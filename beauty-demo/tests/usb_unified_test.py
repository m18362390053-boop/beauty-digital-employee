"""Offline v3 host protocol tests; no port, model, capture, credentials or audio device."""
import base64
import importlib.util
import json
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("unified", Path(__file__).resolve().parents[1] / "scripts" / "usb-unified-gateway.py")
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class Device:
    def __init__(self, answers=b""):
        self.answers = bytearray(answers)
        self.writes = []

    def read(self, n):
        answer = self.answers[:n]
        del self.answers[:n]
        return bytes(answer)

    def write(self, data):
        self.writes.append(data)
        return len(data)


class UnifiedTests(unittest.TestCase):
    def setUp(self):
        self.device = Device()
        self.base = "http://127.0.0.1:3090"
        self.seen = set()

    def process(self, message, approve=lambda _prompt: "NO"):
        return gateway.process(message, self.device, self.base, "fake-token", approve, self.seen)

    def test_state_and_backend_verified_actions(self):
        routine = {"routineId": "care-1", "status": "active", "currentStep": 0,
                   "current": {"productName": "虚构商品", "instruction": "用已确认步骤。"}, "steps": [{}, {}]}
        calls = []
        def api(_base, _token, method, endpoint, body=None):
            calls.append((method, endpoint, body))
            return {"routine": routine} if method == "GET" else {**routine, "eventId": "event-1"}
        with patch.object(gateway.bridge, "api_request", api):
            state = self.process({"v": 3, "type": "get"})
            self.assertEqual((state["stepCount"], state["productName"]), (2, "虚构商品"))
            action = self.process({"v": 3, "type": "action", "requestId": "tap-1", "routineId": "care-1",
                                   "expectedStep": 0, "action": "confirm"})
            self.assertEqual(action["eventId"], "event-1")
        self.assertEqual(calls[1], ("POST", "/api/device/routines/care-1/actions",
                                    {"requestId": "tap-1", "expectedStep": 0, "action": "confirm"}))

    def test_media_requires_one_shot_human_consent_and_never_executes_text(self):
        msg = {"v": 3, "type": "intent", "id": "shot-1", "kind": "image"}
        with patch.object(gateway.media, "receive", side_effect=AssertionError("capture not permitted")), \
             patch.object(gateway.bridge, "api_request", side_effect=AssertionError("external request not permitted")):
            self.assertEqual(self.process(msg)["status"], "cancelled")
            with self.assertRaises(gateway.bridge.BridgeError):
                self.process(msg, lambda _: "YES shot-1")
        image = b"\xff\xd8\xff" + bytes(130)
        with patch.object(gateway.media, "receive", return_value=image) as receive, \
             patch.object(gateway.bridge, "api_request", return_value={"status": "confirmation_required", "items": [{"name": "虚构演示商品"}]}) as api:
            reply = self.process({**msg, "id": "shot-2"}, lambda _: "YES shot-2")
            self.assertEqual(reply["candidates"], ["虚构演示商品"])
            self.assertEqual(reply["status"], "candidate_ready")
            receive.assert_called_once_with(self.device, "image")
            self.assertEqual(api.call_args.args[4]["image"]["dataBase64"], base64.b64encode(image).decode())
        with patch.object(gateway.media, "receive", return_value=b"RIFF0000WAVE" + bytes(120)), \
             patch.object(gateway.bridge, "api_request", return_value={"status": "review_required", "text": "好了"}) as api:
            reply = self.process({"v": 3, "type": "intent", "id": "mic-1", "kind": "audio"}, lambda _: "YES mic-1")
            self.assertEqual((reply["status"], reply["draft"]), ("transcript_ready", "好了"))
            self.assertEqual(api.call_args.args[3], "/api/device/media/audio/transcribe")
        # ASR output is a draft, never mapped to an action endpoint.

    def test_audio_downlink_sends_bounded_mp3_and_requires_ack(self):
        audio = b"ID3" + bytes(1100)
        self.device.answers = bytearray(b"RAAA")
        with patch.object(gateway.bridge, "api_request", return_value={"mediaType": "audio/mpeg", "dataBase64": base64.b64encode(audio).decode()}) as api:
            reply = self.process({"v": 3, "type": "intent", "id": "speak-1", "kind": "speak", "routineId": "care-1"},
                                 lambda _: "YES speak-1")
            self.assertEqual(reply["status"], "audio_sent")
            self.assertEqual(api.call_args.args[3], "/api/device/speech/synthesize")
            self.assertEqual(api.call_args.args[4], {"authorized": True, "routineId": "care-1"})
        header = json.loads(self.device.writes[0]); self.assertEqual(header["crc32"], f"{zlib.crc32(audio):08x}")
        self.assertEqual(b"".join(self.device.writes[1:-1]), audio)
        self.assertEqual(json.loads(self.device.writes[-1])["type"], "end")
        self.device = Device(b"R")
        with patch.object(gateway.bridge, "api_request", return_value={"mediaType": "audio/mpeg", "dataBase64": base64.b64encode(audio).decode()}):
            with self.assertRaisesRegex(gateway.bridge.BridgeError, "AUDIO_TRANSFER_INCOMPLETE"):
                self.process({"v": 3, "type": "intent", "id": "speak-2", "kind": "speak", "routineId": "care-1"},
                             lambda _: "YES speak-2")

    def test_rejects_forged_frames_and_oversize_output(self):
        invalid = [{"v": 3, "type": "action", "requestId": "x", "routineId": "../../ops", "expectedStep": 0, "action": "confirm"},
                   {"v": 3, "type": "intent", "id": "x", "kind": "image", "routineId": "care-1"},
                   {"v": 3, "type": "intent", "id": "x", "kind": "speak"},
                   {"v": 3, "type": "action", "requestId": "x", "routineId": "care-1", "expectedStep": True, "action": "confirm"}]
        with patch.object(gateway.bridge, "api_request", side_effect=AssertionError("must not reach backend")):
            for frame in invalid:
                with self.assertRaises(gateway.bridge.BridgeError):
                    self.process(frame)
        with self.assertRaises(gateway.bridge.BridgeError):
            gateway.outbound(self.device, {"v": 3, "text": "中" * 600})


if __name__ == "__main__":
    unittest.main()

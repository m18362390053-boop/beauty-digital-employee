"""No USB port, external service, secrets or pyserial needed for these tests."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("usb_bridge", Path(__file__).resolve().parents[1] / "scripts" / "usb-bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class FakeSerial:
    def __init__(self, lines):
        self.lines = list(lines)
        self.sent = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def readline(self):
        if not self.lines:
            raise KeyboardInterrupt()
        return self.lines.pop(0)

    def write(self, line):
        self.sent.append(json.loads(line))


class USBBridgeTests(unittest.TestCase):
    def test_get_state_and_user_bound_action(self):
        calls = []
        def api(_base, _token, method, path, body=None):
            calls.append((method, path, body))
            routine = {"routineId": "care-1", "status": "active", "currentStep": 0,
                       "current": {"instruction": "虚构演示：轻轻清洁面部。"}}
            return {"routine": routine} if method == "GET" else {**routine, "eventId": None}
        with patch.object(bridge, "api_request", api):
            self.assertEqual(bridge.handle({"v": 1, "type": "get"}, "http://127.0.0.1:3090", "token")["instruction"],
                             "虚构演示：轻轻清洁面部。")
            action = {"v": 1, "type": "action", "requestId": "boot-1", "routineId": "care-1",
                      "expectedStep": 0, "action": "repeat"}
            self.assertEqual(bridge.handle(action, "http://127.0.0.1:3090", "token")["eventId"], "")
            self.assertEqual(bridge.handle(action, "http://127.0.0.1:3090", "token")["requestId"], "boot-1")
        self.assertEqual(calls[1], ("POST", "/api/device/routines/care-1/actions",
                                     {"requestId": "boot-1", "expectedStep": 0, "action": "repeat"}))

    def test_lcd_demo_enriches_real_step_without_enabling_completion(self):
        routine = {"routineId": "care-demo", "status": "active", "currentStep": 0,
                   "current": {"productName": "虚构演示洁面", "instruction": "轻轻清洁面部。"},
                   "steps": [{"productName": "虚构演示洁面"}, {"productName": "虚构演示面霜"}]}
        with patch.object(bridge, "api_request", return_value={"routine": routine}) as api:
            state = bridge.handle({"v": 1, "type": "get"}, "http://127.0.0.1:3090", "token", lcd_demo=True)
            self.assertEqual(state["step"], 0)
            self.assertEqual(state["stepCount"], 2)
            self.assertEqual(state["productName"], "虚构演示洁面")
            self.assertEqual(state["instruction"], "轻轻清洁面部。")
            self.assertEqual((state["streakDays"], state["weekCount"], state["bedtime"]), (4, 5, "23:00"))
            self.assertTrue(state["demo"])
            self.assertIsNone(state["region"])
            self.assertEqual(state["buttons"], ["repeat"])
            self.assertLess(len(json.dumps(state, ensure_ascii=False).encode("utf-8")), 1024)
            self.assertNotIn("productName", bridge.handle({"v": 1, "type": "get"}, "http://127.0.0.1:3090", "token"))
            with self.assertRaises(bridge.BridgeError):
                bridge.handle({"v": 1, "type": "action", "requestId": "x", "routineId": "care-demo",
                               "expectedStep": 0, "action": "confirm"}, "http://127.0.0.1:3090", "token", lcd_demo=True)
            api.assert_called_with("http://127.0.0.1:3090", "token", "GET", "/api/device/routines/current")
        self.assertEqual(bridge.state_message(None, lcd_demo=True)["screen"], "waiting")

    def test_reject_invalid_messages_before_any_http(self):
        invalid = [{"v": 1, "type": "action", "requestId": "x", "routineId": "../ops", "expectedStep": 0, "action": "confirm"},
                   {"v": 1, "type": "action", "requestId": "x", "routineId": "care-1", "expectedStep": True, "action": "confirm"},
                   {"v": 1, "type": "get", "token": "do-not-forward"}, {"v": 1, "type": "speech"},
                   {"v": True, "type": "get"},
                   {"v": 1, "type": "action", "requestId": "x", "routineId": "care-1", "expectedStep": 0, "action": "confirm"}]
        with patch.object(bridge, "api_request", side_effect=AssertionError("unexpected outbound request")):
            for item in invalid:
                with self.assertRaises(bridge.BridgeError):
                    bridge.handle(item, "http://127.0.0.1:3090", "token")

    def test_serial_framing_and_no_secret_in_replies(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "device-token.txt"
            file.write_text("x" * 40, encoding="utf-8")
            device = FakeSerial([b'{"v":1,"type":', b'"get"}\n', b'{"v":1,"type":"get","token":"bad"}\n', b'bad\n'])
            with patch.object(bridge, "api_request", return_value={"routine": None}):
                with self.assertRaises(KeyboardInterrupt):
                    bridge.run("COM5", file, "http://127.0.0.1:3090", lambda *_a, **_k: device)
            self.assertEqual([msg["type"] for msg in device.sent], ["state", "error", "error"])
            self.assertNotIn("x" * 40, json.dumps(device.sent))
            self.assertEqual(device.sent[0]["status"], "idle")
            with self.assertRaises(bridge.BridgeError):
                bridge.run("COM5", file, "http://external.example:3090", lambda *_a, **_k: device)

    def test_oversized_partial_line_is_discarded_not_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "device-token.txt"
            file.write_text("x" * 40, encoding="utf-8")
            device = FakeSerial([b'x' * 1100, b'{"v":1,"type":"get"}\n', b'{"v":1,"type":"get"}\n'])
            with patch.object(bridge, "api_request", return_value={"routine": None}) as api:
                with self.assertRaises(KeyboardInterrupt):
                    bridge.run("COM5", file, "http://127.0.0.1:3090", lambda *_a, **_k: device)
            self.assertEqual([msg["type"] for msg in device.sent], ["error", "state"])
            api.assert_called_once()


if __name__ == "__main__":
    unittest.main()

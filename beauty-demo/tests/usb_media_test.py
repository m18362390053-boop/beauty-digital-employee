"""Offline framing and consent tests; no board, microphone, camera or model call."""
import importlib.util
import json
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("usb_media", Path(__file__).resolve().parents[1] / "scripts" / "usb-media-check.py")
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)


class FakePort:
    def __init__(self, data, kind="image", corrupt=False, truncated=False):
        self.data = data
        self.kind = kind
        self.corrupt = corrupt
        self.truncated = truncated
        self.offset = 0
        self.sent = []
        self.ready = False

    def __enter__(self): return self
    def __exit__(self, *_): pass

    def write(self, part):
        self.sent.append(part)
        if part == b"R": self.ready = True
        return len(part)

    def readline(self, _size=None):
        if not self.ready:
            return (json.dumps({"v": 2, "type": "media", "kind": self.kind, "size": len(self.data),
                                "crc32": format(zlib.crc32(self.data) ^ (1 if self.corrupt else 0), "08x")}) + "\n").encode()
        return b'{"v":2,"type":"end"}\n'

    def read(self, count):
        if self.truncated: return b""
        part = self.data[self.offset:self.offset + count]
        self.offset += len(part)
        return part


class MediaTests(unittest.TestCase):
    def test_image_and_audio_framing(self):
        for kind, data in [("image", b"\xff\xd8\xff" + b"a" * 1100), ("audio", b"RIFF" + b"\0" * 4 + b"WAVE" + b"a" * 1024)]:
            port = FakePort(data, kind)
            self.assertEqual(media.receive(port, kind), data)
            self.assertEqual(port.sent[0], (json.dumps({"v": 2, "type": "capture", "kind": kind}) + "\n").encode())
            self.assertEqual(port.sent.count(b"A"), 3)

    def test_reject_broken_transfer_before_backend(self):
        photo = b"\xff\xd8\xff" + b"a" * 1100
        for port in (FakePort(photo, corrupt=True), FakePort(photo, truncated=True)):
            with self.assertRaises(media.bridge.BridgeError): media.receive(port, "image")

    def test_refuse_oversize_or_mismatched_media_without_reading_payload(self):
        for header in ({"v": 2, "type": "media", "kind": "image", "size": 900001, "crc32": "00000000"},
                       {"v": 2, "type": "media", "kind": "audio", "size": 100, "crc32": "00000000"}):
            port = FakePort(b"\xff\xd8\xff" + b"a" * 1000)
            port.readline = lambda _size=0, h=header: (json.dumps(h) + "\n").encode()
            with self.assertRaises(media.bridge.BridgeError): media.receive(port, "image")
            self.assertNotIn(b"R", port.sent)

    def test_permission_and_local_url_gate(self):
        with patch.object(media.bridge, "api_request", side_effect=AssertionError("not allowed")):
            with self.assertRaises(media.bridge.BridgeError):
                media.run("COM5", "missing", "http://127.0.0.1:3090", "image", approve=lambda _: "NO")
            with self.assertRaises(media.bridge.BridgeError):
                media.run("COM5", "missing", "http://example.com:3090", "image", approve=lambda _: "YES image")

    def test_only_validated_media_hits_bound_device_endpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token"
            token_file.write_text("x" * 40)
            port = FakePort(b"\xff\xd8\xff" + b"a" * 1100)
            with patch.object(media.bridge, "api_request", return_value={"status": "confirmation_required"}) as api:
                result = media.run("COM5", token_file, "http://127.0.0.1:3090", "image", lambda *_a, **_kw: port, lambda _: "YES image")
            self.assertEqual(result["status"], "confirmation_required")
            self.assertEqual(api.call_args.args[3], "/api/device/media/image/recognize")
            self.assertTrue(api.call_args.args[4]["authorized"])
            self.assertNotIn("x" * 40, str(port.sent))


if __name__ == "__main__": unittest.main()

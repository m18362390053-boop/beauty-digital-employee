"""One-shot, operator-consented Sense capture. Close the v1 bridge before running.

No media or credentials are stored on disk or printed. No Wi-Fi is used.
"""
import argparse
import importlib.util
import json
import re
import sys
import time
import zlib
from pathlib import Path

spec = importlib.util.spec_from_file_location("usb_bridge", Path(__file__).with_name("usb-bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

LIMITS = {"image": 900_000, "audio": 160_000}
ENDPOINTS = {"image": "/api/device/media/image/recognize", "audio": "/api/device/media/audio/transcribe"}
MIME = {"image": "image/jpeg", "audio": "audio/wav"}
CHUNK = 512


def receive(device, kind):
    deadline = time.monotonic() + 120
    device.write((json.dumps({"v": 2, "type": "capture", "kind": kind}) + "\n").encode())
    header = device.readline(181)
    if len(header) > 180 or not header.endswith(b"\n"):
        raise bridge.BridgeError("MEDIA_HEADER_INVALID")
    try:
        message = json.loads(header)
    except (UnicodeError, ValueError):
        raise bridge.BridgeError("MEDIA_HEADER_INVALID") from None
    if not isinstance(message, dict):
        raise bridge.BridgeError("MEDIA_HEADER_INVALID")
    if message.get("type") == "error":
        raise bridge.BridgeError("CAPTURE_FAILED")
    if (set(message) != {"v", "type", "kind", "size", "crc32"} or message["v"] != 2
        or message["type"] != "media" or message["kind"] != kind
        or type(message["size"]) is not int or not 100 <= message["size"] <= LIMITS[kind]
        or not isinstance(message["crc32"], str) or not re.fullmatch(r"[0-9a-f]{8}", message["crc32"])):
        raise bridge.BridgeError("MEDIA_HEADER_INVALID")
    size = message["size"]
    data = bytearray()
    device.write(b"R")
    while len(data) < size:
        if time.monotonic() >= deadline:
            raise bridge.BridgeError("MEDIA_TRANSFER_TIMEOUT")
        remaining = min(CHUNK, size - len(data))
        part = device.read(remaining)
        if len(part) != remaining:
            raise bridge.BridgeError("MEDIA_TRANSFER_INCOMPLETE")
        data.extend(part)
        device.write(b"A")
    if device.readline(40) != b'{"v":2,"type":"end"}\n':
        raise bridge.BridgeError("MEDIA_TRANSFER_INCOMPLETE")
    if format(zlib.crc32(data), "08x") != message["crc32"]:
        raise bridge.BridgeError("MEDIA_CHECKSUM_FAILED")
    if kind == "image" and not data.startswith(b"\xff\xd8\xff"):
        raise bridge.BridgeError("MEDIA_FORMAT_INVALID")
    if kind == "audio" and (data[:4] != b"RIFF" or data[8:12] != b"WAVE"):
        raise bridge.BridgeError("MEDIA_FORMAT_INVALID")
    return bytes(data)


def run(port, token_file, base, kind, serial_factory=None, approve=input):
    if not re.fullmatch(r"http://127\.0\.0\.1:[0-9]{1,5}", base):
        raise bridge.BridgeError("LOCAL_BACKEND_ONLY")
    if approve(f"将拍摄/录制一次 {kind} 并提交到本机后端调用外部模型。确认用户已同意，输入 YES {kind}: ") != "YES " + kind:
        raise bridge.BridgeError("CONSENT_REQUIRED")
    token = bridge.credential(token_file)
    if serial_factory is None:
        import serial
        serial_factory = serial.Serial
    with serial_factory(port, 115200, timeout=15, write_timeout=15) as device:
        data = receive(device, kind)
    import base64
    result = bridge.api_request(base, token, "POST", ENDPOINTS[kind], {
        "authorized": True, **({"image": {"mediaType": MIME[kind], "dataBase64": base64.b64encode(data).decode("ascii")}}
                               if kind == "image" else {"mediaType": MIME[kind], "dataBase64": base64.b64encode(data).decode("ascii")}),
    })
    # Return only model-derived candidates/draft. The caller must review before using them.
    if not isinstance(result, dict) or result.get("status") != ("confirmation_required" if kind == "image" else "review_required"):
        raise bridge.BridgeError("MODEL_RESULT_INVALID")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="One-shot USB Sense photo/voice model check (no Wi-Fi)")
    parser.add_argument("--port", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--kind", required=True, choices=tuple(LIMITS))
    parser.add_argument("--backend", default="http://127.0.0.1:3090")
    args = parser.parse_args()
    try:
        answer = run(args.port, args.token_file, args.backend.rstrip("/"), args.kind)
        print(json.dumps(answer, ensure_ascii=False))  # User-authorised model text only; never raw media or token.
    except (bridge.BridgeError, OSError, ImportError) as error:
        print("USB media check stopped: " + (error.code if isinstance(error, bridge.BridgeError) else "PORT_OR_DEPENDENCY_ERROR"), file=sys.stderr)
        sys.exit(1)

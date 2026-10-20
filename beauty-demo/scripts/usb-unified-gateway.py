"""Opt-in v3 USB integration gateway (host reference implementation).

One serial owner. No Wi-Fi, firmware secrets, silent capture or auto-executed ASR.
Requires matching v3 firmware; do NOT use with v1/H02/H04 or media-only v2 firmware.
"""
import argparse
import base64
import importlib.util
import json
import re
import sys
import zlib
from pathlib import Path


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load("usb_bridge_v1", "usb-bridge.py")
media = load("usb_media_v2", "usb-media-check.py")
ID = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")
MAX_LINE = 1024
MAX_AUDIO = 2_000_000


class FatalTransfer(bridge.BridgeError):
    """Binary stream lost sync; close the serial session instead of parsing stray bytes."""


def outbound(device, message):
    line = (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(line) > MAX_LINE:
        raise bridge.BridgeError("FRAME_TOO_LARGE")
    device.write(line)


def incoming(device):
    line = device.readline(MAX_LINE + 1)
    if not line:
        return None
    if len(line) > MAX_LINE or not line.endswith(b"\n"):
        raise bridge.BridgeError("INVALID_MESSAGE")
    try:
        message = json.loads(line.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise bridge.BridgeError("INVALID_MESSAGE") from None
    if not isinstance(message, dict) or type(message.get("v")) is not int or message["v"] != 3:
        raise bridge.BridgeError("INVALID_MESSAGE")
    return message


def state(routine, request_id=""):
    if routine is None:
        return {"v": 3, "type": "state", "screen": "home", "status": "idle", "routineId": "",
                "step": 0, "stepCount": 0, "productName": "", "instruction": "", "requestId": request_id}
    current = routine.get("current") or {}
    return {"v": 3, "type": "state", "screen": "routine_step" if routine["status"] == "active" else "home",
            "status": routine["status"], "routineId": routine["routineId"], "step": routine["currentStep"],
            "stepCount": len(routine.get("steps") or []), "productName": str(current.get("productName") or "")[:40],
            "instruction": str(current.get("instruction") or "")[:170], "requestId": request_id}


def check(message, seen):
    kind = message.get("type")
    if kind == "get" and set(message) == {"v", "type"}:
        return kind
    if kind == "action" and set(message) == {"v", "type", "requestId", "routineId", "expectedStep", "action"}:
        if (isinstance(message["requestId"], str) and ID.fullmatch(message["requestId"])
            and isinstance(message["routineId"], str) and ID.fullmatch(message["routineId"])
            and type(message["expectedStep"]) is int and 0 <= message["expectedStep"] <= 100
            and message["action"] in ("confirm", "repeat", "skip", "stop")):
            return kind
    if kind == "intent" and set(message) in ({"v", "type", "id", "kind"}, {"v", "type", "id", "kind", "routineId"},
                                                 {"v", "type", "id", "kind", "messageId"}):
        task = message["kind"]
        if (isinstance(message["id"], str) and ID.fullmatch(message["id"])
            and task in ("image", "audio", "speak")
            and (task != "speak" and len(message) == 4 or task == "speak" and len(message) == 5
                 and ("routineId" in message or "messageId" in message)
                 and isinstance(message.get("routineId", message.get("messageId")), str)
                 and ID.fullmatch(message.get("routineId", message.get("messageId"))))):
            if message["id"] in seen:
                raise bridge.BridgeError("TASK_ALREADY_USED")
            return kind
    raise bridge.BridgeError("INVALID_MESSAGE")


def send_binary(device, payload, task_id):
    # Host -> board, 512-byte stop-and-wait blocks, only after a validated TTS response.
    if not 100 <= len(payload) <= MAX_AUDIO or payload[:3] != b"ID3" and not (payload[0] == 0xff and payload[1] & 0xe0 == 0xe0):
        raise bridge.BridgeError("AUDIO_FORMAT_INVALID")
    outbound(device, {"v": 3, "type": "binary", "id": task_id, "kind": "speech", "format": "mp3",
                      "size": len(payload), "crc32": f"{zlib.crc32(payload):08x}"})
    if device.read(1) != b"R":
        raise FatalTransfer("AUDIO_TRANSFER_INCOMPLETE")
    for offset in range(0, len(payload), media.CHUNK):
        part = payload[offset:offset + media.CHUNK]
        if device.write(part) != len(part) or device.read(1) != b"A":
            raise FatalTransfer("AUDIO_TRANSFER_INCOMPLETE")
    outbound(device, {"v": 3, "type": "end", "id": task_id})


def process(message, device, base, token, approve=input, seen=None):
    seen = seen if seen is not None else set()
    kind = check(message, seen)
    if kind == "get":
        return state(bridge.api_request(base, token, "GET", "/api/device/routines/current")["routine"])
    if kind == "action":
        result = bridge.api_request(base, token, "POST", "/api/device/routines/" + message["routineId"] + "/actions",
                                    {"requestId": message["requestId"], "expectedStep": message["expectedStep"],
                                     "action": message["action"]})
        return {**state(result, message["requestId"]), "eventId": result.get("eventId") or ""}

    task, task_id = message["kind"], message["id"]
    if len(seen) >= 1024:
        raise bridge.BridgeError("SESSION_TASK_LIMIT")
    seen.add(task_id)  # Even a declined task ID must not be replayed as a new grant.
    if approve(f"设备请求 {task}；确认用户单次同意采集/外发或朗读，输入 YES {task_id}: ") != "YES " + task_id:
        return {"v": 3, "type": "task", "id": task_id, "status": "cancelled"}
    if task == "speak":
        source = {"authorized": True, **({"routineId": message["routineId"]} if "routineId" in message else {"messageId": message["messageId"]})}
        result = bridge.api_request(base, token, "POST", "/api/device/speech/synthesize", source)
        if (result.get("mediaType") != "audio/mpeg" or not isinstance(result.get("dataBase64"), str)
            or len(result["dataBase64"]) > 2_700_000):
            raise bridge.BridgeError("AUDIO_FORMAT_INVALID")
        try:
            audio = base64.b64decode(result["dataBase64"], validate=True)
        except (ValueError, base64.binascii.Error):
            raise bridge.BridgeError("AUDIO_FORMAT_INVALID") from None
        send_binary(device, audio, task_id)
        return {"v": 3, "type": "task", "id": task_id, "status": "audio_sent"}

    # Existing v2 binary capture is reused only inside this exclusive v3 session.
    try:
        data = media.receive(device, task)
    except media.bridge.BridgeError as error:
        raise FatalTransfer(error.code) from None
    body = {"authorized": True, **({"image": {"mediaType": "image/jpeg", "dataBase64": base64.b64encode(data).decode("ascii")}}
                                  if task == "image" else {"mediaType": "audio/wav", "dataBase64": base64.b64encode(data).decode("ascii")})}
    result = bridge.api_request(base, token, "POST", media.ENDPOINTS[task], body)
    if task == "audio":
        if result.get("status") != "review_required" or not isinstance(result.get("text"), str):
            raise bridge.BridgeError("MODEL_RESULT_INVALID")
        return {"v": 3, "type": "task", "id": task_id, "status": "transcript_ready", "draft": result["text"][:120]}
    if result.get("status") != "confirmation_required" or not isinstance(result.get("items"), list):
        raise bridge.BridgeError("MODEL_RESULT_INVALID")
    items = result["items"]
    names = [item.get("name", "")[:35] for item in items[:2] if isinstance(item, dict) and isinstance(item.get("name"), str)]
    return {"v": 3, "type": "task", "id": task_id, "status": "candidate_ready", "candidates": names}


def run(port, token_file, base, serial_factory=None, approve=input):
    if not re.fullmatch(r"http://127\.0\.0\.1:[0-9]{1,5}", base):
        raise bridge.BridgeError("LOCAL_BACKEND_ONLY")
    token = bridge.credential(token_file)
    if serial_factory is None:
        import serial
        serial_factory = serial.Serial
    seen = set()
    with serial_factory(port, 115200, timeout=15, write_timeout=15) as device:
        print("Unified USB gateway: v3 firmware required; local backend only.")
        while True:
            try:
                message = incoming(device)
                if message is None:
                    continue
                reply = process(message, device, base, token, approve, seen)
            except FatalTransfer:
                raise
            except bridge.BridgeError as error:
                reply = {"v": 3, "type": "error", "code": error.code}
            outbound(device, reply)
            # No photos, recordings, transcript, answer, token, text or TTS bytes in logs.


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Opt-in unified USB v3 gateway (requires paired firmware)")
    parser.add_argument("--port", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--backend", default="http://127.0.0.1:3090")
    args = parser.parse_args()
    try:
        run(args.port, args.token_file, args.backend.rstrip("/"))
    except (bridge.BridgeError, OSError, ImportError) as error:
        print("Unified USB gateway stopped: " + (error.code if isinstance(error, bridge.BridgeError) else "PORT_OR_DEPENDENCY_ERROR"), file=sys.stderr)
        sys.exit(1)

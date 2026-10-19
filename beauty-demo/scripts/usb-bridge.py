"""Local USB-serial bridge; only the PC holds the user-bound device credential.

Install pyserial separately: python -m pip install pyserial
The bridge never opens an internet-facing listener or sends a model credential.
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
# Only a harmless repeat command is enabled in this first hardware phase.
# Enabling completion/skip/stop requires a verified physical UX and new tests.
ACTIONS = {"repeat"}
MAX_LINE = 1024


class BridgeError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def credential(path):
    file = Path(path)
    if not file.is_file() or file.stat().st_size > 1024:
        raise BridgeError("INVALID_TOKEN_FILE")
    token = file.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,100}", token):
        raise BridgeError("INVALID_TOKEN_FILE")
    return token


def api_request(base, token, method, endpoint, body=None):
    url = base + endpoint
    payload = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(url, data=payload, method=method,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Discard arbitrary upstream text (including potential sensitive data).
        try:
            code = json.load(error).get("error", {}).get("code")
        except (ValueError, AttributeError, TypeError):
            code = None
        if not isinstance(code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{1,63}", code):
            code = "BACKEND_HTTP_ERROR"
        raise BridgeError(code) from None
    except (ValueError, KeyError, TypeError):
        raise BridgeError("BACKEND_INVALID_RESPONSE") from None
    except (urllib.error.URLError, TimeoutError):
        raise BridgeError("BACKEND_UNAVAILABLE") from None


def state_message(routine, request_id="", lcd_demo=False):
    if routine is None:
        state = {"v": 1, "type": "state", "routineId": "", "status": "idle", "step": 0,
                 "instruction": "", "eventId": "", "requestId": request_id}
        if lcd_demo:
            state.update(screen="waiting", demo=True)
        return state
    current = routine.get("current") or {}
    state = {"v": 1, "type": "state", "routineId": routine["routineId"],
             "status": routine["status"], "step": routine["currentStep"],
             "instruction": str(current.get("instruction", ""))[:500],
             "eventId": routine.get("eventId") or "", "requestId": request_id}
    if lcd_demo:
        steps = routine.get("steps") or []
        # Only the step and product name come from the user's routine. The rest
        # is explicitly labelled demo data, never recorded as care events.
        state.update(screen="routine_step" if routine["status"] == "active" else "finished",
                     demo=True, stepCount=len(steps), productName=str(current.get("productName") or "演示商品")[:40],
                     streakDays=4, weekCount=5, bedtime="23:00",
                     areaLabel="区域以已确认步骤为准", region=None,
                     buttons=["repeat"] if routine["status"] == "active" else [])
    return state


def handle(message, base, token, lcd_demo=False):
    if not isinstance(message, dict) or type(message.get("v")) is not int or message["v"] != 1:
        raise BridgeError("INVALID_MESSAGE")
    kind = message.get("type")
    if kind in ("hello", "get"):
        if set(message) != {"v", "type"}:
            raise BridgeError("INVALID_MESSAGE")
        result = api_request(base, token, "GET", "/api/device/routines/current")
        return state_message(result["routine"], lcd_demo=lcd_demo)
    if kind != "action" or set(message) != {"v", "type", "requestId", "routineId", "expectedStep", "action"}:
        raise BridgeError("INVALID_MESSAGE")
    request_id, routine_id, step, action = (message[k] for k in ("requestId", "routineId", "expectedStep", "action"))
    if (not isinstance(request_id, str) or not ID.fullmatch(request_id)
        or not isinstance(routine_id, str) or not ID.fullmatch(routine_id)
        or type(step) is not int or step < 0 or step > 10000 or action not in ACTIONS):
        raise BridgeError("INVALID_MESSAGE")
    result = api_request(base, token, "POST", "/api/device/routines/" + routine_id + "/actions",
                         {"requestId": request_id, "expectedStep": step, "action": action})
    return state_message(result, request_id, lcd_demo=lcd_demo)


def run(port, token_file, base, serial_factory=None, lcd_demo=False):
    if not re.fullmatch(r"http://127\.0\.0\.1:[0-9]{1,5}", base):
        raise BridgeError("LOCAL_BACKEND_ONLY")
    token = credential(token_file)
    if serial_factory is None:
        import serial  # pyserial only required for a real USB connection
        serial_factory = serial.Serial
    with serial_factory(port, 115200, timeout=1) as device:
        print("USB bridge connected (local backend only); no credentials sent to board.")
        partial = b""
        dropping = False
        while True:
            chunk = device.readline()
            if not chunk:
                continue
            if dropping:
                if chunk.endswith(b"\n"):
                    dropping = False
                continue
            if len(partial) + len(chunk) > MAX_LINE:
                partial = b""
                dropping = not chunk.endswith(b"\n")
                answer = {"v": 1, "type": "error", "code": "INVALID_MESSAGE"}
                device.write((json.dumps(answer) + "\n").encode("utf-8"))
                print("USB error: INVALID_MESSAGE")
                continue
            partial += chunk
            if not partial.endswith(b"\n"):
                continue  # pyserial can return a partial line on a timeout
            line, partial = partial, b""
            try:
                message = json.loads(line.decode("utf-8"))
                answer = handle(message, base, token, lcd_demo=lcd_demo)
            except (ValueError, UnicodeError, KeyError, TypeError, BridgeError) as error:
                answer = {"v": 1, "type": "error", "code": error.code if isinstance(error, BridgeError) else "INVALID_MESSAGE"}
            device.write((json.dumps(answer, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
            # Never log the instruction, input body, token or media content.
            if answer["type"] == "state":
                print("USB state: " + answer["status"] + " step=" + str(answer["step"]))
            else:
                print("USB error: " + answer["code"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="XIAO ESP32S3 Sense USB button bridge (no Wi-Fi)")
    parser.add_argument("--port", required=True, help="USB COM port, e.g. COM5")
    parser.add_argument("--token-file", required=True, help="Private PC-only file with one user-bound device token")
    parser.add_argument("--backend", default="http://127.0.0.1:3090")
    parser.add_argument("--lcd-demo", action="store_true", help="Add labelled placeholder LCD fields to v1 state replies")
    args = parser.parse_args()
    try:
        run(args.port, args.token_file, args.backend.rstrip("/"), lcd_demo=args.lcd_demo)
    except (BridgeError, OSError, ImportError) as error:
        # Do not print exception internals; they may contain file paths or credential context.
        print("USB bridge stopped: " + (error.code if isinstance(error, BridgeError) else "PORT_OR_DEPENDENCY_ERROR"), file=sys.stderr)
        sys.exit(1)

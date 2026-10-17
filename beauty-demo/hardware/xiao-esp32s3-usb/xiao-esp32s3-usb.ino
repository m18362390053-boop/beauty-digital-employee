// USB CDC phase 1: current care step + optional external REPEAT button only.
// Board: Seeed XIAO ESP32S3 (Sense expansion attached). Arduino ESP32 3.x,
// Tools > USB CDC On Boot: Enabled. Library Manager: ArduinoJson 7.x.
// No Wi-Fi, provider keys, user token, camera, microphone, LCD, amp or SD access.
#include <Arduino.h>
#include <ArduinoJson.h>
#include <esp_system.h>

// Optional momentary button between D0 (GPIO1) and GND. Never use BOOT as
// an action key; pulling GPIO0 low while powering on changes the boot mode.
constexpr uint8_t REPEAT_PIN = 1;  // XIAO D0 = GPIO1 per Seeed pin map
constexpr unsigned long POLL_MS = 3000;
String routineId;
int currentStep = 0;
bool active = false;
String pendingId;
String pendingRoutineId;
int pendingStep = 0;
String incoming;
unsigned long lastPoll = 0;
unsigned long lastAction = 0;
unsigned long lastEdge = 0;
bool previousPressed = false;
uint32_t nonce;
uint32_t sequence = 0;

void sendGet() {
  JsonDocument doc;
  doc["v"] = 1;
  doc["type"] = "get";
  serializeJson(doc, Serial);
  Serial.write('\n');
  lastPoll = millis();
}

void sendRepeat() {
  if (!active || routineId.isEmpty()) return;
  if (pendingId.isEmpty()) {
    pendingId = String(nonce, HEX) + "-" + String(++sequence);
    pendingRoutineId = routineId;
    pendingStep = currentStep;
  }
  JsonDocument doc;
  doc["v"] = 1;
  doc["type"] = "action";
  doc["requestId"] = pendingId;
  doc["routineId"] = pendingRoutineId;
  doc["expectedStep"] = pendingStep;
  doc["action"] = "repeat";  // safe: never creates a care completion event
  serializeJson(doc, Serial);
  Serial.write('\n');
  lastAction = millis();
}

void acceptLine(const String &line) {
  JsonDocument doc;
  if (deserializeJson(doc, line) || doc["v"] != 1) return;
  const char *type = doc["type"] | "";
  if (strcmp(type, "state") == 0) {
    // The bridge passes only server-approved state, not credentials.
    routineId = doc["routineId"].is<const char *>() ? doc["routineId"].as<String>() : "";
    currentStep = doc["step"] | 0;
    const char *status = doc["status"] | "";
    active = strcmp(status, "active") == 0;
    String acknowledged = doc["requestId"].is<const char *>() ? doc["requestId"].as<String>() : "";
    if (!pendingId.isEmpty() && acknowledged == pendingId) pendingId = "";
    // Later: display doc["instruction"] on the verified LCD controller.
  } else if (strcmp(type, "error") == 0) {
    const char *code = doc["code"] | "";
    if (strcmp(code, "BACKEND_UNAVAILABLE") != 0) pendingId = "";
    // A conflict/changed step must be refreshed; never auto-advance.
    if (strcmp(code, "STEP_CHANGED") == 0 || strcmp(code, "ROUTINE_NOT_ACTIVE") == 0) sendGet();
  }
}

void setup() {
  pinMode(REPEAT_PIN, INPUT_PULLUP);
  nonce = esp_random();
  Serial.begin(115200);
  // USB CDC may not be open yet; regular polling recovers on connection.
}

void loop() {
  while (Serial.available()) {
    char byte = static_cast<char>(Serial.read());
    if (byte == '\n') {
      acceptLine(incoming);
      incoming = "";
    } else if (incoming.length() < 4096 && byte != '\r') {
      incoming += byte;
    } else if (incoming.length() >= 4096) {
      incoming = "";
    }
  }
  unsigned long now = millis();
  bool pressed = digitalRead(REPEAT_PIN) == LOW;
  if (pressed != previousPressed && now - lastEdge > 40) {
    previousPressed = pressed;
    lastEdge = now;
    if (pressed && pendingId.isEmpty()) sendRepeat();
  }
  if (!pendingId.isEmpty() && now - lastAction >= POLL_MS) sendRepeat();
  else if (pendingId.isEmpty() && now - lastPoll >= POLL_MS) sendGet();
}

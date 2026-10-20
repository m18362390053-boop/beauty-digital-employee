// LCD-only v3 receive/display integration candidate. NOT the v3 media/audio/touch firmware.
// Pin values mirror the teammate's reported H03 wiring; verify against actual board
// before powering or uploading. Never run this with v1 or media-only v2 gateway.
// Arduino ESP32 3.x, ArduinoJson 7.x, Arduino_GFX 1.4.9, U8g2.
#include <Arduino.h>
#include <ArduinoJson.h>
#include <U8g2lib.h>             // Must precede Arduino_GFX for U8g2 font support.
#include <Arduino_GFX_Library.h>

constexpr int PIN_SCK = 7, PIN_MOSI = 9, PIN_CS = 1;
constexpr int PIN_DC = 2, PIN_RST = 4, PIN_BL = 3;
constexpr uint16_t BG = 0xFF9A, INK = 0x4949, ACCENT = 0x922D, MUTE = 0x9CF3;
constexpr uint32_t POLL_MS = 3000, STALE_MS = 15000, PAGE_MS = 4500;
constexpr size_t MAX_LINE_BYTES = 1024;

Arduino_DataBus *bus = new Arduino_ESP32SPI(PIN_DC, PIN_CS, PIN_SCK, PIN_MOSI, GFX_NOT_DEFINED);
Arduino_GFX *lcd = new Arduino_ST7789(bus, PIN_RST, 0, true, 240, 284);

struct View {
  String screen = "home", status = "idle", product, instruction, routineId;
  String title, result, error;
  int step = 0, stepCount = 0;
} view;

String lineBuffer;
bool dropping = false, connected = false;
uint32_t lastGet = 0, lastState = 0, lastPage = 0;
uint32_t resultUntil = 0;
View resumeView;
int page = 0;

// UTF-8 characters must never be split in the middle of a multi-byte sequence.
String nextGlyph(const String &value, size_t &at) {
  unsigned char first = static_cast<unsigned char>(value[at]);
  size_t count = first < 0x80 ? 1 : (first & 0xE0) == 0xC0 ? 2 :
                 (first & 0xF0) == 0xE0 ? 3 : (first & 0xF8) == 0xF0 ? 4 : 1;
  if (at + count > value.length()) count = 1;
  String glyph = value.substring(at, at + count);
  at += count;
  return glyph;
}

void text(int x, int baseline, const String &value, uint16_t color = INK) {
  lcd->setTextColor(color);
  lcd->setCursor(x, baseline);
  lcd->print(value);
}

void paragraph(const String &value, int x, int y, int maxWidth, int maxRows, int offset = 0) {
  String row;
  int width = 0, rowIndex = 0, visible = 0;
  for (size_t at = 0; at < value.length();) {
    String glyph = nextGlyph(value, at);
    bool ascii = glyph.length() == 1;
    if (glyph == "\n" || width + (ascii ? 7 : 12) > maxWidth) {
      if (rowIndex >= offset && visible < maxRows) { text(x, y + visible * 18, row); visible++; }
      rowIndex++; row = ""; width = 0;
      if (glyph == "\n") continue;
    }
    row += glyph; width += ascii ? 7 : 12;
    if (rowIndex >= offset + maxRows) return;
  }
  if (row.length() && rowIndex >= offset && visible < maxRows) text(x, y + visible * 18, row);
}

int lineCount(const String &value, int maxWidth) {
  int count = 1, width = 0;
  for (size_t at = 0; at < value.length();) {
    String glyph = nextGlyph(value, at);
    int glyphWidth = glyph.length() == 1 ? 7 : 12;
    if (glyph == "\n") { count++; width = 0; continue; }
    if (width + glyphWidth > maxWidth) { count++; width = 0; }
    width += glyphWidth;
  }
  return count;
}

void topbar() {
  lcd->fillScreen(BG);
  lcd->fillRect(0, 0, 240, 39, ACCENT);
  text(10, 26, "悦见", 0xFFFF);
  text(178, 26, "DEMO", 0xFFFF);
}

void faceIcon() {
  // Fixed schematic, not a person's face or a product-approved application map.
  lcd->fillCircle(120, 114, 39, 0xFF59);
  lcd->drawCircle(120, 114, 39, ACCENT);
  lcd->drawLine(98, 106, 108, 106, INK);
  lcd->drawLine(132, 106, 142, 106, INK);
  lcd->drawLine(117, 111, 115, 130, INK);
  lcd->drawLine(111, 136, 120, 139, ACCENT);
  lcd->drawLine(120, 139, 129, 136, ACCENT);
}

void drawView() {
  topbar();
  if (!connected) {
    text(16, 90, "正在连接电脑...");
    text(16, 118, "请检查USB与网关");
  } else if (view.screen == "routine_step" && view.status == "active") {
    text(12, 61, "今晚护理 · 演示画面", ACCENT);
    faceIcon();
    text(12, 172, "第 " + String(view.step + 1) + " 步 / " + String(view.stepCount) + " 步", ACCENT);
    paragraph(view.product, 12, 194, 216, 1);
    paragraph(view.instruction, 12, 216, 216, 3, page * 3);
    text(12, 276, "仅显示 · 按钮待接触摸", MUTE);
  } else if (view.screen == "result") {
    text(12, 70, view.title, ACCENT);
    paragraph(view.result, 12, 102, 216, 8, page * 8);
    text(12, 276, "识别文字仅用于演示", MUTE);
  } else if (view.screen == "error") {
    text(12, 76, "连接或请求失败", ACCENT);
    paragraph(view.error, 12, 106, 216, 5);
    text(12, 276, "不会自动推进护理", MUTE);
  } else {
    faceIcon();
    text(19, 182, "你好，欢迎回来", ACCENT);
    text(16, 215, "请从网页开始演示护理");
    text(16, 242, "照片/语音入口待整合");
  }
  lastPage = millis();
}

void getState() {
  Serial.print("{\"v\":3,\"type\":\"get\"}\n");
  lastGet = millis();
}

void accept(const String &line) {
  JsonDocument msg;
  if (deserializeJson(msg, line) || !msg.is<JsonObject>() || msg["v"].as<int>() != 3) return;
  const char *type = msg["type"] | "";
  if (strcmp(type, "state") == 0) {
    const char *status = msg["status"] | "";
    int step = msg["step"] | 0, total = msg["stepCount"] | 0;
    if (step < 0 || total < 0 || total > 100 || step > total) return;
    View updated;
    updated.status = status;
    updated.screen = msg["screen"] | "home";
    updated.routineId = msg["routineId"] | "";
    updated.step = step; updated.stepCount = total;
    updated.product = msg["productName"] | "";
    updated.instruction = msg["instruction"] | "";
    bool changed = !connected || updated.screen != view.screen || updated.status != view.status ||
      updated.step != view.step || updated.product != view.product || updated.instruction != view.instruction;
    connected = true; lastState = millis();
    if (resultUntil && static_cast<int32_t>(resultUntil - millis()) > 0) {
      resumeView = updated;
      return;  // Polling must not erase a newly delivered result immediately.
    }
    view = updated;
    if (changed) { page = 0; drawView(); }
  } else if (strcmp(type, "task") == 0) {
    const char *status = msg["status"] | "";
    if (strcmp(status, "candidate_ready") == 0 || strcmp(status, "transcript_ready") == 0) {
      view.screen = "result";
      view.title = strcmp(status, "candidate_ready") == 0 ? "包装识别结果" : "语音识别结果";
      view.result = strcmp(status, "transcript_ready") == 0 ? String(msg["draft"] | "") : "";
      if (strcmp(status, "candidate_ready") == 0) {
        JsonArray candidates = msg["candidates"].as<JsonArray>();
        for (JsonVariant item : candidates) if (item.is<const char *>()) {
          if (view.result.length()) view.result += "、";
          view.result += item.as<const char *>();
        }
        if (view.result.isEmpty()) view.result = "未找到商品候选";
      }
      resumeView = view;
      resumeView.screen = resumeView.status == "active" ? "routine_step" : "home";
      resultUntil = millis() + 12000;
      page = 0; connected = true; lastState = millis(); drawView();
    }
  } else if (strcmp(type, "error") == 0) {
    view.screen = "error";
    view.error = msg["code"] | "UNKNOWN_ERROR";
    connected = true; lastState = millis(); drawView();
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BL, OUTPUT);
  digitalWrite(PIN_BL, HIGH);
  lcd->begin();
  lcd->setUTF8Print(true);
  lcd->setFont(u8g2_font_wqy12_t_gb2312);
  drawView();
  getState();
}

void loop() {
  while (Serial.available()) {
    char ch = static_cast<char>(Serial.read());
    if (ch == '\n') {
      if (!dropping) accept(lineBuffer);
      lineBuffer = ""; dropping = false;
    } else if (!dropping && ch != '\r') {
      if (lineBuffer.length() < MAX_LINE_BYTES) lineBuffer += ch;
      else { lineBuffer = ""; dropping = true; }
    }
  }
  uint32_t now = millis();
  if (now - lastGet >= POLL_MS) getState();
  if (resultUntil && static_cast<int32_t>(now - resultUntil) >= 0) {
    resultUntil = 0;
    view = resumeView;
    page = 0;
    drawView();
  }
  if (connected && now - lastState >= STALE_MS) { connected = false; drawView(); }
  if (connected && now - lastPage >= PAGE_MS &&
      (view.screen == "routine_step" || view.screen == "result")) {
    int rows = view.screen == "result" ? 8 : 3;
    int count = lineCount(view.screen == "result" ? view.result : view.instruction, 216);
    int pages = (count + rows - 1) / rows;
    if (pages > 1) { page = (page + 1) % pages; drawView(); }
    else lastPage = now;
  }
}

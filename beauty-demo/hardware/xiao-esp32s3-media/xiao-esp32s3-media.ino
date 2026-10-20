// Experimental one-shot USB media sketch (replaces, does not augment, phase-1 sketch).
// Arduino ESP32 3.x; XIAO_ESP32S3 Sense; USB CDC On Boot + PSRAM enabled.
// Uses Sense camera and built-in PDM mic ONLY. No Wi-Fi, SD, screen, speaker or secrets.
#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP_I2S.h>
#include "esp_camera.h"

I2SClass microphone;
bool cameraReady = false;
bool micReady = false;
String commandLine;
constexpr size_t IMAGE_MAX = 900000;
constexpr size_t AUDIO_MAX = 160000;
constexpr size_t BLOCK = 512;

void failure(const char *code) {
  JsonDocument message;
  message["v"] = 2; message["type"] = "error"; message["code"] = code;
  serializeJson(message, Serial); Serial.write('\n');
}

// Standard CRC-32 (IEEE), verified on the PC before any backend call.
uint32_t checksum(const uint8_t *data, size_t size) {
  uint32_t crc = 0xffffffff;
  for (size_t i = 0; i < size; ++i) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return ~crc;
}

bool expect(char wanted) {
  unsigned long start = millis();
  while (millis() - start < 15000) {
    if (Serial.available()) return Serial.read() == wanted;
    delay(1);
  }
  return false;
}

void transmit(const char *kind, const uint8_t *data, size_t size) {
  if (!data || size < 100 || size > (strcmp(kind, "image") == 0 ? IMAGE_MAX : AUDIO_MAX)) {
    failure("MEDIA_SIZE"); return;
  }
  char crc[9]; snprintf(crc, sizeof(crc), "%08lx", static_cast<unsigned long>(checksum(data, size)));
  JsonDocument header;
  header["v"] = 2; header["type"] = "media"; header["kind"] = kind;
  header["size"] = size; header["crc32"] = crc;
  serializeJson(header, Serial); Serial.write('\n');
  if (!expect('R')) return;
  for (size_t offset = 0; offset < size; offset += BLOCK) {
    size_t count = min(BLOCK, size - offset);
    if (Serial.write(data + offset, count) != count || !expect('A')) return;
  }
  Serial.print("{\"v\":2,\"type\":\"end\"}\n");
}

bool startCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  // Official Arduino CameraWebServer CAMERA_MODEL_XIAO_ESP32S3 pin map.
  c.pin_d0 = 15; c.pin_d1 = 17; c.pin_d2 = 18; c.pin_d3 = 16;
  c.pin_d4 = 14; c.pin_d5 = 12; c.pin_d6 = 11; c.pin_d7 = 48;
  c.pin_xclk = 10; c.pin_pclk = 13; c.pin_vsync = 38; c.pin_href = 47;
  c.pin_sccb_sda = 40; c.pin_sccb_scl = 39;
  c.pin_pwdn = -1; c.pin_reset = -1; c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG; c.frame_size = FRAMESIZE_VGA;
  c.jpeg_quality = 15; c.fb_count = 1; c.fb_location = CAMERA_FB_IN_PSRAM;
  return esp_camera_init(&c) == ESP_OK;
}

void capture(const char *kind) {
  if (strcmp(kind, "image") == 0) {
    if (!cameraReady) cameraReady = startCamera();
    if (!cameraReady) { failure("CAMERA_UNAVAILABLE"); return; }
    camera_fb_t *frame = esp_camera_fb_get();
    if (!frame) { failure("CAMERA_FRAME_FAILED"); return; }
    if (frame->format != PIXFORMAT_JPEG) failure("CAMERA_FORMAT");
    else transmit("image", frame->buf, frame->len);
    esp_camera_fb_return(frame);
  } else if (strcmp(kind, "audio") == 0) {
    if (!micReady) {
      microphone.setPinsPdmRx(42, 41);
      micReady = microphone.begin(I2S_MODE_PDM_RX, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
    }
    if (!micReady) { failure("MIC_UNAVAILABLE"); return; }
    size_t length = 0;
    uint8_t *wav = microphone.recordWAV(3, &length); // 3 s, 16 kHz mono WAV, no TF card.
    if (!wav) { failure("MIC_RECORD_FAILED"); return; }
    transmit("audio", wav, length);
    free(wav);
  }
}

void setup() { Serial.begin(115200); }

void loop() {
  while (Serial.available()) {
    char ch = static_cast<char>(Serial.read());
    if (ch == '\n') {
      JsonDocument request;
      if (!deserializeJson(request, commandLine) && request["v"] == 2
          && request["type"] == "capture" && request.size() == 3) {
        const char *kind = request["kind"] | "";
        if (strcmp(kind, "image") == 0 || strcmp(kind, "audio") == 0) capture(kind);
        else failure("INVALID_KIND");
      } else failure("INVALID_COMMAND");
      commandLine = "";
    } else if (ch != '\r' && commandLine.length() < 160) commandLine += ch;
    else { commandLine = ""; failure("INVALID_COMMAND"); }
  }
}

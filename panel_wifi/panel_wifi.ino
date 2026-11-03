/*
 * Waveshare ESP32-S3-RGB-Matrix + 128x64 outdoor HUB75
 * Wi-Fi firmware: NTP clock + HTTP JSON API for a future web UI.
 *
 * Locked panel config:
 *   DMA 256x32, FM6124, Type-138 (no SM5266P), clkphase=false, E=-1
 *   Four-scan remap #825 pxbase=1
 *
 * API (JSON):
 *   GET  /api/status
 *   POST /api/notify     {"text":"...","duration_ms":5000,"r":0,"g":255,"b":80}
 *   POST /api/brightness {"value":70} or {"mode":"auto"|"manual","value":70}
 *   POST /api/clear
 *   GET  /               short HTML help
 *
 * First boot: connect to AP "LEDPanel-Setup" and set Wi-Fi,
 * or create config.h from config.example.h with WIFI_SSID / WIFI_PASS.
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <time.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <Adafruit_GFX.h>

#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

#ifndef PANEL_HOSTNAME
#define PANEL_HOSTNAME "ledpanel"
#endif
#ifndef BRIGHTNESS_DEFAULT
#define BRIGHTNESS_DEFAULT 70
#endif
#ifndef NTP_TZ
#define NTP_TZ "CET-1CEST,M3.5.0,M10.5.0/3"
#endif
#ifndef NTP_SERVER
#define NTP_SERVER "pool.ntp.org"
#endif

MatrixPanel_I2S_DMA *dma = nullptr;
WebServer server(80);

class MappedPanel : public Adafruit_GFX {
 public:
  MappedPanel() : Adafruit_GFX(128, 64) {}
  void drawPixel(int16_t x, int16_t y, uint16_t color) override {
    if (x < 0 || y < 0 || x >= 128 || y >= 64 || !dma) return;
    int16_t cx = x, cy = y;
    if ((cy & 16) == 0) cx += cx + 1;
    else cx += cx;
    cy = (cy >> 5) * 16 + (cy & 0x0F);
    if (cx >= 0 && cy >= 0 && cx < 256 && cy < 32) dma->drawPixel(cx, cy, color);
  }
};

MappedPanel panel;

enum class Mode : uint8_t { Clock, Notify, Boot };
Mode mode = Mode::Boot;

String notifyText;
uint16_t notifyColor = 0;
uint32_t notifyUntil = 0;

bool brightnessAuto = true;
uint8_t brightnessManual = BRIGHTNESS_DEFAULT;
uint8_t brightnessNow = BRIGHTNESS_DEFAULT;

uint16_t cW, cG, cC, cY;

void beginFrame() { dma->fillScreen(0); }
void endFrame() { dma->flipDMABuffer(); }
uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) { return dma->color565(r, g, b); }

void addCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

uint8_t autoBrightnessForHour(int hour) {
  if (hour >= 22 || hour < 6) return 18;
  if (hour >= 20 || hour < 7) return 35;
  if (hour >= 8 && hour < 18) return 110;
  return 70;
}

void applyBrightness() {
  uint8_t b = brightnessManual;
  if (brightnessAuto) {
    time_t now = time(nullptr);
    struct tm ti;
    if (now > 100000 && localtime_r(&now, &ti)) b = autoBrightnessForHour(ti.tm_hour);
    else b = BRIGHTNESS_DEFAULT;
  }
  if (b != brightnessNow) {
    brightnessNow = b;
    dma->setBrightness8(brightnessNow);
  }
}

void showBoot(const char *line1, const char *line2 = nullptr) {
  beginFrame();
  panel.setTextWrap(false);
  panel.setTextSize(1);
  panel.setTextColor(cC);
  panel.setCursor(2, 8);
  panel.print(line1);
  if (line2) {
    panel.setTextColor(cY);
    panel.setCursor(2, 24);
    panel.print(line2);
  }
  endFrame();
}

void drawClock() {
  time_t now = time(nullptr);
  struct tm ti;
  beginFrame();
  panel.setTextWrap(false);

  if (now < 100000 || !localtime_r(&now, &ti)) {
    panel.setTextSize(1);
    panel.setTextColor(cY);
    panel.setCursor(8, 28);
    panel.print("Syncing NTP...");
    endFrame();
    return;
  }

  char tbuf[16], dbuf[24];
  snprintf(tbuf, sizeof(tbuf), "%02d:%02d:%02d", ti.tm_hour, ti.tm_min, ti.tm_sec);
  snprintf(dbuf, sizeof(dbuf), "%02d.%02d.%04d", ti.tm_mday, ti.tm_mon + 1, ti.tm_year + 1900);

  panel.setTextSize(2);
  panel.setTextColor(cW);
  panel.setCursor(8, 8);
  panel.print(tbuf);

  panel.setTextSize(1);
  panel.setTextColor(cG);
  panel.setCursor(8, 32);
  panel.print(dbuf);

  panel.setTextColor(cC);
  panel.setCursor(8, 48);
  panel.print(WiFi.localIP().toString());

  panel.setCursor(100, 48);
  panel.print(brightnessAuto ? "A" : "M");
  panel.print(brightnessNow);
  endFrame();
}

void drawNotify() {
  beginFrame();
  panel.setTextWrap(true);
  panel.setTextSize(1);
  panel.setTextColor(notifyColor ? notifyColor : cG);
  panel.setCursor(2, 8);
  panel.print(notifyText);
  endFrame();
}

void render() {
  applyBrightness();
  if (mode == Mode::Notify) {
    if ((int32_t)(millis() - notifyUntil) >= 0) {
      mode = Mode::Clock;
      drawClock();
    } else {
      drawNotify();
    }
  } else if (mode == Mode::Clock) {
    drawClock();
  }
}

bool readJson(JsonDocument &doc) {
  String body = server.arg("plain");
  if (body.isEmpty()) return false;
  return deserializeJson(doc, body) == DeserializationError::Ok;
}

void sendJson(int code, JsonDocument &doc) {
  addCors();
  String out;
  serializeJson(doc, out);
  server.send(code, "application/json", out);
}

void handleStatus() {
  JsonDocument doc;
  doc["ok"] = true;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["hostname"] = PANEL_HOSTNAME;
  doc["mode"] = (mode == Mode::Notify) ? "notify" : "clock";
  doc["brightness"] = brightnessNow;
  doc["brightness_mode"] = brightnessAuto ? "auto" : "manual";
  doc["brightness_manual"] = brightnessManual;
  doc["notify_text"] = notifyText;
  doc["uptime_ms"] = millis();

  time_t now = time(nullptr);
  struct tm ti;
  if (now > 100000 && localtime_r(&now, &ti)) {
    char buf[32];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &ti);
    doc["local_time"] = buf;
  } else {
    doc["local_time"] = nullptr;
  }
  sendJson(200, doc);
}

void handleNotify() {
  JsonDocument doc;
  if (!readJson(doc)) {
    addCors();
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"bad_json\"}");
    return;
  }
  const char *text = doc["text"] | "";
  if (!text[0]) {
    addCors();
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"text_required\"}");
    return;
  }
  uint32_t dur = doc["duration_ms"] | 5000;
  if (dur < 500) dur = 500;
  if (dur > 120000) dur = 120000;

  uint8_t r = doc["r"] | 40;
  uint8_t g = doc["g"] | 255;
  uint8_t b = doc["b"] | 80;
  notifyColor = rgb(r, g, b);
  notifyText = String(text);
  if (notifyText.length() > 120) notifyText = notifyText.substring(0, 120);
  notifyUntil = millis() + dur;
  mode = Mode::Notify;
  drawNotify();

  JsonDocument out;
  out["ok"] = true;
  out["mode"] = "notify";
  out["duration_ms"] = dur;
  sendJson(200, out);
}

void handleBrightness() {
  JsonDocument doc;
  if (!readJson(doc)) {
    addCors();
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"bad_json\"}");
    return;
  }
  const char *m = doc["mode"] | "";
  if (!strcmp(m, "auto")) brightnessAuto = true;
  else if (!strcmp(m, "manual")) brightnessAuto = false;

  if (!doc["value"].isNull()) {
    int v = doc["value"] | (int)brightnessManual;
    if (v < 0) v = 0;
    if (v > 255) v = 255;
    brightnessManual = (uint8_t)v;
    if (!m[0]) brightnessAuto = false;
  }
  applyBrightness();
  dma->setBrightness8(brightnessNow);

  JsonDocument out;
  out["ok"] = true;
  out["brightness"] = brightnessNow;
  out["brightness_mode"] = brightnessAuto ? "auto" : "manual";
  sendJson(200, out);
}

void handleClear() {
  mode = Mode::Clock;
  notifyText = "";
  drawClock();
  JsonDocument out;
  out["ok"] = true;
  out["mode"] = "clock";
  sendJson(200, out);
}

void handleRoot() {
  addCors();
  String html;
  html += F("<!doctype html><meta charset=utf-8><title>LED Panel</title>");
  html += F("<pre>Waveshare ESP32-S3 128x64 HUB75\n\n");
  html += F("GET  /api/status\n");
  html += F("POST /api/notify      {\"text\":\"Hi\",\"duration_ms\":5000}\n");
  html += F("POST /api/brightness  {\"mode\":\"auto\"} or {\"mode\":\"manual\",\"value\":70}\n");
  html += F("POST /api/clear\n\nIP: ");
  html += WiFi.localIP().toString();
  html += "\nmDNS: http://";
  html += PANEL_HOSTNAME;
  html += ".local/</pre>";
  server.send(200, "text/html", html);
}

void handleOptions() {
  addCors();
  server.send(204);
}

void setupPanel() {
  HUB75_I2S_CFG::i2s_pins pins = {
      4, 5, 6, 7, 15, 16, 18, 8, 3, 42, -1, 40, 2, 41
  };
  HUB75_I2S_CFG cfg(256, 32, 1, pins);
  cfg.clkphase = false;
  cfg.driver = HUB75_I2S_CFG::FM6124;
  cfg.double_buff = true;

  dma = new MatrixPanel_I2S_DMA(cfg);
  if (!dma->begin()) {
    while (true) delay(1000);
  }
  dma->setBrightness8(BRIGHTNESS_DEFAULT);
  dma->setLatBlanking(8);
  cW = rgb(255, 255, 255);
  cG = rgb(40, 255, 80);
  cC = rgb(40, 255, 255);
  cY = rgb(255, 220, 40);
}

void setupWifi() {
  showBoot("WiFi setup...", "AP: LEDPanel-Setup");
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(PANEL_HOSTNAME);

  WiFiManager wm;
  wm.setConfigPortalTimeout(180);

#if defined(WIFI_SSID) && defined(WIFI_PASS)
  if (WIFI_SSID[0]) {
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) delay(200);
  }
#endif

  if (WiFi.status() != WL_CONNECTED) {
    if (!wm.autoConnect("LEDPanel-Setup")) {
      showBoot("WiFi FAILED", "reboot...");
      delay(3000);
      ESP.restart();
    }
  }

  showBoot("WiFi OK", WiFi.localIP().toString().c_str());
  delay(1000);

  if (MDNS.begin(PANEL_HOSTNAME)) MDNS.addService("http", "tcp", 80);
  configTzTime(NTP_TZ, NTP_SERVER);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("=== panel_wifi ===");

  setupPanel();
  showBoot("Booting...");
  setupWifi();

  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/notify", HTTP_POST, handleNotify);
  server.on("/api/brightness", HTTP_POST, handleBrightness);
  server.on("/api/clear", HTTP_POST, handleClear);
  server.on("/api/notify", HTTP_OPTIONS, handleOptions);
  server.on("/api/brightness", HTTP_OPTIONS, handleOptions);
  server.on("/api/clear", HTTP_OPTIONS, handleOptions);
  server.onNotFound([]() {
    addCors();
    server.send(404, "application/json", "{\"ok\":false,\"error\":\"not_found\"}");
  });
  server.begin();

  mode = Mode::Clock;
  applyBrightness();
  drawClock();
  Serial.printf("Ready http://%s/  mDNS http://%s.local/\n",
                WiFi.localIP().toString().c_str(), PANEL_HOSTNAME);
}

uint32_t lastRender = 0;

void loop() {
  server.handleClient();
  if (millis() - lastRender >= 250) {
    lastRender = millis();
    render();
  }
}

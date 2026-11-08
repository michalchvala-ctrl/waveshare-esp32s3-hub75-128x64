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
 *   POST /api/layout     hub layout JSON (widgets below strip)
 *   GET  /               short HTML help
 *
 * Last layout is persisted to LittleFS (/layout.json) and restored on boot.
 * Brightness mode/value is stored in NVS Preferences.
 */


#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <esp_heap_caps.h>
#include <time.h>
#include <sys/time.h>
#include <string.h>
#include <Wire.h>
#include <math.h>
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <Adafruit_GFX.h>
#include <Fonts/TomThumb.h>
#include <Fonts/Org_01.h>

#define LAYOUT_FILE "/layout.json"

/** ArduinoJson allocator → PSRAM (layout JSON + atlases are large). */
struct PsramAllocator : ArduinoJson::Allocator {
  void *allocate(size_t size) override {
    return heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  }
  void deallocate(void *pointer) override { heap_caps_free(pointer); }
  void *reallocate(void *pointer, size_t new_size) override {
    return heap_caps_realloc(pointer, new_size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  }
};
PsramAllocator psramAlloc;

#define I2C_SDA_PIN 47
#define I2C_SCL_PIN 48
#define SENSOR_REFRESH_MS 1000
#define SHTC3_ADDR 0x70
// Sensirion SHTC3 commands (16-bit)
#define SHTC3_CMD_WAKEUP 0x3517
#define SHTC3_CMD_SLEEP 0xB098
#define SHTC3_CMD_SOFT_RESET 0x805D
#define SHTC3_CMD_READ_ID 0xEFC8
#define SHTC3_CMD_MEAS_TFIRST 0x7866  // normal, clock stretching disabled

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
#define NTP_TZ "CET-1CEST,M3.5.0/2,M10.5.0/3"
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
bool notifyStripOnly = true;
uint8_t notifyStripHeight = 16;
bool notifyDirty = false;

bool brightnessAuto = true;
uint8_t brightnessManual = BRIGHTNESS_DEFAULT;
uint8_t brightnessNow = BRIGHTNESS_DEFAULT;

uint16_t cW, cG, cC, cY;

uint32_t lastRenderPoll = 0;
uint32_t lastWifiCheck = 0;
uint32_t lastSensorMs = 0;
uint8_t lastClockSec = 255;
bool wifiWasConnected = false;
bool layoutDirty = false;
bool wifiIpDirty = false;

bool shtc3Ok = false;
float tempC = NAN;
float humRh = NAN;
uint16_t shtc3RawT = 0;
uint16_t shtc3RawH = 0;
bool sensorDirty = false;

#define MAX_WIDGETS 16
#define BITMAP_POOL_SIZE 28672
#define MAX_ATLAS_GLYPHS 24
enum class WType : uint8_t { Text, Clock, Date, Temp, Humidity, Weather, Unknown };
enum class WFont : uint8_t { Default, TomThumb, Org01, TtfBlit };

struct Widget {
  WType type;
  WFont font;
  int16_t x;
  int16_t y;
  uint8_t size;
  uint8_t r, g, b;
  uint16_t color;
  char text[48];
  char format[24];  // clock/date format preset
  bool useBitmap;
  uint16_t bw;
  uint16_t bh;
  uint16_t bitmapOff;  // offset into bitmapPool
  // TTF digit atlas — compose HH:MM:SS locally each second
  bool useAtlas;
  uint8_t atlasCount;
  uint8_t atlasCellH;
  char atlasCh[MAX_ATLAS_GLYPHS];
  uint8_t atlasW[MAX_ATLAS_GLYPHS];
  uint8_t atlasH[MAX_ATLAS_GLYPHS];
  uint16_t atlasOff[MAX_ATLAS_GLYPHS];
};

Widget widgets[MAX_WIDGETS];
uint8_t widgetCount = 0;
uint8_t layoutStripHeight = 16;
bool hasLayout = false;
uint8_t bitmapPool[BITMAP_POOL_SIZE];
uint16_t bitmapPoolUsed = 0;

void beginFrame() { dma->fillScreen(0); }
void endFrame() { dma->flipDMABuffer(); }
uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) { return dma->color565(r, g, b); }

uint16_t parseHexColor(const char *hex) {
  if (!hex || hex[0] != '#' || strlen(hex) < 7) return rgb(255, 255, 255);
  auto nib = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return 0;
  };
  uint8_t r = (nib(hex[1]) << 4) | nib(hex[2]);
  uint8_t g = (nib(hex[3]) << 4) | nib(hex[4]);
  uint8_t b = (nib(hex[5]) << 4) | nib(hex[6]);
  return rgb(r, g, b);
}

WType parseWType(const char *t) {
  if (!t) return WType::Unknown;
  if (!strcmp(t, "text")) return WType::Text;
  if (!strcmp(t, "clock")) return WType::Clock;
  if (!strcmp(t, "date")) return WType::Date;
  if (!strcmp(t, "temp")) return WType::Temp;
  if (!strcmp(t, "humidity")) return WType::Humidity;
  if (!strcmp(t, "weather")) return WType::Weather;
  return WType::Unknown;
}

WFont parseWFont(const char *t) {
  if (!t) return WFont::Default;
  if (!strcmp(t, "tomthumb")) return WFont::TomThumb;
  if (!strcmp(t, "org01")) return WFont::Org01;
  if (t[0] == 't' && t[1] == 't' && t[2] == 'f' && t[3] == ':') return WFont::TtfBlit;
  return WFont::Default;
}

void applyWidgetFont(WFont f) {
  switch (f) {
    case WFont::TomThumb:
      panel.setFont(&TomThumb);
      break;
    case WFont::Org01:
      panel.setFont(&Org_01);
      break;
    default:
      panel.setFont();
      break;
  }
}

static int b64Val(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

// Decode base64 into bitmapPool; returns byte count or 0 on failure
static uint16_t decodeBase64ToPool(const char *in, uint16_t need) {
  if (!in || need == 0) return 0;
  if (bitmapPoolUsed + need > BITMAP_POOL_SIZE) return 0;
  uint8_t *out = bitmapPool + bitmapPoolUsed;
  uint16_t written = 0;
  int val = 0, valb = -8;
  for (const char *p = in; *p && written < need; p++) {
    if (*p == '=' || *p == '\n' || *p == '\r') continue;
    int d = b64Val(*p);
    if (d < 0) continue;
    val = (val << 6) + d;
    valb += 6;
    if (valb >= 0) {
      out[written++] = (uint8_t)((val >> valb) & 0xFF);
      valb -= 8;
    }
  }
  if (written < need) return 0;
  bitmapPoolUsed += need;
  return need;
}

void blitGrayAt(int16_t x0, int16_t y0, uint16_t bw, uint16_t bh, uint16_t off,
                uint8_t r, uint8_t g, uint8_t b) {
  if ((uint32_t)off + (uint32_t)bw * bh > bitmapPoolUsed) return;
  const uint8_t *pix = bitmapPool + off;
  for (uint16_t yy = 0; yy < bh; yy++) {
    for (uint16_t xx = 0; xx < bw; xx++) {
      uint8_t v = pix[yy * bw + xx];
      if (!v) continue;
      panel.drawPixel(x0 + (int16_t)xx, y0 + (int16_t)yy,
                      rgb((uint8_t)((r * v) / 255), (uint8_t)((g * v) / 255),
                          (uint8_t)((b * v) / 255)));
    }
  }
}

void blitWidgetBitmap(const Widget &w) {
  if (!w.useBitmap || w.bw == 0 || w.bh == 0) return;
  blitGrayAt(w.x, w.y, w.bw, w.bh, w.bitmapOff, w.r, w.g, w.b);
}

static int findAtlasGlyph(const Widget &w, char ch) {
  for (uint8_t i = 0; i < w.atlasCount; i++) {
    if (w.atlasCh[i] == ch) return (int)i;
  }
  return -1;
}

void blitAtlasString(const Widget &w, const char *s) {
  if (!w.useAtlas || !s) return;
  int16_t x = w.x;
  const uint8_t cellH = w.atlasCellH ? w.atlasCellH : 8;
  for (; *s; s++) {
    int gi = findAtlasGlyph(w, *s);
    if (gi < 0) {
      x += (int16_t)(cellH / 3);
      continue;
    }
    int16_t y = w.y + (int16_t)(cellH > w.atlasH[gi] ? (cellH - w.atlasH[gi]) : 0);
    blitGrayAt(x, y, w.atlasW[gi], w.atlasH[gi], w.atlasOff[gi], w.r, w.g, w.b);
    x += (int16_t)w.atlasW[gi];
    if (x >= 128) break;
  }
}

void printWidgetText(const Widget &w, const char *buf) {
  if (w.useAtlas) {
    blitAtlasString(w, buf);
    return;
  }
  if (w.useBitmap) {
    blitWidgetBitmap(w);
    return;
  }
  WFont f = w.font;
  if (f == WFont::TtfBlit) f = WFont::Default;
  applyWidgetFont(f);
  panel.setTextWrap(false);
  panel.setTextSize(w.size);
  panel.setTextColor(w.color);
  panel.setCursor(w.x, w.y);
  panel.print(buf);
}

void addCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

bool requireAuth() {
#ifndef API_TOKEN
  return true;
#else
  if (!API_TOKEN[0]) return true;
  if (!server.hasHeader("Authorization")) return false;
  String h = server.header("Authorization");
  String want = String("Bearer ") + API_TOKEN;
  return h == want;
#endif
}

void rejectUnauthorized() {
  addCors();
  server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}");
}

void pumpServer() {
  server.handleClient();
  yield();
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
  panel.setFont();
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

void printIpOrWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    panel.print(WiFi.localIP().toString());
  } else {
    panel.print("WiFi...");
  }
}

static bool isLocalLiveType(WType t) {
  return t == WType::Clock || t == WType::Date || t == WType::Temp || t == WType::Humidity;
}

static void formatClockBuf(char *buf, size_t n, const struct tm *ti, const char *fmt) {
  if (!ti) {
    if (fmt && (!strcmp(fmt, "HH:mm") || !strcmp(fmt, "H:mm") || !strcmp(fmt, "hh:mm tt")))
      snprintf(buf, n, "--:--");
    else if (fmt && !strcmp(fmt, "hh:mm:ss tt"))
      snprintf(buf, n, "--:--:-- --");
    else
      snprintf(buf, n, "--:--:--");
    return;
  }
  int H = ti->tm_hour;
  int m = ti->tm_min;
  int s = ti->tm_sec;
  int h12 = H % 12;
  if (h12 == 0) h12 = 12;
  const char *tt = (H < 12) ? "AM" : "PM";
  if (fmt && !strcmp(fmt, "HH:mm")) {
    snprintf(buf, n, "%02d:%02d", H, m);
  } else if (fmt && !strcmp(fmt, "H:mm")) {
    snprintf(buf, n, "%d:%02d", H, m);
  } else if (fmt && !strcmp(fmt, "hh:mm:ss tt")) {
    snprintf(buf, n, "%02d:%02d:%02d %s", h12, m, s, tt);
  } else if (fmt && !strcmp(fmt, "hh:mm tt")) {
    snprintf(buf, n, "%02d:%02d %s", h12, m, tt);
  } else {
    snprintf(buf, n, "%02d:%02d:%02d", H, m, s);
  }
}

static void formatDateBuf(char *buf, size_t n, const struct tm *ti, const char *fmt) {
  if (!ti) {
    snprintf(buf, n, "--.--.----");
    return;
  }
  int d = ti->tm_mday;
  int M = ti->tm_mon + 1;
  int y = ti->tm_year + 1900;
  int yy = y % 100;
  if (fmt && !strcmp(fmt, "d.M.yyyy")) {
    snprintf(buf, n, "%d.%d.%04d", d, M, y);
  } else if (fmt && !strcmp(fmt, "dd.MM.yy")) {
    snprintf(buf, n, "%02d.%02d.%02d", d, M, yy);
  } else if (fmt && !strcmp(fmt, "d. M. yyyy")) {
    snprintf(buf, n, "%d. %d. %04d", d, M, y);
  } else if (fmt && !strcmp(fmt, "yyyy-MM-dd")) {
    snprintf(buf, n, "%04d-%02d-%02d", y, M, d);
  } else if (fmt && !strcmp(fmt, "dd/MM/yyyy")) {
    snprintf(buf, n, "%02d/%02d/%04d", d, M, y);
  } else if (fmt && !strcmp(fmt, "MM/dd/yyyy")) {
    snprintf(buf, n, "%02d/%02d/%04d", M, d, y);
  } else if (fmt && !strcmp(fmt, "d/M/yyyy")) {
    snprintf(buf, n, "%d/%d/%04d", d, M, y);
  } else {
    snprintf(buf, n, "%02d.%02d.%04d", d, M, y);
  }
}

void drawWidget(const Widget &w, const struct tm *ti) {
  char buf[48];
  buf[0] = 0;
  switch (w.type) {
    case WType::Clock:
      formatClockBuf(buf, sizeof(buf), ti, w.format);
      break;
    case WType::Date:
      formatDateBuf(buf, sizeof(buf), ti, w.format);
      break;
    case WType::Temp:
      if (shtc3Ok && !isnan(tempC))
        snprintf(buf, sizeof(buf), "%.1fC", tempC);
      else
        strcpy(buf, "--.-C");
      break;
    case WType::Humidity:
      if (shtc3Ok && !isnan(humRh))
        snprintf(buf, sizeof(buf), "%.0f%%", humRh);
      else
        strcpy(buf, "--%");
      break;
    case WType::Weather:
    case WType::Text:
      strncpy(buf, w.text, sizeof(buf) - 1);
      break;
    default:
      return;
  }

  // Live types: TTF atlas compose OR selected GFX font+size (never stale full-string bitmap)
  if (isLocalLiveType(w.type)) {
    Widget local = w;
    local.useBitmap = false;  // ignore full-string snapshot
    if (!local.useAtlas && local.font == WFont::TtfBlit) local.font = WFont::Default;
    printWidgetText(local, buf);
    return;
  }
  printWidgetText(w, buf);
}

void drawLayoutScreen() {
  time_t now = time(nullptr);
  struct tm ti;
  bool ok = now > 100000 && localtime_r(&now, &ti);

  beginFrame();
  panel.setFont();
  if (layoutStripHeight > 0) {
    panel.fillRect(0, 0, 128, layoutStripHeight, rgb(8, 8, 8));
  }

  if (!hasLayout || widgetCount == 0) {
    if (!ok) {
      panel.setTextSize(1);
      panel.setTextColor(cY);
      panel.setCursor(4, layoutStripHeight + 4);
      panel.print("Syncing NTP...");
    } else {
      char tbuf[16], dbuf[24];
      snprintf(tbuf, sizeof(tbuf), "%02d:%02d:%02d", ti.tm_hour, ti.tm_min, ti.tm_sec);
      snprintf(dbuf, sizeof(dbuf), "%02d.%02d.%04d", ti.tm_mday, ti.tm_mon + 1, ti.tm_year + 1900);
      panel.setTextSize(2);
      panel.setTextColor(cW);
      panel.setCursor(4, layoutStripHeight + 4);
      panel.print(tbuf);
      panel.setTextSize(1);
      panel.setTextColor(cG);
      panel.setCursor(4, layoutStripHeight + 28);
      panel.print(dbuf);
    }
    panel.setTextSize(1);
    panel.setTextColor(cC);
    panel.setCursor(4, 56);
    printIpOrWifi();
  } else {
    for (uint8_t i = 0; i < widgetCount; i++) {
      drawWidget(widgets[i], ok ? &ti : nullptr);
    }
  }

  endFrame();
  if (ok) lastClockSec = (uint8_t)ti.tm_sec;
  layoutDirty = false;
  wifiIpDirty = false;
  sensorDirty = false;
}

void drawClock() { drawLayoutScreen(); }

void drawNotify() {
  // Default Adafruit GFX 5x7 — more readable than TomThumb on 128x64
  beginFrame();
  panel.setFont();
  panel.setTextSize(1);

  if (notifyStripOnly) {
    // User area (below strip): keep clock so notify does not wipe the panel
    time_t now = time(nullptr);
    struct tm ti;
    int y0 = notifyStripHeight + 2;
    if (now > 100000 && localtime_r(&now, &ti)) {
      char tbuf[16];
      snprintf(tbuf, sizeof(tbuf), "%02d:%02d:%02d", ti.tm_hour, ti.tm_min, ti.tm_sec);
      panel.setTextSize(2);
      panel.setTextColor(cW);
      panel.setCursor(8, y0);
      panel.print(tbuf);
      panel.setTextSize(1);
      panel.setTextColor(cC);
      panel.setCursor(8, y0 + 24);
      printIpOrWifi();
    }
    if (notifyStripHeight > 0) {
      panel.fillRect(0, 0, 128, notifyStripHeight, rgb(16, 16, 16));
    }
    panel.setTextWrap(true);
    panel.setTextColor(notifyColor ? notifyColor : cY);
    panel.setCursor(1, 1);
  } else {
    panel.setTextWrap(true);
    panel.setTextColor(notifyColor ? notifyColor : cG);
    panel.setCursor(1, 1);
  }

  const char *p = notifyText.c_str();
  size_t n = notifyText.length();
  for (size_t i = 0; i < n; i++) {
    panel.write((uint8_t)p[i]);
    if ((i & 31) == 31) pumpServer();
  }
  endFrame();
  notifyDirty = false;
}

void ensureWifi() {
  if (millis() - lastWifiCheck < 4000) return;
  lastWifiCheck = millis();

  wl_status_t st = WiFi.status();
  if (st == WL_CONNECTED) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Serial.printf("WiFi up %s\n", WiFi.localIP().toString().c_str());
      wifiIpDirty = true;
    }
    return;
  }

  wifiWasConnected = false;
  Serial.printf("WiFi down status=%d — reconnect\n", (int)st);
  WiFi.disconnect(false, false);
  delay(50);
  WiFi.begin();  // NVS / last credentials (WiFiManager saved)
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 8000) {
    pumpServer();
    delay(100);
  }
  if (WiFi.status() == WL_CONNECTED) {
    wifiWasConnected = true;
    Serial.printf("WiFi reconnected %s\n", WiFi.localIP().toString().c_str());
    wifiIpDirty = true;
  }
}

void render() {
  applyBrightness();

  if (mode == Mode::Notify) {
    if ((int32_t)(millis() - notifyUntil) >= 0) {
      mode = Mode::Clock;
      drawClock();
      return;
    }
    if (notifyDirty) drawNotify();
    return;
  }

  if (mode != Mode::Clock) return;

  struct timeval tv;
  gettimeofday(&tv, nullptr);
  struct tm ti;
  bool need = sensorDirty || layoutDirty || wifiIpDirty;
  if (tv.tv_sec > 100000 && localtime_r(&tv.tv_sec, &ti)) {
    if ((uint8_t)ti.tm_sec != lastClockSec) need = true;
  } else {
    static uint32_t lastNtpWait = 0;
    if (millis() - lastNtpWait > 1000) {
      lastNtpWait = millis();
      need = true;
    }
  }
  if (need) drawClock();
}

/** Pump HTTP until just before the next NTP second (precise 1Hz). */
void waitAlignedToNextSecond() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  if (tv.tv_sec <= 100000) {
    delay(5);
    return;
  }
  int remainMs = 1000 - (int)(tv.tv_usec / 1000);
  if (remainMs < 3) return;
  // Cap wait so layout/sensor dirty can still land quickly
  if (remainMs > 950) remainMs = 950;
  uint32_t deadline = millis() + (uint32_t)(remainMs - 2);
  while ((int32_t)(millis() - deadline) < 0) {
    pumpServer();
    if (layoutDirty || sensorDirty || wifiIpDirty || mode != Mode::Clock) return;
    delay(1);
  }
}

// Sensirion CRC-8 (poly 0x31), datasheet
static uint8_t shtc3Crc8(const uint8_t *data, uint8_t len) {
  uint8_t crc = 0xFF;
  for (uint8_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
  }
  return crc;
}

static bool shtc3WriteCmd(uint16_t cmd) {
  Wire.beginTransmission(SHTC3_ADDR);
  Wire.write((uint8_t)(cmd >> 8));
  Wire.write((uint8_t)(cmd & 0xFF));
  return Wire.endTransmission() == 0;
}

bool initShtc3() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(400000);
  delay(1);
  if (!shtc3WriteCmd(SHTC3_CMD_WAKEUP)) {
    Serial.println("SHTC3 wake FAIL");
    return false;
  }
  delayMicroseconds(500);
  if (!shtc3WriteCmd(SHTC3_CMD_SOFT_RESET)) {
    Serial.println("SHTC3 reset FAIL");
    return false;
  }
  delay(2);
  if (!shtc3WriteCmd(SHTC3_CMD_WAKEUP)) return false;
  delayMicroseconds(500);
  if (!shtc3WriteCmd(SHTC3_CMD_READ_ID)) return false;
  delayMicroseconds(200);
  if (Wire.requestFrom((int)SHTC3_ADDR, 3) != 3) {
    Serial.println("SHTC3 ID read FAIL");
    return false;
  }
  uint8_t idb[3] = {
      (uint8_t)Wire.read(), (uint8_t)Wire.read(), (uint8_t)Wire.read()};
  if (shtc3Crc8(idb, 2) != idb[2]) {
    Serial.println("SHTC3 ID CRC FAIL");
    return false;
  }
  uint16_t id = ((uint16_t)idb[0] << 8) | idb[1];
  // Bits 11 and 5..0 form product code 0x807 for SHTC3
  if ((id & 0x083F) != 0x0807) {
    Serial.printf("SHTC3 bad ID 0x%04X\n", id);
    return false;
  }
  Serial.printf("SHTC3 OK id=0x%04X (SDA=%d SCL=%d)\n", id, I2C_SDA_PIN, I2C_SCL_PIN);
  return true;
}

// Datasheet: T = -45 + 175 * S_T / 2^16 ; RH = 100 * S_RH / 2^16
static bool readShtc3Once(float &outT, float &outH, uint16_t &rawT, uint16_t &rawH) {
  if (!shtc3WriteCmd(SHTC3_CMD_WAKEUP)) return false;
  delayMicroseconds(500);
  if (!shtc3WriteCmd(SHTC3_CMD_MEAS_TFIRST)) return false;
  delay(15);  // max ~12.1 ms normal mode
  if (Wire.requestFrom((int)SHTC3_ADDR, 6) != 6) return false;
  uint8_t buf[6];
  for (int i = 0; i < 6; i++) buf[i] = (uint8_t)Wire.read();
  if (shtc3Crc8(buf, 2) != buf[2] || shtc3Crc8(buf + 3, 2) != buf[5]) return false;

  rawT = ((uint16_t)buf[0] << 8) | buf[1];
  rawH = ((uint16_t)buf[3] << 8) | buf[4];
  outT = -45.0f + 175.0f * ((float)rawT / 65536.0f);
  outH = 100.0f * ((float)rawH / 65536.0f);
  if (outH < 0.0f) outH = 0.0f;
  if (outH > 100.0f) outH = 100.0f;
  // Reject physically absurd readings (bad bus / wrong endian)
  if (outT < -40.0f || outT > 125.0f) return false;
  return true;
}

void refreshShtc3() {
  if (millis() - lastSensorMs < SENSOR_REFRESH_MS) return;
  lastSensorMs = millis();

  if (!shtc3Ok) {
    static uint8_t failBackoff = 0;
    if (++failBackoff < 5) return;
    failBackoff = 0;
    shtc3Ok = initShtc3();
    if (!shtc3Ok) return;
  }

  float nt, nh;
  uint16_t rt, rh;
  if (!readShtc3Once(nt, nh, rt, rh)) {
    Serial.println("SHTC3 read FAIL");
    shtc3Ok = false;
    tempC = NAN;
    humRh = NAN;
    sensorDirty = true;
    return;
  }

  shtc3RawT = rt;
  shtc3RawH = rh;
  if (isnan(tempC) || fabsf(nt - tempC) >= 0.05f || isnan(humRh) || fabsf(nh - humRh) >= 0.5f) {
    sensorDirty = true;
  }
  tempC = nt;
  humRh = nh;
  static uint32_t lastLog = 0;
  if (millis() - lastLog > 5000) {
    lastLog = millis();
    Serial.printf("SHTC3 T=%.2fC H=%.1f%% rawT=%u rawH=%u\n", tempC, humRh, shtc3RawT, shtc3RawH);
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
  doc["wifi"] = WiFi.status() == WL_CONNECTED;
  doc["ip"] = (WiFi.status() == WL_CONNECTED) ? WiFi.localIP().toString() : "0.0.0.0";
  doc["rssi"] = WiFi.RSSI();
  doc["hostname"] = PANEL_HOSTNAME;
  doc["mode"] = (mode == Mode::Notify) ? "notify" : "clock";
  doc["brightness"] = brightnessNow;
  doc["brightness_mode"] = brightnessAuto ? "auto" : "manual";
  doc["brightness_manual"] = brightnessManual;
  doc["notify_text"] = notifyText;
  doc["uptime_ms"] = millis();
  doc["shtc3_ok"] = shtc3Ok;
  if (shtc3Ok && !isnan(tempC)) {
    doc["temp_c"] = (double)tempC;
    char tb[16];
    snprintf(tb, sizeof(tb), "%.1fC", tempC);
    doc["temp_display"] = tb;
  } else {
    doc["temp_c"] = nullptr;
    doc["temp_display"] = "--.-C";
  }
  if (shtc3Ok && !isnan(humRh)) {
    doc["humidity"] = (double)humRh;
    char hb[16];
    snprintf(hb, sizeof(hb), "%.0f%%", humRh);
    doc["humidity_display"] = hb;
  } else {
    doc["humidity"] = nullptr;
    doc["humidity_display"] = "--%";
  }
  doc["shtc3_raw_t"] = shtc3RawT;
  doc["shtc3_raw_h"] = shtc3RawH;
  doc["has_layout"] = hasLayout;
  doc["widgets"] = widgetCount;
  bool bootSaved = LittleFS.exists(LAYOUT_FILE);
  doc["boot_saved"] = bootSaved;
  if (bootSaved) {
    File bf = LittleFS.open(LAYOUT_FILE, "r");
    doc["boot_bytes"] = bf ? (long)bf.size() : 0;
    if (bf) bf.close();
  } else {
    doc["boot_bytes"] = 0;
  }

  time_t now = time(nullptr);
  doc["unix"] = (long)now;
  struct tm tiLocal;
  struct tm tiUtc;
  if (now > 100000 && localtime_r(&now, &tiLocal)) {
    char buf[32];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &tiLocal);
    doc["local_time"] = buf;
    char clock[16];
    snprintf(clock, sizeof(clock), "%02d:%02d:%02d", tiLocal.tm_hour, tiLocal.tm_min, tiLocal.tm_sec);
    doc["clock"] = clock;
  } else {
    doc["local_time"] = nullptr;
    doc["clock"] = nullptr;
  }
  if (now > 100000 && gmtime_r(&now, &tiUtc)) {
    char ubuf[32];
    strftime(ubuf, sizeof(ubuf), "%Y-%m-%dT%H:%M:%SZ", &tiUtc);
    doc["utc_time"] = ubuf;
  }
  sendJson(200, doc);
}

void handleNotify() {
  if (!requireAuth()) {
    rejectUnauthorized();
    return;
  }
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
  notifyStripOnly = doc["strip_only"] | true;
  // Prefer layout strip; allow 0 (= full-screen notify / strip disabled)
  int sh = doc["strip_height"].isNull() ? (int)layoutStripHeight : (int)doc["strip_height"];
  if (sh < 0) sh = 0;
  if (sh > 32) sh = 32;
  notifyStripHeight = (uint8_t)sh;
  if (notifyStripHeight == 0) notifyStripOnly = false;
  notifyColor = rgb(r, g, b);
  notifyText = String(text);
  if (notifyText.length() > 360) notifyText = notifyText.substring(0, 360);
  notifyUntil = millis() + dur;
  mode = Mode::Notify;
  notifyDirty = true;

  // Respond ASAP so client does not time out during slow draw
  JsonDocument out;
  out["ok"] = true;
  out["mode"] = "notify";
  out["duration_ms"] = dur;
  sendJson(200, out);

  drawNotify();
}

void handleBrightness() {
  if (!requireAuth()) {
    rejectUnauthorized();
    return;
  }
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
  saveBrightnessPrefs();

  JsonDocument out;
  out["ok"] = true;
  out["brightness"] = brightnessNow;
  out["brightness_mode"] = brightnessAuto ? "auto" : "manual";
  sendJson(200, out);
}

void handleClear() {
  if (!requireAuth()) {
    rejectUnauthorized();
    return;
  }
  mode = Mode::Clock;
  notifyText = "";
  notifyDirty = false;
  drawClock();
  JsonDocument out;
  out["ok"] = true;
  out["mode"] = "clock";
  sendJson(200, out);
}

bool applyLayoutFromDoc(JsonDocument &doc) {
  int sh = doc["strip_height"].isNull() ? 16 : (int)doc["strip_height"];
  if (sh < 0) sh = 0;
  if (sh > 32) sh = 32;
  layoutStripHeight = (uint8_t)sh;

  widgetCount = 0;
  bitmapPoolUsed = 0;
  JsonArray arr = doc["widgets"].as<JsonArray>();
  if (!arr.isNull()) {
    for (JsonObject o : arr) {
      if (widgetCount >= MAX_WIDGETS) break;
      Widget &w = widgets[widgetCount];
      memset(&w, 0, sizeof(w));
      w.type = parseWType(o["type"] | "");
      if (w.type == WType::Unknown) continue;
      w.x = o["x"] | 0;
      w.y = o["y"] | layoutStripHeight;
      if (layoutStripHeight > 0 && w.y < layoutStripHeight) w.y = layoutStripHeight;
      int sz = o["size"] | 1;
      if (sz < 1) sz = 1;
      if (sz > 3) sz = 3;
      w.size = (uint8_t)sz;
      w.font = parseWFont(o["font"] | "default");
      const char *hx = o["color"] | "#FFFFFF";
      w.color = parseHexColor(hx);
      if (hx[0] == '#' && strlen(hx) >= 7) {
        auto nib = [](char c) -> int {
          if (c >= '0' && c <= '9') return c - '0';
          if (c >= 'a' && c <= 'f') return c - 'a' + 10;
          if (c >= 'A' && c <= 'F') return c - 'A' + 10;
          return 0;
        };
        w.r = (nib(hx[1]) << 4) | nib(hx[2]);
        w.g = (nib(hx[3]) << 4) | nib(hx[4]);
        w.b = (nib(hx[5]) << 4) | nib(hx[6]);
      } else {
        w.r = w.g = w.b = 255;
      }
      const char *tx = o["text"] | "";
      strncpy(w.text, tx, sizeof(w.text) - 1);
      w.text[sizeof(w.text) - 1] = 0;
      const char *fmt = o["format"] | "";
      strncpy(w.format, fmt, sizeof(w.format) - 1);
      w.format[sizeof(w.format) - 1] = 0;

      w.useBitmap = false;
      w.useAtlas = false;


      // Live TTF: digit atlas for local 1Hz compose (same AA as web)
      if (isLocalLiveType(w.type) && w.font == WFont::TtfBlit) {
        JsonObject at = o["atlas"].as<JsonObject>();
        if (!at.isNull()) {
          int cellH = at["cellH"] | 0;
          if (cellH < 1) cellH = 1;
          if (cellH > 48) cellH = 48;
          w.atlasCellH = (uint8_t)cellH;
          JsonArray glyphs = at["glyphs"].as<JsonArray>();
          if (!glyphs.isNull()) {
            for (JsonObject g : glyphs) {
              if (w.atlasCount >= MAX_ATLAS_GLYPHS) break;
              const char *ch = g["ch"] | "";
              int gw = g["w"] | 0;
              int gh = g["h"] | 0;
              const char *b64 = g["pixels"] | "";
              if (!ch[0] || gw < 1 || gh < 1 || gw > 64 || gh > 48 || !b64[0]) continue;
              uint16_t needBytes = (uint16_t)(gw * gh);
              uint16_t off = bitmapPoolUsed;
              if (decodeBase64ToPool(b64, needBytes) != needBytes) break;
              uint8_t gi = w.atlasCount++;
              w.atlasCh[gi] = ch[0];
              w.atlasW[gi] = (uint8_t)gw;
              w.atlasH[gi] = (uint8_t)gh;
              w.atlasOff[gi] = off;
            }
            if (w.atlasCount > 0) w.useAtlas = true;
          }
        }
        if (!w.useAtlas) w.font = WFont::Default;  // TTF requested but no atlas
      } else if (!isLocalLiveType(w.type)) {
        // Static text/weather full-string TTF bitmap
        JsonObject bm = o["bitmap"].as<JsonObject>();
        if (!bm.isNull()) {
          int bw = bm["w"] | 0;
          int bh = bm["h"] | 0;
          const char *b64 = bm["pixels"] | "";
          if (bw > 0 && bh > 0 && bw <= 128 && bh <= 64 && b64[0]) {
            uint16_t needBytes = (uint16_t)(bw * bh);
            uint16_t off = bitmapPoolUsed;
            if (decodeBase64ToPool(b64, needBytes) == needBytes) {
              w.useBitmap = true;
              w.bw = (uint16_t)bw;
              w.bh = (uint16_t)bh;
              w.bitmapOff = off;
              w.font = WFont::TtfBlit;
            }
          }
        }
      }
      widgetCount++;
    }
  }
  hasLayout = true;
  layoutDirty = true;
  return true;
}

bool saveLayoutRaw(const String &body) {
  if (body.isEmpty()) return false;
  File f = LittleFS.open(LAYOUT_FILE, "w");
  if (!f) {
    Serial.println("layout save: open FAIL");
    return false;
  }
  size_t n = f.print(body);
  f.close();
  bool ok = n == body.length();
  Serial.printf("layout saved %u bytes %s\n", (unsigned)n, ok ? "OK" : "TRUNC");
  return ok;
}

bool applyLayoutFromJsonString(const String &body) {
  if (body.isEmpty()) return false;
  JsonDocument doc(&psramAlloc);
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.printf("layout JSON %s (len=%u heap=%u psram=%u)\n", err.c_str(),
                  (unsigned)body.length(), (unsigned)ESP.getFreeHeap(),
                  (unsigned)ESP.getFreePsram());
    return false;
  }
  if (!applyLayoutFromDoc(doc)) return false;
  Serial.printf("layout applied widgets=%u strip=%u\n", widgetCount, layoutStripHeight);
  return true;
}

bool loadLayoutFromFs() {
  if (!LittleFS.exists(LAYOUT_FILE)) {
    Serial.println("layout: no boot screen saved");
    return false;
  }
  File f = LittleFS.open(LAYOUT_FILE, "r");
  if (!f) {
    Serial.println("layout load: open FAIL");
    return false;
  }
  String body = f.readString();
  f.close();
  if (body.isEmpty()) return false;
  Serial.printf("layout boot file %u bytes\n", (unsigned)body.length());
  return applyLayoutFromJsonString(body);
}

void saveBrightnessPrefs() {
  Preferences prefs;
  if (!prefs.begin("panel", false)) return;
  prefs.putBool("bri_auto", brightnessAuto);
  prefs.putUChar("bri_man", brightnessManual);
  prefs.end();
}

void loadBrightnessPrefs() {
  Preferences prefs;
  if (!prefs.begin("panel", true)) return;
  brightnessAuto = prefs.getBool("bri_auto", true);
  brightnessManual = prefs.getUChar("bri_man", BRIGHTNESS_DEFAULT);
  prefs.end();
}

void handleLayout() {
  if (!requireAuth()) {
    rejectUnauthorized();
    return;
  }
  String body = server.arg("plain");
  if (body.isEmpty()) {
    addCors();
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"bad_json\"}");
    return;
  }
  JsonDocument doc(&psramAlloc);
  if (deserializeJson(doc, body) != DeserializationError::Ok) {
    addCors();
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"bad_json\"}");
    return;
  }

  // persist:true → save as boot screen (survives restart). Live push omits it.
  bool wantPersist = doc["persist"] | false;
  applyLayoutFromDoc(doc);
  bool saved = false;
  if (wantPersist) saved = saveLayoutRaw(body);

  JsonDocument out;
  out["ok"] = true;
  out["widgets"] = widgetCount;
  out["strip_height"] = layoutStripHeight;
  out["persisted"] = saved;
  out["boot_saved"] = LittleFS.exists(LAYOUT_FILE);
  sendJson(200, out);

  if (mode == Mode::Clock) {
    drawLayoutScreen();
  }
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
  html += (WiFi.status() == WL_CONNECTED) ? WiFi.localIP().toString() : "WiFi...";
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
  showBoot("WiFi setup...", "connecting...");
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(PANEL_HOSTNAME);
  WiFi.setSleep(false);  // critical: sleep + heavy DMA/draw drops STA
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);

  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  wm.setConnectTimeout(25);
  wm.setConnectRetries(3);

  // One-shot: clear stuck EUF2GNEW NVS so LEDPanel-Setup portal can start.
  {
    Preferences prefs;
    if (prefs.begin("panel", false)) {
      if (!prefs.getBool("wifi_nvs_clr1", false)) {
        Serial.println("WiFi: clearing stuck saved credentials (once)");
        WiFi.disconnect(true, true);
        delay(200);
        wm.resetSettings();
        prefs.putBool("wifi_nvs_clr1", true);
      }
      prefs.end();
    }
  }

#if defined(WIFI_SSID) && defined(WIFI_PASS)
  if (WIFI_SSID[0]) {
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) delay(200);
  }
#endif

  if (WiFi.status() != WL_CONNECTED) {
    showBoot("WiFi setup...", "AP: LEDPanel-Setup");
    if (!wm.autoConnect("LEDPanel-Setup")) {
      showBoot("WiFi FAILED", "reboot...");
      delay(3000);
      ESP.restart();
    }
  }

  WiFi.setSleep(false);
  wifiWasConnected = true;
  showBoot("WiFi OK", WiFi.localIP().toString().c_str());
  delay(800);

  if (MDNS.begin(PANEL_HOSTNAME)) MDNS.addService("http", "tcp", 80);

  // Explicit TZ + multi-server NTP (Slovakia / EU CET-CEST)
  setenv("TZ", NTP_TZ, 1);
  tzset();
  configTzTime(NTP_TZ, NTP_SERVER, "time.google.com", "sk.pool.ntp.org");
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("=== panel_wifi (boot screen) ===");

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount FAIL");
  } else {
    Serial.printf("LittleFS OK free=%u\n", (unsigned)LittleFS.totalBytes() - (unsigned)LittleFS.usedBytes());
  }
  loadBrightnessPrefs();

  // Read boot layout early (before DMA/WiFi eat heap), apply after panel is up
  String bootBody;
  if (LittleFS.exists(LAYOUT_FILE)) {
    File f = LittleFS.open(LAYOUT_FILE, "r");
    if (f) {
      bootBody = f.readString();
      f.close();
      Serial.printf("boot screen preload %u bytes\n", (unsigned)bootBody.length());
    }
  }

  setupPanel();
  showBoot("Booting...");
  shtc3Ok = initShtc3();
  if (shtc3Ok) {
    showBoot("SHTC3 OK", "T/H sensor");
    delay(400);
    refreshShtc3();
  } else {
    showBoot("SHTC3 FAIL", "T/H = --");
    delay(600);
  }
  setupWifi();

  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/notify", HTTP_POST, handleNotify);
  server.on("/api/brightness", HTTP_POST, handleBrightness);
  server.on("/api/clear", HTTP_POST, handleClear);
  server.on("/api/layout", HTTP_POST, handleLayout);
  server.on("/api/notify", HTTP_OPTIONS, handleOptions);
  server.on("/api/brightness", HTTP_OPTIONS, handleOptions);
  server.on("/api/clear", HTTP_OPTIONS, handleOptions);
  server.on("/api/layout", HTTP_OPTIONS, handleOptions);
  server.onNotFound([]() {
    addCors();
    server.send(404, "application/json", "{\"ok\":false,\"error\":\"not_found\"}");
  });
  const char *hdrs[] = {"Authorization"};
  server.collectHeaders(hdrs, 1);
  server.begin();

  mode = Mode::Clock;
  applyBrightness();
  if (bootBody.length() && applyLayoutFromJsonString(bootBody)) {
    showBoot("Boot screen", "restored");
    delay(500);
  } else if (loadLayoutFromFs()) {
    showBoot("Boot screen", "restored");
    delay(500);
  } else {
    showBoot("No boot screen", "set in hub");
    delay(600);
  }
  drawClock();
  Serial.printf("Ready http://%s/  mDNS http://%s.local/\n",
                WiFi.localIP().toString().c_str(), PANEL_HOSTNAME);
}


void loop() {
  pumpServer();
  ensureWifi();
  refreshShtc3();

  if (mode == Mode::Notify) {
    if (millis() - lastRenderPoll >= 50) {
      lastRenderPoll = millis();
      render();
    }
    return;
  }

  // Draw on second change / dirty, then sleep-align to next second while pumping
  render();
  if (mode == Mode::Clock && !layoutDirty && !sensorDirty && !wifiIpDirty) {
    waitAlignedToNextSecond();
  } else {
    delay(2);
  }
}

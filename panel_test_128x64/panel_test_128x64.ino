/*
 * v53 LOCKED map + double-buffer + v49-style marquee (50% slower) 2nd in loop
 */

#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <Adafruit_GFX.h>

MatrixPanel_I2S_DMA *dma = nullptr;

class MappedPanel : public Adafruit_GFX {
 public:
  MappedPanel() : Adafruit_GFX(128, 64) {}

  void drawPixel(int16_t x, int16_t y, uint16_t color) override {
    if (x < 0 || y < 0 || x >= 128 || y >= 64 || !dma) return;
    int16_t cx = x;
    int16_t cy = y;
    if ((cy & 16) == 0) {
      cx += cx + 1;
    } else {
      cx += cx;
    }
    cy = (cy >> 5) * 16 + (cy & 0b00001111);
    if (cx >= 0 && cy >= 0 && cx < 256 && cy < 32) dma->drawPixel(cx, cy, color);
  }
};

MappedPanel panel;

uint16_t cW, cBlk, cR, cG, cB, cY, cC, cM;

void beginFrame() { dma->fillScreen(0); }
void endFrame() { dma->flipDMABuffer(); }

const uint8_t SMILEY[32] PROGMEM = {
  0x03, 0xC0, 0x0C, 0x30, 0x10, 0x08, 0x20, 0x04,
  0x46, 0x62, 0x46, 0x62, 0x40, 0x02, 0x40, 0x02,
  0x48, 0x12, 0x44, 0x22, 0x23, 0xC4, 0x20, 0x04,
  0x10, 0x08, 0x0C, 0x30, 0x03, 0xC0, 0x00, 0x00
};

void drawBitmap1bpp(int16_t x0, int16_t y0, const uint8_t *bmp, int16_t w, int16_t h,
                    uint16_t fg, int scale) {
  for (int16_t y = 0; y < h; y++) {
    for (int16_t x = 0; x < w; x++) {
      int bit = 7 - (x & 7);
      int idx = y * ((w + 7) / 8) + (x / 8);
      if (pgm_read_byte(&bmp[idx]) & (1 << bit)) {
        panel.fillRect(x0 + x * scale, y0 + y * scale, scale, scale, fg);
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println("=== v53 marquee 2nd, 50% slower ===");

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
  dma->setBrightness8(70);
  dma->setLatBlanking(8);

  cW = dma->color565(255, 255, 255);
  cBlk = dma->color565(0, 0, 0);
  cR = dma->color565(255, 40, 40);
  cG = dma->color565(40, 255, 80);
  cB = dma->color565(60, 140, 255);
  cY = dma->color565(255, 220, 40);
  cC = dma->color565(40, 255, 255);
  cM = dma->color565(255, 60, 200);
}

void showTextScreen() {
  beginFrame();
  panel.setTextWrap(false);
  panel.setTextSize(2);
  panel.setTextColor(cC);
  panel.setCursor(4, 4);
  panel.print("Waveshare");
  panel.setTextSize(1);
  panel.setTextColor(cW);
  panel.setCursor(4, 24);
  panel.print("ESP32-S3 RGB Matrix");
  panel.setTextColor(cY);
  panel.setCursor(4, 36);
  panel.print("128x64 HUB75 OK");
  panel.setTextColor(cG);
  panel.setCursor(4, 48);
  panel.print("FM6124 + map #825");
  endFrame();
}

void showBigHello() {
  beginFrame();
  panel.setTextWrap(false);
  panel.setTextSize(3);
  panel.setTextColor(cW);
  panel.setCursor(8, 8);
  panel.print("HELLO");
  panel.setTextSize(2);
  panel.setTextColor(cM);
  panel.setCursor(16, 40);
  panel.print("WORLD!");
  endFrame();
}

void showImage() {
  beginFrame();
  for (int i = 0; i < 6; i++) {
    uint16_t cols[] = {cR, cG, cB, cY, cC, cM};
    panel.fillRect(0, i * 10, 40, 10, cols[i]);
  }
  drawBitmap1bpp(56, 8, SMILEY, 16, 16, cY, 3);
  panel.setTextSize(1);
  panel.setTextColor(cW);
  panel.setCursor(52, 56);
  panel.print("smiley");
  endFrame();
}

void showMarquee() {
  // v49 style (double-buffer + delay) — only slight hitch, no weird flicker.
  // delay 50ms = 50% slower than original 25ms.
  const char *msg = "  LED panel funguje! 128x64 outdoor 1/16  ";
  for (int offset = 0; offset < 160; offset++) {
    beginFrame();
    panel.setTextWrap(false);
    panel.setTextSize(2);
    panel.setTextColor(cG);
    panel.setCursor(64 - offset, 22);
    panel.print(msg);
    endFrame();
    delay(50);
  }
}

void showBrightness() {
  // Ramp 10 → 255 → 10 while showing level on screen
  auto drawLevel = [&](uint8_t b) {
    beginFrame();
    panel.setTextWrap(false);
    panel.setTextSize(2);
    panel.setTextColor(cW);
    panel.setCursor(8, 8);
    panel.print("JAS");
    panel.setCursor(56, 8);
    panel.print(b);
    panel.setTextSize(1);
    panel.setTextColor(cY);
    panel.setCursor(8, 36);
    panel.print("setBrightness8()");
    // bar
    int w = map(b, 0, 255, 0, 120);
    panel.drawRect(4, 50, 120, 10, cW);
    panel.fillRect(4, 50, w, 10, cC);
    endFrame();
    dma->setBrightness8(b);
  };

  for (int b = 10; b <= 255; b += 5) {
    drawLevel((uint8_t)b);
    delay(40);
  }
  for (int b = 255; b >= 10; b -= 5) {
    drawLevel((uint8_t)b);
    delay(40);
  }
  dma->setBrightness8(70);
}

void loop() {
  showTextScreen();
  delay(5000);

  showMarquee();  // 2nd

  showBigHello();
  delay(4000);

  showImage();
  delay(5000);

  showBrightness();
}

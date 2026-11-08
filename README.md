# Waveshare ESP32-S3-RGB-Matrix + P2.5 128×64 outdoor HUB75

Working config for a **Waveshare ESP32-S3-RGB-Matrix (dual mics)** board with a **128×64 / 1/16-scan outdoor** panel that has chips like **FM6124 + SM5166** (and related 2012 / 7258 labels).

There was **no ready-made recipe** online for this exact combo. This repo documents what finally worked so others do not spend hours on four-scan mapping.

## Panel labels seen on the PCB

- `YS-P25-320x160-16s-1415-2M-B1`
- `YP2.5-6124HG15P-Y2055`
- Driver / mux marks: **6124**, **5166**, **2012**, **7258**

Physical resolution used in software: **128×64**.

## Working configuration (locked)

| Setting | Value |
|---|---|
| Library | [ESP32-HUB75-MatrixPanel-DMA](https://github.com/mrcodetastic/ESP32-HUB75-MatrixPanel-DMA) |
| DMA size | **256 × 32** (width×2, height÷2 — four-scan trick) |
| Chain | 1 |
| Shift driver | **FM6124** |
| Line decoder | **default / Type-138** — do **not** set `SM5266P` |
| `clkphase` | `false` |
| `E` pin | `-1` (not used on this 1/16 panel) |
| Double buffer | `true` (helps scrolling) |

### Waveshare ESP32-S3-RGB-Matrix HUB75 pins

```text
R1=4  G1=5  B1=6  R2=7  G2=15 B2=16
A=18  B=8   C=3   D=42  E=-1
LAT=40 OE=2  CLK=41
```

### Pixel remap (critical)

This outdoor 1/16 panel needs a **custom four-scan map** (same geometry class as [issue #825](https://github.com/mrcodetastic/ESP32-HUB75-MatrixPanel-DMA/issues/825), `pxbase = 1`):

```cpp
void mapPixel(int16_t x, int16_t y, uint16_t color) {
  if (x < 0 || y < 0 || x >= 128 || y >= 64) return;
  int16_t cx = x;
  int16_t cy = y;
  if ((cy & 16) == 0) {
    cx += cx + 1;   // 2*x + 1
  } else {
    cx += cx;       // 2*x
  }
  cy = (cy >> 5) * 16 + (cy & 0x0F);
  if (cx >= 0 && cy >= 0 && cx < 256 && cy < 32)
    dma->drawPixel(cx, cy, color);
}
```

Wrap that in an `Adafruit_GFX` subclass (`drawPixel` override) so `print()`, `fillRect()`, etc. all go through the map.

### Brightness

```cpp
dma->setBrightness8(0..255);  // e.g. 70 for indoor testing
dma->setLatBlanking(8);
```

## What failed / what to avoid

- **`line_decoder = SM5266P`**: SM5166 on these panels is a **Type-138** mux, not SM5266P. With SM5266P, solids/bars can look almost OK while **vertical lines / text stay broken**. Dropping SM5266P fixed H+V+border together with the #825 map.
- Native **128×64** DMA without four-scan remap → doubled / striped image.
- Built-in `FOUR_SCAN_64` + various `pixelBase` values → colors sometimes OK, geometry still wrong.
- Flipping the double-buffer **as fast as possible** during scroll → heavy flicker. Cap ~30 FPS or use ~25–50 ms delay between frames.

## LAN Hub (multi-user web)

See [`hub/`](hub/): Next.js app for LAN control (login, panel registry, admin notify strip).

```bash
cd hub && npm install && npm run dev
```

Open http://localhost:3000 — `admin` / `admin`. Internet/Nginx later; MVP is LAN-only.

## Wi-Fi firmware (live data, no reflash)

See [`panel_wifi/`](panel_wifi/): NTP clock on the panel + HTTP JSON API for a separate web UI.

- First boot: join AP **`LEDPanel-Setup`** (or put `WIFI_SSID` / `WIFI_PASS` in `config.h`)
- Then open `http://<ip>/` or `http://ledpanel.local/`
- `POST /api/notify` — show text without uploading a new sketch
- `POST /api/brightness` — `auto` (day/night curve) or `manual` 0–255
- `GET /api/status` — IP, time, brightness, mode

## Demo sketch

See [`panel_test_128x64/panel_test_128x64.ino`](panel_test_128x64/panel_test_128x64.ino):

- solid / text / image / brightness ramp / scrolling text
- Arduino FQBN used here:

```text
esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=32M,PartitionScheme=app13M_data7M_32MB,PSRAM=opi,USBMode=hwcdc
```

## Quick checklist if your panel looks wrong

1. DMA **256×32**, not 128×64  
2. **FM6124**, `clkphase = false`, **E = -1**  
3. **No SM5266P** when the chip is SM5166  
4. Apply the **#825-style** remap above  
5. Verify with: full red/green/blue → single H line → single V line → border → text  

## Credits / related links

- Library: [mrcodetastic/ESP32-HUB75-MatrixPanel-DMA](https://github.com/mrcodetastic/ESP32-HUB75-MatrixPanel-DMA)  
- Remap geometry: [issue #825](https://github.com/mrcodetastic/ESP32-HUB75-MatrixPanel-DMA/issues/825)  
- Outdoor SM5166 notes: [discussion #826](https://github.com/mrcodetastic/ESP32-HUB75-MatrixPanel-DMA/discussions/826), [issue #702](https://github.com/mrcodetastic/ESP32-HUB75-MatrixPanel-DMA/issues/702)  
- Board: [Waveshare ESP32-S3-RGB-Matrix](https://www.waveshare.com/)

## License

MIT — use freely; please star/link if this saved you time.

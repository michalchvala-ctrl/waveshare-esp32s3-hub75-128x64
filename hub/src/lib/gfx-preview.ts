import fontJson from "./glcdfont.json";
import { PANEL_H, PANEL_W, type Widget } from "./layout";
import {
  CLASSIC_CHAR_H,
  CLASSIC_CHAR_W,
  foldGfxText,
  forEachGlyphPixel,
  measureText,
  normalizeFont,
  type FontId,
} from "./gfx-fonts";
import { isTtfFont, type GrayBitmap } from "./ttf-fonts";
import { formatClock, formatDate } from "./datetime-format";
import {
  effectBrightness,
  effectScrollDx,
  scaleHexColor,
} from "./widget-effects";

const FONT = fontJson as number[];

export const GFX_CHAR_W = CLASSIC_CHAR_W;
export const GFX_CHAR_H = CLASSIC_CHAR_H;

export type WidgetRender = Widget & { _gray?: GrayBitmap };

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

function plotPixel(
  data: Uint8ClampedArray,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  blendMax: boolean
) {
  if (x < 0 || y < 0 || x >= PANEL_W || y >= PANEL_H) return;
  const o = (y * PANEL_W + x) * 4;
  if (blendMax) {
    data[o] = Math.max(data[o], r);
    data[o + 1] = Math.max(data[o + 1], g);
    data[o + 2] = Math.max(data[o + 2], b);
  } else {
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
  }
  data[o + 3] = 255;
}

function blitGray(
  data: Uint8ClampedArray,
  x0: number,
  y0: number,
  gray: GrayBitmap,
  color: string
) {
  const [cr, cg, cb] = hexToRgb(color);
  for (let yy = 0; yy < gray.h; yy++) {
    for (let xx = 0; xx < gray.w; xx++) {
      const v = gray.pixels[yy * gray.w + xx] ?? 0;
      if (!v) continue;
      plotPixel(
        data,
        x0 + xx,
        y0 + yy,
        Math.round((cr * v) / 255),
        Math.round((cg * v) / 255),
        Math.round((cb * v) / 255),
        true
      );
    }
  }
}

function scaleRgb(
  r: number,
  g: number,
  b: number,
  bri: number
): [number, number, number] {
  if (bri >= 255) return [r, g, b];
  return [
    Math.round((r * bri) / 255),
    Math.round((g * bri) / 255),
    Math.round((b * bri) / 255),
  ];
}

function drawClassicChar(
  data: Uint8ClampedArray,
  x0: number,
  y0: number,
  ch: number,
  size: number,
  r: number,
  g: number,
  b: number
) {
  if (ch < 0 || ch > 255) ch = 0x3f;
  const base = ch * 5;
  for (let i = 0; i < 5; i++) {
    let line = FONT[base + i] ?? 0;
    for (let j = 0; j < 8; j++, line >>= 1) {
      if (!(line & 1)) continue;
      for (let sy = 0; sy < size; sy++) {
        for (let sx = 0; sx < size; sx++) {
          plotPixel(data, x0 + i * size + sx, y0 + j * size + sy, r, g, b, false);
        }
      }
    }
  }
}

function drawClassicText(
  data: Uint8ClampedArray,
  x: number,
  y: number,
  text: string,
  size: number,
  r: number,
  g: number,
  b: number
) {
  const folded = foldGfxText(text);
  let cx = x;
  for (let i = 0; i < folded.length; i++) {
    drawClassicChar(data, cx, y, folded.charCodeAt(i), size, r, g, b);
    cx += CLASSIC_CHAR_W * size;
  }
}

function drawGfxText(
  data: Uint8ClampedArray,
  x: number,
  y: number,
  text: string,
  font: FontId,
  size: number,
  color: string,
  bri = 255
) {
  let [r, g, b] = hexToRgb(color);
  [r, g, b] = scaleRgb(r, g, b, bri);
  if (bri <= 0) return;
  if (font === "default") {
    drawClassicText(data, x, y, text, size, r, g, b);
    return;
  }
  forEachGlyphPixel(text, font, size, x, y, (px, py) => {
    plotPixel(data, px, py, r, g, b, false);
  });
}

export type LiveSensor = {
  temp_c: number | null;
  humidity: number | null;
  temp_display?: string | null;
  humidity_display?: string | null;
  ok?: boolean;
};

export function formatTempLabel(tempC: number | null | undefined, display?: string | null): string {
  if (display) return display;
  if (tempC == null || Number.isNaN(tempC)) return "--.-C";
  return `${tempC.toFixed(1)}C`;
}

export function formatHumidityLabel(
  humidity: number | null | undefined,
  display?: string | null
): string {
  if (display) return display;
  if (humidity == null || Number.isNaN(humidity)) return "--%";
  return `${Math.round(humidity)}%`;
}

export function widgetLabel(w: Widget, now: Date, sensor?: LiveSensor | null): string {
  switch (w.type) {
    case "clock":
      return formatClock(now, w.format);
    case "date":
      return formatDate(now, w.format);
    case "temp":
      return formatTempLabel(sensor?.temp_c, sensor?.temp_display);
    case "humidity":
      return formatHumidityLabel(sensor?.humidity, sensor?.humidity_display);
    case "weather":
      return w.text || "Oblacno";
    default:
      return w.text || "Text";
  }
}

export function widgetBox(w: WidgetRender, label: string) {
  if (w._gray) {
    return {
      x: w.x,
      y: w.y,
      width: w._gray.w,
      height: w._gray.h,
      baseline: false,
    };
  }
  if (isTtfFont(w.font)) {
    // Approximate until raster ready
    const px = w.size >= 3 ? 22 : w.size >= 2 ? 14 : 9;
    return {
      x: w.x,
      y: w.y,
      width: Math.min(PANEL_W, Math.ceil(label.length * px * 0.55) + 2),
      height: Math.ceil(px * 1.2) + 2,
      baseline: false,
    };
  }
  const font = normalizeFont(w.font);
  const m = measureText(label, font, w.size);
  return {
    x: w.x,
    y: w.y + m.top,
    width: m.width,
    height: m.height,
    baseline: m.baseline,
  };
}

export function clearBuffer(data: Uint8ClampedArray, rgb: [number, number, number] = [0, 0, 0]) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
}

export function fillRect(
  data: Uint8ClampedArray,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: [number, number, number]
) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= PANEL_W || yy >= PANEL_H) continue;
      const o = (yy * PANEL_W + xx) * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
  }
}

export function renderPanelFrame(
  data: Uint8ClampedArray,
  widgets: WidgetRender[],
  stripHeight: number,
  now: Date,
  sensor?: LiveSensor | null,
  animMs?: number
) {
  const t = animMs ?? now.getTime();
  clearBuffer(data, [0, 0, 0]);
  fillRect(data, 0, 0, PANEL_W, stripHeight, [8, 8, 8]);
  for (const w of widgets) {
    const label = widgetLabel(w, now, sensor);
    const bri = effectBrightness(w.effect, w.effect_speed, t);
    if (bri <= 0) continue;
    const box = widgetBox(w, label);
    const dx = effectScrollDx(w.effect, w.effect_speed, t, box.width);
    const x = w.x + dx;
    const color = scaleHexColor(w.color, bri);
    if (w._gray) {
      blitGray(data, x, w.y, w._gray, color);
      continue;
    }
    if (isTtfFont(w.font)) {
      // Waiting for raster — skip hard edges
      continue;
    }
    const font = normalizeFont(w.font);
    drawGfxText(data, x, w.y, label, font, w.size, w.color, bri);
  }
}

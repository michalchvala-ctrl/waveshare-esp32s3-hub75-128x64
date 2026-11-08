/** Bundled TrueType fonts — real AA via canvas alpha → LED brightness. */

export type GfxFontId = "default" | "tomthumb" | "org01";
export type TtfFontId = "ttf:roboto" | "ttf:inter" | "ttf:pressstart";
export type AnyFontId = GfxFontId | TtfFontId | string;

export type FontOption = {
  id: AnyFontId;
  label: string;
  /** CSS font-family when TTF */
  family?: string;
  /** public URL */
  url?: string;
  ttf?: boolean;
};

export const FONT_OPTIONS: FontOption[] = [
  { id: "default", label: "Default 5×7" },
  { id: "tomthumb", label: "TomThumb (bitmap)" },
  { id: "org01", label: "Org_01 (bitmap)" },
  {
    id: "ttf:roboto",
    label: "Roboto (TTF AA)",
    family: "LedRoboto",
    url: "/fonts/Roboto-Regular.ttf",
    ttf: true,
  },
  {
    id: "ttf:inter",
    label: "Inter (TTF AA)",
    family: "LedInter",
    url: "/fonts/Inter-Regular.ttf",
    ttf: true,
  },
  {
    id: "ttf:pressstart",
    label: "Press Start 2P (TTF)",
    family: "LedPressStart",
    url: "/fonts/PressStart2P-Regular.ttf",
    ttf: true,
  },
];

export function isTtfFont(font?: string | null): boolean {
  return !!font && font.startsWith("ttf:");
}

export function fontOption(font?: string | null): FontOption {
  return FONT_OPTIONS.find((f) => f.id === font) || FONT_OPTIONS[0];
}

export function ttfCssFamily(font?: string | null): string {
  return fontOption(font).family || "sans-serif";
}

/** Map widget size 1|2|3 → px for TTF (fits 128×64). */
export function ttfPx(size: number): number {
  // Prefer sizes that stay readable after LED-style downsample
  if (size >= 3) return 20;
  if (size >= 2) return 14;
  return 10;
}

/** Supersample factor — matches LED bloom better than 1× canvas AA. */
const TTF_SS = 3;

let fontsReady: Promise<void> | null = null;

export function ensureTtfFontsLoaded(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  if (!fontsReady) {
    fontsReady = (async () => {
      const faces: FontFace[] = [];
      for (const f of FONT_OPTIONS) {
        if (!f.ttf || !f.family || !f.url) continue;
        const face = new FontFace(f.family, `url(${f.url})`);
        faces.push(face);
        document.fonts.add(face);
      }
      await Promise.all(faces.map((f) => f.load().catch(() => null)));
      await document.fonts.ready;
    })();
  }
  return fontsReady;
}

export type GrayBitmap = { w: number; h: number; pixels: Uint8Array };

/** Rasterize text with TTF → grayscale (supersampled, then max-pooled). */
export async function rasterizeTtfText(
  text: string,
  fontId: string,
  size: number
): Promise<GrayBitmap> {
  await ensureTtfFontsLoaded();
  const family = ttfCssFamily(fontId);
  const px = ttfPx(size);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { w: 1, h: 1, pixels: new Uint8Array([0]) };

  const fontCss = `${px}px "${family}"`;
  ctx.font = fontCss;
  const metrics = ctx.measureText(text || " ");
  const asc = metrics.actualBoundingBoxAscent || px * 0.8;
  const desc = metrics.actualBoundingBoxDescent || px * 0.2;
  let w = Math.ceil(Math.max(1, metrics.width)) + 2;
  let h = Math.ceil(asc + desc) + 2;
  if (w > 128) w = 128;
  if (h > 48) h = 48;

  const ss = TTF_SS;
  canvas.width = w * ss;
  canvas.height = h * ss;
  ctx.setTransform(ss, 0, 0, ss, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = fontCss;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  const tx = 1;
  const ty = Math.ceil(asc) + 1;
  const label = text || " ";
  // Soft fonts: light stroke ≈ LED bloom. Pixel font stays crisp.
  if (fontId !== "ttf:pressstart") {
    ctx.lineWidth = size <= 1 ? 0.7 : 0.45;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText(label, tx, ty);
  }
  ctx.fillText(label, tx, ty);

  const img = ctx.getImageData(0, 0, w * ss, h * ss);
  const pixels = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      let max = 0;
      let sum = 0;
      let n = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = ((yy * ss + sy) * w * ss + (xx * ss + sx)) * 4;
          const a = img.data[i + 3];
          const lum = img.data[i];
          const v = a > 0 ? a : lum;
          if (v > max) max = v;
          sum += v;
          n++;
        }
      }
      // Mix max (crisp stem) + average (soft edge) — readable on PC and LED
      const avg = n ? sum / n : 0;
      let v = Math.round(max * 0.72 + avg * 0.28);
      // Gamma lift so mid AA does not vanish on dark pixelated preview
      if (v > 0 && v < 255) {
        v = Math.min(255, Math.round(255 * Math.pow(v / 255, 0.72)));
      }
      pixels[yy * w + xx] = v;
    }
  }
  return { w, h, pixels };
}

export function bitmapToBase64(pixels: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < pixels.length; i++) bin += String.fromCharCode(pixels[i]);
  return btoa(bin);
}

export function base64ToBitmap(b64: string, w: number, h: number): GrayBitmap {
  const bin = atob(b64);
  const pixels = new Uint8Array(w * h);
  for (let i = 0; i < pixels.length && i < bin.length; i++) {
    pixels[i] = bin.charCodeAt(i) & 0xff;
  }
  return { w, h, pixels };
}

export type AtlasGlyph = {
  ch: string;
  w: number;
  h: number;
  pixels: string; // base64
  /** client preview */
  _gray?: GrayBitmap;
};

export type DigitAtlas = {
  chars: string;
  cellH: number;
  glyphs: AtlasGlyph[];
};

/** Base chars for live TTF atlas (clock/date/temp/humidity) on ESP. */
export const LIVE_ATLAS_CHARS = "0123456789:.-/%AMP ";

const atlasCache = new Map<string, DigitAtlas>();

/** Rasterize digit atlas once per font+size — ESP composes HH:MM:SS each second. */
export async function rasterizeDigitAtlas(
  fontId: string,
  size: number
): Promise<DigitAtlas> {
  const key = `v3|${fontId}|${size}`;
  const hit = atlasCache.get(key);
  if (hit) return hit;

  await ensureTtfFontsLoaded();
  const glyphs: AtlasGlyph[] = [];
  let cellH = 1;
  for (const ch of LIVE_ATLAS_CHARS) {
    const gray = await rasterizeTtfText(ch, fontId, size);
    cellH = Math.max(cellH, gray.h);
    glyphs.push({
      ch,
      w: gray.w,
      h: gray.h,
      pixels: bitmapToBase64(gray.pixels),
      _gray: gray,
    });
  }
  const atlas: DigitAtlas = { chars: LIVE_ATLAS_CHARS, cellH, glyphs };
  atlasCache.set(key, atlas);
  return atlas;
}

export function composeAtlasString(
  atlas: DigitAtlas,
  text: string
): GrayBitmap {
  const glyphs = new Map(atlas.glyphs.map((g) => [g.ch, g]));
  let width = 0;
  for (const ch of text) {
    const g = glyphs.get(ch);
    width += g ? g.w : Math.max(2, Math.floor(atlas.cellH / 3));
  }
  width = Math.max(1, Math.min(128, width));
  const h = Math.min(48, atlas.cellH);
  const pixels = new Uint8Array(width * h);
  let x = 0;
  for (const ch of text) {
    const g = glyphs.get(ch);
    if (!g || !g._gray) {
      x += Math.max(2, Math.floor(h / 3));
      continue;
    }
    const src = g._gray;
    const y0 = Math.max(0, h - src.h); // bottom-align in cell
    for (let yy = 0; yy < src.h; yy++) {
      for (let xx = 0; xx < src.w; xx++) {
        const dx = x + xx;
        const dy = y0 + yy;
        if (dx >= width || dy >= h) continue;
        const v = src.pixels[yy * src.w + xx] ?? 0;
        const o = dy * width + dx;
        if (v > pixels[o]) pixels[o] = v;
      }
    }
    x += src.w;
  }
  return { w: width, h, pixels };
}

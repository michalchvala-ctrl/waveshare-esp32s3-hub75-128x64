import tomthumb from "./tomthumb.json";
import org01 from "./org01.json";

export type FontId = "default" | "tomthumb" | "org01";

type GfxGlyph = {
  bo: number;
  w: number;
  h: number;
  xa: number;
  xo: number;
  yo: number;
};

type GfxFontJson = {
  first: number;
  last: number;
  yAdvance: number;
  bitmaps: number[];
  glyphs: GfxGlyph[];
};

const FONTS: Record<Exclude<FontId, "default">, GfxFontJson> = {
  tomthumb: tomthumb as GfxFontJson,
  org01: org01 as GfxFontJson,
};

/** Classic Adafruit GLCD: top-left cursor, 6×8 cell. */
export const CLASSIC_CHAR_W = 6;
export const CLASSIC_CHAR_H = 8;

export function normalizeFont(font?: string | null): FontId {
  // TTF handled separately via raster bitmaps
  if (font === "tomthumb" || font === "org01") return font;
  return "default";
}

/**
 * GFX fonts (default/TomThumb/Org_01) are ASCII 32–126 only.
 * Fold common Slovak/Czech diacritics so preview matches the panel.
 */
export function foldGfxText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[Đđ]/g, (c) => (c === "Đ" ? "D" : "d"))
    .replace(/[Łł]/g, (c) => (c === "Ł" ? "L" : "l"))
    .replace(/[ß]/g, "ss")
    .replace(/[€]/g, "E")
    .replace(/[^\x20-\x7E]/g, "?");
}

export function isGfxFont(font: FontId): font is "tomthumb" | "org01" {
  return font === "tomthumb" || font === "org01";
}

export function getGfxFont(font: FontId): GfxFontJson | null {
  if (!isGfxFont(font)) return null;
  return FONTS[font];
}

/** Measure rendered text width/height and top offset relative to cursor y. */
export function measureText(
  text: string,
  font: FontId,
  size: number
): { width: number; height: number; top: number; baseline: boolean } {
  const s = Math.max(1, size | 0);
  const folded = foldGfxText(text);
  if (font === "default") {
    return {
      width: Math.max(CLASSIC_CHAR_W * s, folded.length * CLASSIC_CHAR_W * s),
      height: CLASSIC_CHAR_H * s,
      top: 0,
      baseline: false,
    };
  }
  const f = FONTS[font];
  let width = 0;
  let minYo = 0;
  let maxBottom = 0;
  for (let i = 0; i < folded.length; i++) {
    const code = folded.charCodeAt(i);
    const g = glyphFor(f, code);
    width += (g?.xa ?? 0) * s;
    if (g && g.w > 0 && g.h > 0) {
      const yo = g.yo * s;
      minYo = Math.min(minYo, yo);
      maxBottom = Math.max(maxBottom, yo + g.h * s);
    }
  }
  if (maxBottom <= minYo) {
    return { width, height: f.yAdvance * s, top: -(f.yAdvance - 1) * s, baseline: true };
  }
  return {
    width,
    height: maxBottom - minYo,
    top: minYo,
    baseline: true,
  };
}

function glyphFor(f: GfxFontJson, code: number): GfxGlyph | null {
  if (code < f.first || code > f.last) return null;
  return f.glyphs[code - f.first] ?? null;
}

export function forEachGlyphPixel(
  text: string,
  font: FontId,
  size: number,
  cursorX: number,
  cursorY: number,
  plot: (x: number, y: number) => void
) {
  const s = Math.max(1, size | 0);
  if (font === "default") {
    // Handled by classic drawer in gfx-preview
    return;
  }
  const f = FONTS[font];
  const folded = foldGfxText(text);
  let cx = cursorX;
  for (let i = 0; i < folded.length; i++) {
    const code = folded.charCodeAt(i);
    const g = glyphFor(f, code);
    if (!g) {
      cx += s;
      continue;
    }
    if (g.w > 0 && g.h > 0) {
      let bo = g.bo;
      let bits = 0;
      let bit = 0;
      for (let yy = 0; yy < g.h; yy++) {
        for (let xx = 0; xx < g.w; xx++) {
          if (!(bit++ & 7)) bits = f.bitmaps[bo++] ?? 0;
          if (bits & 0x80) {
            for (let sy = 0; sy < s; sy++) {
              for (let sx = 0; sx < s; sx++) {
                plot(
                  cx + g.xo * s + xx * s + sx,
                  cursorY + g.yo * s + yy * s + sy
                );
              }
            }
          }
          bits <<= 1;
        }
      }
    }
    cx += g.xa * s;
  }
}

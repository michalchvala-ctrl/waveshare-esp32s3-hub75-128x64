export const PANEL_W = 128;
export const PANEL_H = 64;

export type WidgetType =
  | "text"
  | "clock"
  | "date"
  | "temp"
  | "humidity"
  | "weather";

/** GFX bitmap fonts or ttf:* TrueType with AA */
export type WidgetFont =
  | "default"
  | "tomthumb"
  | "org01"
  | "ttf:roboto"
  | "ttf:inter"
  | "ttf:pressstart"
  | string;

export type WidgetBitmap = {
  w: number;
  h: number;
  /** base64 grayscale 0–255 */
  pixels: string;
};

export type WidgetAtlasGlyph = {
  ch: string;
  w: number;
  h: number;
  pixels: string;
};

/** Digit atlas for TTF clock/date/temp/humidity — ESP composes locally @ 1Hz */
export type WidgetAtlas = {
  chars: string;
  cellH: number;
  glyphs: WidgetAtlasGlyph[];
};

export type WidgetEffect = "none" | "blink" | "pulse" | "scroll";

export type Widget = {
  id: string;
  type: WidgetType;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  /** clock/date format preset (Windows-like), e.g. HH:mm or dd.MM.yyyy */
  format?: string;
  color: string; // #RRGGBB
  size: 1 | 2 | 3;
  font?: WidgetFont;
  /** none | blink | pulse | scroll */
  effect?: WidgetEffect;
  /** 1 = slow … 10 = fast */
  effect_speed?: number;
  /** @deprecated fake glow — ignored; TTF AA replaces it */
  soft?: boolean;
  /** Pre-rasterized TTF glyph run for static text/weather */
  bitmap?: WidgetBitmap;
  /** TTF digit atlas for live widgets */
  atlas?: WidgetAtlas;
};

export type PanelLayout = {
  panel_id: number;
  strip_height: number;
  widgets: Widget[];
  updated_at: string;
};

export function defaultLayout(panelId: number, stripHeight = 16): PanelLayout {
  return {
    panel_id: panelId,
    strip_height: stripHeight,
    updated_at: new Date().toISOString(),
    widgets: [
      {
        id: "clock1",
        type: "clock",
        x: 4,
        y: stripHeight + 4,
        color: "#FFFFFF",
        size: 2,
        font: "default",
        format: "HH:mm:ss",
      },
      {
        id: "date1",
        type: "date",
        x: 4,
        y: stripHeight + 28,
        color: "#3DFF80",
        size: 1,
        font: "default",
        format: "dd.MM.yyyy",
      },
    ],
  };
}

function normalizeFont(font?: string): WidgetFont {
  if (!font) return "default";
  if (
    font === "tomthumb" ||
    font === "org01" ||
    font === "default" ||
    font.startsWith("ttf:")
  ) {
    return font;
  }
  return "default";
}

function normalizeEffect(v?: string): WidgetEffect {
  if (v === "blink" || v === "pulse" || v === "scroll") return v;
  return "none";
}

export function clampWidget(w: Widget, stripHeight: number): Widget {
  const maxY = PANEL_H - 1;
  const minY = stripHeight;
  const effect = normalizeEffect(w.effect);
  const speed =
    typeof w.effect_speed === "number" && Number.isFinite(w.effect_speed)
      ? Math.max(1, Math.min(10, Math.round(w.effect_speed)))
      : 5;
  const out: Widget = {
    ...w,
    x: Math.max(0, Math.min(PANEL_W - 1, Math.round(w.x))),
    y: Math.max(minY, Math.min(maxY, Math.round(w.y))),
    size: ([1, 2, 3].includes(w.size) ? w.size : 1) as 1 | 2 | 3,
    color: /^#[0-9A-Fa-f]{6}$/.test(w.color) ? w.color : "#FFFFFF",
    font: normalizeFont(w.font),
    soft: false,
  };
  if (effect !== "none") {
    out.effect = effect;
    out.effect_speed = speed;
  } else {
    delete out.effect;
    delete out.effect_speed;
  }
  if (typeof w.format === "string" && w.format.length > 0 && w.format.length <= 24) {
    out.format = w.format;
  } else {
    delete out.format;
  }
  if (
    w.bitmap &&
    Number.isFinite(w.bitmap.w) &&
    Number.isFinite(w.bitmap.h) &&
    typeof w.bitmap.pixels === "string" &&
    w.bitmap.w > 0 &&
    w.bitmap.h > 0 &&
    w.bitmap.w <= 128 &&
    w.bitmap.h <= 64
  ) {
    out.bitmap = {
      w: Math.round(w.bitmap.w),
      h: Math.round(w.bitmap.h),
      pixels: w.bitmap.pixels,
    };
  } else {
    delete out.bitmap;
  }
  if (w.atlas && Array.isArray(w.atlas.glyphs) && w.atlas.glyphs.length > 0) {
    out.atlas = {
      chars: String(w.atlas.chars || ""),
      cellH: Math.max(1, Math.min(48, Math.round(w.atlas.cellH || 1))),
      glyphs: w.atlas.glyphs
        .filter(
          (g) =>
            g &&
            typeof g.ch === "string" &&
            g.ch.length >= 1 &&
            g.w > 0 &&
            g.h > 0 &&
            g.w <= 64 &&
            g.h <= 48 &&
            typeof g.pixels === "string"
        )
        .slice(0, 24)
        .map((g) => ({
          ch: g.ch[0],
          w: Math.round(g.w),
          h: Math.round(g.h),
          pixels: g.pixels,
        })),
    };
  } else {
    delete out.atlas;
  }
  return out;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

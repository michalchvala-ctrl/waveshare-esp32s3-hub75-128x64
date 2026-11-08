import type { Widget } from "./layout";
import { widgetLabel, type LiveSensor } from "./gfx-preview";
import {
  bitmapToBase64,
  composeAtlasString,
  isTtfFont,
  rasterizeDigitAtlas,
  rasterizeTtfText,
  type DigitAtlas,
  type GrayBitmap,
} from "./ttf-fonts";

export type WidgetWithBitmap = Widget & {
  bitmap?: { w: number; h: number; pixels: string };
  atlas?: DigitAtlas;
  /** client-only cache for preview */
  _gray?: GrayBitmap;
};

const LIVE_TYPES = new Set(["clock", "date", "temp", "humidity"]);

function atlasForStorage(atlas: DigitAtlas): DigitAtlas {
  return {
    chars: atlas.chars,
    cellH: atlas.cellH,
    glyphs: atlas.glyphs.map(({ ch, w, h, pixels }) => ({ ch, w, h, pixels })),
  };
}

/**
 * Prepare widgets for preview and/or panel push.
 * - text/weather + TTF → full-string grayscale bitmap
 * - clock/date/temp/humidity + TTF → digit atlas (ESP composes each second)
 * - GFX fonts → unchanged (ESP draws with selected font+size)
 */
export async function prepareTtfWidgets(
  widgets: Widget[],
  now: Date,
  sensor?: LiveSensor | null,
  opts?: { forPush?: boolean }
): Promise<WidgetWithBitmap[]> {
  const forPush = !!opts?.forPush;
  const out: WidgetWithBitmap[] = [];

  for (const w of widgets) {
    if (!isTtfFont(w.font)) {
      out.push({ ...w, soft: false });
      continue;
    }

    try {
      if (LIVE_TYPES.has(w.type)) {
        const atlas = await rasterizeDigitAtlas(w.font!, w.size);
        const label = widgetLabel(w, now, sensor);
        const composed = composeAtlasString(atlas, label);
        out.push({
          ...w,
          soft: false,
          _gray: composed,
          atlas: forPush ? atlasForStorage(atlas) : undefined,
          bitmap: undefined,
        });
      } else {
        const label = widgetLabel(w, now, sensor);
        const gray = await rasterizeTtfText(label, w.font!, w.size);
        out.push({
          ...w,
          soft: false,
          _gray: gray,
          bitmap: forPush
            ? { w: gray.w, h: gray.h, pixels: bitmapToBase64(gray.pixels) }
            : undefined,
        });
      }
    } catch {
      out.push({ ...w, soft: false });
    }
  }
  return out;
}

/** Drop heavy bitmap/atlas fields before persisting hub.json */
export function widgetsForStorage(widgets: Widget[]): Widget[] {
  return widgets.map((w) => {
    const { bitmap: _b, atlas: _a, ...rest } = w as WidgetWithBitmap;
    return { ...rest, soft: false };
  });
}

export type WidgetEffect = "none" | "blink" | "pulse" | "scroll";

export const EFFECT_OPTIONS: { id: WidgetEffect; label: string }[] = [
  { id: "none", label: "Žiadny" },
  { id: "blink", label: "Blikanie" },
  { id: "pulse", label: "Pulz (jas)" },
  { id: "scroll", label: "Scroll" },
];

export function normalizeEffect(v?: string | null): WidgetEffect {
  if (v === "blink" || v === "pulse" || v === "scroll") return v;
  return "none";
}

/** 1 = slow … 10 = fast */
export function normalizeEffectSpeed(v?: number | null): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 5;
  return Math.max(1, Math.min(10, n));
}

/** Full blink/pulse cycle length in ms. */
export function effectPeriodMs(speed: number): number {
  const s = normalizeEffectSpeed(speed);
  return Math.max(200, 2200 - s * 180);
}

/** 0–255 brightness multiplier for the current anim time. */
export function effectBrightness(
  effect: WidgetEffect | undefined,
  speed: number | undefined,
  nowMs: number
): number {
  const e = normalizeEffect(effect);
  if (e === "none" || e === "scroll") return 255;
  const period = effectPeriodMs(speed ?? 5);
  const t = ((nowMs % period) + period) % period;
  if (e === "blink") return t < period / 2 ? 255 : 0;
  // pulse: smooth sine, never fully off
  const phase = (t / period) * Math.PI * 2;
  const s = (Math.sin(phase) + 1) / 2;
  return Math.round(36 + s * 219);
}

/** Horizontal scroll offset in LED pixels (negative = move left). */
export function effectScrollDx(
  effect: WidgetEffect | undefined,
  speed: number | undefined,
  nowMs: number,
  textWidth: number
): number {
  if (normalizeEffect(effect) !== "scroll") return 0;
  const s = normalizeEffectSpeed(speed);
  const span = Math.max(8, textWidth + PANEL_SCROLL_GAP);
  const msPerPx = Math.max(12, 70 - s * 5);
  const dist = Math.floor(nowMs / msPerPx) % span;
  return -dist;
}

const PANEL_SCROLL_GAP = 128;

export function scaleHexColor(hex: string, bri: number): string {
  if (bri >= 255) return hex;
  if (bri <= 0) return "#000000";
  const h = hex.replace("#", "");
  const r = Math.round((parseInt(h.slice(0, 2), 16) * bri) / 255);
  const g = Math.round((parseInt(h.slice(2, 4), 16) * bri) / 255);
  const b = Math.round((parseInt(h.slice(4, 6), 16) * bri) / 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b
    .toString(16)
    .padStart(2, "0")}`;
}

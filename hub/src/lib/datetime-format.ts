/** Presets inspired by Windows short time/date formats. */

export type ClockFormatId =
  | "HH:mm:ss"
  | "HH:mm"
  | "H:mm"
  | "hh:mm:ss tt"
  | "hh:mm tt";

export type DateFormatId =
  | "dd.MM.yyyy"
  | "d.M.yyyy"
  | "dd.MM.yy"
  | "d. M. yyyy"
  | "yyyy-MM-dd"
  | "dd/MM/yyyy"
  | "MM/dd/yyyy"
  | "d/M/yyyy";

export const CLOCK_FORMATS: { id: ClockFormatId; label: string }[] = [
  { id: "HH:mm:ss", label: "23:59:59 (s sekundami)" },
  { id: "HH:mm", label: "23:59 (bez sekúnd)" },
  { id: "H:mm", label: "9:05 (bez nuly)" },
  { id: "hh:mm:ss tt", label: "11:59:59 AM/PM" },
  { id: "hh:mm tt", label: "11:59 AM/PM" },
];

export const DATE_FORMATS: { id: DateFormatId; label: string }[] = [
  { id: "dd.MM.yyyy", label: "07.11.2026 (SK)" },
  { id: "d.M.yyyy", label: "7.11.2026" },
  { id: "dd.MM.yy", label: "07.11.26" },
  { id: "d. M. yyyy", label: "7. 11. 2026" },
  { id: "yyyy-MM-dd", label: "2026-11-07 (ISO)" },
  { id: "dd/MM/yyyy", label: "07/11/2026" },
  { id: "MM/dd/yyyy", label: "11/07/2026 (US)" },
  { id: "d/M/yyyy", label: "7/11/2026" },
];

export const DEFAULT_CLOCK_FORMAT: ClockFormatId = "HH:mm:ss";
export const DEFAULT_DATE_FORMAT: DateFormatId = "dd.MM.yyyy";

export function normalizeClockFormat(v?: string | null): ClockFormatId {
  return CLOCK_FORMATS.some((f) => f.id === v)
    ? (v as ClockFormatId)
    : DEFAULT_CLOCK_FORMAT;
}

export function normalizeDateFormat(v?: string | null): DateFormatId {
  return DATE_FORMATS.some((f) => f.id === v)
    ? (v as DateFormatId)
    : DEFAULT_DATE_FORMAT;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatClock(now: Date, format?: string | null): string {
  const fmt = normalizeClockFormat(format);
  const H = now.getHours();
  const m = now.getMinutes();
  const s = now.getSeconds();
  const h12 = H % 12 || 12;
  const tt = H < 12 ? "AM" : "PM";
  switch (fmt) {
    case "HH:mm":
      return `${pad2(H)}:${pad2(m)}`;
    case "H:mm":
      return `${H}:${pad2(m)}`;
    case "hh:mm:ss tt":
      return `${pad2(h12)}:${pad2(m)}:${pad2(s)} ${tt}`;
    case "hh:mm tt":
      return `${pad2(h12)}:${pad2(m)} ${tt}`;
    case "HH:mm:ss":
    default:
      return `${pad2(H)}:${pad2(m)}:${pad2(s)}`;
  }
}

export function formatDate(now: Date, format?: string | null): string {
  const fmt = normalizeDateFormat(format);
  const d = now.getDate();
  const M = now.getMonth() + 1;
  const y = now.getFullYear();
  const yy = pad2(y % 100);
  switch (fmt) {
    case "d.M.yyyy":
      return `${d}.${M}.${y}`;
    case "dd.MM.yy":
      return `${pad2(d)}.${pad2(M)}.${yy}`;
    case "d. M. yyyy":
      return `${d}. ${M}. ${y}`;
    case "yyyy-MM-dd":
      return `${y}-${pad2(M)}-${pad2(d)}`;
    case "dd/MM/yyyy":
      return `${pad2(d)}/${pad2(M)}/${y}`;
    case "MM/dd/yyyy":
      return `${pad2(M)}/${pad2(d)}/${y}`;
    case "d/M/yyyy":
      return `${d}/${M}/${y}`;
    case "dd.MM.yyyy":
    default:
      return `${pad2(d)}.${pad2(M)}.${y}`;
  }
}

/** Extra atlas glyphs needed beyond digits for a given format. */
export function formatAtlasExtras(format?: string | null): string {
  if (!format) return "";
  const extras = new Set<string>();
  for (const ch of format) {
    if (ch === "t") {
      extras.add("A");
      extras.add("M");
      extras.add("P");
      extras.add(" ");
    } else if (!/[HhmssdMy]/.test(ch)) {
      extras.add(ch);
    }
  }
  return [...extras].join("");
}

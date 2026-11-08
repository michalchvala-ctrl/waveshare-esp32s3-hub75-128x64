import { getDb, saveDb, type PanelRow } from "./db";

export function listPanels(): PanelRow[] {
  return [...getDb().panels].sort((a, b) => a.id - b.id);
}

export function getPanel(id: number): PanelRow | undefined {
  return getDb().panels.find((p) => p.id === id);
}

export function createPanel(input: {
  name: string;
  host: string;
  token: string;
  strip_height?: number;
  owner_user_id?: number | null;
}): PanelRow {
  const db = getDb();
  const panel: PanelRow = {
    id: db.nextPanelId++,
    name: input.name,
    host: input.host,
    token: input.token,
    owner_user_id: input.owner_user_id ?? null,
    strip_height: input.strip_height ?? 16,
    enabled: 1,
  };
  db.panels.push(panel);
  saveDb();
  return panel;
}

export function updatePanel(
  id: number,
  patch: Partial<
    Pick<PanelRow, "name" | "host" | "token" | "owner_user_id" | "strip_height" | "enabled">
  >
): PanelRow | undefined {
  const db = getDb();
  const cur = db.panels.find((p) => p.id === id);
  if (!cur) return undefined;
  Object.assign(cur, patch);
  saveDb();
  return cur;
}

export type NotifyPayload = {
  text: string;
  duration_ms?: number;
  r?: number;
  g?: number;
  b?: number;
  strip_only?: boolean;
  strip_height?: number;
};

export async function pushNotifyToPanel(
  panel: PanelRow,
  payload: NotifyPayload
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = `http://${panel.host}/api/notify`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${panel.token}`,
      },
      body: JSON.stringify({
        text: payload.text,
        duration_ms: payload.duration_ms ?? 8000,
        r: payload.r ?? 255,
        g: payload.g ?? 220,
        b: payload.b ?? 40,
        strip_only: payload.strip_only ?? true,
        strip_height: payload.strip_height ?? panel.strip_height,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: t || res.statusText };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

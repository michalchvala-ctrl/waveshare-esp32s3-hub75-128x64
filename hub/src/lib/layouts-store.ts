import { getDb, saveDb, type PanelRow } from "./db";
import {
  clampWidget,
  defaultLayout,
  type PanelLayout,
  type Widget,
} from "./layout";
import { getPanel } from "./panels";

export function getLayout(panelId: number): PanelLayout {
  const db = getDb();
  const key = String(panelId);
  const panel = getPanel(panelId);
  if (db.layouts[key]) {
    const layout = db.layouts[key];
    if (panel) layout.strip_height = panel.strip_height;
    return layout;
  }
  return defaultLayout(panelId, panel?.strip_height ?? 16);
}

/** Build a layout payload without writing hub.json (for live push). */
export function buildLayout(
  panelId: number,
  widgets: Widget[],
  stripHeight?: number
): PanelLayout {
  const panel = getPanel(panelId);
  if (!panel) throw new Error("panel_not_found");

  let strip = panel.strip_height;
  if (typeof stripHeight === "number" && Number.isFinite(stripHeight)) {
    strip = Math.max(0, Math.min(32, Math.round(stripHeight)));
  }

  return {
    panel_id: panelId,
    strip_height: strip,
    widgets: widgets.map((w) => clampWidget(w, strip)),
    updated_at: new Date().toISOString(),
  };
}

export function saveLayout(
  panelId: number,
  widgets: Widget[],
  stripHeight?: number
): PanelLayout {
  const db = getDb();
  const panel = getPanel(panelId);
  if (!panel) throw new Error("panel_not_found");

  let strip = panel.strip_height;
  if (typeof stripHeight === "number" && Number.isFinite(stripHeight)) {
    strip = Math.max(0, Math.min(32, Math.round(stripHeight)));
    panel.strip_height = strip;
  }

  const layout: PanelLayout = {
    panel_id: panelId,
    strip_height: strip,
    widgets: widgets.map((w) => clampWidget(w, strip)),
    updated_at: new Date().toISOString(),
  };
  db.layouts[String(panelId)] = layout;
  saveDb();
  return layout;
}

export function canEditPanel(
  user: { id: number; role: string },
  panel: PanelRow
): boolean {
  if (user.role === "admin") return true;
  return panel.owner_user_id === user.id;
}

export async function pushLayoutToPanel(
  panel: PanelRow,
  layout: PanelLayout,
  opts?: { persist?: boolean }
): Promise<{ ok: boolean; status?: number; error?: string; persisted?: boolean }> {
  const url = `http://${panel.host}/api/layout`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${panel.token}`,
      },
      body: JSON.stringify({
        ...layout,
        persist: !!opts?.persist,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: json.error || res.statusText,
      };
    }
    return {
      ok: true,
      status: res.status,
      persisted: !!json.persisted,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

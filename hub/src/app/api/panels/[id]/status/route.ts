import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getPanel } from "@/lib/panels";
import { canEditPanel } from "@/lib/layouts-store";

type Ctx = { params: Promise<{ id: string }> };

/** Proxy GET panel /api/status (temp/humidity) so the editor matches the LED. */
export async function GET(_req: Request, ctx: Ctx) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const id = Number((await ctx.params).id);
  const panel = getPanel(id);
  if (!panel) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!canEditPanel(user, panel)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  try {
    const res = await fetch(`http://${panel.host}/api/status`, {
      headers: { Authorization: `Bearer ${panel.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: json.error || res.statusText || "panel_error", status: res.status },
        { status: 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      panel_id: panel.id,
      host: panel.host,
      shtc3_ok: !!json.shtc3_ok,
      temp_c: typeof json.temp_c === "number" ? json.temp_c : null,
      humidity: typeof json.humidity === "number" ? json.humidity : null,
      temp_display: json.temp_display ?? null,
      humidity_display: json.humidity_display ?? null,
      clock: json.clock ?? null,
      brightness: json.brightness ?? null,
      brightness_mode: json.brightness_mode ?? null,
      brightness_manual: json.brightness_manual ?? null,
      has_layout: !!json.has_layout,
      boot_saved: !!json.boot_saved,
      boot_bytes: typeof json.boot_bytes === "number" ? json.boot_bytes : null,
      raw: json,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}

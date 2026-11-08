import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { getPanel } from "@/lib/panels";
import { canEditPanel } from "@/lib/layouts-store";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  mode: z.enum(["auto", "manual"]).optional(),
  value: z.number().int().min(0).max(255).optional(),
});

export async function POST(req: Request, ctx: Ctx) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const id = Number((await ctx.params).id);
  const panel = getPanel(id);
  if (!panel) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!canEditPanel(user, panel)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  try {
    const res = await fetch(`http://${panel.host}/api/brightness`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${panel.token}`,
      },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: json.error || res.statusText, status: res.status },
        { status: 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      brightness: json.brightness,
      brightness_mode: json.brightness_mode,
      brightness_manual: parsed.data.value ?? json.brightness,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}

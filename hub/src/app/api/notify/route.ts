import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { getPanel, listPanels, pushNotifyToPanel } from "@/lib/panels";

const schema = z.object({
  text: z.string().min(1).max(360),
  duration_ms: z.number().int().min(500).max(120000).optional(),
  r: z.number().int().min(0).max(255).optional(),
  g: z.number().int().min(0).max(255).optional(),
  b: z.number().int().min(0).max(255).optional(),
  strip_only: z.boolean().optional(),
  /** panel id list, or "all" */
  target: z.union([z.literal("all"), z.array(z.number().int().positive())]),
});

export async function POST(req: Request) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const all = listPanels().filter((p) => p.enabled);
  const targets =
    parsed.data.target === "all"
      ? all
      : parsed.data.target
          .map((id) => getPanel(id))
          .filter((p): p is NonNullable<typeof p> => !!p && !!p.enabled);

  if (!targets.length) {
    return NextResponse.json({ ok: false, error: "no_panels" }, { status: 400 });
  }

  const results = [];
  for (const panel of targets) {
    const r = await pushNotifyToPanel(panel, {
      text: parsed.data.text,
      duration_ms: parsed.data.duration_ms,
      r: parsed.data.r,
      g: parsed.data.g,
      b: parsed.data.b,
      strip_only: parsed.data.strip_only ?? true,
      strip_height: panel.strip_height,
    });
    results.push({ panel_id: panel.id, name: panel.name, host: panel.host, ...r });
  }

  return NextResponse.json({ ok: true, results });
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { createPanel, listPanels } from "@/lib/panels";

export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  let panels = listPanels();
  if (user.role !== "admin") {
    panels = panels.filter((p) => p.owner_user_id === user.id);
  }
  return NextResponse.json({
    ok: true,
    panels: panels.map((p) => ({
      id: p.id,
      name: p.name,
      host: p.host,
      strip_height: p.strip_height,
      enabled: !!p.enabled,
      owner_user_id: p.owner_user_id,
      // never expose token to non-admin
      token: user.role === "admin" ? p.token : undefined,
    })),
  });
}

const createSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  token: z.string().min(4),
  strip_height: z.number().int().min(0).max(32).optional(),
  owner_user_id: z.number().int().nullable().optional(),
});

export async function POST(req: Request) {
  const user = await getSession();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const panel = createPanel(parsed.data);
  return NextResponse.json({ ok: true, panel });
}

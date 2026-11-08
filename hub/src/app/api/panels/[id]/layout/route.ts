import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { getPanel } from "@/lib/panels";
import {
  buildLayout,
  canEditPanel,
  getLayout,
  pushLayoutToPanel,
  saveLayout,
} from "@/lib/layouts-store";
import { widgetsForStorage } from "@/lib/ttf-prepare";
import type { Widget } from "@/lib/layout";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const id = Number((await ctx.params).id);
  const panel = getPanel(id);
  if (!panel) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!canEditPanel(user, panel)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, layout: getLayout(id), panel });
}

const bitmapSchema = z.object({
  w: z.number().int().min(1).max(128),
  h: z.number().int().min(1).max(64),
  pixels: z.string().min(1).max(24000),
});

const atlasSchema = z.object({
  chars: z.string().max(32),
  cellH: z.number().int().min(1).max(48),
  glyphs: z
    .array(
      z.object({
        ch: z.string().min(1).max(2),
        w: z.number().int().min(1).max(64),
        h: z.number().int().min(1).max(48),
        pixels: z.string().min(1).max(8000),
      })
    )
    .max(24),
});

const widgetSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["text", "clock", "date", "temp", "humidity", "weather"]),
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  text: z.string().max(80).optional(),
  format: z.string().max(24).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  size: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  font: z.string().max(40).optional(),
  effect: z.enum(["none", "blink", "pulse", "scroll"]).optional(),
  effect_speed: z.number().int().min(1).max(10).optional(),
  soft: z.boolean().optional(),
  bitmap: bitmapSchema.optional(),
  atlas: atlasSchema.optional(),
});

const putSchema = z.object({
  widgets: z.array(widgetSchema),
  strip_height: z.number().int().min(0).max(32).optional(),
  push: z.boolean().optional(),
  /** Save on panel flash as boot screen after restart */
  persist: z.boolean().optional(),
});

const postSchema = z.object({
  widgets: z.array(widgetSchema),
  strip_height: z.number().int().min(0).max(32).optional(),
  persist: z.boolean().optional(),
});

export async function PUT(req: Request, ctx: Ctx) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const id = Number((await ctx.params).id);
  let panel = getPanel(id);
  if (!panel) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!canEditPanel(user, panel)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const stripArg =
    user.role === "admin" ? parsed.data.strip_height : undefined;

  const widgets = parsed.data.widgets as Widget[];
  const layout = saveLayout(id, widgetsForStorage(widgets), stripArg);
  panel = getPanel(id)!;

  let push: { ok: boolean; error?: string; persisted?: boolean } | undefined;
  if (parsed.data.push || parsed.data.persist) {
    const pushLayout = buildLayout(id, widgets, stripArg);
    push = await pushLayoutToPanel(panel, pushLayout, {
      persist: !!parsed.data.persist,
    });
  }
  return NextResponse.json({ ok: true, layout, panel, push });
}

export async function POST(req: Request, ctx: Ctx) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const id = Number((await ctx.params).id);
  const panel = getPanel(id);
  if (!panel) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!canEditPanel(user, panel)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const stripArg =
    user.role === "admin" ? parsed.data.strip_height : undefined;
  const layout = buildLayout(id, parsed.data.widgets as Widget[], stripArg);
  const push = await pushLayoutToPanel(panel, layout, {
    persist: !!parsed.data.persist,
  });
  return NextResponse.json({ ok: push.ok, push, layout });
}

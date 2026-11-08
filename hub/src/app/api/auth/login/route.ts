import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, findUserByUsername, verifyPassword } from "@/lib/auth";

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const user = findUserByUsername(parsed.data.username);
  if (!user || !verifyPassword(user, parsed.data.password)) {
    return NextResponse.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  }
  await createSession({
    id: user.id,
    username: user.username,
    role: user.role,
  });
  return NextResponse.json({
    ok: true,
    user: { id: user.id, username: user.username, role: user.role },
  });
}

"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type User = { id: number; username: string; role: "admin" | "user" };
type Panel = {
  id: number;
  name: string;
  host: string;
  strip_height: number;
  enabled: boolean;
  owner_user_id: number | null;
  token?: string;
};

export default function HomePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [text, setText] = useState("Admin notifikacia v rezervovanom pase");
  const [target, setTarget] = useState<"all" | string>("all");
  const [duration, setDuration] = useState(10000);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [briPanel, setBriPanel] = useState<string>("");
  const [briAuto, setBriAuto] = useState(true);
  const [briValue, setBriValue] = useState(70);
  const [briNow, setBriNow] = useState<number | null>(null);
  const [briNote, setBriNote] = useState("");

  const load = useCallback(async () => {
    const me = await fetch("/api/auth/me");
    if (!me.ok) {
      router.replace("/login");
      return;
    }
    const meJson = await me.json();
    setUser(meJson.user);
    const p = await fetch("/api/panels");
    const pJson = await p.json();
    const list = (pJson.panels || []) as Panel[];
    setPanels(list);
    if (list.length && !briPanel) setBriPanel(String(list[0].id));
  }, [router, briPanel]);

  useEffect(() => {
    load();
  }, [load]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  async function setBrightness(mode: "auto" | "manual", value?: number) {
    if (!briPanel) return;
    setBriNote("…");
    const res = await fetch(`/api/panels/${briPanel}/brightness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        mode === "auto" ? { mode: "auto" } : { mode: "manual", value: value ?? briValue }
      ),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBriNote(json.error || "chyba");
      return;
    }
    setBriAuto(mode === "auto");
    if (typeof json.brightness === "number") setBriNow(json.brightness);
    setBriNote(mode === "auto" ? "auto OK" : `manual ${value ?? briValue}`);
  }

  useEffect(() => {
    if (!briPanel) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/panels/${briPanel}/status`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (cancelled || !res.ok) return;
      if (json.brightness_mode === "manual") setBriAuto(false);
      else setBriAuto(true);
      if (typeof json.brightness_manual === "number") setBriValue(json.brightness_manual);
      if (typeof json.brightness === "number") setBriNow(json.brightness);
    })();
    return () => {
      cancelled = true;
    };
  }, [briPanel]);

  async function sendNotify(e: FormEvent) {
    e.preventDefault();
    if (!user || user.role !== "admin") return;
    setBusy(true);
    setMsg("");
    const body = {
      text,
      duration_ms: duration,
      strip_only: true,
      target: target === "all" ? "all" : [Number(target)],
      r: 255,
      g: 220,
      b: 40,
    };
    const res = await fetch("/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMsg(json.error || "Chyba");
      return;
    }
    const lines = (json.results || [])
      .map(
        (r: { name: string; ok: boolean; error?: string }) =>
          `${r.name}: ${r.ok ? "OK" : r.error || "fail"}`
      )
      .join(" | ");
    setMsg(lines || "Hotovo");
  }

  if (!user) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 text-[var(--muted)]">
        Načítavam…
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">LED Panel Hub</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {user.username} · {user.role} · LAN only
          </p>
        </div>
        <button
          onClick={logout}
          className="rounded border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--fg)]"
        >
          Odhlásiť
        </button>
      </header>

      <section className="mb-8 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-5">
        <h2 className="mb-3 text-lg font-medium">Jas panela</h2>
        <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--muted)]">Panel</span>
            <select
              className="rounded border border-[var(--line)] bg-[#0d1210] px-2 py-1.5"
              value={briPanel}
              onChange={(e) => setBriPanel(e.target.value)}
            >
              {panels.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-1 text-xs">
            <input
              type="checkbox"
              checked={briAuto}
              onChange={(e) => {
                if (e.target.checked) void setBrightness("auto");
                else void setBrightness("manual", briValue);
              }}
            />
            Auto
          </label>
        </div>
        <input
          type="range"
          min={0}
          max={255}
          value={briValue}
          disabled={briAuto || !briPanel}
          onChange={(e) => setBriValue(Number(e.target.value))}
          onPointerUp={() => {
            if (!briAuto) void setBrightness("manual", briValue);
          }}
          className="w-full"
        />
        <p className="mt-1 text-xs text-[var(--muted)]">
          manual {briValue} · now {briNow ?? "—"} {briNote ? `· ${briNote}` : ""}
        </p>
      </section>

      <section className="mb-8 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-5">
        <h2 className="mb-3 text-lg font-medium">Panely</h2>
        {panels.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Žiadne panely.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {panels.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--line)] px-3 py-2"
              >
                <span>
                  <strong>{p.name}</strong>{" "}
                  <span className="text-[var(--muted)]">{p.host}</span>
                </span>
                <span className="flex items-center gap-3">
                  <a
                    href={`/editor?panel=${p.id}`}
                    className="text-sm text-[var(--accent)] hover:underline"
                  >
                    Editor
                  </a>
                  <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--warn)]">
                    strip {p.strip_height}px
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-[var(--muted)]">
          Rezervovaný pás (frame) hore — user sem nebude môcť kresliť; admin sem posiela
          notifikácie.
        </p>
      </section>

      {user.role === "admin" ? (
        <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-5">
          <h2 className="mb-3 text-lg font-medium">Admin notifikácia</h2>
          <form onSubmit={sendNotify} className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-[var(--muted)]">Cieľ</span>
              <select
                className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-3 py-2"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="all">Všetky panely</option>
                {panels.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name} ({p.host})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-[var(--muted)]">Text</span>
              <textarea
                className="min-h-24 w-full rounded border border-[var(--line)] bg-[#0d1210] px-3 py-2"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-[var(--muted)]">Trvanie (ms)</span>
              <input
                type="number"
                className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-3 py-2"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-[var(--accent)] px-4 py-2 font-medium text-[#062014] disabled:opacity-60"
            >
              {busy ? "Posielam…" : "Poslať do stripu"}
            </button>
            {msg ? <p className="text-sm text-[var(--warn)]">{msg}</p> : null}
          </form>
        </section>
      ) : (
        <p className="text-sm text-[var(--muted)]">
          Otvor <strong>Editor</strong> pri svojom paneli a uprav layout mimo
          admin stripu.
        </p>
      )}
    </main>
  );
}

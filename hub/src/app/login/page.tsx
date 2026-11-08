"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    setBusy(false);
    if (!res.ok) {
      setError("Nesprávne meno alebo heslo");
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="mb-2 font-[family-name:var(--font-sans)] text-3xl font-semibold tracking-tight">
        LED Panel Hub
      </h1>
      <p className="mb-8 text-sm text-[var(--muted)]">
        Lokálna správa panelov — len LAN (internet neskôr cez Nginx/VPN).
      </p>
      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6"
      >
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--muted)]">Používateľ</span>
          <input
            className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-3 py-2 outline-none focus:border-[var(--accent)]"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--muted)]">Heslo</span>
          <input
            type="password"
            className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-3 py-2 outline-none focus:border-[var(--accent)]"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-[var(--accent)] px-3 py-2 font-medium text-[#062014] disabled:opacity-60"
        >
          {busy ? "…" : "Prihlásiť"}
        </button>
      </form>
      <p className="mt-4 text-xs text-[var(--muted)]">
        Predvolené: <code className="text-[var(--warn)]">admin / admin</code> — zmeň hneď po prvom prihlásení.
      </p>
    </main>
  );
}

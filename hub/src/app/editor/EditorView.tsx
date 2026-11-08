"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  PANEL_H,
  PANEL_W,
  type PanelLayout,
  type Widget,
  type WidgetType,
} from "@/lib/layout";
import {
  renderPanelFrame,
  widgetBox,
  widgetLabel,
  type LiveSensor,
  type WidgetRender,
} from "@/lib/gfx-preview";
import { FONT_OPTIONS, ensureTtfFontsLoaded, isTtfFont } from "@/lib/ttf-fonts";
import { prepareTtfWidgets, widgetsForStorage } from "@/lib/ttf-prepare";
import {
  CLOCK_FORMATS,
  DATE_FORMATS,
  DEFAULT_CLOCK_FORMAT,
  DEFAULT_DATE_FORMAT,
} from "@/lib/datetime-format";
import { EFFECT_OPTIONS, normalizeEffect } from "@/lib/widget-effects";

type Panel = {
  id: number;
  name: string;
  host: string;
  strip_height: number;
};

const SCALE = 8;
const LIVE_PUSH_MS = 200;
const LIVE_SAVE_MS = 2000;

const LABELS: Record<WidgetType, string> = {
  text: "Text",
  clock: "Čas",
  date: "Dátum",
  temp: "Teplota",
  humidity: "Vlhkosť",
  weather: "Počasie",
};

function estimateWidgetBox(w: WidgetRender, now: Date, sensor?: LiveSensor | null) {
  return widgetBox(w, widgetLabel(w, now, sensor));
}

export default function EditorView() {
  const router = useRouter();
  const params = useSearchParams();
  const panelId = Number(params.get("panel") || "1");

  const [panel, setPanel] = useState<Panel | null>(null);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [renderWidgets, setRenderWidgets] = useState<WidgetRender[]>([]);
  const [stripHeight, setStripHeight] = useState(16);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [liveStatus, setLiveStatus] = useState("");
  const [sensor, setSensor] = useState<LiveSensor | null>(null);
  const [sensorNote, setSensorNote] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [showGrid, setShowGrid] = useState(true);
  const [briAuto, setBriAuto] = useState(true);
  const [briValue, setBriValue] = useState(70);
  const [briNow, setBriNow] = useState<number | null>(null);
  const [briNote, setBriNote] = useState("");
  const [bootSaved, setBootSaved] = useState<boolean | null>(null);
  const [bootBytes, setBootBytes] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const bufRef = useRef<ImageData | null>(null);

  const widgetsRef = useRef(widgets);
  const stripRef = useRef(stripHeight);
  const liveRef = useRef(live);
  const sensorRef = useRef(sensor);
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushInFlightRef = useRef(false);
  const pushQueuedRef = useRef(false);
  const skipLiveOnceRef = useRef(true);

  widgetsRef.current = widgets;
  stripRef.current = stripHeight;
  liveRef.current = live;
  sensorRef.current = sensor;

  const selected = widgets.find((w) => w.id === selectedId) || null;

  const load = useCallback(async () => {
    const me = await fetch("/api/auth/me");
    if (!me.ok) {
      router.replace("/login");
      return;
    }
    await ensureTtfFontsLoaded();
    const res = await fetch(`/api/panels/${panelId}/layout`);
    if (!res.ok) {
      setStatus("Panel sa nepodarilo načítať");
      return;
    }
    const json = await res.json();
    setPanel({
      id: json.panel.id,
      name: json.panel.name,
      host: json.panel.host,
      strip_height: json.panel.strip_height,
    });
    const layout = json.layout as PanelLayout;
    skipLiveOnceRef.current = true;
    setStripHeight(layout.strip_height ?? json.panel.strip_height ?? 16);
    setWidgets(layout.widgets);
    setSelectedId(layout.widgets[0]?.id ?? null);

    const st = await fetch(`/api/panels/${panelId}/status`, { cache: "no-store" });
    if (st.ok) {
      const s = await st.json();
      if (s.raw?.brightness_mode === "manual" || s.brightness_mode === "manual") {
        setBriAuto(false);
      }
      const bm = s.raw?.brightness_manual ?? s.brightness_manual;
      const bn = s.raw?.brightness ?? s.brightness;
      if (typeof bm === "number") setBriValue(bm);
      if (typeof bn === "number") setBriNow(bn);
    }
  }, [panelId, router]);

  useEffect(() => {
    load();
  }, [load]);

  const hasEffects = widgets.some(
    (w) => w.effect && w.effect !== "none"
  );

  useEffect(() => {
    const ms = hasEffects ? 50 : 1000;
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [hasEffects]);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const res = await fetch(`/api/panels/${panelId}/status`, { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.ok) {
          setSensorNote(json.error || "sensor offline");
          return;
        }
        setSensor({
          ok: !!json.shtc3_ok,
          temp_c: typeof json.temp_c === "number" ? json.temp_c : null,
          humidity: typeof json.humidity === "number" ? json.humidity : null,
          temp_display: json.temp_display ?? null,
          humidity_display: json.humidity_display ?? null,
        });
        setSensorNote(
          json.shtc3_ok
            ? `panel ${json.temp_display || "?"} / ${json.humidity_display || "?"}`
            : "SHTC3 offline"
        );
        const bn = json.raw?.brightness ?? json.brightness;
        if (typeof bn === "number") setBriNow(bn);
        setBootSaved(!!json.boot_saved);
        setBootBytes(typeof json.boot_bytes === "number" ? json.boot_bytes : null);
      } catch (e) {
        if (!cancelled) setSensorNote(e instanceof Error ? e.message : "sensor error");
      }
    };
    void pull();
    const t = setInterval(pull, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [panelId]);

  // Rasterize TTF → grayscale for preview (true AA)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await ensureTtfFontsLoaded();
      const prepared = await prepareTtfWidgets(widgets, now, sensor);
      if (!cancelled) setRenderWidgets(prepared);
    })();
    return () => {
      cancelled = true;
    };
  }, [widgets, now, sensor]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!bufRef.current) bufRef.current = ctx.createImageData(PANEL_W, PANEL_H);
    const img = bufRef.current;
    renderPanelFrame(img.data, renderWidgets, stripHeight, now, sensor);
    ctx.putImageData(img, 0, 0);
  }, [renderWidgets, stripHeight, now, sensor]);

  const buildPushWidgets = useCallback(async () => {
    return prepareTtfWidgets(widgetsRef.current, new Date(), sensorRef.current, {
      forPush: true,
    });
  }, []);

  const persistQuiet = useCallback(async () => {
    try {
      await fetch(`/api/panels/${panelId}/layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          widgets: widgetsForStorage(widgetsRef.current),
          strip_height: stripRef.current,
          push: false,
        }),
      });
    } catch {
      /* ignore */
    }
  }, [panelId]);

  const pushLiveNow = useCallback(
    async (immediateSave = false) => {
      if (!liveRef.current) return;
      if (pushInFlightRef.current) {
        pushQueuedRef.current = true;
        return;
      }
      pushInFlightRef.current = true;
      setLiveStatus("live…");
      try {
        const prepared = await buildPushWidgets();
        const payload = prepared.map(({ _gray: _g, ...rest }) => rest);
        const res = await fetch(`/api/panels/${panelId}/layout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            widgets: payload,
            strip_height: stripRef.current,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.push?.ok) {
          setLiveStatus(`live chyba: ${json.push?.error || json.error || res.status}`);
        } else {
          setLiveStatus("live ✓");
        }
      } catch (e) {
        setLiveStatus(`live chyba: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        pushInFlightRef.current = false;
        if (pushQueuedRef.current && liveRef.current) {
          pushQueuedRef.current = false;
          void pushLiveNow(false);
        }
      }
      if (immediateSave) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          void persistQuiet();
        }, LIVE_SAVE_MS);
      }
    },
    [panelId, persistQuiet, buildPushWidgets]
  );

  const scheduleLivePush = useCallback(
    (opts?: { immediate?: boolean }) => {
      if (!liveRef.current) return;
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
      if (opts?.immediate) {
        void pushLiveNow(true);
        return;
      }
      pushTimerRef.current = setTimeout(() => {
        void pushLiveNow(true);
      }, LIVE_PUSH_MS);
    },
    [pushLiveNow]
  );

  useEffect(() => {
    if (skipLiveOnceRef.current) {
      skipLiveOnceRef.current = false;
      return;
    }
    if (!live) return;
    scheduleLivePush();
  }, [widgets, stripHeight, live, scheduleLivePush]);

  // No 1s Live re-push for clock — ESP advances seconds locally from NTP.

  useEffect(() => {
    return () => {
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  function addWidget(type: WidgetType) {
    const id = `${type}_${Math.random().toString(36).slice(2, 8)}`;
    const w: Widget = {
      id,
      type,
      x: 4,
      y: stripHeight + (stripHeight > 0 ? 2 : 4),
      color: type === "clock" ? "#FFFFFF" : "#3DFF80",
      size: type === "clock" ? 2 : 1,
      font: "default",
      text: type === "text" ? "Ahoj" : type === "weather" ? "Oblacno" : undefined,
      format:
        type === "clock"
          ? DEFAULT_CLOCK_FORMAT
          : type === "date"
            ? DEFAULT_DATE_FORMAT
            : undefined,
    };
    setWidgets((prev) => [...prev, w]);
    setSelectedId(id);
  }

  function updateSelected(patch: Partial<Widget>) {
    if (!selectedId) return;
    setWidgets((prev) =>
      prev.map((w) => {
        if (w.id !== selectedId) return w;
        const next = { ...w, ...patch };
        next.x = Math.max(0, Math.min(PANEL_W - 1, Math.round(next.x)));
        next.y = Math.max(stripHeight, Math.min(PANEL_H - 1, Math.round(next.y)));
        next.soft = false;
        return next;
      })
    );
  }

  function removeSelected() {
    if (!selectedId) return;
    setWidgets((prev) => prev.filter((w) => w.id !== selectedId));
    setSelectedId(null);
  }

  function onStripChange(v: number) {
    let sh = Math.round(v);
    if (sh < 0) sh = 0;
    if (sh > 32) sh = 32;
    setStripHeight(sh);
    setWidgets((prev) =>
      prev.map((w) => ({
        ...w,
        y: Math.max(sh, Math.min(PANEL_H - 1, w.y)),
      }))
    );
  }

  async function save(opts: { push?: boolean; persist?: boolean } | boolean) {
    const push = typeof opts === "boolean" ? opts : !!opts.push;
    const persist = typeof opts === "boolean" ? false : !!opts.persist;
    setBusy(true);
    setStatus("");
    let payloadWidgets: Widget[] = widgetsForStorage(widgets);
    if (push || persist) {
      const prepared = await prepareTtfWidgets(widgets, new Date(), sensor, {
        forPush: true,
      });
      payloadWidgets = prepared.map(({ _gray: _g, ...rest }) => rest);
    }
    const res = await fetch(`/api/panels/${panelId}/layout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        widgets: payloadWidgets,
        strip_height: stripHeight,
        push: push || persist,
        persist,
      }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setStatus(json.error || "Chyba uloženia");
      return;
    }
    if (json.panel) {
      setPanel((p) => (p ? { ...p, strip_height: json.panel.strip_height } : p));
    }
    if (persist) {
      if (json.push?.ok && json.push?.persisted) {
        setBootSaved(true);
        setStatus("Štartová obrazovka uložená na paneli (po reštarte)");
      } else if (json.push?.ok) {
        setStatus(
          "Poslané na panel, ale boot sa neuložil (LittleFS). Skús znova."
        );
      } else {
        setStatus(`Boot zlyhal: ${json.push?.error || "?"}`);
      }
    } else if (push) {
      setStatus(
        json.push?.ok
          ? "Uložené a poslané na panel"
          : `Uložené, push zlyhal: ${json.push?.error || "?"}`
      );
    } else {
      setStatus("Uložené");
    }
  }

  async function setBrightness(mode: "auto" | "manual", value?: number) {
    setBriNote("…");
    const res = await fetch(`/api/panels/${panelId}/brightness`, {
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
    setBriNote(mode === "auto" ? "auto" : `manual ${value ?? briValue}`);
  }

  const ledFromEvent = (clientX: number, clientY: number) => {
    const stage = stageRef.current!;
    const rect = stage.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / SCALE,
      y: (clientY - rect.top) / SCALE,
    };
  };

  const hitTest = (lx: number, ly: number): string | null => {
    const list = renderWidgets.length ? renderWidgets : widgets;
    for (let i = list.length - 1; i >= 0; i--) {
      const w = list[i];
      const box = estimateWidgetBox(w, now, sensor);
      if (lx >= box.x && lx < box.x + box.width && ly >= box.y && ly < box.y + box.height) {
        return w.id;
      }
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = ledFromEvent(e.clientX, e.clientY);
    const id = hitTest(x, y);
    if (!id) {
      setSelectedId(null);
      return;
    }
    const w = widgets.find((x) => x.id === id)!;
    dragRef.current = { id, ox: x - w.x, oy: y - w.y };
    setSelectedId(id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { x, y } = ledFromEvent(e.clientX, e.clientY);
    const id = dragRef.current.id;
    const nx = Math.max(0, Math.min(PANEL_W - 1, Math.round(x - dragRef.current.ox)));
    const ny = Math.max(
      stripHeight,
      Math.min(PANEL_H - 1, Math.round(y - dragRef.current.oy))
    );
    setWidgets((prev) => prev.map((w) => (w.id === id ? { ...w, x: nx, y: ny } : w)));
  };

  const onPointerUp = () => {
    const wasDragging = !!dragRef.current;
    dragRef.current = null;
    if (wasDragging && liveRef.current) scheduleLivePush({ immediate: true });
  };

  const stageW = PANEL_W * SCALE;
  const stageH = PANEL_H * SCALE;
  const selectedRender =
    renderWidgets.find((w) => w.id === selectedId) || selected || null;

  return (
    <main className="h-full min-h-screen w-full px-3 py-4 lg:px-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <button
            className="mb-1 text-sm text-[var(--muted)] hover:text-[var(--fg)]"
            onClick={() => router.push("/")}
          >
            ← Hub
          </button>
          <h1 className="text-2xl font-semibold tracking-tight">
            Editor {panel ? `· ${panel.name}` : ""}
          </h1>
          <p className="text-sm text-[var(--muted)]">
            128×64 · TTF AA · {SCALE}× zoom · {panel?.host}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label
            className="flex cursor-pointer items-center gap-2 rounded border border-[var(--line)] px-3 py-2 text-sm"
            title="Debounced push; TTF clock/temp re-push každú 1 s"
          >
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => {
                const on = e.target.checked;
                setLive(on);
                if (on) {
                  setLiveStatus("live zapnuté");
                  setTimeout(() => {
                    if (liveRef.current) void pushLiveNow(true);
                  }, 0);
                } else {
                  setLiveStatus("");
                  if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
                }
              }}
            />
            <span>Live na panel</span>
            {live && liveStatus ? (
              <span className="text-xs text-[var(--muted)]">{liveStatus}</span>
            ) : null}
          </label>
          <button
            disabled={busy}
            onClick={() => save({ push: false })}
            className="rounded border border-[var(--line)] px-3 py-2 text-sm"
          >
            Uložiť
          </button>
          <button
            disabled={busy}
            onClick={() => save({ push: true })}
            className="rounded border border-[var(--line)] px-3 py-2 text-sm"
          >
            Poslať na panel
          </button>
          <button
            disabled={busy}
            onClick={() => save({ persist: true })}
            title="Uloží aktuálny layout do flashu panelu — tento screen nabehne po reštarte"
            className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[#062014]"
          >
            Štartová obrazovka
          </button>
          <span
            className="text-xs text-[var(--muted)]"
            title="Či má panel vo flashi uložený boot layout"
          >
            {bootSaved == null
              ? "boot: …"
              : bootSaved
                ? `boot ✓${bootBytes != null ? ` ${Math.round(bootBytes / 1024)}kB` : ""}`
                : "boot ✗ nie je uložená"}
          </span>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap gap-2">
            {(Object.keys(LABELS) as WidgetType[]).map((t) => (
              <button
                key={t}
                onClick={() => addWidget(t)}
                className="rounded border border-[var(--line)] px-2 py-1 text-xs hover:border-[var(--accent)]"
              >
                + {LABELS[t]}
              </button>
            ))}
            <label className="ml-auto flex items-center gap-2 text-xs text-[var(--muted)]">
              <input
                type="checkbox"
                checked={showGrid}
                onChange={(e) => setShowGrid(e.target.checked)}
              />
              LED mriežka
            </label>
          </div>

          <div
            ref={stageRef}
            className="relative touch-none select-none overflow-hidden rounded border border-[var(--line)] bg-black shadow-lg"
            style={{ width: stageW, height: stageH }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <canvas
              ref={canvasRef}
              width={PANEL_W}
              height={PANEL_H}
              className="pointer-events-none absolute left-0 top-0"
              style={{
                width: stageW,
                height: stageH,
                imageRendering: "pixelated",
              }}
            />
            {showGrid ? (
              <div
                className="pointer-events-none absolute inset-0 z-[1]"
                style={{
                  backgroundImage: `
                    linear-gradient(to right, rgba(255,255,255,0.07) 1px, transparent 1px),
                    linear-gradient(to bottom, rgba(255,255,255,0.07) 1px, transparent 1px)
                  `,
                  backgroundSize: `${SCALE}px ${SCALE}px`,
                }}
              />
            ) : null}
            {stripHeight > 0 ? (
              <div
                className="pointer-events-none absolute left-0 right-0 top-0 z-[2] border-b border-dashed border-[#667]"
                style={{
                  height: stripHeight * SCALE,
                  background: "rgba(40,40,50,0.25)",
                }}
              >
                <span className="absolute left-1 top-0.5 text-[9px] uppercase tracking-wider text-[#999]">
                  notify strip {stripHeight}px
                </span>
              </div>
            ) : null}
            {selectedRender ? (
              (() => {
                const box = estimateWidgetBox(selectedRender, now, sensor);
                return (
                  <div
                    className="pointer-events-none absolute z-[3] outline outline-1 outline-[var(--warn)]"
                    style={{
                      left: box.x * SCALE,
                      top: box.y * SCALE,
                      width: Math.max(1, box.width) * SCALE,
                      height: Math.max(1, box.height) * SCALE,
                    }}
                  />
                );
              })()
            ) : null}
          </div>

          {status ? (
            <p className="mt-3 text-sm text-[var(--warn)]">{status}</p>
          ) : (
            <p className="mt-3 text-xs text-[var(--muted)]">
              TTF fonty = skutočné AA (čiastočný jas LED). GFX fonty = 1-bit. T/H{" "}
              ({sensorNote || "…"}).
            </p>
          )}
        </section>

        <aside className="space-y-4">
          <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
            <h2 className="mb-3 text-sm font-medium">Jas panela</h2>
            <label className="mb-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={briAuto}
                onChange={(e) => {
                  if (e.target.checked) void setBrightness("auto");
                  else void setBrightness("manual", briValue);
                }}
              />
              Auto (podľa hodiny)
            </label>
            <input
              type="range"
              min={0}
              max={255}
              value={briValue}
              disabled={briAuto}
              onChange={(e) => setBriValue(Number(e.target.value))}
              onPointerUp={() => {
                if (!briAuto) void setBrightness("manual", briValue);
              }}
              className="w-full"
            />
            <div className="mt-1 flex justify-between text-xs text-[var(--muted)]">
              <span>manual {briValue}</span>
              <span>now {briNow ?? "—"} {briNote ? `· ${briNote}` : ""}</span>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
            <h2 className="mb-3 text-sm font-medium">Admin strip</h2>
            <label className="block text-sm">
              <span className="mb-1 flex justify-between text-xs text-[var(--muted)]">
                <span>Výška (px)</span>
                <span className="text-[var(--warn)]">
                  {stripHeight === 0 ? "vypnuté" : `${stripHeight} px`}
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={32}
                step={1}
                value={stripHeight}
                onChange={(e) => onStripChange(Number(e.target.value))}
                className="w-full"
              />
            </label>
          </div>

          <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
            <h2 className="mb-3 text-sm font-medium">Vlastnosti</h2>
            {!selected ? (
              <p className="text-sm text-[var(--muted)]">Klikni na widget na ploche.</p>
            ) : (
              <div className="space-y-3 text-sm">
                <div className="text-[var(--muted)]">{LABELS[selected.type]}</div>
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--muted)]">X</span>
                  <input
                    type="number"
                    className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-2 py-1"
                    value={selected.x}
                    onChange={(e) => updateSelected({ x: Number(e.target.value) })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--muted)]">
                    Y
                    {isTtfFont(selected.font)
                      ? " (top TTF)"
                      : selected.font && selected.font !== "default"
                        ? " (baseline GFX)"
                        : " (top)"}
                  </span>
                  <input
                    type="number"
                    className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-2 py-1"
                    value={selected.y}
                    min={stripHeight}
                    onChange={(e) =>
                      updateSelected({
                        y: Math.max(stripHeight, Number(e.target.value)),
                      })
                    }
                  />
                </label>
                {selected.type === "clock" ? (
                  <label className="block">
                    <span className="mb-1 block text-xs text-[var(--muted)]">
                      Formát času
                    </span>
                    <select
                      className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-2 py-1"
                      value={selected.format || DEFAULT_CLOCK_FORMAT}
                      onChange={(e) => updateSelected({ format: e.target.value })}
                    >
                      {CLOCK_FORMATS.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {selected.type === "date" ? (
                  <label className="block">
                    <span className="mb-1 block text-xs text-[var(--muted)]">
                      Formát dátumu
                    </span>
                    <select
                      className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-2 py-1"
                      value={selected.format || DEFAULT_DATE_FORMAT}
                      onChange={(e) => updateSelected({ format: e.target.value })}
                    >
                      {DATE_FORMATS.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--muted)]">Veľkosť</span>
                  <select
                    className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-2 py-1"
                    value={selected.size}
                    onChange={(e) =>
                      updateSelected({ size: Number(e.target.value) as 1 | 2 | 3 })
                    }
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--muted)]">Font</span>
                  <select
                    className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-2 py-1"
                    value={selected.font || "default"}
                    onChange={(e) => updateSelected({ font: e.target.value })}
                  >
                    {FONT_OPTIONS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  {(selected.type === "clock" ||
                    selected.type === "date" ||
                    selected.type === "temp" ||
                    selected.type === "humidity") &&
                  isTtfFont(selected.font) ? (
                    <span className="mt-1 block text-[10px] text-[var(--muted)]">
                      TTF digit atlas on panel — same AA, local 1Hz compose.
                    </span>
                  ) : null}
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--muted)]">Efekt</span>
                  <select
                    className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-2 py-1"
                    value={normalizeEffect(selected.effect)}
                    onChange={(e) =>
                      updateSelected({
                        effect: e.target.value as
                          | "none"
                          | "blink"
                          | "pulse"
                          | "scroll",
                      })
                    }
                  >
                    {EFFECT_OPTIONS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
                {normalizeEffect(selected.effect) !== "none" ? (
                  <label className="block">
                    <span className="mb-1 flex justify-between text-xs text-[var(--muted)]">
                      <span>Rýchlosť efektu</span>
                      <span>{selected.effect_speed ?? 5}</span>
                    </span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      step={1}
                      className="w-full"
                      value={selected.effect_speed ?? 5}
                      onChange={(e) =>
                        updateSelected({ effect_speed: Number(e.target.value) })
                      }
                    />
                  </label>
                ) : null}
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--muted)]">Farba</span>
                  <input
                    type="color"
                    className="h-9 w-full cursor-pointer rounded border border-[var(--line)] bg-[#0d1210]"
                    value={selected.color}
                    onChange={(e) => updateSelected({ color: e.target.value })}
                  />
                </label>
                {(selected.type === "text" || selected.type === "weather") && (
                  <label className="block">
                    <span className="mb-1 block text-xs text-[var(--muted)]">Text</span>
                    <input
                      className="w-full rounded border border-[var(--line)] bg-[#0d1210] px-2 py-1"
                      value={selected.text || ""}
                      maxLength={80}
                      onChange={(e) => updateSelected({ text: e.target.value })}
                    />
                  </label>
                )}
                <button
                  onClick={removeSelected}
                  className="w-full rounded border border-red-900/60 px-2 py-1.5 text-red-300"
                >
                  Zmazať widget
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

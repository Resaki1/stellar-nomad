"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom } from "jotai";
import { ArrowLeft, Check, Download, FileJson, FlaskConical, Headphones, Play, RotateCcw, Shuffle, Square, Upload, Waves } from "lucide-react";
import AudioSystem from "@/components/Audio/AudioSystem";
import { audioSettingsAtom } from "@/store/audio";
import { createRecipe, durationRange, getPreset, parseRecipe, SOUND_PRESETS, type Recipe } from "@/audio/workshop/presets";
import { encodeWav, recipeDocument, soundFilename } from "@/audio/workshop/export";
import { WorkshopPreview } from "@/audio/workshop/preview";
import { RENDERER_VERSION, type RenderedSound } from "@/audio/workshop/synthesize";
import type { RenderResponse } from "@/audio/workshop/render.worker";
import type { TestResult } from "@/audio/selftest";
import styles from "./workshop.module.scss";

const DRAFT_KEY = "sn-audio-workshop-v1";
const GROUPS = ["Mining", "Flight", "Interface", "Hull"] as const;

function saveFile(bytes: BlobPart, type: string, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Waveform({ sound }: { sound: RenderedSound }) {
  const path = useMemo(() => {
    const pcm = sound.samples;
    const columns = 700;
    const top: string[] = [], bottom: string[] = [];
    for (let x = 0; x < columns; x++) {
      let low = 0, high = 0;
      const end = Math.floor((x + 1) * pcm.length / columns);
      for (let i = Math.floor(x * pcm.length / columns); i < end; i++) { low = Math.min(low, pcm[i]); high = Math.max(high, pcm[i]); }
      top.push(`${x},${100 - high * 94}`);
      bottom.push(`${x},${100 - low * 94}`);
    }
    return `M${top.join(" L")} L${bottom.reverse().join(" L")} Z`;
  }, [sound]);
  return <svg viewBox="0 0 700 200" preserveAspectRatio="none" role="img" aria-label={`Waveform, ${sound.recipe.duration.toFixed(2)} seconds. Fixed full-scale amplitude.`}>
    {[25, 50, 75, 100, 125, 150, 175].map((y) => <line key={`y${y}`} x1="0" x2="700" y1={y} y2={y} className={y === 100 ? styles.zeroLine : styles.gridLine} />)}
    {[0, 175, 350, 525, 699].map((x) => <line key={x} x1={x} x2={x} y1="0" y2="200" className={styles.gridLine} />)}
    <path d={path} className={styles.wavePath} />
  </svg>;
}

function Slider({ label, value, min, max, step = 0.01, format, description, onChange }: {
  label: string; value: number; min: number; max: number; step?: number;
  format: (v: number) => string; description?: string; onChange: (v: number) => void;
}) {
  return <label className={styles.slider}>
    <span><strong>{label}</strong><output>{format(value)}</output></span>
    <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
    {description && <small>{description}</small>}
  </label>;
}

export default function AudioWorkshopPage() {
  const [recipe, setRecipe] = useState<Recipe>(() => createRecipe(SOUND_PRESETS[0].id));
  const [sound, setSound] = useState<RenderedSound | null>(null);
  const [reference, setReference] = useState<RenderedSound | null>(null);
  const [renderMs, setRenderMs] = useState(0);
  const [rendering, setRendering] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [playing, setPlaying] = useState<"current" | "reference" | null>(null);
  const [monitor, setMonitor] = useState(-6);
  const [filter, setFilter] = useState("");
  const [checks, setChecks] = useState<TestResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [settings, setSettings] = useAtom(audioSettingsAtom);
  const workerRef = useRef<Worker | null>(null);
  const sequence = useRef(0);
  const preview = useRef<WorkshopPreview | null>(null);
  // The worker callback is created once, so it cannot read `playing` from state.
  const playingRef = useRef<"current" | "reference" | null>(null);
  const lastPreset = useRef(recipe.presetId);
  const fileInput = useRef<HTMLInputElement>(null);
  const preset = getPreset(recipe.presetId);
  const [minDuration, maxDuration] = durationRange(preset);
  const category = preset.bus === "ui" ? "ui" : preset.bus === "ambience" ? "ambience" : "sfx";
  const muted = settings.muted || settings.master === 0 || settings[category] === 0;
  const currentReady = !!sound && !rendering && JSON.stringify(sound.recipe) === JSON.stringify(recipe);

  useEffect(() => {
    preview.current = new WorkshopPreview();
    let worker: Worker;
    try {
      worker = new Worker(new URL("../../../audio/workshop/render.worker.ts", import.meta.url), { type: "module" });
    } catch {
      setError("The render worker could not start. Reload the page in a browser with Web Worker support.");
      setRendering(false);
      return;
    }
    workerRef.current = worker;
    worker.onmessage = ({ data }: MessageEvent<RenderResponse>) => {
      if (data.id !== sequence.current) return;
      setRendering(false);
      if ("error" in data) { setError(data.error); return; }
      setSound(data.sound);
      setRenderMs(data.renderMs);
      setError("");
      // Keep the preview alive across the re-render so a knob can be tuned by
      // ear. `swap` declines only when the clip it would replace has ended.
      if (playingRef.current === "current" && !preview.current?.swap(data.sound)) show(null);
    };
    worker.onerror = (event) => { setError(`Audio render failed: ${event.message || "reload to restart the worker"}`); setRendering(false); };
    try {
      const draft = localStorage.getItem(DRAFT_KEY);
      if (draft) setRecipe(parseRecipe(JSON.parse(draft)));
    } catch { setNotice("The saved draft could not be read. Loaded the default preset."); }
    setReady(true);
    const stop = () => { preview.current?.stop(); show(null); };
    const visibility = () => { if (document.hidden) stop(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") stop(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", stop);
    window.addEventListener("keydown", key);
    return () => {
      sequence.current++;
      worker.terminate();
      workerRef.current = null;
      preview.current?.stop();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", stop);
      window.removeEventListener("keydown", key);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const id = ++sequence.current;
    setRendering(true);
    // Only a different sound interrupts playback. A parameter change is swapped
    // in mid-flight when the render lands.
    if (lastPreset.current !== recipe.presetId) { preview.current?.stop(); show(null); }
    lastPreset.current = recipe.presetId;
    const timer = setTimeout(() => {
      workerRef.current?.postMessage({ id, recipe });
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(recipe)); }
      catch { setNotice("Draft storage is unavailable. Export the recipe to keep your settings."); }
    }, 110);
    return () => clearTimeout(timer);
  }, [recipe, ready]);

  const show = (which: "current" | "reference" | null) => { playingRef.current = which; setPlaying(which); };
  const change = (key: "duration" | "pitch" | "brightness" | "motion" | "body" | "texture" | "detail" | "seed", value: number) => {
    setRecipe((previous) => ({ ...previous, [key]: value }));
  };
  const play = (which: "current" | "reference") => {
    const clip = which === "current" ? sound : reference;
    if (!clip || !preview.current) return;
    setError("");
    show(which);
    void preview.current.play(clip, () => show(null)).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err)); show(null);
    });
  };
  const stop = () => { preview.current?.stop(); show(null); };

  const importRecipe = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 65536) throw new Error("Recipe is too large (maximum 64 KB).");
      const data: unknown = JSON.parse(await file.text());
      let value = data;
      if (data && typeof data === "object" && "recipe" in data) {
        if (!("rendererVersion" in data) || data.rendererVersion !== RENDERER_VERSION) throw new Error("This recipe requires a different renderer version.");
        value = data.recipe;
      }
      setRecipe(parseRecipe(value));
      setError(""); setNotice(`Imported ${file.name}.`);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const runChecks = async () => {
    stop(); setChecking(true);
    try { const { runAudioSelfTest } = await import("@/audio/selftest"); setChecks(await runAudioSelfTest()); }
    catch (err) { setError(`Engine checks failed: ${String(err)}`); }
    finally { setChecking(false); }
  };

  return <main className={styles.workshop}>
    <AudioSystem authoring />
    <header className={styles.header}>
      <div className={styles.identity}><Waves size={26} strokeWidth={1.5} /><div><span>Stellar Nomad</span><h1>Audio workshop</h1></div></div>
      <div className={styles.headerRight}><span className={styles.format}>48 kHz / 24-bit / mono</span><Link href="/" className={styles.back}><ArrowLeft size={15} /> Back to game</Link></div>
    </header>

    <div className={styles.layout}>
      <aside className={styles.library} aria-label="Sound library">
        <div className={styles.libraryHeading}><h2>Sound library</h2><span>{SOUND_PRESETS.length}</span></div>
        <input className={styles.search} type="search" aria-label="Find a sound" placeholder="Find a sound…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <nav className={styles.presets} aria-label="Presets">
          {GROUPS.map((group) => {
            const entries = SOUND_PRESETS.filter((p) => p.group === group && `${p.name} ${p.id} ${p.trigger}`.toLowerCase().includes(filter.toLowerCase()));
            return entries.length ? <section key={group}><h3>{group}</h3>{entries.map((p) => <button key={p.id} className={`${styles.preset} ${p.id === recipe.presetId ? styles.selected : ""}`} aria-pressed={p.id === recipe.presetId} onClick={() => { setRecipe(createRecipe(p.id)); setNotice(""); }}>
              <span>{p.name}</span><small>{p.loop ? "loop" : p.experimental ? "study" : `${p.duration.toFixed(2)}s`}</small>
            </button>)}</section> : null;
          })}
          {!SOUND_PRESETS.some((p) => `${p.name} ${p.id} ${p.trigger}`.toLowerCase().includes(filter.toLowerCase())) && <p className={styles.empty}>No matching sounds.</p>}
        </nav>
        <p className={styles.libraryNote}>Original synthesis. No external audio or generation service required.</p>
      </aside>

      <section className={styles.editor} aria-label="Sound editor">
        <div className={styles.titleRow}><div><div className={styles.eventId}>{preset.id}</div><h2>{preset.name}</h2></div><span className={styles.badge}>{preset.loop ? "Seamless loop" : preset.experimental ? "Material study" : "One-shot"}</span></div>
        <p className={styles.character}>{preset.character}</p>
        <p className={styles.trigger}><span>Trigger</span>{preset.trigger}</p>

        <section className={styles.scope} aria-label="Rendered waveform" aria-busy={rendering}>
          <div className={styles.scopeTop}><span>{playing ? `Playing ${playing === "reference" ? "reference" : "current"}${rendering ? " · updating" : ""}` : rendering ? "Rendering…" : "Ready to audition"}</span><span>Amplitude / full scale</span></div>
          <div className={`${styles.wave} ${rendering ? styles.pending : ""}`}>{sound ? <Waveform sound={sound} /> : <div className={styles.noWave}>Generating the first sound…</div>}</div>
          <div className={styles.timeline}><span>0.00 s</span><span>{((sound?.recipe.duration ?? recipe.duration) / 2).toFixed(2)} s</span><span>{(sound?.recipe.duration ?? recipe.duration).toFixed(2)} s</span></div>
          <div className={styles.transport}>
            <button className={styles.play} disabled={!currentReady && playing !== "current"} onClick={() => playing === "current" ? stop() : play("current")}>
              {playing === "current" ? <Square size={15} fill="currentColor" /> : <Play size={16} fill="currentColor" />}{playing === "current" ? "Stop" : preset.loop ? "Play loop" : "Play sound"}
            </button>
            <button disabled={!currentReady} onClick={() => { if (sound) { setReference(sound); setNotice("Reference held. Change the sound, then compare both versions."); } }}>Keep reference</button>
            <button disabled={!reference} aria-pressed={playing === "reference"} title={reference ? `${getPreset(reference.recipe.presetId).name}, seed ${reference.recipe.seed}` : "Keep a reference first"} onClick={() => playing === "reference" ? stop() : play("reference")}>{playing === "reference" ? "Stop reference" : "Play reference"}</button>
            <span className={styles.escape}>Esc to stop</span>
          </div>
        </section>

        <div className={styles.stats} aria-label="Rendered audio measurements">
          <span>Peak <b>{sound ? `${sound.stats.peakDb.toFixed(1)} dBFS` : "—"}</b></span>
          <span>RMS <b>{sound ? `${sound.stats.rmsDb.toFixed(1)} dBFS` : "—"}</b></span>
          <span>Render <b>{sound ? `${renderMs.toFixed(0)} ms` : "—"}</b></span>
          <span className={styles.health}>{sound && !sound.stats.silent && sound.stats.finite && sound.stats.peakDb < 0 ? <><Check size={14} /> Headroom OK</> : sound ? "Silent recipe" : "Checking…"}</span>
        </div>

        <section className={styles.controls}>
          <div className={styles.sectionHeading}><h3>Shape the sound</h3><button className={styles.textButton} onClick={() => setRecipe(createRecipe(preset.id))}><RotateCcw size={13} /> Reset preset</button></div>
          <div className={styles.parameters}>
            <Slider label="Duration" value={recipe.duration} min={minDuration} max={maxDuration} step={0.005} format={(v) => `${v.toFixed(2)} s`} onChange={(v) => change("duration", v)} />
            <Slider label="Pitch" value={recipe.pitch} min={-12} max={12} step={0.25} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} st`} onChange={(v) => change("pitch", v)} />
            <Slider label="Brightness" value={recipe.brightness} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => change("brightness", v)} />
            {!["signal", "impact", "jet"].includes(preset.family) && <Slider label="Motion" value={recipe.motion} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} description={preset.family === "creak" ? "Rate of friction pulses." : "Slow modulation in machinery and drive sounds."} onChange={(v) => change("motion", v)} />}
          </div>
          <div className={styles.sectionHeading}><h3>Layer balance</h3><span>Relative mix; preset peak stays consistent</span></div>
          <div className={styles.layers}>
            <Slider label="Body" description="Weight, fundamental, low resonances" value={recipe.body} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => change("body", v)} />
            <Slider label="Texture" description="Turbulence, friction, switching noise" value={recipe.texture} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => change("texture", v)} />
            <Slider label="Detail" description="Upper harmonics and small transients" value={recipe.detail} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => change("detail", v)} />
          </div>
          <div className={styles.variation}><label>Variation seed <input aria-label="Variation seed" type="number" min="0" max="4294967295" step="1" value={recipe.seed} onChange={(e) => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 0 && value <= 4294967295) change("seed", value); }} /></label><button onClick={() => change("seed", (recipe.seed + 1) >>> 0)}><Shuffle size={14} /> Next variation</button><small>Same recipe + seed = same sound.</small></div>
        </section>
      </section>

      <aside className={styles.output} aria-label="Monitor and export">
        <section><h2><Headphones size={17} /> Monitor</h2><p>Audition through the game mixer. Monitor level affects listening only.</p>
          <Slider label="Monitor level" value={monitor} min={-36} max={0} step={1} format={(v) => `${v} dB`} onChange={(v) => { setMonitor(v); preview.current?.setMonitorDb(v); }} />
          <div className={styles.route}><span>Output bus</span><b>{preset.bus}</b></div>
          {muted && <p className={styles.muted}>The game mixer is muted or a volume is at zero. Adjust the game volumes below.</p>}
          <details className={styles.settings}><summary>Game volumes</summary>
            <label className={styles.muteToggle}><input type="checkbox" checked={settings.muted} onChange={(e) => setSettings({ muted: e.target.checked })} /> Mute all game audio</label>
            {(["master", "sfx", "ui", "ambience"] as const).map((key) => <Slider key={key} label={key === "ui" ? "Interface" : key === "sfx" ? "Effects" : key === "master" ? "Master" : "Ambience"} value={settings[key]} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setSettings({ [key]: v })} />)}
          </details>
          <p className={styles.small}>Playback stops when this page loses focus. While a sound is playing, parameter changes are swapped in without a gap; choosing a different sound stops it.</p>
        </section>
        <section className={styles.export}><h2>Take it into the game</h2><p>Export a lossless source and keep its recipe for future revisions.</p>
          <button className={styles.exportPrimary} disabled={!currentReady || sound?.stats.silent} onClick={() => { if (sound) saveFile(encodeWav(sound), "audio/wav", `${soundFilename(sound)}.wav`); }}><Download size={16} /> Export WAV</button>
          <button disabled={!currentReady} onClick={() => { if (sound) saveFile(JSON.stringify(recipeDocument(sound), null, 2), "application/json", `${soundFilename(sound)}.recipe.json`); }}><FileJson size={16} /> Export recipe</button>
          <button onClick={() => fileInput.current?.click()}><Upload size={16} /> Import recipe</button>
          <input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={(e) => { void importRecipe(e.target.files?.[0]); e.target.value = ""; }} />
          <p className={styles.small}>Loops include WAV loop markers. All exports are mono, including hull sounds intended for spatial playback.</p>
        </section>
        <section className={styles.automation}><h2><FlaskConical size={16} /> Agent workflow</h2><p>Generate every preset and its variants with the same renderer:</p><code>pnpm gen:audio-workshop</code><p className={styles.small}>Writes WAVs, recipes and a QA report to <b>AUDIO/workshop/</b>. The default pack is integrated into gameplay. Promote regenerated sources with pnpm integrate:audio-workshop.</p>
          <button disabled={checking} onClick={() => void runChecks()}>{checking ? "Checking engine…" : "Run engine checks"}</button>
          {checks && <details className={styles.checks} open><summary>{checks.filter((c) => c.pass).length}/{checks.length} engine checks passed</summary><ul>{checks.map((check) => <li key={check.name} className={check.pass ? styles.passed : styles.failed}>{check.pass ? "✓" : "✕"} {check.name}<small>{check.detail}</small></li>)}</ul></details>}
        </section>
      </aside>
    </div>
    <footer className={styles.footer}><span>Source authoring / renderer v{RENDERER_VERSION}</span><span role="status">{notice || "Your current recipe is saved in this browser."}</span></footer>
    {error && <div className={styles.error} role="alert"><strong>Audio workshop</strong><span>{error}</span><button onClick={() => setError("")}>Dismiss</button></div>}
  </main>;
}

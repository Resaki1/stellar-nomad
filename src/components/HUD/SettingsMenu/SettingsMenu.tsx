import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  ECLIPSE_2024_04_08_MS,
  formatSimTime,
  simEpochMsAtom,
  simRateAtom,
} from "@/store/simTime";
import "./SettingsMenu.scss";
import { SetStateAction, useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { ChevronLeft, Settings as SettingsIcon } from "lucide-react";
import {
  SetAtom,
  Settings,
  hdrCalibrationOpenAtom,
  settingsAtom,
  settingsIsOpenAtom,
} from "@/store/store";
import SettingsCheckbox from "./SettingsCheckbox/SettingsCheckbox";
import KeybindRow from "./KeybindRow/KeybindRow";
import Panel from "../Shell/Panel";
import {
  KEYBIND_ACTIONS,
  CATEGORY_LABELS,
  KeybindCategory,
  keybindsAtom,
  resetKeybindsAtom,
} from "@/store/keybinds";
import { useDetectGPU } from "@react-three/drei";
import { useAsteroidDeltaStore } from "@/sim/asteroids/runtimeContext";
import { clearShipState, loadShipState } from "@/sim/shipPersistence";
import { devTeleportAtom, devMaxSpeedOverrideAtom, devSpeedUnitAtom } from "@/store/dev";
import { type SpeedUnit, SPEED_UNIT_TO_MPS } from "@/sim/units";
import { addAssaySamplesAtom, researchAtom } from "@/store/research";
import { addCargoAtom } from "@/store/cargo";
import { modulesAtom, addCraftedItemAtom } from "@/store/modules";
import { ITEMS, RESEARCH_NODES } from "@/data/content";
import { resetCommsPlayedAtom } from "@/store/comms";
import { benchProgress, getBenchRunner } from "@/components/space/perf/benchRunner";
import { isPerfEnabled } from "@/components/space/perf/perfProfiler";
import {
  BODY_IDS,
  SCENARIOS,
  bodyRadiusKm,
  findScenario,
  resolveBodyWarp,
  resolveScenario,
} from "@/components/space/perf/scenarios";
import {
  displaySupportsHdr,
  displaySupportsP3,
  hdrCanvasStatus,
} from "@/components/space/hdrOutput";

enum SubMenu {
  Graphics = "graphics",
  Controls = "controls",
  Dev = "dev",
}

const IS_DEV = process.env.NODE_ENV === "development";

const renderSubMenu = (
  subMenu: SubMenu,
  settings: Settings,
  setSettings: SetAtom<[SetStateAction<Settings>], void>,
  onResetWorld?: () => void,
  onResetKeybinds?: () => void,
  devHandlers?: {
    onTeleport: (x: number, y: number, z: number) => void;
    onSetMaxSpeed: (speed: number | null) => void;
    currentMaxSpeedOverride: number | null;
    exposureStops: number;
    onSetExposureStops: (stops: number) => void;
    onGrantAssay: (amount: number) => void;
    onGrantCargo: (resourceId: string, amount: number) => void;
    onUnlockAllResearch: () => void;
    onGrantAllItems: () => void;
    onResetProgress: () => void;
    onResetComms: () => void;
  }
) => {
  switch (subMenu) {
    case SubMenu.Graphics:
      return (
        <>
          {/* D14. Applies to the scaled scene (planets, asteroids, stars), which
              is where the aliasing was reported; the ship's own pass is not
              multisampled — see the note in SpaceRenderer. Costs GPU memory and a
              little fill on that one target, so it is worth exposing. */}
          <SettingsCheckbox
            active={settings.antialias ?? true}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                // ⚠ `?? true` — atomWithStorage replaces the defaults with the saved
                // blob, so a key added after first run is `undefined` and `!undefined`
                // would flip it to `true` on the FIRST click and `false` on the
                // second, i.e. the toggle would appear to do nothing the first time.
                antialias: !(prev.antialias ?? true),
              }))
            }
            label="anti-aliasing (4× MSAA)"
          />
          <SettingsCheckbox
            active={settings.toneMapping}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                toneMapping: !prev.toneMapping,
              }))
            }
            label="AgX tone mapping"
          />
          <HdrOutputSetting settings={settings} setSettings={setSettings} />
          {/* Player-facing brightness. Rides on TOP of auto-exposure rather than
              replacing it: `exposureStops` is the compensation term, which
              composes with the metered EV (photometry.ts) exactly the way
              Unreal's ExposureCompensation does. So the eye still adapts; the
              player only shifts where it settles — which is what a display
              brightness control should do, since we cannot detect their panel. */}
          <label className="dev-controls__label">
            brightness {settings.exposureStops > 0 ? "+" : ""}
            {(settings.exposureStops ?? 0).toFixed(1)} stops
            {/* ⚠ No conditional " (default)" suffix here. It reflows the label when the
                value leaves its default, which moves the slider out from under the
                cursor mid-drag — the author hit exactly that on the HDR headroom
                slider and had to strip it. Same bug, same fix. */}
            <input
              type="range"
              className="dev-controls__range"
              min={-4}
              max={4}
              step={0.5}
              value={settings.exposureStops ?? 0}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  exposureStops: Number(e.target.value),
                }))
              }
            />
          </label>
          {/* ── VEILING GLARE (Phase 8, glarePass.ts) ──────────────────────────
              Scales the physical straylight fraction (0.03 = "a few percent of all
              light entering the eye is scattered"). 1.0× is the calibrated value.

              🔑 Exposed on request, and it is the right knob: glare is what makes
              staring at the sun punishing — deliberate feel — but it also veils
              asteroids and targets, so the tolerable amount depends on taste and on
              what the player is doing. The SHAPE stays derived; this scales only the
              amount, so no setting can make it unphysical in KIND.

              ⚠ `?? 1` throughout — atomWithStorage replaces defaults with the saved
              blob, so a key added after first run reads `undefined`. */}
          <label className="dev-controls__label">
            veiling glare {((settings.glare ?? 1) * 100).toFixed(0)}%
            {(settings.glare ?? 1) === 1 ? " (physical)" : ""}
            {(settings.glare ?? 1) === 0 ? " (off)" : ""}
            <input
              type="range"
              className="dev-controls__range"
              min={0}
              max={2}
              step={0.1}
              value={settings.glare ?? 1}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  glare: Number(e.target.value),
                }))
              }
            />
          </label>
        </>
      );
    case SubMenu.Controls: {
      const categories = new Map<KeybindCategory, typeof KEYBIND_ACTIONS>();
      for (const a of KEYBIND_ACTIONS) {
        if (!categories.has(a.category)) categories.set(a.category, []);
        categories.get(a.category)!.push(a);
      }

      return (
        <>
          <SettingsCheckbox
            active={settings.invertPitch}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                invertPitch: !prev.invertPitch,
              }))
            }
            label="invert pitch"
          />

          {Array.from(categories.entries()).map(([cat, actions]) => (
            <div key={cat} className="keybind-category">
              <div className="keybind-category__title">
                {CATEGORY_LABELS[cat]}
              </div>
              <div className="keybind-category__rows">
                {actions.map((a) => (
                  <KeybindRow key={a.id} action={a.id} label={a.label} />
                ))}
              </div>
            </div>
          ))}

          {onResetKeybinds && (
            <button
              className="settings-menu__button settings-menu__button--subtle"
              onClick={onResetKeybinds}
            >
              reset keybinds
            </button>
          )}
        </>
      );
    }
    case SubMenu.Dev:
      return (
        <>
          <SimTimeControls />

          <SettingsCheckbox
            active={settings.fps}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                fps: !prev.fps,
              }))
            }
            label="show fps"
          />
          <SettingsCheckbox
            active={settings.perf}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                perf: !prev.perf,
              }))
            }
            // GPU timestamp queries are requested when the WebGPURenderer is
            // constructed, so this only takes effect on the next page load.
            label="perf profiler (reload)"
          />
          <BodyWarpControls />
          <PerfSweepButton />
          {devHandlers && <DevControls {...devHandlers} />}
          {onResetWorld && (
            <button
              className="settings-menu__button settings-menu__button--danger"
              onClick={onResetWorld}
            >
              reset world
            </button>
          )}
        </>
      );
  }
};

// ---------------------------------------------------------------------------
// Sim time (ephemeris) — see store/simTime.ts
// ---------------------------------------------------------------------------

/** `YYYY-MM-DDTHH:MM:SS` in UTC, which is what a `datetime-local` input wants. */
const toDateTimeInput = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 19);

/** Slider notch → rate: 0 = frozen, then decades 1×, 10× … 1e5×. */
const NOTCH_TO_RATE = (notch: number): number => (notch === 0 ? 0 : 10 ** (notch - 1));
const RATE_TO_NOTCH = (rate: number): number =>
  rate === 0 ? 0 : Math.round(Math.log10(rate)) + 1;

/**
 * Date + rate for the ephemeris. One scalar drives every body's position and
 * orientation; the default rate is 0, so orbits are FROZEN and gameplay is
 * unchanged. Set a date to reach a specific configuration, or a rate to watch
 * one evolve.
 *
 * 🔑 The default date is the 2024-04-08 total solar eclipse at greatest eclipse,
 * the case `__lum.ephemeris()` validates against published values — so "does the
 * eclipse system work" is answerable from a fresh session.
 *
 * ⚠ Its OWN component, reading the atoms directly, and that is the fix for a
 * shipped bug: these were passed down through `devHandlers`, a `useMemo` whose
 * dependency array listed neither `simRate` nor `simEpochMs`. The atoms updated
 * but the props did not, so the date field and the rate slider both appeared
 * DEAD — they only caught up when an unrelated dependency (the max-speed
 * override) invalidated the memo. Reading state where it is rendered has no
 * dependency array to get wrong.
 *
 * The date is UNCONTROLLED + an explicit apply, not applied on change: a
 * `datetime-local` fires `onChange` on every keystroke, and a half-typed value
 * parses to `NaN` (or to the year 0002 while you type "2026"), so a controlled
 * input that wrote straight through was impossible to type into. `key` on the
 * epoch remounts it when the date changes from elsewhere (the eclipse button, or
 * time actually running) — cheaper than a draft-plus-effect and it has no
 * cascading render.
 */
function SimTimeControls() {
  const [simEpochMs, setSimEpochMs] = useAtom(simEpochMsAtom);
  const [simRate, setSimRate] = useAtom(simRateAtom);
  const dateRef = useRef<HTMLInputElement>(null);

  const applyDate = useCallback(() => {
    const raw = dateRef.current?.value;
    if (!raw) return;
    // The UA drops ":SS" when it is zero, which `Date.parse` accepts either way.
    const ms = Date.parse(raw + "Z");
    if (Number.isFinite(ms)) setSimEpochMs(ms);
  }, [setSimEpochMs]);

  return (
    <>
      <div className="dev-controls__section">
        <div className="dev-controls__label">sim date (utc)</div>
        <div className="dev-controls__row">
          <input
            key={simEpochMs}
            ref={dateRef}
            className="dev-controls__input dev-controls__input--datetime"
            type="datetime-local"
            step={1}
            defaultValue={toDateTimeInput(simEpochMs)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyDate();
            }}
          />
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={applyDate}
          >
            apply
          </button>
        </div>
        <div className="dev-controls__row">
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={() => setSimEpochMs(ECLIPSE_2024_04_08_MS)}
          >
            jump to 2024-04-08 solar eclipse
          </button>
        </div>
        <div className="dev-controls__hint">
          applied: <code>{formatSimTime(simEpochMs)}</code>
        </div>
      </div>

      <div className="dev-controls__section">
        <div className="dev-controls__label">
          time rate {simRate === 0 ? "frozen" : `${simRate.toLocaleString()}× real`}
        </div>
        <div className="dev-controls__row">
          {/* ⚠ Log steps: the useful range spans five decades — an eclipse
              transit needs ~1e4 to be watchable, orbital motion ~1e5. */}
          <input
            className="dev-controls__range"
            type="range"
            min={0}
            max={6}
            step={1}
            value={RATE_TO_NOTCH(simRate)}
            onChange={(e) => setSimRate(NOTCH_TO_RATE(Number(e.target.value)))}
          />
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={() => setSimRate(0)}
          >
            freeze
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Body / scenario warps — see docs/PERF_MEASUREMENT.md
// ---------------------------------------------------------------------------

/** Sensible starting altitude per body: low enough to see it, high enough to be outside it. */
const DEFAULT_ALT_KM = 2000;

/**
 * Two ways to get somewhere specific without the console:
 *  • any body + an altitude — for eyeballing
 *  • a named benchmark scenario — for reproducing a measured row
 *
 * Both route through the same `resolveScenario` math the sweep uses, so the pose
 * you eyeball is the pose that gets measured. A dropdown rather than one button
 * per body: 14 buttons still would not let you pick a distance, and distance is
 * what drives every altitude gate.
 *
 * Both close the menu, because `settingsIsOpenAtom` sets `frameloop="never"` —
 * with the menu open the warp sits unconsumed and nothing appears to happen.
 */
function BodyWarpControls() {
  const store = useStore();
  const setIsOpen = useSetAtom(settingsIsOpenAtom);
  const [bodyId, setBodyId] = useState<string>("earth");
  const [altKm, setAltKm] = useState(String(DEFAULT_ALT_KM));
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0].id);

  const warpTo = useCallback(
    (warp: ReturnType<typeof resolveBodyWarp>) => {
      setIsOpen(false);
      store.set(devTeleportAtom, warp);
    },
    [store, setIsOpen],
  );

  const handleBodyWarp = useCallback(() => {
    const alt = parseFloat(altKm);
    if (!Number.isFinite(alt)) return;
    warpTo(resolveBodyWarp(bodyId, alt));
  }, [bodyId, altKm, warpTo]);

  const handleScenarioWarp = useCallback(() => {
    const s = findScenario(scenarioId);
    if (s) warpTo(resolveScenario(s));
  }, [scenarioId, warpTo]);

  const handleScenarioMeasure = useCallback(() => {
    setIsOpen(false);
    void getBenchRunner(store)
      .run(scenarioId)
      .catch((err) => console.error(err));
  }, [scenarioId, store, setIsOpen]);

  return (
    <>
      <div className="dev-controls__section">
        <div className="dev-controls__label">
          warp to body — altitude above surface (r = {Math.round(bodyRadiusKm(bodyId))} km)
        </div>
        <div className="dev-controls__row">
          <select
            className="dev-controls__select"
            value={bodyId}
            onChange={(e) => setBodyId(e.target.value)}
          >
            {BODY_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <input
            className="dev-controls__input dev-controls__input--wide"
            type="number"
            placeholder="km"
            value={altKm}
            onChange={(e) => setAltKm(e.target.value)}
          />
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleBodyWarp}
          >
            warp
          </button>
        </div>
      </div>

      <div className="dev-controls__section">
        <div className="dev-controls__label">perf scenario</div>
        <div className="dev-controls__row dev-controls__row--wrap">
          <select
            className="dev-controls__select dev-controls__select--wide"
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value)}
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleScenarioWarp}
          >
            warp
          </button>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleScenarioMeasure}
          >
            measure
          </button>
        </div>
        <div className="dev-controls__hint">
          {findScenario(scenarioId)?.what}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Perf sweep launcher — see docs/PERF_MEASUREMENT.md
// ---------------------------------------------------------------------------

/**
 * Runs `__bench.sweep()` without needing the console.
 *
 * Two things this has to get right:
 *  • **It must close the settings menu first.** `settingsIsOpenAtom` drives
 *    `frameloop="never"` in Scene.tsx, so with the menu open there are no frames
 *    to measure and the sweep would hang forever on its first `advance()`.
 *  • Profiling has to have been on at page load (GPU timestamp queries are
 *    requested when the renderer is constructed), so when it isn't, this offers
 *    the reload instead of failing silently.
 */
function PerfSweepButton() {
  const store = useStore();
  const setIsOpen = useSetAtom(settingsIsOpenAtom);
  const settings = useAtomValue(settingsAtom);
  const [busy, setBusy] = useState(benchProgress.running);

  const perfActive = isPerfEnabled();

  const handleRun = useCallback(() => {
    setIsOpen(false); // MUST come first — see above.
    setBusy(true);
    // No requestAnimationFrame deferral: React flushes the close before the next
    // paint, and the runner counts RENDERED frames (perf.renderedFrames), so it
    // synchronises itself. An rAF wrapper here only adds a failure mode — rAF is
    // frozen outright in a hidden tab, which silently swallowed the whole run.
    void getBenchRunner(store)
      .sweep()
      .catch((err) => console.error(err))
      .finally(() => setBusy(false));
  }, [store, setIsOpen]);

  if (!perfActive) {
    return (
      <div className="dev-controls__section">
        <div className="dev-controls__label">perf sweep</div>
        <div className="dev-controls__hint">
          {settings.perf
            ? "enabled — reload the page to arm GPU timers"
            : "turn on “perf profiler” above, then reload"}
        </div>
      </div>
    );
  }

  return (
    <div className="dev-controls__section">
      <div className="dev-controls__label">perf sweep — ~2 min, closes this menu</div>
      <div className="dev-controls__row">
        <button
          className="settings-menu__button settings-menu__button--subtle"
          onClick={handleRun}
          disabled={busy}
        >
          {busy ? "running…" : "run perf sweep"}
        </button>
      </div>
      <div className="dev-controls__hint">
        Don&apos;t touch the controls while it runs. Progress shows in the perf
        overlay; the result prints to the console and is copied to the clipboard
        (also at <code>__bench.lastJson</code>).
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * Phase 6a — the HDR output toggle plus a read-back of what the canvas actually became.
 *
 * No hooks and no effect: this subtree is unreachable until the player has opened the
 * menu AND picked Graphics (`isOpen && activeSubMenu`), both of which start false/null,
 * so it can never be part of the server render or of hydration. That means the
 * browser-only probes can simply be read during render — and the status is then fresh
 * every time the panel is opened instead of frozen at mount.
 *
 * 🔑 The status line reports `toneMapping.mode` from the canvas's own
 * `getConfiguration()`, not a media query. That is the only test that interrogates the
 * pipeline we actually render through — a browser that accepts `outputType` but ignores
 * the tone-mapping option shows up here and nowhere else.
 */
const HdrOutputSetting = ({
  settings,
  setSettings,
}: {
  settings: Settings;
  setSettings: SetAtom<[SetStateAction<Settings>], void>;
}) => {
  // ⚠ Hooks ARE allowed here even though the rest of this subtree deliberately avoids
  // them: the component is only reachable after two clicks (menu open, Graphics picked),
  // so it is never part of the server render or of hydration.
  const setCalOpen = useSetAtom(hdrCalibrationOpenAtom);
  const setSettingsOpen = useSetAtom(settingsIsOpenAtom);
  const st = hdrCanvasStatus();
  const capable = displaySupportsHdr();
  const p3 = displaySupportsP3();
  // ⚠ `?? false` — `atomWithStorage` REPLACES the defaults with the saved blob rather
  // than merging, so for a returning player this key is `undefined` and `!undefined`
  // would make the first click a no-op. Same trap as `antialias` above.
  const on = settings.hdrOutput ?? false;

  return (
    <>
      <SettingsCheckbox
        active={on}
        onChange={() =>
          setSettings((prev) => ({ ...prev, hdrOutput: !(prev.hdrOutput ?? false) }))
        }
        label="HDR output (reload)"
      />
      {st.active && (
        /* ── HDR headroom (Phase 6c) ─────────────────────────────────────────
           How far above reference white the display transform is allowed to go.
           MEASURED on an XDR: 2 stops makes the sun's core punch out; 3 stops adds
           very little, because past the panel's real headroom the compositor clips
           and extra stops only compress more scene range into the same visible span.
           So the point where raising this stops helping IS your display's headroom —
           which is exactly what a calibration screen would measure. Mid-tones do not
           move (the transform's pivot is pinned to middle grey), so the thing to
           watch while dragging this is the SUN, not the ground. */
        <label className="dev-controls__label">
          HDR headroom {(settings.hdrPeakStops ?? 2).toFixed(2)} stops (
          {Math.pow(2, settings.hdrPeakStops ?? 2).toFixed(1)}× white)
          <input
            type="range"
            className="dev-controls__range"
            min={0}
            max={3}
            step={0.25}
            value={settings.hdrPeakStops ?? 2}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                hdrPeakStops: Number(e.target.value),
              }))
            }
          />
        </label>
      )}
      {st.active && (
        <button
          className="settings-menu__button"
          onClick={() => {
            setCalOpen(true);
            setSettingsOpen(false);
          }}
        >
          calibrate HDR…
        </button>
      )}
      <div className="dev-controls__label">
        {st.active
          ? `active — ${st.format}. \u26a0 costs a fixed ~2 ms per frame (browser compositing, measured), which hurts most at high frame rates. Raise the headroom until the sun stops getting brighter — that point is your display's real limit.`
          : on
            ? st.toneMappingMode === null
              ? "enabled — reload to apply."
              : `enabled, but this browser reported "${st.toneMappingMode}" — HDR is not active.`
            : capable
              ? `your display reports HDR${p3 ? " and P3" : ""}. \u26a0 costs a fixed ~2 ms per frame, and panels that advertise HDR at low peak brightness can look worse with it on — try both.`
              : "no HDR display detected — this will have no effect."}
      </div>
    </>
  );
};

// Dev-only controls (position teleport + max speed override)
// ---------------------------------------------------------------------------

const RESOURCE_IDS = [
  "silicates",
  "fe_ni_metal",
  "carbon",
  "sulfur",
  "hydrates",
  "titanium",
  "helium_3",
] as const;

function DevControls({
  onTeleport,
  onSetMaxSpeed,
  currentMaxSpeedOverride,
  exposureStops,
  onSetExposureStops,
  onGrantAssay,
  onGrantCargo,
  onUnlockAllResearch,
  onGrantAllItems,
  onResetProgress,
  onResetComms,
}: {
  onTeleport: (x: number, y: number, z: number) => void;
  onSetMaxSpeed: (speed: number | null) => void;
  currentMaxSpeedOverride: number | null;
  exposureStops: number;
  onSetExposureStops: (stops: number) => void;
  onGrantAssay: (amount: number) => void;
  onGrantCargo: (resourceId: string, amount: number) => void;
  onUnlockAllResearch: () => void;
  onGrantAllItems: () => void;
  onResetProgress: () => void;
  onResetComms: () => void;
}) {
  const [posX, setPosX] = useState("");
  const [posY, setPosY] = useState("");
  const [posZ, setPosZ] = useState("");
  const [speedUnit, setSpeedUnit] = useAtom(devSpeedUnitAtom);
  const [speedVal, setSpeedVal] = useState(
    currentMaxSpeedOverride !== null
      ? String(currentMaxSpeedOverride / SPEED_UNIT_TO_MPS[speedUnit])
      : ""
  );

  const [selectedResource, setSelectedResource] = useState<string>(RESOURCE_IDS[0]);
  const [resourceAmount, setResourceAmount] = useState("500");
  const [assayAmount, setAssayAmount] = useState("500");

  const handleLoadCurrent = () => {
    const saved = loadShipState();
    if (saved) {
      setPosX(String(Math.round(saved.positionKm[0] * 100) / 100));
      setPosY(String(Math.round(saved.positionKm[1] * 100) / 100));
      setPosZ(String(Math.round(saved.positionKm[2] * 100) / 100));
    }
  };

  const handleTeleport = () => {
    const x = parseFloat(posX);
    const y = parseFloat(posY);
    const z = parseFloat(posZ);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    onTeleport(x, y, z);
  };

  const handleUnitChange = (newUnit: SpeedUnit) => {
    const v = parseFloat(speedVal);
    if (Number.isFinite(v) && v > 0) {
      const mps = v * SPEED_UNIT_TO_MPS[speedUnit];
      setSpeedVal(String(mps / SPEED_UNIT_TO_MPS[newUnit]));
    }
    setSpeedUnit(newUnit);
  };

  const handleSpeedApply = () => {
    const v = parseFloat(speedVal);
    if (!speedVal.trim()) {
      onSetMaxSpeed(null);
      return;
    }
    if (!Number.isFinite(v) || v <= 0) return;
    onSetMaxSpeed(v * SPEED_UNIT_TO_MPS[speedUnit]);
  };

  const handleGrantCargo = () => {
    const amt = parseInt(resourceAmount, 10);
    if (!Number.isFinite(amt) || amt <= 0) return;
    onGrantCargo(selectedResource, amt);
  };

  const handleGrantAllCargo = () => {
    const amt = parseInt(resourceAmount, 10) || 500;
    for (const id of RESOURCE_IDS) {
      onGrantCargo(id, amt);
    }
  };

  const handleGrantAssay = () => {
    const amt = parseInt(assayAmount, 10);
    if (!Number.isFinite(amt) || amt <= 0) return;
    onGrantAssay(amt);
  };

  return (
    <div className="dev-controls">
      {/* Exposure — docs/LIGHTING_PLAN.md §3.4. Compensation in STOPS on top of
          the metered exposure; +1 = twice as bright. 0 is the calibrated neutral,
          and this same knob survives into Phase 5's auto-exposure unchanged. */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">
          exposure {exposureStops > 0 ? "+" : ""}
          {exposureStops.toFixed(2)} stops
          {exposureStops === 0 ? " (neutral)" : ` — ×${(2 ** exposureStops).toPrecision(3)}`}
        </div>
        <div className="dev-controls__row">
          <input
            className="dev-controls__range"
            type="range"
            min={-8}
            max={8}
            step={0.25}
            value={exposureStops}
            onChange={(e) => onSetExposureStops(Number(e.target.value))}
          />
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={() => onSetExposureStops(0)}
          >
            reset
          </button>
        </div>
      </div>

      {/* Teleport */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">teleport (km)</div>
        <div className="dev-controls__row">
          <input
            className="dev-controls__input"
            type="number"
            placeholder="X"
            value={posX}
            onChange={(e) => setPosX(e.target.value)}
          />
          <input
            className="dev-controls__input"
            type="number"
            placeholder="Y"
            value={posY}
            onChange={(e) => setPosY(e.target.value)}
          />
          <input
            className="dev-controls__input"
            type="number"
            placeholder="Z"
            value={posZ}
            onChange={(e) => setPosZ(e.target.value)}
          />
        </div>
        <div className="dev-controls__row">
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleLoadCurrent}
          >
            load current
          </button>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleTeleport}
          >
            teleport
          </button>
        </div>
      </div>

      {/* Max speed */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">max speed -- default: 400 m/s</div>
        <div className="dev-controls__row">
          <input
            className="dev-controls__input dev-controls__input--wide"
            type="number"
            placeholder={String(400 / SPEED_UNIT_TO_MPS[speedUnit])}
            value={speedVal}
            onChange={(e) => setSpeedVal(e.target.value)}
          />
          <select
            className="dev-controls__select"
            value={speedUnit}
            onChange={(e) => handleUnitChange(e.target.value as SpeedUnit)}
          >
            <option value="m/s">m/s</option>
            <option value="km/s">km/s</option>
            <option value="AU/s">AU/s</option>
          </select>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleSpeedApply}
          >
            {speedVal.trim() ? "apply" : "reset"}
          </button>
        </div>
      </div>

      {/* Grant cargo */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">grant cargo</div>
        <div className="dev-controls__row">
          <select
            className="dev-controls__select"
            value={selectedResource}
            onChange={(e) => setSelectedResource(e.target.value)}
          >
            {RESOURCE_IDS.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          <input
            className="dev-controls__input dev-controls__input--wide"
            type="number"
            placeholder="500"
            value={resourceAmount}
            onChange={(e) => setResourceAmount(e.target.value)}
          />
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleGrantCargo}
          >
            add
          </button>
        </div>
        <div className="dev-controls__row">
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleGrantAllCargo}
          >
            grant all resources
          </button>
        </div>
      </div>

      {/* Grant assay samples */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">assay samples</div>
        <div className="dev-controls__row">
          <input
            className="dev-controls__input dev-controls__input--wide"
            type="number"
            placeholder="500"
            value={assayAmount}
            onChange={(e) => setAssayAmount(e.target.value)}
          />
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleGrantAssay}
          >
            add
          </button>
        </div>
      </div>

      {/* Progression cheats */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">progression</div>
        <div className="dev-controls__row dev-controls__row--wrap">
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={onUnlockAllResearch}
          >
            unlock all research
          </button>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={onGrantAllItems}
          >
            grant all items
          </button>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={onResetComms}
          >
            reset comms
          </button>
          <button
            className="settings-menu__button settings-menu__button--danger"
            onClick={onResetProgress}
          >
            reset progress
          </button>
        </div>
      </div>
    </div>
  );
}

const SettingsMenu = () => {
  const [settings, setSettings] = useAtom(settingsAtom);
  const [isOpen, setIsOpen] = useAtom(settingsIsOpenAtom);
  const [activeSubMenu, setActiveSubMenu] = useState<SubMenu | null>(null);
  const gpu = useDetectGPU();
  const deltaStore = useAsteroidDeltaStore();

  const keybinds = useAtomValue(keybindsAtom);
  const resetKeybinds = useSetAtom(resetKeybindsAtom);

  const setDevTeleport = useSetAtom(devTeleportAtom);
  const [devMaxSpeed, setDevMaxSpeed] = useAtom(devMaxSpeedOverrideAtom);
  const setAddAssay = useSetAtom(addAssaySamplesAtom);
  const setAddCargo = useSetAtom(addCargoAtom);
  const [, setResearch] = useAtom(researchAtom);
  const [, setModules] = useAtom(modulesAtom);
  const setAddCraftedItem = useSetAtom(addCraftedItemAtom);
  const resetComms = useSetAtom(resetCommsPlayedAtom);

  const availableSubMenus = useMemo(
    () =>
      Object.values(SubMenu).filter(
        (s) => s !== SubMenu.Dev || IS_DEV
      ),
    []
  );

  const devHandlers = useMemo(
    () =>
      IS_DEV
        ? {
            onTeleport: (x: number, y: number, z: number) =>
              setDevTeleport({ positionKm: [x, y, z] }),
            onSetMaxSpeed: (speed: number | null) => setDevMaxSpeed(speed),
            currentMaxSpeedOverride: devMaxSpeed,
            // `?? 0` is load-bearing: `atomWithStorage` REPLACES the default with
            // whatever is in localStorage, it does not merge. Any player who
            // opened Settings before this field existed has a stored object
            // without it, so this reads `undefined` and the slider's
            // `.toFixed()` would throw. Same hazard as the hydration trap noted
            // in the comms store.
            exposureStops: settings.exposureStops ?? 0,
            onSetExposureStops: (stops: number) =>
              setSettings((prev) => ({ ...prev, exposureStops: stops })),
            onGrantAssay: (amount: number) => setAddAssay(amount),
            onGrantCargo: (resourceId: string, amount: number) =>
              setAddCargo({ resourceId, amount }),
            onUnlockAllResearch: () => {
              const allIds = RESEARCH_NODES.map((n) => n.id);
              setResearch((prev) => ({
                ...prev,
                completedNodes: allIds,
                activeResearch: null,
                assaySamples: prev.assaySamples + 9999,
              }));
            },
            onGrantAllItems: () => {
              for (const item of ITEMS) {
                if (item.type === "consumable") {
                  for (let i = 0; i < 5; i++) setAddCraftedItem(item.id);
                } else {
                  setAddCraftedItem(item.id);
                }
              }
            },
            onResetProgress: () => {
              setResearch({
                assaySamples: 0,
                completedNodes: [],
                activeResearch: null,
              });
              setModules({
                ownedModules: [],
                equippedModules: {},
                consumables: {},
                consumableCooldowns: {},
                hotbar: Array(10).fill(null),
              });
            },
            onResetComms: () => resetComms(),
          }
        : undefined,
    [setDevTeleport, setDevMaxSpeed, devMaxSpeed, settings.exposureStops, setSettings, setAddAssay, setAddCargo, setResearch, setAddCraftedItem, setModules, resetComms]
  );

  const handleResetKeybinds = useCallback(() => {
    resetKeybinds();
  }, [resetKeybinds]);

  const handleResetWorld = useCallback(() => {
    if (!window.confirm("Reset asteroid field? All mining progress will be lost.")) return;
    deltaStore.clearAll();
    clearShipState();
    localStorage.removeItem("ship-config-v1");
    localStorage.removeItem("cargo");
    localStorage.removeItem("keybinds-v1");
    localStorage.removeItem("research-v1");
    localStorage.removeItem("modules-v1");
    localStorage.removeItem("modules-v2");
    localStorage.removeItem("asteroids-mined-lifetime-v1");
    window.location.reload();
  }, [deltaStore]);

  useEffect(() => {
    const storedSettings = JSON.parse(
      localStorage.getItem("settings") ?? '{"initial": true}'
    );
    if (storedSettings.initial === true) {
      // This first-run pass only STEPS DOWN on weak hardware.
      //
      // ⚠⚠ `bloom: gpu.tier >= 2` used to live here and was a DEAD WRITE after bloom
      // was deleted — TypeScript cannot catch it, because an excess property on a
      // spread object literal is not an error. Grep, do not trust the compiler, when
      // removing a settings key.
      //
      // ⚠ VEILING GLARE IS DELIBERATELY *NOT* TIER-GATED, and the reason is that a
      // tier gate would not buy anything: reducing the glare STRENGTH saves no time
      // at all — the pyramid still runs — and only strength 0 skips the passes. So
      // the only available step-down is "off entirely", which trades the calibrated
      // eye model for 0.9–1.3 ms. Bloom was decoration costing 5.8 ms; glare is
      // physics costing a fifth of that. Not the same trade.
      //
      // Tone mapping is NOT stepped down either: swapping AgX for Neutral is not a
      // perf win (same single curve evaluation), it just picks a worse curve.
      setSettings((prev) => ({
        ...prev,
        // D14: MSAA costs a 4× colour+depth allocation on the scaled-scene target
        // plus coverage fill, so a low-tier GPU should not pay it by default.
        antialias: gpu.tier >= 2,
        initial: false,
      }));
    }
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setActiveSubMenu(null);
  }, [setIsOpen]);

  const toggleMenu = useCallback(() => setIsOpen((prev) => !prev), [setIsOpen]);

  // Hotkey handler: when closed, toggle key opens settings. When open, Panel
  // handles Esc / backdrop close.
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isOpenRef.current) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();
      if (keybindsRef.current.toggleSettings.includes(key)) {
        setIsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setIsOpen]);

  const title = activeSubMenu
    ? activeSubMenu.charAt(0).toUpperCase() + activeSubMenu.slice(1)
    : "Settings";
  const eyebrow = activeSubMenu ? "Settings" : undefined;

  return (
    <>
      <button
        className="settings__open-button"
        onClick={toggleMenu}
        aria-label="Open settings"
      >
        <SettingsIcon size={16} strokeWidth={1.75} aria-hidden />
      </button>

      {isOpen && (
        <Panel
          title={title}
          eyebrow={eyebrow}
          tier={2}
          width={560}
          onClose={handleClose}
          secondaryAction={
            activeSubMenu
              ? {
                  label: "Back",
                  icon: <ChevronLeft size={14} strokeWidth={1.75} aria-hidden />,
                  variant: "subtle",
                  onClick: () => setActiveSubMenu(null),
                }
              : undefined
          }
        >
          <div className="settings-menu">
            {!activeSubMenu ? (
              <div className="settings-menu__nav">
                {availableSubMenus.map((subMenu) => (
                  <button
                    key={subMenu}
                    className="settings-menu__button"
                    onClick={() => setActiveSubMenu(subMenu)}
                  >
                    {subMenu}
                  </button>
                ))}
              </div>
            ) : (
              <div className="settings-menu__content">
                {renderSubMenu(
                  activeSubMenu,
                  settings,
                  setSettings,
                  handleResetWorld,
                  handleResetKeybinds,
                  devHandlers
                )}
              </div>
            )}
          </div>
        </Panel>
      )}
    </>
  );
};

export default SettingsMenu;

"use client";

/**
 * Settings sections that work without the game mounted (graphics, controls), shared by the
 * in-game settings menu and the title screen's settings.
 */
import type { SetStateAction } from "jotai";
import { useSetAtom } from "jotai";
import {
  SetAtom,
  Settings,
  hdrCalibrationOpenAtom,
  settingsIsOpenAtom,
} from "@/store/store";
import SettingsCheckbox from "./SettingsCheckbox/SettingsCheckbox";
import KeybindRow from "./KeybindRow/KeybindRow";
import { KEYBIND_ACTIONS, CATEGORY_LABELS, KeybindCategory } from "@/store/keybinds";
import {
  displaySupportsHdr,
  displaySupportsP3,
  hdrCanvasStatus,
} from "@/components/space/hdrOutput";

type SectionProps = {
  settings: Settings;
  setSettings: SetAtom<[SetStateAction<Settings>], void>;
};

export function GraphicsSettings({ settings, setSettings }: SectionProps) {
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
}

export function ControlsSettings({
  settings,
  setSettings,
  onResetKeybinds,
}: SectionProps & { onResetKeybinds?: () => void }) {
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


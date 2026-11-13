// ---------------------------------------------------------------------------
// Audio settings submenu — docs/AUDIO_PLAN.md §8.
//
// Its own component rather than another branch threaded through
// `renderSubMenu`'s already-long parameter list: audio settings live in
// `audioSettingsAtom` (A9), not in `settingsAtom`, so there is nothing to pass
// down. Reuses the `.dev-controls__*` markup the Graphics submenu's brightness
// and glare sliders already use — the class prefix is misleading, but it IS the
// established convention for a non-dev slider here.
// ---------------------------------------------------------------------------

import { useAtom } from "jotai";

import {
  audioSettingsAtom,
  BLUR_LABELS,
  DEFAULT_AUDIO_SETTINGS,
  VOLUME_KEYS,
  VOLUME_LABELS,
  type BlurBehaviour,
} from "@/store/audio";
import { playAudio } from "@/audio";
import SettingsCheckbox from "./SettingsCheckbox/SettingsCheckbox";

/**
 * Slider readout as a plain percentage, like every other game's. The curve
 * behind it is perceptual (gain = t², §8.1 / `sliderToGain`), so 50% sounds
 * about half as loud rather than nearly full.
 */
function labelFor(t: number): string {
  return `${Math.round(t * 100)}%`;
}

export default function AudioSettings() {
  const [audio, setAudio] = useAtom(audioSettingsAtom);

  return (
    <>
      {VOLUME_KEYS.map((key) => (
        <label className="dev-controls__label" key={key}>
          {VOLUME_LABELS[key]} {labelFor(audio[key])}
          {/* ⚠ No conditional " (default)" suffix. It reflows the label when the
              value leaves its default, which moves the slider out from under the
              cursor mid-drag — the author hit exactly that on the HDR headroom
              slider and had to strip it. Same bug, same fix. */}
          <input
            type="range"
            className="dev-controls__range"
            min={0}
            max={1}
            step={0.01}
            value={audio[key]}
            onChange={(e) => setAudio({ [key]: Number(e.target.value) })}
            // Audible feedback while dragging the bus you are adjusting, so the
            // slider proves it works. Not on `master` — a tick per pixel of
            // travel there would be maddening.
            onPointerUp={() => {
              if (key !== "master") playAudio("hover.tick");
            }}
          />
        </label>
      ))}

      <label className="dev-controls__label">
        audio in background
        <select
          className="dev-controls__select"
          value={audio.onBlur}
          onChange={(e) =>
            setAudio({ onBlur: e.target.value as BlurBehaviour })
          }
        >
          {(Object.keys(BLUR_LABELS) as BlurBehaviour[]).map((b) => (
            <option key={b} value={b}>
              {BLUR_LABELS[b]}
            </option>
          ))}
        </select>
      </label>

      {/* Three states, "reduced" (−25 dB) by default: co-op, so you alt-tab to a
          call while the world keeps running and a hull alarm should still reach
          you. §8.2. */}
      <SettingsCheckbox
        active={audio.muted}
        onChange={() => setAudio({ muted: !audio.muted })}
        label="mute all audio"
      />

      {/* Dev-only, and NOT gated through `devHandlers` — that prop is undefined in
          production and this panel must render without it (trap T2). A plain
          NODE_ENV check is the right gate for one dev row inside a player panel. */}
      {process.env.NODE_ENV === "development" && (
        <SettingsCheckbox
          active={audio.hud}
          onChange={() => setAudio({ hud: !audio.hud })}
          label="audio hud (dev)"
        />
      )}

      <div className="dev-controls__row">
        <button
          className="settings-menu__button"
          onClick={() => playAudio("click.hard")}
        >
          test sound
        </button>
        <button
          className="settings-menu__button"
          onClick={() => setAudio({ ...DEFAULT_AUDIO_SETTINGS })}
        >
          reset to defaults
        </button>
      </div>
    </>
  );
}

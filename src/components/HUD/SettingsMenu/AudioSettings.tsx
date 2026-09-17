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
import { playAudio, sliderToGain } from "@/audio";
import SettingsCheckbox from "./SettingsCheckbox/SettingsCheckbox";

/** Slider position → the dB the player is actually setting. For the readout only. */
function labelFor(t: number): string {
  const g = sliderToGain(t);
  if (g <= 0) return "off";
  return `${(20 * Math.log10(g)).toFixed(1)} dB`;
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

      {/* 🔑 The slider curve is PERCEPTUAL, not linear: gain = t², i.e.
          dB = 40·log10(t). A linear `gain = t` mapping is the single
          most-reported volume-slider complaint — it puts nearly all audible
          change in the top 20-30% of travel, so the slider "does nothing until
          80%". See §8.1 and `sliderToGain`. */}
      <div className="dev-controls__hint">
        Music defaults below effects on purpose — it otherwise buries the alarms
        and the mining feedback.
      </div>

      <label className="dev-controls__label">
        when the tab loses focus
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

      {/* Three states rather than a boolean, and `duck` is the default. This is
          a co-op game: you alt-tab to a wiki or a call while the world keeps
          running and teammates keep playing. A hard mute means missing a
          hull-breach cue the game is actively delivering; full volume means
          blaring into the call. Ducking to −25 dB resolves both. §8.2. */}
      <div className="dev-controls__hint">
        <strong>duck</strong> drops to −25 dB so alerts still reach you —
        recommended for co-op. <strong>mute</strong> silences everything.
      </div>

      <SettingsCheckbox
        active={audio.muted}
        onChange={() => setAudio({ muted: !audio.muted })}
        label="mute all audio"
      />

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

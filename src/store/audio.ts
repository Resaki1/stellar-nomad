// ---------------------------------------------------------------------------
// AUDIO SETTINGS — docs/AUDIO_PLAN.md A9 / §8.
//
// 🔑 ITS OWN STORE MODULE, not new keys on `settingsAtom`, mirroring how
// comms.ts sits apart from store.ts. SettingsMenu.tsx is already ~1300 lines and
// `settingsAtom` already carries nine graphics keys.
//
// ⚠⚠ AND IT CARRIES A MERGE WRAPPER FROM DAY ONE — this is trap T1. Plain
// `atomWithStorage` REPLACES the defaults with the saved blob, so any key added
// later reads `undefined` for a returning player. SettingsMenu.tsx documents
// that failure three separate times because it has bitten before: `!undefined`
// is `true`, so a new toggle appears to do nothing on the first click, and
// `undefined.toFixed()` throws. keybinds.ts already solves it this way;
// settingsAtom still does not.
// ---------------------------------------------------------------------------

import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

/** What happens to audio when the tab loses focus. §8.2. */
export type BlurBehaviour = "mute" | "duck" | "play";

export type AudioSettings = {
  /** Slider positions, 0..1. Converted to gain by `sliderToGain` (t², §8.1). */
  master: number;
  music: number;
  sfx: number;
  ui: number;
  ambience: number;
  onBlur: BlurBehaviour;
  muted: boolean;
  /** Mono output (accessibility). */
  mono: boolean;
  /** Dev-only live readout (§9.2). Lives here rather than in `settingsAtom`. */
  hud: boolean;
};

/**
 * ⚠ MUSIC SITS BELOW SFX ON PURPOSE. The pull to put your own composed tracks
 * at unity is real and must be resisted: it buries the alarms, the AI chirp and
 * the mining feedback, which is the opposite of an instrument panel.
 */
export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  master: 0.8,
  sfx: 0.9,
  ui: 0.7,
  ambience: 0.7,
  music: 0.55,
  // Duck, not mute: this is a co-op game, so you alt-tab while the world keeps
  // running. A hard mute means missing a cue the game is actively delivering;
  // full volume means blaring into a call. §8.2.
  onBlur: "duck",
  muted: false,
  mono: false,
  hud: false,
};

const _rawAudioSettingsAtom = atomWithStorage<AudioSettings>(
  "audio-v1",
  DEFAULT_AUDIO_SETTINGS,
);

/**
 * Migration-safe audio settings. Reads always merge over the defaults, so a key
 * added in a later version is never `undefined` for a returning player (T1).
 */
export const audioSettingsAtom = atom(
  (get): AudioSettings => ({
    ...DEFAULT_AUDIO_SETTINGS,
    ...get(_rawAudioSettingsAtom),
  }),
  (get, set, update: Partial<AudioSettings>) => {
    set(_rawAudioSettingsAtom, {
      ...DEFAULT_AUDIO_SETTINGS,
      ...get(_rawAudioSettingsAtom),
      ...update,
    });
  },
);

/** Labels for the settings UI. Keys are the slider-backed fields only. */
export const VOLUME_LABELS: Record<
  "master" | "music" | "sfx" | "ui" | "ambience",
  string
> = {
  master: "master",
  sfx: "effects",
  ui: "interface",
  ambience: "ambience",
  music: "music",
};

export const VOLUME_KEYS = [
  "master",
  "sfx",
  "ui",
  "ambience",
  "music",
] as const;

/** Player-facing names; the ids stay for saved settings. Key order = menu order. */
export const BLUR_LABELS: Record<BlurBehaviour, string> = {
  play: "full volume",
  duck: "reduced",
  mute: "muted",
};

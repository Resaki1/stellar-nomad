import { setBusGain, setMasterGain, sliderToGain } from "@/audio/engine";
import { VOLUME_KEYS, type AudioSettings } from "@/store/audio";

/** Volume sliders → bus gains. `sfx` drives both the ship and the world bus (§5.5). */
export function applyAudioSettings(settings: AudioSettings): void {
  setMasterGain(settings.muted ? 0 : sliderToGain(settings.master));
  for (const key of VOLUME_KEYS) {
    if (key === "master") continue;
    const gain = sliderToGain(settings[key]);
    if (key === "sfx") {
      setBusGain("sfxShip", gain);
      setBusGain("sfxWorld", gain);
    } else {
      setBusGain(key, gain);
    }
  }
}

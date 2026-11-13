// Typed view of `musicTracks.json`. Authored fields are hand-edited there;
// measured fields are written only by `scripts/process-music.mjs`.
import manifest from "./musicTracks.json";

export type MusicMood = "calm" | "explore" | "tension" | "danger";

export type MusicTrack = {
  id: string;
  title: string;
  artist: string;
  mood: MusicMood;
  /** Relative pick weight within its mood pool. */
  weight: number;
  durationSec: number;
  /** First and last audible instants; edge silence is skipped at playback. */
  startSec: number;
  endSec: number;
  /** Runtime gain to the shared loudness target. Applied here, not baked in. */
  gainDb: number;
};

export const MUSIC_TRACKS: readonly MusicTrack[] = (manifest.tracks as MusicTrack[]).map((t) => ({
  id: t.id, title: t.title, artist: t.artist, mood: t.mood, weight: t.weight,
  durationSec: t.durationSec, startSec: t.startSec, endSec: t.endSec, gainDb: t.gainDb,
}));

export function musicUrl(track: MusicTrack): string {
  return `/audio/music/${track.id}.opus`;
}

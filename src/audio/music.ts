// ---------------------------------------------------------------------------
// MUSIC DIRECTOR — docs/AUDIO_PLAN.md §7.
//
// Silence → weighted pick from the mood pool → fade in → play ONCE → fade out
// → silence. No loops, no beat grid, no crossfades. Driven by the 15 Hz audio
// tick on real time (A6), so it keeps time while the settings menu stops the
// render loop.
//
// 🔑 THE FIRST TRACK COMES EARLY, THE REST ARE SPARSE. There is no title
// screen, so the start of a session plays that role: one track shortly after
// the first interaction, then long randomised silences. Silence is the default
// state (§7.2) — it is what makes a track land when it does.
// ---------------------------------------------------------------------------

import { MUSIC_TRACKS, musicUrl, type MusicMood, type MusicTrack } from "@/data/musicTracks";
import { createStreamSource, dbToGain, getEngine, isAudioUnlocked, setParamSmooth, type StreamSource } from "./engine";

/** Delay from audio unlock to the first track, s. */
export const MUSIC_FIRST_DELAY_S: readonly [number, number] = [20, 40];
/** Silence between tracks, s. Minecraft-like sparseness, a little denser. */
export const MUSIC_GAP_S: readonly [number, number] = [300, 720];
const FADE_IN_S = 3;
const FADE_OUT_S = 4;
/** Under comms and critical alerts (§7.6). */
const DUCK_DB = -9;
/** How long "explore" outlasts the transit that caused it, s. */
const EXPLORE_HOLD_S = 180;

type Playing = { track: MusicTrack; src: StreamSource; fadingOut: boolean; stopAtMs: number };

let current: Playing | null = null;
let nextAtMs: number | null = null;
let lastId: string | null = null;
let ducked = false;
let suppressed = false;
let traveling = false;
let exploreUntilMs = 0;

const between = ([lo, hi]: readonly [number, number]) => lo + Math.random() * (hi - lo);

function mood(now: number): MusicMood {
  return traveling || now < exploreUntilMs ? "explore" : "calm";
}

/** Weighted pick from the mood pool, never repeating the last track if avoidable. */
function pick(m: MusicMood): MusicTrack | null {
  const pools = [
    MUSIC_TRACKS.filter((t) => t.mood === m && t.id !== lastId),
    MUSIC_TRACKS.filter((t) => t.mood === "calm" && t.id !== lastId),
    MUSIC_TRACKS.filter((t) => t.id !== lastId),
    MUSIC_TRACKS,
  ];
  const pool = pools.find((p) => p.length > 0);
  if (!pool) return null;
  let r = Math.random() * pool.reduce((s, t) => s + t.weight, 0);
  for (const t of pool) if ((r -= t.weight) <= 0) return t;
  return pool[pool.length - 1];
}

function targetGain(track: MusicTrack): number {
  return dbToGain(track.gainDb + (ducked ? DUCK_DB : 0));
}

function setMediaSession(track: MusicTrack | null): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  if (!track) {
    ms.metadata = null;
    ms.playbackState = "none";
    return;
  }
  ms.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: "Stellar Nomad" });
  ms.playbackState = "playing";
  // A stray media key must do something sensible mid-flight (§7.7).
  ms.setActionHandler("pause", () => stopMusic());
  ms.setActionHandler("stop", () => stopMusic());
  ms.setActionHandler("nexttrack", () => skipMusic());
  ms.setActionHandler("play", () => { if (!current) playMusicNow(); });
}

function start(track: MusicTrack): void {
  const e = getEngine();
  const src = createStreamSource(musicUrl(track), "music");
  if (!e || !src) return;
  const { element, gain } = src;
  // Skip the measured edge silence; set once metadata makes seeking legal.
  element.addEventListener("loadedmetadata", () => { element.currentTime = track.startSec; }, { once: true });
  const t = e.ctx.currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(targetGain(track), t + FADE_IN_S);
  current = { track, src, fadingOut: false, stopAtMs: 0 };
  lastId = track.id;
  setMediaSession(track);
  element.play().catch(() => {
    // Autoplay refused or the file failed: give up on this one, try later.
    src.dispose();
    if (current?.src === src) current = null;
    setMediaSession(null);
    nextAtMs = performance.now() + 30_000;
  });
}

function fadeOut(seconds = FADE_OUT_S): void {
  const e = getEngine();
  if (!current || current.fadingOut || !e) return;
  const g = current.src.gain.gain;
  const t = e.ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(0, t + seconds);
  current.fadingOut = true;
  current.stopAtMs = performance.now() + seconds * 1000 + 100;
}

/** Called from the audio tick. */
export function pumpMusic(): void {
  if (!isAudioUnlocked() || MUSIC_TRACKS.length === 0) return;
  const now = performance.now();
  if (nextAtMs === null) nextAtMs = now + between(MUSIC_FIRST_DELAY_S) * 1000;

  if (current) {
    const el = current.src.element;
    // Begin the fade so it ENDS at the last audible instant, not after it.
    if (!current.fadingOut && (el.ended || el.currentTime >= current.track.endSec - FADE_OUT_S)) fadeOut();
    if (current.fadingOut && now >= current.stopAtMs) {
      current.src.dispose();
      current = null;
      setMediaSession(null);
      nextAtMs = now + between(MUSIC_GAP_S) * 1000;
    }
    return;
  }
  if (!suppressed && now >= nextAtMs) {
    const track = pick(mood(now));
    if (track) start(track);
  }
}

/** While in transit the next pick is "explore", and for a while after. */
export function setMusicTraveling(isTraveling: boolean): void {
  if (traveling && !isTraveling) exploreUntilMs = performance.now() + EXPLORE_HOLD_S * 1000;
  traveling = isTraveling;
}

/** Duck under comms and critical alerts. */
export function setMusicDucked(isDucked: boolean): void {
  if (ducked === isDucked) return;
  ducked = isDucked;
  if (current && !current.fadingOut) setParamSmooth(current.src.gain.gain, targetGain(current.track), 0.3);
}

/** Death: fade out and start nothing until it clears. */
export function setMusicSuppressed(isSuppressed: boolean): void {
  if (suppressed === isSuppressed) return;
  suppressed = isSuppressed;
  if (isSuppressed) fadeOut(2);
  else nextAtMs = performance.now() + between(MUSIC_GAP_S) * 1000;
}

/** Fade the current track out; the normal silence follows. */
export function stopMusic(): void {
  fadeOut();
}

/** Fade the current track out and start another straight after. */
export function skipMusic(): void {
  fadeOut(1.5);
  nextAtMs = performance.now() + 1600;
}

/** Start a track now (media "play" key, dev harness). */
export function playMusicNow(id?: string): boolean {
  if (!isAudioUnlocked()) return false;
  const track = id ? MUSIC_TRACKS.find((t) => t.id === id) : pick(mood(performance.now()));
  if (!track) return false;
  if (current) {
    current.src.dispose();
    current = null;
  }
  start(track);
  return true;
}

/** Dev: jump the current track to `secondsBeforeEnd` before its last audible instant. */
export function seekMusicToEnd(secondsBeforeEnd: number): void {
  if (current && !current.fadingOut) current.src.element.currentTime = Math.max(0, current.track.endSec - secondsBeforeEnd);
}

export function musicDebug(): Record<string, unknown> {
  const now = performance.now();
  const el = current?.src.element;
  return {
    mood: mood(now),
    playing: current ? {
      id: current.track.id,
      t: el ? Math.round(el.currentTime * 10) / 10 : null,
      endSec: current.track.endSec,
      gain: Math.round(current.src.gain.gain.value * 1000) / 1000,
      fadingOut: current.fadingOut,
      paused: el?.paused,
    } : null,
    nextInS: !current && nextAtMs !== null ? Math.round((nextAtMs - now) / 1000) : null,
    ducked, suppressed, traveling,
    exploreHoldS: Math.max(0, Math.round((exploreUntilMs - now) / 1000)),
  };
}

// ---------------------------------------------------------------------------
// ASSET LOADING — tiered preload + decode cache. docs/AUDIO_PLAN.md A7 / §6.8.
//
// SFX decode into AudioBuffers and stay resident; music streams (A7), because
// AudioBuffer is decoded f32 PCM at a MEASURED 344 KiB/s stereo — a 3-minute
// track is ~62 MB resident, and a dozen would be 500 MB+.
// ---------------------------------------------------------------------------

import {
  audioEventsByPreloadTier,
  type PreloadTier,
} from "@/data/audioEvents";
import { ensureEngine } from "./engine";

type Entry =
  | { state: "loading"; promise: Promise<AudioBuffer | null> }
  | { state: "ready"; buffer: AudioBuffer; decodeMs: number; bytes: number }
  | { state: "failed"; error: string };

const cache = new Map<string, Entry>();

export type LoadStats = {
  ready: number;
  loading: number;
  failed: number;
  residentBytes: number;
  files: {
    url: string;
    state: Entry["state"];
    decodeMs?: number;
    bytes?: number;
    error?: string;
  }[];
};

/**
 * Fetch + decode one file, memoised.
 *
 * ⚠ A first-play decode is an audible hitch — MEASURED 6.3 ms for 3 s of mono
 * 16-bit WAV (T6). That is why Tier 0/1 are warmed during load rather than
 * decoded lazily on the first mining press.
 */
export function loadAudioFile(url: string): Promise<AudioBuffer | null> {
  const hit = cache.get(url);
  if (hit) {
    if (hit.state === "ready") return Promise.resolve(hit.buffer);
    if (hit.state === "loading") return hit.promise;
    return Promise.resolve(null);
  }

  const e = ensureEngine();
  if (!e) return Promise.resolve(null);

  const promise = (async (): Promise<AudioBuffer | null> => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      const t0 = performance.now();
      // `decodeAudioData` resamples to the context rate here — MEASURED 44100
      // on the target machine, NOT 48000. Authoring at 48 k is fine; assuming
      // 48 k at runtime is not.
      const buffer = await e.ctx.decodeAudioData(bytes);
      const decodeMs = performance.now() - t0;
      cache.set(url, {
        state: "ready",
        buffer,
        decodeMs,
        bytes: buffer.length * buffer.numberOfChannels * 4,
      });
      return buffer;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cache.set(url, { state: "failed", error: msg });
      console.warn(`[audio] failed to load ${url}: ${msg}`);
      return null;
    }
  })();

  cache.set(url, { state: "loading", promise });
  return promise;
}

export function getCachedBuffer(url: string): AudioBuffer | null {
  const hit = cache.get(url);
  return hit && hit.state === "ready" ? hit.buffer : null;
}

/** Warm every file at a preload tier. Fire-and-forget; failures are logged, not thrown. */
export function preloadTier(tier: PreloadTier): Promise<void> {
  const urls = new Set<string>();
  for (const def of audioEventsByPreloadTier(tier)) {
    for (const v of def.variants) urls.add(v);
  }
  // `Array.from`, not spread — tsconfig targets es5 (see audioEvents.ts).
  return Promise.all(Array.from(urls).map(loadAudioFile)).then(() => undefined);
}

export function loadStats(): LoadStats {
  let ready = 0;
  let loading = 0;
  let failed = 0;
  let residentBytes = 0;
  const files: LoadStats["files"] = [];
  for (const [url, entry] of Array.from(cache.entries())) {
    if (entry.state === "ready") {
      ready++;
      residentBytes += entry.bytes;
      files.push({
        url,
        state: entry.state,
        decodeMs: Math.round(entry.decodeMs * 100) / 100,
        bytes: entry.bytes,
      });
    } else if (entry.state === "loading") {
      loading++;
      files.push({ url, state: entry.state });
    } else {
      failed++;
      files.push({ url, state: entry.state, error: entry.error });
    }
  }
  return { ready, loading, failed, residentBytes, files };
}

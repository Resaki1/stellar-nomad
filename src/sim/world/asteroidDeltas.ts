import { UNCHUNKED, type AsteroidDeltas } from "@/save/types";

const EMPTY: ReadonlySet<number> = new Set();

/**
 * O(1) lookup over the save's per-chunk destroyed-id lists. Rebuilt when the backing object
 * changes identity (world activated / reset); appended to in step with the save.
 */
export class AsteroidDeltaIndex {
  private source: AsteroidDeltas | null = null;
  private readonly sets = new Map<string, Map<string, Set<number>>>();

  sync(deltas: AsteroidDeltas): void {
    if (deltas === this.source) return;
    this.source = deltas;
    this.sets.clear();
    for (const fieldId of Object.keys(deltas)) {
      const m = new Map<string, Set<number>>();
      for (const chunkKey of Object.keys(deltas[fieldId])) m.set(chunkKey, new Set(deltas[fieldId][chunkKey]));
      this.sets.set(fieldId, m);
    }
  }

  /** Destroyed ids recorded under `chunkKey`. */
  chunk(fieldId: string, chunkKey: string): ReadonlySet<number> {
    return this.sets.get(fieldId)?.get(chunkKey) ?? EMPTY;
  }

  /** Migrated ids whose chunk is unknown. */
  unchunked(fieldId: string): ReadonlySet<number> {
    return this.chunk(fieldId, UNCHUNKED);
  }

  has(fieldId: string, chunkKey: string, id: number): boolean {
    const f = this.sets.get(fieldId);
    if (!f) return false;
    return (f.get(chunkKey)?.has(id) ?? false) || (f.get(UNCHUNKED)?.has(id) ?? false);
  }

  /** Records into both the index and the backing save object. */
  add(fieldId: string, chunkKey: string, id: number): void {
    const deltas = this.source;
    if (!deltas) throw new Error("[AsteroidDeltaIndex] add before sync");
    let f = this.sets.get(fieldId);
    if (!f) this.sets.set(fieldId, (f = new Map()));
    let s = f.get(chunkKey);
    if (!s) f.set(chunkKey, (s = new Set()));
    s.add(id);
    ((deltas[fieldId] ??= {})[chunkKey] ??= []).push(id);
  }

  count(): number {
    let n = 0;
    this.sets.forEach((f) => f.forEach((s) => (n += s.size)));
    return n;
  }
}

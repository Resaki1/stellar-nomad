import { renderSound, type RenderedSound } from "./synthesize";
import type { Recipe } from "./presets";

export type RenderRequest = { id: number; recipe: Recipe };
export type RenderResponse = { id: number; sound: RenderedSound; renderMs: number } | { id: number; error: string };

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<RenderRequest>) => void) | null;
  postMessage: (value: RenderResponse, transfer?: Transferable[]) => void;
};
worker.onmessage = ({ data }) => {
  const start = performance.now();
  try {
    const sound = renderSound(data.recipe);
    worker.postMessage({ id: data.id, sound, renderMs: performance.now() - start }, [sound.samples.buffer]);
  } catch (error) {
    worker.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};

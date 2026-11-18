import { playAudio, registerEmitter, type EmitterHandle } from "@/audio";

let loop: EmitterHandle | null = null;
let poll: number | null = null;

/** Start cue + the scan loop for as long as `active()` holds (inspection or site scan, B11). */
export function startInspectAudio(active: () => boolean): void {
  stopInspectAudio();
  playAudio("mining.inspect.start");
  loop = registerEmitter({ event: "mining.inspect.loop", fadeInMs: 60 });
  poll = window.setInterval(() => {
    if (!active()) stopInspectAudio();
  }, 100);
}

export function stopInspectAudio(): void {
  if (poll !== null) window.clearInterval(poll);
  poll = null;
  loop?.stop(120);
  loop = null;
}

# Automated Testing: driving the game without a human

How an agent (or you) runs the game, puts the camera somewhere repeatable, waits
until the picture is final, and **measures** the picture and the sound. The goal is
unattended loops: "iterate until this metric passes at these scenes".

Two front ends share one in-game API:

| | `scripts/drive.mjs` (headless Chrome) | in-app browser pane |
|---|---|---|
| Use for | unattended loops, perf, anything long | quick interactive looks |
| Renders when nobody watches | **yes** | **no**: rAF drops to ~2/s while the pane is hidden |
| Files on disk | direct (CDP) | via `POST /api/dev/capture` |
| GPU | real Metal WebGPU, `timestamp-query` | same |

Both need the dev server (`pnpm start`) and a **dev build**: `__test` does not exist
in production.

---

## 1. `scripts/drive.mjs`

```bash
pnpm drive -- scene:earth_horizon_8 settle canvas:h8 stats
```

Every step prints one JSON line (`{"step", "ok", "ms", "result"}`); the first
failure stops the run with a non-zero exit code. Console errors and warnings from the
page are printed at the end. Full step and option list: the header of
`scripts/drive.mjs`.

**Fast iteration:** `--keep` leaves Chrome running with the game loaded, so the next
call attaches in ~50 ms instead of reloading. The page is connected to the dev
server, so HMR applies edits; use the `reload` step after anything HMR can't apply
(module-level state, shaders built once). `--stop` kills it.

**Profile:** `.captures/.chrome-profile` persists between runs (localStorage, the
save). `--fresh` wipes it. The driver pre-sets the AI name so the naming prompt can't
swallow keystrokes, and by default calls `__test.isolate()`: bench mode, so no comms,
no ship-position saves, no camera shake. `--no-isolate` keeps gameplay live.

**Title screen (M0.4).** The driver loads `?autostart=1`, which skips the title but
still waits for the loading gate: `__test.ready()` resolves once the game is playable.
`--title` loads the title instead; a script then starts a world (UI clicks or
`__test.app.start(id?)`) and calls `d.enterGame()`. `__test.app` exposes `phase()`,
`progress()` and `timings()` (stage times, and frame stats for the first 10 s after the
gate). `--query nogate=1` bypasses the gate (dev only); see
`scripts/drive-examples/shell-check.mjs`.

**Resolution** is pinned: `--size 1280x720 --dpr 1` by default. Compare captures
only at the same size and DPR.

### Perf runs: always `--perf`

`--perf` loads `?perf` (per-pass GPU timers) **and switches Chrome to vsync pacing**.
Without `--perf`, frames are uncapped (~110 rAF/s) for speed, and in that mode
three's timestamp query pool overflows ("Maximum number of queries exceeded"), so GPU
samples stop arriving or come back corrupt. MEASURED 2026-11-13: an uncapped
headless run reported 11.0 ms GPU at `earth_horizon_8` from that broken state. A kept
Chrome is relaunched automatically when the mode changes.

```bash
pnpm drive -- --perf bench:earth_650,earth_750
```

Headless numbers are comparable with other headless runs at the same size, **not**
with numbers from the pane or a normal window. Same rules as
[`PERF_MEASUREMENT.md`](PERF_MEASUREMENT.md) otherwise (reload before a sweep you
intend to compare; quote pass milliseconds, not FPS).

### Input

`hold:<key>:<ms>` sends trusted CDP key events. The flight model samples **held**
keys per frame, so a tap (`press:`) never steers. Defaults (M1): W/S throttle set-point,
A/D strafe, arrows pitch/yaw, Q/E roll, Shift boost, X brake, V assist, M mine, T transit
(hold). `click:<x>:<y>` for UI. Scripted flight without key timing: `__test.flight.simulate`.

Mouse (M1b): `__test.input.mouse(dx, dy)` injects a delta exactly where a pointer-lock
`mousemove` lands; `freeLook(on)`, `mode('stick'|'aim')`, `sampleCamera(n)`; `state()` has
`camera`, `input` and `reticle`. A real pointer lock works headless only after
`d.send("Page.bringToFront")` (else `WrongDocumentError`); then trusted CDP `mouseMoved`
events arrive as `movementX`. The settings menu stops the render loop, so `shot:` (which
waits for frames) stalls there: capture with `Page.captureScreenshot` directly.

### Sandbox

Chrome can't start inside Claude Code's Seatbelt sandbox (mach-port denial), and
sandboxed commands can't reach localhost. The driver must run unsandboxed: either
approve it per call, or exclude it in `.claude/settings.local.json`:

```json
{ "sandbox": { "excludedCommands": ["pnpm drive*", "pnpm -s drive*"] } }
```

---

## 2. The in-game API: `window.__test`

Source: `src/components/TestHarness/testHarness.ts`. Installed by `DevTools.tsx` in
development.

| Call | What it does |
|---|---|
| `isolate(on = true)` | bench mode on/off (see above), clears queued comms |
| `scene("earth_650")` | any `__bench.list()` scenario |
| `scene({ body, altKm, look?, phaseDeg? })` | ad-hoc pose, same sun-relative frame as the bench (`look`: `body` / `up` / `horizon`) |
| `await settled(opts?)` | waits until the frame is final; returns `{ settled, frames, ms, pending }` |
| `await frames(n)` | n **rendered** frames (rejects after 10 s with none: paused loop) |
| `hud(false)` | hides all DOM over the canvas (HUD, labels, dev badge) |
| `await hold(key, ms)` | synthetic held key on `window` (pane use; the driver uses CDP) |
| `state()` | atmosphere body, altitude, speed, throttle, exposure EVs, resident resources |
| `await image.stats(region?)` | metrics of the rendered frame, HUD excluded (below) |
| `await image.png()` / `image.save(name)` | base64 PNG / write `.captures/<name>.png` |
| `audio.unlock()` | resume the AudioContext without a gesture |
| `await audio.record(ms, keep?, eventId?)` | record the real master bus, optionally firing an event at the start |
| `await audio.save(name, ms?, eventId?)` | same, written to `.captures/<name>.webm` |

### What "settled" means

All of these, re-checked every frame:

1. the teleport was consumed;
2. no pending cloud volume bakes, blue noise loaded (the bench's own signals);
3. network idle for 750 ms (fetch in flight + resource timing);
4. resident texture/geometry counts unchanged for 30 frames (LOD tiers swapping in);
5. eye adaptation within 0.07 EV of its target. By default it is **snapped** once
   loading finishes, because adaptation is deliberately slow, and **re-snapped** if
   the target moves afterwards. MEASURED: rotation keeps damping out after a key
   release and moved the target 0.37 EV after a one-time snap;
6. then at least one full cloud temporal cycle (`CLOUD_TEMPORAL_CYCLE` frames)
   **after** the last snap, because radiance buffers are pre-exposed (D25) and history
   accumulated at the old exposure is wrong. If loading restarts, the count restarts.

If `maxFrames` (default 3000) runs out, `pending` names what never finished.
Measured: 5–13 s per warp headless.

### Image metrics

`image.stats({ x0, y0, x1, y1 })`, with the region normalised to 0..1 from the top left:

- `luma` mean / p01 / p50 / p99 (8-bit sRGB luma), `rgbMean`, 32-bin `histogram`
- `clippedFrac` (any channel ≥ 254), `blackFrac` (luma ≤ 1)
- `banding.edgesPer1kPx`: ±1 LSB steps between two flat runs ≥ 4 px, rows plus
  columns. Dithered gradients score near 0, quantised ones high. `meanFlatRunPx`
  is the typical band width.
- `hash`: 16×9 thumbnail hash; equal hashes mean nothing visible changed.

These are **post-tonemap 8-bit** values, the right thing for "does it look banded,
clipped or crushed". They are *not* photometric. For radiance, exposure or luminance
questions use `__lum` (see `LIGHTING_PLAN.md`), which reads the HDR buffers.

`compare:a:b` in the driver runs ffmpeg SSIM + PSNR and writes `a__b.diff.png`
(absolute difference ×4).

### Audio

`audio:<name>:<ms>:<eventId>` records the master bus after the limiter (what the
player hears) and writes:

- `<name>.webm`, the Opus recording;
- EBU R128 integrated loudness, loudness range and true peak (ffmpeg `ebur128`);
- `<name>.spectrogram.png`, log-frequency, which an agent can read like a screenshot.

Silence measures as −120 dB (floored; Opus decodes digital silence to denormals). A
ship parked at rest is genuinely near-silent: don't mistake that for a broken capture.
Fire an event to test the chain end to end, for example `audio:click:1000:click.hard`.
`__audio.selftest()` (offline DSP assertions) still applies, see `AUDIO_PLAN.md` §10.

### Two browsers (co-op)

`scripts/drive-coop.mjs` runs a host and a guest Chrome side by side (headless, muted,
own profiles `.captures/.chrome-profile-{host,guest}`, CDP ports 9341/9342, pidfiles
`.captures/.chrome-{host,guest}.pid`, so `DRIVE_PROFILE=host DRIVE_CDP_PORT=9341 pnpm drive`
can attach to a kept one). A `run:` script gets `{ host, guest }`, each with `load(query)`,
`ready()`, `evaluate`, `press`, `frames`, `shot`, `canvas`. Both Chromes stop at the end
unless `--keep`; `pnpm drive:coop -- --stop` stops kept ones.

```bash
COOP_PARTS=settingsSpawn,presence,jitter,race,raceRev,dropReply,restart,lunar,joinCard,reloadPose,lateName,remoteFx,crash,pilotMarker,rename,writeGate,exportHidden,cancelJoin,handoff,hostFail,leave pnpm drive:coop -- --url http://127.0.0.1:3001/ run:scripts/drive-examples/coop-check.mjs
```

For Settings and starting positions, run `COOP_PARTS=settingsSpawn,reloadPose,leave` with
the same command. The host keeps Settings open as the first guest joins. The gate measures
both ships' simulation steps and spawn separation, then checks the host pauses again when
the last guest leaves.

For crashes and laser visibility, run `COOP_PARTS=remoteFx,crash`. The host watches a guest mine
from 7 km, hit an asteroid, die on a second approach, then respawn. `pnpm coop:transcript shipLifecycle`
delivers delayed poses across death and respawn and adds an observer while the pilot is dead.
For Settings cursor capture, run `SHELL_PARTS=lock pnpm drive -- --title run:scripts/drive-examples/shell-check.mjs`.
The gate opens Settings with Escape, waits for the previous input activation to expire, then closes
with Escape and reads `document.pointerLockElement`. It also checks Enter to resume flight.

The gate mines through MiningSystem (aim, focus, the [M] key). Faults are in-page test
hooks: `__test.coop.holdIncoming(ms)` (latency spike: the race loser still sends its claim)
and `__test.coop.cutAfterCommit()` (the link dies after the host commits, before the reply).
Delay faults set before the action: `window.__coopFault = { hostStartDelayMs }` (slow host
worker start: handoff) and `{ joinSnapshotDelayMs }` (welcome/snapshot held: Back while
"Joining…"). At the title only the stub harness exists; `__test.coopTitle()` reads join state there.
presence and race fail on any WebGPU `setPipeline` console error and require the first pose
sample after first sight under 200 ms (the remote ship is precompiled at session start).
remoteFx reads `__test.coop.fx(ms)` (what each remote slot drew: beam frames/length, plume) and
`__test.coop.bursts()` (destruction bursts shown for another pilot's mine); pilotMarker reads
`__test.coop.markers()` (green pilot POI markers and edge triangles as drawn, plus the gaze
target); rename types into Settings → friends. Captures go to `.captures/coop/`.

---

## 3. Quality-goal loops

The pattern, from `scripts/drive-examples/quality-gate.mjs`:

```js
export default async function (d) {
  await d.scene("earth_horizon_8");
  const s = await d.settle();
  await d.canvas("horizon8");
  const st = await d.stats("0,0,0.45,1");
  return { pass: s.settled && st.banding.edgesPer1kPx < 15, st };
}
```

```bash
pnpm drive -- --keep run:scripts/drive-examples/quality-gate.mjs
```

To turn a goal into a loop:

1. **Name the scenes** where the goal must hold: bench ids or ad-hoc specs. Include
   the hard cases (grazing horizon, night side, inside the deck).
2. **Pick a metric and measure the current build first.** A threshold set before
   seeing the baseline is a guess.
3. **State the stop condition up front**: metric thresholds, plus a perf budget
   (`--perf bench:`) so a visual fix can't silently cost 3 ms.
4. Iterate: edit, `reload` if HMR can't apply it, rerun, read numbers **and** look at
   the PNGs (and diff images) before claiming a pass. A metric can be gamed; a
   picture is the sanity check.
5. Keep every capture under a run-specific name so before/after pairs survive for
   review.

Thresholds in the example are illustrative, not calibrated.

---

## 4. Traps (MEASURED)

- **The hidden pane runs at ~2 fps.** `frames()` will look like a slow scene. Use
  the driver for anything unattended.
- **Pane screenshots can lag the DOM by a frame or more**: one showed an overlay
  already unmounted. Prefer `image.*` (reads the presented canvas) or wait frames.
- **`Page.navigate` returns before the old document is gone.** The driver marks the
  old page so it can't run steps on it; keep that if you change `load()`.
- **Fresh saves start with intro comms and a text field** that eats keystrokes.
  `isolate()` plus the pre-set AI name cover it.
- **The `earth_horizon_8` view is rolled 90°** (horizon vertical in frame). It is the
  bench pose as authored. Account for it when choosing regions.

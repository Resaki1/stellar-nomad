# Audio System Plan — Stellar Nomad

**Status:** proposal, 2026-09-15. **Revised 2026-09-16** for the co-op-survival
direction change, the future cockpit/VR views, and the Suno-sourced music reality.
**Scope:** the whole audio subsystem, from `AudioContext` creation to the settings menu.

> ### Revision note — read this first
>
> The first draft of this document assumed a **narrative space sim**: a handful of
> one-shots, scripted comms beats, voiced dialogue, bar-quantised music. The author has
> since pivoted toward a **co-op survival game with emergent gameplay**, modelled on
> **Minecraft and Satisfactory**. That is a different *audio load class*, not a
> reskin, and it changed four things:
>
> | Was | Now | Why |
> |---|---|---|
> | Bar-quantised music crossfade | **Minecraft model**: long silence → weighted-random pick → fade in → play once → fade out (§7) | A *simplification*. It needs none of the BPM/loop/stem metadata the Suno tracks lack |
> | Voiced comms + TTS pipeline | **Non-verbal AI chirp only** (§6.7) | Scripted story dropped; all comms except the ship-AI messages are being scrapped |
> | Ship audio is flat 2D, permanently | Flat 2D is a **chase-mode optimisation**, behind a listener-mode seam (A2) | A cockpit view, WebXR, and possibly on-foot-inside-ship are all wanted eventually |
> | `playAudio()` for everything | **Emitter registry** for continuous sounds (A11) | A loop needs start/stop/move lifecycle that a fire-and-forget call cannot express |
>
> It also promoted one thing from nice-to-have to **design pillar**: in an emergent
> game, audio is the primary channel for state nothing else reports — a stalled
> machine, a browning-out power grid, a depleted seam. See §5.8.
>
> ### Scope walked back, 2026-09-16 (second pass)
>
> The 2026-09-16 first pass over-corrected. On learning the game was becoming a
> co-op survival builder, it assumed **Satisfactory-scale density** — "dozens to
> hundreds of continuously running machine loops" — and built a two-tier
> virtual-voice triage system plus cluster aggregation plus audio LOD on that
> assumption.
>
> The author then supplied the actual figure: **not dense.** "More like a space
> station with a few drones flying in and out and maybe a handful of space ships."
> That is on the order of **10–30 concurrent emitters against a 24-voice real pool** —
> so voice triage almost never fires, and clustering has nothing to cluster.
>
> | First pass said | Corrected |
> |---|---|
> | Virtual tier with playhead retention, in Phase 0 | **Deferred.** Speculative at this density (§5.3a) |
> | Cluster aggregation (§5.3b) | **Dropped.** Trigger condition recorded instead |
> | Audio LOD composite beds (§5.3c) | **Dropped.** Same |
> | Gate EA-4 "emergent-load gate" | **Demoted** to a sanity check |
> | A11 is "the single load-bearing change" | **Overstated.** The registry is still right, for a simpler reason |
>
> What survived, and is now *better* justified: **cull hysteresis** (a drone flying
> in and out of range is precisely the threshold-flicker case), and the **emitter
> registry** as the API shape for continuous sounds — true at any count above one.
>
> Meanwhile the *other* two seams got cheaper to justify, not more expensive: A2's
> listener-mode seam and §5.6's `localOffsetM` now serve **three** future consumers
> (cockpit view, WebXR, on-foot inside a ship) rather than two. Those two remain in
> Phase 0. The triage machinery does not.
**Decision:** build a **thin, hand-rolled engine directly on native Web Audio**
(`src/audio/`), with a typed semantic **event catalogue**, a fixed **voice pool**, a
**bus graph**, and an **audio tick decoupled from `useFrame`**. No Howler, no Tone.js,
no Wwise/FMOD web runtime, and **not** `THREE.Audio` / `THREE.PositionalAudio` /
drei's `<PositionalAudio>`.

**Content decision:** **sourced samples first, synthesis second.** The one exception
is warning/alarm tones, which are plain `OscillatorNode` from day one — cheaper to
build than to source, and more authentic to real spacecraft alerting.

**Ordering answer:** the bare minimum is almost entirely *architecture*, not content.
Every sound added later depends on the context/bus/voice/catalogue skeleton being
right once. Phase 0 + 1 below is the floor; it is small, and it is load-bearing.

**Multiplayer / VR answer:** almost nothing needs building now. Three small seams
(A2's listener pose, A11's emitter registry, §5.6's `localOffsetM`) cost an afternoon
today and prevent a rewrite later. Everything else — WebXR, voice chat, networked
emitters — is genuinely deferrable. A13 says exactly where the line is.

---

## 1. What exists today

### 1.1 Audio

**Nothing.** Verified: zero references to `AudioContext`, `new Audio`, `Howler`,
`PositionalAudio` or `AudioListener` anywhere in `src/`. This is a greenfield
subsystem with no migration burden and no legacy to respect.

⚠ **`STORY.md` is now partly stale.** It describes a three-act narrative (ESA, Dr.
Stern, Elara, the cryo-bay twist). The author is moving toward co-op survival with
emergent gameplay.

**Decided 2026-09-16: all comms messages are being scrapped except the ship-AI ones.**
So [`src/data/commsMessages.ts`](../src/data/commsMessages.ts) shrinks to the AI's
messages, and the Dr. Stern / Elara / ESA-bulletin speakers go. For audio this means:

- The comms *system* survives and stays the AI's delivery mechanism, so the `comms`
  mix snapshot (§5.5) keeps a real consumer and music ducking still has something to
  duck under.
- There is exactly **one speaker**, so per-speaker audio identity is a non-problem —
  one chirp family, not a set (§6.7).
- The `voice` bus and its slider are **removed** (§5.2): text + chirp needs no voice
  bus, and a dead slider is cruft.
- Subtitles become moot (§8.6).

The comms system also remains an excellent architectural precedent (§1.2) regardless
of how little content it ends up carrying.

One piece of prior art exists and should be **superseded deliberately, not ignored**:
[`docs/UI_STYLE_GUIDE.md`](UI_STYLE_GUIDE.md) §6 already declares a `SoundChannel`
union (`click.soft`, `click.hard`, `hover.tick`, `notify.info`, `notify.warn`,
`notify.crit`, `stinger.story`, `ui.transit`) with the instruction "define sound
channels in code now… the plumbing must not [wait]". That instinct was right. Its
shape is not: it conflates *category* (which bus) with *event* (what happened), and it
covers only UI. §5.6 below replaces it with an event catalogue whose UI subset maps
1:1 onto those eight names, so the style guide's vocabulary survives.

### 1.2 Adjacent precedents this plan reuses

The repo already solved several of the hard problems for other subsystems. Audio
should look like a sibling of these, not like a new invention.

| Precedent | Where | What audio takes from it |
|---|---|---|
| Comms system | [`src/store/comms.ts`](../src/store/comms.ts), [`src/data/commsMessages.ts`](../src/data/commsMessages.ts), [`GameCommsTriggers.tsx`](../src/components/Comms/GameCommsTriggers.tsx) | Typed catalogue + **centralised trigger component** + signal-atom indirection + played-registry persistence |
| Item/research catalogue | [`src/data/content.ts`](../src/data/content.ts) | Flat `Def[]` array + derived lookup `Map` + `getX()` helpers — the right shape for many id-addressed entries |
| Perf harness | [`src/components/space/perf/benchRunner.ts`](../src/components/space/perf/benchRunner.ts), [`docs/PERF_MEASUREMENT.md`](PERF_MEASUREMENT.md) | `window.__bench`-style scripted scenario harness, `lastJson`, singleton getter |
| Live readout HUD | [`src/components/HUD/PerfHUD/`](../src/components/HUD/PerfHUD/) | ref + `setInterval` + `textContent` (no React re-render per sample) |
| Console harnesses | [`src/components/DevTools.tsx`](../src/components/DevTools.tsx) | `window.__dev` / `__bench` / `__lum` installation, gated to dev |
| Deferred asset load | [`src/hooks/useDeferredKTX2.ts`](../src/hooks/useDeferredKTX2.ts) | Keeping a heavy decode off the startup critical path |
| Asset conversion script | [`scripts/convert-to-ktx2.sh`](../scripts/convert-to-ktx2.sh) | A committed, documented, batch-capable asset preprocessing script |
| Keybind merge wrapper | [`src/store/keybinds.ts`](../src/store/keybinds.ts) | The *correct* `atomWithStorage` pattern — merges defaults instead of replacing (see T1) |

### 1.3 Ready-made signals audio can consume today

These already exist and need **no new gameplay plumbing**:

| Signal | Where | Audio use |
|---|---|---|
| `exhaustIntensity` (smoothed 0..1 thrust) | [`Spaceship.tsx:111`](../src/components/Spaceship.tsx:111) | **The engine RTPC.** Already smoothed, already a ref, already feeds `EngineExhaust` |
| `spawnVFXEventAtom` (`"mined"` / `"collision"`, world position in metres, `radiusM`, `impactDirection`, `loot`) | [`vfx.ts:47`](../src/store/vfx.ts:47) | Impact + mining-complete world emitters, with position and size for free |
| `asteroidMinedSignalAtom` | [`mining.ts:127`](../src/store/mining.ts:127) | Mining-complete stinger |
| `itemCraftedSignalAtom`, `lastCompletedResearchIdAtom` | `modules.ts`, `research.ts` | Progression stingers |
| `dieAtom` | [`death.ts:53`](../src/store/death.ts:53) | Death sequence |
| `miningStateAtom` (`laserHeat`, `isOverheated`, `isMining`, `miningProgress`, `isFocused`) | [`mining.ts`](../src/store/mining.ts) | Laser RTPCs + overheat alarm |
| `transitStateAtom` + `transitDriveBuffer` | [`transit.ts`](../src/store/transit.ts) | Spool / accel / decel / arrival, and the only real velocity vector in the game |
| `shipHealthAtom` | [`store.ts`](../src/store/store.ts) | Damage, low-hull alarm |
| `addToastAtom` | [`toast.ts:20`](../src/store/toast.ts:20) | A single choke point covering 7 notification call sites |
| `Panel.tsx` | [`HUD/Shell/Panel.tsx`](../src/components/HUD/Shell/Panel.tsx) | One shell = one hook for every modal open/close |

---

## 2. Measured platform baseline

Measured 2026-09-15 on the target class of machine (Chrome 152 / macOS,
`hardwareConcurrency` 10, `deviceMemory` 16 GB), **run in the real game page** at the
dev server — not in a synthetic harness. Per house rules, nothing below is eye-balled.

### 2.1 Platform

| Quantity | Measured | Consequence |
|---|---|---|
| `ctx.sampleRate` | **44100 in one context, 48000 in another, same machine** | ⚠ **DEVICE-DEPENDENT, NOT A PLATFORM FACT.** An earlier revision of this table asserted "44100, not 48000" from a single reading; a later run on the same machine reported 48000. It follows the output device. Never assume either — `decodeAudioData` resamples to whatever the context is |
| `ctx.baseLatency` | **5.80 ms** @44.1 k (exactly 256/44100), **5.33 ms** @48 k (256/48000) | A 256-frame buffer either way. Well inside the ~20 ms threshold where players notice lateness — scheduling latency is ours to lose, not the platform's |
| `ctx.outputLatency` | **0 in one context, 32 ms in another** | Also device-dependent, and 0 means "not reported" rather than "zero". Do not build compensation on it |
| `destination.maxChannelCount` | 2 | Stereo. No surround path to design for |
| `AudioWorklet` | present, quantum 128 | Available when we want it (Phase 4+) |
| `panner.panningModel` default | `equalpower` | The cheap one is already the default |
| `panner.distanceModel` default | `inverse` | Irrelevant — we do not use the native distance model (A3) |
| `listener.positionX` | is an `AudioParam` | Modern API: the listener can be *ramped*, not snapped |

### 2.2 Costs

| Operation | Measured | Consequence |
|---|---|---|
| `OfflineAudioContext`, 5 s stereo @48 k, 4 nodes | **19.6 ms → ~255× faster than real time** | Offline assertion tests are effectively free. This is the backbone of §10.2 |
| Full one-shot voice (`bufferSource`+`gain`+`panner`+3 params+connects) | **24.6 µs** | 24 voices = 0.59 ms if all spawned in one frame. Pooling matters; creation is not catastrophic |
| `bufferSource`+`gain` only | 8.1 µs | The pooled path |
| HRTF panner construct | 31.2 µs | Don't construct these per voice |
| `AnalyserNode.getFloatTimeDomainData(2048)` | **2.4 µs** | Live metering in the dev HUD is free |
| `decodeAudioData`, 3 s mono 16-bit WAV | 6.3 ms | Must not happen on first trigger (see T6) |
| `AudioBuffer` RAM | **517 KiB per 3 s mono** = 172 KiB/s mono, 344 KiB/s stereo | A 3-minute stereo track is **~62 MB resident**. Music must stream (A7) |

### 2.3 M1 — AudioParam write cost scales with the pending event list

Measured: cost of `setTargetAtTime` on one param, as a function of how many events
are already queued on it.

| Queued events | Cost per call |
|---|---|
| 0 | **1.40 µs** |
| 1,000 | 2.40 µs |
| 5,000 | 4.40 µs |
| 10,000 | 10.00 µs |
| 20,000 | **17.60 µs** (12.6× the clean cost) |
| 40,000 | 1.60 µs — *the backlog had been pruned by the audio clock* |

`cancelScheduledValues()` immediately followed by `setTargetAtTime` measured
**0.40 µs**.

The growth is self-limiting: events in the past are discarded as the audio clock
passes them, which is why the 40,000 row collapses back to the floor. But a writer
that schedules into the future faster than the clock consumes grows the list without
bound, and every write on that param gets more expensive.

> **Rule: cancel-then-schedule on any param written repeatedly, and write at ≤ 30 Hz.**
> With a clean list all the automation forms are equivalent (`value=` 10.44,
> `setTargetAtTime` 11.07, `setValueAtTime` 9.95, `linearRamp` 8.52 µs *measured with a
> fat list*; ~1.4 µs clean).

⚠ An earlier run of this measurement recorded `.value=` at 33 µs/call and concluded
direct assignment was 3× worse than scheduling. **That was a confound** — 20,000
events left queued on the param by the preceding test. The corrected numbers are
above. Re-measure with a fresh context per variant; the event list is shared state.

### 2.4 M2 — HRTF is 3.4× equalpower

| Load | equalpower | HRTF | Ratio |
|---|---|---|---|
| 16 voices, 2 s offline | 7.9 ms | 25.7 ms | 3.3× |
| 64 voices, 2 s offline | 29.1 ms | 98.2 ms | **3.4×** |

64 HRTF voices = 98.2 ms of CPU per 2 s of audio = **4.9% of one core** in real time;
64 equalpower voices = 1.5%. Both are affordable. This **overturns the common
"HRTF is too expensive" framing** for our voice counts — but see A4 for why we still
default to equalpower.

### 2.5 M3 — the real mix can be captured to a file

`MediaStreamAudioDestinationNode` → `MediaRecorder(audio/webm;codecs=opus)`:
a 600 ms capture produced an **8,024-byte blob**, and decoding it back gave 0.48 s,
**peak 0.307** against an expected 0.3 (a 0.3-gain 880 Hz sine), rms 0.210.

`MediaRecorder.isTypeSupported`: `audio/webm;codecs=opus` **true**, `audio/mp4`
**true**, `audio/ogg;codecs=opus` false.

**This is the answer to "can you verify audio before I listen to it".** An agent can
drive the running game, capture its actual output, decode the PCM, and assert on it.
See §10.3.

### 2.6 Codec support (`canPlayType`)

`opus` in Ogg **probably** · `opus` in WebM **probably** · `mp4a.40.2` probably ·
`mpeg` probably · `vorbis` probably · `flac` probably · `aac` probably · `wav` maybe.

Opus is available in both containers. Ship Opus; no fallback bundle is needed for
desktop Chrome/Firefox/Safari 17+. Re-check before shipping if older Safari matters.

---

## 3. Design philosophy — what "high quality" actually means here

Three claims, in priority order. Everything in §5 serves them.

**3.1 Restraint beats fidelity.** What separates a AAA mix from an amateur one is
mostly *consistency and headroom*, not sample quality: one loudness target, per-
category loudness bands, a hard ceiling on the single loudest sound, and long
stretches where very little plays. A game that is quiet 80% of the time and loud
*once* feels expensive. A game that is loud constantly feels cheap regardless of how
good each sample is. This matches [`UI_STYLE_GUIDE.md`](UI_STYLE_GUIDE.md) §1 exactly:
"95% of the screen at any moment is either the game world or empty space" — audio
should obey the same ratio.

**3.2 The realism question is not "is there sound in space".** It is *"what does a
pilot inside a hull hear"*, and the honest answer is: a great deal. Structure-borne
vibration through the frame, RCS thumps, gimbal whine, pumps, coolant, ventilation,
electrical hum, micrometeorite pings. Every credible reference — Elite Dangerous's
"every sound is generated by the ship", Hardspace: Shipbreaker's contact-transmission
model, The Expanse — resolves vacuum silence the same way: **the ship is the
instrument, and you are inside it.** That framing is both physically defensible and
better for gameplay feedback than silence. It is also exactly this project's
established voice ("the ship is a third character", style guide §2.1).

**3.3 Silence is a designed state, not an absence.** *Stellar Nomad* is a game about
isolation ([`STORY.md`](../STORY.md) §1: "extreme isolation… the weight of physics").
Music should be **rare**, and therefore land. Subnautica, Outer Wilds, Elite and
Kerbal all default to no music and are loved for it. Default state = silence; music is
an event.

### 3.4 What players will hate

Ranked by how cheap they are to avoid. Each maps to a requirement below.

| Complaint | Requirement |
|---|---|
| A volume slider that doesn't gate everything | **Every** sound routes through the bus graph. No stray `new Audio()`. Ever (T5) |
| Audio keeps blaring after alt-tab | Mute-on-blur, default ON (§8.2) |
| The alarm is unbearable | Per-bus peak ceiling on alerts, independent of master (§8.3) |
| The same sound over and over | 3–5 variants + pitch/volume jitter on high-frequency one-shots (§6.4) |
| Sound arrives late, feels cheap | Schedule from the input event, never from a React re-render (T4) |
| No feedback for an action I took | Action-coverage audit as a named gate (§11, Gate EA-1) |
| Music louder than the thing warning me | Music defaults *below* SFX (§8.1) |
| Volume slider does nothing until 80% | dB-linear (perceptual) slider curve, not linear gain (§8.1) |

---

## 4. Architecture — invariants

These are the decisions that are expensive to change later. Each is numbered so a
future session can cite or overturn one explicitly.

### A1 — One module-scope engine singleton, not a React resource

The `AudioContext`, bus graph and voice pool live in a module-level singleton in
`src/audio/engine.ts`, created lazily and **never torn down**. Not in a
`useEffect`, not in a context provider, not keyed to the Canvas lifecycle.

Three independent reasons, all verified in this repo:
- `frameloop="never"` ([`Scene.tsx:228`](../src/components/Scene/Scene.tsx:228)) hard-stops
  every `useFrame` when the settings menu opens. An engine owned by the render tree
  would stutter or restart when the player opens settings.
- React dev double-invocation is live in this codebase — two dev pages already carry
  `startedRef` guards with "guard double-invoke in dev" comments
  ([`src/app/dev/mip3d-test/page.tsx`](../src/app/dev/mip3d-test/page.tsx),
  [`src/app/dev/cloud-volume-gpu/page.tsx`](../src/app/dev/cloud-volume-gpu/page.tsx)).
  An `AudioContext` in a mount effect would be created twice.
- Web Audio does not exist during SSR. Module *scope* must not touch `window`;
  construction happens on first use, inside a browser-only code path.

### A2 — Two emitter tiers, behind a listener-mode seam

**This resolves a real mismatch.** Every "diegetic cockpit" reference assumes a
first-person cockpit view. *Stellar Nomad's camera is a chase camera*: a fixed local
offset plus a **speed-dependent standoff** (`_offset.add(_fwd.multiplyScalar(speed.current * 0.75 + 1))`)
plus procedural shake, all applied directly to `camera.position` / `camera.quaternion`
([`Spaceship.tsx:517-523`](../src/components/Spaceship.tsx:517)). The player watches
the ship from outside. Naively attaching ship sounds to a listener at the camera would
make the engine quieter as you accelerate — exactly backwards.

The fix costs nothing because it is a *routing* rule, not geometry:

| Tier | Examples | Routing |
|---|---|---|
| **Ship-diegetic** | engine, RCS, mining laser, alarms, UI, AI chirp, hull creaks, coolant | In chase mode: **never panned, never distance-attenuated.** Straight to their bus at full gain. Diegetically you are aboard the ship wherever the camera floats |
| **World emitter** | asteroid impacts, debris, flybys, machines, other players later, POI beacons | Panned + attenuated, fed camera-relative metres |

Say this out loud in code, because it will look like a bug to a future reader: the
engine sound does *not* get quieter as the camera pulls back.

> ⚠ **Flat-2D ship audio is a chase-mode OPTIMISATION, not a permanent law.** A2's own
> justification — "the camera is not the pilot" — is precisely the condition that stops
> holding the day a cockpit view exists, where the camera *is* the pilot's head. A
> future session must not read this rule as fundamental.

**The seam (build now, ~20 lines, changes nothing observable):**

```ts
type ListenerMode = 'chase' | 'cockpit' | 'xr'
// src/audio/spatial.ts
function getAudioListenerPose(): { positionM: Vec3; quat: Quat }
```

Today only the `chase` branch exists and it returns identity — a no-op. This is the
single place `cockpit` and `xr` get added later, instead of retrofitting every call
site that has independently baked in "camera-relative" maths.

| Mode | Listener | Ship-tier sounds | Panning |
|---|---|---|---|
| `chase` (today) | identity; ship at origin | flat 2D, unpanned | `equalpower` |
| `cockpit` (later) | pilot head in ship-local space | **positioned** via `localOffsetM` | `equalpower` |
| `xr` (later) | `XRViewerPose`, updated **every compositor frame** | positioned | **HRTF forced** |

Three notes for whoever builds `xr`, so the reasoning isn't lost:

- **XR listener updates must bypass A5's 15 Hz tick** and write `listener.positionX/Y/Z`
  + `forwardX/Y/Z` + `upX/Y/Z` by direct `.value =` assignment every XR frame (90–120 Hz),
  with **no ramp**. Audio lagging real head rotation is exactly what makes VR audio
  nauseating — the opposite of the smoothing A5 correctly mandates for RTPCs. This is
  the same escape hatch A5 already grants `transitDriveBuffer`, applied once more.
  Read the pose from `camera.matrixWorld` (three's `WebXRManager` keeps it current) —
  don't hand-roll `XRFrame.getViewerPose()`.
- **HRTF becomes mandatory in XR**, not optional: true head rotation needs elevation
  and front/back cues that `equalpower` does not model at all. A4's cap-don't-globalise
  design already anticipates this. M2 measured the cost as affordable.
- **Head-locked audio is the central VR pitfall.** Non-spatialised sound that doesn't
  move with head rotation reads as "stuck inside your skull". UI and music legitimately
  stay head-locked even in VR; ship systems must not.

**What NOT to build:** no panner wiring for ship-tier sounds today; and when XR does
come, **not** Omnitone or the Resonance Audio Web SDK (the latter is formally archived,
the former's maintenance status is an open question), and **not** Steam Audio (no
official browser/WASM build exists). Chrome's built-in `PannerNode` HRTF is the only
web-viable path and it needs no dependency. Ambisonic beds are not worth it; a handful
of discrete positioned drones captures most of the win.

**Left open deliberately:** whether the ship-AI chirp is head-locked ("inner voice") or
anchored to a cockpit speaker. Both are precedented. It depends on the AI's in-fiction
framing, which is being re-decided right now — so don't encode an answer.

**A fourth mode may eventually exist: on-foot.** The author has floated on-foot
exploration on planets and moons, and possibly on foot *inside* ships — far future,
and explicitly may not happen. No work now. But it is worth noting that it needs
**nothing beyond the two seams already listed**, because on-foot-inside-a-ship is
mechanically the same problem as a cockpit view: a listener with real position and
orientation inside the ship's local frame, with ship systems as positioned emitters.
`getAudioListenerPose()` gains a branch; `localOffsetM` gets filled in.

That is the payoff argument for those two seams: they are ~20 lines and an optional
field, and they serve **three** prospective consumers (cockpit, WebXR, on-foot).
Contrast §5.3a, where the machinery sized for a *hypothetical* density was cut.
Cheap seams that serve several futures are worth taking; speculative machinery is not.

On-foot would bring genuinely new *content* categories — footsteps by surface, suit
and helmet layers, breathing, interior room tone, EVA-vs-pressurised transitions — but
those are asset and tuning work on top of an unchanged architecture, which is exactly
where you want the cost to fall.

### A3 — Spatialisation is hand-computed in camera-relative metres; the native distance model is not used

`localScene` is already 1 unit = 1 metre, and the ship is pinned to local `(0,0,0)`
every frame ([`Spaceship.tsx:506`](../src/components/Spaceship.tsx:506)). World-emitter
positions are therefore *already* near-camera metres. Feed
`panner.positionX/Y/Z` from those directly.

Do **not** use `PannerNode`'s `inverse`/`exponential` distance model: `refDistance`
and `maxDistance` are single scalars, and no single curve is sane across a game whose
distances span ~1 m to ~1e9 m. Compute gain ourselves from **log-distance bands**, and
let the panner do panning only.

Do **not** spatialise against `scaledScene` coordinates — they are compressed units,
not metres.

> ✅ **The floating origin is a non-problem, but the reason is not the obvious one.**
> [`worldOrigin.tsx`](../src/sim/worldOrigin.tsx) defines `RECENTER_THRESHOLD_KM = 10_000`
> and a `maybeRecenter()` — **which is dead code, never called anywhere in `src/`.**
> The actual rebase happens *every frame* in
> [`Spaceship.tsx:503-505`](../src/components/Spaceship.tsx:503), which continuously
> re-anchors local space on the ship. So local positions never jump, and panner
> positions never pop. Verify this explicitly rather than trusting it (§10 lists it as
> a test), and do not "fix" the dead threshold code without re-checking audio.

### A4 — equalpower by default; HRTF capped, not global

M2 measured HRTF at 3.4× equalpower — affordable, but it buys imaging only for
*close* sources, and most world emitters are not close. Default `equalpower`
everywhere. A "Headphones" output mode applies HRTF to the **nearest N active
positional voices only** (start N = 4, tunable), falling back to equalpower beyond.
Pick N from `__audio.stress()`, not by feel.

### A5 — The audio tick is not `useFrame`

A dedicated `setInterval` at **~15 Hz** (66 ms) in `src/audio/tick.ts` reads refs and
pushes `AudioParam` targets. `AudioParam` ramps do the actual smoothing on the audio
thread.

Why not `useFrame`: it stops dead under `frameloop="never"`, and M1 says per-frame
param writes are the expensive pattern anyway. Why 15 Hz: at 24 voices × ~4 params,
15 Hz is ~1,440 writes/s ≈ **2 ms/s of main thread** at the clean-list cost — noise.
At 120 Hz it would be ~16 ms/s and growing, because a per-frame writer is exactly the
event-list-growth case M1 measured.

**Music scheduling is separate and must also not be on `useFrame`** — see A8.

Exception: anything that must be frame-exact (world-emitter *positions* for fast
flybys) may read positions inside an existing `useFrame` and write to a plain buffer
that the tick consumes — the `transitDriveBuffer` pattern.

### A6 — Real time, never sim time

[`simRateAtom`](../src/store/simTime.ts) scales *celestial ephemeris* time only, up to
1e5. It does **not** scale the ship's fixed-step physics. At 1e5, planets whirl but
the ship flies normally.

**No audio is ever driven by sim time.** Not pitch, not rate, not LFOs. A time warp
must not make the engine scream. This is a one-line rule that prevents a whole class of
bug; write it in the engine header.

### A7 — SFX in memory, music streamed

From §2.2: `AudioBuffer` is decoded f32 PCM at 344 KiB/s stereo, so a 3-minute track is
**~62 MB resident**, and 8–12 tracks would be 500 MB+. Therefore:

- **SFX / loops / UI:** `decodeAudioData` into `AudioBuffer`, pre-decoded in tiers.
- **Music:** `HTMLAudioElement` → `MediaElementAudioSourceNode`, fetched on demand.

### A8 — Music is a timer and two gain ramps, not a scheduler

**Superseded 2026-09-16, and this is the good kind of supersession: the work
disappeared.** The first draft specified a ~25 ms lookahead scheduler with ~100 ms
schedule-ahead (the standard "two clocks" pattern), because bar-quantised transitions
need sample-accurate scheduling.

The Minecraft model (§7.1) quantises nothing. So the music director is a randomised
silence timer, a weighted-random pick, and a linear gain ramp at each end. No
lookahead, no beat grid, no scheduler.

What survives from the original invariant is only the part that was never about music
theory: **the timer must not be `useFrame`**, because `frameloop="never"` would stop
music dead when the settings menu opens. A plain `setInterval` is sufficient — the
track itself is a streamed `MediaElementAudioSourceNode` whose playback the audio
thread owns regardless.

### A9 — Settings live in their own store module

New `src/store/audio.ts` with its own `atomWithStorage`, mirroring how `comms.ts`
sits apart from `store.ts`. [`SettingsMenu.tsx`](../src/components/HUD/SettingsMenu/SettingsMenu.tsx)
is already ~1300 lines and `settingsAtom` already carries nine graphics keys; do not
grow it further. See T1 for the trap this must handle either way.

### A10 — Game code fires semantic event IDs, never filenames

`playAudio('mining.laser.start')`, never `play('laser_01.opus')`. This is what makes
variants, re-mapping, per-event caps and the contract tests in §10.1 possible at all.

It is also, for free, the correct **network** vocabulary: multiplayer sends
`{eventId, position, params, tick}`, never audio. See A13.

### A11 — Emitter registry for continuous sounds

**A loop is not a long one-shot.** `playAudio('impact')` is fire-and-forget: it starts,
it ends, nobody refers to it again. A drone's engine hum, a station's ventilation, a
mining laser — these need **start, stop, move, and change-parameter** over a lifetime
measured in minutes. A fire-and-forget call cannot express that, and bolting lifecycle
onto it produces a second, worse API.

So continuous sounds use a registry:

```ts
const h = registerEmitter({ event: 'station.vent.loop', positionM });
h.setPosition(p);  h.setParam('load', 0.4);  h.stop();
```

This is justified at **any** emitter count above one, which is why it stays in Phase 0
even after the density correction. It is not justified by voice triage.

**What the registry owns today:**
- lifecycle (the above)
- **cull hysteresis** — separate enter/exit thresholds for holding a real voice.
  ⚠ This matters *specifically* for the stated scenario: a drone flying in and out of
  range is exactly the case where a single threshold makes a voice chatter on and off.
  One line; do not skip it.
- position feeding into A3's gain bands at the A5 tick

**What it does not own yet:** see §5.3a.

> ⚠ **The first pass of this revision called A11 "the single load-bearing change" and
> "expensive to retrofit". That was overstated** — it was sized for a Satisfactory-scale
> base that isn't the design. The registry is still the right shape; the *reason* is
> loop lifecycle, not triage, and the retrofit cost is an afternoon, not a rewrite.

### A12 — One shared alert primitive, not five bespoke alarms

Every survival stat (oxygen, fuel, power, heat, hull) needs the same shape: escalation
tiers, a non-repeating reminder cooldown, and player acknowledge/snooze. Build it
**once** as `escalatingAlert(stat, tiers)` and wire each stat in as an instance.

The failure mode is documented and shipped: Subnautica's low-oxygen warning plays one
fixed voice line identically every trigger, and players wrote mods specifically to
replace it with a progressive cue tied to the actual value. Five independently-written
alarms become five independently-annoying alarms.

### A13 — Multiplayer: two seams, then stop

There is no multiplayer today. **Almost nothing needs building**, and over-preparing is
a real cost. But two decisions already made happen to be the right seams, and one
small habit is worth adopting now.

**Already correct, by luck:** A10's semantic event IDs *are* the wire vocabulary
(`{eventId, position, params, tick}` — never PCM), and A3's hand-rolled distance/gain
is exactly what proximity voice chat will reuse later, fed from a
`MediaStreamAudioSourceNode` instead of a decoded buffer. Native Web Audio doppler was
removed from the spec years ago, so hand-rolling it was always required — remote-emitter
doppler is one more small function beside the gain-band code, not a subsystem.

**Worth doing now (free):** classify each event as `predicted` or `confirmed` at
authoring time (§5.6). A predicted sound that the server later contradicts — a
mining-complete sting for an asteroid that wasn't mined — needs an explicit
release-envelope path, and A11's registry already provides it: tell the voice to fade
and let it be stolen normally. No new mechanism.

**Defer entirely, with notes so the research isn't repeated:**

- **Remote emitters** ride the existing 15 Hz tick — a near-perfect match for 10–30 Hz
  network rates — with two-sample interpolation and a stale-timeout fade.
- **Ambience stays client-derived from the seed**, never networked.
- **Scaling:** with N players each running machines, §5.3's culling/virtualisation/
  clustering stop being optional. A11 is what makes that survivable.
- **Voice chat:** LiveKit (Apache-2.0, self-hostable, free tier covers early access)
  over hand-rolled mediasoup — it removes the whole signalling + TURN build. A P2P mesh
  is fine up to roughly **6–8 audio participants** and breaks past that; for 2–6 player
  co-op a mesh may be enough.
- ⚠ **Two gotchas that will cost a day each if rediscovered.** (1) A remote WebRTC
  `MediaStream` routed *only* through Web Audio can go silent or bleed in Chrome — you
  also need a hidden, muted `<audio>` element with `srcObject` set to the same stream,
  purely to keep Chrome's pipeline pumping. (2) `getUserMedia`'s default
  `autoGainControl` fights your own gain staging on the voice bus; request
  `autoGainControl: false` explicitly. Echo cancellation also degrades when loud game
  audio shares the output device.
- **Ducking under voice** is universally shipped as VAD-gated automatic sidechain
  attenuation, not a static setting.

---

## 5. Architecture — components

### 5.1 Module layout

```
src/audio/
  engine.ts          A1 singleton: AudioContext, bus graph, unlock, master limiter
  buses.ts           bus definitions + snapshot application
  voices.ts          real-voice pool: priority, stealing, per-event caps + cooldowns
  emitters.ts        A11 registry: real/virtual tiers, playhead retention, hysteresis
  clusters.ts        §5.3 aggregation + audio LOD  (Phase 3)
  spatial.ts         A3 log-distance bands, panner feed, clamped doppler,
                     A2 getAudioListenerPose()
  tick.ts            A5 15 Hz RTPC/snapshot pusher (cancel-then-schedule, M1)
  rtpc.ts            named continuous parameters + their smoothing
  alerts.ts          A12 shared escalating-alert primitive
  music/
    director.ts      A8 silence timer, weighted pick, fade in/out (no scheduler)
  loader.ts          tiered preload, decode, cache, A7 stream path
  alarms.ts          OscillatorNode alert tones (§6.3)
  worklets/          (Phase 4+) DSP processors
src/data/
  audioEvents.ts     A10 catalogue
  musicTracks.ts     {id, file, mood, durationSec, weight} — that is all (§7.1)
src/components/Audio/
  GameAudioTriggers.tsx   the ONE place gameplay events become sounds
  AudioDevTools.tsx       window.__audio (dev only)
  AudioHUD/               live readout, PerfHUD-shaped
```

### 5.2 Bus graph

```
                                  ┌─ music ──────────┐
                                  ├─ ambience ───────┤
destination ← limiter ← master ←  ├─ sfx-ship ───────┤
                                  ├─ sfx-world ──────┤
                                  └─ ui ─────────────┘
                                         ↑
                              alerts ────┘  (own ceiling, §8.3)
```

- Each bus is a `GainNode`, optionally + one `BiquadFilterNode` for muffling.
- `limiter` is a `DynamicsCompressorNode` as a soft brickwall — insurance against
  a simultaneous-impact blowout, independent of the voice cap.
- `alerts` is a *sub-bus of sfx-ship* with its own gain ceiling so a full-volume
  alarm can never exceed a sane peak no matter where the master sits.

> **The `voice` bus was removed, 2026-09-16.** With all comms except the ship-AI
> messages scrapped and those delivered as text + chirp (§6.7), nothing would route
> to it — and a settings slider with no consumer is user-visible cruft, not
> future-proofing. The **AI chirp goes to `ui`**: it is a short interface sound, which
> is what it functionally is.
>
> Voice chat (A13) will want this bus back. Adding a `GainNode` and a slider at that
> point is trivial; shipping a dead slider until then is not free.

### 5.3 The real-voice pool

Pre-create **24** `{GainNode, PannerNode}` chains, wired once. Per trigger, create
only a fresh `AudioBufferSourceNode` (they are single-use — unavoidable) and attach.
Measured cost 8.1 µs pooled vs 24.6 µs unpooled (§2.2).

**24 is deliberately the low end** of every estimate, and it is a guess until measured.
Raising it requires `__audio.stress(n)` evidence under a genuinely GPU-busy scenario —
the same discipline [`PERF_MEASUREMENT.md`](PERF_MEASUREMENT.md) imposes on GPU passes.
Do not raise it by feel.

**Two independent limits are both required:**
- Global: on overflow, steal lowest priority → then farthest → then oldest.
- Per event: `maxInstances` + `cooldownMs` in the catalogue. Without this, one noisy
  event starves the whole budget (T3 is exactly this case).

**Priority ladder** (borrowed from Factorio, and free to adopt): player/UI above
ship systems, ship systems above world one-shots, world one-shots above ambient
loops. A drone hum should never steal a hull alarm.

At the density this game is actually targeting, overflow should be rare — see §5.3a.

### 5.3a Density: what is NOT being built, and when to revisit

**Measured against the actual design, not a genre assumption.** The author's stated
target is a space station with a few drones flying in and out and a handful of ships —
call it **10–30 concurrent emitters**, against a **24-voice real pool**. At that ratio
almost every emitter simply *has* a real voice, and the triage machinery has nothing
to do.

So three things are deliberately **not** in the plan, each with the condition that
would bring it back:

| Not building | Revisit when |
|---|---|
| **Virtual tier** (ranking, promotion/demotion, playhead retention) | Concurrent emitters routinely exceed the real-voice cap. Until then a stolen loop is a non-event, because nothing gets stolen |
| **Cluster aggregation** (same-type emitters merged at a centroid) | A single scene holds more than ~2× the cap in *same-type* emitters — e.g. a drone swarm, or if the builder scope grows |
| **Audio LOD** (many loops → one composite bed) | Same trigger as clustering, plus a view distance where individual emitters stop being localisable |

Keep the numbers in mind rather than the machinery: if `__audio.voices()` starts
reporting sustained pressure at the cap during normal play, this table is the plan.

> ⚠⚠ **Recorded because it will bite whoever eventually builds aggregation, and it is
> the opposite of what you would assume.**
>
> For *N* genuinely **incoherent** sources, level rises by `10·log10(N)` — N=10 is
> **+10 dB**. That is the number people quote. But a naive implementation that spawns
> N voices of **the same buffer at the same start time** produces *identical, in-phase*
> signals, which sum **coherently** like voltage: N=10 is **+20 dB**. Ten decibels
> hotter than intended, and a real clipping risk.
>
> Worse, the master limiter will *hide* it — masking a broken mix decision rather than
> correcting it. Two valid fixes: randomise per-instance start offset so decorrelation
> actually holds, or (better) past a small cluster size **stop summing real voices at
> all** and play one pre-mixed aggregate asset.
>
> This applies at N=3 too, so it is relevant even at the current density: **three
> identical drones are +9.5 dB, not +4.8 dB**, if they share a buffer and a start time.
> Randomising start offset per drone is the cheap fix and should be the default for any
> multi-instance loop.

**Keep the log-distance bands (A3), but understand their scope.** They answer "how loud
is *one* emitter at distance D". They say nothing about instance count. Two separate
problems; only the first is solved, and at this density the second may never need to be.

**Prior art, if density ever does grow.** Factorio's Friday Facts #341 and #396 document
this regime with real numbers: simultaneous-sound cap raised **15 → 50**; a per-type
instance cap tried and **removed** in favour of a per-entity "audible distance modifier"
because the type-cap broke looping pump sounds (partial loops playing with no fluid
flowing); playback rate and volume matched to machine *activity rate*; per-animation-frame
"sound accents" riding the main loop; and under load, player/GUI prioritised over
ambient, ambient over enemies. That last is a ready-made priority ladder and is worth
adopting now regardless of density — it costs nothing.

> ⚠ **Fix voice count, not information.** Should pressure ever arrive, the temptation is
> to mute or cull emitters. That throws away exactly the diegetic information §5.8
> argues is the biggest opportunity here. Aggregate instead: the goal is **fewer voices,
> not less information**.

### 5.4 RTPCs

Continuous game values mapped to audio params, pushed at 15 Hz by A5.

| RTPC | Source | Drives |
|---|---|---|
| `throttle` | `exhaustIntensity` ref ([`Spaceship.tsx:111`](../src/components/Spaceship.tsx:111)) | Engine loop blend, RCS level |
| `speed` | `hudInfoAtom.speed` (scalar m/s) | Aero noise, engine layer bias |
| `laserHeat` | `miningStateAtom.laserHeat` | Laser timbre + overheat alarm proximity |
| `hullIntegrity` | `shipHealthAtom` | Damage hum, low-hull alarm gate |
| `transitPhase` / `spoolProgress` | `transitStateAtom`, `transitDriveBuffer` | Spool pitch sweep, drive drone |
| `altitudeKm`, `atmoDensity` | `frameGates` — **needs a new accessor**, see T7 | Aero noise, wind, muffling |
| `dangerLevel` | derived, smoothed | Music intensity |

⚠ There is **no velocity vector** anywhere for normal flight — only the scalar
`hudInfoAtom.speed`. Doppler and directional aero need a new per-frame mutable buffer
mirroring `transitDriveBuffer`. Adding it is cheap; *assuming it exists* is the trap.

### 5.5 Mix snapshots

Named partial overrides `{busId: {gain?, lowpassHz?}}` blended with
`linearRampToValueAtTime`:

| Snapshot | Trigger | Effect |
|---|---|---|
| `default` | — | Unity |
| `paused` | `settingsIsOpenAtom` | Duck everything, keep music at a floor |
| `comms` | active comms message | Music −8 dB, ambience −6 dB |
| `transit` | `TransitPhase` ≠ idle | Muffle `sfx-world`, raise drive |
| `atmosphere` | `altitudeKm` inside the shell | Wind bed in, slight `sfx-world` lowpass |
| `critical` | hull < 25% | Alerts up, music down |
| `background` | tab hidden | Master → floor (§8.2) |

### 5.6 Event catalogue

`src/data/audioEvents.ts`, shaped like [`content.ts`](../src/data/content.ts) (flat
array + derived `Map` + `getAudioEvent(id)`), **not** like `commsMessages.ts`'s
`Record` — audio events are addressed by id from many scattered call sites, exactly
like items, and the array shape's filter/iterate helpers are the ones actually needed.

```ts
type AudioEventDef = {
  id: AudioEventId;            // 'mining.laser.start'
  bus: BusId;
  tier: 'ship' | 'world' | 'ui';   // A2 routing
  variants: string[];          // round-robin, 'avoid last 2'
  priority: number;
  maxInstances: number;
  cooldownMs: number;
  loop?: boolean;
  pitchJitterCents?: number;   // ±20..50 typical
  gainJitterDb?: number;       // ±1..2 typical
  preloadTier: 0 | 1 | 2;

  /**
   * Position in SHIP-LOCAL metres for ship-tier events. Unset (the default) = today's
   * flat-2D chase-mode behaviour. Filled in only when a cockpit view exists (A2), at
   * which point it is pure content tuning — coolant pump behind-left, master caution
   * front-centre, engine aft. Declared now so that is not a schema migration touching
   * all ~46 entries.
   */
  localOffsetM?: [number, number, number];

  /**
   * Multiplayer (A13). 'predicted' fires locally and immediately, and must be
   * fadeable if the server disagrees; 'confirmed' waits for the server. Unset =
   * 'predicted'. Costs nothing today; classifying at authoring time is far easier
   * than auditing 46 events later.
   */
  netClass?: 'predicted' | 'confirmed';

  /** Cluster key for §5.3 aggregation. Unset = never aggregated. */
  clusterKey?: string;
};
```

The UI subset carries the style guide's eight §6 names as its ids, so
`ui.click.soft` etc. remain the vocabulary.

### 5.7 The trigger layer

**All** gameplay→audio wiring lives in `src/components/Audio/GameAudioTriggers.tsx`,
mirroring `GameCommsTriggers.tsx`. Gameplay components set signal atoms or write
buffers; they do not call the audio engine.

**But the playback path is imperative, not React.** Comms enqueues through a jotai
atom because it fires a handful of times per session. Audio fires hundreds of times a
minute. `GameAudioTriggers` *watches* atoms and *calls* `playAudio()` directly — jotai
is used only for slow, UI-facing state (current track name, volumes, mute).

Four choke points cover a disproportionate share of all events:
`spawnVFXEventAtom` ([`vfx.ts:47`](../src/store/vfx.ts:47)),
`addToastAtom` ([`toast.ts:20`](../src/store/toast.ts:20)),
`dieAtom` ([`death.ts:53`](../src/store/death.ts:53)),
and the shared `Panel.tsx` modal shell. Wire those four first.

### 5.8 Audio as an information channel — the design pillar

**In an emergent game this is the biggest audio opportunity, and it is not a polish
item.** A narrative game can put a cutscene in front of you. A factory game cannot: the
player built the situation, and nothing but audio is going to tell them that something
three rooms away has stopped working.

The patterns, all cheap once A11's registry exists:

| Pattern | Example | How |
|---|---|---|
| **Rate/pitch as load** | a smelter running at 40% | playback rate + gain track the machine's activity rate |
| **A "wrong" variant** | belt backed up, seam depleted | a second loop for the fault state, crossfaded in |
| **Spatialised fault** | *which* machine broke | the alert emits from the machine, so you can walk toward it |
| **Silence as signal** | power browned out | a loop *stopping* is information. Don't fill the gap |
| **Accents on top of a loop** | mechanical character | short one-shots keyed to animation frames, riding the loop (Factorio's foundry has twelve) |

Two consequences worth stating plainly:

- **Silence-as-signal only works if the baseline is not noisy.** This is the same
  argument as §3.1 and §3.3, arriving from a different direction: a mix that is busy
  all the time cannot use a stop as a cue.
- **A machine loop is not decoration, so a perf fix that culls it is a regression**,
  even when the frame time improves. See the warning at the end of §5.3.

### 5.9 Building and placement feedback

Disproportionately important in a builder, and cheap. The place → connect → confirm
loop is performed hundreds of times an hour, so it *is* the game's texture. It needs
crisp transients, at least 3 variants (§6.4), and a clear distinction between
"placed", "connected", and "rejected". T15 notes that rejection currently has nowhere
to attach — fix that when building is built.

---

## 6. Content

### 6.1 The synthesise-vs-sample decision rule

Synthesise when the sound is **(a)** simple, periodic and tonal by nature — which is
what the real hardware is anyway; **(b)** driven by a continuous sim parameter with no
natural discrete states; or **(c)** needed in unbounded variation.

Sample everything that needs to sound **expensive**: broadband, transient, physical.
Impacts, debris, metal, hull, mechanical actuation.

Synthesis loses to recordings on broadband/transient realism per engineering-hour, and
has done for two decades of "are we there yet?" GDC talks. That is not an argument
against synthesis — it is an argument for *where*.

| Sound | Verdict |
|---|---|
| Alarms, warnings, cautions | **Synthesise** (§6.3) — and this is the *authentic* choice |
| UI blips, confirms, ticks | Synthesise or sample; sample is faster |
| Mining laser drone | Sample base + synthesised modulation layer (heat) |
| Engine / RCS / transit drive | **Sampled loops, blended** (§6.5) |
| Impacts, debris, hull, docking | **Sample.** Non-negotiable |
| Hull creak, coolant, electrical hum | Synthesise (cheap, endless variation) |
| Ambience beds | Sample (incl. real plasma-wave sonification, §6.6) |
| AI chirp | **Sample** — 2-3 short authored files, no voice (§6.7) |

### 6.2 MVP asset list — ~46 files

Counted, so "source audio" is a finishable checklist rather than an open-ended task.

| Group | Events | Variants | Files |
|---|---|---|---|
| Mining | laser start, laser loop, laser stop, asteroid destroyed, loot | 3 (start/destroyed), 1 (loop/stop/loot) | 11 |
| Impact / damage | hull impact minor, hull impact major, damage taken | 3 | 9 |
| Transit | spool, engage, drive loop, decel, arrive | 1 | 5 |
| Engine | idle, low, mid, high thrust loops | 1 | 4 |
| Progression | craft complete, research complete, module equip | 1 | 3 |
| UI | click soft, click hard, hover tick, notify info, notify warn, panel open/close | 1 | 7 |
| Comms | message arrive chirp, page advance, dismiss | 1 | 3 |
| Death | destruction, death-screen bed | 1 | 2 |
| Alarms | overheat, low hull, cargo full, critical | **0 — synthesised** | 0 |
| Ambience | cockpit hum, deep-space bed | 1 | 2 |
| **Total** | | | **~46** |

Music is separate: the author's own tracks.

### 6.3 Alarms are oscillators, and that is the realistic choice

Real spacecraft alerting uses simple multi-tone patterns, and distinguishes severity
by **pulse pattern**, not only pitch. Build these from `OscillatorNode` directly — no
worklet, a handful of nodes:

- fundamental 400–700 Hz, plus 1–2 harmonics
- advisory: single slow beep · caution: dual-tone fast repeat · critical: continuous warble
- routed to the `alerts` sub-bus with its own ceiling (§8.3)

This is cheaper to build than to source, more authentic, infinitely tweakable, and
costs zero download.

### 6.4 Variation

Any sound heard more than twice needs variation. For the two highest-frequency events
(mining laser hit, hull impact): **3 variants minimum**, an "avoid last 2" rule,
±20–50 cents pitch jitter, ±1–2 dB gain jitter. Cheap upfront, impossible to retrofit
once the mix is tuned.

### 6.5 Engine loops

3–5 pre-rendered loop layers (idle/low/mid/high, plus on-load vs off-load for
transit accel/decel) crossfaded by `GainNode` ramps driven by the `throttle` RTPC.

⚠ The classic bug: if each layer is not tuned to a **shared pitch curve**, crossfade
points beat and phase audibly. Author the layers against one reference pitch.

Granular scrubbing of a single loop is a genuine upgrade (endless variation from one
source) but adds worklet complexity and its own artefacts. **Post-launch**, on top of
a working blended baseline — not a parallel MVP path.

### 6.6 Sourcing and licensing

| Source | Licence | Use |
|---|---|---|
| **Sonniss GDC bundles** | Commercial, no attribution (⚠ verify current terms at download — see L2) | Bulk: engine hums, impacts, electrical, metal |
| **Kenney.nl** | CC0 | UI clicks, confirms, sci-fi blips |
| **Own contact-mic recordings** | Ours | Hull, coolant, mechanical. Household motors, fridges, HVAC, servos, metal + pitch-down/convolution/resonators is how much real sci-fi design is made |
| **Freesound** | ⚠ **per-sound**: CC0 / CC-BY / **CC-BY-NC** | CC0 and CC-BY only. **NC is not shippable** |
| **NASA / U. Iowa plasma-wave** | Generally uncopyrighted (⚠ L5) | Ambience beds — thematically perfect |
| **BBC Sound Effects (free tier)** | ⚠ **RemArc: research/education/personal only** | **Not shippable.** Named here so nobody assumes otherwise |
| Boom Library Sci-Fi | Paid (~$50–240) | Early-access spend once the pipeline is proven |

**Start a `CREDITS.md` with the first CC-BY download, not the fiftieth.** Attribution
is impossible to reconstruct retroactively.

⚠ Subscription libraries (Epidemic/Artlist-style) are typically perpetual only for
what was published *while subscribed*. A continuously-redeployed browser game is
arguably republishing on every deploy. Avoid them for shipped assets.

### 6.7 The AI chirp — no voice, and that is the right call

**Decided: a non-verbal chirp plus on-screen text. No TTS, no VO.** The scripted-story
direction is being dropped, so a dialogue VO pipeline would be built for content that
may not survive.

This is not a compromise. Three independent reasons it is actively better:

- The AI is **player-named** (`aiNameAtom`), so its name can never be spoken aloud —
  full VO is structurally awkward no matter the budget.
- A chirp convention **ages better than mediocre VO**, and several well-regarded sci-fi
  games choose it deliberately.
- It costs 2–3 short files instead of a pipeline, and it never needs re-recording when
  the writing changes.

Give the chirp real character — it is signature sound #3 (§11.1), the AI's voice-print,
and it will be heard thousands of times. Distinct chirps for *arriving*, *advancing*,
and *urgent* are worth having.

Deliberately unresolved: whether the chirp is head-locked or cockpit-anchored in a
future cockpit/VR view (A2).

### 6.8 Asset pipeline

A committed script, following [`convert-to-ktx2.sh`](../scripts/convert-to-ktx2.sh)'s
precedent: `scripts/process-audio.sh`.

1. **Force mono** for anything spatialised. ⚠ Feeding a *stereo* file into a
   `PannerNode` silently upmixes stereo→stereo and smears the directional cue. It
   does not error. It just sounds vaguely wrong forever.
2. **Two-pass ffmpeg `loudnorm`** to `I=-16:TP=-1.5:LRA=11` **per asset**.
3. Trim + short fades to kill edge clicks.
4. Encode **Opus** 48–96 kbps (SFX) / 128–192 kbps (music).
5. Output under `public/audio/{sfx3d,sfx2d,ambience,voice,music}/`.

> **Two loudness numbers, two different stages — do not apply either twice.**
> **−16 LUFS** integrated is the *per-asset* normalisation target, applied in step 2
> before a file enters the manifest.
> **−18 to −20 LUFS** integrated is the *master bus* target after all buses mix,
> leaving headroom under the limiter for simultaneous alarms and impacts.

**Download budget:** ≤ 15–25 MB for all SFX/UI/ambience combined. Music **streams per
track on demand** and is not bundled. Initial page load adds ~0 MB of audio beyond a
couple of tiny Tier-0 UI sounds.

---

## 7. Music

### 7.1 Model — the Minecraft scheduler, and why it deletes most of the work

```
silence timer (randomised, e.g. 5–15 min)
  → weighted-random pick from the mood-tagged pool
  → linear fade in (2–4 s)
  → play the file start to finish, ONCE
  → linear fade out
  → back to the silence timer
```

That is the whole system. It never reads a beat position, never crossfades bar-to-bar,
and **never loops a buffer**.

> ### 🔑 This is why the missing metadata stopped mattering
>
> The first draft assumed bar-quantised crossfading, which needs **BPM, a bar grid and
> loop points** — precisely the metadata the Suno tracks lack and that the author said
> he has no way to author. Under a play-once-with-fades director, the per-track schema
> collapses to:
>
> ```ts
> // src/data/musicTracks.ts
> { id, file, mood, durationSec, weight }
> ```
>
> **`durationSec` comes from `ffprobe`. `mood` and `weight` are typed by hand in a
> minute. Loudness is baked in offline. There is no third thing.**
>
> This is a *simplification*, not a deferral — and the risk runs the other way: building
> BPM/loop tooling now would be solo-dev time spent on a system the direction has moved
> away from. Skip it entirely.

Minecraft's own numbers are worth citing carefully: it runs at 20 ticks/s, picks
weighted-random from a per-context pool, and plays ambient tracks **once to completion
then falls silent** for a randomised delay commonly documented as ~10–20 minutes.
⚠ The exact current-version delay and whether the classic scheduler crossfades or
hard-cuts are **not** verified (L9, L10) — treat "short linear fade, a few seconds,
long randomised gap" as a design target, not a spec to replicate.

Jukebox discs *do* loop in Minecraft, but that is a separate diegetic system — don't
conflate the two when reading sources.

### 7.2 Silence is the default state

The director starts with **nothing playing**, and most of the time nothing requests
anything. Deep space with only the engine humming is the *point*: it is what makes the
occasional track land, and it is what sells vastness. Cooldowns ensure quiet returns
and stays.

### 7.3 Mood selection, with hysteresis

A small enum (calm / explore / tension / danger) chosen in `GameMusicTriggers` from
smoothed existing signals, selecting *which pool* the next pick comes from.

⚠ Without **hysteresis + asymmetric minimum dwell + cooldown** this produces "music
seasickness": `laserHeat` oscillating near the overheat line, or health crossing a
threshold, flips the mood audibly. Escalate fast, de-escalate slowly. Note the
play-once model is far more forgiving here than crossfading would have been — a mood
change only affects the *next* pick, not the track currently playing.

### 7.4 Suno: licensing first, then a mechanical checklist

> ⚠⚠ **L1 — CHECK THIS BEFORE ANY OTHER MUSIC WORK.** Suno's commercial-use rights
> attach to **the plan active when a track was generated**, not the plan active when you
> ship. Free-tier generations are personal/non-commercial **even if you upgrade later** —
> upgrading is *not* retroactive. Pro/Premier generations keep their commercial rights
> **even after you cancel**, because the right attaches to the creation date.
>
> So: for every track, check its generation date against your subscription history.
> Any track made on the free tier or during a lapse must be re-generated under a paid
> plan or dropped. This is the one step no amount of audio processing can fix, and
> verifying it before investing in the pipeline is the whole reason it is listed first.
> Verify against Suno's current terms — see L2.

Then, assuming the play-once design, this is the entire pipeline. None of it requires a
music background; it is file conversion and command-line work.

1. **Licence check** (above). Blocking.
2. **Export the highest quality Suno offers** (WAV if your plan allows) — don't
   re-encode an already-lossy MP3 further down the chain.
3. **Tag mood by ear**, into the manifest. *The only step that needs a human*, and it
   needs taste, not expertise.
4. **Duration:**
   ```bash
   ffprobe -v quiet -show_entries format=duration -of csv=p=0 track.wav
   ```
5. **Loudness-normalise the whole batch**, same target for every file (§6.8's two-pass
   `loudnorm`, `linear=true` for music so it applies one constant gain rather than
   dynamically compressing).
6. **Trim leading/trailing digital silence, apply a 2–4 s fade in/out.** Fixed
   duration, not beat-aligned.
7. **Skip BPM detection and loop-point authoring entirely.**
8. **Encode to Opus** 128–160 kbps VBR.
9. **Load as a streamed source** (A7), never `decodeAudioData` — a 3-minute track is
   ~62 MB resident.

**If you ever do want a looping bed** (menu, hangar): treat it as a *separate asset
category*, not a retrofit of the pack. Suno tracks are usually **structurally
unloopable** — composed intro, faded outro — so head-to-tail looping bumps audibly even
when tempo happens to line up. Two options: run `pymusiclooper` to search for a
high-confidence interior loop (best-effort; it may find nothing), or just prompt Suno
for *"ambient bed, no build-up, no fade-out, static texture throughout"*, which loops
far more reliably than a structured song. The second is easier and better.

**If you ever want stem layering:** try **Suno's own Advanced Split** before reaching
for Demucs. It *regenerates* stems from the model rather than deconvolving a finished
mix, so it isn't limited by mix bleed. Demucs (`pip install -U demucs`,
`demucs -n htdemucs track.wav`, ~1.5× real time on CPU) works, but separating an
AI-generated mixdown is inherently lossier than the demos you'll see — those use real
multitrack-mixed source material. Either way: not needed now.

**Tools you asked about, for completeness** — BPM detection is `aubio tempo`,
`librosa.beat.beat_track`, Essentia's `RhythmExtractor2013`, or Sonic Visualiser's
visual beat grid (the most trustworthy for imperfect AI material, since a human
confirms it). All of them assume a metrically regular tempo and all are prone to
octave errors (reporting half or double). Suno v5 reportedly introduces deliberate
micro-timing drift, which makes automatic detection worse. **You need none of this** —
it is recorded here only so a future session doesn't re-research it.

### 7.5 Loudness

⚠ Tracks generated across different Suno sessions and prompts **will not** sit at the
same LUFS even at similar peaks. Under a weighted-random picker this is *more* audible
than it would be in an authored sequence, because the player hears arbitrary
adjacencies. An unnormalised calm→action pick reads as a volume bug, not as dynamics.
This is the one piece of real audio processing the play-once model genuinely needs.

### 7.6 Ducking

Duck under the AI chirp and under critical alerts (§5.5 `comms` snapshot). Do not add a
second trigger surface — all triggers stay centralised.

### 7.7 MediaSession

Wire `navigator.mediaSession.metadata` (title/composer) and play/pause handlers once
streaming exists. A dozen lines; prevents a stray media key doing something confusing
mid-flight, and shows the author's own track titles in the OS.

---

## 8. Player-facing settings

New `SubMenu.Audio`, **unconditional** (not `IS_DEV`-gated — see T2). Reuse the
existing `.dev-controls__label` / `.dev-controls__range` slider markup already used by
the Graphics submenu's brightness and glare sliders (the class prefix is misleading but
it *is* the established convention — worth a note so a reviewer doesn't read it as a
scoping mistake).

### 8.1 Volume

Five sliders: **Master, Music, SFX, UI, Ambience.** (No Voice slider — §5.2.)

**Defaults: Master 0.8, SFX 0.9, UI 0.7, Ambience 0.7, Music 0.55.**
Music sits deliberately below SFX. The pull to put the author's own tracks at unity is
real and must be resisted — it buries the alarms, the comms and the mining feedback,
which is the opposite of an instrument panel.

⚠ **Slider curve must be perceptual, not linear.** `gain = t` concentrates almost all
perceived change in the top 20–30% of travel — the "does nothing until 80%" complaint.
Use `dB = 40·log10(t)` (i.e. `gain = t²`) or an explicit −60 dB..0 dB map, with
`t = 0` → hard zero.

⚠ **Never assign `gain.value` on a slider drag** — it snaps and clicks. Use
`setTargetAtTime(g, ctx.currentTime, 0.015)`, and per M1 **cancel first**.

### 8.2 On blur — three states, defaulting to *duck*

`Mute / **Duck** (default) / Keep playing`, via the Page Visibility API, ramping over
150–300 ms rather than hard-cutting.

**Duck, not mute, is the right default specifically because this is a co-op survival
game.** You will alt-tab to a wiki or a call while your base keeps running and
teammates keep playing. A hard mute means you miss a hull-breach or power-failure cue
that the game is actively trying to tell you about; blaring at full volume into a call
is the complaint that made mute-on-blur a requirement in the first place. Ducking to
roughly **−25 dB** resolves both: alerts stay faintly present, nothing blares.

A boolean cannot express that, which is why this is three states and not two.

⚠ Web Audio's clock keeps running when a tab is backgrounded, unlike rAF — so
backgrounding does **not** pause audio for free. You must do this explicitly.

### 8.3 Alert ceiling

The `alerts` sub-bus gets its own peak ceiling independent of master, so a full-volume
alarm can never exceed a sane level relative to the rest of the mix. This directly
targets "the alarm is unbearable", which is a complaint about *relative* level, not
about master volume.

### 8.4 Night mode

One toggle engaging a `DynamicsCompressorNode` on master (start from threshold −24 dB,
knee 30, ratio 12:1, attack 3 ms, release 250 ms; tune toward ratio 16–20:1). A game
with ~100 dB of intended dynamic range is unlistenable on laptop speakers without it —
and laptop speakers are the stated target hardware.

### 8.5 Output mode

Stereo (default) / Headphones (HRTF, capped per A4) / **Mono**. Mono downmix is a
genuine accessibility feature for single-sided deafness and one-earbud listening, and
costs one `ChannelMerger` stage.

### 8.6 Accessibility

- **Subtitles are moot, and that is a genuine accessibility win rather than a gap.**
  With no voiced content anywhere (§6.7), `CommsOverlay`'s text panel *is* the content,
  not a transcript of it. Nothing is conveyed by speech that a deaf player would miss.
  Re-open this only if voiced content ever appears.
- **Captions for non-speech cues** — this is where the real work is, and it matters
  more than usual here, because §5.8 deliberately routes *gameplay state* through
  audio. Every audio-only signal (a drone fault, a depleted seam, a power brownout)
  needs a visual counterpart or it is inaccessible by design. Reuse `ToastDisplay`'s
  HUD slot: icon + short label ("⚠ Laser overheating") driven by the *same* signal as
  the sound.
- **Every audio cue needs a visual counterpart.** Audit against existing HUD state and
  attach audio as a *second consumer* of an existing signal, not as a parallel system:
  `laserHeat`→MiningHUD flash, `shipHealthAtom`→DamageVignette, etc. Mostly already
  true; the discipline is to keep it true.

### 8.7 Sub-bass warning

⚠ "Scale and awe" designs that lean on deep LFO rumble will be **inaudible** on the
M2 Pro laptop speakers that are the stated target. Any awe cue needs a parallel
mid/high-frequency component or a psychoacoustic substitute.

---

## 9. Dev tooling

Three surfaces, all following existing precedent.

### 9.1 `window.__audio` — console harness

Installed from `src/components/Audio/AudioDevTools.tsx`, dev-gated, sibling to
`__dev` / `__bench` / `__lum`.

```
__audio.voices()            active + virtual voice table: id, bus, tier, priority,
                            distance, gain, real/virtual
__audio.busLevels()         per-bus gain + live peak/RMS (AnalyserNode — 2.4 µs, free)
__audio.play(id)            fire any catalogued event by id
__audio.stress(n)           fire n simultaneous voices at random world positions
__audio.soak(n)             n randomised triggers over time; report voice leak
__audio.setRTPC(name, v)    force an RTPC value
__audio.snapshot(name)      force a mix snapshot
__audio.solo(busId) / mute(busId)
__audio.state()             ctx.state, sampleRate, baseLatency, loaded/failed assets,
                            decode times, current music state + next transition
__audio.lastJson            copyable report, exactly like __bench.lastJson
```

### 9.2 `AudioHUD` — live in-game readout

`PerfHUD`-shaped: ref + `setInterval` + `textContent`, **no React re-render per
sample**. Mounted next to `{perfHudOn && <PerfHUD />}` in `HUD.tsx`, behind a new
dev setting. Shows voice count vs cap, per-bus meters, current snapshot, current music
state, and a rolling log of the last ~10 audio events.

### 9.3 `/dev/audio` page

Follows the existing `src/app/dev/*/page.tsx` convention: a trigger palette (every
catalogued event as a button), bus faders, RTPC sliders, snapshot buttons, and a
waveform/spectrum view of the master bus. Best surface for auditioning assets without
flying the ship there.

⚠ Note the existing `/dev/*` pages carry **no** environment gating and are reachable
in production (verified across all five). That is the accepted convention, but it
differs from how `DevTools.tsx` and the Settings→Dev submenu *are* gated. Decide
deliberately for audio.

### 9.4 A mute keybind

[`keybinds.ts`](../src/store/keybinds.ts) already has a migration-safe merge wrapper
(unlike `settingsAtom`), so adding a mute action is a trivial, trap-free addition.

---

## 10. Automated verification — what I can check without your ears

This is the answer to "is there a way for you to test stuff automatically before
letting me test them". **Yes, in three tiers**, and tier 3 is stronger than expected.

### 10.1 Tier 1 — contract tests (no audio at all, instant, CI-safe)

Pure static checks over the manifest and source. These catch the majority of *real*
bugs and need no `AudioContext`:

- every event id referenced in `src/` exists in the catalogue (and vice versa — no orphans)
- every file referenced by the catalogue exists on disk
- every `tier: 'world'` asset is **mono** (the silent stereo-panner smear, §6.8)
- every asset within its size/duration budget; total bundle under the §6.8 ceiling
- every looping asset has loop points; every id unique; every bus id valid
- every `maxInstances` ≥ 1 and `cooldownMs` sane
- **no sound path bypasses the bus graph** — grep for `new Audio(`, `.connect(ctx.destination)`
  outside `engine.ts`. This is the §3.4 top complaint, enforced mechanically.

⚠ A contract test only catches what the schema encodes. The schema **is** the gate;
design it deliberately.

### 10.2 Tier 2 — `OfflineAudioContext` assertions

Measured at **~255× real time** (§2.2), so a scenario suite is effectively free.
Render a graph deterministically and assert on the PCM:

- peak, RMS, DC offset, duration, channel count
- silence at edges; fade-in/out envelope correctness
- **click/discontinuity detection** via sample-to-sample delta
- **ducking actually ducked**: render music + a scripted comms trigger through the real
  bus chain, assert the music bus RMS drops by the configured dB ±1
- **nothing clips**: render a voice-storm scenario, assert peak ≤ ceiling
- the volume-curve math at known points (t=0 → silence, t=1 → unity)

⚠ Threshold tuning matters: a naive "reject any delta above X" click detector
false-positives on intentional hard transients (impacts, weapon fire). Tune against a
corpus of known-good transients.

⚠ **Do not use exact hashes as golden files.** f32 DSP output differs across browser
versions, CPU FMA/denormal handling, and engine implementations. Assert on *statistics*
(peak/RMS/band energy), not `sha256(pcm)`.

⚠ LUFS is undefined on short clips (BS.1770 is a gated 400 ms-block measurement).
Use peak/RMS dB for one-shots; reserve LUFS for music beds.

### 10.3 Tier 3 — capture the real mix and assert on it

**Measured working (M3).** `MediaStreamAudioDestinationNode` → `MediaRecorder` →
decode → assert. This closes the loop on the real running game, not a synthetic graph.

The harness mirrors `__bench.sweep()`:

```
__audioBench.capture(scenarioId)   drive a scripted scenario in the real game,
                                   capture the master bus, return decoded stats
__audioBench.sweep()               the full scenario ladder → one JSON report
__audioBench.soak(n)               voice-leak / node-growth soak
```

Scenarios: start mining → overheat → take damage → trigger a comms message → engage
transit → arrive. For each: did *anything* play, at what peak/RMS, did the mix duck
when it should have, did the voice count stay under cap, did node count converge.

An agent can then run this, read the JSON, and fix a silent event or a clipped mix
*before* asking you to listen.

⚠ Headless Chrome needs `--autoplay-policy=no-user-gesture-required` (or a simulated
gesture) or the context stays suspended and every assertion reads garbage.

⚠ Assert leaks on **our own voice-pool bookkeeping**, not `performance.memory` — V8 GC
timing is non-deterministic and such a test flakes in both directions. Chrome's CDP
`WebAudio` domain (node created/destroyed events) is available as a ground-truth
cross-check if we want one.

### 10.4 What genuinely needs your ears

Be honest about the boundary. No automation can judge:

- whether a sound is **the right sound** for the thing (a correctly-registered,
  correctly-normalised, non-clipping asset can simply be wrong)
- timbre, character, "does this feel like a spaceship"
- whether the mix *balance* is pleasant, as opposed to numerically correct
- whether music transitions feel musical
- ear fatigue over a 40-minute session — the thing that matters most and is least testable
- whether a signature sound is memorable

So: automation guarantees **nothing is broken, silent, clipped, leaking, repeating or
unmuteable.** You judge whether it is *good*. That is the right split, and it means
your listening time goes to taste rather than to bug-hunting.

---

## 11. Phases and gates

Effort is relative, for a solo dev. Each gate is a thing that must be *true*, not a
thing that must be *done*.

### Phase 0 — Skeleton (no content)

The floor. Almost pure architecture.

- A1 engine singleton; unlock on first `pointerdown` anywhere (T8)
- §5.2 bus graph + master limiter
- §5.3 voice pool at 24, priority + stealing + per-event caps
- **A11 emitter registry** — lifecycle (start/stop/move/param) + **cull hysteresis**.
  No virtual tier, no clustering (§5.3a)
- A10 event catalogue with **placeholder** assets, including the `localOffsetM`,
  `netClass` and `clusterKey` fields (unset — declared so they aren't a later migration)
- **A2's `getAudioListenerPose()` seam**, `chase` branch only (~20 lines, a no-op today)
- A5 15 Hz tick, with the **cancel-then-schedule** convention from M1; A9 `src/store/audio.ts`
- §8.1 five sliders (dB-linear) + §8.2 three-state on-blur
- §10.1 Tier-1 contract tests
- `window.__audio` minimal: `state()`, `play(id)`, `voices()`

**Gate P0:** a placeholder click plays from a real bus, every slider gates it, mute-on-blur
works, contract tests pass, and `__audio.state()` reports a running context.
Nothing else may be built on a skeleton that cannot do this.

> ### ✅ Phase 0 landed and Gate P0 PASSED — 2026-09-16
>
> Verified in the running game at `localhost:3001`, by measurement rather than by
> listening. Reproduce with `__audio` (§9.1); the contract suite is
> `pnpm check:audio`.
>
> | Claim | How it was proven | Result |
> |---|---|---|
> | Signal reaches the output | `__audio.capture()` of the real master bus, against a silence baseline | baseline peak **0.0** (380-byte blob) → after `click.hard` peak **0.0082, −41.7 dB** (7,058 bytes) |
> | Slider curve is perceptual | Read bus gains against `t²` | master 0.8→**0.64**, sfx 0.9→**0.81**, ui/ambience 0.7→**0.49**, music 0.55→**0.303**. All exact |
> | Sliders actually gate | Drove the real `<input type=range>`, read the bus | music 0.25 → **0.063** (= 0.25²); master 0.4 → **0.16** |
> | dB readouts are honest | Compared UI labels to the gains | −3.9 / −1.8 / −6.2 / −6.2 / −10.4 dB, all correct |
> | On-blur duck (§8.2) | Read master while the tab was hidden | **0.036** measured vs **0.036** predicted (0.8² × 10^(−25/20)); returns to 0.64 when visible |
> | Tick survives `frameloop="never"` (A5) | Counted ticks for 1 s with the settings menu open | **15 ticks**, against a predicted 1000/66 = 15. The render loop was fully stopped |
> | Tick is cheap | `__audio.state().tick` over 1000 ticks | **avg 0.044 ms** |
> | Per-event cap (T3) | 10 synchronous `world.impact` triggers | **1 played, 9 refused.** Spaced 70 ms apart: `[2,3,4,null,null,5]` — 3 concurrent, then refusal, then recovery |
> | Cull hysteresis is asymmetric (A11) | At **2007 m** (audible 0.013, strictly between exit 0.008 and enter 0.02): an already-playing emitter vs a freshly-registered one | held voice = **true**, fresh voice = **false**. ⚠ The first attempt at this test targeted audible 0.04 — *above* the enter threshold — so it passed without discriminating. A degenerate metric; the numbers above are from the corrected test |
> | Emitter lifecycle | far → near → band → far → stop | 4000 m: no voice · 8 m: voice 7 · 2400 m: released · after `stop()`: **0 emitters, 0 voices** |
> | Unlock (T8) | `__audio.state().unlocked` before and after a real click | false → **true**; queued pre-unlock triggers flush |
> | Contract suite | `pnpm check:audio`, plus four deliberate falsification tests | **0 problems** (8 events, 10 files, 0.08 MB of 25 MB). Missing file, stereo-on-world-tier, `new Audio(`, and a typo'd id each fail it correctly |
> | Gates | `pnpm typecheck`, `pnpm lint` | tsc **0 errors**; eslint **0 errors** (130 pre-existing warnings, none in audio files) |
>
> **Not yet proven:** that any of it sounds good. The assets are synthesised
> placeholders whose only job was to prove the path. §10.4 stands.

### Phase 1 — Core loop feedback (MVP)

The point at which the game stops feeling broken.

- §6.2 asset pass: mining, impact, UI, progression, AI chirp, death (~46 files)
- §6.3 synthesised alarms + §8.3 alert ceiling + **A12's shared escalating-alert
  primitive**, with 1–2 stats wired as proof
- §6.8 `process-audio.sh` pipeline + `CREDITS.md`
- §6.5 engine loops on the `throttle` RTPC
- Transit spool/engage/decel/arrive
- §5.7 the four choke points wired
- **§5.9 build/place/connect/reject feedback**, as and when building exists — and T15's
  missing rejection branch
- §10.2 Tier-2 offline suite
- `AudioHUD`

> ### Phase 1 progress — 2026-09-16
>
> **The wiring half is done; the content half is not.**
>
> | Item | State |
> |---|---|
> | §5.7 four choke points wired | ✅ `vfxEventsAtom`, `addToastAtom`, `dieAtom`, the `Panel` shell |
> | §6.3 synthesised alarms | ✅ **finished, not placeholdered** (`alarms.ts`) — three tiers differing by PATTERN, measured audibly distinct: advisory rms 0.0013, caution 0.0028, critical 0.0070 |
> | A12 shared alert primitive | ✅ `alerts.ts`, hull wired as the proof stat |
> | §6.5 engine loop on the throttle RTPC | 🟡 one placeholder loop; RTPC verified (intensity 0.304 → gain 0.077 = −12 dB × 0.304). Not yet the 3–5 layer blend |
> | Transit spool/engage/decel/arrive | 🟡 wired to placeholders |
> | §6.2 real asset pass (~46 files) | ❌ placeholders only — **needs the author** (sourcing, licensing, taste) |
> | §6.8 `process-audio.sh` + `CREDITS.md` | ❌ |
> | §10.2 Tier-2 offline suite | ❌ |
> | `AudioHUD` | ❌ |
> | §5.9 build/place feedback | ⏸ blocked — no building system yet |
>
> **A12 verified by measurement:** escalation ladder none → advisory (0.4, 25 s gap)
> → caution (0.2, 9 s) → critical (0.05, 4 s); hysteresis holds `critical` when the
> value climbs 0.05 → 0.12 and only releases past `exitAbove` 0.16; acknowledge
> silences and re-arms after recovery.
>
> ⚠⚠ **A bug worth recording, because it was SILENT.** The first wiring called
> `updateAlert` only from a React effect on the stat's value. A player sitting at a
> steady 20% hull — value unchanged, so no effect, so no call — would have heard the
> first alarm and then **nothing, ever**. Reminder scheduling must be clock-driven:
> `pumpAlerts()` now runs on the A5 tick. Verified by holding a value static and
> watching the countdown re-arm on its own (3.2 → 0 → 3.2, twice in 11.2 s against a
> predicted 2 cycles at the 4 s critical gap).
>
> **Gate EA-2 has not been run.** The voice cap is still the unmeasured 24 (L8).

**Gate EA-1 — action-coverage audit:** enumerate every core-loop action from the
signal list in §1.3 and require each to have a wired sound. A silent action reads as a
bug even in early access. This is a named punch-list item, not a vibe.

**Gate EA-2:** `__audio.stress(24)` under a dense-asteroid `__bench` scenario shows no
frame-time regression beyond noise. Only then consider raising the voice cap.

### Phase 2 — Music (MVP+), now much smaller

- §7.1 Minecraft-model director: silence timer → weighted pick → fade → play once → fade
- §7.4 the Suno checklist, **licence check first**
- A7 streaming path; §7.5 batch loudness normalisation
- §7.6 ducking under chirp + alerts
- §7.7 MediaSession
- ~~A8 lookahead scheduler, bar-quantised crossfade~~ — **not needed.** Nothing
  quantises to a beat, so there is no scheduler to build (§7.1)

**Gate M-1:** no audible level jump between any two tracks under repeated random picks;
mood changes never interrupt a playing track.

### Phase 3 — Early-access polish

- §8.4 night mode; §8.5 mono + capped HRTF; §8.6 captions for every audio-only cue
  (subtitles are moot — no voiced content)
- A2 world-emitter spatialisation + log-distance bands
- Clamped manual doppler (needs the new velocity buffer, §5.4)
- T7 `frameGates` accessor → atmosphere/altitude RTPCs
- **§12.3 the propagation-physics block** — ISO 9613-1 air absorption, per-body
  speed of sound, `q = ½ρv²` wind/entry noise, density-scaled audibility. Depends
  on the T7 accessor, so it lands here rather than earlier. This is the
  "calibrate to reality" work, and it is propagation, not level (§12)
- **§5.8 the information-channel pass**: activity-rate loops, fault variants,
  spatialised faults, silence-as-signal — as drones/stations/building ship. At this
  density this is the highest-value work in the phase
- Randomised start offsets on multi-instance loops (the N=3 coherence case, §5.3a)
- §10.3 Tier-3 capture harness + soak
- `/dev/audio` page

**Gate EA-3:** Tier-3 sweep green across the scenario ladder; soak shows voice count
converging.

**Gate EA-4 — density sanity check.** `__audio.stress()` with the busiest realistic
scene (a station plus its drones plus a few ships), asserting: concurrent emitters stay
comfortably under the real-voice cap, no multi-instance loop is summing coherently, and
the master limiter is not quietly rescuing the mix. If emitters *do* press the cap,
§5.3a's table is the plan — but the expectation at the stated density is that this gate
is a formality.

### Phase 4 — Post-launch

- AudioWorklet DSP: laser drone, granular thruster
- Aux-send convolution reverb — **shared sends, never per-voice.** ⚠ Pull this forward
  to ship *with* the first cockpit view rather than waiting for the rest of Phase 4: an
  enclosed cabin with no early reflections reads as wrong, and that is the cue doing
  the work
- **Cockpit view:** A2's `cockpit` listener branch + filling in `localOffsetM`
- **WebXR:** A2's `xr` branch, HRTF forced, listener written every compositor frame
- Vertical stem layering — try **Suno's Advanced Split** before Demucs (§7.4)
- **Multiplayer audio** (A13): remote emitters on the 15 Hz tick, voice chat via
  LiveKit, proximity attenuation reusing the existing gain bands
- A real contact-transmission exterior/interior split, *if* EVA or a hull breach is
  ever added
- Asteroid-composition sonification — **only if** it is information-bearing. The style
  guide forbids decorative flourishes, and a mapping the player cannot read is exactly
  that

### Phase 5 — Cherry on top

Metered LUFS mix pass with documented per-category bands · FFT spectral-fingerprint
regression for signature sounds · CDP `WebAudio` leak assertions · true VAD-gated
sidechain ducking under voice chat · location-tied music pools off `frameGates` ·
ambisonic VR ambience (only if a maintained web decoder exists by then — see A2).

### 11.1 The 3–5 signature sounds

Pick these early and treat them as a **named, protected asset list**. A game needs a
few sounds that are instantly recognisable as *itself*.

1. The **transit-drive spool-up** — the game's "jump sound"
2. The **mining laser** — the most-heard sound in the game
3. The **AI chirp** — the AI's voice-print (§6.7)
4. The **hull-critical alarm**
5. The **acquire / craft / build confirmation** — see below

**On "but these vary with ship, engine and atmosphere":** a signature sound and a
variable sound are not in conflict. The pattern is **one invariant identity layer plus
parametric layers on top**. A lightsaber is always unmistakably a lightsaber while its
pitch tracks motion. So the transit spool keeps a fixed harmonic-sweep *motif* whose
rate and pitch scale with engine tier — the variation reinforces recognition rather
than diluting it. What you must not do is author a combinatorial sample library per
ship × tier × atmosphere; that is the actual trap, and parametrised layering is the
escape from it. Both #1 and the entry transition are transient one-shots, so neither
interacts with §5.3's many-loops problem.

**Atmospheric entry was dropped from this list, deliberately.** It is a *transition*,
not a sound: a mix snapshot moving over several seconds driven by density and velocity
(§5.5). It has no fixed transient to be recognisable by. It remains a signature
*moment* — it just isn't an asset.

**#5 replaced it because of the direction change, and it is the most important one on
the list.** In Minecraft and Satisfactory the iconic sounds are not set pieces — they
are the acquire/craft/build confirmations. The XP orb, the chest, the unlock jingle.
Those get heard thousands of times per session and become the game's actual voice, and
in an emergent game they are the primary reward signal. §5.9 is where it lives.

Build these from layered real recordings (the Ben Burtt method) rather than pure
synthesis, and protect them from casual revision.

---

## 12. Physical calibration — what to calibrate, and what not to

**Question (2026-09-16):** the lighting work calibrated everything to real
photometric values and then added an eye-modelled auto-exposure to compress ~14
orders of magnitude onto a display. Should audio get the same treatment —
absolute SPL per sound, plus an adaptive "auto-exposure for audio"?

**Decision: calibrate PROPAGATION, not LEVEL.** Half the analogy is excellent and
this game is unusually well placed to exploit it. The other half inverts, for a
reason that is measurable rather than aesthetic.

### 12.1 Why the level half inverts

Three independent arguments, any one of which would be sufficient.

**(a) The adaptation is in the wrong organ.** This is the crux, and it is
quantitative:

| | Eye | Ear |
|---|---|---|
| Total range | ~14 log₁₀ units | ~120–140 dB SPL ≈ 12–14 orders of magnitude in intensity |
| **Instantaneous** range at fixed adaptation | only **~3–4 log units** | basilar-membrane / outer-hair-cell compression alone squeezes **~100 dB into ~30–35 dB** — measured slope as low as **0.2 dB/dB (≈5:1)** |
| Where the rest comes from | **slow adaptive re-referencing**: pupil (~1.2–1.8 log units, 1–2 s), photopigment bleaching (cones ~10 min, rods ~20–45 min) | **small, slow, protective** top-ups: stapedius reflex ~15–20 dB (onset ~10 ms, full ~100–150 ms), loudness adaptation over tens of seconds |

So the eye covers *most* of its range by slowly re-referencing — which is exactly
what an exposure meter models. The ear covers *most* of its range with an
always-on, sub-millisecond mechanical compressor, and its slow mechanisms are a
minor, protective remainder. **An "auto-exposure for audio" models the eye's
strategy and applies it to an organ that does not use it.**

**(b) The artefact is predictable, not bad luck.** Intensity JND is ~1 dB, and as
low as ~0.25–0.4 dB at 1–4 kHz above 60 dB SPL. The ear is also acutely sensitive
to envelope modulation in the **0.1–2 s** band — precisely where a multi-second
leveler's release lives. That is why AGC on TVs and AV receivers is widely
disliked for "pumping" and "breathing" while auto-exposure reads as natural. It
is a psychoacoustic fact, not a convention. (Vision has no comparable sensitivity
to slow global luminance ramps, and on-screen exposure changes usually have a
visible diegetic cause.)

**(c) There is no fixed target at the listener's ear.** Auto-exposure works
because a display has a known transfer function — you tonemap to *nits*, and
Phase 6 even let the player calibrate headroom. Audio has no equivalent: the
player's OS volume, their transducer and their room noise floor are unknown and
vary by 40+ dB. **Absolute SPL is not deliverable at the output**, so calibrating
to it is a units conversion with extra steps.

Two supporting points worth recording:

- **The ground truth is fictional for most of our sources.** A star's luminosity
  is a published number; the sound power of a mining laser is not. The lighting
  calibration was falsifiable because it was anchored to *measurements of real
  objects*. Audio's anchors would be invented.
- **Nobody ships this.** Frostbite's HDR Audio is the canonical "loudness ≈
  real-world dB" system — and it reportedly **abandoned real SPL values in
  practice**, which is cited as the reason Wwise's own HDR feature adopted a
  *relative* volume scheme instead. The industry's actual absolute-SPL anchor
  (GANG/IESD's 79 / 84–85 / 76 dB SPL) calibrates the **mixing room**, i.e. the
  authoring side — the equivalent of calibrating a monitor's peak nits, not of
  tagging each asset with physical units.

> 🔑 **And note what we already decided.** §3.2 resolved the vacuum problem as
> "the ship is the instrument and you are inside it", because physically-correct
> audio for a ship in vacuum is *silence*. The lighting work succeeded precisely
> because physical correctness produced the desired image. In audio it produces
> nothing — so the physical anchor for level was abandoned out of necessity
> before this question was even asked.

### 12.2 We already have the exposure analogue

It is not missing; it is standard, and Phase 0 shipped it:

| Lighting | Audio equivalent | Status |
|---|---|---|
| cd/m² | dB SPL | n/a — not deliverable (12.1c) |
| Eye model (V(λ), scotopic, glare) | ISO 226 contours → phon → sone; **ITU-R BS.1770-5 K-weighting → LUFS** | Off-the-shelf standards. Phase 0's −16 LUFS per-asset / −18 to −20 LUFS master targets already use them |
| Auto-exposure meter | **The always-on limiter** — fast, static, ratio-based | Built (`engine.ts`). This *is* the basilar-membrane analogue |
| Display headroom calibration | Monitor calibration at a fixed SPL | An authoring practice, not runtime |

Two cheap refinements follow, and neither is a new system:

- **Tune the limiter deliberately** toward a ~3–5:1 ratio above the knee, echoing
  the measured ~5:1 basilar-membrane compression, instead of the current
  20:1 brickwall-only role. It is the right mechanism; it is currently only doing
  safety duty.
- **A real BS.1770 gated meter as a dev tool** (momentary 400 ms / short-term 3 s
  / integrated), in the spirit of the existing perf and `__lum` harnesses. That is
  the honest analogue of `__lum.units()`: a *measurement* surface, not a processor.

⚠ Do not confuse the two. LUFS is a **number describing finished content**, like
an exposure value. It is not a gain-riding process, and reaching for "more LUFS"
as a runtime mechanism is the category error this section exists to prevent.

### 12.3 What IS worth calibrating: propagation

**This is the genuinely exciting half, and the game is unusually well placed for
it — the inputs already exist.** `atmosphereData.ts` and `sol.json` carry per-body
composition, ground pressure and scale height; `frameGates` already computes local
altitude and the dominant body every frame. All of it was built for the
Rayleigh/Mie pass and is sitting there unused by audio.

| Win | Formula / standard | Effort | Payoff |
|---|---|---|---|
| **Frequency-dependent air absorption** on world emitters | **ISO 9613-1**: `A = α(f,T,p,composition)·r` dB, α = classical (~f²) + O₂ + N₂ relaxation terms | M | **high** |
| **Per-body speed of sound** → flash-to-bang delay, Doppler, sonic-boom trigger | `c = √(γRT/M)` | S | **high** |
| **q-driven wind / entry noise** | `q = ½ρv²`; turbulent dipole intensity ~V⁶ ⇒ **18.06 dB per doubling of V**, i.e. 9.03 dB per doubling of q | M | **high** |
| **Density-scaled world audibility** ("Mars is quiet") | radiated power scales with ambient ρ | S | **high** |
| **Continuous vacuum falloff** instead of a hard mute at altitude | monotonic in the existing per-frame density | S | medium |

**Measured anchors** (these make it falsifiable, which is the whole point):

- **ISO 9613-1 at 20 °C, 70% RH, 101.325 kPa:** 1 kHz **≈4.98 dB/km**, 4 kHz
  **≈23.1 dB/km**, 10 kHz **≈117.5 dB/km**, 20 kHz **≈420 dB/km**. The 4 kHz
  figure cross-checked against an independent ANSI/ASA table to 0.1 dB. This is
  the real basis for "distant things lose their highs" — a derived filter rather
  than a guessed lowpass.
- **Mars, measured in situ** (Maurice et al. 2022, *Nature*, "In situ recording of
  Mars soundscape"): speed of sound **≈240 m/s** for low frequencies and
  **≈250 m/s** above ~2 kHz, with the transition around **~240 Hz** — Mars has
  **two sound speeds**, which is a genuinely strange, real, renderable fact.
  Audible drop-off at **~8 m** versus Earth's ~65 m for a comparable sound, with
  high tones gone entirely by then.
- **Mars is ~20 dB quieter** overall (team statement). ⚠ **An earlier revision of
  this section put the density-coupling estimate at −21.9 dB from
  `10·log10(650 Pa / 101325 Pa)`. That is a PRESSURE ratio, and it is the wrong
  quantity** — radiated power couples to *density*, and Mars is much colder than
  Earth, so it is denser than its pressure ratio alone implies. Computed properly
  from `ρ = pM/(RT)`: **−18.9 dB**, i.e. 3 dB less severe than the shortcut
  suggested. Still in the same range as the team's "~20 dB" statement, which is
  the actual agreement worth claiming.

> 🔑 **This also resolves §11.1's loose end.** Atmospheric entry was dropped from
> the signature-sound list because it is a transition, not an asset. With `q = ½ρv²`
> driving the wind bed from the *same* ρ the atmosphere renderer already uses, it
> becomes a **physically derived** transition — and thin-Mars entry differs from
> thick-Venus entry with zero extra authoring.

### 12.3a Implementation: validated against published values

`src/audio/acoustics.ts` derives each body's acoustic properties from the same
`AtmosphereDef` the renderer uses. Re-derived independently in a standalone
script and compared against published figures:

| Body | M g/mol | γ | c m/s | ρ kg/m³ | ρ vs Earth | H km | density term |
|---|---|---|---|---|---|---|---|
| **Earth** | 28.965 (**0.0%**) | 1.401 | 340.4 (**0.0%**) | 1.2256 (**0.0%**) | 1.00 | 8.4 (−1.2%) | 0 dB |
| **Mars** | 43.476 (0.3%) | 1.296 | 228.1 (**−5.0%** vs measured 240) | 0.0158 | 0.0129 | 10.8 (−2.7%) | **−18.9 dB** |
| **Venus** | 43.45 (0.0%) | 1.293 | 427 (+4.1%) | 65.23 (0.4%) | 53.3 | 15.9 (0.0%) | 0 dB (clamped) |
| **Jupiter** | 2.255 (1.6%) | 1.426 | 931 (+3.5%) | 0.1644 | 0.134 | 23.5 (−13%) | −8.7 dB |
| Saturn | 2.144 | 1.415 | 857 | 0.1924 | 0.157 | 46.5 | −8.0 dB |
| Uranus | 2.641 | 1.433 | 585 | 0.4179 | 0.341 | 27.0 | −4.7 dB |
| Neptune | 2.668 | 1.439 | 568 | 0.4456 | 0.364 | 19.9 | −4.4 dB |

✅ **Earth is the control and it is exact** — molar mass, speed of sound and
density all agree to 0.0%. That isolates every other body's error to its own
inputs and approximations rather than to the maths.

Known, explained deviations — none of them worth "fixing" by fudging inputs:

- **Mars c −5.0%.** Predicted before implementing. 210 K is a *mean*; the
  measured 240 m/s was taken at a warmer surface moment, and CO₂'s vibrational
  relaxation alters the effective γ at low frequency. The direction and magnitude
  both match expectation.
- **Venus c +4.1%, Mars/Venus γ.** `GAMMA` holds room-temperature values, and γ
  for polyatomics falls as temperature rises — so Venus at 737 K should have a
  lower γ and hence lower c than modelled. Enters c as √γ, so a few percent of γ
  is 1–2% of c.
- ⚠ **Uranus/Neptune γ is wrong in the OTHER direction.** At 76 K and 72 K, H₂'s
  rotational modes partially freeze out and its γ rises toward the monatomic
  1.667, so the fixed 1.41 *understates* it. Flagged rather than corrected: a
  T-dependent Cp model is the fix, and it is not worth it before anything can be
  heard on an ice giant.
- **Mars ρ −21% against the commonly cited 0.020 kg/m³.** ⚠ This one is a
  discrepancy in the *published* numbers, not in the arithmetic: NASA's own Mars
  fact sheet lists 6.36 mbar, 210 K **and** 0.020 kg/m³, and those three are
  mutually inconsistent by ~26% (`pM/RT` at 6.36 mbar / 210 K is 0.0158). Our
  value is the one consistent with our own pressure and temperature, which is the
  right choice for a model that must stay internally coherent.
- **Jupiter H −13%.** `sol.json`'s mass/radius give g = 25.92 m/s² against a
  published 24.79 (+4.6%), which propagates straight into H. That is the whole
  game's figure for Jupiter's gravity, so audio should not diverge from it.

The mixture-γ rule is also verified: the naive `Σxᵢγᵢ` shortcut errs by only
**0.11%** for Mars' CO₂/N₂ mix — harmless there — but by **0.65%** for Jupiter's
H₂/He, which is why the correct heat-capacity route is used.

### 12.3b Absorption: three tiers, each labelled by provenance

`absorptionDbPerM()` dispatches on composition, because **no single model covers
these atmospheres** — and the code tags every result with its `tier` so a number's
provenance is never guessed at.

| Atmosphere | Model | Tier |
|---|---|---|
| Earth-like (N₂/O₂) | **ISO 9613-1 verbatim** | `standard` |
| CO₂-dominated (Mars, Venus) | **fitted to in-situ measurements** | `measured` |
| H₂/He giants, N₂/CH₄ | classical (Stokes–Kirchhoff) only | `classical` |
| none | — | `vacuum` |

> ⚠⚠ **ISO 9613-1 DOES NOT APPLY OFF EARTH, and this was the whole reason to
> research before implementing.** Its two relaxation terms are specifically the
> vibrational relaxation of **O₂ and N₂, catalysed by water vapour**. Mars has
> essentially none of those three. Its validated envelope is 50 Hz–10 kHz,
> −20…+50 °C, 10–100% RH, ≈1 atm — Mars (0.6% atm), Venus (92 atm, 737 K) and
> the gas giants are all far outside it. Applying it anyway would have produced
> confident, standards-citing numbers that are physically meaningless.

**Tier 1 — Earth. ✅ Transcription verified to 0.1%.** Checked against published
tables at the six independently-sourced points:

| | 1 kHz | 4 kHz | 10 kHz |
|---|---|---|---|
| 50% RH | −0.1% | −0.1% | 0.0% |
| 70% RH | −0.0% | −0.1% | 0.0% |

⚠ The game's Earth is **288 K**, not the tables' 293.15 K, so in-game values
differ from the published ones — **4.16 dB/km at 1 kHz and 36.8 at 4 kHz**. That
is not an error: 288 K alone accounts for −10.9% at 1 kHz and **+24.0%** at 4 kHz,
because the O₂ relaxation peak moves from 35.4 kHz down to 23.5 kHz. Being low at
one frequency and high at another is the correct signature of a cooler atmosphere;
it looked like a shape bug and was not.

⚠ Relative humidity is **not in the composition data**, so it is a fixed 50%
assumption — mid-range of ISO's validity window. 0% would push `frN` into a
physically odd corner.

**Tier 2 — Mars, from measurement. ✅ Validated against a value it was not fitted
to.** Maurice et al. 2022, *Nature* 605: Perseverance's SuperCam used its own
laser sparks as a known source at 2–5 m and measured band-averaged α of
**0.21±0.04 (3–6 kHz), 0.34±0.05 (6–11 kHz), 0.43±0.05 m⁻¹ (11–15 kHz)**.

Model: `α(f) = C·f² + A·f_r·f²/(f_r²+f²)`, with **f_r = 240 Hz** — the CO₂
vibrational relaxation frequency, which is *also* the direct cause of Mars having
**two sound speeds** (γ falls 1.4 → 9/7 below f_r, so c drops ~250 → ~240 m/s).
Least squares on those three bands alone gives C = 1.4061e-9, A = 8.5161e-4,
fitting all three within **0.68σ**.

> ✅ **THE GATE THAT MATTERS.** Evaluated at 100 Hz — a frequency **not in the
> fit** — the model predicts **0.03025** against Petculescu & Lueptow's
> independent first-principles value (*Icarus* 186, 2007) of **0.030**:
> **0.8% agreement** between an in-situ measurement at 4.5–13 kHz and a
> theoretical model at 100 Hz, through two fitted parameters. It also independently
> reproduces the paper's reported ~8 m audible range: 20 dB of absorption alone
> arrives at **9.9 m on Mars against 544 m on Earth**.

**Tier 3 — everything else.** Classical Stokes–Kirchhoff only:
`α = [2π²f²/(ρc³)]·[(4/3)η + (γ−1)κ/c_p]`. This is the one term that genuinely
generalises to any gas. ⚠ Simplified: it anchors on Earth air's measured classical
term and scales by the leading `1/(ρc³)`, rather than carrying per-gas viscosity
we would be extrapolating to 76 K anyway. **No planetary-acoustics literature was
found for H₂/He at giant-planet conditions**, so this tier is physics-shaped
extrapolation, not a citation.

> 🔑 **A COUNTER-INTUITIVE CONSEQUENCE, AND IT IS REAL:** α ∝ 1/ρ, so **a thinner
> atmosphere ABSORBS MORE**. Verified in the shipped code — Earth's 4 kHz
> absorption rises from **36.8 dB/km at sea level to 53.0 dB/km at 20 km**. "Thin
> air ⇒ less absorption" is exactly backwards, and it is part of why Mars is the
> most absorptive of the four modelled bodies even before CO₂ relaxation.

**Level coupling — corrected.** Multiply amplitude by `√(Z/Z_earth)` where
**Z = ρ·c**, the characteristic acoustic impedance. ⚠ An earlier revision used the
density ratio alone and was wrong by 1.7 dB on Mars (−18.9 vs the correct
**−20.6 dB**), because Mars' sound speed is *also* lower and the two compound. Our
Z values (Earth 417, Mars 3.6, Venus 27,855) reproduce the published ones
(407, 4.4, 26,960). Venus' +18.2 dB is clamped away per §12.1: the physical model
may take loudness away, not add it.

### 12.3c `air` vs `contact` — the concept that makes the physics safe to ship

**Applying the propagation model to every world sound would have been actively
harmful, and noticing that was the most useful moment in this work.**

Every world emitter in the game today sits in hard vacuum: `origin_belt` is
anchored to Earth at [-5000, 0, 15000] km — about **9,400 km altitude** — and
`luna_belt` orbits airless Luna. So a naive wiring would have silenced asteroid
impacts and mining, which are the core loop's entire feedback. That is precisely
the outcome Frontier tested and rejected for Elite Dangerous (§12.4).

The fix is not to weaken the physics. Those sounds were **misclassified**, and
`AudioEventDef.coupling` is the missing concept:

| `coupling` | Reaches you via | Atmospheric attenuation? |
|---|---|---|
| `contact` (default) | direct mechanical contact with your own hull — you hit the rock, your laser is cutting it, debris struck the plating | **No.** Structure-borne, so the surrounding gas is irrelevant |
| `air` | the medium | **Yes.** Impedance coupling + frequency-dependent absorption, so it falls silent in vacuum |

Both are still panned — the hull conducts differently from the side that was
struck — so nothing is lost in feel.

> 🔑 **This is physics, not a gameplay exemption.** Sound arriving through a solid
> hull genuinely does not care about the vacuum outside. Hardspace: Shipbreaker
> built its whole soundscape on this, and §3.2's "the ship is the instrument"
> already implied it — `coupling` just makes it explicit and per-event.
>
> ⚠ **`contact` is the DEFAULT**, deliberately. The failure mode of getting this
> wrong is a silent core loop, so attenuation is opt-in. `check-audio-manifest`
> also emits a warning for every `air` event, because "this is inaudible in
> vacuum by design" should be a visible decision rather than an incidental one.

**Verified in the running game, in vacuum at ~10,900 km altitude:**

| Claim | Result |
|---|---|
| Contact-coupled still audible in vacuum | baseline peak [0.0008, 0.0009] vs impacts [0.0257, 0.0260] — fully separated, ~30× |
| Air-coupled culled in vacuum | emitter takes **no voice at all** |
| Voice not wasted | ⚠ First implementation applied propagation *after* promotion, so a silenced emitter still held a real voice. Folded into the cull test instead — attenuation now belongs to the promote/cull decision, not to the gain afterwards |

⚠ **A bug worth recording from the same change.** Voices are pooled and reused
across tiers, and the two use different topologies (`gain→lowpass→panner→bus` for
world, `gain→bus` for ship/UI). The first version only re-pointed the panner, so
the next world sound to reuse a ship-tier voice played **unpanned, unfiltered and
double-summed into the bus** — presenting as "spatial audio works, except
sometimes", depending purely on reuse order. `connectVoice` now disconnects all
three nodes and rebuilds.

### 12.3d What is actually audible today — and what is not

Stated plainly, because the model is validated and largely **unconsumed**:

| Consumer | Status |
|---|---|
| Impedance coupling on contact sounds | ✅ live, and correctly a **no-op** — they are contact-coupled |
| Impedance coupling on air sounds | ✅ live, but **nothing in the game is air-coupled in an atmosphere yet** |
| Frequency-dependent absorption | ⚠ **live with no consumer.** Needs an air-coupled emitter inside an atmosphere, and there are none |
| Wind / entry noise from `q = ½ρv²` | ❌ **not built — and this is the one piece with an audible consumer today**, because the player can already fly from Earth's surface to orbit. It is *ship*-tier (heard through the hull), so it needs no world emitters at all |

**So the next build is the `q = ½ρv²` wind bed**, not more propagation. It is the
only part of §12.3 that can be heard without content that does not exist yet, and
it is the surface-to-orbit transition the design already showcases visually.

The absorption model then waits for a real consumer: a station vent you fly past
in atmosphere, another player's ship, on-foot surface gameplay, or drones around
a station on a body with air. It is validated and ready; it is not yet load-bearing.

### 12.4 Precedent: does anyone else do this?

**Researched 2026-09-16. Short answer: no shipped game does.**

| Game | What it actually does | Physical? |
|---|---|---|
| **Star Citizen** | **The closest thing that exists.** "StarAudio", revealed at CitizenCon 2024, computes **speed of sound per environment from atmospheric pressure and temperature**, pulled from the same Planet Tech v5 per-body data that generates the atmospheres — i.e. exactly the architecture §12.3 proposes. ⚠ But the documented scope is Doppler/delay/pitch, **not** confirmed absorption or loudness attenuation, and it was still marked **not implemented**, targeting future patches | partial, **unshipped** |
| **Elite Dangerous** | Deliberately, explicitly **not** physical — see the design risk below | no |
| **No Man's Sky** | Wwise state/switch containers keyed to **biome and weather**, not measured density | no |
| **Starfield** | Ignores it completely — an NPC on an airless moon hears footsteps exactly as one in a pressurised city. Multiple Nexus mods exist purely to add atmosphere-aware muffling | no |
| **KSP 1** | ⚠ **Stock KSP does NOT attenuate sound in vacuum.** Engines and explosions play at full unfiltered volume in orbit. Density-scaled muffling is *mod-only* (Atmospheric Sound Enhancement, Audio Muffler Redux, Rocket Sound Enhancement) | no |
| **KSP 2** | Real field recordings (15-mic array at an Atlas V launch) **hand re-engineered** per destination for the Moon, Mars and vacuum. Authored offline per location, not a runtime formula | authored |
| **Deliver Us Mars** | Genuinely researched NASA/ESA Mars atmosphere data and modelled amplitude/frequency muffling and propagation delay — then applied it as an **authored mix for one fixed linear level** | authored |
| **DCS World** | Speed-of-sound propagation delay and a cockpit/helmet-isolated mix; no evidence of density-driven absorption | partial |

The pattern across the whole genre: everyone treats the atmosphere/vacuum boundary
as an **authored binary or a small tier set** (an in-atmosphere-vs-vacuum switch,
Odyssey's tenuous/thin/none tiers, NMS's biome states), or ignores it, or
hand-authors a physically-informed mix for a handful of fixed places. **Nobody
runs a continuous formula over real per-body composition and pressure.** Even a
two-band continuous curve keyed to actual density would be ahead of the observed
norm.

> ⚠⚠ **THE DESIGN RISK, AND IT IS THE MOST IMPORTANT THING IN THIS SECTION.**
>
> Frontier tested the realistic version of this for Elite Dangerous and
> **rejected it**. Their own explanation: atmospheres as thin as Odyssey's
> "practically wouldn't carry sound", so realistic landing sites would be
> near-silent — and pre-alpha testing of that "would be dull". Hence the
> in-fiction *handwavium*: suits and ships have built-in speakers that synthesise
> a soundscape for the pilot regardless of the real acoustics. That is not
> laziness; it is a deliberate, tested, gameplay-first design pillar from a team
> that shipped one of the most respected soundscapes in the genre.
>
> **So the realistic version has been tried and found to be less fun. Take that
> seriously.**
>
> ✅ **And then note that A2 already resolves it, for an unrelated reason.** Our
> split is: ship-diegetic sounds are **never** attenuated (you are aboard the
> ship, and the ship is the instrument — §3.2), and only **world emitters** are
> spatialised and attenuated. Elite's failure mode was silence applied to
> *everything*. Ours applies it only to the distant explosion that should be
> silent, while the hull, the engine, the alarms and the UI stay exactly as
> present as before.
>
> That means the interesting half of the realism (a rock shattering soundlessly
> two kilometres away in vacuum; the world going quiet as you climb; Mars
> swallowing the high frequencies) arrives without the dull half (your own ship
> going mute). Elite's rejection is therefore evidence **for** this architecture
> rather than against the feature — but the lever it implies is worth keeping:
> if real thin-world silence tests badly, a diegetic **"hull audio enhancement"**
> toggle is the honest escape hatch, and it is already consistent with the
> fiction.

⚠ No team published CPU numbers for per-voice atmospheric filtering. Treat the
cost as **unmeasured** — one biquad per world voice plus a 15 Hz coefficient
update should be negligible at our voice counts, but that is a prediction, and
Gate EA-2's harness is where it gets checked.

### 12.5 Recommendation

- ❌ **No** absolute-SPL asset calibration. ❌ **No** adaptive master auto-gain.
- ✅ Keep loudness-as-*importance* driving the existing voice priority and caps.
  That is what Frostbite's idea actually reduces to, and Phase 0 already has the
  machinery — the authored number just needs to be explicitly **importance**, not
  a physics guess.
- ✅ Spend the physical-modelling effort on **§12.3**, as a **Phase 3** block
  alongside the `frameGates` accessor (T7) that it depends on.
- ✅ Tune the limiter; add the BS.1770 dev meter.

**Where it lands:** fun and realism do not trade off here, because the realistic
thing (a thin atmosphere swallowing high frequencies, a sonic boom at the real
local Mach number, silence arriving gradually as you climb) is also the
*legible* thing. It is level where they would have traded off — and level is the
half we are declining to calibrate.

---

## 13. Verified codebase traps

Each verified against the actual files. These are the things that will cost a day if
rediscovered.

**T1 — `settingsAtom` replaces defaults, it does not merge.**
[`store.ts`](../src/store/store.ts)'s `atomWithStorage("settings", …)` has no merge
wrapper (unlike [`keybinds.ts`](../src/store/keybinds.ts), which does). A returning
player's saved blob **replaces** the whole default object, so any key added later reads
`undefined` on first load. `SettingsMenu.tsx` documents this three separate times
(lines ~108-111, ~166-167, ~1112-1117) because it has bitten before: `!undefined` →
`true` makes a new toggle appear to do nothing on the first click, and `undefined.toFixed()`
throws. **Every** read of a new audio setting needs `?? DEFAULT`. A9's separate store
module should carry a merge wrapper from the start so this trap simply doesn't apply.

**T2 — the Dev submenu and a player submenu are different mechanisms.**
`SubMenu.Dev` is filtered by `IS_DEV` ([`SettingsMenu.tsx:73`](../src/components/HUD/SettingsMenu/SettingsMenu.tsx:73))
and its `devHandlers` prop is entirely `undefined` in production — the Dev case
*cannot* render without it. A player-facing Audio submenu must be its own
unconditional case taking only `settings`/`setSettings`. Conversely audio *debug*
tooling belongs inside `case SubMenu.Dev`. Conflating them ships the debug panel to
every player.

**T3 — one asteroid hit can fire up to 3 collision events in a single tick.**
[`AsteroidField.tsx:51`](../src/components/Asteroids/AsteroidField.tsx:51)
`MAX_COLLISION_LOGS_PER_TICK = 3`, scanned on a `COLLISION_INTERVAL_S = 0.1` accumulator
over a 3×3×3 chunk neighbourhood. A naive hook on every `"collision"` VFX event stacks
2–3 overlapping impacts instantly. Needs per-event `maxInstances` + `cooldownMs`, or
coalescing.

**T4 — never schedule sound from a React re-render.**
Measured `baseLatency` is 5.80 ms; the ~20 ms perceptual budget is generous *if* we
don't waste it. Scheduling inside a `useEffect` reacting to a jotai change adds a
render hop and can push past the threshold where a sound reads as "late and cheap".
Fire from the same handler that mutates game state.

**T5 — one stray `new Audio()` invalidates the master volume slider.**
The single most-cited audio complaint is a slider that doesn't gate everything. Any
path that bypasses the bus graph reproduces it exactly. §10.1 greps for this
mechanically.

**T6 — first-play decode is an audible hitch.**
`decodeAudioData` measured 6.3 ms for 3 s mono. Pre-decode Tier-0/1 assets during the
existing load phase so the first mining press never pays it.

**T7 — `frameGates` is profiler-gated, but audio does not need it. ⚠ PARTLY RETRACTED.**
[`SpaceRenderer.tsx:254`](../src/components/space/SpaceRenderer.tsx:254) is a
module-private `const`, and its only external consumer `perf.setGates(frameGates)` sits
behind `if (!this.enabled) return`. **That part is true.**

⚠ **But the conclusion drawn from it — "audio cannot read altitude or the dominant
body" — was wrong, and it nearly caused a redundant accessor to be built.**
[`getDominantAtmosphereBody()`](../src/components/space/atmospherePass.ts:1425) is
**already exported**, and gives `id`, `distanceKm` and the full `params` (including
`groundRadiusKm`, so altitude is `distanceKm − groundRadiusKm`). Its backing map is
populated by `setAtmosphereBody()` from `CelestialBody`'s frame loop, gated only on
`config.atmosphere && (showNear || showMid)` — **LOD visibility, not the profiler**.

So: altitude, dominant body and the atmosphere params are all reachable today with no
new plumbing. Only `cloudsVisible` / `volumetricBlend` / `bsmStrength` are genuinely
`frameGates`-only, and §12.3 does not need them.

⚠ The one real caveat: a body drops out of the map when its LOD hides it, so
`getDominantAtmosphereBody()` returns `null` at distance. That is correct behaviour for
audio — no body in range means vacuum, which is exactly the right answer — but it means
`null` must be handled as "vacuum", never as "unknown, keep the last value".

**T8 — the context must be unlocked from a real gesture, synchronously.**
Every browser starts it suspended; iOS Safari is strictest and wants the *first* touch.
A joystick drag ([`react-joystick-component`](../package.json) is in the stack) is not
guaranteed to be that first gesture. Gate creation/resume on the first `pointerdown`
anywhere, queue pre-unlock triggers and flush on unlock (the shape `comms.ts`'s
`pendingDelayedIds` already uses). **Test on a real iOS Safari device** — this class of
bug ships silently broken when verified only on desktop Chrome.

**T9 — `pulseCycleBuffer.beamOn` is a per-frame value, not an event.**
[`mining.ts:161`](../src/store/mining.ts:161) is overwritten every frame on a
~1.5 s-on/0.5 s-off cycle. "Play a sound when `beamOn`" retriggers **every frame**.
Edge-detect against a previous-value ref.

**T10 — overheat clears at two different thresholds.**
`MiningSystem.tsx` clears `isOverheatedRef` at heat `<= 0` on natural cooldown
(line 1333) but at heat `< 1` after a heat-sink consumable (line 1356). Edge-detect the
committed `isOverheated` **boolean**, not the ref crossing zero, or the heat-sink path
is missed.

**T11 — `miningStateAtom` lags its own refs by 1–2 frames.**
Committed every `STATE_COMMIT_INTERVAL_S = 1/30`, with a forced commit on
cancel/complete. For latency-sensitive cues (target acquired, focus complete), hook
inside `MiningSystem`'s own `useFrame` rather than watching the atom.

**T12 — `cameraShakeIntensityAtom` and the `"collision"` VFX event are the same hit.**
[`vfx.ts:47`](../src/store/vfx.ts:47) sets both. Watching both plays two sounds per
impact. **Use `vfxEventsAtom`** — it carries `radiusM` and `impactDirection`, which the
shake atom doesn't.

**T13 — `toastsAtom` has no severity field.**
[`toast.ts:6`](../src/store/toast.ts:6) carries only `message`/`detail`/`durationMs`.
Its seven call sites span celebratory (research complete), error (cannot start
research), alert (transit disengaged) and minor rejection (no heat to reduce). A single
watcher would have to guess tone from message text. **Add a `kind` field** rather than
pattern-matching strings.

**T14 — chunk streaming must never make a sound.**
`fieldRuntime.onChunkUpdate` ([`AsteroidField.tsx:201`](../src/components/Asteroids/AsteroidField.tsx:201))
fires on worker message arrival — many times per second during transit, fully decoupled
from player action. It superficially looks like a spawn/despawn event. It is not.

**T15 — cargo-full and craft-blocked are currently *unhookable*.**
`MiningHUD` sets `disabled={mineDisabled}`, so a disabled button dispatches no click at
all; its keydown handler's `else if` has no `else`. `CraftingPanel`'s `requestCraft`
returns early on `!canAfford` with no signal. A rejection sound needs a **new branch**,
not just a hook. Rejection feedback is one of the cheapest wins in the game and
currently has nowhere to attach.

**T16 — Rapier will replace the collision surface.**
[`PHYSICS_PLAN.md`](PHYSICS_PLAN.md) puts Rapier next, and it will very likely supply
contact events with real impulse magnitude and normal — *better* audio data than
`radiusM`. So keep the hook a thin adapter: `playImpact(positionM, intensity)` called
from `spawnVFXEventAtom`'s collision branch, with `intensity` a rough function of
`radiusM` today and real impulse later. Do not architect anything elaborate around the
pre-Rapier surface.

**T17 — reuse the comms played-registry for one-shot stingers.**
If first-ever-mining / first-transit stingers are wanted, namespace ids with `audio:`
into the existing `comms-played-v1` localStorage mechanism rather than inventing a
second registry — then `resetCommsPlayedAtom` resets them for free on a new game.

---

## 14. Claims in this document that are NOT verified

Stated explicitly so a future session does not treat them as settled.

| # | Claim | Why it's soft | Cheap verification |
|---|---|---|---|
| L1 | Console loudness standards are −23/−24 LUFS, portable −16 | Traced to a source that returned 403; cited via search summary only | Pull Sony's or GANG's published spec before quoting the figures externally |
| L2 | Sonniss GDC bundle licence permits commercial use with no attribution | Single licence-page citation; free-bundle terms change between releases | Read `sonniss.com/gdc-bundle-license/` **at download time** |
| L3 | Minimising `AudioParam` count per worklet is critical (one report: 544→96 params fixed a perf problem) | One anecdotal blog post, one Chrome version, generalised into a rule | Measure `process()` time on the M2 Pro via our own harness once worklet code exists |
| ~~L4~~ | ~~Current TTS quality/pricing rankings~~ | **Moot** — TTS was dropped with the voiced-comms decision (§6.7) | n/a |
| L5 | U. Iowa / NASA plasma-wave audio is unconditionally commercial-free | NASA's "generally uncopyrighted" policy has a carve-out for pieces containing third-party music/narration | Read the archive page's own terms, not NASA's general brand guidelines |
| L6 | "No volume sliders" / "audio after alt-tab" are *the* top complaints | Described as recurring forum sentiment without linked threads | Spot-check Steam EA reviews for comparable space sims. (The advice is cheap enough to follow regardless of the ranking) |
| L7 | `node-web-audio-api` (Rust) output matches Chromium's, incl. HRTF | Targets WPT spec compliance, not bit-parity | Render one scenario through both, diff peak/RMS, before trusting it for panning assertions |
| L8 | Voice cap 24 is right | Nobody measured it against this renderer | `__audio.stress()` under a dense `__bench` scenario (Gate EA-2) |
| L9 | Minecraft's ambient-music gap is 10–20 minutes | A frequently-repeated figure that may be stale or version/biome-specific | The Minecraft wiki's post-2022 biome-music changelog, or just pick your own range — the design doesn't depend on matching it |
| L10 | Minecraft's ambient scheduler fades rather than hard-cuts, and by how much | Only confirmed data points are a 20w17a changelog note ("no longer stops abruptly") and Bedrock's scripting `fadeSeconds` (0–10 s); neither documents the classic scheduler | Capture real gameplay audio and measure — or treat "short linear fade" as the design target, which is what §7.1 does |
| L11 | Suno's commercial terms as described in §7.4 (rights attach to creation-date plan, survive cancellation, free tier excluded) | Read from Suno's help-centre pages at one point in time; SaaS terms change, and this one *gates shipping* | Re-read Suno's terms and your own generation/subscription history **before** the Phase 2 music work |
| L12 | Suno's Advanced Split works on already-generated tracks on the author's plan | Found on Suno's product pages, not verified against the account | Log in and try it on one existing track |
| L13 | Satisfactory's specific many-machine audio approach | No developer-authored technical source found — only forum/wiki mentions | Factorio's FFF #341/#396 are the documented substitute and are cited instead (§5.3) |
| L14 | The full content of Frontier's GDC talk on thousands of dynamic audio objects (Planet Coaster/Zoo, Elite) | GDC Vault is paywalled; only the abstract was readable | Worth tracking down before finalising the aggregation design — it is the closest genre precedent |
| L15 | Frostbite/DICE abandoned real-world SPL values in practice | Sourced to a practitioner article explaining why Wwise's HDR went relative, not to DICE directly. The *conclusion* (§12.5) does not depend on it — 12.1's three arguments stand alone | Find the DICE GDC 2008 deck's own wording, or Audiokinetic's rationale for the relative scheme |
| L16 | Mars' two sound speeds (≈240 m/s low, ≈250 m/s above ~2 kHz, transition ~240 Hz) | From press coverage of Maurice et al. 2022 (*Nature*); the paper itself is paywalled and was not read | Read the paper before building the per-body `c` table on it. The ideal-gas calculation for 95.3% CO₂ at 210–230 K gives 228–238 m/s, within 1–5% of 240 — a useful independent sanity check |
| L17 | ISO 9613-1 α values quoted in §12.3 | Computed from the standard's equations as reproduced in a toolbox doc, not from the standard itself; the 4 kHz figure cross-checked against an ANSI/ASA table to 0.1 dB | Recompute from ISO 9613-1:1993 directly when implementing, and unit-test against the published table |
| L19 | Star Citizen's StarAudio includes absorption/loudness attenuation, not just speed-of-sound Doppler | Only secondary CitizenCon summaries were readable; the talk itself was not watched | Watch the CitizenCon 2024 StarAudio segment. It changes "nobody does this" to "one unshipped system may do part of it" — it does not change the plan |
| L20 | That Elite Dangerous has *zero* atmosphere-dependent variation | From a forum-summarised Frontier answer, not a primary transcript of Florianz's talks. The *design-risk* lesson stands regardless of how absolute the absence is | Find a primary source for the pre-alpha "would be dull" finding |
| L21 | CPU cost of per-voice atmospheric filtering | **No team publishes this.** Our own estimate (one biquad per world voice + 15 Hz coefficient update ≈ negligible) is a prediction, not a measurement | Gate EA-2's `__audio.stress()` under a busy scene, once the filter exists |
| L18 | Stapedius attenuation ~15–20 dB and ~10 ms onset | Sources ranged; frequency- and individual-dependent | Not load-bearing — it appears only as evidence that the ear's slow mechanisms are a small budget |

---

## 15. Questions — answered 2026-09-16

| # | Question | Answer |
|---|---|---|
| 1 | How rare is rare, for music? | **Silence is the default.** Minecraft's model explicitly: long silence, occasional calm fade-in. Deep space with just the engine humming is the point — filling it would undermine the isolation and the vastness (§7.1, §7.2) |
| 2 | Can you supply BPM / loop points? | **Not needed — the requirement was deleted by answer 1.** Play-once-with-fades reads no beat position and loops nothing, so the schema is `{id, file, mood, durationSec, weight}` and `ffprobe` supplies the only computed field (§7.1) |
| 3 | Comms voice? | **Chirp only.** No TTS, no VO (§6.7) |
| 4 | `/dev/audio` gating? | **Reachable in production is fine**, matching the existing `/dev/*` convention (§9.3) |
| 5 | Mute-on-blur default? | Refined to **three states defaulting to *duck***, not a boolean mute — because in co-op you alt-tab while the world keeps running and teammates keep playing (§8.2) |
| 6 | Signature sounds? | Four confirmed. **Atmospheric entry dropped** — it's a transition, not a sound. **Acquire/craft/build confirmation added** in its place, and it's now the most important one. The variability worry is answered by invariant-identity-layer + parametric layers (§11.1) |

### Second round — answered 2026-09-16

| # | Question | Answer | Consequence |
|---|---|---|---|
| 1 | Do the comms messages survive? | **Ship-AI messages only**; everything else scrapped | `voice` bus + slider removed; subtitles moot; one chirp family, not a per-speaker set (§1.1, §5.2, §6.7, §8.6) |
| 2 | Suno plan history? | Author is checking | Still the one thing that can block shipping music (§7.4, L1/L11) |
| 3 | How dense will bases get? | **Not dense.** A station, a few drones in and out, a handful of ships — ~10–30 emitters vs a 24-voice cap | Virtual tier deferred, clustering and audio LOD dropped, Gate EA-4 demoted to a formality (§5.3a). This was a real de-scope |
| 4 | On-foot mode? | **Far future, may not happen** — on planets/moons, possibly inside ships | No work now. Needs nothing beyond A2's two existing seams, which now serve three futures (A2) |

### Still open

1. **Suno plan history** (above) — blocking for Phase 2 only.
2. **Does the AI chirp read as head-locked or ship-anchored** once a cockpit exists?
   Deliberately unanswered; depends on how the AI's framing settles (A2).
3. **Nothing else.** The plan is actionable as written; Phase 0 has no unanswered
   dependencies.

---

## 16. References

**Techniques / talks**
- Frostbite "HDR Audio" (DICE) — loudness-as-importance prioritisation instead of compression
- Hardspace: Shipbreaker — contact/structure-borne propagation in vacuum (GDC + Audiokinetic writeup)
- Elite Dangerous — "every sound is generated by the ship"; silence reserved for canopy breach
- Chris Wilson, "A Tale of Two Clocks" — the lookahead scheduler pattern (A8)
- Andy Farnell, *Designing Sound* — synthesis topologies for the Phase 4 worklets
- Ben Burtt's layering method — the signature-sound approach (§11.1)
- Winifred Phillips / Destiny 2 audio talks — horizontal re-sequencing, transition matrices
- No Man's Sky procedural audio (Paul Weir) — what shipped, and its limits
- Game Accessibility Guidelines — the basic/intermediate/advanced audio tiers (§8.6)

**Specs / docs**
- MDN Web Audio API; `AudioWorklet`; `OfflineAudioContext`; Page Visibility API; MediaSession
- Wwise docs — playback limit / priority / volume threshold / virtual voices (§5.3)
- FMOD docs — buses, VCAs, snapshots (§5.5)
- ITU-R BS.1770-4 / EBU R128 — loudness measurement (§6.8)

**In-repo**
- [`docs/PERF_MEASUREMENT.md`](PERF_MEASUREMENT.md) — the measurement discipline this doc follows
- [`docs/UI_STYLE_GUIDE.md`](UI_STYLE_GUIDE.md) §6 — the `SoundChannel` stub this supersedes
- [`docs/PHYSICS_PLAN.md`](PHYSICS_PLAN.md) — plan-doc house style; T16
- [`STORY.md`](../STORY.md) — tone, the ship AI, isolation as the core theme

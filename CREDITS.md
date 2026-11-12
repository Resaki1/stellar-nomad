# Credits & Asset Licences — Stellar Nomad

> ⚠⚠ **LOG EVERY ATTRIBUTION-REQUIRED ASSET HERE THE DAY YOU DOWNLOAD IT.**
> Attribution is impossible to reconstruct retroactively — once fifty files are
> in `public/audio/` nobody can remember which three were CC-BY. A missing
> attribution on a shipped commercial build is a licence violation, not an
> oversight.
>
> Assets that are CC0, public domain, or covered by a paid no-attribution
> licence do **not** legally need a line here, but log them anyway: the *reason*
> a file is safe to ship is worth recording, and "where did this come from?"
> is asked far more often than expected.

---

## Audio

### Current status

The gameplay starter pack is original procedural output. No third-party audio
has been added. The station vent remains a synthetic development fixture.

| File | Source | Licence | Attribution required |
|---|---|---|---|
| `workshop/*.opus`, `workshop/*.wav` | `src/audio/workshop/`, promoted with `scripts/integrate-workshop-audio.mjs` | project-owned | no |
| `sfx3d/station_vent_loop.opus` | `gen-placeholder-audio.mjs` | project-owned | no |

Alarm and warning tones are **synthesised at runtime** (`src/audio/alarms.ts`) and
are not files at all.

### Procedural workshop sources

`AUDIO/workshop/*.wav` are original procedural output of
`src/audio/workshop/` and `scripts/audio-workshop.mjs`. No third-party recordings,
samples, generative models or external generation services are used. Every export
has a recipe with the renderer version, seed and parameters. Their encoded/lossless counterparts in `public/audio/workshop/` are now connected
to gameplay. Timbre and mix acceptance remain subject to listening tests.

### Licence traps to check before adding anything

Recorded from the §6.6 research so they are not rediscovered:

- ⚠ **Freesound is per-sound.** CC0 and CC-BY are shippable; **CC-BY-NC is not**,
  in a commercial game, ever. Check each sound individually — the licence is set
  per upload, not per site.
- ⚠ **The BBC Sound Effects free tier is RemArc-licensed: research, education and
  personal use only.** Not shippable without a separate commercial licence.
- ⚠ **Subscription libraries** (Epidemic Sound, Artlist and similar) are typically
  perpetual only for what was published *while subscribed*. A continuously
  redeployed browser game is arguably republishing on every deploy, so a lapsed
  subscription is a real risk. Prefer one-off purchases or CC0.
- ✅ **Sonniss GDC bundles** and **Kenney.nl** (CC0) are the safest bulk sources —
  but re-read Sonniss' licence at download time, since bundle terms change
  between releases.
- ⚠ **NASA / ESA audio** is generally uncopyrighted, but published *audiovisual
  pieces* sometimes carry third-party music or narration. Check the specific
  archive page's terms, not the agency's general media-guidelines page.

### Music

Tracks are generated with **Suno AI**.

> ⚠⚠ **BLOCKING CHECK BEFORE SHIPPING ANY TRACK.** Suno's commercial-use rights
> attach to **the plan active when a track was generated**, not the plan active
> when you ship. Free-tier generations remain personal/non-commercial **even if
> you upgrade later** — upgrading is not retroactive. Pro/Premier generations keep
> their rights even after cancellation.
>
> So: check each track's generation date against your subscription history, and
> re-generate or drop anything made on the free tier or during a lapse. Verify
> against Suno's current terms — see L11 in `docs/AUDIO_PLAN.md`.

| Track | Generated | Plan at generation | Mood tag | Cleared |
|---|---|---|---|---|
| _(none imported yet)_ | | | | |

---

## Fonts

Orbitron, Inter and JetBrains Mono, via `next/font/google` — all SIL Open Font
License 1.1. No attribution required in-product.

---

## Code & libraries

See `package.json`. Notable: three.js (MIT), React (MIT), Next.js (MIT),
jotai (MIT), @react-three/fiber and drei (MIT).

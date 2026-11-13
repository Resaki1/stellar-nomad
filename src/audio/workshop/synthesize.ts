import { renderMechanism } from "./mechanisms";
import { getPreset, parseRecipe, type Recipe } from "./presets";

export const WORKSHOP_SAMPLE_RATE = 48000;
export const RENDERER_VERSION = 6;
const TAU = Math.PI * 2;

export type SoundStats = {
  peakDb: number;
  rmsDb: number;
  dc: number;
  seamDelta: number;
  maxDelta: number;
  finite: boolean;
  silent: boolean;
};
export type RenderedSound = {
  recipe: Recipe;
  samples: Float32Array<ArrayBuffer>;
  sampleRate: number;
  loop: boolean;
  stats: SoundStats;
};

/** Mulberry32: local deterministic noise, never Math.random or shared game state. */
function random(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let n = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two passes over the SAME noise period settle filter state for continuous loops.
 *
 * `grain` is the wide band through a feedback comb at the fundamental plus two
 * narrow cavity resonances. Measured on the v3 pack: every sound reported as
 * cheap static had tilt-invariant spectral flatness 0.90-1.00 over 300 Hz-8 kHz,
 * while hull tension — the one noisy sound nobody objected to — measured 0.71.
 * The defect is missing STRUCTURE in that band, not excess brightness: those
 * sounds were already 73-97% sub-300 Hz. A first attempt used a bank of three
 * Q=7..16 resonators and measured WORSE than useless: flatness fell to 0.05 and
 * the centroid halved, but the tilt-invariant number stayed at 0.91 — a wide
 * resonator bank is a lowpass wearing a costume, and it muffled the pack instead
 * of structuring it. The comb is what works, because it lays a dense harmonic
 * series across the whole band while leaving the broad tilt alone.
 */
function noiseBands(length: number, brightness: number, seed: number, loop: boolean, combHz: number, grainHz: number) {
  const low = new Float32Array(length);
  const wide = new Float32Array(length);
  const grain = new Float32Array(length);
  // Pink-tilted air, with no comb and no cavity anywhere in its path. Wind's
  // defect is the OPPOSITE of the motors': the first build fed it `grain` and
  // measured 0.56 periodic at 62 Hz above 300 Hz — within 0.01 of the engine at
  // full thrust, and described as a saw grinding on metal. A comb is how a
  // MOTOR stops sounding like static; air has no fundamental, so the same tool
  // is the defect here. Pink rather than white because broadband flow noise
  // falls with frequency; flat noise is the hiss v4 exists to remove.
  const air = new Float32Array(length);     // dark: the lull between gusts
  const airTop = new Float32Array(length);  // open: the gust itself
  const coefficient = (hz: number) => 1 - Math.exp(-TAU * hz / WORKSHOP_SAMPLE_RATE);
  const bassCut = coefficient(180);
  const topCut = coefficient(650 + brightness * brightness * 9000);
  const dcCut = coefficient(25);
  // Over a loop the delay divides the period exactly, because `combHz` is the
  // quantised carrier, so the comb state is already correct at the wrap.
  const delay = Math.max(4, Math.min(length / 2, WORKSHOP_SAMPLE_RATE / combHz));
  const whole = Math.floor(delay);
  const fraction = delay - whole;
  const line = new Float32Array(whole + 2);
  const feedbackCut = coefficient(1800 + brightness * 5000);
  // The grain band is deliberately much darker than `wide`. A-weighted, the
  // sounds that were called static put 31-64% of their perceived energy in
  // 1.2-8 kHz, where hull tension — the noisy sound nobody objected to — puts
  // 1.3%. Unweighted they look bass-heavy (73-97% sub-300 Hz), which is exactly
  // how the first two attempts talked themselves out of rolling the top off.
  const grainTop = coefficient(grainHz);
  const airCut = coefficient(430);
  const airTopCut = coefficient(430 + brightness * brightness * 1500);
  const airHpCut = coefficient(150);
  // Narrow enough that the ear hears pitch, not another band of noise: a Q of 7
  // is wider than a third of an octave and simply disappears into the tilt.
  const cavities = ([[2.9, 24], [6.7, 34]] as const).map(([ratio, q]) => {
    const hz = Math.min(combHz * ratio, 9000);
    const r = Math.exp(-Math.PI * hz / (q * WORKSHOP_SAMPLE_RATE));
    return { a: 2 * r * Math.cos(TAU * hz / WORKSHOP_SAMPLE_RATE), b: r * r, g: 1 - r, y1: 0, y2: 0 };
  });
  let bass = 0, weight = 0, weight2 = 0, top = 0, top2 = 0, dc = 0, damp = 0, write = 0, soft = 0, soft2 = 0;
  let pink0 = 0, pink1 = 0, pink2 = 0, dark = 0, dark2 = 0, open = 0, open2 = 0, openDc = 0;
  for (let pass = 0; pass < (loop ? 2 : 1); pass++) {
    const rng = random(seed);
    for (let i = 0; i < length; i++) {
      const white = rng() * 2 - 1;
      bass += bassCut * (white - bass);
      // Three poles, not one. A single 180 Hz pole is only -24 dB at 3 kHz, and
      // A-weighting gives back 20 of them, so one-pole "rumble" still arrives at
      // the ear as hiss — measured, it was the engines' whole static problem.
      // The 7.31 restores the level the one-pole cascade used to deliver.
      weight += bassCut * (bass - weight);
      weight2 += bassCut * (weight - weight2);
      dc += dcCut * (weight2 - dc);
      top += topCut * (white - top);
      top2 += topCut * (top - top2);
      low[i] = (weight2 - dc) * 7.31;
      const band = (top2 - bass) * 2;
      wide[i] = band;
      soft += grainTop * (band - soft);
      soft2 += grainTop * (soft - soft2);
      const lag = (write + line.length - whole) % line.length;
      const older = (lag + line.length - 1) % line.length;
      damp += feedbackCut * ((line[lag] * (1 - fraction) + line[older] * fraction) - damp);
      const combed = soft2 + 0.84 * damp;
      line[write] = combed;
      write = (write + 1) % line.length;
      let resonant = 0;
      for (let c = 0; c < cavities.length; c++) {
        const mode = cavities[c];
        const y = mode.a * mode.y1 - mode.b * mode.y2 + mode.g * soft2;
        mode.y2 = mode.y1;
        mode.y1 = y;
        resonant += y;
      }
      grain[i] = combed * 0.42 + resonant * 0.5;
      // Kellet's economy pink filter: -3 dB/oct to ~0.3 dB across the band.
      pink0 = 0.99765 * pink0 + white * 0.0990460;
      pink1 = 0.963 * pink1 + white * 0.2965164;
      pink2 = 0.57 * pink2 + white * 0.1050186;
      const pink = (pink0 + pink1 + pink2 + white * 0.0848) * 0.25;
      dark += airCut * (pink - dark);
      dark2 += airCut * (dark - dark2);
      air[i] = dark2;
      // Two poles, not one. Pink already falls at -3 dB/oct, and a single pole
      // on top of it still left `ship.wind.high` at 33% A-weighted 1.2-8 kHz —
      // squarely in the 31-64% band every sound the pack called cheap static
      // measured in. The bed is heard THROUGH a hull; the top has to be shut.
      open += airTopCut * (pink - open);
      open2 += airTopCut * (open - open2);
      openDc += airHpCut * (open2 - openDc);
      airTop[i] = open2 - openDc;
    }
  }
  // Match the wide band's level, so every family mix coefficient keeps its meaning.
  const matchTo = (band: Float32Array) => {
    let wideSquares = 0, bandSquares = 0;
    for (let i = 0; i < length; i++) { wideSquares += wide[i] * wide[i]; bandSquares += band[i] * band[i]; }
    const match = bandSquares > 1e-12 ? Math.sqrt(wideSquares / bandSquares) : 0;
    for (let i = 0; i < length; i++) band[i] *= match;
  };
  matchTo(grain);
  matchTo(air);
  matchTo(airTop);
  return { low, wide, grain, air, airTop };
}

const db = (amplitude: number) => amplitude > 0 ? 20 * Math.log10(amplitude) : -120;

export function measureSound(samples: Float32Array): SoundStats {
  let peak = 0, squares = 0, total = 0, maxDelta = 0, finite = true;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!Number.isFinite(s)) finite = false;
    peak = Math.max(peak, Math.abs(s));
    squares += s * s;
    total += s;
    if (i) maxDelta = Math.max(maxDelta, Math.abs(s - samples[i - 1]));
  }
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(squares / samples.length)), dc: total / samples.length,
    seamDelta: Math.abs(samples[0] - samples[samples.length - 1]), maxDelta, finite, silent: peak < 1e-7 };
}

/** Pure offline authoring DSP: identical code runs in a Web Worker and the CLI. */
export function renderSound(input: Recipe): RenderedSound {
  const recipe = parseRecipe(input);
  const preset = getPreset(recipe.presetId);
  const rate = WORKSHOP_SAMPLE_RATE;
  const n = Math.round(recipe.duration * rate);
  const duration = n / rate;
  const samples = new Float32Array(n);
  const loop = !!preset.loop;
  const rng = random(recipe.seed ^ 0x7ef231a9);
  const fundamental = preset.hz * 2 ** (recipe.pitch / 12);
  const periodicHz = (hz: number) => loop ? Math.round(hz * duration) / duration : hz;
  const base = periodicHz(fundamental);
  // How far up the grain reaches, per family. A comb at the fundamental only
  // makes noise read as pitched while its teeth stay wider than a critical band
  // (~15%), so roughly up to 7x the fundamental; above that the ear hears noise
  // however dense the comb is. A 48 Hz reactor cannot be structured at 3 kHz —
  // measured, it held 42% A-weighted hiss through three attempts to do so — so
  // its band gets rolled off there instead.
  const tone = recipe.brightness * recipe.brightness;
  const grainHz = preset.family === "motor" ? 420 + tone * 1600
    : preset.family === "cutter" ? 700 + tone * 5200
    : preset.family === "drive" ? 430 + tone * 2600
    // `wind` has no entry because it never reads the grain band at all: see the
    // `air` / `airTop` comment in noiseBands.
    : 520 + tone * 4200;
  const noise = noiseBands(n, recipe.brightness, recipe.seed, loop, Math.max(20, base), grainHz);
  const phaseOffset = rng() * TAU;
  // Inharmonic bending modes. This is a useful material-inspired model, not a
  // calibrated hull simulation: no geometry/material measurements exist yet.
  const impact = preset.family === "impact";
  const ratios = impact ? Array.from({ length: 28 }, (_, i) => 0.55 * 1.19 ** i)
    : [1, 1.47, 2.09, 2.56, 3.71, 5.21, 7.3, 10.6];
  const modes = ratios.map((ratio, i) => {
    const hz = fundamental * ratio * (0.97 + rng() * 0.06);
    // Broad, heavily damped panel modes rather than a few high-Q musical notes.
    const decay = impact ? (14 + i * 2.8 + rng() * 14) / Math.sqrt(duration)
      : (3 + i * 1.2) / duration;
    const r = Math.exp(-decay / rate);
    return { a: 2 * r * Math.cos(TAU * hz / rate), b: r * r,
      gain: Math.sin(TAU * hz / rate) / (1 + i * 0.45) * (impact ? 0.07 : 1), y1: 0, y2: 0 };
  });
  // Small secondary contacts make a hull strike a mechanical event, not a bell.
  const contacts = Array.from({ length: 7 }, (_, i) => ({
    at: (0.018 + i * 0.022 + rng() * 0.02) * Math.sqrt(duration),
    decay: 0.004 + rng() * 0.014,
    gain: (0.25 + rng() * 0.5) / (1 + i * 0.5),
  }));
  let phase = 0;
  const bright = recipe.brightness;
  // Ship hardware one-shots are modal/flow models with their own structure.
  const mechanism = preset.family === "mechanism" ? renderMechanism(preset.gesture, recipe, n, rate) : null;
  if (mechanism) samples.set(mechanism);
  else for (let i = 0; i < n; i++) {
    const t = i / rate;
    const u = i / n;
    let body = 0, texture = 0, detail = 0;
    let envelope = 1;
    const drift = Math.sin(TAU * u * 2 + phaseOffset) * recipe.motion;

    if (preset.family === "signal") {
      const tick = preset.gesture === "tick";
      const notes = tick ? [1] : preset.gesture === "reject" ? [1, 0.75] : duration > 0.8 ? [1, 1.25, 1.5] : [1, 1.5];
      for (let note = 0; note < notes.length; note++) {
        const since = t - note * duration * (notes.length === 3 ? 0.19 : 0.24);
        if (since < 0) continue;
        const pitch = base * notes[note] * (1 + 0.002 * Math.sin(phaseOffset));
        const attack = 1 - Math.exp(-since / 0.002);
        const decay = Math.exp(-since / (duration * (tick ? 0.13 : 0.16)));
        const p = TAU * pitch * since;
        body += attack * decay * (Math.sin(p) * 0.6 + Math.sin(p * 2) * 0.13);
        detail += attack * decay * Math.sin(p * 3.003 + 0.3 * Math.sin(p)) * (0.08 + bright * 0.12);
        texture += noise.wide[i] * Math.exp(-since / 0.009) * 0.7;
      }
    } else if (preset.family === "impact" || preset.family === "creak") {
      const creak = preset.family === "creak";
      const friction = Math.max(0, Math.sin(TAU * ((3 + recipe.motion * 12) * t + 4 * t * t) + phaseOffset)) ** 12;
      let rattle = 0;
      if (!creak) for (const contact of contacts) {
        const since = t - contact.at;
        if (since >= 0) rattle += contact.gain * (1 - Math.exp(-since / 0.0007)) * Math.exp(-since / contact.decay);
      }
      const excitation = creak
        ? noise.wide[i] * friction * Math.sin(Math.PI * u) ** 2 * 0.13
        : noise.wide[i] * (Math.exp(-t / 0.009) + rattle * 0.4);
      for (let m = 0; m < modes.length; m++) {
        const mode = modes[m];
        const y = mode.a * mode.y1 - mode.b * mode.y2 + excitation * mode.gain;
        mode.y2 = mode.y1;
        mode.y1 = y;
        if (m < 3) body += y;
        else detail += y * (0.25 + bright * 0.7);
      }
      // The first 12 ms stays flat and white — that is the crack. Everything that
      // outlives it goes through the cavity, because a long flat tail is the
      // part that reads as static.
      texture = creak ? excitation * 2 : noise.wide[i] * Math.exp(-t / 0.012) * 1.6
        + noise.grain[i] * (Math.exp(-t / (duration * 0.1)) * 0.95 + rattle * 1.7);
      body += noise.low[i] * Math.exp(-t / (duration * 0.16)) * (creak ? 0.04 : 1.6);
      if (!creak) body = Math.tanh(body * 1.8) * 0.8;
    } else {
      const rising = preset.gesture === "rise";
      const falling = preset.gesture === "fall";
      const hit = preset.gesture === "hit";
      const sweep = rising ? 0.45 + 0.55 * u * u : falling ? 1 - 0.65 * u : hit ? 0.75 + 1.4 * Math.exp(-t * 14) : 1;
      phase += TAU * base * sweep / rate;
      // For steady loops every carrier and modulation completes whole cycles.
      // No tail crossfade, silent join, or new random noise at each repeat.
      const p = loop ? TAU * base * t : phase;
      const flutter = 1 + recipe.motion * 0.12 * Math.sin(TAU * periodicHz(13) * t + drift);
      if (preset.family === "motor") {
        // Weight is an explicit 40–60 Hz body, with audible 100–250 Hz
        // harmonics for small speakers. Broadband airflow must not mask it.
        // Periodic, unequal chamber phases avoid a static pure synth note;
        // all layers retain the same phase while load changes their spectrum.
        const chamber = p + 0.45 * Math.sin(TAU * periodicHz(0.67) * t)
          + 0.18 * Math.sin(TAU * periodicHz(1.83) * t + phaseOffset);
        const growl = Math.sin(chamber) * 0.72 + Math.sin(chamber * 2) * 0.3
          + Math.sin(chamber * 3) * (0.12 + bright * 0.18);
        const weight = Math.sin(TAU * periodicHz(base * 0.79) * t + drift * 0.25);
        const churn = 0.88 + 0.08 * Math.sin(TAU * periodicHz(2.3) * t + drift)
          + 0.04 * Math.sin(TAU * periodicHz(5.7) * t + phaseOffset);
        body = (Math.tanh(growl * (1.2 + bright)) * 0.72 + weight * 0.22) * churn;
        texture = noise.low[i] * 0.9 + noise.grain[i] * flutter * (0.3 + bright * 0.18);
        // tanh(noise.low * 3) hard-saturated a lowpassed band into a broadband
        // buzz — a hiss generator wearing a rasp's name. Softer drive, and the
        // upper air is now breathed at the chamber rate so it has sidebands.
        detail = Math.tanh(noise.low[i] * 1.9) * (0.15 + bright * 0.18)
          + Math.sin(chamber * 4 + drift) * 0.09
          + noise.grain[i] * (0.55 + 0.45 * Math.sin(chamber * 2)) * (0.16 + bright * 0.1);
      } else if (preset.family === "cutter") {
        body = Math.sin(p + drift * 0.12) * 0.31 + Math.sin(p * 2) * 0.12 + noise.low[i] * 0.2;
        // Depth matters more than level here: the old 12% ripple on flat noise
        // was far too shallow to put sidebands anywhere the ear would find them.
        const bite = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(p + drift * 0.4)) ** 2;
        texture = noise.grain[i] * flutter * bite * 0.95;
        detail = (Math.sin(p * 6 + 0.55 * Math.sin(p * 2)) * 0.11 + Math.sin(p * 11) * 0.025) * (0.4 + bright);
      } else if (preset.family === "drive") {
        body = Math.sin(p) * 0.46 + Math.sin(p * 0.5) * 0.16 + noise.low[i] * 0.3;
        // Quantize the subharmonic separately; base/2 may be a half cycle.
        if (loop) body = Math.sin(p) * 0.46 + Math.sin(TAU * periodicHz(base / 2) * t) * 0.16 + noise.low[i] * 0.3;
        // Modulated at 1.5x the carrier: inharmonic sidebands, so the field reads
        // as a machine running rather than as noise laid over a tone.
        const shimmer = 0.62 + 0.38 * Math.sin(TAU * periodicHz(base * 1.5) * t + drift);
        texture = noise.grain[i] * (0.8 + drift * 0.18) * shimmer;
        detail = Math.sin(p * 4 + drift * 0.8) * 0.1 + Math.sin(p * 7) * 0.035;
      } else if (preset.family === "wind") {
        // Moving air: the pink `air` / `airTop` bands and NOTHING from `grain`
        // or from a carrier. ⚠ Do not reintroduce `Math.sin(p)` here "for
        // weight" — 62 Hz against a broadband bed is the saw, not the hull.
        //
        // Four gust LFOs at pairwise-coprime cycle counts over the loop, SUMMED
        // rather than multiplied so there are no deep nulls, and the first a
        // `cos` with no seed phase so the seam sits on a peak. ⚠ Pick rates for
        // what they quantise TO, not what they read as: whole cycles per loop is
        // the only choice available, so 0.23 and 0.61 Hz land on 1 and 4 over a
        // 6 s loop — a 1:4 lock that gusts audibly in step. ⚠ No single term may
        // dominate either, or its own rate becomes the pattern the ear locks
        // onto regardless of the loop length: 0.20/0.16/0.10/0.06 is deliberately
        // flat, so the swell is never twice the same shape inside the loop.
        const cycles = (count: number) => count / duration;
        const gust = Math.min(1, Math.max(0,
          0.5 + 0.2 * Math.cos(TAU * cycles(3) * t)
            + 0.16 * Math.sin(TAU * cycles(7) * t + phaseOffset)
            + 0.1 * Math.sin(TAU * cycles(13) * t + drift)
            + 0.06 * Math.sin(TAU * cycles(19) * t + phaseOffset * 1.7)));
        // 🔑 THE GUST IS SPECTRAL, NOT AN AMPLITUDE ENVELOPE. A deep level
        // modulation on a loop IS the loop's signature — the first build ran
        // 10.5 dB of it over 6 s and was heard as "a repeating pattern every few
        // seconds". Opening and closing the band instead reads as air arriving
        // and leaves the level nearly flat, so the repeat has far less to latch
        // onto. The remaining level term is ~1.4 dB, for weight, not for shape.
        const opening = 0.12 + 0.88 * gust;
        body = noise.low[i] * (0.88 + 0.12 * gust);
        texture = (noise.air[i] * (1 - opening * 0.72) + noise.airTop[i] * opening)
          * (0.86 + 0.14 * gust);
        detail = noise.airTop[i] * opening * (0.1 + bright * 0.2);
      } else if (preset.family === "jet") {
        body = noise.low[i] * 0.8 + Math.sin(p) * Math.exp(-t * 35) * 0.12;
        texture = noise.wide[i] * 1.2;
        detail = noise.wide[i] * Math.exp(-t * 70) * 0.3;
      } else {
        body = Math.sin(p) * 0.16 + noise.low[i] * 0.25;
        texture = noise.wide[i] * (0.7 + drift * 0.1);
        detail = Math.sin(p * 3) * 0.06;
      }
      if (!loop) {
        envelope = rising ? (0.15 + u * 0.85) : falling ? (1 - u) ** 1.5 : hit ? Math.exp(-u * 4.5) : 1;
        // Mechanical switching transient; absent in sustained loops.
        detail += noise.wide[i] * Math.exp(-t / 0.008) * 0.5;
      }
    }
    samples[i] = (body * recipe.body + texture * recipe.texture + detail * recipe.detail) * envelope;
  }

  // Subtract DC before windowing. For one-shots, use the edge window's weighted
  // mean so removal does not reintroduce DC or make nonzero export endpoints.
  const fadeIn = Math.min(0.004, duration * 0.04);
  const fadeOut = Math.min(0.09, duration * 0.2);
  const windowAt = (i: number) => loop ? 1 :
    Math.sin(Math.min(1, i / (fadeIn * rate)) * Math.PI / 2) ** 2 *
    Math.sin(Math.min(1, (n - 1 - i) / (fadeOut * rate)) * Math.PI / 2) ** 2;
  let sum = 0, weight = 0;
  for (let i = 0; i < n; i++) { const w = windowAt(i); sum += samples[i] * w; weight += w; }
  const mean = sum / weight;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    samples[i] = (samples[i] - mean) * windowAt(i);
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  // Consistent preset peaks aid authoring; layer knobs change the balance.
  // A silent recipe stays silent. No limiter or runtime master gain is baked in.
  const gain = peak > 1e-7 ? 10 ** (preset.peakDb / 20) / peak : 0;
  for (let i = 0; i < n; i++) samples[i] *= gain;
  return { recipe, samples, sampleRate: rate, loop, stats: measureSound(samples) };
}

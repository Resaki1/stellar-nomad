// ---------------------------------------------------------------------------
// MECHANISMS — physically modelled one-shots for ship hardware (Gate EA-1).
//
// Everything here is heard THROUGH THE SHIP: the ship is in vacuum, so a valve,
// latch or contactor reaches the crew as structure-borne vibration. That is why
// contacts excite modal banks instead of playing noise bursts, and why gas flow
// is lowpassed by the structure instead of arriving as open-air hiss.
// ---------------------------------------------------------------------------

import type { Recipe } from "./presets";

const TAU = Math.PI * 2;

export type MechanismGesture = "vent" | "purge" | "relay" | "unlatch" | "jettison" | "repair" | "boot";

/** Mulberry32, same generator as the main renderer. */
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
 * A structure as a bank of damped modes, driven by a force signal.
 * Contacts are half-sine force pulses of duration `tc`: a short contact
 * (hard metal-on-metal, ~0.2 ms) reaches the high modes, a long one (a padded
 * plunger, ~1.5 ms) cannot — physically why soft impacts sound dull.
 */
class Structure {
  readonly force: Float32Array;
  constructor(
    private readonly rate: number,
    length: number,
    readonly freqs: number[],
    readonly t60: number[],
    readonly weights: number[],
  ) {
    this.force = new Float32Array(length);
  }

  strike(atS: number, tcS: number, amp: number): void {
    const start = Math.max(0, Math.round(atS * this.rate));
    const width = Math.max(2, Math.round(tcS * this.rate));
    for (let i = 0; i < width && start + i < this.force.length; i++) {
      this.force[start + i] += amp * Math.sin((Math.PI * (i + 0.5)) / width);
    }
  }

  /** Stick-slip friction: a train of micro-impacts, rate and level per call. */
  scrape(fromS: number, toS: number, rateHz: (u: number) => number, amp: (u: number) => number, rng: () => number): void {
    let t = fromS;
    while (t < toS) {
      const u = (t - fromS) / (toS - fromS);
      this.strike(t, 0.0006, amp(u) * (0.4 + rng() * 0.8));
      // Exponential inter-arrival: slip events are Poisson-like, not periodic.
      t += -Math.log(1 - rng() * 0.999) / Math.max(1, rateHz(u));
    }
  }

  render(out: Float32Array, gain: number, scale: number): void {
    for (let m = 0; m < this.freqs.length; m++) {
      const hz = Math.min(this.freqs[m] * scale, this.rate * 0.45);
      const w = (TAU * hz) / this.rate;
      const r = 10 ** (-3 / (this.t60[m] * this.rate));
      const a = 2 * r * Math.cos(w), b = r * r, g = Math.sin(w) * this.weights[m] * gain;
      let y1 = 0, y2 = 0;
      for (let i = 0; i < out.length; i++) {
        const y = a * y1 - b * y2 + g * this.force[i];
        y2 = y1;
        y1 = y;
        out[i] += y;
      }
    }
  }
}

/** Kellet pink noise, -3 dB/oct. */
function pinkNoise(length: number, rng: () => number): Float32Array {
  const out = new Float32Array(length);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < length; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 0.1050186;
    out[i] = (b0 + b1 + b2 + w * 0.0848) * 0.25;
  }
  return out;
}

/**
 * Pressure-vessel blowdown through a valve, as heard through the plumbing.
 * P(t) = e^(-t/τ). While choked (P > Pc) the exit is sonic, so mass flow — and
 * amplitude — go as P with a fixed spectrum. Below Pc the jet is subsonic:
 * Lighthill's U⁸ power with U ∝ √ΔP gives amplitude ∝ ΔP², and the spectral
 * peak (Strouhal, f ∝ U) falls as √P. A fixed one-pole at 2.4 kHz stands in for
 * the structure's mass-law rolloff — the reason this is a rush, not a hiss.
 */
function blowdown(
  out: Float32Array, rate: number, pink: Float32Array,
  o: { startS: number; openS: number; tauS: number; peakHz: number; amp: number; closeS?: number; scale: number },
): void {
  const pc = 0.3;
  const hp = 1 - Math.exp((-TAU * 120) / rate);
  const wall = 1 - Math.exp((-TAU * 2400) / rate);
  let l1 = 0, l2 = 0, h = 0, s = 0, rumble = 0;
  const rumbleK = 1 - Math.exp((-TAU * 140) / rate);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate - o.startS;
    if (t < 0) continue;
    const open = Math.min(1, t / o.openS) ** 2 * (3 - 2 * Math.min(1, t / o.openS));
    // `closeS` is absolute time; a valve shuts over ~30 ms.
    const close = o.closeS === undefined ? 1 : Math.max(0, Math.min(1, (o.closeS - (t + o.startS)) / 0.03));
    const p = Math.exp(-t / o.tauS);
    const amp = (p > pc ? p : pc * (p / pc) ** 2) * open * close;
    const peak = (p > pc ? 1 : Math.sqrt(p / pc)) * o.peakHz * o.scale + 160;
    const k = 1 - Math.exp((-TAU * peak) / rate);
    l1 += k * (pink[i] - l1);
    l2 += k * (l1 - l2);
    h += hp * (l2 - h);
    s += wall * ((l2 - h) - s);
    rumble += rumbleK * (pink[i] - rumble);
    out[i] += (s * 3.2 + rumble * 1.4) * amp * o.amp;
  }
}

/** Transformer magnetostriction hum: twice line frequency, plus harmonics. */
function hum(out: Float32Array, rate: number, env: (t: number) => number, scale: number, amp: number): void {
  const parts = [[100, 1], [200, 0.45], [300, 0.25], [400, 0.12]] as const;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const e = env(t);
    if (e <= 0) continue;
    let v = 0;
    for (const [hz, g] of parts) v += Math.sin(TAU * hz * scale * t) * g;
    out[i] += v * e * amp;
  }
}

/**
 * Render a mechanism one-shot, or null if `gesture` is not one of ours.
 * Layer knobs keep their meaning: body = heavy structural contacts,
 * texture = flow / friction / electrical, detail = small bright contacts.
 * Brightness shortens contact times (harder contacts reach higher modes).
 */
export function renderMechanism(gesture: string, recipe: Recipe, n: number, rate: number): Float32Array | null {
  const rng = random(recipe.seed ^ 0x51ed270b);
  const scale = 2 ** (recipe.pitch / 12);
  const hard = 1.6 - recipe.brightness; // contact-time multiplier
  const body = new Float32Array(n), texture = new Float32Array(n), detail = new Float32Array(n);
  const jitter = (s: number) => (rng() - 0.5) * s;
  const S = (f: number[], t: number[], w: number[]) => new Structure(rate, n, f, t, w);

  switch (gesture as MechanismGesture) {
    case "vent":
    case "purge": {
      // Cartridge valve: solenoid plunger seats, then the charge blows down.
      const big = gesture === "purge";
      const valve = S([190, 520, 1010, 1840], [0.12, 0.08, 0.05, 0.03], [1, 0.6, 0.35, 0.2]);
      valve.strike(0.004, 0.0012 * hard, 1);
      valve.render(body, 1, scale);
      blowdown(texture, rate, pinkNoise(n, rng), {
        startS: 0.012, openS: big ? 0.04 : 0.025, tauS: big ? 0.48 : 0.24,
        peakHz: big ? 1100 : 1500, amp: 1, scale,
      });
      // The empty line knocks once as the pressure wave reflects.
      const line = S([310, 870, 1650], [0.09, 0.06, 0.04], [1, 0.5, 0.3]);
      line.strike((big ? 0.09 : 0.06) + jitter(0.01), 0.0008 * hard, 0.25);
      line.render(detail, 1, scale);
      break;
    }
    case "relay": {
      // Contactor re-arming the cutter's power stage: armature strike, two
      // bounces of decaying energy, then the magnetising inrush hum.
      const armature = S([1150, 2900, 5200, 8100], [0.04, 0.025, 0.015, 0.01], [1, 0.7, 0.45, 0.25]);
      const frame = S([310, 840], [0.06, 0.04], [1, 0.5]);
      // Bounce timing and energy differ on every real closure.
      for (const [dt, a] of [[0, 1], [0.0022, 0.35], [0.0039, 0.12]] as const) {
        const at = 0.005 + dt * (0.8 + rng() * 0.4);
        const e = a * (dt === 0 ? 1 : 0.7 + rng() * 0.6);
        armature.strike(at, 0.00025 * hard, e);
        frame.strike(at, 0.00025 * hard, e * 0.6);
      }
      armature.render(detail, 1, scale);
      frame.render(body, 1, scale);
      hum(texture, rate, (t) => t < 0.007 ? 0 : (1 - Math.exp(-(t - 0.007) / 0.006)) * Math.exp(-(t - 0.007) / 0.09), scale, 0.35);
      break;
    }
    case "unlatch": {
      // Module release: pawl lets go, the latch arm springs, the module slides
      // out along its rails (stick-slip), and stops against the cradle.
      const pawl = S([1700, 4300, 7600], [0.03, 0.02, 0.012], [1, 0.6, 0.3]);
      pawl.strike(0.004, 0.0003 * hard, 0.7);
      pawl.strike(0.011 + jitter(0.002), 0.0002 * hard, 0.35);
      pawl.render(detail, 1, scale);
      const rail = S([260, 710, 1390, 2300], [0.05, 0.04, 0.03, 0.02], [1, 0.7, 0.45, 0.25]);
      rail.scrape(0.05, 0.24, (u) => 140 - 80 * u, (u) => 0.15 * Math.sin(Math.PI * u) ** 0.5, rng);
      rail.render(texture, 1, scale);
      const cradle = S([120, 330, 640], [0.12, 0.08, 0.05], [1, 0.55, 0.3]);
      cradle.strike(0.27 + jitter(0.015), 0.0015 * hard, 0.6);
      cradle.render(body, 1, scale);
      break;
    }
    case "jettison": {
      // Hold door actuator, the clamp letting go of the container, a short
      // ejector charge, the container dragging out along its rails, and the
      // last rail joint. After that it is in vacuum and nothing is heard.
      const door = S([85, 230, 470, 910], [0.25, 0.15, 0.09, 0.05], [1, 0.6, 0.35, 0.2]);
      door.strike(0.006, 0.0012 * hard, 1);
      door.strike(0.47 + jitter(0.03), 0.0018 * hard, 0.3);
      door.render(body, 1, scale);
      const clamp = S([310, 860, 1690, 2780], [0.35, 0.22, 0.14, 0.08], [1, 0.65, 0.4, 0.25]);
      clamp.strike(0.09 + jitter(0.01), 0.0004 * hard, 0.7);
      clamp.render(detail, 1, scale);
      blowdown(texture, rate, pinkNoise(n, rng), { startS: 0.1, openS: 0.012, tauS: 0.1, peakHz: 900, amp: 0.8, scale });
      const rail = S([260, 710, 1390, 2300], [0.05, 0.04, 0.03, 0.02], [1, 0.7, 0.45, 0.25]);
      rail.scrape(0.12, 0.45, (u) => 220 - 130 * u, (u) => 0.22 * (1 - u) ** 1.5, rng);
      rail.render(texture, 1, scale);
      break;
    }
    case "repair": {
      // Patch applicator: seats on the panel, injects sealant (a low-pressure
      // blowdown whose valve closes), then clamps the patch in three strikes
      // and the panel flexes as it settles.
      const applicator = S([150, 410, 820], [0.1, 0.07, 0.04], [1, 0.55, 0.3]);
      applicator.strike(0.006, 0.001 * hard, 0.7);
      applicator.strike(0.76, 0.0006 * hard, 0.25); // sealant valve closes
      applicator.render(body, 1, scale);
      blowdown(texture, rate, pinkNoise(n, rng), {
        startS: 0.05, openS: 0.05, tauS: 0.9, peakHz: 600, amp: 0.55, closeS: 0.75, scale,
      });
      const panel = S([420, 1160, 2270, 3750], [0.18, 0.12, 0.07, 0.04], [1, 0.65, 0.4, 0.2]);
      const flex = S([95], [0.3], [1]);
      const clampTimes = [0.85, 1.03, 1.2].map((t) => t + jitter(0.03));
      clampTimes.forEach((t, k) => panel.strike(t, 0.00035 * hard, [0.8, 0.75, 0.9][k]));
      flex.strike(clampTimes[2] + 0.04, 0.004, 0.5);
      panel.render(detail, 1, scale);
      flex.render(body, 1, scale);
      break;
    }
    case "boot": {
      // Systems restart after respawn. Main bus contactor, magnetising inrush
      // that settles to a steady hum, the avionics contactor and a ripple of
      // relays, and cooling fans spinning up. Fan sound power goes as rpm⁵
      // (fan law), so amplitude as rpm^2.5; blade-pass = 7 blades × rpm/60.
      const main = S([70, 190, 370, 720], [0.3, 0.2, 0.12, 0.07], [1, 0.6, 0.35, 0.2]);
      main.strike(0.02, 0.0015 * hard, 1);
      main.strike(0.023, 0.0012 * hard, 0.3);
      main.render(body, 1, scale);
      const avionics = S([160, 430, 900], [0.12, 0.08, 0.05], [1, 0.55, 0.3]);
      avionics.strike(0.55 + jitter(0.03), 0.001 * hard, 0.5);
      avionics.render(body, 1, scale);
      const relays = S([1150, 2900, 5200], [0.04, 0.025, 0.015], [1, 0.6, 0.35]);
      for (let k = 0; k < 4; k++) relays.strike(0.68 + k * 0.06 + jitter(0.04), 0.00025 * hard, 0.3 + rng() * 0.25);
      relays.render(detail, 1, scale);
      hum(texture, rate, (t) => t < 0.025 ? 0 : 0.35 + 0.65 * Math.exp(-(t - 0.025) / 0.25), scale, 0.3);
      const pink = pinkNoise(n, rng);
      const rpmMax = 3200, blades = 7;
      let phase = 0, l1 = 0, l2 = 0, h = 0;
      const hp = 1 - Math.exp((-TAU * 120) / rate);
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const spin = t < 0.3 ? 0 : 1 - Math.exp(-(t - 0.3) / 0.9);
        phase += (TAU * blades * rpmMax * spin * scale) / 60 / rate;
        const level = spin ** 2.5;
        const k = 1 - Math.exp((-TAU * (200 + 1400 * spin)) / rate);
        l1 += k * (pink[i] - l1);
        l2 += k * (l1 - l2);
        h += hp * (l2 - h);
        texture[i] += ((l2 - h) * 1.6 + (Math.sin(phase) + 0.4 * Math.sin(2 * phase)) * 0.06) * level;
      }
      // End on the running state, not a cut: the last 0.5 s eases out.
      const tail = Math.round(0.5 * rate);
      for (let i = Math.max(0, n - tail); i < n; i++) {
        const f = (n - i) / tail;
        texture[i] *= f * f * (3 - 2 * f);
      }
      break;
    }
    default:
      return null;
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = body[i] * recipe.body + texture[i] * recipe.texture + detail[i] * recipe.detail;
  return out;
}

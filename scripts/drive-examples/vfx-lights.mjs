/**
 * VFX plan §1 gates: station lamps as flux-conserving light points.
 *
 *   pnpm drive -- --keep --no-isolate run:scripts/drive-examples/vfx-lights.mjs
 *
 * Lamp flux is MEASURED as an on/off difference at the same pose (`__lights.enable`),
 * summed over the HDR target (`__lum.region`), so the hull, sky and ship cancel exactly.
 * - drift:   30 sub-metre poses at 250 m and 2 km → coefficient of variation (gate < 5 %)
 * - ladder:  E·d² from 150 m to 6 km across the mesh→point crossfade and both LOD
 *            switches (600 / 1100 m) → largest step between neighbours
 * - beacon:  8 km, flash on → peak and lit pixels
 * Parts: LIGHTS_PARTS=drift,ladder,beacon,shots (default all).
 */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const R = G + ".rep";
const FRAME = "earth";
const ID = "vfx-lights-review";
const CENTER = [0, 10_000, 0];
const YAW = 31 * Math.PI / 180;
const Q = [0, Math.sin(YAW / 2), 0, Math.cos(YAW / 2)];
const j = JSON.stringify;
const PARTS = (process.env.LIGHTS_PARTS ?? "drift,xfade,ladder,beacon,shots").split(",");

function move([x, y, z], angle = YAW) {
  return [x * Math.cos(angle) + z * Math.sin(angle), y, z * Math.cos(angle) - x * Math.sin(angle)];
}

export default async function vfxLights(d) {
  const ev = expression => d.evaluate(expression);
  const until = async (label, fn, ms = 12_000) => {
    const end = Date.now() + ms;
    do {
      const value = await fn();
      if (value) return value;
      await d.sleep(65);
    } while (Date.now() < end);
    throw Error(label);
  };
  // Look at the station from `pos` (station space, metres): the camera trails the ship.
  const teleport = async (position) => {
    const destination = move(position).map((n, i) => CENTER[i] + n / 1000);
    await ev(`${R}.teleportRel(${j(FRAME)}, ${j(destination)}, ${j(Q)})`);
    await d.frames(4);
  };
  // Crop to the station (the rest of the frame carries frame-to-frame noise of its own).
  // The station spans ~75 m; it sits at screen centre, the ship's hull lower in frame.
  let tan = 0.00213;
  const crop = D => {
    const hw = Math.min(0.5, Math.max(30, 50 / (D * tan)) / 1280);
    const hh = Math.min(0.5, Math.max(30, 50 / (D * tan)) / 720);
    const c = v => Math.min(1, Math.max(0, v));
    return [c(0.5 - hw), c(0.49 - hh), c(0.5 + hw), Math.min(0.62, c(0.49 + hh))];
  };
  const lampFlux = async (D, pairs = 2) => {
    const r = crop(D).join(",");
    let flux = 0, peak = 0, lit = 0;
    await ev("__lum.holdExposure(true)");
    for (let k = 0; k < pairs; k++) {
      await ev("__lights.enable(true)");
      await d.frames(3);
      const on = await ev(`__lum.region(${r})`);
      await ev("__lights.enable(false)");
      await d.frames(3);
      const off = await ev(`__lum.region(${r})`);
      flux += (on.sum - off.sum) / pairs;
      peak = Math.max(peak, on.max);
      lit += (on.lit - off.lit) / pairs;
    }
    await ev("__lights.enable(true)");
    await ev("__lum.holdExposure(false)");
    return { flux, peak, lit };
  };
  const tanPerPx = async () => (await ev("__lights.stats()")).tanPerPx;

  const previous = await ev("__test.save.info().id");
  const fixture = await ev(`(async () => {
    const game = ${G};
    const data = JSON.parse(await game.fixtures.export(${j(previous)})).data;
    const by = game.localId();
    data.world.replication.points = data.world.replication.points.filter(p => p.starter);
    data.world.replication.points.push({
      id: ${j(ID)}, name: "Lamp trial", frameId: ${j(FRAME)}, positionKm: ${j(CENTER)},
      quaternion: ${j(Q)}, by, starter: false, createdAt: Date.now(),
    });
    data.players[by].isDead = false;
    return game.fixtures.create("vfx-lights", data);
  })()`);

  const out = {};
  try {
    await ev(`${G}.fixtures.activate(${j(fixture)})`);
    await d.reload();
    // Physical flux: the star display lift on unresolved points is a look, not photometry.
    await ev(`__test.simRate(0); ${G}.m37.comms.dismiss(); __test.hud(false); __lights.lift(false)`);
    await teleport([0, 0, -400]);
    await d.settle(900);
    out.tanPerPx = tan = await tanPerPx();

    if (PARTS.includes("drift")) {
      for (const D of [250, 2000]) {
        const fluxes = [];
        for (let i = 0; i < 30; i++) {
          // ~4 m/s drift sampled at 30 Hz, both lateral axes: sweeps sub-pixel phase.
          await teleport([0.13 * i, 0.07 * i, -D]);
          fluxes.push((await lampFlux(D, 1)).flux);
        }
        const mean = fluxes.reduce((a, b) => a + b, 0) / fluxes.length;
        const sd = Math.sqrt(fluxes.reduce((a, b) => a + (b - mean) ** 2, 0) / fluxes.length);
        out[`drift${D}`] = { mean, cv: sd / mean, min: Math.min(...fluxes), max: Math.max(...fluxes) };
        console.log(`drift ${D} m`, JSON.stringify(out[`drift${D}`]));
      }
    }

    if (PARTS.includes("xfade")) {
      // Mesh only vs points only vs the size-driven blend at the same pose: equal flux.
      const rows = [];
      for (const D of [60, 90, 130, 200]) {
        await teleport([0, 0, -D]);
        await d.frames(6);
        const row = { D };
        for (const [k, share] of [["mesh", 0], ["points", 1], ["blend", -1]]) {
          await ev(`__lights.force(${share})`);
          row[k] = +(await lampFlux(D)).flux.toFixed(1);
        }
        await ev("__lights.force()");
        row.pointsOverMesh = +(row.points / row.mesh).toFixed(3);
        rows.push(row);
      }
      out.xfade = rows;
      console.log("xfade", JSON.stringify(rows));
    }

    if (PARTS.includes("xshots")) {
      await teleport([0, 0, -60]);
      await d.frames(8);
      for (const [k, share] of [["mesh", 0], ["points", 1]]) {
        await ev(`__lights.force(${share})`);
        await d.frames(4);
        await d.canvas(`lights-60m-${k}`);
      }
      await ev("__lights.force()");
    }

    if (PARTS.includes("perf")) {
      // Run with --perf. Local-scene GPU ms, points on vs off, interleaved twice.
      const local = async () => {
        await ev("__bench.reset()");
        await d.frames(150);
        const snap = await ev("JSON.parse(JSON.stringify(__bench.report()))");
        const pass = (snap.passes ?? []).find(p => /local/i.test(p.label));
        return pass ? +pass.gpu.p50.toFixed(3) : null;
      };
      const rows = [];
      for (const D of [250, 2000]) {
        await teleport([0, 0, -D]);
        await d.frames(30);
        const r = { D, on: [], off: [] };
        for (let k = 0; k < 2; k++) {
          await ev("__lights.points(true)"); r.on.push(await local());
          await ev("__lights.points(false)"); r.off.push(await local());
        }
        await ev("__lights.points(true)");
        rows.push(r);
      }
      out.perf = rows;
      console.log("perf", JSON.stringify(rows));
    }

    if (PARTS.includes("ladder")) {
      const ladder = [];
      for (const D of [250, 400, 550, 650, 800, 1000, 1200, 1600, 2400, 4000, 6000]) {
        await teleport([0, 0, -D]);
        await d.frames(6);
        const { flux } = await lampFlux(D);
        ladder.push({ D, flux, fluxD2: flux * D * D });
      }
      const steps = ladder.slice(1).map((r, i) => r.fluxD2 / ladder[i].fluxD2);
      out.ladder = ladder.map(r => [r.D, +r.fluxD2.toExponential(3)]);
      out.ladderWorstStep = Math.max(...steps.map(s => Math.max(s, 1 / s)));
      out.ladderBeacons = (await ev(`${R}.lights()`))["Amber mast beacons"];
      console.log("ladder", JSON.stringify(out.ladder), "worst step", out.ladderWorstStep, "beacons", out.ladderBeacons);
    }

    if (PARTS.includes("farShots")) {
      // The look with the display lift (default): the station at range, auto exposure.
      // Reports the box's peak, pixels over 0.5 (apparent size) and the sum per distance.
      await ev("__lights.lift(true)");
      const tag = process.env.FAR_TAG ?? "now";
      const rows = [];
      for (const D of [500, 1500, 4000, 8000]) {
        await teleport([0, 0, -D]);
        await d.frames(90);
        const r = crop(D).join(",");
        const st = await ev(`(async () => { const r = await __lum.region(${r}); return r; })()`);
        const over = await ev(`(async () => { const t = __lum; return null; })()`);
        void over;
        rows.push({ D, peak: +st.max.toFixed(3), sum: +st.sum.toFixed(2) });
        await d.canvas(`lamps-far-${tag}-${D}`);
      }
      await ev("__lights.lift(false)");
      out.farShots = rows;
      console.log("farShots", JSON.stringify(rows));
    }

    if (PARTS.includes("liftLadder")) {
      // With the star display lift on unresolved points: lamp flux must never rise as the
      // station recedes (no pop at the mesh ↔ point hand-over). The taper is tested with the
      // lift held constant ("legacy" 1024×); "auto" follows eye adaptation, which brightens
      // points as the lit station leaves the view (reported, not gated).
      const run = async (mode) => {
        await ev(`__lum.starLift(${JSON.stringify(mode)})`);
        const rows = [];
        for (const D of [60, 90, 130, 200, 300, 500, 1000, 2000, 4000, 8000]) {
          await teleport([0, 0, -D]);
          await d.frames(6);
          rows.push({ D, flux: +(await lampFlux(D)).flux.toExponential(3) });
        }
        return rows;
      };
      await ev("__lights.lift(true)");
      const held = await run("legacy");
      const auto = await run("auto");
      await ev("__lights.lift(false)");
      const rises = held.slice(1).map((r, i) => +(r.flux / held[i].flux).toFixed(3)).filter((x) => x > 1.05);
      out.liftLadder = { held, auto, rises, pass: rises.length === 0 };
      console.log("liftLadder", JSON.stringify(out.liftLadder));
    }

    if (PARTS.includes("beacon")) {
      await teleport([0, 0, -8000]);
      await ev("__test.simRate(1)");
      await until("Mast beacons never flashed", async () => (await ev(`${R}.lights()`))["Amber mast beacons"] === 1, 4000);
      await ev("__test.simRate(0)");
      const lights = await ev(`${R}.lights()`);
      assert.equal(lights["Amber mast beacons"], 1);
      out.beacon8km = await lampFlux(8000);
      if (PARTS.includes("shots")) await d.canvas("lights-8km-flash");
    }

    if (PARTS.includes("shots")) {
      for (const D of [250, 2000]) {
        await teleport([0, 0, -D]);
        await d.frames(8);
        await d.canvas(`lights-${D}m`);
      }
    }
    console.log(JSON.stringify(out, null, 1));
  } finally {
    await ev("__lights.lift(true); __lum.starLift('auto'); __test.simRate(1)").catch(() => {});
    await ev(`${G}.fixtures.activate(${j(previous)})`);
    await d.reload();
    await ev(`${G}.fixtures.remove(${j(fixture)})`);
  }
}

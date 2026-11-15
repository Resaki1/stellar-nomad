/**
 * Reference-frame exit gates (ROADMAP M0.2) for scripts/drive.mjs.
 *
 *   FRAMES_PARTS=ride,switch,asteroids,transit pnpm drive -- --keep run:scripts/drive-examples/frames-check.mjs
 *
 * Parts (default: all; split them to stay under a few minutes per run):
 *   ride       ship parked 500 km above Luna / Earth at rate 1e4 and 1: frame, bit-identical
 *              relative position, absolute distance constant; per-frame no-lag spread
 *   switch     fly across Luna's SOI both ways: absolute continuity + no flapping in the band
 *   asteroids  parked in the origin belt at rate 1 and 1e4: offset to Earth constant, same rocks
 *   transit    autopilot → Luna at rate 1: arrival distance vs intended standoff
 */
const len = (a) => Math.hypot(...a);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const same = (a, b) => a.every((v, i) => v === b[i]);

export default async function framesCheck(d) {
  const ev = (js) => d.evaluate(js);
  const wait = (ms) => ev(`new Promise(r => setTimeout(r, ${ms}))`);
  const rate = (r) => ev(`__test.simRate(${r})`);
  const dist = async (body) => (await ev(`__test.sampleOffsets(${JSON.stringify(body)}, 1)`)).distKm.min;
  const parts = (process.env.FRAMES_PARTS ?? "ride,switch,asteroids,transit").split(",");
  const out = {};

  async function ride(body, altKm, r) {
    await rate(0);
    await d.scene(`${body}:${altKm}`);
    await d.frames(10);
    await rate(r);
    await d.frames(3);
    const s0 = (await d.state()).ship;
    const d0 = await dist(body);
    await wait(5000);
    const s1 = (await d.state()).ship;
    const d1 = await dist(body);
    const lag = await ev(`__test.sampleOffsets(${JSON.stringify(body)}, 120)`);
    await rate(0);
    return {
      body, rate: r,
      frameId: s1.frameId,
      relBitIdentical: same(s0.relPosKm, s1.relPosKm),
      absMovedKm: +len(sub(s1.posKm, s0.posKm)).toFixed(1),
      distKm: +d0.toFixed(6),
      distDriftKm: Math.abs(d1 - d0),
      lag: {
        n: lag.n,
        frameIds: lag.frameIds,
        distSpreadKm: lag.distSpreadKm,
        maxComponentSpreadKm: lag.maxComponentSpreadKm,
        bodyMoveKmPerFrame: +lag.bodyMoveKmPerFrame.toFixed(4),
      },
      pass:
        s1.frameId === body && same(s0.relPosKm, s1.relPosKm) && Math.abs(d1 - d0) < 1e-3 &&
        lag.maxComponentSpreadKm < 1e-3,
    };
  }

  if (parts.includes("ride")) {
    out.ride = [
      await ride("luna", 500, 1e4),
      await ride("earth", 500, 1e4),
      await ride("luna", 500, 1),
    ];
  }

  if (parts.includes("switch")) {
    const soi = (await ev("__test.frameList()")).find((f) => f.id === "luna").soiKm;
    const lunaR = 1737;
    /** Fly at `kmps` until distance to Luna crosses `stopKm`, then cut speed. Returns the track. */
    async function fly(kmps, stopKm, outward) {
      await ev(`__bench.maxSpeed(${kmps * 1000})`);
      await ev("void (window.__trk = __test.track(4000))");
      await d.hold("w", 1500);
      for (let i = 0; i < 600; i++) {
        const r = await dist("luna");
        if (outward ? r >= stopKm : r <= stopKm) break;
        await wait(20);
      }
      await ev("__bench.maxSpeed(0)");
      await d.hold("s", 1500);
      await d.frames(5);
      await ev("__test.frames(1)");
      await ev("__test.trackStop()");
      return ev("window.__trk");
    }
    function continuity(track) {
      let switchIdx = -1;
      const perStep = [];
      for (let i = 1; i < track.length; i++) {
        const steps = track[i].steps - track[i - 1].steps;
        const m = len(sub(track[i].absKm, track[i - 1].absKm));
        if (track[i].frameId !== track[i - 1].frameId) switchIdx = i;
        perStep.push({ i, steps, kmPerStep: steps > 0 ? m / steps : null, jumpKm: steps === 0 ? m : 0 });
      }
      const sw = perStep.find((p) => p.i === switchIdx);
      const near = perStep.filter((p) => Math.abs(p.i - switchIdx) <= 5 && p.i !== switchIdx && p.kmPerStep);
      const ref = near.length ? near.reduce((a, p) => a + p.kmPerStep, 0) / near.length : null;
      const switches = track.filter((t, i) => i > 0 && t.frameId !== track[i - 1].frameId).length;
      return {
        frames: track.length,
        switches,
        from: switchIdx > 0 ? track[switchIdx - 1].frameId : null,
        to: switchIdx > 0 ? track[switchIdx].frameId : null,
        kmPerStepAtSwitch: sw?.kmPerStep ?? null,
        kmPerStepNeighbours: ref,
        maxZeroStepJumpKm: Math.max(0, ...perStep.map((p) => p.jumpKm)),
      };
    }
    await rate(0);
    // Outward: start inside at 0.98 SOI facing away; park in the band, then cross 1.1.
    await d.scene(`luna:${0.98 * soi - lunaR}:up`);
    await d.frames(10);
    const startFrame = (await d.state()).ship.frameId;
    const band1 = await fly(800, 1.05 * soi, true);
    const parkedR = await dist("luna");
    const parked = (await d.state()).ship;
    await rate(1e4);
    await wait(3000);
    const parkedAfter = (await d.state()).ship;
    await rate(0);
    const cross1 = await fly(800, 1.12 * soi, true);
    const afterOut = (await d.state()).ship;
    // Inward: start in Earth's frame at 1.15 SOI facing Luna; park in the band, then cross 1.0.
    await d.scene(`luna:${1.15 * soi - lunaR}:body`);
    await d.frames(10);
    const startIn = (await d.state()).ship.frameId;
    const band2 = await fly(800, 1.05 * soi, false);
    const parkedIn = (await d.state()).ship;
    const parkedInR = await dist("luna");
    // Rate 1, not 1e4: parked in EARTH's frame, Luna moves ~1e4 km/s relative to the ship at
    // 1e4 and legitimately sweeps its SOI over it (one real entry, not a flap).
    await rate(1);
    await wait(3000);
    const parkedInAfter = (await d.state()).ship;
    await rate(0);
    const cross2 = await fly(800, 0.97 * soi, false);
    const afterIn = (await d.state()).ship;
    await ev("__bench.maxSpeed(null)");
    out.switch = {
      soiKm: soi,
      outward: {
        startFrame,
        bandTrack: continuity(band1),
        parkedAtSoi: +(parkedR / soi).toFixed(4),
        parkedFrame: parked.frameId,
        parkedFrameAfter3sAt1e4: parkedAfter.frameId,
        switchesWhileParked: parkedAfter.frameSwitches - parked.frameSwitches,
        cross: continuity(cross1),
        endFrame: afterOut.frameId,
      },
      inward: {
        startFrame: startIn,
        bandTrack: continuity(band2),
        parkedAtSoi: +(parkedInR / soi).toFixed(4),
        parkedFrame: parkedIn.frameId,
        switchesWhileParked: parkedInAfter.frameSwitches - parkedIn.frameSwitches,
        cross: continuity(cross2),
        endFrame: afterIn.frameId,
      },
    };
    await d.scene("luna:500");
  }

  if (parts.includes("asteroids")) {
    const res = [];
    for (const r of [1, 1e4]) {
      await rate(0);
      await d.scene("belt");
      await d.settle(1500);
      await rate(r);
      await d.frames(3);
      const d0 = await dist("earth");
      const s0 = (await d.state()).ship;
      await d.canvas(`frames_belt_${r}_a`);
      await wait(5000);
      await d.canvas(`frames_belt_${r}_b`);
      const s1 = (await d.state()).ship;
      const d1 = await dist("earth");
      await rate(0);
      res.push({
        rate: r,
        frameId: s1.frameId,
        relBitIdentical: same(s0.relPosKm, s1.relPosKm),
        earthDistDriftKm: Math.abs(d1 - d0),
        absMovedKm: +len(sub(s1.posKm, s0.posKm)).toFixed(1),
        image: d.compare(`frames_belt_${r}_a`, `frames_belt_${r}_b`),
      });
    }
    out.asteroids = res;
  }

  if (parts.includes("transit")) {
    // From the spawn belt, Earth sits between the ship and Luna at the default epoch and the
    // auto-brake stops the drive at Earth, so start 100,000 km above Luna (Earth's frame):
    // the run also crosses into Luna's SOI with the drive engaged.
    if (await ev("!!document.querySelector('.death-screen__respawn')")) {
      await ev("document.querySelector('.death-screen__respawn').click()");
      await d.frames(10);
    }
    await rate(0);
    await d.scene("luna:100000");
    await d.frames(30);
    const startFrame = (await d.state()).ship.frameId;
    const transitRate = Number(process.env.FRAMES_TRANSIT_RATE ?? 1);
    await rate(transitRate);
    const eng = await ev('__test.transitTo("luna")');
    const t0 = Date.now();
    let phase = "accelerating";
    while (Date.now() - t0 < 120_000) {
      phase = (await d.state()).transit.phase;
      if (phase === "idle") break;
      await wait(250);
    }
    const arrivedKm = await dist("luna");
    const s = (await d.state()).ship;
    await rate(0);
    out.transit = {
      rate: transitRate,
      startFrame,
      dead: await ev("!!document.querySelector('.death-screen__respawn')"),
      engaged: eng.engaged,
      endPhase: phase,
      seconds: Math.round((Date.now() - t0) / 1000),
      intendedStandoffKm: eng.arrivalOffsetKm,
      arrivedDistKm: +arrivedKm.toFixed(1),
      errorKm: +(arrivedKm - eng.arrivalOffsetKm).toFixed(1),
      frameId: s.frameId,
      frameSwitches: s.frameSwitches,
    };
  }
  return out;
}

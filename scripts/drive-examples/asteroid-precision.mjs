/**
 * Asteroid render precision (close-range jitter) gates for scripts/drive.mjs.
 *
 *   PREC_PARTS=error,tiers,visual pnpm -s drive -- --keep reload run:scripts/drive-examples/asteroid-precision.mjs
 *
 * error:  __phys.asteroids.renderError (f32 model of the drawn centre vs f64 truth) at the default
 *         start (5 m/s and 400 m/s drift), parked 30 m from a rock, and deep in luna_belt; plus a
 *         GPU read-back of each tier's output vs the f32 model (gpuCheck).
 * tiers:  visible instances per tier at three fixed poses.
 * visual: captures jitter-near-a/b, jitter-field, jitter-far.
 */
const parts = (process.env.PREC_PARTS ?? "error,tiers,visual").split(",");
const LUNA_OFFSET_KM = [1200, 300, -1200];
const TOL_M = 0.001;

export default async function asteroidPrecision(d) {
  const ev = (js) => d.evaluate(js);
  const out = {};
  await ev("__test.simRate(0)");
  // Collisions while drifting must not kill the ship mid-measurement.
  await ev("__phys.tuning.set({ noDamageSpeedMps: 1e5, lethalSpeedMps: 2e5 })");
  if (await ev("__phys.game.isDead()")) await ev("__phys.game.respawn()");

  /** Wait until `n` rocks are loaded and drawn by the near tier. */
  const waitRocks = async (n = 5) => {
    for (let k = 0; k < 60; k++) {
      await d.frames(20);
      const rs = await ev(`__phys.asteroids.nearest(${n})`);
      if (rs.length >= n && rs.every((r) => r.rendered)) return rs;
    }
    throw new Error("rocks never loaded");
  };
  const atStart = async () => {
    await d.scene("belt");
    await d.frames(30);
    return waitRocks();
  };
  const inLuna = async () => {
    await ev(`__phys.asteroids.warpToField("luna_belt", ${JSON.stringify(LUNA_OFFSET_KM)})`);
    await d.frames(30);
    return waitRocks();
  };
  const err = (n, frames, mps) => ev(`__phys.asteroids.renderError(${n}, ${frames}, ${mps})`);
  const summary = (r) => ({
    within8kmMaxM: Math.max(0, ...r.rocks.filter((k) => k.surfaceDistM < 8192).map((k) => Math.max(k.maxErrM, k.maxJitterM))), maxErrM: r.maxErrM, maxJitterM: r.maxJitterM, movedM: +r.movedM.toFixed(2), samples: r.samples, nearestSurfaceM: +r.rocks[0].surfaceDistM.toFixed(1),
    perRock: r.rocks.map((k) => `${(k.surfaceDistM / 1000).toFixed(2)}km err ${(k.maxErrM * 1000).toFixed(3)}mm jit ${(k.maxJitterM * 1000).toFixed(3)}mm`) });

  if (parts.includes("error")) {
    const rows = {};
    await atStart();
    rows.start_5mps = summary(await err(5, 240, 5));
    await atStart();
    rows.start_400mps = summary(await err(5, 240, 400));
    await atStart();
    const gpuTiers = async () => ({
      near: await ev('__phys.asteroids.gpuCheck(5, "near")'),
      mid: await ev('__phys.asteroids.gpuCheck(5, "mid")'),
      far: await ev('__phys.asteroids.gpuCheck(5, "far")'),
    });
    rows.start_gpu = await gpuTiers();
    // Parked 30 m from a rock, drifting sideways.
    const rock = (await ev("__phys.asteroids.nearest(50)")).find((r) => r.radiusM >= 15 && r.radiusM <= 150);
    await ev(`__phys.asteroids.standoff(${rock.instanceId}, 30)`);
    await d.frames(30);
    rows.near30m_5mps = summary(await err(5, 240, 5));
    await inLuna();
    rows.luna_5mps = summary(await err(5, 240, 5));
    await inLuna();
    rows.luna_400mps = summary(await err(5, 240, 400));
    await inLuna();
    rows.luna_gpu = await gpuTiers();
    const meas = Object.values(rows).filter((r) => r.maxErrM !== undefined);
    const gpuSets = [rows.start_gpu, rows.luna_gpu].flatMap((p) => [p.near, p.mid, p.far]);
    const gpuNear = [...rows.start_gpu.near, ...rows.luna_gpu.near];
    out.error = {
      ...rows,
      worstErrM: Math.max(...meas.map((r) => r.maxErrM)), worstJitterM: Math.max(...meas.map((r) => r.maxJitterM)),
      worstNearGpuVsTruthM: Math.max(...gpuNear.map((g) => g.gpuVsTruthM)),
      // The CPU f32 model must match the GPU output bit-exactly in every tier and pose.
      gpuMatchesModel: gpuSets.every((s) => s.length >= 2 && s.every((g) => g.gpuVsModelM === 0)),
      // Beyond 8192 m the f32 output's own ulp is 0.98 mm, so 1 mm is only reachable closer in.
      passWithin8km: meas.every((r) => r.within8kmMaxM < TOL_M),
      // Strict brief gate (5 nearest, any distance); passWithin8km is the relaxed one and needs owner sign-off.
      pass: meas.every((r) => r.maxErrM < TOL_M && r.maxJitterM < TOL_M && r.samples > 0) && gpuNear.every((g) => g.gpuVsTruthM < TOL_M),
    };
  }

  if (parts.includes("tiers")) {
    const stable = async () => {
      let prev = null;
      for (let k = 0; k < 40; k++) {
        await d.frames(30);
        const c = await ev("__phys.asteroids.tierCounts()");
        if (prev && c.near === prev.near && c.mid === prev.mid && c.far === prev.far) return c;
        prev = c;
      }
      return { ...prev, unstable: true };
    };
    const poses = {};
    await d.scene("belt");
    await waitRocks();
    poses.start = await stable();
    await ev('__phys.asteroids.warpToField("origin_belt", [-2000, 0, 0])');
    await waitRocks();
    poses.belt_2000km = await stable();
    await inLuna();
    poses.luna = await stable();
    out.tiers = poses;
  }

  if (parts.includes("visual")) {
    await atStart();
    const rock = (await ev("__phys.asteroids.nearest(50)")).find((r) => r.radiusM >= 15 && r.radiusM <= 80);
    await ev(`__phys.asteroids.standoff(${rock.instanceId}, 30)`);
    await d.frames(60);
    await ev("__phys.asteroids.drift(5)");
    await d.frames(10);
    await d.canvas("jitter-near-a");
    await d.frames(4);
    await d.canvas("jitter-near-b");
    await ev("__phys.asteroids.drift(0)");
    const big = (await ev("__phys.asteroids.nearest(200)")).find((r) => r.radiusM >= 150);
    if (big) await ev(`__phys.asteroids.standoff(${big.instanceId}, 1500)`);
    await d.frames(120);
    await d.canvas("jitter-field");
    // Toward the field centre from 1000 km out: mid (32–64 km) and far (64–512 km) tiers in view.
    await ev('__phys.asteroids.warpToField("origin_belt", [0, 0, -1000])');
    await waitRocks();
    await d.frames(120);
    await d.canvas("jitter-far");
    out.visual = { near: rock.instanceId, big: big?.instanceId ?? null, tiers: await ev("__phys.asteroids.tierCounts()"), captures: ["jitter-near-a", "jitter-near-b", "jitter-field", "jitter-far"] };
  }

  await ev("__phys.tuning.set({ noDamageSpeedMps: 8, lethalSpeedMps: 120 })");
  const tiersOk = !out.tiers || !Object.values(out.tiers).some((p) => p.unstable);
  out.pass = (!out.error || (out.error.pass && out.error.gpuMatchesModel)) && tiersOk;
  out.passWithin8km = (!out.error || (out.error.passWithin8km && out.error.gpuMatchesModel)) && tiersOk;
  return out;
}

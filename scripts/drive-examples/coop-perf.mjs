// Use --perf --four. One renderer and three real WebRTC guests with scripted static poses.
// These are same-machine measurements; the release comparison also uses separate guest devices.
export default async function coopPerf({ host, guest, extraGuests, log }) {
  if (extraGuests.length !== 2) throw Error("Use --perf --four for the host frame comparison");
  const peers = [guest, ...extraGuests];
  await host.load({ perf: 1 }); await host.ready();
  const prev = await host.evaluate("__test.coop.worldId()");
  const world = await host.evaluate('__test.gameplay.fixtures.create("coop-perf","new")');
  const results = {};
  const measure = async label => {
    const row = await host.evaluate(`(async () => {
      const report = await __bench.run("earth_650");
      const r = report.results[0];
      return { frameMs: r.frameMs, cpuMs: r.cpuTotalMs, gpuMs: r.gpuTotalMs, settled: r.settled, frames: r.frames,
        canvas: report.env.canvasPx, git: report.env.gitState, gpuTimers: report.env.gpuTimings };
    })()`);
    results[label] = row; log({ part: label, ...row });
  };
  try {
    await host.evaluate(`__test.gameplay.fixtures.activate(${JSON.stringify(world)})`);
    await host.load({ perf: 1 }); await host.ready();
    await measure("solo");
    const pose = await host.evaluate("__test.state().ship");
    const code = await host.evaluate("__test.coop.host()");
    await host.evaluate('__test.gameplay.submit({type:"time.set",rate:0,epochMs:Date.UTC(2024,3,8,18,17,0)})');
    for (let i = 0; i < 3; i++) {
      await peers[i].load({ title: 1 });
      await peers[i].evaluate(`__test.networkPilot(${JSON.stringify(code)})`);
      if (i === 1) continue;
      for (const near of [true, false]) {
        for (let j = 0; j <= i; j++) {
          const p = near ? { frameId: pose.frameId, positionKm: [pose.relPosKm[0] + (j+1)*0.08, ...pose.relPosKm.slice(1)] }
            : { frameId: "luna", positionKm: [10000 + j,0,0] };
          await peers[j].evaluate(`__test.moveNetworkPilot(${JSON.stringify({ ...p, quaternion: [0,0,0,1] })}); true`);
        }
        await measure("host+" + (i+1) + (near ? "-near" : "-luna"));
      }
    }
    const {timings} = await host.evaluate("__test.coop.hostRecord()");
    return { pass: Object.values(results).every(r => r.frames > 0 && r.gpuTimers), results, timings };
  } finally {
    for (const p of peers) await p.load({ title: 1 }).catch(() => {});
    await host.evaluate("__test.coop.close(false)").catch(() => {});
    if (prev) await host.evaluate(`__test.gameplay.fixtures.activate(${JSON.stringify(prev)})`);
    await host.load({ perf: 1 }); await host.ready();
    await host.evaluate(`__test.gameplay.fixtures.remove(${JSON.stringify(world)})`);
  }
}

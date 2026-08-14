// Validation of audit4_montecarlo_groundtruth.mjs against an analytic reference.
//
// Analytic single-scattering nadir reflectance of a plane-parallel slab,
// collimated normal incidence (mu0 = 1), nadir view (mu = 1), black ground:
//
//   L(0,mu) = (omega*p(Theta)*F0 / 4pi) * [1 - exp(-tau*(1/mu0+1/mu))] / (1/mu0+1/mu)
//   => at mu = mu0 = 1:   pi*L/F0 = omega * p(180) * [1 - exp(-2*tau)] / 8
//
// CONVENTION IS EVERYTHING. This assumes \int p dOmega = 4pi (isotropic => p=1),
// for which Rayleigh p(Theta) = (3/4)(1+cos^2 Theta) and p(180) = 1.5.
// The other convention (\int p dOmega = 1) gives p(180) = 3/(8pi) = 0.1194 —
// smaller by exactly 4pi = 12.566. Mixing them is a 12.6x error, and that is
// precisely the error in the orchestrator's first derivation (0.00271).
//
// THE DECISIVE TEST is `maxScatters = 1`: with the MC restricted to exactly one
// scattering event it computes the SAME quantity as the analytic, so agreement
// validates the ESTIMATOR independently of any multiple-scattering physics.
// Only then is the full-physics run's excess attributable to real higher orders.

const P180_4PI = 1.5;

function analyticSS(tau, omega = 1) {
  return (omega * P180_4PI * (1 - Math.exp(-2 * tau))) / 8;
}

// `maxScatters`: cap on scattering events (Infinity = the original full physics).
function mc(tauMax, omega, N, surfAlb = 0.0, seed = 12345, maxScatters = Infinity) {
  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s >>> 8) / 16777216; };
  const MU_LO = 0.95, dOmega = 2 * Math.PI * (1 - MU_LO), muBar = (1 + MU_LO) / 2;
  let hit = 0, hit2 = 0;
  for (let n = 0; n < N; n++) {
    let tau = 0, mu = -1, phi = 0, w = 1, nsc = 0;
    for (;;) {
      const t = -Math.log(1 - rnd());
      tau += -mu * t;
      if (tau <= 0) { if (mu >= MU_LO) { hit += w; hit2 += w * w; } break; }
      if (tau >= tauMax) {
        if (surfAlb <= 0) break;
        w *= surfAlb; if (w < 1e-4) break;
        tau = tauMax - 1e-9; mu = Math.sqrt(rnd());
        phi = 2 * Math.PI * rnd(); nsc++;
        if (nsc >= maxScatters) break;
        continue;
      }
      w *= omega; nsc++;
      if (w < 1e-4 || nsc > 4000) break;
      const k = 8 * rnd() - 4;
      const disc = Math.sqrt((k * k) / 4 + 1);
      const x = Math.cbrt(k / 2 + disc) + Math.cbrt(k / 2 - disc);
      const cosT = Math.max(-1, Math.min(1, x));
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const psi = 2 * Math.PI * rnd();
      const sinMu = Math.sqrt(Math.max(0, 1 - mu * mu));
      let muN, phiN;
      if (sinMu < 1e-9) { muN = mu > 0 ? cosT : -cosT; phiN = psi; }
      else {
        muN = mu * cosT + sinMu * sinT * Math.cos(psi);
        phiN = phi + Math.atan2(sinT * Math.sin(psi), sinMu * cosT - mu * sinT * Math.cos(psi));
      }
      mu = Math.max(-1, Math.min(1, muN)); phi = phiN;
      if (nsc >= maxScatters) {
        // Let it fly out without scattering again.
        for (;;) {
          const t2 = -Math.log(1 - rnd());
          tau += -mu * t2;
          if (tau <= 0) { if (mu >= MU_LO) { hit += w; hit2 += w * w; } break; }
          if (tau >= tauMax) break;
          break; // would have scattered again -> absorbed by the cap
        }
        break;
      }
    }
  }
  const norm = Math.PI / (muBar * dOmega);
  const f = hit / N;
  // 1-sigma relative error from the weighted second moment.
  const varF = Math.max(0, hit2 / N - f * f) / N;
  return { value: norm * f, rel: f > 0 ? Math.sqrt(varF) / f : Infinity, counted: hit };
}

const N = 4_000_000;

console.log(`SINGLE-SCATTER-ONLY (maxScatters=1), N=${N.toLocaleString()} — validates the ESTIMATOR`);
console.log('tau      analytic_SS   MC            MC/analytic  ±1sigma');
for (const tau of [0.01, 0.03, 0.1, 0.3, 1.0]) {
  const a = analyticSS(tau, 1.0);
  const m = mc(tau, 1.0, N, 0.0, 12345, 1);
  console.log(
    `${tau.toString().padEnd(8)} ${a.toExponential(3).padEnd(13)} ${m.value.toExponential(3).padEnd(13)} ` +
    `${(m.value / a).toFixed(4).padEnd(12)} ${(m.rel * 100).toFixed(2)}%`,
  );
}

console.log(`\nFULL PHYSICS (unbounded orders), N=${N.toLocaleString()} — excess over SS = real multiple scattering`);
console.log('tau      analytic_SS   MC            MC/analytic  ±1sigma');
for (const tau of [0.01, 0.03, 0.1, 0.3]) {
  const a = analyticSS(tau, 1.0);
  const m = mc(tau, 1.0, N, 0.0, 999, Infinity);
  console.log(
    `${tau.toString().padEnd(8)} ${a.toExponential(3).padEnd(13)} ${m.value.toExponential(3).padEnd(13)} ` +
    `${(m.value / a).toFixed(4).padEnd(12)} ${(m.rel * 100).toFixed(2)}%`,
  );
}

console.log('\nThe disputed sanity case, tau=0.1 omega=1, for the record:');
console.log('  analytic single-scatter, 4pi convention (CORRECT) : 0.0340');
console.log('  same with p180=3/(8pi) (orchestrator\'s 1st try)   : 0.00270  <- 4pi convention error');
console.log('  original script\'s printed expectation             : 0.0188   <- unexplained, likely a stray /2 and no 3/4');

// ── VENUS, with the now-validated estimator + error bars ──
// tau/omega taken from the replica's derived Venus coefficients.
// Run with surfAlb = 0.5 AND 0.0: at tau 9-46 the ground must be irrelevant,
// which is itself a check that the comparison is clean.
console.log('\nVENUS nadir pi*L/E, validated estimator:');
const VEN = [['R', 9.070, (7.826 + 1.097) / 9.070], ['G', 19.522, (18.287 + 1.063) / 19.522], ['B', 45.877, (44.644 + 0.962) / 45.877]];
const NV = 200_000;
const out = {};
for (const alb of [0.5, 0.0]) {
  const row = [];
  for (const [n, tau, om] of VEN) {
    const m = mc(tau, om, NV, alb, 4242, Infinity);
    row.push(m);
    console.log(`  surfAlb=${alb}  ${n}  tau=${tau.toFixed(2)} omega=${om.toFixed(4)}  pi*L/E = ${m.value.toFixed(4)} ±${(m.rel * 100).toFixed(2)}%`);
  }
  out[alb] = row;
}
const E_VENUS = 40.631;
const ENGINE = [11.081, 12.605, 13.271];
console.log(`\nVerdict (E_venus = ${E_VENUS} game units, L_true = pi*L/E * E/pi):`);
console.log('  ch  L_true          engine    engine/true');
out[0.5].forEach((m, i) => {
  const Ltrue = m.value * E_VENUS / Math.PI;
  console.log(`  ${VEN[i][0]}   ${Ltrue.toFixed(3)} ±${(m.rel * 100).toFixed(1)}%   ${ENGINE[i].toFixed(3)}    ${(ENGINE[i] / Ltrue).toFixed(3)}`);
});

// Monte-Carlo ground truth: plane-parallel slab, normal incidence, Rayleigh phase.
// Returns pi*L_nadir/E  (== the "geometric albedo at phase 0, nadir view").
function mc(tauMax, omega, N, surfAlb=0.0, seed=12345){
  let s=seed>>>0; const rnd=()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return (s>>>8)/16777216;};
  const MU_LO=0.95, dOmega=2*Math.PI*(1-MU_LO), muBar=(1+MU_LO)/2;
  let hit=0;
  for(let n=0;n<N;n++){
    let tau=0, mu=-1, phi=0, w=1; // mu<0 = downward (tau increases)
    let alive=true, nsc=0;
    while(alive){
      const t=-Math.log(1-rnd())/1.0; // free path in optical depth
      const dtau = -mu*t;             // mu<0 -> dtau>0 (downward)
      tau += dtau;
      if(tau<=0){ // escaped top
        if(mu>=MU_LO) hit+=w;
        break;
      }
      if(tau>=tauMax){ // hit surface
        if(surfAlb<=0) break;
        w*=surfAlb; if(w<1e-4) break;
        tau=tauMax-1e-9; mu=Math.sqrt(rnd()); // lambert up
        phi=2*Math.PI*rnd(); nsc++; continue;
      }
      // scatter
      w*=omega; nsc++;
      if(w<1e-4||nsc>4000) break;
      // Rayleigh scattering angle: p(cos)= 3/16pi (1+cos^2); sample via cubic root
      const u=2*rnd()-1;
      // solve for x: CDF(x)= (3x + x^3)/... normalised: F(x)=(3(x+1)+ (x^3+1))/8
      // => x^3+3x = 8*U -4  ; solve cubic x^3+3x - k =0 (single real root)
      const k=8*rnd()-4;
      const disc=Math.sqrt(k*k/4+1);
      const x=Math.cbrt(k/2+disc)+Math.cbrt(k/2-disc);
      const cosT=Math.max(-1,Math.min(1,x));
      const sinT=Math.sqrt(Math.max(0,1-cosT*cosT));
      const psi=2*Math.PI*rnd();
      // rotate direction (mu,phi) by (cosT,psi)
      const sinMu=Math.sqrt(Math.max(0,1-mu*mu));
      let muN, phiN;
      if(sinMu<1e-9){ muN = mu>0? cosT : -cosT; phiN=psi; }
      else { muN = mu*cosT + sinMu*sinT*Math.cos(psi);
             phiN = phi + Math.atan2(sinT*Math.sin(psi), sinMu*cosT - mu*sinT*Math.cos(psi)); }
      mu=Math.max(-1,Math.min(1,muN)); phi=phiN;
    }
  }
  const f=hit/N;
  return Math.PI*f/(muBar*dOmega);
}
const cases=[
  ['venus R', 9.070, (7.826+1.097)/9.070],
  ['venus G',19.522, (18.287+1.063)/19.522],
  ['venus B',45.877, (44.644+0.962)/45.877],
];
for(const [n,tau,om] of cases){
  const v=mc(tau,om,120000,0.5);
  console.log(n,'tau='+tau.toFixed(2),'omega='+om.toFixed(4),'-> pi*L/E =',v.toFixed(3));
}
// sanity: thin, conservative
console.log('sanity tau=0.1 om=1 ->', mc(0.1,1.0,200000,0).toFixed(4), '(single-scatter expect ~pi*p_R(180)*tau/2 =', (Math.PI*(3/(16*Math.PI))*2*0.1/2).toFixed(4),')');

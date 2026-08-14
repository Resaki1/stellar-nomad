// JS replica of atmospherePass.ts's MS bake + main march, for Venus and Earth.
const PI=Math.PI, ISO=1/(4*PI);
const R_GAS=8.314462, G=6.674e-11;
const EARTH_P=1.01325, EARTH_T=288;
const RAY_E=[5.802e-6,13.558e-6,33.1e-6], HR_E=8.0;
const MIE_S=3.996e-6, MIE_A=4.4e-6, HM_E=1.2;
const OZ=[0.65e-6,1.881e-6,0.085e-6], OZ_REF=0.209;
const CTF=0.9502, TOP=12.5;
const GASES={n2:[0.028014,1.027],o2:[0.031999,0.907],co2:[0.04401,2.57],ar:[0.039948,0.883],ch4:[0.016043,2.2],h2:[0.002016,0.199],he:[0.004003,0.0137],h2o:[0.018015,0.7],so2:[0.064066,5.5]};
const CH4ABS=[9.0e-4,1.5e-4,5.0e-6];
import fs from 'fs';
const sys=JSON.parse(fs.readFileSync('src/sim/systems/sol.json','utf8'));
function derive(id){
 const b=sys.celestialBodies.find(x=>x.id===id); const a=b.atmosphere;
 const ent=Object.entries(a.composition); const sum=ent.reduce((t,[,x])=>t+x,0);
 let M=0,rr=0,xO2=0,gasAbs=[0,0,0];
 for(const [g,x] of ent){const xn=x/sum;M+=xn*GASES[g][0];rr+=xn*GASES[g][1];if(g==='o2')xO2=xn;if(g==='ch4')for(let c=0;c<3;c++)gasAbs[c]+=xn*CH4ABS[c];}
 const rm=b.radiusKm*1000, grav=G*b.massKg/(rm*rm);
 const H=CTF*R_GAS*a.surfaceTemperatureK/(M*grav)/1000;
 const nRel=(a.surfacePressureBar/EARTH_P)*(EARTH_T/a.surfaceTemperatureK);
 const haze=a.haze??1,tS=a.hazeTint??[1,1,1],tA=a.hazeAbsorptionTint??[1,1,1];
 const hasOz=xO2>=0.005, ozS=hasOz?xO2/OZ_REF:0, hR=H/HR_E;
 return {Rg:b.radiusKm, top:TOP*H, HR:H,
  ray:RAY_E.map(v=>v*nRel*rr*1000),               // km^-1
  mieS:tS.map(t=>MIE_S*haze*t*1000),
  mieE:[0,1,2].map(c=>(MIE_S*haze*tS[c]+MIE_A*haze*tA[c])*1000),
  HM:a.hazeScaleHeightKm ?? (HM_E/HR_E)*H,
  oz:OZ.map(v=>v*ozS*1000), ozC:hasOz?25*hR:0, ozHW:hasOz?15*hR:0,
  ga:gasAbs.map(v=>v*nRel*1000),
  albedo:a.groundAlbedo??[0.3,0.3,0.3], mieG:(typeof (a.mieG??0.8)==='number')?[a.mieG??0.8,a.mieG??0.8,a.mieG??0.8]:a.mieG};
}
const add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const mul=(a,b)=>[a[0]*b[0],a[1]*b[1],a[2]*b[2]];
const scl=(a,s)=>[a[0]*s,a[1]*s,a[2]*s];
const expn=a=>[Math.exp(-a[0]),Math.exp(-a[1]),Math.exp(-a[2])];
function medium(p,h){
 const dR=Math.exp(-h/p.HR), dM=Math.exp(-h/p.HM);
 const dO=p.ozHW>0?Math.max(0,1-Math.abs(h-p.ozC)/p.ozHW):0;
 const sr=scl(p.ray,dR), sm=scl(p.mieS,dM), em=scl(p.mieE,dM);
 const sc=add(sr,sm);
 const ex=add(add(sr,em),add(scl(p.oz,dO),scl(p.ga,dR)));
 return {sr,sm,sc,ex};
}
const len=v=>Math.hypot(v[0],v[1],v[2]);
function raySphereNearest(ro,rd,R){ // smallest positive root
 const b=ro[0]*rd[0]+ro[1]*rd[1]+ro[2]*rd[2];
 const c=ro[0]**2+ro[1]**2+ro[2]**2-R*R;
 const d=b*b-c; if(d<0)return -1;
 const sd=Math.sqrt(d); const t0=-b-sd,t1=-b+sd;
 if(t0>0)return t0; if(t1>0)return t1; return -1;
}
function rayFar(ro,rd,R){const b=ro[0]*rd[0]+ro[1]*rd[1]+ro[2]*rd[2];const c=ro[0]**2+ro[1]**2+ro[2]**2-R*R;const d=b*b-c;if(d<0)return{n:-1,f:-1};const sd=Math.sqrt(d);return{n:-b-sd,f:-b+sd};}
// exact optical depth toward sun (replaces the LUT; 200 steps)
function sunT(p,P,sd,steps=200){
 const Rt=p.Rg+p.top;
 const {n,f}=rayFar(P,sd,Rt); if(f<=0)return [1,1,1];
 const t0=Math.max(0,n), tM=f-t0; const dt=tM/steps; let od=[0,0,0];
 for(let i=0;i<steps;i++){const t=t0+(i+0.5)*dt;const Q=[P[0]+sd[0]*t,P[1]+sd[1]*t,P[2]+sd[2]*t];
  const m=medium(p,Math.max(0,len(Q)-p.Rg)); od=add(od,scl(m.ex,dt));}
 return expn(od);
}
// Multi-scatter bake at radius r, cosSunZenith
function msBake(p,r,cosSZ,{SQ=8,STEPS=20}={}){
 const ro=[0,0,r]; const sdir=[Math.sqrt(Math.max(0,1-cosSZ*cosSZ)),0,cosSZ];
 let Lsum=[0,0,0], fsum=[0,0,0]; const N=SQ*SQ;
 for(let i=0;i<SQ;i++)for(let j=0;j<SQ;j++){
  const a=(i+0.5)/SQ, b=(j+0.5)/SQ;
  const th=a*2*PI, ph=Math.acos(1-b*2), sp=Math.sin(ph);
  const dir=[Math.cos(th)*sp,Math.sin(th)*sp,Math.cos(ph)];
  const tB=raySphereNearest(ro,dir,p.Rg), tT=raySphereNearest(ro,dir,p.Rg+p.top);
  const tMax = tB>0? tB : Math.max(0,tT);
  const dt=tMax/STEPS; let thr=[1,1,1],L=[0,0,0],fms=[0,0,0];
  for(let s=0;s<STEPS;s++){
   const t=(s+0.5)*dt; const P=[ro[0]+dir[0]*t,ro[1]+dir[1]*t,ro[2]+dir[2]*t];
   const m=medium(p,Math.max(0,len(P)-p.Rg)); const sT=expn(scl(m.ex,dt));
   const Ts=sunT(p,P,sdir);
   const Pn=scl(P,1/len(P));
   const off=[P[0]+Pn[0]*0.01,P[1]+Pn[1]*0.01,P[2]+Pn[2]*0.01];
   const sh=raySphereNearest(off,sdir,p.Rg)>0?0:1;
   const S=scl(mul(mul(m.sc,Ts),[sh,sh,sh]),ISO);
   const Sint=[0,1,2].map(c=>(S[c]-S[c]*sT[c])/Math.max(1e-6,m.ex[c]));
   L=add(L,mul(thr,Sint));
   const MSint=[0,1,2].map(c=>(m.sc[c]-m.sc[c]*sT[c])/Math.max(1e-6,m.ex[c]));
   fms=add(fms,mul(thr,MSint));
   thr=mul(thr,sT);
  }
  if(tB>0){const Pg=[ro[0]+dir[0]*tB,ro[1]+dir[1]*tB,ro[2]+dir[2]*tB];
   const N2=scl(Pg,1/len(Pg)); const NdL=Math.max(0,N2[0]*sdir[0]+N2[1]*sdir[1]+N2[2]*sdir[2]);
   const Tg=sunT(p,Pg,sdir);
   L=add(L,scl(mul(mul(thr,p.albedo),Tg),NdL/PI));}
  Lsum=add(Lsum,L); fsum=add(fsum,fms);
 }
 const L2=scl(Lsum,1/N), F=scl(fsum,1/N);
 const psi=[0,1,2].map(c=>L2[c]/Math.max(1e-4,1-F[c]));
 return {L2,F,psi};
}
// main march: camera outside, looking at sub-solar point (view = -sunDir, i.e. nadir view with sun behind camera)
function march(p,illum,{steps=16,SEG=0.3,altKm=200000,msPsiFn}={}){
 const Rt=p.Rg+p.top;
 // camera along +z at r=Rg+altKm, sun along +z (sub-solar, phase angle 0), view -z
 const ro=[0,0,p.Rg+altKm], rd=[0,0,-1], sdir=[0,0,1];
 const {n,f}=rayFar(ro,rd,Rt); const tG=raySphereNearest(ro,rd,p.Rg);
 const t0=Math.max(0,n)+ (n>0?0.01:0);
 const tEnd= tG>0? tG : f; const tMax=tEnd-t0;
 const cosT=rd[0]*sdir[0]+rd[1]*sdir[1]+rd[2]*sdir[2]; // = -1 (backscatter)
 const phR=3/(16*PI)*(1+cosT*cosT);
 const phM=p.mieG.map(g=>{const g2=g*g;const k=3/(8*PI)*(1-g2)/(2+g2);return k*(1+cosT*cosT)/Math.pow(Math.max(1e-4,1+g2-2*g*cosT),1.5);});
 let L=[0,0,0], thr=[1,1,1], t=0;
 for(let s=0;s<steps;s++){
  const tNew=tMax*(s+SEG)/steps; const dt=tNew-t; t=tNew;
  const P=[ro[0]+rd[0]*(t0+t),ro[1]+rd[1]*(t0+t),ro[2]+rd[2]*(t0+t)];
  const rP=len(P); const m=medium(p,Math.max(0,rP-p.Rg));
  const sT=expn(scl(m.ex,dt));
  const Ts=sunT(p,P,sdir);
  const Pn=scl(P,1/rP); const off=[P[0]+Pn[0]*0.01,P[1]+Pn[1]*0.01,P[2]+Pn[2]*0.01];
  const sh=raySphereNearest(off,sdir,p.Rg)>0?0:1;
  const ps=[0,1,2].map(c=>m.sm[c]*phM[c]+m.sr[c]*phR);
  const cosSZ=(P[0]*sdir[0]+P[1]*sdir[1]+P[2]*sdir[2])/rP;
  const cosH=-Math.sqrt(Math.max(0,1-p.Rg*p.Rg/(rP*rP)));
  const x=Math.min(1,Math.max(0,(cosSZ-(cosH-0.05))/0.1)); const sunVis=x*x*(3-2*x);
  const psi=msPsiFn(rP,cosSZ);
  const msC=[0,1,2].map(c=>psi[c]*m.sc[c]*sunVis);
  const S=[0,1,2].map(c=>illum[c]*(sh*Ts[c]*ps[c]+msC[c]));
  const Sint=[0,1,2].map(c=>(S[c]-S[c]*sT[c])/Math.max(1e-6,m.ex[c]));
  L=add(L,mul(thr,Sint)); thr=mul(thr,sT);
 }
 return {L,thr};
}
function psiTable(p){ // 32x32 like the LUT, bilinear
 const N=32; const tab=[];
 for(let j=0;j<N;j++){ const v=(j+0.5)/N; const r=p.Rg+v*p.top; const row=[];
  for(let i=0;i<N;i++){ const u=(i+0.5)/N; const cs=u*2-1; row.push(msBake(p,r,cs).psi); }
  tab.push(row); }
 return (rP,cosSZ)=>{
  const v=Math.min(1,Math.max(0,(rP-p.Rg)/p.top)), u=Math.min(1,Math.max(0,cosSZ*0.5+0.5));
  const fy=Math.min(N-1,Math.max(0,v*N-0.5)), fx=Math.min(N-1,Math.max(0,u*N-0.5));
  const y0=Math.floor(fy),x0=Math.floor(fx),y1=Math.min(N-1,y0+1),x1=Math.min(N-1,x0+1);
  const ty=fy-y0,tx=fx-x0;
  return [0,1,2].map(c=>{
   const a=tab[y0][x0][c]*(1-tx)+tab[y0][x1][c]*tx;
   const b=tab[y1][x0][c]*(1-tx)+tab[y1][x1][c]*tx;
   return a*(1-ty)+b*ty;});
 };
}
for(const [id,illumScalar] of [['earth',20],['venus',40.631]]){
 const p=derive(id);
 console.log('\n===== '+id.toUpperCase()+'  Rg='+p.Rg+' top='+p.top.toFixed(1)+' illum='+illumScalar);
 // Fms / psi at a few points, sub-solar (cosSZ=1)
 for(const frac of [0.02,0.1,0.3,0.6]){
   const r=p.Rg+frac*p.top; const {L2,F,psi}=msBake(p,r,1.0);
   console.log(`  h=${(frac*p.top).toFixed(1)}km  Fms=[${F.map(v=>v.toFixed(4))}]  1/(1-Fms)=[${F.map(v=>(1/Math.max(1e-4,1-v)).toFixed(2))}]  L2=[${L2.map(v=>v.toExponential(2))}]  psi=[${psi.map(v=>v.toFixed(4))}]`);
 }
 const fn=psiTable(p);
 const r16=march(p,[illumScalar,illumScalar,illumScalar],{steps:16,msPsiFn:fn});
 const r256=march(p,[illumScalar,illumScalar,illumScalar],{steps:256,msPsiFn:fn});
 // single-scatter only (psi=0) for reference
 const rSS=march(p,[illumScalar,illumScalar,illumScalar],{steps:256,msPsiFn:()=>[0,0,0]});
 console.log('  DISC (sub-solar, nadir, phase 0):');
 console.log('   16 steps  L=['+r16.L.map(v=>v.toFixed(3))+'] T=['+r16.thr.map(v=>v.toExponential(1))+']');
 console.log('   256 steps L=['+r256.L.map(v=>v.toFixed(3))+']');
 console.log('   single-scatter only L=['+rSS.L.map(v=>v.toFixed(3))+']');
 console.log('   physical p*E/pi (p=geom albedo): earth p=.43 venus p=.69 -> '+(id==='earth'?(0.43*illumScalar/PI).toFixed(3):(0.69*illumScalar/PI).toFixed(3)));
 console.log('   conservative-Rayleigh ceiling A=0.9 -> '+(0.9*illumScalar/PI).toFixed(3));
}

// ── Extra: Earth zenith sky luminance from the ground (sun at zenith) ──
{
 const p=derive('earth'); const E=20;
 const fn=psiTable(p);
 // camera 0.01 km above ground, view = +z (zenith), sun = +z
 const ro=[0,0,p.Rg+0.01], rd=[0,0,1], sdir=[0,0,1];
 const Rt=p.Rg+p.top;
 const {f}=rayFar(ro,rd,Rt); const tMax=f;
 let L=[0,0,0], thr=[1,1,1], t=0; const steps=256, SEG=0.5;
 for(let s=0;s<steps;s++){
  const tNew=tMax*(s+SEG)/steps; const dt=tNew-t; t=tNew;
  const P=[0,0,ro[2]+t]; const rP=P[2]; const m=medium(p,Math.max(0,rP-p.Rg));
  const sT=expn(scl(m.ex,dt)); const Ts=sunT(p,P,sdir);
  const cosT=1; const phR=3/(16*PI)*(1+1);
  const phM=p.mieG.map(g=>{const g2=g*g;const k=3/(8*PI)*(1-g2)/(2+g2);return k*2/Math.pow(Math.max(1e-4,1+g2-2*g),1.5);});
  const ps=[0,1,2].map(c=>m.sm[c]*phM[c]+m.sr[c]*phR);
  const psi=fn(rP,1);
  const msC=[0,1,2].map(c=>psi[c]*m.sc[c]);
  const S=[0,1,2].map(c=>E*(Ts[c]*ps[c]+msC[c]));
  const Sint=[0,1,2].map(c=>(S[c]-S[c]*sT[c])/Math.max(1e-6,m.ex[c]));
  L=add(L,mul(thr,Sint)); thr=mul(thr,sT);
 }
 console.log('\nEarth ZENITH sky luminance (sun at zenith), game units:', L.map(v=>v.toFixed(4)).join(' '));
 console.log('  x 6400 cd/m2 per unit ->', L.map(v=>(v*6400).toFixed(0)).join(' '), 'cd/m^2  (photopic-ish mix ~', (0.2126*L[0]+0.7152*L[1]+0.0722*L[2]).toFixed(3),'units =', ((0.2126*L[0]+0.7152*L[1]+0.0722*L[2])*6400).toFixed(0),'cd/m2)');
}

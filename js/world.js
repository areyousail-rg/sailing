// 江の島沖 / 八景島沖の世界: 海・空・島・海岸・ランドマーク・マーク・航跡
import * as THREE from 'three';
import { MARKS, LEGS, COURSE_MODE, toWorld, LINE_HALF, LINE_SKEW, FAVORED, lineA, U, W0, setWindDir } from './course.js';
import { makeMotorboat } from './powerboats.js';
import { shiftAt, waveSample, SEA } from './sim.js';

export const FOG_COLOR = 0xbdd5e6;
export const FOG_DENSITY = 3.0e-5;
export const SUN_DIR = new THREE.Vector3(0.5, 0.55, 0.62).normalize();

// ---------- ノイズ ----------
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
let seed = 12345; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

// ---------- 海 ----------
const SKY_FN = `
uniform vec3 uSun;
vec3 skyBase(vec3 d){
  float h=clamp(d.y,0.0001,1.0);
  vec3 hor=vec3(0.74,0.86,0.94), zen=vec3(0.14,0.38,0.78);
  vec3 c=mix(hor,zen,pow(h,0.42));
  float s=clamp(dot(d,uSun),0.0001,1.0);
  c+=vec3(1.0,0.92,0.75)*(pow(s,600.0)*6.0+pow(s,12.0)*0.18);
  return c;
}`;
export const MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
const SEA_VS = `
uniform float uWT; uniform vec4 uSeaA[4]; uniform vec4 uSeaB[4]; uniform vec3 uPatchC; uniform float uPatchR; uniform float uBaseY;
varying vec3 vW;
void main(){
  vec4 w=modelMatrix*vec4(position,1.0);
#ifdef PATCH
  // 長周期のうねり成分のみ頂点を実際に上下させる(カメラ周辺の局所パッチ)。外縁は下の海面(uBaseY)へ滑らかに沈める
  float h=0.0;
  for(int i=0;i<4;i++){ vec4 A=uSeaA[i]; vec4 B=uSeaB[i]; if(B.z>0.5) h+=A.w*sin(A.z*dot(A.xy,w.xz)-B.x*uWT+B.y); }
  float r=length(w.xz-uPatchC.xz)/max(uPatchR,1.0);
  w.y=mix(h,uBaseY,smoothstep(0.72,1.0,r));
#endif
  vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w;
}`;
const waterMat = new THREE.ShaderMaterial({
  defines: { NWAVE: MOBILE ? 3 : 4 },
  uniforms: {
    uTime: { value: 0 }, uWT: { value: 0 }, uW0: { value: W0 }, uSideBias: { value: -0.6 }, uSun: { value: SUN_DIR }, uShift: { value: 0 }, uGen: { value: 0.55 },
    uSeaA: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uSeaB: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uPatchC: { value: new THREE.Vector3() }, uPatchR: { value: 300 }, uBaseY: { value: 0 },
  },
  vertexShader: SEA_VS,
  fragmentShader: `
precision highp float;
varying vec3 vW; uniform float uTime; uniform float uWT; uniform float uW0; uniform float uSideBias; uniform float uShift; uniform float uGen; uniform vec4 uSeaA[4]; uniform vec4 uSeaB[4];
${SKY_FN}
float hh(vec2 p){ p=mod(p,289.0); return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(hh(i),hh(i+vec2(1,0)),f.x),mix(hh(i+vec2(0,1)),hh(i+vec2(1,1)),f.x),f.y); }
void main(){
  vec2 p=vW.xz; vec3 V=normalize(cameraPosition-vW); float dist=length(cameraPosition-vW);
  vec2 g=vec2(0.0);
  for(int i=0;i<NWAVE;i++){
    float fi=float(i);
    float ang=0.35+fi*0.83; vec2 d=normalize(vec2(sin(ang)*0.9+0.34,-cos(ang)*0.7-0.5));
    float k=0.11*pow(1.75,fi); float A=0.55*pow(0.52,fi);
    float w=sqrt(9.8*k)*0.9;
    float fade=exp(-dist*k*0.0035);
    if(fade<0.02) break; // 遠方では高周波の波を省略(kは増加するので以降も不要)
    g+=d*A*k*cos(mod(dot(d,p)*k-uTime*w+fi*1.7,628.3185))*fade*uGen;
  }
  // 海況(三角波・うねり・短周期の風浪): sim.js waveSample と同じ成分・同じ時刻で法線を作る
  for(int i=0;i<4;i++){
    vec4 A=uSeaA[i]; vec4 B=uSeaB[i];
    float fd=exp(-dist*A.z*0.0045);
    if(fd>0.02) g+=A.xy*(A.w*A.z*cos(mod(A.z*dot(A.xy,p)-B.x*uWT+B.y,6.2831853)))*fd*1.5;
  }
  if(dist<2000.0) g+=(vec2(vn(p*0.9+uTime*0.3),vn(p*0.9-uTime*0.25+7.0))-0.5)*0.12*exp(-dist*0.004);
  // 風: sim.js windAt と完全に同じ式で、風上から風下へ流れるブロー(黒い筋)とシフトを海面に表現
  vec2 uDir=vec2(sin(uW0),-cos(uW0));
  vec2 rDir=vec2(cos(uW0),sin(uW0));
  float ca=dot(p,uDir), cc=dot(p,rDir);
  float adv=mod(ca+uWT*4.8,6283.185);
  float p1=sin(adv*0.032+cc*0.018+sin(cc*0.011-uWT*0.08)*1.4);
  float p2=sin(adv*0.055-cc*0.024+1.7);
  float p3=sin(adv*0.019+cc*0.038-0.9);
  float puff=smoothstep(-0.15,0.72,0.50*p1+0.32*p2+0.18*p3);
  float sideNorm=clamp(cc/160.0,-1.2,1.2);
  float wf=clamp(0.86+0.34*puff+uSideBias*sideNorm*0.065,0.72,1.32);
  float wsh=uShift+0.06*sin(adv*0.028-cc*0.021)+uSideBias*sideNorm*0.075;
  float wfr=uW0+wsh; vec2 wd=vec2(-sin(wfr),cos(wfr)); vec2 wp=vec2(-wd.y,wd.x);
  float wu=dot(p,wp), wv=dot(p,wd);
  float gust=smoothstep(0.84,1.18,wf);
  float blow=smoothstep(0.98,1.16,wf); // ブロー(強風域)の視覚強調係数
  if(dist<2400.0){
    float rip=vn(vec2(wu*1.2,wv*0.25-uTime*2.6))*0.6+vn(vec2(wu*2.7+3.0,wv*0.55-uTime*3.6))*0.4;
    g+=wp*(rip-0.5)*(0.12+0.68*gust)*exp(-dist*0.0025);
  }
  vec3 n=normalize(vec3(-g.x,1.0,-g.y));
  float ndv=max(dot(n,V),0.0);
  float F=0.03+0.97*pow(max(1.0-ndv,0.0001),4.5);
  vec3 R=reflect(-V,n); R.y=abs(R.y);
  vec3 refl=skyBase(R);
  vec3 deep=vec3(0.012,0.14,0.24), shallow=vec3(0.06,0.34,0.42);
  float crest=clamp(length(g)*2.2,0.0,1.0);
  vec3 body=mix(deep,shallow,crest*0.7+0.15);
  vec3 col=mix(body,refl,F);
  if(dist<2800.0){
    float foam=smoothstep(0.62,0.95,length(g)*3.2+vn(p*2.3+uTime*0.5)*0.35)*exp(-dist*0.002);
    col=mix(col,vec3(0.92,0.96,0.98),foam*0.5);
  }
  // ブロー(風の強い海面のさざ波): あからさまな黒い塊ではなく、実際の海面のように注意して見ると少し濃くざわついて見える程度に抑える
  float catpaw=0.55+0.45*vn(vec2(wu*0.48,wv*0.07-uTime*1.35));
  col*=mix(1.03,0.90,smoothstep(0.76,1.22,wf));
  col=mix(col,col*vec3(0.84,0.87,0.91),blow*(0.20+0.20*catpaw)*exp(-dist*0.0006));
  if(dist<4000.0){
    float streak=smoothstep(0.72,0.92,vn(vec2(wu*0.32,wv*0.03-uTime*1.1)));
    col+=vec3(0.55,0.62,0.66)*streak*0.11*(0.4+gust)*exp(-dist*0.0012);
  }
  float fd0=dist*${FOG_DENSITY.toFixed(7)};
  float fogF=1.0-exp(-(fd0*fd0));
  col=mix(col,vec3(0.741,0.835,0.902),fogF);
  gl_FragColor=vec4(col,1.0);
}`,
  fog: false,
});

// ---------- 空 ----------
const skyMat = new THREE.ShaderMaterial({
  uniforms: { uSun: { value: SUN_DIR }, uTime: { value: 0 } },
  side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: `varying vec3 vD; void main(){ vD=normalize(position); gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0); }`,
  fragmentShader: `
precision highp float; varying vec3 vD; uniform float uTime;
${SKY_FN}
float hh(vec2 p){ p=mod(p,289.0); return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(hh(i),hh(i+vec2(1,0)),f.x),mix(hh(i+vec2(0,1)),hh(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float a=0.5,s=0.0; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+1.7; a*=0.5;} return s; }
void main(){
  vec3 d=normalize(vD);
  vec3 c=skyBase(vec3(d.x,max(d.y,0.0),d.z));
  if(d.y<0.0) c=mix(c,vec3(0.74,0.86,0.94),smoothstep(0.0,-0.2,d.y));
  if(d.y>0.0){
    vec2 uv=d.xz/(d.y+0.12)*0.9+vec2(uTime*0.004,uTime*0.002);
    float cl=smoothstep(0.52,0.85,fbm(uv*1.4));
    float lit=0.75+0.25*clamp(dot(normalize(vec3(d.x,0.0,d.z)),normalize(vec3(uSun.x,0.0,uSun.z)))*0.5+0.5,0.0,1.0);
    vec3 cc=mix(vec3(0.72,0.78,0.86),vec3(1.0),lit);
    c=mix(c,cc,cl*smoothstep(0.0,0.25,d.y)*0.9);
  }
  gl_FragColor=vec4(c,1.0);
}`,
});

// ---------- 地形 ----------
// 江の島: コースから約800m(島の南端)。南側は崖と波食台(岩棚)、北側はなだらかな斜面に街並み
export const ISLAND = { x: 450, z: -1150, rx: 520, rz: 230 };
function islandPolar(x, z) {
  const dx = (x - ISLAND.x) / ISLAND.rx, dz = (z - ISLAND.z) / ISLAND.rz;
  const ang = -0.14, rx = dx * Math.cos(ang) - dz * Math.sin(ang), rz = dx * Math.sin(ang) + dz * Math.cos(ang);
  const n = noise2(x * 0.006, z * 0.006) * 0.2 + noise2(x * 0.021, z * 0.021) * 0.06;
  return { rx, rz, r: Math.sqrt(rx * rx * 0.9 + rz * rz * 1.15) + n - 0.12 };
}
export function islandH(x, z) {
  const { rx, rz, r } = islandPolar(x, z);
  const south = smooth(-0.3, 0.55, rz); // 南側(沖側)ほど崖が切り立つ
  if (r >= 1) {
    // 波食台: 南西側(稚児ヶ淵〜岩屋前)に海面すれすれの平らな岩棚
    const shelf = south * smooth(0.3, -0.4, rx) * (1 - smooth(1.0, 1.15, r));
    const base = -6 + Math.max(0, 1.3 - r) * 12;
    return Math.max(base, shelf > 0.05 ? -0.5 + 1.4 * shelf + noise2(x * 0.15, z * 0.15) * 0.5 : base);
  }
  const t = 1 - r;
  // 西〜中央が標高約58mの丘陵(シーキャンドル・サムエルコッキング苑)、東側(rx > 0.18)は湘南港(ヨットハーバー)の低い埋立地へなだらかに降りる
  const eastHarbor = smooth(0.12, 0.52, rx);
  const ex = 0.62 - 0.34 * south;
  const hillH = Math.pow(t, ex) * 58 * (1 - 0.86 * eastHarbor);
  const terraceH = eastHarbor * smooth(1.0, 0.72, r) * 3.2;
  return hillH + terraceH - 1.8 + (1 - 0.8 * eastHarbor) * (noise2(x * 0.05, z * 0.05) * 2.2 + noise2(x * 0.11, z * 0.11) * 1.0);
}
const COAST = 1850; // 湘南海岸(片瀬海岸)までの距離
const COAST_Z = -COAST;
const coastD = (x, z) => -z - COAST - 40 * Math.sin(x / 700) - 25 * Math.sin(x / 230 + 1);
function landH(x, z) {
  const d = coastD(x, z);
  const ramp = smooth(0, 160, d);
  const hills = Math.pow(smooth(700, 7000, d), 1.4) * 520 * (0.35 + 0.65 * noise2(x / 2600, d / 2200)) + smooth(300, 1500, d) * 30 * noise2(x / 500, d / 400);
  return -1.2 + 3.4 * ramp + hills;
}
function colorLand(x, z, h, out) {
  const d = coastD(x, z);
  if (h < 0.15) out.setRGB(0.36, 0.33, 0.28); // 波打ち際(濡れた砂)
  else if (d < 125) { const g = noise2(x / 40, z / 40) * 0.05; out.setRGB(0.5 + g, 0.45 + g, 0.37 + g); } // 湘南の灰褐色の砂浜
  else if (d < 150) out.setRGB(0.42, 0.42, 0.41); // 防潮堤・国道134号
  else {
    const g = noise2(x / 150, z / 150);
    const u = smooth(0, 500, h);
    out.setRGB(0.1 + 0.06 * g - 0.03 * u, 0.22 + 0.1 * g - 0.04 * u, 0.07 + 0.04 * g);
    if (d < 2200 && noise2(x / 60, z / 60) > 0.5) out.setRGB(0.4, 0.39, 0.36); // 市街地
  }
}

// 遠景の陸地(三浦半島・伊豆半島・箱根・伊豆大島): 楕円の高さ場+ノイズ
function distantLand(scene, cx, cz, rx, rz, hmax, rot = 0, n = 48) {
  const xs = [], zs = [];
  const R = Math.max(rx, rz) * 1.15;
  for (let i = 0; i <= n; i++) { xs.push(cx - R + (2 * R * i) / n); zs.push(cz - R + (2 * R * i) / n); }
  const c = Math.cos(rot), s = Math.sin(rot);
  const hf = (x, z) => {
    const dx = x - cx, dz = z - cz;
    const u = (dx * c - dz * s) / rx, v = (dx * s + dz * c) / rz;
    const r = Math.sqrt(u * u + v * v) + (noise2(x / (rx * 0.35), z / (rz * 0.35)) - 0.5) * 0.35;
    if (r >= 1) return -30;
    const ridge = 0.55 + 0.45 * noise2(x / (rx * 0.18) + 9, z / (rz * 0.18) - 3);
    return Math.pow(1 - r, 0.8) * hmax * ridge - 4;
  };
  const geo = buildGrid(xs, zs, hf, (x, z, h, out) => {
    const g = noise2(x / 900, z / 900);
    if (h < 6) out.setRGB(0.4, 0.38, 0.33); else out.setRGB(0.12 + 0.05 * g, 0.2 + 0.07 * g, 0.12 + 0.03 * g);
  });
  scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));
}

function buildGrid(xs, zs, hf, cf) {
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3);
  const c = new THREE.Color();
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, h = hf(xs[i], zs[j]);
    pos[k * 3] = xs[i]; pos[k * 3 + 1] = h; pos[k * 3 + 2] = zs[j];
    cf(xs[i], zs[j], h, c); col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, cc = a + nx, d = cc + 1;
    idx.push(a, cc, b, b, cc, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export function createWorld(scene) {
  scene.background = new THREE.Color(FOG_COLOR);
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x4a6770, 1.35));
  const sun = new THREE.DirectionalLight(0xfff0d6, 2.7); sun.position.copy(SUN_DIR).multiplyScalar(200); scene.add(sun);

  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), waterMat);
  sea.geometry.rotateX(-Math.PI / 2); sea.scale.set(120000, 1, 120000); sea.frustumCulled = false; scene.add(sea);
  // うねり用の局所変位パッチ(長周期の波がある海況のときだけ表示)。先に描画して下の平面海面のフラグメント計算を深度テストで省く
  const PATCH_R = 300, PATCH_SEG = MOBILE ? 64 : 96;
  const seaPatchMat = new THREE.ShaderMaterial({ defines: { ...waterMat.defines, PATCH: 1 }, uniforms: waterMat.uniforms, vertexShader: waterMat.vertexShader, fragmentShader: waterMat.fragmentShader, fog: false });
  const patchGeo = new THREE.PlaneGeometry(PATCH_R * 2, PATCH_R * 2, PATCH_SEG, PATCH_SEG); patchGeo.rotateX(-Math.PI / 2);
  const seaPatch = new THREE.Mesh(patchGeo, seaPatchMat); seaPatch.frustumCulled = false; seaPatch.renderOrder = -5; seaPatch.visible = false; scene.add(seaPatch);
  sea.renderOrder = -4;
  waterMat.uniforms.uPatchR.value = PATCH_R;
  let seaBaseY = 0;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(70000, 32, 16), skyMat); sky.frustumCulled = false; sky.renderOrder = -10; scene.add(sky);

  // ---------- ステージ風景: 江の島 / 八景島 ----------
  const enoshimaGroup = new THREE.Group();
  const hakkeijimaGroup = new THREE.Group();
  hakkeijimaGroup.visible = false;
  scene.add(enoshimaGroup, hakkeijimaGroup);

  // 白波(磯・浜に砕ける波): 等高線に沿った帯を作り、波のテクスチャを流す
  const foamTex = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64; const x = c.getContext('2d');
    for (let i = 0; i < 900; i++) {
      const px = Math.random() * 256, py = Math.random() * 64, a = Math.pow(1 - py / 64, 1.6) * (0.25 + Math.random() * 0.5);
      x.fillStyle = `rgba(255,255,255,${a})`; x.beginPath(); x.ellipse(px, py, 3 + Math.random() * 9, 1 + Math.random() * 3, 0, 0, 7); x.fill();
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; return t;
  })();
  const surfMat = new THREE.MeshBasicMaterial({ map: foamTex, transparent: true, opacity: 0.8, depthWrite: false, color: 0xf2f7f8 });
  const surfStrip = (parent, pts, width) => {
    const pos = [], uv = [], idx = [];
    let acc = 0;
    pts.forEach((p, i) => {
      if (i) acc += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      const w = width * (0.6 + 0.8 * noise2(p.x * 0.02, p.z * 0.02));
      pos.push(p.x - p.ux * 1.5, 0.22, p.z - p.uz * 1.5, p.x + p.ux * w, 0.22, p.z + p.uz * w);
      uv.push(acc / 40, 0, acc / 40, 1);
      if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    const m = new THREE.Mesh(g, surfMat); m.renderOrder = 1; parent.add(m); return m;
  };

  // ===== 1. 江の島ステージ =====
  const xs = [], zs = [];
  for (let i = 0; i <= 200; i++) xs.push(ISLAND.x - 640 + (1280 * i) / 200);
  for (let j = 0; j <= 110; j++) zs.push(ISLAND.z - 330 + (660 * j) / 110);
  const islandGeo = buildGrid(xs, zs, islandH, (x, z, h, out) => out.setRGB(0, 0, 0));
  {
    // 斜面の傾きとエリアで岩肌(凝灰岩の海食崖)・磯・市街テラス・照葉樹林を塗り分ける(緑一色にならないリアルな配色)
    const P = islandGeo.attributes.position, N = islandGeo.attributes.normal, C = islandGeo.attributes.color;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), h = P.getY(i), z = P.getZ(i), ny = N.getY(i);
      const g = noise2(x / 9, z / 9), g2 = noise2(x / 31 + 5, z / 31);
      const isEastHarbor = x > ISLAND.x + 110;
      const isNorthTown = z < ISLAND.z - 40 && h < 26;
      let r, gg, b;
      if (h < 1.1) { r = 0.22; gg = 0.21; b = 0.19; } // 潮間帯の濡れた岩
      else if (h < 5.5 || isEastHarbor) {
        // 岩棚・磯・東側のヨットハーバー埋立地周辺は明るい砂岩・コンクリート調
        r = 0.56 + 0.07 * g; gg = 0.52 + 0.06 * g; b = 0.45 + 0.05 * g;
      } else if (isNorthTown) {
        // 北〜東の参道・市街地斜面は落ち着いた石畳・建物トーン
        r = 0.44 + 0.06 * g; gg = 0.42 + 0.06 * g; b = 0.37 + 0.05 * g;
      } else {
        // 丘陵上部の樹林帯 (彩度を抑えた自然な緑)
        r = 0.11 + 0.05 * g + 0.03 * g2; gg = 0.21 + 0.08 * g + 0.04 * g2; b = 0.09 + 0.03 * g;
      }
      if (h >= 1.1) {
        // 少しでも傾斜がある海食崖(南面・西面)は江の島らしい明るい黄褐色の凝灰岩肌を広く見せる
        const steep = smooth(0.88, 0.55, ny);
        const cr = 0.62 + 0.09 * g, cg = 0.54 + 0.08 * g, cb = 0.42 + 0.06 * g;
        r += (cr - r) * steep; gg += (cg - gg) * steep; b += (cb - b) * steep;
      }
      C.setXYZ(i, r, gg, b);
    }
    C.needsUpdate = true;
  }
  enoshimaGroup.add(new THREE.Mesh(islandGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  {
    const pts = [];
    for (let k = 0; k <= 360; k++) {
      const a = (k / 360) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
      let rr = 0;
      for (let s = 760; s > 0; s -= 2) { if (islandH(ISLAND.x + ux * s, ISLAND.z + uz * s) > -0.25) { rr = s; break; } }
      pts.push({ x: ISLAND.x + ux * rr, z: ISLAND.z + uz * rr, ux, uz });
    }
    surfStrip(enoshimaGroup, pts, 9);
    const cpts = [];
    for (let x = -14000; x <= 3000; x += 40) cpts.push({ x, z: -(COAST + 64 + 40 * Math.sin(x / 700) + 25 * Math.sin(x / 230 + 1)), ux: 0, uz: 1 });
    surfStrip(enoshimaGroup, cpts, 14);
  }

  // 湘南海岸
  const lx = [], lz = [];
  for (let i = 0; i <= 220; i++) lx.push(-48000 + (96000 * i) / 220);
  for (let j = 0; j < 48; j++) lz.push(COAST_Z + 100 - (25 * (Math.pow(1.095, j) - 1)) / 0.095);
  const landGeo = buildGrid(lx, lz, landH, colorLand);
  enoshimaGroup.add(new THREE.Mesh(landGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  // 遠景: 三浦半島(東) / 箱根(富士の手前) / 伊豆半島(南西) / 伊豆大島(南の水平線)
  // (三浦半島は addEnoshimaScenery で実際の海岸線(稲村ヶ崎〜逗子〜葉山〜城ヶ島)に沿って作成)
  // 箱根: 江の島から方位約265°(富士山の左手前)。外輪山の裾が小田原〜真鶴付近で相模湾へ落ちる
  distantLand(enoshimaGroup, -26000, 2000, 8000, 6500, 1300, 0.25);
  distantLand(enoshimaGroup, -31000, 26000, 8500, 20000, 950, -0.2, 56);
  distantLand(enoshimaGroup, -6000, 41000, 5200, 6500, 760, 0);

  // 富士山 (山頂が尖らず、広い平らな火口頂上部と剣ヶ峰のわずかな起伏・優美な裾野を持つリアルなシルエット)
  const prof = [];
  const rBase = 23000, rTop = 1680; // 山頂の平らな火口直径(約3.3km相当)を確保して先が尖らないようにする
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const r = rTop + (rBase - rTop) * Math.pow(1 - t, 1.85);
    prof.push(new THREE.Vector2(r, 3776 * t));
  }
  prof.push(new THREE.Vector2(0, 3730)); // 火口底を平らに閉じる
  const fgeo = new THREE.LatheGeometry(prof, 72);
  const fpos = fgeo.attributes.position;
  const fc = new Float32Array(fpos.count * 3);
  for (let i = 0; i < fpos.count; i++) {
    let y = fpos.getY(i);
    const px = fpos.getX(i), pz = fpos.getZ(i);
    // 山頂火口縁に剣ヶ峰などのごくわずかな凹凸を付与
    if (y > 3600 && Math.hypot(px, pz) > 500) {
      const rim = 55 * (noise2(px / 900 + 2.1, pz / 900 - 1.3) - 0.4);
      y += rim;
      fpos.setY(i, y);
    }
    const jag = 380 * (noise2(px / 1800, pz / 1800) - 0.5);
    const snow = smooth(2500, 2800, y + jag);
    fc[i * 3] = 0.2 + 0.78 * snow; fc[i * 3 + 1] = 0.3 + 0.68 * snow; fc[i * 3 + 2] = 0.34 + 0.62 * snow;
  }
  fgeo.computeVertexNormals();
  fgeo.setAttribute('color', new THREE.BufferAttribute(fc, 3));
  const fuji = new THREE.Mesh(fgeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  // 江の島から見た富士山はほぼ真西(方位約278°)、箱根の右肩・丹沢の左に聳える
  fuji.position.set(-41000, -2, -5800); fuji.scale.set(1, 1, 1); enoshimaGroup.add(fuji);

  // 江の島の木(緑豊かすぎないよう、西〜中央の丘の上部のみに絞って配置し、東側のヨットハーバーや崖・参道はすっきり見せる)
  const treeCount = 520;
  const trees = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial(), treeCount); // 遠景の樹冠は36面体で十分(80→36三角形)
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), tc = new THREE.Color(), eul = new THREE.Euler();
  let n = 0;
  for (let tries = 0; tries < 6000 && n < treeCount; tries++) {
    const x = ISLAND.x - 420 + rnd() * 540, z = ISLAND.z + (rnd() * 2 - 1) * 210;
    if (x > ISLAND.x + 115) continue; // 東側はヨットハーバー・駐車場・広場のため木を生やさない
    const h = islandH(x, z); if (h < 14) continue; // 低い斜面や磯・参道には生やさない
    const slope = Math.abs(islandH(x + 3, z) - h) + Math.abs(islandH(x, z + 3) - h);
    if (slope > 3.6) continue; // 崖には生えない
    const s = 3.2 + rnd() * 3.4;
    q.setFromEuler(eul.set(0, rnd() * 6.28, 0));
    m4.compose(new THREE.Vector3(x, h + s * 0.35, z), q, new THREE.Vector3(s * (0.9 + rnd() * 0.35), s * (0.55 + rnd() * 0.22), s * (0.9 + rnd() * 0.35)));
    trees.setMatrixAt(n, m4); tc.setRGB(0.08 + rnd() * 0.06, 0.18 + rnd() * 0.09, 0.07 + rnd() * 0.03); trees.setColorAt(n, tc); n++;
  }
  q.identity();
  trees.count = n; enoshimaGroup.add(trees);

  const BOXMAX = 3200;
  const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), BOXMAX);
  let bn = 0;
  const addBox = (x, y, z, w, h, d, color) => {
    if (bn >= BOXMAX) return;
    m4.compose(new THREE.Vector3(x, y + h / 2, z), q, new THREE.Vector3(w, h, d));
    boxes.setMatrixAt(bn, m4); tc.setHex(color); boxes.setColorAt(bn, tc); bn++;
  };
  const pal = [0xf3efe6, 0xe9e2d3, 0xd9d4c8, 0xf6f0e0, 0xc9b8a0, 0xe8ddd0, 0xb9c4cc];
  const roofPal = [0x4a4f55, 0x6b5a4a, 0x3d4a5a, 0x7a3b2e, 0x5c6065, 0x2f3a3a];
  const house = (x, y, z, w, h, d) => { addBox(x, y, z, w, h, d, pal[(rnd() * pal.length) | 0]); addBox(x, y + h, z, w + 0.8, 0.9, d + 0.8, roofPal[(rnd() * roofPal.length) | 0]); };
  // 島の北〜東斜面の仲見世通り・旅館街・島内建築群(海からも街並みが見えるように充実)
  for (let tries = 0, k = 0; tries < 6000 && k < 240; tries++) {
    const x = ISLAND.x - 360 + rnd() * 520, z = ISLAND.z - 240 + rnd() * 340;
    const h = islandH(x, z); if (h < 2.5 || h > 36) continue;
    house(x, h - 0.5, z, 8 + rnd() * 10, 6 + rnd() * 9, 8 + rnd() * 10); k++;
  }
  // 海岸の街並み(片瀬・鵠沼・腰越)
  for (let k = 0; k < 1300; k++) {
    const x = -9000 + rnd() * 21000, z = COAST_Z - 170 - rnd() * 1200;
    const h = landH(x, z); if (h < 1.5) continue;
    const tall = rnd() < 0.12;
    house(x, h - 0.5, z, 10 + rnd() * 18, tall ? 22 + rnd() * 30 : 6 + rnd() * 14, 10 + rnd() * 18);
  }
  boxes.count = bn; enoshimaGroup.add(boxes);

  // 江の島シーキャンドル(展望灯台): 島の中央丘陵頂上(x = ISLAND.x - 35)に聳える象徴的な展望塔
  const lhx = ISLAND.x - 35, lhz = ISLAND.z - 15, topH = islandH(lhx, lhz);
  const lh = new THREE.Group();
  const towerM = new THREE.MeshLambertMaterial({ color: 0xf1efe9 });
  const tw = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 4.2, 52, 16), towerM); tw.position.y = 26; lh.add(tw);
  for (let i = 0; i < 6; i++) { const rib = new THREE.Mesh(new THREE.BoxGeometry(0.6, 52, 0.6), new THREE.MeshLambertMaterial({ color: 0xd8d4cc })); const a = (i / 6) * Math.PI * 2; rib.position.set(Math.cos(a) * 3.9, 26, Math.sin(a) * 3.9); rib.rotation.z = Math.cos(a) * 0.035; rib.rotation.x = -Math.sin(a) * 0.035; lh.add(rib); }
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(7.2, 6.2, 5.5, 20), new THREE.MeshLambertMaterial({ color: 0x8fb8cc, emissive: 0x1d3442 })); deck.position.y = 53; lh.add(deck);
  const deckRoof = new THREE.Mesh(new THREE.CylinderGeometry(7.6, 7.6, 0.9, 20), towerM); deckRoof.position.y = 56.2; lh.add(deckRoof);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 3.5, 12), new THREE.MeshLambertMaterial({ color: 0xfff6d0, emissive: 0x665a2a })); lantern.position.y = 58.5; lh.add(lantern);
  const spire = new THREE.Mesh(new THREE.ConeGeometry(1.3, 5, 12), new THREE.MeshLambertMaterial({ color: 0x555a60 })); spire.position.y = 62.5; lh.add(spire);
  lh.position.set(lhx, topH - 1, lhz); enoshimaGroup.add(lh);
  // 神社(辺津宮)と入口の青銅鳥居
  const sx = ISLAND.x - 110, sz = ISLAND.z - 140, sh = islandH(sx, sz);
  const shrine = new THREE.Mesh(new THREE.BoxGeometry(18, 8, 14), new THREE.MeshLambertMaterial({ color: 0xc63a2d })); shrine.position.set(sx, sh + 3.5, sz); enoshimaGroup.add(shrine);
  const sroof = new THREE.Mesh(new THREE.ConeGeometry(15, 6, 4), new THREE.MeshLambertMaterial({ color: 0x2f3a3a })); sroof.rotation.y = Math.PI / 4; sroof.position.set(sx, sh + 10.5, sz); enoshimaGroup.add(sroof);

  // 弁天橋(島の北端から片瀬海岸へ)
  const bx = ISLAND.x - 40;
  let zN = ISLAND.z; for (let z = ISLAND.z; z > ISLAND.z - 600; z -= 2) { if (islandH(bx, z) < 0.5) { zN = z + 6; break; } }
  const zC = -(COAST + 90 + 40 * Math.sin(bx / 700) + 25 * Math.sin(bx / 230 + 1));
  const blen = zN - zC;
  addTori(enoshimaGroup, bx, islandH(bx, zN - 14) + 0.3, zN - 14);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(9, 1.6, blen), new THREE.MeshLambertMaterial({ color: 0xcfcac0 }));
  bridge.position.set(bx, 4.2, (zN + zC) / 2); enoshimaGroup.add(bridge);
  const np = Math.floor(blen / 30);
  const piers = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 6, 1.6), new THREE.MeshLambertMaterial({ color: 0x8c8a85 }), np * 2);
  for (let i = 0; i < np; i++) for (const s of [-1, 1]) { m4.makeTranslation(bx + s * 3.2, 0.5, zC + 15 + i * 30); piers.setMatrixAt(i * 2 + (s > 0 ? 1 : 0), m4); }
  enoshimaGroup.add(piers);

  // ===== 江の島ヨットハーバー (湘南港): 島の東〜南東側(レース海面から正面に見える位置)に広がる巨大埋立地ハーバー =====
  const yhGroup = new THREE.Group();
  const hx = ISLAND.x + 210, hz = ISLAND.z + 35; // 島の東半分〜南東側(コース側)に大きく張り出す実際の湘南港の位置
  const conc = new THREE.MeshLambertMaterial({ color: 0xd6d3cb });
  const concDark = new THREE.MeshLambertMaterial({ color: 0x9ca3af });
  const brk = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x0284c7, emissive: 0x0c4a6e });

  // 1) ディンギーパーク広大埋立地エプロン & さざえ島・北緑地プロムナード
  const mainApron = new THREE.Mesh(new THREE.BoxGeometry(310, 3.6, 230), conc);
  mainApron.position.set(hx + 20, 1.2, hz - 10); yhGroup.add(mainApron);
  const northApron = new THREE.Mesh(new THREE.BoxGeometry(260, 3.8, 140), new THREE.MeshLambertMaterial({ color: 0xcbd5e1 }));
  northApron.position.set(hx - 15, 1.3, hz - 185); yhGroup.add(northApron);
  // 海へ降りるコンクリートスロープ(ディンギー出艇スロープ×2面)
  for (const sz of [hz - 55, hz + 35]) {
    const slip = new THREE.Mesh(new THREE.BoxGeometry(46, 1.8, 68), new THREE.MeshLambertMaterial({ color: 0xb8b4aa }));
    slip.position.set(hx + 188, 0.6, sz);
    slip.rotation.z = -0.06;
    yhGroup.add(slip);
  }

  // 2) 江の島ヨットハウス (クラブハウス: 特徴的な白い波型ルーフとガラス張りファサード・ウッドデッキ)
  const yhX = hx - 25, yhZ = hz - 25;
  const yhBody = new THREE.Mesh(new THREE.BoxGeometry(86, 11, 38), whiteMat);
  yhBody.position.set(yhX, 8.2, yhZ); yhGroup.add(yhBody);
  const yhGlass = new THREE.Mesh(new THREE.BoxGeometry(82, 7.5, 39.5), glassMat);
  yhGlass.position.set(yhX, 8.0, yhZ + 0.5); yhGroup.add(yhGlass);
  // 波型ルーフ (3連の緩やかな白いアーチ屋根で江の島ヨットハウスの外観を再現)
  for (let w = -1; w <= 1; w++) {
    const waveRoof = new THREE.Mesh(new THREE.CylinderGeometry(18, 18, 42, 16, 1, false, -Math.PI * 0.35, Math.PI * 0.7), whiteMat);
    waveRoof.rotation.x = Math.PI / 2;
    waveRoof.scale.set(1.05, 0.38, 1);
    waveRoof.position.set(yhX + w * 28, 10.2, yhZ);
    yhGroup.add(waveRoof);
  }
  // センタープロムナードのウッドデッキ＆さざえ島(タイドプールのある小丘)
  const woodDeck = new THREE.Mesh(new THREE.BoxGeometry(110, 1.2, 26), new THREE.MeshLambertMaterial({ color: 0xb48a60 }));
  woodDeck.position.set(yhX + 10, 3.4, yhZ + 32); yhGroup.add(woodDeck);
  const sazae = new THREE.Mesh(new THREE.ConeGeometry(28, 11, 12), new THREE.MeshLambertMaterial({ color: 0x8b7e6a }));
  sazae.position.set(hx + 115, 7.5, hz + 82); yhGroup.add(sazae);

  // 湘南港本館(ポートハウス・白い管制塔ビル)
  const portHouse = new THREE.Mesh(new THREE.BoxGeometry(44, 14, 30), whiteMat);
  portHouse.position.set(hx + 75, 9.5, hz - 95); yhGroup.add(portHouse);
  const portTower = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 6.5, 22, 12), whiteMat);
  portTower.position.set(hx + 90, 14, hz - 85); yhGroup.add(portTower);
  const portGlass = new THREE.Mesh(new THREE.CylinderGeometry(6.0, 6.0, 4.0, 12), glassMat);
  portGlass.position.set(hx + 90, 22, hz - 85); yhGroup.add(portGlass);

  // 3) 泊地を囲む長大な南防波堤・東防波堤と、先端の白い「江の島灯台(湘南港灯台)」
  // 南防波堤 (コース側から正面に見える長い防波堤)
  const southBrk = new THREE.Mesh(new THREE.BoxGeometry(360, 5.2, 14), brk);
  southBrk.position.set(hx + 275, 2.0, hz + 125); yhGroup.add(southBrk);
  // 東防波堤 & 北防波堤
  const eastBrk = new THREE.Mesh(new THREE.BoxGeometry(14, 5.2, 280), brk);
  eastBrk.position.set(hx + 450, 2.0, hz - 25); yhGroup.add(eastBrk);
  const northBrk = new THREE.Mesh(new THREE.BoxGeometry(290, 4.8, 12), brk);
  northBrk.position.set(hx + 305, 1.8, hz - 165); yhGroup.add(northBrk);
  // 防波堤先端の象徴的な白い湘南港灯台(白灯台)
  const hLighthouse = new THREE.Group();
  const hlBase = new THREE.Mesh(new THREE.CylinderGeometry(3.8, 4.6, 4.5, 12), whiteMat); hlBase.position.y = 4.5; hLighthouse.add(hlBase);
  const hlBody = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.0, 15, 12), whiteMat); hlBody.position.y = 13.5; hLighthouse.add(hlBody);
  const hlTop = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, 2.2, 12), whiteMat); hlTop.position.y = 21.5; hLighthouse.add(hlTop);
  const hlLamp = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 2.4, 10), new THREE.MeshBasicMaterial({ color: 0xfef08a })); hlLamp.position.y = 23.2; hLighthouse.add(hlLamp);
  hLighthouse.position.set(hx + 450, 1.5, hz + 118);
  yhGroup.add(hLighthouse);

  // 4) 泊地内の浮桟橋(ポンツーン)と係留クルーザー群
  for (let p = 0; p < 5; p++) {
    const pz = hz - 110 + p * 44;
    const pontoon = new THREE.Mesh(new THREE.BoxGeometry(190, 1.0, 3.2), concDark);
    pontoon.position.set(hx + 305, 0.6, pz); yhGroup.add(pontoon);
  }
  const mastsG = new THREE.CylinderGeometry(0.16, 0.16, 12, 5);
  const hulls = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 1.1, 7.5), new THREE.MeshLambertMaterial({ color: 0xffffff }), 72);
  const masts = new THREE.InstancedMesh(mastsG, new THREE.MeshLambertMaterial({ color: 0xcfd3d8 }), 72);
  for (let i = 0; i < 72; i++) {
    const x = hx + 225 + (i % 12) * 15 + (rnd() - 0.5) * 1.5, z = hz - 105 + Math.floor(i / 12) * 38 + (rnd() - 0.5) * 2;
    m4.makeTranslation(x, 0.65, z); hulls.setMatrixAt(i, m4); tc.setHSL(rnd(), 0.25, 0.88); hulls.setColorAt(i, tc);
    m4.makeTranslation(x, 6.8, z); masts.setMatrixAt(i, m4);
  }
  yhGroup.add(hulls, masts);

  // 5) ディンギーパークにずらりと並ぶスナイプ/470等の小型ヨット群 (140艇)
  const dh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.5, 4.7), new THREE.MeshLambertMaterial(), 140);
  const dm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, 6.8, 4), new THREE.MeshLambertMaterial({ color: 0xd8dde3 }), 140);
  for (let i = 0; i < 140; i++) {
    const colIdx = i % 14, rowIdx = Math.floor(i / 14);
    const x = hx - 95 + colIdx * 18 + (rnd() - 0.5) * 2, z = hz - 75 + rowIdx * 16 + (rnd() - 0.5) * 2;
    m4.makeTranslation(x, 3.2, z); dh.setMatrixAt(i, m4); tc.setHSL(rnd(), 0.55, 0.72 + rnd() * 0.22); dh.setColorAt(i, tc);
    m4.makeTranslation(x, 6.6, z - 0.6); dm.setMatrixAt(i, m4);
  }
  yhGroup.add(dh, dm);
  enoshimaGroup.add(yhGroup);

  // 6) 江の島周辺・腰越・片瀬沖の漁船(スパンカー帆付き小型漁船)と大型クルーザー・外洋ヨット群 (レースコース外に配置)
  const enoShips = new THREE.Group();
  const enoWhite = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const enoBlue = new THREE.MeshLambertMaterial({ color: 0x0284c7 });
  const enoNavy = new THREE.MeshLambertMaterial({ color: 0x1e3a8a });
  const enoDark = new THREE.MeshLambertMaterial({ color: 0x1e293b });
  const enoTeak = new THREE.MeshLambertMaterial({ color: 0xb48a60 });
  const enoGlass = new THREE.MeshLambertMaterial({ color: 0x0ea5e9, emissive: 0x0c4a6e });
  // (6-a) 腰越・片瀬・江の島沖のシラス漁船・釣り船 (白い船体・青ライン・船尾スパンカー帆)
  const enoFishCoords = [
    [620, -480, 0.65], [960, -360, -0.45], [1180, -640, 1.15],
    [-460, -520, 0.35], [-740, -680, -0.85], [-580, 260, 0.9],
    [540, 480, -1.2], [860, 220, 0.25], [-420, 560, 1.6]
  ];
  for (const [fx, fz, fry] of enoFishCoords) {
    const fg = new THREE.Group();
    const fh = new THREE.Mesh(new THREE.BoxGeometry(3.5, 1.3, 11.5), enoWhite);
    fh.position.y = 0.55; fg.add(fh);
    const fb = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.38, 11.6), enoBlue);
    fb.position.y = 1.15; fg.add(fb);
    const fc = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.0, 3.4), enoWhite);
    fc.position.set(0, 2.0, -0.4); fg.add(fc);
    const fWin = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.65, 1.8), enoGlass);
    fWin.position.set(0, 2.35, 0.3); fg.add(fWin);
    const spanker = new THREE.Mesh(new THREE.ConeGeometry(1.55, 4.2, 3), enoWhite);
    spanker.position.set(0, 3.5, -4.1); fg.add(spanker);
    fg.position.set(fx, 0, fz); fg.rotation.y = fry;
    enoShips.add(fg);
  }
  // (6-b) 湘南港・相模湾を航行する大型モータークルーザー & 大型外洋セーリングクルーザー
  const enoCruiserConfigs = [
    { x: 740, z: -210, ry: -0.35, scale: 1.25, col: 0xf8fafc, stripe: 0x1e3a8a, sail: false },
    { x: -520, z: -240, ry: 0.55, scale: 1.35, col: 0x1e293b, stripe: 0x38bdf8, sail: false },
    { x: 640, z: 160, ry: 2.35, scale: 1.18, col: 0xf8fafc, stripe: 0x0284c7, sail: true },
    { x: -640, z: -40, ry: -0.75, scale: 1.28, col: 0xf1f5f9, stripe: 0xdc2626, sail: true },
    { x: 1080, z: -80, ry: -1.1, scale: 1.45, col: 0xf8fafc, stripe: 0x0f172a, sail: false },
    { x: 380, z: 640, ry: 0.18, scale: 1.22, col: 0xf8fafc, stripe: 0x2563eb, sail: true },
  ];
  for (const cc of enoCruiserConfigs) {
    const cg = new THREE.Group();
    const hullMat = new THREE.MeshLambertMaterial({ color: cc.col });
    const strMat = new THREE.MeshLambertMaterial({ color: cc.stripe });
    // 船体 (全長約20〜26m級の大型ラグジュアリークルーザー)
    const hull = new THREE.Mesh(new THREE.BoxGeometry(5.6, 2.4, 21.0), hullMat);
    hull.position.y = 1.0; cg.add(hull);
    const bow = new THREE.Mesh(new THREE.ConeGeometry(3.96, 6.8, 4), hullMat);
    bow.rotation.x = Math.PI / 2; bow.rotation.y = Math.PI / 4;
    bow.scale.set(1, 0.62, 1); bow.position.set(0, 1.05, 13.8); cg.add(bow);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(5.72, 0.42, 21.2), strMat);
    stripe.position.y = 1.85; cg.add(stripe);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.3, 20.0), enoTeak);
    deck.position.y = 2.25; cg.add(deck);
    if (cc.sail) {
      // 大型外洋セーリングクルーザー(45〜55ft級: キャビン＋高いマスト＆メイン・ジブセール)
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.3, 8.5), enoWhite);
      cabin.position.set(0, 2.8, 1.2); cg.add(cabin);
      const cWin = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.55, 6.2), enoGlass);
      cWin.position.set(0, 3.0, 1.4); cg.add(cWin);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 24.0, 8), enoWhite);
      mast.position.set(0, 14.0, 2.5); cg.add(mast);
      const mainSail = new THREE.Mesh(new THREE.ConeGeometry(4.2, 20.0, 3), new THREE.MeshLambertMaterial({ color: 0xf8fafc, side: THREE.DoubleSide }));
      mainSail.position.set(0, 13.5, -1.2); mainSail.scale.set(0.12, 1, 1.35); cg.add(mainSail);
      const jibSail = new THREE.Mesh(new THREE.ConeGeometry(3.5, 17.5, 3), new THREE.MeshLambertMaterial({ color: 0xf1f5f9, side: THREE.DoubleSide }));
      jibSail.position.set(0, 12.0, 7.6); jibSail.scale.set(0.12, 1, 1.15); cg.add(jibSail);
    } else {
      // フライブリッジ付き大型モータークルーザー (サロンクルーザー)
      const salon = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.2, 11.5), enoWhite);
      salon.position.set(0, 3.3, -0.5); cg.add(salon);
      const sWin = new THREE.Mesh(new THREE.BoxGeometry(4.72, 1.1, 9.8), enoGlass);
      sWin.position.set(0, 3.5, 0.2); cg.add(sWin);
      const fly = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.4, 6.8), enoWhite);
      fly.position.set(0, 5.0, -1.2); cg.add(fly);
      const radarArch = new THREE.Mesh(new THREE.BoxGeometry(3.9, 1.8, 1.2), enoWhite);
      radarArch.position.set(0, 6.2, -3.2); cg.add(radarArch);
      const hardTop = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.3, 6.2), enoWhite);
      hardTop.position.set(0, 7.1, -1.2); cg.add(hardTop);
    }
    cg.scale.setScalar(cc.scale);
    cg.position.set(cc.x, 0, cc.z);
    cg.rotation.y = cc.ry;
    enoShips.add(cg);
  }
  enoshimaGroup.add(enoShips);

  // ===== 2. 八景島ステージ (横浜・八景島シーパラダイス沖) =====
  buildHakkeijima(hakkeijimaGroup, surfStrip, fgeo);

  // 実地調査に基づく周辺景観の追加 → 静的メッシュをマテリアル特性ごとに結合してドローコールを大幅削減
  addEnoshimaScenery(enoshimaGroup, surfStrip);
  addHakkeiScenery(hakkeijimaGroup);
  bakeStatic(enoshimaGroup);
  bakeStatic(hakkeijimaGroup);

  // ---------- マーク類 ----------
  const bob = [];
  const markObjs = {};
  const dark = new THREE.MeshLambertMaterial({ color: 0x111111 });
  const flag = (color) => {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6), new THREE.MeshLambertMaterial({ color: 0x555555 })); pole.position.y = 3.5; g.add(pole);
    const f = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.0), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })); f.position.set(0.85, 4.6, 0); g.add(f);
    return g;
  };
  const buoy = (color, flagColor) => {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.7, 3.8, 14), new THREE.MeshLambertMaterial({ color })); cone.position.y = 1.0; g.add(cone);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.7, 14), new THREE.MeshLambertMaterial({ color: 0x222222 })); base.position.y = -0.4; g.add(base);
    g.add(flag(flagColor)); return g;
  };
  const place = (key, obj) => { const p = toWorld(MARKS[key].a, MARKS[key].c); obj.position.set(p.x, 0, p.z); scene.add(obj); bob.push(obj); markObjs[key] = obj; };
  place('m1', buoy(0xffc21a, 0xff5a1f)); place('m1a', buoy(0xffc21a, 0xff5a1f)); place('m2', buoy(0xffc21a, 0xff5a1f)); place('m3', buoy(0xffc21a, 0xff5a1f));
  place('gL', buoy(0xff6a1f, 0xffffff)); place('gR', buoy(0xff6a1f, 0xffffff));

  // アウター艇(ピン側のオレンジ旗艇) — 船首を風上に向けてアンカリング
  const flagSway = [];
  const courseBoats = [];
  const putBoat = (b, a, c, relRot) => {
    const head = Math.atan2(U.x, U.z);
    const p = toWorld(a, c);
    b.position.set(p.x, 0, p.z);
    b.rotation.y = head + relRot;
    scene.add(b); bob.push(b);
    courseBoats.push({ b, a, c, relRot });
    b.traverse((o) => { if (o.userData.flag) flagSway.push(o); });
    return b;
  };
  const ORG = { color: '#ff7a1a', w: 1.5, h: 1.0 };
  markObjs.pin = putBoat(makeMotorboat('outer', { flags: [ORG] }), MARKS.pin.a, MARKS.pin.c, 0.06);

  // スタート運営艇(右端)
  const com = putBoat(makeMotorboat('committee', { flags: [ORG, { color: '#1c4fa0', w: 1.4, h: 0.9, text: 'P' }] }), MARKS.com.a, MARKS.com.c, -0.05);
  markObjs.com = com;

  // コース周辺の観覧艇・サポート艇(レースエリアの外: 右は c≥175、左は c≤-220、1マークの上 a≥355、フィニッシュの下 a≤-185)
  const specPositions = [
    { a: 360, c: 40, rot: 1.2, type: 'cruiser' },
    { a: 180, c: 180, rot: -0.8, type: 'rib' },
    { a: 240, c: -232, rot: 2.1, type: 'cruiser' },
    { a: 60, c: -228, rot: 0.4, type: 'rib' },
    { a: -90, c: -232, rot: -1.5, type: 'cruiser' },
    { a: 372, c: -70, rot: 0.9, type: 'rib' },
    { a: 20, c: 190, rot: -2.2, type: 'cruiser' },
    { a: 290, c: 192, rot: 0.1, type: 'rib' },
    { a: -195, c: -20, rot: 2.6, type: 'cruiser' },
    { a: -30, c: -262, rot: 0.9, type: 'rib' },
  ];
  const TUBES = [0x2d3748, 0xc2410c, 0x1e3a8a, 0x374151];
  specPositions.forEach((s, i) => putBoat(makeMotorboat(s.type, { tube: TUBES[i % 4], flags: s.type === 'rib' ? [{ color: i % 2 ? '#ffffff' : '#ffd23f', w: 0.8, h: 0.5 }] : [] }), s.a, s.c, s.rot));
  // スタートライン(TV中継風の薄いライン)
  const pa0 = toWorld(MARKS.pin.a, MARKS.pin.c), pb0 = toWorld(MARKS.com.a, MARKS.com.c);
  const len = Math.hypot(pb0.x - pa0.x, pb0.z - pa0.z);
  const lineMesh = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.7), new THREE.MeshBasicMaterial({ color: 0xffe36a, transparent: true, opacity: 0.62, depthWrite: false, blending: THREE.AdditiveBlending }));
  lineMesh.rotation.x = -Math.PI / 2; scene.add(lineMesh);

  // ---------- スタート前限定: 有利サイド(赤バッジのみ・コンパクト表記) ----------
  const preStartGroup = new THREE.Group();
  scene.add(preStartGroup);
  const favCanvas = document.createElement('canvas');
  favCanvas.width = 384; favCanvas.height = 112;
  const favTex = new THREE.CanvasTexture(favCanvas);
  const favEndBadge = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: favTex, transparent: true, depthWrite: false })
  );
  favEndBadge.scale.set(13.5, 3.9, 1);
  favEndBadge.renderOrder = 6;
  preStartGroup.add(favEndBadge);

  const updateFavBadge = () => {
    const skewDeg = Math.round(Math.abs((LINE_SKEW * 180) / Math.PI));
    const labelStr = FAVORED === 'even' || skewDeg === 0 ? '0°有利なし' : `${skewDeg}°${FAVORED === 'com' ? '上有利' : '下有利'}`;
    const ctx = favCanvas.getContext('2d');
    ctx.clearRect(0, 0, 384, 112);
    ctx.fillStyle = FAVORED === 'even' || skewDeg === 0 ? 'rgba(120, 35, 35, 0.82)' : 'rgba(185, 28, 28, 0.90)';
    ctx.beginPath(); ctx.roundRect(6, 6, 372, 100, 20); ctx.fill();
    ctx.strokeStyle = '#fde047'; ctx.lineWidth = 6; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 52px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(labelStr, 192, 58);
    favTex.needsUpdate = true;
  };

  // フィニッシュライン(チェッカー柄の帯 + 縦のカーテン + FINISH表示)
  const fpa0 = toWorld(MARKS.fm.a, MARKS.fm.c), fpb0 = toWorld(MARKS.fcom.a, MARKS.fcom.c);
  const flen = Math.hypot(fpb0.x - fpa0.x, fpb0.z - fpa0.z);
  const checker = (rx, ry) => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 64); x.fillStyle = '#111'; x.fillRect(0, 0, 32, 32); x.fillRect(32, 32, 32, 32);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const finBand = new THREE.Mesh(new THREE.PlaneGeometry(flen, 3), new THREE.MeshBasicMaterial({ map: checker(flen / 3, 1), transparent: true, opacity: 0.9, depthWrite: false }));
  finBand.rotation.x = -Math.PI / 2;
  const finCurtainMat = new THREE.MeshBasicMaterial({ map: checker(flen / 3.5, 1), transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
  const finCurtain = new THREE.Mesh(new THREE.PlaneGeometry(flen, 3.5), finCurtainMat);
  const fin = new THREE.Group(); fin.add(finBand, finCurtain); scene.add(fin);
  
  const lineLabel = (txt, bg, lx, lz) => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128; const x = c.getContext('2d');
    x.fillStyle = bg; x.fillRect(0, 0, 512, 128); x.strokeStyle = '#fff'; x.lineWidth = 8; x.strokeRect(4, 4, 504, 120);
    x.fillStyle = '#fff'; x.font = 'bold 84px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, 256, 68);
    const s = new THREE.Sprite(new THREE.CanvasTexture(c) ? new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true }) : undefined);
    s.scale.set(26, 6.5, 1); s.position.set(lx, 12, lz); s.renderOrder = 5; scene.add(s); return s;
  };
  const startLabel = lineLabel('START LINE', 'rgba(180,120,0,0.85)', 0, 0);
  const finLabel = lineLabel('FINISH', 'rgba(20,20,20,0.88)', 0, 0);
  
  // フィニッシュ運営艇(青旗 + RRS 32.2コース短縮「S旗」+ オレンジライン旗)とピン
  const fComBoat = putBoat(makeMotorboat('committee', { stripe: 0x1d4ed8, flags: [{ color: '#1d4ed8', w: 1.5, h: 1.0 }, { color: '#ffffff', w: 1.45, h: 0.95, text: 'S' }, ORG] }), MARKS.fcom.a, MARKS.fcom.c, 0.1);
  markObjs.fcom = fComBoat;
  const fPinObj = buoy(0x2a77ff, 0x2a77ff); scene.add(fPinObj); bob.push(fPinObj); markObjs.fm = fPinObj;

  // 風向(W0)やコースモード(COURSE_MODE)変更時にすべてのコースマーク・ライン・観覧艇のワールド座標と表示状態を更新
  const syncCourseObjects = () => {
    const isUpwindMode = COURSE_MODE === 'upwind';
    for (const k of ['m1', 'm1a', 'm2', 'm3', 'gL', 'gR', 'fm']) {
      const p = toWorld(MARKS[k].a, MARKS[k].c);
      markObjs[k].position.x = p.x; markObjs[k].position.z = p.z;
    }
    // 上マークフィニッシュモード時は 1a, 2, 3, 4S(gL), 4P(gR), fm(下フィニッシュピン: 上マーク1がピンになるため) を非表示化
    for (const k of ['m1a', 'm2', 'm3', 'gL', 'gR', 'fm']) {
      markObjs[k].visible = !isUpwindMode;
    }
    const head = Math.atan2(U.x, U.z);
    for (const cb of courseBoats) {
      let ca = cb.a, cc = cb.c;
      if (cb.b === fComBoat) {
        ca = MARKS.fcom.a; cc = MARKS.fcom.c;
      } else if (cb.b === markObjs.pin) {
        ca = MARKS.pin.a; cc = MARKS.pin.c;
      } else if (cb.b === markObjs.com) {
        ca = MARKS.com.a; cc = MARKS.com.c;
      } else if (isUpwindMode && cb.a >= 350) {
        // 1マーク北側の観覧艇は2倍レグ(a=600)の上側に退避
        ca = cb.a + 300;
      }
      const p = toWorld(ca, cc);
      cb.b.position.x = p.x; cb.b.position.z = p.z;
      cb.b.rotation.y = head + cb.relRot;
    }
    const pa = toWorld(MARKS.pin.a, MARKS.pin.c), pb = toWorld(MARKS.com.a, MARKS.com.c);
    const lcx = (pa.x + pb.x) / 2, lcz = (pa.z + pb.z) / 2, lrot = -Math.atan2(pb.z - pa.z, pb.x - pa.x);
    lineMesh.rotation.z = lrot; lineMesh.position.set(lcx, 0.15, lcz);
    startLabel.position.set(lcx, 12, lcz);

    // スタート前ガイド: 有利サイド赤バッジの位置とテキスト更新
    updateFavBadge();
    if (FAVORED === 'even') {
      favEndBadge.position.set(lcx, 17.2, lcz);
    } else {
      const favPt = FAVORED === 'com' ? pb : pa;
      favEndBadge.position.set(favPt.x, 12.5, favPt.z);
    }

    const fpa = toWorld(MARKS.fm.a, MARKS.fm.c), fpb = toWorld(MARKS.fcom.a, MARKS.fcom.c);
    const curFlen = Math.hypot(fpb.x - fpa.x, fpb.z - fpa.z);
    const flcx = (fpa.x + fpb.x) / 2, flcz = (fpa.z + fpb.z) / 2, flrot = -Math.atan2(fpb.z - fpa.z, fpb.x - fpa.x);
    finBand.scale.x = curFlen / flen;
    finCurtain.scale.x = curFlen / flen;
    finBand.rotation.z = flrot; finBand.position.set(flcx, 0.18, flcz);
    finCurtain.rotation.y = flrot; finCurtain.position.set(flcx, 2.2, flcz);
    finLabel.position.set(flcx, 12, flcz);
  };
  syncCourseObjects();

  // マークの番号ラベル (遠くのマークほど番号がはっきり大きく見えるよう距離比例スケール + カメラ接近時は完全非表示化)
  const markSprites = {};
  const label = (txt, key, y = 4.2) => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256; const x = c.getContext('2d');
    x.fillStyle = 'rgba(8, 18, 38, 0.88)'; x.beginPath(); x.arc(128, 128, 114, 0, Math.PI * 2); x.fill();
    x.strokeStyle = '#ffd23f'; x.lineWidth = 14; x.stroke();
    x.fillStyle = '#ffffff'; x.font = 'bold 126px Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(txt, 128, 134);
    const tex = new THREE.CanvasTexture(c);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true, opacity: 0.94 }));
    s.scale.set(4.5, 4.5, 1); s.position.y = y; s.renderOrder = 4; markObjs[key].add(s);
    markSprites[key] = s;
  };
  label('1', 'm1'); label('1a', 'm1a'); label('2', 'm2'); label('3', 'm3'); label('4S', 'gL'); label('4P', 'gR');

  // ---------- 次向かうマークの赤い矢印 + 上部「Next」文字列 (4ゲートは4S/4P両方に表示) ----------
  const makeNextTextTex = () => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 112; const x = c.getContext('2d');
    x.fillStyle = 'rgba(220, 24, 24, 0.92)';
    x.beginPath(); x.roundRect(12, 12, 232, 88, 22); x.fill();
    x.strokeStyle = '#ffffff'; x.lineWidth = 8; x.stroke();
    x.fillStyle = '#ffffff'; x.font = 'bold 64px Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('Next', 128, 58);
    return new THREE.CanvasTexture(c);
  };
  const nextTex = makeNextTextTex();
  const makeTargetArrow = () => {
    const g = new THREE.Group();
    const coneMat = new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.96, depthWrite: false });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.7, 4.5, 14), coneMat);
    cone.rotation.x = Math.PI;
    cone.position.y = -1.2;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 3.6, 14), coneMat);
    shaft.position.y = 2.4;
    const nextMat = new THREE.SpriteMaterial({ map: nextTex, transparent: true, opacity: 0.96, depthWrite: false });
    const nextSp = new THREE.Sprite(nextMat);
    nextSp.scale.set(6.8, 3.0, 1);
    nextSp.position.y = 6.2;
    nextSp.renderOrder = 6;
    g.add(cone, shaft, nextSp);
    g.userData.mat = coneMat;
    g.userData.nextMat = nextMat;
    g.visible = false;
    scene.add(g);
    return g;
  };
  const targetArrows = [makeTargetArrow(), makeTargetArrow()];
  let activeMarkKeys = ['m1'];
  const camDir = new THREE.Vector3();

  // ---------- 航跡 ----------
  // 艇尾直後の薄い乱流帯(中央)と、左右に広がる細いケルビン波(八の字)。小型ディンギーなので短く淡く消える
  const TRAIL_N = 16, MAXB = 40, PER = 3, LIFE = 2.6;
  const trailGeo = new THREE.CircleGeometry(1, 12); trailGeo.rotateX(-Math.PI / 2);
  const trailMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const trail = new THREE.InstancedMesh(trailGeo, trailMat, TRAIL_N * PER * MAXB);
  trail.frustumCulled = false; trail.position.y = 0.06; scene.add(trail);
  trail.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const hist = new Map();
  const col = new THREE.Color();
  const tv = new THREE.Vector3(), ts = new THREE.Vector3(), tq = new THREE.Quaternion(), yAx = new THREE.Vector3(0, 1, 0);
  const hide = (k) => { m4.makeScale(0, 0, 0); trail.setMatrixAt(k, m4); col.setScalar(0); trail.setColorAt(k, col); };
  const wake = {
    update(boats, dt) {
      let k = 0;
      for (const b of boats) {
        let h = hist.get(b.id);
        if (!h) { h = { pts: [], acc: 0 }; hist.set(b.id, h); }
        h.acc += dt;
        if (h.acc > 0.16 && b.v > 0.6) {
          h.acc = 0;
          const bx = b.x - Math.sin(b.h) * 2.3, bz = b.z + Math.cos(b.h) * 2.3;
          h.pts.unshift({ x: bx, z: bz, h: b.h, age: 0, s: clampN(b.v / 6, 0, 1) });
          if (h.pts.length > TRAIL_N) h.pts.pop();
        }
        for (const p of h.pts) p.age += dt;
        for (let i = 0; i < TRAIL_N; i++) {
          const p = h.pts[i];
          if (!p || p.age >= LIFE) { for (let j = 0; j < PER; j++) hide(k++); continue; }
          const life = 1 - p.age / LIFE, fade = life * life;
          const py = SEA.longAmp > 0.01 ? waveSample(p.x, p.z, SEA.clock).hLong : 0; // うねりの上に航跡を沿わせる
          const rx = Math.cos(p.h), rz = Math.sin(p.h); // 艇の右方向
          tq.setFromAxisAngle(yAx, -p.h);
          // 中央: 細長い楕円で少しずつ広がる
          ts.set(0.32 + p.age * 0.32, 1, 0.9 + p.age * 0.25);
          m4.compose(tv.set(p.x, py, p.z), tq, ts); trail.setMatrixAt(k, m4);
          col.setRGB(0.62, 0.72, 0.76).multiplyScalar(0.16 * fade * p.s); trail.setColorAt(k++, col);
          // 左右のケルビン波: 艇速に応じて外へ移動
          const off = 0.45 + p.age * (0.55 + p.s * 0.9);
          for (const s of [-1, 1]) {
            const a = p.h - s * 0.62; // 後方外側へ斜めに伸びる波頭
            tq.setFromAxisAngle(yAx, -a);
            ts.set(0.07 + p.age * 0.05, 1, 0.5 + p.age * 0.35);
            m4.compose(tv.set(p.x + rx * s * off, py, p.z + rz * s * off), tq, ts); trail.setMatrixAt(k, m4);
            col.setRGB(0.7, 0.8, 0.84).multiplyScalar(0.11 * fade * p.s); trail.setColorAt(k++, col);
          }
        }
      }
      for (; k < TRAIL_N * PER * MAXB; k++) { m4.makeScale(0, 0, 0); trail.setMatrixAt(k, m4); }
      trail.instanceMatrix.needsUpdate = true;
      if (trail.instanceColor) trail.instanceColor.needsUpdate = true;
    },
    reset() { hist.clear(); },
  };

  return {
    markObjs,
    wake,
    syncCourseObjects,
    // 海況を海面シェーダーへ反映(最大4成分)。長周期成分があるときだけ変位パッチを表示する
    setSea(sea) {
      const U4 = waterMat.uniforms;
      for (let i = 0; i < 4; i++) {
        const c = sea.comps[i];
        if (c) { U4.uSeaA.value[i].set(c.dx, c.dz, c.k, c.A); U4.uSeaB.value[i].set(c.w, c.ph, c.long ? 1 : 0, 0); }
        else { U4.uSeaA.value[i].set(1, 0, 0.1, 0); U4.uSeaB.value[i].set(0, 0, 0, 0); }
      }
      // 汎用の装飾波は海況が大きいほど控えめにして、海況ごとの波の特徴を際立たせる
      U4.uGen.value = clampN(0.75 - sea.H * 0.6, 0.3, 0.65);
      seaBaseY = sea.longAmp > 0.01 ? -(sea.longAmp + 0.12) : 0;
      U4.uBaseY.value = seaBaseY;
      seaPatch.visible = sea.longAmp > 0.01;
    },
    setVenue(venue, customWindDeg = null, sideBias = -0.6) {
      const isHakkei = venue === 'hakkeijima';
      enoshimaGroup.visible = !isHakkei;
      hakkeijimaGroup.visible = isHakkei;
      if (isHakkei) hakkeijimaGroup.updateMatrixWorld(true);
      else enoshimaGroup.updateMatrixWorld(true);
      // 八景島は北風スタート(15°北北東の風)、江の島は南南西(200°)。リアル気象時は取得した風向を使用
      const deg = (typeof customWindDeg === 'number' && Number.isFinite(customWindDeg)) ? customWindDeg : (isHakkei ? 15 : 200);
      setWindDir(deg);
      waterMat.uniforms.uW0.value = W0;
      waterMat.uniforms.uSideBias.value = sideBias;
      syncCourseObjects();
    },
    setTargetMark(legIndex, wt, finished) {
      if (finished) {
        for (const ar of targetArrows) ar.visible = false;
        activeMarkKeys = [];
        return;
      }
      const L = LEGS[Math.min(Math.max(0, legIndex || 0), LEGS.length - 1)];
      if (!L) return;
      // フィニッシュレグではマーク(fm)の上ではなく「FINISH」看板(finLabel)の真上にNext矢印を表示する
      if (L.type === 'finish') {
        activeMarkKeys = COURSE_MODE === 'upwind' ? ['m1'] : [];
        const ar0 = targetArrows[0];
        ar0.visible = true;
        ar0.position.x = finLabel.position.x;
        ar0.position.z = finLabel.position.z;
        ar0.userData.isFinish = true;
        ar0.userData.markKey = null;
        targetArrows[1].visible = false;
        return;
      }
      activeMarkKeys = L.type === 'gate' ? ['gL', 'gR'] : [L.markKey || 'm1'];
      for (let i = 0; i < targetArrows.length; i++) {
        const key = activeMarkKeys[i];
        const ar = targetArrows[i];
        if (key && markObjs[key]) {
          ar.visible = true;
          ar.position.x = markObjs[key].position.x;
          ar.position.z = markObjs[key].position.z;
          ar.userData.isFinish = false;
          ar.userData.markKey = key;
        } else {
          ar.visible = false;
          ar.userData.markKey = null;
        }
      }
    },
    // mode: 'start' | 'finish'  emph: 0..1 (プレイヤーが最終レグで強調)  showPreStart: スタート前のみtrue
    setLine(mode, emph, showPreStart = false) {
      finCurtainMat.opacity = 0.25 + 0.3 * emph + (emph > 0.5 ? 0.12 * Math.sin(performance.now() / 250) : 0);
      preStartGroup.visible = !!showPreStart;
    },
    update(t, camera, dt, wt = 0) {
      waterMat.uniforms.uTime.value = t; waterMat.uniforms.uWT.value = wt; waterMat.uniforms.uW0.value = W0; skyMat.uniforms.uTime.value = t;
      waterMat.uniforms.uShift.value = shiftAt(wt);
      sky.position.copy(camera.position);
      sea.position.set(camera.position.x, seaBaseY, camera.position.z);
      if (seaPatch.visible) {
        const cs = (PATCH_R * 2) / PATCH_SEG; // グリッド単位でスナップして頂点の揺らぎ(泳ぎ)を防ぐ
        seaPatch.position.set(Math.round(camera.position.x / cs) * cs, 0, Math.round(camera.position.z / cs) * cs);
        waterMat.uniforms.uPatchC.value.copy(seaPatch.position);
      }
      // マーク・ブイは海面の高さに合わせて上下し、波で揺れる
      for (const o of bob) {
        const ws = waveSample(o.position.x, o.position.z, SEA.clock, 1, 0);
        o.position.y = ws.hLong + (ws.h - ws.hLong) * 0.6 + 0.05 + 0.03 * Math.sin(t * 1.4 + o.position.x);
        o.rotation.z = clampN(Math.atan(ws.slope) * 0.6, -0.15, 0.15) + 0.03 * Math.sin(t * 1.1 + o.position.z);
      }
      flagSway.forEach((f, i) => { f.rotation.y = Math.sin(t * 2.6 + i * 1.7) * 0.12; });

      camera.getWorldDirection(camDir);
      const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      // ドローンカメラと自艇の視線上(0 < along < 44m)にマークが入った場合やカメラ接近時は完全に非表示(0)にして視界を遮らない
      const calcVis = (wx, wy, wz, minDist, fadeRange) => {
        const dx = wx - cx, dy = wy - cy, dz = wz - cz;
        const dCam = Math.hypot(dx, dz);
        const distFade = clampN((dCam - minDist) / fadeRange, 0, 1);
        if (distFade <= 0.01) return 0;
        const along = dx * camDir.x + dy * camDir.y + dz * camDir.z;
        if (along > -4 && along < 44) {
          const px = dx - camDir.x * along, py = dy - camDir.y * along, pz = dz - camDir.z * along;
          const perp = Math.hypot(px, py, pz);
          const losFade = clampN((perp - 8) / 9, 0, 1);
          return distFade * losFade;
        }
        return distFade;
      };

      // 1) マーク番号ラベル: 遠くにあるマークほど大きく拡大して遠くからでも番号がはっきり判読できるようにし、カメラ接近時は完全に消す
      for (const [k, sp] of Object.entries(markSprites)) {
        const mo = markObjs[k];
        if (!mo.visible) { sp.visible = false; continue; }
        const isAct = activeMarkKeys.includes(k);
        const dCam = Math.hypot(mo.position.x - cx, mo.position.z - cz);
        const baseS = isAct ? 4.8 : 4.0;
        const distBoost = Math.max(0, dCam - 50) * (isAct ? 0.048 : 0.040);
        const s = clampN(baseS + distBoost, baseS, isAct ? 22.0 : 18.0);
        sp.scale.set(s, s, 1);
        sp.position.y = 4.2 + (s - baseS) * 0.38;
        const v = calcVis(mo.position.x, sp.position.y, mo.position.z, isAct ? 26 : 55, 22);
        sp.material.opacity = 0.94 * v;
        sp.visible = v > 0.02;
      }

      // 2) マークの数字ラベルの「さらに上」に赤矢印＋Next表記を配置 (数字と重ならないよう番号サークルの最上部より上にオフセット)
      for (const ar of targetArrows) {
        if (!ar.visible) continue;
        const dCam = Math.hypot(ar.position.x - cx, ar.position.z - cz);
        const arScale = clampN(1.0 + Math.max(0, dCam - 55) * 0.0065, 1.0, 2.8);
        ar.scale.setScalar(arScale);
        if (ar.userData.isFinish) {
          ar.position.y = 18.8 + 0.65 * Math.sin(t * 3.2) + (arScale - 1.0) * 3.2;
        } else {
          const mk = ar.userData.markKey;
          const sp = mk && markSprites[mk];
          // マーク番号サークルの上端(sp.position.y + sp.scale.y * 0.56)のさらに上に矢印先端(local y=-3.45*arScale)が来るように配置
          const spTopY = sp ? (sp.position.y + sp.scale.y * 0.56) : 7.5;
          ar.position.y = spTopY + 3.85 * arScale + 0.55 * Math.sin(t * 3.2);
        }
        ar.rotation.y = t * 1.6;
        const v = calcVis(ar.position.x, ar.position.y, ar.position.z, 24, 18);
        ar.userData.mat.opacity = 0.96 * v;
        if (ar.userData.nextMat) ar.userData.nextMat.opacity = 0.96 * v;
      }
      for (const lb of [startLabel, finLabel]) {
        if (!lb) continue;
        const v = calcVis(lb.position.x, lb.position.y, lb.position.z, 32, 24);
        lb.material.opacity = 0.88 * v;
        lb.visible = v > 0.02;
      }
      if (preStartGroup.visible) {
        const vFav = calcVis(favEndBadge.position.x, favEndBadge.position.y, favEndBadge.position.z, 22, 18);
        favEndBadge.material.opacity = 0.92 * vFav;
        favEndBadge.visible = vFav > 0.02;
      }
      // 磯波: 白波が寄せては引く
      foamTex.offset.x = t * 0.004; foamTex.offset.y = 0.12 * Math.sin(t * 0.7);
      surfMat.opacity = 0.62 + 0.22 * Math.sin(t * 0.7 + 1.2);
    },
  };
}

function addTori(scene, x, h, z) {
  const m = new THREE.MeshLambertMaterial({ color: 0xd2382a });
  const g = new THREE.Group();
  for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 10, 8), m); p.position.set(s * 4, 5, 0); g.add(p); }
  const b1 = new THREE.Mesh(new THREE.BoxGeometry(12.5, 0.9, 1.4), m); b1.position.y = 10.2; g.add(b1);
  const b2 = new THREE.Mesh(new THREE.BoxGeometry(10, 0.7, 1), m); b2.position.y = 8; g.add(b2);
  g.position.set(x, h, z); scene.add(g);
}

// ---------- 八景島ステージ構築 (実地図・セーリングガイド準拠) ----------
// ワールド座標: x=東(+), 西(-), z=南(+), 北(-)。コースは八景島の東側海面(x≈0, z≈0)で北風(15°)スタート(北が風上)。
function buildHakkeijima(root, surfStrip, fgeo) {
  // 八景島の実際のレース海面は八景島マリーナから北東へ沖出しし、テクノタワーホテル正面沖付近まで出るため、
  // 陸地・背景グループ全体を南西(西へ280m・南へ980m)へオフセットしてコース(0,0〜北側上マーク)がテクノタワー沖に来るように配置
  root.position.set(-280, 0, 980);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), tc = new THREE.Color(), eul = new THREE.Euler();
  // 八景島本島 (オフセット後のワールド座標では x = -1530, z = +1130 の南西沖合に位置)
  const H_ISLAND = { x: -1250, z: 150, rx: 430, rz: 460 };

  const hakkeiIslandH = (x, z) => {
    const dx = (x - H_ISLAND.x) / H_ISLAND.rx, dz = (z - H_ISLAND.z) / H_ISLAND.rz;
    const u = dx * 0.92 + dz * 0.38, v = -dx * 0.38 + dz * 0.92;
    const n = noise2(x * 0.007, z * 0.007) * 0.1;
    const r = Math.pow(Math.pow(Math.abs(u), 2.5) + Math.pow(Math.abs(v), 2.5), 1 / 2.5) + n - 0.04;
    if (r >= 1.04) return -6;
    if (r >= 0.96) return -2 + (1.04 - r) * 70; // 人工島の護岸
    const hill = Math.max(0, 1 - Math.hypot(dx + 0.12, dz + 0.05) * 1.6) * 20;
    return 3.5 + hill + noise2(x * 0.03, z * 0.03) * 1.2;
  };

  const xs = [], zs = [];
  for (let i = 0; i <= 130; i++) xs.push(H_ISLAND.x - 520 + (1040 * i) / 130);
  for (let j = 0; j <= 130; j++) zs.push(H_ISLAND.z - 540 + (1080 * j) / 130);
  const islGeo = buildGrid(xs, zs, hakkeiIslandH, (x, z, h, out) => {
    const g = noise2(x / 18, z / 18);
    if (h < 3.6) out.setRGB(0.68, 0.67, 0.64); // コンクリート護岸・プロムナード
    else if (h < 7.2 && x > H_ISLAND.x - 180) out.setRGB(0.76 + 0.05 * g, 0.72 + 0.04 * g, 0.66); // ボードウォーク・広場
    else out.setRGB(0.12 + 0.06 * g, 0.30 + 0.08 * g, 0.11 + 0.04 * g); // 芝生・丘の緑地
  });
  root.add(new THREE.Mesh(islGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  // 1) アクアミュージアム (島の北側・白いピラミッド型の屋根を持つ大水族館) & その手前(東側海面)の防波堤(堤防)
  const aqx = H_ISLAND.x + 40, aqz = H_ISLAND.z - 190;
  const aq = new THREE.Group();
  const aqBase = new THREE.Mesh(new THREE.BoxGeometry(115, 18, 95), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
  aqBase.position.y = 9; aq.add(aqBase);
  const aqRoof = new THREE.Mesh(new THREE.ConeGeometry(68, 36, 4), new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x1e293b }));
  aqRoof.rotation.y = Math.PI / 4; aqRoof.position.set(0, 36, 0); aq.add(aqRoof);
  const aqSubRoof = new THREE.Mesh(new THREE.ConeGeometry(38, 22, 4), new THREE.MeshLambertMaterial({ color: 0xf1f5f9, emissive: 0x1e293b }));
  aqSubRoof.rotation.y = Math.PI / 4; aqSubRoof.position.set(38, 27, 25); aq.add(aqSubRoof);
  aq.position.set(aqx, Math.max(3.5, hakkeiIslandH(aqx, aqz) - 0.5), aqz);
  root.add(aq);

  // アクアミュージアム手前(東・北東側海面)に突き出るコンクリートの堤防(防波堤)と桟橋棟
  const aqBrkGroup = new THREE.Group();
  const aqBrkMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const aqBrkTopMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
  // 北側から東へ伸びる堤防と、水族館正面を囲むように南へ折れ曲がる外堤防・内桟橋
  for (const [bx, bz, bw, bd, rotY] of [
    [H_ISLAND.x + 310, aqz - 95, 230, 14, 0.08],   // 北側〜沖へ突き出る堤防
    [H_ISLAND.x + 425, aqz + 5, 15, 215, -0.10],   // 水族館の手前正面(東側沖)を南北に走る堤防
    [H_ISLAND.x + 355, aqz + 115, 140, 14, 0.25],  // 南端の折れ曲がり堤防
    [H_ISLAND.x + 255, aqz + 90, 145, 16, 0.0]     // 水族館南東側から伸びる桟橋護岸
  ]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(bw, 4.6, bd), aqBrkMat);
    wall.position.set(bx, 1.4, bz); wall.rotation.y = rotY;
    aqBrkGroup.add(wall);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(bw - 1, 0.8, bd + 1.2), aqBrkTopMat);
    cap.position.set(bx, 3.8, bz); cap.rotation.y = rotY;
    aqBrkGroup.add(cap);
  }
  // 堤防先端の赤・白灯台標識と内側の白い2階建て桟橋ハウス(うみファーム/客船ターミナル棟)
  const lhPole = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, 8.5, 10), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
  lhPole.position.set(H_ISLAND.x + 415, 7.5, aqz - 98); aqBrkGroup.add(lhPole);
  const pierBldg = new THREE.Mesh(new THREE.BoxGeometry(34, 8.5, 16), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
  pierBldg.position.set(H_ISLAND.x + 275, 6.2, aqz + 90); aqBrkGroup.add(pierBldg);
  const pierRoof = new THREE.Mesh(new THREE.ConeGeometry(22, 4.2, 4), new THREE.MeshLambertMaterial({ color: 0x94a3b8 }));
  pierRoof.rotation.y = Math.PI / 4; pierRoof.scale.set(1.2, 1, 0.7);
  pierRoof.position.set(H_ISLAND.x + 275, 12.4, aqz + 90); aqBrkGroup.add(pierRoof);
  root.add(aqBrkGroup);

  // 2) 旧ブルーフォール跡 (高さ107mのタワーは2020年3月に営業終了・同年解体済み → 跡地の中型アトラクション「フライトイーグル」級の門型フレームに置き換え)
  const bfx = H_ISLAND.x - 175, bfz = H_ISLAND.z - 210;
  const bfGroup = new THREE.Group();
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(2.2, 30, 2.2), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
    leg.position.set(s * 11, 15, 0); leg.rotation.z = s * 0.12; bfGroup.add(leg);
  }
  const bfTop = new THREE.Mesh(new THREE.BoxGeometry(20, 2.6, 3.2), new THREE.MeshLambertMaterial({ color: 0x0284c7 }));
  bfTop.position.y = 30; bfGroup.add(bfTop);
  const bfCap = new THREE.Mesh(new THREE.BoxGeometry(6, 3.5, 9), new THREE.MeshLambertMaterial({ color: 0xf59e0b }));
  bfCap.position.y = 18; bfGroup.add(bfCap);
  bfGroup.position.set(bfx, Math.max(3.5, hakkeiIslandH(bfx, bfz)), bfz);
  root.add(bfGroup);

  // 3) シーパラダイスタワー (高さ90mのパノラマ展望タワー: アクアミュージアムの少し南)
  const stx = H_ISLAND.x + 95, stz = H_ISLAND.z - 55;
  const stGroup = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.8, 88, 16), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
  mast.position.y = 44; stGroup.add(mast);
  for (let i = 0; i < 4; i++) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.65, 5, 16), new THREE.MeshLambertMaterial({ color: 0x1d4ed8 }));
    band.position.y = 18 + i * 18; stGroup.add(band);
  }
  const cabin = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, 4.2, 24), new THREE.MeshLambertMaterial({ color: 0x38bdf8, emissive: 0x0c4a6e }));
  cabin.position.y = 74; stGroup.add(cabin);
  const cabinRing = new THREE.Mesh(new THREE.CylinderGeometry(9.0, 9.0, 1.2, 24), new THREE.MeshLambertMaterial({ color: 0xffffff }));
  cabinRing.position.y = 76.2; stGroup.add(cabinRing);
  stGroup.position.set(stx, Math.max(3.5, hakkeiIslandH(stx, stz)), stz);
  root.add(stGroup);

  // 4) サーフコースター リヴァイアサン (水族館の南側・少し奥寄りに位置する青い海上ジェットコースター)
  const coaster = new THREE.Group();
  const railMat = new THREE.MeshLambertMaterial({ color: 0x0284c7 }); // 青色のコースターレール
  const trussMat = new THREE.MeshLambertMaterial({ color: 0x38bdf8 });
  const pillarMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
  const loopCx = H_ISLAND.x + 150, loopCz = H_ISLAND.z + 35; // 以前より少し奥側(西寄り)に配置
  for (let i = 0; i < 36; i++) {
    const t = (i / 36) * Math.PI * 2;
    const rx = loopCx + Math.cos(t) * 105, rz = loopCz + Math.sin(t) * 150;
    const ry = 10 + 25 * Math.pow(Math.sin(t * 2 + 0.3) * 0.5 + 0.5, 1.35);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(30, 2.4, 3.6), railMat);
    seg.position.set(rx, ry, rz);
    seg.rotation.y = -Math.atan2(Math.cos(t) * 150, -Math.sin(t) * 105);
    coaster.add(seg);
    const sub = new THREE.Mesh(new THREE.BoxGeometry(30, 1.0, 2.2), trussMat);
    sub.position.set(rx, ry - 1.6, rz); sub.rotation.y = seg.rotation.y;
    coaster.add(sub);
    if (i % 2 === 0) {
      const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.9, ry + 3, 6), pillarMat);
      pil.position.set(rx, ry / 2 - 1.5, rz);
      coaster.add(pil);
    }
  }
  root.add(coaster);

  // 5) ホテル シーパラダイス イン & その手前(海側・東側)の八景島マリーナ
  const htx = H_ISLAND.x + 40, htz = H_ISLAND.z + 310;
  const hotel = new THREE.Mesh(new THREE.BoxGeometry(42, 30, 95), new THREE.MeshLambertMaterial({ color: 0xfef3c7 }));
  hotel.position.set(htx, 18, htz); root.add(hotel);
  const hotelRoof = new THREE.Mesh(new THREE.BoxGeometry(45, 3, 98), new THREE.MeshLambertMaterial({ color: 0xb45309 }));
  hotelRoof.position.set(htx, 34, htz); root.add(hotelRoof);

  // 八景島マリーナ (ホテル棟のすぐ手前＝コース側、屋根は赤ではなく白〜明るいシルバーグレーのクラブハウス)
  const mhx = H_ISLAND.x + 290, mhz = H_ISLAND.z + 310;
  const conc = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const yard = new THREE.Mesh(new THREE.BoxGeometry(150, 3.2, 230), conc); yard.position.set(mhx, 0.6, mhz); root.add(yard);
  const club = new THREE.Mesh(new THREE.BoxGeometry(42, 9.5, 26), new THREE.MeshLambertMaterial({ color: 0xf8fafc })); club.position.set(mhx - 28, 6.8, mhz - 50); root.add(club);
  const clubRotunda = new THREE.Mesh(new THREE.CylinderGeometry(9.5, 9.5, 10.5, 16), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 })); clubRotunda.position.set(mhx - 7, 7.2, mhz - 50); root.add(clubRotunda);
  const clubRoof = new THREE.Mesh(new THREE.ConeGeometry(26, 4.5, 4), new THREE.MeshLambertMaterial({ color: 0xcbd5e1 })); clubRoof.rotation.y = Math.PI / 4; clubRoof.scale.set(1.15, 1, 0.8); clubRoof.position.set(mhx - 28, 13.8, mhz - 50); root.add(clubRoof);
  const clubRotRoof = new THREE.Mesh(new THREE.ConeGeometry(10.5, 3.2, 16), new THREE.MeshLambertMaterial({ color: 0x94a3b8 })); clubRotRoof.position.set(mhx - 7, 14.0, mhz - 50); root.add(clubRotRoof);
  const brk = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
  for (const [x, z, w, d] of [[mhx + 240, mhz, 10, 250], [mhx + 150, mhz - 125, 190, 10], [mhx + 130, mhz + 125, 150, 10]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, 4.2, d), brk); b.position.set(x, 1.0, z); root.add(b);
  }
  const hulls = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 1, 7), new THREE.MeshLambertMaterial({ color: 0xffffff }), 55);
  const masts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.15, 11, 5), new THREE.MeshLambertMaterial({ color: 0xcfd3d8 }), 55);
  for (let i = 0; i < 55; i++) {
    const x = mhx + 85 + (i % 11) * 13, z = mhz - 95 + Math.floor(i / 11) * 44;
    m4.makeTranslation(x, 0.6, z); hulls.setMatrixAt(i, m4); tc.setHSL(rnd(), 0.25, 0.88); hulls.setColorAt(i, tc);
    m4.makeTranslation(x, 6.4, z); masts.setMatrixAt(i, m4);
  }
  root.add(hulls, masts);

  // 八景島内の木々
  const hTreeCount = 850;
  const hTrees = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial(), hTreeCount);
  let tn = 0;
  for (let tries = 0; tries < 5000 && tn < hTreeCount; tries++) {
    const x = H_ISLAND.x + (rnd() * 2 - 1) * 390, z = H_ISLAND.z + (rnd() * 2 - 1) * 410;
    const h = hakkeiIslandH(x, z); if (h < 4.2) continue;
    if (Math.hypot(x - aqx, z - aqz) < 75) continue;
    const s = 3.2 + rnd() * 3.8;
    q.setFromEuler(eul.set(0, rnd() * 6.28, 0));
    m4.compose(new THREE.Vector3(x, h + s * 0.35, z), q, new THREE.Vector3(s, s * 0.75, s));
    hTrees.setMatrixAt(tn, m4); tc.setRGB(0.08 + rnd() * 0.06, 0.22 + rnd() * 0.12, 0.07 + rnd() * 0.04); hTrees.setColorAt(tn, tc); tn++;
  }
  q.identity(); hTrees.count = tn; root.add(hTrees);

  // 6) 八景島大橋 & シーサイドライン高架橋 (福浦・海の公園側から水道を大きく跨いで八景島へ伸びる非常に長い橋と中央主塔)
  const ohGroup = new THREE.Group();
  const ohX = H_ISLAND.x - 420, ohZ = H_ISLAND.z - 480;
  const ohRot = 0.22;
  // 長大な連続高架橋デッキ (全長約1,150m)
  const ohDeck = new THREE.Mesh(new THREE.BoxGeometry(20, 3.6, 1150), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
  ohDeck.position.set(ohX, 15.5, ohZ); ohDeck.rotation.y = ohRot; ohGroup.add(ohDeck);
  // 特徴的な中央の白い主塔 (斜張橋・エクストラドーズド風の白い1本主塔とケーブル、および青いアーチ桁)
  const pylon = new THREE.Mesh(new THREE.BoxGeometry(5.5, 56, 7.5), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
  pylon.position.set(ohX, 34, ohZ); pylon.rotation.y = ohRot; ohGroup.add(pylon);
  for (const s of [-7.5, 7.5]) {
    const archRib = new THREE.Mesh(new THREE.TorusGeometry(95, 2.2, 8, 32, Math.PI), new THREE.MeshLambertMaterial({ color: 0x0284c7 }));
    archRib.rotation.y = Math.PI / 2 + ohRot;
    archRib.scale.set(1.2, 0.55, 1);
    archRib.position.set(ohX + s * Math.cos(ohRot), 16.0, ohZ - s * Math.sin(ohRot));
    ohGroup.add(archRib);
  }
  // 長い橋を支える多数の橋脚列
  for (let dz = -520; dz <= 520; dz += 80) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(22, 18, 6.5), new THREE.MeshLambertMaterial({ color: 0x94a3b8 }));
    pier.position.set(ohX + dz * Math.sin(ohRot), 7, ohZ + dz * Math.cos(ohRot));
    pier.rotation.y = ohRot; ohGroup.add(pier);
  }
  // マリンゲート橋 (八景島西側〜海の公園側を結ぶ長い連絡橋)
  const brMesh = new THREE.Mesh(new THREE.BoxGeometry(780, 3.0, 13), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
  brMesh.position.set(H_ISLAND.x - 660, 12.0, H_ISLAND.z - 160); ohGroup.add(brMesh);
  for (let dx = -340; dx <= 340; dx += 85) {
    const mp = new THREE.Mesh(new THREE.BoxGeometry(6, 14, 15), new THREE.MeshLambertMaterial({ color: 0x94a3b8 }));
    mp.position.set(H_ISLAND.x - 660 + dx, 5.5, H_ISLAND.z - 160); ohGroup.add(mp);
  }
  const mgArch = new THREE.Mesh(new THREE.TorusGeometry(48, 1.8, 8, 24, Math.PI), new THREE.MeshLambertMaterial({ color: 0x38bdf8 }));
  mgArch.position.set(H_ISLAND.x - 510, 13.0, H_ISLAND.z - 160); ohGroup.add(mgArch);
  root.add(ohGroup);

  // 7) 八景島の北側: 福浦エリア・セーリングガイド記載の名物ランドマーク群と海岸線の並木
  // (横浜市大病院・ヘリポート・海岸線の並木・テクノタワーホテル・ヤグラ型エントツ・焼却炉・三菱重工)
  const fukuura = new THREE.Group();
  const fkLand = new THREE.Mesh(new THREE.BoxGeometry(2250, 4.5, 3200), new THREE.MeshLambertMaterial({ color: 0xd6d3c9 }));
  fkLand.position.set(-1675, 1.2, -2250); fukuura.add(fkLand);
  const fkWall = new THREE.Mesh(new THREE.BoxGeometry(16, 5.2, 3200), new THREE.MeshLambertMaterial({ color: 0xcbd5e1 }));
  fkWall.position.set(-555, 1.6, -2250); fukuura.add(fkWall);

  // (7-a) 海岸線の並木 (セーリングガイドの通り、ヘリポート北側からヤグラ型エントツ手前まで海岸線に沿って緑の木々がずらりと並ぶ)
  const coastTreeCount = 160;
  const coastTrees = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshLambertMaterial(), coastTreeCount);
  const coastTrunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.3, 1, 6), new THREE.MeshLambertMaterial({ color: 0x5c4033 }), coastTreeCount);
  let ctn = 0;
  for (let z = -700; z >= -2120 && ctn < coastTreeCount; z -= 18) {
    for (const row of [0, 1]) {
      if (ctn >= coastTreeCount) break;
      const tx = -572 - row * 16 + (rnd() - 0.5) * 5;
      const tz = z - row * 9 + (rnd() - 0.5) * 5;
      const s = 9.5 + rnd() * 4.0;
      q.setFromEuler(eul.set(0, rnd() * 6.28, 0));
      m4.compose(new THREE.Vector3(tx, 3.5 + s * 0.85, tz), q, new THREE.Vector3(s * 0.95, s * 0.85, s * 0.95));
      coastTrees.setMatrixAt(ctn, m4);
      tc.setRGB(0.10 + rnd() * 0.06, 0.34 + rnd() * 0.12, 0.09 + rnd() * 0.05);
      coastTrees.setColorAt(ctn, tc);
      q.identity();
      m4.compose(new THREE.Vector3(tx, 3.5 + s * 0.35, tz), q, new THREE.Vector3(s * 0.12, s * 0.7, s * 0.12));
      coastTrunks.setMatrixAt(ctn, m4);
      ctn++;
    }
  }
  coastTrees.count = ctn; coastTrunks.count = ctn;
  fukuura.add(coastTrunks, coastTrees);

  // (7-b) 海に突き出た「横浜ヘリポート」
  const hpx = -390, hpz = -780;
  const hpPad = new THREE.Mesh(new THREE.BoxGeometry(340, 4.2, 240), new THREE.MeshLambertMaterial({ color: 0x64748b }));
  hpPad.position.set(hpx, 1.1, hpz); fukuura.add(hpPad);
  const hpApron = new THREE.Mesh(new THREE.PlaneGeometry(300, 200), new THREE.MeshBasicMaterial({ color: 0x334155 }));
  hpApron.rotation.x = -Math.PI / 2; hpApron.position.set(hpx, 3.3, hpz); fukuura.add(hpApron);
  const hRing = new THREE.Mesh(new THREE.RingGeometry(34, 40, 32), new THREE.MeshBasicMaterial({ color: 0xfacc15, side: THREE.DoubleSide }));
  hRing.rotation.x = -Math.PI / 2; hRing.position.set(hpx + 45, 3.4, hpz); fukuura.add(hRing);
  for (const dx of [-13, 13]) {
    const hBar = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 36), new THREE.MeshBasicMaterial({ color: 0xfacc15 }));
    hBar.rotation.x = -Math.PI / 2; hBar.position.set(hpx + 45 + dx, 3.42, hpz); fukuura.add(hBar);
  }
  const hCross = new THREE.Mesh(new THREE.PlaneGeometry(26, 5.5), new THREE.MeshBasicMaterial({ color: 0xfacc15 }));
  hCross.rotation.x = -Math.PI / 2; hCross.position.set(hpx + 45, 3.42, hpz); fukuura.add(hCross);

  // (7-c) 横浜市大病院 (ヘリポートのすぐ背後 x=-635, z=-800 に建つ十字・段差型の大きな大学病院棟: 窓帯と赤十字看板付きで海上からしっかり見える)
  const hospGroup = new THREE.Group();
  const hospX = -635, hospZ = -800;
  const hospMat = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const hospSubMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
  const hospWinMat = new THREE.MeshLambertMaterial({ color: 0x334155 });
  // 中央高層病棟 + 南北ウイング + 東側外来棟 (イラストの立体十字形状を再現)
  for (const [dx, dz, bw, bh, bd, mat] of [
    [0, 0, 95, 74, 150, hospMat],       // 中央主病棟
    [55, 0, 75, 54, 95, hospSubMat],    // 海側(東)ウイング
    [-55, 0, 75, 58, 105, hospSubMat],  // 西ウイング
    [15, -85, 80, 46, 65, hospMat],     // 北ウイング
    [15, 85, 80, 46, 65, hospMat],      // 南ウイング
  ]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
    wing.position.set(dx, bh / 2 + 3, dz); hospGroup.add(wing);
    for (let wy = 12; wy < bh - 4; wy += 9) {
      const wBand = new THREE.Mesh(new THREE.BoxGeometry(bw + 1.5, 3.2, bd + 1.5), hospWinMat);
      wBand.position.set(dx, wy + 3, dz); hospGroup.add(wBand);
    }
  }
  // 病院屋上のペントハウスと赤い病院マーク塔
  const hospTop = new THREE.Mesh(new THREE.BoxGeometry(48, 14, 52), new THREE.MeshLambertMaterial({ color: 0x0284c7 }));
  hospTop.position.set(0, 84, 0); hospGroup.add(hospTop);
  const redCrossV = new THREE.Mesh(new THREE.BoxGeometry(2.5, 10, 3.2), new THREE.MeshBasicMaterial({ color: 0xdc2626 }));
  redCrossV.position.set(25, 84, 0); hospGroup.add(redCrossV);
  const redCrossH = new THREE.Mesh(new THREE.BoxGeometry(2.5, 3.2, 10), new THREE.MeshBasicMaterial({ color: 0xdc2626 }));
  redCrossH.position.set(25, 84, 0); hospGroup.add(redCrossH);
  hospGroup.position.set(hospX, 0, hospZ);
  fukuura.add(hospGroup);

  // (7-d) テクノタワーホテル (福浦のランドマークとなるひときわ高い段差型超高層ビル: 周囲の建物より圧倒的に高く海上から一目でわかるように再現)
  const tthGroup = new THREE.Group();
  const tthX = -760, tthZ = -1460;
  const tthMat = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const tthSideMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  // メイン超高層タワー (高さ155m・段差構造)
  const tthBase = new THREE.Mesh(new THREE.BoxGeometry(74, 115, 68), tthSideMat);
  tthBase.position.set(0, 60, 0); tthGroup.add(tthBase);
  const tthShaft = new THREE.Mesh(new THREE.BoxGeometry(58, 152, 54), tthMat);
  tthShaft.position.set(6, 78, -4); tthGroup.add(tthShaft);
  const tthTop = new THREE.Mesh(new THREE.BoxGeometry(42, 22, 40), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
  tthTop.position.set(6, 162, -4); tthGroup.add(tthTop);
  // ホテルのガラスカーテンウォール・窓ストライプ
  const tthGlass = new THREE.Mesh(new THREE.BoxGeometry(60, 136, 26), new THREE.MeshLambertMaterial({ color: 0x0284c7, emissive: 0x0c4a6e }));
  tthGlass.position.set(6, 80, -4); tthGroup.add(tthGlass);
  for (let wy = 18; wy <= 144; wy += 12) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(60.5, 3.2, 55.5), hospWinMat);
    stripe.position.set(6, wy, -4); tthGroup.add(stripe);
  }
  // テクノタワーホテルのすぐ海側(右隣)の青緑色のビル(テクノタワーが際立つよう周辺建物は小さめに調整)
  const subBld = new THREE.Mesh(new THREE.BoxGeometry(44, 38, 42), new THREE.MeshLambertMaterial({ color: 0x38bdf8 }));
  subBld.position.set(78, 21, 14); tthGroup.add(subBld);
  const subRoof = new THREE.Mesh(new THREE.BoxGeometry(46, 2.5, 44), new THREE.MeshLambertMaterial({ color: 0xcbd5e1 }));
  subRoof.position.set(78, 41, 14); tthGroup.add(subRoof);
  for (const ox of [68, 78, 88]) {
    const unit = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 4, 10), new THREE.MeshLambertMaterial({ color: 0xea580c }));
    unit.position.set(ox, 44, 14); tthGroup.add(unit);
  }
  tthGroup.position.set(tthX, 0, tthZ);
  tthGroup.scale.y = 0.6; // 実際の横浜テクノタワーホテル(横浜金沢ハイテクセンター)は地上22階・高さ約100m
  fukuura.add(tthGroup);

  // (7-e) ヤグラ型エントツ (海岸線の北寄り角にある鉄骨トラスの櫓煙突と茶色い建屋)
  const yagX = -680, yagZ = -2220;
  const yagCore = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 7.5, 105, 12), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
  yagCore.position.set(yagX, 55, yagZ); fukuura.add(yagCore);
  const yagRed = new THREE.Mesh(new THREE.CylinderGeometry(5.8, 6.2, 16, 12), new THREE.MeshLambertMaterial({ color: 0xdc2626 }));
  yagRed.position.set(yagX, 98, yagZ); fukuura.add(yagRed);
  const trussCol = new THREE.MeshLambertMaterial({ color: 0x475569 });
  for (const sx of [-12, 12]) for (const sz of [-12, 12]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(2.5, 100, 2.5), trussCol);
    post.position.set(yagX + sx, 52, yagZ + sz); fukuura.add(post);
  }
  for (let h = 18; h <= 96; h += 18) {
    const ring = new THREE.Mesh(new THREE.BoxGeometry(27, 2.0, 27), trussCol);
    ring.position.set(yagX, h, yagZ); fukuura.add(ring);
  }
  const yagBld = new THREE.Mesh(new THREE.BoxGeometry(85, 28, 75), new THREE.MeshLambertMaterial({ color: 0xa8a29e }));
  yagBld.position.set(yagX - 55, 16, yagZ + 20); fukuura.add(yagBld);

  // (7-f) 焼却炉 (白地に水色トップの高層煙突と工場棟) & 三菱重工 (4棟並んだ白い三角屋根の大工場群: イラスト通り北岸に配置)
  // 北端の幸浦埋立地張り出し
  const northPier = new THREE.Mesh(new THREE.BoxGeometry(750, 4.5, 750), new THREE.MeshLambertMaterial({ color: 0xd6d3c9 }));
  northPier.position.set(-720, 1.2, -2850); fukuura.add(northPier);
  const incX = -1020, incZ = -2820;
  const incBld = new THREE.Mesh(new THREE.BoxGeometry(150, 44, 140), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
  incBld.position.set(incX, 24, incZ); fukuura.add(incBld);
  // 金沢工場(資源循環局)の煙突: 実際の高さ130m
  const incStack = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 12, 122, 16), new THREE.MeshLambertMaterial({ color: 0xffffff }));
  incStack.position.set(incX - 95, 62, incZ); fukuura.add(incStack);
  const incCap = new THREE.Mesh(new THREE.CylinderGeometry(9.0, 9.5, 14, 16), new THREE.MeshLambertMaterial({ color: 0x0284c7 }));
  incCap.position.set(incX - 95, 126, incZ); fukuura.add(incCap);

  // 三菱重工の4連白い蒲鉾/三角屋根工場棟 (イラスト右上・焼却炉の右隣に4棟並ぶ)
  for (let i = 0; i < 4; i++) {
    const hx = -820 + i * 82, hz = -2820;
    const hall = new THREE.Mesh(new THREE.BoxGeometry(74, 34, 210), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
    hall.position.set(hx, 19, hz); fukuura.add(hall);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(38, 38, 210, 3), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
    roof.rotation.x = Math.PI / 2; roof.rotation.y = Math.PI;
    roof.position.set(hx, 38, hz); roof.scale.set(1, 1, 0.45); fukuura.add(roof);
  }

  // テクノタワーホテル周辺 (金沢区福浦1〜3丁目・金沢産業振興センター・MDC物流センター・日本発条・研究所群・シーサイドライン高架)
  const fukuColors = [0xf8fafc, 0xe2e8f0, 0xf1f5f9, 0xdbeafe, 0xe5e7eb, 0xd6d3d1];
  const fukuRoofMat = new THREE.MeshLambertMaterial({ color: 0x64748b });
  const fukuStripeBlue = new THREE.MeshLambertMaterial({ color: 0x0284c7 });
  const fukuStripeNavy = new THREE.MeshLambertMaterial({ color: 0x1e3a8a });
  const fukuWinMat = new THREE.MeshLambertMaterial({ color: 0x38bdf8, emissive: 0x082f49 });

  // 1) テクノタワー直近の金沢産業振興センター本館・ホール棟・研究所ビル群 & 周辺工場・物流倉庫群
  for (const [bx, bz, bw, bh, bd, ci, hasStripe] of [
    // 福浦1丁目 (市大医学部北〜福浦駅周辺: 研究所・製薬・精密工場群)
    [-635, -960, 66, 26, 56, 0, 1],
    [-735, -980, 74, 32, 62, 1, 0],
    [-640, -1065, 68, 24, 58, 2, 1],
    [-750, -1095, 82, 34, 66, 3, 2],
    [-635, -1175, 64, 22, 54, 0, 0],
    [-745, -1210, 78, 30, 64, 1, 1],
    [-640, -1290, 70, 26, 58, 4, 0],
    // テクノタワーホテル(x=-760, z=-1460)を取り囲む産業振興センター附属棟・ハイテクセンター・企業ビル群
    [-650, -1385, 68, 28, 56, 0, 2],
    [-865, -1380, 76, 34, 62, 3, 1],
    [-645, -1475, 62, 24, 58, 2, 1],  // テクノタワー海側(東隣)のホール・展示棟
    [-875, -1470, 82, 36, 68, 1, 2],  // テクノタワー内陸側(西隣)のオフィス・研究棟
    [-650, -1565, 70, 28, 60, 0, 1],
    [-765, -1585, 78, 32, 62, 2, 0],
    [-880, -1580, 84, 30, 66, 4, 1],
    // 福浦2丁目・3丁目 (テクノタワー北側〜ヤグラ煙突: 日本発条本社工場・MDC大型物流センター・大型倉庫群)
    [-645, -1675, 76, 26, 64, 0, 1],
    [-765, -1700, 92, 36, 74, 1, 2],
    [-895, -1695, 88, 30, 70, 5, 0],
    [-640, -1795, 74, 24, 62, 2, 1],
    [-760, -1825, 96, 38, 78, 0, 2],  // 大型マルチテナント物流施設(MDC)
    [-900, -1820, 86, 28, 72, 1, 0],
    [-645, -1920, 72, 25, 60, 4, 1],
    [-765, -1950, 90, 34, 74, 3, 2],
    [-895, -1945, 84, 26, 68, 0, 0],
    [-645, -2040, 76, 28, 64, 1, 1],
    [-770, -2075, 88, 32, 70, 2, 2],
    [-895, -2070, 82, 26, 66, 5, 0],
    [-775, -2175, 78, 26, 62, 0, 1],
    // さらに内陸側(第3列: x=-1020〜-1220)の工場・物流倉庫群で奥行きのスカイラインを形成
    [-1015, -1040, 88, 28, 72, 1, 0],
    [-1025, -1180, 92, 32, 76, 0, 1],
    [-1020, -1330, 86, 26, 70, 4, 0],
    [-1025, -1470, 96, 38, 80, 2, 2],
    [-1020, -1620, 90, 30, 74, 1, 1],
    [-1030, -1770, 98, 36, 82, 0, 2],
    [-1020, -1920, 92, 28, 76, 5, 0],
    [-1025, -2060, 88, 30, 72, 2, 1],
    [-1170, -1120, 84, 24, 68, 4, 0],
    [-1175, -1300, 90, 28, 74, 1, 0],
    [-1170, -1480, 94, 32, 78, 0, 1],
    [-1175, -1660, 88, 26, 72, 2, 0],
    [-1170, -1840, 92, 30, 76, 1, 1],
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), new THREE.MeshLambertMaterial({ color: fukuColors[ci] }));
    m.position.set(bx, bh / 2 + 3, bz); fukuura.add(m);
    const rf = new THREE.Mesh(new THREE.BoxGeometry(bw + 2, 1.6, bd + 2), fukuRoofMat);
    rf.position.set(bx, bh + 3.6, bz); fukuura.add(rf);
    if (hasStripe > 0) {
      const stMat = hasStripe === 2 ? fukuStripeNavy : fukuStripeBlue;
      const st = new THREE.Mesh(new THREE.BoxGeometry(bw + 1.2, 2.6, bd + 1.2), stMat);
      st.position.set(bx, bh - 1.5, bz); fukuura.add(st);
      const winBand = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.8, 3.2, bd * 0.82), fukuWinMat);
      winBand.position.set(bx, bh * 0.62 + 3, bz); fukuura.add(winBand);
    }
  }

  // 2) 金沢シーサイドラインの高架軌道と駅舎 (市大医学部駅〜福浦駅〜産業振興センター駅〜幸浦駅: x=-825付近を南北に貫く)
  const viaductMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const pierMat = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
  const viaBeam = new THREE.Mesh(new THREE.BoxGeometry(9.5, 3.2, 1680), viaductMat);
  viaBeam.position.set(-825, 12.5, -1540); fukuura.add(viaBeam);
  for (let pz = -740; pz >= -2340; pz -= 60) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(3.6, 11, 4.2), pierMat);
    pier.position.set(-825, 6.5, pz); fukuura.add(pier);
  }
  for (const stZ of [-820, -1180, -1480, -1920]) {
    const stBox = new THREE.Mesh(new THREE.BoxGeometry(18, 7.5, 58), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
    stBox.position.set(-825, 16.2, stZ); fukuura.add(stBox);
    const stRoof = new THREE.Mesh(new THREE.BoxGeometry(20, 1.5, 60), fukuStripeBlue);
    stRoof.position.set(-825, 20.4, stZ); fukuura.add(stRoof);
  }

  // 3) 福浦岸壁プロムナード沿いの防風林(緑地帯)と球形ガスタンク・サイロ群
  const treeMatF = new THREE.MeshLambertMaterial({ color: 0x166534 });
  for (let tz = -920; tz >= -2120; tz -= 48) {
    const tr = new THREE.Mesh(new THREE.ConeGeometry(8.5, 16, 7), treeMatF);
    tr.position.set(-582, 10, tz); fukuura.add(tr);
  }
  for (const [tx, tz] of [[-625, -1625], [-625, -1655], [-630, -2120], [-660, -2120]]) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 20, 14), new THREE.MeshLambertMaterial({ color: 0xf1f5f9 }));
    tank.position.set(tx, 13, tz); fukuura.add(tank);
  }

  // 八景大橋(x≈-1670)と横浜市大医学部病院(x=-635, z=-800)の間の海岸・キャンパス・駅周辺の建物群
  const midBldColors = [0xf8fafc, 0xe2e8f0, 0xf1f5f9, 0xdbeafe, 0xe7e5e4];
  for (const [bx, bz, bw, bh, bd, ci] of [
    [-820, -760, 68, 28, 54, 0],   // 医学部研究棟(東)
    [-925, -790, 74, 32, 58, 1],   // 医学部研究棟(西)
    [-1040, -740, 62, 22, 48, 2],  // 看護学部・キャンパス棟
    [-1150, -780, 58, 20, 52, 0],
    [-1260, -730, 64, 24, 46, 3],  // シーサイドライン駅舎・周辺ビル
    [-1370, -760, 56, 18, 48, 1],
    [-1480, -710, 60, 22, 50, 4],  // 八景大橋たもと周辺の建物
    [-1560, -770, 52, 18, 44, 0],
    [-880, -910, 58, 18, 48, 2],
    [-1010, -900, 64, 20, 52, 1],
    [-1160, -920, 56, 16, 46, 4],
    [-1310, -890, 60, 18, 50, 0],
    [-1450, -880, 54, 16, 44, 2],
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), new THREE.MeshLambertMaterial({ color: midBldColors[ci] }));
    m.position.set(bx, bh / 2 + 3, bz); fukuura.add(m);
    const rf = new THREE.Mesh(new THREE.BoxGeometry(bw + 2, 1.8, bd + 2), new THREE.MeshLambertMaterial({ color: 0x64748b }));
    rf.position.set(bx, bh + 3.8, bz); fukuura.add(rf);
  }
  root.add(fukuura);

  // 8) 西岸の陸地 (海の公園の砂浜〜野島公園〜南側の横須賀・追浜・夏島エリアの緑の丘陵)
  const westX = [], westZ = [];
  for (let i = 0; i <= 90; i++) westX.push(-9500 + (8200 * i) / 90);
  for (let j = 0; j <= 120; j++) westZ.push(-4500 + (11000 * j) / 120);
  const wCoastX = (z) => -1750 + 220 * Math.sin(z / 950) + (z > 900 ? Math.min(750, (z - 900) * 0.42) : 0);
  const wLandH = (x, z) => {
    const d = wCoastX(z) - x;
    if (d < 0) return -6;
    const ramp = smooth(0, 120, d);
    const isYokosuka = smooth(600, 1400, z);
    const hillBase = isYokosuka ? smooth(80, 900, d) * 145 : Math.pow(smooth(450, 4000, d), 1.3) * 130;
    return -1.0 + 3.2 * ramp + hillBase * (0.45 + 0.55 * noise2(x / 900, z / 900));
  };
  const wColorLand = (x, z, h, out) => {
    const d = wCoastX(z) - x;
    if (h < 0.2) out.setRGB(0.42, 0.40, 0.35);
    else if (z > -600 && z < 750 && d < 130) out.setRGB(0.78, 0.73, 0.60); // 海の公園の白砂ビーチ
    else if (z >= 900 && z <= 2500 && d < 320) out.setRGB(0.54, 0.56, 0.58); // 夏島・住友重機械の工場敷地岸壁
    else {
      const g = noise2(x / 120, z / 120);
      out.setRGB(0.11 + 0.05 * g, 0.24 + 0.08 * g, 0.09 + 0.03 * g);
    }
  };
  const wGeo = buildGrid(westX, westZ, wLandH, wColorLand);
  root.add(new THREE.Mesh(wGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  // 海の公園の波打ち際白波
  const wcpts = [];
  for (let z = -550; z <= 750; z += 35) wcpts.push({ x: wCoastX(z), z, ux: 1, uz: 0 });
  surfStrip(root, wcpts, 12);

  // 9) 横須賀側 (南〜南西 z = +1150 〜 +2350): 住友重機械工業 横須賀製造所のオレンジ色ゴライアスクレーンと白い大工場棟 (画像準拠)
  const shi = new THREE.Group();
  const shiX = -1050, shiZ = 1650;
  const shiYard = new THREE.Mesh(new THREE.BoxGeometry(660, 4.5, 1180), new THREE.MeshLambertMaterial({ color: 0x64748b }));
  shiYard.position.set(shiX, 1.2, shiZ); shi.add(shiYard);
  // クレーンの右手(西側)に並ぶ白い大型工場建屋 (暗い横連窓ストライプ入り)
  for (const [dx, dz, w, h, d, cBody, cRoof] of [
    [-90, 90, 290, 54, 340, 0xf8fafc, 0x475569],   // 写真右側の白い巨大工場棟
    [-110, -250, 250, 42, 210, 0xf1f5f9, 0x334155],
    [-95, 380, 230, 38, 180, 0xe2e8f0, 0x334155],
    [110, 140, 140, 30, 190, 0xf8fafc, 0x475569],
  ]) {
    const bld = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: cBody }));
    bld.position.set(shiX + dx, h / 2 + 3, shiZ + dz); shi.add(bld);
    const rf = new THREE.Mesh(new THREE.BoxGeometry(w + 4, 2.5, d + 4), new THREE.MeshLambertMaterial({ color: cRoof }));
    rf.position.set(shiX + dx, h + 4.2, shiZ + dz); shi.add(rf);
    // 工場壁面の横連窓バンド
    for (const wy of [h * 0.45, h * 0.75]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(w + 1.5, 3.5, d * 0.92), new THREE.MeshLambertMaterial({ color: 0x334155 }));
      win.position.set(shiX + dx, wy + 3, shiZ + dz); shi.add(win);
    }
  }
  // 住友重工の象徴: 鮮やかなオレンジ色(赤橙)の巨大ゴライアスクレーン (脚に白帯・上部にSUMITOMO白文字プレート)
  const craneOrange = new THREE.MeshLambertMaterial({ color: 0xea580c });
  const craneOrangeSub = new THREE.MeshLambertMaterial({ color: 0xf97316 });
  const craneWhite = new THREE.MeshLambertMaterial({ color: 0xffffff });
  for (const [cz, ch, span] of [[shiZ - 140, 112, 185], [shiZ + 220, 98, 160]]) {
    const cx = shiX + 135;
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(6.5, ch, 8.5), craneOrange);
      leg.position.set(cx, ch / 2 + 3, cz + s * (span / 2)); shi.add(leg);
      // 脚の紅白(オレンジ×白)ストライプ帯
      for (const bh of [ch * 0.35, ch * 0.68]) {
        const wBand = new THREE.Mesh(new THREE.BoxGeometry(7.0, 10, 9.0), craneWhite);
        wBand.position.set(cx, bh + 3, cz + s * (span / 2)); shi.add(wBand);
      }
      const brace = new THREE.Mesh(new THREE.BoxGeometry(5.2, ch * 0.92, 5.2), craneOrange);
      brace.position.set(cx - 14, ch * 0.46 + 3, cz + s * (span / 2)); brace.rotation.z = -0.22; shi.add(brace);
    }
    // 上部オレンジガーダー(横桁) + SUMITOMO白ロゴ帯
    const girder = new THREE.Mesh(new THREE.BoxGeometry(13, 9.5, span + 34), craneOrange);
    girder.position.set(cx - 4, ch + 5, cz); shi.add(girder);
    const logo = new THREE.Mesh(new THREE.BoxGeometry(13.6, 5.2, span * 0.58), craneWhite);
    logo.position.set(cx - 4, ch + 5, cz); shi.add(logo);
  }
  // 周囲のオレンジ色ジブクレーン群
  for (const [jx, jz] of [[shiX + 215, shiZ - 310], [shiX + 225, shiZ + 20], [shiX + 205, shiZ + 360]]) {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 5, 28, 8), craneOrange);
    base.position.set(jx, 16, jz); shi.add(base);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 2.2, 85, 6), craneOrangeSub);
    boom.position.set(jx + 18, 52, jz); boom.rotation.z = -0.46; shi.add(boom);
  }
  root.add(shi);

  // 10) 東京湾の船舶・海上構造物 (八景島遊覧船「パラダイス」・大型商船/コンテナ船・漁船・シーバース・小柴ブイ・沖ノ根)
  const bayShips = new THREE.Group();

  // (10-a) 八景島の島回り遊覧船「パラダイス」(写真準拠: 黒×赤の2階建て外輪船・金の丸窓・2本煙突・赤い外輪)
  const para = new THREE.Group();
  const pBlack = new THREE.MeshLambertMaterial({ color: 0x1e293b });
  const pRed = new THREE.MeshLambertMaterial({ color: 0xdc2626 });
  const pWhite = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const pGold = new THREE.MeshLambertMaterial({ color: 0xf59e0b });
  // 黒い船体 + 白喫水ライン + 赤いブルワーク縁取り (全長約28mにスケールアップして視認性確保)
  const pHull = new THREE.Mesh(new THREE.BoxGeometry(7.2, 2.8, 28), pBlack);
  pHull.position.y = 1.2; para.add(pHull);
  const pBow = new THREE.Mesh(new THREE.ConeGeometry(5.1, 7.5, 4), pBlack);
  pBow.rotation.x = Math.PI / 2; pBow.rotation.z = Math.PI / 4; pBow.position.set(0, 1.2, 17.5); para.add(pBow);
  const pStripe = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.45, 28.2), pWhite);
  pStripe.position.y = 2.4; para.add(pStripe);
  const pDeck1 = new THREE.Mesh(new THREE.BoxGeometry(6.6, 2.8, 21), pBlack);
  pDeck1.position.set(0, 3.8, -0.5); para.add(pDeck1);
  const pRedBand = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.55, 21.4), pRed);
  pRedBand.position.set(0, 5.2, -0.5); para.add(pRedBand);
  // 1階側面の金色の丸窓 (片側5個ずつ)
  for (const sx of [-3.35, 3.35]) for (let wz = -7.5; wz <= 6.5; wz += 3.5) {
    const port = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, 0.2, 12), pGold);
    port.rotation.z = Math.PI / 2; port.position.set(sx, 3.8, wz); para.add(port);
  }
  // 2階オープンデッキの屋根と前方の操舵室
  const pBridge = new THREE.Mesh(new THREE.BoxGeometry(5.6, 2.6, 5.5), pBlack);
  pBridge.position.set(0, 6.6, 6.8); para.add(pBridge);
  const pBridgeWin = new THREE.Mesh(new THREE.BoxGeometry(5.8, 1.1, 5.7), pGold);
  pBridgeWin.position.set(0, 6.9, 6.8); para.add(pBridgeWin);
  const pCanopy = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.6, 19.5), pRed);
  pCanopy.position.set(0, 8.1, -0.2); para.add(pCanopy);
  // 象徴的な2本の黒い煙突と赤い横連結バー
  for (const sx of [-1.7, 1.7]) {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 6.5, 10), pBlack);
    stack.position.set(sx, 11.2, 2.2); para.add(stack);
    const sCap = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.7, 10), pRed);
    sCap.position.set(sx, 13.8, 2.2); para.add(sCap);
  }
  const sCross = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.65, 0.65), pRed);
  sCross.position.set(0, 12.2, 2.2); para.add(sCross);
  // 船尾の赤い外輪 (パドルホイール)
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 4.6, 12), pRed);
  wheel.rotation.z = Math.PI / 2; wheel.position.set(0, 1.8, -14.8); para.add(wheel);
  para.position.set(H_ISLAND.x + 640, 0, H_ISLAND.z + 280); // 八景島マリーナ沖を遊覧中
  para.rotation.y = 0.35;
  bayShips.add(para);

  // (10-b) 東京湾の大型商船・コンテナ船・自動車運搬船・タンカー (停泊本船・航行船)
  const cargoConfigs = [
    { x: 1380, z: -850, ry: -0.18, len: 210, w: 32, col: 0x991b1b, type: 'container' },
    { x: 1950, z: 420, ry: 0.12, len: 195, w: 30, col: 0x1e3a8a, type: 'container' },
    { x: 720, z: -2750, ry: -0.45, len: 180, w: 28, col: 0x0f172a, type: 'tanker' },   // 三菱沖の停泊本船
    { x: 1720, z: -2200, ry: 0.05, len: 190, w: 30, col: 0x1d4ed8, type: 'car' },
    { x: 2650, z: -1450, ry: -0.1, len: 230, w: 35, col: 0x047857, type: 'container' },
  ];
  const contColors = [0xdc2626, 0x2563eb, 0xd97706, 0x059669, 0x9333ea, 0xe11d48];
  for (const cfg of cargoConfigs) {
    const sg = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(cfg.w, 13, cfg.len), new THREE.MeshLambertMaterial({ color: cfg.col }));
    hull.position.y = 5.5; sg.add(hull);
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(cfg.w * 0.82, 24, 22), pWhite);
    bridge.position.set(0, 22, -cfg.len * 0.34); sg.add(bridge);
    const funnel = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.0, 14, 10), new THREE.MeshLambertMaterial({ color: 0xea580c }));
    funnel.position.set(0, 36, -cfg.len * 0.38); sg.add(funnel);
    if (cfg.type === 'container') {
      for (let cz = -cfg.len * 0.18; cz <= cfg.len * 0.34; cz += 26) {
        const cMat = new THREE.MeshLambertMaterial({ color: contColors[Math.abs(Math.round(cz)) % contColors.length] });
        const stack = new THREE.Mesh(new THREE.BoxGeometry(cfg.w * 0.86, 11, 22), cMat);
        stack.position.set(0, 17, cz); sg.add(stack);
      }
    } else if (cfg.type === 'car') {
      const boxHull = new THREE.Mesh(new THREE.BoxGeometry(cfg.w * 0.96, 16, cfg.len * 0.88), new THREE.MeshLambertMaterial({ color: 0x3b82f6 }));
      boxHull.position.set(0, 18, 0); sg.add(boxHull);
    }
    sg.position.set(cfg.x, 0, cfg.z); sg.rotation.y = cfg.ry;
    bayShips.add(sg);
  }

  // (10-c) 柴漁港・金沢の小型漁船群 (白船体・青ライン・船尾スパンカー帆: 沖出ししたレース海面と重ならない位置に配置)
  const fishCoords = [
    [-460, -540, 0.8], [-440, -1240, -0.4], [620, 460, 1.2],
    [740, -140, -1.1], [-320, 740, 0.5], [760, -640, 2.1], [860, 820, -0.7]
  ];
  const fBlue = new THREE.MeshLambertMaterial({ color: 0x0284c7 });
  for (const [fx, fz, fry] of fishCoords) {
    const fg = new THREE.Group();
    const fh = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.2, 10.5), pWhite);
    fh.position.y = 0.5; fg.add(fh);
    const fb = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.35, 10.6), fBlue);
    fb.position.y = 1.1; fg.add(fb);
    const fc = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.8, 3.0), pWhite);
    fc.position.set(0, 1.9, -0.5); fg.add(fc);
    const spanker = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3.8, 3), pWhite);
    spanker.position.set(0, 3.2, -3.8); fg.add(spanker);
    fg.position.set(fx, 0, fz); fg.rotation.y = fry;
    bayShips.add(fg);
  }

  // (10-d) セーリングガイド記載の海上標識: シーバース・小柴2/3/4号灯浮標・沖ノ根ビーコン
  // 沖ノ根 (黒赤二横線の孤立障害標識)
  const oki = new THREE.Group();
  const okiPole = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, 11, 10), pBlack);
  okiPole.position.y = 5.5; oki.add(okiPole);
  const okiBand = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.45, 3.5, 10), pRed);
  okiBand.position.y = 6.0; oki.add(okiBand);
  oki.position.set(-450, 0, 520); bayShips.add(oki);

  // 小柴4(赤)・小柴3(緑)・小柴2(赤) ブイ
  const gMat = new THREE.MeshLambertMaterial({ color: 0x16a34a });
  for (const [bx, bz, mat] of [[680, -420, pRed], [880, -820, gMat], [1120, -1420, pRed]]) {
    const bg = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 2.0, 10), mat);
    base.position.y = 1.0; bg.add(base);
    const tw = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.4, 5.5, 8), mat);
    tw.position.y = 4.5; bg.add(tw);
    bg.position.set(bx, 0, bz); bayShips.add(bg);
  }

  // 小柴シーバース (沖合のドルフィン桟橋構造物)
  const sbGroup = new THREE.Group();
  const sbDeck = new THREE.Mesh(new THREE.BoxGeometry(16, 3.5, 140), new THREE.MeshLambertMaterial({ color: 0xf59e0b }));
  sbDeck.position.y = 4.5; sbGroup.add(sbDeck);
  for (let sz = -60; sz <= 60; sz += 30) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 9, 8), pBlack);
    leg.position.set(0, 2, sz); sbGroup.add(leg);
  }
  sbGroup.position.set(1050, 0, -1120); sbGroup.rotation.y = -0.25;
  bayShips.add(sbGroup);
  root.add(bayShips);

  // 11) 北〜北東の遠景: 本牧の赤いクレーン群(手前北側) + 奥はおとなしめの海岸線 + かなり遠くに見える横浜ランドマークタワーと周辺ビル群
  const metro = new THREE.Group();

  // 北側に見える本牧ふ頭・南本牧ふ頭の赤白ガントリークレーン群 (ユーザー好評ポイントとしてそのまま維持)
  const redMat = new THREE.MeshLambertMaterial({ color: 0xdc2626 });
  for (let i = 0; i < 8; i++) {
    const gx = -450 + i * 95, gz = -3800 - (i % 3) * 140;
    const gTower = new THREE.Mesh(new THREE.BoxGeometry(8, 72, 12), redMat);
    gTower.position.set(gx, 36, gz); metro.add(gTower);
    const gBoom = new THREE.Mesh(new THREE.BoxGeometry(95, 5, 6), redMat);
    gBoom.position.set(gx + 32, 64, gz); metro.add(gBoom);
  }

  // クレーンの奥側〜横浜・東京方面の低い遠方陸地プレート
  const metroLand = new THREE.Mesh(new THREE.BoxGeometry(12000, 5, 18000), new THREE.MeshLambertMaterial({ color: 0x64748b }));
  metroLand.position.set(-1800, 1.0, -16500); metro.add(metroLand);

  // 横浜ランドマークタワーと周辺のみなとみらいビル群 (かなり遠く z ≈ -11500 だがシルエットがはっきり分かるように再現)
  const lmkX = -1550, lmkZ = -11500;
  const lmk = new THREE.Mesh(new THREE.CylinderGeometry(42, 60, 360, 4), new THREE.MeshLambertMaterial({ color: 0xdbeafe, emissive: 0x1e293b }));
  lmk.rotation.y = Math.PI / 4; lmk.position.set(lmkX, 180, lmkZ); metro.add(lmk);
  // クイーンズスクエア3連棟 (ランドマークタワーのすぐ右隣)
  for (let i = 0; i < 3; i++) {
    const qh = 205 - i * 22;
    const qb = new THREE.Mesh(new THREE.BoxGeometry(64, qh, 64), new THREE.MeshLambertMaterial({ color: 0xe2e8f0, emissive: 0x1e293b }));
    qb.position.set(lmkX + 210 + i * 95, qh / 2, lmkZ + 80 + i * 45); metro.add(qb);
  }
  // ヨコハマ グランド インターコンチネンタル ホテル (ヨットのセール型)
  const interCon = new THREE.Mesh(new THREE.CylinderGeometry(75, 75, 24, 24, 1, false, 0, Math.PI), new THREE.MeshLambertMaterial({ color: 0xf1f5f9, emissive: 0x1e293b }));
  interCon.rotation.z = Math.PI / 2; interCon.rotation.y = 0.4; interCon.position.set(lmkX + 520, 60, lmkZ + 180); interCon.scale.set(2.2, 1, 1); metro.add(interCon);

  // 横浜ベイブリッジ (ランドマークタワーの手前右寄りに遠望できる斜張橋)
  const bbX = 850, bbZ = -11200;
  const bbDeck = new THREE.Mesh(new THREE.BoxGeometry(2600, 9, 28), new THREE.MeshLambertMaterial({ color: 0xcbd5e1 }));
  bbDeck.position.set(bbX, 64, bbZ); bbDeck.rotation.y = -0.25; metro.add(bbDeck);
  for (const s of [-460, 460]) {
    const tw = new THREE.Mesh(new THREE.BoxGeometry(22, 185, 30), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
    tw.position.set(bbX + s * Math.cos(0.25), 92.5, bbZ + s * Math.sin(0.25)); metro.add(tw);
  }

  // クレーンの奥は都会になりすぎないよう大幅に棟数を絞り、ランドマークタワー周辺と東京側の遠景におとなしめに配置
  const HBOX = 180;
  const hBoxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), HBOX);
  let hbn = 0;
  const cityPal = [0xcbd5e1, 0x94a3b8, 0xdbeafe, 0xb4c6da];
  // (a) ランドマークタワー周辺のビル群 (z = -10800 .. -12600, x = -2300 .. -750 にコンパクトに集約)
  for (let k = 0; k < 48 && hbn < HBOX; k++) {
    const x = lmkX - 700 + rnd() * 1550, z = lmkZ - 900 + rnd() * 1600;
    const bh = 65 + rnd() * 115, bw = 38 + rnd() * 45, bd = 38 + rnd() * 45;
    m4.compose(new THREE.Vector3(x, bh / 2 + 2, z), q, new THREE.Vector3(bw, bh, bd));
    hBoxes.setMatrixAt(hbn, m4); tc.setHex(cityPal[(rnd() * cityPal.length) | 0]); hBoxes.setColorAt(hbn, tc); hbn++;
  }
  // (b) クレーンの少し奥(根岸・本牧ふ頭倉庫: z = -4500 .. -7200) はごく控えめな低層倉庫のみ (おとなしめ)
  for (let k = 0; k < 22 && hbn < HBOX; k++) {
    const x = -2200 + rnd() * 1800, z = -4500 - rnd() * 2600;
    const bh = 14 + rnd() * 16, bw = 35 + rnd() * 45, bd = 35 + rnd() * 45;
    m4.compose(new THREE.Vector3(x, bh / 2 + 2, z), q, new THREE.Vector3(bw, bh, bd));
    hBoxes.setMatrixAt(hbn, m4); tc.setHex(0x94a3b8); hBoxes.setColorAt(hbn, tc); hbn++;
  }
  // (c) さらに奥の川崎・東京側陸地(z = -13500 .. -22000) にうっすら見える控えめなビル群
  for (let k = 0; k < 90 && hbn < HBOX; k++) {
    const z = -13500 - rnd() * 8500;
    const x = -2500 + rnd() * 5800;
    const bh = 45 + rnd() * 85, bw = 42 + rnd() * 50, bd = 42 + rnd() * 50;
    m4.compose(new THREE.Vector3(x, bh / 2 + 2, z), q, new THREE.Vector3(bw, bh, bd));
    hBoxes.setMatrixAt(hbn, m4); tc.setHex(cityPal[(rnd() * cityPal.length) | 0]); hBoxes.setColorAt(hbn, tc); hbn++;
  }
  hBoxes.count = hbn; metro.add(hBoxes);
  root.add(metro);

  // 遠景陸地: 磯子・根岸の緑の丘陵(クレーン奥西側)、東京側奥の陸地(北〜北東)、千葉・房総半島(東〜南東の遠方にうっすら見える稜線)
  distantLand(root, -2800, -6500, 1400, 2800, 82, 0.08);    // クレーン奥の穏やかな緑の丘陵
  distantLand(root, 2200, -21000, 8500, 6500, 65, 0.15);   // 東京側奥の陸地
  // (千葉・房総半島は addHakkeiScenery で実際の海岸線(富津岬・君津・木更津・鋸山)に沿って作成)

  // 八景島からも西〜西南西の丘陵越しにわずかに見える遠方の富士山
  if (fgeo) {
    const fujiHMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      color: 0xd8e6f2,
      emissive: 0x3b4d5e,
      transparent: true,
      opacity: 0.45,
    });
    const fujiH = new THREE.Mesh(fgeo, fujiHMat);
    fujiH.position.set(-41500, -320, -1500); // 八景島から見た富士山はほぼ真西(方位約272°)
    fujiH.scale.set(0.82, 0.72, 0.82);
    root.add(fujiH);
  }
}




// =====================================================================
// 静的メッシュの一括結合 (ドローコール削減)
// group 配下の静的な Lambert / Basic メッシュを「マテリアル特性(種類・発光色・面・透明度)」ごとに 1 メッシュへ結合する。
// マテリアル色(×既存の頂点色)は頂点色へ焼き込むので、色違いの建物・船・標識もまとめて 1 ドローコールになる。
// テクスチャ付き(白波など)は同一マテリアル同士だけを結合し、元のマテリアル(アニメーション付き)をそのまま使う。
// =====================================================================
function bakeStatic(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.geometry || !o.geometry.attributes.position) return;
    const m = o.material;
    if (Array.isArray(m) || !(m.isMeshLambertMaterial || m.isMeshBasicMaterial)) return;
    for (let p = o; p && p !== root; p = p.parent) if (!p.visible) return;
    const key = m.map ? `map|${m.uuid}|${o.renderOrder}`
      : [m.type, m.emissive ? m.emissive.getHex() : 0, m.side, m.transparent ? m.opacity : 1, m.depthWrite, m.fog, o.renderOrder].join('|');
    let b = buckets.get(key);
    if (!b) { b = { m, items: [], nv: 0, ni: 0, ro: o.renderOrder }; buckets.set(key, b); }
    const g = o.geometry, nv = g.attributes.position.count;
    b.items.push(o); b.nv += nv; b.ni += g.index ? g.index.count : nv;
  });
  const mtx = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3(), c = new THREE.Color(), vc = new THREE.Color();
  for (const b of buckets.values()) {
    if (b.items.length < 2) continue;
    const textured = !!b.m.map;
    const pos = new Float32Array(b.nv * 3), nor = new Float32Array(b.nv * 3);
    const col = textured ? null : new Float32Array(b.nv * 3), uvs = textured ? new Float32Array(b.nv * 2) : null;
    const idx = new Uint32Array(b.ni);
    let vo = 0, io = 0;
    for (const o of b.items) {
      const g = o.geometry, P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color, UV = g.attributes.uv, I = g.index;
      const mm = o.material, useVC = mm.vertexColors && C;
      mtx.multiplyMatrices(inv, o.matrixWorld); nm.getNormalMatrix(mtx);
      const flip = mtx.determinant() < 0;
      for (let i = 0; i < P.count; i++) {
        const k = (vo + i) * 3;
        v.fromBufferAttribute(P, i).applyMatrix4(mtx); pos[k] = v.x; pos[k + 1] = v.y; pos[k + 2] = v.z;
        if (N) v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); else v.set(0, 1, 0);
        nor[k] = v.x; nor[k + 1] = v.y; nor[k + 2] = v.z;
        if (col) {
          c.copy(mm.color); if (useVC) c.multiply(vc.fromBufferAttribute(C, i));
          col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
        }
        if (uvs) { uvs[(vo + i) * 2] = UV ? UV.getX(i) : 0; uvs[(vo + i) * 2 + 1] = UV ? UV.getY(i) : 0; }
      }
      const n = I ? I.count : P.count;
      for (let i = 0; i < n; i += 3) {
        const a = I ? I.getX(i) : i, bb = I ? I.getX(i + 1) : i + 1, cc = I ? I.getX(i + 2) : i + 2;
        idx[io++] = vo + a; idx[io++] = vo + (flip ? cc : bb); idx[io++] = vo + (flip ? bb : cc);
      }
      vo += P.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (uvs) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    let mat = b.m;
    if (!textured) {
      mat = b.m.isMeshBasicMaterial ? new THREE.MeshBasicMaterial({ vertexColors: true }) : new THREE.MeshLambertMaterial({ vertexColors: true });
      if (mat.emissive) mat.emissive.copy(b.m.emissive);
      mat.side = b.m.side; mat.transparent = b.m.transparent; mat.opacity = b.m.opacity; mat.depthWrite = b.m.depthWrite; mat.fog = b.m.fog;
    }
    for (const o of b.items) o.parent.remove(o);
    const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = b.ro; mesh.frustumCulled = false; root.add(mesh);
  }
  // 空になったグループを取り除き、シーングラフの走査コストも減らす
  const prune = (o) => { for (const ch of [...o.children]) { prune(ch); if (!ch.isMesh && !ch.isSprite && !ch.isLight && ch.children.length === 0 && ch.type !== 'Scene') o.remove(ch); } };
  prune(root);
  root.updateMatrixWorld(true);
}

// ---------- 静的オブジェクト用の小道具 (bakeStatic で結合される前提。マテリアル・ジオメトリは使い回す) ----------
const _sgeo = new Map(), _smat = new Map();
const sGeo = (key, make) => { let g = _sgeo.get(key); if (!g) { g = make(); _sgeo.set(key, g); } return g; };
const sMat = (hex, emissive = 0) => { const k = `${hex}|${emissive}`; let m = _smat.get(k); if (!m) { m = new THREE.MeshLambertMaterial({ color: hex, emissive }); _smat.set(k, m); } return m; };
// 底面中心 (x, y, z) に置く直方体
function sBox(parent, x, y, z, w, h, d, hex, ry = 0) {
  const m = new THREE.Mesh(sGeo('box', () => new THREE.BoxGeometry(1, 1, 1)), sMat(hex));
  m.position.set(x, y + h / 2, z); m.scale.set(w, h, d); m.rotation.y = ry; parent.add(m); return m;
}
// 底面中心に置く円柱/円錐台 (seg=4 で角柱)。sx/sz で楕円断面
function sCyl(parent, x, y, z, rTop, rBot, h, hex, seg = 8, sx = 1, sz = 1, ry = 0) {
  const m = new THREE.Mesh(sGeo(`cyl|${(rTop / rBot).toFixed(3)}|${seg}`, () => new THREE.CylinderGeometry(rTop / rBot, 1, 1, seg)), sMat(hex));
  m.position.set(x, y + h / 2, z); m.scale.set(rBot * sx, h, rBot * sz); m.rotation.y = ry; parent.add(m); return m;
}
// 紅白(または任意2色)の帯を巻いた煙突・鉄塔
function sBanded(parent, x, y, z, rTop, rBot, h, bands, c1, c2, seg = 8) {
  for (let i = 0; i < bands; i++) {
    const t0 = i / bands, t1 = (i + 1) / bands;
    const r0 = rBot + (rTop - rBot) * t0, r1 = rBot + (rTop - rBot) * t1;
    sCyl(parent, x, y + h * t0, z, r1, r0, h / bands, i % 2 ? c2 : c1, seg);
  }
}
// 遠景の簡易船舶 (船体 + 船橋 + 積荷)。全部で 3〜4 個の箱
function sShip(parent, x, z, ry, len, type, hullHex) {
  const g = new THREE.Group();
  const w = len * 0.15;
  sBox(g, 0, -1, 0, w, 9 + len * 0.02, len, hullHex);
  sBox(g, 0, 7.5 + len * 0.02, -len * 0.36, w * 0.9, 14 + len * 0.03, len * 0.1, 0xf1f5f9);
  if (type === 'container') sBox(g, 0, 7.5 + len * 0.02, len * 0.07, w * 0.92, 9, len * 0.6, [0xb45309, 0x1d4ed8, 0x991b1b, 0x0f766e][Math.abs(Math.round(x)) % 4]);
  else if (type === 'car') sBox(g, 0, 7.5 + len * 0.02, len * 0.04, w * 0.97, 15, len * 0.74, 0xe2e8f0);
  else if (type === 'tanker') sBox(g, 0, 7.5 + len * 0.02, len * 0.08, w * 0.3, 1.6, len * 0.62, 0x9ca3af);
  else sBox(g, 0, 7.5 + len * 0.02, len * 0.1, w * 0.85, 3, len * 0.5, 0x6b7280); // バルカー(ハッチ)
  g.position.set(x, 0, z); g.rotation.y = ry; parent.add(g); return g;
}

// 海岸線ポリラインからの符号付き距離 (陸側が正)。coast は海岸線(開いた折れ線)、closing は内陸側を閉じる頂点列
function makeCoastField(coast, closing) {
  const poly = coast.concat(closing);
  const inside = (x, z) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  return (x, z) => {
    let best = 1e18;
    for (let i = 0; i < coast.length - 1; i++) {
      const ax = coast[i][0], az = coast[i][1], dx = coast[i + 1][0] - ax, dz = coast[i + 1][1] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      const ex = ax + dx * t - x, ez = az + dz * t - z;
      best = Math.min(best, ex * ex + ez * ez);
    }
    const d = Math.sqrt(best);
    return inside(x, z) ? d : -d;
  };
}
// 不等間隔グリッド座標列 [[start, end, step], ...]
const gridAxis = (segs) => { const a = []; for (const [s, e, st] of segs) for (let v = s; v < e - 1e-6; v += st) a.push(v); a.push(segs[segs.length - 1][1]); return a; };

// =====================================================================
// 江の島ステージ: 実際の地理(相模湾の海岸線・山並み)に合わせた周辺景観の追加
// ワールド座標 ≒ 江の島中心からの実距離 × 0.62 (遠景を圧縮して霧の内側に収めている既存スケールに合わせる)
// =====================================================================
function addEnoshimaScenery(grp, surfStrip) {
  const sc = new THREE.Group();

  // ---- 1) 鎌倉〜逗子〜葉山〜三浦半島: 稲村ヶ崎で海へ突き出し、由比ヶ浜・逗子湾を経て南へ折れる実際の海岸線 ----
  const MIURA = [
    [2900, -1960], [3150, -1700], [3330, -1350], [3470, -1150], [3640, -1330], [3900, -1680], [4300, -1770], [4700, -1640],
    [4950, -1450], [5200, -1230], [5520, -1000], [5850, -860], [6100, -420], [6330, 350], [6650, 1200], [7050, 2250],
    [7450, 3250], [7700, 4500], [8000, 5800], [8200, 7400], [8300, 9000], [8100, 10500], [9100, 11250], [10500, 10700],
    [11800, 9000], [12500, 6000], [12900, 2500], [13300, -1000], [13600, -2600],
  ];
  const sdM = makeCoastField(MIURA, [[13600, -3600], [2900, -3600]]);
  const isBeach = (x, z) => (x > 3650 && x < 4900 && z < -1450) || (x > 5300 && x < 6050 && z > -1150 && z < -650) || (x > 6150 && x < 6700 && z > -100 && z < 1300) || (x > 7200 && x < 7600 && z > 2600 && z < 3500);
  const miuraH = (x, z) => {
    const d = sdM(x, z);
    if (d <= 0) return Math.max(-30, -3 + d * 0.08);
    const fade = smooth(0, 1100, x - 2900) * (1 - smooth(-1900, -1300, z)) + smooth(-1900, -1300, z);
    const top = 150 + 85 * smooth(-1200, 0, z) - 175 * smooth(5500, 10500, z);
    const n = 0.45 + 0.55 * noise2(x / 1100 + 3, z / 1100 - 7);
    let h = 2.2 * smooth(0, 35, d) + top * Math.pow(smooth(20, 1500, d), 0.9) * n * fade;
    h += 36 * Math.exp(-((x - 3440) ** 2 + (z + 1250) ** 2) / 60000) * smooth(0, 30, d); // 稲村ヶ崎の断崖
    h += 95 * Math.exp(-((x - 8350) ** 2 + (z - 1950) ** 2) / 1.6e6); // 大楠山 (241m)
    return h - 1.0;
  };
  const miuraC = (x, z, h, out) => {
    const d = sdM(x, z), g = noise2(x / 150, z / 150);
    if (h < 0.3) out.setRGB(0.34, 0.32, 0.28);
    else if (d < 50 && isBeach(x, z)) out.setRGB(0.52 + g * 0.04, 0.47 + g * 0.04, 0.38); // 由比ヶ浜・材木座・逗子海岸・森戸・秋谷の砂浜
    else if (d < 55) out.setRGB(0.43 + g * 0.05, 0.4 + g * 0.05, 0.34); // 岩礁・崖
    else if (h < 75 && d < 1500 && noise2(x / 90, z / 90) > 0.47) out.setRGB(0.47 + g * 0.05, 0.46 + g * 0.05, 0.43); // 市街地
    else out.setRGB(0.1 + 0.05 * g, 0.21 + 0.08 * g, 0.08 + 0.03 * g);
  };
  const mxs = gridAxis([[2800, 7200, 85], [7200, 13700, 270]]);
  const mzs = gridAxis([[-3600, -2200, 280], [-2200, 1400, 90], [1400, 11700, 280]]);
  sc.add(new THREE.Mesh(buildGrid(mxs, mzs, miuraH, miuraC), new THREE.MeshLambertMaterial({ vertexColors: true })));
  // 鎌倉〜葉山の砂浜の白波
  {
    const pts = [];
    for (let i = 3; i < 13; i++) {
      const [ax, az] = MIURA[i], [bx, bz] = MIURA[i + 1];
      const L = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / L, nz = (bx - ax) / L; // 進行方向の右手(海側)
      for (let s = 0; s < L; s += 40) pts.push({ x: ax + (bx - ax) * s / L, z: az + (bz - az) * s / L, ux: nx, uz: nz });
    }
    surfStrip(sc, pts, 10);
  }
  // 鎌倉・逗子・葉山・秋谷の低層住宅地(海岸段丘〜谷戸に沿って)
  const pal = [0xf3efe6, 0xe9e2d3, 0xd9d4c8, 0xf6f0e0, 0xc9b8a0, 0xe8ddd0, 0xb9c4cc];
  const roofs = [0x4a4f55, 0x6b5a4a, 0x3d4a5a, 0x7a3b2e, 0x5c6065];
  for (let k = 0, tries = 0; k < 420 && tries < 6000; tries++) {
    const x = 3000 + rnd() * 5200, z = -2500 + rnd() * 6200;
    const d = sdM(x, z); if (d < 45 || d > 1500) continue;
    const h = miuraH(x, z); if (h < 2 || h > 85) continue;
    if (noise2(x / 90, z / 90) < 0.42) continue;
    const w = 9 + rnd() * 9, dd = 9 + rnd() * 9, bh = 6 + rnd() * 7;
    sBox(sc, x, h - 1.5, z, w, bh + 1.5, dd, pal[(rnd() * pal.length) | 0]);
    sBox(sc, x, h + bh, z, w + 0.8, 0.9, dd + 0.8, roofs[(rnd() * roofs.length) | 0]);
    k++;
  }
  // 逗子マリーナ(小坪): 海に張り出した白いリゾートマンション群とマリーナ防波堤
  for (let i = 0; i < 4; i++) sBox(sc, 4930 + i * 70, 1, -1420 + i * 40, 26, 30 + (i % 2) * 6, 58, 0xf4f1ea, -0.7);
  sBox(sc, 5230, -2, -1150, 260, 5, 12, 0x9ca3af, -0.75);
  sBox(sc, 5120, 0, -1300, 160, 3, 90, 0xcfcac0, -0.75);
  // 葉山・森戸沖の名島(菜島): 白い鳥居と紅白の小灯台(葉山灯台)
  sCyl(sc, 6060, -2, 520, 14, 30, 9, 0x4a4540, 7);
  sBanded(sc, 6070, 6, 520, 1.1, 1.4, 9, 4, 0xf8fafc, 0xdc2626, 8);
  sBox(sc, 6045, 6, 505, 0.7, 6, 0.7, 0xf8fafc); sBox(sc, 6045, 6, 513, 0.7, 6, 0.7, 0xf8fafc); sBox(sc, 6045, 11.6, 509, 1, 0.7, 11, 0xf8fafc);

  // ---- 2) 江の島周辺: 江の島大橋(車道)・片瀬漁港の紅白灯台・新江ノ島水族館・腰越漁港 ----
  {
    const bx = ISLAND.x + 30; // 弁天橋(ISLAND.x - 40)の東隣に並行する江の島大橋
    let zN = ISLAND.z - 200; for (let z = ISLAND.z; z > ISLAND.z - 600; z -= 2) { if (islandH(bx, z) < 0.5) { zN = z + 4; break; } }
    const zC = -(COAST + 110 + 40 * Math.sin(bx / 700) + 25 * Math.sin(bx / 230 + 1));
    const L = zN - zC;
    sBox(sc, bx, 6.2, (zN + zC) / 2, 15, 1.8, L, 0xcbc7bf);
    sBox(sc, bx - 7.2, 8.0, (zN + zC) / 2, 0.4, 1.0, L, 0xe5e7eb); sBox(sc, bx + 7.2, 8.0, (zN + zC) / 2, 0.4, 1.0, L, 0xe5e7eb);
    for (let z = zC + 20; z < zN - 10; z += 38) sBox(sc, bx, -1, z, 10, 7.4, 2.2, 0x8c8a85);
  }
  // 片瀬漁港 (境川河口・弁天橋の西隣): 港口の右(東)に赤灯台、左(西)に白灯台
  {
    const zc = -(COAST + 60);
    sBox(sc, 330, -1, zc + 90, 10, 4.2, 230, 0x9ca3af, 0.12);
    sBox(sc, 175, -1, zc + 80, 10, 4.2, 210, 0x9ca3af, -0.1);
    sBanded(sc, 343, 3, zc + 205, 1.4, 1.9, 11, 1, 0xdc2626, 0xdc2626, 10); sCyl(sc, 343, 14, zc + 205, 1.6, 1.6, 1.2, 0x7f1d1d, 10);
    sBanded(sc, 165, 3, zc + 185, 1.4, 1.9, 11, 1, 0xf8fafc, 0xf8fafc, 10); sCyl(sc, 165, 14, zc + 185, 1.6, 1.6, 1.2, 0x475569, 10);
  }
  // 新江ノ島水族館 (片瀬西浜): 白い低層棟と曲面屋根
  {
    const ax = -120, az = -(COAST + 175), ah = landH(ax, az);
    sBox(sc, ax, ah - 1, az, 150, 14, 55, 0xe8ecef);
    sBox(sc, ax + 40, ah - 1, az + 26, 70, 10, 4, 0x2b6f9a);
    const roof = new THREE.Mesh(sGeo('halfcyl', () => new THREE.CylinderGeometry(1, 1, 1, 10, 1, false, 0, Math.PI)), sMat(0xf4f6f7));
    roof.rotation.z = Math.PI / 2; roof.scale.set(8, 150, 28); roof.position.set(ax, ah + 13, az); sc.add(roof);
  }
  // 腰越漁港 (小動岬の脇) の防波堤
  sBox(sc, 1250, -1, -(COAST + 10), 9, 4, 150, 0x9ca3af, 0.2);
  sBox(sc, 1180, -1, -(COAST - 60), 90, 4, 9, 0x9ca3af, 0.2);

  // ---- 3) 茅ヶ崎: 烏帽子岩(姥島)と茅ヶ崎ヘッドランド(T字突堤) ----
  {
    const ex = -6450, ez = -1480;
    const rock = new THREE.Mesh(sGeo('eboshi', () => {
      const prof = [[0, -3], [11, -3], [10, 1], [7.5, 5], [5.5, 9], [3.6, 13], [1.8, 16.5], [0.4, 18.5], [0, 18.8]].map(([r, y]) => new THREE.Vector2(r, y));
      return new THREE.LatheGeometry(prof, 7);
    }), sMat(0x47423c));
    rock.position.set(ex, 0, ez); rock.rotation.set(0.05, 0.4, 0.13); rock.scale.set(1, 1, 0.75); sc.add(rock);
    for (const [dx, dz, r, h] of [[-26, 10, 9, 3.5], [18, -14, 7, 2.6], [36, 8, 10, 2.2], [-12, -26, 6, 2.8], [52, -6, 5, 1.6], [-44, -8, 7, 1.8]]) sCyl(sc, ex + dx, -2, ez + dz, r * 0.45, r, h + 2, 0x4b463f, 6);
    const hx = -5600, hz = -(COAST + 40 + 40 * Math.sin(-5600 / 700) + 25 * Math.sin(-5600 / 230 + 1));
    sBox(sc, hx, -1, hz + 70, 9, 3.4, 150, 0x8f8b84);
    sBox(sc, hx, -1, hz + 145, 120, 3.4, 12, 0x8f8b84);
  }

  // ---- 4) 大磯・平塚: 海岸近くまで迫る高麗山の丘と、湘南平(181m)の紅白テレビ塔群 ----
  distantLand(sc, -11300, -2850, 2600, 950, 175, 0.12, 24);
  distantLand(sc, -8900, -3300, 1500, 750, 190, 0.25, 20);
  for (const [tx, tz, th] of [[-8950, -3330, 58], [-8820, -3270, 48], [-9080, -3380, 40]]) sBanded(sc, tx, 30, tz, 1.4, 6, th + 120, 9, 0xdc2626, 0xf8fafc, 4); // 根元は丘に埋める

  // ---- 5) 遠景の山並み: 丹沢山地(大山1252m・塔ノ岳・蛭ヶ岳)/ 真鶴半島 / 初島 ----
  distantLand(sc, -19500, -12600, 6800, 2500, 1650, -0.44, 40);
  distantLand(sc, -13900, -10900, 2300, 2100, 1500, 0.2, 26);
  distantLand(sc, -19400, 8600, 1700, 800, 120, 0.65, 20);
  distantLand(sc, -17200, 16600, 900, 600, 55, 0, 14);

  grp.add(sc);
}

// =====================================================================
// 八景島ステージ: 実際の東京湾西岸〜房総の景観 (root ローカル座標: 八景島中心 ≒ (-1250, 150)、コース ≒ (280, -980))
// =====================================================================
function addHakkeiScenery(root) {
  const sc = new THREE.Group();

  // ---- 1) 横須賀 (追浜・夏島の南〜猿島の対岸): 八景島から南に見える丘陵と市街・港 ----
  const YOKO = [[-1300, 2350], [-1020, 2300], [-600, 2600], [-150, 3100], [300, 3500], [700, 3800], [1000, 4300], [1400, 5000], [2000, 5700], [2600, 6600], [3200, 7800], [3600, 9500], [3800, 12500]];
  const sdY = makeCoastField(YOKO, [[-1300, 12500]]);
  const yokoH = (x, z) => {
    const d = sdY(x, z);
    if (d <= 0) return Math.max(-30, -3 + d * 0.08);
    return 2.6 * smooth(0, 30, d) + 128 * Math.pow(smooth(40, 1300, d), 0.9) * (0.45 + 0.55 * noise2(x / 900 + 11, z / 900)) - 1.0;
  };
  const yokoC = (x, z, h, out) => {
    const d = sdY(x, z), g = noise2(x / 140, z / 140);
    if (h < 0.3) out.setRGB(0.36, 0.35, 0.33);
    else if (d < 70) out.setRGB(0.52, 0.53, 0.54); // 岸壁
    else if (h < 60 && d < 1300 && noise2(x / 80, z / 80) > 0.42) out.setRGB(0.48 + g * 0.05, 0.47 + g * 0.05, 0.45);
    else out.setRGB(0.1 + 0.05 * g, 0.22 + 0.08 * g, 0.09 + 0.03 * g);
  };
  sc.add(new THREE.Mesh(buildGrid(gridAxis([[-1300, 4300, 110]]), gridAxis([[2200, 6200, 110], [6200, 12500, 300]]), yokoH, yokoC), new THREE.MeshLambertMaterial({ vertexColors: true })));
  const cityPal = [0xe5e7eb, 0xd6d3d1, 0xf1f5f9, 0xcbd5e1, 0xe7e5e4];
  for (let k = 0, tries = 0; k < 150 && tries < 4000; tries++) {
    const x = -900 + rnd() * 3300, z = 2500 + rnd() * 4200;
    const d = sdY(x, z); if (d < 50 || d > 1100) continue;
    const h = yokoH(x, z); if (h < 2 || h > 50) continue;
    const w = 14 + rnd() * 18, dd = 14 + rnd() * 18, bh = 9 + rnd() * 22;
    sBox(sc, x, h - 2, z, w, bh + 2, dd, cityPal[(rnd() * cityPal.length) | 0], rnd() * 0.6);
    k++;
  }
  // 横須賀中央の高層ビル群 (ベイスクエアよこすか等 ~100m) と港のクレーン
  for (const [x, z, w, h] of [[520, 4150, 30, 104], [610, 4230, 26, 72], [430, 4300, 24, 62], [700, 4120, 22, 55]]) sBox(sc, x, 2, z, w, h, w, 0xe2e8f0);
  for (const [x, z] of [[860, 3880], [960, 4050]]) { sBox(sc, x, 2, z, 4, 45, 4, 0x64748b); sBox(sc, x + 14, 44, z, 40, 3, 3, 0x64748b); }
  // 猿島 (東京湾唯一の自然島: 横須賀沖の緑の小島)
  distantLand(sc, 1600, 2950, 240, 130, 42, 0.5, 14);
  // 野島 (野島公園の小高い丘・展望台)
  distantLand(sc, -1650, 950, 300, 220, 58, 0.3, 14);
  sCyl(sc, -1650, 40, 950, 3, 4, 14, 0xf1f5f9, 8);

  // ---- 2) 北側: 磯子火力発電所(扁平な200m煙突)・根岸製油所(タンク群と紅白煙突) ----
  sCyl(sc, -1900, 1, -4400, 12, 15, 200, 0xd9dde2, 12, 1, 0.55);
  sCyl(sc, -1900, 186, -4400, 12.2, 12.4, 14, 0x9aa5b1, 12, 1, 0.55);
  sBox(sc, -2010, 1, -4330, 70, 72, 55, 0xe5e7eb); sBox(sc, -2090, 1, -4440, 65, 64, 50, 0xd6dbe0);
  for (const dz of [-80, 0]) sCyl(sc, -1790, 1, -4560 + dz, 26, 28, 48, 0xcbd5e1, 14);
  for (let i = 0; i < 18; i++) sCyl(sc, -2250 - (i % 6) * 70, 1, -5000 - Math.floor(i / 6) * 75, 27, 27, 16 + (i % 3) * 4, i % 4 ? 0xeef0f2 : 0xd1d5db, 12);
  sBanded(sc, -2350, 1, -5300, 3.5, 5, 120, 6, 0xdc2626, 0xf8fafc, 8);
  sBanded(sc, -2600, 1, -5150, 3, 4.4, 95, 6, 0xdc2626, 0xf8fafc, 8);

  // ---- 3) 対岸の房総半島: 富津岬の細長い砂州・君津製鉄所・東京湾アクアライン(海ほたる/風の塔)・鋸山〜鹿野山の稜線 ----
  const BOSO = [[10400, 30000], [9800, 13000], [10450, 1600], [12950, 650], [14000, -3000], [14950, -7150], [18000, -9500], [22000, -12000], [25000, -18000], [26000, -26000]];
  const sdB = makeCoastField(BOSO, [[42000, -26000], [42000, 30000]]);
  const bosoH = (x, z) => {
    const d = sdB(x, z);
    if (d <= 0) return -30;
    const south = smooth(-2000, 6000, z);
    const top = 70 + 260 * south;
    let h = 3 * smooth(0, 60, d) + top * Math.pow(smooth(200, 4500, d), 0.8) * (0.4 + 0.6 * noise2(x / 2600 + 1, z / 2600 + 5));
    h += 150 * Math.exp(-((x - 18100) ** 2 + (z - 6800) ** 2) / 1.2e7); // 鹿野山 (379m)
    h += 120 * Math.exp(-((x - 10600) ** 2 + (z - 12600) ** 2) / 1.5e6); // 鋸山 (329m)
    return h - 2;
  };
  const bosoC = (x, z, h, out) => {
    const g = noise2(x / 900, z / 900);
    if (h < 3) out.setRGB(0.42, 0.4, 0.36);
    else if (h < 40 && z < 3000) out.setRGB(0.4, 0.4, 0.4); // 君津・木更津の臨海工業地帯
    else out.setRGB(0.13 + 0.05 * g, 0.21 + 0.06 * g, 0.13 + 0.03 * g);
  };
  sc.add(new THREE.Mesh(buildGrid(gridAxis([[9000, 34000, 600]]), gridAxis([[-26000, 30000, 700]]), bosoH, bosoC), new THREE.MeshLambertMaterial({ vertexColors: true })));
  distantLand(sc, 8700, 1500, 2000, 260, 14, 0.157, 24); // 富津岬
  // 君津製鉄所: 高炉と紅白煙突
  for (const [x, z] of [[13300, -300], [13700, 600], [14200, 1500]]) { sBox(sc, x, 0, z, 70, 70, 60, 0x8b8f94); sCyl(sc, x + 30, 0, z + 10, 7, 9, 105, 0x6b6f75, 8); }
  for (const [x, z, h] of [[13000, -900, 190], [13500, 1000, 170], [14000, 2200, 150], [12900, 1800, 120]]) sBanded(sc, x, 0, z, 5, 7, h, 7, 0xdc2626, 0xf8fafc, 8);
  // 東京湾アクアライン: 海ほたるPA(船型の人工島) と木更津へ伸びる低い橋、川崎側の換気塔「風の塔」
  sBox(sc, 13300, -1, -9800, 110, 26, 640, 0xe5e7eb, 0.557);
  sBox(sc, 13300, 24, -9800, 60, 10, 260, 0xcbd5e1, 0.557);
  {
    const ax = 13300 + 320 * Math.sin(0.557), az = -9800 + 320 * Math.cos(0.557);
    const bx = 14950, bz = -7150, L = Math.hypot(bx - ax, bz - az), ry = Math.atan2(bx - ax, bz - az);
    const N = 8;
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N, hump = 12 + 30 * Math.exp(-((t - 0.25) ** 2) / 0.01);
      sBox(sc, ax + (bx - ax) * t, hump, az + (bz - az) * t, 22, 3, L / N + 4, 0xd1d5db, ry);
    }
  }
  sCyl(sc, 10450, -1, -11750, 22, 26, 75, 0xe2e8f0, 10); sCyl(sc, 10560, -1, -11720, 18, 22, 90, 0xe2e8f0, 10);

  // ---- 4) 東京湾の錨泊船・航行船 (横浜港外の錨地〜浦賀水道) ----
  for (const [x, z, ry, len, type, hex] of [
    [3600, -3200, 0.4, 190, 'bulk', 0x7f1d1d], [5200, -1900, -0.2, 230, 'container', 0x1e3a8a], [6400, -4300, 0.9, 170, 'tanker', 0x111827],
    [5600, 1200, 1.4, 200, 'car', 0xe5e7eb], [7900, -2600, 0.1, 250, 'container', 0x0f172a], [4300, 3600, -0.6, 160, 'bulk', 0x374151],
    [8800, 3900, 1.6, 210, 'tanker', 0x7c2d12], [9300, -6200, 0.3, 180, 'bulk', 0x1f2937], [3200, -6800, -0.9, 200, 'container', 0x064e3b],
  ]) sShip(sc, x, z, ry, len, type, hex);

  // ---- 5) 遠景の丹沢(大山)・箱根: 西の丘陵越しにわずかに稜線が覗く ----
  distantLand(sc, -26500, -8300, 2400, 2200, 1450, 0.2, 22);
  distantLand(sc, -33000, -12000, 6500, 2400, 1600, -0.44, 30);
  distantLand(sc, -38000, 9000, 8000, 6000, 1300, 0.25, 28);

  root.add(sc);
}


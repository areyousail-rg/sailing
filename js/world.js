// 江の島沖 / 八景島沖の世界: 海・空・島・海岸・ランドマーク・マーク・航跡
import * as THREE from 'three';
import { MARKS, toWorld, LINE_HALF, U, W0, setWindDir } from './course.js';
import { makeMotorboat } from './powerboats.js';

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
  float h=clamp(d.y,0.0,1.0);
  vec3 hor=vec3(0.74,0.86,0.94), zen=vec3(0.14,0.38,0.78);
  vec3 c=mix(hor,zen,pow(h,0.42));
  float s=max(dot(d,uSun),0.0);
  c+=vec3(1.0,0.92,0.75)*(pow(s,600.0)*6.0+pow(s,12.0)*0.18);
  return c;
}`;
export const MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
const waterMat = new THREE.ShaderMaterial({
  defines: { NWAVE: MOBILE ? 4 : 6 },
  uniforms: { uTime: { value: 0 }, uWT: { value: 0 }, uW0: { value: W0 }, uSun: { value: SUN_DIR } },
  vertexShader: `varying vec3 vW; void main(){ vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
  fragmentShader: `
precision highp float;
varying vec3 vW; uniform float uTime; uniform float uWT; uniform float uW0;
${SKY_FN}
float hh(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(hh(i),hh(i+vec2(1,0)),f.x),mix(hh(i+vec2(0,1)),hh(i+vec2(1,1)),f.x),f.y); }
void main(){
  vec2 p=vW.xz; vec3 V=normalize(cameraPosition-vW); float dist=length(cameraPosition-vW);
  vec2 g=vec2(0.0);
  vec4 W0=vec4(0.34,-0.94,0.11,0.55);  // dirx,dirz,k,A
  for(int i=0;i<NWAVE;i++){
    float fi=float(i);
    float ang=0.35+fi*0.83; vec2 d=normalize(vec2(sin(ang)*0.9+0.34,-cos(ang)*0.7-0.5));
    float k=0.11*pow(1.75,fi); float A=0.55*pow(0.52,fi);
    float w=sqrt(9.8*k)*0.9;
    float fade=exp(-dist*k*0.0035);
    if(fade<0.02) break; // 遠方では高周波の波を省略(kは増加するので以降も不要)
    g+=d*A*k*cos(dot(d,p)*k-uTime*w+fi*1.7)*fade;
  }
  if(dist<2500.0) g+=(vec2(vn(p*0.9+uTime*0.3),vn(p*0.9-uTime*0.25+7.0))-0.5)*0.12*exp(-dist*0.004);
  // 風: sim.js windAt と同じ式で強弱(ガスト/ラル)と風向を海面に表現
  float wf=clamp(1.0+0.10*sin(uWT*0.13+p.x*0.011)+0.08*sin(uWT*0.37-p.y*0.013)+0.05*sin(uWT*0.9+p.x*0.02),0.75,1.25);
  float wsh=0.10*sin(uWT*0.031+0.7)+0.05*sin(uWT*0.113+1.3)+0.04*sin(p.x*0.0042-p.y*0.0021+uWT*0.05);
  float wfr=uW0+wsh; vec2 wd=vec2(-sin(wfr),cos(wfr)); vec2 wp=vec2(-wd.y,wd.x);
  float wu=dot(p,wp), wv=dot(p,wd);
  float gust=smoothstep(0.82,1.2,wf);
  if(dist<3000.0){
    float rip=vn(vec2(wu*1.2,wv*0.25-uTime*2.6))*0.6+vn(vec2(wu*2.7+3.0,wv*0.55-uTime*3.6))*0.4;
    g+=wp*(rip-0.5)*(0.12+0.5*gust)*exp(-dist*0.0025);
  }
  vec3 n=normalize(vec3(-g.x,1.0,-g.y));
  float ndv=max(dot(n,V),0.0);
  float F=0.03+0.97*pow(1.0-ndv,4.5);
  vec3 R=reflect(-V,n); R.y=abs(R.y);
  vec3 refl=skyBase(R);
  vec3 deep=vec3(0.012,0.14,0.24), shallow=vec3(0.06,0.34,0.42);
  float crest=clamp(length(g)*2.2,0.0,1.0);
  vec3 body=mix(deep,shallow,crest*0.7+0.15);
  vec3 col=mix(body,refl,F);
  if(dist<3500.0){
    float foam=smoothstep(0.62,0.95,length(g)*3.2+vn(p*2.3+uTime*0.5)*0.35)*exp(-dist*0.002);
    col=mix(col,vec3(0.92,0.96,0.98),foam*0.5);
  }
  col*=mix(1.10,0.74,smoothstep(0.78,1.22,wf));
  if(dist<5000.0){
    float streak=smoothstep(0.72,0.92,vn(vec2(wu*0.32,wv*0.03-uTime*1.1)));
    col+=vec3(0.55,0.62,0.66)*streak*0.14*(0.4+gust)*exp(-dist*0.0012);
  }
  float fogF=1.0-exp(-pow(dist*${FOG_DENSITY.toFixed(7)},2.0));
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
float hh(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
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
    // 波食台: 南西側に海面すれすれの平らな岩棚
    const shelf = south * smooth(0.3, -0.4, rx) * (1 - smooth(1.0, 1.14, r));
    const base = -6 + Math.max(0, 1.3 - r) * 12;
    return Math.max(base, shelf > 0.05 ? -0.6 + 1.3 * shelf + noise2(x * 0.15, z * 0.15) * 0.5 : base);
  }
  const t = 1 - r;
  const east = smooth(-0.2, 0.7, rx);
  const ex = 0.62 - 0.36 * south;
  return Math.pow(t, ex) * (62 + 24 * east) - 2.2 + noise2(x * 0.05, z * 0.05) * 2.5 + noise2(x * 0.11, z * 0.11) * 1.2;
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
    // 斜面の傾きで岩肌(凝灰岩の崖)・磯・照葉樹林を塗り分ける
    const P = islandGeo.attributes.position, N = islandGeo.attributes.normal, C = islandGeo.attributes.color;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), h = P.getY(i), z = P.getZ(i), ny = N.getY(i);
      const g = noise2(x / 9, z / 9), g2 = noise2(x / 31 + 5, z / 31);
      let r, gg, b;
      if (h < 0.9) { r = 0.19; gg = 0.18; b = 0.16; } // 潮間帯の濡れた岩
      else if (h < 3.2) { r = 0.5 + 0.08 * g; gg = 0.45 + 0.07 * g; b = 0.37 + 0.05 * g; } // 岩棚・磯
      else { r = 0.07 + 0.05 * g + 0.03 * g2; gg = 0.17 + 0.09 * g + 0.04 * g2; b = 0.06 + 0.03 * g; } // 照葉樹林
      if (h >= 0.9) {
        const steep = smooth(0.8, 0.5, ny);
        const cr = 0.55 + 0.1 * g, cg = 0.48 + 0.08 * g, cb = 0.37 + 0.06 * g;
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
    for (let x = -14000; x <= 16000; x += 40) cpts.push({ x, z: -(COAST + 64 + 40 * Math.sin(x / 700) + 25 * Math.sin(x / 230 + 1)), ux: 0, uz: 1 });
    surfStrip(enoshimaGroup, cpts, 14);
  }

  // 湘南海岸
  const lx = [], lz = [];
  for (let i = 0; i <= 220; i++) lx.push(-48000 + (96000 * i) / 220);
  for (let j = 0; j < 48; j++) lz.push(COAST_Z + 100 - (25 * (Math.pow(1.095, j) - 1)) / 0.095);
  const landGeo = buildGrid(lx, lz, landH, colorLand);
  enoshimaGroup.add(new THREE.Mesh(landGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  // 遠景: 三浦半島(東) / 箱根(富士の手前) / 伊豆半島(南西) / 伊豆大島(南の水平線)
  distantLand(enoshimaGroup, 15500, 6000, 4200, 10500, 220, 0.15);
  distantLand(enoshimaGroup, -25000, -8500, 9000, 6500, 1350, 0.3);
  distantLand(enoshimaGroup, -31000, 26000, 8500, 20000, 950, -0.2, 56);
  distantLand(enoshimaGroup, -6000, 41000, 5200, 6500, 760, 0);

  // 富士山
  const prof = [];
  for (let i = 0; i <= 48; i++) { const t = i / 48; prof.push(new THREE.Vector2(22000 * Math.pow(1 - t, 1.75) + 1, 3776 * t)); }
  const fgeo = new THREE.LatheGeometry(prof, 72);
  const fc = new Float32Array(fgeo.attributes.position.count * 3);
  for (let i = 0; i < fgeo.attributes.position.count; i++) {
    const y = fgeo.attributes.position.getY(i);
    const px = fgeo.attributes.position.getX(i), pz = fgeo.attributes.position.getZ(i);
    const jag = 380 * (noise2(px / 1800, pz / 1800) - 0.5);
    const snow = smooth(2500, 2800, y + jag);
    fc[i * 3] = 0.2 + 0.78 * snow; fc[i * 3 + 1] = 0.3 + 0.68 * snow; fc[i * 3 + 2] = 0.34 + 0.62 * snow;
  }
  fgeo.setAttribute('color', new THREE.BufferAttribute(fc, 3));
  const fuji = new THREE.Mesh(fgeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  fuji.position.set(-36000, -2, -19000); fuji.scale.set(1, 1, 1); enoshimaGroup.add(fuji);

  // 江の島の木(タブノキ・スダジイ等の丸い樹冠)・建物・展望灯台
  const treeCount = 1600;
  const trees = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshLambertMaterial(), treeCount);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), tc = new THREE.Color(), eul = new THREE.Euler();
  let n = 0;
  for (let tries = 0; tries < 12000 && n < treeCount; tries++) {
    const x = ISLAND.x + (rnd() * 2 - 1) * 580, z = ISLAND.z + (rnd() * 2 - 1) * 270;
    const h = islandH(x, z); if (h < 4) continue;
    const slope = Math.abs(islandH(x + 3, z) - h) + Math.abs(islandH(x, z + 3) - h);
    if (slope > 4.2) continue; // 崖には生えない
    const s = 3.5 + rnd() * 4;
    q.setFromEuler(eul.set(0, rnd() * 6.28, 0));
    m4.compose(new THREE.Vector3(x, h + s * 0.35, z), q, new THREE.Vector3(s * (0.9 + rnd() * 0.4), s * (0.55 + rnd() * 0.25), s * (0.9 + rnd() * 0.4)));
    trees.setMatrixAt(n, m4); tc.setRGB(0.05 + rnd() * 0.06, 0.14 + rnd() * 0.11, 0.05 + rnd() * 0.03); trees.setColorAt(n, tc); n++;
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
  // 島の北側(岸側)斜面の仲見世通り・旅館街
  for (let tries = 0, k = 0; tries < 5000 && k < 190; tries++) {
    const x = ISLAND.x - 430 + rnd() * 720, z = ISLAND.z - 250 + rnd() * 210;
    const h = islandH(x, z); if (h < 2.5 || h > 32) continue;
    house(x, h - 0.5, z, 7 + rnd() * 9, 5 + rnd() * 8, 7 + rnd() * 9); k++;
  }
  // 海岸の街並み(片瀬・鵠沼・腰越)
  for (let k = 0; k < 1300; k++) {
    const x = -9000 + rnd() * 21000, z = COAST_Z - 170 - rnd() * 1200;
    const h = landH(x, z); if (h < 1.5) continue;
    const tall = rnd() < 0.12;
    house(x, h - 0.5, z, 10 + rnd() * 18, tall ? 22 + rnd() * 30 : 6 + rnd() * 14, 10 + rnd() * 18);
  }
  boxes.count = bn; enoshimaGroup.add(boxes);

  // 江の島シーキャンドル(展望灯台): 細い塔と展望デッキ
  const lhx = ISLAND.x + 90, lhz = ISLAND.z - 20, topH = islandH(lhx, lhz);
  const lh = new THREE.Group();
  const towerM = new THREE.MeshLambertMaterial({ color: 0xf1efe9 });
  const tw = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 3.6, 46, 16), towerM); tw.position.y = 23; lh.add(tw);
  for (let i = 0; i < 6; i++) { const rib = new THREE.Mesh(new THREE.BoxGeometry(0.5, 46, 0.5), new THREE.MeshLambertMaterial({ color: 0xd8d4cc })); const a = (i / 6) * Math.PI * 2; rib.position.set(Math.cos(a) * 3.4, 23, Math.sin(a) * 3.4); rib.rotation.z = Math.cos(a) * 0.035; rib.rotation.x = -Math.sin(a) * 0.035; lh.add(rib); }
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 5.5, 5, 20), new THREE.MeshLambertMaterial({ color: 0x8fb8cc, emissive: 0x1d3442 })); deck.position.y = 47; lh.add(deck);
  const deckRoof = new THREE.Mesh(new THREE.CylinderGeometry(6.9, 6.9, 0.8, 20), towerM); deckRoof.position.y = 49.8; lh.add(deckRoof);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 3, 12), new THREE.MeshLambertMaterial({ color: 0xfff6d0, emissive: 0x665a2a })); lantern.position.y = 52; lh.add(lantern);
  const spire = new THREE.Mesh(new THREE.ConeGeometry(1.2, 4, 12), new THREE.MeshLambertMaterial({ color: 0x555a60 })); spire.position.y = 55.5; lh.add(spire);
  lh.position.set(lhx, topH - 1, lhz); enoshimaGroup.add(lh);
  // 神社(辺津宮)と入口の青銅鳥居
  const sx = ISLAND.x - 90, sz = ISLAND.z - 150, sh = islandH(sx, sz);
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

  // 江の島ヨットハーバー(島の東側): 埋立地のディンギーパーク + 防波堤に囲まれた泊地
  const hx = ISLAND.x + 540, hz = ISLAND.z - 40;
  const conc = new THREE.MeshLambertMaterial({ color: 0xb8b4aa });
  const yard = new THREE.Mesh(new THREE.BoxGeometry(130, 3, 250), conc); yard.position.set(hx + 40, 0.5, hz); enoshimaGroup.add(yard);
  const brk = new THREE.MeshLambertMaterial({ color: 0x9a9890 });
  for (const [x, z, w, d] of [[hx + 330, hz, 9, 250], [hx + 218, hz - 125, 233, 9], [hx + 175, hz + 125, 150, 9]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, 4, d), brk); b.position.set(x, 0.9, z); enoshimaGroup.add(b);
  }
  const mastsG = new THREE.CylinderGeometry(0.15, 0.15, 11, 5);
  const hulls = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 1, 7), new THREE.MeshLambertMaterial({ color: 0xffffff }), 60);
  const masts = new THREE.InstancedMesh(mastsG, new THREE.MeshLambertMaterial({ color: 0xcfd3d8 }), 60);
  for (let i = 0; i < 60; i++) {
    const x = hx + 125 + (i % 12) * 16 + (rnd() - 0.5) * 2, z = hz - 100 + Math.floor(i / 12) * 42 + (rnd() - 0.5) * 3;
    m4.makeTranslation(x, 0.6, z); hulls.setMatrixAt(i, m4); tc.setHSL(rnd(), 0.2, 0.85); hulls.setColorAt(i, tc);
    m4.makeTranslation(x, 6.4, z); masts.setMatrixAt(i, m4);
  }
  enoshimaGroup.add(hulls, masts);
  // ディンギーパーク(上架された小型艇)
  const dh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.45, 4.6), new THREE.MeshLambertMaterial(), 90);
  const dm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 6.5, 4), new THREE.MeshLambertMaterial({ color: 0xd8dde3 }), 90);
  for (let i = 0; i < 90; i++) {
    const x = hx - 10 + (i % 9) * 11, z = hz - 110 + Math.floor(i / 9) * 22 + (rnd() - 0.5) * 2;
    m4.makeTranslation(x, 2.3, z); dh.setMatrixAt(i, m4); tc.setHSL(rnd(), rnd() * 0.5, 0.75 + rnd() * 0.2); dh.setColorAt(i, tc);
    m4.makeTranslation(x, 5.6, z - 0.6); dm.setMatrixAt(i, m4);
  }
  enoshimaGroup.add(dh, dm);

  // ===== 2. 八景島ステージ (横浜・八景島シーパラダイス沖) =====
  buildHakkeijima(hakkeijimaGroup, surfStrip);

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
  const lineMesh = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.6), new THREE.MeshBasicMaterial({ color: 0xffe36a, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  lineMesh.rotation.x = -Math.PI / 2; scene.add(lineMesh);
  
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
  
  // フィニッシュ運営艇とピン
  const fComBoat = putBoat(makeMotorboat('committee', { stripe: 0x1d4ed8, flags: [{ color: '#1d4ed8', w: 1.5, h: 1.0 }, ORG] }), MARKS.fcom.a, MARKS.fcom.c, 0.1);
  markObjs.fcom = fComBoat;
  const fPinObj = buoy(0x2a77ff, 0x2a77ff); scene.add(fPinObj); bob.push(fPinObj); markObjs.fm = fPinObj;

  // 風向(W0)変更時にすべてのコースマーク・ライン・観覧艇のワールド座標を更新
  const syncCourseObjects = () => {
    for (const k of ['m1', 'm1a', 'm2', 'm3', 'gL', 'gR', 'fm']) {
      const p = toWorld(MARKS[k].a, MARKS[k].c);
      markObjs[k].position.x = p.x; markObjs[k].position.z = p.z;
    }
    const head = Math.atan2(U.x, U.z);
    for (const cb of courseBoats) {
      const p = toWorld(cb.a, cb.c);
      cb.b.position.x = p.x; cb.b.position.z = p.z;
      cb.b.rotation.y = head + cb.relRot;
    }
    const pa = toWorld(MARKS.pin.a, MARKS.pin.c), pb = toWorld(MARKS.com.a, MARKS.com.c);
    const lcx = (pa.x + pb.x) / 2, lcz = (pa.z + pb.z) / 2, lrot = -Math.atan2(pb.z - pa.z, pb.x - pa.x);
    lineMesh.rotation.z = lrot; lineMesh.position.set(lcx, 0.15, lcz);
    startLabel.position.set(lcx, 12, lcz);

    const fpa = toWorld(MARKS.fm.a, MARKS.fm.c), fpb = toWorld(MARKS.fcom.a, MARKS.fcom.c);
    const flcx = (fpa.x + fpb.x) / 2, flcz = (fpa.z + fpb.z) / 2, flrot = -Math.atan2(fpb.z - fpa.z, fpb.x - fpa.x);
    finBand.rotation.z = flrot; finBand.position.set(flcx, 0.18, flcz);
    finCurtain.rotation.y = flrot; finCurtain.position.set(flcx, 2.2, flcz);
    finLabel.position.set(flcx, 12, flcz);
  };
  syncCourseObjects();
  // マークの番号ラベル
  const label = (txt, key, y = 11) => {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128; const x = c.getContext('2d');
    x.fillStyle = 'rgba(10,20,40,0.7)'; x.beginPath(); x.arc(64, 64, 58, 0, 7); x.fill();
    x.strokeStyle = '#ffd23f'; x.lineWidth = 6; x.stroke();
    x.fillStyle = '#fff'; x.font = 'bold 64px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, 64, 68);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
    s.scale.set(9, 9, 1); s.position.y = y; s.renderOrder = 5; markObjs[key].add(s);
  };
  label('1', 'm1'); label('1a', 'm1a'); label('2', 'm2'); label('3', 'm3'); label('4S', 'gL'); label('4P', 'gR');

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
          const rx = Math.cos(p.h), rz = Math.sin(p.h); // 艇の右方向
          tq.setFromAxisAngle(yAx, -p.h);
          // 中央: 細長い楕円で少しずつ広がる
          ts.set(0.32 + p.age * 0.32, 1, 0.9 + p.age * 0.25);
          m4.compose(tv.set(p.x, 0, p.z), tq, ts); trail.setMatrixAt(k, m4);
          col.setRGB(0.62, 0.72, 0.76).multiplyScalar(0.16 * fade * p.s); trail.setColorAt(k++, col);
          // 左右のケルビン波: 艇速に応じて外へ移動
          const off = 0.45 + p.age * (0.55 + p.s * 0.9);
          for (const s of [-1, 1]) {
            const a = p.h - s * 0.62; // 後方外側へ斜めに伸びる波頭
            tq.setFromAxisAngle(yAx, -a);
            ts.set(0.07 + p.age * 0.05, 1, 0.5 + p.age * 0.35);
            m4.compose(tv.set(p.x + rx * s * off, 0, p.z + rz * s * off), tq, ts); trail.setMatrixAt(k, m4);
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
    setVenue(venue) {
      const isHakkei = venue === 'hakkeijima';
      enoshimaGroup.visible = !isHakkei;
      hakkeijimaGroup.visible = isHakkei;
      // 八景島は北風スタート(15°北北東の風)、江の島は南南西(200°)
      setWindDir(isHakkei ? 15 : 200);
      waterMat.uniforms.uW0.value = W0;
      syncCourseObjects();
    },
    // mode: 'start' | 'finish'  emph: 0..1 (\u30d7\u30ec\u30a4\u30e4\u30fc\u304c\u6700\u7d42\u30ec\u30b0\u3067\u5f37\u8abf)
    setLine(mode, emph) {
      finCurtainMat.opacity = 0.25 + 0.3 * emph + (emph > 0.5 ? 0.12 * Math.sin(performance.now() / 250) : 0);
    },
    update(t, camera, dt, wt = 0) {
      waterMat.uniforms.uTime.value = t; waterMat.uniforms.uWT.value = wt; waterMat.uniforms.uW0.value = W0; skyMat.uniforms.uTime.value = t;
      sky.position.copy(camera.position);
      sea.position.set(camera.position.x, 0, camera.position.z);
      for (const o of bob) { o.position.y = 0.12 * Math.sin(t * 1.4 + o.position.x) + 0.05; o.rotation.z = 0.05 * Math.sin(t * 1.1 + o.position.z); }
      flagSway.forEach((f, i) => { f.rotation.y = Math.sin(t * 2.6 + i * 1.7) * 0.12; });
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
function buildHakkeijima(root, surfStrip) {
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), tc = new THREE.Color(), eul = new THREE.Euler();
  // 八景島本島: コースのすぐ西側 (x = -1250, z = +150)
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

  // 1) アクアミュージアム (島の北側・白いピラミッド型の屋根を持つ大水族館)
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

  // 2) フリーフォール / ブルーフォール (アクアミュージアムの西側＝奥側にある高さ107mの垂直タワー)
  const bfx = H_ISLAND.x - 175, bfz = H_ISLAND.z - 210;
  const bfGroup = new THREE.Group();
  const bfTower = new THREE.Mesh(new THREE.BoxGeometry(5.0, 105, 5.0), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
  bfTower.position.y = 52.5; bfGroup.add(bfTower);
  const bfTop = new THREE.Mesh(new THREE.CylinderGeometry(6.0, 3.2, 8, 12), new THREE.MeshLambertMaterial({ color: 0x0284c7 }));
  bfTop.position.y = 106; bfGroup.add(bfTop);
  const bfCap = new THREE.Mesh(new THREE.ConeGeometry(2.2, 11, 8), new THREE.MeshLambertMaterial({ color: 0x38bdf8 }));
  bfCap.position.y = 115; bfGroup.add(bfCap);
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

  // 八景島マリーナ (ホテル棟のすぐ手前＝コース側)
  const mhx = H_ISLAND.x + 290, mhz = H_ISLAND.z + 310;
  const conc = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const yard = new THREE.Mesh(new THREE.BoxGeometry(150, 3.2, 230), conc); yard.position.set(mhx, 0.6, mhz); root.add(yard);
  const club = new THREE.Mesh(new THREE.BoxGeometry(36, 9, 24), new THREE.MeshLambertMaterial({ color: 0xf8fafc })); club.position.set(mhx - 30, 6.5, mhz - 50); root.add(club);
  const clubRoof = new THREE.Mesh(new THREE.ConeGeometry(24, 5, 4), new THREE.MeshLambertMaterial({ color: 0xc2410c })); clubRoof.rotation.y = Math.PI / 4; clubRoof.position.set(mhx - 30, 13.5, mhz - 50); root.add(clubRoof);
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
  const hTrees = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshLambertMaterial(), hTreeCount);
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

  // 6) 八景大橋 (金沢八景大橋) & マリンゲート橋 (ヘリポートと八景島の奥側＝西側水道に架かる青いアーチ橋と高架橋)
  const ohGroup = new THREE.Group();
  const ohX = H_ISLAND.x - 410, ohZ = H_ISLAND.z - 390; // ヘリポート奥側〜八景島北西を結ぶ
  const ohDeck = new THREE.Mesh(new THREE.BoxGeometry(18, 3.2, 460), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
  ohDeck.position.set(ohX, 14, ohZ); ohDeck.rotation.y = 0.28; ohGroup.add(ohDeck);
  // 八景大橋の中央アーチ (青い鋼製ローゼ橋アーチ)
  for (const s of [-6.5, 6.5]) {
    const archRib = new THREE.Mesh(new THREE.TorusGeometry(68, 2.0, 8, 28, Math.PI), new THREE.MeshLambertMaterial({ color: 0x0284c7 }));
    archRib.rotation.y = Math.PI / 2 + 0.28;
    archRib.position.set(ohX + s * Math.cos(0.28), 14.5, ohZ - s * Math.sin(0.28));
    ohGroup.add(archRib);
  }
  // 橋脚
  for (const dz of [-140, -65, 65, 140]) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(20, 16, 6), new THREE.MeshLambertMaterial({ color: 0x94a3b8 }));
    pier.position.set(ohX + dz * Math.sin(0.28), 6, ohZ + dz * Math.cos(0.28));
    pier.rotation.y = 0.28; ohGroup.add(pier);
  }
  // マリンゲート橋 (八景島西側〜海の公園側)
  const brMesh = new THREE.Mesh(new THREE.BoxGeometry(460, 2.5, 11), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
  brMesh.position.set(H_ISLAND.x - 520, 9.5, H_ISLAND.z - 160); ohGroup.add(brMesh);
  const mgArch = new THREE.Mesh(new THREE.TorusGeometry(32, 1.6, 8, 24, Math.PI), new THREE.MeshLambertMaterial({ color: 0x38bdf8 }));
  mgArch.position.set(H_ISLAND.x - 430, 10.5, H_ISLAND.z - 160); ohGroup.add(mgArch);
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
  // イラストでテクノタワーホテルのすぐ海側(右隣)に描かれている青緑色の中高層ビル(屋上にオレンジ色の丸型設備)
  const subBld = new THREE.Mesh(new THREE.BoxGeometry(66, 82, 62), new THREE.MeshLambertMaterial({ color: 0x38bdf8 }));
  subBld.position.set(95, 43, 18); tthGroup.add(subBld);
  const subRoof = new THREE.Mesh(new THREE.BoxGeometry(68, 4, 64), new THREE.MeshLambertMaterial({ color: 0xcbd5e1 }));
  subRoof.position.set(95, 85, 18); tthGroup.add(subRoof);
  for (const ox of [78, 95, 112]) {
    const unit = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 6, 10), new THREE.MeshLambertMaterial({ color: 0xea580c }));
    unit.position.set(ox, 89, 18); tthGroup.add(unit);
  }
  tthGroup.position.set(tthX, 0, tthZ);
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
  const incStack = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 12, 145, 16), new THREE.MeshLambertMaterial({ color: 0xffffff }));
  incStack.position.set(incX - 95, 74, incZ); fukuura.add(incStack);
  const incCap = new THREE.Mesh(new THREE.CylinderGeometry(9.0, 9.5, 22, 16), new THREE.MeshLambertMaterial({ color: 0x0284c7 }));
  incCap.position.set(incX - 95, 134, incZ); fukuura.add(incCap);

  // 三菱重工の4連白い蒲鉾/三角屋根工場棟 (イラスト右上・焼却炉の右隣に4棟並ぶ)
  for (let i = 0; i < 4; i++) {
    const hx = -820 + i * 82, hz = -2820;
    const hall = new THREE.Mesh(new THREE.BoxGeometry(74, 34, 210), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
    hall.position.set(hx, 19, hz); fukuura.add(hall);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(38, 38, 210, 3), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
    roof.rotation.x = Math.PI / 2; roof.rotation.y = Math.PI;
    roof.position.set(hx, 38, hz); roof.scale.set(1, 1, 0.45); fukuura.add(roof);
  }

  // 海岸線の並木の背後(市大病院とテクノタワーホテルの間)に並ぶ白い低層工場・倉庫群 (イラスト通り白い四角い建物を配置)
  for (const [bx, bz, bw, bh, bd] of [
    [-655, -1040, 75, 22, 65],
    [-755, -1100, 80, 26, 70],
    [-660, -1190, 72, 20, 62],
    [-770, -1250, 85, 24, 68],
    [-655, -1320, 70, 22, 60],
    [-665, -1620, 78, 22, 68],
    [-775, -1690, 82, 25, 72],
    [-670, -1810, 80, 20, 70],
    [-780, -1920, 88, 24, 75],
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
    m.position.set(bx, bh / 2 + 3, bz); fukuura.add(m);
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

  // (10-c) 柴漁港・金沢の小型漁船群 (白船体・青ライン・船尾スパンカー帆)
  const fishCoords = [
    [-460, -540, 0.8], [-390, -1180, -0.4], [520, 460, 1.2],
    [640, -140, -1.1], [-320, 740, 0.5], [430, -640, 2.1], [820, 820, -0.7]
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
  for (const [bx, bz, mat] of [[520, -420, pRed], [780, -820, gMat], [1040, -1420, pRed]]) {
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
  sbGroup.position.set(920, 0, -1120); sbGroup.rotation.y = -0.25;
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

  // 遠景陸地: 磯子・根岸の緑の丘陵(クレーン奥西側)、東京側奥の陸地(北〜北東)、千葉・房総半島(東の遠方)、観音崎方面(南東)
  distantLand(root, -2800, -6500, 1400, 2800, 82, 0.08);    // クレーン奥の穏やかな緑の丘陵
  distantLand(root, 2200, -21000, 8500, 6500, 65, 0.15);   // 東京側奥の陸地
  distantLand(root, 22500, -1000, 3600, 22000, 110, 0.04); // 千葉・房総側 (遠方にうっすら見える低い稜線)
  distantLand(root, 1800, 5800, 2600, 2200, 135, -0.3);    // 観音崎・横須賀南東の緑の岬
}




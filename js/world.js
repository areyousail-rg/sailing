// 江の島沖の世界: 海・空・江の島・湘南海岸・富士山・マーク・航跡
import * as THREE from 'three';
import { MARKS, toWorld, LINE_HALF, U } from './course.js';
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
  uniforms: { uTime: { value: 0 }, uWT: { value: 0 }, uSun: { value: SUN_DIR } },
  vertexShader: `varying vec3 vW; void main(){ vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
  fragmentShader: `
precision highp float;
varying vec3 vW; uniform float uTime; uniform float uWT;
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
    g+=d*A*k*cos(dot(d,p)*k-uTime*w+fi*1.7)*fade;
  }
  g+=(vec2(vn(p*0.9+uTime*0.3),vn(p*0.9-uTime*0.25+7.0))-0.5)*0.12*exp(-dist*0.004);
  // 風: sim.js windAt と同じ式で強弱(ガスト/ラル)と風向を海面に表現
  float wf=clamp(1.0+0.10*sin(uWT*0.13+p.x*0.011)+0.08*sin(uWT*0.37-p.y*0.013)+0.05*sin(uWT*0.9+p.x*0.02),0.75,1.25);
  float wsh=0.10*sin(uWT*0.031+0.7)+0.05*sin(uWT*0.113+1.3)+0.04*sin(p.x*0.0042-p.y*0.0021+uWT*0.05);
  float wfr=3.4906585+wsh; vec2 wd=vec2(-sin(wfr),cos(wfr)); vec2 wp=vec2(-wd.y,wd.x);
  float wu=dot(p,wp), wv=dot(p,wd);
  float gust=smoothstep(0.82,1.2,wf);
  float rip=vn(vec2(wu*1.2,wv*0.25-uTime*2.6))*0.6+vn(vec2(wu*2.7+3.0,wv*0.55-uTime*3.6))*0.4;
  g+=wp*(rip-0.5)*(0.12+0.5*gust)*exp(-dist*0.0025);
  vec3 n=normalize(vec3(-g.x,1.0,-g.y));
  float ndv=max(dot(n,V),0.0);
  float F=0.03+0.97*pow(1.0-ndv,4.5);
  vec3 R=reflect(-V,n); R.y=abs(R.y);
  vec3 refl=skyBase(R);
  vec3 deep=vec3(0.012,0.14,0.24), shallow=vec3(0.06,0.34,0.42);
  float crest=clamp(length(g)*2.2,0.0,1.0);
  vec3 body=mix(deep,shallow,crest*0.7+0.15);
  vec3 col=mix(body,refl,F);
  float foam=smoothstep(0.62,0.95,length(g)*3.2+vn(p*2.3+uTime*0.5)*0.35)*exp(-dist*0.002);
  col=mix(col,vec3(0.92,0.96,0.98),foam*0.5);
  col*=mix(1.10,0.74,smoothstep(0.78,1.22,wf));
  float streak=smoothstep(0.72,0.92,vn(vec2(wu*0.32,wv*0.03-uTime*1.1)));
  col+=vec3(0.55,0.62,0.66)*streak*0.14*(0.4+gust)*exp(-dist*0.0012);
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

  // 江の島
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
  scene.add(new THREE.Mesh(islandGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

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
  const surfStrip = (pts, width) => {
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
    const m = new THREE.Mesh(g, surfMat); m.renderOrder = 1; scene.add(m); return m;
  };
  {
    const pts = [];
    for (let k = 0; k <= 360; k++) {
      const a = (k / 360) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
      let rr = 0;
      for (let s = 760; s > 0; s -= 2) { if (islandH(ISLAND.x + ux * s, ISLAND.z + uz * s) > -0.25) { rr = s; break; } }
      pts.push({ x: ISLAND.x + ux * rr, z: ISLAND.z + uz * rr, ux, uz });
    }
    surfStrip(pts, 9);
    const cpts = [];
    for (let x = -14000; x <= 16000; x += 40) cpts.push({ x, z: -(COAST + 64 + 40 * Math.sin(x / 700) + 25 * Math.sin(x / 230 + 1)), ux: 0, uz: 1 });
    surfStrip(cpts, 14);
  }

  // 湘南海岸
  const lx = [], lz = [];
  for (let i = 0; i <= 220; i++) lx.push(-48000 + (96000 * i) / 220);
  for (let j = 0; j < 48; j++) lz.push(COAST_Z + 100 - (25 * (Math.pow(1.095, j) - 1)) / 0.095);
  const landGeo = buildGrid(lx, lz, landH, colorLand);
  scene.add(new THREE.Mesh(landGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  // 遠景: 三浦半島(東) / 箱根(富士の手前) / 伊豆半島(南西) / 伊豆大島(南の水平線)
  distantLand(scene, 15500, 6000, 4200, 10500, 220, 0.15);
  distantLand(scene, -25000, -8500, 9000, 6500, 1350, 0.3);
  distantLand(scene, -31000, 26000, 8500, 20000, 950, -0.2, 56);
  distantLand(scene, -6000, 41000, 5200, 6500, 760, 0);

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
  fuji.position.set(-36000, -2, -19000); fuji.scale.set(1, 1, 1); scene.add(fuji);

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
  trees.count = n; scene.add(trees);

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
  boxes.count = bn; scene.add(boxes);

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
  lh.position.set(lhx, topH - 1, lhz); scene.add(lh);
  // 神社(辺津宮)と入口の青銅鳥居
  const sx = ISLAND.x - 90, sz = ISLAND.z - 150, sh = islandH(sx, sz);
  const shrine = new THREE.Mesh(new THREE.BoxGeometry(18, 8, 14), new THREE.MeshLambertMaterial({ color: 0xc63a2d })); shrine.position.set(sx, sh + 3.5, sz); scene.add(shrine);
  const sroof = new THREE.Mesh(new THREE.ConeGeometry(15, 6, 4), new THREE.MeshLambertMaterial({ color: 0x2f3a3a })); sroof.rotation.y = Math.PI / 4; sroof.position.set(sx, sh + 10.5, sz); scene.add(sroof);

  // 弁天橋(島の北端から片瀬海岸へ)
  const bx = ISLAND.x - 40;
  let zN = ISLAND.z; for (let z = ISLAND.z; z > ISLAND.z - 600; z -= 2) { if (islandH(bx, z) < 0.5) { zN = z + 6; break; } }
  const zC = -(COAST + 90 + 40 * Math.sin(bx / 700) + 25 * Math.sin(bx / 230 + 1));
  const blen = zN - zC;
  addTori(scene, bx, islandH(bx, zN - 14) + 0.3, zN - 14);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(9, 1.6, blen), new THREE.MeshLambertMaterial({ color: 0xcfcac0 }));
  bridge.position.set(bx, 4.2, (zN + zC) / 2); scene.add(bridge);
  const np = Math.floor(blen / 30);
  const piers = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 6, 1.6), new THREE.MeshLambertMaterial({ color: 0x8c8a85 }), np * 2);
  for (let i = 0; i < np; i++) for (const s of [-1, 1]) { m4.makeTranslation(bx + s * 3.2, 0.5, zC + 15 + i * 30); piers.setMatrixAt(i * 2 + (s > 0 ? 1 : 0), m4); }
  scene.add(piers);

  // 江の島ヨットハーバー(島の東側): 埋立地のディンギーパーク + 防波堤に囲まれた泊地
  const hx = ISLAND.x + 540, hz = ISLAND.z - 40;
  const conc = new THREE.MeshLambertMaterial({ color: 0xb8b4aa });
  const yard = new THREE.Mesh(new THREE.BoxGeometry(130, 3, 250), conc); yard.position.set(hx + 40, 0.5, hz); scene.add(yard);
  const brk = new THREE.MeshLambertMaterial({ color: 0x9a9890 });
  for (const [x, z, w, d] of [[hx + 330, hz, 9, 250], [hx + 218, hz - 125, 233, 9], [hx + 175, hz + 125, 150, 9]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, 4, d), brk); b.position.set(x, 0.9, z); scene.add(b);
  }
  const mastsG = new THREE.CylinderGeometry(0.15, 0.15, 11, 5);
  const hulls = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 1, 7), new THREE.MeshLambertMaterial({ color: 0xffffff }), 60);
  const masts = new THREE.InstancedMesh(mastsG, new THREE.MeshLambertMaterial({ color: 0xcfd3d8 }), 60);
  for (let i = 0; i < 60; i++) {
    const x = hx + 125 + (i % 12) * 16 + (rnd() - 0.5) * 2, z = hz - 100 + Math.floor(i / 12) * 42 + (rnd() - 0.5) * 3;
    m4.makeTranslation(x, 0.6, z); hulls.setMatrixAt(i, m4); tc.setHSL(rnd(), 0.2, 0.85); hulls.setColorAt(i, tc);
    m4.makeTranslation(x, 6.4, z); masts.setMatrixAt(i, m4);
  }
  scene.add(hulls, masts);
  // ディンギーパーク(上架された小型艇)
  const dh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.45, 4.6), new THREE.MeshLambertMaterial(), 90);
  const dm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 6.5, 4), new THREE.MeshLambertMaterial({ color: 0xd8dde3 }), 90);
  for (let i = 0; i < 90; i++) {
    const x = hx - 10 + (i % 9) * 11, z = hz - 110 + Math.floor(i / 9) * 22 + (rnd() - 0.5) * 2;
    m4.makeTranslation(x, 2.3, z); dh.setMatrixAt(i, m4); tc.setHSL(rnd(), rnd() * 0.5, 0.75 + rnd() * 0.2); dh.setColorAt(i, tc);
    m4.makeTranslation(x, 5.6, z - 0.6); dm.setMatrixAt(i, m4);
  }
  scene.add(dh, dm);

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
  const HEAD = Math.atan2(U.x, U.z);
  const flagSway = [];
  const putBoat = (b, a, c, rot) => { const p = toWorld(a, c); b.position.set(p.x, 0, p.z); b.rotation.y = rot; scene.add(b); bob.push(b); b.traverse((o) => { if (o.userData.flag) flagSway.push(o); }); return b; };
  const ORG = { color: '#ff7a1a', w: 1.5, h: 1.0 };
  markObjs.pin = putBoat(makeMotorboat('outer', { flags: [ORG] }), MARKS.pin.a, MARKS.pin.c, HEAD + 0.06);

  // スタート運営艇(右端)
  const com = putBoat(makeMotorboat('committee', { flags: [ORG, { color: '#1c4fa0', w: 1.4, h: 0.9, text: 'P' }] }), MARKS.com.a, MARKS.com.c, HEAD - 0.05);
  markObjs.com = com;

  // コース周辺の観覧艇・サポート艇
  const specPositions = [
    { a: 315, c: 70, rot: 1.2, type: 'cruiser' },
    { a: 150, c: 75, rot: -0.8, type: 'rib' },
    { a: 235, c: -225, rot: 2.1, type: 'cruiser' },
    { a: 60, c: -215, rot: 0.4, type: 'rib' },
    { a: -90, c: -215, rot: -1.5, type: 'cruiser' },
    { a: 345, c: -60, rot: 0.9, type: 'rib' },
    { a: 30, c: 130, rot: -2.2, type: 'cruiser' },
    { a: 210, c: 95, rot: 0.1, type: 'rib' },
    { a: -150, c: 20, rot: 2.6, type: 'cruiser' },
    { a: -20, c: -250, rot: 0.9, type: 'rib' },
  ];
  const TUBES = [0x2d3748, 0xc2410c, 0x1e3a8a, 0x374151];
  specPositions.forEach((s, i) => putBoat(makeMotorboat(s.type, { tube: TUBES[i % 4], flags: s.type === 'rib' ? [{ color: i % 2 ? '#ffffff' : '#ffd23f', w: 0.8, h: 0.5 }] : [] }), s.a, s.c, s.rot));
  // スタートライン(TV中継風の薄いライン)
  const pa = toWorld(MARKS.pin.a, MARKS.pin.c), pb = toWorld(MARKS.com.a, MARKS.com.c);
  const len = Math.hypot(pb.x - pa.x, pb.z - pa.z);
  const lcx = (pa.x + pb.x) / 2, lcz = (pa.z + pb.z) / 2, lrot = -Math.atan2(pb.z - pa.z, pb.x - pa.x);
  const lineMesh = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.6), new THREE.MeshBasicMaterial({ color: 0xffe36a, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  lineMesh.rotation.x = -Math.PI / 2; lineMesh.rotation.z = lrot;
  lineMesh.position.set(lcx, 0.15, lcz); scene.add(lineMesh);
  
  // フィニッシュライン(チェッカー柄の帯 + 縦のカーテン + FINISH表示)
  const fpa = toWorld(MARKS.fm.a, MARKS.fm.c), fpb = toWorld(MARKS.fcom.a, MARKS.fcom.c);
  const flen = Math.hypot(fpb.x - fpa.x, fpb.z - fpa.z);
  const flcx = (fpa.x + fpb.x) / 2, flcz = (fpa.z + fpb.z) / 2, flrot = -Math.atan2(fpb.z - fpa.z, fpb.x - fpa.x);
  const checker = (rx, ry) => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 64); x.fillStyle = '#111'; x.fillRect(0, 0, 32, 32); x.fillRect(32, 32, 32, 32);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const finBand = new THREE.Mesh(new THREE.PlaneGeometry(flen, 3), new THREE.MeshBasicMaterial({ map: checker(flen / 3, 1), transparent: true, opacity: 0.9, depthWrite: false }));
  finBand.rotation.x = -Math.PI / 2; finBand.rotation.z = flrot; finBand.position.set(flcx, 0.18, flcz);
  const finCurtainMat = new THREE.MeshBasicMaterial({ map: checker(flen / 3.5, 1), transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
  const finCurtain = new THREE.Mesh(new THREE.PlaneGeometry(flen, 3.5), finCurtainMat);
  finCurtain.rotation.y = flrot; finCurtain.position.set(flcx, 2.2, flcz);
  const fin = new THREE.Group(); fin.add(finBand, finCurtain); scene.add(fin);
  
  const lineLabel = (txt, bg, lx, lz) => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128; const x = c.getContext('2d');
    x.fillStyle = bg; x.fillRect(0, 0, 512, 128); x.strokeStyle = '#fff'; x.lineWidth = 8; x.strokeRect(4, 4, 504, 120);
    x.fillStyle = '#fff'; x.font = 'bold 84px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, 256, 68);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true }));
    s.scale.set(26, 6.5, 1); s.position.set(lx, 12, lz); s.renderOrder = 5; scene.add(s); return s;
  };
  const startLabel = lineLabel('START LINE', 'rgba(180,120,0,0.85)', lcx, lcz);
  const finLabel = lineLabel('FINISH', 'rgba(20,20,20,0.88)', flcx, flcz);
  
  // フィニッシュ運営艇とピン
  const fComBoat = putBoat(makeMotorboat('committee', { stripe: 0x1d4ed8, flags: [{ color: '#1d4ed8', w: 1.5, h: 1.0 }, ORG] }), MARKS.fcom.a, MARKS.fcom.c, HEAD + 0.1);
  const fPinObj = buoy(0x2a77ff, 0x2a77ff); fPinObj.position.set(fpa.x, 0, fpa.z); scene.add(fPinObj); bob.push(fPinObj); markObjs.fm = fPinObj;
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
    // mode: 'start' | 'finish'  emph: 0..1 (\u30d7\u30ec\u30a4\u30e4\u30fc\u304c\u6700\u7d42\u30ec\u30b0\u3067\u5f37\u8abf)
    setLine(mode, emph) {
      finCurtainMat.opacity = 0.25 + 0.3 * emph + (emph > 0.5 ? 0.12 * Math.sin(performance.now() / 250) : 0);
    },
    update(t, camera, dt, wt = 0) {
      waterMat.uniforms.uTime.value = t; waterMat.uniforms.uWT.value = wt; skyMat.uniforms.uTime.value = t;
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

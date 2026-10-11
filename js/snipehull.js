// スナイプ級の船体・デッキ・コクピットの詳細モデル(実艇の構造に準拠)
// 座標: 船首 -z / 船尾 +z / x=横 / y=上。全長 4.72m
import * as THREE from 'three';

const L = 2.36;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const uOf = (z) => clamp01((z + L) / (2 * L));

export const FLOOR_Y = 0.07; // コクピット床
export const COAM = 0.43; // コクピット半幅
export const ZC0 = -0.58, ZC1 = 1.66; // コクピット前端・後端

export function halfBeam(z) {
  const u = uOf(z);
  if (u < 0.5) return 0.77 * Math.pow(Math.sin((u / 0.5) * Math.PI / 2), 0.72);
  return 0.77 - 0.2 * Math.pow((u - 0.5) / 0.5, 1.7);
}
export function sheerY(z) {
  const u = uOf(z);
  return 0.35 + 0.12 * Math.pow(Math.max(0, 1 - u / 0.45), 2) - 0.012 * u;
}
function bottomY(z) {
  const u = uOf(z);
  return -0.22 + Math.pow(Math.max(0, 1 - u / 0.6), 2.2) * (sheerY(z) + 0.19) + Math.pow(Math.max(0, (u - 0.7) / 0.3), 2) * 0.16;
}
export function deckY(z, x) {
  const B = Math.max(halfBeam(z), 1e-3);
  const w = Math.min(1, Math.abs(x) / B);
  return sheerY(z) + 0.045 * (1 - w * w) * Math.min(1, B / 0.5);
}

// ---------- テクスチャ ----------
function noiseCanvas(sz, base, amp, dots) {
  const c = document.createElement('canvas'); c.width = c.height = sz; const x = c.getContext('2d');
  x.fillStyle = base; x.fillRect(0, 0, sz, sz);
  for (let i = 0; i < dots; i++) {
    const v = Math.random() * amp; x.fillStyle = `rgba(0,0,0,${v})`; x.fillRect(Math.random() * sz, Math.random() * sz, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  return c;
}
function tex(c, rep, srgb = true) {
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep[0], rep[1]); t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
}
// ノンスキッド(ダイヤ格子の凸凹)
function nonskidBump() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  x.fillStyle = '#808080'; x.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
    const px = i * 8 + (j % 2) * 4, py = j * 8;
    const g = x.createRadialGradient(px + 4, py + 4, 0, px + 4, py + 4, 3.5);
    g.addColorStop(0, '#fff'); g.addColorStop(1, '#808080');
    x.fillStyle = g; x.beginPath(); x.arc(px + 4, py + 4, 3.4, 0, 7); x.fill();
  }
  return c;
}
function braidTex() {
  const c = document.createElement('canvas'); c.width = 32; c.height = 32; const x = c.getContext('2d');
  x.fillStyle = '#d8d8d8'; x.fillRect(0, 0, 32, 32);
  x.strokeStyle = '#8a8a8a'; x.lineWidth = 3;
  for (let i = -32; i < 64; i += 8) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 32, 32); x.stroke(); }
  x.strokeStyle = '#f4f4f4'; x.lineWidth = 1.5;
  for (let i = -28; i < 64; i += 8) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 32, 32); x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function webbingTex() {
  const c = document.createElement('canvas'); c.width = 16; c.height = 64; const x = c.getContext('2d');
  x.fillStyle = '#e8e8e8'; x.fillRect(0, 0, 16, 64);
  x.fillStyle = '#9a9a9a'; for (let i = 0; i < 64; i += 3) x.fillRect(0, i, 16, 1);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}

const bump = (() => { const t = tex(nonskidBump(), [1, 1], false); return t; })();
const braid = braidTex();
const webbing = webbingTex();
const speckle = tex(noiseCanvas(256, '#ffffff', 0.05, 1400), [1, 1]);

export const M = {
  gel: new THREE.MeshPhysicalMaterial({ color: 0xf3f6f5, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1, map: speckle, side: THREE.DoubleSide }),
  nonskid: new THREE.MeshStandardMaterial({ color: 0xe4e8e6, roughness: 0.75, bumpMap: bump, bumpScale: 1.4, side: THREE.DoubleSide }),
  floor: new THREE.MeshStandardMaterial({ color: 0xcfd6d8, roughness: 0.8, bumpMap: bump, bumpScale: 1.6, side: THREE.DoubleSide }),
  wall: new THREE.MeshPhysicalMaterial({ color: 0xe9eeee, roughness: 0.35, clearcoat: 0.6, side: THREE.DoubleSide }),
  alu: new THREE.MeshStandardMaterial({ color: 0xc9cfd6, roughness: 0.28, metalness: 0.9 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.25, metalness: 1 }),
  black: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.55, metalness: 0.1 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x101113, roughness: 0.95 }),
  rail: new THREE.MeshStandardMaterial({ color: 0x20252c, roughness: 0.6 }),
  wood: new THREE.MeshStandardMaterial({ color: 0xb98a55, roughness: 0.55 }),
  strap: new THREE.MeshStandardMaterial({ color: 0x1d2a44, roughness: 0.9, map: webbing }),
  foam: new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 1 }),
};
const ropeMats = new Map();
export function ropeMat(color) {
  let m = ropeMats.get(color);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, map: braid }); ropeMats.set(color, m); }
  return m;
}

// ---------- ジオメトリ補助 ----------
function grid(us, vs, fn, colorFn, uvk = [2, 2]) {
  const pos = [], uv = [], col = colorFn ? [] : null, idx = [];
  for (let i = 0; i < us.length; i++) for (let j = 0; j < vs.length; j++) {
    const p = fn(us[i], vs[j], i, j); pos.push(p[0], p[1], p[2]); uv.push(p[0] * uvk[0], p[2] * uvk[1]);
    if (col) { const c = colorFn(us[i], vs[j], i, j); col.push(c[0], c[1], c[2]); }
  }
  const nv = vs.length;
  for (let i = 0; i < us.length - 1; i++) for (let j = 0; j < nv - 1; j++) {
    const a = i * nv + j, b = a + 1, c = a + nv, d = c + 1; idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals(); return g;
}
const lin = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

export function ropeGeo(pts, r = 0.0065, seg) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => (p.isVector3 ? p : new THREE.Vector3(...p))), false, 'catmullrom', 0.3);
  const n = seg || Math.max(8, pts.length * 6);
  const g = new THREE.TubeGeometry(curve, n, r, 6, false);
  const len = curve.getLength(); const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * len * 55);
  return g;
}
export function rope(pts, color, r) { return new THREE.Mesh(ropeGeo(pts, r), ropeMat(color)); }

function mesh(geo, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; }

// カムクリート
export function camCleat(scale = 1) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(0.075, 0.012, 0.038), M.black, 0, 0.006, 0));
  for (const s of [-1, 1]) {
    const horn = mesh(new THREE.BoxGeometry(0.03, 0.02, 0.016), M.alu, s * 0.016, 0.022, 0); horn.rotation.z = -s * 0.5; g.add(horn);
    const cam = mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.012, 10), M.steel, s * 0.012, 0.03, 0.0); cam.rotation.x = Math.PI / 2; g.add(cam);
  }
  g.add(mesh(new THREE.BoxGeometry(0.008, 0.01, 0.038), M.alu, 0, 0.018, 0));
  g.scale.setScalar(scale); return g;
}
// ブロック(滑車)
export function block(r = 0.022, color = 0x22262c) {
  const g = new THREE.Group();
  const sheave = mesh(new THREE.CylinderGeometry(r, r, r * 0.55, 16), new THREE.MeshStandardMaterial({ color, roughness: 0.4 })); sheave.rotation.z = Math.PI / 2; g.add(sheave);
  for (const s of [-1, 1]) { const ch = mesh(new THREE.CylinderGeometry(r * 1.12, r * 1.12, r * 0.12, 16), M.alu, s * r * 0.4, 0, 0); ch.rotation.z = Math.PI / 2; g.add(ch); }
  const eye = mesh(new THREE.TorusGeometry(r * 0.45, r * 0.12, 6, 12), M.steel, 0, r * 1.15, 0); eye.rotation.y = Math.PI / 2; g.add(eye);
  return g;
}
function fairlead(r = 0.02) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(r * 1.6, r * 1.8, 0.01, 12), M.black, 0, 0.005, 0));
  g.add(mesh(new THREE.TorusGeometry(r, r * 0.35, 8, 14), M.steel, 0, 0.022, 0));
  return g;
}

// ---------- 船体メッシュ本体 ----------
export function buildHull(accent = 0x2a77ff) {
  const g = new THREE.Group();
  const acc = new THREE.Color(accent);
  // 外板(舷側のカラーストライプは頂点カラー)
  const ts = [0, 0.01, 0.04, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.84, 0.86, 0.925, 0.94, 0.97, 1];
  const ws = [...ts.map((t) => -Math.pow(t, 1 / 2.3)).reverse(), ...ts.slice(1).map((t) => Math.pow(t, 1 / 2.3))];
  const zs = lin(-L, L, 70);
  const hullGeo = grid(zs, ws, (z, w) => {
    const B = halfBeam(z), s = sheerY(z), bo = bottomY(z);
    return [w * B, bo + (s - bo) * Math.pow(Math.abs(w), 2.3), z];
  }, (z, w) => {
    const t = Math.pow(Math.abs(w), 2.3);
    if (t >= 0.855 && t <= 0.93) return [acc.r, acc.g, acc.b];
    return [1, 1, 1];
  }, [1, 1]);
  const hullMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08, vertexColors: true, side: THREE.DoubleSide, map: speckle });
  g.add(new THREE.Mesh(hullGeo, hullMat));
  // 船尾板
  const sh = new THREE.Shape(); const B = halfBeam(L), s = sheerY(L), bo = bottomY(L);
  sh.moveTo(-B, s);
  for (const w of ws) sh.lineTo(w * B, bo + (s - bo) * Math.pow(Math.abs(w), 2.3));
  sh.lineTo(B, s); sh.closePath();
  const tr = new THREE.Mesh(new THREE.ShapeGeometry(sh), M.gel); tr.position.z = L; g.add(tr);

  // デッキ(フォアデッキ / サイドデッキ / 後部デッキ)
  const dz = (a, b, n) => lin(a, b, n);
  const fore = grid(dz(-L, ZC0, 24), lin(-1, 1, 20), (z, w) => { const x = w * halfBeam(z); return [x, deckY(z, x), z]; });
  g.add(new THREE.Mesh(fore, M.gel));
  const aft = grid(dz(ZC1, L, 8), lin(-1, 1, 20), (z, w) => { const x = w * halfBeam(z); return [x, deckY(z, x), z]; });
  g.add(new THREE.Mesh(aft, M.nonskid));
  for (const sg of [-1, 1]) {
    const side = grid(dz(ZC0, ZC1, 28), lin(0, 1, 8), (z, v) => { const B2 = halfBeam(z); const x = sg * (COAM + v * (B2 - COAM)); return [x, deckY(z, x), z]; });
    g.add(new THREE.Mesh(side, M.nonskid));
    // コーミング(コクピット側壁)
    const wall = grid(dz(ZC0, ZC1, 20), lin(0, 1, 4), (z, v) => { const top = deckY(z, COAM); return [sg * COAM, FLOOR_Y + (top - FLOOR_Y) * v, z]; });
    g.add(new THREE.Mesh(wall, M.wall));
    // コーミング上端のキャップ(丸み)
    const capPts = dz(ZC0, ZC1, 14).map((z) => new THREE.Vector3(sg * (COAM - 0.004), deckY(z, COAM) + 0.004, z));
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(capPts), 40, 0.012, 8), M.gel));
    // ガンネル(ラブレール)
    const rr = dz(-L * 0.97, L * 0.99, 40).map((z) => { const x = sg * halfBeam(z) * 0.995; return new THREE.Vector3(x, deckY(z, x) + 0.004, z); });
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rr), 90, 0.016, 8), M.rail));
  }
  // 前後バルクヘッド
  const fb = grid(lin(-1, 1, 6), lin(0, 1, 4), (w, v) => [w * COAM, FLOOR_Y + (deckY(ZC0, w * COAM) - FLOOR_Y) * v, ZC0]); g.add(new THREE.Mesh(fb, M.wall));
  const ab = grid(lin(-1, 1, 6), lin(0, 1, 4), (w, v) => [w * COAM, FLOOR_Y + (deckY(ZC1, w * COAM) - FLOOR_Y) * v, ZC1]); g.add(new THREE.Mesh(ab, M.wall));
  // コクピット床(後方へ緩く上がる)
  const fl = grid(lin(ZC0, ZC1, 14), lin(-1, 1, 10), (z, w) => [w * COAM, FLOOR_Y + Math.max(0, z - 0.9) * 0.05 + 0.012 * (1 - w * w), z]);
  g.add(new THREE.Mesh(fl, M.floor));

  // センターボードケース(トランク)
  const trunk = new THREE.Group();
  const tw = 0.075, tz0 = -0.5, tz1 = 0.5, th = 0.52;
  trunk.add(mesh(new THREE.BoxGeometry(tw * 2, th, tz1 - tz0), M.wall, 0, FLOOR_Y + th / 2, (tz0 + tz1) / 2));
  trunk.add(mesh(new THREE.BoxGeometry(tw * 2 + 0.02, 0.025, tz1 - tz0 + 0.02), M.alu, 0, FLOOR_Y + th + 0.005, (tz0 + tz1) / 2));
  trunk.add(mesh(new THREE.BoxGeometry(0.024, 0.02, tz1 - tz0 - 0.04), M.black, 0, FLOOR_Y + th + 0.02, (tz0 + tz1) / 2)); // スロット
  // センターボード・ハンドル/ピボット
  const pivot = mesh(new THREE.CylinderGeometry(0.014, 0.014, tw * 2 + 0.05, 10), M.steel, 0, FLOOR_Y + th - 0.02, tz1 - 0.12); pivot.rotation.z = Math.PI / 2; trunk.add(pivot);
  const handle = mesh(new THREE.BoxGeometry(0.018, 0.012, 0.3), M.alu, tw + 0.035, FLOOR_Y + th + 0.01, 0.25); trunk.add(handle);
  g.add(trunk);
  // トランク両側のジブシートクリート
  for (const sg of [-1, 1]) {
    const c = camCleat(1.1); c.position.set(sg * (tw + 0.006), FLOOR_Y + 0.34, -0.12); c.rotation.z = -sg * Math.PI / 2; c.rotation.y = sg * 0.15; g.add(c);
    const c2 = camCleat(0.9); c2.position.set(sg * (tw + 0.006), FLOOR_Y + 0.22, 0.32); c2.rotation.z = -sg * Math.PI / 2; g.add(c2);
    const fl2 = fairlead(); fl2.position.set(sg * (tw + 0.006), FLOOR_Y + 0.4, -0.3); fl2.rotation.z = -sg * Math.PI / 2; g.add(fl2);
  }

  // ハイクアウトストラップ(トーストラップ): 床のアイボルトからパッド付きで張る
  for (const sg of [-1, 1]) {
    const pts = [[0, 0], [0.2, 0.04], [0.55, 0.15], [0.95, 0.17], [1.3, 0.13], [1.55, 0.04]]
      .map(([zz, hh]) => new THREE.Vector3(sg * 0.25, FLOOR_Y + 0.02 + hh, -0.08 + zz));
    const cv = new THREE.CatmullRomCurve3(pts);
    const t = new THREE.Mesh(new THREE.TubeGeometry(cv, 40, 0.017, 8), M.strap); t.scale.set(2.2, 1, 1); // 平たいベルト断面
    // scaleで位置もずれるため原点補正
    t.position.x = sg * 0.25 * (1 - 2.2); g.add(t);
    const pad = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.slice(2, 5)), 12, 0.022, 8), M.foam); pad.scale.set(1.8, 1, 1); pad.position.x = sg * 0.25 * (1 - 1.8); g.add(pad);
    for (const p of [pts[0], pts[pts.length - 1]]) { const e = mesh(new THREE.TorusGeometry(0.018, 0.005, 6, 10), M.steel, p.x, p.y, p.z); e.rotation.x = Math.PI / 2; g.add(e); }
  }

  // ジブリード(サイドデッキのトラック+カー)
  for (const sg of [-1, 1]) {
    const x = sg * 0.58;
    for (const dx of [-0.018, 0.018]) g.add(mesh(new THREE.BoxGeometry(0.008, 0.012, 0.8), M.alu, x + dx, deckY(-0.05, x) + 0.007, -0.05));
    g.add(mesh(new THREE.BoxGeometry(0.052, 0.008, 0.8), M.black, x, deckY(-0.05, x) + 0.002, -0.05));
    const car = new THREE.Group(); car.position.set(x, deckY(-0.1, x) + 0.012, -0.1);
    car.add(mesh(new THREE.BoxGeometry(0.06, 0.03, 0.07), M.black, 0, 0.015, 0));
    const fl3 = fairlead(0.018); fl3.position.y = 0.03; car.add(fl3); g.add(car);
  }
  // シュラウド・チェーンプレート
  for (const sg of [-1, 1]) {
    const x = sg * 0.62, z = -0.75, y = deckY(z, x);
    g.add(mesh(new THREE.BoxGeometry(0.04, 0.006, 0.09), M.steel, x, y + 0.004, z));
    g.add(mesh(new THREE.TorusGeometry(0.012, 0.004, 6, 10), M.steel, x, y + 0.02, z));
  }
  // 艇首: ストラップ付きハッチ、フォアステイ金具、クリート
  const hy = deckY(-1.55, 0);
  const hatch = mesh(new THREE.CylinderGeometry(0.11, 0.115, 0.018, 24), M.wall, 0, hy + 0.01, -1.55); g.add(hatch);
  g.add(mesh(new THREE.TorusGeometry(0.105, 0.007, 8, 28), M.alu, 0, hy + 0.02, -1.55).rotateX(Math.PI / 2));
  const bowEye = mesh(new THREE.TorusGeometry(0.02, 0.006, 6, 10), M.steel, 0, deckY(-2.18, 0) + 0.02, -2.2); bowEye.rotation.y = Math.PI / 2; g.add(bowEye);
  const stem = mesh(new THREE.BoxGeometry(0.04, 0.06, 0.1), M.steel, 0, deckY(-2.28, 0) + 0.015, -2.27); g.add(stem);
  const fcl = camCleat(1); fcl.position.set(0, deckY(-1.2, 0), -1.2); g.add(fcl);
  // バウの黒い3本線(ジブ調整の目安): フォアステイ根元から左右に放射状に引かれたライン
  const lineMat = new THREE.MeshBasicMaterial({ color: 0x0b0c0e, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const deckStripe = (ang, sg) => {
    const z0 = -1.36, z1 = -0.66, w = 0.0065, n = 10, pos = [], idx = [];
    const tn = Math.tan(ang), nx = Math.cos(ang), nz = Math.sin(ang) * sg; // ライン直交方向(平面内)
    for (let i = 0; i <= n; i++) {
      const z = z0 + ((z1 - z0) * i) / n, x = sg * (z + 2.0) * tn;
      for (const s of [-1, 1]) { const px = x + s * w * nx, pz = z - s * w * nz; pos.push(px, deckY(pz, px) + 0.0025, pz); }
      if (i < n) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    const m = new THREE.Mesh(geo, lineMat); m.material.side = THREE.DoubleSide; g.add(m);
  };
  for (const sg of [-1, 1]) for (const deg of [8, 11, 14]) deckStripe((deg * Math.PI) / 180, sg);
  // マスト根元(カラー+ブーツ)
  const my = deckY(-0.9, 0);
  g.add(mesh(new THREE.CylinderGeometry(0.052, 0.062, 0.05, 16), M.alu, 0, my + 0.02, -0.9));
  g.add(mesh(new THREE.CylinderGeometry(0.046, 0.054, 0.1, 16), M.rubber, 0, my + 0.08, -0.9));

  // 後部デッキ: トラベラー+クリート類
  const trY = deckY(1.45, 0) + 0.02; // 後方コクピット横断のトラベラー(バー)
  const barPts = lin(-1, 1, 12).map((w) => new THREE.Vector3(w * 0.5, FLOOR_Y + 0.32 + 0.0 * w, 1.52 - 0.06 * w * w));
  g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(barPts), 30, 0.011, 8), M.alu));
  for (const sg of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(0.03, 0.34, 0.03), M.alu, sg * 0.5, FLOOR_Y + 0.17, 1.46)); // サポート脚
    const cl = camCleat(0.9); cl.position.set(sg * 0.43, FLOOR_Y + 0.34, 1.5); g.add(cl);
    const bl = block(0.016); bl.position.set(sg * 0.5, FLOOR_Y + 0.33, 1.5); g.add(bl);
  }
  g.add(mesh(new THREE.BoxGeometry(0.06, 0.04, 0.05), M.black, 0, FLOOR_Y + 0.32, 1.52));
  const tb = block(0.024); tb.position.set(0, FLOOR_Y + 0.28, 1.52); g.add(tb);
  // 床のメインシートクリート
  const msc = camCleat(1.2); msc.position.set(0, FLOOR_Y + 0.012, 1.18); g.add(msc);
  // バイラー・ボトル・スポンジ
  g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 12), M.alu, 0, FLOOR_Y + 0.04, 1.6)); // バイラー
  const bottle = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 12), new THREE.MeshPhysicalMaterial({ color: 0x3aa0ff, roughness: 0.2, transmission: 0.2, transparent: true, opacity: 0.8 }), -0.34, FLOOR_Y + 0.1, 0.72);
  bottle.rotation.z = Math.PI / 2; g.add(bottle);
  // 排水口(トランサム: 自動バイラー)
  g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.012, 14), M.black, 0.2, FLOOR_Y + 0.02, 1.72).rotateX(0));

  // コントロールライン(カニンガム/アウトホール/バング)の尻尾: 左右のコーミングに静的に配置
  const tail = (sx, z0, color) => {
    const pts = []; for (let i = 0; i < 6; i++) pts.push(new THREE.Vector3(sx * (COAM - 0.04 - i * 0.012), FLOOR_Y + 0.015 + (i % 2) * 0.006, z0 + i * 0.07 + Math.sin(i * 1.7) * 0.03));
    g.add(rope(pts, color, 0.005));
  };
  tail(-1, 0.55, 0xffd23a); tail(1, 0.6, 0x22c55e); tail(-1, 0.95, 0xef4444); tail(1, 0.98, 0x3b82f6);
  // 床に転がるシート類の束(コイル)
  for (const [px, pz, col] of [[0.22, 0.55, 0xff3b3b], [-0.2, 0.85, 0x3b82f6], [0.1, 1.28, 0xf5f5f5]]) {
    const pts = []; for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 4; const rr = 0.05 + i * 0.006; pts.push(new THREE.Vector3(px + Math.cos(a) * rr, FLOOR_Y + 0.02 + i * 0.002, pz + Math.sin(a) * rr * 0.8)); }
    g.add(rope(pts, col, 0.0065));
  }
  return g;
}

// スナイプ級の船体・デッキ・コクピットの詳細モデル(実艇の構造に準拠)
// 座標: 船首 -z / 船尾 +z / x=横 / y=上。全長 4.72m
import * as THREE from 'three';

const L = 2.36;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const uOf = (z) => clamp01((z + L) / (2 * L));

export const FLOOR_Y = 0.15; // コクピット床(自己排水フロア・波頭が貫通しない十分な乾舷高さを確保)
export const COAM = 0.50; // コクピット半幅 (スナイプ級の広いコクピット幅)
export const ZC0 = -0.58, ZC1 = 1.66; // コクピット前端・後端

export function halfBeam(z) {
  const u = uOf(z);
  // スナイプ級特有の張りのある中央ビーム(最大半幅0.92m)と、後方から見たときに船体側面が自然に覗くスターンテーパー
  if (u < 0.46) return 0.92 * Math.pow(Math.sin((u / 0.46) * Math.PI / 2), 0.60);
  return 0.92 - 0.25 * Math.pow((u - 0.46) / 0.54, 1.42);
}
export function sheerY(z) {
  const u = uOf(z);
  // 船尾(スターン)側が海面にしっかり浸かり、後ろから見た際に側面パネルとトランサムがリアルに見えるシアーライン
  return 0.35 + 0.125 * Math.pow(Math.max(0, 1 - u / 0.45), 2) - 0.068 * Math.pow(Math.max(0, (u - 0.32) / 0.68), 1.32);
}
function bottomY(z) {
  const u = uOf(z);
  // 船尾ボトムも浮き上がらず海中にしっかり浸かるロッカー形状
  return -0.23 + Math.pow(Math.max(0, 1 - u / 0.58), 2.2) * (sheerY(z) + 0.20) + Math.pow(Math.max(0, (u - 0.72) / 0.28), 2) * 0.045;
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
  gel: new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x283542,
    emissiveIntensity: 0.22,
    roughness: 0.34,
    metalness: 0.0,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilRef: 1,
    stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilFail: THREE.KeepStencilOp,
  }),
  nonskid: new THREE.MeshStandardMaterial({ color: 0xfbfdff, emissive: 0x283542, emissiveIntensity: 0.22, roughness: 0.34, metalness: 0.0, side: THREE.DoubleSide }),
  floor: new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    emissive: 0x283542,
    emissiveIntensity: 0.22,
    roughness: 0.34,
    metalness: 0.0,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilRef: 1,
    stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilFail: THREE.KeepStencilOp,
  }),
  wall: new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x283542,
    emissiveIntensity: 0.22,
    roughness: 0.32,
    metalness: 0.0,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilRef: 1,
    stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilFail: THREE.KeepStencilOp,
  }),
  // 環境マップ無しでも黒く沈まず明るいシルバーに見えるよう metalness を抑えて明度を確保
  alu: new THREE.MeshStandardMaterial({ color: 0xdbe2ea, roughness: 0.35, metalness: 0.22 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.32, metalness: 0.25 }),
  black: new THREE.MeshStandardMaterial({ color: 0x262a30, roughness: 0.5, metalness: 0.08 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x262a30, roughness: 0.85 }),
  rail: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.26, metalness: 0.0 }),
  wood: new THREE.MeshStandardMaterial({ color: 0xb98a55, roughness: 0.55 }),
  strap: new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.85, map: webbing }),
  foam: new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 }),
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

// カムクリート (黒い塊感を抑え、シルバーベース＋コンパクトなカムに)
export function camCleat(scale = 1) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(0.055, 0.008, 0.028), M.alu, 0, 0.004, 0));
  for (const s of [-1, 1]) {
    const cam = mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.011, 10), M.black, s * 0.011, 0.014, 0.0); cam.rotation.x = Math.PI / 2; g.add(cam);
  }
  g.add(mesh(new THREE.TorusGeometry(0.013, 0.0025, 6, 12), M.steel, 0, 0.014, 0.014));
  g.scale.setScalar(scale); return g;
}
// ブロック(滑車)
export function block(r = 0.018, color = 0x334155) {
  const g = new THREE.Group();
  const sheave = mesh(new THREE.CylinderGeometry(r, r, r * 0.5, 14), new THREE.MeshStandardMaterial({ color, roughness: 0.35 })); sheave.rotation.z = Math.PI / 2; g.add(sheave);
  for (const s of [-1, 1]) { const ch = mesh(new THREE.CylinderGeometry(r * 1.08, r * 1.08, r * 0.1, 14), M.alu, s * r * 0.36, 0, 0); ch.rotation.z = Math.PI / 2; g.add(ch); }
  return g;
}
function fairlead(r = 0.015) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.TorusGeometry(r, r * 0.25, 8, 14), M.steel, 0, 0.014, 0));
  return g;
}

// ---------- 船体メッシュ本体 (実艇スナイプの純白FRPゲルコート・バウカウル・フラットデッキを忠実再現) ----------
export function buildHull(accent = 0x2a77ff) {
  const g = new THREE.Group();
  // 外板: 実艇写真通り、後ろから見た際にも傾斜したチャイン側面が立体的に見える純白FRPハル
  const ts = [0, 0.01, 0.04, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.88, 0.94, 0.98, 1];
  const ws = [...ts.map((t) => -Math.pow(t, 1 / 1.92)).reverse(), ...ts.slice(1).map((t) => Math.pow(t, 1 / 1.92))];
  const zs = lin(-L, L, 70);
  const wsOut = [...ws].reverse();
  const hullGeo = grid(zs, wsOut, (z, w) => {
    const B = halfBeam(z), s = sheerY(z), bo = bottomY(z);
    return [w * B, bo + (s - bo) * Math.pow(Math.abs(w), 1.92), z];
  });
  const addOrder = (m, order) => { m.renderOrder = order; g.add(m); return m; };
  addOrder(new THREE.Mesh(hullGeo, M.gel), -9);

  // 船尾板 (トランサム): 上縁も後部デッキのキャンバー(deckY)に完全一致させ、スターン端の隙間を無くす
  const sh = new THREE.Shape(); const B = halfBeam(L), s = sheerY(L), bo = bottomY(L);
  sh.moveTo(-B, deckY(L, -B));
  for (const w of ws) sh.lineTo(w * B, bo + (s - bo) * Math.pow(Math.abs(w), 1.92));
  for (let k = ws.length - 1; k >= 0; k--) {
    const x = ws[k] * B;
    sh.lineTo(x, deckY(L, x));
  }
  sh.closePath();
  const tr = new THREE.Mesh(new THREE.ShapeGeometry(sh), M.gel); tr.position.z = L; addOrder(tr, -9);
  // トランサム上縁の純白ロールエッジキャップ
  const trCapPts = lin(-1, 1, 16).map((w) => { const x = w * B; return new THREE.Vector3(x, deckY(L, x), L); });
  addOrder(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(trCapPts), 24, 0.012, 8), M.gel), -9);

  // デッキ(フォアデッキ / サイドデッキ / 後部デッキ): 段差や色ムラのない純白デッキ (左右とも法線が必ず上向き+yになるよう頂点順を揃える)
  const dz = (a, b, n) => lin(a, b, n);
  const fore = grid(dz(-L, ZC0, 28), ws, (z, w) => { const x = w * halfBeam(z); return [x, deckY(z, x), z]; });
  addOrder(new THREE.Mesh(fore, M.gel), -9);
  const aft = grid(dz(ZC1, L, 12), ws, (z, w) => { const x = w * halfBeam(z); return [x, deckY(z, x), z]; });
  addOrder(new THREE.Mesh(aft, M.gel), -9);
  for (const sg of [-1, 1]) {
    const vSide = sg > 0 ? lin(0, 1, 8) : lin(1, 0, 8);
    const side = grid(dz(ZC0, ZC1, 28), vSide, (z, v) => { const B2 = halfBeam(z); const x = sg * (COAM + v * (B2 - COAM)); return [x, deckY(z, x), z]; });
    addOrder(new THREE.Mesh(side, M.gel), -9);
    // コーミング(コクピット側壁): 黒い縁を無くし、サイドデッキから滑らかに丸く巻き込む純白FRPのロールエッジ
    const vWall = sg < 0 ? lin(0, 1, 4) : lin(1, 0, 4);
    const wall = grid(dz(ZC0, ZC1, 20), vWall, (z, v) => { const top = deckY(z, COAM); return [sg * COAM, FLOOR_Y + (top - FLOOR_Y) * v, z]; });
    addOrder(new THREE.Mesh(wall, M.wall), -8);
    const capPts = dz(ZC0, ZC1, 16).map((z) => new THREE.Vector3(sg * (COAM - 0.005), deckY(z, COAM) + 0.002, z));
    addOrder(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(capPts), 36, 0.018, 10), M.gel), -9);
    // ガンネルエッジも黒いラブレールではなく白いFRPシアーラインに統一(スターン端 L まで完全にカバー)
    const rr = dz(-L * 0.99, L, 44).map((z) => { const x = sg * halfBeam(z) * 0.998; return new THREE.Vector3(x, deckY(z, x), z); });
    addOrder(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rr), 72, 0.012, 8), M.gel), -9);
  }
  // 前後バルクヘッド & 純白のコクピットフロア
  const fb = grid(lin(-1, 1, 6), lin(0, 1, 4), (w, v) => [w * COAM, FLOOR_Y + (deckY(ZC0, w * COAM) - FLOOR_Y) * v, ZC0]); addOrder(new THREE.Mesh(fb, M.wall), -8);
  const ab = grid(lin(-1, 1, 6), lin(0, 1, 4), (w, v) => [w * COAM, FLOOR_Y + (deckY(ZC1, w * COAM) - FLOOR_Y) * v, ZC1]); addOrder(new THREE.Mesh(ab, M.wall), -8);
  const fl = grid(lin(ZC0, ZC1, 14), lin(-1, 1, 10), (z, w) => [w * COAM, FLOOR_Y + Math.max(0, z - 0.9) * 0.04 + 0.008 * (1 - w * w), z]);
  addOrder(new THREE.Mesh(fl, M.floor), -8);

  // 実艇写真の特徴的な「コクピット前端の白い立体波除けカウル (スプラッシュコーミング / コンソールフード)」
  // マスト前方(-1.12m)からコクピット前端(-0.52m)にかけて三角形に立ち上がる純白のFRPカウル
  const hoodZ = lin(-1.12, -0.50, 14);
  const hoodW = lin(-1, 1, 16);
  const hoodGeo = grid(hoodZ, hoodW, (z, w) => {
    const t = (z - (-1.12)) / 0.62; // 0(先端) .. 1(コクピット前端)
    const halfW = 0.045 + t * (COAM * 0.88 - 0.045);
    const x = w * halfW;
    const base = deckY(z, x);
    const arch = Math.sin(t * Math.PI * 0.85) * (1 - 0.65 * w * w) * 0.095;
    return [x, base + arch, z];
  });
  addOrder(new THREE.Mesh(hoodGeo, M.gel), -9);
  // カウル後端(コクピット側)の白いパネル壁
  const hoodBack = grid(lin(-1, 1, 12), lin(0, 1, 4), (w, v) => {
    const x = w * COAM * 0.88;
    const y0 = deckY(-0.50, x), y1 = y0 + (1 - 0.65 * w * w) * 0.075;
    return [x, y0 + (y1 - y0) * v, -0.50];
  });
  addOrder(new THREE.Mesh(hoodBack, M.wall), -8);

  // センターボードケース(ダガーボードトランク) & アルミ製ダガーボード:
  // クローズホールド時はケース内に深く下りており、リーチング〜ランチャーアップ時にケースのスリット(z=-0.26)に沿って真上に引き上がる構造
  const trunk = new THREE.Group();
  const tw = 0.048, tz0 = -0.54, tz1 = 0.02, th = 0.18, tzMid = (tz0 + tz1) * 0.5; // tzMid = -0.26
  const trBox = mesh(new THREE.BoxGeometry(tw * 2, th, tz1 - tz0), M.wall, 0, FLOOR_Y + th / 2, tzMid);
  trBox.renderOrder = -8;
  trunk.add(trBox);
  // 上面のシルバーアルミプレート (z=-0.26中心でトランクと完全一致)
  trunk.add(mesh(new THREE.BoxGeometry(tw * 2 + 0.014, 0.010, tz1 - tz0 + 0.012), M.alu, 0, FLOOR_Y + th + 0.005, tzMid));
  // センターボードスリット開口部 (z=-0.26中心、長さ0.44m)
  trunk.add(mesh(new THREE.BoxGeometry(0.024, 0.012, 0.44), M.black, 0, FLOOR_Y + th + 0.006, tzMid));
  // ダガーボード(センターボード)本体: スリット中心(x=0, z=-0.26)に完全一致させ、上げた時もケースと一切ずれないよう垂直配置
  const cbBoard = new THREE.Group();
  const cbTopBaseY = FLOOR_Y + th;
  // 1) 幅広のアルミ製メインプレート (前後幅0.41m: クローズ時(y=0)はケース内に収まり、上げた時(y=+0.23)も下端がケースのスリット内に残る)
  cbBoard.add(mesh(new THREE.BoxGeometry(0.016, 0.34, 0.41), M.alu, 0, cbTopBaseY - 0.155, tzMid));
  // 2) 上部のくり抜きハンドルフレーム (前後ピラーと上辺グリップバーも z=-0.26 中心・傾きなしでスリットと完全整列)
  const frontPillar = mesh(new THREE.BoxGeometry(0.016, 0.068, 0.064), M.alu, 0, cbTopBaseY + 0.048, tzMid - 0.172);
  cbBoard.add(frontPillar);
  const rearPillar = mesh(new THREE.BoxGeometry(0.016, 0.068, 0.064), M.alu, 0, cbTopBaseY + 0.048, tzMid + 0.172);
  cbBoard.add(rearPillar);
  const topBar = mesh(new THREE.BoxGeometry(0.018, 0.032, 0.41), M.alu, 0, cbTopBaseY + 0.092, tzMid);
  cbBoard.add(topBar);
  // 3) 上端前後の茶/オレンジ色ストッパーブロック(左右両面)
  const stopperMat = new THREE.MeshStandardMaterial({ color: 0xc25e28, roughness: 0.48, metalness: 0.05 });
  cbBoard.add(mesh(new THREE.BoxGeometry(0.050, 0.030, 0.054), stopperMat, 0, cbTopBaseY + 0.092, tzMid - 0.175));
  cbBoard.add(mesh(new THREE.BoxGeometry(0.048, 0.028, 0.050), stopperMat, 0, cbTopBaseY + 0.092, tzMid + 0.175));
  trunk.add(cbBoard);
  // ケース前端の保持ラバーコード(トランク側に固定し、ボードを上げた時に空中に浮かないようにする)
  trunk.add(rope([[0, cbTopBaseY + 0.022, tzMid - 0.21], [0.022, cbTopBaseY + 0.014, tzMid - 0.25], [0, cbTopBaseY + 0.008, tz0 - 0.01]], 0x1e293b, 0.0045));
  g.userData.cbBoard = cbBoard;
  // センターケース後端(z=0.05〜0.19)の低い白いフロアブレース＆メインシートブロック台座 (画像3枚目)
  const trBrace = mesh(new THREE.BoxGeometry(0.07, 0.11, 0.14), M.wall, 0, FLOOR_Y + 0.055, 0.11);
  trBrace.renderOrder = -8;
  trunk.add(trBrace);
  g.add(trunk);

  // トランク・コンソール周りのクリート
  for (const sg of [-1, 1]) {
    const c = camCleat(0.95); c.position.set(sg * 0.14, deckY(-0.52, sg * 0.14) + 0.055, -0.52); c.rotation.x = 0.25; g.add(c);
    const c2 = camCleat(0.9); c2.position.set(sg * (COAM - 0.02), deckY(0.05, sg * COAM) + 0.005, 0.05); g.add(c2);
  }

  // ハイクアウトストラップ(トーストラップ): 黒く太く見えないよう細身のグレーストラップを左右に配置
  for (const sg of [-1, 1]) {
    const pts = [[0, 0], [0.2, 0.025], [0.55, 0.07], [0.95, 0.075], [1.3, 0.06], [1.52, 0.02]]
      .map(([zz, hh]) => new THREE.Vector3(sg * 0.24, FLOOR_Y + 0.018 + hh, 0.02 + zz));
    const cv = new THREE.CatmullRomCurve3(pts);
    const t = new THREE.Mesh(new THREE.TubeGeometry(cv, 28, 0.010, 8), M.strap); t.scale.set(1.3, 0.55, 1);
    t.position.x = sg * 0.24 * (1 - 1.3); g.add(t);
  }

  // ジブリード & サイドステー金具 (広くなった船体幅に合わせて配置)
  for (const sg of [-1, 1]) {
    const x = sg * 0.64;
    g.add(mesh(new THREE.BoxGeometry(0.016, 0.008, 0.36), M.alu, x, deckY(-0.08, x) + 0.004, -0.08));
    const jb = block(0.016); jb.position.set(x, deckY(-0.1, x) + 0.02, -0.1); g.add(jb);
    // シュラウド・チェーンプレート(ステンレス)
    const sx = sg * 0.72, sz = -0.75, sy = deckY(sz, sx);
    g.add(mesh(new THREE.BoxGeometry(0.028, 0.006, 0.075), M.steel, sx, sy + 0.003, sz));
    g.add(mesh(new THREE.TorusGeometry(0.011, 0.0035, 6, 10), M.steel, sx, sy + 0.016, sz));
  }

  // 艇首: バウ先端のステンレス金具と細引き
  const bowEye = mesh(new THREE.TorusGeometry(0.016, 0.005, 6, 10), M.steel, 0, deckY(-2.22, 0) + 0.015, -2.22); bowEye.rotation.y = Math.PI / 2; g.add(bowEye);
  const stem = mesh(new THREE.BoxGeometry(0.032, 0.045, 0.085), M.steel, 0, deckY(-2.29, 0) + 0.01, -2.29); g.add(stem);
  g.add(rope([[0, deckY(-2.24, 0) + 0.012, -2.24], [0, deckY(-1.65, 0) + 0.012, -1.65]], 0xfacc15, 0.0035));
  g.add(rope([[0, deckY(-1.65, 0) + 0.012, -1.65], [0, deckY(-1.12, 0) + 0.018, -1.12]], 0x4ade80, 0.0035));

  // センターケース後端(z=0.10)のメインシートラチェットブロック & カムクリート (画像2・3枚目の位置)
  const msc = camCleat(1.0); msc.position.set(0, FLOOR_Y + 0.11, 0.10); g.add(msc);
  const tb = block(0.022); tb.position.set(0, FLOOR_Y + 0.15, 0.10); g.add(tb);

  // コンソール周りのカラフルなコントロールライン(ピンク・イエロー・ライトグリーン・ブルーの細ロープ)
  const tail = (sx, z0, color) => {
    const pts = []; for (let i = 0; i < 6; i++) pts.push(new THREE.Vector3(sx * (0.18 + i * 0.025), deckY(z0, sx * 0.2) + 0.01 + (i % 2) * 0.004, z0 + i * 0.055 + Math.sin(i * 1.7) * 0.02));
    g.add(rope(pts, color, 0.004));
  };
  tail(-1, -0.48, 0xf472b6); tail(1, -0.48, 0xfacc15); tail(-0.5, -0.52, 0x4ade80); tail(0.5, -0.50, 0x38bdf8);
  return g;
}

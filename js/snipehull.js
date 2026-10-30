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
  // スナイプ級特有の立ち上がったトップサイド乾舷と緩やかなシアーライン(後方・横から見た際に船の横の部分がはっきり見える高さ)
  return 0.37 + 0.115 * Math.pow(Math.max(0, 1 - u / 0.46), 1.9) - 0.032 * Math.pow(Math.max(0, (u - 0.35) / 0.65), 1.25);
}
export function chineY(z) {
  const u = uOf(z);
  // ハードチャインの稜線高さ: 水線すぐ上から船尾・船首へと伸び、トップサイド(船の横の部分)とボトム斜面をくっきり分ける
  return 0.055 + 0.165 * Math.pow(Math.max(0, 1 - u / 0.44), 2.05) + 0.028 * Math.pow(Math.max(0, (u - 0.55) / 0.45), 1.35);
}
function chineRatio(z) {
  const u = uOf(z);
  return 0.84 + 0.03 * Math.sin(Math.min(1, u / 0.85) * Math.PI);
}
function bottomY(z) {
  const u = uOf(z);
  // チャインから船底キールへのV字ボトムロッカー形状
  return -0.19 + Math.pow(Math.max(0, 1 - u / 0.52), 2.15) * (chineY(z) + 0.16) + Math.pow(Math.max(0, (u - 0.68) / 0.32), 1.8) * 0.085;
}
export function deckY(z, x) {
  const B = Math.max(halfBeam(z), 1e-3);
  const w = Math.min(1, Math.abs(x) / B);
  return sheerY(z) + 0.042 * (1 - w * w) * Math.min(1, B / 0.5);
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
// 実艇写真のトップサイド(船の横の部分)テクスチャ: ガンネル下の陰影・チャインの稜線・船尾クォーターの青いクラス/ビルダーロゴを再現
function topsidePanelTex() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0.0, '#aebfd2');   // ガンネル張り出し直下のシャープな陰影ライン
  g.addColorStop(0.11, '#d7e2ee');  // トップサイド上部
  g.addColorStop(0.55, '#e2ebf5');  // トップサイド中央(海面反射を受ける側面)
  g.addColorStop(0.90, '#d0ddeb');  // チャイン直上
  g.addColorStop(1.0, '#9fb2c7');   // ハードチャイン角の稜線エッジ
  x.fillStyle = g; x.fillRect(0, 0, 512, 128);
  // 船尾クォーター寄り(u ≈ 0.78..0.88)の青いスナイプビルダー/クラスデカール (実艇写真1枚目準拠)
  x.fillStyle = '#2563eb';
  x.fillRect(398, 26, 22, 12);
  x.fillStyle = '#1d4ed8';
  x.fillRect(426, 28, 34, 6);
  x.fillStyle = '#60a5fa';
  x.fillRect(426, 37, 24, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const bump = (() => { const t = tex(nonskidBump(), [1, 1], false); return t; })();
const braid = braidTex();
const webbing = webbingTex();
const topsideMap = topsidePanelTex();
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
  // 船の横の部分(トップサイド側面パネル): デッキの純白(#ffffff)と溶け込まないよう、側面特有のクールな陰影と艶を持たせる
  topside: new THREE.MeshStandardMaterial({
    color: 0xe2ebf5,
    map: topsideMap,
    emissive: 0x162230,
    emissiveIntensity: 0.10,
    roughness: 0.26,
    metalness: 0.02,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilRef: 1,
    stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilFail: THREE.KeepStencilOp,
  }),
  // チャインから下のボトムパネル: 斜め下を向くためトップサイドより一段濃い陰影となり、チャイン角の折れ線を際立たせる
  hullBottom: new THREE.MeshStandardMaterial({
    color: 0xb5c5d8,
    emissive: 0x0f1924,
    emissiveIntensity: 0.08,
    roughness: 0.36,
    metalness: 0.02,
    side: THREE.DoubleSide,
  }),
  // 船尾板(トランサム)上部パネル: トップサイド側面との角(コーナー)が立体的に見えるよう明度を分ける
  transom: new THREE.MeshStandardMaterial({
    color: 0xedf3fa,
    emissive: 0x1c2938,
    emissiveIntensity: 0.14,
    roughness: 0.30,
    metalness: 0.01,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilRef: 1,
    stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilFail: THREE.KeepStencilOp,
  }),
  // ガンネル張り出し縁の下面シャドウ＆チャイン稜線
  gunwaleUnder: new THREE.MeshStandardMaterial({
    color: 0x7c8ea3,
    roughness: 0.45,
    metalness: 0.02,
    side: THREE.DoubleSide,
  }),
  // バウ(前部)の空洞内部フロア＆奥壁: フォアデッキ下の奥行きと空洞感が一目で分かる陰影マテリアル
  cavityFloor: new THREE.MeshStandardMaterial({
    color: 0xc2ccd8,
    emissive: 0x121b26,
    emissiveIntensity: 0.10,
    roughness: 0.48,
    metalness: 0.0,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilRef: 1,
    stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilFail: THREE.KeepStencilOp,
  }),
  cavityWall: new THREE.MeshStandardMaterial({
    color: 0x9aa8ba,
    emissive: 0x0d1520,
    emissiveIntensity: 0.08,
    roughness: 0.52,
    metalness: 0.0,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilRef: 1,
    stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilFail: THREE.KeepStencilOp,
  }),
  cavityDeep: new THREE.MeshStandardMaterial({
    color: 0x4b5868,
    roughness: 0.70,
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

// ---------- 船体メッシュ本体 (実艇スナイプのハードチャイン側面・バウ空洞・フラットデッキを忠実再現) ----------
export function buildHull(accent = 0x2a77ff) {
  const g = new THREE.Group();
  const addOrder = (m, order) => { m.renderOrder = order; g.add(m); return m; };
  const zs = lin(-L, L, 72);
  const dz = (a, b, n) => lin(a, b, n);

  // 1) 船の横の部分 (トップサイド側面パネル: チャイン稜線 chineY 〜 シアーライン sheerY)
  // 実艇写真(1枚目)のように、白いデッキ面の下にガンネルの張り出し縁があり、その下にフラットな船体側面パネルとハードチャインの折れ線がくっきり見える構造
  for (const sg of [-1, 1]) {
    const vSidePanel = sg > 0 ? lin(0, 1, 6) : lin(1, 0, 6);
    const topsideGeo = grid(zs, vSidePanel, (z, v) => {
      const B = halfBeam(z);
      const cw = chineRatio(z);
      const xChine = sg * B * cw;
      const xSheer = sg * B * 0.985;
      const yChine = chineY(z);
      const ySheer = sheerY(z);
      return [xChine + (xSheer - xChine) * v, yChine + (ySheer - yChine) * v, z];
    });
    // UVを (u = バウ〜スターン 0..1, v = シアー上端0 .. チャイン下端1) に設定して topsideMap の陰影・デカールを正確に貼る
    const uvAttr = topsideGeo.attributes.uv;
    const nZ = zs.length, nV = vSidePanel.length;
    for (let i = 0; i < nZ; i++) {
      const u = i / (nZ - 1);
      for (let j = 0; j < nV; j++) {
        const v = vSidePanel[j]; // 0(chine) .. 1(sheer)
        uvAttr.setXY(i * nV + j, u, 1 - v);
      }
    }
    uvAttr.needsUpdate = true;
    addOrder(new THREE.Mesh(topsideGeo, M.topside), -9);

    // ハードチャインのシャープな折れ線エッジを強調するチャインライン
    const chinePts = dz(-L * 0.98, L, 48).map((z) => new THREE.Vector3(sg * halfBeam(z) * chineRatio(z), chineY(z), z));
    addOrder(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(chinePts), 64, 0.0065, 6), M.transom), -9);
  }

  // 2) チャインから下のV字ボトム斜面パネル (キール w=0 〜 チャイン w=±chineRatio)
  const wBotHalf = [0, 0.08, 0.22, 0.42, 0.65, 0.85, 1.0];
  const wsBot = [...wBotHalf.slice(1).map((t) => -t).reverse(), ...wBotHalf];
  const wsBotOut = [...wsBot].reverse();
  const bottomGeo = grid(zs, wsBotOut, (z, w) => {
    const B = halfBeam(z), cw = chineRatio(z);
    const yc = chineY(z), yb = bottomY(z);
    const aw = Math.abs(w);
    return [w * B * cw, yb + (yc - yb) * Math.pow(aw, 1.18), z];
  });
  addOrder(new THREE.Mesh(bottomGeo, M.hullBottom), -9);

  // 3) 船尾板 (トランサム): 実艇写真(1枚目)の通り、チャインより上の垂直に近いアッパートランサムと、チャインより下の斜めに絞られたロアートランサムの2段ハードチャイン形状
  const BL = halfBeam(L), cwL = chineRatio(L), sL = sheerY(L), cL = chineY(L), boL = bottomY(L);
  // アッパートランサム (チャイン cL 〜 デッキ上縁 deckY)
  const trUpGeo = grid(lin(-1, 1, 16), lin(0, 1, 4), (w, v) => {
    const xBot = w * BL * cwL;
    const xTop = w * BL * 0.99;
    const yBot = cL;
    const yTop = deckY(L, xTop);
    return [xBot + (xTop - xBot) * v, yBot + (yTop - yBot) * v, L];
  });
  addOrder(new THREE.Mesh(trUpGeo, M.transom), -9);
  // ロアートランサム (ボトム boL 〜 チャイン cL)
  const trLowGeo = grid(lin(-1, 1, 14), lin(0, 1, 4), (w, v) => {
    const aw = Math.abs(w);
    const xBot = w * BL * 0.22;
    const xTop = w * BL * cwL;
    const yBot = boL + (cL - boL) * Math.pow(aw, 1.5) * 0.25;
    const yTop = cL;
    return [xBot + (xTop - xBot) * v, yBot + (yTop - yBot) * v, L - (1 - v) * 0.035];
  });
  addOrder(new THREE.Mesh(trLowGeo, M.hullBottom), -9);
  // トランサム左舷の青いスナイプ銘板デカール (実艇写真1枚目準拠)
  const trDecal = mesh(new THREE.PlaneGeometry(0.16, 0.042), new THREE.MeshBasicMaterial({ color: 0x2563eb, side: THREE.DoubleSide }), -BL * 0.42, cL + (sL - cL) * 0.62, L + 0.002);
  addOrder(trDecal, -8);
  // トランサム上縁の純白ロールエッジキャップ
  const trCapPts = lin(-1, 1, 16).map((w) => { const x = w * BL; return new THREE.Vector3(x, deckY(L, x), L); });
  addOrder(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(trCapPts), 24, 0.013, 8), M.gel), -9);

  // 4) デッキ(フォアデッキ / サイドデッキ / 後部デッキ): 純白FRPデッキ
  const ts = [0, 0.02, 0.08, 0.18, 0.32, 0.5, 0.68, 0.84, 0.94, 1];
  const ws = [...ts.map((t) => -t).reverse(), ...ts.slice(1)];
  const fore = grid(dz(-L, ZC0, 28), ws, (z, w) => { const x = w * halfBeam(z); return [x, deckY(z, x), z]; });
  addOrder(new THREE.Mesh(fore, M.gel), -9);
  const aft = grid(dz(ZC1, L, 12), ws, (z, w) => { const x = w * halfBeam(z); return [x, deckY(z, x), z]; });
  addOrder(new THREE.Mesh(aft, M.gel), -9);
  for (const sg of [-1, 1]) {
    const vSide = sg > 0 ? lin(0, 1, 8) : lin(1, 0, 8);
    const side = grid(dz(ZC0, ZC1, 28), vSide, (z, v) => { const B2 = halfBeam(z); const x = sg * (COAM + v * (B2 - COAM)); return [x, deckY(z, x), z]; });
    addOrder(new THREE.Mesh(side, M.gel), -9);
    // コーミング(コクピット側壁): サイドデッキから滑らかに巻き込む純白FRPのロールエッジ
    const vWall = sg < 0 ? lin(0, 1, 4) : lin(1, 0, 4);
    const wall = grid(dz(ZC0, ZC1, 20), vWall, (z, v) => { const top = deckY(z, COAM); return [sg * COAM, FLOOR_Y + (top - FLOOR_Y) * v, z]; });
    addOrder(new THREE.Mesh(wall, M.wall), -8);
    const capPts = dz(ZC0, ZC1, 16).map((z) => new THREE.Vector3(sg * (COAM - 0.005), deckY(z, COAM) + 0.002, z));
    addOrder(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(capPts), 36, 0.018, 10), M.gel), -9);
    // ガンネルの張り出しラブレール(上側は純白、すぐ下側にシャープな陰影リップを入れてデッキと船体横側面を明確に分離)
    const rr = dz(-L * 0.99, L, 48).map((z) => { const x = sg * halfBeam(z) * 1.012; return new THREE.Vector3(x, deckY(z, x) + 0.003, z); });
    addOrder(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rr), 72, 0.014, 8), M.gel), -9);
    const rrUnder = dz(-L * 0.98, L, 44).map((z) => { const x = sg * halfBeam(z) * 0.996; return new THREE.Vector3(x, sheerY(z) - 0.008, z); });
    addOrder(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rrUnder), 64, 0.006, 6), M.gunwaleUnder), -9);
  }

  // 5) 後部バルクヘッド & コクピットフロア
  const ab = grid(lin(-1, 1, 6), lin(0, 1, 4), (w, v) => [w * COAM, FLOOR_Y + (deckY(ZC1, w * COAM) - FLOOR_Y) * v, ZC1]);
  addOrder(new THREE.Mesh(ab, M.wall), -8);
  const fl = grid(lin(ZC0, ZC1, 14), lin(-1, 1, 10), (z, w) => [w * COAM, FLOOR_Y + Math.max(0, z - 0.9) * 0.04 + 0.008 * (1 - w * w), z]);
  addOrder(new THREE.Mesh(fl, M.floor), -8);

  // 6) 実艇写真(2枚目)の「前の部分の空洞 (フォアデッキ下のバウ内部空間)」と「左右2連アーチ開口バルクヘッド＆中央V支柱」を徹底再現
  const Z_BOW_CAV = -1.68;
  // フォアデッキ下の空洞フロア (z = -1.68 〜 ZC0 = -0.58)
  const bowFl = grid(lin(Z_BOW_CAV, ZC0, 10), lin(-1, 1, 8), (z, w) => {
    const halfW = Math.min(COAM * 0.94, halfBeam(z) * 0.78);
    return [w * halfW, FLOOR_Y + 0.005 * (1 - w * w), z];
  });
  addOrder(new THREE.Mesh(bowFl, M.cavityFloor), -8);
  // 空洞内部の左右内壁・天井裏シェード・奥壁 (塞がった白い壁ではなく奥行きのある暗い空洞として見えるようにする)
  for (const sg of [-1, 1]) {
    const vIn = sg < 0 ? lin(0, 1, 4) : lin(1, 0, 4);
    const bowSideWall = grid(lin(Z_BOW_CAV, ZC0, 10), vIn, (z, v) => {
      const halfW = Math.min(COAM * 0.94, halfBeam(z) * 0.78);
      const topY = deckY(z, sg * halfW) - 0.006;
      return [sg * halfW, FLOOR_Y + (topY - FLOOR_Y) * v, z];
    });
    addOrder(new THREE.Mesh(bowSideWall, M.cavityWall), -8);
  }
  const bowCeil = grid(lin(Z_BOW_CAV, ZC0, 8), lin(-1, 1, 6), (z, w) => {
    const halfW = Math.min(COAM * 0.92, halfBeam(z) * 0.76);
    const x = w * halfW;
    return [x, deckY(z, x) - 0.008, z];
  });
  addOrder(new THREE.Mesh(bowCeil, M.cavityDeep), -8);
  const bowEndWall = grid(lin(-1, 1, 6), lin(0, 1, 4), (w, v) => {
    const halfW = Math.min(COAM * 0.92, halfBeam(Z_BOW_CAV) * 0.76);
    const x = w * halfW;
    return [x, FLOOR_Y + (deckY(Z_BOW_CAV, x) - FLOOR_Y) * v, Z_BOW_CAV];
  });
  addOrder(new THREE.Mesh(bowEndWall, M.cavityDeep), -8);
  // 空洞内部に見えるセンターケース前方延長リブとマストステップ支柱 (z = -0.90)
  const fwdKeelson = mesh(new THREE.BoxGeometry(0.072, 0.065, 0.56), M.cavityWall, 0, FLOOR_Y + 0.032, -0.82);
  addOrder(fwdKeelson, -8);
  const mastStepPost = mesh(new THREE.CylinderGeometry(0.032, 0.036, 0.34, 12), M.alu, 0, FLOOR_Y + 0.17, -0.90);
  addOrder(mastStepPost, -8);

  // コクピット前端の白い立体波除けカウル (スプラッシュコーミング / コンソールフード)
  const hoodZ = lin(-1.12, -0.50, 14);
  const hoodW = lin(-1, 1, 16);
  const hoodArchAt = (z, x) => {
    const t = clamp01((z - (-1.12)) / 0.62);
    const halfW = Math.max(0.045, 0.045 + t * (COAM * 0.88 - 0.045));
    const wn = clamp01(Math.abs(x) / halfW);
    return Math.sin(t * Math.PI * 0.85) * (1 - 0.65 * wn * wn) * 0.095;
  };
  const hoodGeo = grid(hoodZ, hoodW, (z, w) => {
    const t = (z - (-1.12)) / 0.62;
    const halfW = 0.045 + t * (COAM * 0.88 - 0.045);
    const x = w * halfW;
    return [x, deckY(z, x) + hoodArchAt(z, x), z];
  });
  addOrder(new THREE.Mesh(hoodGeo, M.gel), -9);

  // 実艇写真(2枚目)の「左右が大きくくり抜かれたアーチ型フロントフレーム (z = -0.52)」:
  // 全面を壁で塞がず、上縁のアーチビーム・左右外側のニー・中央のマストサポートV支柱だけで構成し、左右の大きな開口部からバウの空洞が覗く構造
  const zFrame = -0.52;
  const openArchY = (x) => {
    const ax = Math.abs(x);
    // |x| = 0.055 〜 0.42 の間が大きく開いたアーチくり抜き (下端は FLOOR_Y、上端は deckY + 0.015 まで開口)
    if (ax < 0.048 || ax > 0.43) return FLOOR_Y;
    const u = (ax - 0.048) / (0.43 - 0.048); // 0 .. 1
    const archCurve = Math.sin(u * Math.PI);
    return deckY(zFrame, x) - 0.032 + archCurve * 0.046;
  };
  const archHeaderGeo = grid(lin(-1, 1, 32), lin(0, 1, 4), (w, v) => {
    const x = w * COAM;
    const yTop = deckY(zFrame, x) + ( Math.abs(x) <= COAM * 0.88 ? hoodArchAt(zFrame, x) : 0 );
    const yBot = Math.min(yTop - 0.024, openArchY(x));
    return [x, yBot + (yTop - yBot) * v, zFrame];
  });
  addOrder(new THREE.Mesh(archHeaderGeo, M.wall), -8);

  // 中央のV字サポートストラット (写真2枚目中央の白いV字フレーム支柱)
  for (const sg of [-1, 1]) {
    const vStrut = mesh(new THREE.BoxGeometry(0.026, 0.24, 0.028), M.wall, sg * 0.058, FLOOR_Y + 0.25, zFrame - 0.005);
    vStrut.rotation.z = -sg * 0.22;
    addOrder(vStrut, -8);
  }
  const centerPillar = mesh(new THREE.BoxGeometry(0.056, 0.26, 0.036), M.wall, 0, FLOOR_Y + 0.25, zFrame - 0.008);
  addOrder(centerPillar, -8);

  // 写真2枚目通り: 中央支柱に掛かるオレンジ色・ブルー色のコントロールライン束と、空洞内へ伸びる黒いハイクアウトストラップ前端金具
  for (let loopIdx = 0; loopIdx < 3; loopIdx++) {
    const rx = 0.042 + loopIdx * 0.012;
    const ry = 0.055 + loopIdx * 0.014;
    const loopPts = lin(0, Math.PI * 2, 18).map((a) => new THREE.Vector3(
      0.045 + Math.sin(a) * rx,
      FLOOR_Y + 0.25 + Math.cos(a) * ry,
      zFrame + 0.016 + Math.sin(a * 2) * 0.006
    ));
    g.add(rope(loopPts, 0xf97316, 0.0038));
  }
  g.add(rope([
    [-0.08, FLOOR_Y + 0.34, zFrame + 0.01],
    [-0.14, FLOOR_Y + 0.22, zFrame - 0.03],
    [-0.19, FLOOR_Y + 0.14, zFrame - 0.02],
  ], 0x38bdf8, 0.0036));

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

  // ハイクアウトストラップ(トーストラップ): 実艇写真(2枚目)通り、フロントフレームの空洞開口下部(z=-0.54)から後部コクピットまで伸びる左右ストラップ＆白い金具プレート
  for (const sg of [-1, 1]) {
    const pts = [
      [-0.54, 0.135],
      [-0.36, 0.055],
      [-0.14, 0.015],
      [0.02, 0.005],
      [0.24, 0.030],
      [0.58, 0.072],
      [0.96, 0.075],
      [1.30, 0.058],
      [1.52, 0.020],
    ].map(([zz, hh]) => new THREE.Vector3(sg * (zz < 0 ? 0.18 - zz * 0.06 : 0.24), FLOOR_Y + 0.018 + hh, zz));
    const cv = new THREE.CatmullRomCurve3(pts);
    const t = new THREE.Mesh(new THREE.TubeGeometry(cv, 36, 0.011, 8), M.strap);
    t.scale.set(1.35, 0.48, 1);
    t.position.x = sg * 0.22 * (1 - 1.35);
    g.add(t);
    // フロントフレーム側の白いストラップ固定プレート (写真2枚目)
    const anchorPlate = mesh(new THREE.BoxGeometry(0.036, 0.044, 0.012), M.wall, sg * 0.20, FLOOR_Y + 0.16, -0.53);
    anchorPlate.rotation.x = -0.35;
    g.add(anchorPlate);
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

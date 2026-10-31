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
  const c = document.createElement('canvas'); c.width = 64; c.height = 128; const x = c.getContext('2d');
  x.fillStyle = '#1e293b'; x.fillRect(0, 0, 64, 128);
  // 両端の補強パイピングとイエローステッチライン(白フロア上でハイクベルトの輪郭がくっきり浮き立つ実艇仕様)
  x.fillStyle = '#0f172a'; x.fillRect(0, 0, 9, 128); x.fillRect(55, 0, 9, 128);
  x.fillStyle = '#facc15';
  for (let y = 2; y < 128; y += 6) {
    x.fillRect(10, y, 2, 3);
    x.fillRect(52, y, 2, 3);
  }
  x.fillStyle = '#334155';
  for (let y = 0; y < 128; y += 4) x.fillRect(14, y, 36, 1.5);
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
  strap: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.68, map: webbing, side: THREE.DoubleSide }),
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
let _cachedStaticHullParts = null;

function buildStaticHullParts() {
  if (_cachedStaticHullParts) return _cachedStaticHullParts;
  const g = new THREE.Group();
  const addOrder = (m, order) => { m.renderOrder = order; g.add(m); return m; };
  const zs = lin(-L, L, 72);
  const dz = (a, b, n) => lin(a, b, n);

  // 1) 船の横の部分 (トップサイド側面パネル: チャイン稜線 chineY 〜 シアーライン sheerY)
  // 船の淵が出っ張らないよう、デッキ外縁(B*0.992)とトップサイド上縁がフラットにつながる実艇形状
  for (const sg of [-1, 1]) {
    const vSidePanel = sg > 0 ? lin(0, 1, 6) : lin(1, 0, 6);
    const topsideGeo = grid(zs, vSidePanel, (z, v) => {
      const B = halfBeam(z);
      const cw = chineRatio(z);
      const xChine = sg * B * cw;
      const xSheer = sg * B * 0.992;
      const yChine = chineY(z);
      const ySheer = deckY(z, xSheer);
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

  // 3) 船尾板 (トランサム): チャインより上のアッパートランサムと、チャインより下のロアートランサム (淵の突起チューブなし)
  const BL = halfBeam(L), cwL = chineRatio(L), sL = sheerY(L), cL = chineY(L), boL = bottomY(L);
  const trUpGeo = grid(lin(-1, 1, 16), lin(0, 1, 4), (w, v) => {
    const xBot = w * BL * cwL;
    const xTop = w * BL * 0.992;
    const yBot = cL;
    const yTop = deckY(L, xTop);
    return [xBot + (xTop - xBot) * v, yBot + (yTop - yBot) * v, L];
  });
  addOrder(new THREE.Mesh(trUpGeo, M.transom), -9);
  const trLowGeo = grid(lin(-1, 1, 14), lin(0, 1, 4), (w, v) => {
    const aw = Math.abs(w);
    const xBot = w * BL * 0.22;
    const xTop = w * BL * cwL;
    const yBot = boL + (cL - boL) * Math.pow(aw, 1.5) * 0.25;
    const yTop = cL;
    return [xBot + (xTop - xBot) * v, yBot + (yTop - yBot) * v, L - (1 - v) * 0.035];
  });
  addOrder(new THREE.Mesh(trLowGeo, M.hullBottom), -9);
  // トランサム左舷の青いスナイプ銘板デカール
  const trDecal = mesh(new THREE.PlaneGeometry(0.16, 0.042), new THREE.MeshBasicMaterial({ color: 0x2563eb, side: THREE.DoubleSide }), -BL * 0.42, cL + (sL - cL) * 0.62, L + 0.002);
  addOrder(trDecal, -8);

  // 4) デッキ(フォアデッキ / サイドデッキ / 後部デッキ): 外側の淵も内側のコーミング淵も出っ張りチューブを廃してフラットに接続
  const ts = [0, 0.02, 0.08, 0.18, 0.32, 0.5, 0.68, 0.84, 0.94, 0.992];
  const ws = [...ts.map((t) => -t).reverse(), ...ts.slice(1)];
  const fore = grid(dz(-L, ZC0, 28), ws, (z, w) => { const x = w * halfBeam(z); return [x, deckY(z, x), z]; });
  addOrder(new THREE.Mesh(fore, M.gel), -9);
  const aft = grid(dz(ZC1, L, 12), ws, (z, w) => { const x = w * halfBeam(z); return [x, deckY(z, x), z]; });
  addOrder(new THREE.Mesh(aft, M.gel), -9);
  for (const sg of [-1, 1]) {
    const vSide = sg > 0 ? lin(0, 1, 8) : lin(1, 0, 8);
    const side = grid(dz(ZC0, ZC1, 28), vSide, (z, v) => { const B2 = halfBeam(z) * 0.992; const x = sg * (COAM + v * (B2 - COAM)); return [x, deckY(z, x), z]; });
    addOrder(new THREE.Mesh(side, M.gel), -9);
    // コーミング(コクピット側壁): サイドデッキ内縁(x = ±COAM)から出っ張りなしで垂直に降りるフラットな壁面
    const vWall = sg < 0 ? lin(0, 1, 4) : lin(1, 0, 4);
    const wall = grid(dz(ZC0, ZC1, 20), vWall, (z, v) => { const top = deckY(z, sg * COAM); return [sg * COAM, FLOOR_Y + (top - FLOOR_Y) * v, z]; });
    addOrder(new THREE.Mesh(wall, M.wall), -8);
  }

  // 5) 後部バルクヘッド & コクピットフロア
  const ab = grid(lin(-1, 1, 6), lin(0, 1, 4), (w, v) => [w * COAM, FLOOR_Y + (deckY(ZC1, w * COAM) - FLOOR_Y) * v, ZC1]);
  addOrder(new THREE.Mesh(ab, M.wall), -8);
  const fl = grid(lin(ZC0, ZC1, 14), lin(-1, 1, 10), (z, w) => [w * COAM, FLOOR_Y + Math.max(0, z - 0.9) * 0.04 + 0.008 * (1 - w * w), z]);
  addOrder(new THREE.Mesh(fl, M.floor), -8);

  // 6) フォアデッキ下のバウ内部空洞と左右2連アーチ開口バルクヘッド＆中央V支柱
  const Z_BOW_CAV = -1.68;
  const bowFl = grid(lin(Z_BOW_CAV, ZC0, 10), lin(-1, 1, 8), (z, w) => {
    const halfW = Math.min(COAM * 0.94, halfBeam(z) * 0.78);
    return [w * halfW, FLOOR_Y + 0.005 * (1 - w * w), z];
  });
  addOrder(new THREE.Mesh(bowFl, M.cavityFloor), -8);
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
  const fwdKeelson = mesh(new THREE.BoxGeometry(0.072, 0.065, 0.56), M.cavityWall, 0, FLOOR_Y + 0.032, -0.82);
  addOrder(fwdKeelson, -8);
  const mastStepPost = mesh(new THREE.CylinderGeometry(0.032, 0.036, 0.34, 12), M.alu, 0, FLOOR_Y + 0.17, -0.90);
  addOrder(mastStepPost, -8);

  // コクピット前端の白い立体波除けカウル & V字ウォーターブレイク (上縁の丸チューブ突起をなくしシャープな板状に)
  const hoodZ = lin(-1.24, -0.50, 16);
  const hoodW = lin(-1, 1, 18);
  const hoodArchAt = (z, x) => {
    const t = clamp01((z - (-1.24)) / 0.74);
    const halfW = Math.max(0.048, 0.048 + t * (COAM * 0.94 - 0.048));
    const wn = clamp01(Math.abs(x) / halfW);
    return Math.sin(t * Math.PI * 0.86) * (1 - 0.52 * wn * wn) * 0.138;
  };
  const hoodGeo = grid(hoodZ, hoodW, (z, w) => {
    const t = (z - (-1.24)) / 0.74;
    const halfW = 0.048 + t * (COAM * 0.94 - 0.048);
    const x = w * halfW;
    return [x, deckY(z, x) + hoodArchAt(z, x), z];
  });
  addOrder(new THREE.Mesh(hoodGeo, M.gel), -9);
  for (const sg of [-1, 1]) {
    const bwUs = lin(0, 1, 16);
    const bwVs = sg > 0 ? lin(0, 1, 4) : lin(1, 0, 4);
    const bwWallGeo = grid(bwUs, bwVs, (u, v) => {
      const z = -1.26 + u * (-0.52 - (-1.26));
      const x = sg * (0.018 + Math.pow(u, 0.92) * (COAM * 0.94 - 0.018));
      const baseY = deckY(z, x);
      const wallH = (0.068 + 0.068 * Math.sin(u * Math.PI * 0.78)) * (0.65 + 0.35 * u);
      return [x - sg * (1 - v) * 0.010, baseY + wallH * v, z];
    });
    addOrder(new THREE.Mesh(bwWallGeo, M.wall), -9);
  }

  // 左右が大きくくり抜かれたアーチ型フロントフレーム (z = -0.52)
  const zFrame = -0.52;
  const openArchY = (x) => {
    const ax = Math.abs(x);
    if (ax < 0.048 || ax > 0.43) return FLOOR_Y;
    const u = (ax - 0.048) / (0.43 - 0.048);
    const archCurve = Math.sin(u * Math.PI);
    return deckY(zFrame, x) - 0.032 + archCurve * 0.046;
  };
  const archHeaderGeo = grid(lin(-1, 1, 32), lin(0, 1, 4), (w, v) => {
    const x = w * COAM;
    const yTop = deckY(zFrame, x) + (Math.abs(x) <= COAM * 0.94 ? hoodArchAt(zFrame, x) : 0);
    const yBot = Math.min(yTop - 0.024, openArchY(x));
    return [x, yBot + (yTop - yBot) * v, zFrame];
  });
  addOrder(new THREE.Mesh(archHeaderGeo, M.wall), -8);

  for (const sg of [-1, 1]) {
    const vStrut = mesh(new THREE.BoxGeometry(0.026, 0.24, 0.028), M.wall, sg * 0.058, FLOOR_Y + 0.25, zFrame - 0.005);
    vStrut.rotation.z = -sg * 0.22;
    addOrder(vStrut, -8);
  }
  const centerPillar = mesh(new THREE.BoxGeometry(0.056, 0.26, 0.036), M.wall, 0, FLOOR_Y + 0.25, zFrame - 0.008);
  addOrder(centerPillar, -8);

  // センターボードケース(ダガーボードトランク)の固定部
  const tw = 0.048, tz0 = -0.54, tz1 = 0.02, th = 0.18, tzMid = (tz0 + tz1) * 0.5;
  addOrder(mesh(new THREE.BoxGeometry(tw * 2, th, tz1 - tz0), M.wall, 0, FLOOR_Y + th / 2, tzMid), -8);
  g.add(mesh(new THREE.BoxGeometry(tw * 2 + 0.014, 0.010, tz1 - tz0 + 0.012), M.alu, 0, FLOOR_Y + th + 0.005, tzMid));
  g.add(mesh(new THREE.BoxGeometry(0.024, 0.012, 0.44), M.black, 0, FLOOR_Y + th + 0.006, tzMid));
  const cbTopBaseY = FLOOR_Y + th;
  g.add(rope([[0, cbTopBaseY + 0.022, tzMid - 0.21], [0.022, cbTopBaseY + 0.014, tzMid - 0.25], [0, cbTopBaseY + 0.008, tz0 - 0.01]], 0x1e293b, 0.0045));
  const trBrace = mesh(new THREE.BoxGeometry(0.07, 0.11, 0.14), M.wall, 0, FLOOR_Y + 0.055, 0.11);
  addOrder(trBrace, -8);

  // トランク・コンソール周りのクリート
  for (const sg of [-1, 1]) {
    const c = camCleat(0.95); c.position.set(sg * 0.14, deckY(-0.52, sg * 0.14) + 0.055, -0.52); c.rotation.x = 0.25; g.add(c);
  }

  // ハイクベルト(ハイクアウトストラップ):
  // 実艇写真(3枚目)に準拠し、クルー用(前側: z=-0.53〜+0.14)とスキッパー用(後ろ側: z=+0.24〜+1.55)に2分割して配置
  const strapW = 0.068, strapH = 0.016;
  const addStrapRibbon = (sg, sampleFn, uSteps, uvScale) => {
    const sUs = lin(0, 1, uSteps);
    const topRibbon = grid(sUs, [-0.5, 0.5], (u, w) => {
      const [sx, sy, sz] = sampleFn(u);
      return [sx + w * strapW, sy + strapH * 0.5, sz];
    }, null, uvScale);
    const botRibbon = grid(sUs, [0.5, -0.5], (u, w) => {
      const [sx, sy, sz] = sampleFn(u);
      return [sx + w * strapW, sy - strapH * 0.5, sz];
    }, null, uvScale);
    const sideOuter = grid(sUs, [0, 1], (u, v) => {
      const [sx, sy, sz] = sampleFn(u);
      return [sx + sg * strapW * 0.5, sy + (v - 0.5) * strapH, sz];
    }, null, uvScale);
    const sideInner = grid(sUs, [1, 0], (u, v) => {
      const [sx, sy, sz] = sampleFn(u);
      return [sx - sg * strapW * 0.5, sy + (v - 0.5) * strapH, sz];
    }, null, uvScale);
    for (const rGeo of [topRibbon, botRibbon, sideOuter, sideInner]) {
      const mStrap = new THREE.Mesh(rGeo, M.strap);
      mStrap.renderOrder = -6;
      g.add(mStrap);
    }
  };

  for (const sg of [-1, 1]) {
    // (A) クルー用フロントハイクベルト (フロントフレーム z=-0.53 〜 センターケース後端脇 z=+0.14)
    const crewStrapSample = (u) => {
      const z = -0.53 + u * (0.14 - (-0.53));
      // 前端は x=±0.18、中央(z=-0.22)は x=±0.21、後端(z=+0.14)はセンターケース後端脇(x=±0.09)へ収束
      const x = sg * (0.18 + Math.sin(u * Math.PI) * 0.035 - Math.pow(u, 2.2) * 0.09);
      const floorLocal = FLOOR_Y + 0.008;
      const lift = 0.042 + 0.072 * Math.pow(1 - u, 1.8) + 0.028 * Math.sin(u * Math.PI);
      return [x, floorLocal + lift, z];
    };
    addStrapRibbon(sg, crewStrapSample, 14, [6, 6]);

    // (B) スキッパー用リアハイクベルト (センターケース後ろ z=+0.24 〜 後部バルクヘッド z=+1.55)
    const skipperStrapSample = (u) => {
      const z = 0.24 + u * (1.55 - 0.24);
      // 前端はセンターケース後ろフロア金具(x=±0.095)から始まり、コクピット中央〜後方で x=±0.23 を通る(画像3枚目)
      const x = sg * (0.095 + Math.pow(u, 0.55) * 0.145 - Math.max(0, u - 0.78) * 0.09);
      const floorLocal = FLOOR_Y + Math.max(0, z - 0.9) * 0.04 + 0.008;
      const lift = 0.036 + 0.056 * Math.sin(u * Math.PI) + 0.032 * Math.pow(u, 1.6);
      return [x, floorLocal + lift, z];
    };
    addStrapRibbon(sg, skipperStrapSample, 18, [9, 6]);

    // 1) フロントフレーム側のストラップ固定金具 (z = -0.53)
    const [fx0, fy0] = crewStrapSample(0);
    const anchorPlate = mesh(new THREE.BoxGeometry(0.044, 0.052, 0.014), M.wall, fx0, fy0, -0.53);
    anchorPlate.rotation.x = -0.28;
    g.add(anchorPlate);
    g.add(mesh(new THREE.BoxGeometry(0.050, 0.014, 0.022), M.steel, fx0, fy0, -0.515));

    // 2) センターケース後端の分割アンカー金具 (クルーベルト後端 z=0.14 & スキッパーベルト前端 z=0.24)
    const [cxEnd, cyEnd, czEnd] = crewStrapSample(1);
    g.add(mesh(new THREE.BoxGeometry(0.036, 0.014, 0.032), M.steel, cxEnd, cyEnd - 0.01, czEnd));
    const [sx0, sy0, sz0] = skipperStrapSample(0);
    g.add(mesh(new THREE.BoxGeometry(0.038, 0.014, 0.036), M.steel, sx0, sy0 - 0.01, sz0));
    g.add(rope([[sx0, sy0 - 0.005, sz0], [0, FLOOR_Y + 0.045, 0.17]], 0x1e293b, 0.0042));

    // 3) 後部バルクヘッド(z = 1.55)のステンレスアイプレート＆黒い調整ライン
    const [ax0, ay0, az0] = skipperStrapSample(1);
    g.add(mesh(new THREE.BoxGeometry(0.048, 0.038, 0.016), M.steel, ax0, ay0, ZC1 - 0.01));
    g.add(rope([[ax0, ay0, az0 - 0.02], [ax0, ay0 - 0.02, ZC1 - 0.01]], 0x1e293b, 0.0045));
  }

  // 左右のジブカム(スイベル台座＋カムクリート＋フェアリードリング: x=±0.54, z=-0.06) & サイドステー金具
  for (const sg of [-1, 1]) {
    const xCam = sg * 0.54, zCam = -0.06, yCam = deckY(zCam, xCam);
    const camBase = mesh(new THREE.CylinderGeometry(0.028, 0.034, 0.024, 12), M.alu, xCam, yCam + 0.012, zCam);
    g.add(camBase);
    const jCam = camCleat(1.08);
    jCam.position.set(xCam, yCam + 0.022, zCam);
    jCam.rotation.y = -sg * 0.72;
    jCam.rotation.z = sg * 0.12;
    g.add(jCam);
    const x = sg * 0.62;
    g.add(mesh(new THREE.BoxGeometry(0.016, 0.008, 0.34), M.alu, x, deckY(-0.10, x) + 0.004, -0.10));
    const jb = block(0.016); jb.position.set(x, deckY(-0.12, x) + 0.02, -0.12); g.add(jb);
    const sx = sg * 0.72, sz = -0.75, sy = deckY(sz, sx);
    g.add(mesh(new THREE.BoxGeometry(0.028, 0.006, 0.075), M.steel, sx, sy + 0.003, sz));
    g.add(mesh(new THREE.TorusGeometry(0.011, 0.0035, 6, 10), M.steel, sx, sy + 0.016, sz));
  }

  // 艇首: バウ先端のステンレス金具と細引き
  const bowEye = mesh(new THREE.TorusGeometry(0.016, 0.005, 6, 10), M.steel, 0, deckY(-2.22, 0) + 0.015, -2.22); bowEye.rotation.y = Math.PI / 2; g.add(bowEye);
  const stem = mesh(new THREE.BoxGeometry(0.032, 0.045, 0.085), M.steel, 0, deckY(-2.29, 0) + 0.01, -2.29); g.add(stem);
  g.add(rope([[0, deckY(-2.24, 0) + 0.012, -2.24], [0, deckY(-1.65, 0) + 0.012, -1.65]], 0xfacc15, 0.0035));
  g.add(rope([[0, deckY(-1.65, 0) + 0.012, -1.65], [0, deckY(-1.12, 0) + 0.018, -1.12]], 0x4ade80, 0.0035));

  // センターケース後端(z=0.10)のメインシートラチェットブロック & カムクリート
  const msc = camCleat(1.0); msc.position.set(0, FLOOR_Y + 0.11, 0.10); g.add(msc);
  const tb = block(0.022); tb.position.set(0, FLOOR_Y + 0.15, 0.10); g.add(tb);

  // コンソール周りのコントロールライン
  const tail = (sx, z0, color) => {
    const pts = []; for (let i = 0; i < 6; i++) pts.push(new THREE.Vector3(sx * (0.18 + i * 0.025), deckY(z0, sx * 0.2) + 0.01 + (i % 2) * 0.004, z0 + i * 0.055 + Math.sin(i * 1.7) * 0.02));
    g.add(rope(pts, color, 0.004));
  };
  tail(-1, -0.48, 0xf472b6); tail(1, -0.48, 0xfacc15); tail(-0.5, -0.52, 0x4ade80); tail(0.5, -0.50, 0x38bdf8);

  // 全静的メッシュを (material, renderOrder) ごとに単一 BufferGeometry に統合してドローコールを約80%削減
  g.updateMatrixWorld(true);
  const buckets = new Map();
  const vTmp = new THREE.Vector3();
  const nMat = new THREE.Matrix3();
  g.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const mat = obj.material;
    const order = obj.renderOrder || 0;
    let bucket = buckets.get(mat);
    if (!bucket) { bucket = new Map(); buckets.set(mat, bucket); }
    let list = bucket.get(order);
    if (!list) { list = { pos: [], norm: [], uv: [], idx: [], vOffset: 0 }; bucket.set(order, list); }

    const geo = obj.geometry;
    const posAttr = geo.attributes.position;
    if (!posAttr) return;
    const normAttr = geo.attributes.normal;
    const uvAttr = geo.attributes.uv;
    const mw = obj.matrixWorld;
    nMat.getNormalMatrix(mw);

    for (let i = 0; i < posAttr.count; i++) {
      vTmp.fromBufferAttribute(posAttr, i).applyMatrix4(mw);
      list.pos.push(vTmp.x, vTmp.y, vTmp.z);
      if (normAttr) {
        vTmp.fromBufferAttribute(normAttr, i).applyMatrix3(nMat).normalize();
        list.norm.push(vTmp.x, vTmp.y, vTmp.z);
      } else {
        list.norm.push(0, 1, 0);
      }
      if (uvAttr) {
        list.uv.push(uvAttr.getX(i), uvAttr.getY(i));
      } else {
        list.uv.push(0, 0);
      }
    }
    if (geo.index) {
      const idxArr = geo.index.array;
      for (let i = 0; i < idxArr.length; i++) list.idx.push(list.vOffset + idxArr[i]);
    } else {
      for (let i = 0; i < posAttr.count; i++) list.idx.push(list.vOffset + i);
    }
    list.vOffset += posAttr.count;
  });

  const parts = [];
  for (const [mat, bucket] of buckets.entries()) {
    for (const [order, list] of bucket.entries()) {
      const merged = new THREE.BufferGeometry();
      merged.setAttribute('position', new THREE.Float32BufferAttribute(list.pos, 3));
      merged.setAttribute('normal', new THREE.Float32BufferAttribute(list.norm, 3));
      merged.setAttribute('uv', new THREE.Float32BufferAttribute(list.uv, 2));
      merged.setIndex(list.idx);
      parts.push({ geo: merged, mat, order });
    }
  }
  _cachedStaticHullParts = parts;
  return parts;
}

const _stopperMat = new THREE.MeshStandardMaterial({ color: 0xc25e28, roughness: 0.48, metalness: 0.05 });
let _cachedCbGeos = null;

export function buildHull(accent = 0x2a77ff) {
  const g = new THREE.Group();
  const staticParts = buildStaticHullParts();
  for (let i = 0; i < staticParts.length; i++) {
    const p = staticParts[i];
    const m = new THREE.Mesh(p.geo, p.mat);
    m.renderOrder = p.order;
    g.add(m);
  }

  // 動的に上下するダガーボード(センターボード)本体のみ個別Groupとして追加
  const tz0 = -0.54, tz1 = 0.02, th = 0.18, tzMid = (tz0 + tz1) * 0.5;
  const cbTopBaseY = FLOOR_Y + th;
  if (!_cachedCbGeos) {
    _cachedCbGeos = {
      plate: new THREE.BoxGeometry(0.016, 0.34, 0.41),
      pillar: new THREE.BoxGeometry(0.016, 0.068, 0.064),
      topBar: new THREE.BoxGeometry(0.018, 0.032, 0.41),
      stopF: new THREE.BoxGeometry(0.050, 0.030, 0.054),
      stopR: new THREE.BoxGeometry(0.048, 0.028, 0.050),
    };
  }
  const cbBoard = new THREE.Group();
  cbBoard.add(mesh(_cachedCbGeos.plate, M.alu, 0, cbTopBaseY - 0.155, tzMid));
  cbBoard.add(mesh(_cachedCbGeos.pillar, M.alu, 0, cbTopBaseY + 0.048, tzMid - 0.172));
  cbBoard.add(mesh(_cachedCbGeos.pillar, M.alu, 0, cbTopBaseY + 0.048, tzMid + 0.172));
  cbBoard.add(mesh(_cachedCbGeos.topBar, M.alu, 0, cbTopBaseY + 0.092, tzMid));
  cbBoard.add(mesh(_cachedCbGeos.stopF, _stopperMat, 0, cbTopBaseY + 0.092, tzMid - 0.175));
  cbBoard.add(mesh(_cachedCbGeos.stopR, _stopperMat, 0, cbTopBaseY + 0.092, tzMid + 0.175));
  g.userData.cbBoard = cbBoard;
  g.add(cbBoard);
  return g;
}

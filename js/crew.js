// クルー(人間 / オリジナル動物キャラ)のモデル生成
import * as THREE from 'three';

export const CREW_TYPES = [
  { id: 'human_m', label: '男性', icon: '👨' },
  { id: 'human_f', label: '女性', icon: '👩' },
  { id: 'cat', label: 'ネコ', icon: '🐱' },
];

// assets/crew/manifest.json から読み込んだ差し替えモデル
export const customModels = new Map();
export async function loadCustomCrew() {
  try {
    const res = await fetch('assets/crew/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const list = await res.json();
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const out = [];
    for (const it of list.models || []) {
      try {
        const gltf = await loader.loadAsync('assets/crew/' + it.file);
        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        const h = box.max.y - box.min.y || 1;
        const s = (it.height || 0.95) / h;
        root.scale.setScalar(s);
        root.position.y -= box.min.y * s;
        const wrap = new THREE.Group(); wrap.add(root);
        customModels.set('custom:' + it.file, wrap);
        out.push({ id: 'custom:' + it.file, label: it.name || it.file, icon: '📦' });
      } catch (e) { console.warn('custom crew load failed', it, e); }
    }
    return out;
  } catch (e) { return []; }
}

const matCache = new Map();
const mat = (c) => { let m = matCache.get(c); if (!m) { m = new THREE.MeshLambertMaterial({ color: c }); matCache.set(c, m); } return m; };
const geoCache = new Map();
const sphereG = new THREE.SphereGeometry(1, 18, 14);
const capG = (r, l) => { const k = r + '_' + l; let g = geoCache.get(k); if (!g) { g = new THREE.CapsuleGeometry(r, l, 4, 10); geoCache.set(k, g); } return g; };
const coneG = new THREE.ConeGeometry(1, 1, 12);
const cylG = new THREE.CylinderGeometry(1, 1, 1, 18);

function sph(parent, color, sx, sy, sz, x, y, z) {
  const m = new THREE.Mesh(sphereG, mat(color)); m.scale.set(sx, sy, sz); m.position.set(x, y, z); parent.add(m); return m;
}
function cap(parent, color, r, l, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(capG(r, l), mat(color)); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); parent.add(m); return m;
}
function cone(parent, color, r, h, x, y, z, rx = 0, rz = 0) {
  const m = new THREE.Mesh(coneG, mat(color)); m.scale.set(r, h, r); m.position.set(x, y, z); m.rotation.set(rx, 0, rz); parent.add(m); return m;
}

// ---- リアルな人間(ウェットスーツ + PFD + グローブ + ブーツ + キャップ + サングラス) ----
const smatCache = new Map();
const smat = (c, r = 0.8, m = 0) => { const k = c + '_' + r + '_' + m; let x = smatCache.get(k); if (!x) { x = new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m }); smatCache.set(k, x); } return x; };
function limb(parent, material, r, a, b, taper = 1) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), len = d.length();
  const m = new THREE.Mesh(capG(r, Math.max(0.01, len - 2 * r)), material);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  m.scale.set(1, 1, taper); parent.add(m); return m;
}
function ell(parent, material, sx, sy, sz, x, y, z) { const m = new THREE.Mesh(sphereG, material); m.scale.set(sx, sy, sz); m.position.set(x, y, z); parent.add(m); return m; }
const HAIR = [0x1d1510, 0x2b1d13, 0x3b2a1c, 0x14110f, 0x5a3f28];
function buildHuman(g, style, jacket, isFemale = false) {
  const skin = style.skin ?? (isFemale ? 0xf4cab0 : 0xe9b98f);
  const hat = style.hat ?? (isFemale ? 0xf8fafc : 0x1b2338);
  const top = style.shirt ?? (isFemale ? 0x0ea5e9 : 0x2b6cff);
  const hairC = style.hair ?? (isFemale ? 0x2c1d14 : HAIR[Math.abs(((skin * 7) ^ (hat * 3)) % HAIR.length)]);
  const suit = smat(0x1f242b, 0.65), top_ = smat(top, 0.68), skinM = smat(skin, 0.5, 0.02);
  const pfd = smat(0x161920, 0.78), pfdSub = smat(0x252a34, 0.72), accent = smat(jacket, 0.55);
  const glove = smat(0x1c2026, 0.75), gloveGrip = smat(0x374151, 0.88), boot = smat(0x15181e, 0.85), sole = smat(0xf1f5f9, 0.75), pad = smat(0x2d333d, 0.88);
  const lipColor = isFemale ? 0xd9777f : new THREE.Color(skin).multiplyScalar(0.82).getHex();
  const lip = smat(lipColor, 0.42), hairM = smat(hairC, 0.85);
  const eyeW = smat(0xf8fafc, 0.3), iris = smat(0x291d12, 0.2);
  const frameM = smat(0x111318, 0.3, 0.2), lensM = smat(0x0f172a, 0.08, 0.78);

  const shScale = isFemale ? 0.88 : 1.0;

  // 1) 骨盤・下半身 (サイドデッキに座り、太ももが船内へ伸びて膝から下がコクピット床へ降りるリアルなヨット座位姿勢)
  ell(g, suit, 0.138 * (isFemale ? 0.96 : 1), 0.088, 0.106, 0, 0.055, 0.01);
  for (const s of [-1, 1]) {
    const legS = isFemale ? 0.93 : 1.0;
    const hip = [s * 0.086 * shScale, 0.055, 0.01];
    const midThigh = [s * 0.095 * shScale, 0.052, -0.15];
    const knee = [s * 0.100 * shScale, 0.042, -0.30];
    const midCalf = [s * 0.094 * shScale, -0.085, -0.355];
    const ank = [s * 0.088 * shScale, -0.210, -0.395];
    // 太もも (サイドデッキ上からコーミング縁へ)
    limb(g, suit, 0.072 * legS, hip, midThigh, 0.94);
    limb(g, suit, 0.060 * legS, midThigh, knee, 0.94);
    // 膝関節 & ハイキングニーパッド
    ell(g, pad, 0.055 * legS, 0.054 * legS, 0.060 * legS, knee[0], knee[1] + 0.008, knee[2] - 0.010);
    // すね・ふくらはぎ (膝からコクピット内へ下向きに曲がる)
    limb(g, suit, 0.052 * legS, knee, midCalf, 0.94);
    limb(g, suit, 0.041 * legS, midCalf, ank, 0.94);
    // ディンギーブーツ (コクピット内のハイクアウトストラップ下に足先を入れる形)
    limb(g, boot, 0.044 * legS, [ank[0], ank[1] + 0.035, ank[2]], [ank[0], ank[1] - 0.020, ank[2] - 0.095]);
    const so = new THREE.Mesh(new THREE.BoxGeometry(0.080 * legS, 0.015, 0.19), sole);
    so.position.set(ank[0], ank[1] - 0.036, ank[2] - 0.038);
    so.rotation.x = 0.08;
    g.add(so);
  }

  // 2) 上半身グループ (腰を軸にハイクアウトで外へ反り、タック時はブームの下をくぐる)
  const upper = new THREE.Group();
  upper.position.set(0, 0.08, 0.01);
  g.add(upper);
  g.userData.upper = upper;

  // 腰〜腹〜胸郭〜肩の自然な人体ライン
  limb(upper, suit, 0.104 * shScale, [0, 0.01, -0.005], [0, 0.19, -0.01], 0.76);
  limb(upper, top_, 0.118 * shScale, [0, 0.16, -0.01], [0, 0.45, -0.005], 0.72);
  ell(upper, top_, 0.178 * shScale, 0.122, 0.098, 0, 0.44, -0.005); // 胸郭・肩ライン
  if (isFemale) {
    ell(upper, top_, 0.112, 0.068, 0.072, 0, 0.39, -0.042);
  }
  for (const s of [-1, 1]) {
    const tr = ell(upper, top_, 0.072 * shScale, 0.038, 0.062, s * 0.090 * shScale, 0.535, 0.0);
    tr.rotation.z = s * 0.30;
  }

  // 3) レーシングPFD (身体に沿う丸みのあるスリムライフジャケット)
  const pw = 0.268 * shScale;
  ell(upper, pfd, pw * 0.52, 0.135, 0.098, 0, 0.365, -0.012);
  const pfdFront = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.88, 0.23, 0.034), pfd);
  pfdFront.position.set(0, 0.365, -0.086); pfdFront.rotation.x = 0.04; upper.add(pfdFront);
  const pfdBack = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.90, 0.24, 0.032), pfd);
  pfdBack.position.set(0, 0.375, 0.078); pfdBack.rotation.x = -0.04; upper.add(pfdBack);
  for (const s of [-1, 1]) {
    const sideP = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.195, 0.165), pfdSub);
    sideP.position.set(s * 0.130 * shScale, 0.355, -0.004); upper.add(sideP);
    const shStrap = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.065, 0.168), pfd);
    shStrap.position.set(s * 0.096 * shScale, 0.525, -0.004); upper.add(shStrap);
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.025, 0.036), smat(0x94a3b8, 0.35, 0.6));
    buckle.position.set(s * 0.144 * shScale, 0.305, -0.02); upper.add(buckle);
  }
  const pocket = new THREE.Mesh(new THREE.BoxGeometry(0.16 * shScale, 0.098, 0.014), pfdSub);
  pocket.position.set(0, 0.335, -0.105); pocket.rotation.x = 0.04; upper.add(pocket);
  const accBand = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.86, 0.028, 0.012), accent);
  accBand.position.set(0, 0.445, -0.103); accBand.rotation.x = 0.04; upper.add(accBand);
  const backBand = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.86, 0.028, 0.010), accent);
  backBand.position.set(0, 0.455, 0.094); backBand.rotation.x = -0.04; upper.add(backBand);
  const waistBelt = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.94, 0.022, 0.178), smat(0x111318, 0.9));
  waistBelt.position.set(0, 0.270, -0.004); upper.add(waistBelt);

  // 4) 腕・前腕・グローブ (シートやティラーを自然に構える非対称のリアルな腕角度)
  for (const s of [-1, 1]) {
    const sh = [s * 0.182 * shScale, 0.475, -0.005];
    const el = [s * 0.202 * shScale, 0.295, -0.085];
    const wr = [s * 0.115, 0.255 + (s > 0 ? 0.02 : 0), -0.255];
    const ha = [s * 0.095, 0.250 + (s > 0 ? 0.02 : 0), -0.295];
    ell(upper, top_, 0.052 * shScale, 0.056 * shScale, 0.052 * shScale, sh[0], sh[1], sh[2]);
    limb(upper, top_, 0.042 * shScale, sh, el);
    ell(upper, skinM, 0.036 * shScale, 0.036 * shScale, 0.036 * shScale, el[0], el[1], el[2]);
    limb(upper, skinM, 0.032 * shScale, el, wr);
    if (s === -1) {
      const watch = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.030, 0.016, 12), frameM);
      watch.position.set(wr[0], wr[1], wr[2] + 0.018); watch.rotation.x = Math.PI / 2; upper.add(watch);
    }
    ell(upper, glove, 0.027, 0.021, 0.036, ha[0], ha[1], ha[2]);
    ell(upper, gloveGrip, 0.025, 0.016, 0.032, ha[0], ha[1] - 0.007, ha[2] - 0.004);
    for (let f = 0; f < 4; f++) {
      limb(upper, glove, 0.0075, [ha[0] + (f - 1.5) * 0.011, ha[1] + 0.005, ha[2] - 0.026], [ha[0] + (f - 1.5) * 0.010, ha[1] - 0.014, ha[2] - 0.040]);
    }
    limb(upper, glove, 0.0085, [ha[0] - s * 0.021, ha[1] + 0.004, ha[2] - 0.006], [ha[0] - s * 0.014, ha[1] + 0.010, ha[2] - 0.035]);
  }

  // 5) 首・頭部 (進行方向・セール側へ自然に顔を向けられるよう独立グループ化)
  limb(upper, skinM, isFemale ? 0.036 : 0.041, [0, 0.525, -0.005], [0, 0.640, -0.014], 0.92);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.046 * shScale, 0.052 * shScale, 0.030, 18), top_);
  collar.position.set(0, 0.558, -0.006); upper.add(collar);

  const head = new THREE.Group();
  head.position.set(0, 0.710, -0.018);
  upper.add(head);
  g.userData.head = head;

  ell(head, skinM, isFemale ? 0.072 : 0.075, 0.090, 0.084, 0, 0.012, 0.002);
  ell(head, skinM, isFemale ? 0.058 : 0.063, 0.055, 0.068, 0, -0.035, -0.018);
  ell(head, skinM, isFemale ? 0.030 : 0.035, 0.025, 0.038, 0, -0.065, -0.040);
  limb(head, skinM, 0.009, [0, 0.010, -0.077], [0, -0.022, -0.090], 0.85);
  ell(head, skinM, 0.012, 0.009, 0.010, 0, -0.025, -0.087);
  ell(head, lip, 0.018, 0.0055, 0.008, 0, -0.048, -0.077);
  for (const s of [-1, 1]) {
    const ear = ell(head, skinM, 0.011, 0.023, 0.015, s * (isFemale ? 0.072 : 0.075), -0.006, 0.002);
    ear.rotation.y = s * 0.25;
    ell(head, eyeW, 0.012, 0.007, 0.006, s * 0.026, 0.012, -0.075);
    ell(head, iris, 0.006, 0.006, 0.004, s * 0.026, 0.012, -0.079);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.0036, 0.006), hairM);
    brow.position.set(s * 0.026, 0.024, -0.077); brow.rotation.z = -s * 0.06; head.add(brow);
  }
  ell(head, hairM, 0.077, 0.066, 0.084, 0, 0.014, 0.014);
  ell(head, hairM, 0.062, 0.040, 0.044, 0, -0.030, 0.050);
  for (const s of [-1, 1]) {
    ell(head, hairM, 0.014, isFemale ? 0.050 : 0.030, 0.026, s * 0.068, isFemale ? -0.008 : 0.008, -0.015);
  }
  if (isFemale) {
    ell(head, smat(0xec4899, 0.5), 0.017, 0.017, 0.015, 0, -0.005, 0.084);
    limb(head, hairM, 0.025, [0, -0.008, 0.090], [0, -0.072, 0.132], 0.85);
    limb(head, hairM, 0.018, [0, -0.068, 0.128], [0, -0.130, 0.115], 0.75);
  }

  // 偏光スポーツサングラス
  const topBar = new THREE.Mesh(new THREE.BoxGeometry(0.120, 0.005, 0.011), frameM);
  topBar.position.set(0, 0.024, -0.078); head.add(topBar);
  for (const s of [-1, 1]) {
    const lns = ell(head, lensM, 0.026, 0.015, 0.010, s * 0.029, 0.011, -0.078);
    lns.rotation.y = s * 0.22; lns.rotation.z = -s * 0.05;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.006, 0.078), frameM);
    arm.position.set(s * 0.070, 0.016, -0.036); arm.rotation.y = s * 0.08; head.add(arm);
  }

  // セーリングキャップ
  const capMat = smat(hat, 0.78);
  const crown = new THREE.Mesh(new THREE.SphereGeometry(0.081, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.54), capMat);
  crown.scale.set(0.97, 0.92, 1.06); crown.position.set(0, 0.025, 0.003); crown.rotation.x = -0.06; head.add(crown);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.006, 20, 1, false, -Math.PI * 0.52, Math.PI * 1.04), capMat);
  brim.rotation.y = Math.PI; brim.rotation.x = -0.16; brim.scale.set(1.02, 1, 1.12);
  brim.position.set(0, 0.033, -0.093); head.add(brim);
  ell(head, capMat, 0.009, 0.005, 0.009, 0, 0.100, 0.008);

  if (isFemale) g.scale.setScalar(0.95);
  return g;
}

const ANIMAL = {
  cat: { body: 0xf0a24a, belly: 0xfff0dc, nose: 0xff8fa3 },
  shiba: { body: 0xd9954a, belly: 0xfff4e6, nose: 0x222222 },
  penguin: { body: 0x27323d, belly: 0xffffff, nose: 0xff9f1c },
  bear: { body: 0x8b5a3c, belly: 0xd8b48c, nose: 0x1a1a1a },
  rabbit: { body: 0xf6f1ee, belly: 0xffffff, nose: 0xff8fa3 },
  capybara: { body: 0xa87a4b, belly: 0xc29866, nose: 0x3a2a1a },
};

// ネコ用 Gill ライフジャケット前面テクスチャ (赤いボディ・白Gillロゴ・ポケットファスナー・斜めシーム)
let gillPfdTex = null;
function getGillPfdTex() {
  if (gillPfdTex) return gillPfdTex;
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  // ベース赤 (#d8261c)
  ctx.fillStyle = '#d8261c';
  ctx.fillRect(0, 0, 256, 256);
  // 首元のU字カット内側の黒裏地
  ctx.fillStyle = '#181b20';
  ctx.beginPath();
  ctx.arc(128, 12, 54, 0, Math.PI);
  ctx.fill();
  // 胸中央の白い「Gill」ロゴ
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Gill', 128, 98);
  // Gillロゴの「i」上の特徴的なドットアクセント
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(122, 69, 3.5, 0, Math.PI * 2);
  ctx.fill();
  // フロントポケットの角丸輪郭 & 上部黒ファスナーライン
  const px = 48, py = 116, pw = 160, ph = 92, pr = 18;
  ctx.strokeStyle = '#99150e';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.roundRect(px, py, pw, ph, pr);
  ctx.stroke();
  // ポケット上部の黒ジッパーライン
  ctx.strokeStyle = '#1b1e24';
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.moveTo(px + 12, py + 4);
  ctx.lineTo(px + pw - 12, py + 4);
  ctx.stroke();
  // ポケット右上の小さな黒ピスタグ
  ctx.fillStyle = '#181b20';
  ctx.fillRect(px + pw - 36, py + 5, 22, 9);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 7px Arial';
  ctx.fillText('Gill', px + pw - 25, py + 12);
  // ポケット下端から左右斜め下へ伸びるシームライン
  ctx.strokeStyle = '#99150e';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(px + 28, py + ph);
  ctx.lineTo(18, 245);
  ctx.moveTo(px + pw - 28, py + ph);
  ctx.lineTo(238, 245);
  ctx.stroke();
  // 下端の黒いウェビングベルト
  ctx.fillStyle = '#161920';
  ctx.fillRect(0, 222, 256, 26);

  gillPfdTex = new THREE.CanvasTexture(c);
  gillPfdTex.colorSpace = THREE.SRGBColorSpace;
  return gillPfdTex;
}

// 座位の原点=お尻。前方 -z、上 +y。全高 約0.95m
export function buildFigure(type, style = {}) {
  if (customModels.has(type)) return customModels.get(type).clone(true);
  const g = new THREE.Group();
  const jacket = style.jacket ?? 0xff7a1a;
  if (type === 'human' || type === 'human_m' || type === 'human_f' || !ANIMAL[type]) {
    return buildHuman(g, style, jacket, type === 'human_f');
  }
  const A = ANIMAL[type];
  const bodyM = smat(A.body, 0.72);
  const bellyM = smat(A.belly, 0.75);

  // 1) 下半身・脚 (サイドデッキに座り、膝を曲げてコクピット床のハイクベルト下に足先を引っ掛ける姿勢)
  ell(g, bodyM, 0.17, 0.11, 0.14, 0, 0.06, 0.01);
  for (const s of [-1, 1]) {
    const hip = [s * 0.085, 0.055, 0.01];
    const knee = [s * 0.092, 0.040, -0.26];
    const ank = [s * 0.084, -0.185, -0.37];
    // 太もも (サイドデッキから船内方向へ)
    limb(g, bodyM, 0.052, hip, knee, 0.95);
    // すね (膝からコクピット内のハイクベルトへ向けて下ろす)
    limb(g, bodyM, 0.042, knee, ank, 0.92);
    // 足先・肉球 (コクピット床のハイクアウトベルトの下にしっかり足をかける)
    ell(g, bellyM, 0.045, 0.032, 0.068, ank[0], ank[1] - 0.012, ank[2] - 0.035);
  }

  // 2) 上半身グループ (風速に応じて腰から上を海側へ反らせてハイクアウトする)
  const upper = new THREE.Group();
  upper.position.set(0, 0.08, 0.01);
  g.add(upper);
  g.userData.upper = upper;

  sph(upper, A.body, 0.22, 0.25, 0.19, 0, 0.23, -0.01);
  sph(upper, A.belly, 0.14, 0.16, 0.08, 0, 0.23, -0.15);

  if (type === 'cat') {
    // 画像の Gill 赤ライフジャケット(PFD)を忠実に再現:
    // 深いU字ネック＆黒インナー・黒い肩パッドストラップ・胸の白「Gill」ロゴ・角丸フロントポケット・下部黒ベルト＆バックル
    const gillRed = smat(0xd8261c, 0.62);
    const gillDark = smat(0x181b20, 0.82);
    const gillPocketRed = smat(0xc81e14, 0.68);
    const gillFrontMat = new THREE.MeshStandardMaterial({ map: getGillPfdTex(), roughness: 0.58, metalness: 0.02 });

    // 赤いPFD本体(胴回り)
    ell(upper, gillRed, 0.236, 0.195, 0.195, 0, 0.245, -0.005);
    // 首元の黒いインナーライニング
    ell(upper, gillDark, 0.135, 0.075, 0.125, 0, 0.375, -0.035);
    // 前面パネル (Gillロゴ・ポケット・ベルト描画テクスチャ付き曲面)
    const frontPanel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.215, 0.228, 0.31, 24, 1, true, -Math.PI * 0.32, Math.PI * 0.64),
      gillFrontMat
    );
    frontPanel.rotation.y = Math.PI;
    frontPanel.scale.set(1.06, 1, 0.88);
    frontPanel.position.set(0, 0.245, -0.012);
    upper.add(frontPanel);

    // 立体感のあるフロント角丸ポケットの膨らみ & 上部黒ジッパー
    const pocket3D = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.115, 0.028), gillPocketRed);
    pocket3D.position.set(0, 0.215, -0.195);
    pocket3D.rotation.x = 0.05;
    upper.add(pocket3D);
    const zipLine = new THREE.Mesh(new THREE.BoxGeometry(0.195, 0.012, 0.032), gillDark);
    zipLine.position.set(0, 0.270, -0.193);
    upper.add(zipLine);

    // 左右の黒いパッド入りショルダーストラップ + 赤いチェストパネル上部
    for (const s of [-1, 1]) {
      const redShoulder = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.095, 0.13), gillRed);
      redShoulder.position.set(s * 0.118, 0.375, -0.045);
      redShoulder.rotation.z = -s * 0.12;
      upper.add(redShoulder);

      const blkStrap = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.058, 0.145), gillDark);
      blkStrap.position.set(s * 0.115, 0.428, -0.015);
      blkStrap.rotation.z = -s * 0.10;
      upper.add(blkStrap);
    }

    // 下部の黒いウェビングベルト & 左寄り(向かって左)の黒バックルとベルトループ
    const waistBelt = new THREE.Mesh(cylG, gillDark);
    waistBelt.scale.set(0.242, 0.034, 0.204);
    waistBelt.position.set(0, 0.128, -0.008);
    upper.add(waistBelt);

    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.044, 0.024), smat(0x111318, 0.4, 0.2));
    buckle.position.set(-0.055, 0.128, -0.205);
    upper.add(buckle);
    const keeper = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.046, 0.026), gillDark);
    keeper.position.set(-0.105, 0.128, -0.192);
    upper.add(keeper);
  } else {
    const band = new THREE.Mesh(cylG, mat(jacket)); band.scale.set(0.235, 0.1, 0.215); band.position.set(0, 0.24, 0); upper.add(band);
  }

  const head = new THREE.Group(); head.position.set(0, 0.61, -0.02); upper.add(head);
  g.userData.head = head;
  const hs = type === 'capybara' ? [0.22, 0.2, 0.26] : [0.24, 0.21, 0.22];
  sph(head, A.body, hs[0], hs[1], hs[2], 0, 0, 0);
  // 目
  sph(head, 0x111111, 0.034, 0.045, 0.02, -0.09, 0.02, -hs[2] + 0.01);
  sph(head, 0x111111, 0.034, 0.045, 0.02, 0.09, 0.02, -hs[2] + 0.01);
  sph(head, 0xffffff, 0.011, 0.014, 0.01, -0.082, 0.04, -hs[2] - 0.005);
  sph(head, 0xffffff, 0.011, 0.014, 0.01, 0.098, 0.04, -hs[2] - 0.005);
  if (type !== 'penguin') sph(head, A.nose, 0.032, 0.024, 0.026, 0, -0.04, -hs[2] - 0.005);
  sph(head, 0xff9db0, 0.04, 0.025, 0.01, -0.15, -0.03, -hs[2] + 0.06); // ほっぺ
  sph(head, 0xff9db0, 0.04, 0.025, 0.01, 0.15, -0.03, -hs[2] + 0.06);
  // 前足(腕): 上半身に追従してシートを構えるポーズ
  cap(upper, A.body, 0.048, 0.14, -0.22, 0.28, -0.13, Math.PI / 2.3, 0, -0.45);
  cap(upper, A.body, 0.048, 0.14, 0.22, 0.28, -0.13, Math.PI / 2.3, 0, 0.45);
  switch (type) {
    case 'cat':
      cone(head, A.body, 0.07, 0.14, -0.14, 0.2, 0, 0, 0.35); cone(head, A.body, 0.07, 0.14, 0.14, 0.2, 0, 0, -0.35);
      cone(head, 0xff8fa3, 0.04, 0.09, -0.14, 0.19, -0.03, 0, 0.35); cone(head, 0xff8fa3, 0.04, 0.09, 0.14, 0.19, -0.03, 0, -0.35);
      cap(upper, A.body, 0.032, 0.09, 0.0, 0.14, 0.21, 0.85, 0, 0);
      g.scale.setScalar(0.90); // ネコは人間より少しだけ小さめのほどよいサイズ感に調整
      break;
    case 'shiba':
      cone(head, A.body, 0.075, 0.13, -0.14, 0.19, 0, 0, 0.3); cone(head, A.body, 0.075, 0.13, 0.14, 0.19, 0, 0, -0.3);
      sph(head, A.belly, 0.12, 0.09, 0.09, 0, -0.07, -hs[2] + 0.07);
      sph(head, 0xfff4e6, 0.03, 0.02, 0.01, -0.09, 0.09, -hs[2] + 0.01);
      sph(head, 0xfff4e6, 0.03, 0.02, 0.01, 0.09, 0.09, -hs[2] + 0.01);
      sph(upper, A.body, 0.12, 0.12, 0.12, 0, 0.34, 0.26);
      break;
    case 'penguin': {
      cone(head, A.nose, 0.04, 0.09, 0, -0.02, -hs[2] - 0.03, -Math.PI / 2, 0);
      sph(head, A.belly, 0.17, 0.15, 0.1, 0, -0.02, -hs[2] + 0.07);
      cap(upper, A.body, 0.04, 0.2, -0.27, 0.26, -0.02, 0, 0, 0.5);
      cap(upper, A.body, 0.04, 0.2, 0.27, 0.26, -0.02, 0, 0, -0.5);
      break;
    }
    case 'bear':
      sph(head, A.body, 0.07, 0.07, 0.05, -0.17, 0.17, 0); sph(head, A.body, 0.07, 0.07, 0.05, 0.17, 0.17, 0);
      sph(head, A.belly, 0.1, 0.08, 0.08, 0, -0.05, -hs[2] + 0.08);
      sph(upper, A.body, 0.07, 0.07, 0.07, 0, 0.12, 0.25);
      break;
    case 'rabbit':
      cap(head, A.body, 0.05, 0.28, -0.08, 0.34, 0.02, -0.1, 0, 0.12);
      cap(head, A.body, 0.05, 0.28, 0.08, 0.34, 0.02, -0.1, 0, -0.12);
      cap(head, 0xffb7c5, 0.025, 0.22, -0.08, 0.34, -0.02, -0.1, 0, 0.12);
      cap(head, 0xffb7c5, 0.025, 0.22, 0.08, 0.34, -0.02, -0.1, 0, -0.12);
      sph(upper, 0xffffff, 0.09, 0.09, 0.09, 0, 0.14, 0.24);
      break;
    case 'capybara':
      sph(head, A.body, 0.14, 0.12, 0.14, 0, -0.04, -hs[2] + 0.1);
      sph(head, A.nose, 0.05, 0.035, 0.03, 0, -0.01, -hs[2] - 0.05);
      sph(head, A.body, 0.045, 0.045, 0.03, -0.14, 0.15, 0.03); sph(head, A.body, 0.045, 0.045, 0.03, 0.14, 0.15, 0.03);
      break;
  }
  return g;
}

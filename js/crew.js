// クルー(人間 / オリジナル動物キャラ)のモデル生成
import * as THREE from 'three';

export const CREW_TYPES = [
  { id: 'human_m', label: '男性', icon: '' },
  { id: 'human_f', label: '女性', icon: '' },
  { id: 'cat', label: 'ネコ', icon: '' },
  { id: 'dog', label: 'イヌ', icon: '' },
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
        out.push({ id: 'custom:' + it.file, label: it.name || it.file, icon: '' });
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
  const rawSkin = style.skin ?? (isFemale ? 0xd68e66 : 0xcf855c);
  const skinCol = new THREE.Color(rawSkin);
  // 強い屋外太陽光の下で白飛びして真っ白に見えないよう、健康的な暖かみのある肌色トーンに補正
  if (skinCol.r > 0.80 && skinCol.g > 0.70) {
    skinCol.setHex(isFemale ? 0xd68e66 : 0xcf855c);
  }
  const skin = skinCol.getHex();
  const hat = style.hat ?? (isFemale ? 0xf8fafc : 0x1b2338);
  const hairC = style.hair ?? (isFemale ? 0x2c1d14 : HAIR[Math.abs(((skin * 7) ^ (hat * 3)) % HAIR.length)]);
  // インナーは黒いウェットスーツ/ラッシュガード、その上に鮮やかなビブス(プレイヤー=青、CP=黒・白・赤など)を着用
  const suit = smat(0x1b1f26, 0.68), top_ = smat(0x1e232b, 0.70), skinM = smat(skin, 0.82, 0.0);
  const bibCol = new THREE.Color(jacket);
  const isLightBib = (bibCol.r * 0.3 + bibCol.g * 0.59 + bibCol.b * 0.11) > 0.72;
  const pfd = smat(jacket, 0.56);
  const pfdSub = smat(bibCol.clone().multiplyScalar(isLightBib ? 0.86 : 0.78).getHex(), 0.64);
  const bibPanelMat = new THREE.MeshStandardMaterial({ map: getBibTex(jacket), roughness: 0.54, metalness: 0.02 });
  const glove = smat(0x1c2026, 0.75), gloveGrip = smat(0x374151, 0.88), boot = smat(0x15181e, 0.85), sole = smat(0xf1f5f9, 0.75), pad = smat(0x2d333d, 0.88);
  const lipColor = isFemale ? 0xc8646c : new THREE.Color(skin).multiplyScalar(0.78).getHex();
  const lip = smat(lipColor, 0.55), hairM = smat(hairC, 0.85);
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

  // 3) レーシングビブス & PFD (参考画像準拠: 黒ウェットの上に着用するビブス、胸・背中にロゴ入り)
  const pw = 0.272 * shScale;
  ell(upper, pfd, pw * 0.53, 0.142, 0.100, 0, 0.365, -0.012);
  const pfdFront = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.90, 0.24, 0.036), bibPanelMat);
  pfdFront.position.set(0, 0.368, -0.088); pfdFront.rotation.x = 0.04; upper.add(pfdFront);
  const pfdBack = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.92, 0.245, 0.034), bibPanelMat);
  pfdBack.position.set(0, 0.375, 0.080); pfdBack.rotation.x = -0.04; upper.add(pfdBack);
  for (const s of [-1, 1]) {
    const sideP = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.205, 0.168), pfdSub);
    sideP.position.set(s * 0.131 * shScale, 0.358, -0.004); upper.add(sideP);
    const shStrap = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.072, 0.172), pfd);
    shStrap.position.set(s * 0.096 * shScale, 0.525, -0.004); upper.add(shStrap);
  }
  const waistBelt = new THREE.Mesh(new THREE.BoxGeometry(pw * 0.95, 0.020, 0.180), smat(0x111318, 0.85));
  waistBelt.position.set(0, 0.258, -0.004); upper.add(waistBelt);

  // 4) 腕・前腕・グローブ (シートやティラーを自然に構え、強風フルハイク時は外側の腕を伸ばせるよう肩ピボット化)
  for (const s of [-1, 1]) {
    const sh = [s * 0.182 * shScale, 0.475, -0.005];
    const armG = new THREE.Group();
    armG.position.set(sh[0], sh[1], sh[2]);
    upper.add(armG);
    if (s === -1) upper.userData.armL = armG;
    else upper.userData.armR = armG;

    const el = [s * 0.020 * shScale, -0.180, -0.080];
    const wr = [s * (-0.067 * shScale), -0.220 + (s > 0 ? 0.02 : 0), -0.250];
    const ha = [s * (-0.087 * shScale), -0.225 + (s > 0 ? 0.02 : 0), -0.290];
    ell(armG, top_, 0.052 * shScale, 0.056 * shScale, 0.052 * shScale, 0, 0, 0);
    limb(armG, top_, 0.042 * shScale, [0, 0, 0], el);
    ell(armG, skinM, 0.036 * shScale, 0.036 * shScale, 0.036 * shScale, el[0], el[1], el[2]);
    limb(armG, skinM, 0.032 * shScale, el, wr);
    if (s === -1) {
      const watch = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.030, 0.016, 12), frameM);
      watch.position.set(wr[0], wr[1], wr[2] + 0.018); watch.rotation.x = Math.PI / 2; armG.add(watch);
    }
    ell(armG, glove, 0.027, 0.021, 0.036, ha[0], ha[1], ha[2]);
    ell(armG, gloveGrip, 0.025, 0.016, 0.032, ha[0], ha[1] - 0.007, ha[2] - 0.004);
    for (let f = 0; f < 4; f++) {
      limb(armG, glove, 0.0075, [ha[0] + (f - 1.5) * 0.011, ha[1] + 0.005, ha[2] - 0.026], [ha[0] + (f - 1.5) * 0.010, ha[1] - 0.014, ha[2] - 0.040]);
    }
    limb(armG, glove, 0.0085, [ha[0] - s * 0.021, ha[1] + 0.004, ha[2] - 0.006], [ha[0] - s * 0.014, ha[1] + 0.010, ha[2] - 0.035]);
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
  dog: { body: 0xd98b3a, belly: 0xfff5e8, nose: 0x1e1b18 },
  shiba: { body: 0xd98b3a, belly: 0xfff5e8, nose: 0x1e1b18 },
  penguin: { body: 0x27323d, belly: 0xffffff, nose: 0xff9f1c },
  bear: { body: 0x8b5a3c, belly: 0xd8b48c, nose: 0x1a1a1a },
  rabbit: { body: 0xf6f1ee, belly: 0xffffff, nose: 0xff8fa3 },
  capybara: { body: 0xa87a4b, belly: 0xc29866, nose: 0x3a2a1a },
};

// 参考画像(青いzhikレーシングビブス)を忠実に再現したカラー別ビブステクスチャキャッシュ
const bibTexCache = new Map();
function getBibTex(colorHex = 0x0e52b8) {
  const key = colorHex >>> 0;
  if (bibTexCache.has(key)) return bibTexCache.get(key);
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const col = new THREE.Color(colorHex);
  const hexStr = '#' + col.getHexString();
  const lum = col.r * 0.3 + col.g * 0.59 + col.b * 0.11;
  const fg = lum > 0.70 ? '#111827' : '#ffffff';
  const seam = '#' + col.clone().multiplyScalar(lum > 0.70 ? 0.82 : 0.74).getHexString();

  // ベースカラー (プレイヤーは鮮やかなロイヤルブルー #0e52b8、CPは黒・白・赤など)
  ctx.fillStyle = hexStr;
  ctx.fillRect(0, 0, 256, 256);

  // 両脇の立体シェーディングとフラットロックステッチ線
  ctx.fillStyle = seam;
  ctx.fillRect(0, 0, 22, 256);
  ctx.fillRect(234, 0, 22, 256);
  ctx.strokeStyle = seam;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(32, 0); ctx.lineTo(26, 256);
  ctx.moveTo(224, 0); ctx.lineTo(230, 256);
  ctx.stroke();

  // 首元の丸首パイピング
  ctx.fillStyle = '#14181f';
  ctx.beginPath();
  ctx.arc(128, 8, 52, 0, Math.PI);
  ctx.fill();
  ctx.strokeStyle = seam;
  ctx.lineWidth = 5;
  ctx.stroke();

  // 胸上部のブランドロゴ (参考画像の「zhik」スタイル白ロゴ)
  ctx.fillStyle = fg;
  ctx.font = 'bold 28px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('zhik', 128, 92);

  // 胸中央のチームロゴボックス & 「Sailing Team」プリント (参考画像準拠)
  const bx = 68, by = 114, bw = 120, bh = 38;
  ctx.strokeStyle = fg;
  ctx.lineWidth = 2.8;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.font = '900 18px "Helvetica Neue", Arial, sans-serif';
  ctx.fillText('SNIPE', 128, by + 26);

  ctx.font = 'italic bold 20px Georgia, serif';
  ctx.fillText('Sailing Team', 128, 180);

  // 裾のパイピングライン
  ctx.fillStyle = seam;
  ctx.fillRect(0, 236, 256, 20);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  bibTexCache.set(key, tex);
  return tex;
}

// 座位の原点=お尻。前方 -z、上 +y。全高 約0.95m
export function buildFigure(type, style = {}) {
  if (customModels.has(type)) return customModels.get(type).clone(true);
  const g = new THREE.Group();
  const jacket = style.jacket ?? 0x0e52b8;
  if (type === 'human' || type === 'human_m' || type === 'human_f' || !ANIMAL[type]) {
    return buildHuman(g, style, jacket, type === 'human_f');
  }
  const A = ANIMAL[type];
  const bodyM = smat(A.body, 0.72);
  const bellyM = smat(A.belly, 0.75);

  const isRoundPet = type === 'cat' || type === 'dog' || type === 'shiba';
  g.userData.isRoundPet = isRoundPet;

  // 1) 上半身グループ (風速に応じて腰から上を海側へ反らせてハイクアウトする)
  const upper = new THREE.Group();
  upper.position.set(0, 0.08, 0.01);
  g.add(upper);
  g.userData.upper = upper;

  // 2) 下半身・まるっこい足:
  // ネコ・イヌ(isRoundPet)は強風ハイクアウト時に胴体と足が離れて足が長く見えないよう、
  // まるっこいお尻と球状の短いあんよを upper 下部に一体配置し、常に短い丸足の可愛いフォルムを保つ
  if (isRoundPet) {
    ell(upper, bodyM, 0.19, 0.10, 0.16, 0, 0.04, 0.0);
    for (const s of [-1, 1]) {
      sph(upper, A.body, 0.068, 0.058, 0.068, s * 0.105, 0.015, -0.130);
      sph(upper, A.belly, 0.052, 0.042, 0.035, s * 0.105, 0.012, -0.176);
      sph(upper, type === 'cat' ? 0xff8fa3 : 0x4a3525, 0.024, 0.020, 0.016, s * 0.105, 0.009, -0.196);
    }
  } else {
    ell(g, bodyM, 0.19, 0.11, 0.16, 0, 0.06, 0.01);
    for (const s of [-1, 1]) {
      cap(g, A.body, 0.048, 0.065, s * 0.095, 0.025, -0.10, 0.55, 0, 0);
      ell(g, bellyM, 0.044, 0.032, 0.052, s * 0.095, -0.015, -0.155);
    }
  }

  if (isRoundPet) {
    // ネコ・イヌはまるっこい胴体とおなか
    sph(upper, A.body, 0.255, 0.275, 0.235, 0, 0.23, 0.0);
    sph(upper, A.belly, 0.175, 0.19, 0.11, 0, 0.23, -0.155);
  } else {
    sph(upper, A.body, 0.22, 0.25, 0.19, 0, 0.23, -0.01);
    sph(upper, A.belly, 0.14, 0.16, 0.08, 0, 0.23, -0.15);
  }

  // 動物キャラクターも人間と同じレーシングビブス(自分が選んだキャラは青ビブス、CP艇は黒・白・赤など)を着用
  {
    const bibCol = new THREE.Color(jacket);
    const isLight = (bibCol.r * 0.3 + bibCol.g * 0.59 + bibCol.b * 0.11) > 0.72;
    const bibMain = smat(jacket, 0.56);
    const bibDark = smat(0x181b20, 0.82);
    const bibSub = smat(bibCol.clone().multiplyScalar(isLight ? 0.86 : 0.78).getHex(), 0.66);
    const bibFrontMat = new THREE.MeshStandardMaterial({ map: getBibTex(jacket), roughness: 0.54, metalness: 0.02 });
    const rScale = isRoundPet ? 1.0 : 0.88;

    // ビブス本体(胴回り)
    ell(upper, bibMain, 0.264 * rScale, 0.205, 0.232 * rScale, 0, 0.245, -0.005);
    // 首元の黒いインナーライニング
    ell(upper, bibDark, 0.148 * rScale, 0.078, 0.142 * rScale, 0, 0.382, -0.035);
    // 前面・背面パネル (zhik / Sailing Team ビブスロゴ描画テクスチャ付き曲面)
    const frontPanel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.242 * rScale, 0.255 * rScale, 0.315, 24, 1, true, -Math.PI * 0.32, Math.PI * 0.64),
      bibFrontMat
    );
    frontPanel.rotation.y = Math.PI;
    frontPanel.scale.set(1.06, 1, 0.94);
    frontPanel.position.set(0, 0.245, -0.012);
    upper.add(frontPanel);

    const backPanel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.240 * rScale, 0.252 * rScale, 0.305, 24, 1, true, -Math.PI * 0.30, Math.PI * 0.60),
      bibFrontMat
    );
    backPanel.scale.set(1.05, 1, 0.93);
    backPanel.position.set(0, 0.245, 0.006);
    upper.add(backPanel);

    // ビブス肩ストラップ
    for (const s of [-1, 1]) {
      const shShoulder = new THREE.Mesh(new THREE.BoxGeometry(0.072 * rScale, 0.095, 0.14 * rScale), bibMain);
      shShoulder.position.set(s * 0.128 * rScale, 0.380, -0.040);
      shShoulder.rotation.z = -s * 0.12;
      upper.add(shShoulder);

      const sideHem = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.18, 0.15 * rScale), bibSub);
      sideHem.position.set(s * 0.225 * rScale, 0.245, -0.005);
      upper.add(sideHem);
    }

    // 下部の裾トリムベルト
    const waistBelt = new THREE.Mesh(cylG, bibDark);
    waistBelt.scale.set(0.266 * rScale, 0.026, 0.236 * rScale);
    waistBelt.position.set(0, 0.126, -0.008);
    upper.add(waistBelt);
  }

  const head = new THREE.Group(); head.position.set(0, 0.61, -0.01); upper.add(head);
  g.userData.head = head;
  const hs = type === 'capybara' ? [0.22, 0.2, 0.26] : isRoundPet ? [0.26, 0.23, 0.245] : [0.24, 0.21, 0.22];
  sph(head, A.body, hs[0], hs[1], hs[2], 0, 0, 0);
  // 目
  sph(head, 0x111111, 0.034, 0.045, 0.02, -0.09, 0.02, -hs[2] + 0.01);
  sph(head, 0x111111, 0.034, 0.045, 0.02, 0.09, 0.02, -hs[2] + 0.01);
  sph(head, 0xffffff, 0.011, 0.014, 0.01, -0.082, 0.04, -hs[2] - 0.005);
  sph(head, 0xffffff, 0.011, 0.014, 0.01, 0.098, 0.04, -hs[2] - 0.005);
  if (type !== 'penguin') sph(head, A.nose, 0.032, 0.024, 0.026, 0, -0.04, -hs[2] - 0.005);
  sph(head, 0xff9db0, 0.04, 0.025, 0.01, -0.15, -0.03, -hs[2] + 0.06); // ほっぺ
  sph(head, 0xff9db0, 0.04, 0.025, 0.01, 0.15, -0.03, -hs[2] + 0.06);
  // 前足(おてて): ネコ・イヌは丸い球状のおてて、他動物はカプセル前足
  if (isRoundPet) {
    for (const s of [-1, 1]) {
      sph(upper, A.body, 0.066, 0.062, 0.072, s * 0.235, 0.265, -0.145);
      sph(upper, A.belly, 0.050, 0.046, 0.042, s * 0.235, 0.260, -0.192);
    }
  } else {
    cap(upper, A.body, 0.048, 0.14, -0.22, 0.28, -0.13, Math.PI / 2.3, 0, -0.45);
    cap(upper, A.body, 0.048, 0.14, 0.22, 0.28, -0.13, Math.PI / 2.3, 0, 0.45);
  }
  switch (type) {
    case 'cat':
      cone(head, A.body, 0.075, 0.145, -0.145, 0.21, 0, 0, 0.35); cone(head, A.body, 0.075, 0.145, 0.145, 0.21, 0, 0, -0.35);
      cone(head, 0xff8fa3, 0.042, 0.095, -0.145, 0.20, -0.03, 0, 0.35); cone(head, 0xff8fa3, 0.042, 0.095, 0.145, 0.20, -0.03, 0, -0.35);
      cap(upper, A.body, 0.036, 0.10, 0.0, 0.14, 0.24, 0.85, 0, 0);
      g.scale.setScalar(0.92); // もとのまるっこいフォルムが映えるサイズ感
      break;
    case 'dog':
    case 'shiba':
      // 柴犬風のピンと立った少し厚めの三角耳 + 白い内耳
      cone(head, A.body, 0.082, 0.14, -0.145, 0.205, 0.01, -0.08, 0.28); cone(head, A.body, 0.082, 0.14, 0.145, 0.205, 0.01, -0.08, -0.28);
      cone(head, A.belly, 0.046, 0.09, -0.145, 0.195, -0.02, -0.08, 0.28); cone(head, A.belly, 0.046, 0.09, 0.145, 0.195, -0.02, -0.08, -0.28);
      // ぷっくり丸い白マズル＆白ほっぺ（裏白模様）
      sph(head, A.belly, 0.115, 0.088, 0.095, 0, -0.062, -hs[2] + 0.055);
      sph(head, A.belly, 0.155, 0.095, 0.085, -0.085, -0.045, -hs[2] + 0.085);
      sph(head, A.belly, 0.155, 0.095, 0.085, 0.085, -0.045, -hs[2] + 0.085);
      // 大きな黒鼻
      sph(head, A.nose, 0.038, 0.028, 0.032, 0, -0.035, -hs[2] - 0.018);
      // チャームポイントの白い豆眉（まろ眉）
      sph(head, A.belly, 0.032, 0.022, 0.015, -0.088, 0.092, -hs[2] + 0.015);
      sph(head, A.belly, 0.032, 0.022, 0.015, 0.088, 0.092, -hs[2] + 0.015);
      // 背中にくるんと丸まった可愛い巻きしっぽ
      sph(upper, A.body, 0.085, 0.095, 0.095, 0, 0.22, 0.255);
      sph(upper, A.belly, 0.065, 0.065, 0.065, 0, 0.265, 0.245);
      g.scale.setScalar(0.92);
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

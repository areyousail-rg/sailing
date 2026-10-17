// クルー(人間 / オリジナル動物キャラ)のモデル生成
import * as THREE from 'three';

export const CREW_TYPES = [
  { id: 'human', label: '人間', icon: '🧑' },
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
function buildHuman(g, style, jacket) {
  const skin = style.skin ?? 0xe9b98f, hat = style.hat ?? 0x1b2338, top = style.shirt ?? 0x2b6cff;
  const hairC = style.hair ?? HAIR[Math.abs(((skin * 7) ^ (hat * 3)) % HAIR.length)];
  const suit = smat(0x1f242b, 0.65), top_ = smat(top, 0.68), skinM = smat(skin, 0.5, 0.02);
  const pfd = smat(0x161920, 0.78), pfdSub = smat(0x252a34, 0.72), accent = smat(jacket, 0.55);
  const glove = smat(0x1c2026, 0.75), gloveGrip = smat(0x374151, 0.88), boot = smat(0x15181e, 0.85), sole = smat(0xf1f5f9, 0.75), pad = smat(0x2d333d, 0.88);
  const lip = smat(new THREE.Color(skin).multiplyScalar(0.82).getHex(), 0.45), hairM = smat(hairC, 0.9);
  const eyeW = smat(0xf8fafc, 0.3), iris = smat(0x291d12, 0.2);

  // 1) 骨盤・体幹・ラッシュガード(自然な人体の厚みと肩〜腰のテーパー)
  ell(g, suit, 0.145, 0.095, 0.11, 0, 0.075, 0.0);
  limb(g, suit, 0.112, [0, 0.10, 0.005], [0, 0.28, 0.0], 0.78);
  limb(g, top_, 0.125, [0, 0.25, 0.0], [0, 0.54, 0.0], 0.74);
  ell(g, top_, 0.185, 0.13, 0.102, 0, 0.53, 0.005); // 胸郭・肩ライン
  for (const s of [-1, 1]) {
    const tr = ell(g, top_, 0.078, 0.042, 0.068, s * 0.095, 0.625, 0.008);
    tr.rotation.z = s * 0.32;
  }

  // 2) レーシングPFD(ディンギー用スリムライフジャケット: Zhik/Musto風のフラットな立体パネル構造)
  const pfdFront = new THREE.Mesh(new THREE.BoxGeometry(0.285, 0.26, 0.042), pfd);
  pfdFront.position.set(0, 0.455, -0.092); pfdFront.rotation.x = 0.05; g.add(pfdFront);
  const pfdBack = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.27, 0.038), pfd);
  pfdBack.position.set(0, 0.465, 0.095); pfdBack.rotation.x = -0.04; g.add(pfdBack);
  // PFDサイドネオプレーンパネル & 胸部ポケット・アクセントライン
  for (const s of [-1, 1]) {
    const sideP = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.22, 0.19), pfdSub);
    sideP.position.set(s * 0.142, 0.44, 0.0); g.add(sideP);
    // ショルダーストラップ
    const shStrap = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.07, 0.19), pfd);
    shStrap.position.set(s * 0.105, 0.618, 0.0); g.add(shStrap);
    // サイド調整ベルト
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.028, 0.04), smat(0x94a3b8, 0.35, 0.6));
    buckle.position.set(s * 0.158, 0.39, -0.02); g.add(buckle);
  }
  // フロントポケット & カラーアクセント帯 + 反射パイピング
  const pocket = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.11, 0.016), pfdSub);
  pocket.position.set(0, 0.42, -0.114); pocket.rotation.x = 0.05; g.add(pocket);
  const accBand = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.032, 0.014), accent);
  accBand.position.set(0, 0.54, -0.112); accBand.rotation.x = 0.05; g.add(accBand);
  const backBand = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.032, 0.012), accent);
  backBand.position.set(0, 0.55, 0.112); backBand.rotation.x = -0.04; g.add(backBand);
  const waistBelt = new THREE.Mesh(new THREE.BoxGeometry(0.295, 0.024, 0.205), smat(0x111318, 0.9));
  waistBelt.position.set(0, 0.355, 0.0); g.add(waistBelt);

  // 3) 首・頭部・自然な顔立ち・スポーツサングラス・キャップ
  limb(g, skinM, 0.042, [0, 0.61, 0.005], [0, 0.725, -0.006], 0.92);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.050, 0.056, 0.032, 18), top_);
  collar.position.set(0, 0.642, 0.003); g.add(collar);

  const head = new THREE.Group(); head.position.set(0, 0.795, -0.012); g.add(head);
  // 滑らかな頭蓋〜輪郭・顎ライン(ゴツゴツした球体の突起を無くし自然な卵型の頭部に)
  ell(head, skinM, 0.076, 0.094, 0.088, 0, 0.012, 0.002);
  ell(head, skinM, 0.064, 0.058, 0.072, 0, -0.036, -0.018);
  ell(head, skinM, 0.036, 0.028, 0.042, 0, -0.068, -0.042); // 自然な顎先
  // 鼻筋・唇・耳
  limb(head, skinM, 0.010, [0, 0.010, -0.080], [0, -0.024, -0.094], 0.85);
  ell(head, skinM, 0.014, 0.010, 0.012, 0, -0.027, -0.091);
  ell(head, lip, 0.020, 0.0055, 0.008, 0, -0.050, -0.080);
  for (const s of [-1, 1]) {
    const ear = ell(head, skinM, 0.011, 0.025, 0.017, s * 0.076, -0.006, 0.002);
    ear.rotation.y = s * 0.25;
    // 目・眉(サングラスの奥に自然に見える造形)
    ell(head, eyeW, 0.012, 0.007, 0.006, s * 0.028, 0.012, -0.078);
    ell(head, iris, 0.006, 0.006, 0.004, s * 0.028, 0.012, -0.082);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.004, 0.006), hairM);
    brow.position.set(s * 0.028, 0.024, -0.080); brow.rotation.z = -s * 0.08; head.add(brow);
  }
  // 後ろ髪・襟足・もみあげ
  ell(head, hairM, 0.080, 0.068, 0.086, 0, 0.014, 0.014);
  ell(head, hairM, 0.065, 0.042, 0.045, 0, -0.032, 0.052); // 襟足
  for (const s of [-1, 1]) ell(head, hairM, 0.013, 0.032, 0.026, s * 0.072, 0.008, -0.018);

  // スポーティな偏光サングラス(左右独立カーブレンズ＋ノーズブリッジ＋フレーム)
  const frameM = smat(0x111318, 0.3, 0.2), lensM = smat(0x0f172a, 0.08, 0.78);
  const topBar = new THREE.Mesh(new THREE.BoxGeometry(0.128, 0.005, 0.012), frameM);
  topBar.position.set(0, 0.024, -0.082); head.add(topBar);
  for (const s of [-1, 1]) {
    const lns = ell(head, lensM, 0.028, 0.016, 0.010, s * 0.031, 0.011, -0.082);
    lns.rotation.y = s * 0.22; lns.rotation.z = -s * 0.05;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.006, 0.082), frameM);
    arm.position.set(s * 0.074, 0.016, -0.038); arm.rotation.y = s * 0.08; head.add(arm);
  }

  // セーリングキャップ(立体的なクラウン＋カーブしたバイザー)
  const capMat = smat(hat, 0.78);
  const crown = new THREE.Mesh(new THREE.SphereGeometry(0.084, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.54), capMat);
  crown.scale.set(0.97, 0.92, 1.06); crown.position.set(0, 0.026, 0.003); crown.rotation.x = -0.06; head.add(crown);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.078, 0.006, 20, 1, false, -Math.PI * 0.52, Math.PI * 1.04), capMat);
  brim.rotation.y = Math.PI; brim.rotation.x = -0.16; brim.scale.set(1.02, 1, 1.12);
  brim.position.set(0, 0.034, -0.096); head.add(brim);
  ell(head, capMat, 0.009, 0.005, 0.009, 0, 0.104, 0.008);

  // 4) 下半身(ハイキングパンツ + ニーパッド + ネオプレーンセーリングブーツ) & 腕・グローブ
  for (const s of [-1, 1]) {
    const hip = [s * 0.088, 0.075, 0.0], knee = [s * 0.11, 0.26, -0.38], ank = [s * 0.105, 0.03, -0.74];
    limb(g, suit, 0.076, hip, [hip[0] * 0.35 + knee[0] * 0.65, hip[1] * 0.35 + knee[1] * 0.65, hip[2] * 0.35 + knee[2] * 0.65], 0.95);
    limb(g, suit, 0.062, hip, knee, 0.95);
    // 膝当てパッド
    ell(g, pad, 0.060, 0.062, 0.068, knee[0], knee[1] + 0.006, knee[2] - 0.008);
    limb(g, suit, 0.052, knee, [knee[0], knee[1] * 0.45 + ank[1] * 0.55, knee[2] * 0.45 + ank[2] * 0.55 + 0.015], 0.95);
    limb(g, suit, 0.042, knee, ank, 0.95);
    // ディンギーブーツ(足首〜甲〜白いラバーソール)
    limb(g, boot, 0.048, [ank[0], ank[1] + 0.04, ank[2]], [ank[0], ank[1] - 0.015, ank[2] - 0.11]);
    const so = new THREE.Mesh(new THREE.BoxGeometry(0.086, 0.016, 0.23), sole);
    so.position.set(ank[0], ank[1] - 0.042, ank[2] - 0.045); g.add(so);

    // 腕: 肩→上腕(半袖〜七分袖ラッシュ)→前腕(日焼け肌)→手首→セーリンググローブ
    const sh = [s * 0.195, 0.565, 0.005], el = [s * 0.225, 0.385, -0.12], wr = [s * 0.135, 0.395, -0.34], ha = [s * 0.115, 0.39, -0.385];
    ell(g, top_, 0.058, 0.062, 0.058, sh[0], sh[1], sh[2]);
    limb(g, top_, 0.046, sh, el);
    ell(g, skinM, 0.040, 0.040, 0.040, el[0], el[1], el[2]);
    limb(g, skinM, 0.036, el, wr);
    // 手首リストバンド / 時計(左腕のみ)
    if (s === -1) {
      const watch = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.018, 12), frameM);
      watch.position.set(wr[0], wr[1], wr[2] + 0.02); watch.rotation.x = Math.PI / 2; g.add(watch);
    }
    // 5本指セーリンググローブ
    ell(g, glove, 0.030, 0.024, 0.042, ha[0], ha[1], ha[2]);
    ell(g, gloveGrip, 0.028, 0.018, 0.036, ha[0], ha[1] - 0.008, ha[2] - 0.005);
    for (let f = 0; f < 4; f++) {
      limb(g, glove, 0.0085, [ha[0] + (f - 1.5) * 0.013, ha[1] + 0.006, ha[2] - 0.032], [ha[0] + (f - 1.5) * 0.012, ha[1] - 0.016, ha[2] - 0.048]);
    }
    limb(g, glove, 0.0095, [ha[0] - s * 0.024, ha[1] + 0.004, ha[2] - 0.008], [ha[0] - s * 0.016, ha[1] + 0.012, ha[2] - 0.042]);
  }
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

// 座位の原点=お尻。前方 -z、上 +y。全高 約0.95m
export function buildFigure(type, style = {}) {
  if (customModels.has(type)) return customModels.get(type).clone(true);
  const g = new THREE.Group();
  const jacket = style.jacket ?? 0xff7a1a;
  if (type === 'human' || !ANIMAL[type]) {
    return buildHuman(g, style, jacket);
  }
  const A = ANIMAL[type];
  const body = sph(g, A.body, 0.23, 0.27, 0.21, 0, 0.30, 0);
  sph(g, A.belly, 0.15, 0.17, 0.08, 0, 0.30, -0.15);
  if (type === 'cat') {
    // ネコ用の赤いライフジャケット(PFDベスト: 赤い身頃・肩ストラップ・黒ベルト・バックル)
    const redPfd = 0xdc2626, beltCol = 0x1e293b;
    sph(g, redPfd, 0.245, 0.19, 0.22, 0, 0.32, 0.01);
    for (const s of [-1, 1]) {
      sph(g, redPfd, 0.115, 0.18, 0.14, s * 0.10, 0.32, -0.09); // 前面左右パネル
      cap(g, redPfd, 0.036, 0.10, s * 0.11, 0.46, -0.02, 0.2, 0, 0); // 肩ストラップ
    }
    const belt = new THREE.Mesh(cylG, mat(beltCol)); belt.scale.set(0.252, 0.035, 0.232); belt.position.set(0, 0.27, 0.0); g.add(belt);
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.02), mat(0xe2e8f0)); buckle.position.set(0, 0.27, -0.225); g.add(buckle);
  } else {
    const band = new THREE.Mesh(cylG, mat(jacket)); band.scale.set(0.235, 0.1, 0.215); band.position.set(0, 0.31, 0); g.add(band);
  }
  const head = new THREE.Group(); head.position.set(0, 0.70, -0.01); g.add(head);
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
  // 手足
  cap(g, A.body, 0.05, 0.14, -0.24, 0.36, -0.12, Math.PI / 2.4, 0, -0.5);
  cap(g, A.body, 0.05, 0.14, 0.24, 0.36, -0.12, Math.PI / 2.4, 0, 0.5);
  sph(g, A.body, 0.07, 0.06, 0.12, -0.1, 0.06, -0.36);
  sph(g, A.body, 0.07, 0.06, 0.12, 0.1, 0.06, -0.36);
  switch (type) {
    case 'cat':
      cone(head, A.body, 0.07, 0.14, -0.14, 0.2, 0, 0, 0.35); cone(head, A.body, 0.07, 0.14, 0.14, 0.2, 0, 0, -0.35);
      cone(head, 0xff8fa3, 0.04, 0.09, -0.14, 0.19, -0.03, 0, 0.35); cone(head, 0xff8fa3, 0.04, 0.09, 0.14, 0.19, -0.03, 0, -0.35);
      cap(g, A.body, 0.032, 0.09, 0.0, 0.22, 0.22, 0.85, 0, 0);
      break;
    case 'shiba':
      cone(head, A.body, 0.075, 0.13, -0.14, 0.19, 0, 0, 0.3); cone(head, A.body, 0.075, 0.13, 0.14, 0.19, 0, 0, -0.3);
      sph(head, A.belly, 0.12, 0.09, 0.09, 0, -0.07, -hs[2] + 0.07);
      sph(head, 0xfff4e6, 0.03, 0.02, 0.01, -0.09, 0.09, -hs[2] + 0.01);
      sph(head, 0xfff4e6, 0.03, 0.02, 0.01, 0.09, 0.09, -hs[2] + 0.01);
      sph(g, A.body, 0.12, 0.12, 0.12, 0, 0.42, 0.26);
      break;
    case 'penguin': {
      const beak = cone(head, A.nose, 0.04, 0.09, 0, -0.02, -hs[2] - 0.03, -Math.PI / 2, 0);
      sph(head, A.belly, 0.17, 0.15, 0.1, 0, -0.02, -hs[2] + 0.07);
      cap(g, A.body, 0.04, 0.2, -0.27, 0.34, -0.02, 0, 0, 0.5);
      cap(g, A.body, 0.04, 0.2, 0.27, 0.34, -0.02, 0, 0, -0.5);
      break;
    }
    case 'bear':
      sph(head, A.body, 0.07, 0.07, 0.05, -0.17, 0.17, 0); sph(head, A.body, 0.07, 0.07, 0.05, 0.17, 0.17, 0);
      sph(head, A.belly, 0.1, 0.08, 0.08, 0, -0.05, -hs[2] + 0.08);
      sph(g, A.body, 0.07, 0.07, 0.07, 0, 0.18, 0.25);
      break;
    case 'rabbit':
      cap(head, A.body, 0.05, 0.28, -0.08, 0.34, 0.02, -0.1, 0, 0.12);
      cap(head, A.body, 0.05, 0.28, 0.08, 0.34, 0.02, -0.1, 0, -0.12);
      cap(head, 0xffb7c5, 0.025, 0.22, -0.08, 0.34, -0.02, -0.1, 0, 0.12);
      cap(head, 0xffb7c5, 0.025, 0.22, 0.08, 0.34, -0.02, -0.1, 0, -0.12);
      sph(g, 0xffffff, 0.09, 0.09, 0.09, 0, 0.2, 0.24);
      break;
    case 'capybara':
      sph(head, A.body, 0.14, 0.12, 0.14, 0, -0.04, -hs[2] + 0.1);
      sph(head, A.nose, 0.05, 0.035, 0.03, 0, -0.01, -hs[2] - 0.05);
      sph(head, A.body, 0.045, 0.045, 0.03, -0.14, 0.15, 0.03); sph(head, A.body, 0.045, 0.045, 0.03, 0.14, 0.15, 0.03);
      break;
  }
  return g;
}

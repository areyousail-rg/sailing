// クルー(人間 / オリジナル動物キャラ)のモデル生成
import * as THREE from 'three';

export const CREW_TYPES = [
  { id: 'human', label: '人間', icon: '🧑' },
  { id: 'cat', label: 'ネコ', icon: '🐱' },
  { id: 'shiba', label: 'イヌ', icon: '🐶' },
  { id: 'penguin', label: 'ペンギン', icon: '🐧' },
  { id: 'bear', label: 'クマ', icon: '🐻' },
  { id: 'rabbit', label: 'ウサギ', icon: '🐰' },
  { id: 'capybara', label: 'カピバラ', icon: '🦫' },
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
function buildHuman(g, style, jacket) {
  const skin = style.skin ?? 0xe9b98f, hat = style.hat ?? 0x1b2338, top = style.shirt ?? 0x30343c;
  const suit = smat(0x23272e, 0.7), top_ = smat(top, 0.75), skinM = smat(skin, 0.6), pfd = smat(0x15181e, 0.85), accent = smat(jacket, 0.6);
  const glove = smat(0x1c1f24, 0.8), boot = smat(0x15171a, 0.9), sole = smat(0xe5e5e5, 0.8);
  // 髄 / 胴
  ell(g, suit, 0.155, 0.095, 0.115, 0, 0.07, 0.0);
  limb(g, top_, 0.12, [0, 0.14, 0.01], [0, 0.4, 0.0], 0.8);
  ell(g, top_, 0.19, 0.14, 0.12, 0, 0.52, 0.0);
  // PFD(ベスト): 胸・背中・肩。サイドバックルとカラーパネル
  ell(g, pfd, 0.205, 0.17, 0.135, 0, 0.47, 0.0);
  ell(g, accent, 0.07, 0.05, 0.02, -0.07, 0.58, -0.125);
  ell(g, accent, 0.07, 0.05, 0.02, 0.07, 0.58, -0.125);
  for (const s of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.02), smat(0x888b90, 0.4, 0.4)); b.position.set(s * 0.16, 0.36, -0.07); g.add(b);
    ell(g, pfd, 0.075, 0.06, 0.1, s * 0.15, 0.62, 0.0);
  }
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.03, 0.01), smat(0x2a2d33, 0.9)); strap.position.set(0, 0.34, -0.118); g.add(strap);
  // 首・頭
  limb(g, skinM, 0.045, [0, 0.62, 0], [0, 0.72, -0.01]);
  const head = new THREE.Group(); head.position.set(0, 0.8, -0.015); g.add(head);
  ell(head, skinM, 0.085, 0.108, 0.098, 0, 0, 0);
  ell(head, skinM, 0.018, 0.03, 0.012, -0.085, -0.005, 0.0); ell(head, skinM, 0.018, 0.03, 0.012, 0.085, -0.005, 0.0); // 耳
  ell(head, skinM, 0.018, 0.022, 0.02, 0, -0.01, -0.095); // 鼻
  const lens = smat(0x0a0c10, 0.12, 0.6);
  for (const s of [-1, 1]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.026, 0.01), lens); l.position.set(s * 0.036, 0.018, -0.094); head.add(l); }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.008, 0.008), lens); bridge.position.set(0, 0.026, -0.084); head.add(bridge);
  const cp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), smat(hat, 0.85)); cp.scale.set(1, 0.95, 1.08); cp.position.set(0, 0.02, 0.0); head.add(cp);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.008, 18, 1, false, -Math.PI * 0.55, Math.PI * 1.1), smat(hat, 0.85)); brim.rotation.y = Math.PI; brim.scale.set(1.1, 1, 1.05); brim.position.set(0, 0.04, -0.12); head.add(brim);
  // 腹部と下半身(ウェットパンツ)
  for (const s of [-1, 1]) {
    const hip = [s * 0.09, 0.07, 0.0], knee = [s * 0.12, 0.3, -0.4], ank = [s * 0.12, 0.04, -0.78];
    limb(g, suit, 0.082, hip, knee, 1);
    ell(g, suit, 0.075, 0.075, 0.075, knee[0], knee[1], knee[2]);
    limb(g, suit, 0.058, knee, ank, 1);
    // セーリングブーツ
    limb(g, boot, 0.06, [ank[0], ank[1] + 0.02, ank[2]], [ank[0], ank[1] - 0.02, ank[2] - 0.1]);
    const so = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.018, 0.27), sole); so.position.set(ank[0], ank[1] - 0.05, ank[2] - 0.05); g.add(so);
    // 腕: 肩→肘→手(前方でシート/ティラーを保持)
    const sh = [s * 0.22, 0.58, 0.0], el = [s * 0.25, 0.4, -0.13], ha = [s * 0.14, 0.44, -0.4];
    ell(g, top_, 0.06, 0.06, 0.06, sh[0], sh[1], sh[2]);
    limb(g, top_, 0.05, sh, el); limb(g, top_, 0.04, el, ha);
    ell(g, glove, 0.045, 0.04, 0.06, ha[0], ha[1], ha[2] - 0.03);
    for (let f = 0; f < 3; f++) ell(g, glove, 0.012, 0.012, 0.03, ha[0] + (f - 1) * 0.022, ha[1] - 0.005, ha[2] - 0.09);
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
  const band = new THREE.Mesh(cylG, mat(jacket)); band.scale.set(0.235, 0.1, 0.215); band.position.set(0, 0.31, 0); g.add(band);
  sph(g, A.belly, 0.15, 0.17, 0.08, 0, 0.30, -0.15);
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
      cap(g, A.body, 0.035, 0.3, 0.0, 0.3, 0.3, 1.0, 0, 0);
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

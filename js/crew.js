// クルー(人間 / オリジナル動物キャラ)のモデル生成
import * as THREE from 'three';

export const CREW_TYPES = [
  { id: 'human_m', label: '男性', icon: '', unlockRate: 0, splashName: 'Male Sailor' },
  { id: 'human_f', label: '女性', icon: '', unlockRate: 0, splashName: 'Female Sailor' },
  { id: 'cat', label: 'ネコ', icon: '', unlockRate: 0, splashName: 'Cat' },
  { id: 'dog', label: 'イヌ', icon: '', unlockRate: 0, splashName: 'Dog' },
  { id: 'duck', label: 'アヒル', icon: '', unlockRate: 1550, splashName: 'Duck' },
  { id: 'tanuki', label: 'タヌキ', icon: '', unlockRate: 1650, splashName: 'Tanuki' },
  { id: 'rabbit', label: 'ウサギ', icon: '', unlockRate: 1750, splashName: 'Rabbit' },
  { id: 'dolphin', label: 'イルカ', icon: '', unlockRate: 1850, splashName: 'Dolphin' },
  { id: 'penguin', label: 'ペンギン', icon: '', unlockRate: 1950, splashName: 'Penguin' },
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

// ---- リアルな人間(解剖学的シルエット + ウェットスーツ + 立体PFD + フィンガーレスグローブ + ブーツ + フィットキャップ + サングラス) ----
const smatCache = new Map();
const smat = (c, r = 0.8, m = 0) => { const k = c + '_' + r + '_' + m; let x = smatCache.get(k); if (!x) { x = new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m }); smatCache.set(k, x); } return x; };

function limb(parent, material, r, a, b, taper = 1) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), len = d.length();
  const m = new THREE.Mesh(capG(r, Math.max(0.01, len - 2 * r)), material);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  m.scale.set(1, 1, taper); parent.add(m); return m;
}

// 筋肉の自然な太さ変化を表現するテーパー付き四肢ヘルパー (共有キャッシュ対応)
const taperCylCache = new Map();
function taperLimb(parent, material, rA, rB, a, b, scaleZ = 1.0, endCaps = true) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const d = B.clone().sub(A), len = Math.max(0.005, d.length());
  const key = `tc_${rA.toFixed(4)}_${rB.toFixed(4)}_${len.toFixed(4)}`;
  let geo = taperCylCache.get(key);
  if (!geo) {
    geo = new THREE.CylinderGeometry(rB, rA, len, 14, 1, false);
    taperCylCache.set(key, geo);
  }
  const m = new THREE.Mesh(geo, material);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  m.scale.set(1, 1, scaleZ);
  parent.add(m);
  if (endCaps) {
    const jA = new THREE.Mesh(sphereG, material);
    jA.scale.set(rA, rA, rA * scaleZ); jA.position.copy(A); parent.add(jA);
    const jB = new THREE.Mesh(sphereG, material);
    jB.scale.set(rB, rB, rB * scaleZ); jB.position.copy(B); parent.add(jB);
  }
  return m;
}

function ell(parent, material, sx, sy, sz, x, y, z) { const m = new THREE.Mesh(sphereG, material); m.scale.set(sx, sy, sz); m.position.set(x, y, z); parent.add(m); return m; }

// ---- 人間用 共有立体ジオメトリ(胴体・頭部・バイザー・PFDパネル) ----
function getHumanTorsoGeo(isFemale) {
  const key = isFemale ? 'htorso_f' : 'htorso_m';
  let g = geoCache.get(key);
  if (g) return g;
  const pts = isFemale ? [
    new THREE.Vector2(0.001, 0.00),
    new THREE.Vector2(0.118, 0.02),
    new THREE.Vector2(0.122, 0.07),
    new THREE.Vector2(0.104, 0.16), // くびれたウエスト
    new THREE.Vector2(0.114, 0.25),
    new THREE.Vector2(0.134, 0.36), // 胸郭
    new THREE.Vector2(0.150, 0.46), // 肩ライン
    new THREE.Vector2(0.126, 0.51),
    new THREE.Vector2(0.068, 0.545), // 僧帽筋〜首根元
    new THREE.Vector2(0.042, 0.565),
  ] : [
    new THREE.Vector2(0.001, 0.00),
    new THREE.Vector2(0.126, 0.02),
    new THREE.Vector2(0.128, 0.08),
    new THREE.Vector2(0.122, 0.17), // 引き締まった腹斜筋
    new THREE.Vector2(0.136, 0.28),
    new THREE.Vector2(0.156, 0.39), // 厚みのある胸郭
    new THREE.Vector2(0.174, 0.475), // 広いアスリート肩
    new THREE.Vector2(0.142, 0.52),
    new THREE.Vector2(0.078, 0.555),
    new THREE.Vector2(0.048, 0.575),
  ];
  g = new THREE.LatheGeometry(pts, 22);
  // 体の前後厚みを自然な楕円比率へ整形し、胸・背中のわずかな立体感を付与
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let nz = z * 0.59;
    // 胸板(前-z)の自然な立体感(PFD背面からはみ出さない範囲)
    if (y > 0.26 && y < 0.48 && z < 0) {
      const k = Math.sin(((y - 0.26) / 0.22) * Math.PI);
      nz -= k * (isFemale ? 0.014 : 0.008) * Math.max(0, 1 - Math.abs(x) / 0.14);
    }
    pos.setZ(i, nz);
  }
  g.computeVertexNormals();
  geoCache.set(key, g);
  return g;
}

function getHumanHeadGeo(isFemale) {
  const key = isFemale ? 'hhead_f' : 'hhead_m';
  let g = geoCache.get(key);
  if (g) return g;
  const s = isFemale ? 0.94 : 1.0;
  // 顎先(-0.080)から頭頂(+0.100)まで、頬骨・エラ・後頭部の自然な輪郭を持つ頭部
  const pts = [
    new THREE.Vector2(0.001, -0.080 * s),
    new THREE.Vector2(0.023 * s, -0.075 * s), // 顎先
    new THREE.Vector2(0.047 * s, -0.055 * s), // 顎ライン
    new THREE.Vector2(0.064 * s, -0.024 * s), // 頬下部
    new THREE.Vector2(0.073 * s,  0.009 * s), // 頬骨
    new THREE.Vector2(0.074 * s,  0.042 * s), // こめかみ・額
    new THREE.Vector2(0.070 * s,  0.072 * s), // 頭蓋側部
    new THREE.Vector2(0.050 * s,  0.091 * s),
    new THREE.Vector2(0.023 * s,  0.099 * s),
    new THREE.Vector2(0.001,  0.101 * s),
  ];
  g = new THREE.LatheGeometry(pts, 28);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    z *= 1.08;
    if (z > 0 && y > -0.02) z += 0.006 * Math.sin(Math.min(1, (y + 0.02) / 0.115) * Math.PI);
    if (y < -0.02 && z < 0) {
      const k = Math.min(1, (-0.02 - y) / 0.06);
      z -= 0.007 * k * Math.max(0, 1 - Math.abs(x) / 0.055);
      x *= (1 - 0.10 * k);
    }
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  geoCache.set(key, g);
  return g;
}

// リアルな肌・眉・目・唇・陰影を描き込んだプロシージャル顔テクスチャ (LatheGeometry UV準拠: u=0.5が正面-z)
const faceTexCache = new Map();
function getHumanFaceTex(skinHex, hairHex, isFemale) {
  const key = `${skinHex >>> 0}_${hairHex >>> 0}_${isFemale ? 1 : 0}`;
  if (faceTexCache.has(key)) return faceTexCache.get(key);
  const W = 512, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const sc = new THREE.Color(skinHex);
  const hc = new THREE.Color(hairHex);
  const baseHex = '#' + sc.getHexString();
  const shadeHex = '#' + sc.clone().multiplyScalar(0.84).getHexString();
  const hiHex = '#' + sc.clone().lerp(new THREE.Color(0xfff1e4), 0.18).getHexString();
  const hairStr = '#' + hc.getHexString();

  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, W, H);

  // 首・顎下〜頬の柔らかな立体陰影
  const jawGrad = ctx.createLinearGradient(0, H * 0.72, 0, H);
  jawGrad.addColorStop(0, 'rgba(90,45,25,0)');
  jawGrad.addColorStop(1, 'rgba(72,36,20,0.26)');
  ctx.fillStyle = jawGrad;
  ctx.fillRect(0, H * 0.72, W, H * 0.28);

  const cx = W * 0.5;
  // Tゾーン(額・鼻筋)の自然なハイライト
  const tGrad = ctx.createRadialGradient(cx, H * 0.44, 4, cx, H * 0.44, 52);
  tGrad.addColorStop(0, hiHex);
  tGrad.addColorStop(1, 'rgba(255,240,225,0)');
  ctx.fillStyle = tGrad;
  ctx.fillRect(cx - 60, H * 0.22, 120, H * 0.46);

  // 健康的な日焼け＆頬の血色
  for (const s of [-1, 1]) {
    const chGrad = ctx.createRadialGradient(cx + s * 36, H * 0.61, 2, cx + s * 36, H * 0.61, 22);
    chGrad.addColorStop(0, isFemale ? 'rgba(218,108,108,0.24)' : 'rgba(182,92,68,0.16)');
    chGrad.addColorStop(1, 'rgba(218,108,108,0)');
    ctx.fillStyle = chGrad;
    ctx.beginPath(); ctx.arc(cx + s * 36, H * 0.61, 22, 0, Math.PI * 2); ctx.fill();
  }

  // 頭頂・後頭部・もみあげの自然な髪の生え際
  ctx.fillStyle = hairStr;
  ctx.fillRect(0, 0, W, H * 0.28);
  ctx.fillRect(0, H * 0.25, W * 0.30, H * 0.50);
  ctx.fillRect(W * 0.70, H * 0.25, W * 0.30, H * 0.50);
  ctx.beginPath();
  ctx.moveTo(W * 0.29, H * 0.27);
  ctx.quadraticCurveTo(cx, H * 0.34, W * 0.71, H * 0.27);
  ctx.lineTo(W * 0.71, H * 0.18);
  ctx.lineTo(W * 0.29, H * 0.18);
  ctx.closePath();
  ctx.fill();

  // 眉毛 (自然なアーチ)
  ctx.strokeStyle = hairStr;
  ctx.lineCap = 'round';
  ctx.lineWidth = isFemale ? 3.2 : 4.4;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + s * 11, H * 0.455);
    ctx.quadraticCurveTo(cx + s * 24, H * 0.434, cx + s * 36, H * 0.452);
    ctx.stroke();
  }

  // 目 (まぶた陰影 + 白目 + 虹彩 + 瞳孔 + ハイライト + まつ毛ライン)
  for (const s of [-1, 1]) {
    const ex = cx + s * 23, ey = H * 0.505;
    ctx.strokeStyle = shadeHex;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(ex - 10, ey - 5);
    ctx.quadraticCurveTo(ex, ey - 9, ex + 10, ey - 5);
    ctx.stroke();

    ctx.fillStyle = '#f5f6f8';
    ctx.beginPath();
    ctx.ellipse(ex, ey, 9.5, isFemale ? 5.2 : 4.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#2d1e15';
    ctx.beginPath(); ctx.arc(ex, ey, isFemale ? 4.4 : 4.0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0f0c0a';
    ctx.beginPath(); ctx.arc(ex, ey, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(ex - 1.5, ey - 1.4, 1.3, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = '#1b1410';
    ctx.lineWidth = isFemale ? 2.4 : 1.9;
    ctx.beginPath();
    ctx.moveTo(ex - 10, ey);
    ctx.quadraticCurveTo(ex, ey - (isFemale ? 6.5 : 5.5), ex + 10, ey + 0.5);
    ctx.stroke();
  }

  // 鼻下のやわらかな影
  ctx.fillStyle = 'rgba(85,42,24,0.20)';
  ctx.beginPath();
  ctx.ellipse(cx, H * 0.635, 6.5, 2.4, 0, 0, Math.PI * 2);
  ctx.fill();

  // 口元・自然な唇
  const ly = H * 0.715;
  ctx.fillStyle = isFemale ? '#c4636d' : '#' + sc.clone().multiplyScalar(0.80).lerp(new THREE.Color(0xa65850), 0.35).getHexString();
  ctx.beginPath();
  ctx.moveTo(cx - 14, ly);
  ctx.quadraticCurveTo(cx - 5, ly - 4.0, cx, ly - 2.0);
  ctx.quadraticCurveTo(cx + 5, ly - 4.0, cx + 14, ly);
  ctx.quadraticCurveTo(cx, ly + 1.5, cx - 14, ly);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - 12, ly + 0.5);
  ctx.quadraticCurveTo(cx, ly + (isFemale ? 6.6 : 5.4), cx + 12, ly + 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(74,34,26,0.42)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cx - 14, ly);
  ctx.quadraticCurveTo(cx, ly + 1.2, cx + 14, ly);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  faceTexCache.set(key, tex);
  return tex;
}

// キャップの自然なカーブバイザー(クラウン前縁からシームレスに接続、浮き隙間ゼロ)
function getCapVisorGeo() {
  let g = geoCache.get('cap_visor');
  if (g) return g;
  const nu = 18, nv = 6;
  const pos = [], uvs = [], idx = [];
  for (let j = 0; j <= nv; j++) {
    const v = j / nv; // 0=額付け根, 1=つば先端
    for (let i = 0; i <= nu; i++) {
      const u = (i / nu) * 2 - 1; // -1..+1
      const halfW = 0.078 * (1 - 0.18 * v * v);
      const x = u * halfW;
      const zRoot = -0.072 + 0.025 * u * u;
      const zTip = -0.158 + 0.048 * u * u;
      const z = zRoot + (zTip - zRoot) * v;
      const arch = -0.014 * u * u * (0.30 + 0.70 * v);
      const slope = -0.012 * v;
      const y = 0.036 + arch + slope;
      pos.push(x, y, z);
      uvs.push(i / nu, v);
    }
  }
  const stride = nu + 1;
  const topCount = pos.length / 3;
  for (let k = 0; k < topCount; k++) {
    pos.push(pos[k * 3], pos[k * 3 + 1] - 0.0044, pos[k * 3 + 2]);
    uvs.push(uvs[k * 2], uvs[k * 2 + 1]);
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
      idx.push(a, c, b, b, c, d);
      const at = a + topCount, bt = b + topCount, ct = c + topCount, dt = d + topCount;
      idx.push(at, bt, ct, bt, dt, ct);
    }
  }
  for (let i = 0; i < nu; i++) {
    const a = nv * stride + i, b = a + 1;
    idx.push(a, a + topCount, b, b, a + topCount, b + topCount);
  }
  for (let j = 0; j < nv; j++) {
    const l0 = j * stride, l1 = (j + 1) * stride;
    idx.push(l0, l0 + topCount, l1, l1, l0 + topCount, l1 + topCount);
    const r0 = j * stride + nu, r1 = (j + 1) * stride + nu;
    idx.push(r0, r1, r0 + topCount, r1, r1 + topCount, r0 + topCount);
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  geoCache.set('cap_visor', g);
  return g;
}

// 人間用 立体面取り・曲面カーブ付きPFD浮力体パネル (BoxGeometryの箱感を完全排除)
function getHumanPfdPanelGeo(w, h, depth, curveDir = -1) {
  const key = `hpfd_${w.toFixed(3)}_${h.toFixed(3)}_${depth.toFixed(3)}_${curveDir}`;
  let g = geoCache.get(key);
  if (g) return g;
  const hw = w * 0.5, hh = h * 0.5, r = Math.min(w, h) * 0.14;
  const shape = new THREE.Shape();
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
  shape.lineTo(hw, hh - r * 1.15);
  shape.quadraticCurveTo(hw, hh, hw - r * 1.25, hh);
  shape.lineTo(hw * 0.34, hh);
  shape.quadraticCurveTo(0, hh - h * 0.08, -hw * 0.34, hh);
  shape.lineTo(-hw + r * 1.25, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - r * 1.15);
  shape.lineTo(-hw, -hh + r);
  shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);

  g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.0085,
    bevelSize: 0.008,
    bevelSegments: 3,
    curveSegments: 8,
  });
  g.translate(0, 0, -depth * 0.5);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = x / (hw + 0.01);
    const bend = nx * nx * 0.022 * (-curveDir);
    pos.setZ(i, z + bend);
    const u = curveDir < 0 ? (0.5 - x / (w + 0.018)) : (0.5 + x / (w + 0.018));
    const v = 0.5 + y / (h + 0.018);
    uv.setXY(i, Math.max(0, Math.min(1, u)), Math.max(0, Math.min(1, v)));
  }
  g.computeVertexNormals();
  geoCache.set(key, g);
  return g;
}

const HAIR = [0x1d1510, 0x2b1d13, 0x3b2a1c, 0x14110f, 0x5a3f28];
function buildHuman(g, style, jacket, isFemale = false) {
  const rawSkin = style.skin ?? (isFemale ? 0xd99770 : 0xce885e);
  const skinCol = new THREE.Color(rawSkin);
  if (skinCol.r > 0.82 && skinCol.g > 0.72) {
    skinCol.setHex(isFemale ? 0xd99770 : 0xce885e);
  }
  const skin = skinCol.getHex();
  const hat = style.hat ?? (isFemale ? 0xf5f3ee : 0x162944);
  const hairC = style.hair ?? (isFemale ? 0x2a1b12 : HAIR[Math.abs(((skin * 7) ^ (hat * 3)) % HAIR.length)]);

  const suit = smat(0x181c23, 0.64), suitPanel = smat(0x252c38, 0.72), top_ = smat(0x1b2029, 0.66);
  const skinM = smat(skin, 0.78, 0.0);
  const faceMat = new THREE.MeshStandardMaterial({ map: getHumanFaceTex(skin, hairC, isFemale), roughness: 0.76, metalness: 0.0 });
  const bibCol = new THREE.Color(jacket);
  const isLightBib = (bibCol.r * 0.3 + bibCol.g * 0.59 + bibCol.b * 0.11) > 0.72;
  const pfd = smat(jacket, 0.54);
  const pfdSub = smat(bibCol.clone().multiplyScalar(isLightBib ? 0.85 : 0.76).getHex(), 0.66);
  const bibPanelMat = new THREE.MeshStandardMaterial({ map: getBibTex(jacket), roughness: 0.52, metalness: 0.02 });
  const strapDark = smat(0x13171e, 0.82);
  const buckleM = smat(0x202630, 0.42, 0.25);
  const glove = smat(0x1a1e25, 0.72), gloveGrip = smat(0x36404e, 0.88), boot = smat(0x161a21, 0.78), sole = smat(0xedeae2, 0.76), pad = smat(0x2a313c, 0.88);
  const hairM = smat(hairC, 0.82);
  const frameM = smat(0x11151c, 0.28, 0.35), lensM = smat(0x14385c, 0.05, 0.84);

  const shScale = isFemale ? 0.88 : 1.0;
  const legS = isFemale ? 0.92 : 1.0;

  // 1) 骨盤・下半身 (筋肉のテーパーを持たせた太もも・ふくらはぎ・コーデュラ膝パッド・ネオプレンディンギーブーツ)
  ell(g, suit, 0.132 * (isFemale ? 0.97 : 1.0), 0.080, 0.090, 0, 0.052, 0.008);
  for (const s of [-1, 1]) {
    const hip = [s * 0.080 * shScale, 0.052, 0.008];
    const midThigh = [s * 0.090 * shScale, 0.050, -0.150];
    const knee = [s * 0.095 * shScale, 0.042, -0.300];
    const upperCalf = [s * 0.092 * shScale, -0.058, -0.348];
    const ank = [s * 0.086 * shScale, -0.212, -0.394];

    taperLimb(g, suit, 0.072 * legS, 0.062 * legS, hip, midThigh, 0.92, true);
    taperLimb(g, suit, 0.062 * legS, 0.050 * legS, midThigh, knee, 0.92, true);
    ell(g, pad, 0.054 * legS, 0.042 * legS, 0.090 * legS, midThigh[0], midThigh[1] - 0.016, midThigh[2] - 0.010);
    ell(g, pad, 0.049 * legS, 0.047 * legS, 0.052 * legS, knee[0], knee[1] + 0.007, knee[2] - 0.010);
    taperLimb(g, suit, 0.047 * legS, 0.050 * legS, knee, upperCalf, 0.94, false);
    taperLimb(g, suit, 0.050 * legS, 0.035 * legS, upperCalf, ank, 0.94, true);

    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.039 * legS, 0.042 * legS, 0.060, 14), boot);
    cuff.position.set(ank[0], ank[1] + 0.020, ank[2] + 0.005); cuff.rotation.x = 0.22; g.add(cuff);
    taperLimb(g, boot, 0.041 * legS, 0.034 * legS, [ank[0], ank[1] - 0.004, ank[2] + 0.010], [ank[0], ank[1] - 0.022, ank[2] - 0.098], 0.85, true);
    const archStrap = new THREE.Mesh(new THREE.CylinderGeometry(0.040 * legS, 0.040 * legS, 0.024, 14), strapDark);
    archStrap.position.set(ank[0], ank[1] - 0.012, ank[2] - 0.040); archStrap.rotation.x = Math.PI / 2 - 0.14; g.add(archStrap);
    const soleG = new THREE.CapsuleGeometry(0.037 * legS, 0.115, 4, 10);
    const so = new THREE.Mesh(soleG, sole);
    so.scale.set(1.02, 1.0, 0.24);
    so.rotation.x = Math.PI / 2 + 0.08;
    so.position.set(ank[0], ank[1] - 0.035, ank[2] - 0.044);
    g.add(so);
  }

  // 2) 上半身グループ (腰を軸にハイクアウト・タック動作)
  const upper = new THREE.Group();
  upper.position.set(0, 0.08, 0.01);
  g.add(upper);
  g.userData.upper = upper;

  // 解剖学的Lathe胴体 (黒ウェットスーツ + 自然な肩ライン)
  const torsoMesh = new THREE.Mesh(getHumanTorsoGeo(isFemale), top_);
  upper.add(torsoMesh);

  // 3) 立体セーリングPFD (胴体にぴったり沿うスリムな面取り曲面フォームパネル + 曲面サイドガセット + 肩ストラップ + 腰バックル)
  const pw = 0.258 * shScale;
  const pfdDepthScale = isFemale ? 0.94 : 1.0;
  const pfdZFront = -0.106 * pfdDepthScale;
  const pfdZBack = 0.100 * pfdDepthScale;
  const pfdFront = new THREE.Mesh(getHumanPfdPanelGeo(pw, 0.244, 0.021, -1), bibPanelMat);
  pfdFront.position.set(0, 0.362, pfdZFront);
  pfdFront.rotation.x = 0.015;
  upper.add(pfdFront);

  const pfdBack = new THREE.Mesh(getHumanPfdPanelGeo(pw * 1.02, 0.250, 0.021, 1), bibPanelMat);
  pfdBack.position.set(0, 0.366, pfdZBack);
  pfdBack.rotation.x = -0.015;
  upper.add(pfdBack);

  for (const s of [-1, 1]) {
    const sideArc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.076 * pfdDepthScale, 0.080 * pfdDepthScale, 0.198, 14, 1, false, s > 0 ? 0.12 : Math.PI - 0.12, Math.PI - 0.24),
      pfdSub
    );
    sideArc.scale.set(0.52, 1, 1.15);
    sideArc.position.set(s * 0.118 * shScale, 0.354, -0.003);
    upper.add(sideArc);

    const strapCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(s * 0.086 * shScale, 0.468, pfdZFront + 0.010),
      new THREE.Vector3(s * 0.094 * shScale, 0.532, -0.044 * pfdDepthScale),
      new THREE.Vector3(s * 0.096 * shScale, 0.552,  0.000),
      new THREE.Vector3(s * 0.094 * shScale, 0.532,  0.044 * pfdDepthScale),
      new THREE.Vector3(s * 0.086 * shScale, 0.472, pfdZBack - 0.010),
    ]);
    const shStrap = new THREE.Mesh(new THREE.TubeGeometry(strapCurve, 14, 0.019 * shScale, 8, false), pfd);
    shStrap.scale.set(1.25, 0.72, 1.0);
    upper.add(shStrap);

    const sideStr = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.020, 0.138 * pfdDepthScale), strapDark);
    sideStr.position.set(s * 0.142 * shScale, 0.312, -0.003);
    upper.add(sideStr);
  }
  const waistCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.252, pfdZFront - 0.010),
    new THREE.Vector3(0.116 * shScale, 0.252, -0.074 * pfdDepthScale),
    new THREE.Vector3(0.138 * shScale, 0.252, -0.003),
    new THREE.Vector3(0.116 * shScale, 0.252,  0.072 * pfdDepthScale),
    new THREE.Vector3(0, 0.252, pfdZBack + 0.010),
    new THREE.Vector3(-0.116 * shScale, 0.252,  0.072 * pfdDepthScale),
    new THREE.Vector3(-0.138 * shScale, 0.252, -0.003),
    new THREE.Vector3(-0.116 * shScale, 0.252, -0.074 * pfdDepthScale),
  ], true);
  upper.add(new THREE.Mesh(new THREE.TubeGeometry(waistCurve, 26, 0.010, 6, true), strapDark));
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.025, 0.013), buckleM);
  buckle.position.set(0, 0.252, pfdZFront - 0.015);
  upper.add(buckle);

  // 4) 腕・前腕・フィンガーレスセーリンググローブ (胴体肩ラインから滑らかに接続)
  for (const s of [-1, 1]) {
    const sh = [s * 0.160 * shScale, 0.464, -0.004];
    const armG = new THREE.Group();
    armG.position.set(sh[0], sh[1], sh[2]);
    upper.add(armG);
    if (s === -1) upper.userData.armL = armG;
    else upper.userData.armR = armG;

    const el = [s * 0.024 * shScale, -0.172, -0.074];
    const cuffPt = [el[0] * 0.85, el[1] * 0.85, el[2] * 0.85];
    const wr = [s * (-0.056 * shScale), -0.210 + (s > 0 ? 0.016 : 0), -0.244];
    const ha = [s * (-0.074 * shScale), -0.216 + (s > 0 ? 0.016 : 0), -0.283];

    taperLimb(armG, top_, 0.047 * shScale, 0.036 * shScale, [0, 0, 0], cuffPt, 0.94, true);
    taperLimb(armG, suitPanel, 0.0385 * shScale, 0.037 * shScale, cuffPt, el, 0.94, false);
    taperLimb(armG, skinM, 0.034 * shScale, 0.024 * shScale, el, wr, 0.92, true);

    if (s === -1) {
      const watchBand = new THREE.Mesh(new THREE.CylinderGeometry(0.027 * shScale, 0.027 * shScale, 0.015, 14), strapDark);
      watchBand.position.set(wr[0], wr[1], wr[2] + 0.016); watchBand.rotation.x = Math.PI / 2; armG.add(watchBand);
      const watchFace = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.007, 14), frameM);
      watchFace.position.set(wr[0] - 0.015, wr[1] + 0.015, wr[2] + 0.016); watchFace.rotation.z = 0.7; armG.add(watchFace);
    }

    const wristStrap = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.025, 0.020, 12), glove);
    wristStrap.position.set(wr[0], wr[1], wr[2] - 0.008); wristStrap.rotation.x = Math.PI / 2; armG.add(wristStrap);
    ell(armG, glove, 0.025, 0.018, 0.032, ha[0], ha[1], ha[2]);
    ell(armG, gloveGrip, 0.023, 0.013, 0.028, ha[0], ha[1] - 0.006, ha[2] - 0.004);
    for (let f = 0; f < 4; f++) {
      const fx = ha[0] + (f - 1.5) * 0.0102;
      taperLimb(armG, glove, 0.0070, 0.0064, [fx, ha[1] + 0.004, ha[2] - 0.023], [fx, ha[1] - 0.005, ha[2] - 0.033], 1, false);
      taperLimb(armG, skinM, 0.0060, 0.0050, [fx, ha[1] - 0.005, ha[2] - 0.033], [fx, ha[1] - 0.014, ha[2] - 0.040], 1, true);
    }
    taperLimb(armG, glove, 0.0080, 0.0070, [ha[0] - s * 0.019, ha[1] + 0.003, ha[2] - 0.006], [ha[0] - s * 0.015, ha[1] + 0.008, ha[2] - 0.023], 1, false);
    taperLimb(armG, skinM, 0.0066, 0.0056, [ha[0] - s * 0.015, ha[1] + 0.008, ha[2] - 0.023], [ha[0] - s * 0.011, ha[1] + 0.009, ha[2] - 0.034], 1, true);
  }

  // 5) 首・立体頭部 (自然なアスリート首バランス + 顔テクスチャ + 端正な鼻/耳 + 完全フィットキャップ + ラップサングラス)
  taperLimb(upper, skinM, isFemale ? 0.040 : 0.046, isFemale ? 0.035 : 0.040, [0, 0.540, -0.005], [0, 0.625, -0.012], 0.94, false);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.046 * shScale, 0.056 * shScale, 0.038, 18), top_);
  collar.position.set(0, 0.562, -0.006); upper.add(collar);

  const head = new THREE.Group();
  head.position.set(0, 0.680, -0.016);
  upper.add(head);
  g.userData.head = head;

  const headMesh = new THREE.Mesh(getHumanHeadGeo(isFemale), faceMat);
  head.add(headMesh);

  // さりげない端正な鼻筋・鼻先・耳
  const hs = isFemale ? 0.94 : 1.0;
  taperLimb(head, skinM, 0.0055 * hs, 0.0072 * hs, [0, 0.010 * hs, -0.078 * hs], [0, -0.017 * hs, -0.086 * hs], 0.80, true);
  for (const s of [-1, 1]) {
    const ear = ell(head, skinM, 0.009 * hs, 0.020 * hs, 0.013 * hs, s * 0.072 * hs, -0.006 * hs, 0.004 * hs);
    ear.rotation.y = s * 0.24;
  }

  // 髪型 (男性: 襟足すっきり短髪 / 女性: サイドロック＋キャップ後部から流れるポニーテール)
  ell(head, hairM, 0.062 * hs, 0.032 * hs, 0.030 * hs, 0, -0.012 * hs, 0.052 * hs);
  for (const s of [-1, 1]) {
    const sideLock = ell(head, hairM, 0.009 * hs, (isFemale ? 0.036 : 0.018) * hs, 0.018 * hs, s * 0.068 * hs, (isFemale ? -0.006 : 0.010) * hs, -0.008 * hs);
    sideLock.rotation.z = -s * 0.08;
  }
  if (isFemale) {
    const hairTie = new THREE.Mesh(new THREE.TorusGeometry(0.015, 0.0045, 8, 14), smat(0xc9382b, 0.55));
    hairTie.position.set(0, 0.006, 0.084); head.add(hairTie);
    const ponyCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.006, 0.086),
      new THREE.Vector3(0, -0.018, 0.114),
      new THREE.Vector3(0, -0.064, 0.126),
      new THREE.Vector3(0, -0.122, 0.116),
      new THREE.Vector3(0, -0.158, 0.102),
    ]);
    taperLimb(head, hairM, 0.020, 0.024, [0, 0.006, 0.086], [0, -0.042, 0.121], 0.88, true);
    taperLimb(head, hairM, 0.023, 0.015, [0, -0.042, 0.121], [0, -0.108, 0.120], 0.85, true);
    taperLimb(head, hairM, 0.015, 0.0065, [0, -0.108, 0.120], [0, -0.156, 0.105], 0.82, true);
    const strand = new THREE.Mesh(new THREE.TubeGeometry(ponyCurve, 12, 0.007, 6, false), hairM);
    strand.position.x = 0.011; head.add(strand);
  }

  // 偏光ラップアラウンド・スポーツサングラス (顔カーブにフィット)
  const browCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.070 * hs, 0.015 * hs, -0.024 * hs),
    new THREE.Vector3(-0.056 * hs, 0.022 * hs, -0.070 * hs),
    new THREE.Vector3(0,           0.024 * hs, -0.083 * hs),
    new THREE.Vector3(0.056 * hs,  0.022 * hs, -0.070 * hs),
    new THREE.Vector3(0.070 * hs,  0.015 * hs, -0.024 * hs),
  ]);
  head.add(new THREE.Mesh(new THREE.TubeGeometry(browCurve, 18, 0.0032, 6, false), frameM));
  for (const s of [-1, 1]) {
    const lns = ell(head, lensM, 0.026 * hs, 0.0125 * hs, 0.007 * hs, s * 0.027 * hs, 0.011 * hs, -0.079 * hs);
    lns.rotation.y = s * 0.30; lns.rotation.z = -s * 0.04;
    const temple = new THREE.CatmullRomCurve3([
      new THREE.Vector3(s * 0.060 * hs, 0.020 * hs, -0.066 * hs),
      new THREE.Vector3(s * 0.074 * hs, 0.015 * hs, -0.022 * hs),
      new THREE.Vector3(s * 0.073 * hs, 0.010 * hs,  0.016 * hs),
      new THREE.Vector3(s * 0.070 * hs, 0.000 * hs,  0.023 * hs),
    ]);
    head.add(new THREE.Mesh(new THREE.TubeGeometry(temple, 10, 0.0026, 5, false), frameM));
  }

  // フィット型6パネル・セーリングキャップ (頭頂全体を確実に覆う深めクラウン＋シームレス曲線バイザー)
  const capMat = smat(hat, 0.76);
  const capTrim = smat(0x0f2744, 0.72);
  const crown = new THREE.Mesh(new THREE.SphereGeometry(0.084 * hs, 26, 16, 0, Math.PI * 2, 0, Math.PI * 0.56), capMat);
  crown.scale.set(0.99, 1.03, 1.11);
  crown.position.set(0, 0.027 * hs, 0.002);
  crown.rotation.x = -0.05;
  head.add(crown);
  const visor = new THREE.Mesh(getCapVisorGeo(), capMat);
  visor.scale.setScalar(hs);
  head.add(visor);
  ell(head, capMat, 0.0075, 0.004, 0.0075, 0, 0.113 * hs, 0.004);
  const patch = new THREE.Mesh(new THREE.BoxGeometry(0.022 * hs, 0.011 * hs, 0.003), smat(0xc9382b, 0.58));
  patch.position.set(0, 0.062 * hs, -0.088 * hs); patch.rotation.x = -0.34; head.add(patch);
  const backStrap = new THREE.Mesh(new THREE.BoxGeometry(0.044 * hs, 0.010, 0.006), capTrim);
  backStrap.position.set(0, 0.024 * hs, 0.091 * hs); head.add(backStrap);

  if (isFemale) g.scale.setScalar(0.95);
  return g;
}

const ANIMAL = {
  cat: { body: 0xf0a24a, belly: 0xfff0dc, nose: 0xff8fa3 },
  dog: { body: 0xd98b3a, belly: 0xfff5e8, nose: 0x1e1b18 },
  shiba: { body: 0xd98b3a, belly: 0xfff5e8, nose: 0x1e1b18 },
  duck: { body: 0xfffcf5, belly: 0xffffff, nose: 0xff9f1a },
  tanuki: { body: 0x9c6b3b, belly: 0xf7ebd2, nose: 0x24170f },
  rabbit: { body: 0xfdfaf7, belly: 0xffffff, nose: 0xff8fa3 },
  dolphin: { body: 0x38bdf8, belly: 0xf8fafc, nose: 0x0284c7 },
  penguin: { body: 0x27323d, belly: 0xffffff, nose: 0xff9f1c },
  bear: { body: 0x8b5a3c, belly: 0xd8b48c, nose: 0x1a1a1a },
  capybara: { body: 0xa87a4b, belly: 0xc29866, nose: 0x3a2a1a },
};

// ---- オリジナルPFD・レーシングビブステクスチャ ("KAZE" / "BAY CLUB" / "50N") ----
function drawOriginalBibEmblem(ctx, W, H, fg, accent) {
  ctx.save();
  ctx.fillStyle = fg;
  ctx.strokeStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 1) 上部オリジナルマリンブランドエンブレム: 二重の風翼シェブロン + "KAZE"
  ctx.lineWidth = W * 0.011;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(W * 0.41, H * 0.255);
  ctx.lineTo(W * 0.50, H * 0.215);
  ctx.lineTo(W * 0.59, H * 0.255);
  ctx.moveTo(W * 0.44, H * 0.280);
  ctx.lineTo(W * 0.50, H * 0.250);
  ctx.lineTo(W * 0.56, H * 0.280);
  ctx.stroke();

  ctx.font = `900 ${Math.round(W * 0.095)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('KAZE', W * 0.50, H * 0.360);

  // 2) 中央のヨットクラブ風オリジナルラインフレーム + "BAY CLUB"
  ctx.fillStyle = accent;
  ctx.fillRect(W * 0.25, H * 0.445, W * 0.50, H * 0.012);
  ctx.fillRect(W * 0.25, H * 0.618, W * 0.50, H * 0.012);

  ctx.fillStyle = fg;
  ctx.font = `800 ${Math.round(W * 0.072)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('BAY CLUB', W * 0.50, H * 0.535);

  // 3) 下部スペック刻印 ("MARINE GEAR · 50N")
  ctx.globalAlpha = 0.86;
  ctx.font = `700 ${Math.round(W * 0.046)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('MARINE GEAR · 50N', W * 0.50, H * 0.705);
  ctx.restore();
}

const bibTexCache = new Map();
function getBibTex(colorHex = 0x0e52b8) {
  const key = colorHex >>> 0;
  if (bibTexCache.has(key)) return bibTexCache.get(key);
  const W = 512, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const col = new THREE.Color(colorHex);
  const hexStr = '#' + col.getHexString();
  const lum = col.r * 0.3 + col.g * 0.59 + col.b * 0.11;
  const fg = lum > 0.70 ? '#10253f' : '#ffffff';
  const accent = lum > 0.70 ? '#c9382b' : '#f2c96b';
  const seam = '#' + col.clone().multiplyScalar(lum > 0.70 ? 0.84 : 0.76).getHexString();
  const hi = '#' + col.clone().lerp(new THREE.Color(0xffffff), 0.10).getHexString();

  ctx.fillStyle = hexStr;
  ctx.fillRect(0, 0, W, H);

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, hi);
  grad.addColorStop(0.5, 'rgba(0,0,0,0)');
  grad.addColorStop(1, seam);
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1.0;

  ctx.strokeStyle = seam;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(W * 0.13, 0); ctx.lineTo(W * 0.10, H);
  ctx.moveTo(W * 0.87, 0); ctx.lineTo(W * 0.90, H);
  ctx.moveTo(W * 0.11, H * 0.79); ctx.lineTo(W * 0.89, H * 0.79);
  ctx.stroke();

  ctx.strokeStyle = lum > 0.70 ? 'rgba(16,37,63,0.42)' : 'rgba(10,18,28,0.52)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(W * 0.32, H * 0.845); ctx.lineTo(W * 0.68, H * 0.845);
  ctx.stroke();

  drawOriginalBibEmblem(ctx, W, H, fg, accent);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  bibTexCache.set(key, tex);
  return tex;
}

const bibLogoTexCache = new Map();
function getBibLogoTex(colorHex = 0x0e52b8) {
  const key = colorHex >>> 0;
  if (bibLogoTexCache.has(key)) return bibLogoTexCache.get(key);
  const W = 512, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const col = new THREE.Color(colorHex);
  const lum = col.r * 0.3 + col.g * 0.59 + col.b * 0.11;
  const fg = lum > 0.70 ? '#10253f' : '#ffffff';
  const accent = lum > 0.70 ? '#c9382b' : '#f2c96b';
  drawOriginalBibEmblem(ctx, W, H, fg, accent);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  bibLogoTexCache.set(key, tex);
  return tex;
}

// ---- 動物用 胴体曲面フィット型ライフジャケット(脇のアームホールを丸く自然にくぐらせる閉曲面シェル) ----
function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function animalEllipsoidPt(rx, ry, rz, cy, theta, y, pad) {
  const yn = Math.max(-0.94, Math.min(0.94, (y - cy) / ry));
  const ring = Math.sqrt(Math.max(0.02, 1 - yn * yn));
  const ex = (rx + pad) * ring * Math.sin(theta);
  const ez = -(rz + pad) * ring * Math.cos(theta);
  return [ex, y, ez];
}

function getAnimalVestGeo(isRoundPet) {
  const key = isRoundPet ? 'avest_round' : 'avest_slim';
  let g = geoCache.get(key);
  if (g) return g;

  const rx = isRoundPet ? 0.255 : 0.220;
  const ry = isRoundPet ? 0.275 : 0.250;
  const rz = isRoundPet ? 0.235 : 0.190;
  const cy = 0.23;

  const nTheta = 56;
  const prof = [
    { h: 0.00, p: -0.006 },
    { h: 0.02, p:  0.011 },
    { h: 0.07, p:  0.019 },
    { h: 0.22, p:  0.022 },
    { h: 0.50, p:  0.024 },
    { h: 0.78, p:  0.022 },
    { h: 0.93, p:  0.019 },
    { h: 0.98, p:  0.011 },
    { h: 1.00, p: -0.006 },
  ];
  const nV = prof.length - 1;
  const pos = [], uvs = [], idx = [];

  for (let i = 0; i <= nTheta; i++) {
    const theta = (i / nTheta) * Math.PI * 2;
    const dFront = angDiff(theta, 0);
    const dArmL = angDiff(theta, -1.26);
    const dArmR = angDiff(theta,  1.26);

    const yBot = 0.114 - 0.005 * Math.cos(theta);
    // 胸・背中は肩下まで自然に覆い、両脇だけ腕の付け根に合わせて滑らかにU字カーブさせる
    const baseTop = 0.376 - 0.006 * Math.cos(theta);
    const neckScoop = 0.024 * Math.exp(-(dFront * dFront) / (0.38 * 0.38));
    const armScoop = 0.145 * (
      Math.exp(-(dArmL * dArmL) / (0.43 * 0.43)) +
      Math.exp(-(dArmR * dArmR) / (0.43 * 0.43))
    );
    const yTop = Math.max(yBot + 0.070, baseTop - neckScoop - armScoop);

    for (let j = 0; j <= nV; j++) {
      const y = yBot + (yTop - yBot) * prof[j].h;
      const [px, py, pz] = animalEllipsoidPt(rx, ry, rz, cy, theta, y, prof[j].p);
      pos.push(px, py, pz);
      uvs.push(i / nTheta, prof[j].h);
    }
  }

  const stride = nV + 1;
  for (let i = 0; i < nTheta; i++) {
    for (let j = 0; j < nV; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const c = (i + 1) * stride + j;
      const d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }

  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  geoCache.set(key, g);
  return g;
}

// 動物ベスト中央(胸・背中)の曲面密着ロゴパッチ (脇には一切かからない)
function getAnimalLogoPatchGeo(isRoundPet, isBack) {
  const key = `alogopatch_${isRoundPet ? 'r' : 's'}_${isBack ? 'b' : 'f'}`;
  let g = geoCache.get(key);
  if (g) return g;

  const rx = isRoundPet ? 0.255 : 0.220;
  const ry = isRoundPet ? 0.275 : 0.250;
  const rz = isRoundPet ? 0.235 : 0.190;
  const cy = 0.23;

  const nu = 16, nv = 10;
  const centerTheta = isBack ? Math.PI : 0;
  const halfSpan = 0.48;
  const y0 = 0.165, y1 = isBack ? 0.358 : 0.342;
  const pos = [], uvs = [], idx = [];

  for (let i = 0; i <= nu; i++) {
    const f = i / nu;
    const theta = centerTheta - halfSpan + f * halfSpan * 2;
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      const y = y0 + (y1 - y0) * v;
      const [px, py, pz] = animalEllipsoidPt(rx, ry, rz, cy, theta, y, 0.0265);
      pos.push(px, py, pz);
      uvs.push(1 - f, v);
    }
  }

  const stride = nv + 1;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const c = (i + 1) * stride + j;
      const d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }

  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  geoCache.set(key, g);
  return g;
}

// 動物ベストの曲面フィット肩ストラップ＆腰ベルトジオメトリ
function getAnimalStrapGeo(isRoundPet, side) {
  const key = `astrap_${isRoundPet ? 'r' : 's'}_${side > 0 ? 'R' : 'L'}`;
  let g = geoCache.get(key);
  if (g) return g;

  const rx = isRoundPet ? 0.255 : 0.220;
  const ry = isRoundPet ? 0.275 : 0.250;
  const rz = isRoundPet ? 0.235 : 0.190;
  const cy = 0.23;

  const pts = [];
  const steps = 12;
  for (let k = 0; k <= steps; k++) {
    const u = k / steps;
    const ang = -0.96 + u * 1.92;
    const xBase = side * (0.114 * (isRoundPet ? 1.0 : 0.88));
    const nx = xBase / (rx + 0.018);
    const rem = Math.sqrt(Math.max(0.05, 1 - nx * nx));
    const y = cy + (ry + 0.016) * rem * Math.cos(ang * 1.08) * 0.94;
    const z = (rz + 0.019) * rem * Math.sin(ang * 1.10);
    pts.push(new THREE.Vector3(xBase, Math.max(0.29, y), z));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  g = new THREE.TubeGeometry(curve, 16, 0.022, 8, false);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setX(i, xBaseAdjust(x, side * 0.114 * (isRoundPet ? 1.0 : 0.88), 1.40));
  }
  g.computeVertexNormals();
  geoCache.set(key, g);
  return g;
}
function xBaseAdjust(x, center, mult) { return center + (x - center) * mult; }

function getAnimalWaistBeltGeo(isRoundPet) {
  const key = `abelt_${isRoundPet ? 'r' : 's'}`;
  let g = geoCache.get(key);
  if (g) return g;
  const rx = isRoundPet ? 0.255 : 0.220;
  const ry = isRoundPet ? 0.275 : 0.250;
  const rz = isRoundPet ? 0.235 : 0.190;
  const cy = 0.23;
  const pts = [];
  const N = 28;
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * Math.PI * 2;
    const y = 0.132 - 0.004 * Math.cos(theta);
    const [px, py, pz] = animalEllipsoidPt(rx, ry, rz, cy, theta, y, 0.023);
    pts.push(new THREE.Vector3(px, py, pz));
  }
  g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 36, 0.010, 6, true);
  geoCache.set(key, g);
  return g;
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

  const isRoundPet = type === 'cat' || type === 'dog' || type === 'shiba' || type === 'duck' || type === 'tanuki' || type === 'rabbit' || type === 'dolphin' || type === 'penguin';
  g.userData.isRoundPet = isRoundPet;

  // 1) 上半身グループ (風速に応じて腰から上を海側へ反らせてハイクアウトする)
  const upper = new THREE.Group();
  upper.position.set(0, 0.08, 0.01);
  g.add(upper);
  g.userData.upper = upper;

  // 2) 下半身・まるっこい足:
  if (isRoundPet) {
    ell(upper, bodyM, 0.19, 0.10, 0.16, 0, 0.04, 0.0);
    for (const s of [-1, 1]) {
      if (type === 'duck' || type === 'penguin') {
        sph(upper, A.nose, 0.072, 0.036, 0.088, s * 0.102, 0.012, -0.145);
        sph(upper, 0xf2850c, 0.030, 0.022, 0.045, s * 0.102 - 0.028, 0.008, -0.185);
        sph(upper, A.nose, 0.032, 0.024, 0.050, s * 0.102, 0.008, -0.192);
        sph(upper, 0xf2850c, 0.030, 0.022, 0.045, s * 0.102 + 0.028, 0.008, -0.185);
      } else if (type === 'dolphin') {
        sph(upper, A.body, 0.064, 0.040, 0.082, s * 0.098, 0.012, -0.140);
        sph(upper, A.belly, 0.048, 0.030, 0.052, s * 0.098, 0.008, -0.178);
      } else if (type === 'tanuki') {
        sph(upper, 0x3b2314, 0.068, 0.056, 0.070, s * 0.105, 0.015, -0.132);
        sph(upper, 0x24170f, 0.052, 0.042, 0.038, s * 0.105, 0.011, -0.178);
      } else {
        sph(upper, A.body, 0.068, 0.058, 0.068, s * 0.105, 0.015, -0.130);
        sph(upper, A.belly, 0.052, 0.042, 0.035, s * 0.105, 0.012, -0.176);
        sph(upper, (type === 'cat' || type === 'rabbit') ? 0xff8fa3 : 0x4a3525, 0.024, 0.020, 0.016, s * 0.105, 0.009, -0.196);
      }
    }
  } else {
    ell(g, bodyM, 0.19, 0.11, 0.16, 0, 0.06, 0.01);
    for (const s of [-1, 1]) {
      cap(g, A.body, 0.048, 0.065, s * 0.095, 0.025, -0.10, 0.55, 0, 0);
      ell(g, bellyM, 0.044, 0.032, 0.052, s * 0.095, -0.015, -0.155);
    }
  }

  // まるっこい胴体 & おなか (おなか球がライフジャケット前面を突き抜けないよう胴体表面に沿わせる)
  if (isRoundPet) {
    sph(upper, A.body, 0.255, 0.275, 0.235, 0, 0.23, 0.0);
    sph(upper, A.belly, 0.175, 0.205, 0.105, 0, 0.24, -0.132);
  } else {
    sph(upper, A.body, 0.22, 0.25, 0.19, 0, 0.23, -0.01);
    sph(upper, A.belly, 0.14, 0.17, 0.08, 0, 0.24, -0.112);
  }

  // 動物キャラクター用: 胴体の丸みにぴったり沿い、脇のアームホールも自然にくり抜かれた立体ライフジャケット
  {
    const bibMain = smat(jacket, 0.54);
    const bibDark = smat(0x161b22, 0.80);
    const buckleMat = smat(0x232a35, 0.42, 0.25);
    const logoMat = new THREE.MeshStandardMaterial({
      map: getBibLogoTex(jacket),
      transparent: true,
      alphaTest: 0.05,
      roughness: 0.52,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });

    upper.add(new THREE.Mesh(getAnimalVestGeo(isRoundPet), bibMain));
    upper.add(new THREE.Mesh(getAnimalLogoPatchGeo(isRoundPet, false), logoMat));
    upper.add(new THREE.Mesh(getAnimalLogoPatchGeo(isRoundPet, true), logoMat));
    for (const s of [-1, 1]) {
      upper.add(new THREE.Mesh(getAnimalStrapGeo(isRoundPet, s), bibMain));
    }
    upper.add(new THREE.Mesh(getAnimalWaistBeltGeo(isRoundPet), bibDark));
    const rzW = (isRoundPet ? 0.235 : 0.190) * Math.sqrt(1 - Math.pow((0.128 - 0.23) / (isRoundPet ? 0.275 : 0.250), 2));
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.028, 0.016), buckleMat);
    buckle.position.set(0, 0.128, -(rzW + 0.028));
    upper.add(buckle);
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
  if (type !== 'penguin' && type !== 'duck') sph(head, A.nose, 0.032, 0.024, 0.026, 0, -0.04, -hs[2] - 0.005);
  sph(head, 0xff9db0, 0.042, 0.026, 0.012, -0.15, -0.03, -hs[2] + 0.06); // ほっぺ
  sph(head, 0xff9db0, 0.042, 0.026, 0.012, 0.15, -0.03, -hs[2] + 0.06);
  // 前足(おてて)/翼: 待機モーションで動かせるよう armL / armR グループ化
  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-0.22, 0.27, -0.08);
  armR.position.set(0.22, 0.27, -0.08);
  upper.add(armL); upper.add(armR);
  upper.userData.armL = armL;
  upper.userData.armR = armR;
  if (type === 'duck') {
    // アヒルのぷっくりした可愛い白い羽(つばさ)
    for (const [grp, s] of [[armL, -1], [armR, 1]]) {
      const w1 = sph(grp, A.body, 0.056, 0.105, 0.095, s * 0.025, -0.01, -0.045);
      w1.rotation.z = -s * 0.35; w1.rotation.x = 0.35;
      const w2 = sph(grp, A.belly, 0.042, 0.075, 0.078, s * 0.032, -0.025, -0.095);
      w2.rotation.z = -s * 0.28; w2.rotation.x = 0.45;
    }
  } else if (type === 'dolphin') {
    // イルカの可愛い胸ビレ(フリッパー)
    for (const [grp, s] of [[armL, -1], [armR, 1]]) {
      const fl = sph(grp, A.body, 0.045, 0.115, 0.088, s * 0.035, -0.015, -0.045);
      fl.rotation.z = -s * 0.48; fl.rotation.x = 0.32;
      const flTip = sph(grp, A.nose, 0.032, 0.075, 0.068, s * 0.052, -0.035, -0.085);
      flTip.rotation.z = -s * 0.42; flTip.rotation.x = 0.40;
    }
  } else if (type === 'penguin') {
    // ペンギンのパタパタ動く可愛いフリッパー翼(表は濃紺グレー、内側は白)
    for (const [grp, s] of [[armL, -1], [armR, 1]]) {
      const fl = sph(grp, A.body, 0.044, 0.128, 0.084, s * 0.034, -0.015, -0.038);
      fl.rotation.z = -s * 0.42; fl.rotation.x = 0.26;
      const flIn = sph(grp, A.belly, 0.026, 0.095, 0.062, s * 0.016, -0.020, -0.056);
      flIn.rotation.z = -s * 0.40; flIn.rotation.x = 0.26;
    }
  } else if (type === 'tanuki') {
    // タヌキのこげ茶色のおてて
    for (const [grp, s] of [[armL, -1], [armR, 1]]) {
      sph(grp, A.body, 0.065, 0.062, 0.070, s * 0.015, -0.005, -0.055);
      sph(grp, 0x3b2314, 0.054, 0.048, 0.046, s * 0.015, -0.010, -0.108);
    }
  } else if (isRoundPet) {
    for (const [grp, s] of [[armL, -1], [armR, 1]]) {
      sph(grp, A.body, 0.066, 0.062, 0.072, s * 0.015, -0.005, -0.065);
      sph(grp, A.belly, 0.050, 0.046, 0.042, s * 0.015, -0.010, -0.112);
    }
  } else {
    cap(armL, A.body, 0.048, 0.14, 0, 0.01, -0.05, Math.PI / 2.3, 0, -0.45);
    cap(armR, A.body, 0.048, 0.14, 0, 0.01, -0.05, Math.PI / 2.3, 0, 0.45);
  }
  const tailGrp = new THREE.Group();
  tailGrp.position.set(0, 0.16, 0.23);
  upper.add(tailGrp);
  upper.userData.tail = tailGrp;
  switch (type) {
    case 'cat':
      cone(head, A.body, 0.075, 0.145, -0.145, 0.21, 0, 0, 0.35); cone(head, A.body, 0.075, 0.145, 0.145, 0.21, 0, 0, -0.35);
      cone(head, 0xff8fa3, 0.042, 0.095, -0.145, 0.20, -0.03, 0, 0.35); cone(head, 0xff8fa3, 0.042, 0.095, 0.145, 0.20, -0.03, 0, -0.35);
      cap(tailGrp, A.body, 0.036, 0.10, 0.0, -0.02, 0.01, 0.85, 0, 0);
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
      sph(tailGrp, A.body, 0.085, 0.095, 0.095, 0, 0.06, 0.025);
      sph(tailGrp, A.belly, 0.065, 0.065, 0.065, 0, 0.105, 0.015);
      g.scale.setScalar(0.92);
      break;
    case 'duck': {
      // ぷっくり膨らんだ真っ白なもちもちほっぺ
      sph(head, A.body, 0.152, 0.105, 0.105, -0.095, -0.042, -hs[2] + 0.085);
      sph(head, A.body, 0.152, 0.105, 0.105, 0.095, -0.042, -hs[2] + 0.085);
      // 可愛らしい山吹〜オレンジ色の平たく丸みのあるアヒルくちばし(上くちばし＋下くちばし＋口角の笑顔ライン)
      const billTop = sph(head, A.nose, 0.118, 0.044, 0.105, 0, -0.038, -hs[2] - 0.018);
      billTop.rotation.x = 0.06;
      const billTip = sph(head, 0xffaa2b, 0.095, 0.034, 0.065, 0, -0.042, -hs[2] - 0.055);
      billTip.rotation.x = 0.08;
      const billBot = sph(head, 0xe8820c, 0.092, 0.028, 0.082, 0, -0.062, -hs[2] - 0.005);
      billBot.rotation.x = 0.10;
      // くちばしの小さな鼻孔
      sph(head, 0xc96504, 0.010, 0.007, 0.012, -0.028, -0.020, -hs[2] - 0.045);
      sph(head, 0xc96504, 0.010, 0.007, 0.012, 0.028, -0.020, -hs[2] - 0.045);
      // 頭のてっぺんのふわふわアホ毛(冠羽3本)
      cap(head, A.body, 0.028, 0.065, 0, 0.235, 0.01, -0.25, 0, 0);
      cap(head, A.body, 0.022, 0.052, -0.032, 0.225, 0.015, -0.20, 0, 0.35);
      cap(head, A.body, 0.022, 0.052, 0.032, 0.225, 0.015, -0.20, 0, -0.35);
      // ピンと上を向いた可愛いアヒルしっぽ
      cone(tailGrp, A.body, 0.085, 0.13, 0, 0.04, 0.03, 0.95, 0);
      sph(tailGrp, A.belly, 0.075, 0.065, 0.075, 0, 0.01, 0.01);
      g.scale.setScalar(0.92);
      break;
    }
    case 'tanuki': {
      // タヌキ: 目の周りの可愛いこげ茶色のアイマスク模様 + クリーム色のほっぺ＆マズル + 頭の葉っぱ + 太いしましましっぽ
      sph(head, A.belly, 0.165, 0.105, 0.095, -0.095, -0.040, -hs[2] + 0.082);
      sph(head, A.belly, 0.165, 0.105, 0.095, 0.095, -0.040, -hs[2] + 0.082);
      sph(head, A.belly, 0.110, 0.082, 0.095, 0, -0.052, -hs[2] + 0.048);
      // 目の周りのこげ茶色たれパンダ風アイパッチ
      const patchL = sph(head, 0x3b2314, 0.076, 0.068, 0.035, -0.092, 0.016, -hs[2] + 0.028);
      patchL.rotation.z = 0.22;
      const patchR = sph(head, 0x3b2314, 0.076, 0.068, 0.035, 0.092, 0.016, -hs[2] + 0.028);
      patchR.rotation.z = -0.22;
      // 大きく輝く黒目とハイライトをアイパッチの前面に再配置
      sph(head, 0x111111, 0.035, 0.046, 0.022, -0.09, 0.02, -hs[2] - 0.004);
      sph(head, 0x111111, 0.035, 0.046, 0.022, 0.09, 0.02, -hs[2] - 0.004);
      sph(head, 0xffffff, 0.012, 0.015, 0.012, -0.082, 0.038, -hs[2] - 0.018);
      sph(head, 0xffffff, 0.012, 0.015, 0.012, 0.098, 0.038, -hs[2] - 0.018);
      // 黒いツヤ鼻
      sph(head, A.nose, 0.038, 0.028, 0.032, 0, -0.034, -hs[2] - 0.016);
      // 丸みのある可愛いタヌキ耳(縁がこげ茶色)
      sph(head, 0x3b2314, 0.078, 0.088, 0.048, -0.165, 0.185, 0.01);
      sph(head, 0x3b2314, 0.078, 0.088, 0.048, 0.165, 0.185, 0.01);
      sph(head, A.belly, 0.046, 0.054, 0.032, -0.165, 0.180, -0.015);
      sph(head, A.belly, 0.046, 0.054, 0.032, 0.165, 0.180, -0.015);
      // 頭のてっぺんにちょこんと乗った緑の葉っぱ
      const leaf = sph(head, 0x22c55e, 0.075, 0.018, 0.048, 0.01, 0.232, -0.02);
      leaf.rotation.z = -0.18; leaf.rotation.y = 0.35;
      // ぷっくり太いタヌキしっぽ
      sph(tailGrp, A.body, 0.105, 0.105, 0.145, 0, 0.03, 0.06);
      sph(tailGrp, 0x3b2314, 0.092, 0.092, 0.095, 0, 0.045, 0.125);
      g.scale.setScalar(0.92);
      break;
    }
    case 'rabbit': {
      // ウサギ: ぷっくり白ほっぺ + 長くて可愛いピン耳(揺れる) + まんまる白ポンポンしっぽ
      sph(head, A.body, 0.148, 0.098, 0.095, -0.092, -0.042, -hs[2] + 0.082);
      sph(head, A.body, 0.148, 0.098, 0.095, 0.092, -0.042, -hs[2] + 0.082);
      sph(head, A.belly, 0.095, 0.072, 0.082, 0, -0.048, -hs[2] + 0.042);
      sph(head, A.nose, 0.032, 0.024, 0.028, 0, -0.032, -hs[2] - 0.014);
      cap(head, A.body, 0.054, 0.25, -0.088, 0.32, 0.01, -0.08, 0, 0.14);
      cap(head, A.body, 0.054, 0.25, 0.088, 0.32, 0.01, -0.08, 0, -0.14);
      cap(head, 0xffb7c5, 0.030, 0.19, -0.088, 0.315, -0.022, -0.08, 0, 0.14);
      cap(head, 0xffb7c5, 0.030, 0.19, 0.088, 0.315, -0.022, -0.08, 0, -0.14);
      // ふわふわの丸いポンポンしっぽ
      sph(tailGrp, 0xffffff, 0.098, 0.098, 0.098, 0, 0.02, 0.02);
      g.scale.setScalar(0.92);
      break;
    }
    case 'dolphin': {
      // イルカ: 爽やかなマリンブルーのツヤ肌 + 白いおなか＆口元 + 可愛い吻(くちばし) + 背ビレ + 尾ビレ
      sph(head, A.belly, 0.195, 0.115, 0.165, 0, -0.068, -hs[2] + 0.125);
      // イルカの可愛い丸みのある口吻(ロストラム)
      const snoutTop = sph(head, A.body, 0.096, 0.048, 0.115, 0, -0.036, -hs[2] - 0.022);
      snoutTop.rotation.x = 0.08;
      const snoutBot = sph(head, A.belly, 0.084, 0.035, 0.098, 0, -0.058, -hs[2] - 0.012);
      snoutBot.rotation.x = 0.10;
      // 頭頂部の小さな噴気孔アクセント
      sph(head, A.nose, 0.022, 0.008, 0.016, 0, 0.224, -0.02);
      // 背中の可愛い背ビレ
      const dorsal = cone(upper, A.nose, 0.065, 0.16, 0, 0.33, 0.22, -0.58, 0);
      dorsal.scale.x = 0.028;
      // 水平に広がった可愛いイルカの尾ビレ(フルーク)
      const flukeL = sph(tailGrp, A.body, 0.115, 0.026, 0.068, -0.072, 0.01, 0.055);
      flukeL.rotation.y = 0.32;
      const flukeR = sph(tailGrp, A.body, 0.115, 0.026, 0.068, 0.072, 0.01, 0.055);
      flukeR.rotation.y = -0.32;
      sph(tailGrp, A.nose, 0.048, 0.038, 0.075, 0, 0.01, 0.02);
      g.scale.setScalar(0.92);
      break;
    }
    case 'penguin': {
      // ペンギン: ハート型の白い顔模様 + 黄色いほっぺ/首元のコウテイペンギン風アクセント + 山吹色くちばし + 小さな丸しっぽ
      sph(head, A.belly, 0.135, 0.138, 0.082, -0.072, -0.015, -hs[2] + 0.062);
      sph(head, A.belly, 0.135, 0.138, 0.082, 0.072, -0.015, -hs[2] + 0.062);
      sph(head, A.belly, 0.165, 0.095, 0.088, 0, -0.068, -hs[2] + 0.068);
      // コウテイペンギン風の淡いレモンイエロー頬アクセント
      sph(head, 0xfde047, 0.052, 0.068, 0.042, -0.175, -0.045, -hs[2] + 0.115);
      sph(head, 0xfde047, 0.052, 0.068, 0.042, 0.175, -0.045, -hs[2] + 0.115);
      // 白い顔マスクの前面に輝く黒目とピンクほっぺをくっきり配置
      sph(head, 0x111111, 0.035, 0.046, 0.022, -0.092, 0.020, -hs[2] - 0.008);
      sph(head, 0x111111, 0.035, 0.046, 0.022, 0.092, 0.020, -hs[2] - 0.008);
      sph(head, 0xffffff, 0.012, 0.015, 0.012, -0.084, 0.038, -hs[2] - 0.022);
      sph(head, 0xffffff, 0.012, 0.015, 0.012, 0.100, 0.038, -hs[2] - 0.022);
      sph(head, 0xff9db0, 0.042, 0.026, 0.014, -0.148, -0.034, -hs[2] + 0.032);
      sph(head, 0xff9db0, 0.042, 0.026, 0.014, 0.148, -0.034, -hs[2] + 0.032);
      // 丸みのある可愛いオレンジ色のくちばし(上くちばし＋下くちばし)
      const pBillTop = cone(head, A.nose, 0.054, 0.115, 0, -0.028, -hs[2] - 0.048, -Math.PI / 2 + 0.10, 0);
      pBillTop.scale.x = 0.064;
      const pBillBot = sph(head, 0xe8820c, 0.046, 0.024, 0.058, 0, -0.054, -hs[2] - 0.022);
      pBillBot.rotation.x = 0.12;
      // ちょこんと尖ったペンギンのしっぽ
      cone(tailGrp, A.body, 0.072, 0.115, 0, 0.01, 0.02, 1.15, 0);
      g.scale.setScalar(0.92);
      break;
    }
    case 'bear':
      sph(head, A.body, 0.07, 0.07, 0.05, -0.17, 0.17, 0); sph(head, A.body, 0.07, 0.07, 0.05, 0.17, 0.17, 0);
      sph(head, A.belly, 0.1, 0.08, 0.08, 0, -0.05, -hs[2] + 0.08);
      sph(upper, A.body, 0.07, 0.07, 0.07, 0, 0.12, 0.25);
      break;
    case 'capybara':
      sph(head, A.body, 0.14, 0.12, 0.14, 0, -0.04, -hs[2] + 0.1);
      sph(head, A.nose, 0.05, 0.035, 0.03, 0, -0.01, -hs[2] - 0.05);
      sph(head, A.body, 0.045, 0.045, 0.03, -0.14, 0.15, 0.03); sph(head, A.body, 0.045, 0.045, 0.03, 0.14, 0.15, 0.03);
      break;
  }
  return g;
}

// スタート画面等のキャラクタープレビュー用・生き生きとした待機モーション更新ヘルパー
export function animatePreviewFigure(fig, time, phaseOffset = 0, baseRotY = 0) {
  if (!fig) return;
  const t = time + phaseOffset;
  const breath = Math.sin(t * 2.5) * 0.042 + Math.sin(t * 4.2) * 0.018;
  fig.rotation.y = baseRotY + Math.sin(t * 0.9) * 0.10;
  const upper = fig.userData && fig.userData.upper;
  if (upper) {
    upper.rotation.x = breath;
    upper.rotation.z = Math.sin(t * 1.65) * 0.048;
    if (upper.userData.armL && upper.userData.armR) {
      const waveL = Math.sin(t * 2.9) * 0.18;
      const waveR = Math.cos(t * 2.9 + 0.8) * 0.18;
      upper.userData.armL.rotation.set(-0.10 + waveL, 0.06 * Math.cos(t * 2.1), -0.08 + 0.06 * Math.sin(t * 2.4));
      upper.userData.armR.rotation.set(-0.10 + waveR, -0.06 * Math.sin(t * 2.1), 0.08 - 0.06 * Math.cos(t * 2.4));
    }
    if (upper.userData.tail) {
      upper.userData.tail.rotation.y = Math.sin(t * 5.8) * 0.34;
      upper.userData.tail.rotation.x = Math.cos(t * 3.8) * 0.14;
    }
  }
  const head = fig.userData && fig.userData.head;
  if (head) {
    head.rotation.y = Math.sin(t * 1.15) * 0.24 + Math.sin(t * 2.3 + 0.6) * 0.10;
    head.rotation.x = Math.sin(t * 1.55 + 0.4) * 0.11;
    head.rotation.z = Math.cos(t * 1.85) * 0.075;
  }
}

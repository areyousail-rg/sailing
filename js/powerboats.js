// 運営艇・アウター艇・フィニッシュ艇・観覧艇のリアルなモーターボートモデル
// ローカル座標: 船首 +z / 船尾 -z / y=上(喫水線 y=0)
import * as THREE from 'three';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mat = (c, r = 0.5, m = 0, extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, ...extra });
const gelcoat = (c) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12, vertexColors: false });
const glass = new THREE.MeshPhysicalMaterial({ color: 0x1b2c3a, roughness: 0.06, metalness: 0.5, clearcoat: 1 });
const chrome = mat(0xc8ced6, 0.2, 0.95);
const blackM = mat(0x16181b, 0.6, 0.1);
const rubber = mat(0x0f1012, 0.95);
const white = gelcoat(0xf4f6f6);
const alu = mat(0xb8bec6, 0.35, 0.8);
const teak = mat(0xa9855a, 0.7);

function tube(pts, r, m, closed = false) {
  return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), closed), Math.max(12, pts.length * 8), r, 8, closed), m);
}
function box(w, h, d, m, x, y, z) { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); return b; }
function cyl(r, h, m, x, y, z, rx = 0, rz = 0) { const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), m); c.position.set(x, y, z); c.rotation.set(rx, 0, rz); return c; }

function flagMesh(w, h, color, text) {
  const geo = new THREE.PlaneGeometry(w, h, 10, 4);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i) + w / 2; p.setZ(i, Math.sin(x * 3.2) * 0.07 * (x / w)); }
  geo.computeVertexNormals();
  let m;
  if (text) {
    const c = document.createElement('canvas'); c.width = 128; c.height = 80; const x = c.getContext('2d');
    x.fillStyle = color; x.fillRect(0, 0, 128, 80); x.fillStyle = '#fff'; x.font = 'bold 56px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 64, 44);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    m = new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, roughness: 0.9 });
  } else m = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.9, emissive: color, emissiveIntensity: 0.25 });
  const f = new THREE.Mesh(geo, m); f.position.x = w / 2; return f;
}

// 船体ロフト(プレーニングハル)
function hullGroup(L, B, H, hullColor, stripeColor) {
  const g = new THREE.Group();
  const halfB = (z) => { const u = clamp01((z + L / 2) / L); if (u < 0.68) return (B / 2) * (1 - 0.05 * Math.pow(1 - u / 0.68, 2)); const k = (u - 0.68) / 0.32; return (B / 2) * Math.pow(Math.max(0.0001, 1 - k * k), 0.7) + 0.02; };
  const sheer = (z) => { const u = clamp01((z + L / 2) / L); return H + 0.5 * H * Math.pow(u, 3.2); };
  const bottom = (z) => { const u = clamp01((z + L / 2) / L); return -0.5 * H * (1 - Math.pow(Math.max(0, (u - 0.4) / 0.6), 1.5)) + 0.05; };
  const ts = [0, 0.12, 0.25, 0.3, 0.34, 0.5, 0.7, 0.72, 0.8, 0.82, 0.95, 1];
  const ws = [...ts.map((t) => -Math.pow(t, 1 / 1.6)).reverse(), ...ts.slice(1).map((t) => Math.pow(t, 1 / 1.6))];
  const nz = 36, pos = [], col = [], idx = [];
  const hc = new THREE.Color(hullColor), sc = new THREE.Color(stripeColor), bc = new THREE.Color(0x3a1f1c);
  for (let i = 0; i <= nz; i++) {
    const z = -L / 2 + (L * i) / nz, B2 = halfB(z), s = sheer(z), bo = bottom(z);
    for (const w of ws) {
      const t = Math.pow(Math.abs(w), 1.6);
      pos.push(w * B2, bo + (s - bo) * t, z);
      const c = t <= 0.26 ? bc : t >= 0.71 && t <= 0.83 ? sc : hc; col.push(c.r, c.g, c.b);
    }
  }
  const nv = ws.length;
  for (let i = 0; i < nz; i++) for (let j = 0; j < nv - 1; j++) { const a = i * nv + j, b = a + 1, c = a + nv, d = c + 1; idx.push(a, c, b, b, c, d); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  g.add(new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1, side: THREE.DoubleSide })));
  // 船尾板
  const sh = new THREE.Shape(); const Bs = halfB(-L / 2), ss = sheer(-L / 2), bs = bottom(-L / 2);
  sh.moveTo(-Bs, ss); for (const w of ws) sh.lineTo(w * Bs, bs + (ss - bs) * Math.pow(Math.abs(w), 1.6)); sh.lineTo(Bs, ss);
  const tr = new THREE.Mesh(new THREE.ShapeGeometry(sh), white); tr.rotation.y = Math.PI; tr.position.z = -L / 2; g.add(tr);
  // デッキ
  const dpos = [], didx = [], N = 30, M = 10;
  for (let i = 0; i <= N; i++) { const z = -L / 2 + (L * i) / N; for (let j = 0; j <= M; j++) { const w = -1 + (2 * j) / M; dpos.push(w * halfB(z) * 0.985, sheer(z) + 0.04 * (1 - w * w), z); } }
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) { const a = i * (M + 1) + j, b = a + 1, c = a + M + 1, d = c + 1; didx.push(a, c, b, b, c, d); }
  const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(dpos, 3)); dg.setIndex(didx); dg.computeVertexNormals();
  g.add(new THREE.Mesh(dg, new THREE.MeshStandardMaterial({ color: 0xdfe3e2, roughness: 0.8, side: THREE.DoubleSide })));
  // ガンネルのラブレール
  for (const sg of [-1, 1]) {
    const pts = []; for (let i = 0; i <= 24; i++) { const z = -L / 2 + (L * i) / 24; pts.push([sg * halfB(z), sheer(z) + 0.02, z]); }
    g.add(tube(pts, 0.04, mat(0x1a1c20, 0.5)));
  }
  g.userData = { halfB, sheer };
  return g;
}

function outboard(x, z, scale = 1) {
  const g = new THREE.Group();
  g.add(box(0.5, 0.75, 0.55, mat(0xdadee2, 0.4, 0.2), 0, 0.5, 0));
  g.add(box(0.52, 0.2, 0.5, blackM, 0, 0.92, 0));
  g.add(box(0.2, 0.9, 0.3, mat(0xc4c9ce, 0.5, 0.3), 0, -0.25, -0.05));
  const prop = cyl(0.2, 0.03, alu, 0, -0.65, -0.05, Math.PI / 2, 0); g.add(prop);
  g.add(box(0.6, 0.12, 0.45, blackM, 0, 0.1, 0));
  g.position.set(x, 0.55, z); g.rotation.x = 0.05; g.scale.setScalar(scale); return g;
}
function pulpit(g, hb, z0, y) { // 船首の手すり
  const pts = []; for (const k of [0, 0.5, 1]) { const z = z0 + k * 1.6; pts.push([-hb(z) * 0.9, y + 0.75 * (k < 1 ? 1 : 0.85), z]); }
  for (const sg of [-1, 1]) {
    const pp = []; for (let i = 0; i <= 6; i++) { const z = z0 + i * 0.25; pp.push([sg * hb(z) * 0.88, y + 0.7, z]); }
    g.add(tube(pp, 0.018, chrome));
    for (let i = 0; i <= 3; i++) { const z = z0 + i * 0.5; g.add(cyl(0.015, 0.7, chrome, sg * hb(z) * 0.88, y + 0.35, z)); }
  }
}
function cleat(x, y, z) { const g = new THREE.Group(); g.add(box(0.2, 0.025, 0.05, chrome, 0, 0, 0)); g.add(box(0.05, 0.05, 0.05, chrome, 0, 0.03, 0)); g.position.set(x, y, z); return g; }
function fender(x, y, z, color = 0xf8f8f8) { const g = new THREE.Group(); const c = cyl(0.11, 0.65, mat(color, 0.6), 0, -0.3, 0); g.add(c); g.add(cyl(0.012, 0.3, mat(0xdddddd, 0.9), 0, 0.15, 0)); g.position.set(x, y, z); return g; }

// フラグポール
function pole(h, flags) {
  const g = new THREE.Group();
  g.add(cyl(0.035, h, alu, 0, h / 2, 0));
  g.add(cyl(0.05, 0.08, blackM, 0, 0.04, 0));
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), mat(0xe8c14a, 0.3, 0.8)); ball.position.y = h + 0.03; g.add(ball);
  flags.forEach((f, i) => { const fm = flagMesh(f.w || 1.2, f.h || 0.8, f.color, f.text); const h2 = new THREE.Group(); h2.position.set(0.035, h - 0.5 - i * (f.h || 0.8) * 1.15 - (f.dy || 0), 0); h2.add(fm); h2.userData.flag = true; g.add(h2); });
  return g;
}

export function makeMotorboat(type, o = {}) {
  const g = new THREE.Group();
  const flagCfg = o.flags || [];
  if (type === 'committee') {
    // 本部船: 全長約16mのモータークルーザー(サロン + フライブリッジ)。後部に信号マストとヤード
    const L = 16, B = 4.8, H = 1.4;
    const hull = hullGroup(L, B, H, 0xf6f7f7, o.stripe ?? 0x1c3f86); g.add(hull);
    const hb = hull.userData.halfB, sh = hull.userData.sheer;
    // サロン(側面プロファイル押し出し)
    const cs = new THREE.Shape(); cs.moveTo(-5.2, 0); cs.lineTo(3.0, 0); cs.lineTo(3.0, 0.5); cs.lineTo(1.4, 1.9); cs.lineTo(-4.8, 1.9); cs.lineTo(-5.2, 1.7); cs.closePath();
    const cg = new THREE.ExtrudeGeometry(cs, { depth: 3.7, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2 }); cg.rotateY(-Math.PI / 2); cg.translate(1.85, H + 0.05, 0);
    g.add(new THREE.Mesh(cg, white));
    // 船体側面の舷窓とサロンの連続窓
    for (const sg of [-1, 1]) {
      g.add(box(0.03, 0.7, 5.6, glass, sg * 1.9, H + 1.15, -1.6));
      g.add(box(0.03, 0.22, 2.6, glass, sg * (hb(2.6) + 0.01), H - 0.35, 2.6));
    }
    const ws = box(3.4, 0.8, 0.03, glass, 0, H + 1.25, 1.95); ws.rotation.x = -0.86; g.add(ws);
    // フライブリッジ(上部操舵席)+ ハードトップ
    g.add(box(3.6, 0.1, 5.0, white, 0, H + 1.98, -2.4));
    g.add(box(3.2, 0.75, 2.6, white, 0, H + 2.4, -1.6));
    g.add(box(3.0, 0.4, 0.03, glass, 0, H + 2.55, -0.28));
    for (const [x, z] of [[-1.5, -0.4], [1.5, -0.4], [-1.5, -3.0], [1.5, -3.0]]) g.add(cyl(0.035, 1.3, alu, x, H + 3.4, z));
    g.add(box(3.4, 0.08, 3.0, white, 0, H + 4.08, -1.7));
    for (const sg of [-1, 1]) { const pp = []; for (let i = 0; i <= 6; i++) pp.push([sg * 1.75, H + 2.75, -4.6 + i * 0.75]); g.add(tube(pp, 0.025, chrome)); }
    // レーダー・アンテナ
    const radar = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.36, 0.14, 16), mat(0xdee2e6, 0.5)); radar.position.set(0, H + 4.2, -1.2); g.add(radar);
    g.add(cyl(0.02, 1.6, mat(0xf0f0f0, 0.5), 1.3, H + 4.9, -2.6));
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), mat(0xffa500, 0.3, 0, { emissive: 0xff7700, emissiveIntensity: 0.6 })); beacon.position.set(-1.2, H + 4.2, -2.6); g.add(beacon);
    // 後部デッキの信号マスト + ヤード(フラッグはここに揚げる)
    const mast = pole(5.2, flagCfg); mast.position.set(0, H + 0.05, -6.0); g.add(mast);
    g.userData.mast = mast;
    const yard = cyl(0.03, 3.0, alu, 0, 0, 0, 0, Math.PI / 2); yard.position.set(0, H + 4.3, -6.0); g.add(yard);
    // 後部デッキ設備: フラッグボックス・クーラー・スイムプラットフォーム
    g.add(box(0.9, 0.55, 0.55, mat(0xff7a00, 0.6), 1.3, H + 0.3, -6.7));
    g.add(box(0.7, 0.4, 1.0, mat(0x2a2d33, 0.8), -1.3, H + 0.22, -6.6));
    g.add(box(B * 0.9, 0.12, 1.1, mat(0xd8c7a5, 0.8), 0, 0.35, -L / 2 - 0.5));
    g.add(box(0.03, 1.0, 1.4, glass, 0, H + 0.95, -5.27)); // 後部ドア
    pulpit(g, hb, 4.0, sh(4.0));
    for (const [x, z] of [[-2.0, 2.0], [2.0, 2.0], [-2.1, -2.5], [2.1, -2.5], [-1.9, -7.2], [1.9, -7.2]]) g.add(cleat(x, sh(z) + 0.06, z));
    for (const z of [-5.0, -2.0, 1.2]) for (const sg of [-1, 1]) g.add(fender(sg * (hb(z) + 0.05), sh(z) + 0.05, z));
    // 錨
    g.add(box(0.14, 0.1, 0.6, chrome, 0, sh(6.0) + 0.12, 5.9));
  } else if (type === 'outer') {
    const L = 7.6, B = 2.7, H = 0.85;
    const hull = hullGroup(L, B, H, 0xf2f4f5, o.stripe ?? 0xd9531e); g.add(hull);
    const hb = hull.userData.halfB, sh = hull.userData.sheer;
    // センターコンソール + Tトップ
    g.add(box(1.0, 1.0, 0.9, white, 0, H + 0.5, 0.3));
    const sw = box(0.95, 0.5, 0.03, glass, 0, H + 1.2, 0.8); sw.rotation.x = -0.35; g.add(sw);
    for (const [x, z] of [[-0.6, 0.0], [0.6, 0.0], [-0.6, 0.9], [0.6, 0.9]]) g.add(cyl(0.025, 1.9, alu, x, H + 1.0, z));
    g.add(box(1.6, 0.06, 1.8, white, 0, H + 2.0, 0.45));
    // ベンチ
    g.add(box(1.8, 0.35, 0.6, mat(0x2a2f36, 0.8), 0, H + 0.2, -1.6));
    g.add(box(1.8, 0.35, 0.1, mat(0x2a2f36, 0.8), 0, H + 0.55, -1.9));
    const mast = pole(3.6, flagCfg); mast.position.set(0, H + 2.03, 0.45); g.add(mast); g.userData.mast = mast;
    g.add(outboard(0, -L / 2 - 0.15, 1.35));
    pulpit(g, hb, 1.7, sh(1.7));
    for (const z of [-1.0, 1.0]) for (const sg of [-1, 1]) g.add(fender(sg * (hb(z) + 0.05), sh(z) + 0.05, z, 0xff7a00));
  } else if (type === 'cruiser') {
    const L = 13, B = 4.2, H = 1.15;
    const hull = hullGroup(L, B, H, 0xfafafa, o.stripe ?? 0x1e293b); g.add(hull);
    const hb = hull.userData.halfB, sh = hull.userData.sheer;
    // サロン + フライブリッジ
    const cs = new THREE.Shape(); cs.moveTo(-4.2, 0); cs.lineTo(2.2, 0); cs.lineTo(2.2, 0.4); cs.lineTo(1.0, 1.55); cs.lineTo(-3.8, 1.55); cs.lineTo(-4.2, 1.35); cs.closePath();
    const cg = new THREE.ExtrudeGeometry(cs, { depth: 3.1, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2 }); cg.rotateY(-Math.PI / 2); cg.translate(1.55, H + 0.05, 0);
    g.add(new THREE.Mesh(cg, white));
    for (const sg of [-1, 1]) g.add(box(0.03, 0.62, 4.6, glass, sg * 1.6, H + 0.9, -1.7));
    const ws = box(3.0, 0.7, 0.03, glass, 0, H + 1.05, 1.2); ws.rotation.x = -0.92; g.add(ws);
    g.add(box(2.7, 0.1, 3.4, white, 0, H + 1.62, -2.3));
    g.add(box(2.4, 0.9, 2.0, white, 0, H + 2.1, -2.0));
    g.add(box(2.2, 0.42, 0.03, glass, 0, H + 2.15, -0.98));
    g.add(box(2.6, 0.08, 2.4, white, 0, H + 2.58, -1.9));
    const rm = cyl(0.03, 1.8, alu, 0, H + 3.5, -2.7); g.add(rm);
    g.add(box(1.4, 0.05, 0.05, alu, 0, H + 3.2, -2.7));
    const radar = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.12, 16), mat(0xdee2e6, 0.5)); radar.position.set(0, H + 2.7, -1.3); g.add(radar);
    const p = pole(2.2, [{ color: '#d13232', w: 1.0, h: 0.65 }]); p.position.set(0, sh(5.8) + 0.05, 5.6); g.add(p);
    pulpit(g, hb, 2.8, sh(2.8));
    g.add(outboard(-1.0, -L / 2 - 0.2, 1.25)); g.add(outboard(1.0, -L / 2 - 0.2, 1.25));
    for (const z of [-3.5, -1.0, 1.5]) for (const sg of [-1, 1]) g.add(fender(sg * (hb(z) + 0.05), sh(z) + 0.05, z));
  } else { // rib
    const L = 6.6, B = 2.4;
    const g2 = new THREE.Group();
    const half = (z) => { const u = (z + L / 2) / L; return (B / 2) * (u < 0.7 ? 1 : Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.7) / 0.3, 2)))) + 0.02; };
    const tubeMat = mat(o.tube ?? 0x2d3748, 0.7);
    for (const sg of [-1, 1]) {
      const pts = []; for (let i = 0; i <= 14; i++) { const z = -L / 2 + (L * i) / 14; pts.push([sg * (half(z) - 0.0), 0.5 + 0.12 * Math.pow(i / 14, 3), z]); }
      g2.add(tube(pts, 0.34, tubeMat));
    }
    const bow = tube([[-half(L / 2 - 0.1) + 0.1, 0.62, L / 2 - 0.2], [0, 0.66, L / 2 + 0.15], [half(L / 2 - 0.1) - 0.1, 0.62, L / 2 - 0.2]], 0.3, tubeMat); g2.add(bow);
    g2.add(box(B - 0.5, 0.12, L - 0.6, mat(0x9aa3ab, 0.9), 0, 0.28, 0));
    g2.add(box(B - 0.5, 0.45, 0.16, mat(0xe8ecee, 0.5), 0, 0.5, -L / 2 + 0.2));
    g2.add(box(0.7, 0.9, 0.55, white, 0, 0.9, 0.2));
    const sw = box(0.6, 0.3, 0.03, glass, 0, 1.45, 0.45); sw.rotation.x = -0.4; g2.add(sw);
    g2.add(box(0.6, 0.35, 0.5, mat(0x20252b, 0.8), 0, 0.5, -0.9));
    g2.add(outboard(-0.45, -L / 2 - 0.1, 1.2)); g2.add(outboard(0.45, -L / 2 - 0.1, 1.2));
    const p = pole(2.2, flagCfg.length ? flagCfg : [{ color: '#ffffff', w: 0.8, h: 0.5 }]); p.position.set(0, 1.35, -0.6); g2.add(p);
    g2.position.y = -0.05; g.add(g2);
  }
  g.traverse((m) => { if (m.isMesh) { m.castShadow = false; } });
  return g;
}

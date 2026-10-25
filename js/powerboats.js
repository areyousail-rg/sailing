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

// 軽量化: 細い手すり類は断面5角・経路分割を控えめに(見た目はほぼ同じで三角形数を約1/4に)。RIBのチューブ等の太いものだけ断面10角
function tube(pts, r, m, closed = false) {
  return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), closed), Math.max(8, pts.length * 3), r, r > 0.2 ? 10 : 5, closed), m);
}
function box(w, h, d, m, x, y, z) { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); return b; }
function cyl(r, h, m, x, y, z, rx = 0, rz = 0) { const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, r > 0.08 ? 12 : 6), m); c.position.set(x, y, z); c.rotation.set(rx, 0, rz); return c; }

function flagMesh(w, h, color, text) {
  const geo = new THREE.PlaneGeometry(w, h, 10, 4);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i) + w / 2; p.setZ(i, Math.sin(x * 3.2) * 0.07 * (x / w)); }
  geo.computeVertexNormals();
  let m;
  if (text === 'S') {
    // 国際信号旗「S旗」(RRS規則32.2 コース短縮): 白地に青い中央長方形
    const c = document.createElement('canvas'); c.width = 128; c.height = 84; const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 128, 84);
    x.strokeStyle = '#cbd5e1'; x.lineWidth = 4; x.strokeRect(2, 2, 124, 80);
    x.fillStyle = '#1d4ed8'; x.fillRect(28, 18, 72, 48);
    x.fillStyle = '#ffffff'; x.font = 'bold 38px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('S', 64, 43);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    m = new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, roughness: 0.85 });
  } else if (text) {
    const c = document.createElement('canvas'); c.width = 128; c.height = 80; const x = c.getContext('2d');
    x.fillStyle = color; x.fillRect(0, 0, 128, 80); x.fillStyle = '#fff'; x.font = 'bold 56px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 64, 44);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    m = new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, roughness: 0.9 });
  } else m = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.9, emissive: color, emissiveIntensity: 0.25 });
  const f = new THREE.Mesh(geo, m); f.position.x = w / 2; return f;
}

// 船体ロフト(プレーニングハル / セーリングクルーザーハル / 和船サポートボートハル)
function hullGroup(L, B, H, hullColor, stripeColor, opts = {}) {
  const g = new THREE.Group();
  const isSail = !!opts.sailCruiser;
  const isWasen = !!opts.wasen;
  const halfB = (z) => {
    const u = clamp01((z + L / 2) / L);
    if (isSail) {
      // セーリングクルーザー: 中央がふっくらし、バウとスターンへ滑らかに絞られるヨットハル
      if (u < 0.35) return (B / 2) * (0.72 + 0.28 * Math.sin((u / 0.35) * (Math.PI / 2)));
      if (u < 0.62) return B / 2;
      const k = (u - 0.62) / 0.38;
      return (B / 2) * Math.pow(Math.max(0.0001, 1 - Math.pow(k, 1.45)), 0.78) + 0.015;
    }
    if (u < 0.68) return (B / 2) * (1 - 0.05 * Math.pow(1 - u / 0.68, 2));
    const k = (u - 0.68) / 0.32;
    return (B / 2) * Math.pow(Math.max(0.0001, 1 - k * k), 0.7) + 0.02;
  };
  const sheer = (z) => {
    const u = clamp01((z + L / 2) / L);
    return H + (isSail ? 0.28 : 0.46) * H * Math.pow(u, 2.8);
  };
  const bottom = (z) => {
    const u = clamp01((z + L / 2) / L);
    return -0.52 * H * (1 - Math.pow(Math.max(0, (u - 0.42) / 0.58), 1.5)) + 0.04;
  };
  const ts = [0, 0.12, 0.25, 0.3, 0.34, 0.48, 0.52, 0.68, 0.72, 0.82, 0.86, 0.95, 1];
  const ws = [...ts.map((t) => -Math.pow(t, 1 / 1.6)).reverse(), ...ts.slice(1).map((t) => Math.pow(t, 1 / 1.6))];
  const nz = 36, pos = [], col = [], idx = [];
  const hc = new THREE.Color(hullColor), sc = new THREE.Color(stripeColor);
  const bc = new THREE.Color(opts.bottomColor ?? (isSail || isWasen ? 0x162238 : 0x3a1f1c));
  const sc2 = new THREE.Color(opts.stripe2Color ?? stripeColor);
  for (let i = 0; i <= nz; i++) {
    const z = -L / 2 + (L * i) / nz, B2 = halfB(z), s = sheer(z), bo = bottom(z);
    for (const w of ws) {
      const t = Math.pow(Math.abs(w), 1.6);
      pos.push(w * B2, bo + (s - bo) * t, z);
      let c = hc;
      if (t <= 0.28) c = bc;
      else if (isWasen) {
        // アウター和船: 側面に太い赤(上段)＋黒紺(下段)の2色ストライプ
        if (t >= 0.48 && t < 0.66) c = sc2;
        else if (t >= 0.66 && t <= 0.84) c = sc;
      } else if (isSail) {
        // セーリングクルーザー: 水線上の濃紺ブートトップ＋シアー下の濃紺コーブストライプ
        if ((t > 0.28 && t <= 0.36) || (t >= 0.82 && t <= 0.89)) c = sc;
      } else if (t >= 0.71 && t <= 0.83) {
        c = sc;
      }
      col.push(c.r, c.g, c.b);
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
  g.add(new THREE.Mesh(dg, new THREE.MeshStandardMaterial({ color: isSail ? 0xf1f5f9 : 0xdfe3e2, roughness: 0.78, side: THREE.DoubleSide })));
  // ガンネルのラブレール
  for (const sg of [-1, 1]) {
    const pts = []; for (let i = 0; i <= 24; i++) { const z = -L / 2 + (L * i) / 24; pts.push([sg * halfB(z), sheer(z) + 0.02, z]); }
    g.add(tube(pts, 0.036, mat(isSail ? 0xcbd5e1 : 0x1a1c20, 0.45)));
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

// 船首から水面〜海底へ斜め前方に伸びるアンカー係留ロープ＋バウアンカーローラー
function addAnchorMooring(g, bowY, bowZ, ropeLenFwd = 5.2, ropeDepth = 4.8) {
  // ステンレス製バウアンカーローラー＆プラウ型アンカー
  g.add(box(0.14, 0.08, 0.52, chrome, 0, bowY + 0.06, bowZ + 0.08));
  const flk = box(0.24, 0.05, 0.34, chrome, 0, bowY - 0.06, bowZ + 0.24);
  flk.rotation.x = 0.55;
  g.add(flk);
  // 1) 船首ローラーから水面を貫通して海底へ垂れるメインの係留アンカーロープ(わずかなカテナリー曲線)
  const ropeMat = mat(0xdbe4ee, 0.82);
  const subRopeMat = mat(0x7dd3fc, 0.75);
  const pts = [
    [0, bowY + 0.05, bowZ + 0.16],
    [0, bowY * 0.42, bowZ + ropeLenFwd * 0.20],
    [0, 0.02, bowZ + ropeLenFwd * 0.36],
    [0, -ropeDepth * 0.42, bowZ + ropeLenFwd * 0.65],
    [0, -ropeDepth, bowZ + ropeLenFwd],
  ];
  g.add(tube(pts, 0.028, ropeMat));
  // 2) 水面直下〜浅Depthで見えるアンカーロープの水中透過ライン(ヨットが引っかかる危険域が視覚的にもわかる演出)
  const subPts = [
    [0, 0.03, bowZ + ropeLenFwd * 0.32],
    [0, -0.08, bowZ + ropeLenFwd * 0.58],
    [0, -0.22, bowZ + ropeLenFwd * 0.85],
  ];
  g.add(tube(subPts, 0.024, subRopeMat));
}

export function makeMotorboat(type, o = {}) {
  const g = new THREE.Group();
  const flagCfg = o.flags || [];
  if (type === 'committee') {
    // 本部船(参考写真準拠): 白いセーリングクルーザー(高いアルミマスト・ファーリングジブ・ネイビーのブームカバー＆ビミニトップ・アンカー係留ロープ)
    const L = 11.8, B = 3.65, H = 1.12;
    const navyCanvas = mat(0x1b3668, 0.82);
    const sailWhite = mat(0xf4f6f9, 0.65);
    const hull = hullGroup(L, B, H, 0xf7f9fb, o.stripe ?? 0x1b2d52, { sailCruiser: true, bottomColor: 0x152238 });
    g.add(hull);
    const hb = hull.userData.halfB, sh = hull.userData.sheer;

    // 1) ロープロファイルの白いキャビン(ドッグハウス/コーチルーフ) + 濃色アクリル連続窓
    const cs = new THREE.Shape();
    cs.moveTo(-2.1, 0);
    cs.lineTo(2.4, 0);
    cs.lineTo(1.7, 0.58);
    cs.lineTo(-1.85, 0.62);
    cs.closePath();
    const cg = new THREE.ExtrudeGeometry(cs, { depth: 2.15, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2 });
    cg.rotateY(-Math.PI / 2);
    cg.translate(1.075, H + 0.02, 0);
    g.add(new THREE.Mesh(cg, white));
    // キャビン側面のスモーク窓 & 船体側面の楕円ポートライト(舷窓)
    for (const sg of [-1, 1]) {
      const cw = box(0.03, 0.24, 2.75, glass, sg * 1.11, H + 0.36, 0.05);
      cw.rotation.z = -sg * 0.12;
      g.add(cw);
      // 船体中央の楕円ポートライト
      const port = cyl(0.11, 0.03, glass, sg * (hb(0.4) - 0.01), H - 0.22, 0.4, 0, Math.PI / 2);
      port.scale.set(1, 1, 2.2);
      g.add(port);
      // キャビンルーフ上のチークハンドレール
      g.add(box(0.04, 0.04, 2.2, teak, sg * 0.78, H + 0.64, 0.1));
    }
    const fws = box(1.9, 0.32, 0.03, glass, 0, H + 0.34, 2.08);
    fws.rotation.x = -0.78;
    g.add(fws);

    // 2) 後部コクピット・チーク座面・ステアリングペデスタル＆大型ラット(舵輪)
    g.add(box(2.2, 0.12, 3.1, teak, 0, H - 0.02, -3.55));
    for (const sg of [-1, 1]) {
      g.add(box(0.48, 0.26, 2.8, white, sg * 0.92, H + 0.14, -3.5));
    }
    g.add(cyl(0.09, 0.78, white, 0, H + 0.38, -4.35));
    const wheelRim = tube([
      [0, H + 0.52, -4.46], [0.42, H + 0.52, -4.46], [0, H + 0.94, -4.46], [-0.42, H + 0.52, -4.46], [0, H + 0.10, -4.46]
    ], 0.018, chrome, true);
    g.add(wheelRim);

    // 3) ネイビーブルーのビミニトップ(日除け幌)＆ステンレスフレーム + 後部プッシュピット上のオレンジ救命浮環
    for (const z of [-2.55, -4.65]) {
      const arch = tube([
        [-1.22, H + 0.22, z], [-1.28, H + 1.52, z], [0, H + 1.66, z], [1.28, H + 1.52, z], [1.22, H + 0.22, z]
      ], 0.020, chrome);
      g.add(arch);
    }
    const bimini = box(2.58, 0.06, 2.35, navyCanvas, 0, H + 1.62, -3.60);
    g.add(bimini);
    // 船尾プッシュピットのオレンジ救命浮環(ライフブイ)
    const buoyPts = [
      [-1.18, H + 0.55, -5.0], [-1.18, H + 0.78, -5.22], [-1.18, H + 0.55, -5.44], [-1.18, H + 0.32, -5.22]
    ];
    g.add(tube(buoyPts, 0.055, mat(0xff5a1f, 0.55), true));

    // 4) 高いアルミ製セーリングマスト(2段スプレッダー) + ネイビーのブームカバー(レイジーバッグ) + ファーリングジブ
    const mastZ = 0.95, mastH = 13.6;
    g.add(cyl(0.075, mastH, alu, 0, H + 0.55 + mastH / 2, mastZ));
    // 2段スプレッダー
    for (const [sy, sw] of [[H + 4.8, 1.85], [H + 9.0, 1.35]]) {
      g.add(box(sw, 0.04, 0.08, alu, 0, sy, mastZ - 0.04));
    }
    // メインブーム＆ネイビーブルーのブームカバー(レイジーバッグ)
    const boomLen = 4.65, boomY = H + 1.88;
    g.add(cyl(0.055, boomLen, alu, 0, boomY, mastZ - boomLen / 2, Math.PI / 2, 0));
    const lazyBag = box(0.24, 0.34, boomLen - 0.15, navyCanvas, 0, boomY + 0.18, mastZ - boomLen / 2);
    g.add(lazyBag);
    // ファーリングジブ(フォアステイに沿って巻かれた白セール＋ネイビーUVカバー)
    const forestayPts = [[0, sh(L / 2 - 0.2) + 0.12, L / 2 - 0.22], [0, H + mastH - 0.35, mastZ]];
    g.add(tube(forestayPts, 0.042, sailWhite));
    const uvPts = [[0.01, sh(L / 2 - 0.2) + 0.12, L / 2 - 0.20], [0.01, H + mastH * 0.78, mastZ + 0.95]];
    g.add(tube(uvPts, 0.032, navyCanvas));
    // シュラウド(サイドステー)＆バックステイ
    for (const sg of [-1, 1]) {
      g.add(tube([[sg * (hb(mastZ) * 0.94), sh(mastZ), mastZ - 0.15], [sg * 0.92, H + 4.8, mastZ - 0.04], [0, H + mastH - 0.2, mastZ]], 0.012, chrome));
    }
    g.add(tube([[0, sh(-L / 2) + 0.1, -L / 2 + 0.15], [0, H + mastH + 0.35, mastZ]], 0.012, chrome));

    // 5) 運営信号旗ポール(オレンジ旗・P旗/S旗)
    const flagPole = pole(3.8, flagCfg);
    flagPole.position.set(0.85, H + 0.25, -4.85);
    g.add(flagPole);
    g.userData.mast = flagPole;

    // 6) バウパルピット・ライフラインスタンション・フェンダー・アンカー係留ロープ
    pulpit(g, hb, 3.2, sh(3.2));
    for (const z of [-4.2, -1.5, 1.2]) {
      for (const sg of [-1, 1]) g.add(fender(sg * (hb(z) + 0.05), sh(z) - 0.02, z, 0xf8fafc));
    }
    addAnchorMooring(g, sh(L / 2 - 0.1), L / 2 - 0.1, 5.4, 4.8);
  } else if (type === 'outer') {
    // アウター艇(参考写真準拠): 和船型サポートモーターボート(白船体・濃紺ボトム・側面の赤×黒紺2色ストライプ・前傾黒窓フォワードキャビン＋白ハードトップ・大型白青俵フェンダー・アンカー係留ロープ)
    const L = 7.8, B = 2.48, H = 0.82;
    const hull = hullGroup(L, B, H, 0xf5f7f8, 0xd9261c, {
      wasen: true,
      stripe2Color: 0x141b29,
      bottomColor: 0x161f2e,
    });
    g.add(hull);
    const hb = hull.userData.halfB, sh = hull.userData.sheer;

    // 1) フォワードキャビン(操舵室) + 前傾した黒窓 + 後方へ張り出す白いハードトップ屋根
    g.add(box(1.56, 0.72, 1.95, white, 0, H + 0.34, 0.72));
    // 前傾フロントガラス＆側面黒窓
    const fWin = box(1.46, 0.46, 0.04, glass, 0, H + 0.82, 1.56);
    fWin.rotation.x = 0.38; // 写真特有の逆スラント/前傾気味のフロントガラス風情
    g.add(fWin);
    for (const sg of [-1, 1]) {
      g.add(box(0.04, 0.42, 1.55, glass, sg * 0.77, H + 0.80, 0.72));
      // ハードトップ後部を支えるステンレス支柱
      g.add(cyl(0.024, 1.05, chrome, sg * 0.74, H + 0.56, -0.88));
    }
    // 白いハードトップルーフ(前キャビンから後方操舵席上までカバー)
    g.add(box(1.68, 0.08, 2.75, white, 0, H + 1.08, 0.32));
    // ハードトップ上のスピーカーホーン＆GPSアンテナ
    const horn = cyl(0.07, 0.28, white, 0.32, H + 1.20, 0.95, Math.PI / 2, 0);
    g.add(horn);
    g.add(cyl(0.015, 0.85, alu, -0.45, H + 1.52, 0.55));

    // 2) スタートラインのオレンジ旗ポール
    const mast = pole(2.9, flagCfg);
    mast.position.set(0, H + 1.10, -0.35);
    g.add(mast);
    g.userData.mast = mast;

    // 3) 船外機・ステンレスバウレール・写真特徴の大型白×青キャップ俵フェンダー
    g.add(outboard(0, -L / 2 - 0.15, 1.25));
    pulpit(g, hb, 1.55, sh(1.55));
    for (const z of [-1.25, 0.55]) {
      for (const sg of [-1, 1]) {
        const fx = sg * (hb(z) + 0.08), fy = sh(z) - 0.02;
        const fg = new THREE.Group();
        fg.add(cyl(0.145, 0.52, white, 0, -0.28, 0));
        fg.add(cyl(0.142, 0.12, mat(0x1d4ed8, 0.5), 0, -0.05, 0));
        fg.add(cyl(0.142, 0.12, mat(0x1d4ed8, 0.5), 0, -0.51, 0));
        fg.position.set(fx, fy, z);
        g.add(fg);
      }
    }
    // 4) 船首から海底へ垂れるアンカー係留ロープ(スタート前後にヨットが船首すぐ前を通ると引っかかる)
    addAnchorMooring(g, sh(L / 2 - 0.08), L / 2 - 0.08, 5.0, 4.6);
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
  mergeBoat(g);
  return g;
}

// ---------- 軽量化: 1 艇あたり 60〜80 個あった小部品メッシュを材質カテゴリ別に結合 (見た目はほぼ同じで 5〜6 ドローコールに) ----------
// 旗(userData.flag 配下: 毎フレームなびく)とテクスチャ付き・発光部品は結合しない。色は頂点色へ焼き込む
const BOAT_MATS = {
  coat: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12, side: THREE.DoubleSide }),
  metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.88 }),
  satin: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.15 }),
  matte: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }),
};
function boatMatKey(m) {
  if (m === glass) return 'glass';
  if (m.emissive && m.emissive.getHex() !== 0) return null;
  if (m.isMeshPhysicalMaterial && m.clearcoat > 0) return 'coat';
  if (m.isMeshStandardMaterial) return m.metalness >= 0.5 ? 'metal' : m.roughness >= 0.7 ? 'matte' : 'satin';
  return null;
}
function mergeBoat(g) {
  g.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
  const buckets = new Map();
  const walk = (o) => {
    if (o.userData && o.userData.flag) return;
    if (o.isMesh && !Array.isArray(o.material) && !o.material.map && o.geometry.attributes.position) {
      const key = boatMatKey(o.material);
      if (key) { let b = buckets.get(key); if (!b) { b = []; buckets.set(key, b); } b.push(o); }
    }
    for (const ch of o.children) walk(ch);
  };
  walk(g);
  const mtx = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3(), c = new THREE.Color(), vc = new THREE.Color();
  for (const [key, items] of buckets) {
    if (items.length < 2) continue;
    let nv = 0, ni = 0;
    for (const o of items) { const n = o.geometry.attributes.position.count; nv += n; ni += o.geometry.index ? o.geometry.index.count : n; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = key === 'glass' ? null : new Float32Array(nv * 3), idx = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const o of items) {
      const geo = o.geometry, P = geo.attributes.position, N = geo.attributes.normal, C = geo.attributes.color, I = geo.index;
      mtx.multiplyMatrices(inv, o.matrixWorld); nm.getNormalMatrix(mtx);
      const flip = mtx.determinant() < 0, useVC = o.material.vertexColors && C;
      for (let i = 0; i < P.count; i++) {
        const k = (vo + i) * 3;
        v.fromBufferAttribute(P, i).applyMatrix4(mtx); pos[k] = v.x; pos[k + 1] = v.y; pos[k + 2] = v.z;
        if (N) v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); else v.set(0, 1, 0);
        nor[k] = v.x; nor[k + 1] = v.y; nor[k + 2] = v.z;
        if (col) { c.copy(o.material.color); if (useVC) c.multiply(vc.fromBufferAttribute(C, i)); col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b; }
      }
      const n = I ? I.count : P.count;
      for (let i = 0; i < n; i += 3) {
        const a = I ? I.getX(i) : i, b = I ? I.getX(i + 1) : i + 1, d = I ? I.getX(i + 2) : i + 2;
        idx[io++] = vo + a; idx[io++] = vo + (flip ? d : b); idx[io++] = vo + (flip ? b : d);
      }
      vo += P.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    for (const o of items) o.parent.remove(o);
    const mesh = new THREE.Mesh(geo, key === 'glass' ? glass : BOAT_MATS[key]);
    mesh.castShadow = false; g.add(mesh);
  }
  // 部品を抜いて空になったサブグループ(船外機・クリート・フェンダー等)を除去 (旗を含むグループは残る)
  const prune = (o) => { for (const ch of [...o.children]) { prune(ch); if (!ch.isMesh && ch.children.length === 0 && !(ch.userData && ch.userData.flag)) o.remove(ch); } };
  prune(g);
}

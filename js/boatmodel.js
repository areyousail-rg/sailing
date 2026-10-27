// スナイプ級の3Dモデルとリアルな見た目の同期
import * as THREE from 'three';
import { buildFigure } from './crew.js';
import { buildHull, block, rope, ropeGeo, ropeMat, M, FLOOR_Y, deckY } from './snipehull.js';
import { clamp, waveSample, SEA } from './sim.js';

// 船体シェイプ
const hullShape = new THREE.Shape();
hullShape.moveTo(-0.5, -2.36);
hullShape.lineTo(0.5, -2.36);
hullShape.bezierCurveTo(0.78, -1.0, 0.78, 0.9, 0, 2.36);
hullShape.bezierCurveTo(-0.78, 0.9, -0.78, -1.0, -0.5, -2.36);
const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 0.32, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.07, bevelSegments: 4, curveSegments: 24 });
hullGeo.rotateX(-Math.PI / 2);

const deckShape = new THREE.Shape();
deckShape.moveTo(-0.4, -2.12); deckShape.lineTo(0.4, -2.12);
deckShape.bezierCurveTo(0.64, -1.0, 0.64, 0.8, 0, 2.18);
deckShape.bezierCurveTo(-0.64, 0.8, -0.64, -1.0, -0.4, -2.12);

const wellHole = new THREE.Path();
wellHole.moveTo(-0.32, -0.28); wellHole.lineTo(0.32, -0.28);
wellHole.lineTo(0.28, 1.75); wellHole.lineTo(-0.28, 1.75); wellHole.closePath();
deckShape.holes.push(wellHole);

const deckGeo = new THREE.ExtrudeGeometry(deckShape, { depth: 0.25, bevelEnabled: false, curveSegments: 24 });
deckGeo.rotateX(-Math.PI / 2);

const floorShape = new THREE.Shape();
floorShape.moveTo(-0.32, -0.28); floorShape.lineTo(0.32, -0.28);
floorShape.lineTo(0.28, 1.75); floorShape.lineTo(-0.28, 1.75); floorShape.closePath();
const floorGeo = new THREE.ShapeGeometry(floorShape); floorGeo.rotateX(-Math.PI / 2);

// FRPノンスリップデッキテクスチャ生成
function createDeckTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f3ed'; ctx.fillRect(0, 0, 512, 512);
  // ノンスリップグリッド
  ctx.strokeStyle = '#e0ded3'; ctx.lineWidth = 1;
  for (let i = 0; i < 512; i += 8) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
  }
  // ハイクアウトストラップ & 艇内センターライン
  ctx.fillStyle = '#22252a'; ctx.fillRect(240, 100, 32, 300);
  ctx.fillStyle = '#3a82f6'; ctx.fillRect(200, 180, 16, 200); ctx.fillRect(296, 180, 16, 200);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
const deckTex = createDeckTexture();

const mHull = new Map();
const hullMat = (c) => {
  let m = mHull.get(c);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.15, metalness: 0.08 });
    mHull.set(c, m);
  }
  return m;
};
const deckMat = new THREE.MeshStandardMaterial({ map: deckTex, color: 0xffffff, roughness: 0.3, metalness: 0.05 });
const cockpitMat = new THREE.MeshStandardMaterial({ color: 0x3d444d, roughness: 0.8 });
const spar = new THREE.MeshStandardMaterial({ color: 0xdbe2ea, roughness: 0.32, metalness: 0.22 });
const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.5 });
const carbonMat = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.3, metalness: 0.2 });

// リアルなセール幾何体（クロス/ドラフトカーブ + リーチのローチ膨らみ + 上部リーチの風下ツイスト + 3本バテンによる角度変化）
const JIB_NU = 12, JIB_NV = 10;
const JIB_TACK_Y = 0.57, JIB_DECK_Y = 0.415, JIB_TACK_Z = -2.08;
const JIB_CLEW_LEN = 1.72, JIB_HEAD_Y = 5.38, JIB_HEAD_Z = 1.18;
const MAIN_TWIST = 0.36;
const LEECH_RIBBON_US = [0.32, 0.56, 0.78]; // スナイプ級メインセールの3本バテン(下・中・トップバテン)位置
function sailGeometry(tack, head, clew, bulge, nu = 12, nv = 10, roach = 0, twist = 0, withBattens = false) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= nu; i++) {
    const u = i / nu;
    const lx = tack[0] + u * (head[0] - tack[0]), ly = tack[1] + u * (head[1] - tack[1]), lz = tack[2] + u * (head[2] - tack[2]);
    // バテン位置でローチが支えられ、バテン間ではわずかに角度が折れる実艇のリーチ形状
    let roachZ = roach * 4 * u * (1 - u);
    let battenFacetTwist = 0;
    if (withBattens) {
      for (let bi = 0; bi < LEECH_RIBBON_US.length; bi++) {
        const bu = LEECH_RIBBON_US[bi];
        const du = (u - bu) / 0.055;
        const rib = Math.exp(-du * du);
        roachZ += 0.018 * rib;
      }
      // 各バテン(0.32, 0.56, 0.78)を境にセール面のツイスト角がわずかに段階的に変化する
      const s1 = Math.max(0, u - 0.32), s2 = Math.max(0, u - 0.56), s3 = Math.max(0, u - 0.78);
      battenFacetTwist = (0.14 * s1 + 0.18 * s2 + 0.22 * s3) * (1 - u);
    }
    const rx = clew[0] + u * (head[0] - clew[0]), ry = clew[1] + u * (head[1] - clew[1]), rz = clew[2] + u * (head[2] - clew[2]) + roachZ;
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      // バテンが入る後半部(v > 0.42)はバテンで直線的に支えられ、バテンライン上でわずかに角度が変わる立体リッジを形成
      let battenRidge = 0;
      let aftFlatten = 1.0;
      if (withBattens && v > 0.38) {
        const vWeight = Math.pow((v - 0.38) / 0.62, 0.85);
        aftFlatten = 1.0 - 0.18 * vWeight;
        for (let bi = 0; bi < LEECH_RIBBON_US.length; bi++) {
          const bu = LEECH_RIBBON_US[bi];
          const du = (u - bu) / 0.032;
          battenRidge += 0.016 * Math.exp(-du * du) * Math.sin(Math.PI * Math.min(1, (v - 0.35) / 0.65));
        }
        // バテンとバテンの間のパネルでわずかに面角度が切り替わるファセット効果
        const seg = u < 0.32 ? u / 0.32 : u < 0.56 ? (u - 0.32) / 0.24 : u < 0.78 ? (u - 0.56) / 0.22 : (u - 0.78) / 0.22;
        battenRidge -= 0.009 * Math.sin(Math.PI * seg) * vWeight;
      }
      const b = bulge * Math.sin(Math.PI * v) * aftFlatten * (1 - 0.55 * u) * Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.9));
      // クローズ引き込み時にメインセール下部はセンター近くまでタイトに引き込まれ、中〜上部リーチがバテン節ごとにツイストして開く
      const twistX = (twist * Math.pow(u, 1.18) * (1 - u) * 2.05 + battenFacetTwist) * Math.pow(v, 1.12);
      pos.push(lx + v * (rx - lx) + b + twistX + battenRidge, ly + v * (ry - ly), lz + v * (rz - lz));
      uv.push(v, u);
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = i * (nv + 1) + j, b = a + 1, c = a + nv + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// ブロック間を直線的にピンと張るシート用ジオメトリ(スプラインの不自然な大回りループを防ぐ)
function tautSheetGeo(pts, r = 0.0065) {
  const sharpPts = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0) sharpPts.push(pts[i - 1].clone().lerp(p, 0.88));
    sharpPts.push(p);
    if (i < pts.length - 1) sharpPts.push(p.clone().lerp(pts[i + 1], 0.12));
  }
  return ropeGeo(sharpPts, r, Math.max(18, sharpPts.length * 4));
}

const mainGeo = sailGeometry([0, 1.02, 0], [0, 6.75, 0.08], [0, 0.98, 2.88], 0.33, 28, 12, 0.36, MAIN_TWIST, true);
const jibGeo = sailGeometry([0, 0, 0], [0, JIB_HEAD_Y, JIB_HEAD_Z], [0, 0.22, JIB_CLEW_LEN], 0.20, JIB_NU, JIB_NV);
const mastGeo = new THREE.CylinderGeometry(0.035, 0.046, 6.9, 12);
const boomGeo = new THREE.CylinderGeometry(0.030, 0.030, 2.88, 8); boomGeo.rotateX(Math.PI / 2);

// メインセールテクスチャ: 実艇写真(画像3枚目)準拠のうっすら透ける3本バテンポケット、パネルシーム、コーナー補強パッチ、スナイプ鳥マーク、JPN & セールNo、小さめの下部クリアウィンドウ
function mainSailTexture(no, color) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 1024;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(249, 251, 253, 0.98)';
  x.fillRect(0, 0, 512, 1024);

  // 1) ラフ(前縁)・フット(下縁)・コーナー(ヘッド/タック/クリュー)のダクロン積層補強パッチ
  x.fillStyle = 'rgba(235, 240, 246, 0.85)';
  x.fillRect(0, 0, 18, 1024); // ラフテープ帯
  x.fillRect(0, 1004, 512, 20); // フットテープ帯
  // クリュー・タック・ヘッドの放射状コーナーパッチ
  for (const [cx, cy, r] of [[512, 1024, 95], [0, 1024, 78], [256, 0, 72]]) {
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.fillStyle = 'rgba(232, 238, 245, 0.75)';
    x.fill();
    x.strokeStyle = 'rgba(198, 206, 216, 0.8)';
    x.lineWidth = 1.5;
    x.stroke();
  }

  // 2) セールクロスのクロスカットシーム(パネルライン)
  x.strokeStyle = 'rgba(206, 214, 224, 0.85)';
  x.lineWidth = 1.8;
  for (let y = 88; y < 1024; y += 84) {
    x.beginPath();
    x.moveTo(0, y + 8);
    x.lineTo(512, y - 6);
    x.stroke();
  }

  // 3) うっすら見える3本のバテンポケット & 内部バテンロッド & リーチ端バテンキャップ (LEECH_RIBBON_US = [0.32, 0.56, 0.78])
  // UVの u は下端=0(y=1024)、上端=1(y=0) なので cy = (1 - u) * 1024
  const battenSpecs = [
    { u: 0.78, vStart: 0.36 }, // トップバテン
    { u: 0.56, vStart: 0.42 }, // ミドルバテン
    { u: 0.32, vStart: 0.46 }, // ローワーバテン
  ];
  for (const bs of battenSpecs) {
    const ly = (1 - bs.u) * 1024;
    const x0 = Math.round(bs.vStart * 512);
    const y0 = ly + 10; // 内側端はわずかに下向き
    const y1 = ly;      // リーチ端(x=512)
    x.save();
    // バテンポケットのダクロン袋布(うっすら見える帯)
    x.beginPath();
    x.moveTo(x0, y0 - 8);
    x.lineTo(512, y1 - 9);
    x.lineTo(512, y1 + 9);
    x.lineTo(x0, y0 + 8);
    x.closePath();
    x.fillStyle = 'rgba(224, 231, 240, 0.82)';
    x.fill();
    x.strokeStyle = 'rgba(176, 188, 202, 0.88)';
    x.lineWidth = 1.5;
    x.stroke();

    // ポケット内部にうっすら透けて見えるグラスファイバーバテン芯材と立体陰影
    x.beginPath();
    x.moveTo(x0 + 8, y0);
    x.lineTo(506, y1);
    x.strokeStyle = 'rgba(154, 168, 186, 0.62)';
    x.lineWidth = 5.0;
    x.stroke();
    x.beginPath();
    x.moveTo(x0 + 8, y0 - 2.5);
    x.lineTo(506, y1 - 2.5);
    x.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    x.lineWidth = 2.0;
    x.stroke();

    // バテンポケット前端(セール中央側)の補強パッチ(四角い白パッチ)
    x.fillStyle = 'rgba(214, 222, 232, 0.90)';
    x.strokeStyle = 'rgba(168, 180, 195, 0.85)';
    x.lineWidth = 1.4;
    x.fillRect(x0 - 6, y0 - 11, 22, 22);
    x.strokeRect(x0 - 6, y0 - 11, 22, 22);

    // リーチ端のバテンエンドキャップ(濃紺/黒のエンドプロテクター)
    x.fillStyle = '#1e293b';
    x.fillRect(496, y1 - 7, 16, 14);
    x.restore();
  }

  // 4) 帆の上部: スナイプ級の象徴である「鳥のマーク(飛ぶシギのシルエット)」(実艇写真準拠の濃紺ブルー)
  x.save();
  x.translate(242, 172);
  x.scale(1.28, 1.28);
  x.fillStyle = '#123e96';
  x.beginPath();
  x.moveTo(46, -8);    // 長いくちばし先端
  x.lineTo(18, -5);    // 頭頂
  x.quadraticCurveTo(10, -9, 2, -4); // 頭部から首
  x.quadraticCurveTo(-8, -26, -34, -22); // 翼端上
  x.quadraticCurveTo(-20, -10, -14, -2); // 翼の後縁くびれ
  x.lineTo(-36, 8);
  x.lineTo(-22, 11);
  x.quadraticCurveTo(-2, 12, 12, 2);
  x.lineTo(20, -1);
  x.closePath();
  x.fill();
  x.restore();

  // 5) 国コード「JPN」＋ 裏面透け文字(反転JPN) — トップバテンとミドルバテンの間に配置
  const sailBlue = '#123e96';
  const ghostBlue = 'rgba(18, 62, 150, 0.22)';
  x.fillStyle = sailBlue;
  x.font = 'bold 84px Arial, sans-serif';
  x.textAlign = 'center';
  x.save();
  x.translate(244, 336);
  x.rotate(0.06);
  x.fillText('JPN', 0, 0);
  x.restore();

  x.save();
  x.translate(238, 416);
  x.rotate(0.06);
  x.scale(-1, 1);
  x.fillStyle = ghostBlue;
  x.font = 'bold 84px Arial, sans-serif';
  x.fillText('JPN', 0, 0);
  x.restore();

  // 6) セールナンバー ＋ 裏面透けナンバー(左右反転) — ミドルバテンとローワーバテンの間に配置
  const numText = no && no.length >= 4 ? no : '31804';
  x.save();
  x.translate(254, 548);
  x.rotate(0.06);
  x.fillStyle = sailBlue;
  x.font = 'bold 84px Arial, sans-serif';
  x.fillText(numText, 0, 0);
  x.restore();

  x.save();
  x.translate(246, 632);
  x.rotate(0.06);
  x.scale(-1, 1);
  x.fillStyle = ghostBlue;
  x.font = 'bold 84px Arial, sans-serif';
  x.fillText(numText, 0, 0);
  x.restore();

  // 7) メインセール下部の視認用クリアウィンドウ(画像3枚目準拠の小さめサイズ)
  const mwx = 68, mwy = 858, mww = 96, mwh = 44;
  x.clearRect(mwx, mwy, mww, mwh);
  x.fillStyle = 'rgba(195, 225, 248, 0.18)';
  x.fillRect(mwx, mwy, mww, mwh);
  x.strokeStyle = 'rgba(255, 255, 255, 0.36)';
  x.lineWidth = 1.4;
  x.beginPath();
  x.moveTo(mwx + 16, mwy + mwh - 4); x.lineTo(mwx + 38, mwy + 4);
  x.moveTo(mwx + 56, mwy + mwh - 4); x.lineTo(mwx + 78, mwy + 4);
  x.stroke();
  x.strokeStyle = 'rgba(228, 234, 242, 0.95)';
  x.lineWidth = 5;
  x.strokeRect(mwx, mwy, mww, mwh);
  x.strokeStyle = 'rgba(170, 186, 204, 0.85)';
  x.lineWidth = 1.5;
  x.strokeRect(mwx, mwy, mww, mwh);

  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

// ジブセールテクスチャ: 下部に反対側が透けて見える小さめの透明ウインドウを配置
let jibTex = null;
function jibTexture() {
  if (jibTex) return jibTex;
  const c = document.createElement('canvas'); c.width = 256; c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(251, 252, 254, 0.97)';
  x.fillRect(0, 0, 256, 512);

  // パネルシームライン
  x.strokeStyle = 'rgba(214, 220, 228, 0.85)';
  x.lineWidth = 1.5;
  for (let y = 44; y < 512; y += 52) {
    x.beginPath(); x.moveTo(0, y); x.lineTo(256, y); x.stroke();
  }

  // ジブセール下部の透明ウインドウ (実艇写真準拠のコンパクトなクリア窓)
  const wx = 54, wy = 420, ww = 98, wh = 34;
  x.clearRect(wx, wy, ww, wh);
  x.fillStyle = 'rgba(190, 225, 250, 0.16)';
  x.fillRect(wx, wy, ww, wh);
  // 透明ビニール窓の細い反射ハイライト線
  x.strokeStyle = 'rgba(255, 255, 255, 0.38)';
  x.lineWidth = 1.5;
  x.beginPath();
  x.moveTo(wx + 24, wy + wh - 4); x.lineTo(wx + 62, wy + 4);
  x.moveTo(wx + 108, wy + wh - 4); x.lineTo(wx + 142, wy + 4);
  x.stroke();
  // 窓枠の白い補強テープ縁取り
  x.strokeStyle = 'rgba(230, 236, 242, 0.96)';
  x.lineWidth = 6;
  x.strokeRect(wx, wy, ww, wh);
  x.strokeStyle = 'rgba(165, 182, 200, 0.85)';
  x.lineWidth = 1.5;
  x.strokeRect(wx, wy, ww, wh);

  jibTex = new THREE.CanvasTexture(c); jibTex.colorSpace = THREE.SRGBColorSpace; return jibTex;
}

const stayMat = new THREE.MeshStandardMaterial({ color: 0xb8c2cc, metalness: 0.25, roughness: 0.3 });
function stay(a, b) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b), len = va.distanceTo(vb);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, len, 6), stayMat);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  return m;
}

function ribbonGeo(len, h) {
  const g = new THREE.PlaneGeometry(len, h); g.rotateY(Math.PI / 2); g.translate(0, 0, len / 2); return g;
}
// 細い毛糸・紐状のテルテールジオメトリ (根元から後方+zへ伸びる細紐)
function yarnGeo(len = 0.28, r = 0.0046) {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, -0.003, len * 0.38),
    new THREE.Vector3(0, -0.009, len * 0.75),
    new THREE.Vector3(0, -0.014, len),
  ]);
  return new THREE.TubeGeometry(curve, 10, r, 6, false);
}
const TT_HEIGHTS = [0.28, 0.50, 0.72], TT_V = 0.14; // 視認しやすい位置
// サイドステー(シュラウド): 広くなった船体幅(x=0.72)と高くなったリグに合わせてチェーンプレート → スプレッダー先端
const SHROUD_A = [0.72, 0.375, -0.75], SHROUD_B = [0.64, 3.85, -0.92];
const onShroud = (y) => { const t = (y - SHROUD_A[1]) / (SHROUD_B[1] - SHROUD_A[1]); return [SHROUD_A[0] + (SHROUD_B[0] - SHROUD_A[0]) * t, y, SHROUD_A[2] + (SHROUD_B[2] - SHROUD_A[2]) * t]; };
// ランチャー(ウィスカーポール): ブーム基部(グースネック付近 y=1.36)からジブクリューの先端まで正確に伸びる
const POLE_ROOT = new THREE.Vector3(0, 1.36, -0.92);
const poleGeo = new THREE.CylinderGeometry(0.015, 0.017, 1, 8); poleGeo.translate(0, 0.5, 0);
// シート用共有ジオメトリ (毎フレームのジオメトリ生成・破棄をゼロにしてGPUメモリ負荷と描画崩れを完全解消)
const sheetSegGeo = new THREE.CylinderGeometry(0.0064, 0.0064, 1, 6); sheetSegGeo.translate(0, 0.5, 0);
const mainSheetMat = ropeMat(0x86efac);
const jibSheetMatL = ropeMat(0xf5f5f5);
const jibSheetMatW = ropeMat(0x3b82f6);
const JIB_WING = 1.22; // ランチャーで風上側に張り出したジブの角度
const _Y = new THREE.Vector3(0, 1, 0), _v = new THREE.Vector3(), _root = new THREE.Vector3(), _segDir = new THREE.Vector3();
const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3(), _p3 = new THREE.Vector3(), _p4 = new THREE.Vector3(), _p5 = new THREE.Vector3();
const _spM4 = new THREE.Matrix4(), _spPos = new THREE.Vector3(), _spQuat = new THREE.Quaternion(), _spScale = new THREE.Vector3(), _spEul = new THREE.Euler(), _spCol = new THREE.Color();

// 3方向直交クアッドによる立体しぶきジオメトリ（ドローン視点・艇内カメラ視点のどちらから見ても厚みのある水しぶき粒に見える）
let _spray3DGeo = null, _sprayDropMat = null;
function getSpray3DGeo() {
  if (_spray3DGeo) return _spray3DGeo;
  const pos = [
    // XY plane (艇内カメラから正面に見える面)
    -0.5, -0.5, 0,  0.5, -0.5, 0,  0.5, 0.5, 0,  -0.5, -0.5, 0,  0.5, 0.5, 0,  -0.5, 0.5, 0,
    // YZ plane (横・斜めから見える面)
    0, -0.5, -0.5,  0, 0.5, -0.5,  0, 0.5, 0.5,  0, -0.5, -0.5,  0, 0.5, 0.5,  0, -0.5, 0.5,
    // XZ plane (上空ドローンから見える面)
    -0.5, 0, -0.5,  0.5, 0, -0.5,  0.5, 0, 0.5,  -0.5, 0, -0.5,  0.5, 0, 0.5,  -0.5, 0, 0.5,
  ];
  const uv = [
    0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  _spray3DGeo = g;
  return _spray3DGeo;
}
function getSprayDropMat() {
  if (_sprayDropMat) return _sprayDropMat;
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 64, 64);
  for (let py = 0; py < 64; py++) {
    for (let px = 0; px < 64; px++) {
      const dx = (px - 31.5) / 31.5, dy = (py - 31.5) / 31.5;
      const r2 = dx * dx + dy * dy;
      if (r2 >= 1) continue;
      const a = Math.pow(1 - r2, 1.85);
      x.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      x.fillRect(px, py, 1, 1);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  _sprayDropMat = new THREE.MeshBasicMaterial({
    map: tex,
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return _sprayDropMat;
}

function placeSeg(mesh, a, b) {
  mesh.position.copy(a);
  _segDir.subVectors(b, a);
  const len = _segDir.length();
  if (len < 1e-4) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.quaternion.setFromUnitVectors(_Y, _segDir.multiplyScalar(1 / len));
  mesh.scale.set(1, len, 1);
}

export class BoatModel {
  constructor(boat, crewHelm, crewCrew) {
    this.boat = boat;
    this.root = new THREE.Group();
    this.body = new THREE.Group(); this.root.add(this.body);

    const hull = buildHull(boat.color);
    this.body.add(hull);
    this.cbBoard = hull.userData.cbBoard || null;
    const mast = new THREE.Mesh(mastGeo, spar); mast.position.set(0, 3.85, -0.9); this.body.add(mast);
    this.mast = mast;

    // 舵 (白ラダーヘッド & 水線上のラダー上部) & アルミティラー + エクステンションバー
    // 海中のラダーブレード下部が見えてしまわないよう、トランサム水線上部(y=-0.06〜+0.46)のみを描画
    const rudderGroup = new THREE.Group(); rudderGroup.position.set(0, 0.4, 2.36);
    const rudderHead = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.22, 0.20), M.gel); rudderHead.position.set(0, -0.05, 0.08); rudderGroup.add(rudderHead);
    const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.42, 0.26), M.gel); rudder.position.set(0, -0.25, 0.12); rudderGroup.add(rudder);
    const tiller = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 1.18, 10), M.alu); tiller.rotation.x = Math.PI / 2; tiller.position.set(0, 0.05, -0.58); rudderGroup.add(tiller);
    const ext = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.95, 8), carbonMat); ext.rotation.z = Math.PI / 4; ext.position.set(0.28, 0.09, -1.06); rudderGroup.add(ext);
    this.rudderGroup = rudderGroup; this.body.add(rudderGroup);

    const tex = mainSailTexture(String(boat.sailNo), boat.color);
    // メインセール・ジブともに小さい透明ウインドウが自然に透けつつdepthWriteで前後ソート崩れを防ぐ
    this.sailMat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.62, metalness: 0.04, transparent: true, opacity: 0.99, depthWrite: true });
    this.jibMat = new THREE.MeshStandardMaterial({ map: jibTexture(), side: THREE.DoubleSide, roughness: 0.58, transparent: true, opacity: 0.98, depthWrite: true });

    this.mainPivot = new THREE.Group(); this.mainPivot.position.set(0, 0.4, -0.9); this.body.add(this.mainPivot);
    this.mainSail = new THREE.Mesh(mainGeo, this.sailMat); this.mainPivot.add(this.mainSail);
    // メインセール後縁(リーチ)の3本バテン端に取り付けられたリーチリボン(リーチテルテール)
    this.leechRibbons = [];
    const lrGeo = yarnGeo(0.25, 0.0046);
    const lrMat = new THREE.MeshStandardMaterial({ color: 0xff2438, roughness: 0.75, metalness: 0.0 });
    for (let i = 0; i < LEECH_RIBBON_US.length; i++) {
      const u = LEECH_RIBBON_US[i];
      const ry = 0.98 + u * (6.75 - 0.98);
      const rz = 2.88 + u * (0.08 - 2.88) + 0.36 * 4 * u * (1 - u) + 0.018;
      const s1 = Math.max(0, u - 0.32), s2 = Math.max(0, u - 0.56), s3 = Math.max(0, u - 0.78);
      const battenFacetTwist = (0.14 * s1 + 0.18 * s2 + 0.22 * s3) * (1 - u);
      const twistX = MAIN_TWIST * Math.pow(u, 1.18) * (1 - u) * 2.05 + battenFacetTwist;
      const m = new THREE.Mesh(lrGeo, lrMat);
      m.position.set(twistX, ry, rz);
      this.mainPivot.add(m);
      this.leechRibbons.push({ m, u, ry, rz, twistX, ph: i * 2.1 + Math.random() * 3 });
    }
    const boom = new THREE.Mesh(boomGeo, spar); boom.position.set(0, 1.02, 1.44); this.mainPivot.add(boom);
    // ゴースネック / ブームブロック(後部 bz=2.52・中央 bz=1.18: センターケース後端z=0.10の真上付近) / バング
    const gn = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.045, 0.07), M.alu); gn.position.set(0, 1.02, 0.02); this.mainPivot.add(gn);
    const bb = block(0.02); bb.position.set(0, 0.97, 2.52); this.mainPivot.add(bb);
    const bbMid = block(0.02); bbMid.position.set(0, 0.97, 1.18); this.mainPivot.add(bbMid);
    const bEnd = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 0.035), M.alu); bEnd.position.set(0, 1.02, 2.86); this.mainPivot.add(bEnd);
    const vb1 = block(0.015); vb1.position.set(0, 0.96, 0.58); this.mainPivot.add(vb1);
    const vb2 = block(0.015); vb2.position.set(0, 0.1, 0.04); this.mainPivot.add(vb2);
    this.mainPivot.add(rope([[0, 0.1, 0.04], [0.012, 0.5, 0.3], [0, 0.96, 0.58]], 0xffd23a, 0.0055), rope([[0.012, 0.1, 0.04], [-0.012, 0.55, 0.28], [0.012, 0.96, 0.58]], 0xffd23a, 0.0055));
    // 後部ブライドル基部ブロック (z=1.56)
    const aftBridleBlk = block(0.018); aftBridleBlk.position.set(0, FLOOR_Y + 0.28, 1.56); this.body.add(aftBridleBlk);
    // メインシート(4セグメント共有ジオメトリ方式で毎フレームのアロケーションゼロ)
    this.mainSheetSegs = [];
    for (let i = 0; i < 4; i++) {
      const seg = new THREE.Mesh(sheetSegGeo, mainSheetMat);
      this.body.add(seg);
      this.mainSheetSegs.push(seg);
    }
    if (boat.isPlayer) {
      // ジブシート: ジブクリュー → ジブカム(サイドデッキ) → クルーの手元へ真っ直ぐ伸びる2セグメントのみ(余分な船内ジブシートは削除)
      this.rjLeeSegs = [];
      for (let i = 0; i < 2; i++) { const s = new THREE.Mesh(sheetSegGeo, jibSheetMatL); this.body.add(s); this.rjLeeSegs.push(s); }
    }

    // ジブセールは下部(タック角)がバウデッキに密接しておらず、ジブタック(Jib Tack)のコードでバウデッキ金具から約15.5cm浮かせて距離を調整している実艇構造を再現
    this.jibPivot = new THREE.Group(); this.jibPivot.position.set(0, JIB_TACK_Y, JIB_TACK_Z); this.body.add(this.jibPivot);
    this.jibGeo = jibGeo.clone();
    this.jibSail = new THREE.Mesh(this.jibGeo, this.jibMat); this.jibPivot.add(this.jibSail);
    // バウデッキ金具(y=0.415, z=-2.08)とジブタック角(y=0.57, z=-2.08)を結ぶジブタック紐(ダイニーマコード)とクリングル金具
    const tackFitting = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.020, 0.042), M.steel);
    tackFitting.position.set(0, JIB_DECK_Y + 0.008, JIB_TACK_Z);
    this.body.add(tackFitting);
    const tackCringle = new THREE.Mesh(new THREE.TorusGeometry(0.011, 0.0035, 6, 10), M.steel);
    tackCringle.rotation.y = Math.PI / 2;
    tackCringle.position.set(0, JIB_TACK_Y, JIB_TACK_Z);
    this.body.add(tackCringle);
    this.body.add(
      rope([[0, JIB_DECK_Y + 0.012, JIB_TACK_Z], [0, JIB_TACK_Y, JIB_TACK_Z]], 0xe11d48, 0.0046),
      rope([[0.004, JIB_DECK_Y + 0.012, JIB_TACK_Z - 0.006], [0, JIB_TACK_Y - 0.004, JIB_TACK_Z]], 0x1e293b, 0.0036)
    );
    this._lastPk = -1; this._lastJibRot = -99; this._lastJibCamber = -99;

    this.helm = buildFigure(crewHelm.type, crewHelm.style); this.helmRig = new THREE.Group(); this.helmRig.add(this.helm); this.body.add(this.helmRig);
    this.crew = buildFigure(crewCrew.type, crewCrew.style); this.crewRig = new THREE.Group(); this.crewRig.add(this.crew); this.body.add(this.crewRig);

    this.side = boat.tack;
    this.crewSide = boat.tack;
    this.boomA = 0.3;
    this.phase = Math.random() * 10;
    this._prevPole = boat.pole;
    this.crewPoleTimer = 0;
    for (const s of [-1, 1]) {
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.68, 8), spar); sp.rotation.z = Math.PI / 2 + s * 0.12; sp.position.set(s * 0.31, 3.85, -0.92); this.body.add(sp);
      this.body.add(stay([s * SHROUD_A[0], SHROUD_A[1], SHROUD_A[2]], [s * SHROUD_B[0], SHROUD_B[1], SHROUD_B[2]]), stay([s * SHROUD_B[0], 3.85, -0.92], [0, 5.95, -0.9]));
    }
    // フォアステイ: ランチャーアップ時はテンションを少し緩めて前・風下へわずかにサギングできるよう4セグメントで構成
    this.forestaySegs = [];
    const fSegGeo = new THREE.CylinderGeometry(0.0068, 0.0068, 1, 6); fSegGeo.translate(0, 0.5, 0);
    for (let i = 0; i < 4; i++) {
      const fs = new THREE.Mesh(fSegGeo, stayMat);
      this.body.add(fs);
      this.forestaySegs.push(fs);
    }
    this.syncForestay(0, boat.tack);
    // ランチャーポール(全艇): 使わない時はブーム脇に沿って格納した金属バーとして見える
    this.pole = new THREE.Mesh(poleGeo, spar); this.pole.position.copy(POLE_ROOT); this.pole.visible = false; this.body.add(this.pole);
    const stowGeo = new THREE.CylinderGeometry(0.013, 0.013, 2.2, 8); stowGeo.rotateX(Math.PI / 2);
    this.poleStow = new THREE.Mesh(stowGeo, spar); this.poleStow.position.set(0.075, 0.96, 1.35); this.mainPivot.add(this.poleStow);
    for (const zz of [0.45, 2.15]) { const clip = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.035), M.alu); clip.position.set(0.05, 0.98, zz); this.mainPivot.add(clip); }
    this.jibRot = 0;

    // 船内カメラ用マウント(スキッパーの目線／少し高めのデッキ後方視点)
    this.mount = new THREE.Object3D();
    this.mount.position.set(0.42, 1.42, 0.98);
    this.body.add(this.mount);

    // 3Dバウしぶき（中低速〜高速走行中にバウ左右から舞い上がり艇内カメラでも見える飛沫）＋ 波にはたかれた際の大しぶきバースト
    this.SPRAY_N = 28; // 0..15: 常時走行バウしぶき, 16..27: 波にはたかれた際のスプラッシュ
    this.bowSprayMesh = new THREE.InstancedMesh(getSpray3DGeo(), getSprayDropMat(), this.SPRAY_N);
    this.bowSprayMesh.frustumCulled = false;
    this.bowSprayMesh.renderOrder = 6;
    this.bowSprayMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _spM4.makeScale(0, 0, 0);
    _spCol.setScalar(0);
    for (let i = 0; i < this.SPRAY_N; i++) {
      this.bowSprayMesh.setMatrixAt(i, _spM4);
      this.bowSprayMesh.setColorAt(i, _spCol);
    }
    this.body.add(this.bowSprayMesh);
    this.slamBurstT = 0;
    this.slamBurstPow = 0;
    this.slamAutoCD = 0;

    if (boat.isPlayer) {
      this.tells = [];
      const yGeo = yarnGeo(0.28, 0.0046); // 細い毛糸・紐状のテルテール
      const patchGeo = new THREE.CircleGeometry(0.012, 10); patchGeo.rotateY(Math.PI / 2);
      const patchMat = new THREE.MeshBasicMaterial({ color: 0x1e293b, side: THREE.DoubleSide });
      for (const u of TT_HEIGHTS) {
        for (const side of [1, -1]) {
          // 右舷(スタボ)=鮮やかな青(0x1d7dfa)、左舷(ポート)=赤(0xff2233)
          const matWind = new THREE.MeshStandardMaterial({ color: side > 0 ? 0x1d7dfa : 0xff2233, roughness: 0.85, metalness: 0.0 });
          const matLeeward = new THREE.MeshBasicMaterial({ color: side > 0 ? 0x1e40af : 0x881111, transparent: true, opacity: 0.35, depthTest: true });
          const m = new THREE.Mesh(yGeo, matWind);
          const patch = new THREE.Mesh(patchGeo, patchMat);
          m.add(patch);
          const mShadow = new THREE.Mesh(yGeo, matLeeward);
          this.jibPivot.add(m); this.jibPivot.add(mShadow);
          this.tells.push({ m, mShadow, u, side, ph: Math.random() * 9 });
        }
      }

      // サイドステーの風見(毛糸): 左右のシュラウド上、目線の高さと少し上の2箇所に結ぶ
      this.vanes = [];
      for (const s of [-1, 1]) {
        for (const vy of [1.68, 2.28]) {
          const p = onShroud(vy);
          const vane = new THREE.Group(); vane.position.set(s * p[0], p[1], p[2]);
          const vm = new THREE.Mesh(ribbonGeo(0.14, 0.022), new THREE.MeshBasicMaterial({ color: 0xffd23f, side: THREE.DoubleSide }));
          vm.geometry = vm.geometry.clone(); vm.geometry.rotateY(Math.PI / 2);
          const bead = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2222 }));
          vane.add(vm, bead); this.body.add(vane); this.vanes.push({ g: vane, ph: s * 1.7 + vy });
        }
      }
    }
    this.root.position.set(boat.x, 0, boat.z);
    this.root.rotation.y = -boat.h;
  }

  dispose() {
    if (this.sailMat) {
      if (this.sailMat.map) this.sailMat.map.dispose();
      this.sailMat.dispose();
    }
    if (this.jibGeo) this.jibGeo.dispose();
  }

  setFirstPerson(on) {
    if (this.fp === on) return; this.fp = on;
    // 艇内カメラ時はヘルメット/スキッパーモデルを隠す(クルーは表示したままにする)
    if (this.helmRig) this.helmRig.visible = !on; // スキッパーを非表示
    // if (this.crewRig) this.crewRig.visible = !on;
  }

  // ドローンカメラ時に他艇(CP艇)がカメラと自艇の間に入って視界を遮る際、そのCP艇を半透明化する
  setOccludingAlpha(alpha) {
    const a = clamp(alpha, 0.18, 1.0);
    if (this._occAlpha === undefined) this._occAlpha = 1.0;
    if (Math.abs(a - this._occAlpha) < 0.01 && (a >= 0.99) === (this._occAlpha >= 0.99)) return;
    this._occAlpha = a;
    if (!this._occMats) {
      this._occMats = [];
      const matMap = new Map();
      this.body.traverse((obj) => {
        if (!obj.isMesh || !obj.material || obj === this.bowSprayMesh) return;
        const cloneMat = (m) => {
          if (matMap.has(m)) return matMap.get(m);
          const cm = (m === this.sailMat || m === this.jibMat) ? m : m.clone();
          matMap.set(m, cm);
          this._occMats.push({ mat: cm, baseOp: cm.opacity !== undefined ? cm.opacity : 1.0, baseTrans: !!cm.transparent, baseStencil: !!cm.stencilWrite });
          return cm;
        };
        if (Array.isArray(obj.material)) obj.material = obj.material.map(cloneMat);
        else obj.material = cloneMat(obj.material);
      });
    }
    const isTrans = a < 0.98;
    for (const item of this._occMats) {
      item.mat.transparent = isTrans ? true : item.baseTrans;
      item.mat.opacity = item.baseOp * a;
      item.mat.depthWrite = !isTrans;
      item.mat.stencilWrite = !isTrans && item.baseStencil;
    }
  }

  // フォアステイの更新: クローズではピンと直線に張り、ランチャーアップ(pk>0)時はテンションを抜いて前・風上側へはっきりサギングさせる
  syncForestay(pk, sgn) {
    if (!this.forestaySegs) return;
    const N = this.forestaySegs.length;
    const y0 = JIB_DECK_Y, z0 = JIB_TACK_Z;
    const y1 = 5.95, z1 = -0.90 - 0.065 * pk;
    for (let i = 0; i < N; i++) {
      const u0 = i / N, u1 = (i + 1) / N;
      const s0 = pk * Math.sin(Math.PI * u0), s1 = pk * Math.sin(Math.PI * u1);
      _p0.set(-sgn * 0.095 * s0, y0 + (y1 - y0) * u0 - 0.045 * s0, z0 + (z1 - z0) * u0 - 0.145 * s0);
      _p1.set(-sgn * 0.095 * s1, y0 + (y1 - y0) * u1 - 0.045 * s1, z0 + (z1 - z0) * u1 - 0.145 * s1);
      placeSeg(this.forestaySegs[i], _p0, _p1);
    }
  }

  // ジブのラフ(v=0)をフォアステーへ固定し、ランチャー展開時(pk>0)はフォアステイ＆ジブのテンションを抜いた丸みのある形状を反映
  // クローズ時はフット中央(v≈0.25..0.72)がフォアデッキに密接し、先端(v=0)と手前クリュー側(v=1)は船体から浮いた実艇形状を再現
  evalJibPoint(u, v, clewX, clewLocalY, clewLocalZ, camberSigned, pk, out) {
    const sgn = this.boat.tack || 1;
    const headY = JIB_HEAD_Y - 0.055 * pk, headZ = JIB_HEAD_Z - 0.065 * pk;
    const sag = pk * Math.sin(Math.PI * u);
    const lx = -sgn * 0.095 * sag, ly = headY * u - 0.045 * sag, lz = headZ * u - 0.145 * sag;
    const rx = clewX * (1 - u);
    const ry = clewLocalY + (headY - clewLocalY) * u;
    const rz = clewLocalZ + (headZ - clewLocalZ) * u;
    // コード(ラフ→リーチ)に対する法線方向へキャンバー(膨らみ)を付与。ランチャー展開時(pk>0)はテンションを抜いた深いポケット形状にする
    const dx = rx - lx, dz = rz - lz;
    const clen = Math.hypot(dx, dz) || 1;
    const nx = dz / clen, nz = -dx / clen;
    const upperTension = Math.pow(1 - u, 0.85) * (1 - 0.12 * pk * u) + 0.46 * pk * Math.sin(Math.PI * u);
    const footProfile = Math.sin(Math.PI * Math.pow(v, 0.85 - 0.18 * pk));
    const b = camberSigned * footProfile * upperTension;
    let px = lx + v * dx + nx * b;
    let py = ly + v * (ry - ly);
    const pz = lz + v * dz + nz * b;
    const zBody = JIB_TACK_Z + pz;

    // クローズ走行時: ジブセールの底(フット u→0)の真ん中あたり(v≈0.22..0.76)は船体(フォアデッキ)と密接し、
    // 先端(バウ側 v→0: ジブタック紐で浮く)や手前側(クリュー側 v→1)は船体にくっついていない形状を再現
    const closeF = this._closeFactor ?? 0;
    if (pk < 0.35 && closeF > 0.05 && u < 0.42) {
      const midFootBell = Math.pow(Math.sin(Math.PI * v), 1.65); // v=0とv=1で0、中央(v=0.5)で1
      const footUWeight = Math.exp(-u * 6.8) * closeF * (1 - pk);
      const deckLocalY = deckY(zBody, px) - JIB_TACK_Y + 0.006;
      const dropToDeck = (py - deckLocalY) * midFootBell * footUWeight;
      py -= dropToDeck;
      if (u < 0.08 && v > 0.15 && v < 0.85) {
        py = Math.max(py, deckLocalY);
      }
    } else if (pk > 0.1) {
      // ランチャーアップ時はテンションを抜いた自然なフットのたるみ・丸みを付与
      py -= 0.10 * pk * Math.sin(Math.PI * v) * Math.pow(1 - u, 1.3);
    }

    // メインセール貫通防止ガード: マスト(z = -0.90)より後方へ重なる頂点は、メインセールの同高さ・同前後位置の風下変位より必ず外側に保つ
    if (pk < 0.35 && zBody > -0.92) {
      const yBody = JIB_TACK_Y + py;
      const zMain = Math.max(0, zBody - (-0.90));
      const uMain = clamp((yBody - 1.02) / 5.73, 0, 1);
      const chordMain = Math.max(0.35, 2.88 * (1 - uMain) + 0.36 * 4 * uMain * (1 - uMain));
      const vMain = clamp(zMain / chordMain, 0, 1);
      const bMain = 0.33 * Math.sin(Math.PI * vMain) * (1 - 0.55 * uMain) * Math.sin(Math.PI * Math.min(1, 0.15 + uMain * 0.9));
      const twMain = MAIN_TWIST * Math.pow(uMain, 1.18) * (1 - uMain) * 2.05 * Math.pow(vMain, 1.12);
      const boomAng = this.boomA || 0.03;
      const mainScale = this.mainSail ? Math.abs(this.mainSail.scale.x) : 1;
      const mainLeeDist = zMain * Math.sin(boomAng) + (bMain + twMain) * mainScale * Math.cos(boomAng);
      const leeSign = sgn > 0 ? -1 : 1; // スターボード(sgn=1)の風下は -x、ポート(sgn=-1)の風下は +x
      const minOutboard = mainLeeDist + 0.032;
      if (leeSign * px < minOutboard) {
        px = leeSign * minOutboard;
      }
    }
    out.set(px, py, pz);
  }

  updateJibShape(pk, jibRot, camberSigned) {
    const closeF = this._closeFactor ?? 0;
    const eps = this.boat.isPlayer ? 0.004 : 0.015;
    if (Math.abs(pk - this._lastPk) < eps && Math.abs(jibRot - this._lastJibRot) < eps && Math.abs(camberSigned - this._lastJibCamber) < eps && Math.abs((this.boomA || 0) - (this._lastBoomA || 0)) < eps && Math.abs(closeF - (this._lastCloseF || 0)) < eps) return;
    this._lastPk = pk; this._lastJibRot = jibRot; this._lastJibCamber = camberSigned; this._lastBoomA = this.boomA || 0; this._lastCloseF = closeF;

    const clewX = JIB_CLEW_LEN * Math.sin(jibRot);
    // ランチャー展開時はクリューが跳ね上がりすぎずテンションを抜いた自然な高さ(0.16 + 0.54*pk)に保つ
    const clewLocalY = 0.16 + 0.54 * pk;
    const clewLocalZ = JIB_CLEW_LEN * Math.cos(jibRot);
    const pos = this.jibGeo.attributes.position;
    const norm = this.jibGeo.attributes.normal;
    const nxBase = Math.cos(jibRot), nzBase = -Math.sin(jibRot);
    let idx = 0;
    for (let i = 0; i <= JIB_NU; i++) {
      const u = i / JIB_NU;
      for (let j = 0; j <= JIB_NV; j++) {
        const v = j / JIB_NV;
        this.evalJibPoint(u, v, clewX, clewLocalY, clewLocalZ, camberSigned, pk, _v);
        pos.setXYZ(idx, _v.x, _v.y, _v.z);
        if (norm) norm.setXYZ(idx, nxBase, 0.08, nzBase);
        idx++;
      }
    }
    pos.needsUpdate = true;
    if (norm) norm.needsUpdate = true;
  }

  // ジブのテルテール: セール面に常に密着し、風上側が躍る=上り過ぎ、風下側が躍る=落とし過ぎ、リーバウ効果時は風上テルテールが上向きにリフト反応
  syncTells(t, camberSigned, luff, stall, pk = 0, jibRot = 0) {
    const sgn = this.boat.tack;
    const clewX = JIB_CLEW_LEN * Math.sin(jibRot);
    const clewLocalY = 0.16 + 0.54 * pk;
    const clewLocalZ = JIB_CLEW_LEN * Math.cos(jibRot);
    // リーバウ効果やスターン通過リフト(windBend > 0)を受けている時はテルテールがリフト反応を示す
    const leeBowLift = clamp((this.boat.windBend || 0) * 6.0, -0.5, 0.65);
    for (const k of this.tells) {
      const u = k.u, v = TT_V;
      this.evalJibPoint(u, v, clewX, clewLocalY, clewLocalZ, camberSigned, pk, _v);
      k.m.position.set(_v.x + k.side * 0.011, _v.y, _v.z);
      k.mShadow.position.set(_v.x - k.side * 0.008, _v.y, _v.z);

      const windward = k.side === sgn;
      const lift = windward ? Math.max(luff, Math.max(0, leeBowLift) * 0.55) : Math.max(stall, Math.max(0, -leeBowLift) * 0.55);
      const dev = lift * (0.55 + 0.50 * Math.sin(t * 16 + k.ph)) + 0.04 * Math.sin(t * 6 + k.ph);
      const pitchUp = windward && leeBowLift > 0.05 ? -leeBowLift * 0.65 + 0.18 * Math.sin(t * 14 + k.ph) : lift * 0.35 * Math.sin(t * 12 + k.ph);

      k.m.rotation.y = jibRot * (1 - u * 0.6) + k.side * dev;
      k.m.rotation.x = pitchUp;
      k.mShadow.rotation.y = k.m.rotation.y;
      k.mShadow.rotation.x = k.m.rotation.x;
    }
  }

  sync(dt, t) {
    const b = this.boat;
    this.root.position.set(b.x, 0, b.z);
    this.root.rotation.y = -b.h;
    const ph = t * 1.6 + this.phase;
    // 海況に合わせた上下動(ヒーブ)と縦揺れ(ピッチ):
    // 波に100%完全追従して一定の高さが常に海上に出続けるのではなく、船体の慣性で波頭に少し沈み込んだり谷で海面に出たりを繰り返す実艇の挙動を再現
    // (船内・コクピット底への海面貫通は海面フラグメントシェーダー側の船内マスクで防止)
    const hx = Math.sin(b.h), hz = -Math.cos(b.h);
    const ws = waveSample(b.x, b.z, SEA.clock, hx, hz);
    const speedNorm = clamp(Math.abs(b.v) / 2.6, 0, 1);
    const slowFactor = Math.pow(1 - speedNorm, 1.35);
    const downFactor = clamp((b.twa - 1.05) / 0.65, 0, 1);
    const chopRespond = (0.34 + 1.08 * slowFactor) * (1 - 0.65 * downFactor * speedNorm);
    const heave = ws.hLong * 0.84 + (ws.h - ws.hLong) * 0.30 * chopRespond + 0.042 * Math.sin(ph * 1.35);
    // 船尾(z=+2.36)のラダーが波で水面上に飛び出さないようピッチ角の前傾側(-0.045)を抑えつつ、波による上下・縦揺れを表現
    const pitchW = clamp(Math.atan(ws.slopeLong * 0.72 + (ws.slope - ws.slopeLong) * 0.62 * chopRespond), -0.045, 0.105);
    // 横方向の傾き(三角波の交差波で左右にも揺さぶられる + 他艇の引き波通過時の揺れ)
    const wsR = waveSample(b.x, b.z, SEA.clock, -hz, hx);
    const wakeWobble = (b.wakeWave || 0) * 0.045 * Math.sin(t * 11.0 + this.phase);
    const rollW = clamp(Math.atan(wsR.slope) * 0.56 * chopRespond + wakeWobble, -0.115, 0.115);
    this.body.position.y = 0.14 + Math.abs(b.heel) * 0.09 + heave;
    this.body.rotation.z = b.heel + 0.014 * Math.sin(ph * 0.8) - rollW;
    this.body.rotation.x = pitchW + 0.012 * Math.sin(ph * 1.1 + 1) + clamp(b.v / 14, 0, 0.25) * 0.032;

    if (this.rudderGroup) {
      this.rudderGroup.rotation.y = b.steer * 0.6;
    }

    // セール: クローズ走行時はブーム・メインセールをセンターライン近くまでしっかり引き込み、上部リーチがツイストして開く
    const twa = b.twa, luff = b.luff;
    const closeFactor = clamp(1 - (twa - 0.65) / 0.38, 0, 1);
    this._closeFactor = closeFactor;
    const effMainSheet = clamp(b.sheet + closeFactor * 0.045, 0, 1);
    const sheetAng = (0.012 + (1 - closeFactor) * 0.052) + Math.pow(1 - effMainSheet, 1.12) * 1.34;
    let ang = Math.min(sheetAng, Math.max(0.012, Math.abs(b.awa) - 0.12 * closeFactor - 0.04), 1.0); // シュラウド(サイドステー)を突き抜けない上限
    ang += luff * 0.09 * Math.sin(t * 19 + this.phase);
    this.boomA += (ang - this.boomA) * (1 - Math.exp(-dt * (luff > 0.3 ? 14 : 4)));
    const sgn = b.tack;
    this.mainPivot.rotation.y = -sgn * this.boomA;
    // ジブ: クローズ時はさらに一段タイトに引き込み、クローズ以外の角度では従来の自然な引き具合を維持
    // ランニングのランチャーアップ時は、ジブが手前(アフト側)に引かれて風とほぼ直角(90°)になる角度(1.52〜1.66 rad)へ展開
    const pk = b.poleK || 0;
    // ランチャーアップ時はセンターボードを少し引き上げ(+22cm)、フォアステイのテンションを緩めてマストをわずかに前傾させる
    if (this.cbBoard) this.cbBoard.position.y = pk * 0.22;
    if (this.mast) {
      this.mast.rotation.x = -0.018 * pk;
      this.mast.position.z = -0.90 - 0.028 * pk;
    }
    this.syncForestay(pk, sgn);

    const ease = Math.max(0, 0.97 - b.sheet);
    const bearOut = Math.max(0, twa - 0.78) * 0.28;
    const luffOut = luff * (0.28 + 0.09 * Math.sin(t * 21 + this.phase));
    const baseJibIn = 0.076 * closeFactor + 0.19 * (1 - closeFactor);
    const easeWeight = 0.24 * closeFactor + 0.72 * (1 - closeFactor);
    const jibDesired = baseJibIn + ease * easeWeight + bearOut * 0.42 + luffOut;
    const jibMaxAwa = Math.max(0.082 + 0.258 * (1 - closeFactor), Math.abs(b.awa) * 0.92 + luff * 0.28 + ease * 0.35);
    const minJibLee = 0.076 * closeFactor + 0.18 * (1 - closeFactor);
    const jibLee = clamp(Math.min(Math.max(this.boomA * (0.62 * closeFactor + 0.72 * (1 - closeFactor)), jibDesired), jibMaxAwa), minJibLee, 0.82);
    // ランニングのランチャー展開時: 風に対して鈍角(前出)にならず、手前(コクピット側)へ引いて風とほぼ直角になる角度(約88°〜95° = 1.54〜1.66 rad)にする
    const wingAngle = clamp(Math.PI - twa + 0.36, 1.52, 1.66);
    const jibRot = -sgn * jibLee * (1 - pk) + sgn * wingAngle * pk;
    this.jibRot = jibRot;
    this.jibPivot.rotation.y = 0; // ラフをフォアステーに完全固定するためjibPivot自体は回転させず頂点で展開
    const bulgeSign = sgn > 0 ? -1 : 1;
    const jibBulge = pk > 0.5 ? -bulgeSign : bulgeSign;
    const flap = 1 - luff * (0.55 + 0.45 * Math.sin(t * 21 + this.phase));
    const jibLuff = luff * (1 - pk);
    this.mainSail.scale.x = bulgeSign * flap;
    if (this.leechRibbons) {
      const stall = b.stall || 0;
      for (const r of this.leechRibbons) {
        r.m.position.x = r.twistX * this.mainSail.scale.x;
        // 気流が綺麗に流れている時はリーチ延長方向へなびき、引きすぎ(ストール)時は風下裏側へ巻き込み、シバー時はバタつく
        const twistYaw = bulgeSign * (0.14 * r.u);
        const curl = -bulgeSign * stall * (0.75 + 0.55 * Math.sin(t * 20 + r.ph)) + luff * 0.45 * Math.sin(t * 23 + r.ph);
        const flutter = (0.06 + 0.22 * Math.max(luff, stall)) * Math.sin(t * 17 + r.ph);
        r.m.rotation.y = twistYaw + curl + flutter;
        r.m.rotation.x = -0.05 + 0.16 * Math.sin(t * 14 + r.ph) * (0.3 + Math.max(luff, stall));
      }
    }
    // ランチャーアップ時はテンションを抜いてふっくら風をはらんだ深いポケット(0.31)を表現
    const jibCamberScale = 0.132 * closeFactor + (0.23 + 0.085 * pk) * (1 - closeFactor);
    const transitDip = 1 - 0.55 * Math.sin(Math.PI * pk) * (1 - pk * 0.85);
    const jibCamber = jibBulge * jibCamberScale * Math.max(0.08, 1 - jibLuff * (0.55 + 0.45 * Math.sin(t * 25 + this.phase + 1))) * transitDip;
    this.jibSail.scale.x = 1;
    this.jibSail.rotation.x = 0;
    this.updateJibShape(pk, jibRot, jibCamber);

    // ジブクリュー(セール後端角)の正確な3Dボディ座標 (セール頂点 [clewX, 0.16 + 0.54*pk, clewLocalZ] と完全一致)
    const clewX = JIB_CLEW_LEN * Math.sin(jibRot);
    const clewY = JIB_TACK_Y + 0.16 + 0.54 * pk;
    const clewZ = JIB_TACK_Z + JIB_CLEW_LEN * Math.cos(jibRot);

    // ランチャーポール: ブーム基部(y=1.36, z=-0.92)からジブクリューの頂点座標まで寸分違わず届くように配置
    this.poleStow.visible = pk <= 0.01;
    if (pk > 0.01) {
      const boomSlide = (1 - pk) * 0.45;
      const pm = -sgn * this.boomA;
      _root.set(
        POLE_ROOT.x + Math.sin(pm) * boomSlide,
        POLE_ROOT.y,
        POLE_ROOT.z + Math.cos(pm) * boomSlide
      );
      this.pole.position.copy(_root);
      _v.set(clewX, clewY, clewZ).sub(_root);
      const len = _v.length();
      this.pole.quaternion.setFromUnitVectors(_Y, _v.normalize());
      this.pole.scale.set(1, len, 1);
      this.pole.visible = true;
    } else this.pole.visible = false;
    
    if (this.tells) this.syncTells(t, jibCamber, luff, b.stall, pk, jibRot);
    if (this.vanes) {
      const aw = b.awa;
      for (const v of this.vanes) {
        v.g.rotation.y = Math.atan2(-Math.cos(aw), -Math.sin(aw)) + Math.sin(t * 7 + v.ph) * 0.08;
        v.g.rotation.z = -0.15 + Math.sin(t * 9 + v.ph) * 0.06;
      }
    }
    // ランチャーアップ／ダウン時のクルー演出: クルーが前・中央(マスト/センターケース周り)へ動いてランチャー操作＆ボード上げ下げを行う
    if (b.pole !== this._prevPole) {
      this._prevPole = b.pole;
      this.crewPoleTimer = 1.45;
    } else if (this.crewPoleTimer > 0) {
      this.crewPoleTimer = Math.max(0, this.crewPoleTimer - dt);
    }
    const poleMoving = pk > 0.03 && pk < 0.97 ? Math.sin(pk * Math.PI) : 0;
    const crewPoleAct = clamp(Math.max(this.crewPoleTimer / 1.15, poleMoving), 0, 1);

    // クルー・スキッパーの乗船・ハイクアウト姿勢表現
    // 下レグでは 120°〜150° はクルーは船の真ん中(0)に座り、150°以上で風下(-sgn)へ移動する
    this.side += (sgn - this.side) * (1 - Math.exp(-dt * 3));
    const isDeepRun = twa >= (150 * Math.PI) / 180;
    const isMidDown = twa >= (120 * Math.PI) / 180 && !isDeepRun;
    const targetCrewSide = isDeepRun ? -sgn : isMidDown ? 0 : sgn;
    this.crewSide += (targetCrewSide - this.crewSide) * (1 - Math.exp(-dt * 3.5));
    const hikeAmt = b.hike !== undefined ? b.hike : 0.35;
    const lean = isDeepRun ? 0.12 : isMidDown ? 0.18 : clamp(0.10 + hikeAmt * 0.96, 0.10, 1.36);
    const crewLean = ((isDeepRun || isMidDown) ? 0.08 : clamp(0.08 + hikeAmt * 1.06, 0.08, 1.44)) * (1 - 0.85 * crewPoleAct);

    const sideAbs = Math.abs(this.side);
    const crewSideAbs = Math.abs(this.crewSide);
    const boomLow = clamp(1 - (this.boomA - 0.35) / 0.30, 0, 1);

    // ヘルムスマン(スキッパー): 後部サイドデッキ(z=0.86)に座り、強風時はガンネルから水平近くまで深くハイクアウト
    const helmPet = !!this.helm.userData.isRoundPet;
    this.helmRig.position.set(
      this.side * (0.54 + lean * (helmPet ? 0.17 : 0.155)),
      0.35 - (1 - sideAbs) * 0.06 - Math.max(0, lean - 0.85) * (helmPet ? 0.01 : 0.035),
      0.86
    );
    this.helmRig.rotation.y = this.side * 1.35;
    if (this.helm.userData.upper) {
      this.helmRig.rotation.z = 0;
      const duck = (1 - sideAbs) * 0.42 * boomLow;
      const hike = (helmPet ? Math.min(lean * 0.62, 0.76) : lean * 0.96) * sideAbs;
      this.helm.userData.upper.rotation.x = hike - duck;
      this.helm.userData.upper.rotation.z = -this.side * 0.08;
    } else {
      this.helmRig.rotation.z = -this.side * lean * 0.45;
    }
    if (this.helm.userData.head) {
      const uRx = this.helm.userData.upper ? this.helm.userData.upper.rotation.x : 0;
      this.helm.userData.head.rotation.x = -uRx * (helmPet ? 0.55 : 0.68);
      this.helm.userData.head.rotation.y = -this.side * 0.55;
    }

    // クルー(人間・ネコ・イヌとも): 120°〜150°では船の真ん中(x≈0)に座り、強風クローズ時は水平近くまでフルハイクアウト
    const crewPet = !!this.crew.userData.isRoundPet;
    const baseCrewX = this.crewSide * (0.55 + crewLean * (crewPet ? 0.175 : 0.165));
    const baseCrewY = 0.36 - (1 - crewSideAbs) * 0.04 - Math.max(0, crewLean - 0.85) * (crewPet ? 0.01 : 0.04);
    const baseCrewZ = -0.04;
    const actCrewX = sgn * 0.12;
    const actCrewY = 0.39 + 0.03 * Math.sin(t * 14);
    const actCrewZ = -0.30;
    this.crewRig.position.set(
      baseCrewX + (actCrewX - baseCrewX) * crewPoleAct,
      baseCrewY + (actCrewY - baseCrewY) * crewPoleAct,
      baseCrewZ + (actCrewZ - baseCrewZ) * crewPoleAct
    );
    const baseCrewRotY = crewSideAbs < 0.18 ? this.side * 0.35 : this.crewSide * 1.35;
    this.crewRig.rotation.y = baseCrewRotY + (sgn * 0.22 - baseCrewRotY) * crewPoleAct;
    if (this.crew.userData.upper) {
      this.crewRig.rotation.z = 0;
      const cDuck = (1 - crewSideAbs) * 0.45 * boomLow;
      const cHike = (crewPet ? Math.min(crewLean * 0.64, 0.78) : crewLean * 0.98) * crewSideAbs;
      const baseUpperX = cHike - cDuck;
      const actUpperX = -0.52 + 0.14 * Math.sin(t * 16); // マスト・ランチャー側へ前傾して引き出す/収納する動作
      const cu = this.crew.userData.upper;
      cu.rotation.x = baseUpperX + (actUpperX - baseUpperX) * crewPoleAct;
      cu.rotation.z = -this.crewSide * 0.08 * (1 - crewPoleAct);
      // 強風フルハイク時(crewLean > 0.72)は人間クルーの外側(海面側)の腕を外へ伸ばしてモーメントを稼ぐ(実艇写真準拠)
      if (cu.userData.armL && cu.userData.armR) {
        const ext = clamp((crewLean - 0.70) / 0.55, 0, 1) * crewSideAbs * (1 - crewPoleAct);
        const lOut = this.crewSide > 0 ? ext : 0;
        const rOut = this.crewSide < 0 ? ext : 0;
        cu.userData.armL.rotation.set(-0.55 * lOut, 0, -0.82 * lOut);
        cu.userData.armR.rotation.set(-0.55 * rOut, 0, 0.82 * rOut);
      }
    } else {
      this.crewRig.rotation.z = -this.crewSide * crewLean * 0.42 * (1 - crewPoleAct);
    }
    if (this.crew.userData.head) {
      const cRx = this.crew.userData.upper ? this.crew.userData.upper.rotation.x : 0;
      this.crew.userData.head.rotation.x = -cRx * (crewPet ? 0.55 : 0.68);
      this.crew.userData.head.rotation.y = -this.crewSide * 0.50 * (1 - crewPoleAct);
    }

    // カメラ位置：スキッパーの目線近くまで高くし、ハイクアウト時に外側へより大きく乗り出すように調整
    this.mount.position.set(this.side * (0.50 + lean * 0.7), 1.18 - lean * 0.05, 0.95);
    this.syncMainSheet(sgn, lean, sideAbs);
    if (this.rjLeeSegs) this.syncRopes(sgn, clewY, pk);
    this.syncBowSpray(dt, t, ws, sgn);
  }

  // バウしぶき: 通常走行時は上に噴き上げず海面側(wake)でほんのわずかに白くなる表現にとどめ、波にはたかれた時だけ白く上に噴き上げる
  syncBowSpray(dt, t, ws, sgn) {
    if (!this.bowSprayMesh) return;
    const b = this.boat;
    const vAbs = Math.abs(b.v);
    const spdF = clamp((vAbs - 0.72) / 1.75, 0, 1.30);

    // 1) 通常走行時は常時上へ噴き上げる3Dパーティクル(0..15)は出さず非表示にする(船と海面の接地点が白くなるのも防ぐ)
    _spM4.makeScale(0, 0, 0);
    _spCol.setScalar(0);
    for (let i = 0; i < 16; i++) {
      this.bowSprayMesh.setMatrixAt(i, _spM4);
      this.bowSprayMesh.setColorAt(i, _spCol);
    }

    // 2) 波にはたかれた瞬間(visualSlam または波頭スラム)のみ、適度な濃さ・高さで白く上へ上がるしぶき演出 (16..27)
    this.slamAutoCD = Math.max(0, (this.slamAutoCD || 0) - dt);
    if (b.visualSlam > 0.17) {
      this.slamBurstT = 0.001;
      this.slamBurstPow = clamp(0.48 + b.visualSlam * 0.75, 0.48, 1.08);
      b.visualSlam = 0;
    } else if (this.slamBurstT <= 0 && this.slamAutoCD <= 0 && vAbs > 0.78 && ws.h > 0.048 && ws.slope > 0.055) {
      this.slamBurstT = 0.001;
      this.slamBurstPow = clamp(0.45 + (ws.h * 1.4 + ws.slope * 2.4), 0.45, 0.96);
      this.slamAutoCD = 2.3 + Math.random() * 1.5;
    }

    const SLAM_DUR = 0.56;
    if (this.slamBurstT > 0) {
      this.slamBurstT += dt;
      if (this.slamBurstT >= SLAM_DUR) this.slamBurstT = 0;
    }

    for (let j = 0; j < 12; j++) {
      const idx = 16 + j;
      if (this.slamBurstT <= 0) {
        _spM4.makeScale(0, 0, 0);
        this.bowSprayMesh.setMatrixAt(idx, _spM4);
        _spCol.setScalar(0);
        this.bowSprayMesh.setColorAt(idx, _spCol);
        continue;
      }
      const side = j % 2 === 0 ? 1 : -1;
      const tier = (j >> 1) / 5; // 0..1
      const delay = tier * 0.095;
      const u = clamp((this.slamBurstT - delay) / (SLAM_DUR - delay), 0, 1);
      if (u <= 0 || u >= 1) {
        _spM4.makeScale(0, 0, 0);
        this.bowSprayMesh.setMatrixAt(idx, _spM4);
        _spCol.setScalar(0);
        this.bowSprayMesh.setColorAt(idx, _spCol);
        continue;
      }
      const pow = this.slamBurstPow;
      const arc = Math.sin(u * Math.PI);
      // 波にはたかれた瞬間だけ、バウ外側へ適度な濃さ・高さ(中間バランス)で白く上がって散る
      const x = side * (0.43 + tier * 0.15 + u * (0.68 + tier * 0.42) * pow);
      const y = 0.22 + arc * (0.48 + (1 - tier * 0.35) * 0.42) * pow - u * u * 0.18;
      const z = -2.15 + tier * 0.45 + u * (1.16 + spdF * 0.48);
      const sz = (0.16 + u * 0.27) * pow;
      _spPos.set(x, y, z);
      _spEul.set(u * 2.1 + j, side * (0.45 + u), u * 1.65);
      _spQuat.setFromEuler(_spEul);
      _spScale.set(sz * 1.0, sz * 0.92, sz * 1.30);
      _spM4.compose(_spPos, _spQuat, _spScale);
      this.bowSprayMesh.setMatrixAt(idx, _spM4);
      const fade = Math.pow(1 - u, 1.50) * Math.min(1, u * 7.0) * clamp(0.28 * pow, 0.14, 0.36);
      _spCol.setRGB(0.91 * fade, 0.97 * fade, 1.0 * fade);
      this.bowSprayMesh.setColorAt(idx, _spCol);
    }

    this.bowSprayMesh.instanceMatrix.needsUpdate = true;
    if (this.bowSprayMesh.instanceColor) this.bowSprayMesh.instanceColor.needsUpdate = true;
  }

  // メインシート(実艇写真2・3枚目準拠・共有Cylinderセグメント方式で毎フレームのアロケーション0):
  // 後部ブライドル(z=1.56) → ブーム後端ブロック(bz=2.52) → ブーム下面に沿って中央ブロック(bz=1.18) →
  // センターケース後端のフロアブロック(z=0.10)へ真っ直ぐ降り、そこからスキッパーの前手へ直線的に繋がる
  syncMainSheet(sgn, lean, sideAbs) {
    if (!this.mainSheetSegs) return;
    const pm = -sgn * this.boomA;
    const sinP = Math.sin(pm), cosP = Math.cos(pm);
    const bzAft = 2.52, bzMid = 1.18;
    _p0.set(0, FLOOR_Y + 0.28, 1.56);
    _p1.set(bzAft * sinP, 1.35, -0.9 + bzAft * cosP);
    _p2.set(bzMid * sinP, 1.35, -0.9 + bzMid * cosP);
    _p3.set(0, FLOOR_Y + 0.16, 0.10);
    _p4.set(this.side * (0.30 + lean * 0.20), 0.62 - lean * 0.04 - (1 - sideAbs) * 0.12, 0.72);
    placeSeg(this.mainSheetSegs[0], _p0, _p1);
    placeSeg(this.mainSheetSegs[1], _p1, _p2);
    placeSeg(this.mainSheetSegs[2], _p2, _p3);
    placeSeg(this.mainSheetSegs[3], _p3, _p4);
  }

  // 走る索: ジブシート(ジブクリュー → サイドデッキのジブカム → クルーの手元まで真っ直ぐ一直線に結ぶ)
  syncRopes(sgn, clewY = 0.73, pk = 0) {
    const pj = this.jibRot;
    _p0.set(JIB_CLEW_LEN * Math.sin(pj), clewY, JIB_TACK_Z + JIB_CLEW_LEN * Math.cos(pj));
    // 通常航行時は風下(-sgn)のジブカム、ランチャー展開時(pk>0.5)は風上(sgn)のジブカムを経由
    const sheetSide = pk > 0.5 ? sgn : -sgn;
    const xCam = sheetSide * 0.62;
    _p1.set(xCam, deckY(-0.08, xCam) + 0.025, -0.08);
    // ジブカム(_p1)からクルーの手元(_p2)まで途中で折れ曲がらず真っ直ぐ繋ぐ
    const handX = this.crewRig.position.x - Math.sign(this.crewRig.position.x || sgn) * 0.12;
    const handY = this.crewRig.position.y + 0.22;
    const handZ = this.crewRig.position.z - 0.02;
    _p2.set(handX, handY, handZ);
    placeSeg(this.rjLeeSegs[0], _p0, _p1);
    placeSeg(this.rjLeeSegs[1], _p1, _p2);
  }
}


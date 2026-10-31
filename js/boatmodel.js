// スナイプ級の3Dモデルとリアルな見た目の同期
import * as THREE from 'three';
import { buildFigure } from './crew.js';
import { buildHull, block, rope, ropeGeo, ropeMat, M, FLOOR_Y, deckY } from './snipehull.js';
import { clamp, waveSample, SEA, BASE_WIND_KT } from './sim.js';

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
const MAIN_TWIST = 0.42;
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
      // 各バテン(0.32, 0.56, 0.78)を境にセール面のツイスト角が段階的に変化し、マストヘッド(u=1)では必ず0に収束させる
      const s1 = Math.max(0, u - 0.32), s2 = Math.max(0, u - 0.56), s3 = Math.max(0, u - 0.78);
      battenFacetTwist = (0.14 * s1 + 0.18 * s2 + 0.22 * s3) * (1 - u);
    }
    const rx = clew[0] + u * (head[0] - clew[0]), ry = clew[1] + u * (head[1] - clew[1]), rz = clew[2] + u * (head[2] - clew[2]) + roachZ;
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      // バテンが入る後半部(v > 0.42)はバテンで直線的に支えられ、バテンライン上でわずかに角度が変わる立体リッジを形成(マスト上部u→1では0に減衰)
      let battenRidge = 0;
      let aftFlatten = 1.0;
      const headTaper = 1 - u;
      if (withBattens && v > 0.38) {
        const vWeight = Math.pow((v - 0.38) / 0.62, 0.85) * headTaper;
        aftFlatten = 1.0 - 0.12 * vWeight;
        for (let bi = 0; bi < LEECH_RIBBON_US.length; bi++) {
          const bu = LEECH_RIBBON_US[bi];
          const du = (u - bu) / 0.032;
          battenRidge += 0.016 * Math.exp(-du * du) * Math.sin(Math.PI * Math.min(1, (v - 0.35) / 0.65)) * headTaper;
        }
        // バテンとバテンの間のパネルでわずかに面角度が切り替わるファセット効果
        const seg = u < 0.32 ? u / 0.32 : u < 0.56 ? (u - 0.32) / 0.24 : u < 0.78 ? (u - 0.56) / 0.22 : (u - 0.78) / 0.22;
        battenRidge -= 0.009 * Math.sin(Math.PI * seg) * vWeight;
      }
      const b = bulge * Math.sin(Math.PI * v) * aftFlatten * (1 - 0.50 * u) * Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.85));
      // クローズ引き込み時にメインセール下部はセンター近くまで引き込まれつつ、中〜上部リーチがわずかに開き、マスト頂部(u=1)では0に収束するツイスト形状
      const twistX = (twist * Math.pow(u, 1.15) * (1 - u) * 2.02 + battenFacetTwist) * Math.pow(v, 1.08);
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

const mainGeo = sailGeometry([0, 1.02, 0], [0, 6.75, 0.08], [0, 0.98, 2.88], 0.37, 28, 12, 0.36, MAIN_TWIST, true);
const jibGeo = sailGeometry([0, 0, 0], [0, JIB_HEAD_Y, JIB_HEAD_Z], [0, 0.22, JIB_CLEW_LEN], 0.20, JIB_NU, JIB_NV);
const mastGeo = new THREE.CylinderGeometry(0.035, 0.046, 6.9, 12);
// ブーム: 実艇写真(1・3・5枚目)準拠のやや大きめ・角丸四角断面(ボックスセクション: 幅4.6cm × 高さ7.2cm × 長さ2.88m)のアルミブーム
const boomGeo = (() => {
  const hw = 0.023, hh = 0.036, b = 0.006;
  const sh = new THREE.Shape();
  sh.moveTo(-hw + b, -hh);
  sh.lineTo(hw - b, -hh);
  sh.quadraticCurveTo(hw, -hh, hw, -hh + b);
  sh.lineTo(hw, hh - b);
  sh.quadraticCurveTo(hw, hh, hw - b, hh);
  sh.lineTo(-hw + b, hh);
  sh.quadraticCurveTo(-hw, hh, -hw, hh - b);
  sh.lineTo(-hw, -hh + b);
  sh.quadraticCurveTo(-hw, -hh, -hw + b, -hh);
  const g = new THREE.ExtrudeGeometry(sh, { depth: 2.88, bevelEnabled: false, curveSegments: 2 });
  g.translate(0, 0, -1.44);
  g.computeVertexNormals();
  return g;
})();

// セール文字カラーパレット (自艇は青固定、CP艇は赤・黒・緑・青に振り分け)
const SAIL_LETTER_PALETTE = [
  { main: '#123e96', ghost: 'rgba(18, 62, 150, 0.22)' }, // 青
  { main: '#c81e24', ghost: 'rgba(200, 30, 36, 0.20)' }, // 赤
  { main: '#181c24', ghost: 'rgba(24, 28, 36, 0.20)' },  // 黒
  { main: '#0f7a3c', ghost: 'rgba(15, 122, 60, 0.20)' }, // 緑
];

// メインセールテクスチャ: 実艇写真準拠の3本バテンポケット、パネルシーム、スナイプ鳥マーク、国別コード & 4色セールNo、マスト側下部の控えめな青いロゴ、下部クリアウィンドウ
function mainSailTexture(no, color, nat = 'JPN', isPlayer = false) {
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

    x.fillStyle = 'rgba(214, 222, 232, 0.90)';
    x.strokeStyle = 'rgba(168, 180, 195, 0.85)';
    x.lineWidth = 1.4;
    x.fillRect(x0 - 6, y0 - 11, 22, 22);
    x.strokeRect(x0 - 6, y0 - 11, 22, 22);

    x.fillStyle = '#1e293b';
    x.fillRect(496, y1 - 7, 16, 14);
    x.restore();
  }

  // セール文字・鳥マークの色選択: 自艇は常に青(#123e96)、CP艇は赤・黒・緑・青に振り分け
  let palIdx = 0;
  if (!isPlayer) {
    const numVal = parseInt(String(no || '').replace(/\D/g, ''), 10) || 1;
    palIdx = ((numVal % 4) + 4) % 4;
  }
  const letterCol = SAIL_LETTER_PALETTE[palIdx].main;
  const ghostCol = SAIL_LETTER_PALETTE[palIdx].ghost;
  const natCode = isPlayer ? 'JPN' : String(nat || 'JPN').toUpperCase().slice(0, 3);

  // 4) 帆の上部: スナイプ級の象徴である「鳥のマーク(飛ぶシギのシルエット)」
  x.save();
  x.translate(242, 172);
  x.scale(1.28, 1.28);
  x.fillStyle = letterCol;
  x.beginPath();
  x.moveTo(46, -8);
  x.lineTo(18, -5);
  x.quadraticCurveTo(10, -9, 2, -4);
  x.quadraticCurveTo(-8, -26, -34, -22);
  x.quadraticCurveTo(-20, -10, -14, -2);
  x.lineTo(-36, 8);
  x.lineTo(-22, 11);
  x.quadraticCurveTo(-2, 12, 12, 2);
  x.lineTo(20, -1);
  x.closePath();
  x.fill();
  x.restore();

  // 5) 国コード(自艇はJPN、他艇は国別コード) ＋ 裏面透け文字 — トップバテンとミドルバテンの間に配置
  x.fillStyle = letterCol;
  x.font = 'bold 84px Arial, sans-serif';
  x.textAlign = 'center';
  x.save();
  x.translate(244, 336);
  x.rotate(0.06);
  x.fillText(natCode, 0, 0);
  x.restore();

  x.save();
  x.translate(238, 416);
  x.rotate(0.06);
  x.scale(-1, 1);
  x.fillStyle = ghostCol;
  x.font = 'bold 84px Arial, sans-serif';
  x.fillText(natCode, 0, 0);
  x.restore();

  // 6) セールナンバー ＋ 裏面透けナンバー(左右反転) — ミドルバテンとローワーバテンの間に配置
  const numText = no && no.length >= 4 ? no : '31804';
  x.save();
  x.translate(254, 548);
  x.rotate(0.06);
  x.fillStyle = letterCol;
  x.font = 'bold 84px Arial, sans-serif';
  x.fillText(numText, 0, 0);
  x.restore();

  x.save();
  x.translate(246, 632);
  x.rotate(0.06);
  x.scale(-1, 1);
  x.fillStyle = ghostCol;
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

  // 8) メインセールのマスト側下部(タック付近)の青いセールメーカー/クラスロゴ(画像5枚目準拠・かなり目立たない控えめな表現)
  x.save();
  x.translate(34, 948);
  x.beginPath();
  x.ellipse(0, 0, 12, 9.5, -0.12, 0, Math.PI * 2);
  x.fillStyle = 'rgba(18, 62, 150, 0.38)';
  x.fill();
  x.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  x.lineWidth = 1.2;
  x.beginPath();
  x.moveTo(-7, 5);
  x.lineTo(7, -5);
  x.stroke();
  x.restore();

  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

// ジブセールテクスチャ: 実艇写真(画像4枚目)準拠のパネルシーム、前下部の青いNorth Sailsロゴマーク、コンパクトな透明ウインドウ
let jibTex = null;
function jibTexture() {
  if (jibTex) return jibTex;
  const c = document.createElement('canvas'); c.width = 256; c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(251, 252, 254, 0.97)';
  x.fillRect(0, 0, 256, 512);

  // ラフ・フット補強テープとコーナーパッチ
  x.fillStyle = 'rgba(236, 241, 247, 0.85)';
  x.fillRect(0, 0, 10, 512);
  x.fillRect(0, 498, 256, 14);
  for (const [cx, cy, r] of [[0, 512, 48], [256, 512, 54], [0, 0, 42]]) {
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.fillStyle = 'rgba(232, 238, 245, 0.72)';
    x.fill();
  }

  // パネルシームライン (画像4枚目のわずかに斜め上へ走るクロスカットシーム)
  x.strokeStyle = 'rgba(208, 216, 226, 0.88)';
  x.lineWidth = 1.5;
  for (let y = 48; y < 500; y += 52) {
    x.beginPath(); x.moveTo(0, y + 6); x.lineTo(256, y - 4); x.stroke();
  }

  // ジブセール前下部(タック角付近)の青いロゴマーク (画像4枚目準拠の青い楕円North Sailsロゴ)
  x.save();
  x.translate(30, 444);
  x.rotate(-0.10);
  x.beginPath();
  x.ellipse(0, 0, 14, 10.5, 0, 0, Math.PI * 2);
  x.fillStyle = '#124098';
  x.fill();
  x.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  x.lineWidth = 1.5;
  x.beginPath();
  x.moveTo(-8, 6);
  x.lineTo(8, -6);
  x.stroke();
  x.fillStyle = '#ffffff';
  x.font = 'bold 7px Arial, sans-serif';
  x.textAlign = 'center';
  x.fillText('N', -4, -1);
  x.fillText('S', 4, 6);
  x.restore();

  // ジブセール下部の透明ウインドウ (実艇写真準拠のコンパクトなクリア窓)
  const wx = 60, wy = 420, ww = 96, wh = 34;
  x.clearRect(wx, wy, ww, wh);
  x.fillStyle = 'rgba(190, 225, 250, 0.16)';
  x.fillRect(wx, wy, ww, wh);
  // 透明ビニール窓の細い反射ハイライト線
  x.strokeStyle = 'rgba(255, 255, 255, 0.38)';
  x.lineWidth = 1.5;
  x.beginPath();
  x.moveTo(wx + 24, wy + wh - 4); x.lineTo(wx + 62, wy + 4);
  x.moveTo(wx + 70, wy + wh - 4); x.lineTo(wx + 92, wy + 4);
  x.stroke();
  // 窓枠の白い補強テープ縁取り
  x.strokeStyle = 'rgba(230, 236, 242, 0.96)';
  x.lineWidth = 5;
  x.strokeRect(wx, wy, ww, wh);
  x.strokeStyle = 'rgba(165, 182, 200, 0.85)';
  x.lineWidth = 1.4;
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
const poleTipSegGeo = new THREE.CylinderGeometry(0.0038, 0.0038, 1, 6); poleTipSegGeo.translate(0, 0.5, 0); // ランチャー先端→ジブセール用のやや細めジオメトリ
const mainSheetMat = ropeMat(0x86efac);
const jibSheetMatL = ropeMat(0x38bdf8); // クルーが持つジブシートは水色
const jibSheetMatW = ropeMat(0x94a3b8); // ランチャーポール先端からジブセールにつながる部分は灰色
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

// =========================================================================
// 船体バウ・チャイン＆ラダーで海面を切り裂く3D水流・バウウェーブ＆ラダー水流メッシュ
// 実艇動画に基づき、船と海面の境界に沿って立ち上がる薄い水膜(メニスカス)・バウからのV字水切り波・
// トランサム＆ラダーブレードが水を切る白い水流の筋を艇速・波高・ヒール角・舵角に連動してリアルタイム生成する
// =========================================================================
let _waterCutGeo = null;
function hullWaterHalfWidth(z) {
  if (z <= -2.35) return 0.015;
  if (z < 0.15) {
    const t = clamp((z + 2.35) / 2.50, 0, 1);
    return 0.015 + 0.715 * Math.pow(Math.sin(t * Math.PI * 0.5), 0.86);
  }
  const t = clamp((z - 0.15) / 2.21, 0, 1);
  return 0.73 - 0.25 * Math.pow(t, 1.35);
}
function getWaterCutGeo() {
  if (_waterCutGeo) return _waterCutGeo;
  const pos = [], uv = [], part = [], idx = [];
  let vBase = 0;

  // 1) 左右ハル水線・バウ水切り波リボン (z = -2.36 〜 +2.32, NU=20, NV=5)
  const H_NU = 20, H_NV = 5;
  for (const side of [-1, 1]) {
    for (let i = 0; i <= H_NU; i++) {
      const u = i / H_NU;
      const z = -2.36 + u * 4.68;
      const hx = hullWaterHalfWidth(z);
      for (let j = 0; j <= H_NV; j++) {
        const v = j / H_NV;
        pos.push(side * hx, 0, z);
        uv.push(u, v);
        part.push(side, 0.0, hx);
      }
    }
    for (let i = 0; i < H_NU; i++) {
      for (let j = 0; j < H_NV; j++) {
        const a = vBase + i * (H_NV + 1) + j;
        const b = a + 1, c = a + (H_NV + 1), d = c + 1;
        if (side > 0) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    }
    vBase += (H_NU + 1) * (H_NV + 1);
  }

  // 2) ラダーブレード＆トランサム水切りストリーム (z = +2.28 〜 +4.35, R_NU=16, R_NV=6)
  const R_NU = 16, R_NV = 6;
  for (let i = 0; i <= R_NU; i++) {
    const u = i / R_NU;
    const z = 2.28 + u * 2.07;
    for (let j = 0; j <= R_NV; j++) {
      const v = j / R_NV; // 0(左端) .. 0.5(ラダー中心) .. 1(右端)
      pos.push(0, 0, z);
      uv.push(u, v);
      part.push((v - 0.5) * 2.0, 1.0, 0.0);
    }
  }
  for (let i = 0; i < R_NU; i++) {
    for (let j = 0; j < R_NV; j++) {
      const a = vBase + i * (R_NV + 1) + j;
      const b = a + 1, c = a + (R_NV + 1), d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 3));
  g.setIndex(idx);
  _waterCutGeo = g;
  return _waterCutGeo;
}

function makeWaterCutMat() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: 0 },
      uWave: { value: 0 },
      uHeel: { value: 0 },
      uSteer: { value: 0 },
      uRudderDrag: { value: 0 },
      uOpacity: { value: 1.0 },
    },
    vertexShader: `
      attribute vec3 aPart;
      uniform float uTime;
      uniform float uSpeed;
      uniform float uWave;
      uniform float uHeel;
      uniform float uSteer;
      uniform float uRudderDrag;
      varying vec2 vUv;
      varying float vKind;
      varying float vSideBoost;
      void main() {
        vUv = uv;
        float side = aPart.x;
        float kind = aPart.y;
        float hx = aPart.z;
        vKind = kind;
        vec3 p = position;
        float spd = clamp(uSpeed, 0.0, 1.45);
        float wav = clamp(uWave, 0.0, 1.35);

        if (kind < 0.5) {
          // 1) ハル水線・バウ水切り波リボン
          float u = uv.x;
          float v = uv.y;
          // ヒールしている側(風下チャイン)がより深く水を捉えて強い水切り波を生む
          float leeBoost = clamp(1.0 - side * uHeel * 2.2, 0.55, 1.55);
          vSideBoost = leeBoost;
          // 船体水線すぐ脇(v=0)から外側斜め後方(v=1)へ広がるケルビンバウ波幅 (ほんのわずかに大きめに調整)
          float spreadW = (0.052 + (0.16 + 0.48 * pow(u, 0.82)) * (0.20 + 0.76 * spd + 0.38 * wav)) * leeBoost;
          // ヒールに伴う水線の横ずれ補正
          float heelShift = -uHeel * 0.14;
          p.x = side * (hx + v * spreadW) + heelShift;
          // バウ〜フォアフット(u < 0.42)で水を左右へ押し分けながら立ち上がる薄い水膜リップ
          float bowEnv = sin(clamp(u / 0.44, 0.0, 1.0) * 3.14159265);
          float lipH = (1.0 - v) * (1.0 - v * 0.65) * bowEnv * (0.028 + 0.078 * spd + 0.086 * wav) * leeBoost;
          // 船体側面の水線メニスカス(水とハルの境界を自然に馴染ませる微かなせり上がり)
          float chineLip = (1.0 - smoothstep(0.0, 0.38, v)) * (1.0 - u * 0.55) * (0.016 + 0.028 * spd);
          float ripple = 0.009 * sin(u * 22.0 - uTime * (5.0 + 5.5 * spd) + v * 6.0) * spd * v;
          p.y = 0.012 + lipH + chineLip + ripple;
          p.z += v * (0.14 + 0.32 * spd) * u;
        } else {
          // 2) ラダーブレード＆トランサム水切りストリーム
          float u = uv.x;
          float rSide = side; // -1 .. +1
          vSideBoost = 1.0 + uRudderDrag * 0.8;
          // ラダー前縁(u=0.04)で鋭く水を割り、後方へV字に広がる乱流シート
          float halfW = 0.030 + (0.105 + 0.30 * pow(u, 0.78)) * (0.30 + 0.68 * spd + 0.50 * uRudderDrag + 0.25 * wav);
          // 舵角(uSteer)に応じてラダー直後の水流軌道がしなる
          float deflect = -uSteer * pow(u, 1.28) * (0.32 + 0.24 * spd);
          p.x = deflect + rSide * halfW;
          // ラダーブレードが水を切る襟状の盛り上がり(ラダーカラー)
          float collarEnv = exp(-pow((u - 0.06) / 0.085, 2.0)) * (1.0 - abs(rSide) * 0.75);
          float collarH = collarEnv * (0.028 + 0.062 * spd + 0.050 * uRudderDrag + 0.028 * wav);
          p.y = 0.014 + collarH;
        }
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform float uTime;
      uniform float uSpeed;
      uniform float uWave;
      uniform float uRudderDrag;
      uniform float uOpacity;
      varying vec2 vUv;
      varying float vKind;
      varying float vSideBoost;

      float hh(vec2 p) { p = mod(p, 289.0); return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hh(i), hh(i + vec2(1.0, 0.0)), f.x), mix(hh(i + vec2(0.0, 1.0)), hh(i + vec2(1.0, 1.0)), f.x), f.y);
      }

      void main() {
        float spd = clamp(uSpeed, 0.0, 1.45);
        if (spd < 0.04 && uWave < 0.05) discard;
        float u = vUv.x;
        float v = vUv.y;
        float flowT = uTime * (2.6 + 4.8 * spd);

        if (vKind < 0.5) {
          // ハル水線・バウ水切り波: 船体直近の透き通った水膜光沢＋バウ先から後方へ流れる繊細な気泡筋
          float n1 = vn(vec2(v * 5.2, u * 11.0 - flowT));
          float n2 = vn(vec2(v * 11.5 + 3.1, u * 22.0 - flowT * 1.35));
          float streak = 0.55 * n1 + 0.45 * n2;
          // 内側(v=0: 船体キワ)は滑らかに立ち上がり、外側(v=1)と後端(u=1)で自然に海面へ溶け込む
          float edgeIn = smoothstep(0.0, 0.09, v);
          float edgeOut = pow(max(0.0, 1.0 - v), 1.65);
          float bowFade = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.68, 1.0, u));
          // バウが水を切る先端部(u < 0.36)のリップハイライト
          float bowCrest = smoothstep(0.38, 0.04, u) * smoothstep(0.55, 0.08, v) * (0.45 + 0.55 * streak);
          // ケルビン波の外縁に沿って走る細い水紋ライン
          float kelvinRidge = exp(-pow((v - (0.42 + 0.32 * u)) / 0.18, 2.0)) * (0.4 + 0.6 * n1);
          float intensity = (bowCrest * 0.75 + kelvinRidge * 0.52 + edgeOut * streak * 0.38) * edgeIn * bowFade;
          float act = clamp((spd * 0.75 + uWave * 0.55) * vSideBoost, 0.0, 1.32);
          float alpha = clamp(intensity * act * 0.66 * uOpacity, 0.0, 0.74);
          if (alpha < 0.01) discard;
          vec3 waterSheen = vec3(0.58, 0.84, 0.95);
          vec3 foamWhite = vec3(0.95, 0.99, 1.0);
          vec3 col = mix(waterSheen, foamWhite, clamp(bowCrest * 0.85 + streak * 0.45 + uWave * 0.3, 0.0, 1.0));
          gl_FragColor = vec4(col, alpha);
        } else {
          // ラダー水切り＆トランサム渦流: ラダー前縁の水割りカラーと後方へ伸びる白い水流筋
          float rDist = abs(v - 0.5) * 2.0; // 0(中心) .. 1(外縁)
          float n1 = vn(vec2(rDist * 4.5, u * 10.5 - flowT * 1.25));
          float n2 = vn(vec2(v * 9.0 + 1.7, u * 19.0 - flowT * 1.6));
          float turb = 0.55 * n1 + 0.45 * n2;
          // ラダーブレード直近(u < 0.18)のV字水切りカラー
          float collar = smoothstep(0.22, 0.02, u) * (1.0 - smoothstep(0.0, 0.78, rDist));
          // ラダー後方へ尾を引く2本の剥離渦と中央の気泡ストリーム
          float twinVortex = exp(-pow((rDist - (0.25 + 0.35 * u)) / 0.24, 2.0));
          float centerStream = (1.0 - smoothstep(0.0, 0.68, rDist)) * (0.45 + 0.55 * turb);
          float uEnv = smoothstep(0.0, 0.04, u) * pow(max(0.0, 1.0 - u), 1.25);
          float rAct = clamp(spd * 0.72 + uRudderDrag * 0.78 + uWave * 0.28, 0.0, 1.40);
          float alpha = clamp((collar * 0.80 + (twinVortex * 0.52 + centerStream * 0.55) * turb) * uEnv * rAct * 0.70 * uOpacity, 0.0, 0.78);
          if (alpha < 0.01) discard;
          vec3 col = mix(vec3(0.62, 0.86, 0.96), vec3(0.96, 0.99, 1.0), clamp(collar * 0.9 + turb * 0.5 + uRudderDrag * 0.4, 0.0, 1.0));
          gl_FragColor = vec4(col, alpha);
        }
      }
    `,
  });
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
    // 初心者・中級CP艇のマストトップに取り付けられる黒い球体フロート(黒球: 沈防止浮力体・参考画像1枚目準拠)
    const blackBallMat = new THREE.MeshStandardMaterial({ color: 0x16191f, roughness: 0.42, metalness: 0.08 });
    const blackBallGrp = new THREE.Group();
    const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(0.185, 16, 12), blackBallMat);
    ballMesh.scale.set(0.95, 1.05, 0.95);
    ballMesh.position.set(0, 3.22, 0.14);
    const ballStem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.14, 8), blackBallMat);
    ballStem.rotation.x = Math.PI / 2;
    ballStem.position.set(0, 3.22, 0.04);
    blackBallGrp.add(ballMesh, ballStem);
    blackBallGrp.visible = !!boat.hasBlackBall;
    mast.add(blackBallGrp);
    this.blackBall = blackBallGrp;

    // 舵 (白ラダーヘッド & 水線上のラダー上部) & アルミティラー + ユニバーサルジョイント + エクステンションバー
    // ティラー先端(z=-1.17)にユニバーサルジョイントを設け、ティラーエクステンションの根元がティラー先端に完全接続された状態にする
    const rudderGroup = new THREE.Group(); rudderGroup.position.set(0, 0.4, 2.36);
    const rudderHead = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.22, 0.20), M.gel); rudderHead.position.set(0, -0.05, 0.08); rudderGroup.add(rudderHead);
    const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.42, 0.26), M.gel); rudder.position.set(0, -0.25, 0.12); rudderGroup.add(rudder);
    const tiller = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 1.18, 10), M.alu); tiller.rotation.x = Math.PI / 2; tiller.position.set(0, 0.05, -0.58); rudderGroup.add(tiller);
    const tillerJointCap = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.024, 0.034), M.alu); tillerJointCap.position.set(0, 0.05, -1.17); rudderGroup.add(tillerJointCap);
    const tillerJointBall = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), M.rubber); tillerJointBall.position.set(0, 0.05, -1.17); rudderGroup.add(tillerJointBall);
    const extSegGeo = new THREE.CylinderGeometry(0.0095, 0.0105, 1, 8); extSegGeo.translate(0, 0.5, 0);
    this.tillerExt = new THREE.Mesh(extSegGeo, carbonMat); rudderGroup.add(this.tillerExt);
    this.tillerExtGrip = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 6), M.rubber); rudderGroup.add(this.tillerExtGrip);
    _p0.set(0, 0.05, -1.17); _p1.set((boat.tack || 1) * 0.52, 0.13, -1.48);
    placeSeg(this.tillerExt, _p0, _p1);
    this.tillerExtGrip.position.copy(_p1);
    this.rudderGroup = rudderGroup; this.body.add(rudderGroup);

    const tex = mainSailTexture(String(boat.sailNo), boat.color, boat.nat, boat.isPlayer);
    // メインセール・ジブともに小さい透明ウインドウが自然に透けつつdepthWriteで前後ソート崩れを防ぐ
    this.sailMat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.62, metalness: 0.04, transparent: true, opacity: 0.99, depthWrite: true });
    this.jibMat = new THREE.MeshStandardMaterial({ map: jibTexture(), side: THREE.DoubleSide, roughness: 0.58, transparent: true, opacity: 0.98, depthWrite: true });

    this.mainPivot = new THREE.Group(); this.mainPivot.position.set(0, 0.4, -0.9); this.body.add(this.mainPivot);
    this.mainGeo = mainGeo.clone();
    this._baseMainPos = new Float32Array(this.mainGeo.attributes.position.array);
    this._lastShroudPress = -1;
    this.mainSail = new THREE.Mesh(this.mainGeo, this.sailMat); this.mainPivot.add(this.mainSail);
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
    // ゴースネック / メンタック(2周結び・かなり控えめ) / カニンガム(控えめ)
    const gn = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.052, 0.072), M.alu); gn.position.set(0, 1.02, 0.02); this.mainPivot.add(gn);
    // メンタック(Maintack): マストとメインセール下端(タック角)の間を2周して結ぶ細い紐 (目立たない控えめな太さ・色)
    for (const dy of [0.042, 0.054]) {
      const mtLoop = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.0020, 6, 12), ropeMat(0x64748b));
      mtLoop.rotation.x = Math.PI / 2;
      mtLoop.scale.set(0.72, 1.18, 1);
      mtLoop.position.set(0, 1.02 + dy, 0.018);
      this.mainPivot.add(mtLoop);
    }
    // カニンガム(Cunningham): タックの少し上(y=1.22, z=0.042)のアイレットからグースネック脇を通ってマスト基部へ降りる控えめな細紐
    const cunEye = new THREE.Mesh(new THREE.TorusGeometry(0.0065, 0.0018, 6, 10), M.steel);
    cunEye.rotation.y = Math.PI / 2;
    cunEye.position.set(0, 1.22, 0.042);
    this.mainPivot.add(cunEye);
    this.mainPivot.add(rope([[0, 1.22, 0.042], [0.010, 1.02, 0.028], [0.008, 0.14, 0.024]], 0x64748b, 0.0021));

    // ブーム後端の二股メインシート用ツインブロック(bz=2.56, bz=2.34) & 中央ブロック(bz=1.18)
    const bb = block(0.019, 0x1e293b); bb.position.set(0, 0.965, 2.56); this.mainPivot.add(bb);
    const bbAft2 = block(0.017, 0x1e293b); bbAft2.position.set(0, 0.965, 2.34); this.mainPivot.add(bbAft2);
    const bbMid = block(0.020, 0x1e293b); bbMid.position.set(0, 0.965, 1.18); this.mainPivot.add(bbMid);
    const bEnd = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.074, 0.036), M.alu); bEnd.position.set(0, 1.02, 2.86); this.mainPivot.add(bEnd);

    // バング(Boom Vang): 実艇写真(1・3枚目)準拠の小さめの滑車(ブーム側ブロック・中間カスケードブロック・マスト基部スイベルブロック)とマルチパーチェスライン
    const vangBail = new THREE.Mesh(new THREE.BoxGeometry(0.050, 0.028, 0.024), M.steel); vangBail.position.set(0, 0.985, 0.58); this.mainPivot.add(vangBail);
    const vbBoom = block(0.014, 0x1e293b); vbBoom.position.set(0, 0.955, 0.58); this.mainPivot.add(vbBoom);
    const vbMid = block(0.013, 0x1e293b); vbMid.position.set(0, 0.54, 0.30); this.mainPivot.add(vbMid);
    const vangTangM = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.026, 0.038), M.steel); vangTangM.position.set(0, 0.11, 0.032); this.mainPivot.add(vangTangM);
    const vbMast = block(0.015, 0x1e293b); vbMast.position.set(0, 0.12, 0.048); this.mainPivot.add(vbMast);
    this.mainPivot.add(
      rope([[0, 0.955, 0.58], [0, 0.555, 0.305]], 0x64748b, 0.0044),
      rope([[0.008, 0.535, 0.30], [0.009, 0.125, 0.048]], 0x38bdf8, 0.0036),
      rope([[-0.008, 0.535, 0.30], [-0.009, 0.125, 0.048]], 0x38bdf8, 0.0036),
      rope([[0, 0.535, 0.295], [0, 0.12, 0.044]], 0xe11d48, 0.0034)
    );

    // 後部二股ブライドル(Port/Starboardデッキ金具 z=1.62, x=±0.42 から中央頂点ブロックへ二股に分かれて船体とつながる構造)
    const brApexY = FLOOR_Y + 0.36, brApexZ = 1.58;
    for (const sg of [-1, 1]) {
      const bx = sg * 0.42, bz = 1.62, by = deckY(bz, bx);
      const padEye = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.014, 0.034), M.steel);
      padEye.position.set(bx, by + 0.007, bz);
      this.body.add(padEye);
      this.body.add(rope([[bx, by + 0.012, bz], [sg * 0.012, brApexY - 0.01, brApexZ]], 0x475569, 0.0048));
    }
    const aftBridleBlk = block(0.018, 0x1e293b); aftBridleBlk.position.set(0, brApexY, brApexZ); this.body.add(aftBridleBlk);

    // メインシート(5セグメント共有ジオメトリ方式: ブーム後ろ側の二股パーチェス2本 + ブーム下 + センターブロック降り + スキッパー手元)
    this.mainSheetSegs = [];
    for (let i = 0; i < 5; i++) {
      const seg = new THREE.Mesh(sheetSegGeo, mainSheetMat);
      this.body.add(seg);
      this.mainSheetSegs.push(seg);
    }
    // ジブシート(水色・連続エンドレスループ構成: 5セグメント) & ランチャーポール先端→ジブセール接続ライン(灰色・やや細め: 1セグメント)
    this.rjLoopSegs = [];
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(sheetSegGeo, jibSheetMatL);
      this.body.add(s);
      this.rjLoopSegs.push(s);
    }
    this.poleTipSegs = [];
    const ps = new THREE.Mesh(poleTipSegGeo, jibSheetMatW);
    this.body.add(ps);
    this.poleTipSegs.push(ps);

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
    this.boomRotY = -boat.tack * 0.3;
    this.sailSide = boat.tack > 0 ? -1 : 1;
    this.jibRotCur = -boat.tack * 0.25;
    this._prevTack = boat.tack;
    this._inGybeFlip = false;
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
    // ランチャーポール(全艇): 使わない時はブーム脇に沿って格納した金属バーとして見え、先端にはランチャーチップ金具(poleTipRing)を備える
    this.pole = new THREE.Mesh(poleGeo, spar); this.pole.position.copy(POLE_ROOT); this.pole.visible = false; this.body.add(this.pole);
    this.poleTipRing = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.0045, 8, 14), M.steel);
    this.body.add(this.poleTipRing);
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

    // 船体バウ・チャイン＆ラダーブレードで海面を切る3D水流・バウウェーブ＆ラダーストリームメッシュ(海面高さに追従するroot直下に配置)
    this.waterCutMat = makeWaterCutMat();
    this.waterCutMesh = new THREE.Mesh(getWaterCutGeo(), this.waterCutMat);
    this.waterCutMesh.frustumCulled = false;
    this.waterCutMesh.renderOrder = 3;
    this.root.add(this.waterCutMesh);

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
    if (this.mainGeo) this.mainGeo.dispose();
    if (this.jibGeo) this.jibGeo.dispose();
    if (this.waterCutMat) this.waterCutMat.dispose();
  }

  // ランニング時にメインセールが風下サイドステー(シュラウド)に押し付けられるわずかな窪み・折れ目を再現 (画像5枚目準拠)
  updateMainShroudPress(pressAmt) {
    if (!this.mainGeo || !this._baseMainPos) return;
    const eps = this.boat.isPlayer ? 0.008 : 0.025;
    if (Math.abs(pressAmt - this._lastShroudPress) < eps) return;
    this._lastShroudPress = pressAmt;
    const pos = this.mainGeo.attributes.position;
    const src = this._baseMainPos;
    const nu = 28, nv = 12;
    let idx = 0;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      // シュラウドは y=0.375(u≈0)..3.85(u≈0.60) の範囲でセール前腹部(v≈0.18..0.32)に接触する
      const uContact = Math.sin(clamp(u / 0.68, 0, 1) * Math.PI);
      const vShroud = 0.24 - 0.07 * u;
      for (let j = 0; j <= nv; j++) {
        const v = j / nv;
        const bx = src[idx * 3];
        const by = src[idx * 3 + 1];
        const bz = src[idx * 3 + 2];
        let xMod = bx;
        let zMod = bz;
        if (pressAmt > 0.005 && uContact > 0.01) {
          const dv = (v - vShroud) / 0.14;
          const contactIndent = Math.exp(-dv * dv * 2.2) * uContact * pressAmt;
          // サイドステー接触ラインでキャンバーが手前(風上側)へ少し押し戻され、その後方(v > vShroud)がふっくら張り出す
          const aftBell = v > vShroud ? Math.sin(clamp((v - vShroud) / (1 - vShroud), 0, 1) * Math.PI) * 0.065 * uContact * pressAmt : 0;
          xMod = bx * (1 - 0.42 * contactIndent) + aftBell;
          zMod = bz - 0.032 * contactIndent;
        }
        pos.setXYZ(idx, xMod, by, zMod);
        idx++;
      }
    }
    pos.needsUpdate = true;
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
    if (Math.abs(a - this._occAlpha) < 0.008 && (a >= 0.98) === (this._occAlpha >= 0.98)) return;
    this._occAlpha = a;
    if (this.waterCutMat) this.waterCutMat.uniforms.uOpacity.value = a;
    if (!this._occMats) {
      this._occMats = [];
      this._occMeshes = [];
      const matMap = new Map();
      this.body.traverse((obj) => {
        if (!obj.isMesh || !obj.material || obj === this.bowSprayMesh) return;
        this._occMeshes.push({ mesh: obj, baseOrder: obj.renderOrder || 0 });
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
    const transChanged = this._wasTrans !== isTrans;
    this._wasTrans = isTrans;
    for (const item of this._occMats) {
      const nextTrans = isTrans ? true : item.baseTrans;
      if (item.mat.transparent !== nextTrans || transChanged) {
        item.mat.transparent = nextTrans;
        item.mat.needsUpdate = true;
      }
      item.mat.opacity = item.baseOp * a;
      item.mat.depthWrite = !isTrans;
      item.mat.stencilWrite = !isTrans && item.baseStencil;
    }
    if (transChanged && this._occMeshes) {
      for (const mItem of this._occMeshes) {
        mItem.mesh.renderOrder = isTrans ? Math.max(6, mItem.baseOrder + 16) : mItem.baseOrder;
      }
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

  // ジブのラフ(v=0)をフォアステーへ固定し、クローズ時は画像4枚目のように下縁(フット u=0)が緩やかな丸み(フットスカート)を帯びた立体形状を再現
  evalJibPoint(u, v, clewX, clewLocalY, clewLocalZ, camberSigned, pk, out) {
    const sgn = this.boat.tack || 1;
    const closeF = this._closeFactor ?? 0;
    const headY = JIB_HEAD_Y - 0.055 * pk, headZ = JIB_HEAD_Z - 0.065 * pk;
    const sag = pk * Math.sin(Math.PI * u);
    const lx = -sgn * 0.095 * sag, ly = headY * u - 0.045 * sag, lz = headZ * u - 0.145 * sag;
    const rx = clewX * (1 - u);
    const ry = clewLocalY + (headY - clewLocalY) * u;
    const rz = clewLocalZ + (headZ - clewLocalZ) * u;
    // コード(ラフ→リーチ)に対する法線方向へキャンバー(膨らみ)を付与。クローズ時は前〜中腹部に滑らかな丸みを持たせる(画像4枚目準拠)
    const dx = rx - lx, dz = rz - lz;
    const clen = Math.hypot(dx, dz) || 1;
    const nx = dz / clen, nz = -dx / clen;
    const verticalDraft = (0.68 + 0.34 * Math.sin(Math.PI * Math.pow(u, 0.62))) * Math.pow(1 - u, 0.72) * (1 - 0.12 * pk * u) + 0.42 * pk * Math.sin(Math.PI * u);
    const footProfile = Math.sin(Math.PI * Math.pow(v, 0.78 - 0.10 * closeF - 0.12 * pk));
    const b = camberSigned * footProfile * verticalDraft;
    // クローズ走行時はジブの中〜上部リーチ(v→1, u≈0.25..0.85)が風下へわずかにツイストして開くリアルなスロット形状を表現
    const jibLeechTwist = -sgn * closeF * (1 - pk) * 0.064 * Math.pow(u, 1.05) * (1 - u) * Math.pow(v, 1.25);
    let px = lx + v * dx + nx * b + jibLeechTwist;
    let py = ly + v * (ry - ly);
    const pz = lz + v * dz + nz * b;
    const zBody = JIB_TACK_Z + pz;

    // 実艇写真(画像4枚目)のジブ下部(フット u→0)の丸みを帯びたスカート形状(タックからクリューへ滑らかな弧を描く)
    const footSkirtDepth = 0.058 * closeF + 0.026 * (1 - closeF) + 0.022 * pk;
    py -= footSkirtDepth * Math.sin(Math.PI * Math.pow(v, 0.88)) * Math.pow(1 - u, 1.85);

    // メインセール貫通防止ガード: ジブの中〜下部リーチ側(u < 0.68 かつ v > 0.48)でマスト後方へ重なる頂点のみ外側に保ち、マスト上部のラフやヘッドは絶対に切り離さない
    if (pk < 0.35 && u < 0.68 && v > 0.48 && zBody > -0.88) {
      const yBody = JIB_TACK_Y + py;
      const zMain = Math.max(0, zBody - (-0.90));
      const uMain = clamp((yBody - 1.02) / 5.73, 0, 1);
      const chordMain = Math.max(0.35, 2.88 * (1 - uMain) + 0.36 * 4 * uMain * (1 - uMain));
      const vMain = clamp(zMain / chordMain, 0, 1);
      const bMain = 0.37 * Math.sin(Math.PI * vMain) * (1 - 0.50 * uMain) * Math.sin(Math.PI * Math.min(1, 0.15 + uMain * 0.85));
      const twMain = MAIN_TWIST * Math.pow(uMain, 1.15) * (1 - uMain) * 2.02 * Math.pow(vMain, 1.08);
      const boomAng = this.boomA || 0.03;
      const mainScale = this.mainSail ? Math.abs(this.mainSail.scale.x) : 1;
      const mainLeeDist = zMain * Math.sin(boomAng) + (bMain + twMain) * mainScale * Math.cos(boomAng);
      const leeSign = sgn > 0 ? -1 : 1; // スターボード(sgn=1)の風下は -x、ポート(sgn=-1)の風下は +x
      const blendW = clamp((0.68 - u) / 0.22, 0, 1) * clamp((v - 0.48) / 0.25, 0, 1);
      const minOutboard = (mainLeeDist + 0.032) * blendW;
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
    const hx = Math.sin(b.h), hz = -Math.cos(b.h);
    const ws = waveSample(b.x, b.z, SEA.clock, hx, hz);
    const speedNorm = clamp(Math.abs(b.v) / 2.6, 0, 1);
    const slowFactor = Math.pow(1 - speedNorm, 1.35);
    const downFactor = clamp((b.twa - 1.05) / 0.65, 0, 1);
    const chopRespond = (0.34 + 1.08 * slowFactor) * (1 - 0.65 * downFactor * speedNorm);
    const heave = ws.hLong * 0.84 + (ws.h - ws.hLong) * 0.30 * chopRespond + 0.042 * Math.sin(ph * 1.35);
    const pitchW = clamp(Math.atan(ws.slopeLong * 0.72 + (ws.slope - ws.slopeLong) * 0.62 * chopRespond), -0.025, 0.115);
    const wsR = waveSample(b.x, b.z, SEA.clock, -hz, hx);
    const wakeWobble = (b.wakeWave || 0) * 0.045 * Math.sin(t * 11.0 + this.phase);
    const rollW = clamp(Math.atan(wsR.slope) * 0.56 * chopRespond + wakeWobble, -0.115, 0.115);
    this.body.position.y = 0.132 + Math.abs(b.heel) * 0.078 + heave;
    this.body.rotation.z = b.heel + 0.014 * Math.sin(ph * 0.8) - rollW;
    this.body.rotation.x = 0.008 + pitchW + 0.012 * Math.sin(ph * 1.1 + 1) + clamp(b.v / 12, 0, 0.28) * 0.032;
    if (this.blackBall) this.blackBall.visible = !!b.hasBlackBall;

    if (this.rudderGroup) {
      this.rudderGroup.rotation.y = b.steer * 0.6;
    }

    // 船体バウ・チャイン＆ラダーブレードで海面を切る3D水流・バウウェーブ＆ラダーストリームのリアルタイム同期
    if (this.waterCutMesh && this.waterCutMat) {
      const surfY = ws.hLong * 0.96 + (ws.h - ws.hLong) * 0.58;
      this.waterCutMesh.position.y = surfY;
      this.waterCutMesh.rotation.x = clamp(Math.atan(ws.slopeLong * 0.85 + (ws.slope - ws.slopeLong) * 0.45), -0.09, 0.09);
      this.waterCutMesh.rotation.z = -clamp(Math.atan(wsR.slope * 0.55), -0.08, 0.08);
      const u = this.waterCutMat.uniforms;
      u.uTime.value = t;
      u.uSpeed.value = clamp(Math.abs(b.v) / 2.25, 0, 1.45);
      const waveCut = clamp((SEA.H || 0.25) * 1.15 + Math.max(0, ws.h) * 2.1 + Math.max(0, ws.slope) * 2.6 + (b.waveSlam || 0) * 0.9, 0.08, 1.35);
      u.uWave.value = waveCut;
      u.uHeel.value = b.heel || 0;
      u.uSteer.value = b.steer || 0;
      u.uRudderDrag.value = clamp((b.rudderDrag || 0) + Math.abs(b.steer || 0) * 0.55, 0, 1.2);
    }

    // セール: クローズ時はしっかり引き込み、ランニング時は従来(1.0rad)よりもう少し大きく(最大1.24rad≒71°)ブームを出せるようにしてサイドステーへの押し付け形状も再現
    const twa = b.twa, luff = b.luff;
    const closeFactor = clamp(1 - (twa - 0.65) / 0.38, 0, 1);
    const runEaseFactor = clamp((twa - 1.50) / 1.15, 0, 1);
    this._closeFactor = closeFactor;
    const effMainSheet = clamp(b.sheet + closeFactor * 0.036, 0, 1);
    const sheetAng = (0.018 + (1 - closeFactor) * 0.052) + Math.pow(1 - effMainSheet, 1.10) * (1.36 + 0.16 * runEaseFactor);
    const maxBoomAng = 1.0 + 0.24 * runEaseFactor;
    let ang = Math.min(sheetAng, Math.max(0.018, Math.abs(b.awa) - 0.11 * closeFactor - 0.03 + 0.10 * runEaseFactor), maxBoomAng);
    ang += luff * 0.09 * Math.sin(t * 19 + this.phase);
    this.boomA += (ang - this.boomA) * (1 - Math.exp(-dt * (luff > 0.3 ? 14 : 4)));
    // ランニング時にブームが大きく出た際、風下サイドステー(シュラウド)にメインセールが押し付けられるわずかな窪み・折れ目を更新
    const shroudPress = clamp((this.boomA - 0.78) / 0.42, 0, 1);
    this.updateMainShroudPress(shroudPress);

    const sgn = b.tack;
    if (sgn !== this._prevTack) {
      this._inGybeFlip = twa >= Math.PI * 0.5;
      this._prevTack = sgn;
    }
    const windSpd = BASE_WIND_KT * (b.windF || 1) * 0.5144 * 2.0;
    const boatSpd = Math.max(0.45, Math.abs(b.v));
    const windToBoat = clamp(windSpd / boatSpd, 0.55, 3.2);
    const flipRate = this._inGybeFlip
      ? clamp(1.8 + Math.pow(windToBoat, 1.35) * 3.1, 2.4, 15.0)
      : clamp(5.5 + windToBoat * 2.2, 6.5, 13.5);
    const targetBoomRotY = -sgn * this.boomA;
    if (this.boomRotY === undefined) this.boomRotY = targetBoomRotY;
    this.boomRotY += (targetBoomRotY - this.boomRotY) * (1 - Math.exp(-dt * flipRate));
    if (Math.abs(targetBoomRotY - this.boomRotY) < 0.025) this._inGybeFlip = false;
    this.mainPivot.rotation.y = this.boomRotY;

    const pk = b.poleK || 0;
    if (this.cbBoard) {
      const reachLift = clamp((twa - 1.28) / 1.05, 0, 1);
      this.cbBoard.position.y = Math.max(reachLift * 0.16, pk * 0.23);
    }
    if (this.mast) {
      this.mast.rotation.x = -0.018 * pk;
      this.mast.position.z = -0.90 - 0.028 * pk;
    }

    const ease = Math.max(0, 0.97 - b.sheet);
    const bearOut = Math.max(0, twa - 0.78) * 0.28;
    const luffOut = luff * (0.28 + 0.09 * Math.sin(t * 21 + this.phase));
    const baseJibIn = 0.088 * closeFactor + 0.19 * (1 - closeFactor);
    const easeWeight = 0.24 * closeFactor + 0.76 * (1 - closeFactor);
    const jibDesired = baseJibIn + ease * easeWeight + bearOut * 0.44 + luffOut;
    const jibMaxAwa = Math.max(0.092 + 0.258 * (1 - closeFactor), Math.abs(b.awa) * 0.92 + luff * 0.28 + ease * 0.35);
    const minJibLee = 0.088 * closeFactor + 0.18 * (1 - closeFactor);
    const jibLee = clamp(Math.min(Math.max(this.boomA * (0.65 * closeFactor + 0.72 * (1 - closeFactor)), jibDesired), jibMaxAwa), minJibLee, 0.88);
    // ランニングのランチャー展開時: 風とほぼ直角〜やや出し気味の角度(約88°〜96° = 1.54〜1.68 rad)にする
    const wingAngle = clamp(Math.PI - twa + 0.38, 1.54, 1.68);
    const targetJibRot = -sgn * jibLee * (1 - pk) + sgn * wingAngle * pk;
    if (this.jibRotCur === undefined) this.jibRotCur = targetJibRot;
    this.jibRotCur += (targetJibRot - this.jibRotCur) * (1 - Math.exp(-dt * (flipRate * 1.08)));
    const jibRot = this.jibRotCur;
    this.jibRot = jibRot;
    this.jibPivot.rotation.y = 0;
    const targetBulgeSign = sgn > 0 ? -1 : 1;
    if (this.sailSide === undefined) this.sailSide = targetBulgeSign;
    this.sailSide += (targetBulgeSign - this.sailSide) * (1 - Math.exp(-dt * (flipRate * 1.25)));
    const bulgeSign = Math.abs(this.sailSide) < 0.08 ? targetBulgeSign * 0.08 : this.sailSide;
    const jibBulge = pk > 0.5 ? -bulgeSign : bulgeSign;
    const flap = 1 - luff * (0.55 + 0.45 * Math.sin(t * 21 + this.phase));
    const jibLuff = luff * (1 - pk);
    const closeDepthScale = 1 + 0.075 * closeFactor;
    this.mainSail.scale.x = bulgeSign * flap * closeDepthScale;

    // クローズ時は深めで丸みのあるジブキャンバー(0.168)、ランチャーアップ時はふっくら風をはらんだ深いポケット(0.31)を表現
    const jibCamberScale = 0.168 * closeFactor + (0.23 + 0.085 * pk) * (1 - closeFactor);
    const transitDip = 1 - 0.55 * Math.sin(Math.PI * pk) * (1 - pk * 0.85);
    const jibCamber = jibBulge * jibCamberScale * Math.max(0.08, 1 - jibLuff * (0.55 + 0.45 * Math.sin(t * 25 + this.phase + 1))) * transitDip;
    this.jibSail.scale.x = 1;
    this.jibSail.rotation.x = 0;
    this.updateJibShape(pk, jibRot, jibCamber);

    const clewX = JIB_CLEW_LEN * Math.sin(jibRot);
    const clewY = JIB_TACK_Y + 0.16 + 0.54 * pk;
    const clewZ = JIB_TACK_Z + JIB_CLEW_LEN * Math.cos(jibRot);

    this.poleStow.visible = pk <= 0.01;
    if (pk > 0.01) {
      const boomSlide = (1 - pk) * 0.45;
      const pm = this.boomRotY;
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
    if (b.pole !== this._prevPole) {
      this._prevPole = b.pole;
      this.crewPoleTimer = 1.45;
    } else if (this.crewPoleTimer > 0) {
      this.crewPoleTimer = Math.max(0, this.crewPoleTimer - dt);
    }
    const poleMoving = pk > 0.03 && pk < 0.97 ? Math.sin(pk * Math.PI) : 0;
    const crewPoleAct = clamp(Math.max(this.crewPoleTimer / 1.15, poleMoving), 0, 1);

    // クルー・スキッパーの乗船・ハイクアウト姿勢 ＆ 連続的に滑らかな重心移動:
    // 舵をずっと同じ方向に切った時でもカクッと段階的に飛ばないよう、smoothstepによる連続補間と座標・回転のダンピングを適用
    //  ・±10°以内: 真ん中(0)
    //  ・±30°付近: 真ん中右寄り・左寄り(0.52 * sgn)
    //  ・クローズ〜リーチ〜ラン: 上デッキ(+sgn) → 上と真ん中の間(+0.52*sgn) → センター横オフセット → 下と真ん中の間(-0.52*sgn) → 下デッキ(-sgn)
    const sStep = (e0, e1, val) => {
      const x = clamp((val - e0) / (e1 - e0), 0, 1);
      return x * x * (3 - 2 * x);
    };
    this.side += (sgn - this.side) * (1 - Math.exp(-dt * 3.5));
    const twaDeg = (twa * 180) / Math.PI;
    const hikeAmt = b.hike !== undefined ? b.hike : 0.35;
    const cbLift = this.cbBoard ? this.cbBoard.position.y : 0;
    const cbRaiseBlend = sStep(0.015, 0.075, cbLift);

    // クローズ時の風上デッキ量を風速(hikeAmt)に滑らかに連動 (微風時は 0.52、中〜強風時は 1.0)
    const windwardFull = 0.52 + 0.48 * sStep(0.14, 0.34, hikeAmt);
    // 1) 0°..10.5° は 0、10.5°..24° で 0 → 0.52 へ滑らかに遷移、24°..33° は 0.52 (±30°で真ん中右/左寄り)、33°..43° で 0.52 → windwardFull へ遷移
    const upRise1 = sStep(10.5, 22.0, twaDeg);
    const upRise2 = sStep(33.0, 43.0, twaDeg);
    let sideCoeff = upRise1 * (0.52 + (windwardFull - 0.52) * upRise2);

    // 2) アビーム〜フリー〜ランニング (96°..164°) の連続遷移:
    //    96°..114°: windwardFull → +0.52 (上と真ん中の間)
    //    114°..142°: +0.52 → -0.52 (センターボード上げ時は中央0を通過せず ±0.44 を滑らかに維持して貫通を防止)
    //    142°..162°: -0.52 → -1.0 (下デッキ)
    if (twaDeg > 96.0) {
      const toWindMid = sStep(96.0, 112.0, twaDeg);
      const toLeeMid = sStep(114.0, 142.0, twaDeg);
      const toDeepRun = sStep(144.0, 162.0, twaDeg);
      const fromFull = windwardFull + (0.52 - windwardFull) * toWindMid;
      const midSpan = 0.52 - 1.04 * toLeeMid; // +0.52 .. -0.52
      const afterMid = midSpan + (-1.0 - midSpan) * toDeepRun;
      sideCoeff = toWindMid < 1.0 && twaDeg <= 114.0 ? fromFull : afterMid;
    }
    const targetCrewSide = sideCoeff * sgn;
    this.crewSide += (targetCrewSide - this.crewSide) * (1 - Math.exp(-dt * 4.8));

    // スキッパー・クルーの上体ハイク角度も不連続な三項演算子を廃して連続関数＋ダンピングで滑らかに補間
    const activeHikeWindow = sStep(14.0, 38.0, twaDeg) * (1 - sStep(108.0, 145.0, twaDeg));
    const targetHelmLean = 0.12 + clamp(hikeAmt * 0.96, 0.04, 1.24) * activeHikeWindow;
    if (this.helmLeanCur === undefined) this.helmLeanCur = targetHelmLean;
    this.helmLeanCur += (targetHelmLean - this.helmLeanCur) * (1 - Math.exp(-dt * 5.2));
    const lean = this.helmLeanCur;

    const crewDeckFactor = sStep(0.32, 0.95, Math.abs(this.crewSide));
    const targetCrewLean = (0.08 + clamp(hikeAmt * 1.06 * crewDeckFactor, 0, 1.36) * activeHikeWindow) * (1 - 0.85 * crewPoleAct);
    if (this.crewLeanCur === undefined) this.crewLeanCur = targetCrewLean;
    this.crewLeanCur += (targetCrewLean - this.crewLeanCur) * (1 - Math.exp(-dt * 5.2));
    const crewLean = this.crewLeanCur;

    const sideAbs = Math.abs(this.side);
    const crewSideAbs = Math.abs(this.crewSide);
    const boomLow = clamp(1 - (this.boomA - 0.35) / 0.30, 0, 1);

    // 待機モーション用の自然な周期波
    const idleT = t + this.phase * 1.7;
    const helmBreath = Math.sin(idleT * 2.4) * 0.038 + Math.sin(idleT * 4.1) * 0.018;
    const crewBreath = Math.sin(idleT * 2.7 + 1.4) * 0.042 + Math.cos(idleT * 3.8) * 0.020;
    const helmLookYaw = 0.22 * Math.sin(idleT * 0.95) + 0.12 * Math.sin(idleT * 2.15 + 0.7);
    const helmLookPitch = 0.11 * Math.sin(idleT * 1.35 + 0.4) + 0.06 * Math.cos(idleT * 2.6);
    const helmHeadTilt = 0.075 * Math.sin(idleT * 1.65 + 1.1);
    const crewLookYaw = 0.28 * Math.sin(idleT * 1.12 + 2.2) + 0.15 * Math.cos(idleT * 2.35);
    const crewLookPitch = 0.12 * Math.sin(idleT * 1.52 + 1.8) + 0.06 * Math.sin(idleT * 2.9);
    const crewHeadTilt = 0.085 * Math.cos(idleT * 1.85 + 0.5);

    // ヘルムスマン(スキッパー)
    const helmPet = !!this.helm.userData.isRoundPet;
    this.helmRig.position.set(
      this.side * (0.54 + lean * (helmPet ? 0.17 : 0.155)),
      0.35 - (1 - sideAbs) * 0.06 - Math.max(0, lean - 0.85) * (helmPet ? 0.01 : 0.035) + 0.008 * Math.sin(idleT * 2.4),
      0.86
    );
    this.helmRig.rotation.y = this.side * 1.35;
    if (this.tillerExt && this.tillerExtGrip) {
      _p0.set(0, 0.05, -1.17);
      _p1.set(this.side * (0.48 + lean * 0.13), 0.13 - lean * 0.02, -1.48);
      placeSeg(this.tillerExt, _p0, _p1);
      this.tillerExtGrip.position.copy(_p1);
    }
    if (this.helm.userData.upper) {
      const hu = this.helm.userData.upper;
      this.helmRig.rotation.z = 0;
      const duck = (1 - sideAbs) * 0.42 * boomLow;
      const hike = (helmPet ? Math.min(lean * 0.62, 0.76) : lean * 0.96) * sideAbs;
      hu.rotation.x = hike - duck + helmBreath;
      hu.rotation.z = -this.side * 0.08 + 0.045 * Math.sin(idleT * 1.8);
      if (hu.userData.armL && hu.userData.armR) {
        const steerAct = (b.steer || 0) * 0.22 + 0.12 * Math.sin(idleT * 3.1);
        const sheetAct = 0.14 * Math.sin(idleT * 2.3 + 0.8);
        hu.userData.armL.rotation.set(-0.12 + sheetAct, 0.06 * Math.cos(idleT * 2.0), -0.08 + steerAct * 0.5);
        hu.userData.armR.rotation.set(-0.12 - steerAct, -0.06 * Math.sin(idleT * 2.2), 0.08 + sheetAct * 0.5);
      }
      if (hu.userData.tail) {
        hu.userData.tail.rotation.y = 0.28 * Math.sin(idleT * 5.2);
        hu.userData.tail.rotation.x = 0.12 * Math.cos(idleT * 3.6);
      }
    } else {
      this.helmRig.rotation.z = -this.side * lean * 0.45 + helmBreath * 0.5;
    }
    if (this.helm.userData.head) {
      const uRx = this.helm.userData.upper ? this.helm.userData.upper.rotation.x : 0;
      this.helm.userData.head.rotation.x = -uRx * (helmPet ? 0.55 : 0.68) + helmLookPitch;
      this.helm.userData.head.rotation.y = -this.side * 0.55 + helmLookYaw;
      this.helm.userData.head.rotation.z = helmHeadTilt;
    }

    // クルー: センターボード引き上げ時のクリアランス回避や前後の移動・体の向きもすべて連続補間で滑らかに動作させる
    const crewPet = !!this.crew.userData.isRoundPet;
    const fwdShift = clamp(Math.max(pk, sStep(102, 130, twaDeg) * (1 - crewDeckFactor * 0.55)), 0, 1);
    const baseCrewX = this.crewSide * ((0.55 - 0.17 * fwdShift) + crewLean * (crewPet ? 0.175 : 0.165));
    const baseCrewY = 0.36 - (1 - crewSideAbs) * 0.04 - Math.max(0, crewLean - 0.85) * (crewPet ? 0.01 : 0.04) + 0.009 * Math.sin(idleT * 2.7 + 1.4);
    const baseCrewZ = -0.04 - 0.38 * fwdShift;
    const actCrewX = sgn * 0.26;
    const actCrewY = 0.39 + 0.03 * Math.sin(t * 14);
    const actCrewZ = -0.40;
    let targetCrewX = baseCrewX + (actCrewX - baseCrewX) * crewPoleAct;
    const targetCrewY = baseCrewY + (actCrewY - baseCrewY) * crewPoleAct;
    const targetCrewZ = baseCrewZ + (actCrewZ - baseCrewZ) * crewPoleAct;
    if (cbRaiseBlend > 0.01) {
      const minCbClearX = (0.25 + clamp(cbLift / 0.23, 0, 1) * 0.03) * cbRaiseBlend;
      const prefDir = Math.abs(targetCrewX) > 0.06 ? Math.sign(targetCrewX) : (twaDeg < 129 ? sgn : -sgn);
      if (this._cbClearSign === undefined) this._cbClearSign = prefDir;
      this._cbClearSign += (prefDir - this._cbClearSign) * (1 - Math.exp(-dt * 5.0));
      const signSmooth = Math.abs(this._cbClearSign) < 0.25 ? prefDir * 0.25 : this._cbClearSign;
      if (Math.abs(targetCrewX) < minCbClearX) {
        const pushBlend = 1 - Math.abs(targetCrewX) / Math.max(0.01, minCbClearX);
        targetCrewX += signSmooth * (minCbClearX - Math.abs(targetCrewX)) * pushBlend;
        if (Math.abs(targetCrewX) < minCbClearX) targetCrewX = Math.sign(signSmooth || prefDir) * minCbClearX;
      }
    }
    const posFollow = 1 - Math.exp(-dt * 6.5);
    if (this._crewX === undefined) {
      this._crewX = targetCrewX;
      this._crewY = targetCrewY;
      this._crewZ = targetCrewZ;
    } else {
      this._crewX += (targetCrewX - this._crewX) * posFollow;
      this._crewY += (targetCrewY - this._crewY) * posFollow;
      this._crewZ += (targetCrewZ - this._crewZ) * posFollow;
    }
    this.crewRig.position.set(this._crewX, this._crewY, this._crewZ);

    // 体の向き(rotation.y)も閾値ジャンプをなくし、中央付近からデッキ側へ連続ブレンド
    const centerRotY = this.side * 0.35;
    const deckRotY = this.crewSide * 1.35;
    const rotBlend = sStep(0.06, 0.34, crewSideAbs);
    const rawCrewRotY = centerRotY + (deckRotY - centerRotY) * rotBlend;
    const targetCrewRotY = rawCrewRotY + (sgn * 0.22 - rawCrewRotY) * crewPoleAct;
    if (this._crewRotY === undefined) this._crewRotY = targetCrewRotY;
    else this._crewRotY += (targetCrewRotY - this._crewRotY) * (1 - Math.exp(-dt * 6.0));
    this.crewRig.rotation.y = this._crewRotY;

    if (this.crew.userData.upper) {
      this.crewRig.rotation.z = 0;
      const cDuck = (1 - crewSideAbs) * 0.45 * boomLow;
      const cHike = (crewPet ? Math.min(crewLean * 0.64, 0.78) : crewLean * 0.98) * crewSideAbs;
      const baseUpperX = cHike - cDuck + crewBreath;
      const actUpperX = -0.52 + 0.14 * Math.sin(t * 16);
      const cu = this.crew.userData.upper;
      cu.rotation.x = baseUpperX + (actUpperX - baseUpperX) * crewPoleAct;
      cu.rotation.z = (-this.crewSide * 0.08 + 0.05 * Math.cos(idleT * 2.1)) * (1 - crewPoleAct);
      if (cu.userData.armL && cu.userData.armR) {
        const ext = clamp((crewLean - 0.70) / 0.55, 0, 1) * crewSideAbs * (1 - crewPoleAct);
        const lOut = this.crewSide > 0 ? ext : 0;
        const rOut = this.crewSide < 0 ? ext : 0;
        const trimWaveL = 0.15 * Math.sin(idleT * 2.8) * (1 - lOut);
        const trimWaveR = 0.15 * Math.cos(idleT * 2.8 + 0.9) * (1 - rOut);
        cu.userData.armL.rotation.set(-0.55 * lOut + trimWaveL, 0.06 * Math.sin(idleT * 2.0), -0.82 * lOut - 0.08 * (1 - lOut));
        cu.userData.armR.rotation.set(-0.55 * rOut + trimWaveR, -0.06 * Math.cos(idleT * 2.0), 0.82 * rOut + 0.08 * (1 - rOut));
      }
      if (cu.userData.tail) {
        cu.userData.tail.rotation.y = 0.30 * Math.sin(idleT * 5.6 + 1.2);
        cu.userData.tail.rotation.x = 0.14 * Math.sin(idleT * 3.9);
      }
    } else {
      this.crewRig.rotation.z = -this.crewSide * crewLean * 0.42 * (1 - crewPoleAct) + crewBreath * 0.5;
    }
    if (this.crew.userData.head) {
      const cRx = this.crew.userData.upper ? this.crew.userData.upper.rotation.x : 0;
      this.crew.userData.head.rotation.x = -cRx * (crewPet ? 0.55 : 0.68) + crewLookPitch * (1 - crewPoleAct);
      this.crew.userData.head.rotation.y = (-this.crewSide * 0.50 + crewLookYaw) * (1 - crewPoleAct);
      this.crew.userData.head.rotation.z = crewHeadTilt * (1 - crewPoleAct);
    }

    // カメラ位置：スキッパーの目線近くまで高くし、ハイクアウト時に外側へより大きく乗り出すように調整
    this.mount.position.set(this.side * (0.50 + lean * 0.7), 1.18 - lean * 0.05, 0.95);

    // パフォーマンス最適化: CP艇の細かいロープ・リーチリボン更新は2フレームに1回間引いてCPU負荷を軽減
    this._ropeTick = ((this._ropeTick || 0) + 1) & 1;
    const doDetailSync = b.isPlayer || this._ropeTick === 0 || this._firstSyncDone !== true;
    this._firstSyncDone = true;
    if (doDetailSync) {
      this.syncForestay(pk, sgn);
      if (this.leechRibbons) {
        const stall = b.stall || 0;
        for (const r of this.leechRibbons) {
          r.m.position.x = r.twistX * this.mainSail.scale.x;
          const twistYaw = bulgeSign * (0.14 * r.u);
          const curl = -bulgeSign * stall * (0.75 + 0.55 * Math.sin(t * 20 + r.ph)) + luff * 0.45 * Math.sin(t * 23 + r.ph);
          const flutter = (0.06 + 0.22 * Math.max(luff, stall)) * Math.sin(t * 17 + r.ph);
          r.m.rotation.y = twistYaw + curl + flutter;
          r.m.rotation.x = -0.05 + 0.16 * Math.sin(t * 14 + r.ph) * (0.3 + Math.max(luff, stall));
        }
      }
      this.syncMainSheet(sgn, lean, sideAbs);
      if (this.rjLoopSegs) this.syncRopes(sgn, clewY, pk);
    }
    this.syncBowSpray(dt, t, ws, sgn);
  }

  // バウしぶき: 通常走行時は上に噴き上げず海面側(wake)でほんのわずかに白くなる表現にとどめ、波にはたかれた時だけ白く上に噴き上げる
  syncBowSpray(dt, t, ws, sgn) {
    if (!this.bowSprayMesh) return;
    const b = this.boat;
    const vAbs = Math.abs(b.v);
    const spdF = clamp((vAbs - 0.72) / 1.75, 0, 1.30);

    // 1) 通常走行時は常時上へ噴き上げる3Dパーティクル(0..15)は出さず非表示にする(船と海面の接地点が白くなるのも防ぐ)
    if (!this._sprayZeroed) {
      _spM4.makeScale(0, 0, 0);
      _spCol.setScalar(0);
      for (let i = 0; i < 16; i++) {
        this.bowSprayMesh.setMatrixAt(i, _spM4);
        this.bowSprayMesh.setColorAt(i, _spCol);
      }
      this._sprayZeroed = true;
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
    } else if (this._sprayIdleCleared) {
      return;
    }
    this._sprayIdleCleared = this.slamBurstT <= 0;

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
      const x = side * (0.44 + tier * 0.16 + u * (0.76 + tier * 0.46) * pow);
      const y = 0.23 + arc * (0.55 + (1 - tier * 0.35) * 0.48) * pow - u * u * 0.18;
      const z = -2.15 + tier * 0.45 + u * (1.22 + spdF * 0.52);
      const sz = (0.185 + u * 0.31) * pow;
      _spPos.set(x, y, z);
      _spEul.set(u * 2.1 + j, side * (0.45 + u), u * 1.65);
      _spQuat.setFromEuler(_spEul);
      _spScale.set(sz * 1.0, sz * 0.92, sz * 1.30);
      _spM4.compose(_spPos, _spQuat, _spScale);
      this.bowSprayMesh.setMatrixAt(idx, _spM4);
      const fade = Math.pow(1 - u, 1.48) * Math.min(1, u * 7.0) * clamp(0.33 * pow, 0.16, 0.42);
      _spCol.setRGB(0.91 * fade, 0.97 * fade, 1.0 * fade);
      this.bowSprayMesh.setColorAt(idx, _spCol);
    }

    this.bowSprayMesh.instanceMatrix.needsUpdate = true;
    if (this.bowSprayMesh.instanceColor) this.bowSprayMesh.instanceColor.needsUpdate = true;
  }

  // メインシート(実艇写真1・5枚目準拠):
  // ブーム後端側は2個のブロック(bz=2.56, bz=2.34)と船体後部ブライドル頂点ブロック(z=1.58)の間で二股に分かれてつながり、
  // ブーム下面に沿って中央ブロック(bz=1.18) → センターケース後端フロアブロック(z=0.10) → スキッパー手元へつながる
  syncMainSheet(sgn, lean, sideAbs) {
    if (!this.mainSheetSegs || this.mainSheetSegs.length < 5) return;
    const pm = this.boomRotY !== undefined ? this.boomRotY : -sgn * this.boomA;
    const sinP = Math.sin(pm), cosP = Math.cos(pm);
    const bzAft1 = 2.56, bzAft2 = 2.34, bzMid = 1.18;
    const brY = FLOOR_Y + 0.36, brZ = 1.58;
    // seg[0]: ブライドル頂点ブロック → ブーム後端第1ブロック(bz=2.56)
    _p0.set(-0.008, brY, brZ + 0.01);
    _p1.set(bzAft1 * sinP, 1.35, -0.9 + bzAft1 * cosP);
    placeSeg(this.mainSheetSegs[0], _p0, _p1);
    // seg[1]: ブライドル頂点ブロック → ブーム後端第2ブロック(bz=2.34) (二股パーチェス)
    _p0.set(0.008, brY, brZ - 0.01);
    _p2.set(bzAft2 * sinP, 1.35, -0.9 + bzAft2 * cosP);
    placeSeg(this.mainSheetSegs[1], _p0, _p2);
    // seg[2]: ブーム後端ブロック → ブーム中央ブロック(bz=1.18)
    _p3.set(bzMid * sinP, 1.35, -0.9 + bzMid * cosP);
    placeSeg(this.mainSheetSegs[2], _p1, _p3);
    // seg[3]: ブーム中央ブロック → センターケース後端ラチェットブロック(0, FLOOR_Y + 0.16, 0.10)
    _p4.set(0, FLOOR_Y + 0.16, 0.10);
    placeSeg(this.mainSheetSegs[3], _p3, _p4);
    // seg[4]: ラチェットブロック → スキッパーの前手
    _p5.set(this.side * (0.30 + lean * 0.20), 0.62 - lean * 0.04 - (1 - sideAbs) * 0.12, 0.72);
    placeSeg(this.mainSheetSegs[4], _p4, _p5);
  }

  // 走る索:
  // 1) ジブシート(水色・連続エンドレスループ構成):
  //    ジブセールの手前側(クリュー _p0) → 引き込み側ジブカム(_p1) → クルー手元(_p2) → 反対舷ジブカム(_p3) → マスト前フェアリード(_p4) → ジブクリュー(_p0) へ一周
  // 2) ランチャーポールの先端(_p5)からジブセール(_p0)へつながる細い灰色のライン(マストへ行く不要な水色シートは廃止)
  syncRopes(sgn, clewY = 0.73, pk = 0) {
    const pj = this.jibRot;
    const clewX = JIB_CLEW_LEN * Math.sin(pj);
    const clewZ = JIB_TACK_Z + JIB_CLEW_LEN * Math.cos(pj);
    _p0.set(clewX, clewY, clewZ); // ジブセールの手前側(クリュー角)

    // 通常航行時は風下(-sgn)のジブカム、ランチャー展開時(pk>0.5)は風上(sgn)のジブカムが引き込み側
    const sheetSide = pk > 0.5 ? sgn : -sgn;
    const xCamAct = sheetSide * 0.54, zCam = -0.06;
    const xCamOpp = -sheetSide * 0.54;
    const yCam = deckY(zCam, 0.54) + 0.026;
    _p1.set(xCamAct, yCam, zCam); // 引き込み側ジブカム
    const handX = this.crewRig.position.x - Math.sign(this.crewRig.position.x || sgn) * 0.11;
    const handY = Math.max(yCam + 0.04, this.crewRig.position.y + 0.21);
    const handZ = this.crewRig.position.z - 0.02;
    _p2.set(handX, handY, handZ); // クルー手元
    _p3.set(xCamOpp, yCam, zCam); // 反対舷のジブカム

    // ランチャーポールの先端座標(_p5): 格納時(pk≈0)はブーム前端のランチャー先端、展開時(pk>0)はポールの先端(ジブクリューへ進出)
    const pm = this.boomRotY !== undefined ? this.boomRotY : -sgn * this.boomA;
    const stowTipX = 0.075 * Math.cos(pm) + 0.25 * Math.sin(pm);
    const stowTipY = 1.36;
    const stowTipZ = -0.90 + 0.25 * Math.cos(pm) - 0.075 * Math.sin(pm);
    _p5.set(
      stowTipX + (clewX - stowTipX) * pk,
      stowTipY + (clewY - stowTipY) * pk,
      stowTipZ + (clewZ - stowTipZ) * pk
    );
    if (this.poleTipRing) {
      this.poleTipRing.position.copy(_p5);
      this.poleTipRing.rotation.y = pj;
    }

    // 反対舷ジブカム(_p3)からマスト前/ランチャー先端付近(_p4)を経由してジブセールの手前側(_p0)へ戻り一周する
    _p4.set(
      -sheetSide * 0.20 * (1 - pk) + _p5.x * pk,
      0.66 * (1 - pk) + _p5.y * pk,
      -0.72 * (1 - pk) + _p5.z * pk
    );
    if (this.rjLoopSegs && this.rjLoopSegs.length >= 5) {
      placeSeg(this.rjLoopSegs[0], _p0, _p1); // ジブクリュー → 引き込み側ジブカム
      placeSeg(this.rjLoopSegs[1], _p1, _p2); // 引き込み側ジブカム → クルー手元
      placeSeg(this.rjLoopSegs[2], _p2, _p3); // クルー手元 → 反対舷ジブカム
      placeSeg(this.rjLoopSegs[3], _p3, _p4); // 反対舷ジブカム → マスト前/ランチャーチップ中継点
      placeSeg(this.rjLoopSegs[4], _p4, _p0); // 中継点 → ジブクリュー(手前側)へ戻って一周完結
    }

    // ランチャーポール先端(_p5)からジブセール(_p0)へつながるやや細めの灰色ライン
    if (this.poleTipSegs && this.poleTipSegs.length >= 1) {
      if (pk < 0.96) {
        placeSeg(this.poleTipSegs[0], _p5, _p0);
      } else {
        _p4.set((clewX + xCamAct) * 0.5, (clewY + yCam) * 0.5, (clewZ + zCam) * 0.5);
        placeSeg(this.poleTipSegs[0], _p5, _p4);
      }
    }
  }
}


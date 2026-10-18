// スナイプ級の3Dモデルとリアルな見た目の同期
import * as THREE from 'three';
import { buildFigure } from './crew.js';
import { buildHull, block, rope, ropeGeo, ropeMat, M, FLOOR_Y, deckY } from './snipehull.js';
import { clamp } from './sim.js';

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
const spar = new THREE.MeshStandardMaterial({ color: 0xd0d5dd, roughness: 0.25, metalness: 0.8 });
const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.5 });
const carbonMat = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.3, metalness: 0.4 });

// リアルなセール幾何体（クロス/ドラフトカーブ）
function sailGeometry(tack, head, clew, bulge, nu = 12, nv = 10) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= nu; i++) {
    const u = i / nu;
    const lx = tack[0] + u * (head[0] - tack[0]), ly = tack[1] + u * (head[1] - tack[1]), lz = tack[2] + u * (head[2] - tack[2]);
    const rx = clew[0] + u * (head[0] - clew[0]), ry = clew[1] + u * (head[1] - clew[1]), rz = clew[2] + u * (head[2] - clew[2]);
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      const b = bulge * Math.sin(Math.PI * v) * (1 - 0.55 * u) * Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.9));
      pos.push(lx + v * (rx - lx) + b, ly + v * (ry - ly), lz + v * (rz - lz));
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

const mainGeo = sailGeometry([0, 1.05, 0], [0, 5.9, 0.06], [0, 1.0, 2.5], 0.4);
const jibGeo = sailGeometry([0, 0, 0], [0, 4.5, 1.0], [0, 0.25, 1.9], 0.24, 10, 8);
const mastGeo = new THREE.CylinderGeometry(0.032, 0.042, 6.0, 12);
const boomGeo = new THREE.CylinderGeometry(0.028, 0.028, 2.5, 8); boomGeo.rotateX(Math.PI / 2);

// メインセールテクスチャ: Snipeロゴ、JPN 31933 / JPN ナンバー、パネルライン、透明ウィンドウ
function mainSailTexture(no, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = '#f8f8f2'; x.fillRect(0, 0, 256, 512);
  
  // パネルライン
  x.strokeStyle = '#e2e2d8'; x.lineWidth = 1.5;
  for (let y = 40; y < 512; y += 45) {
    x.beginPath(); x.moveTo(0, y); x.lineTo(256, y); x.stroke();
  }

  // 頂部国識別カラー帯
  x.fillStyle = '#' + color.toString(16).padStart(6, '0'); x.fillRect(0, 0, 256, 512 * 0.1);
  
  // スナイプの「S」ロゴ
  x.fillStyle = '#d93636'; x.font = 'bold 96px sans-serif'; x.textAlign = 'center';
  x.fillText('S', 128, 140);
  
  // 国コード & セールナンバー（参考画像 JPN 31933）
  x.fillStyle = '#1b3b8a'; x.font = 'bold 54px Arial';
  x.fillText('JPN', 128, 220);
  x.font = 'bold 60px Arial';
  const numText = no.length >= 4 ? no : '31804';
  x.fillText(numText, 128, 285);
  
  // 視認用クリアウィンドウ(透明窓)
  x.fillStyle = 'rgba(215, 235, 250, 0.6)';
  x.fillRect(50, 360, 100, 60);
  x.strokeStyle = '#a0c4e2'; x.lineWidth = 3; x.strokeRect(50, 360, 100, 60);

  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

// ジブセールテクスチャ: 3本のトリム線、透明窓、風透過感
let jibTex = null;
function jibTexture() {
  if (jibTex) return jibTex;
  const c = document.createElement('canvas'); c.width = 128; c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = '#fcfcf6'; x.fillRect(0, 0, 128, 512);
  
  // パネルライン
  x.strokeStyle = '#e6e6dc'; x.lineWidth = 1.5;
  for (let y = 30; y < 512; y += 40) {
    x.beginPath(); x.moveTo(0, y); x.lineTo(128, y); x.stroke();
  }

  // (赤いドラフトストライプは無し。テルテールは別メッシュで表示)

  // ジブ用クリア窓
  x.fillStyle = 'rgba(200, 230, 250, 0.65)';
  x.fillRect(20, 260, 88, 70);
  x.strokeStyle = '#8ab4d8'; x.lineWidth = 3; x.strokeRect(20, 260, 88, 70);

  jibTex = new THREE.CanvasTexture(c); jibTex.colorSpace = THREE.SRGBColorSpace; return jibTex;
}

const stayMat = new THREE.MeshStandardMaterial({ color: 0x8a939e, metalness: 0.9, roughness: 0.2 });
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
const TT_HEIGHTS = [0.28, 0.52, 0.76], TT_V = 0.12; // 視認しやすい位置
// サイドステー(シュラウド): チェーンプレート → スプレッダー先端
const SHROUD_A = [0.62, 0.375, -0.75], SHROUD_B = [0.58, 3.38, -0.92];
const onShroud = (y) => { const t = (y - SHROUD_A[1]) / (SHROUD_B[1] - SHROUD_A[1]); return [SHROUD_A[0] + (SHROUD_B[0] - SHROUD_A[0]) * t, y, SHROUD_A[2] + (SHROUD_B[2] - SHROUD_A[2]) * t]; };
const VANE_Y = 1.75;
// ランチャー(ウィスカーポール): マスト前面の少し低めの取付リングからジブクリューへやや上向きに伸びる
const POLE_ROOT = new THREE.Vector3(0, 0.80, -0.95);
const poleGeo = new THREE.CylinderGeometry(0.013, 0.016, 1, 8); poleGeo.translate(0, 0.5, 0);
const JIB_WING = 1.2; // ランチャーで風上側に張り出したジブの角度
const _Y = new THREE.Vector3(0, 1, 0), _v = new THREE.Vector3();

export class BoatModel {
  constructor(boat, crewHelm, crewCrew) {
    this.boat = boat;
    this.root = new THREE.Group();
    this.body = new THREE.Group(); this.root.add(this.body);

    this.body.add(buildHull(boat.color));
    const sheetMat = new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.9 });
    const mast = new THREE.Mesh(mastGeo, spar); mast.position.set(0, 3.4, -0.9); this.body.add(mast);

    // 舵 (白ラダーブレード & 白ラダーヘッド) & アルミティラー + エクステンションバー
    const rudderGroup = new THREE.Group(); rudderGroup.position.set(0, 0.4, 2.36);
    const rudderHead = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.22, 0.20), M.gel); rudderHead.position.set(0, -0.05, 0.08); rudderGroup.add(rudderHead);
    const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.88, 0.32), M.gel); rudder.position.set(0, -0.45, 0.14); rudderGroup.add(rudder);
    const tiller = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 1.18, 10), M.alu); tiller.rotation.x = Math.PI / 2; tiller.position.set(0, 0.05, -0.58); rudderGroup.add(tiller);
    const ext = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.95, 8), carbonMat); ext.rotation.z = Math.PI / 4; ext.position.set(0.28, 0.09, -1.06); rudderGroup.add(ext);
    this.rudderGroup = rudderGroup; this.body.add(rudderGroup);

    const tex = mainSailTexture(String(boat.sailNo), boat.color);
    this.sailMat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.65, metalness: 0.05 });
    this.jibMat = new THREE.MeshStandardMaterial({ map: jibTexture(), side: THREE.DoubleSide, roughness: 0.6, transparent: true, opacity: 0.85, depthWrite: true });

    this.mainPivot = new THREE.Group(); this.mainPivot.position.set(0, 0.4, -0.9); this.body.add(this.mainPivot);
    this.mainSail = new THREE.Mesh(mainGeo, this.sailMat); this.mainPivot.add(this.mainSail);
    const boom = new THREE.Mesh(boomGeo, spar); boom.position.set(0, 1.05, 1.25); this.mainPivot.add(boom);
    // ゴースネック / ブームブロック(後部・中央) / バング(ロープタックル)
    const gn = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.045, 0.07), M.alu); gn.position.set(0, 1.05, 0.02); this.mainPivot.add(gn);
    const bb = block(0.02); bb.position.set(0, 1.0, 2.15); this.mainPivot.add(bb);
    const bbMid = block(0.02); bbMid.position.set(0, 1.0, 1.38); this.mainPivot.add(bbMid);
    const bEnd = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 0.035), M.alu); bEnd.position.set(0, 1.05, 2.48); this.mainPivot.add(bEnd);
    const vb1 = block(0.015); vb1.position.set(0, 0.99, 0.55); this.mainPivot.add(vb1);
    const vb2 = block(0.015); vb2.position.set(0, 0.1, 0.04); this.mainPivot.add(vb2);
    this.mainPivot.add(rope([[0, 0.1, 0.04], [0.012, 0.5, 0.3], [0, 0.99, 0.55]], 0xffd23a, 0.0055), rope([[0.012, 0.1, 0.04], [-0.012, 0.55, 0.28], [0.012, 0.99, 0.55]], 0xffd23a, 0.0055));
    this.mainPivot.add(rope([[0, 0.12, 0.06], [0.02, 0.07, 0.2], [0.04, 0.0, 0.4]], 0x3b82f6, 0.0055));
    // コクピット床のメインシートラチェットブロック
    const floorRatchet = block(0.022); floorRatchet.position.set(0, FLOOR_Y + 0.24, 0.88); this.body.add(floorRatchet);
    // メインシート(全艇でスキッパーが手に持つ) & ジブシート×2(プレイヤー艇)
    this.mainSheetMesh = new THREE.Mesh(new THREE.BufferGeometry(), ropeMat(0xf8fafc));
    this.mainSheetMesh.frustumCulled = false;
    this.body.add(this.mainSheetMesh);
    if (boat.isPlayer) {
      this.rj = [new THREE.Mesh(new THREE.BufferGeometry(), ropeMat(0xf5f5f5)), new THREE.Mesh(new THREE.BufferGeometry(), ropeMat(0x3b82f6))];
      for (const r of this.rj) { r.frustumCulled = false; this.body.add(r); }
    }

    this.jibPivot = new THREE.Group(); this.jibPivot.position.set(0, 0.42, -2.0); this.body.add(this.jibPivot);
    this.jibSail = new THREE.Mesh(jibGeo, this.jibMat); this.jibPivot.add(this.jibSail);

    this.helm = buildFigure(crewHelm.type, crewHelm.style); this.helmRig = new THREE.Group(); this.helmRig.add(this.helm); this.body.add(this.helmRig);
    this.crew = buildFigure(crewCrew.type, crewCrew.style); this.crewRig = new THREE.Group(); this.crewRig.add(this.crew); this.body.add(this.crewRig);

    this.side = boat.tack;
    this.crewSide = boat.tack;
    this.boomA = 0.3;
    this.phase = Math.random() * 10;
    for (const s of [-1, 1]) {
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.62, 8), spar); sp.rotation.z = Math.PI / 2 + s * 0.12; sp.position.set(s * 0.28, 3.4, -0.92); this.body.add(sp);
      this.body.add(stay([s * SHROUD_A[0], SHROUD_A[1], SHROUD_A[2]], [s * SHROUD_B[0], SHROUD_B[1], SHROUD_B[2]]), stay([s * 0.58, 3.4, -0.92], [0, 5.3, -0.9]));
    }
    this.body.add(stay([0, 0.42, -2.0], [0, 5.3, -0.9]));
    // ランチャーポール(全艇): 使わない時はブーム脇に沿って格納した金属バーとして見える
    this.pole = new THREE.Mesh(poleGeo, spar); this.pole.position.copy(POLE_ROOT); this.pole.visible = false; this.body.add(this.pole);
    const stowGeo = new THREE.CylinderGeometry(0.013, 0.013, 1.9, 8); stowGeo.rotateX(Math.PI / 2);
    this.poleStow = new THREE.Mesh(stowGeo, spar); this.poleStow.position.set(0.075, 0.99, 1.2); this.mainPivot.add(this.poleStow);
    for (const zz of [0.45, 1.95]) { const clip = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.035), M.alu); clip.position.set(0.05, 1.01, zz); this.mainPivot.add(clip); }
    this.jibRot = 0;

    // 船内カメラ用マウント(スキッパーの目線／少し高めのデッキ後方視点)
    this.mount = new THREE.Object3D();
    this.mount.position.set(0.35, 1.42, 0.98);
    this.body.add(this.mount);

    if (boat.isPlayer) {
      this.tells = [];
      const geo = ribbonGeo(0.45, 0.05); // 元のように小さく
      for (const u of TT_HEIGHTS) {
        for (const side of [1, -1]) {
          const matWind = new THREE.MeshBasicMaterial({ color: side > 0 ? 0x00ee44 : 0xff2233, side: THREE.DoubleSide });
          // 裏側のテルテールは depthTest を有効に戻し、opacity を下げて薄く見せる
          const matLeeward = new THREE.MeshBasicMaterial({ color: side > 0 ? 0x006622 : 0x881111, side: THREE.DoubleSide, transparent: true, opacity: 0.35, depthTest: true });
          const m = new THREE.Mesh(geo, matWind);
          const mShadow = new THREE.Mesh(geo, matLeeward);
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
          const vm = new THREE.Mesh(ribbonGeo(0.14, 0.03), new THREE.MeshBasicMaterial({ color: 0xffd23f, side: THREE.DoubleSide }));
          vm.geometry = vm.geometry.clone(); vm.geometry.rotateY(Math.PI / 2);
          const bead = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2222 }));
          vane.add(vm, bead); this.body.add(vane); this.vanes.push({ g: vane, ph: s * 1.7 + vy });
        }
      }


    }
  }

  setFirstPerson(on) {
    if (this.fp === on) return; this.fp = on;
    // 艇内カメラ時はヘルメット/スキッパーモデルを隠す(クルーは表示したままにする)
    if (this.helmRig) this.helmRig.visible = !on; // スキッパーを非表示
    // if (this.crewRig) this.crewRig.visible = !on;
  }

  // ジブのテルテール: 風上側が躍る=緩め過ぎ/上り過ぎ、風下側が躍る=絞り過ぎ/落とし過ぎ
  syncTells(t, bulgeSign, luff, stall) {
    const sgn = this.boat.tack, sx = this.jibSail.scale.x;
    for (const k of this.tells) {
      const u = k.u, v = TT_V;
      const ly = 4.5 * u, lz = u, ry = 0.25 + 4.25 * u, rz = 1.9 - 0.9 * u;
      const bl = 0.24 * Math.sin(Math.PI * v) * (1 - 0.55 * u) * Math.sin(Math.PI * Math.min(1, 0.15 + 0.9 * u));
      const pos = new THREE.Vector3(sx * bl + k.side * 0.035, ly + v * (ry - ly), lz + v * (rz - lz));
      
      k.m.position.copy(pos);
      k.mShadow.position.set(sx * bl - k.side * 0.015, pos.y, pos.z);

      const windward = k.side === sgn;
      const lift = windward ? luff : stall;
      const dev = lift * (0.6 + 0.55 * Math.sin(t * 16 + k.ph)) + 0.05 * Math.sin(t * 6 + k.ph);
      
      k.m.rotation.y = k.side * dev;
      k.m.rotation.x = lift * 0.35 * Math.sin(t * 12 + k.ph);
      k.mShadow.rotation.y = k.m.rotation.y;
      k.mShadow.rotation.x = k.m.rotation.x;
    }
  }

  sync(dt, t) {
    const b = this.boat;
    this.root.position.set(b.x, 0, b.z);
    this.root.rotation.y = -b.h;
    const ph = t * 1.6 + this.phase;
    // コクピット床(FLOOR_Y)が海面(y=0)より下に潜って海が見えないよう、基準高さを上げて上下動も小さくする
    this.body.position.y = 0.12 + 0.05 * Math.sin(ph) + 0.02 * Math.sin(ph * 2.3);
    this.body.rotation.z = b.heel + 0.025 * Math.sin(ph * 0.8);
    this.body.rotation.x = 0.03 * Math.sin(ph * 1.1 + 1) - clamp(b.v / 14, 0, 0.3) * 0.2;

    if (this.rudderGroup) {
      this.rudderGroup.rotation.y = b.steer * 0.6;
    }

    // セール: シート量から角度を決め、ラフ(シバー)時はバタつかせる
    const twa = b.twa, luff = b.luff;
    const sheetAng = 0.08 + (1 - b.sheet) * 1.3;
    let ang = Math.min(sheetAng, Math.max(0.06, Math.abs(b.awa) - 0.04), 1.0); // シュラウド(サイドステー)を突き抜けない上限
    ang += luff * 0.09 * Math.sin(t * 19 + this.phase);
    this.boomA += (ang - this.boomA) * (1 - Math.exp(-dt * (luff > 0.3 ? 14 : 4)));
    const sgn = b.tack;
    this.mainPivot.rotation.y = -sgn * this.boomA;
    // ジブ: 通常は風下側。ランチャー展開に合わせて風上側へ張り出す(観音開き)
    const pk = b.poleK || 0;
    const jibLee = Math.min(this.boomA * 0.8, 0.27); // ジブはシュラウドの内側を通す(緩めてもステーに当たって止まる)
    const jibRot = -sgn * jibLee * (1 - pk) + sgn * JIB_WING * pk;
    this.jibRot = jibRot;
    this.jibPivot.rotation.y = jibRot;
    const bulgeSign = sgn > 0 ? -1 : 1;
    const jibBulge = pk > 0.5 ? -bulgeSign : bulgeSign;
    const flap = 1 - luff * (0.55 + 0.45 * Math.sin(t * 21 + this.phase));
    const jibLuff = luff * (1 - pk);
    this.mainSail.scale.x = bulgeSign * flap; this.jibSail.scale.x = jibBulge * Math.max(0.05, 1 - jibLuff * (0.55 + 0.45 * Math.sin(t * 25 + this.phase + 1))) * (1 - 0.7 * Math.sin(Math.PI * pk));
    // ランチャー展開時はジブクリューがやや上向きに持ち上がるようにジブを少しピッチアップさせる
    this.jibSail.rotation.x = -0.25 * pk;
    const clewY = 0.67 + 0.47 * pk;
    // ポール: マストの取付リング(y=0.80)から持ち上がったジブクリュー(y≈1.14)へやや上向きに伸びる
    this.poleStow.visible = pk <= 0.01;
    if (pk > 0.01) {
      _v.set(1.9 * Math.sin(jibRot), clewY, -2.0 + 1.9 * Math.cos(jibRot)).sub(POLE_ROOT);
      const len = _v.length();
      this.pole.quaternion.setFromUnitVectors(_Y, _v.normalize());
      this.pole.scale.set(1, len * pk, 1); this.pole.visible = true;
    } else this.pole.visible = false;
    
    if (this.tells) this.syncTells(t, bulgeSign, luff, b.stall);
    if (this.vanes) {
      const aw = b.awa;
      for (const v of this.vanes) {
        v.g.rotation.y = Math.atan2(-Math.cos(aw), -Math.sin(aw)) + Math.sin(t * 7 + v.ph) * 0.08;
        v.g.rotation.z = -0.15 + Math.sin(t * 9 + v.ph) * 0.06;
      }
    }
    // クルー・スキッパーの乗船・ハイクアウト姿勢表現
    // サイドデッキ(ガンネル)に腰掛け、身体と脚は船内側(コクピット中央)へ向けて足をコクピット内のハイクベルト下に入れ、
    // 上半身(腰から上)を海側へ反らせてハイクアウトし、顔は前方(バウ・セール方向)を見るリアルな姿勢にする
    this.side += (sgn - this.side) * (1 - Math.exp(-dt * 3));
    const isDeepRun = twa >= (150 * Math.PI) / 180;
    const targetCrewSide = isDeepRun ? -sgn : sgn;
    this.crewSide += (targetCrewSide - this.crewSide) * (1 - Math.exp(-dt * 3.5));
    const isUpwind = twa < Math.PI * 0.6;
    const lean = isUpwind ? clamp(0.95 - twa * 0.35, 0.2, 0.75) * clamp(b.windF * 1.1, 0.7, 1.3) : 0.2;
    const crewLean = isDeepRun ? 0.14 : lean;

    const sideAbs = Math.abs(this.side);
    const crewSideAbs = Math.abs(this.crewSide);

    // ヘルムスマン(スキッパー): 後部サイドデッキ(z=0.86)に座り、脚はコクピット内へ、腰から上を外へハイクアウト
    this.helmRig.position.set(this.side * (0.48 + lean * 0.09), 0.35 - (1 - sideAbs) * 0.06, 0.86);
    this.helmRig.rotation.y = this.side * 1.35; // 船内側(横方向＋わずかに前)を向き、足がコクピット内に収まる
    if (this.helm.userData.upper) {
      this.helmRig.rotation.z = 0;
      const duck = (1 - sideAbs) * 0.42; // タック・ジャイブ移動中はブームの下をくぐる前傾
      const hike = lean * 0.76 * sideAbs; // 腰から上を海側へ反らすハイクアウト
      this.helm.userData.upper.rotation.x = hike - duck;
      this.helm.userData.upper.rotation.z = -this.side * 0.08;
    } else {
      this.helmRig.rotation.z = -this.side * lean * 0.4;
    }
    if (this.helm.userData.head) {
      const uRx = this.helm.userData.upper ? this.helm.userData.upper.rotation.x : 0;
      this.helm.userData.head.rotation.x = -uRx * 0.65;
      this.helm.userData.head.rotation.y = -this.side * 0.55; // 顔をバウ・セール側へ向ける
    }

    // クルー(人間・ネコとも): 前部サイドデッキ(z=-0.04)に座り、足をコクピット床のハイクベルト下にかけ、風速に応じてハイクアウト
    this.crewRig.position.set(this.crewSide * (0.49 + crewLean * 0.09), 0.36 - (1 - crewSideAbs) * 0.06, -0.04);
    this.crewRig.rotation.y = this.crewSide * 1.35;
    if (this.crew.userData.upper) {
      this.crewRig.rotation.z = 0;
      const cDuck = (1 - crewSideAbs) * 0.45;
      const cHike = crewLean * 0.78 * crewSideAbs;
      this.crew.userData.upper.rotation.x = cHike - cDuck;
      this.crew.userData.upper.rotation.z = -this.crewSide * 0.08;
    } else {
      this.crewRig.rotation.z = -this.crewSide * crewLean * 0.35;
    }
    if (this.crew.userData.head) {
      const cRx = this.crew.userData.upper ? this.crew.userData.upper.rotation.x : 0;
      this.crew.userData.head.rotation.x = -cRx * 0.65;
      this.crew.userData.head.rotation.y = -this.crewSide * 0.50;
    }

    // カメラ位置：スキッパーの目線近くまで高くし、ハイクアウト時に外側へより大きく乗り出すように調整
    this.mount.position.set(this.side * (0.45 + lean * 0.7), 1.18 - lean * 0.05, 0.95);
    this.syncMainSheet(sgn, lean, sideAbs);
    if (this.rj) this.syncRopes(sgn, clewY);
  }

  // メインシート: ブーム後部ブロック → トラベラー(ブライドル) → ブーム中央ブロック → コクピット床ラチェットブロック → スキッパーの手元へ
  syncMainSheet(sgn, lean, sideAbs) {
    if (!this.mainSheetMesh) return;
    const A = this.boomA, V = THREE.Vector3;
    const pm = -sgn * A;
    const bzAft = 2.15, bzMid = 1.38;
    const bblkAft = new V(bzAft * Math.sin(pm), 1.40, -0.9 + bzAft * Math.cos(pm));
    const trAft = new V(0, FLOOR_Y + 0.31, 1.52);
    const bblkMid = new V(bzMid * Math.sin(pm), 1.40, -0.9 + bzMid * Math.cos(pm));
    const ratchet = new V(0, FLOOR_Y + 0.25, 0.88);
    // スキッパーの前手(メインシートを持つ手)の座標
    const handX = this.side * (0.24 + lean * 0.20);
    const handY = 0.62 - lean * 0.04 - (1 - sideAbs) * 0.12;
    const handZ = 0.80;
    const hand = new V(handX, handY, handZ);
    const tail = new V(this.side * 0.14, FLOOR_Y + 0.12, 0.85);
    this.mainSheetMesh.geometry.dispose();
    this.mainSheetMesh.geometry = ropeGeo([bblkAft, trAft, bblkMid, ratchet, hand, tail], 0.0085, 28);
  }

  // 走る索: ジブシート(風下=緊張 / 風上=たるみ)
  syncRopes(sgn, clewY = 0.67) {
    const V = THREE.Vector3;
    const pj = this.jibRot, clew = new V(1.9 * Math.sin(pj), clewY, -2.0 + 1.9 * Math.cos(pj));
    const carY = (x) => deckY(-0.1, x) + 0.05;
    const xL = -sgn * 0.58, xW = sgn * 0.58, cl = 0.085;
    const set = (i, pts, r) => { const m = this.rj[i]; m.geometry.dispose(); m.geometry = ropeGeo(pts, r, 24); };
    const lee = [clew, new V(xL * 0.92, carY(xL) + 0.01, -0.1), new V(xL * 0.55, FLOOR_Y + 0.55, -0.1), new V(-sgn * cl, FLOOR_Y + 0.34, -0.12), new V(-sgn * cl, FLOOR_Y + 0.2, 0.0)];
    const mid = clew.clone().lerp(new V(xW, carY(xW), -0.1), 0.5); mid.y -= 0.18; mid.x *= 0.5;
    const wnd = [clew, mid, new V(xW * 1.0, carY(xW) + 0.01, -0.1), new V(xW * 0.6, FLOOR_Y + 0.5, -0.1), new V(sgn * cl, FLOOR_Y + 0.34, -0.12), new V(sgn * cl, FLOOR_Y + 0.2, 0.0)];
    set(0, lee, 0.0065); set(1, wnd, 0.0065);
  }
}


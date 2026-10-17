// コース幾何・レグ進行管理(three.js非依存)
// 座標系: world x=東, z=南(北が -z)。コース座標 a=風上方向距離, c=風上を向いて右方向の距離。
export let W0 = (200 * Math.PI) / 180; // 風向(風が吹いてくる方位) 江の島: 南南西(200°), 八景島: 北北東(15°)
export const U = { x: Math.sin(W0), z: -Math.cos(W0) }; // 風上単位ベクトル
export const Rv = { x: Math.cos(W0), z: Math.sin(W0) }; // 風上を向いた時の右
export function setWindDir(deg) {
  W0 = (deg * Math.PI) / 180;
  U.x = Math.sin(W0); U.z = -Math.cos(W0);
  Rv.x = Math.cos(W0); Rv.z = Math.sin(W0);
}
export const toWorld = (a, c) => ({ x: U.x * a + Rv.x * c, z: U.z * a + Rv.z * c });
export const toCourse = (x, z) => ({ a: x * U.x + z * U.z, c: x * Rv.x + z * Rv.z });

export const LINE_HALF = 75; // スタートライン半幅
// 実際のスタートラインは風に対して完全な直角ではなく、どちらかのエンドが少し有利になる。
// LINE_SKEW>0: 本部船(右)側が風上=有利 / <0: ピン(左)側が有利。ページ読み込み毎に4〜8°でランダム。
export const LINE_SKEW = (Math.random() < 0.5 ? -1 : 1) * ((4 + Math.random() * 4) * Math.PI) / 180;
const LINE_T = Math.tan(LINE_SKEW);
export const lineA = (c) => c * LINE_T; // スタートライン上で横位置cにおける風上距離a
export const FAVORED = LINE_SKEW > 0 ? 'com' : 'pin';
export const ROUND_R = 22;
// トラペゾイドコース: 1(風上) → 2(ウィング) → 3(リーチ終点) → 4(ゲート)
//  4→1: クローズホールドのビート / 1→2: 真風角120°のリーチ
//  2→3: ほぼランニング / 3→4: 真風角120°のリーチ
export const MARKS = {
  m1: { a: 300, c: 0 },
  m1a: { a: 300, c: -30 },
  m2: { a: 200, c: -160 },
  m3: { a: -40, c: -160 },
  gL: { a: 40, c: -22 },
  gR: { a: 40, c: 22 },
  pin: { a: lineA(-LINE_HALF), c: -LINE_HALF },
  com: { a: lineA(LINE_HALF), c: LINE_HALF },
  // フィニッシュ: 図の通り 運営艇(右上=風上側)とフィニッシュマーク(左下)。3マークから右下へリーチして間を通過
  fcom: { a: -95, c: -70 },
  fm: { a: -135, c: -110 },
};

const norm = (a, c) => { const l = Math.hypot(a, c) || 1; return { a: a / l, c: c / l }; };
const dir = (p, q) => norm(q.a - p.a, q.c - p.c);
const START = { a: 0, c: 0 };
const GATEC = { a: 40, c: 0 };
const FINISHC = { a: (-95 + -135) / 2, c: (-70 + -110) / 2 };
const { m1, m1a, m2, m3 } = MARKS;

// side: 通過時にマークが艇の左(-1=左舷回航)か右(+1)か。側判定 cross<0 が左舷回航。
export const LEGS = [
  { id: 0, name: '1', label: '1マーク(風上)を左舷に見て回航', type: 'mark', mark: m1, side: -1, from: START, next: m1a },
  { id: 1, name: '1a', label: '1a(オフセット)を左舷に見て回航', type: 'mark', mark: m1a, side: -1, from: m1, next: GATEC },
  { id: 2, name: '4', label: '4ゲート(4S/4P)を通過', type: 'gate', from: m1a, center: GATEC, aim: { a: 10, c: 0 } },
  { id: 3, name: '1', label: '1マーク(風上)を左舷に見て回航', type: 'mark', mark: m1, side: -1, from: GATEC, next: m2 },
  { id: 4, name: '2', label: '2マーク(ウィング)を左舷に見て回航', type: 'mark', mark: m2, side: -1, from: m1, next: m3 },
  { id: 5, name: '3', label: '3マークを左舷に見て回航', type: 'mark', mark: m3, side: -1, from: m2, next: FINISHC },
  { id: 6, name: 'F', label: 'フィニッシュラインへ', type: 'finish', from: m3, center: FINISHC, aim: FINISHC },
];
let cum = 0;
for (const L of LEGS) {
  if (L.type === 'mark') {
    L.dirIn = dir(L.from, L.mark);
    L.dirOut = dir(L.mark, L.next);
    const o = norm(L.dirIn.a - L.dirOut.a, L.dirIn.c - L.dirOut.c);
    L.aim = { a: L.mark.a + 12 * o.a, c: L.mark.c + 12 * o.c };
  }
  const tgt = L.type === 'mark' ? L.mark : L.center;
  L.len = Math.hypot(tgt.a - L.from.a, tgt.c - L.from.c);
  L.cum = cum;
  cum += L.len;
}
export const TOTAL = cum;

export function progressOf(b) {
  if (b.finished) return 1e6 - b.finishTime;
  const L = LEGS[b.leg];
  const tgt = L.type === 'mark' ? L.mark : L.center;
  const d = Math.hypot(b.c - tgt.c, b.a - tgt.a);
  return L.cum + Math.max(0, L.len - d) - (b.ocs ? 50 : 0);
}

// 毎フレーム呼ぶ。イベント配列を返す。
export function updateProgress(b, t) {
  const ev = [];
  const cp = toCourse(b.x, b.z);
  const prevA = b.a, prevC = b.c;
  b.a = cp.a; b.c = cp.c;
  if (b.finished || t < 0 || prevA === undefined) return ev;
  const L = LEGS[b.leg];
  if (L.type === 'mark') {
    const dx = b.c - L.mark.c, dy = b.a - L.mark.a;
    const d = Math.hypot(dx, dy);
    if (d < ROUND_R) {
      // マーク周りに掃いた角度(反時計回り=左舷回航で正)を積算して回航方向を判定
      const ang = Math.atan2(dy, dx);
      if (!b.visit) b.visit = { min: 1e9, side: 0, passed: false, sweep: 0, ang };
      let da = ang - b.visit.ang; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      b.visit.sweep += da; b.visit.ang = ang;
      if (d < b.visit.min) { b.visit.min = d; b.visit.side = L.dirIn.c * dy - L.dirIn.a * dx; }
      if (dx * L.dirIn.c + dy * L.dirIn.a > 1.5) b.visit.passed = true;
    } else if (b.visit) {
      const v = b.visit; b.visit = null;
      const sideOk = v.sweep * -L.side > 0.25;
      if (sideOk && v.passed && !b.ocs) { b.leg++; ev.push({ type: 'rounded', leg: L }); }
      else if (!sideOk || !v.passed) ev.push({ type: 'wrongSide', leg: L });
    }
  } else if (L.type === 'gate') {
    if (prevA > L.center.a && b.a <= L.center.a && Math.abs(b.c) < 30) { b.leg++; ev.push({ type: 'gate', leg: L }); }
  } else if (L.type === 'finish') {
    const F = MARKS.fcom, G = MARKS.fm;
    const side = (a, c) => (G.a - F.a) * (c - F.c) - (G.c - F.c) * (a - F.a);
    const s0 = side(prevA, prevC), s1 = side(b.a, b.c);
    const sRef = side(MARKS.m3.a, MARKS.m3.c); // 3マーク側が「手前」
    if (s0 * sRef > 0 && s1 * sRef <= 0) {
      const ll = Math.hypot(G.a - F.a, G.c - F.c);
      const proj = ((b.a - F.a) * (G.a - F.a) + (b.c - F.c) * (G.c - F.c)) / ll;
      if (proj > -6 && proj < ll + 6) { b.finished = true; b.finishTime = t; ev.push({ type: 'finish' }); }
    }
  }
  return ev;
}

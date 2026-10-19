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
// LINE_SKEW>0: 本部船(上/右)側が風上=上有利 / <0: ピン(下/左)側が風上=下有利。
// 偏りが出ないよう、前回と逆サイドになる確率を高めつつ約50/50の確率で上有利・下有利を決定する。
export let LINE_SKEW = 0;
let LINE_T = 0;
export let FAVORED = 'pin';
export const lineA = (c) => c * LINE_T; // スタートライン上で横位置cにおける風上距離a

export const ROUND_R = 22;
export let COURSE_MODE = 'trapezoid'; // 'trapezoid' | 'upwind'

// トラペゾイドコース: 1(風上) → 2(ウィング) → 3(リーチ終点) → 4(ゲート)
// 上マークフィニッシュコース(RRS 32.2 S旗コース短縮準拠): スタート → 2倍距離(a=600)の1マークとS旗掲揚運営艇の間のフィニッシュライン
export const MARKS = {
  m1: { a: 300, c: 0 },
  m1a: { a: 300, c: -30 },
  m2: { a: 200, c: -160 },
  m3: { a: -40, c: -160 },
  gL: { a: 40, c: -22 },
  gR: { a: 40, c: 22 },
  pin: { a: 0, c: -LINE_HALF },
  com: { a: 0, c: LINE_HALF },
  // フィニッシュ: トラペゾイド時は運営艇(右上)とフィニッシュマーク(左下)、上マークフィニッシュ時は1マーク(左端)とS旗掲揚運営艇(右端)
  fcom: { a: -95, c: -70 },
  fm: { a: -135, c: -110 },
};

export function randomizeStartLine() {
  let sign = Math.random() < 0.5 ? -1 : 1;
  try {
    const prev = sessionStorage.getItem('snipe-last-fav');
    // 連続して同じサイドばかりにならないよう、前回記録がある場合は65%の確率で反対側にして体感でもしっかり半々にする
    if (prev === 'com') sign = Math.random() < 0.65 ? -1 : 1;
    else if (prev === 'pin') sign = Math.random() < 0.65 ? 1 : -1;
    sessionStorage.setItem('snipe-last-fav', sign > 0 ? 'com' : 'pin');
  } catch (e) {}
  const deg = Math.round(4 + Math.random() * 4); // 4°〜8°の整数角度
  LINE_SKEW = sign * ((deg * Math.PI) / 180);
  LINE_T = Math.tan(LINE_SKEW);
  FAVORED = LINE_SKEW > 0 ? 'com' : 'pin';
  MARKS.pin.a = lineA(-LINE_HALF);
  MARKS.pin.c = -LINE_HALF;
  MARKS.com.a = lineA(LINE_HALF);
  MARKS.com.c = LINE_HALF;
}
randomizeStartLine();

const norm = (a, c) => { const l = Math.hypot(a, c) || 1; return { a: a / l, c: c / l }; };
const dir = (p, q) => norm(q.a - p.a, q.c - p.c);
const START = { a: 0, c: 0 };
const GATEC = { a: 40, c: 0 };

export const LEGS = [];
export let TOTAL = 0;

export function setCourseMode(mode = 'trapezoid') {
  COURSE_MODE = mode === 'upwind' ? 'upwind' : 'trapezoid';
  LEGS.length = 0;
  if (COURSE_MODE === 'upwind') {
    // RRS 32.2(a) 回航マークにおけるフィニッシュ(コース短縮・S旗):
    // トラペゾイドの2倍の風上距離(a=600)に1マーク(左端ピン)とS旗掲揚運営艇(右端・スターボード側)を配置し、その間を風下からフィニッシュする
    MARKS.m1.a = 600; MARKS.m1.c = -22;
    MARKS.fm.a = 600; MARKS.fm.c = -22; // 1マーク自体がフィニッシュライン左端(ピン)
    MARKS.fcom.a = 600; MARKS.fcom.c = 24; // S旗・青旗を掲揚したフィニッシュ運営艇が右端
    const upFinCenter = { a: 600, c: 1 };
    LEGS.push(
      { id: 0, name: 'F', label: '1マーク(2倍距離)フィニッシュへ [RRS32.2 S旗]', type: 'finish', from: START, center: upFinCenter, aim: { a: 600, c: 0 } }
    );
  } else {
    MARKS.m1.a = 300; MARKS.m1.c = 0;
    MARKS.m1a.a = 300; MARKS.m1a.c = -30;
    MARKS.m2.a = 200; MARKS.m2.c = -160;
    MARKS.m3.a = -40; MARKS.m3.c = -160;
    MARKS.gL.a = 40; MARKS.gL.c = -22;
    MARKS.gR.a = 40; MARKS.gR.c = 22;
    MARKS.fcom.a = -95; MARKS.fcom.c = -70;
    MARKS.fm.a = -135; MARKS.fm.c = -110;
    const FINISHC = { a: (-95 + -135) / 2, c: (-70 + -110) / 2 };
    const { m1, m1a, m2, m3 } = MARKS;
    LEGS.push(
      { id: 0, name: '1', markKey: 'm1', label: '1マーク(風上)を左舷に見て回航', type: 'mark', mark: m1, side: -1, from: START, next: m1a },
      { id: 1, name: '1a', markKey: 'm1a', label: '1a(オフセット)を左舷に見て回航', type: 'mark', mark: m1a, side: -1, from: m1, next: GATEC },
      { id: 2, name: '4', label: '4ゲート(4S/4P)を通過', type: 'gate', from: m1a, center: GATEC, aim: { a: 10, c: 0 } },
      { id: 3, name: '1', markKey: 'm1', label: '1マーク(風上)を左舷に見て回航', type: 'mark', mark: m1, side: -1, from: GATEC, next: m2 },
      { id: 4, name: '2', markKey: 'm2', label: '2マーク(ウィング)を左舷に見て回航', type: 'mark', mark: m2, side: -1, from: m1, next: m3 },
      { id: 5, name: '3', markKey: 'm3', label: '3マークを左舷に見て回航', type: 'mark', mark: m3, side: -1, from: m2, next: FINISHC },
      { id: 6, name: 'F', label: 'フィニッシュラインへ', type: 'finish', from: m3, center: FINISHC, aim: FINISHC }
    );
  }
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
  TOTAL = cum;
}
setCourseMode('trapezoid');

export function progressOf(b) {
  if (b.dsq) return -1e6;
  if (b.finished) return 1e6 - b.finishTime;
  const L = LEGS[Math.min(b.leg, LEGS.length - 1)];
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
  const L = LEGS[Math.min(b.leg, LEGS.length - 1)];
  if (!L) return ev;
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
      if (dx * L.dirIn.c + dy * L.dirIn.a > -1.2) b.visit.passed = true;
      // ROUND_R(22m)圏から離れるのを待たず、マークの横を通過して次レグ方向へ回り込んだ瞬間に即座に回航判定
      const swept = b.visit.sweep * -L.side;
      const alongOut = dx * L.dirOut.c + dy * L.dirOut.a;
      if (!b.ocs && b.visit.passed && ((swept > 0.36 && alongOut > -1.8) || swept > 0.62)) {
        b.visit = null;
        b.leg++;
        ev.push({ type: 'rounded', leg: L });
      }
    } else if (b.visit) {
      const v = b.visit; b.visit = null;
      const sideOk = v.sweep * -L.side > 0.22;
      if (sideOk && v.passed && !b.ocs) { b.leg++; ev.push({ type: 'rounded', leg: L }); }
      else if (!sideOk || !v.passed) ev.push({ type: 'wrongSide', leg: L });
    }
  } else if (L.type === 'gate') {
    if (prevA > L.center.a + 2.2 && b.a <= L.center.a + 2.2 && Math.abs(b.c) < 32) { b.leg++; ev.push({ type: 'gate', leg: L }); }
  } else if (L.type === 'finish') {
    const F = MARKS.fcom, G = MARKS.fm;
    const side = (a, c) => (G.a - F.a) * (c - F.c) - (G.c - F.c) * (a - F.a);
    const s0 = side(prevA, prevC), s1 = side(b.a, b.c);
    const refPt = L.from || START;
    const sRef = side(refPt.a, refPt.c); // 前マークまたはスタート側が「手前」
    if (s0 * sRef > 0 && s1 * sRef <= 0) {
      const ll = Math.hypot(G.a - F.a, G.c - F.c);
      const proj = ((b.a - F.a) * (G.a - F.a) + (b.c - F.c) * (G.c - F.c)) / ll;
      if (proj > -6 && proj < ll + 6) { b.finished = true; b.finishTime = t; ev.push({ type: 'finish' }); }
    }
  }
  return ev;
}

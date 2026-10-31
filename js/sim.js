// 艇の物理・風・衝突(three.js非依存)
import { W0, toCourse, MARKS, toWorld, COURSE_MODE } from './course.js';
import { giveWayBoat } from './rules.js';

export const BOAT_LEN = 4.72;
export const KT = 0.5144;
export const SPEED_SCALE = 2.0; // 5分レースに収めるための速度スケール
export let BASE_WIND_KT = 9;
export let SIDE_BIAS = -0.6; // コース左右の地理的有利傾向 (-1=左海面伸び, +1=右海面伸び)
export function setWindParams(kt = 9, sideBias = -0.6) {
  BASE_WIND_KT = Math.max(4, Math.min(22, kt));
  SIDE_BIAS = Math.max(-1.5, Math.min(1.5, sideBias));
}
export const wrap = (a) => {
  if (!Number.isFinite(a)) return 0;
  let r = (a + Math.PI) % (2 * Math.PI);
  if (r <= 0) r += 2 * Math.PI;
  return r - Math.PI;
};
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// ランチャー(ウィスカーポール): 上げている間はこの真風角より風上には向けない
export const POLE_MIN = (100 * Math.PI) / 180;

// スナイプ級の実態に即した風域別ベストクローズ角度(TWA deg)
// ・VMGが最大になるスイートスポットは 40°〜44° を維持
// ・38°〜39° でもシバーせずに走ることができ、VMGは40°〜44°よりほんのわずかに遅い程度
export function bestCloseDeg(windKt = BASE_WIND_KT) {
  if (windKt <= 5.5) return 44.0;
  if (windKt <= 9.0) return 44.0 - ((windKt - 5.5) / 3.5) * 2.5;   // 5.5kt:44° → 9.0kt:41.5°
  if (windKt <= 13.5) return 41.5 - ((windKt - 9.0) / 4.5) * 1.5;  // 9.0kt:41.5° → 13.5kt:40°
  return 40.0;
}

// スナイプ級のポーラー(TWA deg, windKt → m/s @ 基準9kt換算)
// ・クローズ(35°〜45°): ベストVMGは40°〜44°、38°〜39°もシバーせずVMGよりほんのわずかに遅い程度で走れる
// ・リーチング(60°〜135°): 実艇同様にラフ(のぼす: 120°→95°→75°)すると見かけ風速(AWS)が増してスロット効果で艇速が明確に速くなる
const V45_CLOSE = 2.10;
const VMG_CLOSE = V45_CLOSE * Math.cos((45 * Math.PI) / 180); // ≈ 1.4849 m/s
const V33_BASE = VMG_CLOSE / Math.cos((33 * Math.PI) / 180);
const POLAR = [
  [0, 0],
  [20, 0],
  [25, 0.86],
  [29, 1.42],
  [33, V33_BASE],
  [45, V45_CLOSE],
  [48, 2.34],
  [55, 2.96],
  [65, 3.76],
  [75, 3.92],
  [85, 3.86],
  [95, 3.72],
  [110, 3.52],
  [125, 3.30],
  [135, 3.12],
  [150, 3.00],
  [160, 2.84],
  [170, 2.90],
  [180, 2.45],
];

export function polar(deg, windKt = BASE_WIND_KT) {
  if (deg >= 33 && deg <= 45) {
    const opt = bestCloseDeg(windKt); // 40°〜44°
    const vIso = VMG_CLOSE / Math.cos((deg * Math.PI) / 180);
    // 40°〜44°のスイートスポットでVMGが最大(vmgFactor ≈ 1.015)
    let vmgFactor = 1.015;
    if (deg >= 40 && deg <= 44.5) {
      const diff = deg - opt;
      vmgFactor = 1.015 - 0.00035 * diff * diff;
    } else if (deg >= 38 && deg < 40) {
      // 38°〜39°はベストVMG(40°〜44°)よりほんのわずかに遅い程度(VMG比で約1.2%〜2.2%差)でしっかり上れる
      const d40 = 40 - deg; // 0..2
      vmgFactor = 1.002 - 0.0055 * d40;
    } else if (deg < 38) {
      // 37°以下はさらにピンチングとなり風域に応じて減速
      const lightNess = clamp((9.0 - windKt) / 3.8, 0, 1);
      const overPinch = 38 - deg;
      vmgFactor = 0.991 - overPinch * overPinch * (0.0045 + 0.0045 * lightNess);
    } else {
      const overFoot = deg - 44.5;
      vmgFactor = 1.012 - 0.0025 * overFoot * overFoot;
    }
    return vIso * clamp(vmgFactor, 0.78, 1.02);
  }
  if (deg > 20 && deg < 33) {
    const v33 = polar(33, windKt);
    if (deg >= 29) return 1.42 + ((deg - 29) / 4) * (v33 - 1.42);
  }
  for (let i = 1; i < POLAR.length; i++) {
    if (deg <= POLAR[i][0]) {
      const [d0, v0] = POLAR[i - 1], [d1, v1] = POLAR[i];
      return v0 + ((deg - d0) / (d1 - d0)) * (v1 - v0);
    }
  }
  return POLAR[POLAR.length - 1][1];
}

// 風上〜風下でのセール最適トリム(1=引き込み, 0=開放)
const SOPT = [[0, 0.97], [0.8, 0.97], [1.57, 0.58], [2.4, 0.22], [3.15, 0.12]];
export function sheetOpt(twa) {
  for (let i = 1; i < SOPT.length; i++) if (twa <= SOPT[i][0]) { const [a0, v0] = SOPT[i - 1], [a1, v1] = SOPT[i]; return v0 + ((twa - a0) / (a1 - a0)) * (v1 - v0); }
  return 0.12;
}

// ---------- 海況(波) ----------
// 海面・風向ごとの実際の波の特徴:
//  ・八景島 × 北風: 東京湾奥の短い吹送距離＋護岸・八景島の岸壁反射で、向きの違う短い波が交差する「三角波」
//  ・江の島 × 南風: 相模湾外洋から入る周期の長い「うねり」(＋その上に乗る小さな風浪)
//  ・江の島 × 北風: 陸からの吹き出しで吹送距離が短く、周期の短い細かい風浪
// 各成分: { A:振幅[m], k:波数, w:角周波数, dx,dz:進行方向, ph:位相, long:ジオメトリ変位する長周期成分か }
export const SEA = { type: 'mixed', label: '', H: 0.3, steep: 0.55, surf: 0.12, maxSlope: 0.1, comps: [], longAmp: 0, clock: 0 };
export function setSeaState(venue, windDeg, kt) {
  const d = ((windDeg % 360) + 360) % 360;
  const north = d >= 290 || d <= 80;
  const south = d >= 125 && d <= 260;
  const R = Math.PI / 180;
  const from = d * R; // 風(波)が来る方位
  const comps = [];
  // 方位 brg から来て反対方向へ進む波 (x=東, z=南)
  const add = (A, lambda, brgFrom, ph, long = false) => {
    const k = (2 * Math.PI) / lambda;
    comps.push({ A, k, w: Math.sqrt(9.81 * k), dx: -Math.sin(brgFrom), dz: Math.cos(brgFrom), ph, long });
  };
  let type, label, H;
  if (venue === 'hakkeijima' && north) {
    type = 'chop'; label = '三角波(北風・護岸反射の交差波)';
    H = clamp(0.22 + 0.034 * kt, 0.28, 0.84);
    add(H * 0.42, 7.2, from, 0.0);
    add(H * 0.22, 6.2, from + 26 * R, 1.9); // 岸壁からの反射波が斜めに交差(主風向の流れを損なわない角度)
    add(H * 0.19, 5.6, from - 24 * R, 4.1);
    add(H * 0.13, 11.0, from + 5 * R, 2.6);
    Object.assign(SEA, { steep: 1.08, surf: 0.08 });
  } else if (venue === 'enoshima' && south) {
    type = 'swell'; label = '長周期のうねり(南風・相模湾)';
    H = clamp(0.98 + 0.058 * kt, 1.10, 2.35);
    add(H * 0.46, 64, from, 0.0, true);         // 風向に沿った相模湾の大きなうねり
    add(H * 0.24, 44, from - 7 * R, 2.2, true); // 副次うねり
    add(0.095 + 0.013 * kt, 9.2, from + 5 * R, 1.1);  // うねりに乗る風浪
    add(0.065 + 0.010 * kt, 6.6, from - 10 * R, 3.7);
    Object.assign(SEA, { steep: 0.46, surf: 0.40 });
  } else if (venue === 'enoshima' && north) {
    type = 'short'; label = '周期の短い風浪(北風・陸からの吹き出し)';
    H = clamp(0.24 + 0.036 * kt, 0.30, 0.90);
    add(H * 0.38, 9.6, from, 0.0);
    add(H * 0.22, 7.8, from + 14 * R, 2.3);
    add(H * 0.22, 48, from - 6 * R, 4.4, true); // 江の島沖に残る相模湾のベースうねり
    add(H * 0.10, 5.6, from - 18 * R, 1.2);
    Object.assign(SEA, { steep: 0.84, surf: 0.18 });
  } else {
    type = 'mixed'; label = venue === 'enoshima' ? 'うねりを伴う風浪' : '風浪';
    H = venue === 'enoshima' ? clamp(0.68 + 0.045 * kt, 0.78, 1.75) : clamp(0.21 + 0.032 * kt, 0.27, 0.80);
    add(H * 0.38, venue === 'enoshima' ? 54 : 10.5, from, 0.0, venue === 'enoshima');
    add(H * 0.24, 8.6, from + 14 * R, 2.0);
    add(H * 0.20, 32, from - 8 * R, 4.0, true);
    add(H * 0.10, 6.2, from - 18 * R, 1.3);
    Object.assign(SEA, { steep: 0.64, surf: 0.20 });
  }
  let ms = 0, la = 0;
  for (const c of comps) { ms += c.A * c.k; if (c.long) la += c.A; }
  Object.assign(SEA, { type, label, H, comps, maxSlope: Math.max(0.02, ms * 0.7), longAmp: la });
}
// 点(x,z)・時刻tの海面: h=全成分の高さ, hLong=長周期成分の高さ, slope=進行方向(hx,hz)の傾き(+なら上り坂)
const _ws = { h: 0, hLong: 0, slope: 0, slopeLong: 0 };
export function waveSample(x, z, t, hx = 0, hz = 0) {
  let h = 0, hl = 0, sl = 0, sll = 0;
  for (const c of SEA.comps) {
    const ph = c.k * (c.dx * x + c.dz * z) - c.w * t + c.ph;
    const s = Math.sin(ph), co = Math.cos(ph);
    const g = c.A * c.k * co * (c.dx * hx + c.dz * hz);
    h += c.A * s; sl += g;
    if (c.long) { hl += c.A * s; sll += g; }
  }
  _ws.h = h; _ws.hLong = hl; _ws.slope = sl; _ws.slopeLong = sll;
  return _ws;
}

// ---------- 潮の満ち引き・潮流 (八景島沖＝東京湾西岸、江の島沖＝相模湾北東部) ----------
// 実際の天文潮汐(月齢・太陰半日周潮M2+太陽半日周潮S2)と各海面の地形的特性からリアルタイムの潮汐・潮流を算出:
//  ・八景島沖(東京湾西岸・金沢八景沖):
//     上げ潮(満潮へ向かう流れ)は湾奥へ向かう北北西流(約335°方向)、下げ潮(干潮へ向かう流れ)は湾口・観音崎へ向かう南南東流(約155°方向)。大潮最大約0.45kt
//  ・江の島沖(相模湾北東部):
//     上げ潮は相模湾反時計回り還流と合わさる西北西流(約285°・江の島〜烏帽子岩方向)、下げ潮は東南東流(約105°・鎌倉〜逗子方向)。大潮最大約0.35kt
export const TIDE = {
  venue: 'hakkeijima',
  tideType: '中潮',     // 大潮 / 中潮 / 小潮 / 長潮 / 若潮
  phaseLabel: '上げ潮', // 上げ潮 / 下げ潮 / 満潮前後(潮止まり) / 干潮前後(潮止まり)
  dirToDeg: 335,        // 潮が流れていく方位(度: 0=北, 90=東, 180=南, 270=西)
  dirLabel: '北北西',
  kt: 0.22,             // 潮流速度 [kt]
  heightM: 1.25,        // 推算潮位 [m]
  vx: 0,                // コース座標系での潮流ベクトルX (東向き+) [m/s]
  vz: 0,                // コース座標系での潮流ベクトルZ (南向き+) [m/s]
  active: true,
};

const COMPASS_16_JA = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
function degToCompassJa(deg) {
  const d = ((deg % 360) + 360) % 360;
  return COMPASS_16_JA[Math.round(d / 22.5) % 16];
}

export function setTideState(venue = 'hakkeijima', windDeg = 0, nowMs = Date.now()) {
  // 基準新月: 2024-01-11 11:57 UTC (1704974220000 ms), 朔望月 = 29.530588853 日
  const SYNODIC_DAYS = 29.530588853;
  const elapsedDays = (nowMs - 1704974220000) / 86400000;
  const lunarAge = ((elapsedDays % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;

  // 月齢から潮回り(大潮・中潮・小潮・長潮・若潮)と振幅係数を算出
  const halfCycle = lunarAge % (SYNODIC_DAYS * 0.5); // 0 .. 14.765
  let tideType = '中潮', springFactor = 0.88;
  if (halfCycle < 2.2 || halfCycle > 13.0) {
    tideType = '大潮'; springFactor = 1.18;
  } else if (halfCycle < 5.6 || (halfCycle >= 11.2 && halfCycle <= 13.0)) {
    tideType = '中潮'; springFactor = 0.90;
  } else if (halfCycle < 8.8) {
    tideType = '小潮'; springFactor = 0.58;
  } else if (halfCycle < 10.0) {
    tideType = '長潮'; springFactor = 0.48;
  } else {
    tideType = '若潮'; springFactor = 0.72;
  }

  // 日本標準時(UTC+9)での時刻と太陰時角から半日周潮位相を計算
  // 満潮時刻は八景島(横浜・東京湾西岸)が江の島(片瀬・相模湾)より約30分遅れる
  const jstHours = ((nowMs + 9 * 3600000) / 3600000);
  const lunarLagHours = lunarAge * 0.8412; // 1日あたり約50.5分の月の南中遅れ
  const portHighOffset = venue === 'enoshima' ? 4.85 : 5.38;
  const semidiurnalPeriod = 12.4206; // M2半日周潮周期 [時間]
  const tideAngle = ((jstHours - lunarLagHours - portHighOffset) / semidiurnalPeriod) * 2 * Math.PI;

  // 潮位 h = cos(tideAngle) (+1:満潮, -1:干潮)、潮流流速 u = -sin(tideAngle) (+:上げ潮最大, -:下げ潮最大)
  const tideCos = Math.cos(tideAngle);
  const flowSin = -Math.sin(tideAngle); // >0 なら干潮→満潮へ向かう「上げ潮」、<0 なら満潮→干潮へ向かう「下げ潮」
  const meanLevel = venue === 'enoshima' ? 1.05 : 1.18;
  const tideRange = (venue === 'enoshima' ? 0.58 : 0.78) * springFactor;
  const heightM = Math.round((meanLevel + tideRange * tideCos) * 100) / 100;

  // 上げ潮 / 下げ潮 の流向と最大流速
  const isFlood = flowSin >= 0;
  const floodDir = venue === 'enoshima' ? 285 : 335; // 江の島上げ潮: 西北西(285°), 八景島上げ潮: 北北西(335°)
  const ebbDir = venue === 'enoshima' ? 105 : 155;   // 江の島下げ潮: 東南東(105°), 八景島下げ潮: 南南東(155°)
  const maxKt = (venue === 'enoshima' ? 0.35 : 0.45) * springFactor;
  const rawKt = Math.abs(flowSin) * maxKt;
  const kt = Math.round(Math.max(0.04, rawKt) * 100) / 100;
  const dirToDeg = isFlood ? floodDir : ebbDir;
  const dirLabel = degToCompassJa(dirToDeg);

  let phaseLabel;
  if (Math.abs(flowSin) < 0.20) {
    phaseLabel = tideCos >= 0 ? '満潮前後(潮止まり)' : '干潮前後(潮止まり)';
  } else {
    phaseLabel = isFlood ? '上げ潮' : '下げ潮';
  }

  // レース海面ワールド座標(x=東, z=南)での潮流ベクトル [m/s]
  const dirRad = (dirToDeg * Math.PI) / 180;
  const speedMs = kt * KT;
  const vx = Math.sin(dirRad) * speedMs;
  const vz = -Math.cos(dirRad) * speedMs;

  Object.assign(TIDE, {
    venue,
    tideType,
    phaseLabel,
    dirToDeg,
    dirLabel,
    kt,
    heightM,
    vx,
    vz,
  });
  return TIDE;
}
setTideState('hakkeijima', 0, Date.now());

// ---------- 風の振れ(シフト) ----------
// 実際のレース同様、①左右に振れて戻る「オシレーション」、②徐々に回って戻らない「パーシステントシフト」、
// ③ブローと共に短時間で振れる「ステップ的なシフト」をランダムな順番・長さで組み合わせた時系列を毎レース生成する
const SHIFT_T0 = -150, SHIFT_DT = 0.5, SHIFT_SPAN = 1500;
const SHIFT_N = Math.ceil(SHIFT_SPAN / SHIFT_DT) + 2;
const SHIFT_TAB = new Float32Array(SHIFT_N);
export const SHIFT_LOG = []; // 振り返り用: { t, type, deg }
export function randomizeWindShifts(seed = Date.now()) {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const D = Math.PI / 180, LIM = 12 * D;
  let mean = (r() - 0.5) * 6 * D, meanT = mean, rate = 0.2 * D;
  let amp = (3 + r() * 4) * D, ampT = amp, per = 50 + r() * 40, phase = r() * 6.283;
  let segEnd = SHIFT_T0;
  SHIFT_LOG.length = 0;
  for (let i = 0; i < SHIFT_N; i++) {
    const t = SHIFT_T0 + i * SHIFT_DT;
    if (t >= segEnd) {
      const u = r();
      if (u < 0.42) {
        // オシレーション: 平均はほぼそのまま、左右に周期的に振れる
        meanT = clamp(mean + (r() - 0.5) * 3 * D, -LIM, LIM); rate = 0.1 * D;
        ampT = (3 + r() * 4.5) * D; per = 40 + r() * 60;
        segEnd = t + 50 + r() * 70;
        SHIFT_LOG.push({ t, type: 'osc', deg: Math.round((ampT / D) * 10) / 10 });
      } else if (u < 0.78) {
        // パーシステント: 一方向へゆっくり回り、そのまま戻らない(既に大きく振れている側へさらに回る確率は低め)
        let dir = r() < 0.5 ? -1 : 1;
        if (Math.sign(mean) === dir && r() < Math.abs(mean) / LIM) dir = -dir;
        const mag = (5 + r() * 8) * D;
        meanT = clamp(mean + dir * mag, -LIM, LIM);
        rate = Math.abs(meanT - mean) / (35 + r() * 70);
        ampT = (1.5 + r() * 3) * D; per = 35 + r() * 40;
        segEnd = t + 70 + r() * 90;
        SHIFT_LOG.push({ t, type: 'persist', deg: Math.round(((meanT - mean) / D) * 10) / 10 });
      } else {
        // ステップ: ブローと共に短時間で振れる(後で戻ることも戻らないこともある)
        const dir = Math.sign(mean) !== 0 && r() < Math.abs(mean) / LIM ? -Math.sign(mean) : r() < 0.5 ? -1 : 1;
        meanT = clamp(mean + dir * (4 + r() * 6) * D, -LIM, LIM);
        rate = Math.abs(meanT - mean) / (5 + r() * 8);
        ampT = (2 + r() * 3) * D; per = 30 + r() * 30;
        segEnd = t + 25 + r() * 45;
        SHIFT_LOG.push({ t, type: 'step', deg: Math.round(((meanT - mean) / D) * 10) / 10 });
      }
    }
    const dm = meanT - mean, st = rate * SHIFT_DT;
    mean += Math.abs(dm) <= st ? dm : Math.sign(dm) * st;
    amp += (ampT - amp) * (SHIFT_DT / 18);
    phase += (2 * Math.PI * SHIFT_DT) / per;
    SHIFT_TAB[i] = mean + amp * Math.sin(phase);
  }
}
randomizeWindShifts(Date.now());
export function shiftAt(t) {
  let u = (t - SHIFT_T0) / SHIFT_DT;
  if (u < 0) u = 0;
  if (u > SHIFT_N - 2) u = u % (SHIFT_N - 2); // 練習モードの長時間航行時はループ
  const i = Math.floor(u), f = u - i;
  return SHIFT_TAB[i] + (SHIFT_TAB[i + 1] - SHIFT_TAB[i]) * f;
}

// ブランケット(風影)・リーバウ効果(風下前方からの吹き上げリフト＆風上艇へのバックウィンド)・別タック艇スターン通過リフト
const SHADOW_LEN = 23; // ディンギーの風影影響圏(従来の34mから少し小さめの約4.8艇身に調整)
export function computeBlanket(boats) {
  for (const b of boats) {
    b.coverT = 0;
    b.backT = 0;      // うちバックウインド(風下艇のリーチからの吹き返し)成分
    b.windBendT = 0;  // +ならリフト(のぼせる)、-ならヘダー(落とされる) [rad]
    b.flowBoostT = 0; // 局所的な増速効果
    b.aeroTag = '';
  }
  for (const A of boats) {
    if (A.dsq) continue;
    // A艇の船首方向ベクトル(fx, fz)と風下横方向ベクトル(lx, lz)
    const fx = Math.sin(A.h), fz = -Math.cos(A.h);
    const lx = -A.tack * Math.cos(A.h), lz = -A.tack * Math.sin(A.h);
    // 真風(True Wind)の流下方向ベクトル(twx, twz)
    const twx = -Math.sin(A.windFrom), twz = Math.cos(A.windFrom);
    // クローズホールド(twa < 55°)では見かけ風とリーチ排気で風影がわずかに風下後方へ傾くが、
    // リーチング〜ランニング(twa >= 60°)では他艇が「明確に真風上の方向」にいる時のみブランケットになるよう真風軸ベースにする
    const upwindFactor = 1 - smoothstep(0.92, 1.32, A.twa);
    const awWeight = 0.12 + 0.24 * upwindFactor;
    const leechDeflect = upwindFactor * 0.06 * (1 - A.luff * 0.7);
    let sx = twx * (1 - awWeight) + A.awx * awWeight - fx * leechDeflect;
    let sz = twz * (1 - awWeight) + A.awz * awWeight - fz * leechDeflect;
    const sl = Math.hypot(sx, sz) || 1;
    sx /= sl; sz /= sl;

    const maxLen = SHADOW_LEN + (A.poleK || 0) * 3.5;
    const sailProj = 1.08 + 0.28 * Math.sin(clamp(A.twa, 0.35, 2.85)) + 0.24 * (A.poleK || 0);
    // リーチング・ランニング時はA艇がB艇から見て真風上方向(cos >= 0.76 ≒ 真風軸から±40°以内)にいることを必須とする
    const minTrueCos = 0.52 + 0.26 * (1 - upwindFactor);

    for (const B of boats) {
      if (A === B || B.dsq) continue;
      const rx = B.x - A.x, rz = B.z - A.z;
      const dist2 = rx * rx + rz * rz;
      if (dist2 > (maxLen + 4) * (maxLen + 4) || dist2 < 0.25) continue;
      const dist = Math.sqrt(dist2);

      // 真風方向でA艇が明確に風上側にいない場合(横並びやリーチングで単に前方を走っているだけの場合)はブランケットにならない
      const alongTrue = rx * twx + rz * twz;
      if (alongTrue <= 1.2 || alongTrue / dist < minTrueCos) {
        // ブランケット圏外
      } else {
        const along = rx * sx + rz * sz;
        if (along > 1.1 && along < maxLen) {
          const lat = Math.abs(-rx * sz + rz * sx);
          const half = sailProj + along * 0.125;
          if (lat < half) {
            const normDist = clamp((along - 1.1) / (maxLen - 1.1), 0, 1);
            const distFactor = Math.pow(1 - Math.pow(normDist, 1.28), 1.45);
            const coreFactor = Math.exp(-Math.pow(lat / (half * 0.65), 2));
            const edgeFactor = Math.max(0, 1 - lat / half);
            // リーチング時は真風軸からのズレに応じてさらに厳격に減衰させる
            const trueAlign = smoothstep(minTrueCos, Math.min(0.96, minTrueCos + 0.18), alongTrue / dist);
            const bestS = clamp(distFactor * trueAlign * (0.80 * coreFactor + 0.20 * edgeFactor), 0, 1.0);
            if (bestS > 0.01) {
              B.coverT = clamp(B.coverT + bestS, 0, 1.0);
              // 風影内ではセール後流の乱れで風向がヘダー(頭を抑えられる悪風)になる
              if (B.twa < 1.55 && bestS > 0.14) {
                B.windBendT -= bestS * 0.048;
              }
            }
          }
        }
      }

      // A艇基準のB艇相対位置 (ahead: Aの前方+, leeDist: Aの風下横方向+)
      const ahead = rx * fx + rz * fz;
      const leeDist = rx * lx + rz * lz;

      // 2) リーバウ効果(Lee-Bow / Safe Leeward):
      // クローズ〜クローズリーチで同タックの2艇において、B艇がA艇の風下側かつ斜め前方にいるとき:
      // ・風下艇BはA艇セールの循環によるアップウォッシュ(吹き上げ)とスロット効果で「わずかにのぼせる」(効果は従来の1/3に抑制)
      // ・風上艇AはB艇セールリーチからのバックウィンド(排気)を浴びてヘダー＆減速を受ける(風上側への影響範囲は短くし、少し風上に離れれば影響なし)
      if (A.tack === B.tack && A.twa > 0.48 && A.twa < 1.42 && B.twa > 0.48 && B.twa < 1.42) {
        if (leeDist > 1.2 && leeDist < 9.5 && ahead > -1.0 && ahead < 9.5) {
          const kLee = Math.exp(-Math.pow((leeDist - 3.6) / 3.0, 2)) * Math.exp(-Math.pow((ahead - 2.6) / 3.6, 2));
          if (kLee > 0.06) {
            // 風下前方のB艇(リーバウ艇): 従来の1/3の控えめなリフトと微増速
            const liftRad = 0.026 * kLee;
            if (liftRad > B.windBendT) {
              B.windBendT = Math.max(B.windBendT, liftRad);
              B.flowBoostT = Math.max(B.flowBoostT, 0.013 * kLee);
              if (kLee > 0.22) B.aeroTag = 'leebow';
            }
          }
          // 風上後方のA艇(被リーバウ艇): バックウィンドの影響範囲は風上側へ短く(leeDist < 5.4m)限定
          if (leeDist < 5.4 && ahead > -0.1 && ahead < 7.5) {
            const kBack = Math.exp(-Math.pow((leeDist - 2.35) / 1.70, 2)) * Math.exp(-Math.pow((ahead - 2.2) / 2.8, 2));
            if (kBack > 0.08) {
              const backK = kBack * smoothstep(-0.1, 1.6, ahead);
              A.windBendT -= 0.055 * backK;
              A.coverT = clamp(A.coverT + 0.65 * backK, 0, 1.0);
              A.backT = clamp(A.backT + 0.65 * backK, 0, 1.0);
              if (backK > 0.20 && !A.aeroTag) A.aeroTag = 'backwind';
            }
          }
        }
      }

      // 3) 別タック艇のスターン後方通過時のリフト(従来の1/3に抑制):
      if (A.tack !== B.tack && B.twa > 0.50 && B.twa < 1.25 && A.twa > 0.50 && A.twa < 2.2) {
        const behindA = -ahead; // A艇の船尾から後方への距離
        if (behindA > 1.4 && behindA < 16.5 && leeDist > -5.5 && leeDist < 9.5) {
          const kBehind = Math.exp(-Math.pow((behindA - 5.8) / 4.5, 2));
          const kLat = Math.exp(-Math.pow((leeDist - 1.8) / 4.2, 2));
          const kDuck = kBehind * kLat;
          if (kDuck > 0.08) {
            B.coverT *= (1 - 0.25 * kDuck);
            const sternLift = 0.032 * kDuck;
            if (sternLift > B.windBendT) {
              B.windBendT = sternLift;
              B.flowBoostT = Math.max(B.flowBoostT, 0.014 * kDuck);
              if (kDuck > 0.22) B.aeroTag = 'sternlift';
            }
          }
        }
      }
    }
  }
}

// 風上から風下へゆっくり流れるブロー(強風の黒い筋) + 周期シフト + 海面・風向ごとの片側有利バイアス
export function windAt(x, z, t) {
  const { a, c } = toCourse(x, z);
  const adv = a + t * 4.8; // 風上(+a)から風下(-a)へ秒速4.8mで流れるブロー座標
  const p1 = Math.sin(adv * 0.032 + c * 0.018 + Math.sin(c * 0.011 - t * 0.08) * 1.4);
  const p2 = Math.sin(adv * 0.055 - c * 0.024 + 1.7);
  const p3 = Math.sin(adv * 0.019 + c * 0.038 - 0.9);
  const puffRaw = 0.50 * p1 + 0.32 * p2 + 0.18 * p3;
  const puff = smoothstep(-0.15, 0.72, puffRaw);
  const sideNorm = clamp(c / 160, -1.2, 1.2);
  const geoPressure = SIDE_BIAS * sideNorm * 0.065;
  const geoShift = SIDE_BIAS * sideNorm * 0.075;
  const osc = shiftAt(t); // オシレーション/パーシステント/ステップを組み合わせた時系列の振れ
  const puffShift = 0.06 * Math.sin(adv * 0.028 - c * 0.021);
  const shift = osc + puffShift + geoShift;
  const f = clamp(0.86 + 0.34 * puff + geoPressure, 0.72, 1.32);
  return { from: W0 + shift, f, puff };
}

export class Boat {
  constructor(o) {
    Object.assign(this, { id: 0, name: '', sailNo: '', isPlayer: false, skill: 1, color: 0xffffff }, o);
    this.x = 0; this.z = 0; this.h = 0; this.v = 0;
    this.steer = 0; this.sheet = 1; this.throttle = 1;
    this.tack = 1; this.tacking = false; this.tackTimer = 0;
    this.tackCount = 0; this.gybeCount = 0;
    this.rel = 0; this.twa = 0; this.effTwaDeg = 0; this.byTheLee = 0;
    this.windFrom = W0; this.windF = 1;
    this.maneuver = null; this.penalty = null; this.penaltyDone = false; this.penaltyExpired = null; this.penaltyUpgraded = null;
    this.leg = 0; this.ocs = false; this.started = false; this.finished = false; this.finishTime = 0;
    this.a = undefined; this.c = 0; this.visit = null;
    this.contactCD = 0; this.touchCD = 0; this.heel = 0; this.rollBias = 0; this.hike = 0.15; this.turned = 0;
    this.sOpt = 1; this.luff = 0; this.stall = 0;
    this.cover = 0; this.coverT = 0; this.back = 0; this.backT = 0;
    this.waveF = 1; this.waveH = 0; this.waveSlope = 0; this.waveLoss = 0;
    this.waveSlam = 0; this.visualSlam = 0; this.waveSlamCD = 0; this._prevClimb = 0;
    this.windBend = 0; this.windBendT = 0;
    this.flowBoost = 0; this.flowBoostT = 0;
    this.aeroTag = ''; this.aeroClimb = 0;
    this.awa = 0; this.aws = 0; this.awx = -Math.sin(W0); this.awz = Math.cos(W0);
    this.dnf = false; this.dsq = false; this.dsqReason = '';
    this.pole = false; this.poleK = 0; this.gybePoleRestore = 0; // ランチャー(上げる指示 / 展開度0..1 / ジャイブ後の自動再アップタイマー)
    this.rudderDrag = 0; this.snagCD = 0; this.wakeWave = 0; // 急舵時のラダー抵抗白波強度 / アンカーロープ引っかかりCD / 他艇の引き波影響度
  }
  place(x, z, h) {
    this.x = x; this.z = z; this.h = h;
    const cp = toCourse(x, z); this.a = cp.a; this.c = cp.c;
    const w = windAt(x, z, -60);
    this.windFrom = w.from;
    const rel = wrap(w.from - h);
    this.rel = rel; this.twa = Math.abs(rel); this.effTwaDeg = (this.twa * 180) / Math.PI;
    this.tack = rel >= 0 ? 1 : -1;
    this.byTheLee = 0;
  }
  // kind: 'tack'(風上側へ回頭) / 'gybe'(風下側へ回頭) / 未指定=自動
  startManeuver(kind) {
    if (this.maneuver) return false;
    const k = kind || (this.twa < Math.PI / 2 ? 'tack' : 'gybe');
    if (k === 'tack' && this.pole) return false; // ランチャーを上げたまま風上へは回れない
    const restorePole = k === 'gybe' && (this.pole || this.gybePoleRestore > 0);
    if (k === 'gybe') { this.pole = false; this.gybePoleRestore = 0; } // ジャイブ回頭中は一旦ランチャーを下ろし、ジャイブ後に自動で再アップする
    const s0 = this.tack || (Math.sign(this.rel) || 1);
    // ジャイブは180°ちょうどではなくセールが出ているため160°(旧タックから見て200°)付近で返して安定させる
    const gybeTargetRad = (162 * Math.PI) / 180;
    const relNew = k === 'tack' ? -s0 * clamp(Math.abs(this.rel), 0.68, 0.86) : -s0 * gybeTargetRad;
    this.maneuver = { relNew, kind: k, s0, dir: k === 'tack' ? s0 : -s0, t: 0, tCross: 0, flipped: false, restorePole };
    this.maneuverStarted = k;
    return true;
  }
  setPole(on) {
    if (on && (this.twa < POLE_MIN || this.maneuver || this.penalty)) return false;
    if (!on) { this.gybePoleRestore = 0; if (this.maneuver) this.maneuver.restorePole = false; }
    this.pole = on; return true;
  }
  startPenalty(rule) {
    if (this.dsq) return false;
    const isTwoTurns = rule !== 31; // RRS 44.1: 第2章(ルール10〜18)は2回転(720°)、ルール31(マーク接触)は1回転(360°)
    if (this.penalty) {
      if (this.penalty.reqDeg === 360) {
        this.penalty.reqDeg = 720;
        this.penalty.reqRad = 4 * Math.PI * 0.96;
        this.penalty.rule = rule;
        this.penalty.timer = Math.max(this.penalty.timer, 25.0);
        this.penalty.upgraded = true;
        return true;
      }
      return false;
    }
    const reqDeg = isTwoTurns ? 720 : 360;
    const reqRad = (isTwoTurns ? 4 : 2) * Math.PI * 0.96;
    const timer = isTwoTurns ? 25.0 : 20.0;
    this.penalty = { turned: 0, rule, reqDeg, reqRad, timer, clearWater: true, upgraded: false };
    this.pole = false;
    return true;
  }

  update(dt, t, boats) {
    const w = windAt(this.x, this.z, t);
    this.cover += (this.coverT - this.cover) * (1 - Math.exp(-dt / 0.45));
    this.back += (this.backT - this.back) * (1 - Math.exp(-dt / 0.45));
    this.windBend += (this.windBendT - this.windBend) * (1 - Math.exp(-dt / 0.35));
    this.flowBoost += (this.flowBoostT - this.flowBoost) * (1 - Math.exp(-dt / 0.40));
    // 風影(ブランケット)に入った際に素早く明確に風速低下＆ヘダーが効くよう調整
    w.f = clamp(w.f * (1 - 0.42 * Math.pow(this.cover, 1.15) + this.flowBoost), 0.40, 1.45);
    w.from = wrap(w.from + this.tack * this.windBend);
    this.windFrom = w.from; this.windF = w.f;
    let steer = this.steer;
    let rollCmd = 0; // +は風下へオーバーヒール(上す/タック導入)、-は風上へアンヒール(落とす/ジャイブ導入)
    if (this.maneuver) {
      const m = this.maneuver; m.t += dt;
      const relNow = wrap(w.from - this.h);
      const err = wrap(m.relNew - relNow);
      if (m.kind === 'tack') {
        const crossed = relNow * m.s0 < 0;
        const absRel = Math.abs(relNow);
        // ロールタックの3段階ヒール挙動:
        // 1) ラフ開始時: 風下へオーバーヒール(+s0)をかけてウェザーヘルムを作る
        // 2) 風軸(0°)を超える直前(absRel < 0.38): オーバーヒールを起こしてアンヒール(-s0)させる
        // 3) 風軸を超えた後(crossed): タック後の重心移動で新タックから見てオーバーヒール(-s0 = +newTack)を起こし、その後フラットに起こす
        if (!crossed) {
          if (m.t < 0.28 || absRel > 0.38) {
            rollCmd = m.s0 * 0.30;
            steer = m.dir * clamp(m.t / 0.28, 0.28, 1.0);
          } else {
            const unheelF = clamp((0.38 - absRel) / 0.28, 0, 1);
            rollCmd = m.s0 * (0.21 * (1 - unheelF) - 0.25 * unheelF);
            steer = m.dir;
          }
        } else {
          m.tCross = (m.tCross || 0) + dt;
          if (m.tCross < 0.78) {
            rollCmd = -m.s0 * 0.38 * Math.sin(clamp(m.tCross / 0.78, 0.15, 1) * Math.PI * 0.82);
          } else {
            rollCmd = -m.s0 * 0.31 * Math.max(0, 1 - (m.tCross - 0.78) / 0.68);
          }
          steer = -clamp(err * 2.5, -1, 1);
          if (Math.abs(steer) < 0.5) steer = -0.5 * Math.sign(err || 1);
        }
        if ((crossed && Math.abs(err) < 0.07) || m.t > 9) { this.maneuver = null; steer = 0; }
      } else {
        // ジャイブ時は最初にアンヒール(風上側へ傾ける)をかけてリーヘルムを作ってから落とし、
        // セールが出ているため180°ではなく160°〜200°(新タック側160°〜168°)でセールを返す
        const crossed160 = relNow * m.s0 < 0 && Math.abs(relNow) <= (168 * Math.PI) / 180;
        if (crossed160 && !m.flipped) {
          m.flipped = true;
          // セールが返った直後(0.36秒後)にランチャーを自動で再アップし、ランチャーダウン音→セール返し音→ランチャーアップ音が明確に鳴るようにする
          if (m.restorePole && !this.penalty) { this.gybePoleRestore = 0.36; m.restorePole = false; }
        }
        if (m.t < 0.38) {
          rollCmd = -m.s0 * 0.22; // アンヒール(風上側へ起こす/逆ヒール)をかけてから落とす
          steer = m.dir * clamp(m.t / 0.34, 0.22, 0.95);
        } else if (!m.flipped) {
          rollCmd = -m.s0 * 0.15;
          steer = m.dir * 0.92;
        } else {
          rollCmd = 0;
          steer = -clamp(err * 2.4, -1, 1);
        }
        if ((m.flipped && Math.abs(err) < 0.08) || m.t > 8) {
          if (m.restorePole && !this.penalty && Math.abs(relNow) >= POLE_MIN) { this.gybePoleRestore = 0.22; m.restorePole = false; }
          this.maneuver = null; steer = 0;
        }
      }
    } else if (!this.penalty) {
      // 通常操舵時: 急激に上す際にはオーバーヒール → 風軸直前はアンヒール → タック直後は新タック側オーバーヒール、落とす際にはアンヒール
      const turnUp = steer * this.tack; // +ならラフ(上す)、-ならベア(落とす)
      const absRelNow = Math.abs(wrap(w.from - this.h));
      if (this.tacking && this.tackTimer > 0.50) {
        const tc = 1.8 - this.tackTimer;
        rollCmd = this.tack * 0.36 * Math.sin(clamp(tc / 1.30, 0, 1) * Math.PI);
      } else if (turnUp > 0.18) {
        if (absRelNow < 0.36) {
          rollCmd = -this.tack * clamp((0.36 - absRelNow) * 0.58, 0, 0.23);
        } else {
          rollCmd = this.tack * clamp((turnUp - 0.15) * 0.32, 0, 0.26);
        }
      } else if (turnUp < -0.18) {
        rollCmd = -this.tack * clamp((-turnUp - 0.15) * 0.29, 0, 0.24);
      }
    }
    this.rollBias += (rollCmd - this.rollBias) * (1 - Math.exp(-dt * 7.5));
    // ジャイブ後のランチャー自動再アップタイマー処理
    if (this.gybePoleRestore > 0) {
      this.gybePoleRestore -= dt;
      if (this.gybePoleRestore <= 0) {
        this.gybePoleRestore = 0;
        if (!this.penalty && Math.abs(wrap(w.from - this.h)) >= POLE_MIN - 0.15) this.pole = true;
      }
    }
    // ランチャー展開/収納(数秒かかる)。上げている間は POLE_MIN より風上へは切れ上がらない
    this.poleK = clamp(this.poleK + (this.pole ? dt / 1.6 : -dt / 0.9), 0, 1);
    if (this.pole && !this.maneuver && !this.penalty) {
      const relP = wrap(w.from - this.h), up = Math.sign(relP) || 1; // steer*up>0 ならラフアップ
      const twaP = Math.abs(relP);
      if (twaP < POLE_MIN && steer * up > 0) steer = 0;
      if (twaP < POLE_MIN - 0.12) steer = -up * 0.6; // 風の振れで上り過ぎたら自動で落とす
    }
    const rateMax = 0.85 * (0.35 + 0.65 * clamp(Math.abs(this.v) / 2.5, 0, 1));
    // オーバーヒール時はウェザーヘルムで上りやすく、アンヒール時はリーヘルムで落ちやすくなる回頭モーメント補助
    const rollTurnBoost = this.rollBias * this.tack > 0.02 && steer * this.tack > 0 ? 1.12
      : this.rollBias * this.tack < -0.02 && steer * this.tack < 0 ? 1.12 : 1.0;
    const dh = steer * rateMax * rollTurnBoost * dt;
    // リーバウや別タック艇スターン通過のリフト(windBend > 0)を受けた際、クローズ走行中なら船首が自然に少し風上へのぼせる(効果1/3)
    this.aeroClimb = 0;
    if (this.windBend > 0.008 && !this.maneuver && !this.tacking && !this.penalty && this.twa > (40.2 * Math.PI) / 180 && this.twa < 1.22) {
      this.aeroClimb = this.tack * this.windBend * 0.20 * dt;
    }
    this.h = wrap(this.h + dh + this.aeroClimb);
    this.turned += Math.abs(dh);
    // 急激に角度を変えたりタック・ジャイブした際のラダー抵抗(乱流・白泡発生度 0..1: 控えめに調整)
    const turnRate = Math.abs(dh) / Math.max(dt, 1e-4);
    const steerEffort = Math.max(Math.abs(steer), clamp(turnRate / 0.58, 0, 1));
    const speedF = clamp(Math.abs(this.v) / 1.25, 0.18, 1.15);
    const rudderTarget = steerEffort > 0.34
      ? clamp((Math.pow((steerEffort - 0.30) / 0.70, 1.35) * 0.52 + (this.maneuver ? 0.20 : 0)) * speedF, 0, 0.60)
      : 0;
    this.rudderDrag += (rudderTarget - this.rudderDrag) * (1 - Math.exp(-dt * (rudderTarget > this.rudderDrag ? 7.5 : 3.8)));
    if (this.penalty) {
      this.penalty.turned += Math.abs(dh);
      // 他艇が2艇身(約9.5m)以内にいる間は「クリアウオーター確保中」としてタイマー減少を0.25倍に緩和、回頭中も0.2倍に緩和
      let clearWater = true;
      if (boats) {
        for (const o of boats) {
          if (o !== this && !o.finished && !o.dsq && Math.hypot(o.x - this.x, o.z - this.z) < BOAT_LEN * 2) {
            clearWater = false;
            break;
          }
        }
      }
      this.penalty.clearWater = clearWater;
      const activelyTurning = Math.abs(steer) > 0.45 || this.maneuver !== null;
      const decayRate = !clearWater ? 0.25 : activelyTurning ? 0.2 : 1.0;
      this.penalty.timer = Math.max(0, this.penalty.timer - dt * decayRate);
      if (this.penalty.turned >= this.penalty.reqRad) {
        this.penalty = null;
        this.penaltyDone = true;
      } else if (this.penalty.timer <= 0) {
        if (this.penalty.reqDeg === 360 && !this.penalty.upgraded) {
          // 1回転(360°)ペナルティを時間内に消化しなかった場合は720°(2回転)へ格上げ
          this.penalty.reqDeg = 720;
          this.penalty.reqRad = 4 * Math.PI * 0.96;
          this.penalty.timer = 20.0;
          this.penalty.upgraded = true;
          this.penaltyUpgraded = this.penalty.rule;
        } else {
          const r = this.penalty.rule;
          const deg = this.penalty.reqDeg;
          this.penalty = null;
          this.dsq = true;
          this.dsqReason = `ルール${r}違反・${deg}°ペナルティ未履行(RRS 44.2)`;
          this.penaltyExpired = r;
        }
      }
    }
    const rel = wrap(w.from - this.h);
    const twa = Math.abs(rel);
    const rawSign = rel >= 0 ? 1 : -1;
    // タックとジャイブの切り替わり判定:
    // ・風上(twa < 90°)は 0°(風位)をまたいだ瞬間にタック
    // ・風下(ランニング)はセールが外へ出ているため180°ちょうどでは返らず、
    //   180°〜200°の間はバイザリー(旧タック維持)となり、200°(反対舷160°)に達した時またはジャイブ操作で168°まで回った時にセールが返る
    const GYBE_LIMIT_RAD = (160 * Math.PI) / 180; // 反対舷160° = 旧タックから見て200°
    const gybeManThresh = this.maneuver && this.maneuver.kind === 'gybe' ? (168 * Math.PI) / 180 : GYBE_LIMIT_RAD;
    if (rawSign !== this.tack) {
      if (twa < Math.PI / 2) {
        this.tacking = true;
        this.tackTimer = 1.8;
        this.tack = rawSign;
        if (t >= 0 && !this.finished && !this.dsq && !this.penalty) this.tackCount++;
      } else if (twa <= gybeManThresh) {
        this.v *= 0.92;
        this.tack = rawSign;
        if (this.pole) {
          // ジャイブ時(手動ジャイブ含む)も一旦ランチャーを下ろしてダウン音を鳴らし、直後(0.42秒後)に反対舷へ自動再アップしてアップ音を鳴らす
          this.pole = false;
          this.poleK = Math.min(this.poleK, 0.22);
          if (!this.maneuver && !this.penalty) this.gybePoleRestore = 0.42;
        }
        if (t >= 0 && !this.finished && !this.dsq && !this.penalty) this.gybeCount++;
      }
    }
    if (this.tacking) {
      this.tackTimer -= dt;
      if (twa <= (10.5 * Math.PI) / 180 && !(this.maneuver && this.maneuver.kind === 'tack') && Math.abs(steer) < 0.35) {
        this.tacking = false;
      } else if (twa > 0.72 || this.tackTimer <= 0) {
        if (twa > 0.68) this.tacking = false;
        else if (this.tackTimer < -1.8) this.tacking = false;
      }
    }
    this.rel = rel; this.twa = twa;
    // バイザリー判定: 風下走行中に風向が真後ろ(180°)を越えてブームと同じ側から吹いている状態(180°〜200°)
    const isByTheLee = rawSign !== this.tack && twa >= Math.PI / 2;
    const rawTwaDeg = (twa * 180) / Math.PI;
    const effTwaDeg = isByTheLee ? 360 - rawTwaDeg : rawTwaDeg; // バイザリー時は 180°〜200°
    this.effTwaDeg = effTwaDeg;
    this.byTheLee = isByTheLee ? clamp((effTwaDeg - 180) / 20, 0, 1) : 0;

    // トリム評価(オーバー/アンダー)とラフ・ストール (38°〜39°ではシバーせず、37°未満でシバーし始める)
    const localWindKt = BASE_WIND_KT * w.f;
    const optCloseDeg = bestCloseDeg(localWindKt);
    this.bestCloseDeg = optCloseDeg;
    const so = sheetOpt(twa); this.sOpt = so;
    const d = this.sheet - so;
    const pinchDeg = clamp(optCloseDeg - 6.0, 33.5, 37.0); // 38°・39°でもシバーせず走れるようシバー開始角を2°低く設定
    const PINCH = (pinchDeg * Math.PI) / 180;
    const pinch = twa < PINCH ? clamp((PINCH - twa) * 3.8, 0, 1) : 0;
    this.luff = clamp(Math.max(Math.max(0, -d - 0.05) * 3.2, pinch * 0.9), 0, 1);
    this.stall = clamp((d - 0.1) * 3.5, 0, 1);
    const eff = clamp(1 - Math.max(0, -d - 0.06) * 1.45 - Math.max(0, d - 0.1) * 0.9, 0.12, 1);
    // 見かけ風
    const Vw = localWindKt * KT * SPEED_SCALE;
    const ax = -Math.sin(w.from) * Vw - Math.sin(this.h) * this.v, az = Math.cos(w.from) * Vw + Math.cos(this.h) * this.v;
    const al = Math.hypot(ax, az) || 1e-6;
    this.awx = ax / al; this.awz = az / al; this.aws = al;
    this.awa = wrap(Math.atan2(-ax, az) - this.h);
    const twaDeg = rawTwaDeg;
    const turning = this.tacking || (this.maneuver && this.maneuver.kind === 'tack');
    // タック回頭中は惰性が残るため減速を大幅に抑える
    const rawPolarV = polar(twaDeg, localWindKt) * SPEED_SCALE;
    let polarV = turning ? Math.max(rawPolarV, V45_CLOSE * SPEED_SCALE * 0.74) : rawPolarV;
    // リーチング(58°〜135°)でのぼした(ラフした)際、見かけ風速(AWS)の増加とスロット効果で艇速が一段伸びる実艇の特性
    if (twaDeg >= 58 && twaDeg <= 135 && !this.pole) {
      const reachSlot = Math.sin(((clamp(twaDeg, 60, 115) - 60) / 55) * Math.PI); // 60°〜115°(ピーク約85°付近)
      const isLuffingUp = steer * this.tack < -0.02 ? clamp(-steer * this.tack, 0, 0.8) : 0;
      const reachBoost = 1 + 0.045 * reachSlot + 0.038 * isLuffingUp * smoothstep(65, 130, twaDeg);
      polarV *= reachBoost;
    }
    // 180°近く〜180°を超えてバイザリー(180°〜200°)に入った際はメインセールがジブを隠し気流が剥離して艇速が大きく落ちる
    if (effTwaDeg > 176) {
      const over180 = Math.max(0, effTwaDeg - 180);
      const near180 = clamp((effTwaDeg - 176) / 4, 0, 1);
      const byLeePenalty = 0.10 * near180 + 0.26 * clamp(over180 / 18, 0, 1); // 180°超で最大約36%減速
      polarV *= (1 - byLeePenalty);
    }
    // ランチャー: 下レグ(深い角度)でジブが開き、センターボード引き上げ(抵抗減)＆フォアステイ緩和で速くなる。リーチより上では逆効果
    const poleF = 1 + this.poleK * (0.072 * smoothstep(1.80, 2.55, twa) - 0.35 * clamp(POLE_MIN + 0.1 - twa, 0, 1));
    const steerDrag = (twaDeg >= 58 && twaDeg <= 135 && steer * this.tack < 0) ? 0.06 : 0.18; // リーチングでのぼす舵は失速しにくい
    let target = polarV * Math.pow(w.f, 0.8) * this.skill * eff * poleF * (1 - (turning ? 0.022 : steerDrag) * Math.abs(steer)) * this.throttle;
    // 波: 艇速がない時はしっかり波にはたかれ、艇速がある時や下レグでは気にならない程度に抑える
    {
      const ws = waveSample(this.x, this.z, t, Math.sin(this.h), -Math.cos(this.h));
      this.waveH = ws.h; this.waveSlope = ws.slope;
      const Hn = SEA.H / 0.5;
      const climb = clamp(ws.slope / SEA.maxSlope, -1, 1);
      const speedNorm = clamp(Math.abs(this.v) / (1.85 * SPEED_SCALE), 0, 1);
      const slowFactor = Math.pow(1 - speedNorm, 1.35); // 艇速がない時は 1.0 (大きくはたかれる)、艇速が出ると急速に小さくなる
      const downFactor = smoothstep(1.05, 1.70, twa);   // 下レグ・リーチングでは 1.0
      const upw = 1 - downFactor;
      const down = smoothstep(1.15, 1.9, twa);
      const poundScale = (0.35 + 1.15 * slowFactor) * (1 - 0.72 * downFactor * speedNorm);
      let wf = 1 - upw * 0.15 * Hn * SEA.steep * (0.58 + 0.98 * Math.max(0, climb)) * poundScale;
      if (turning) wf -= 0.11 * Hn * SEA.steep * (0.58 + 0.58 * slowFactor); // 波の中でのタック・低速回頭は行き足が止まりやすい
      const windOk = clamp((localWindKt - 5.5) / 6, 0, 1);
      wf += down * SEA.surf * Math.max(0, -climb) * (0.35 + 0.75 * windOk) * clamp(this.v / (2.1 * SPEED_SCALE), 0.3, 1.08);
      if (SEA.type === 'chop') wf -= down * 0.040 * Hn * (0.5 + 0.5 * Math.abs(climb)) * slowFactor;
      this.waveF = wf;
      this.waveLoss = Math.max(0, 1 - wf);
      target *= wf;
      // 波にはたかれた際の水面叩きつけイベント(海に船がたたきつけられる控えめな音 & 適度にしぶきが上がる演出用)
      this.waveSlamCD = Math.max(0, (this.waveSlamCD || 0) - dt);
      const prevClimb = this._prevClimb || 0;
      this._prevClimb = climb;
      if (this.waveSlamCD <= 0 && Math.abs(this.v) > 0.35) {
        const drop = prevClimb - climb;
        if ((prevClimb > 0.21 && drop > 0.15) || (climb > 0.48 && prevClimb <= 0.48)) {
          const steepScale = clamp(SEA.steep / 0.85, 0.55, 1.15);
          const slam = clamp((drop * 0.90 + Math.max(0, climb) * 0.52) * steepScale * (0.45 + 0.75 * slowFactor) * (1 - 0.68 * downFactor * speedNorm), 0, 1);
          if (slam > 0.18) {
            this.visualSlam = Math.max(this.visualSlam || 0, slam);
            if (slam > 0.21) this.waveSlam = slam;
            this.waveSlamCD = 1.6 + Math.random() * 1.2;
          }
        }
      }
    }
    // 他艇の引き波(ケルビンV字波・航跡波)を通過した際のわずかな揺れと艇速への影響
    {
      let wakeHit = 0;
      if (boats) {
        for (const o of boats) {
          if (o === this || o.finished || o.dsq || o.v < 0.65) continue;
          const dx = this.x - o.x, dz = this.z - o.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > 20 * 20) continue;
          const fx = Math.sin(o.h), fz = -Math.cos(o.h);
          const rx = Math.cos(o.h), rz = Math.sin(o.h);
          const behind = -(dx * fx + dz * fz) - 2.1;
          if (behind > 0.3 && behind < 17.5) {
            const lat = Math.abs(dx * rx + dz * rz);
            const vArm = 0.34 + behind * 0.35; // ケルビンV字引き波の広がり幅
            const armDist = Math.abs(lat - vArm);
            const armW = 0.72 + behind * 0.08;
            const centerW = 0.85 + behind * 0.11;
            const hitArm = Math.max(0, 1 - armDist / armW);
            const hitCenter = Math.max(0, 1 - lat / centerW) * 0.72;
            const hitF = Math.max(hitArm, hitCenter);
            if (hitF > 0) {
              const spdF = clamp(o.v / (2.1 * SPEED_SCALE), 0.25, 1.1) * (1 - behind / 17.5);
              wakeHit = Math.max(wakeHit, hitF * spdF);
            }
          }
        }
      }
      this.wakeWave += (wakeHit - (this.wakeWave || 0)) * (1 - Math.exp(-dt * 8.0));
      if (this.wakeWave > 0.04) {
        target *= (1 - 0.042 * this.wakeWave);
        this.rollBias += Math.sin(t * 9.2 + this.id * 1.7) * 0.026 * this.wakeWave * (1 - Math.exp(-dt * 8.0));
      }
    }
    // 風上(真風角 ±10°以内)に向くと風圧でバック(後退)する
    if (twaDeg <= 10.5 && !turning) {
      const irons = clamp(0.46 + ((10.5 - twaDeg) / 10.5) * 0.54, 0.46, 1.0); // ±10°以内は確実にバックし、0°で最大1.0
      target = -irons * 0.48 * SPEED_SCALE * w.f;
    }
    const tau = (twaDeg <= 10.5 && !turning) ? (this.v > 0 ? 1.25 : 1.05) : target > this.v ? (this.tacking ? 1.5 : 2.2) : turning ? 8.5 : 1.5; // ±10°では速やかに失速してバックへ遷移
    this.v += (target - this.v) * (1 - Math.exp(-dt / tau));

    // 風下側への流され(リーウェイ＆風圧ドリフト) ＋ 潮の満ち引きによる潮流(TIDE)の影響:
    // スタート時など船が止まっている・極微速時の下流れを従来のさらに2倍(計3倍)に設定し、一定の速度が出るとセンターボードが効いて流されなくなる
    // また、リアルタイムの潮の流れ(八景島沖・江の島沖の上げ潮/下げ潮)もスタート時や微風時に若干反映される
    const vCut = 1.35 * KT * SPEED_SCALE;
    const slowF = Math.pow(clamp(1 - Math.abs(this.v) / vCut, 0, 1), 1.3);
    const leewayV = 0.60 * slowF * SPEED_SCALE * w.f * Math.sin(twa); // 艇の風下横方向への下流れ(低速時2倍)
    const windageV = 0.36 * slowF * SPEED_SCALE * w.f;                // 風下方向への吹き流され(低速時2倍)
    // リーバウ・スターン通過リフト時はセンターボードの揚力で風上側へわずかにせり上がる(効果1/3)
    const nt = this.tack;
    const liftLatV = this.windBend > 0.008 && this.v > vCut ? this.windBend * 0.38 * SPEED_SCALE : 0;
    const leeX = -nt * Math.cos(this.h) * (leewayV - liftLatV) - Math.sin(w.from) * windageV;
    const leeZ = -nt * Math.sin(this.h) * (leewayV - liftLatV) + Math.cos(w.from) * windageV;

    // 潮流ドリフト: スタート時(低速時 slowF)や微風時ほど潮の流れの影響を若干受ける実艇の挙動
    const lightWindF = clamp((10.5 - localWindKt) / 5.5, 0.35, 1.15);
    const tideWeight = TIDE.active !== false ? (0.18 + 0.28 * slowF) * lightWindF : 0;
    const tideX = (TIDE.vx || 0) * tideWeight;
    const tideZ = (TIDE.vz || 0) * tideWeight;

    this.x += (Math.sin(this.h) * this.v + leeX + tideX) * dt;
    this.z += (-Math.cos(this.h) * this.v + leeZ + tideZ) * dt;

    // 風の強さ(localWindKt)と風角(twa)・シート引き量に応じたヒール力と、クルーのハイクアウトによる復原力
    // ＋ タック/上す際のオーバーヒール、ジャイブ/落とす際のアンヒール(rollBias)を合成 (全体的に強風時・タック時のヒールをもう少しだけ大きめに設定)
    const anglePress = Math.sin(clamp(twa, 0.2, Math.PI * 0.88)) * (0.35 + 0.65 * this.sheet) * (1 - 0.65 * smoothstep(1.85, 2.75, twa)) * (1 - 0.55 * this.luff);
    const windPress = Math.pow(clamp(localWindKt / 8.8, 0.25, 1.95), 1.32);
    const speedPress = 0.35 + 0.65 * clamp(Math.abs(this.v) / 1.8, 0, 1);
    const rawHeelPress = anglePress * windPress * speedPress;
    const strongWindBoost = smoothstep(8.2, 13.5, localWindKt) * 0.42 * anglePress;
    const puffBoost = clamp((w.puff - 0.24) / 0.76, 0, 1);
    const targetHike = twa > 2.45 ? 0.05 : clamp(rawHeelPress * 1.28 + Math.abs(this.heel) * 1.45 + strongWindBoost, 0.05, 1.38);
    this.hike += (targetHike - this.hike) * (1 - Math.exp(-dt * 2.5));
    // ブロー(w.puff)や強風時はヒールがもう少し大きめに入るように調整
    const puffHeelAdd = puffBoost * 0.112 * anglePress;
    const netHeel = Math.max(0.016, rawHeelPress * 0.305 + strongWindBoost * 0.22 + puffHeelAdd - this.hike * 0.132);
    const heelT = clamp(nt * clamp(netHeel, 0, 0.34) + this.rollBias, -0.44, 0.44);
    this.heel += (heelT - this.heel) * (1 - Math.exp(-dt * 5.8));
    this.contactCD = Math.max(0, this.contactCD - dt);
    this.touchCD = Math.max(0, this.touchCD - dt);
    this.snagCD = Math.max(0, (this.snagCD || 0) - dt);
  }
}

// 障害物(マーク・委員会艇)のワールド座標円
export const OBSTACLES = [];
export function rebuildObstacles() {
  OBSTACLES.length = 0;
  // マークの当たり判定は水線位置のブイの太さ(半径約1.3m)に合わせる (上マークフィニッシュ時は1マークのみ)
  const markKeys = COURSE_MODE === 'upwind' ? ['m1'] : ['m1', 'm1a', 'm2', 'm3', 'gL', 'gR', 'fm'];
  for (const k of markKeys) { const p = toWorld(MARKS[k].a, MARKS[k].c); OBSTACLES.push({ key: k, x: p.x, z: p.z, r: 1.35 }); }
  // 艇型障害物: 船首を風上に向けてアンカー(長軸 = a軸)。本部船・アウター・フィニッシュ艇と船首アンカーロープのコンパクトな当たり判定
  for (const [k, sp, n, r, gap] of [['com', MARKS.com, 3, 1.65, 3.3], ['pin', MARKS.pin, 2, 1.45, 3.1], ['com', MARKS.fcom, 2, 1.45, 3.1]]) {
    for (let i = -(n - 1) / 2; i <= (n - 1) / 2; i++) { const p = toWorld(sp.a + i * gap, sp.c); OBSTACLES.push({ key: k, x: p.x, z: p.z, r }); }
  }
  // アンカーロープ判定: 普通の船の当たり判定と同じ仕組みで、船首すぐ前にごく小さな円(r=0.58m)として配置
  for (const [k, sp, aOff] of [['pin', MARKS.pin, 2.5], ['com', MARKS.com, 3.8]]) {
    const p = toWorld(sp.a + aOff, sp.c);
    OBSTACLES.push({ key: k, x: p.x, z: p.z, r: 0.58 });
  }
}
rebuildObstacles();

function circles(b) {
  const dx = Math.sin(b.h), dz = -Math.cos(b.h);
  return [{ x: b.x + dx * 1.2, z: b.z + dz * 1.2 }, { x: b.x - dx * 1.2, z: b.z - dz * 1.2 }];
}
const CR = 0.88;

// 衝突処理。イベントを返す。
export function resolveCollisions(boats, t) {
  const ev = [];
  for (let i = 0; i < boats.length; i++) {
    const A = boats[i];
    const ca = circles(A);
    for (let j = i + 1; j < boats.length; j++) {
      const B = boats[j];
      const ddx = B.x - A.x, ddz = B.z - A.z;
      if (ddx * ddx + ddz * ddz > 100) continue;
      const cb = circles(B);
      let hit = false, nx = 0, nz = 0, pen = 0;
      for (const p of ca) for (const q of cb) {
        const dx = q.x - p.x, dz = q.z - p.z;
        const d = Math.hypot(dx, dz) || 0.001;
        const pp = 2 * CR - d;
        if (pp > pen) { pen = pp; nx = dx / d; nz = dz / d; hit = true; }
      }
      if (!hit) continue;
      A.x -= nx * pen * 0.5; A.z -= nz * pen * 0.5;
      B.x += nx * pen * 0.5; B.z += nz * pen * 0.5;
      A.v *= 0.99; B.v *= 0.99;
      if (A.contactCD <= 0 && B.contactCD <= 0 && !A.finished && !B.finished) {
        const r = giveWayBoat(A, B, OBSTACLES);
        A.contactCD = 3; B.contactCD = 3;
        const vxA = Math.sin(A.h) * A.v, vzA = -Math.cos(A.h) * A.v;
        const vxB = Math.sin(B.h) * B.v, vzB = -Math.cos(B.h) * B.v;
        const relV = Math.hypot(vxA - vxB, vzA - vzB);
        const maxV = Math.max(Math.abs(A.v), Math.abs(B.v));
        const impact = clamp((maxV * 0.55 + relV * 0.45) / (2.15 * SPEED_SCALE), 0.08, 1.25);
        ev.push({ type: 'contact', gw: r.gw, row: r.gw === A ? B : A, rule: r.rule, text: r.text, impact });
      }
    }
    for (const o of OBSTACLES) {
      for (const p of ca) {
        const dx = p.x - o.x, dz = p.z - o.z;
        const d = Math.hypot(dx, dz) || 0.001;
        const pp = o.r + CR - d;
        if (pp > 0) {
          const preV = Math.abs(A.v);
          A.x += (dx / d) * pp; A.z += (dz / d) * pp; A.v *= 0.97;
          if (A.touchCD <= 0 && !A.finished) {
            A.touchCD = 6;
            const impact = clamp(preV / (2.10 * SPEED_SCALE), 0.10, 1.20);
            ev.push({ type: 'touch', boat: A, mark: o.key, impact });
          }
        }
      }
    }
  }
  return ev;
}

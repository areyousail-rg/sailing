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
export const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// ランチャー(ウィスカーポール): 上げている間はこの真風角より風上には向けない
export const POLE_MIN = (100 * Math.PI) / 180;

// スナイプ級の実態に即した風域別ベストクローズ角度(TWA deg)
// ・軽風(〜5.5kt): 艇速が低くセンターボードの揚力を得るためフッティング重視で 45° がベスト
// ・中風(9kt前後): パワーと揚力のバランスが最適となり 40° がベスト
// ・強風(13.5kt〜): ハルスピードに達しやすくデパワー・フェザリングで上れるため 38° がベスト
export function bestCloseDeg(windKt = BASE_WIND_KT) {
  if (windKt <= 5.5) return 45.0;
  if (windKt <= 9.0) return 45.0 - ((windKt - 5.5) / 3.5) * 5.0;   // 5.5kt:45° → 9.0kt:40°
  if (windKt <= 13.5) return 40.0 - ((windKt - 9.0) / 4.5) * 2.0;  // 9.0kt:40° → 13.5kt:38°
  return 38.0;
}

// スナイプ級のポーラー(TWA deg, windKt → m/s @ 基準9kt換算)
// 35°〜45°のクローズ帯では V(θ)*cos(θ) ≈ 一定 をベースとし、目標への到達時間に大差がつかないようにしつつ、
// 風域ごとのベスト角(強風38°・中風40°・軽風45°)でVMGが最大になり、軽風時の35°〜37°ピンチングは失速しやすくなる特性を再現
const V45_CLOSE = 2.10;
const VMG_CLOSE = V45_CLOSE * Math.cos((45 * Math.PI) / 180); // ≈ 1.4849 m/s
const V35_BASE = VMG_CLOSE / Math.cos((35 * Math.PI) / 180);  // ≈ 1.8127 m/s
const POLAR = [
  [0, 0],
  [20, 0],
  [26, 0.82],
  [31, 1.38],
  [35, V35_BASE],
  [45, V45_CLOSE],
  [48, 2.26],
  [60, 2.85],
  [75, 3.3],
  [90, 3.55],
  [110, 3.6],
  [130, 3.4],
  [150, 3.0],
  [160, 2.84],
  [170, 2.9],
  [180, 2.45],
];

export function polar(deg, windKt = BASE_WIND_KT) {
  if (deg >= 35 && deg <= 45) {
    const opt = bestCloseDeg(windKt);
    const vIso = VMG_CLOSE / Math.cos((deg * Math.PI) / 180);
    // ベスト角度(opt)でわずかにピーク(+1.5%)を持ちつつ、35°〜45°全体ではVMG差をごく小さく保つ
    const diff = deg - opt;
    let vmgFactor = 1.015 - 0.00045 * diff * diff;
    // 軽風〜微風(8.5kt未満)でベスト角より上りすぎた場合(特に35°〜37°付近)はセンターボードのストールで艇速が落ちる
    if (deg < opt) {
      const lightNess = clamp((9.0 - windKt) / 3.8, 0, 1); // 9ktで0、5.2kt以下で1
      const pinchDeg = opt - deg;
      // 中〜強風では35°でもほとんど減速せず(95%以上維持)、軽風で36°以下に上るときつくなる(約14〜18%減速、ただし止まらない)
      const pinchLoss = pinchDeg * pinchDeg * (0.0007 + 0.0020 * lightNess);
      vmgFactor -= pinchLoss;
    }
    return vIso * clamp(vmgFactor, 0.80, 1.02);
  }
  if (deg > 20 && deg < 35) {
    // 35°での実効速度に滑らかに接続し、35°付近で急激に止まらないようにする
    const v35 = polar(35, windKt);
    if (deg >= 31) return 1.38 + ((deg - 31) / 4) * (v35 - 1.38);
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
    H = clamp(0.16 + 0.026 * kt, 0.22, 0.65);
    add(H * 0.30, 7.0, from, 0.0);
    add(H * 0.24, 6.0, from + 52 * R, 1.9); // 岸壁からの反射波が斜めに交差
    add(H * 0.20, 5.2, from - 47 * R, 4.1);
    add(H * 0.10, 11.0, from + 8 * R, 2.6);
    Object.assign(SEA, { steep: 1.0, surf: 0.06 });
  } else if (venue === 'enoshima' && south) {
    type = 'swell'; label = '長周期のうねり(南風・相模湾)';
    H = clamp(0.55 + 0.035 * kt, 0.6, 1.4);
    add(H * 0.36, 96, 205 * R, 0.0, true); // 南南西からの外洋うねり(周期約8秒)
    add(H * 0.14, 64, 190 * R, 2.2, true);
    add(0.05 + 0.008 * kt, 9.0, from, 1.1);  // うねりに乗る風浪
    add(0.035 + 0.006 * kt, 6.5, from + 25 * R, 3.7);
    Object.assign(SEA, { steep: 0.32, surf: 0.30 });
  } else if (venue === 'enoshima' && north) {
    type = 'short'; label = '周期の短い風浪(北風・陸からの吹き出し)';
    H = clamp(0.14 + 0.028 * kt, 0.2, 0.7);
    add(H * 0.34, 10.0, from, 0.0);
    add(H * 0.24, 8.0, from + 18 * R, 2.3);
    add(H * 0.16, 13.0, from - 14 * R, 4.4);
    add(H * 0.08, 5.5, from + 40 * R, 1.2);
    Object.assign(SEA, { steep: 0.75, surf: 0.14 });
  } else {
    type = 'mixed'; label = '風浪';
    H = clamp(0.15 + 0.025 * kt, 0.2, 0.6);
    add(H * 0.32, 11.0, from, 0.0);
    add(H * 0.22, 8.5, from + 22 * R, 2.0);
    add(H * 0.16, 30, from - 12 * R, 4.0, true);
    add(H * 0.08, 6.0, from - 35 * R, 1.3);
    Object.assign(SEA, { steep: 0.55, surf: 0.14 });
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
const SHADOW_LEN = 34; // ディンギーの風影影響圏(約7艇身: マスト高約6mの約5〜6倍に相当する実戦的なブランケット距離)
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
    // セール後流(ブランケット)の3つの軸:
    // ① 見かけ風(Apparent Wind)軸: 高速走行時の直接の風影コア
    // ② 混合ウェイク軸 + リーチ排気偏向(Upwindではセールリーチから風下後方へ曲げられた悪風・ダーティエアーが流れる)
    // ③ 真風(True Wind)軸: 水面付近に残류する乱流渦の流下方向
    const twx = -Math.sin(A.windFrom), twz = Math.cos(A.windFrom);
    const leechDeflect = A.twa < 1.75 ? 0.18 * (1 - A.luff * 0.7) : 0; // クローズ〜リーチではリーチから後方(-fx,-fz)へも排気される
    let mx = A.awx * 0.65 + twx * 0.35 - fx * leechDeflect;
    let mz = A.awz * 0.65 + twz * 0.35 - fz * leechDeflect;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;

    // ランチャー展開時やアビーム〜ランニングではセールの投影面積が大きく風影も長く広がる
    const maxLen = SHADOW_LEN + (A.poleK || 0) * 5.0;
    const sailProj = 1.95 + 0.72 * Math.sin(clamp(A.twa, 0.35, 2.85)) + 0.62 * (A.poleK || 0);

    for (const B of boats) {
      if (A === B || B.dsq) continue;
      const rx = B.x - A.x, rz = B.z - A.z;
      const dist2 = rx * rx + rz * rz;
      if (dist2 > (maxLen + 6) * (maxLen + 6)) continue;

      // 1) ブランケット(風影コーン): 見かけ風軸・混合リーチ排気軸・真風軸の扇状セクター全域を評価し、抜け穴のない確実なブランケット判定を行う
      let bestS = 0;
      const axes = [
        [mx, mz, 1.0],
        [A.awx, A.awz, 0.96],
        [twx, twz, 0.92],
      ];
      for (let k = 0; k < 3; k++) {
        const ax = axes[k][0], az = axes[k][1], wgt = axes[k][2];
        const along = rx * ax + rz * az;
        if (along > 0.9 && along < maxLen) {
          const lat = Math.abs(-rx * az + rz * ax);
          const half = sailProj + along * 0.255;
          if (lat < half) {
            const normDist = clamp((along - 0.9) / (maxLen - 0.9), 0, 1);
            // 1〜3艇身(〜15m)では65〜100%の強いブランケット、4〜6艇身でも明確に効く距離減衰カーブ
            const distFactor = Math.pow(1 - Math.pow(normDist, 1.32), 1.35);
            const coreFactor = Math.exp(-Math.pow(lat / (half * 0.72), 2));
            const edgeFactor = Math.max(0, 1 - lat / half);
            const s = clamp(wgt * distFactor * (0.82 * coreFactor + 0.26 * edgeFactor), 0, 1.0);
            if (s > bestS) bestS = s;
          }
        }
      }
      if (bestS > 0.01) {
        B.coverT = clamp(B.coverT + bestS, 0, 1.0);
        // 風影内ではセール後流の乱れで風向がヘダー(頭を抑えられる悪風)になる
        if (B.twa < 1.65 && bestS > 0.12) {
          B.windBendT -= bestS * 0.052;
        }
      }

      // A艇基準のB艇相対位置 (ahead: Aの前方+, leeDist: Aの風下横方向+)
      const ahead = rx * fx + rz * fz;
      const leeDist = rx * lx + rz * lz;

      // 2) リーバウ効果(Lee-Bow / Safe Leeward):
      // クローズ〜クローズリーチで同タックの2艇において、B艇がA艇の風下側(leeDist: 1.2〜12.5m)かつ
      // ほぼ横〜斜め前方(ahead: -1.2〜11.0m)にいるとき:
      // ・風下艇BはA艇セールの循環によるアップウォッシュ(吹き上げ)とスロット効果で「少しのぼせる(リフト＋微増速)」
      // ・風上艇AはB艇セールリーチからのバックウィンド(排気)を浴びてヘダー＆ブランケット減速を強く受ける
      if (A.tack === B.tack && A.twa > 0.48 && A.twa < 1.42 && B.twa > 0.48 && B.twa < 1.42) {
        if (leeDist > 1.2 && leeDist < 12.5 && ahead > -1.2 && ahead < 11.0) {
          const kLee = Math.exp(-Math.pow((leeDist - 4.2) / 3.8, 2)) * Math.exp(-Math.pow((ahead - 2.8) / 4.2, 2));
          if (kLee > 0.06) {
            // 風下前方のB艇(リーバウ艇): 最大約4.5°のリフト + 約3.8%の流速ブーストでのぼせる
            const liftRad = 0.078 * kLee;
            if (liftRad > B.windBendT) {
              B.windBendT = Math.max(B.windBendT, liftRad);
              B.flowBoostT = Math.max(B.flowBoostT, 0.038 * kLee);
              if (kLee > 0.22) B.aeroTag = 'leebow';
            }
            // 風上後方のA艇(被リーバウ艇): バックウィンドによるヘダーとブランケット悪風
            if (ahead > -0.2) {
              const backK = kLee * smoothstep(-0.2, 2.0, ahead);
              A.windBendT -= 0.092 * backK;
              A.coverT = clamp(A.coverT + 0.65 * backK, 0, 1.0);
              A.backT = clamp(A.backT + 0.65 * backK, 0, 1.0);
              if (backK > 0.20 && !A.aeroTag) A.aeroTag = 'backwind';
            }
          }
        }
      }

      // 3) 別タック艇のスターン後方通過時のリフト(クローズで別タックの他艇の後ろを通過すると一瞬のぼせる):
      // B艇がクローズホールド(B.twa: 0.50〜1.25)で、別タックのA艇(A.tack !== B.tack)のスターン直後
      // (ahead: -16.5m〜-1.5m、横ズレ leeDist: -5.5m〜+9.5m)を横切る瞬間、
      // A艇のセールがスターン方向へ曲げた気流がB艇には「リフト(風が横から入る角度変化)」として作用し、一瞬のぼせる
      if (A.tack !== B.tack && B.twa > 0.50 && B.twa < 1.25 && A.twa > 0.50 && A.twa < 2.2) {
        const behindA = -ahead; // A艇の船尾から後方への距離
        if (behindA > 1.4 && behindA < 16.5 && leeDist > -5.5 && leeDist < 9.5) {
          const kBehind = Math.exp(-Math.pow((behindA - 5.8) / 4.5, 2));
          const kLat = Math.exp(-Math.pow((leeDist - 1.8) / 4.2, 2));
          const kDuck = kBehind * kLat;
          if (kDuck > 0.08) {
            // スターン直後を通過する瞬間、風影ペナルティを緩和しつつ最大約5.5°(0.096rad)のリフト＋微ガストを付与
            B.coverT *= (1 - 0.65 * kDuck);
            const sternLift = 0.096 * kDuck;
            if (sternLift > B.windBendT) {
              B.windBendT = sternLift;
              B.flowBoostT = Math.max(B.flowBoostT, 0.042 * kDuck);
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
    this.rel = 0; this.twa = 0; this.windFrom = W0; this.windF = 1;
    this.maneuver = null; this.penalty = null; this.penaltyDone = false; this.penaltyExpired = null; this.penaltyUpgraded = null;
    this.leg = 0; this.ocs = false; this.finished = false; this.finishTime = 0;
    this.a = undefined; this.c = 0; this.visit = null;
    this.contactCD = 0; this.touchCD = 0; this.heel = 0; this.hike = 0.15; this.turned = 0;
    this.sOpt = 1; this.luff = 0; this.stall = 0;
    this.cover = 0; this.coverT = 0; this.back = 0; this.backT = 0;
    this.waveF = 1; this.waveH = 0; this.waveSlope = 0; this.waveLoss = 0;
    this.windBend = 0; this.windBendT = 0;
    this.flowBoost = 0; this.flowBoostT = 0;
    this.aeroTag = ''; this.aeroClimb = 0;
    this.awa = 0; this.aws = 0; this.awx = -Math.sin(W0); this.awz = Math.cos(W0);
    this.dnf = false; this.dsq = false; this.dsqReason = '';
    this.pole = false; this.poleK = 0; // ランチャー(上げる指示 / 展開度0..1)
  }
  place(x, z, h) {
    this.x = x; this.z = z; this.h = h;
    const cp = toCourse(x, z); this.a = cp.a; this.c = cp.c;
    const w = windAt(x, z, -60);
    this.windFrom = w.from;
    const rel = wrap(w.from - h);
    this.rel = rel; this.twa = Math.abs(rel); this.tack = rel >= 0 ? 1 : -1;
  }
  // kind: 'tack'(風上側へ回頭) / 'gybe'(風下側へ回頭) / 未指定=自動
  startManeuver(kind) {
    if (this.maneuver) return false;
    const k = kind || (this.twa < Math.PI / 2 ? 'tack' : 'gybe');
    if (k === 'tack' && this.pole) return false; // ランチャーを上げたまま風上へは回れない
    if (k === 'gybe') this.pole = false; // ジャイブ時はランチャーを下ろす
    const s0 = Math.sign(this.rel) || 1;
    this.maneuver = { relNew: -this.rel, kind: k, s0, dir: k === 'tack' ? s0 : -s0, t: 0 };
    this.maneuverStarted = k;
    return true;
  }
  setPole(on) {
    if (on && (this.twa < POLE_MIN || this.maneuver || this.penalty)) return false;
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
    if (this.maneuver) {
      const m = this.maneuver; m.t += dt;
      const relNow = wrap(w.from - this.h);
      const crossed = relNow * m.s0 < 0;
      const err = wrap(m.relNew - relNow);
      if (!crossed) steer = m.dir;
      else { steer = -clamp(err * 2.5, -1, 1); if (Math.abs(steer) < 0.5) steer = -0.5 * Math.sign(err || 1); }
      if ((crossed && Math.abs(err) < 0.07) || m.t > 9) { this.maneuver = null; steer = 0; }
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
    const dh = steer * rateMax * dt;
    // リーバウや別タック艇スターン通過のリフト(windBend > 0)を受けた際、クローズ走行中なら船首が自然に少し風上へのぼせる
    this.aeroClimb = 0;
    if (this.windBend > 0.008 && !this.maneuver && !this.tacking && !this.penalty && this.twa > (40.2 * Math.PI) / 180 && this.twa < 1.22) {
      this.aeroClimb = this.tack * this.windBend * 0.58 * dt;
    }
    this.h = wrap(this.h + dh + this.aeroClimb);
    this.turned += Math.abs(dh);
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
    const nt = rel >= 0 ? 1 : -1;
    if (nt !== this.tack) {
      if (twa < Math.PI / 2) { this.tacking = true; this.tackTimer = 1.8; } else { this.v *= 0.93; }
      this.tack = nt;
    }
    if (this.tacking) {
      this.tackTimer -= dt;
      if (twa > 0.72 || this.tackTimer <= 0) { if (twa > 0.68) this.tacking = false; else if (this.tackTimer < -1.8) this.tacking = false; }
    }
    this.rel = rel; this.twa = twa;
    // トリム評価(オーバー/アンダー)とラフ・ストール (風域のベスト角度に応じてシバー開始角PINCHも35°〜39°に変化)
    const localWindKt = BASE_WIND_KT * w.f;
    const optCloseDeg = bestCloseDeg(localWindKt);
    this.bestCloseDeg = optCloseDeg;
    const so = sheetOpt(twa); this.sOpt = so;
    const d = this.sheet - so;
    const pinchDeg = clamp(optCloseDeg - 3.5, 34.5, 39.0); // 強風は34.5°までシバーせず、軽風は39°未満でシバーし始める
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
    const twaDeg = (twa * 180) / Math.PI;
    const turning = this.tacking || (this.maneuver && this.maneuver.kind === 'tack');
    // タック回頭中は惰性が残るため減速を大幅に抑える
    const rawPolarV = polar(twaDeg, localWindKt) * SPEED_SCALE;
    const polarV = turning ? Math.max(rawPolarV, V45_CLOSE * SPEED_SCALE * 0.74) : rawPolarV;
    // ランチャー: 下レグ(深い角度)でジブが開いて若干速くなる。リーチより上では逆効果
    const poleF = 1 + this.poleK * (0.065 * smoothstep(1.85, 2.6, twa) - 0.35 * clamp(POLE_MIN + 0.1 - twa, 0, 1));
    let target = polarV * Math.pow(w.f, 0.8) * this.skill * eff * poleF * (1 - (turning ? 0.022 : 0.18) * Math.abs(steer)) * this.throttle;
    // 波: 上りでは波面を登るたびに叩かれて失速(短く急な波ほど大きい)、リーチング〜ランニングでは波の前面を滑り降りて加速(サーフィン)
    {
      const ws = waveSample(this.x, this.z, t, Math.sin(this.h), -Math.cos(this.h));
      this.waveH = ws.h; this.waveSlope = ws.slope;
      const Hn = SEA.H / 0.5;
      const climb = clamp(ws.slope / SEA.maxSlope, -1, 1);
      const upw = 1 - smoothstep(0.95, 1.65, twa);
      const down = smoothstep(1.15, 1.9, twa);
      let wf = 1 - upw * 0.10 * Hn * SEA.steep * (0.55 + 0.9 * Math.max(0, climb));
      if (turning) wf -= 0.10 * Hn * SEA.steep; // 波の中でのタックは行き足が止まりやすい
      const windOk = clamp((localWindKt - 5.5) / 6, 0, 1);
      wf += down * SEA.surf * Math.max(0, -climb) * (0.3 + 0.7 * windOk) * clamp(this.v / (2.2 * SPEED_SCALE), 0.3, 1);
      if (SEA.type === 'chop') wf -= down * 0.035 * Hn * (0.5 + 0.5 * Math.abs(climb)); // 三角波は追い波でも乗りにくく揺さぶられる
      this.waveF = wf;
      this.waveLoss = Math.max(0, 1 - wf);
      target *= wf;
    }
    // 完全風上(0°〜5° / 355°〜360°付近)に向くと風圧で少しずつバック(後退)する
    if (twaDeg < 12 && !turning) {
      const irons = clamp((10 - twaDeg) / 5, 0, 1); // 0°〜5°で最大1.0
      target -= irons * 0.42 * SPEED_SCALE * w.f;
    }
    const tau = target > this.v ? (this.tacking ? 1.5 : 2.2) : turning ? 8.5 : 1.5; // タック中の減速はごく緩やかに、立ち上がりは素早く
    this.v += (target - this.v) * (1 - Math.exp(-dt / tau));

    // 風下側への流され(リーウェイ＆風圧ドリフト):
    // 停止・極微速時のみ風下側へ少しずつ流され(従来の約半分)、一定の速度(約1.15kt以上)が出るとセンターボードが効いて流されなくなる
    const vCut = 1.15 * KT * SPEED_SCALE;
    const slowF = Math.pow(clamp(1 - Math.abs(this.v) / vCut, 0, 1), 1.5);
    const leewayV = 0.20 * slowF * SPEED_SCALE * w.f * Math.sin(twa); // 艇の風下横方向(-nt)への横流れ(停止時のみ、走行中は0)
    const windageV = 0.12 * slowF * SPEED_SCALE * w.f;                // 風下方向への吹き流され(停止時のみ、走行中は0)
    // リーバウ・スターン通過リフト時はセンターボードの揚力で風上側(+nt)へもわずかにせり上がる
    const liftLatV = this.windBend > 0.008 && this.v > vCut ? this.windBend * 1.15 * SPEED_SCALE : 0;
    const leeX = -nt * Math.cos(this.h) * (leewayV - liftLatV) - Math.sin(w.from) * windageV;
    const leeZ = -nt * Math.sin(this.h) * (leewayV - liftLatV) + Math.cos(w.from) * windageV;

    this.x += (Math.sin(this.h) * this.v + leeX) * dt;
    this.z += (-Math.cos(this.h) * this.v + leeZ) * dt;

    // 風の強さ(localWindKt)と風角(twa)・シート引き量に応じたヒール力と、クルーのハイクアウトによる復原力(ヒールを起こす動き)
    const anglePress = Math.sin(clamp(twa, 0.2, Math.PI * 0.88)) * (0.35 + 0.65 * this.sheet) * (1 - 0.65 * smoothstep(1.85, 2.75, twa)) * (1 - 0.55 * this.luff);
    const windPress = Math.pow(clamp(localWindKt / 9.2, 0.25, 1.85), 1.25);
    const speedPress = 0.35 + 0.65 * clamp(Math.abs(this.v) / 1.8, 0, 1);
    const rawHeelPress = anglePress * windPress * speedPress;
    // クルーとスキッパーは風圧と現在のヒール角に応じてハイクアウト量を調整し、船をフラットに起こす
    const targetHike = twa > 2.45 ? 0.05 : clamp(rawHeelPress * 1.18 + Math.abs(this.heel) * 1.35, 0.05, 1.0);
    this.hike += (targetHike - this.hike) * (1 - Math.exp(-dt * 2.5));
    const netHeel = Math.max(0.012, rawHeelPress * 0.24 - this.hike * 0.145);
    const heelT = nt * clamp(netHeel, 0, 0.23);
    this.heel += (heelT - this.heel) * (1 - Math.exp(-dt * 2.8));
    this.contactCD = Math.max(0, this.contactCD - dt);
    this.touchCD = Math.max(0, this.touchCD - dt);
  }
}

// 障害物(マーク・委員会艇)のワールド座標円
export const OBSTACLES = [];
export function rebuildObstacles() {
  OBSTACLES.length = 0;
  // マークの当たり判定は水線位置のブイの太さ(半径約1.3m)に合わせる (上マークフィニッシュ時は1マークのみ)
  const markKeys = COURSE_MODE === 'upwind' ? ['m1'] : ['m1', 'm1a', 'm2', 'm3', 'gL', 'gR', 'fm'];
  for (const k of markKeys) { const p = toWorld(MARKS[k].a, MARKS[k].c); OBSTACLES.push({ key: k, x: p.x, z: p.z, r: 1.35 }); }
  // 艇型障害物: 船首を風上に向けてアンカー(長軸 = a軸)。本部船は全長約16mのクルーザー
  for (const [k, sp, n, r, gap] of [['com', MARKS.com, 4, 2.4, 4.0], ['pin', MARKS.pin, 2, 2.2, 4.5], ['com', MARKS.fcom, 4, 2.4, 4.0]]) {
    for (let i = -(n - 1) / 2; i <= (n - 1) / 2; i++) { const p = toWorld(sp.a + i * gap, sp.c); OBSTACLES.push({ key: k, x: p.x, z: p.z, r }); }
  }
}
rebuildObstacles();

function circles(b) {
  const dx = Math.sin(b.h), dz = -Math.cos(b.h);
  return [{ x: b.x + dx * 1.2, z: b.z + dz * 1.2 }, { x: b.x - dx * 1.2, z: b.z - dz * 1.2 }];
}
const CR = 0.95;

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
        ev.push({ type: 'contact', gw: r.gw, row: r.gw === A ? B : A, rule: r.rule, text: r.text });
      }
    }
    for (const o of OBSTACLES) {
      for (const p of ca) {
        const dx = p.x - o.x, dz = p.z - o.z;
        const d = Math.hypot(dx, dz) || 0.001;
        const pp = o.r + CR - d;
        if (pp > 0) {
          A.x += (dx / d) * pp; A.z += (dz / d) * pp; A.v *= 0.97;
          if (A.touchCD <= 0 && !A.finished) { A.touchCD = 6; ev.push({ type: 'touch', boat: A, mark: o.key }); }
        }
      }
    }
  }
  return ev;
}

// 艇の物理・風・衝突(three.js非依存)
import { W0, toCourse, MARKS, toWorld } from './course.js';
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

// スナイプ風のポーラー(TWA deg → m/s @ 9kt)
// クローズ(40°〜45°)の間は V(θ)*cos(θ) = 一定 とし、角度と艇速のトレードオフで風上目的地への到達時間に差がつかないようにする
const V45_CLOSE = 2.10;
const VMG_CLOSE = V45_CLOSE * Math.cos((45 * Math.PI) / 180); // ≈ 1.4849 m/s (40°で1.938m/s 〜 45°で2.100m/s)
const V40_CLOSE = VMG_CLOSE / Math.cos((40 * Math.PI) / 180);
const POLAR = [[0, 0], [30, 0], [36, 1.15], [40, V40_CLOSE], [45, V45_CLOSE], [48, 2.26], [60, 2.85], [75, 3.3], [90, 3.55], [110, 3.6], [130, 3.4], [150, 3.0], [160, 2.84], [170, 2.9], [180, 2.45]];
export function polar(deg) {
  if (deg >= 40 && deg <= 45) {
    return VMG_CLOSE / Math.cos((deg * Math.PI) / 180);
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

// ブランケット(風影): 他艇の見かけ風の風下側にいる艇の風を弱める
const SHADOW_LEN = 38;
export function computeBlanket(boats) {
  for (const b of boats) b.coverT = 0;
  for (const A of boats) {
    for (const B of boats) {
      if (A === B) continue;
      const rx = B.x - A.x, rz = B.z - A.z;
      const along = rx * A.awx + rz * A.awz;
      if (along < 2 || along > SHADOW_LEN) continue;
      const lat = Math.abs(-rx * A.awz + rz * A.awx), half = 1.4 + along * 0.3;
      if (lat >= half) continue;
      const s = (1 - along / SHADOW_LEN) * (1 - lat / half) * 1.3;
      B.coverT = 1 - (1 - B.coverT) * (1 - Math.min(0.95, s));
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
  const osc = 0.12 * Math.sin(t * 0.038 + 0.7) + 0.06 * Math.sin(t * 0.095 + 1.3);
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
    this.maneuver = null; this.penalty = null; this.penaltyDone = false; this.penaltyExpired = null;
    this.leg = 0; this.ocs = false; this.finished = false; this.finishTime = 0;
    this.a = undefined; this.c = 0; this.visit = null;
    this.contactCD = 0; this.touchCD = 0; this.heel = 0; this.turned = 0;
    this.sOpt = 1; this.luff = 0; this.stall = 0; this.cover = 0; this.coverT = 0;
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
    if (this.penalty || this.dsq) return false;
    this.penalty = { turned: 0, rule, timer: 20.0, clearWater: true };
    this.pole = false;
    return true;
  }

  update(dt, t, boats) {
    const w = windAt(this.x, this.z, t);
    this.cover += (this.coverT - this.cover) * (1 - Math.exp(-dt / 1.2));
    w.f *= 1 - 0.5 * this.cover;
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
    const rateMax = 0.85 * (0.35 + 0.65 * clamp(this.v / 2.5, 0, 1));
    const dh = steer * rateMax * dt;
    this.h = wrap(this.h + dh);
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
      if (this.penalty.turned >= 2 * Math.PI * 0.98) {
        this.penalty = null;
        this.penaltyDone = true;
      } else if (this.penalty.timer <= 0) {
        const r = this.penalty.rule;
        this.penalty = null;
        this.dsq = true;
        this.dsqReason = `ルール${r}違反・20秒以内にペナルティ未履行(RRS 44.2)`;
        this.penaltyExpired = r;
      }
    }
    const rel = wrap(w.from - this.h);
    const twa = Math.abs(rel);
    const nt = rel >= 0 ? 1 : -1;
    if (nt !== this.tack) {
      if (twa < Math.PI / 2) { this.tacking = true; this.tackTimer = 3.0; } else { this.v *= 0.88; }
      this.tack = nt;
    }
    if (this.tacking) {
      this.tackTimer -= dt;
      if (twa > 0.78 || this.tackTimer <= 0) { if (twa > 0.7) this.tacking = false; else if (this.tackTimer < -3) this.tacking = false; }
    }
    this.rel = rel; this.twa = twa;
    // トリム評価(オーバー/アンダー)とラフ・ストール
    const so = sheetOpt(twa); this.sOpt = so;
    const d = this.sheet - so;
    const PINCH = (40 * Math.PI) / 180; // これより上るとセールがシバーする
    const pinch = twa < PINCH ? clamp((PINCH - twa) * 4, 0, 1) : 0;
    this.luff = clamp(Math.max(Math.max(0, -d - 0.05) * 3.2, pinch * 0.9), 0, 1);
    this.stall = clamp((d - 0.1) * 3.5, 0, 1);
    const eff = clamp(1 - Math.max(0, -d - 0.06) * 1.45 - Math.max(0, d - 0.1) * 0.9, 0.12, 1);
    // 見かけ風
    const Vw = BASE_WIND_KT * KT * SPEED_SCALE * w.f;
    const ax = -Math.sin(w.from) * Vw - Math.sin(this.h) * this.v, az = Math.cos(w.from) * Vw + Math.cos(this.h) * this.v;
    const al = Math.hypot(ax, az) || 1e-6;
    this.awx = ax / al; this.awz = az / al; this.aws = al;
    this.awa = wrap(Math.atan2(-ax, az) - this.h);
    const polarV = polar((twa * 180) / Math.PI) * SPEED_SCALE;
    // ランチャー: 下レグ(深い角度)でジブが開いて若干速くなる。リーチより上では逆効果
    const poleF = 1 + this.poleK * (0.065 * smoothstep(1.85, 2.6, twa) - 0.35 * clamp(POLE_MIN + 0.1 - twa, 0, 1));
    const turning = this.tacking || (this.maneuver && this.maneuver.kind === 'tack');
    const target = polarV * Math.pow(w.f, 0.8) * this.skill * eff * poleF * (1 - (turning ? 0.06 : 0.2) * Math.abs(steer)) * this.throttle;
    const tau = target > this.v ? 2.4 : turning ? 5.0 : 1.5; // タック中は減速を緩やかに
    this.v += (target - this.v) * (1 - Math.exp(-dt / tau));
    this.x += Math.sin(this.h) * this.v * dt;
    this.z -= Math.cos(this.h) * this.v * dt;
    const heelT = nt * clamp((0.03 + 0.13 * Math.sin(twa) * w.f * this.sheet) * (0.4 + 0.6 * clamp(this.v / 2, 0, 1)), 0, 0.32);
    this.heel += (heelT - this.heel) * (1 - Math.exp(-dt * 1.5));
    this.contactCD = Math.max(0, this.contactCD - dt);
    this.touchCD = Math.max(0, this.touchCD - dt);
  }
}

// 障害物(マーク・委員会艇)のワールド座標円
export const OBSTACLES = [];
export function rebuildObstacles() {
  OBSTACLES.length = 0;
  // マークの当たり判定は水線位置のブイの太さ(半径約1.3m)に合わせる
  for (const k of ['m1', 'm1a', 'm2', 'm3', 'gL', 'gR', 'fm']) { const p = toWorld(MARKS[k].a, MARKS[k].c); OBSTACLES.push({ key: k, x: p.x, z: p.z, r: 1.35 }); }
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

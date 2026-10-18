// AI艇(three.js非依存)
import { toWorld, LEGS, LINE_HALF, lineA, LINE_SKEW, MARKS, ROUND_R } from './course.js';
import { wrap, clamp, sheetOpt, polar, bestCloseDeg, BASE_WIND_KT, SPEED_SCALE, OBSTACLES, POLE_MIN } from './sim.js';
import { giveWayBoat } from './rules.js';

const START_T = -60;

export class AI {
  constructor(b, rng) {
    this.b = b; this.rng = rng;
    // クローズホールド角度: 風速に応じたスナイプのベスト角度(強風38°・中風40°・軽風45°)＋わずかな個性差
    this.closeAngleOffset = ((rng() - 0.3) * 1.6 * Math.PI) / 180;
    this.closeAngle = (bestCloseDeg(BASE_WIND_KT) * Math.PI) / 180 + this.closeAngleOffset;
    // ランニング角度(下レグで180°の真後ろではなく170°付近を走行してVMGを稼ぐ)
    this.runAngle = ((168.5 + rng() * 3.0) * Math.PI) / 180;
    this.targetStartC = b.startTargetC ?? b.c;
    this.cLim = 100 + rng() * 40;
    this.lastTack = -99;
    // ラインを切る目標時刻(号砲=0秒の後)。ほとんどは0.3〜2秒後、一部は遅れてスタート、稀にOCS。
    const r = rng();
    this.tc = r < 0.02 ? -0.5 - rng() * 0.8 : r < 0.07 ? 2.5 + rng() * 3.5 : 0.6 + rng() * 2.0;
    this.go = false;
    this.layMargin = 0.02 + rng() * 0.07;
    this.penDir = rng() < 0.5 ? 1 : -1;
    this.jit = (rng() - 0.5) * 14;
    this.vmgAt = 0;
    // スタート前: ラインの手前 goDist[m] から加速を開始。それまでは少しずつ前進(creepExp が大きいほど後半に詰める)
    this.goDist = 9 + rng() * 8;
    this.creepExp = 1.5 + rng() * 0.8;
    this.gap0 = null;
    this.avoidUntil = 0; this.avoidH = 0;
    this.roundR = 7.0 + rng() * 2.0; // マーク回航半径(ワイドイン・タイトアウト気味)
    this.rp = null;
    this.poleT = 0;
  }

  bearing(tx, tz) { return Math.atan2(tx - this.b.x, -(tz - this.b.z)); }

  // 静止状態から距L(m)を走破するのに必要な時間(秒)。クローズホールドの目標速度へ指数的に加速すると仮定。
  runUpTime(L) {
    const b = this.b;
    const wKt = BASE_WIND_KT * (b.windF || 1);
    const vT = polar((this.closeAngle * 180) / Math.PI, wKt) * SPEED_SCALE * Math.pow(b.windF || 1, 0.8) * b.skill;
    const tau = 2.4, v0 = b.v;
    const dist = (T) => vT * T - (vT - v0) * tau * (1 - Math.exp(-T / tau));
    let lo = 0, hi = 60;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (dist(mid) < L) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }

  // 目標点が真風に対して直接走れる角度か
  fetchable(tgt, margin = 0.03) {
    const tw = toWorld(tgt.a, tgt.c);
    return Math.abs(wrap(this.b.windFrom - this.bearing(tw.x, tw.z))) > this.closeAngle + margin;
  }

  // 目標点(a,c)へ向かうヘディング(風上ならタック、風下170°超ならジャイブで170°付近を維持)
  headingFor(tgt, t, prestart) {
    const b = this.b, W = b.windFrom;
    const tw = toWorld(tgt.a, tgt.c);
    const brg = this.bearing(tw.x, tw.z);
    const relT = wrap(W - brg);
    const ca = this.closeAngle;
    const ra = this.runAngle;
    // 下レグ(目標が真風角170°より深い場合): 180°で走らず170°付近を維持し、レイラインに達したらジャイブする
    if (!prestart && Math.abs(relT) > ra && Math.hypot(tgt.a - b.a, tgt.c - b.c) > 22) {
      const hs = wrap(W - ra), hp = wrap(W + ra);
      const cs = Math.cos(wrap(hs - brg)), cp = Math.cos(wrap(hp - brg));
      if (t - this.lastTack > 6 && !this.crowded() && !this.nearObstacle(8)) {
        if (b.tack === 1 && cp > cs + 0.012) { this.lastTack = t; b.startManeuver('gybe'); }
        else if (b.tack === -1 && cs > cp + 0.012) { this.lastTack = t; b.startManeuver('gybe'); }
      }
      return wrap(W - b.tack * ra);
    }
    if (Math.abs(relT) > ca + 0.03) return brg; // 直進で到達可能
    // ビーティング
    const da = tgt.a - b.a, dc = b.c - tgt.c;
    const tackNow = b.tack;
    const cool = (prestart ? 15 : 6) < t - this.lastTack;
    let wantTack = false;
    if (cool && da > 5) {
      const lay = da * Math.tan(ca) * (1 + this.layMargin);
      if (tackNow === 1 && dc <= -lay) wantTack = true;
      if (tackNow === -1 && dc >= lay) wantTack = true;
      if (!prestart) {
        if (tackNow === 1 && b.c < -this.cLim) wantTack = true;
        if (tackNow === -1 && b.c > this.cLim) wantTack = true;
        if (t > this.vmgAt) {
          this.vmgAt = t + 6 + this.rng() * 6;
          const hs = W - ca, hp = W + ca; // 右舷タック(rel=+) / 左舷タック
          const cs = Math.cos(wrap(hs - brg)), cp = Math.cos(wrap(hp - brg));
          if (tackNow === 1 && cp > cs + 0.04) wantTack = true;
          if (tackNow === -1 && cs > cp + 0.04) wantTack = true;
        }
      }
    }
    if (wantTack && !this.crowded() && !this.nearObstacle(8)) { this.lastTack = t; b.startManeuver('tack'); }
    return wrap(W - b.tack * ca);
  }

  crowded() {
    const b = this.b;
    for (const o of this.others) {
      if (o === b) continue;
      const dx = o.x - b.x, dz = o.z - b.z;
      if (dx * dx + dz * dz < 100) return true;
    }
    return false;
  }

  // 半径R[m]以内にマーク・運営艇があるか(タックでマークへ寄ってしまうのを防ぐ)
  nearObstacle(R) {
    const b = this.b;
    for (const o of OBSTACLES) {
      const dx = o.x - b.x, dz = o.z - b.z, rr = R + o.r;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  }

  // ---------- マーク回航プラン ----------
  // 左舷回航(マークを左に見て反時計回り)。
  // 進入点 → マーク中心・半径 r の円を接線方向に周回(半径誤差を補正するベクトル場) → 脱出点 → 次の目標。
  // 風上マークは右舷レイライン上の進入点を経由し、マークの右上から回り込む(マークタッチ・逆回り防止)。
  buildRounding(L) {
    const m = L.mark, r = this.roundR, ca = this.closeAngle;
    const right = (d) => ({ c: d.a, a: -d.c });
    const ri = right(L.dirIn), ro = right(L.dirOut);
    const th1 = Math.atan2(ri.a, ri.c);
    let th2 = Math.atan2(ro.a, ro.c);
    while (th2 < th1 + 0.05) th2 += 2 * Math.PI;
    const P = (th) => ({ c: m.c + r * Math.cos(th), a: m.a + r * Math.sin(th) });
    const beat = L.dirIn.a > 0.7;
    const ths = beat ? Math.max(th1, ca + 0.12) : th1 - 0.45;
    const entry = P(ths), e = P(th2);
    // 右舷クローズホールドの進行方向 (c,a)=(-sin ca, cos ca) の手前16mにレイライン進入点
    const lay = beat ? { c: entry.c + 16 * Math.sin(ca), a: entry.a - 16 * Math.cos(ca) } : null;
    const exit = { c: e.c + L.dirOut.c * 8, a: e.a + L.dirOut.a * 8 };
    return { leg: L.id, m, r, ths, arc: th2 - ths, entry, lay, exit, phase: beat ? 'lay' : 'approach', beat, idx: 0 };
  }

  roundingTarget(L) {
    const b = this.b;
    if (!this.rp || this.rp.leg !== L.id) this.rp = this.buildRounding(L);
    const rp = this.rp, m = rp.m, r = rp.r;
    const dc = b.c - m.c, da = b.a - m.a, dM = Math.hypot(dc, da);
    const thb = Math.atan2(da, dc);
    let uu = thb - rp.ths; // 円弧上の進み具合(rad)
    uu = ((((uu + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI / 2;
    const dist = (p) => Math.hypot(b.c - p.c, b.a - p.a);
    const ca = this.closeAngle, t = this.now || 0;
    if (rp.phase === 'lay') {
      if (dist(rp.lay) < 5 || (b.tack === 1 && b.c > m.c + 1 && this.fetchable(rp.entry, 0))) rp.phase = 'approach';
      else return rp.lay;
    }
    if (rp.phase === 'approach' && rp.beat && !this.fetchable(rp.entry, -0.08) && dist(rp.entry) > 4) {
      // 右舷レイラインより下(届かない) → 左舷に返してレイラインまで伸ばしてからタック(マーク下でのピンチ・タッチ防止)
      rp.phase = 'lay2';
      if (b.tack === 1 && !b.maneuver && t - this.lastTack > 3) { this.lastTack = t; b.startManeuver('tack'); }
    }
    if (rp.phase === 'lay2') {
      if (this.fetchable(rp.entry, 0.03)) {
        if (b.tack === -1 && !b.maneuver && t - this.lastTack > 3) { this.lastTack = t; b.startManeuver('tack'); }
        rp.phase = 'approach';
      } else {
        // 左舷クローズホールド方向 (c,a)=(sin ca, cos ca) と右舷レイライン(進入点から (sin ca, -cos ca) 方向)の交点の少し先
        const pc = Math.sin(ca), pa = Math.cos(ca), sc = Math.sin(ca), sa = -Math.cos(ca);
        const rc = rp.entry.c - b.c, ra = rp.entry.a - b.a, det = pc * -sa - pa * -sc;
        const u = Math.abs(det) > 1e-6 ? (rc * -sa - ra * -sc) / det : 10;
        const k = Math.max(4, u + 3);
        return { c: b.c + pc * k, a: b.a + pa * k };
      }
    }
    if (rp.phase === 'approach') {
      // 非ビートレグでは進入点の手前側(時計回り側)から近づいた場合もそのまま周回に入る(進入点へ無理に切り上がらない)
      if (dist(rp.entry) < 5 || (dM < 2 * r && uu > (rp.beat ? -0.35 : -1.2) && uu < rp.arc)) rp.phase = 'orbit';
      else return rp.entry;
    }
    if (rp.phase === 'orbit') {
      rp.idx = 1;
      if (uu >= rp.arc - 0.04) rp.phase = 'exit'; // 行き過ぎても再周回しない
      else if (dM > 3.2 * r) { rp.phase = 'approach'; return rp.entry; }
      else {
        const tc = -Math.sin(thb), ta = Math.cos(thb), nc = Math.cos(thb), na = Math.sin(thb);
        const k = clamp(((dM - r) / r) * 1.6, -1.2, 1);
        let vc = tc - k * nc, va = ta - k * na; const l = Math.hypot(vc, va) || 1; vc /= l; va /= l;
        return { c: b.c + vc * 15, a: b.a + va * 15 };
      }
    }
    // exit
    rp.idx = 2;
    if (dM > ROUND_R + 4) { this.rp = null; return L.mark; } // 回航が認められていない → 回り直し
    if (dist(rp.exit) > 5 && (b.c - rp.exit.c) * L.dirOut.c + (b.a - rp.exit.a) * L.dirOut.a < 0) return rp.exit;
    const nL = LEGS[b.leg + 1];
    // 次がマークなら、マーク中心ではなく次の回航の進入点へ向かう(近接した1→1aでのタッチ防止)
    return nL ? (nL.type === 'mark' ? this.buildRounding(nL).entry : nL.center) : L.mark;
  }

  // 衝突回避: 避ける義務艇のみ回避ヘディングを返す。
  // 希望針路からのずれが最小で、相手とぎりぎり(最接近距離 CLEAR)離れられる針路を選ぶ(大回りしない)
  avoid(t, desired) {
    const b = this.b;
    if (t < this.avoidUntil) return this.avoidH;
    const CLEAR = 4.0, DETECT = 3.8; // 艇体同士が触れない最小限(中心間距離)
    const vb = Math.max(b.v, 1.2);
    const cpaFor = (h, o) => {
      const vx = Math.sin(h) * vb, vz = -Math.cos(h) * vb, vo = Math.max(o.v, 0.8);
      const dvx = Math.sin(o.h) * vo - vx, dvz = -Math.cos(o.h) * vo - vz;
      const dx = o.x - b.x, dz = o.z - b.z;
      const dv2 = dvx * dvx + dvz * dvz || 1e-6;
      const tca = clamp(-(dx * dvx + dz * dvz) / dv2, 0, 8);
      return Math.hypot(dx + dvx * tca, dz + dvz * tca);
    };
    const h0 = desired ?? b.h;
    let threat = null, worst = DETECT;
    for (const o of this.others) {
      if (o === b || o.finished) continue;
      const dx = o.x - b.x, dz = o.z - b.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 900) continue;
      const cpa = cpaFor(h0, o);
      if (cpa >= worst) continue;
      const gw = giveWayBoat(b, o).gw;
      if (gw === b || (cpa < 2.2 && d2 < 36)) { threat = o; worst = cpa; }
    }
    if (!threat) return null;
    const W = b.windFrom;
    let best = null, bestScore = -1e9;
    for (let i = 0; i <= 12; i++) {
      for (const s of i ? [1, -1] : [1]) {
        const dh = s * i * 0.075, h = wrap(h0 + dh);
        if (Math.abs(wrap(W - h)) < 0.66) continue;
        if (b.pole && Math.abs(wrap(W - h)) < POLE_MIN) continue;
        const cpa = cpaFor(h, threat);
        const base = cpa >= CLEAR ? 100 - Math.abs(dh) * 10 : cpa - Math.abs(dh) * 0.5;
        const score = base - Math.max(0, 3.5 - this.markClear(h)) * 2.5;
        if (score > bestScore) { bestScore = score; best = h; }
      }
    }
    if (best !== null) { this.avoidUntil = t + 0.5; this.avoidH = best; }
    return best;
  }

  // ヘディングhで進んだ場合の前方15m以内の障害物との最小横距離(障害物半径を差し引いた値)
  markClear(h) {
    const b = this.b, fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    let m = 99;
    for (const o of OBSTACLES) {
      const ox = o.x - b.x, oz = o.z - b.z;
      if (ox * ox + oz * oz > 500) continue;
      const along = ox * fx + oz * fz;
      if (along < -1 || along > 15) continue;
      m = Math.min(m, Math.abs(ox * rx + oz * rz) - o.r);
    }
    return m;
  }

  // マーク・運営艇への接触を避ける: 希望ヘディングの前方に障害物があれば、
  // 実際に走れて(真風角)・前方と旋回途中の両方で十分離れられる最小のずらし角を探す
  avoidMarks(heading, prestart) {
    const b = this.b, W = b.windFrom, ca = this.closeAngle;
    const near = [];
    for (const o of OBSTACLES) {
      const ox = o.x - b.x, oz = o.z - b.z;
      if (ox * ox + oz * oz < 676) near.push({ o, ox, oz });
    }
    if (!near.length) return heading;
    const L = LEGS[b.leg];
    const active = !prestart && !b.finished && L && L.type === 'mark' ? Object.keys(MARKS).find((k) => MARKS[k] === L.mark) : null;
    const look = clamp(b.v * 4, 9, 20);
    // ヘディングhで直進した時の前方 maxAlong[m] 以内の障害物との最小横距離(障害物半径を差し引く)
    const clr = (h, maxAlong) => {
      const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
      let m = 99;
      for (const n of near) {
        const along = n.ox * fx + n.oz * fz;
        if (along < -2.5 || along > maxAlong) continue;
        m = Math.min(m, Math.abs(n.ox * rx + n.oz * rz) - n.o.r);
      }
      return m;
    };
    const score = (h) => Math.min(clr(h, look), clr(wrap(b.h + wrap(h - b.h) * 0.5), 7));
    const NEED = 1.9; // 艇体円(半径0.95)+余裕
    if (score(heading) > NEED) return heading;
    const ok = (h) => { const tw = Math.abs(wrap(W - h)); return tw > ca - 0.08 && (!b.pole || tw > POLE_MIN); };
    // 回航中のマークを右舷側に見るずらし方(逆回り)は減点
    const wrongSide = (h) => {
      if (!active) return 0;
      const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
      for (const n of near) {
        if (n.o.key !== active) continue;
        const along = n.ox * fx + n.oz * fz, lat = n.ox * rx + n.oz * rz;
        if (along > 0 && along < 20 && lat > 0 && lat < 10) return 3;
      }
      return 0;
    };
    let best = heading, bestV = -1e9;
    for (let i = 1; i <= 11; i++) {
      for (const s of [1, -1]) {
        const d = s * i * 0.11, h = wrap(heading + d);
        if (!ok(h)) continue;
        const c = score(h);
        const v = (c > NEED ? 100 - Math.abs(d) * 10 : c - Math.abs(d) * 0.5) - wrongSide(h);
        if (v > bestV) { bestV = v; best = h; }
      }
    }
    return best;
  }

  // ランチャー: 下レグで真風角が十分深く、マークから離れていれば上げる
  updatePole(dt, heading, distMark, rounding) {
    const b = this.b;
    const twaH = Math.abs(wrap(b.windFrom - heading));
    const want = !b.ocs && !b.penalty && !b.maneuver && !rounding && distMark > 32 && twaH > 2.0 && b.twa > 1.9;
    this.poleT = want ? this.poleT + dt : 0;
    if (!b.pole && this.poleT > 1.2) b.setPole(true);
    if (b.pole && (!want && (twaH < 1.85 || distMark < 26 || rounding || b.penalty))) b.setPole(false);
  }

  update(dt, t, others) {
    const b = this.b;
    this.others = others;
    this.now = t;
    // 現在の風速に応じたスナイプのベストクローズ角度(強風38°・中風40°・軽風45°)へ追従
    const curOptDeg = b.bestCloseDeg || bestCloseDeg(BASE_WIND_KT * (b.windF || 1));
    this.closeAngle = (curOptDeg * Math.PI) / 180 + this.closeAngleOffset;
    if (b.maneuver) return;
    if (b.penalty) { b.steer = this.penDir; b.throttle = 1; return; }
    b.sheet = sheetOpt(b.twa);
    this.coverTime = b.cover > 0.35 ? (this.coverTime || 0) + dt : 0;
    const Lc = LEGS[b.leg];
    const nearMark = Lc && Lc.type === 'mark' && Math.hypot(b.c - Lc.mark.c, b.a - Lc.mark.a) < 40;
    if (this.coverTime > 5 && t > 0 && t - this.lastTack > 12 && b.twa < 1.4 && !nearMark && !this.crowded()) { this.lastTack = t; this.coverTime = 0; b.startManeuver('tack'); return; }
    let heading;
    const prestart = t < 0;
    if (b.finished) {
      b.throttle = 0.5;
      if (b.pole) b.setPole(false);
      heading = this.headingFor({ a: -170, c: -40 }, t, false);
    } else if (prestart) {
      // 実戦同様: セールを緩めてラフしながら少しずつラインへ近づき、号砲に合わせてクローズホールドで加速
      const gap = Math.max(0, lineA(b.c) - b.a);
      // ラインまでの航走距離 = gap / (cosθ + tan(skew)·sinθ·tack)  (右舷は左へ進むので斜めのラインに早く届く)
      const tw = Math.min(b.twa, 1.3);
      const upf = Math.max(0.35, Math.cos(tw) + Math.tan(LINE_SKEW) * Math.sin(tw) * b.tack);
      if (this.gap0 === null) this.gap0 = gap;
      if (!this.go && t >= this.tc - this.runUpTime(gap / upf)) this.go = true;
      if (this.go) { b.throttle = 1; b.sheet = sheetOpt(b.twa); }
      else {
        const vT = polar((this.closeAngle * 180) / Math.PI) * SPEED_SCALE * Math.pow(b.windF || 1, 0.8) * b.skill;
        const goL = Math.min(this.goDist, this.gap0);
        const tGo = this.tc - this.runUpTime(goL / upf);
        const span = Math.max(5, tGo - START_T);
        const f = clamp((t - START_T) / span, 0, 1), p = this.creepExp;
        const D = goL + Math.max(0, this.gap0 - goL) * (1 - Math.pow(f, p)); // 目標の残り距離(序盤ゆっくり→終盤速く)
        const dDdt = (Math.max(0, this.gap0 - goL) * p * Math.pow(Math.max(f, 1e-3), p - 1)) / span;
        const vDes = Math.max(0, dDdt + 0.22 * (gap - D)) / upf;
        b.throttle = clamp(vDes / Math.max(0.1, vT), 0.05, 0.85);
        b.sheet = Math.max(0, sheetOpt(b.twa) - 0.05 - 0.25 * (1 - b.throttle));
      }
      const W = b.windFrom;
      // 目標のスタート位置(targetStartC: 下側〜本部船側まで均一分布)に合わせて角度・タックを調整
      const tgtC = this.targetStartC ?? 0;
      const cPred = b.c - gap * Math.tan(this.closeAngle) * 0.78; // 右舷タックのままラインに達した時の予想横位置
      const preAngle = b.tack === 1 ? clamp(this.closeAngle + (cPred - tgtC) * 0.012, 0.66, 0.90) : this.closeAngle;
      heading = wrap(W - b.tack * preAngle);
      if (t - this.lastTack > 11) {
        let wantTack = false;
        // 目標位置より下(左)へ流れすぎた場合は、スタート13秒前までなら左舷タックで上(本部船)側へ戻る
        if (b.tack === 1 && (b.c < -LINE_HALF * 0.82 || (t < -13 && cPred < tgtC - 12))) wantTack = true;
        // 左舷タックで目標スロットの風上レイラインまで上ったら、またはスタート10秒前になったら右舷タックへ返す
        if (b.tack === -1 && (b.c > LINE_HALF * 0.88 || cPred >= tgtC || t > -10)) wantTack = true;
        if (wantTack && !this.crowded()) { this.lastTack = t; b.startManeuver('tack'); }
      }
    } else if (b.ocs) {
      b.throttle = 1;
      if (b.pole) b.setPole(false);
      heading = this.headingFor({ a: lineA(b.c) - 14, c: b.c }, t, false);
    } else {
      b.throttle = 1;
      const L = LEGS[b.leg];
      let tgt, rounding = false, distMark;
      if (L.type === 'mark') {
        tgt = this.roundingTarget(L);
        distMark = Math.hypot(b.c - L.mark.c, b.a - L.mark.a);
        rounding = (this.rp ? this.rp.idx > 0 : false) || distMark < 30;
      } else {
        tgt = L.type === 'gate' ? { a: L.aim.a, c: L.aim.c + this.jit } : L.aim;
        if (L.type === 'gate') {
          // ゲートの外側を通ってしまった → ゲートの上へ戻って間を通り直す
          if (b.a < L.center.a - 2) this.gateRetry = true;
          if (this.gateRetry && b.a > L.center.a + 6) this.gateRetry = false;
          if (this.gateRetry) tgt = { a: L.center.a + 10, c: L.center.c };
        }
        distMark = Math.hypot(b.c - L.center.c, b.a - L.center.a);
      }
      heading = this.headingFor(tgt, t, false);
      this.updatePole(dt, heading, distMark, rounding);
    }
    // スタート直前(密集時)の無闇な回避行動による風下へのベアアウェイを防ぐため、スタート前は回避を抑制
    const av = prestart ? null : this.avoid(t, heading);
    if (av !== null && av !== undefined) heading = av;
    heading = this.avoidMarks(heading, prestart);
    const err = wrap(heading - b.h);
    b.steer = clamp(err * 2.5, -1, 1);
    if (b.maneuver) b.steer = 0;
  }
}

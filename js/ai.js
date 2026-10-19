// AI艇(three.js非依存)
import { toWorld, LEGS, LINE_HALF, lineA, LINE_SKEW, MARKS, ROUND_R, COURSE_MODE } from './course.js';
import { wrap, clamp, sheetOpt, polar, bestCloseDeg, BASE_WIND_KT, SPEED_SCALE, OBSTACLES, POLE_MIN } from './sim.js';
import { giveWayBoat } from './rules.js';

const START_T = -60;

export class AI {
  constructor(b, rng) {
    this.b = b; this.rng = rng;
    // スキル差に応じたクローズ角度・スタート精度・レイライン余白のばらつき(1マークでの密集を防ぐ)
    const skillGap = clamp(1.08 - (b.skill || 1), 0, 0.22);
    // クローズホールド角度: 上位艇はベスト角度に近く、中〜下位艇は少し角度が甘くなる個性差
    this.closeAngleOffset = (((rng() - 0.25) * 1.8 + skillGap * (4.5 + rng() * 4.0)) * Math.PI) / 180;
    this.closeAngle = (bestCloseDeg(BASE_WIND_KT) * Math.PI) / 180 + this.closeAngleOffset;
    // ランニング角度(下レグで180°の真後ろではなく170°付近を走行してVMGを稼ぐ)
    this.runAngle = ((168.0 + rng() * 4.0) * Math.PI) / 180;
    this.targetStartC = b.startTargetC ?? b.c;
    this.cLim = 92 + rng() * 52;
    this.lastTack = -99;
    // ラインを切る目標時刻(号砲=0秒の後): スキルや乱数に応じてスタートダッシュにも適度なばらつきを持たせる
    const r = rng();
    this.tc = r < 0.02 ? -0.5 - rng() * 0.8 : r < 0.12 ? 2.5 + rng() * 4.0 : 0.4 + rng() * 2.2 + skillGap * (6.0 + rng() * 6.0);
    this.go = false;
    this.layMargin = 0.015 + rng() * 0.085 + skillGap * 0.12;
    this.penDir = rng() < 0.5 ? 1 : -1;
    this.jit = (rng() - 0.5) * 14;
    this.vmgAt = 0;
    // スタート前: ラインの手前 goDist[m] から加速を開始。それまでは少しずつ前進(creepExp が大きいほど後半に詰める)
    this.goDist = 9 + rng() * 9;
    this.creepExp = 1.4 + rng() * 0.9;
    this.gap0 = null;
    this.avoidUntil = 0; this.avoidH = 0;
    this.roundR = 6.6 + rng() * 1.0; // マーク進入半径(ワイドイン)
    this.roundROut = 2.40;            // マーク脱出半径(タイトアウト: クローズ時点でマーク真横にピッタリつく)
    this.rp = null;
    // 4ゲート(4S=gL / 4P=gR): CP艇が片方に偏らないようIDの偶奇で50%ずつ均等に4S(左・右舷回航)と4P(右・左舷回航)へ振り分ける
    this.gateKey = b.id % 2 === 0 ? 'gL' : 'gR';
    this.gateRp = null;
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
  headingFor(tgt, t, prestart, directDownwind = false) {
    const b = this.b, W = b.windFrom;
    const tw = toWorld(tgt.a, tgt.c);
    const brg = this.bearing(tw.x, tw.z);
    const relT = wrap(W - brg);
    const ca = this.closeAngle;
    const ra = this.runAngle;
    // 下レグ(目標が真風角170°より深い場合): 180°で走らず170°付近を維持し、レイラインに達したらジャイブする
    if (!prestart && !directDownwind && Math.abs(relT) > ra && Math.hypot(tgt.a - b.a, tgt.c - b.c) > 22) {
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

  // ---------- マーク回航プラン (ワイドイン・タイトアウト: クローズ時点でマーク真横にピッタリつく) ----------
  buildRounding(L) {
    const m = L.mark, rIn = this.roundR, rOut = this.roundROut, ca = this.closeAngle;
    const right = (d) => ({ c: d.a, a: -d.c });
    const ri = right(L.dirIn), ro = right(L.dirOut);
    const th1 = Math.atan2(ri.a, ri.c);
    let th2 = Math.atan2(ro.a, ro.c);
    while (th2 < th1 + 0.05) th2 += 2 * Math.PI;
    const beat = L.dirIn.a > 0.7;
    const ths = beat ? Math.max(th1, ca + 0.12) : th1 - 0.38;
    const entry = { c: m.c + rIn * Math.cos(ths), a: m.a + rIn * Math.sin(ths) };
    // 脱出点 e はマーク真横(rOut = 2.40m)にピタリとつく位置
    const e = { c: m.c + rOut * Math.cos(th2), a: m.a + rOut * Math.sin(th2) };
    const lay = beat ? { c: entry.c + 16 * Math.sin(ca), a: entry.a - 16 * Math.cos(ca) } : null;
    const exit = { c: e.c + L.dirOut.c * 8, a: e.a + L.dirOut.a * 8 };
    return { leg: L.id, m, r: rIn, rOut, ths, arc: th2 - ths, entry, e, lay, exit, phase: beat ? 'lay' : 'approach', beat, idx: 0 };
  }

  roundingTarget(L) {
    const b = this.b;
    if (!this.rp || this.rp.leg !== L.id) this.rp = this.buildRounding(L);
    const rp = this.rp, m = rp.m, rIn = rp.r, rOut = rp.rOut;
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
      rp.phase = 'lay2';
      if (b.tack === 1 && !b.maneuver && t - this.lastTack > 3) { this.lastTack = t; b.startManeuver('tack'); }
    }
    if (rp.phase === 'lay2') {
      if (this.fetchable(rp.entry, 0.03)) {
        if (b.tack === -1 && !b.maneuver && t - this.lastTack > 3) { this.lastTack = t; b.startManeuver('tack'); }
        rp.phase = 'approach';
      } else {
        const pc = Math.sin(ca), pa = Math.cos(ca), sc = Math.sin(ca), sa = -Math.cos(ca);
        const rc = rp.entry.c - b.c, ra = rp.entry.a - b.a, det = pc * -sa - pa * -sc;
        const u = Math.abs(det) > 1e-6 ? (rc * -sa - ra * -sc) / det : 10;
        const k = Math.max(4, u + 3);
        return { c: b.c + pc * k, a: b.a + pa * k };
      }
    }
    if (rp.phase === 'approach') {
      if (dist(rp.entry) < 5 || (dM < 2.1 * rIn && uu > (rp.beat ? -0.35 : -1.1) && uu < rp.arc)) rp.phase = 'orbit';
      else return rp.entry;
    }
    if (rp.phase === 'orbit') {
      rp.idx = 1;
      if (uu >= rp.arc - 0.04) rp.phase = 'exit';
      else if (dM > 3.2 * rIn) { rp.phase = 'approach'; return rp.entry; }
      else {
        // ワイドイン(rIn=6.6m) → タイトアウト(rOut=2.40m)へスパイラル状に半径を絞り、脱出時はマーク真横にピタリとつける
        const prog = clamp(uu / Math.max(0.2, rp.arc), 0, 1);
        const rDes = rIn + (rOut - rIn) * Math.pow(prog, 0.85);
        const tc = -Math.sin(thb), ta = Math.cos(thb), nc = Math.cos(thb), na = Math.sin(thb);
        const k = clamp(((dM - rDes) / Math.max(2.2, rDes)) * 1.85, -1.2, 1.15);
        let vc = tc - k * nc, va = ta - k * na; const l = Math.hypot(vc, va) || 1; vc /= l; va /= l;
        return { c: b.c + vc * 14, a: b.a + va * 14 };
      }
    }
    // exit
    rp.idx = 2;
    if (dM > ROUND_R + 4) { this.rp = null; return L.mark; }
    if (dist(rp.exit) > 4.5 && (b.c - rp.exit.c) * L.dirOut.c + (b.a - rp.exit.a) * L.dirOut.a < 0) return rp.exit;
    const nL = LEGS[b.leg + 1];
    return nL ? (nL.type === 'mark' ? this.buildRounding(nL).entry : nL.center) : L.mark;
  }

  // ---------- 4ゲート(4S=gL / 4P=gR) 専用回航プラン ----------
  // 1) 4S(gL: a=40, c=-22) はゲート内側から入り、マークの下を回って右舷に見て(時計回り・右舷タックのクローズで)外側(c=-24.4)の真横へピタリと出る
  // 2) 4P(gR: a=40, c=+22) はゲート内側から入り、マークの下を回って左舷に見て(反時計回り・左舷タックのクローズで)外側(c=+24.4)の真横へピタリと出る
  updateGateRounding(t) {
    const b = this.b, ca = this.closeAngle;
    const key = this.gateKey; // 'gL' (4S) or 'gR' (4P)
    const m = MARKS[key];
    // s = -1: 4S(gL, c=-22, 左側マーク・右舷回航) / s = +1: 4P(gR, c=+22, 右側マーク・左舷回航)
    const s = key === 'gL' ? -1 : 1;
    // 回航後のクローズホールドで走るべきタック: 4S(s=-1)は右舷タック(+1)、4P(s=+1)は左舷タック(-1)
    const reqTack = -s;

    if (!this.gateRp) {
      this.gateRp = {
        key,
        s,
        phase: 'approach', // 'approach' -> 'orbit' -> 'tightExit' -> 'done'
      };
    }
    const gp = this.gateRp;
    const dc = b.c - m.c, da = b.a - m.a;
    // ゲート内側のワイド進入点(マークの7.0m内側、a=45.5)
    const entry = { a: m.a + 5.5, c: m.c - s * 7.0 };
    // クローズになった時点でマークの真横(a=m.a, 外側2.40m)にピタリとつくタイトアウト点
    const tightAbeam = { a: m.a + 0.4, c: m.c + s * 2.40 };
    const closeFollow = { a: m.a + 14.0, c: m.c + s * (2.40 + 13.6 * Math.tan(ca)) };

    // まだゲートより十分風上(a > 52)にいるとき:
    if (gp.phase === 'approach') {
      // ゲート手前(a = 52..105)で回航タック(reqTack)と逆のタックなら早めにジャイブを済ませ、マーク際ではラフのみで綺麗に回れるようにする
      if (b.a < 105 && b.a > 50 && b.tack !== reqTack && !b.maneuver && t - this.lastTack > 4 && !this.crowded()) {
        this.lastTack = t;
        b.startManeuver('gybe');
      }
      // 万一ゲートの外側(|c| > 20)に膨らんでしまった場合は、必ずゲート内側(c = m.c - s * 7.5, a = 47)へ戻してから進入する
      if (b.a < 58 && (b.c - m.c) * s > -2.5) {
        return { tgt: { a: Math.max(m.a + 6.5, b.a - 4), c: m.c - s * 7.5 }, direct: true, rounding: true };
      }
      if (b.a <= m.a + 5.5 && (b.c - m.c) * s <= 1.0) {
        gp.phase = 'orbit';
      } else {
        return { tgt: entry, direct: b.a < 115, rounding: b.a < 68 };
      }
    }

    if (gp.phase === 'orbit') {
      if (b.pole) b.setPole(false);
      // phi: ゲート内側(da=0, dc=-s*r)で 0 → マーク真下(da<0, dc=0)で π/2 → マーク外側真横(da=0, dc=+s*r)で π
      const phi = Math.atan2(-da, -s * dc);
      // すでにマーク外側(s*dc > 1.2)かつ真横付近(da >= -0.8)まで回り込んだらタイトアウト直進フェーズへ
      if (s * dc > 1.2 && da >= -0.8) {
        gp.phase = 'tightExit';
      } else {
        // phi に応じて目標半径を 7.0m(ワイドイン) → 5.2m(ボトム) → 2.40m(マーク真横タイトアウト) へ滑らかに絞る
        const phiClamped = clamp(phi, -0.35, Math.PI);
        const phiNext = Math.min(Math.PI, Math.max(0.35, phiClamped + 0.52));
        const prog = clamp(phiNext / Math.PI, 0, 1);
        const rC = 2.40 + (7.0 - 2.40) * Math.pow(Math.cos(prog * Math.PI * 0.5), 1.4);
        const rA = 5.2;
        const tgtC = m.c - s * rC * Math.cos(phiNext);
        const tgtA = m.a - rA * Math.sin(phiNext);
        return { tgt: { a: tgtA, c: tgtC }, direct: true, rounding: true };
      }
    }

    if (gp.phase === 'tightExit') {
      if (b.pole) b.setPole(false);
      // マーク真横(tightAbeam: a=40.4, c=m.c+s*2.40)をかすめながらクローズホールドの角度で立ち上がる
      if (b.a < m.a + 1.8) {
        return { tgt: tightAbeam, direct: true, rounding: true };
      }
      if (b.a < m.a + 8.5) {
        return { tgt: closeFollow, direct: true, rounding: true };
      }
      gp.phase = 'done';
    }
    return null;
  }

  // 衝突回避: 避ける義務艇のみ回避ヘディングを返す。
  avoid(t, desired) {
    const b = this.b;
    if (t < this.avoidUntil) return this.avoidH;
    const CLEAR = 4.0, DETECT = 3.8;
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

  // マーク・運営艇への接触を避ける
  avoidMarks(heading, prestart) {
    const b = this.b, W = b.windFrom, ca = this.closeAngle;
    const near = [];
    for (const o of OBSTACLES) {
      const ox = o.x - b.x, oz = o.z - b.z;
      if (ox * ox + oz * oz < 676) near.push({ o, ox, oz });
    }
    if (!near.length) return heading;
    const L = LEGS[Math.min(b.leg, LEGS.length - 1)];
    const activeGate = this.gateRp && this.gateRp.phase !== 'done' ? this.gateKey : null;
    const active = activeGate || (!prestart && !b.finished && L && L.type === 'mark' ? Object.keys(MARKS).find((k) => MARKS[k] === L.mark) : null);
    const look = clamp(b.v * 4, 8, 18);
    // 回航対象マークの真横をタイト(中心間2.4m = 余白1.05m)に抜ける際、余計な大回り回避が入らないよう対象マークのみ許容余白を1.02mにする
    const clr = (h, maxAlong) => {
      const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
      let m = 99;
      for (const n of near) {
        const along = n.ox * fx + n.oz * fz;
        if (along < -2.0 || along > maxAlong) continue;
        const pad = n.o.key === active ? 0.82 : 0.0;
        m = Math.min(m, Math.abs(n.ox * rx + n.oz * rz) - n.o.r + pad);
      }
      return m;
    };
    const score = (h) => Math.min(clr(h, look), clr(wrap(b.h + wrap(h - b.h) * 0.5), 6));
    const NEED = 1.85;
    if (score(heading) > NEED) return heading;
    const ok = (h) => { const tw = Math.abs(wrap(W - h)); return tw > ca - 0.08 && (!b.pole || tw > POLE_MIN); };
    const wrongSide = (h) => {
      if (!active) return 0;
      const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
      const isRightRound = active === 'gL'; // 4S(gL)のみ右舷回航、他は左舷回航
      for (const n of near) {
        if (n.o.key !== active) continue;
        const along = n.ox * fx + n.oz * fz, lat = n.ox * rx + n.oz * rz;
        if (along > 0 && along < 20) {
          if (!isRightRound && lat > 0 && lat < 10) return 3;
          if (isRightRound && lat < 0 && lat > -10) return 3;
        }
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
    const Lc = LEGS[Math.min(b.leg, LEGS.length - 1)];
    const nearMark = Lc && Lc.type === 'mark' && Math.hypot(b.c - Lc.mark.c, b.a - Lc.mark.a) < 40;
    const inGateRound = this.gateRp && this.gateRp.phase !== 'done';
    if (this.coverTime > 5 && t > 0 && t - this.lastTack > 12 && b.twa < 1.4 && !nearMark && !inGateRound && !this.crowded()) { this.lastTack = t; this.coverTime = 0; b.startManeuver('tack'); return; }
    let heading;
    const prestart = t < 0;
    if (b.finished) {
      b.throttle = 0.5;
      if (b.pole) b.setPole(false);
      heading = this.headingFor(COURSE_MODE === 'upwind' ? { a: 665, c: 55 } : { a: -170, c: -40 }, t, false);
    } else if (prestart) {
      // 実戦同様: セールを緩めてラフしながら少しずつラインへ近づき、号砲に合わせてクローズホールドで加速
      const gap = Math.max(0, lineA(b.c) - b.a);
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
        const D = goL + Math.max(0, this.gap0 - goL) * (1 - Math.pow(f, p));
        const dDdt = (Math.max(0, this.gap0 - goL) * p * Math.pow(Math.max(f, 1e-3), p - 1)) / span;
        const vDes = Math.max(0, dDdt + 0.22 * (gap - D)) / upf;
        b.throttle = clamp(vDes / Math.max(0.1, vT), 0.05, 0.85);
        b.sheet = Math.max(0, sheetOpt(b.twa) - 0.05 - 0.25 * (1 - b.throttle));
      }
      const W = b.windFrom;
      const tgtC = this.targetStartC ?? 0;
      const cPred = b.c - gap * Math.tan(this.closeAngle) * 0.78;
      const preAngle = b.tack === 1 ? clamp(this.closeAngle + (cPred - tgtC) * 0.012, 0.66, 0.90) : this.closeAngle;
      heading = wrap(W - b.tack * preAngle);
      if (t - this.lastTack > 11) {
        let wantTack = false;
        if (b.tack === 1 && (b.c < -LINE_HALF * 0.82 || (t < -13 && cPred < tgtC - 12))) wantTack = true;
        if (b.tack === -1 && (b.c > LINE_HALF * 0.88 || cPred >= tgtC || t > -10)) wantTack = true;
        if (wantTack && !this.crowded()) { this.lastTack = t; b.startManeuver('tack'); }
      }
    } else if (b.ocs) {
      b.throttle = 1;
      if (b.pole) b.setPole(false);
      heading = this.headingFor({ a: lineA(b.c) - 14, c: b.c }, t, false);
    } else {
      b.throttle = 1;
      const L = LEGS[Math.min(b.leg, LEGS.length - 1)];
      let tgt, rounding = false, distMark, directDownwind = false;
      // 4ゲート回航: レグ2(gate)の間、およびレグ3に切り替わった直後でもマーク真横のタイトアウトが完了するまで継続
      if (L.type === 'gate' || (this.gateRp && this.gateRp.phase !== 'done' && b.leg === 3)) {
        const gRes = this.updateGateRounding(t);
        if (gRes) {
          tgt = gRes.tgt;
          directDownwind = gRes.direct;
          rounding = gRes.rounding;
          const gm = MARKS[this.gateKey];
          distMark = Math.hypot(b.c - gm.c, b.a - gm.a);
        }
      }
      if (!tgt) {
        if (L.type === 'mark') {
          tgt = this.roundingTarget(L);
          distMark = Math.hypot(b.c - L.mark.c, b.a - L.mark.a);
          rounding = (this.rp ? this.rp.idx > 0 : false) || distMark < 30;
        } else {
          tgt = L.aim;
          distMark = Math.hypot(b.c - L.center.c, b.a - L.center.a);
        }
      }
      heading = this.headingFor(tgt, t, false, directDownwind);
      this.updatePole(dt, heading, distMark, rounding);
    }
    const av = prestart ? null : this.avoid(t, heading);
    if (av !== null && av !== undefined) heading = av;
    heading = this.avoidMarks(heading, prestart);
    const err = wrap(heading - b.h);
    b.steer = clamp(err * 2.5, -1, 1);
    if (b.maneuver) b.steer = 0;
  }
}

// AI艇(three.js非依存)
import { toWorld, LEGS, LINE_HALF, lineA, LINE_SKEW, MARKS, ROUND_R, COURSE_MODE } from './course.js';
import { wrap, clamp, sheetOpt, polar, bestCloseDeg, BASE_WIND_KT, SPEED_SCALE, OBSTACLES, POLE_MIN, windAt, SIDE_BIAS } from './sim.js';
import { giveWayBoat } from './rules.js';

const START_T = -60;

export class AI {
  constructor(b, rng) {
    this.b = b; this.rng = rng;
    this.initParams();
  }

  initParams() {
    const b = this.b, rng = this.rng;
    // スキル差に応じたクローズ角度・スタート精度・レイライン余白のばらつき(1マークでの密集を防ぐ)
    const skillGap = clamp(1.08 - (b.skill || 1), 0, 0.22);
    // クローズホールド角度: 上位艇はベスト角度に近く、中〜下位艇は少し角度が甘くなる個性差
    this.closeAngleOffset = (((rng() - 0.25) * 1.8 + skillGap * (4.5 + rng() * 4.0)) * Math.PI) / 180;
    this.closeAngle = (bestCloseDeg(BASE_WIND_KT) * Math.PI) / 180 + this.closeAngleOffset;
    // ランニング角度(下レグで180°の真後ろではなく164°〜170°付近を走行してVMGを稼ぐ)
    this.runAngle = ((164.0 + rng() * 6.0) * Math.PI) / 180;
    this.targetStartC = b.startTargetC ?? b.c;
    // コースのばらつき: 有利サイド(SIDE_BIAS)も考慮しつつ、適度な回廊幅で極端な不利サイドへの突っ込みを防止
    const slotSpread = ((b.id % 7) - 3) / 3; // -1 .. +1
    const biasShift = clamp((SIDE_BIAS || 0) * 35, -32, 32);
    this.prefSideC = clamp(slotSpread * 72 + biasShift + (rng() - 0.5) * 32, -98, 98);
    this.corridorHalf = 46 + rng() * 34;
    this.cLim = 95 + rng() * 32;
    this.tackCool = 20 + rng() * 14; // 中盤の戦術タック間隔(レイライン到達時は別途即座にタック可能)
    this.lastTack = -99;
    // ラインを切る目標時刻(号砲=0秒の後):
    // 1列目スタート艇はライン手前(6.5〜9.3m)で加速スペースを確保して飛び出し、
    // スタート失敗役(secondRow / highComFail)は第二線から遅れて出る
    const isStrong = (b.skill || 1) >= 1.04;
    const role = b.startRole || 'firstRow';
    if (role === 'secondRow') {
      this.tc = 2.8 + rng() * 2.4;
      this.goDist = 13.0 + rng() * 4.5;
    } else if (role === 'highComFail') {
      this.tc = 3.8 + rng() * 2.2;
      this.goDist = 11.5 + rng() * 3.5;
    } else {
      this.tc = isStrong
        ? 0.35 + rng() * 0.65
        : 0.55 + rng() * 1.15 + skillGap * 1.8;
      // スタート前: 加速スペースをしっかり確保できるようラインの手前 goDist[m] (6.5〜9.3m) で待って加速を開始
      this.goDist = 6.5 + rng() * 2.8;
    }
    this.go = false;
    // レイライン余白を抑え、オーバースタンド(レイラインを大きく超えて不利な位置を走り続ける現象)を防止
    this.layMargin = 0.012 + rng() * 0.042 + skillGap * 0.045;
    this.penDir = rng() < 0.5 ? 1 : -1;
    this.jit = (rng() - 0.5) * 14;
    this.vmgAt = 12 + rng() * 16;
    this.creepExp = 1.15 + rng() * 0.45;
    this.gap0 = null;
    this.avoidUntil = -999; this.avoidH = 0;
    this.roundR = 6.6 + rng() * 1.2; // マーク進入半径(ワイドイン)
    this.roundROut = 2.50;            // マーク脱出半径(タイトアウト)
    this.rp = null;
    // 4ゲート(4S=gL / 4P=gR)
    this.gateKey = b.id % 2 === 0 ? 'gL' : 'gR';
    this.gateRp = null;
    this.poleT = 0;
    this.coverTime = 0;
    // リーチングで前後に密着した際に後ろから上してブランケットを仕掛けたり対抗する積極性(一部CP艇が積極的に仕掛ける)
    this.luffAggro = (b.id % 3 !== 0 || rng() < 0.65) ? 0.58 + rng() * 0.42 : 0.20;
    this.luffMatch = 0;
  }

  bearing(tx, tz) { return Math.atan2(tx - this.b.x, -(tz - this.b.z)); }

  // 静止状態から距離L(m)を走破するのに必要な時間(秒)
  runUpTime(L) {
    const b = this.b;
    const wKt = BASE_WIND_KT * (b.windF || 1);
    const vT = polar((this.closeAngle * 180) / Math.PI, wKt) * SPEED_SCALE * Math.pow(b.windF || 1, 0.8) * b.skill * 0.82;
    const tau = 2.6, v0 = Math.max(0, b.v * 0.85);
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

  // 指定ワールド座標(wx, wz)が他艇のブランケット(風影)に入っているか推定(0..1)
  estimateCoverAt(wx, wz) {
    const b = this.b;
    let cov = 0;
    for (const A of this.others) {
      if (A === b || A.dsq || A.finished) continue;
      const rx = wx - A.x, rz = wz - A.z;
      const d2 = rx * rx + rz * rz;
      if (d2 > 38 * 38) continue;
      const twx = -Math.sin(A.windFrom), twz = Math.cos(A.windFrom);
      const ax = A.awx * 0.65 + twx * 0.35, az = A.awz * 0.65 + twz * 0.35;
      const al = Math.hypot(ax, az) || 1;
      const ux = ax / al, uz = az / al;
      const along = rx * ux + rz * uz;
      if (along > 0.8 && along < 34) {
        const lat = Math.abs(-rx * uz + rz * ux);
        const half = 2.2 + along * 0.25;
        if (lat < half) {
          const s = (1 - along / 34) * (1 - lat / half);
          cov = Math.max(cov, s);
        }
      }
    }
    return cov;
  }

  // タック/ジャイブ先がクリーンエアーで、かつ周囲の権利艇(特にスタボ艇)と衝突コースにならないか厳密に検証
  canTackCleanly(kind = 'tack', allowSlightDirty = false) {
    const b = this.b, W = b.windFrom;
    if (this.nearObstacle(8.5)) return false;
    const newTack = -b.tack;
    const ang = kind === 'tack' ? this.closeAngle : this.runAngle;
    const hNew = wrap(W - newTack * ang);
    const fx = Math.sin(hNew), fz = -Math.cos(hNew);
    const spd = Math.max(b.v, 2.2);
    for (const o of this.others) {
      if (o === b || o.finished || o.dsq) continue;
      const dx = o.x - b.x, dz = o.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d < 5.6) return false;
      // ポートタックへ返る場合、接近中のスターボード艇との交差距離を広めに確保(Rule 10 衝突防止)
      const isPortVsStbd = kind === 'tack' && newTack === -1 && o.tack === 1;
      const maxCheckD = isPortVsStbd ? 28 : 18;
      if (d < maxCheckD) {
        const vx = fx * spd, vz = fz * spd;
        const vo = Math.max(o.v, 1.5);
        const dvx = Math.sin(o.h) * vo - vx, dvz = -Math.cos(o.h) * vo - vz;
        const dv2 = dvx * dvx + dvz * dvz || 1e-6;
        const tca = clamp(-(dx * dvx + dz * dvz) / dv2, 0, isPortVsStbd ? 6.8 : 4.8);
        const cpa = Math.hypot(dx + dvx * tca, dz + dvz * tca);
        if (cpa < (isPortVsStbd ? 5.6 : 4.2)) return false;
      }
    }
    const c3 = this.estimateCoverAt(b.x + fx * spd * 3.4, b.z + fz * spd * 3.4);
    const c6 = this.estimateCoverAt(b.x + fx * spd * 6.5, b.z + fz * spd * 6.5);
    const lim = allowSlightDirty ? 0.28 : 0.14;
    return c3 < lim && c6 < lim;
  }

  // ブランケット脱出判定: タック先またはジャイブ先がブランケットでなく、かつ他艇と衝突しないならtrue
  canEscapeBlanket(kind) {
    const b = this.b;
    const curLoss = Math.max(b.cover, b.back);
    if (!this.canTackCleanly(kind, false)) return false;
    const W = b.windFrom, newTack = -b.tack;
    const ang = kind === 'tack' ? this.closeAngle : this.runAngle;
    const hNew = wrap(W - newTack * ang);
    const fx = Math.sin(hNew), fz = -Math.cos(hNew), spd = Math.max(b.v, 2.2);
    const c4 = this.estimateCoverAt(b.x + fx * spd * 3.8, b.z + fz * spd * 3.8);
    const c7 = this.estimateCoverAt(b.x + fx * spd * 7.0, b.z + fz * spd * 7.0);
    return Math.max(c4, c7) < curLoss * 0.50;
  }

  // 目標点(a,c)へ向かうヘディング(風上ならタック、風下ならジャイブ)
  headingFor(tgt, t, prestart, directDownwind = false) {
    const b = this.b, W = b.windFrom;
    const tw = toWorld(tgt.a, tgt.c);
    const brg = this.bearing(tw.x, tw.z);
    const relT = wrap(W - brg);
    const ca = this.closeAngle;
    const ra = this.runAngle;
    // 下レグ(目標が真風角raより深い場合): 180°で走らず164°〜170°を維持し、レイラインに達したらジャイブする
    if (!prestart && !directDownwind && Math.abs(relT) > ra && Math.hypot(tgt.a - b.a, tgt.c - b.c) > 22) {
      const hs = wrap(W - ra), hp = wrap(W + ra);
      const cs = Math.cos(wrap(hs - brg)), cp = Math.cos(wrap(hp - brg));
      if (t - this.lastTack > 14 && !this.crowded(6.5) && !this.nearObstacle(8) && this.canTackCleanly('gybe', true)) {
        if (b.tack === 1 && cp > cs + 0.045) { this.lastTack = t; b.startManeuver('gybe'); }
        else if (b.tack === -1 && cs > cp + 0.045) { this.lastTack = t; b.startManeuver('gybe'); }
      }
      return wrap(W - b.tack * ra);
    }
    // マークへの直進が可能な角度か判定
    if (Math.abs(relT) > ca + 0.03) return brg;

    // ビーティング: レイライン到達時は無駄に外へ突き抜けず速やかにタックし、中盤の戦術タック時はタック先がブランケットや衝突コースでないことを確認する
    const da = tgt.a - b.a, dc = b.c - tgt.c;
    const tackNow = b.tack;
    const dtTack = t - this.lastTack;
    const layCool = dtTack > (prestart ? 11 : 7.0);
    const midCool = dtTack > (prestart ? 15 : this.tackCool);
    let wantTack = false, isMustTack = false;
    if (da > 5 && layCool) {
      const lay = da * Math.tan(ca) * (1 + this.layMargin);
      if (tackNow === 1 && dc <= -lay) { wantTack = true; isMustTack = true; }
      if (tackNow === -1 && dc >= lay) { wantTack = true; isMustTack = true; }
      // 海面端のデッドコーナーへ突っ込み続けるのを防止
      if (!prestart && ((tackNow === 1 && b.c < -135) || (tackNow === -1 && b.c > 135))) {
        wantTack = true; isMustTack = true;
      }
      if (!prestart && !wantTack && midCool) {
        const weight = clamp((da - 42) / 135, 0, 1);
        const centerC = tgt.c + this.prefSideC * weight;
        const halfW = this.corridorHalf * (0.55 + 0.45 * weight);
        const corridorL = Math.max(-128, centerC - halfW);
        const corridorR = Math.min(128, centerC + halfW);
        if (tackNow === 1 && b.c < corridorL) wantTack = true;
        if (tackNow === -1 && b.c > corridorR) wantTack = true;
        // 風が弱い不利海面を逆方向へ走り続けている場合や、シフトで反対タックが明確にリフトしている場合は戦術タック
        if (t > this.vmgAt) {
          this.vmgAt = t + 18 + this.rng() * 14;
          const hs = W - ca, hp = W + ca;
          const cs = Math.cos(wrap(hs - brg)), cp = Math.cos(wrap(hp - brg));
          const aheadX = b.x + Math.sin(b.h) * 45, aheadZ = b.z - Math.cos(b.h) * 45;
          const oppH = wrap(W + tackNow * ca);
          const oppX = b.x + Math.sin(oppH) * 45, oppZ = b.z - Math.cos(oppH) * 45;
          const wAhead = windAt(aheadX, aheadZ, this.wt ?? t).factor;
          const wOpp = windAt(oppX, oppZ, this.wt ?? t).factor;
          const windGain = (wOpp - wAhead) * 0.65;
          if (tackNow === 1 && (cp - cs + windGain) > 0.14) wantTack = true;
          if (tackNow === -1 && (cs - cp + windGain) > 0.14) wantTack = true;
        }
      }
    }
    if (wantTack && !this.crowded(isMustTack ? 5.2 : 6.8) && !this.nearObstacle(8)) {
      if (isMustTack || this.canTackCleanly('tack', false)) {
        this.lastTack = t;
        if (!isMustTack) this.prefSideC = clamp(b.c + b.tack * 48, -110, 110);
        b.startManeuver('tack');
      }
    }
    return wrap(W - b.tack * ca);
  }

  crowded(rad = 8.5) {
    const b = this.b, r2 = rad * rad;
    const pre = (this.now ?? 0) < 0;
    for (const o of this.others) {
      if (o === b || o.finished || o.dsq) continue;
      if (pre && o.isPlayer) continue; // プリスタート中は自艇の位置に関係なくスタートラインへ並ぶ
      const dx = o.x - b.x, dz = o.z - b.z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  // 半径R[m]以内にマーク・運営艇があるか
  nearObstacle(R) {
    const b = this.b;
    for (const o of OBSTACLES) {
      const dx = o.x - b.x, dz = o.z - b.z, rr = R + o.r;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  }

  // ---------- マーク回航プラン (すべて確実に左舷回航 = 反時計回り) ----------
  buildRounding(L) {
    const m = L.mark, rIn = this.roundR, rOut = this.roundROut, ca = this.closeAngle;
    const right = (d) => ({ c: d.a, a: -d.c });
    const ri = right(L.dirIn), ro = right(L.dirOut);
    const th1 = Math.atan2(ri.a, ri.c);
    let th2 = Math.atan2(ro.a, ro.c);
    while (th2 < th1 + 0.05) th2 += 2 * Math.PI;
    const beat = L.dirIn.a > 0.7;
    const ths = beat ? Math.max(th1, ca + 0.12) : th1 - 0.35;
    const entry = { c: m.c + rIn * Math.cos(ths), a: m.a + rIn * Math.sin(ths) };
    const e = { c: m.c + rOut * Math.cos(th2), a: m.a + rOut * Math.sin(th2) };
    const lay = beat ? { c: entry.c + 18 * Math.sin(ca), a: entry.a - 18 * Math.cos(ca) } : null;
    const exit = { c: e.c + L.dirOut.c * 14, a: e.a + L.dirOut.a * 14 };
    return { leg: L.id, m, r: rIn, rOut, ths, arc: th2 - ths, entry, e, lay, exit, phase: beat ? 'lay' : 'approach', beat, idx: 0 };
  }

  roundingTarget(L) {
    const b = this.b;
    if (!this.rp || this.rp.leg !== L.id) this.rp = this.buildRounding(L);
    const rp = this.rp, m = rp.m, rIn = rp.r, rOut = rp.rOut;
    const dc = b.c - m.c, da = b.a - m.a, dM = Math.hypot(dc, da);
    const thb = Math.atan2(da, dc);
    let uu = thb - rp.ths; // 反時計回りの進み具合(rad)
    uu = ((((uu + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI / 2;
    const dist = (p) => Math.hypot(b.c - p.c, b.a - p.a);
    const ca = this.closeAngle, t = this.now || 0;

    // 1マーク(上りマーク)の手前でマークより左側(dc < -1.5, da > -24, da < -1.5)にいるとき、
    // そのまま風上へ抜けるとマークの左側(逆回り)を通過してしまうため、マークの手前右側へ誘導する
    if (rp.beat && rp.phase !== 'orbit' && rp.phase !== 'exit' && da > -24 && da < -1.5 && dc < -1.5) {
      const safeRight = { c: m.c + rIn + 3.5, a: Math.min(m.a - 5.5, Math.max(b.a + 3, m.a - 12)) };
      if (b.tack === 1 && !b.maneuver && t - this.lastTack > 4.5 && !this.nearObstacle(6)) {
        // マークより左で右舷タック(さらに左へ進む)だと逆回りになるためポートへ返して右側へ出す
        this.lastTack = t;
        b.startManeuver('tack');
      }
      return safeRight;
    }

    if (rp.phase === 'lay') {
      if (dist(rp.lay) < 6 || (b.tack === 1 && b.c >= m.c + rIn * 0.6 && this.fetchable(rp.entry, 0))) rp.phase = 'approach';
      else return rp.lay;
    }
    if (rp.phase === 'approach' && rp.beat && !this.fetchable(rp.entry, -0.06) && dist(rp.entry) > 4.5) {
      rp.phase = 'lay2';
      if (b.tack === 1 && !b.maneuver && t - this.lastTack > 3) { this.lastTack = t; b.startManeuver('tack'); }
    }
    if (rp.phase === 'lay2') {
      if (b.c >= m.c + rIn * 0.65 && this.fetchable(rp.entry, 0.02)) {
        if (b.tack === -1 && !b.maneuver && t - this.lastTack > 3) { this.lastTack = t; b.startManeuver('tack'); }
        rp.phase = 'approach';
      } else {
        const pc = Math.sin(ca), pa = Math.cos(ca), sc = Math.sin(ca), sa = -Math.cos(ca);
        const rc = rp.entry.c - b.c, ra = rp.entry.a - b.a, det = pc * -sa - pa * -sc;
        const u = Math.abs(det) > 1e-6 ? (rc * -sa - ra * -sc) / det : 10;
        const k = Math.max(5, u + 4);
        return { c: b.c + pc * k, a: b.a + pa * k };
      }
    }
    if (rp.phase === 'approach') {
      // orbitへ入るのは必ずマークの正規進入側(uu > -0.45 かつ反時計回り側)に来たときのみ
      const onEntrySide = rp.beat ? (dc > 0 || da > 0) : true;
      if (onEntrySide && (dist(rp.entry) < 5.5 || (dM < 2.0 * rIn && uu > (rp.beat ? -0.30 : -0.95) && uu < rp.arc))) {
        rp.phase = 'orbit';
      } else {
        return rp.entry;
      }
    }
    if (rp.phase === 'orbit') {
      rp.idx = 1;
      if (uu >= rp.arc - 0.04) rp.phase = 'exit';
      else if (dM > 3.0 * rIn) { rp.phase = 'approach'; return rp.entry; }
      else {
        const prog = clamp(uu / Math.max(0.2, rp.arc), 0, 1);
        const rDes = rIn + (rOut - rIn) * Math.pow(prog, 0.85);
        const tc = -Math.sin(thb), ta = Math.cos(thb), nc = Math.cos(thb), na = Math.sin(thb);
        const k = clamp(((dM - rDes) / Math.max(2.2, rDes)) * 1.85, -1.2, 1.15);
        let vc = tc - k * nc, va = ta - k * na; const l = Math.hypot(vc, va) || 1; vc /= l; va /= l;
        return { c: b.c + vc * 14, a: b.a + va * 14 };
      }
    }
    // exit: course.js の updateProgress で b.leg がインクリメントされるまでは絶対に次マークへ飛ばず、
    // 現在のマークの反時計回り脱出方向(rp.exit)へ抜けて確実に回航判定を完了させる
    rp.idx = 2;
    if (dM > ROUND_R - 2) {
      // 万一まだ回航判定が完了していないのにマークから離れた場合はアプローチをやり直す
      this.rp = this.buildRounding(L);
      return this.rp.entry;
    }
    return rp.exit;
  }

  // ---------- 4ゲート(4S=gL / 4P=gR) 専用回航プラン ----------
  updateGateRounding(t) {
    const b = this.b, ca = this.closeAngle;
    // ゲートに近づく際(a > 62)、自分の横位置から自然に入れる側のゲートマークを選択
    if (b.a > 62) {
      if (b.c < -12) this.gateKey = 'gL';
      else if (b.c > 12) this.gateKey = 'gR';
    }
    const key = this.gateKey; // 'gL' (4S) or 'gR' (4P)
    const m = MARKS[key];
    const s = key === 'gL' ? -1 : 1;
    const reqTack = -s;

    if (!this.gateRp || this.gateRp.key !== key) {
      this.gateRp = {
        key,
        s,
        phase: 'approach',
      };
    }
    const gp = this.gateRp;
    // もし既にdoneになっていてもまだb.leg===2(ゲート未通過)ならapproachに戻して確実にゲート間を通過させる
    if (gp.phase === 'done' && b.leg === 2) {
      gp.phase = 'approach';
    }
    const dc = b.c - m.c, da = b.a - m.a;
    // ゲート内側のワイド進入点(マークの7.0m内側、a=45.0)
    const entry = { a: m.a + 5.0, c: m.c - s * 7.0 };
    const tightAbeam = { a: m.a + 0.4, c: m.c + s * 2.50 };
    const closeFollow = { a: m.a + 14.0, c: m.c + s * (2.50 + 13.6 * Math.tan(ca)) };

    if (gp.phase === 'approach') {
      if (b.a < 105 && b.a > 50 && b.tack !== reqTack && !b.maneuver && t - this.lastTack > 4 && !this.crowded(6.5)) {
        this.lastTack = t;
        b.startManeuver('gybe');
      }
      // ゲートの外側に膨らんでいる場合は必ずゲート内側へ戻してから通過する
      if (b.a < 60 && (b.c - m.c) * s > -2.5) {
        return { tgt: { a: Math.max(m.a + 5.5, b.a - 3), c: m.c - s * 8.0 }, direct: true, rounding: true };
      }
      if (b.a <= m.a + 5.2 && (b.c - m.c) * s <= 1.0) {
        gp.phase = 'orbit';
      } else {
        return { tgt: entry, direct: b.a < 115, rounding: b.a < 68 };
      }
    }

    if (gp.phase === 'orbit') {
      if (b.pole) b.setPole(false);
      const phi = Math.atan2(-da, -s * dc);
      if (s * dc > 1.2 && da >= -0.8) {
        gp.phase = 'tightExit';
      } else {
        const phiClamped = clamp(phi, -0.35, Math.PI);
        const phiNext = Math.min(Math.PI, Math.max(0.35, phiClamped + 0.52));
        const prog = clamp(phiNext / Math.PI, 0, 1);
        const rC = 2.50 + (7.0 - 2.50) * Math.pow(Math.cos(prog * Math.PI * 0.5), 1.4);
        const rA = 5.2;
        const tgtC = m.c - s * rC * Math.cos(phiNext);
        const tgtA = m.a - rA * Math.sin(phiNext);
        return { tgt: { a: tgtA, c: tgtC }, direct: true, rounding: true };
      }
    }

    if (gp.phase === 'tightExit') {
      if (b.pole) b.setPole(false);
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

  // 衝突回避: ポート艇がスタボ艇へ突っ込まないよう早期検知し、リーボータック(クリーンな位置へのタック)またはスターン通過(ベアアウェイ)で確実に回避する
  avoid(t, desired) {
    const b = this.b;
    if (t < this.avoidUntil) return this.avoidH;
    const CLEAR = 4.9, DETECT = 5.4;
    const vb = Math.max(b.v, 1.45);
    const cpaInfo = (h, o) => {
      const vx = Math.sin(h) * vb, vz = -Math.cos(h) * vb, vo = Math.max(o.v, 0.85);
      const dvx = Math.sin(o.h) * vo - vx, dvz = -Math.cos(o.h) * vo - vz;
      const dx = o.x - b.x, dz = o.z - b.z;
      const dv2 = dvx * dvx + dvz * dvz || 1e-6;
      const tca = clamp(-(dx * dvx + dz * dvz) / dv2, 0, 9.5);
      const cpa = Math.hypot(dx + dvx * tca, dz + dvz * tca);
      return { cpa, tca, d2: dx * dx + dz * dz };
    };
    const h0 = desired ?? b.h;
    const threats = [];
    const prestart = t < 0;
    for (const o of this.others) {
      if (o === b || o.finished || o.dsq) continue;
      const dx = o.x - b.x, dz = o.z - b.z;
      const d2 = dx * dx + dz * dz;
      // プリスタート中は自艇(isPlayer)がラインから離れていても絶対にそれにつられて針路を変えない(直前3.2mの接触回避のみ)
      if (prestart && o.isPlayer && d2 > 10.5) continue;
      if (d2 > (prestart ? 360 : 1444)) continue; // プリスタート中は19m以内、レース中は38m以内を監視
      const { cpa, tca } = cpaInfo(h0, o);
      const gw = giveWayBoat(b, o).gw;
      const isGiveWay = gw === b;
      const isPortVsStbd = b.tack === -1 && o.tack === 1;
      // 自艇がスタボ権利艇で相手がポート艇の場合は、相手が直前(6.2m以内・cpa<2.3m)まで避けない緊急時以外は針路を維持する
      if (!isGiveWay && b.tack === 1 && o.tack === -1 && (d2 > 38 || cpa > 2.3)) continue;
      const thresh = isGiveWay
        ? (prestart ? 3.8 : (isPortVsStbd ? 5.8 : DETECT))
        : (o.isPlayer ? (prestart ? 2.5 : 3.2) : 2.5);
      if (cpa < thresh && (tca > 0.05 || d2 < 36)) {
        threats.push({ o, isGiveWay, isPortVsStbd, cpa, tca, d2 });
      }
    }
    if (!threats.length) return null;

    // ポートタック走行中にスタボ艇と交差接近(7.5m〜22m)した際、スタボへ返してクリーンエアーで走れるなら早めにタックして回避
    const stbdThreat = threats.find((th) => th.isPortVsStbd && th.d2 > 56 && th.d2 < 484 && th.cpa < 5.0);
    if (!prestart && stbdThreat && b.tack === -1 && b.twa < 1.32 && !b.maneuver && !b.pole && t - this.lastTack > 9.5) {
      if (this.canTackCleanly('tack', false)) {
        this.lastTack = t;
        this.prefSideC = clamp(b.c - 42, -110, 110);
        b.startManeuver('tack');
        return null;
      }
    }

    const W = b.windFrom;
    const twa0 = Math.abs(wrap(W - h0));
    let best = null, bestScore = -1e9, bestMinCpa = 0;
    const maxStep = prestart ? 7 : 16;
    for (let i = 0; i <= maxStep; i++) {
      for (const s of i ? [1, -1] : [1]) {
        const dh = s * i * 0.082, h = wrap(h0 + dh);
        const twaH = Math.abs(wrap(W - h));
        if (twaH < 0.63) continue;
        // プリスタート中は回避で風下へベアアウェイしすぎてスタートラインから離れるのを防ぐ
        if (prestart && twaH > this.closeAngle + 0.25) continue;
        if (b.pole && twaH < POLE_MIN) continue;
        let minCpa = 99;
        for (const th of threats) {
          const { cpa } = cpaInfo(h, th.o);
          const wCpa = th.isGiveWay || th.o.isPlayer ? cpa : cpa + 0.6;
          if (wCpa < minCpa) minCpa = wCpa;
        }
        // ベアアウェイ判定: 真風角twaHが元針路twa0より広がる方向(ポートタックなら dh > 0、スタボタックなら dh < 0)がベアアウェイ(スターン通過)
        const isBearAway = twaH > twa0 + 0.01;
        const hasPortStbd = threats.some((th) => th.isPortVsStbd);
        // ポート艇がスタボ艇を避ける際は、風下へ落として相手のスターン(後ろ)を通る針路を強く優先し、風上へラフして相手バウへ突っ込む針路を禁止
        const duckBonus = hasPortStbd ? (isBearAway ? 3.2 : (dh !== 0 ? -6.5 : 0)) : 0;
        const base = minCpa >= CLEAR ? 100 - Math.abs(dh) * 7.5 + duckBonus : minCpa * 13 - Math.abs(dh) * 0.5 + duckBonus;
        const score = base - Math.max(0, 3.5 - this.markClear(h)) * 4.0;
        if (score > bestScore) { bestScore = score; best = h; bestMinCpa = minCpa; }
      }
    }
    // もし舵を切るだけではスタボ艇との衝突が避けられない(bestMinCpa < 2.6)かつ上りレグでポートタックなら、緊急タックして逃げる
    const hasCloseStbdThreat = threats.some((th) => th.isPortVsStbd && th.d2 > 9 && th.d2 < 256);
    if (hasCloseStbdThreat && bestMinCpa < 2.6 && b.tack === -1 && b.twa < 1.32 && !b.maneuver && !b.pole && t - this.lastTack > 7.5 && !this.nearObstacle(7.5)) {
      this.lastTack = t;
      b.startManeuver('tack');
      return null;
    }
    if (best !== null) { this.avoidUntil = t + 0.42; this.avoidH = best; }
    return best;
  }

  // ヘディングhで進んだ場合の前方15m以内の障害物との最小横距離
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

  // マーク・運営艇への接触を避ける (回航マークを逆回りしないようwrongSideペナルティを厳格化)
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
      const isRightRound = active === 'gL'; // 4S(gL)のみ右舷回航、他はすべて左舷回航
      for (const n of near) {
        if (n.o.key !== active) continue;
        const along = n.ox * fx + n.oz * fz, lat = n.ox * rx + n.oz * rz;
        if (along > -1 && along < 22) {
          if (!isRightRound && lat > 0 && lat < 14) return 25; // 左舷回航マークを右に見て通るのを強く禁止
          if (isRightRound && lat < 0 && lat > -14) return 25;
        }
      }
      return 0;
    };
    let best = heading, bestV = -1e9;
    for (let i = 1; i <= 12; i++) {
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
    const curOptDeg = b.bestCloseDeg || bestCloseDeg(BASE_WIND_KT * (b.windF || 1));
    this.closeAngle = (curOptDeg * Math.PI) / 180 + this.closeAngleOffset;
    if (b.maneuver) return;
    if (b.penalty) { b.steer = this.penDir; b.throttle = 1; return; }
    b.sheet = sheetOpt(b.twa);

    // ブランケット / バックウインド脱出判定 (タック先やジャイブ先もブランケットでない場合は脱出する)
    const dirtyStrength = Math.max(b.cover, b.back * 1.15);
    this.coverTime = dirtyStrength > 0.22
      ? (this.coverTime || 0) + dt * (0.65 + dirtyStrength * 1.35)
      : Math.max(0, (this.coverTime || 0) - dt * 1.4);
    const Lc = LEGS[Math.min(b.leg, LEGS.length - 1)];
    const nearMark = Lc && Lc.type === 'mark' && Math.hypot(b.c - Lc.mark.c, b.a - Lc.mark.a) < 38;
    const inGateRound = this.gateRp && this.gateRp.phase !== 'done';
    if (this.coverTime > 2.6 && t > 6 && t - this.lastTack > 16 && b.started && !b.ocs && !nearMark && !inGateRound) {
      if (b.twa < 1.42 && !b.pole && this.canEscapeBlanket('tack')) {
        this.lastTack = t;
        this.coverTime = 0;
        // 脱出後のタック方向に合わせて回廊中心もシフトし、直後にまた元のブランケットへ戻らないようにする
        this.prefSideC = clamp(b.c + b.tack * 65, -130, 130);
        b.startManeuver('tack');
        return;
      } else if (b.twa > 2.15 && this.canEscapeBlanket('gybe')) {
        this.lastTack = t;
        this.coverTime = 0;
        b.startManeuver('gybe');
        return;
      }
    }

    let heading;
    const prestart = t < 0;
    if (b.finished) {
      b.throttle = 0.5;
      if (b.pole) b.setPole(false);
      heading = this.headingFor(COURSE_MODE === 'upwind' ? { a: 665, c: 55 } : { a: -170, c: -40 }, t, false);
    } else if (prestart) {
      const W = b.windFrom;
      const role = b.startRole || 'firstRow';
      if (role === 'highComFail') {
        // 本部船の上(風上・右側 c > LINE_HALF)で待機し、スペースを失ってスタートに失敗→本部船スターン側へ落として第二線から出るCP艇
        if (t < -3.2) {
          const waitA = MARKS.com.a - 1.5;
          const waitC = LINE_HALF + 4.2;
          const distA = waitA - b.a;
          b.throttle = distA > 3.5 ? 0.52 : 0.08;
          b.sheet = distA > 3.5 ? sheetOpt(b.twa) : 0.14;
          const holdAng = clamp(this.closeAngle + (b.c - waitC) * 0.03, this.closeAngle - 0.05, this.closeAngle + 0.18);
          heading = wrap(W - b.tack * holdAng);
          if (b.tack === -1 && (b.c > LINE_HALF + 10 || t > -14) && t - this.lastTack > 8) {
            this.lastTack = t;
            b.startManeuver('tack');
          }
        } else {
          // 号砲直前に本部船に阻まれて入れず、本部船の後ろ(風下側 a = MARKS.com.a - 7.5, c = LINE_HALF - 6)へベアして回り込む
          b.throttle = 0.85;
          b.sheet = sheetOpt(b.twa);
          const sternW = toWorld(MARKS.com.a - 7.5, LINE_HALF - 6.0);
          heading = this.bearing(sternW.x, sternW.z);
        }
      } else {
        // プリスタート: 強いCP艇は上側の端っこ(本部船すぐ内側)や有利端からも確実にスタートできるよう、
        // 本部船よりも右側(c > LINE_HALF)からスターボードタックでアプローチして本部船スターンをかわして上端へ入る
        const tgtC = clamp(this.targetStartC ?? 0, -LINE_HALF + 5, LINE_HALF - 3.8);
        const lineAtTgt = lineA(tgtC);
        const lineHere = lineA(clamp(b.c, -LINE_HALF, LINE_HALF));
        const targetLineA = b.c > LINE_HALF - 7 ? lineAtTgt : Math.min(lineHere, lineAtTgt + 2.5);
        const gap = targetLineA - b.a;
        const posGap = Math.max(0, gap);
        const tw = Math.min(b.twa, 1.1);
        const upf = Math.max(0.48, Math.cos(tw) + Math.tan(LINE_SKEW) * Math.sin(tw) * b.tack);
        if (this.gap0 === null) this.gap0 = Math.max(16, posGap);
        const holdDist = role === 'secondRow' ? 11.2 : 5.6;
        if (!this.go && t >= this.tc - this.runUpTime(posGap / upf) && (t > -9.5 || posGap > holdDist + 3.0)) this.go = true;
        if (gap < holdDist + 0.4 && t < (role === 'secondRow' ? -0.4 : -2.2)) this.go = false; // 加速スペースを残して早すぎるライン接近を防止
        if (this.go) {
          b.throttle = 1;
          b.sheet = sheetOpt(b.twa);
        } else if (gap < holdDist && t < (role === 'secondRow' ? -0.4 : -2.2)) {
          // ラインから少し離れた待機ライン(1列目は5.6m〜、第二線組は11.2m〜手前)でセールを出してシバー待機し、十分な加速スペースを残す
          b.throttle = 0.04;
          b.sheet = 0.10;
        } else {
          const vT = polar((this.closeAngle * 180) / Math.PI) * SPEED_SCALE * Math.pow(b.windF || 1, 0.8) * b.skill;
          const goL = Math.min(this.goDist, this.gap0);
          const tGo = this.tc - this.runUpTime(goL / upf);
          const span = Math.max(5, tGo - START_T);
          const f = clamp((t - START_T) / span, 0, 1), p = this.creepExp;
          const D = goL + Math.max(0, this.gap0 - goL) * (1 - Math.pow(f, p));
          const dDdt = (Math.max(0, this.gap0 - goL) * p * Math.pow(Math.max(f, 1e-3), p - 1)) / span;
          // 低速時の下流れ(2倍リーウェイ＋風圧ドリフト)で後ろ(-a)に流されないようドリフト補償速度を加算
          const driftComp = posGap > D - 1.2 ? 0.92 * SPEED_SCALE * (b.windF || 1) : 0;
          const vDes = Math.max(0, dDdt + 0.48 * (posGap - D) + driftComp) / upf;
          b.throttle = posGap < D - 1.0
            ? clamp(vDes / Math.max(0.1, vT), 0.10, 0.36)
            : clamp(vDes / Math.max(0.1, vT), 0.44, 0.96);
          // セールは待機距離(D)よりラインに近いときだけ緩めて減速し、通常アプローチ中は最適トリムで下流れを抑える
          b.sheet = posGap < D - 1.0
            ? Math.max(0.14, sheetOpt(b.twa) - 0.36)
            : sheetOpt(b.twa);
        }
        // スターボードタック(左進)で号砲時に見込まれる横座標cPred (残り時間の下流れ＋前進による左移動を考慮)
        const driftLeft = Math.max(0, -t - 8) * 0.16;
        const cPred = b.c - posGap * Math.tan(this.closeAngle) * 0.90 - driftLeft;
        let preAngle = this.closeAngle;
        if (b.tack === 1) {
          // 目標tgtCより右(+c)に余裕がある時は少しだけベアして左へ流し、左(-c)へ流れすぎそうな時は少しピンチして上側を維持
          preAngle = clamp(this.closeAngle + (cPred - tgtC) * 0.012, this.closeAngle - 0.06, this.closeAngle + 0.14);
          if (b.c > LINE_HALF - 2.5 && b.a > MARKS.com.a - 5.0) {
            // 本部船のすぐ真下に迫った時だけ少しベアして本部船の左(ライン内側)へかわす
            preAngle = Math.max(preAngle, this.closeAngle + 0.22);
          }
        }
        heading = wrap(W - b.tack * preAngle);
        if (t - this.lastTack > 9) {
          let wantTack = false;
          // 右舷タック(左へ進む)で目標tgtCより大きく左へ流れすぎた場合のみポートに返して上側(右/+c)へ上り直す
          if (b.tack === 1 && (b.c < -LINE_HALF + 6 || (t < -15 && cPred < tgtC - 9))) wantTack = true;
          // 左舷タック(右へ進む): 目標レイラインに戻ったか残り10秒を切ったら必ずスターボードタックへ返す
          const maxPortC = tgtC >= 30 ? LINE_HALF + 24 : LINE_HALF - 5;
          if (b.tack === -1 && (b.c > maxPortC || cPred >= tgtC + 2 || t > -10.5)) wantTack = true;
          const crowdLim = (b.tack === -1 && t > -11) ? 3.2 : 5.5;
          if (wantTack && !this.crowded(crowdLim) && !this.nearObstacle(6.5)) { this.lastTack = t; b.startManeuver('tack'); }
        }
      }
    } else if (b.ocs) {
      b.throttle = 1;
      if (b.pole) b.setPole(false);
      const returnC = clamp(b.c, -LINE_HALF + 6, LINE_HALF - 6);
      heading = this.headingFor({ a: lineA(returnC) - 14, c: returnC }, t, false, true);
    } else if (!b.started) {
      // まだスタートライン(ピン〜本部船の間)を切っていない艇は、必ずライン内側を通過してからコースへ出る
      b.throttle = 1;
      if (b.pole) b.setPole(false);
      const crossC = clamp(this.targetStartC ?? b.c, -LINE_HALF + 5, LINE_HALF - 5);
      const la = lineA(crossC);
      if (b.c > LINE_HALF - 2.0 && b.a > MARKS.com.a - 5.5) {
        // 本部船の上側でスタート失敗した艇が本部船のスターン側(風下・内側)をかわして第二線からスタートする
        const sternW = toWorld(MARKS.com.a - 7.2, LINE_HALF - 6.5);
        heading = this.bearing(sternW.x, sternW.z);
      } else if (b.a > la - 1.5 && Math.abs(b.c) > LINE_HALF) {
        // ラインの横外側に出てしまっている場合は一度ライン手前内側へ戻る
        heading = this.headingFor({ a: la - 10, c: clamp(b.c, -LINE_HALF + 8, LINE_HALF - 8) }, t, false, true);
      } else {
        heading = this.headingFor({ a: la + 12, c: crossC }, t, false);
      }
    } else {
      b.throttle = 1;
      const L = LEGS[Math.min(b.leg, LEGS.length - 1)];
      let tgt, rounding = false, distMark, directDownwind = false;
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
      // リーチング(真風角60°〜136°付近・マークから十分離れている区間)での「上し合い(ラフマッチ)」戦術:
      // 前後に密着した展開では、後ろの艇がラフ(のぼす)して艇速を上げながら風上へ登り前の艇をブランケットに入れようとし、
      // 前の艇も抜かれないよう対抗してラフする「上し合い」を再現
      const W = b.windFrom;
      const twaBrg = Math.abs(wrap(W - heading));
      let wantLuff = 0;
      if (!rounding && !directDownwind && distMark > 32 && twaBrg >= 1.05 && twaBrg <= 2.38) {
        const ux = Math.sin(heading), uz = -Math.cos(heading);
        const wx = Math.sin(W), wz = -Math.cos(W); // 風上方向ベクトル
        for (const o of this.others) {
          if (o === b || o.finished || o.dsq || o.leg !== b.leg) continue;
          const dx = o.x - b.x, dz = o.z - b.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > 18 * 18) continue;
          const ahead = dx * ux + dz * uz;
          const windLat = dx * wx + dz * wz;
          if (this.luffAggro > 0.42 && ahead > 1.0 && ahead < 16.0 && windLat > -6.5 && windLat < 5.5) {
            // 1) 直前に他艇がいる後続艇: ラフして艇速を伸ばし、風上側を奪って前の船をブランケットに入れようと仕掛ける
            const prox = 1 - ahead / 16.0;
            wantLuff = Math.max(wantLuff, (0.14 + 0.14 * this.luffAggro) * (0.65 + 0.35 * prox));
          } else if (ahead < -0.5 && ahead > -15.5 && windLat > -3.2 && windLat < 7.0) {
            // 2) 直後に迫る後続艇がいる先行艇: 後ろの船が風上へ上して被せようとしてきたら対抗して上し合い(ディフェンスラフ)を行う
            const oTwa = Math.abs(wrap(W - o.h));
            const attackerLuffing = oTwa < twaBrg - 0.03 || windLat > 0.5;
            if (attackerLuffing || this.luffAggro > 0.45) {
              const prox = 1 - Math.abs(ahead) / 15.5;
              wantLuff = Math.max(wantLuff, (0.13 + 0.12 * Math.max(0.45, this.luffAggro)) * (0.65 + 0.35 * prox));
            }
          }
        }
      }
      this.luffMatch += (wantLuff - (this.luffMatch || 0)) * (1 - Math.exp(-dt * 2.8));
      if (this.luffMatch > 0.015) {
        const minReachTwa = 1.08; // 62°未満には上りすぎず、最速のリーチング角度帯(62°〜95°)を使って加速する
        const maxUp = Math.max(0, twaBrg - minReachTwa);
        const dH = Math.min(this.luffMatch, maxUp);
        heading = wrap(heading + b.tack * dH);
        b.sheet = sheetOpt(Math.abs(wrap(W - heading)));
      }
      this.updatePole(dt, heading, distMark, rounding);
    }
    const av = prestart ? this.avoid(t, heading) : this.avoid(t, heading);
    if (av !== null && av !== undefined) heading = av;
    heading = this.avoidMarks(heading, prestart);
    const err = wrap(heading - b.h);
    const steerGain = av !== null && av !== undefined ? 4.2 : 2.6;
    b.steer = clamp(err * steerGain, -1, 1);
    if (b.maneuver) b.steer = 0;
  }
}

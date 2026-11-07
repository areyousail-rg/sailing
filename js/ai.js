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
    const skillGap = clamp(1.10 - (b.skill || 1), 0, 0.28);
    // クローズホールド角度: 上位艇はベスト角度に近く、中〜下位艇は少し角度が甘くなる個性差
    this.closeAngleOffset = (((rng() - 0.25) * 2.1 + skillGap * (5.2 + rng() * 4.5)) * Math.PI) / 180;
    this.closeAngle = (bestCloseDeg(BASE_WIND_KT) * Math.PI) / 180 + this.closeAngleOffset;
    // ランニング角度(下レグで180°の真後ろではなく164°〜170°付近を走行してVMGを稼ぐ)
    this.runAngle = ((164.0 + rng() * 6.0) * Math.PI) / 180;
    this.targetStartC = b.startTargetC ?? b.c;
    // コースのばらつき: 有利サイド(SIDE_BIAS)も考慮しつつ、RRSプロパーコース(レイライン円錐)から大きく外れない適度な回廊幅に制限
    // スタート狙い位置(targetStartC)と逆側へ極端に引っ張られないようバランスよく配置
    const slotSpread = (((b.id * 3) % 7) - 3) / 3; // -1 .. +1
    const biasShift = clamp((SIDE_BIAS || 0) * 18, -16, 16);
    this.prefSideC = clamp(slotSpread * 34 + biasShift + (rng() - 0.5) * 16, -54, 54);
    this.corridorHalf = 22 + rng() * 14;
    this.cLim = 76 + rng() * 10;
    this.tackCool = 18 + rng() * 13; // 中盤の戦術タック間隔(レイライン到達時は別途即座にタック可能)
    this.lastTack = -99;
    // ラインを切る目標時刻(号砲=0秒の後):
    // 1分前は後ろの待機位置からアプローチし、0秒時点で大体の艇が「スタートラインぎりぎり(リコールしない直前)」から0秒で飛び出せるように設定
    const isStrong = (b.skill || 1) >= 1.03;
    const role = b.startRole || 'firstRow';
    // CP艇がスタートラインをフライング(OCS)する確率は約1割(10%)に制御し、残りのCP艇は0:00時点でラインぎりぎり手前に収める
    this.willOcs = (b.id === 2 && rng() < 0.12);
    if (role === 'gapShooter') {
      this.tc = 0.35 + rng() * 0.55;
      this.goDist = 9.2 + rng() * 2.2;
      this.baseStartC = this.targetStartC;
      this.nextGapScanT = -26 + rng() * 2.0;
    } else if (role === 'secondRow') {
      this.tc = 1.65 + rng() * 1.35;
      this.goDist = 10.5 + rng() * 2.8;
    } else if (role === 'highComFail') {
      this.tc = 3.2 + rng() * 1.8;
      this.goDist = 11.0 + rng() * 2.5;
    } else if (this.willOcs) {
      this.tc = -2.2 - rng() * 0.8;
      this.goDist = 4.5 + rng() * 1.2;
    } else {
      this.tc = isStrong
        ? 0.12 + rng() * 0.38
        : 0.25 + rng() * 0.55 + skillGap * 0.8;
      // 加速開始距離: ライン手前 6.0〜8.2m からフル加速し、0秒でラインぎりぎり手前に到達する
      this.goDist = 6.0 + rng() * 2.2;
    }
    this.go = false;
    this.pinBailout = false;
    // レイライン余白を抑え、オーバースタンド(レイラインを大きく超えて不利な位置を走り続ける現象)を防止
    this.layMargin = 0.010 + rng() * 0.032 + skillGap * 0.035;
    this.penDir = rng() < 0.5 ? 1 : -1;
    this.jit = (rng() - 0.5) * 14;
    this.vmgAt = 12 + rng() * 16;
    this.creepExp = 1.15 + rng() * 0.45;
    this.gap0 = null;
    this.avoidUntil = -999; this.avoidH = 0;
    this.roundR = 6.4 + rng() * 1.1; // マーク進入半径(ワイドイン)
    this.roundROut = 2.50;            // マーク脱出半径(タイトアウト)
    this.rp = null;
    // 4ゲート(4S=gL / 4P=gR)
    this.gateKey = b.id % 2 === 0 ? 'gL' : 'gR';
    this.gateRp = null;
    this.poleT = 0;
    this.coverTime = 0;
    // 戦術的に賢い上位〜中上位CP艇かどうか(上レグの抑えのタック・下レグのブランケット意識を実行)
    this.isTacticalStrong = (b.skill || 1) >= 0.99;
    // リーチングで前後に密着した際に後ろから上してブランケットを仕掛けたり対抗する積極性(一部CP艇が積極的に仕掛ける)
    this.luffAggro = (b.id % 3 !== 0 || rng() < 0.65) ? 0.58 + rng() * 0.42 : 0.20;
    this.luffMatch = 0;
    this.mustReturnBelowLine = false;
  }

  // タックを実行した瞬間に周囲の艇と接触・衝突しないかを厳密に検証 (回頭中0.4s〜3.0sの軌道シミュレーション)
  // 「絶対にタックできない場面(タックしたらすぐぶつかる場面)」での無理なタックを完全に禁止する
  canExecuteTackNow(duckRelOverride = null) {
    const b = this.b;
    if (b.maneuver || b.pole) return false;
    if (this.nearObstacle(6.0)) return false;
    if (!this.others) return true;
    const W = b.windFrom;
    const newTack = -(b.tack || 1);
    const relNew = duckRelOverride !== null ? duckRelOverride : newTack * this.closeAngle;
    const hNew = wrap(W - relNew);
    const hMid = wrap(W);
    const fx0 = Math.sin(b.h), fz0 = -Math.cos(b.h);
    const fxM = Math.sin(hMid), fzM = -Math.cos(hMid);
    const fx1 = Math.sin(hNew), fz1 = -Math.cos(hNew);
    const spd = Math.max(b.v, 1.85);
    const pre = (this.now ?? 0) < 0;

    for (const o of this.others) {
      if (o === b || o.dsq) continue;
      if (pre && o.isPlayer && Math.hypot(o.x - b.x, o.z - b.z) > 6.5) continue;
      const dx = o.x - b.x, dz = o.z - b.z;
      const d = Math.hypot(dx, dz);
      const isPortToStbdRightOfWay = !pre && newTack === -1 && o.tack === 1 && !o.finished;
      if (d > (isPortToStbdRightOfWay ? 25 : 22)) continue;
      // 同タックで自艇の風下側(タック回頭方向と逆側)に並走している相手からはタックによって離れるため、風上側の艇から順にタックできるよう許可する
      const isLeewardSameTack = o.tack === b.tack && (o.c - b.c) * (b.tack || 1) < -0.6 && (dx * fx0 + dz * fz0) < 2.2;
      if (d < (isLeewardSameTack ? 2.15 : 3.95)) return false;
      if (isLeewardSameTack) continue;

      const vo = o.postFinishStop ? 0 : Math.max(o.v, 1.1);
      const fox = Math.sin(o.h), foz = -Math.cos(o.h);
      const isDuckTack = duckRelOverride !== null;
      const minClear = o.isPlayer ? 4.6 : (isPortToStbdRightOfWay ? (isDuckTack ? 3.45 : 4.35) : 3.70);
      const simSteps = isPortToStbdRightOfWay ? (isDuckTack ? [0.5, 1.0, 1.6, 2.2] : [0.5, 1.0, 1.6, 2.2, 2.8]) : [0.5, 1.0, 1.6, 2.2];

      // タック回頭中およびタック直後の自艇予測位置と相手艇予測位置の距離を検証
      for (const dtSim of simSteps) {
        let bxSim, bzSim;
        if (dtSim <= 1.6) {
          const u = dtSim / 1.6;
          const turnSpd = spd * 0.78;
          const dirX = fx0 * (1 - u) + fxM * (u * 0.5) + fx1 * (u * 0.5);
          const dirZ = fz0 * (1 - u) + fzM * (u * 0.5) + fz1 * (u * 0.5);
          const dl = Math.hypot(dirX, dirZ) || 1;
          bxSim = b.x + (dirX / dl) * turnSpd * dtSim;
          bzSim = b.z + (dirZ / dl) * turnSpd * dtSim;
        } else {
          const turnDist = spd * 0.78 * 1.6;
          const dirX = fx0 * 0.35 + fxM * 0.30 + fx1 * 0.35;
          const dirZ = fz0 * 0.35 + fzM * 0.30 + fz1 * 0.35;
          const dl = Math.hypot(dirX, dirZ) || 1;
          const postDt = dtSim - 1.6;
          bxSim = b.x + (dirX / dl) * turnDist + fx1 * (spd * 0.86) * postDt;
          bzSim = b.z + (dirZ / dl) * turnDist + fz1 * (spd * 0.86) * postDt;
        }
        const oxSim = o.x + fox * vo * dtSim;
        const ozSim = o.z + foz * vo * dtSim;
        if (Math.hypot(oxSim - bxSim, ozSim - bzSim) < minClear) {
          return false;
        }
      }
    }
    return true;
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

  // スターボード(tack=1)からポート(newTack=-1)へタックした際に、近くのスターボード権利艇と衝突・接近するか検証
  hasStbdTackConflict(isOverstoodLay = false) {
    const b = this.b, W = b.windFrom;
    const hPort = wrap(W + this.closeAngle);
    const fx = Math.sin(hPort), fz = -Math.cos(hPort);
    const spd = Math.max(b.v * 0.85, 2.0);
    // タック回頭中(約1.6秒)に風上・前方へ約2.4m進むオフセットも考慮して両方検証
    const turnOffX = Math.sin(W) * 2.2 + Math.sin(b.h) * 1.4;
    const turnOffZ = -Math.cos(W) * 2.2 - Math.cos(b.h) * 1.4;
    for (const o of this.others) {
      if (o === b || o.finished || o.dsq || o.tack !== 1) continue;
      const dx = o.x - b.x, dz = o.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d > (isOverstoodLay ? 20 : 26)) continue;
      // 自分より左側(o.c < b.c - 0.8)にいてスタボで左へ離れていく艇は、自分がポート(右進行)へタックしても遠ざかるだけなので直近3.8m以外除外
      if (o.c < b.c - 0.8 && d > 3.8) continue;
      if (d < (isOverstoodLay ? 4.4 : 6.4) && o.c >= b.c - 0.8) return o;
      const vo = Math.max(o.v, 1.6);
      const vox = Math.sin(o.h) * vo, voz = -Math.cos(o.h) * vo;
      const minSafeCpa = o.isPlayer ? 6.5 : (isOverstoodLay ? 4.3 : 5.2);
      for (const [ox0, oz0, tOff, sMul] of [[0, 0, 0, 1.0], [0, 0, 0, 0.78], [turnOffX, turnOffZ, 1.3, 0.92]]) {
        const rx = (dx + vox * tOff) - ox0, rz = (dz + voz * tOff) - oz0;
        const vx = fx * spd * sMul, vz = fz * spd * sMul;
        const dvx = vox - vx, dvz = voz - vz;
        const dv2 = dvx * dvx + dvz * dvz || 1e-6;
        const tca = clamp(-(rx * dvx + rz * dvz) / dv2, 0, isOverstoodLay ? 4.5 : 5.8);
        const cpa = Math.hypot(rx + dvx * tca, rz + dvz * tca);
        if (cpa < minSafeCpa) return o;
      }
    }
    return null;
  }

  // 仕方なくスタボからポートへタックせざるを得ない場面で、タック後に角度を落として(ベアアウェイして)全スタボ艇のスターン(後ろ)を安全に通過できる目標relNewを探索
  // 通過できない位置関係(スタボ艇が近すぎる・スタボ艇のバウ前方を横切ってしまう位置)なら null を返し、タック自体を禁止する
  findPostTackDuckAngle(isOverstoodLay = false) {
    const b = this.b, W = b.windFrom, ca = this.closeAngle;
    const spd = Math.max(b.v * 0.82, 1.95);
    const turnOffX = Math.sin(W) * 2.0 + Math.sin(b.h) * 1.2;
    const turnOffZ = -Math.cos(W) * 2.0 - Math.cos(b.h) * 1.2;
    const stbdBoats = [];
    for (const o of this.others) {
      if (o === b || o.finished || o.dsq || o.tack !== 1) continue;
      const d = Math.hypot(o.x - b.x, o.z - b.z);
      if (d > (isOverstoodLay ? 19 : 25)) continue;
      if (o.c < b.c - 0.8 && d > 3.8) continue;
      // 直近右側にスタボ艇がいる場合は、タック中にぶつかるため絶対にタックしない
      const minImmediateD = isOverstoodLay ? 4.1 : 5.6;
      if (d < minImmediateD && o.c >= b.c - 0.8) return null;
      stbdBoats.push(o);
    }
    if (!stbdBoats.length) return -ca;
    for (const extra of [0.18, 0.28, 0.38, 0.48, 0.58]) {
      const duckAng = ca + extra;
      const hDuck = wrap(W + duckAng);
      const fx = Math.sin(hDuck), fz = -Math.cos(hDuck);
      const vx = fx * spd, vz = fz * spd;
      let allSafe = true;
      for (const o of stbdBoats) {
        const vo = Math.max(o.v, 1.6);
        const fox = Math.sin(o.h), foz = -Math.cos(o.h);
        const vox = fox * vo, voz = foz * vo;
        // タック回頭完了時点(約1.3秒後)での相手スタボ艇の位置と自艇の位置を揃えて比較
        const rx = (o.x + vox * 1.3) - (b.x + turnOffX), rz = (o.z + voz * 1.3) - (b.z + turnOffZ);
        const dvx = vox - vx, dvz = voz - vz;
        const dv2 = dvx * dvx + dvz * dvz || 1e-6;
        const tca = clamp(-(rx * dvx + rz * dvz) / dv2, 0, isOverstoodLay ? 4.2 : 5.4);
        const cpa = Math.hypot(rx + dvx * tca, rz + dvz * tca);
        // 最接近時に自艇bがスタボ艇oの進行方向基準でどこにいるか(負=oのスターン後方、正=oのバウ前方)
        const bRelOx = -rx - dvx * tca;
        const bRelOz = -rz - dvz * tca;
        const alongO = bRelOx * fox + bRelOz * foz;
        const minCpa = isOverstoodLay ? 3.8 : 4.4;
        if (cpa < minCpa || (cpa < 6.0 && alongO > -2.4)) {
          allSafe = false;
          break;
        }
      }
      if (allSafe) return -duckAng;
    }
    return null;
  }

  // 上レグで勝っている(先行している)強いCP艇が「抑えのタック(ルーズカバー: 後ろの船と同じ方向に向かう)」を行うための後続監視対象を探索
  findUpwindCoverTarget(tgt) {
    const b = this.b;
    if (!this.isTacticalStrong || !this.others) return null;
    const daToMark = tgt.a - b.a;
    // スタート直後や1マーク直前(レイライン付近)では無理なカバーをせずプロパーコースを優先
    if (b.a < 24 || daToMark < 38) return null;
    // 上位グループ(1〜7位)または直後に迫るライバル艇がいる時にカバーリングを意識
    if ((b.rank || 99) > 8) return null;
    let bestO = null, bestScore = 1e9;
    for (const o of this.others) {
      if (o === b || o.finished || o.dsq || o.ocs || o.leg !== b.leg || o.maneuver) continue;
      const aheadA = b.a - o.a;
      const latC = Math.abs(b.c - o.c);
      // 風上距離で3.5m〜42m後方、横距離36m以内にいる直後の追撃艇を対象とする
      if (aheadA < 3.5 || aheadA > 42.0 || latC > 36.0) continue;
      const score = aheadA + latC * 0.65 - (o.isPlayer ? 5.0 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestO = o;
      }
    }
    return bestO;
  }

  // タック/ジャイブ先がクリーンエアーで、かつ周囲の権利艇(特にスタボ艇)と衝突コースにならないか厳密に検証
  canTackCleanly(kind = 'tack', allowSlightDirty = false) {
    const b = this.b, W = b.windFrom;
    if (this.nearObstacle(8.5)) return false;
    const newTack = -b.tack;
    if (kind === 'tack' && newTack === -1 && this.hasStbdTackConflict()) return false;
    const ang = kind === 'tack' ? this.closeAngle : this.runAngle;
    const hNew = wrap(W - newTack * ang);
    const fx = Math.sin(hNew), fz = -Math.cos(hNew);
    const spd = Math.max(b.v, 2.2);
    for (const o of this.others) {
      if (o === b || o.finished || o.dsq) continue;
      const dx = o.x - b.x, dz = o.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d < 6.5) return false;
      // ポートタックへ返る場合、接近中のスターボード艇との交差距離を広めに確保(Rule 10 衝突防止)
      const isPortVsStbd = kind === 'tack' && newTack === -1 && o.tack === 1;
      const maxCheckD = isPortVsStbd ? 38 : 18;
      if (d < maxCheckD) {
        const vx = fx * spd, vz = fz * spd;
        const vo = Math.max(o.v, 1.5);
        const dvx = Math.sin(o.h) * vo - vx, dvz = -Math.cos(o.h) * vo - vz;
        const dv2 = dvx * dvx + dvz * dvz || 1e-6;
        const tca = clamp(-(dx * dvx + dz * dvz) / dv2, 0, isPortVsStbd ? 9.0 : 4.8);
        const cpa = Math.hypot(dx + dvx * tca, dz + dvz * tca);
        if (cpa < (isPortVsStbd ? 7.6 : 4.2)) return false;
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

  // 目標点(a,c)へ向かうヘディング(RRSプロパーコース準拠: 風上はレイライン円錐内の最適VMGクローズ、風下は最適VMGランニング角＋レイラインジャイブ)
  headingFor(tgt, t, prestart, directDownwind = false) {
    const b = this.b, W = b.windFrom;
    const tw = toWorld(tgt.a, tgt.c);
    const brg = this.bearing(tw.x, tw.z);
    const relT = wrap(W - brg);
    const ca = this.closeAngle;
    const ra = this.runAngle;
    const distTgt = Math.hypot(tgt.a - b.a, tgt.c - b.c);
    // 下レグ(目標が真風角raより深い場合): 180°で走らず164°〜170°を維持し、プロパーコースのダウンウインド・レイラインに達したらジャイブする
    if (!prestart && !directDownwind && Math.abs(relT) > ra && distTgt > 22) {
      const hs = wrap(W - ra), hp = wrap(W + ra);
      const cs = Math.cos(wrap(hs - brg)), cp = Math.cos(wrap(hp - brg));
      const downDa = Math.max(8, b.a - tgt.a);
      const downLay = Math.max(12, downDa * Math.tan(Math.PI - ra) * 0.96);
      // b.tack === 1 (スタボ)は -c 方向へ進み、b.tack === -1 (ポート)は +c 方向へ進むため、目標から離れる側へ downLay 以上膨らんだら overDownLay
      const overDownLay = (b.tack === 1 && b.c - tgt.c < -downLay) || (b.tack === -1 && b.c - tgt.c > downLay);
      const gybeCool = overDownLay ? 4.5 : 12.0;
      if (t - this.lastTack > gybeCool && !this.crowded(overDownLay ? 4.2 : 6.0) && !this.nearObstacle(6.5) && (overDownLay || this.canTackCleanly('gybe', true))) {
        if (b.tack === 1 && (cp > cs + 0.042 || overDownLay)) { this.lastTack = t; b.startManeuver('gybe'); }
        else if (b.tack === -1 && (cs > cp + 0.042 || overDownLay)) { this.lastTack = t; b.startManeuver('gybe'); }
      }
      return wrap(W - b.tack * ra);
    }

    const onUpwindBeat = !prestart && !directDownwind && (b.leg === 0 || b.leg === 3 || COURSE_MODE === 'upwind') && b.a < MARKS.m1.a - 4.0;
    const da = tgt.a - b.a, dc = b.c - tgt.c;

    // タック直後にスタボ艇のスターンを通過するためのダック継続中なら、スタボ艇の後ろを抜けるまで落とし角度を維持し、抜けたら即クローズへ戻す
    if (b.tack === -1 && this.postTackDuckUntil && t < this.postTackDuckUntil) {
      if (this.hasStbdTackConflict()) {
        return wrap(W - (this.postTackDuckRel || -(ca + 0.36)));
      }
      this.postTackDuckUntil = 0;
    }

    // マークへの直進が可能な角度(|relT| > ca + 0.025)のときの処理:
    // 【重要】relT と現在の b.tack が同符号(同じタック側)のときのみ直進またはレイライン・フェッチ角を返す。
    // もし異符号(relT * b.tack < 0)なのにそのまま brg を返すと、startManeuver('tack') なしで風向眼(twa=0°)を横切ろうとしてアイアンズ(逆走・停止)に陥るため、
    // 異符号の上りレグでは必ず下のタック判定へ進ませて正規のタック動作で反対タックへ返らせる！
    if (Math.abs(relT) > ca + 0.025) {
      if (onUpwindBeat) {
        if (relT * b.tack > 0) {
          // 既にレイラインに乗っており現在のタックのままマーク進入点(rp.lay / rp.entry)へフェッチできる状態:
          // マーク手前42m以内ならマークを通り過ぎないようターゲット方向(最大ca+0.30 = 約60°)へ自然にフェッチさせ、遠距離ならクローズ角(ca+0.08)を維持
          const maxFetchRel = da < 42 ? ca + 0.30 : ca + 0.08;
          const clampedRel = Math.sign(relT) * Math.min(Math.abs(relT), maxFetchRel);
          return wrap(W - clampedRel);
        }
        // relT * b.tack < 0 のときは反対タック側のレイラインを大きく超えているため、直進はせず下の強制タック処理へ進む
      } else {
        // リーチングレグ(leg 1: 1→1a, leg 4: 1→2, leg 5: 2→3, leg 6: 3→F)やマーク回航orbit/exit時:
        // もし現在針路(relNow)から目標(relT)への最短回頭が風向眼(twa=0°)を跨ぐ(|relNow|+|relT| < π)場合、
        // startManeuver('tack') なしで回頭すると sim.js のアイアンズ逆走判定に捕まるため、必ず正規のタック動作を開始させる！
        // ※ただし4ゲート回航中(b.leg === 2 または gateRp !== 'done')に風上へタックするとゲートを回らずに上り始めてしまうため除外
        const inGateProcess = b.leg === 2 || (this.gateRp && this.gateRp.phase !== 'done');
        const relNow = wrap(W - b.h);
        if (!prestart && !inGateProcess && !b.maneuver && relNow * relT < 0 && Math.abs(relNow) + Math.abs(relT) < Math.PI - 0.12) {
          const targetRel = Math.sign(relT) * clamp(Math.abs(relT), ca, 1.45);
          if (this.canExecuteTackNow(targetRel)) {
            this.lastTack = t;
            b.startManeuver('tack');
            if (b.maneuver) {
              b.maneuver.relNew = targetRel;
            }
          }
        }
        return brg;
      }
    }

    // 1マーク直前〜頂点(a >= 295.5, c >= -1.5, c <= 18)でスターボード・アプローチ中のみ、
    // 中盤のビーティング用タック判定へ落ちてポートタックへ逆戻りするのを防ぐ
    // (※2マーク等で風下へ流れた際に directDownwind=true でクローズ角が固定され無限に外海へ走り去るバグを防ぐため、directDownwind条件は除外し必ず下のタック判定を通す)
    if (!prestart && Math.abs(relT) <= ca + 0.025) {
      if (b.pole) b.setPole(false);
      if (!onUpwindBeat && (b.leg === 0 || b.leg === 3) && b.tack === 1 && b.a >= MARKS.m1.a - 4.5 && b.c >= -1.5 && b.c <= 18.0) {
        return wrap(W - (b.tack || 1) * ca);
      }
    }

    // ビーティング(RRSプロパーコース):
    // 1マークから伸びる左右のレイライン円錐(コーン)の内側を保ち、レイライン到達時はオーバースタンドせず速やかにタックする
    const tackNow = b.tack;
    const dtTack = t - this.lastTack;
    const layCool = dtTack > (prestart ? 10.5 : 4.5);
    const midCool = dtTack > (prestart ? 15 : this.tackCool);
    let wantTack = false, isMustTack = false, isForcedTack = false, inCorridorTurn = false;
    const lay = Math.max(0, da) * Math.tan(ca) * (1 + this.layMargin);
    if (layCool) {
      if (tackNow === 1 && dc <= -lay) {
        wantTack = true;
        isMustTack = true;
        if (dc <= -lay - 3.5 || !onUpwindBeat) isForcedTack = true;
      }
      if (tackNow === -1 && dc >= lay * 0.92) {
        wantTack = true;
        isMustTack = true;
        isForcedTack = true;
      }
      // リーチング・下マーク(2マーク等)より風下へ流れてしまい、現在のタックでは目標から遠ざかっている場合も即座に強制タックしてマークへ戻る
      if (!prestart && !onUpwindBeat && Math.abs(relT) <= ca + 0.025 && relT * tackNow < -0.05) {
        wantTack = true;
        isMustTack = true;
        isForcedTack = true;
      }
      // 反対タックのフェッチ角を超えてしまっている場合も即座にレイライン強制タック
      if (!prestart && Math.abs(relT) > ca + 0.025 && relT * tackNow < 0) {
        wantTack = true;
        isMustTack = true;
        isForcedTack = true;
      }
      // プロパーコース(海面中央〜有利サイドの回廊)から外へ膨らみすぎないよう艇ごとに異なる境界(78〜92m)で必須タック、+8mで強制タック
      const sideMustLim = 78 + (b.id % 5) * 3.5;
      const sideForceLim = sideMustLim + 8.0;
      if (!prestart && ((tackNow === 1 && b.c < -sideMustLim) || (tackNow === -1 && b.c > sideMustLim))) {
        wantTack = true;
        isMustTack = true;
        if ((tackNow === 1 && b.c < -sideForceLim) || (tackNow === -1 && b.c > sideForceLim)) isForcedTack = true;
      }

      // 戦術的に強いCP艇の「抑えのタック(カバーリングタック: 勝っているときは上レグで後ろの船と同じ方向に向かう)」
      let holdingCover = false;
      if (!prestart && onUpwindBeat && da > 3 && !wantTack && Math.abs(dc) < lay * 0.84) {
        const coverTarget = this.findUpwindCoverTarget(tgt);
        if (coverTarget) {
          if (coverTarget.tack !== tackNow && dtTack > 10.5) {
            // 後ろの船が自分と逆タックへ向かっている場合、タックして後ろの船と同じ方向(同じタック)へ向かい抑える
            wantTack = true;
          } else if (coverTarget.tack === tackNow && Math.abs(b.c - coverTarget.c) < 22) {
            // 既に後ろの船と同じ方向(同じタック)で抑えている最中は、不要な中盤タックを控えてカバーを維持する
            holdingCover = true;
          }
        }
      }

      if (!prestart && da > 3 && !wantTack && !holdingCover && (midCool || (b.a > 10 && dtTack > 8.5))) {
        const weight = clamp((da - 38) / 130, 0, 1);
        const centerC = tgt.c + this.prefSideC * weight;
        const halfW = this.corridorHalf * (0.50 + 0.50 * weight);
        const corridorL = Math.max(-74, Math.min(-12, -lay * 0.84), centerC - halfW);
        const corridorR = Math.min(74, Math.max(12, lay * 0.84), centerC + halfW);
        if (tackNow === 1 && b.c < corridorL) { wantTack = true; inCorridorTurn = true; }
        if (tackNow === -1 && b.c > corridorR) { wantTack = true; inCorridorTurn = true; }
        // 風が弱い不利海面を逆方向へ走り続けている場合や、シフトで反対タックが明確にリフトしている場合は戦術タック(プロパーコース選択)
        if (t > this.vmgAt) {
          this.vmgAt = t + 16 + this.rng() * 12;
          const hs = W - ca, hp = W + ca;
          const cs = Math.cos(wrap(hs - brg)), cp = Math.cos(wrap(hp - brg));
          const aheadX = b.x + Math.sin(b.h) * 45, aheadZ = b.z - Math.cos(b.h) * 45;
          const oppH = wrap(W + tackNow * ca);
          const oppX = b.x + Math.sin(oppH) * 45, oppZ = b.z - Math.cos(oppH) * 45;
          const wAhead = windAt(aheadX, aheadZ, this.wt ?? t).factor;
          const wOpp = windAt(oppX, oppZ, this.wt ?? t).factor;
          const windGain = (wOpp - wAhead) * 0.68;
          if (tackNow === 1 && (cp - cs + windGain) > 0.13) wantTack = true;
          if (tackNow === -1 && (cs - cp + windGain) > 0.13) wantTack = true;
        }
      }
    }
    if (wantTack && !this.crowded(isForcedTack ? 2.4 : (isMustTack ? 3.8 : (inCorridorTurn ? 4.4 : 6.0)), true) && !this.nearObstacle(7.0)) {
      if (tackNow === 1 && (this.hasStbdTackConflict(isForcedTack) || !this.canExecuteTackNow())) {
        // スタボからポートへタックするとスタボ艇に接近する場面:
        // 原則タックせずそのままスタボのクローズを維持する。
        // ただしレイラインまたは回廊境界超過(isMustTack / isForcedTack)でタックしたい場合は、
        // スターン後方を安全に通過できるダック角度(duckRel)が canExecuteTackNow を満たす時のみタックする
        if (isMustTack || isForcedTack) {
          const duckRel = this.findPostTackDuckAngle(isForcedTack);
          if (duckRel !== null && this.canExecuteTackNow(duckRel)) {
            this.lastTack = t;
            b.startManeuver('tack');
            if (b.maneuver) b.maneuver.relNew = duckRel;
            this.postTackDuckUntil = t + 4.4;
            this.postTackDuckRel = duckRel;
          }
        }
      } else if ((isMustTack || inCorridorTurn || this.canTackCleanly('tack', true)) && this.canExecuteTackNow()) {
        this.lastTack = t;
        if (!isMustTack) this.prefSideC = clamp(b.c + b.tack * 32, -42, 42);
        b.startManeuver('tack');
      }
    }
    // 左端・右端の必須タック境界を超えても並走艇に阻まれてまだタックできない場合:
    // 外側にいる艇ほど強く減速する速度勾配を作ることで、複数艇の並走ロックを即座に解消して風上右側の艇を先に通し、そのスターンへ安全にタックさせる
    if (!prestart && !b.maneuver && isMustTack) {
      const overDist = Math.max(0, Math.abs(b.c) - 54);
      if (overDist > 0) {
        b.throttle = Math.min(b.throttle, clamp(1.0 - overDist * 0.055, 0.08, 0.85));
      }
    }
    return wrap(W - b.tack * ca);
  }

  crowded(rad = 8.5, ignoreAwayOnTack = false) {
    const b = this.b, r2 = rad * rad;
    const pre = (this.now ?? 0) < 0;
    for (const o of this.others) {
      if (o === b || o.finished || o.dsq) continue;
      if (pre && o.isPlayer) continue; // プリスタート中は自艇の位置に関係なくスタートラインへ並ぶ
      const dx = o.x - b.x, dz = o.z - b.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r2) continue;
      // タック回頭側と逆(スタボ→ポート時は左=風下側 o.c < b.c - 0.5)にいる艇は、タックすれば離れる方向なので直近2.2m以外除外
      if (ignoreAwayOnTack && (o.c - b.c) * (b.tack || 1) < -0.5 && d2 > 4.8) continue;
      return true;
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
    const m = L.mark, rIn = L.markKey === 'm1a' ? Math.min(this.roundR, 4.8) : this.roundR, rOut = this.roundROut;
    const right = (d) => ({ c: d.a, a: -d.c });
    const ri = right(L.dirIn), ro = right(L.dirOut);
    const th1 = Math.atan2(ri.a, ri.c);
    let th2 = Math.atan2(ro.a, ro.c);
    while (th2 < th1 + 0.05) th2 += 2 * Math.PI;
    const beat = L.dirIn.a > 0.7;
    const ths = L.markKey === 'm1a' ? 0.75 : (beat ? 0.92 : th1 - 0.35);
    // 風上マーク(beat=true: 1マーク)では、真風(twa=0°)方向へバウを向けてアイアンズ・オーバースタンドしないよう、
    // 右下レイライン目標(lay: a=298.0, c=+7.8)からスターボード・クローズ角のままマーク頂点(entry: a=304.2, c=+1.5 -> e: a=303.2, c=-2.5)へ抜け、
    // マークの真上(dc <= 0.6, da >= 2.2)を確実に越えてから次レグ方向(exit)へベアアウェイさせる
    const entry = L.markKey === 'm1a'
      ? { c: m.c + 3.4, a: m.a + 2.0 }
      : beat
        ? { c: m.c + 3.5, a: m.a + 5.0 }
        : { c: m.c + rIn * Math.cos(ths), a: m.a + rIn * Math.sin(ths) };
    const e = beat
      ? { c: m.c - 2.5, a: m.a + 3.8 }
      : { c: m.c + rOut * Math.cos(th2), a: m.a + rOut * Math.sin(th2) };
    const lay = beat ? { c: m.c + 10.5, a: m.a + 0.5 } : null;
    const exit = { c: e.c + L.dirOut.c * 14, a: e.a + L.dirOut.a * 14 };
    return { leg: L.id, m, r: rIn, rOut, ths, arc: th2 - ths, entry, e, lay, exit, phase: beat ? 'lay' : 'approach', beat, passedRight: false, enteredOrbit: false, exitStartT: null, idx: 0 };
  }

  roundingTarget(L) {
    const b = this.b;
    if (!this.rp || this.rp.leg !== L.id) this.rp = this.buildRounding(L);
    const rp = this.rp, m = rp.m, rIn = rp.r, rOut = rp.rOut;
    const dc = b.c - m.c, da = b.a - m.a, dM = Math.hypot(dc, da);
    const thb = Math.atan2(da, dc);
    let uu = thb - rp.ths; // 反時計回りの進み具合(rad)
    uu = ((((uu + 2.35) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - 2.35;
    const dist = (p) => Math.hypot(b.c - p.c, b.a - p.a);
    const t = this.now || 0;

    // マークの右横〜右上(dc > 0.6 && da > -0.5)を確実に通過したことを記録(マーク下側ショートカットによる誤exit防止)
    if (rp.beat) {
      if (dc > 0.6 && da > -0.5) rp.passedRight = true;
      if (da < -2.0 && dc < 0) rp.passedRight = false;
    }

    // 既に風上マーク頂点を正規通過してexitフェーズに入っている場合は、レグ更新が完了するまでexit目標を維持する
    // (ただし万一 dc < -18 まで流れてもレグ更新されなかった場合は passedRight をリセットして再アプローチさせる)
    if (rp.beat && rp.phase === 'exit') {
      if (dc < -18.0 || da < -4.0) {
        rp.phase = 'lay';
        rp.passedRight = false;
      } else {
        rp.idx = 2;
        return { ...rp.exit, forceDirect: true };
      }
    }

    // 1マーク(風上マーク)へポートタック(tack === -1)でアプローチし、マーク頂点(+4.2m)をクリアできるスターボード・レイライン(reqDc)に到達したら、
    // オーバースタンドして右上(a > 314)へ突き抜けないよう即座にスターボードタックへタックする (ただし周囲艇と接触しない場合のみ)
    const reqDc = Math.max(3.4, (4.2 - da) * Math.tan(this.closeAngle));
    if (rp.beat && b.tack === -1 && !b.maneuver && da >= -10.0 && dc >= reqDc && this.canExecuteTackNow()) {
      this.lastTack = t;
      b.startManeuver('tack');
    }

    // 1マーク手前(da >= -24)でポートタック(tack === -1)のままレイライン左側(dc < reqDc)にいる場合:
    // クローズホールド(43°)で登るとスタボのレイライン艇列に突っ込んだりマークの左側〜真上を斜めに横切ってオーバースタンドしてしまうため、
    // 早め(da >= -24)からスタボ艇列の風下・後方を通って正規の右レイライン(c = reqDc + 3.0)へ出るようベアアウェイさせる
    if (rp.beat && rp.phase !== 'exit' && b.tack === -1 && da >= -24.0 && dc < reqDc) {
      return { a: Math.min(b.a + 2.5, m.a - 4.5), c: Math.max(reqDc + 3.0, m.c + 10.5), forceDirect: true };
    }

    // 風上マーク(rp.beat)で正規に右側からアプローチ(rp.passedRight)し、スターボードタックでマークの真上〜左上(da >= 1.8 && dc <= 4.8)に到達したら、
    // マーク真上(dc <= 0.4 && da >= 2.0)を越えた時点で次レグ方向(rp.exit)へベアアウェイする。
    // また右レイラインを少しオーバースタンドして da >= 3.2, dc > 4.8 に出た場合も、クローズのまま a > 314 へ登り続けないよう
    // マーク風上4.5mを通過するアビーム針路でダイレクトにマーク頂点へ寄せる
    if (rp.beat && b.tack === 1 && rp.passedRight) {
      if (da >= 1.8 && dc <= 4.8 && dc >= -18.0) {
        if (dc <= 0.4 && da >= 2.0) {
          rp.phase = 'exit';
          rp.idx = 2;
          return { ...rp.exit, forceDirect: true };
        }
        rp.idx = 1;
        return { ...rp.e, forceDirect: true };
      }
      if (da >= 3.2 && dc > 4.8 && dc <= 18.0) {
        rp.idx = 1;
        return { c: m.c + 0.8, a: Math.max(m.a + 4.5, Math.min(b.a, m.a + 8.0)), forceDirect: true };
      }
    }

    // 万一1マーク(上りマーク)でレイラインより下(左)へ落ちてしまい、このままではマークの下側(逆回り)を通過してしまう位置にある場合:
    // 必ずマークの右下(正規進入側 rp.lay)へ戻す
    if (rp.beat && rp.phase !== 'orbit' && rp.phase !== 'exit' && !rp.passedRight && da >= -4.5 && dc < 1.8) {
      return { a: m.a - 3.5, c: m.c + 9.5, forceDirect: true };
    }

    // 1マーク(上りマーク)の手前〜左横でスターボード・レイラインより左側(アンダースタンド位置)にいるとき:
    // そのままスタボで左へ走るとマーク下側へ突っ込み逆回りまたはa>314へのオーバースタンドになるため、ポートタックへ返してrp.layへ向かわせる
    const minStbdDc = (2.8 - da) * Math.tan(this.closeAngle) - 1.0;
    if (rp.beat && rp.phase !== 'orbit' && rp.phase !== 'exit' && !rp.passedRight && da > -28 && da < 16.0 && dc < Math.min(2.2, minStbdDc)) {
      if (b.tack === 1 && !b.maneuver && t - this.lastTack > 1.8) {
        if (!this.hasStbdTackConflict(true) && this.canExecuteTackNow()) {
          this.lastTack = t;
          b.startManeuver('tack');
        } else {
          const duckRel = this.findPostTackDuckAngle(true);
          if (duckRel !== null && this.canExecuteTackNow(duckRel)) {
            this.lastTack = t;
            b.startManeuver('tack');
            if (b.maneuver) b.maneuver.relNew = duckRel;
            this.postTackDuckUntil = t + 4.0;
            this.postTackDuckRel = duckRel;
          }
        }
      }
      return rp.lay;
    }

    if (rp.phase === 'lay') {
      if (dc >= reqDc - 0.8 && da >= -8.0 && b.tack === 1) {
        rp.phase = 'approach';
      } else {
        return rp.lay;
      }
    }
    if (rp.phase === 'approach') {
      // もし風上マークでスターボード・レイラインより左下に落ちてエントリーできない場合は一旦rp.layへ戻す
      if (rp.beat && da < 0.8 && dc < minStbdDc) {
        rp.phase = 'lay';
        return rp.lay;
      }
      if (rp.beat) {
        // 風上マークのapproachでは、スターボードのクローズ角で頂点(rp.entry)へ向かう
        return rp.entry;
      }
      if (!rp.beat && dM < 2.4 * rIn && uu >= -0.40 && uu <= rp.arc * 0.70) {
        rp.enteredOrbit = true;
      }
      if ((dist(rp.entry) < 7.0 && uu > -0.65 && uu < rp.arc * 0.75) || (dM < 2.2 * rIn && uu > -0.45 && uu < rp.arc * 0.75)) {
        rp.enteredOrbit = true;
        rp.phase = 'orbit';
      } else {
        // もし2マークや1aマークで風下(da < -2.0)へ流れてしまいentry点が風上側になった場合は、forceDirect=falseにして正規に上り直させる
        const entryUpwind = (rp.entry.a - b.a) > 2.5 && Math.abs(rp.entry.c - b.c) < (rp.entry.a - b.a) * 1.15;
        return { ...rp.entry, forceDirect: !entryUpwind };
      }
    }
    if (rp.phase === 'orbit') {
      rp.idx = 1;
      if (dM < 2.4 * rIn && uu >= -0.40 && uu <= rp.arc * 0.75) {
        rp.enteredOrbit = true;
      }
      if (rp.enteredOrbit && uu >= rp.arc - 0.04 && uu < rp.arc + 1.25) {
        rp.phase = 'exit';
        rp.exitStartT = t;
      } else if (dM > 3.2 * rIn || (!rp.enteredOrbit && (uu < -0.65 || uu > rp.arc + 0.25))) {
        rp.phase = 'approach';
        const entryUpwind = (rp.entry.a - b.a) > 2.5 && Math.abs(rp.entry.c - b.c) < (rp.entry.a - b.a) * 1.15;
        return { ...rp.entry, forceDirect: !entryUpwind };
      }
      else {
        const prog = clamp(uu / Math.max(0.2, rp.arc), 0, 1);
        const rDes = rIn + (rOut - rIn) * Math.pow(prog, 0.85);
        const tc = -Math.sin(thb), ta = Math.cos(thb), nc = Math.cos(thb), na = Math.sin(thb);
        const k = clamp(((dM - rDes) / Math.max(2.2, rDes)) * 1.85, -1.2, 1.15);
        let vc = tc - k * nc, va = ta - k * na; const l = Math.hypot(vc, va) || 1; vc /= l; va /= l;
        // orbit接線が風上ノーゴーゾーン(va > cos(closeAngle))を向いて失速・オーバースタンドしないようクランプ
        const maxVa = Math.cos(this.closeAngle);
        if (va > maxVa) {
          va = maxVa;
          vc = -Math.sin(this.closeAngle);
        }
        return { c: b.c + vc * 14, a: b.a + va * 14, forceDirect: true };
      }
    }
    // exit: course.js の updateProgress で b.leg がインクリメントされるまでは絶対に次マークへ飛ばず、
    // 現在のマークの反時計回り脱出方向(rp.exit)へ抜けて確実に回航判定を完了させる
    rp.idx = 2;
    if (rp.exitStartT === null) rp.exitStartT = t;
    const wrongSweep = b.visit && b.visit.sweep * -L.side < -0.15;
    if (dM > ROUND_R - 2 || (t - rp.exitStartT > 3.2) || wrongSweep) {
      // 万一まだ回航判定が完了していないのにマークから離れた場合や逆側を通過した場合はアプローチをやり直す
      if (b.visit) b.visit.sweep = 0;
      this.rp = this.buildRounding(L);
      const entryUpwind = (this.rp.entry.a - b.a) > 2.5 && Math.abs(this.rp.entry.c - b.c) < (this.rp.entry.a - b.a) * 1.15;
      return { ...this.rp.entry, forceDirect: !rp.beat && !entryUpwind };
    }
    return { ...rp.exit, forceDirect: true };
  }

  // ---------- 4ゲート(4S=gL / 4P=gR) 専用回航プラン ----------
  updateGateRounding(t) {
    const b = this.b, ca = this.closeAngle;
    // ゲートに近づく際(a > 62)、自分の横位置と現在のタックから無理なく回れる側のゲートマークを選択
    if (b.a > 62) {
      if (b.c < -7) this.gateKey = 'gL';
      else if (b.c > 7) this.gateKey = 'gR';
      else this.gateKey = b.tack === 1 ? 'gL' : 'gR';
    }
    const key = this.gateKey; // 'gL' (4S: 右舷回航, reqTack=+1) or 'gR' (4P: 左舷回航, reqTack=-1)
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
    // まだb.leg===2(ゲート未通過)の間は絶対にdoneにしない
    if (gp.phase === 'done' && b.leg === 2) {
      gp.phase = 'approach';
    }
    // ゲート回航完了は tightExit フェーズを経て a > m.a + 6.0 に抜けたときのみ
    if (b.leg === 3 && gp.phase === 'tightExit' && b.a > m.a + 6.0) {
      gp.phase = 'done';
      this.lastTack = Math.max(this.lastTack, t - 2.0);
      return null;
    }
    if (b.a < 64 && b.pole) b.setPole(false);

    const dc = b.c - m.c, da = b.a - m.a;
    // 上流(b.a > 76)ではまずゲート中央寄りのファンネル点(c = m.c - s * 10.5 = ∓11.5)へ誘導し、
    // そこからゲート進入点(entry: c = m.c - s * 3.5 = ∓18.5)へは必ず正規タック(4Sならスタボ=-c方向、4Pならポート=+c方向)でアプローチできるようにする
    const funnel = { a: m.a + 32.0, c: m.c - s * 10.5 };
    const entry = { a: m.a + 4.5, c: m.c - s * 3.5 };
    const tightAbeam = { a: m.a + 0.6, c: m.c + s * 2.65 };
    const closeFollow = { a: m.a + 10.0, c: m.c + s * (2.65 + 9.4 * Math.tan(ca)) };

    if (gp.phase === 'approach') {
      // ゲートから十分上(a > 64)にいるうちに正規タック(reqTack)へジャイブを済ませる(ゲート直前でstartManeuver('gybe')するとa<25まで流されるため禁止)
      if (b.a < 105 && b.a > 64 && b.tack !== reqTack && !b.maneuver && t - this.lastTack > 3.2 && !this.crowded(4.8)) {
        this.lastTack = t;
        b.startManeuver('gybe');
      }
      if (b.a > 76) {
        return { tgt: funnel, direct: b.a < 130, rounding: false };
      }
      // ゲートの外側に膨らんでいる場合は、風上へ逆走せず現在位置より風下(またはゲート手前a=43)のゲート内側へ寄せる
      if (b.a < 68 && (b.c - m.c) * s > -2.2) {
        const tgtA = b.a > m.a + 3.0 ? Math.max(m.a + 2.5, b.a - 3.5) : m.a + 3.5;
        return { tgt: { a: tgtA, c: m.c - s * 7.5 }, direct: b.a > m.a + 1.5, rounding: true };
      }
      if (b.a <= m.a + 5.5 && (b.c - m.c) * s <= 1.2) {
        gp.phase = 'orbit';
      } else {
        return { tgt: entry, direct: true, rounding: b.a < 68 };
      }
    }

    if (gp.phase === 'orbit') {
      if (b.pole) b.setPole(false);
      let phi = Math.atan2(-da, -s * dc);
      // マーク外側(s * dc > 0)かつマーク横〜風上(da > 0)に達した際に atan2 が +π から -π へ反転するのを補正
      if (s * dc > 0 && da > 0 && phi < 0) phi += 2 * Math.PI;
      if (s * dc > 0.5 && da >= -0.8) {
        gp.phase = 'tightExit';
      } else {
        const phiClamped = clamp(phi, -0.35, Math.PI);
        const phiNext = Math.min(Math.PI, Math.max(0.35, phiClamped + 0.55));
        const prog = clamp(phiNext / Math.PI, 0, 1);
        const rC = 2.65 + (6.5 - 2.65) * Math.pow(Math.cos(prog * Math.PI * 0.5), 1.4);
        const rA = 4.2;
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
      if (b.a < m.a + 6.0) {
        return { tgt: closeFollow, direct: true, rounding: true };
      }
      gp.phase = 'done';
      this.lastTack = Math.max(this.lastTack, t - 2.0);
    }
    return null;
  }

  // プリスタート中に後ろ(第2列)で待機し、スタート前に前線の船と船の間(ギャップ)を見つけて滑り込むCP艇(gapShooter)の隙間探索
  scanPrestartGap(t) {
    const b = this.b;
    const baseC = clamp(this.baseStartC ?? this.targetStartC ?? 0, -LINE_HALF + 8, LINE_HALF - 7);
    const searchSpan = 22.0;
    const minC = Math.max(-LINE_HALF + 6, baseC - searchSpan);
    const maxC = Math.min(LINE_HALF - 5, baseC + searchSpan);
    const occ = [minC - 2.0, maxC + 2.0];
    const tanCa = Math.tan(this.closeAngle) * 0.85;
    for (const o of this.others) {
      if (o === b || o.finished || o.dsq) continue;
      const laO = lineA(clamp(o.c, -LINE_HALF, LINE_HALF));
      const gapO = laO - o.a;
      // 自分より前方(ライン側)にいる前線待機艇の号砲時予想横位置をリストアップ
      if (gapO < -2.0 || gapO > 26.0 || o.a < b.a - 1.5) continue;
      const projC = o.c - Math.max(0, gapO) * tanCa - Math.max(0, -t - 4) * 0.25;
      if (projC >= minC - 4.0 && projC <= maxC + 4.0) {
        occ.push(projC);
      }
    }
    occ.sort((x, y) => x - y);
    let bestMid = baseC, bestScore = -1e9;
    for (let i = 0; i < occ.length - 1; i++) {
      const cL = Math.max(minC, occ[i]);
      const cR = Math.min(maxC, occ[i + 1]);
      const width = cR - cL;
      if (width < 4.2) continue;
      const mid = (cL + cR) * 0.5;
      // 隙間が広く、かつ自分のベース狙い位置(baseC)から無理なく入れるギャップを高評価
      const score = width * 1.4 - Math.abs(mid - baseC) * 0.45;
      if (score > bestScore) {
        bestScore = score;
        bestMid = mid;
      }
    }
    this.targetStartC = clamp(bestMid, -LINE_HALF + 6, LINE_HALF - 5);
  }

  // 衝突回避: ポート艇がスタボ艇へ突っ込まないよう早期検知し、リーボータック(クリーンな位置へのタック)またはスターン通過(ベアアウェイ)で確実に回避する
  // また接触・密着時(d < 3.8m)に離れようとしない現象を防ぐため、1.15秒後の分離距離(sep1)を評価して即座に離間方向へ舵を切る
  avoid(t, desired) {
    const b = this.b;
    // ポートタック時や直近接触時は毎フレーム即座に再評価してすぐに離れられるようにする
    if (b.tack !== -1 && t < this.avoidUntil && !this.crowded(3.8)) return this.avoidH;
    const CLEAR = 5.2, DETECT = 5.6;
    const vb = Math.max(b.v, 1.45);
    const cpaInfo = (h, o) => {
      const vx = Math.sin(h) * vb, vz = -Math.cos(h) * vb, vo = Math.max(o.v, 0.85);
      const fox = Math.sin(o.h), foz = -Math.cos(o.h);
      const dvx = fox * vo - vx, dvz = foz * vo - vz;
      // 大きく舵を切る際(h !== b.h)、回頭完了までの約0.5〜1.1秒間は現在の船首方向(b.h)へ惰性で進むオフセットを考慮
      const turnLagT = Math.min(1.2, Math.abs(wrap(h - b.h)) * 0.65);
      const lagX = (Math.sin(b.h) - Math.sin(h)) * vb * turnLagT * 0.52;
      const lagZ = (-Math.cos(b.h) - (-Math.cos(h))) * vb * turnLagT * 0.52;
      const dx = o.x - (b.x + lagX), dz = o.z - (b.z + lagZ);
      const rawDx = o.x - b.x, rawDz = o.z - b.z;
      const dv2 = dvx * dvx + dvz * dvz || 1e-6;
      const tca = clamp(-(dx * dvx + dz * dvz) / dv2, 0, 10.5);
      const cpa = Math.hypot(dx + dvx * tca, dz + dvz * tca);
      // 現在すでに密着している場合(tca≈0)でもどの針路hなら1.15秒後に離れられるかを正確に評価
      const sep1 = Math.hypot(rawDx + dvx * 1.15, rawDz + dvz * 1.15);
      // 最接近時に自艇bが相手oの進行方向基準でどこを通過するか(負=oのスターン後方、正=oのバウ前方)
      const bRelOx = -dx - dvx * tca;
      const bRelOz = -dz - dvz * tca;
      const alongO = bRelOx * fox + bRelOz * foz;
      return { cpa, sep1, tca, alongO, d2: rawDx * rawDx + rawDz * rawDz };
    };
    const h0 = desired ?? b.h;
    const W = b.windFrom;
    const twa0 = Math.abs(wrap(W - h0));
    const isCloseHauled = twa0 < 1.08;
    const inGateProcess = b.leg === 2 || (this.gateRp && this.gateRp.phase !== 'done');
    const threats = [];
    const prestart = t < 0;
    for (const o of this.others) {
      if (o === b || o.finished || o.dsq) continue;
      const dx = o.x - b.x, dz = o.z - b.z;
      const d2 = dx * dx + dz * dz;
      // プリスタート中は自艇(isPlayer)がラインから離れていても絶対にそれにつられて針路を変えない(直前3.4mの接触回避のみ)
      if (prestart && o.isPlayer && d2 > 11.5) continue;
      const isPortVsStbd = b.tack === -1 && o.tack === 1;
      if (d2 > (prestart ? 360 : (isPortVsStbd ? 1936 : 1444))) continue; // ポート対スタボ時は44m以内、通常は38m以内を監視
      const { cpa, sep1, tca, alongO } = cpaInfo(h0, o);
      const gw = giveWayBoat(b, o).gw;
      const isGiveWay = gw === b;
      const isSameTackParallel = b.tack === o.tack && Math.abs(wrap(b.h - o.h)) < 0.45;
      // すでに接触・超接近(d < 3.6m)している場合は権利関係や並走判定に関わらず必ず離間対象にする
      const isTouchingOrClose = d2 < 13.0;
      if (!isTouchingOrClose) {
        // 自艇がスタボ権利艇で相手がポート艇の場合は、相手が直前(9.5m以内・cpa<3.0m)まで避けない緊急時(Rule 14)以外は針路を維持する
        if (!isGiveWay && b.tack === 1 && o.tack === -1 && (d2 > 90 || cpa > 3.0)) continue;
        // クローズ中に同タックで並走している他艇に対しては、5.6mで過剰反応して謎に角度を落とさないよう直近接触圏(d2<90かつcpa<2.55m)のみ回避対象にする
        if (isCloseHauled && isSameTackParallel && (d2 > 90 || cpa >= 2.55)) continue;
      }
      const thresh = isGiveWay
        ? (prestart ? 3.8 : (isPortVsStbd ? 9.2 : (isCloseHauled && isSameTackParallel ? 2.65 : DETECT)))
        : (o.isPlayer ? (prestart ? 2.6 : 3.2) : 2.8);
      if (isTouchingOrClose || (cpa < thresh && (tca > 0.05 || d2 < 36))) {
        threats.push({ o, isGiveWay, isPortVsStbd, cpa, sep1, tca, alongO, d2 });
      }
    }
    this.hasPortStbdThreat = threats.some((th) => th.isPortVsStbd);
    if (!threats.length) return null;

    // ポートタック走行中にスタボ艇と交差接近した際:
    // (1) 自艇がスタボ艇の風上・前方にいる場合(b.a >= o.a - 0.8)や距離6m〜30mでスタボへ返せる場合は、風下へ落として相手に突っ込むのではなく即座にスタボへタック(リーボータック)してRule 10を解消する
    const stbdThreat = threats.find((th) => th.isPortVsStbd && th.d2 > 25 && th.d2 < 900 && th.cpa < 8.4);
    if (!prestart && !inGateProcess && stbdThreat && b.tack === -1 && b.twa < 1.35 && !b.maneuver && !b.pole && t - this.lastTack > 2.4) {
      const isUpwindOfStbd = b.a >= stbdThreat.o.a - 0.8;
      if ((isUpwindOfStbd || this.canTackCleanly('tack', true)) && this.canExecuteTackNow()) {
        this.lastTack = t;
        this.prefSideC = clamp(b.c - 32, -42, 42);
        b.startManeuver('tack');
        return null;
      }
    }

    const hasPortStbd = this.hasPortStbdThreat;
    const hasVeryClose = threats.some((th) => th.d2 < 14.5);
    const onM1Leg = !prestart && (b.leg === 0 || b.leg === 3);
    // 1マーク頂点(a >= 301.2)でスタボ回航中に他艇回避で風上(twa < 65°)へラフし直して a > 314 へ登り続けるのを防止
    const inM1TopBearAway = onM1Leg && b.tack === 1 && b.a >= MARKS.m1.a + 1.2 && b.c >= -5.0 && b.c <= 18.0;
    // 1マーク手前右レイライン上(a = 286..301.2, c > 1.5)でスタボ進入中に他艇回避で風下へ落としすぎてマーク下側へ落ちるのを防止
    const inM1StbdApproach = onM1Leg && b.tack === 1 && b.a >= MARKS.m1.a - 14.0 && b.a < MARKS.m1.a + 1.2 && b.c > 1.5;
    let best = null, bestScore = -1e9, bestMinCpa = 0;
    const maxStep = prestart ? 7 : 18;
    // クローズ走行中にピンチしすぎて失速・アイアンズに陥らないよう最小真風角を厳守(密着離間時は少しだけラフ余地を広げて風上艇が右へ逃げられるようにする)
    const minTwaAllow = inM1TopBearAway
      ? Math.min(twa0, 1.12)
      : (isCloseHauled ? Math.max(0.62, this.closeAngle - (hasVeryClose ? 0.11 : 0.045)) : (hasPortStbd ? 0.65 : 0.62));
    for (let i = 0; i <= maxStep; i++) {
      for (const s of i ? [1, -1] : [1]) {
        const dh = s * i * 0.084, h = wrap(h0 + dh);
        const relH = wrap(W - h);
        const twaH = Math.abs(relH);
        if (twaH < minTwaAllow) continue;
        // 4ゲート回航で既にゲート下(a < 38)にいる際、他艇回避でさらに真南(twa > 115°)へ逃げて a < 25 まで流されるのを防止
        if (inGateProcess && b.a < 38.5 && twaH > 2.0) continue;
        // クローズ走行中または1マーク頂点回航中はタックなしで風向眼の反対側へ舵を切ることを禁止
        if ((isCloseHauled || inM1TopBearAway) && relH * (b.tack || 1) < 0) continue;
        // プリスタート中は回避で風下へベアアウェイしすぎてスタートラインから離れるのを防ぐ
        if (prestart && twaH > this.closeAngle + 0.24) continue;
        // 1マークへのスターボード最終アプローチ中はベアアウェイしすぎてレイライン下に落ちるのを禁止
        if (inM1StbdApproach && twaH > this.closeAngle + 0.07) continue;
        // クローズ走行中にスタボ艇との交差(hasPortStbd)時はスターン後方を確実に通過できるよう最大1.62rad(約93°)までのダックを許可し、
        // すでに超接近(hasVeryClose)している場合も1.52radまで広げて船首同士の引っかかりを解消する
        if (!prestart && isCloseHauled) {
          const maxUpwindAvoidTwa = hasPortStbd ? 1.62 : (hasVeryClose ? 1.52 : this.closeAngle + 0.12);
          if (twaH > maxUpwindAvoidTwa) continue;
        }
        if (b.pole && twaH < POLE_MIN) continue;
        let minCpa = 99;
        let bowCrossPenalty = 0;
        let closeSepBonus = 0;
        for (const th of threats) {
          const { cpa, sep1, alongO } = cpaInfo(h, th.o);
          const effCpa = th.d2 < 14.5 ? Math.min(cpa, sep1) : cpa;
          const wCpa = th.isGiveWay || th.o.isPlayer ? effCpa : effCpa + 0.5;
          if (wCpa < minCpa) minCpa = wCpa;
          // 既に接触・密着(d < 3.8m)している相手からは、1.15秒後の距離(sep1)が広がる方向へ強く舵を切って即座に離れる
          if (th.d2 < 14.5) {
            const curD = Math.sqrt(th.d2);
            closeSepBonus += (sep1 - curD) * 24.0;
          }
          // クローズ走行中にポート艇がスタボ艇の直前(alongO > -3.0)を5.2m未満の危険な距離で横切ろうとする針路を禁止
          if (isCloseHauled && !inGateProcess && th.isPortVsStbd && cpa < 5.2 && alongO > -3.0) {
            bowCrossPenalty += 220;
          }
        }
        // ベアアウェイ判定: クローズ走行中に自艇がスタボ艇より風下側(b.a <= o.a + 1.0)にいる時のみ、風下へ落としてスターンを通る針路を優先
        const isBearAway = twaH > twa0 + 0.01;
        const canDuckBehind = isCloseHauled && !inGateProcess && hasPortStbd && threats.every((th) => !th.isPortVsStbd || b.a <= th.o.a + 1.5);
        const duckBonus = canDuckBehind ? (isBearAway ? 18.0 : (dh !== 0 ? -20.0 : 0)) : 0;
        const base = minCpa >= CLEAR ? 100 - Math.abs(dh) * 6.5 + duckBonus : minCpa * 14 - Math.abs(dh) * 0.4 + duckBonus;
        const score = base + closeSepBonus - bowCrossPenalty - Math.max(0, 3.5 - this.markClear(h)) * 4.0;
        if (score > bestScore) { bestScore = score; best = h; bestMinCpa = minCpa; }
      }
    }
    // もし舵を切るだけではスタボ艇との衝突が避けられない(bestMinCpa < 3.4)かつ上りレグでポートタックなら、安全に回れるスペースがある場合に限り緊急タックして逃げる
    const hasCloseStbdThreat = threats.some((th) => th.isPortVsStbd && th.d2 > 16 && th.d2 < 324);
    if (!inGateProcess && hasCloseStbdThreat && bestMinCpa < 3.4 && b.tack === -1 && b.twa < 1.32 && !b.maneuver && !b.pole && t - this.lastTack > 4.0 && this.canExecuteTackNow()) {
      this.lastTack = t;
      b.startManeuver('tack');
      return null;
    }
    if (best !== null) { this.avoidUntil = t + (b.tack === -1 || hasVeryClose ? 0.12 : 0.36); this.avoidH = best; }
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
    const NEED = 1.95;
    let minObsDist = 99;
    for (const n of near) {
      minObsDist = Math.min(minObsDist, Math.hypot(n.ox, n.oz) - n.o.r);
    }
    if (minObsDist > 4.2 && score(heading) > NEED) return heading;
    const veryCloseObs = minObsDist < 3.6;
    const onM1Leg = !prestart && (b.leg === 0 || b.leg === 3);
    const onUpwindMid = !veryCloseObs && !prestart && (b.leg === 0 || b.leg === 3 || COURSE_MODE === 'upwind') && (b.a < MARKS.m1.a - 18 || (b.tack === 1 && b.a < MARKS.m1.a + 0.8 && b.c > 1.5));
    const inM1TopBearAway = !veryCloseObs && onM1Leg && b.tack === 1 && b.a >= MARKS.m1.a + 1.2 && b.c >= -5.0 && b.c <= 18.0;
    const nearPinPreStart = (prestart || !b.started) && b.c < -LINE_HALF + 14.0 && b.a < MARKS.pin.a + 3.5 && b.tack === 1;
    const ok = (h) => {
      const rel = wrap(W - h);
      const tw = Math.abs(rel);
      if (nearPinPreStart && rel < 0) return false; // アウター付近の下スタでポートタック方向へ切り上げてスタボ艇とぶつかるのを防止(必ずベアしてジャイブ側へ逃げる)
      if (onUpwindMid && (tw > ca + 0.14 || rel * (b.tack || 1) < 0)) return false;
      if (inM1TopBearAway && (tw < 1.10 || rel * (b.tack || 1) < 0)) return false;
      return tw > (veryCloseObs ? 0.60 : Math.max(0.68, ca - 0.05)) && (!b.pole || tw > POLE_MIN);
    };
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
    const maxStep = veryCloseObs ? 20 : 12;
    const stepRad = veryCloseObs ? 0.095 : 0.11;
    for (let i = 1; i <= maxStep; i++) {
      for (const s of [1, -1]) {
        const d = s * i * stepRad, h = wrap(heading + d);
        if (!ok(h)) continue;
        const c = score(h);
        const v = (c > NEED ? 100 - Math.abs(d) * 10 : c * 8.0 - Math.abs(d) * 0.5) - wrongSide(h);
        if (v > bestV) { bestV = v; best = h; }
      }
    }
    return best;
  }

  // ランチャー: 下レグで真風角が十分深く、マークから離れていれば上げる (タック違いや上り角度に変わる時は即座に収納して舵ロックを防ぐ)
  updatePole(dt, heading, distMark, rounding) {
    const b = this.b;
    const relH = wrap(b.windFrom - heading);
    const twaH = Math.abs(relH);
    const sameTack = Math.sign(relH || 1) === Math.sign(b.rel || b.tack || 1);
    const onUpwindLeg = b.leg === 0 || b.leg === 3 || COURSE_MODE === 'upwind';
    const want = !b.ocs && !b.penalty && !b.maneuver && !rounding && !onUpwindLeg && sameTack && distMark > 32 && twaH > 2.02 && b.twa > 1.95;
    this.poleT = want ? this.poleT + dt : 0;
    if (!b.pole && this.poleT > 1.2) b.setPole(true);
    if (b.pole && (!want && (twaH < 1.92 || b.twa < 1.90 || !sameTack || onUpwindLeg || distMark < 28 || rounding || b.penalty || b.maneuver))) {
      b.setPole(false);
    }
  }

  update(dt, t, others) {
    const b = this.b;
    this.others = others;
    this.now = t;
    const curOptDeg = b.bestCloseDeg || bestCloseDeg(BASE_WIND_KT * (b.windF || 1));
    this.closeAngle = (curOptDeg * Math.PI) / 180 + this.closeAngleOffset;
    if (b.maneuver) {
      // スタボ(s0 === 1)からポート(relNew < 0)へタックする最中にスタボ艇が近くにいる場合は、タック完了角(relNew)を風下へ深く落としてタック後すぐにスタボ艇のスターン後方へ逃げる
      if (b.maneuver.kind === 'tack' && b.maneuver.s0 === 1 && b.maneuver.relNew < 0 && this.hasStbdTackConflict()) {
        const duckRel = this.findPostTackDuckAngle() || -(this.closeAngle + 0.36);
        b.maneuver.relNew = Math.min(b.maneuver.relNew, duckRel);
        this.postTackDuckUntil = t + 3.8;
        this.postTackDuckRel = b.maneuver.relNew;
      }
      return;
    }
    if (b.penalty) {
      if (b.pole) b.setPole(false);
      // マークや運営艇のすぐ近く(5.2m以内)にいる間はその場で回転せず、まず障害物から離れたクリアな海面へ出てからペナルティターンを行う
      if (this.nearObstacle(5.2)) {
        b.throttle = 1;
        b.sheet += (sheetOpt(b.twa) - b.sheet) * (1 - Math.exp(-dt * 4.5));
        const escH = this.avoidMarks(b.h, t < 0);
        b.steer = clamp(wrap(escH - b.h) * 3.8, -1, 1);
        return;
      }
      b.steer = this.penDir;
      b.throttle = 1;
      return;
    }
    b.sheet += (sheetOpt(b.twa) - b.sheet) * (1 - Math.exp(-dt * 4.5));

    // ブランケット / バックウインド脱出判定 (タック先やジャイブ先もブランケットでない場合は脱出する)
    const dirtyStrength = Math.max(b.cover, b.back * 1.15);
    this.coverTime = dirtyStrength > 0.22
      ? (this.coverTime || 0) + dt * (0.65 + dirtyStrength * 1.35)
      : Math.max(0, (this.coverTime || 0) - dt * 1.4);
    const Lc = LEGS[Math.min(b.leg, LEGS.length - 1)];
    const nearMark = Lc && Lc.type === 'mark' && Math.hypot(b.c - Lc.mark.c, b.a - Lc.mark.a) < 38;
    const inGateRound = this.gateRp && this.gateRp.phase !== 'done';
    if (this.coverTime > 2.6 && t > 6 && t - this.lastTack > 16 && b.started && !b.ocs && !nearMark && !inGateRound) {
      if (b.twa < 1.42 && !b.pole && this.canEscapeBlanket('tack') && this.canExecuteTackNow()) {
        this.lastTack = t;
        this.coverTime = 0;
        // 脱出後のタック方向に合わせて回廊中心もシフトし、直後にまた元のブランケットへ戻らないようにする
        this.prefSideC = clamp(b.c + b.tack * 48, -90, 90);
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
    let isUpwindStrictlyClose = false;
    const prestart = t < 0;
    if (b.finished) {
      if (b.pole) b.setPole(false);
      const dtFin = Math.max(0, t - (b.finishTime ?? t));
      const runOutDur = 7.5 + (b.id % 5) * 1.35; // フィニッシュ後 7.5〜13秒間(約30〜48m)はそのまま前に進んでフィニッシュラインを完全に空ける
      if (dtFin < runOutDur) {
        b.postFinishStop = false;
        b.throttle = 0.95;
        let runH = b.finishHeading ?? b.h;
        const relRun = wrap(b.windFrom - runH);
        if (Math.abs(relRun) < this.closeAngle) {
          runH = wrap(b.windFrom - (b.finishTack || b.tack || 1) * this.closeAngle);
        }
        heading = runH;
        // 強風域(赤旗風域)のクローズでオーバーヒールしてきた際、CP艇もフェアにメインセールを抜いて(出して)ヒールを逃がし、
    // 反応が遅れたCP艇や強風ブローに掴まったCP艇はメインを抜ききれず徐々にオーバーヒールして沈する
    const optS = sheetOpt(b.twa);
    const skillEaseThresh = 0.44 + clamp(1.05 - (b.skill || 1), 0, 0.25) * 1.85 + Math.sin(t * 0.65 + b.id * 2.3) * 0.16;
    if ((b.capsizeRisk || 0) > skillEaseThresh) {
      this._easingForGust = true;
    } else if ((b.capsizeRisk || 0) < 0.18) {
      this._easingForGust = false;
    }
    if (this._easingForGust && t >= 0 && !b.finished) {
      b.easingSheet = true;
      const targetEaseSheet = 0.42;
      b.sheet += (targetEaseSheet - b.sheet) * (1 - Math.exp(-dt * 4.2));
    } else {
      b.easingSheet = false;
      b.sheet += (optS - b.sheet) * (1 - Math.exp(-dt * 4.5));
    }
      } else {
        // 十分前に進んだら風上へ上してセールを緩め、シバーさせて止まる
        b.postFinishStop = true;
        b.throttle = 0;
        b.sheet = 0.05;
        const stopTack = b.finishTack || b.tack || 1;
        heading = wrap(b.windFrom - stopTack * 0.25);
        const errStop = wrap(heading - b.h);
        b.steer = clamp(errStop * 2.2, -0.85, 0.85);
        return;
      }
    } else if (prestart) {
      const W = b.windFrom;
      const role = b.startRole || 'firstRow';
      if (role === 'highComFail') {
        // 本部船の上(風上・右側 c > LINE_HALF)で待機し、スペースを失ってスタートに失敗→本部船スターン側へ落として第二線から出るCP艇
        const safeComLineA = Math.min(MARKS.com.a, lineA(b.c));
        if (t < -6.5) {
          const waitA = safeComLineA - 11.5;
          const waitC = LINE_HALF + 4.2;
          const distA = waitA - b.a;
          b.throttle = distA > 3.5 ? 0.48 : 0.05;
          b.sheet = distA > 3.5 ? sheetOpt(b.twa) : 0.10;
          if (b.a > safeComLineA - 2.2) b.v = Math.min(b.v, 0.15);
          const holdAng = clamp(this.closeAngle + (b.c - waitC) * 0.03, this.closeAngle - 0.05, this.closeAngle + 0.18);
          heading = wrap(W - b.tack * holdAng);
          if (b.tack === -1 && (b.c > LINE_HALF + 10 || t > -14) && t - this.lastTack > 8 && this.canExecuteTackNow()) {
            this.lastTack = t;
            b.startManeuver('tack');
          }
        } else {
          // 号砲前に本部船に阻まれて入れず、本部船の後ろ(風下側)へベアして回り込み、本部船の内側(c <= LINE_HALF - 3.5)へ入ったらスターボードのクローズへ戻す
          b.throttle = b.a > safeComLineA - 2.5 ? 0.25 : 0.78;
          // 強風域(赤旗風域)のクローズでオーバーヒールしてきた際、CP艇もフェアにメインセールを抜いて(出して)ヒールを逃がし、
    // 反応が遅れたCP艇や強風ブローに掴まったCP艇はメインを抜ききれず徐々にオーバーヒールして沈する
    const optS = sheetOpt(b.twa);
    const skillEaseThresh = 0.44 + clamp(1.05 - (b.skill || 1), 0, 0.25) * 1.85 + Math.sin(t * 0.65 + b.id * 2.3) * 0.16;
    if ((b.capsizeRisk || 0) > skillEaseThresh) {
      this._easingForGust = true;
    } else if ((b.capsizeRisk || 0) < 0.18) {
      this._easingForGust = false;
    }
    if (this._easingForGust && t >= 0 && !b.finished) {
      b.easingSheet = true;
      const targetEaseSheet = 0.42;
      b.sheet += (targetEaseSheet - b.sheet) * (1 - Math.exp(-dt * 4.2));
    } else {
      b.easingSheet = false;
      b.sheet += (optS - b.sheet) * (1 - Math.exp(-dt * 4.5));
    }
          if (b.a > safeComLineA - 1.8) b.v = Math.min(b.v, 0.20);
          if (b.c > LINE_HALF - 3.5) {
            const sternW = toWorld(Math.min(b.a - 2.5, safeComLineA - 7.5), LINE_HALF - 6.5);
            heading = this.bearing(sternW.x, sternW.z);
          } else {
            heading = wrap(W - this.closeAngle);
          }
        }
      } else {
        // 後ろ(第2列)で待機し、スタート前に前線の船と船の間(ギャップ)を狙って滑り込むCP艇(gapShooter)の隙間スキャン
        if (role === 'gapShooter' && t > -26 && t < -2.2 && t >= (this.nextGapScanT || -99)) {
          this.nextGapScanT = t + 1.1;
          this.scanPrestartGap(t);
        }
        // プリスタート: ピン端(-LINE_HALF)の外側へ流れ出てスタートラインを切れない艇が出ないよう、左端は -LINE_HALF + 12.5 までに制限
        const tgtC = clamp(this.targetStartC ?? 0, -LINE_HALF + 12.5, LINE_HALF - 3.8);
        const lineAtTgt = lineA(tgtC);
        const lineHere = Math.min(lineA(b.c), lineA(clamp(b.c, -LINE_HALF, LINE_HALF)));
        // 0秒時点でスタートラインぎりぎり(リコールしない直前: 手前約0.8〜1.2m)まで寄せて0秒で飛び出せるように設定
        const ocsSafetyMargin = this.willOcs ? -2.8 : 0.85;
        const targetLineA = (b.c > LINE_HALF - 7 ? Math.min(lineHere, lineAtTgt) : Math.min(lineHere, lineAtTgt + 0.8)) - ocsSafetyMargin;
        const gap = targetLineA - b.a;
        const posGap = Math.max(0, gap);
        const tw = Math.min(b.twa, 1.1);
        const upf = Math.max(0.48, Math.cos(tw) + Math.tan(LINE_SKEW) * Math.sin(tw) * b.tack);
        if (this.gap0 === null) this.gap0 = Math.max(24, posGap);
        const holdDist = role === 'gapShooter' ? 7.2 : (role === 'secondRow' ? 8.2 : (this.willOcs ? 2.0 : 4.2));
        const holdEndT = role === 'gapShooter' ? -5.8 : (role === 'secondRow' ? -1.8 : (this.willOcs ? -5.0 : -4.2));
        if (!this.go && t >= this.tc - this.runUpTime(posGap / upf) && (t > -10.5 || posGap > holdDist + 1.5)) this.go = true;
        if (gap < holdDist + 0.3 && t < holdEndT) this.go = false; // 加速開始時刻(holdEndT)より前にラインへ寄りすぎるのを防ぐ
        // willOcsでない通常CP艇は0:00より前にラインを超えないよう、直前でラインを超えそうな場合のみ減速・シバーさせる
        const projZeroA = b.a + Math.max(0, -t) * Math.max(0, b.v) * upf;
        const earlyHoldLimitA = t < -14.0 ? lineHere - holdDist - 3.0 : lineHere - 0.95;
        const tooEarlyForLine = !this.willOcs && (b.a > earlyHoldLimitA || (t > -5.5 && projZeroA > lineHere - 0.55));
        if (tooEarlyForLine) this.go = false;
        if (tooEarlyForLine) {
          b.throttle = 0;
          b.sheet = 0.05;
          if (b.a > earlyHoldLimitA + 0.25) {
            b.v = Math.min(b.v, Math.max(0.05, (earlyHoldLimitA + 0.65 - b.a) * 0.45));
          }
        } else if (this.go) {
          b.throttle = 1;
          // 強風域(赤旗風域)のクローズでオーバーヒールしてきた際、CP艇もフェアにメインセールを抜いて(出して)ヒールを逃がし、
    // 反応が遅れたCP艇や強風ブローに掴まったCP艇はメインを抜ききれず徐々にオーバーヒールして沈する
    const optS = sheetOpt(b.twa);
    const skillEaseThresh = 0.44 + clamp(1.05 - (b.skill || 1), 0, 0.25) * 1.85 + Math.sin(t * 0.65 + b.id * 2.3) * 0.16;
    if ((b.capsizeRisk || 0) > skillEaseThresh) {
      this._easingForGust = true;
    } else if ((b.capsizeRisk || 0) < 0.18) {
      this._easingForGust = false;
    }
    if (this._easingForGust && t >= 0 && !b.finished) {
      b.easingSheet = true;
      const targetEaseSheet = 0.42;
      b.sheet += (targetEaseSheet - b.sheet) * (1 - Math.exp(-dt * 4.2));
    } else {
      b.easingSheet = false;
      b.sheet += (optS - b.sheet) * (1 - Math.exp(-dt * 4.5));
    }
        } else if (gap < holdDist && t < holdEndT) {
          // 待機ラインで待つ際も、下流れで後ろへ落ちすぎないよう微速を維持
          const isComSide = tgtC >= 12;
          b.throttle = isComSide ? 0.18 : 0.10;
          b.sheet = isComSide ? 0.26 : 0.16;
        } else {
          const vT = polar((this.closeAngle * 180) / Math.PI) * SPEED_SCALE * Math.pow(b.windF || 1, 0.8) * b.skill;
          const goL = Math.min(this.goDist, this.gap0);
          const tGo = this.tc - this.runUpTime(goL / upf);
          const span = Math.max(5, tGo - START_T);
          // 1分前〜前半は後ろの待機位置付近にとどまり、後半にかけて加速開始位置(goL)へしっかり上がるカーブ
          const fRaw = clamp((t - START_T) / span, 0, 1);
          const p = this.creepExp * 1.35;
          const D = goL + Math.max(0, this.gap0 - goL) * (1 - Math.pow(fRaw, p));
          const dDdt = (Math.max(0, this.gap0 - goL) * p * Math.pow(Math.max(fRaw, 1e-3), p - 1)) / span;
          // 低速時の下流れ(リーウェイ＋風圧ドリフト)に負けず確実にライン手前(goL)まで上がれるようドリフト補償と最低スロットルを引き上げ
          const driftComp = posGap > D - 0.8 ? 1.12 * SPEED_SCALE * (b.windF || 1) : 0;
          const vDes = Math.max(0, dDdt + 0.62 * (posGap - D) + driftComp) / upf;
          b.throttle = posGap < D - 0.8
            ? clamp(vDes / Math.max(0.1, vT), 0.08, 0.35)
            : clamp(vDes / Math.max(0.1, vT), 0.65, 1.0);
          // セールは待機距離(D)よりラインに近いときだけ緩めて減速し、通常アプローチ中は最適トリムで下流れを抑える
          b.sheet = posGap < D - 0.8
            ? Math.max(0.14, sheetOpt(b.twa) - 0.36)
            : sheetOpt(b.twa);
        }
        // 下スタ失敗時のジャイブやり直し判定 (pinBailout):
        // アウター(MARKS.pin)付近でスタボのままではアウターを上れずぶつかる角度になった場合、
        // そのままポートへタックして右から来るスタボ艇群と衝突するのを防ぎ、一度ベアしてジャイブしライン下へ回り込んで出直す
        const cPinClear = -LINE_HALF + 3.2;
        const remPinC = b.c - cPinClear;
        const cotClose = 1 / Math.tan(Math.max(0.65, this.closeAngle));
        const projPinA = b.a + remPinC * cotClose * 0.78 - (b.v < 1.2 ? 2.0 : 0);
        if (!this.pinBailout && t > -24.0 && b.tack === 1 && b.c < -LINE_HALF + 16.5) {
          const cannotClearPin = projPinA < MARKS.pin.a + 2.6 || (b.c < -LINE_HALF + 4.5 && b.a < MARKS.pin.a + 3.2);
          const blockedNearPin = b.c < -LINE_HALF + 12.0 && (this.hasStbdTackConflict() || !this.canExecuteTackNow());
          if (cannotClearPin || blockedNearPin) {
            this.pinBailout = true;
            this.go = false;
          }
        }
        if (this.pinBailout) {
          b.throttle = 0.92;
          b.sheet = sheetOpt(b.twa);
          if (b.tack === 1) {
            // 1) まず風下(ランニング方向)へ大きくベアしてアウターの風下側へ逃げる→ジャイブしてポートタックへ
            heading = wrap(W - 2.75);
            if (b.twa > 2.15 && !b.maneuver && t - this.lastTack > 2.5) {
              this.lastTack = t;
              b.startManeuver('gybe');
            }
          } else {
            // 2) ジャイブ完了後(ポートタック): スタートラインより十分下(a = MARKS.pin.a - 11m)を右(+c)へ走って出直し位置へ戻る
            const bailTgtA = Math.min(MARKS.pin.a - 10.5, lineA(b.c) - 11.0);
            const bailTgtC = -LINE_HALF + 20.0;
            const bailW = toWorld(bailTgtA, bailTgtC);
            heading = this.bearing(bailW.x, bailW.z);
            if (b.c >= -LINE_HALF + 15.5 && b.a <= lineA(b.c) - 6.0 && t - this.lastTack > 3.0) {
              this.pinBailout = false;
              this.lastTack = t;
              b.startManeuver('tack');
            }
          }
        } else {
          // スターボードタック(左進)で号砲時に見込まれる横座標cPred (残り時間の下流れ＋前進による左移動を正確に見込む)
          const remT = Math.max(0, -t);
          const driftLeft = remT * 0.42;
          const cPred = b.c - posGap * Math.tan(this.closeAngle) * 0.95 - driftLeft;
          let preAngle = this.closeAngle;
          if (b.tack === 1) {
            // gapShooterが加速突入中(t > -7.5)は狙った船間のギャップ(tgtC)へ正確に入るよう角度を微調整
            const gainC = role === 'gapShooter' && this.go ? 0.024 : 0.016;
            const maxBear = role === 'gapShooter' && this.go ? 0.16 : 0.10;
            preAngle = clamp(this.closeAngle + (cPred - tgtC) * gainC, this.closeAngle - 0.07, this.closeAngle + maxBear);
            if (b.c < -LINE_HALF + 9.0) {
              // ピン端近くにいる時は左(-c)へ流されてピン外へ落ちないよう少し上し気味(ピンチ)に保つ
              preAngle = Math.min(preAngle, this.closeAngle - 0.05);
            } else if (b.c > LINE_HALF - 2.5 && b.a > MARKS.com.a - 5.0) {
              // 本部船のすぐ真下に迫った時だけ少しベアして本部船の左(ライン内側)へかわす
              preAngle = Math.max(preAngle, this.closeAngle + 0.22);
            }
          }
          heading = wrap(W - b.tack * preAngle);
          if (t - this.lastTack > (b.tack === -1 && t > -14 ? 3.5 : 7.5)) {
            let wantTack = false;
            // 右舷タック(左へ進む)で目標tgtCより左へ流されそうな場合は早めにポートタックへ返して本部船側(右/+c)へ上り直す(ただし残り15秒以降はポートへ返さない)
            const minCPred = tgtC >= 15 ? tgtC - 3.0 : Math.max(-LINE_HALF + 8.0, tgtC - 6.0);
            const nearPinLimit = b.tack === 1 && b.c < -LINE_HALF + 12.0 && t < -14.0;
            if (b.tack === 1 && (nearPinLimit || (t < -15.0 && cPred < minCPred))) wantTack = true;
            // 左舷タック(右へ進む): 残り時間の下流れ分も含めて十分右(+c)へ上り直したか、残り14秒を切ったら必ずスターボードタックへ返す
            const maxPortC = tgtC >= 25 ? LINE_HALF + 28 : LINE_HALF - 3;
            const recoverMargin = tgtC >= 15 ? 6.5 : 2.5;
            const mustReturnStbd = b.tack === -1 && t > -14.0;
            if (b.tack === -1 && (b.c > maxPortC || cPred >= tgtC + recoverMargin || mustReturnStbd)) wantTack = true;
            const crowdLim = mustReturnStbd ? 2.2 : ((b.tack === -1 && t > -16) || nearPinLimit ? 3.8 : 5.2);
            if (wantTack && !this.crowded(crowdLim, true) && !this.nearObstacle(mustReturnStbd ? 4.2 : 6.0)) {
              if (b.tack === 1 && this.hasStbdTackConflict()) {
                // ピン端近くでスタボ艇と競合する場合は無理にポートへタックせず、ジャイブでやり直す
                if (b.c < -LINE_HALF + 16.0) {
                  this.pinBailout = true;
                } else {
                  const duckRel = this.findPostTackDuckAngle();
                  if (duckRel !== null && this.canExecuteTackNow(duckRel)) {
                    this.lastTack = t;
                    b.startManeuver('tack');
                    if (b.maneuver) b.maneuver.relNew = duckRel;
                    this.postTackDuckUntil = t + 3.8;
                    this.postTackDuckRel = duckRel;
                  }
                }
              } else if (mustReturnStbd || this.canExecuteTackNow()) {
                this.lastTack = t;
                b.startManeuver('tack');
              }
            }
          }
        }
      }
    } else if (b.ocs) {
      b.throttle = 1;
      if (b.pole) b.setPole(false);
      this.mustReturnBelowLine = true;
      const returnC = clamp(b.c, -LINE_HALF + 6, LINE_HALF - 6);
      heading = this.headingFor({ a: lineA(returnC) - 14, c: returnC }, t, false, true);
    } else if (!b.started) {
      // まだスタートライン(ピン〜本部船の間)を切っていない艇:
      // もし本部船の外側(c > LINE_HALF)やピンの外側(c < -LINE_HALF)からライン延長線より風上に出てしまった場合や、
      // ラインの端で行き場を失った場合も、必ず一度ラインの下(a <= lineA - 4.5, |c| <= LINE_HALF - 5)へ戻ってから正規にラインを切る
      b.throttle = 1;
      if (b.pole) b.setPole(false);
      const clampedC = clamp(b.c, -LINE_HALF + 6, LINE_HALF - 6);
      const laHere = lineA(clampedC);
      if (b.a > laHere - 0.6 || Math.abs(b.c) > LINE_HALF - 1.2) {
        this.mustReturnBelowLine = true;
      } else if (this.mustReturnBelowLine && b.a <= laHere - 4.5 && Math.abs(b.c) <= LINE_HALF - 4.5) {
        this.mustReturnBelowLine = false;
      }
      const cPinClear = -LINE_HALF + 3.2;
      const remPinC = b.c - cPinClear;
      const cotClose = 1 / Math.tan(Math.max(0.65, this.closeAngle));
      const projPinA = b.a + remPinC * cotClose * 0.78 - (b.v < 1.2 ? 2.0 : 0);
      if (!this.pinBailout && b.tack === 1 && b.c < -LINE_HALF + 16.0 && (projPinA < MARKS.pin.a + 2.4 || (b.c < -LINE_HALF + 9.0 && (this.hasStbdTackConflict() || !this.canExecuteTackNow())))) {
        this.pinBailout = true;
      }
      if (this.pinBailout) {
        // 号砲後に下スタでアウターを上れず失敗した艇: タックしてスタボ艇に突っ込まず、ベアしてジャイブしライン下から出直す
        b.sheet = sheetOpt(b.twa);
        if (b.tack === 1) {
          heading = wrap(b.windFrom - 2.75);
          if (b.twa > 2.15 && !b.maneuver && t - this.lastTack > 2.5) {
            this.lastTack = t;
            b.startManeuver('gybe');
          }
        } else {
          const bailTgtA = Math.min(MARKS.pin.a - 10.5, laHere - 11.0);
          const bailTgtC = -LINE_HALF + 20.0;
          const bailW = toWorld(bailTgtA, bailTgtC);
          heading = this.bearing(bailW.x, bailW.z);
          if (b.c >= -LINE_HALF + 15.5 && b.a <= laHere - 6.0 && t - this.lastTack > 3.0) {
            this.pinBailout = false;
            this.lastTack = t;
            b.startManeuver('tack');
          }
        }
      } else if (b.c > LINE_HALF - 3.5 && b.a > MARKS.com.a - 7.5) {
        // 本部船の右側・上側にいる場合は本部船のスターン側(風下・内側)を大きく回り込んでライン下へ戻る
        const sternW = toWorld(MARKS.com.a - 8.5, LINE_HALF - 8.5);
        heading = this.bearing(sternW.x, sternW.z);
      } else if (b.c < -LINE_HALF + 3.5 && b.a > MARKS.pin.a - 6.5) {
        // ピン艇の左側・上側にいる場合はピン艇のスターン側(風下・内側)を回り込んでライン下へ戻る
        const sternW = toWorld(MARKS.pin.a - 8.5, -LINE_HALF + 12.5);
        heading = this.bearing(sternW.x, sternW.z);
        if (b.tack === 1 && b.twa > 2.15 && !b.maneuver && t - this.lastTack > 2.5) {
          this.lastTack = t;
          b.startManeuver('gybe');
        }
      } else if (this.mustReturnBelowLine) {
        // ライン風上側からライン下(a = laHere - 7.5)の内側へ一度戻る
        const retW = toWorld(laHere - 7.5, clampedC);
        heading = this.bearing(retW.x, retW.z);
      } else {
        // ライン下の内側に復帰したら、ピン・本部船の外へ出ないタックを選んでクローズホールドでスタートラインを切る
        if (b.tack === 1 && b.c < -LINE_HALF + 8.0 && t - this.lastTack > 4.0) {
          if (!this.hasStbdTackConflict() && this.canExecuteTackNow()) {
            this.lastTack = t;
            b.startManeuver('tack');
          } else {
            this.pinBailout = true;
          }
        } else if (b.tack === -1 && b.c > LINE_HALF - 8.0 && t - this.lastTack > 4.0 && this.canExecuteTackNow()) {
          this.lastTack = t;
          b.startManeuver('tack');
        }
        isUpwindStrictlyClose = true;
        heading = wrap(b.windFrom - b.tack * this.closeAngle);
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
          rounding = (this.rp ? this.rp.idx > 0 : false) || distMark < 28;
          if (tgt && tgt.forceDirect) directDownwind = true;
        } else {
          tgt = L.aim;
          distMark = Math.hypot(b.c - L.center.c, b.a - L.center.a);
          if (COURSE_MODE === 'upwind' && L.type === 'finish') {
            // 上マークフィニッシュ(a=600, fm.c=-22 .. fcom.c=24)でライン端の外側へ出た場合は一度ライン手前中央(a=590)へ戻してから切る
            if (b.a > 588 && (b.c < MARKS.fm.c + 3.0 || b.c > MARKS.fcom.c - 3.0)) {
              tgt = { a: 590, c: clamp(b.c * 0.25, -10, 12) };
              directDownwind = true;
            }
          } else if (COURSE_MODE === 'trapezoid' && L.type === 'finish') {
            // フィニッシュリーチング(leg 6: 3マーク→フィニッシュ)では基本的に上側(本部船 fcom: a=-95, c=-70 側)でフィニッシュする方が早く実戦でも上側を狙うため、
            // 本部船のすぐ下側(u=0.16..0.30: a≈-101..-107, c≈-76..-82)を狙ってフィニッシュラインを切る
            const uUpper = 0.16 + ((b.id % 5) * 0.032);
            const lineA = MARKS.fcom.a + (MARKS.fm.a - MARKS.fcom.a) * uUpper;
            const lineC = MARKS.fcom.c + (MARKS.fm.c - MARKS.fcom.c) * uUpper;
            const F = MARKS.fcom, G = MARKS.fm;
            const sNow = (G.a - F.a) * (b.c - F.c) - (G.c - F.c) * (b.a - F.a);
            const sRef = (G.a - F.a) * (MARKS.m3.c - F.c) - (G.c - F.c) * (MARKS.m3.a - F.a);
            if (sNow * sRef <= 0) {
              // 万一フィニッシュライン外側から裏へ流れた場合は一度ライン正面の上側(a≈-96, c≈-86)へ戻してから切る
              tgt = { a: lineA + 6, c: lineC - 10 };
            } else {
              tgt = { a: lineA - 8, c: lineC + 8 };
            }
            distMark = Math.hypot(b.c - lineC, b.a - lineA);
            directDownwind = true;
          }
        }
      }
      const onUpwindLeg = b.leg === 0 || b.leg === 3 || COURSE_MODE === 'upwind';
      const inGateExitNow = b.leg === 3 && this.gateRp && this.gateRp.phase !== 'done';
      const inMarkOrbitNow = L.type === 'mark' && this.rp && (this.rp.phase === 'orbit' || this.rp.phase === 'exit');
      isUpwindStrictlyClose = onUpwindLeg && !inGateExitNow && !inMarkOrbitNow && !directDownwind && b.a < MARKS.m1.a - 5.0;
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

      // 下レグ(ランニング: leg 2, 4, 5, 6)で戦術的に強いCP艇が「前の船をブランケット(風影)に入れようと少しだけ意識する」処理
      // (ただしそのために大きくプロパーコースを逸れることはしないよう、最大±5.4°=0.095radの微調整に制限)
      if (!rounding && !onUpwindLeg && distMark > 28 && this.isTacticalStrong && twaBrg > 1.85) {
        const ux = Math.sin(heading), uz = -Math.cos(heading);
        let bestBlanketBrg = null, bestDist = 99;
        for (const o of this.others) {
          if (o === b || o.finished || o.dsq || o.leg !== b.leg) continue;
          const dx = o.x - b.x, dz = o.z - b.z;
          const d = Math.hypot(dx, dz);
          if (d < 3.5 || d > 25.0) continue;
          const ahead = dx * ux + dz * uz;
          if (ahead < 2.8 || ahead > 24.0) continue;
          // 自艇bの風影(真風の下流方向)がちょうど先行艇oに重なるための目標方位を算出
          const brgO = this.bearing(o.x, o.z);
          const diff = wrap(brgO - heading);
          // 現在のプロパーコースから約17°(0.30rad)以内にいる先行艇のみ対象とし、大きくコースを外れる追いかけはしない
          if (Math.abs(diff) < 0.30 && d < bestDist) {
            bestDist = d;
            bestBlanketBrg = diff;
          }
        }
        if (bestBlanketBrg !== null) {
          const nudge = clamp(bestBlanketBrg * 0.42, -0.095, 0.095);
          const candH = wrap(heading + nudge);
          const candTwa = Math.abs(wrap(W - candH));
          if (candTwa >= 2.25 && (!b.pole || candTwa > POLE_MIN)) {
            heading = candH;
          }
        }
      }

      this.updatePole(dt, heading, distMark, rounding);
    }
    const av = prestart ? this.avoid(t, heading) : this.avoid(t, heading);
    if (av !== null && av !== undefined) heading = av;
    heading = this.avoidMarks(heading, prestart);

    // クローズホールド走行中の角度安定ガード:
    // 上りレグ中盤(isUpwindStrictlyClose)でタック中でもOCSでもないのに、回避等の合成で風向眼(twa < 39°)へ突っ込んだり
    // タックと逆符号の向きや極端なリーチング角へ逸れるのを防ぎ、常に自然なクローズホールド角度帯を厳守させる
    // (ただし他艇との近접回避 av !== null やスタボ艇ダック中は、相手のスターン後方を確実に抜けられるよう最大1.68radまで許容する)
    if (!prestart && isUpwindStrictlyClose && !b.maneuver && !b.ocs) {
      const W = b.windFrom;
      const isDuckingStbd = (b.tack === -1 && this.postTackDuckUntil && t < this.postTackDuckUntil) || this.hasPortStbdThreat || (av !== null && av !== undefined);
      const minAllowTwa = Math.max(0.62, this.closeAngle - (this.crowded(3.8) ? 0.11 : 0.045));
      const maxAllowTwa = isDuckingStbd ? 1.62 : this.closeAngle + 0.16;
      const relCurDes = wrap(W - heading);
      const clampedTwa = clamp(Math.abs(relCurDes), minAllowTwa, maxAllowTwa);
      const signTack = b.tack || Math.sign(relCurDes) || 1;
      heading = wrap(W - signTack * clampedTwa);
    }

    let err = wrap(heading - b.h);
    // 4ゲート回航(orbit/tightExit)中に現在針路がまだ風下(|relNow| > 1.35)にある場合、
    // ±π付近で舵の左右が反転して真南(twa≈170°)へ走り続ける現象を防ぎ、必ず指定マークの回航方向(4S=右回転+1, 4P=左回転-1)へ回頭させる
    const relNow = wrap(b.windFrom - b.h);
    const relDes = wrap(b.windFrom - heading);
    if (!prestart && this.gateRp && (this.gateRp.phase === 'orbit' || this.gateRp.phase === 'tightExit') && Math.abs(relNow) > 1.35) {
      if (b.pole) b.setPole(false);
      const gateTurnDir = -this.gateRp.s; // gL(s=-1)は右回転(+1)、gR(s=+1)は左回転(-1)
      if (Math.abs(err) > 1.5 && err * gateTurnDir < 0) {
        err = gateTurnDir * Math.max(0.8, Math.abs(err));
      }
    } else if (!prestart && Math.abs(relNow) > 1.65 && Math.abs(relDes) > 1.55 && relNow * relDes < 0) {
      if (b.pole) b.setPole(false);
      // relNow > 0 (スタボ)から relDes < 0 (ポート)へ風下経由で回るには左回転(err < 0)
      const gybeDir = relNow > 0 ? -1 : 1;
      if (err * gybeDir < 0) err = gybeDir * Math.max(0.6, Math.abs(err));
    }
    const steerGain = av !== null && av !== undefined ? 4.2 : 2.6;
    b.steer = clamp(err * steerGain, -1, 1);
    if (b.maneuver) b.steer = 0;
  }
}

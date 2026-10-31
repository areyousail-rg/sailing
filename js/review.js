// レース振り返り: 全艇の航跡・艇速(上り/下り/リーチング)・対風角(上り/下り)・走行距離・スタート順位・タック/ジャイブ数・海面風況を記録し分析表示する
import { playBgm } from './audio.js';
const CAUSES = ['タック/ジャイブ', 'ブランケット', 'バックウインド', '波', '接触', 'ペナルティ', 'マーク回航', '風の弱まり・振れ'];

function causeOf(b) {
  if (b.penalty) return 'ペナルティ';
  if (b.maneuver || b.tacking) return 'タック/ジャイブ';
  if (b.contactCD > 2.2 || b.touchCD > 5.2) return '接触';
  if (b.back > 0.15) return 'バックウインド';
  if (b.cover > 0.2) return 'ブランケット';
  if (b.waveLoss > 0.06) return '波';
  if (b.visit) return 'マーク回航';
  return '風の弱まり・振れ';
}

export class Recorder {
  constructor(boats, legs, meta = {}) {
    this.meta = meta;
    this.legs = legs;
    this.d = new Map();
    this.acc = 1;
    this.endT = 0;
    this.n = boats.length;
    this.windHistory = [];
    this.seaStats = { leftF: 0, rightF: 0, centerF: 0, leftPuff: 0, rightPuff: 0, count: 0 };
    for (const b of boats) {
      this.d.set(b.id, {
        id: b.id, color: b.color, isPlayer: b.isPlayer, sailNo: b.sailNo, nat: b.nat, boat: b,
        track: [], dist: 0, lx: b.x, lz: b.z,
        spdSum: 0, spdT: 0,
        upSpdSum: 0, upSpdT: 0,
        dnSpdSum: 0, dnSpdT: 0,
        rcSpdSum: 0, rcSpdT: 0,
        upAngSum: 0, upAngT: 0, upAngRawSum: 0, upAngRawT: 0,
        upCourseAngSum: 0, upCourseAngT: 0, upShiftGainSum: 0, upShiftGainT: 0,
        dnAngSum: 0, dnAngT: 0, dnAngRawSum: 0, dnAngRawT: 0,
        pinchT: 0, lossPinch: 0, footT: 0, lossFoot: 0,
        windFSum: 0, windFT: 0, lowBlowT: 0,
        headerT: 0, overstandT: 0, lossCourse: 0, vmgSum: 0,
        distAngleDiff: 0, distShiftDiff: 0, distOverDiff: 0,
        startCross: null, startRank: null, gunRank: null,
        ref: Math.abs(b.v), ev: null, events: [],
        tacks: 0, gybes: 0, lastTack: b.tack, stableTack: b.tack, pendT: null, pendKind: 'tack',
        blkT: 0, backT: 0, lossBlk: 0, lossBack: 0, lossWave: 0, contacts: 0, touches: 0, penalties: 0, hadPen: false,
        legMarks: [], lastLeg: b.leg, finishTime: null, done: false, lastRank: null,
      });
    }
  }

  event(e) {
    if (e.type === 'contact') { const g = this.d.get(e.gw.id), r = this.d.get(e.row.id); if (g) g.contacts++; if (r) r.contacts++; }
    else if (e.type === 'touch') { const s = this.d.get(e.boat.id); if (s) s.touches++; }
  }

  step(dt, t, boats, progressOf, lineA) {
    this.endT = t;
    this.acc += dt;
    let ranks = null;
    if (this.acc >= 1) {
      this.acc = 0;
      const sorted = [...boats].sort((a, b) => progressOf(b) - progressOf(a));
      ranks = new Map(); sorted.forEach((b, i) => ranks.set(b.id, i + 1));

      // 海面全体の風況サンプリング (1秒ごと)
      if (t >= 0 && this.meta.windAt && this.meta.toWorld) {
        const wAt = this.meta.windAt;
        const toW = this.meta.toWorld;
        const sampleA = [90, 190, 270];
        let lSum = 0, rSum = 0, cSum = 0, lPuff = 0, rPuff = 0;
        for (const a of sampleA) {
          const pL1 = toW(a, -105), pL2 = toW(a, -50);
          const pC = toW(a, 0);
          const pR1 = toW(a, 50), pR2 = toW(a, 105);
          const wL1 = wAt(pL1.x, pL1.z, t), wL2 = wAt(pL2.x, pL2.z, t);
          const wC = wAt(pC.x, pC.z, t);
          const wR1 = wAt(pR1.x, pR1.z, t), wR2 = wAt(pR2.x, pR2.z, t);
          lSum += (wL1.f + wL2.f) * 0.5;
          cSum += wC.f;
          rSum += (wR1.f + wR2.f) * 0.5;
          lPuff += (wL1.puff + wL2.puff) * 0.5;
          rPuff += (wR1.puff + wR2.puff) * 0.5;
        }
        const k = sampleA.length;
        this.seaStats.leftF += lSum / k;
        this.seaStats.centerF += cSum / k;
        this.seaStats.rightF += rSum / k;
        this.seaStats.leftPuff += lPuff / k;
        this.seaStats.rightPuff += rPuff / k;
        this.seaStats.count++;
      }
      if (t >= -10 && this.meta.shiftAt) {
        const shiftDeg = (this.meta.shiftAt(t) * 180) / Math.PI;
        this.windHistory.push({ t, shiftDeg });
      }
    }

    const isUpwindCourse = this.meta.courseMode === 'upwind';
    for (const b of boats) {
      const s = this.d.get(b.id); if (!s) continue;
      const active = t >= 0 && !s.done && !b.dsq;
      if (active) {
        const ds = Math.hypot(b.x - s.lx, b.z - s.lz);
        s.dist += ds;
        const v = Math.abs(b.v);
        s.spdSum += v * dt; s.spdT += dt;

        // レグ種別(上り / 下り / リーチング)ごとの艇速および上り・下り対風角の集計
        const twaDeg = (b.twa * 180) / Math.PI;
        const effTwaDeg = b.effTwaDeg ?? twaDeg;
        const isUpLeg = isUpwindCourse ? true : (b.leg === 0 || b.leg === 3);
        const isDnLeg = isUpwindCourse ? false : (b.leg === 2 || b.leg === 5);
        const isRcLeg = isUpwindCourse ? false : (b.leg === 1 || b.leg === 4 || b.leg === 6);
        const curShift = this.meta.shiftAt ? this.meta.shiftAt(t) : 0;

        if (isUpLeg) {
          s.upSpdSum += v * dt; s.upSpdT += dt;
          s.upAngRawSum += twaDeg * dt; s.upAngRawT += dt;
          if (!b.maneuver && !b.tacking && !b.penalty && twaDeg >= 24 && twaDeg <= 72) {
            s.upAngSum += twaDeg * dt; s.upAngT += dt;
            const liftRad = b.tack * curShift;
            const liftDeg = (liftRad * 180) / Math.PI;
            s.upShiftGainSum += liftDeg * dt; s.upShiftGainT += dt;
            s.upCourseAngSum += (twaDeg - liftDeg) * dt; s.upCourseAngT += dt;
            const cosOpt = Math.cos((42 * Math.PI) / 180);
            s.distAngleDiff += ds * (1 - Math.cos(b.twa) / cosOpt);
            s.distShiftDiff += ds * ((Math.cos(b.twa) - Math.cos(Math.max(0.08, b.twa - liftRad))) / cosOpt);
          }
          // 1) 上しすぎ(ピンチング < 39.8°)による艇速低下の積算
          if (!b.maneuver && !b.tacking && !b.penalty && twaDeg < 39.8) {
            s.pinchT += dt;
            const pinchSeverity = Math.min(1.2, (39.8 - twaDeg) / 8.0 + (b.luff || 0) * 0.8);
            s.lossPinch += Math.max(0.4, v) * (0.14 + 0.36 * pinchSeverity) * dt;
          }
          // 2) 落としすぎ(> 45.8°)による上りVMG低下の積算
          if (!b.maneuver && !b.tacking && !b.penalty && twaDeg > 45.8 && twaDeg < 88) {
            s.footT += dt;
            const cosOpt = Math.cos((42 * Math.PI) / 180);
            const cosCur = Math.max(0.1, Math.cos(b.twa));
            s.lossFoot += v * Math.max(0, (cosOpt - cosCur) * 0.85) * dt;
          }
        } else if (isDnLeg) {
          s.dnSpdSum += v * dt; s.dnSpdT += dt;
          s.dnAngRawSum += effTwaDeg * dt; s.dnAngRawT += dt;
          if (!b.maneuver && !b.penalty && twaDeg >= 110) {
            s.dnAngSum += effTwaDeg * dt; s.dnAngT += dt;
            const liftRad = -b.tack * curShift;
            const cosOptDn = Math.cos((32 * Math.PI) / 180);
            const offDnRad = Math.max(0.05, Math.PI - b.twa);
            s.distAngleDiff += ds * (1 - Math.cos(offDnRad) / cosOptDn);
            s.distShiftDiff += ds * ((Math.cos(offDnRad) - Math.cos(Math.max(0.05, offDnRad - liftRad))) / cosOptDn);
          }
          if (!b.maneuver && !b.penalty && twaDeg < 134) {
            s.pinchT += dt;
            s.lossPinch += v * 0.16 * dt;
          } else if (!b.maneuver && !b.penalty && twaDeg > 163) {
            s.footT += dt;
            s.lossFoot += v * 0.14 * dt;
          }
        } else if (isRcLeg) {
          s.rcSpdSum += v * dt; s.rcSpdT += dt;
          if (!b.maneuver && !b.penalty && b.luff > 0.08) {
            s.pinchT += dt;
            s.lossPinch += v * (0.18 * b.luff) * dt;
          }
        }

        // 3) ブロー獲得状況の記録 (b.windF: ガスト・海面バイアスを含む風速倍率)
        const wf = b.windF ?? 1.0;
        s.windFSum += wf * dt;
        s.windFT += dt;
        if (wf < 0.985) s.lowBlowT += dt;

        // 4) コース要因(シフト逆走・レイラインオーバー・大回り)の記録
        if (!b.maneuver && !b.tacking && !b.penalty) {
          // クローズでは windFrom = W0 + shift のとき、tack=+1(スタボ)は右シフト(shift>0)でリフト・左シフト(shift<0)でヘッダー
          if (isUpLeg) {
            const tackGain = b.tack * curShift; // < 0 ならヘッダー(不利タック)を走っている
            if (tackGain < -0.025) {
              s.headerT += dt;
              s.lossCourse += v * Math.sin(Math.min(0.35, -tackGain)) * 1.15 * dt;
            }
            // 上マーク(a=300または600)に対するレイラインオーバー検出
            const m1a = this.meta.courseMode === 'upwind' && b.leg > 0 ? 600 : 300;
            const remA = Math.max(0, m1a - (b.a ?? 0));
            const layC = remA * Math.tan((43 * Math.PI) / 180) + 12;
            if (Math.abs(b.c ?? 0) > layC) {
              s.overstandT += dt;
              s.lossCourse += v * 0.55 * dt;
              s.distOverDiff += ds * 0.55;
            }
          } else if (isDnLeg) {
            const tackGain = -b.tack * curShift;
            if (tackGain < -0.025) {
              s.headerT += dt;
              s.lossCourse += v * Math.sin(Math.min(0.35, -tackGain)) * 0.95 * dt;
            }
            const remA = Math.max(0, (b.a ?? 0));
            const layC = remA * Math.tan((36 * Math.PI) / 180) + 16;
            if (Math.abs(b.c ?? 0) > layC) {
              s.overstandT += dt;
              s.lossCourse += v * 0.48 * dt;
              s.distOverDiff += ds * 0.48;
            }
          }
        }

        if (s.startCross === null && !b.ocs && b.a > lineA(b.c) + 0.5) s.startCross = t;
        // タック数・ジャイブ数を分離して集計 (ペナルティ回転中は除外し、新しい舷が3.0秒以上続いたら1回と数える)
        if (!b.penalty && b.tack !== s.stableTack) {
          if (s.pendT === null) {
            s.pendT = t;
            s.pendKind = b.twa < Math.PI / 2 ? 'tack' : 'gybe';
          } else if (t - s.pendT > 3.0) {
            if (s.pendKind === 'tack') s.tacks++;
            else s.gybes++;
            s.stableTack = b.tack;
            s.pendT = null;
          }
        } else {
          s.pendT = null;
        }
        if (b.penalty && !s.hadPen) s.penalties++;
        s.hadPen = !!b.penalty;
        // 風速低下による推定損失距離(艇速は風速比の0.8乗に比例)
        const f = 1 - 0.42 * Math.pow(Math.max(0, b.cover), 1.15);
        const lossV = v * (Math.pow(1 / Math.max(0.4, f), 0.8) - 1);
        const backFrac = b.cover > 0.01 ? Math.min(1, b.back / b.cover) : 0;
        s.lossBack += lossV * backFrac * dt; s.lossBlk += lossV * (1 - backFrac) * dt;
        if (b.back > 0.2) s.backT += dt; else if (b.cover > 0.2) s.blkT += dt;
        if (b.waveF < 1) s.lossWave += v * (1 / Math.max(0.5, b.waveF) - 1) * dt;
        // 減速イベント検出: 直近の巡航速度(ref)から15%以上落ちた区間を1回と数え、損失距離を積算
        if (!s.ev) {
          s.ref += (v - s.ref) * (1 - Math.exp(-dt / 6));
          if (t > 6 && v < s.ref * 0.85 && s.ref > 0.8) s.ev = { t0: t, ref: s.ref, minV: v, lost: 0, w: {} };
        }
        if (s.ev) {
          const e = s.ev;
          e.minV = Math.min(e.minV, v);
          e.lost += Math.max(0, e.ref - v) * dt;
          const c = causeOf(b); e.w[c] = (e.w[c] || 0) + dt * (1 + (e.ref - v));
          if (v >= e.ref * 0.95 || t - e.t0 > 25 || b.finished) {
            const drop = 1 - e.minV / e.ref;
            if (drop >= 0.15) {
              let best = CAUSES[CAUSES.length - 1], bw = -1;
              for (const k in e.w) if (e.w[k] > bw) { bw = e.w[k]; best = k; }
              s.events.push({ t: e.t0, dur: t - e.t0, drop, lost: e.lost, cause: best, leg: b.leg });
            }
            s.ref = Math.max(v, s.ref * 0.9);
            s.ev = null;
          }
        }
      }
      s.lastTack = b.tack;
      s.lx = b.x; s.lz = b.z;
      if (ranks) {
        const rk = ranks.get(b.id);
        s.lastRank = rk;
        if (t >= -40) s.track.push({ t, a: b.a ?? 0, c: b.c ?? 0, h: b.h, v: Math.abs(b.v), rank: rk });
        if (t >= 0 && s.gunRank === null) s.gunRank = rk;
        if (t >= 25 && s.startRank === null) s.startRank = rk;
      }
      if (b.leg !== s.lastLeg) {
        s.legMarks.push({ leg: s.lastLeg, t, rank: s.lastRank });
        s.lastLeg = b.leg;
      }
      if (b.finished && s.finishTime === null) { s.finishTime = b.finishTime; s.done = true; }
      if (b.dsq) s.done = true;
    }
  }

  finalize(boats, t) {
    this.endT = Math.max(this.endT, t);
    const fin = boats.filter((b) => b.finished && !b.late && !b.dsq).sort((a, b) => a.finishTime - b.finishTime);
    const rest = boats.filter((b) => !fin.includes(b) && !b.dsq);
    this.order = [...fin, ...rest, ...boats.filter((b) => b.dsq)].map((b) => b.id);
    for (const b of boats) {
      const s = this.d.get(b.id);
      s.final = fin.indexOf(b) >= 0 ? fin.indexOf(b) + 1 : null;
      s.status = b.dsq ? 'DSQ' : s.final ? '' : 'DNF';
      s.avgV = s.spdT > 0 ? s.spdSum / s.spdT : 0;
      s.avgUpV = s.upSpdT > 0 ? s.upSpdSum / s.upSpdT : null;
      s.avgDnV = s.dnSpdT > 0 ? s.dnSpdSum / s.dnSpdT : null;
      s.avgRcV = s.rcSpdT > 0 ? s.rcSpdSum / s.rcSpdT : null;
      s.avgUpAng = s.upAngT > 0 ? s.upAngSum / s.upAngT : (s.upAngRawT > 0 ? s.upAngRawSum / s.upAngRawT : null);
      s.avgUpCourseAng = s.upCourseAngT > 0 ? s.upCourseAngSum / s.upCourseAngT : s.avgUpAng;
      s.avgUpShiftGain = s.upShiftGainT > 0 ? s.upShiftGainSum / s.upShiftGainT : 0;
      s.avgDnAng = s.dnAngT > 0 ? s.dnAngSum / s.dnAngT : (s.dnAngRawT > 0 ? s.dnAngRawSum / s.dnAngRawT : null);
      s.avgWindF = s.windFT > 0 ? s.windFSum / s.windFT : 1.0;
      s.lossEv = {}; for (const c of CAUSES) s.lossEv[c] = { n: 0, lost: 0 };
      for (const e of s.events) { s.lossEv[e.cause].n++; s.lossEv[e.cause].lost += e.lost; }
      s.avgDrop = s.events.length ? s.events.reduce((x, e) => x + e.drop, 0) / s.events.length : 0;
      s.lostTotal = s.events.reduce((x, e) => x + e.lost, 0);
    }
    this.windSummary = this.buildWindSummary();
  }

  buildWindSummary() {
    const baseKt = this.meta.baseWindKt || 9;
    const baseDeg = this.meta.windDeg ?? 15;
    const n = Math.max(1, this.seaStats.count);
    const leftKt = baseKt * (this.seaStats.leftF / n || 1);
    const rightKt = baseKt * (this.seaStats.rightF / n || 1);
    const diffKt = leftKt - rightKt;
    let blowSideTxt = '';
    if (Math.abs(diffKt) >= 0.12) {
      const side = diffKt > 0 ? '左海面(コース左側)' : '右海面(コース右側)';
      blowSideTxt = `${side}に強いブローが多く入りました（左海面 平均 ${leftKt.toFixed(2)}kt ／ 右海面 平均 ${rightKt.toFixed(2)}kt）`;
    } else {
      blowSideTxt = `左右の風速差は小さく、中央を含め広い範囲にブローが入りました（左海面 平均 ${leftKt.toFixed(2)}kt ／ 右海面 平均 ${rightKt.toFixed(2)}kt）`;
    }
    if (this.meta.sideBiasDesc) {
      blowSideTxt += ` ― 地形傾向: ${this.meta.sideBiasDesc}`;
    }

    // 風の振れ(シフト)イベントの抽出
    const shifts = [];
    const wh = this.windHistory.filter((p) => p.t >= 0 && p.t <= this.endT);
    if (wh.length > 0) {
      const startShift = wh[0].shiftDeg;
      const startDir = ((baseDeg + startShift) % 360 + 360) % 360;
      shifts.push({
        t: 0,
        timeStr: '0:00 (スタート時)',
        desc: `風向 ${startDir.toFixed(1)}° (${startShift >= 0 ? '右 +' : '左 −'}${Math.abs(startShift).toFixed(1)}°)`,
        kind: '基準風向',
      });
      // 20秒窓で2.2°以上の振れを検出し、連続する同方向の振れを統合する
      let seg = null;
      for (let i = 1; i < wh.length; i++) {
        const prev = wh[Math.max(0, i - 15)];
        const cur = wh[i];
        const delta = cur.shiftDeg - prev.shiftDeg;
        if (Math.abs(delta) >= 2.0) {
          const dir = Math.sign(delta);
          if (!seg || seg.dir !== dir || cur.t - seg.t1 > 22) {
            if (seg) shifts.push(seg);
            seg = {
              t0: prev.t,
              t1: cur.t,
              t: prev.t,
              dir,
              deg0: prev.shiftDeg,
              deg1: cur.shiftDeg,
              delta,
            };
          } else {
            seg.t1 = cur.t;
            seg.deg1 = cur.shiftDeg;
            seg.delta = seg.deg1 - seg.deg0;
          }
        }
      }
      if (seg) shifts.push(seg);
    }

    const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const logList = (this.meta.shiftLog || []).filter((x) => x.t <= this.endT + 30);
    const formattedShifts = shifts.map((s) => {
      if (s.timeStr) return s;
      const d = s.delta;
      const side = d > 0 ? '右' : '左';
      const fromDir = ((baseDeg + s.deg0) % 360 + 360) % 360;
      const toDir = ((baseDeg + s.deg1) % 360 + 360) % 360;
      // SHIFT_LOGの種別を照合
      let logMatch = null;
      for (const lg of logList) {
        if (lg.t <= s.t1 && lg.t >= s.t0 - 80) logMatch = lg;
      }
      const kind = logMatch?.type === 'persist'
        ? '回頭(戻らないシフト)'
        : logMatch?.type === 'step'
          ? 'ブローを伴う急シフト'
          : '周期的な振れ(オシレーション)';
      return {
        t: s.t0,
        timeStr: `${fmtT(s.t0)}〜${fmtT(s.t1)}`,
        desc: `${side}へ ${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}° 振れ (${fromDir.toFixed(0)}°→${toDir.toFixed(0)}°)`,
        kind,
        dir: s.dir,
      };
    });

    return { blowSideTxt, leftKt, rightKt, shifts: formattedShifts };
  }
}

// ---------- 表示 ----------
let cssAdded = false;
function addCss() {
  if (cssAdded) return; cssAdded = true;
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'review.css'; document.head.appendChild(l);
}
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const sec = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}秒`;

export function openReview(rec, o) {
  addCss();
  playBgm('review');
  let root = document.getElementById('review');
  if (root) root.remove();
  root = document.createElement('div');
  root.id = 'review';
  document.body.appendChild(root);
  const toKt = (v) => v / o.speedScale / o.kt;
  const fmtKt2 = (v) => (v == null ? '−' : `${f2(toKt(v))}kt`);
  const fmtAng2 = (a) => (a == null ? '−' : `${f2(a)}°`);
  const list = rec.order.map((id) => rec.d.get(id));
  let sel = o.playerId;
  let tNow = rec.endT;
  let playing = false, raf = 0;

  const legName = (i) => {
    const L = o.legs[i]; if (!L) return '';
    const from = i === 0 ? 'S' : o.legs[i - 1].type === 'gate' ? '4G' : o.legs[i - 1].name;
    const to = L.type === 'gate' ? '4G' : L.type === 'finish' ? 'F' : L.name;
    return `${from}→${to}`;
  };

  root.innerHTML = `
  <div class="rvHead">
    <div class="rvTitle">振り返り <span class="rvSub">${rec.meta.sea ? '海況: ' + rec.meta.sea : ''}${rec.meta.tide ? ' ｜ 潮汐: ' + rec.meta.tide : ''}</span></div>
    <button type="button" class="rvClose" id="rvClose">閉じる</button>
  </div>
  <div class="rvBody">
    <section class="rvCol rvMain">
      <div class="rvBlock">
        <div class="rvLbl">航跡 <span class="rvHint">表の行をタップで艇を選択</span></div>
        <canvas id="rvMap" width="720" height="560"></canvas>
        <div class="rvScrub">
          <button type="button" id="rvPlay" class="rvBtn">再生</button>
          <input type="range" id="rvT" min="-40" max="${Math.ceil(rec.endT)}" step="1" value="${Math.ceil(rec.endT)}">
          <span id="rvTLbl" class="rvNum"></span>
          <span id="rvLiveRank" class="rvLiveRank rvNum"></span>
        </div>
      </div>
      <div class="rvBlock">
        <div class="rvLbl">順位の推移</div>
        <canvas id="rvRank" width="720" height="220"></canvas>
      </div>
    </section>
    <section class="rvCol rvSide">
      <div class="rvBlock" id="rvAnalysis"></div>
    </section>
  </div>
  <div class="rvBlock rvTableWrap">
    <div class="rvLbl">全艇データ</div>
    <table class="rvTable"><thead><tr>
      <th>順位</th><th>艇</th><th>平均艇速</th><th>上り艇速</th><th>下り艇速</th><th>リーチング艇速</th><th>上り対風角</th><th>上り有効角</th><th>下り角度</th><th>走行距離</th><th>スタート</th><th>タック数</th><th>ジャイブ数</th><th>減速</th><th>風の影響</th><th>接触</th>
    </tr></thead><tbody id="rvRows"></tbody></table>
  </div>`;

  const $ = (id) => root.querySelector('#' + id);
  $('rvClose').onclick = () => { cancelAnimationFrame(raf); root.remove(); playBgm('result'); };

  // 表
  const rows = $('rvRows');
  rows.innerHTML = list.map((s) => {
    const st = s.status || `${s.final}`;
    return `<tr data-id="${s.id}" class="${s.isPlayer ? 'me' : ''}">
      <td class="rvNum">${st}</td>
      <td><span class="rvSw" style="background:${hex(s.color)}"></span>${o.nameOf(s.boat)}</td>
      <td class="rvNum">${fmtKt2(s.avgV)}</td>
      <td class="rvNum">${fmtKt2(s.avgUpV)}</td>
      <td class="rvNum">${fmtKt2(s.avgDnV)}</td>
      <td class="rvNum">${fmtKt2(s.avgRcV)}</td>
      <td class="rvNum">${fmtAng2(s.avgUpAng)}</td>
      <td class="rvNum">${fmtAng2(s.avgUpCourseAng)}</td>
      <td class="rvNum">${fmtAng2(s.avgDnAng)}</td>
      <td class="rvNum">${Math.round(s.dist)}m</td>
      <td class="rvNum">${s.startRank ?? '−'}位${s.startCross !== null ? ` / ${f1(s.startCross)}s` : ''}</td>
      <td class="rvNum">${s.tacks}</td>
      <td class="rvNum">${s.gybes}</td>
      <td class="rvNum">${s.events.length}回 (平均${Math.round(s.avgDrop * 100)}%)</td>
      <td class="rvNum">${Math.round(s.blkT + s.backT)}s</td>
      <td class="rvNum">${s.contacts + s.touches}</td>
    </tr>`;
  }).join('');
  rows.onclick = (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    sel = +tr.dataset.id; render();
  };

  // 範囲
  let amin = 1e9, amax = -1e9, cmin = 1e9, cmax = -1e9;
  for (const s of list) for (const p of s.track) { amin = Math.min(amin, p.a); amax = Math.max(amax, p.a); cmin = Math.min(cmin, p.c); cmax = Math.max(cmax, p.c); }
  for (const k in o.marks) { const m = o.marks[k]; if (o.courseMode === 'upwind' && !['m1', 'pin', 'com', 'fcom', 'fm'].includes(k)) continue; amin = Math.min(amin, m.a); amax = Math.max(amax, m.a); cmin = Math.min(cmin, m.c); cmax = Math.max(cmax, m.c); }
  amin -= 15; amax += 15; cmin -= 15; cmax += 15;

  const map = $('rvMap'), mc = map.getContext('2d');
  const rk = $('rvRank'), rc = rk.getContext('2d');

  // 再生バー右側のその時点の順位表示を更新
  function updateTimeAndLiveRank() {
    const t = Math.max(-40, tNow);
    $('rvTLbl').textContent = t < 0 ? `−0:${String(Math.ceil(-t)).padStart(2, '0')}` : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const snap = [];
    for (const st of list) {
      let p = null;
      for (const q of st.track) { if (q.t > tNow) break; p = q; }
      if (p && p.rank != null) snap.push({ st, rank: p.rank });
    }
    snap.sort((a, b) => a.rank - b.rank);
    const curS = snap.find((x) => x.st.id === sel);
    const meS = snap.find((x) => x.st.id === o.playerId);
    const topStr = snap.slice(0, 3).map((x) => `${x.rank}位 ${x.st.isPlayer ? 'あなた' : x.st.sailNo}`).join(' · ');
    let badge = '';
    if (curS && curS.st.id !== o.playerId && meS) {
      badge = `選択艇 ${curS.rank}位 ｜ あなた ${meS.rank}位/${rec.n}艇`;
    } else if (meS) {
      badge = `あなた ${meS.rank}位/${rec.n}艇`;
    }
    if (topStr) badge += ` (${topStr})`;
    const lrEl = $('rvLiveRank');
    if (lrEl) lrEl.textContent = badge;
  }

  function drawMap() {
    const W = map.width, H = map.height, pad = 18;
    const s = Math.min((W - pad * 2) / (cmax - cmin), (H - pad * 2) / (amax - amin));
    const ox = (W - (cmax - cmin) * s) / 2, oy = (H - (amax - amin) * s) / 2;
    const X = (c) => ox + (c - cmin) * s, Y = (a) => H - oy - (a - amin) * s;
    mc.fillStyle = '#0f1d27'; mc.fillRect(0, 0, W, H);
    // 風向(上が風上)
    mc.fillStyle = '#5c6873'; mc.font = '12px sans-serif'; mc.textAlign = 'left';
    mc.fillText('↓ 風', 10, 18);
    const M = o.marks;
    mc.strokeStyle = '#c9b458'; mc.lineWidth = 1.5;
    mc.beginPath(); mc.moveTo(X(M.pin.c), Y(M.pin.a)); mc.lineTo(X(M.com.c), Y(M.com.a)); mc.stroke();
    mc.strokeStyle = '#6aa8d8'; mc.beginPath(); mc.moveTo(X(M.fcom.c), Y(M.fcom.a)); mc.lineTo(X(M.fm.c), Y(M.fm.a)); mc.stroke();
    const mk = o.courseMode === 'upwind' ? [['m1', '1']] : [['m1', '1'], ['m1a', '1a'], ['m2', '2'], ['m3', '3'], ['gL', '4S'], ['gR', '4P']];
    for (const [k, lb] of mk) {
      mc.fillStyle = '#ff9a1a'; mc.beginPath(); mc.arc(X(M[k].c), Y(M[k].a), 4, 0, 7); mc.fill();
      mc.fillStyle = '#d7dde2'; mc.fillText(lb, X(M[k].c) + 6, Y(M[k].a) - 5);
    }
    const line = (st, w, alpha) => {
      mc.strokeStyle = hex(st.color); mc.globalAlpha = alpha; mc.lineWidth = w;
      mc.beginPath(); let first = true;
      for (const p of st.track) { if (p.t > tNow) break; if (first) { mc.moveTo(X(p.c), Y(p.a)); first = false; } else mc.lineTo(X(p.c), Y(p.a)); }
      mc.stroke(); mc.globalAlpha = 1;
    };
    const me = list.find((x) => x.id === o.playerId), cur = list.find((x) => x.id === sel);
    for (const st of list) if (st !== me && st !== cur) line(st, 1, 0.38);
    if (me && me !== cur) line(me, 2.2, 0.9);
    if (cur) {
      line(cur, 3, 1);
      // 減速地点
      for (const e of cur.events) {
        if (e.t > tNow) continue;
        const p = cur.track.find((q) => q.t >= e.t); if (!p) continue;
        mc.strokeStyle = '#e0464b'; mc.lineWidth = 1.5; mc.beginPath(); mc.arc(X(p.c), Y(p.a), 3 + e.drop * 8, 0, 7); mc.stroke();
      }
    }
    // 現在時刻の位置
    for (const st of list) {
      let p = null; for (const q of st.track) { if (q.t > tNow) break; p = q; }
      if (!p) continue;
      const big = st === cur || st === me;
      mc.save(); mc.translate(X(p.c), Y(p.a));
      mc.fillStyle = hex(st.color); mc.strokeStyle = '#0f1d27'; mc.lineWidth = 1;
      mc.beginPath(); mc.arc(0, 0, big ? 5 : 3.2, 0, 7); mc.fill(); mc.stroke();
      mc.restore();
      if (big) {
        mc.fillStyle = '#e9edf0'; mc.font = '11px sans-serif';
        const rkTxt = p.rank ? ` (${p.rank}位)` : '';
        mc.fillText((st.isPlayer ? 'あなた' : st.sailNo) + rkTxt, X(p.c) + 7, Y(p.a) + 4);
      }
    }
  }

  function drawRank() {
    const W = rk.width, H = rk.height, padL = 30, padR = 10, padT = 10, padB = 22;
    const t0 = 0, t1 = Math.max(10, rec.endT), N = rec.n;
    const X = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
    const Y = (r) => padT + ((r - 1) / Math.max(1, N - 1)) * (H - padT - padB);
    rc.fillStyle = '#0f1d27'; rc.fillRect(0, 0, W, H);
    rc.strokeStyle = '#28343e'; rc.lineWidth = 1; rc.fillStyle = '#5c6873'; rc.font = '10px sans-serif'; rc.textAlign = 'right';
    for (const r of [1, Math.ceil(N / 2), N]) { rc.beginPath(); rc.moveTo(padL, Y(r)); rc.lineTo(W - padR, Y(r)); rc.stroke(); rc.fillText(r + '位', padL - 4, Y(r) + 3); }
    rc.textAlign = 'center';
    for (let t = 0; t <= t1; t += 60) rc.fillText(`${t / 60}分`, X(t), H - 6);
    const cur = list.find((x) => x.id === sel), me = list.find((x) => x.id === o.playerId);
    const ln = (st, w, a) => {
      rc.strokeStyle = hex(st.color); rc.globalAlpha = a; rc.lineWidth = w; rc.beginPath(); let f = true;
      for (const p of st.track) { if (p.t < 0) continue; if (f) { rc.moveTo(X(p.t), Y(p.rank)); f = false; } else rc.lineTo(X(p.t), Y(p.rank)); }
      rc.stroke(); rc.globalAlpha = 1;
    };
    for (const st of list) if (st !== cur && st !== me) ln(st, 1, 0.18);
    if (me && me !== cur) ln(me, 2, 0.85);
    if (cur) {
      ln(cur, 2.6, 1);
      rc.fillStyle = '#e9edf0';
      for (const m of cur.legMarks) { if (m.t < 0) continue; rc.beginPath(); rc.arc(X(m.t), Y(m.rank || 1), 3, 0, 7); rc.fill(); }
    }
    rc.strokeStyle = '#f2c200'; rc.lineWidth = 1; rc.beginPath(); rc.moveTo(X(Math.max(0, tNow)), padT); rc.lineTo(X(Math.max(0, tNow)), H - padB); rc.stroke();
  }

  function analysis() {
    const s = rec.d.get(sel);
    const fins = list.filter((x) => x.final);
    const isWinner = s.final === 1;
    const ref = isWinner ? fins[1] || fins[0] || list[1] || s : fins[0] || list[0];
    const isRefSelf = ref === s;
    const name = s.isPlayer ? 'あなた' : o.nameOf(s.boat);
    const refName = ref.isPlayer ? 'あなた' : o.nameOf(ref.boat);
    const refRankStr = ref.final ? `${ref.final}位` : '比較艇';
    const vS = Math.max(0.1, s.avgV), vR = Math.max(0.1, ref.avgV);
    // 所要時間差の要因分解(参照艇比: マイナスは参照艇より速い/有利、プラスは参照艇より遅い/ロス)
    const lossS = s.lostTotal, lossR = ref.lostTotal;
    const dLossT = (lossS - lossR) / vR;
    const dSpeedRaw = s.dist / vS - s.dist / vR - dLossT;

    // 1) コース要因: 走行距離のロス ＋ ヘッダー(不利シフト)逆走・レイラインオーバーによるVMGコース効率ロス
    const rawDistDiff = s.dist - ref.dist;
    const effDistDiff = (!isWinner && s.pinchT > ref.pinchT + 3 && rawDistDiff < 0)
      ? rawDistDiff * 0.25
      : rawDistDiff;
    const routeLossDiffM = (s.lossCourse || 0) - (ref.lossCourse || 0);
    const dCourseT = (effDistDiff + routeLossDiffM * 1.45) / vR;

    // 2) 艇速要因の4内訳（①上しすぎ / ②ブランケット走行 / ③ブロー未獲得 / ④落としすぎ）
    const pinchLossT = ((s.lossPinch || 0) - (ref.lossPinch || 0)) / vR;
    const blkLossT = (((s.lossBlk || 0) + (s.lossBack || 0)) - ((ref.lossBlk || 0) + (ref.lossBack || 0))) / vR;
    const blowDiffPct = ((ref.avgWindF ?? 1) - (s.avgWindF ?? 1)) * 100;
    const blowLossT = ((ref.avgWindF ?? 1) - (s.avgWindF ?? 1)) * 0.82 * Math.max(25, s.spdT || 60);
    const footLossT = ((s.lossFoot || 0) - (ref.lossFoot || 0)) / vR;

    const speedCandidates = [
      { key: 'pinch', label: '上しすぎによる艇速によるもの', winLabel: '適切なクローズ角度維持による艇速', val: pinchLossT },
      { key: 'blanket', label: 'ブランケット走行による艇速によるもの', winLabel: 'クリアウインド確保による艇速', val: blkLossT },
      { key: 'blow', label: 'ブローに入れなかったことによる艇速によるもの', winLabel: 'ブローを捉えたことによる艇速', val: blowLossT },
      { key: 'foot', label: '落としすぎによる艇速・VMGによるもの', winLabel: '無駄のないVMG角度による艇速', val: footLossT },
    ];
    speedCandidates.sort((a, b) => (isWinner ? a.val - b.val : b.val - a.val));
    const mainSpdCause = speedCandidates[0];
    // 2番目に大きい艇速要因も顕著なら併記する
    const secondSpdCause = speedCandidates[1];
    let speedCauseTitle = isWinner ? mainSpdCause.winLabel : mainSpdCause.label;
    if (!isWinner && secondSpdCause && secondSpdCause.val > 1.2 && secondSpdCause.val >= mainSpdCause.val * 0.55) {
      const shortMap = {
        pinch: '上しすぎ',
        blanket: 'ブランケット走行',
        blow: 'ブロー未獲得',
        foot: '落としすぎ',
      };
      speedCauseTitle = `${shortMap[mainSpdCause.key]}・${shortMap[secondSpdCause.key]}による艇速によるもの`;
    }
    const dPureSpeedT = dSpeedRaw - routeLossDiffM * 0.45;
    const speedDetailTxt = `全体平均 ${fmtKt2(s.avgV)} (比較艇 ${fmtKt2(ref.avgV)}) ｜ 内訳: 上しすぎ ${Math.round(s.pinchT || 0)}秒(${sec(pinchLossT)})・ブランケット ${Math.round((s.blkT || 0) + (s.backT || 0))}秒(${sec(blkLossT)})・ブロー風速差 ${blowDiffPct >= 0 ? '−' : '+'}${Math.abs(blowDiffPct).toFixed(1)}%(${sec(blowLossT)})・落としすぎ ${Math.round(s.footT || 0)}秒(${sec(footLossT)})`;

    const parts = [
      { k: 'スタートによるもの', v: (s.startCross ?? 8) - (ref.startCross ?? 8), d: `ライン通過 号砲${s.startCross !== null ? f1(s.startCross) : '−'}秒後 (比較艇 ${ref.startCross !== null ? f1(ref.startCross) : '−'}秒後)・25秒後の順位 ${s.startRank ?? '−'}位` },
      { k: 'コース取りによるもの', v: dCourseT, d: `走行距離 ${Math.round(s.dist)}m (比較艇 ${Math.round(ref.dist)}m / ${s.dist >= ref.dist ? '+' : '−'}${Math.abs(Math.round(s.dist - ref.dist))}m)・不利シフト逆走 ${Math.round(s.headerT || 0)}秒・レイライン超過 ${Math.round(s.overstandT || 0)}秒` },
      { k: speedCauseTitle, v: dPureSpeedT, d: speedDetailTxt },
      { k: '減速(タック・他艇・波など)によるもの', v: dLossT, d: `${s.events.length}回・平均${Math.round(s.avgDrop * 100)}%減速・損失約${Math.round(lossS)}m (比較艇 ${ref.events.length}回・${Math.round(lossR)}m)` },
    ];
    const worst = [...parts].sort((a, b) => b.v - a.v)[0];
    const best = [...parts].sort((a, b) => a.v - b.v)[0];

    // 順位変動: レグごと
    const legRows = [];
    let prev = s.startRank ?? s.gunRank;
    s.legMarks.forEach((m) => {
      if (m.rank == null) return;
      legRows.push({ leg: legName(m.leg), from: prev, to: m.rank, t: m.t });
      prev = m.rank;
    });
    if (s.final && prev != null && (!s.legMarks.length || s.legMarks[s.legMarks.length - 1].leg < o.legs.length - 1)) legRows.push({ leg: legName(o.legs.length - 1), from: prev, to: s.final, t: s.finishTime });

    let summary;
    if (isWinner) {
      if (isRefSelf) {
        summary = `${name}が見事トップでフィニッシュしました！`;
      } else if (best.v < -0.5) {
        summary = `${name}が見事1位でフィニッシュ！ 2位(${refName})に差をつけた最大の勝因は「${best.k}」(${sec(best.v)})です。${worst.v > 1.5 ? `（「${worst.k}」をさらに抑えるとよりリードを広げられます）` : ''}`;
      } else {
        summary = `${name}が見事1位でフィニッシュ！ 2位(${refName})との接戦を制しました。`;
      }
    } else if (worst.v > 1.5) {
      summary = `${name}が${refRankStr}(${refName})に遅れた最大の要因は「${worst.k}」(${sec(worst.v)})です。`;
    } else {
      summary = `${refRankStr}(${refName})との差は小さく、特定の大きな遅れ要因はありません。`;
    }

    const diffLabel = isWinner
      ? `2位(${refName})との時間差の内訳 (−はリード / +はロス)`
      : `${refRankStr}(${refName})との時間差の内訳 (+は遅れ / −はリード)`;

    const ws = rec.windSummary || { blowSideTxt: '記録なし', shifts: [] };

    // 走行距離の要因判別 (①登り角度TWA vs ②コース・シフト vs ③レイライン超過)
    const fmtM = (m) => `${m >= 0 ? '+' : '−'}${Math.abs(Math.round(m))}m`;
    const dTotalM = Math.round(s.dist - ref.dist);
    const dAngM = Math.round((s.distAngleDiff || 0) - (ref.distAngleDiff || 0));
    const dShiftM = Math.round((s.distShiftDiff || 0) - (ref.distShiftDiff || 0));
    const dOverM = Math.round((s.distOverDiff || 0) - (ref.distOverDiff || 0));
    let distVerdict = '';
    if (dTotalM > 8) {
      if (dShiftM + dOverM > dAngM + 4) {
        distVerdict = `【判別】走行距離が長い主因は「登り角度(TWA)」ではなく「コース取り・シフト(ヘッダー逆走 ${fmtM(dShiftM)} / レイライン超過 ${fmtM(dOverM)})」です。`;
      } else if (dAngM > dShiftM + dOverM + 4) {
        distVerdict = `【判別】走行距離が長い主因は「登り・下り角度の広さ(落としすぎ ${fmtM(dAngM)})」です。`;
      } else {
        distVerdict = `【判別】走行距離の増加(${fmtM(dTotalM)})は「角度の広さ(${fmtM(dAngM)})」と「シフト・コース取り(${fmtM(dShiftM + dOverM)})」の両方が影響しています。`;
      }
    } else if (dTotalM < -8 && s.pinchT > ref.pinchT + 3) {
      distVerdict = `【判別】走行距離は短い(${fmtM(dTotalM)})ですが、「上しすぎ(ピンチング ${Math.round(s.pinchT)}秒)」で角度を詰めすぎて艇速を失っています。`;
    } else if (dShiftM < -5) {
      distVerdict = `【判別】リフト(有利シフト)を捉えて対マーク有効角を詰めたことで走行距離を ${fmtM(dShiftM)} 短縮できています。`;
    } else {
      distVerdict = `【判別】比較艇との走行距離差は小さく(${fmtM(dTotalM)})、角度・コースともに標準的です。`;
    }

    $('rvAnalysis').innerHTML = `
      <div class="rvLbl">分析: ${name} ${s.status || s.final + '位'}</div>
      <p class="rvSummary">${summary}</p>
      <div class="rvSubLbl">${diffLabel}</div>
      <table class="rvMini">${parts.map((p) => {
        const isHl = isWinner ? (p === best && p.v < -0.5) : (p === worst && p.v > 1.5);
        return `<tr class="${isHl ? 'hl' : ''}"><th>${p.k}</th><td class="rvNum ${p.v > 0 ? 'bad' : 'good'}">${sec(p.v)}</td></tr><tr class="rvDetail"><td colspan="2">${p.d}</td></tr>`;
      }).join('')}</table>
      <div class="rvSubLbl">走行距離の要因判別 (角度 vs コース・シフト)</div>
      <p class="rvNote">${distVerdict}</p>
      <table class="rvMini">
        <tr><th>総走行距離の差</th><td class="rvNum ${dTotalM > 5 ? 'bad' : dTotalM < -5 ? 'good' : ''}">${Math.round(s.dist)}m <span class="rvDim">(比較艇 ${Math.round(ref.dist)}m / 差 ${fmtM(dTotalM)})</span></td></tr>
        <tr><th>① 登り・下り対風角(TWA)要因</th><td class="rvNum ${dAngM > 5 ? 'bad' : dAngM < -5 ? 'good' : ''}">${fmtM(dAngM)} <span class="rvDim">(上り対風角 ${fmtAng2(s.avgUpAng)} vs ${fmtAng2(ref.avgUpAng)})</span></td></tr>
        <tr><th>② 風の振れ(リフト/ヘッダー)要因</th><td class="rvNum ${dShiftM > 5 ? 'bad' : dShiftM < -5 ? 'good' : ''}">${fmtM(dShiftM)} <span class="rvDim">(対マーク有効角 ${fmtAng2(s.avgUpCourseAng)} vs ${fmtAng2(ref.avgUpCourseAng)})</span></td></tr>
        <tr><th>③ レイライン超過・大回り要因</th><td class="rvNum ${dOverM > 5 ? 'bad' : ''}">${fmtM(dOverM)} <span class="rvDim">(超過 ${Math.round(s.overstandT)}秒 vs ${Math.round(ref.overstandT)}秒)</span></td></tr>
      </table>
      <div class="rvSubLbl">艇速・平均角度・マニューバー内訳 (比較艇: ${refName})</div>
      <table class="rvMini">
        <tr><th>上り平均艇速 / 対風角(有効角)</th><td class="rvNum">${fmtKt2(s.avgUpV)} / ${fmtAng2(s.avgUpAng)}(${fmtAng2(s.avgUpCourseAng)}) <span class="rvDim">(比較艇 ${fmtKt2(ref.avgUpV)} / ${fmtAng2(ref.avgUpAng)})</span></td></tr>
        <tr><th>下り平均艇速 / 平均角度</th><td class="rvNum">${fmtKt2(s.avgDnV)} / ${fmtAng2(s.avgDnAng)} <span class="rvDim">(比較艇 ${fmtKt2(ref.avgDnV)} / ${fmtAng2(ref.avgDnAng)})</span></td></tr>
        <tr><th>リーチング平均艇速</th><td class="rvNum">${fmtKt2(s.avgRcV)} <span class="rvDim">(比較艇 ${fmtKt2(ref.avgRcV)})</span></td></tr>
        <tr><th>タック数 / ジャイブ数</th><td class="rvNum">タック ${s.tacks}回 / ジャイブ ${s.gybes}回 <span class="rvDim">(比較艇 ${ref.tacks}回 / ${ref.gybes}回)</span></td></tr>
      </table>
      <p class="rvNote">ブランケット ${Math.round(s.blkT)}秒・バックウインド ${Math.round(s.backT)}秒 (損失 約${Math.round(s.lossBlk + s.lossBack)}m)、波による損失 約${Math.round(s.lossWave)}m</p>
      <div class="rvSubLbl">レグごとの順位</div>
      ${legRows.length ? `<table class="rvMini">${legRows.map((r) => { const d = r.from - r.to; return `<tr><th>${r.leg}</th><td class="rvNum">${r.from ?? '−'}→${r.to}位 <span class="${d > 0 ? 'good' : d < 0 ? 'bad' : ''}">${d > 0 ? '▲' + d : d < 0 ? '▼' + -d : '±0'}</span></td></tr>`; }).join('')}</table>` : '<p class="rvNote">記録なし</p>'}
      <div class="rvSubLbl">海面全体のブロー傾向・風の振れ履歴</div>
      <p class="rvNote">${ws.blowSideTxt}</p>
      ${ws.shifts.length ? `<table class="rvMini">${ws.shifts.map((w) => `<tr data-t="${w.t}" class="rvJump"><th>${w.timeStr}</th><td class="rvNum">${w.desc} <span class="rvDim">[${w.kind}]</span></td></tr>`).join('')}</table>` : '<p class="rvNote">大きな風向シフトはありませんでした。</p>'}
    `;
    for (const el of $('rvAnalysis').querySelectorAll('.rvJump')) el.onclick = () => { tNow = +el.dataset.t; $('rvT').value = tNow; render(); };
  }

  function render() {
    for (const tr of rows.querySelectorAll('tr')) tr.classList.toggle('sel', +tr.dataset.id === sel);
    updateTimeAndLiveRank();
    drawMap(); drawRank(); analysis();
  }

  $('rvT').oninput = (e) => {
    tNow = +e.target.value;
    playing = false;
    $('rvPlay').textContent = '再生';
    updateTimeAndLiveRank();
    drawMap();
    drawRank();
  };
  $('rvPlay').onclick = () => {
    playing = !playing; $('rvPlay').textContent = playing ? '停止' : '再生';
    if (playing) {
      if (tNow >= rec.endT - 1) tNow = -40;
      let last = performance.now();
      const tick = (now) => {
        if (!playing || !document.body.contains(root)) return;
        tNow = Math.min(rec.endT, tNow + ((now - last) / 1000) * 20); last = now; // 20倍速
        $('rvT').value = tNow;
        updateTimeAndLiveRank();
        drawMap();
        drawRank();
        if (tNow >= rec.endT) { playing = false; $('rvPlay').textContent = '再生'; return; }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
  };
  render();
}

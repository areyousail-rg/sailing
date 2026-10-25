// レース振り返り: 全艇の航跡・艇速(上り/下り/リーチング)・対風角(上り/下り)・走行距離・スタート順位・タック/ジャイブ数・海面風況を記録し分析表示する
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
        dnAngSum: 0, dnAngT: 0, dnAngRawSum: 0, dnAngRawT: 0,
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
        s.dist += Math.hypot(b.x - s.lx, b.z - s.lz);
        const v = Math.abs(b.v);
        s.spdSum += v * dt; s.spdT += dt;

        // レグ種別(上り / 下り / リーチング)ごとの艇速および上り・下り対風角の集計
        const twaDeg = (b.twa * 180) / Math.PI;
        const effTwaDeg = b.effTwaDeg ?? twaDeg;
        const isUpLeg = isUpwindCourse ? true : (b.leg === 0 || b.leg === 3);
        const isDnLeg = isUpwindCourse ? false : (b.leg === 2 || b.leg === 5);
        const isRcLeg = isUpwindCourse ? false : (b.leg === 1 || b.leg === 4 || b.leg === 6);

        if (isUpLeg) {
          s.upSpdSum += v * dt; s.upSpdT += dt;
          s.upAngRawSum += twaDeg * dt; s.upAngRawT += dt;
          if (!b.maneuver && !b.tacking && !b.penalty && twaDeg >= 24 && twaDeg <= 72) {
            s.upAngSum += twaDeg * dt; s.upAngT += dt;
          }
        } else if (isDnLeg) {
          s.dnSpdSum += v * dt; s.dnSpdT += dt;
          s.dnAngRawSum += effTwaDeg * dt; s.dnAngRawT += dt;
          if (!b.maneuver && !b.penalty && twaDeg >= 110) {
            s.dnAngSum += effTwaDeg * dt; s.dnAngT += dt;
          }
        } else if (isRcLeg) {
          s.rcSpdSum += v * dt; s.rcSpdT += dt;
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
      s.avgDnAng = s.dnAngT > 0 ? s.dnAngSum / s.dnAngT : (s.dnAngRawT > 0 ? s.dnAngRawSum / s.dnAngRawT : null);
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
    <div class="rvTitle">振り返り <span class="rvSub">${rec.meta.sea ? '海況: ' + rec.meta.sea : ''}</span></div>
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
      <th>順位</th><th>艇</th><th>平均艇速</th><th>上り艇速</th><th>下り艇速</th><th>リーチング艇速</th><th>上り角度</th><th>下り角度</th><th>走行距離</th><th>スタート</th><th>タック数</th><th>ジャイブ数</th><th>減速</th><th>風の影響</th><th>接触</th>
    </tr></thead><tbody id="rvRows"></tbody></table>
  </div>`;

  const $ = (id) => root.querySelector('#' + id);
  $('rvClose').onclick = () => { cancelAnimationFrame(raf); root.remove(); };

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
    const dSpeed = s.dist / vS - s.dist / vR;
    const parts = [
      { k: 'スタート', v: (s.startCross ?? 8) - (ref.startCross ?? 8), d: `ライン通過 号砲${s.startCross !== null ? f1(s.startCross) : '−'}秒後 (比較艇 ${ref.startCross !== null ? f1(ref.startCross) : '−'}秒後)・25秒後の順位 ${s.startRank ?? '−'}位` },
      { k: 'コース(走行距離)', v: (s.dist - ref.dist) / vR, d: `${Math.round(s.dist)}m (比較艇 ${Math.round(ref.dist)}m / ${s.dist >= ref.dist ? '+' : '−'}${Math.abs(Math.round(s.dist - ref.dist))}m)` },
      { k: '純粋な艇速', v: dSpeed - dLossT, d: `全体平均 ${fmtKt2(s.avgV)} (比較艇 ${fmtKt2(ref.avgV)})` },
      { k: '減速(タック・他艇・波など)', v: dLossT, d: `${s.events.length}回・平均${Math.round(s.avgDrop * 100)}%減速・損失約${Math.round(lossS)}m (比較艇 ${ref.events.length}回・${Math.round(lossR)}m)` },
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

    $('rvAnalysis').innerHTML = `
      <div class="rvLbl">分析: ${name} ${s.status || s.final + '位'}</div>
      <p class="rvSummary">${summary}</p>
      <div class="rvSubLbl">${diffLabel}</div>
      <table class="rvMini">${parts.map((p) => {
        const isHl = isWinner ? (p === best && p.v < -0.5) : (p === worst && p.v > 1.5);
        return `<tr class="${isHl ? 'hl' : ''}"><th>${p.k}</th><td class="rvNum ${p.v > 0 ? 'bad' : 'good'}">${sec(p.v)}</td></tr><tr class="rvDetail"><td colspan="2">${p.d}</td></tr>`;
      }).join('')}</table>
      <div class="rvSubLbl">艇速・平均角度・マニューバー内訳 (比較艇: ${refName})</div>
      <table class="rvMini">
        <tr><th>上り平均艇速 / 平均角度</th><td class="rvNum">${fmtKt2(s.avgUpV)} / ${fmtAng2(s.avgUpAng)} <span class="rvDim">(比較艇 ${fmtKt2(ref.avgUpV)} / ${fmtAng2(ref.avgUpAng)})</span></td></tr>
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

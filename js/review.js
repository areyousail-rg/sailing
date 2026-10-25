// レース振り返り: 全艇の航跡・艇速・走行距離・スタート順位・減速(原因別)・順位変動を記録し、レース後に分析表示する
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
    for (const b of boats) {
      this.d.set(b.id, {
        id: b.id, color: b.color, isPlayer: b.isPlayer, sailNo: b.sailNo, nat: b.nat, boat: b,
        track: [], dist: 0, lx: b.x, lz: b.z, spdSum: 0, spdT: 0,
        startCross: null, startRank: null, gunRank: null,
        ref: Math.abs(b.v), ev: null, events: [], tacks: 0, lastTack: b.tack, stableTack: b.tack, pendT: null,
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
    }
    for (const b of boats) {
      const s = this.d.get(b.id); if (!s) continue;
      const active = t >= 0 && !s.done && !b.dsq;
      if (active) {
        s.dist += Math.hypot(b.x - s.lx, b.z - s.lz);
        const v = Math.abs(b.v);
        s.spdSum += v * dt; s.spdT += dt;
        if (s.startCross === null && !b.ocs && b.a > lineA(b.c) + 0.5) s.startCross = t;
        // タック/ジャイブ数: 真後ろ付近での左右判定のちらつきを除くため、新しい舷が4秒以上続いたら1回と数える
        if (b.tack !== s.stableTack) {
          if (s.pendT === null) s.pendT = t;
          else if (t - s.pendT > 4) { s.tacks++; s.stableTack = b.tack; s.pendT = null; }
        } else s.pendT = null;
        if (b.penalty && !s.hadPen) s.penalties++;
        s.hadPen = !!b.penalty;
        // 風速低下による推定損失距離(艇速は風速比の0.8乗に比例)
        const f = 1 - 0.42 * Math.pow(Math.max(0, b.cover), 1.15);
        const lossV = v * (Math.pow(1 / Math.max(0.4, f), 0.8) - 1);
        const backFrac = b.cover > 0.01 ? Math.min(1, b.back / b.cover) : 0;
        s.lossBack += lossV * backFrac * dt; s.lossBlk += lossV * (1 - backFrac) * dt;
        if (b.back > 0.2) s.backT += dt; else if (b.cover > 0.2) s.blkT += dt;
        if (b.waveF < 1) s.lossWave += v * (1 / Math.max(0.5, b.waveF) - 1) * dt;
        // 減速イベント検出: 直近の巡航速度(ref)から15%以上落ちた区間を1回と数え、原因ごとに損失距離を積算
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
      s.lossEv = {}; for (const c of CAUSES) s.lossEv[c] = { n: 0, lost: 0 };
      for (const e of s.events) { s.lossEv[e.cause].n++; s.lossEv[e.cause].lost += e.lost; }
      s.avgDrop = s.events.length ? s.events.reduce((x, e) => x + e.drop, 0) / s.events.length : 0;
      s.lostTotal = s.events.reduce((x, e) => x + e.lost, 0);
    }
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
const sec = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}秒`;

export function openReview(rec, o) {
  addCss();
  let root = document.getElementById('review');
  if (root) root.remove();
  root = document.createElement('div');
  root.id = 'review';
  document.body.appendChild(root);
  const toKt = (v) => v / o.speedScale / o.kt;
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
      <th>順位</th><th>艇</th><th>平均艇速</th><th>走行距離</th><th>スタート</th><th>減速</th><th>タック/ジャイブ</th><th>風の影響</th><th>接触</th>
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
      <td class="rvNum">${f1(toKt(s.avgV))}kt</td>
      <td class="rvNum">${Math.round(s.dist)}m</td>
      <td class="rvNum">${s.startRank ?? '−'}位${s.startCross !== null ? ` / ${f1(s.startCross)}s` : ''}</td>
      <td class="rvNum">${s.events.length}回 (平均${Math.round(s.avgDrop * 100)}%)</td>
      <td class="rvNum">${s.tacks}</td>
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
      if (big) { mc.fillStyle = '#e9edf0'; mc.font = '11px sans-serif'; mc.fillText(st.isPlayer ? 'あなた' : st.sailNo, X(p.c) + 7, Y(p.a) + 4); }
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
    const ref = s.final === 1 ? fins[1] || fins[0] : fins[0] || list[0];
    const isRefSelf = ref === s;
    const name = s.isPlayer ? 'あなた' : o.nameOf(s.boat);
    const vS = Math.max(0.1, s.avgV), vR = Math.max(0.1, ref.avgV);
    // 所要時間差の要因分解(参照艇比)
    const lossS = s.lostTotal, lossR = ref.lostTotal;
    const dLossT = (lossS - lossR) / vR;
    const dSpeed = s.dist / vS - s.dist / vR;
    const parts = [
      { k: 'スタート', v: (s.startCross ?? 8) - (ref.startCross ?? 8), d: `ライン通過 号砲${s.startCross !== null ? f1(s.startCross) : '−'}秒後 (比較艇 ${ref.startCross !== null ? f1(ref.startCross) : '−'}秒後)・25秒後の順位 ${s.startRank ?? '−'}位` },
      { k: 'コース(走行距離)', v: (s.dist - ref.dist) / vR, d: `${Math.round(s.dist)}m (比較艇 ${Math.round(ref.dist)}m / ${s.dist >= ref.dist ? '+' : '−'}${Math.abs(Math.round(s.dist - ref.dist))}m)` },
      { k: '純粋な艇速', v: dSpeed - dLossT, d: `平均 ${f1(toKt(s.avgV))}kt (比較艇 ${f1(toKt(ref.avgV))}kt)` },
      { k: '減速(タック・他艇・波など)', v: dLossT, d: `${s.events.length}回・平均${Math.round(s.avgDrop * 100)}%減速・損失約${Math.round(lossS)}m (比較艇 ${ref.events.length}回・${Math.round(lossR)}m)` },
    ];
    const worst = [...parts].sort((a, b) => b.v - a.v)[0];
    // 原因別
    const byCause = Object.entries(s.lossEv).filter(([, x]) => x.n > 0).sort((a, b) => b[1].lost - a[1].lost);
    // 順位変動: レグごと
    const legRows = [];
    let prev = s.startRank ?? s.gunRank;
    s.legMarks.forEach((m) => {
      if (m.rank == null) return;
      legRows.push({ leg: legName(m.leg), from: prev, to: m.rank, t: m.t });
      prev = m.rank;
    });
    if (s.final && prev != null && (!s.legMarks.length || s.legMarks[s.legMarks.length - 1].leg < o.legs.length - 1)) legRows.push({ leg: legName(o.legs.length - 1), from: prev, to: s.final, t: s.finishTime });
    // 20秒単位で大きく順位が動いた場面
    const swings = [];
    const tr = s.track.filter((p) => p.t >= 0);
    for (let i = 20; i < tr.length; i += 10) {
      const dr = tr[i].rank - tr[i - 20].rank;
      if (Math.abs(dr) >= 2) {
        const evs = s.events.filter((e) => e.t >= tr[i - 20].t && e.t <= tr[i].t);
        const cause = dr < 0 ? '追い上げ' : evs.length ? evs.sort((a, b) => b.lost - a.lost)[0].cause : '艇速・コース差';
        swings.push({ t0: tr[i - 20].t, t1: tr[i].t, dr, cause });
      }
    }
    // 重複をまとめる
    const sw = [];
    for (const w of swings) { const l = sw[sw.length - 1]; if (l && w.t0 <= l.t1 && Math.sign(w.dr) === Math.sign(l.dr)) { if (Math.abs(w.dr) > Math.abs(l.dr)) Object.assign(l, w); } else sw.push({ ...w }); }
    const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

    const summary = isRefSelf
      ? `${name}がトップ。2位との差の内訳を表示しています。`
      : worst.v > 1.5
        ? `${name}が比較艇(${ref.isPlayer ? 'あなた' : o.nameOf(ref.boat)}・${ref.final}位)に負けた最大の要因は「${worst.k}」です。`
        : `比較艇との差は小さく、特定の大きな要因はありません。`;

    $('rvAnalysis').innerHTML = `
      <div class="rvLbl">分析: ${name} ${s.status || s.final + '位'}</div>
      <p class="rvSummary">${summary}</p>
      <div class="rvSubLbl">比較艇との時間差の内訳 (+は遅れ)</div>
      <table class="rvMini">${parts.map((p) => `<tr class="${p === worst && p.v > 1.5 ? 'hl' : ''}"><th>${p.k}</th><td class="rvNum ${p.v > 0 ? 'bad' : 'good'}">${sec(p.v)}</td></tr><tr class="rvDetail"><td colspan="2">${p.d}</td></tr>`).join('')}</table>
      <div class="rvSubLbl">減速の原因</div>
      ${byCause.length ? `<table class="rvMini">${byCause.map(([k, x]) => `<tr><th>${k}</th><td class="rvNum">${x.n}回 / 約${Math.round(x.lost)}m</td></tr>`).join('')}</table>` : '<p class="rvNote">大きな減速はありませんでした。</p>'}
      <p class="rvNote">ブランケット ${Math.round(s.blkT)}秒・バックウインド ${Math.round(s.backT)}秒 (風速低下による損失 約${Math.round(s.lossBlk + s.lossBack)}m)、波による損失 約${Math.round(s.lossWave)}m、タック/ジャイブ ${s.tacks}回</p>
      <div class="rvSubLbl">レグごとの順位</div>
      ${legRows.length ? `<table class="rvMini">${legRows.map((r) => { const d = r.from - r.to; return `<tr><th>${r.leg}</th><td class="rvNum">${r.from ?? '−'}→${r.to}位 <span class="${d > 0 ? 'good' : d < 0 ? 'bad' : ''}">${d > 0 ? '▲' + d : d < 0 ? '▼' + -d : '±0'}</span></td></tr>`; }).join('')}</table>` : '<p class="rvNote">記録なし</p>'}
      <div class="rvSubLbl">順位が大きく動いた場面</div>
      ${sw.length ? `<table class="rvMini">${sw.slice(0, 6).map((w) => `<tr data-t="${w.t1}" class="rvJump"><th>${fmtT(w.t0)}〜${fmtT(w.t1)}</th><td class="rvNum"><span class="${w.dr < 0 ? 'good' : 'bad'}">${w.dr < 0 ? '▲' + -w.dr : '▼' + w.dr}</span> ${w.cause}</td></tr>`).join('')}</table>` : '<p class="rvNote">大きな変動はありませんでした。</p>'}
    `;
    for (const el of $('rvAnalysis').querySelectorAll('.rvJump')) el.onclick = () => { tNow = +el.dataset.t; $('rvT').value = tNow; render(); };
  }

  function render() {
    for (const tr of rows.querySelectorAll('tr')) tr.classList.toggle('sel', +tr.dataset.id === sel);
    const t = Math.max(-40, tNow);
    $('rvTLbl').textContent = t < 0 ? `−0:${String(Math.ceil(-t)).padStart(2, '0')}` : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    drawMap(); drawRank(); analysis();
  }

  $('rvT').oninput = (e) => { tNow = +e.target.value; playing = false; $('rvPlay').textContent = '再生'; drawMap(); drawRank(); const t = tNow; $('rvTLbl').textContent = t < 0 ? `−0:${String(Math.ceil(-t)).padStart(2, '0')}` : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
  $('rvPlay').onclick = () => {
    playing = !playing; $('rvPlay').textContent = playing ? '停止' : '再生';
    if (playing) {
      if (tNow >= rec.endT - 1) tNow = -40;
      let last = performance.now();
      const tick = (now) => {
        if (!playing || !document.body.contains(root)) return;
        tNow = Math.min(rec.endT, tNow + ((now - last) / 1000) * 20); last = now; // 20倍速
        $('rvT').value = tNow; drawMap(); drawRank();
        const t = tNow; $('rvTLbl').textContent = t < 0 ? `−0:${String(Math.ceil(-t)).padStart(2, '0')}` : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
        if (tNow >= rec.endT) { playing = false; $('rvPlay').textContent = '再生'; return; }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
  };
  render();
}

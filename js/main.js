// ゲーム本体: 初期化・状態管理・HUD
import * as THREE from 'three';
import { createWorld, MOBILE } from './world.js';
import { Boat, resolveCollisions, computeBlanket, sheetOpt, KT, SPEED_SCALE, BASE_WIND_KT, wrap, clamp, rebuildObstacles } from './sim.js';
import { AI } from './ai.js';
import { BoatModel } from './boatmodel.js';
import { CREW_TYPES, buildFigure, loadCustomCrew } from './crew.js';
import { DroneCam, CAM_MODES, COCKPIT } from './camera.js';
import { LEGS, W0, LINE_HALF, LINE_SKEW, FAVORED, lineA, MARKS, updateProgress, progressOf, toCourse, toWorld } from './course.js';
import { initAudio, horn, beep, setWind, toggleMute, thud, markHit, updateNearbyBoatSound, signalHorn, updateSailingAudio, setCameraAudio, sailFlog, poleClank } from './audio.js';

const $ = (id) => document.getElementById(id);
const RACE_LIMIT = 600;
const FINISH_WINDOW = 150; // トップフィニッシュからこの秒数以内にフィニッシュした艇はタイムを記録(超過はDNF)
const N_BOATS = 12;
const START_T = -60;
const IS_TOUCH = MOBILE || (window.matchMedia && matchMedia('(pointer: coarse)').matches) || new URLSearchParams(location.search).has('touch');
const NATS = ['JPN', 'ITA', 'BRA', 'USA', 'ESP', 'POR', 'ARG', 'FRA', 'GER', 'GBR', 'AUS', 'NZL', 'CAN', 'KOR', 'CHN'];

// ---------- 乱数 ----------
let rs = Date.now() % 2147483647 || 7;
const rng = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };

// ---------- 設定(保存) ----------
const VENUES = [
  { id: 'enoshima', label: '江の島 (湘南)', icon: '🏝️', eyebrow: 'SNIPE CLASS ・ ENOSHIMA, SHONAN' },
  { id: 'hakkeijima', label: '八景島 (横浜)', icon: '🎢', eyebrow: 'SNIPE CLASS ・ HAKKEIJIMA, YOKOHAMA' },
];
const defaults = { venue: 'enoshima', helm: 'human', crew: 'cat', skin: '#f1c7a0', shirt: '#2b6cff', hat: '#ffffff', sailNo: '31804' };
let cfg = { ...defaults };
try { cfg = { ...defaults, ...JSON.parse(localStorage.getItem('snipe-cfg') || '{}') }; } catch (e) {}
if (cfg.sailNo === '31415' || cfg.sailNo === '30804') cfg.sailNo = '31804';
if (!VENUES.find((v) => v.id === cfg.venue)) cfg.venue = 'enoshima';
const saveCfg = () => { try { localStorage.setItem('snipe-cfg', JSON.stringify(cfg)); } catch (e) {} };
const hexNum = (s) => parseInt(s.replace('#', ''), 16);

// ---------- Three ----------
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
let pixelRatio = Math.min(window.devicePixelRatio || 1, MOBILE ? 1.25 : 1.5);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.5, 150000);
const world = createWorld(scene);
const cam = new DroneCam(camera, canvas);
window.addEventListener('resize', () => { renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); });

// ---------- 状態 ----------
const state = { phase: 'menu', t: START_T, paused: false, sig: 0, pFinish: null, firstFinish: null, resultShown: false, count: -1, ff: false, pAI: null };
let autoTrim = true, lastFlap = 0;
let boats = [], ais = [], models = [], player = null, crewOptions = [...CREW_TYPES];
const keys = new Set();

function humanStyle(random) {
  if (!random) return { skin: hexNum(cfg.skin), shirt: hexNum(cfg.shirt), hat: hexNum(cfg.hat) };
  const skins = [0xf1c7a0, 0xe0ac86, 0xc68642, 0x8d5524, 0xffdbb4];
  const c = new THREE.Color().setHSL(rng(), 0.7, 0.5), h = new THREE.Color().setHSL(rng(), 0.5, 0.75);
  return { skin: skins[(rng() * skins.length) | 0], shirt: c.getHex(), hat: h.getHex() };
}
function randomCrewSpec() {
  const pool = crewOptions.filter((c) => !c.id.startsWith('custom:'));
  const r = rng();
  const type = r < 0.35 ? 'human' : pool[(rng() * pool.length) | 0].id;
  return { type, style: { ...humanStyle(true), jacket: new THREE.Color().setHSL(rng(), 0.9, 0.55).getHex() } };
}

function clearFleet() {
  for (const m of models) scene.remove(m.root);
  boats = []; ais = []; models = []; world.wake.reset();
}
function makeFleet() {
  clearFleet();
  const slots = [];
  // CP艇の号砲時ターゲット横位置(targetC)をピン側(-54)〜本部船側(+59)まで均一に割り当て、
  // 右舷タックで左(-c)へ進む分だけ1分前の初期位置(c)を風上(右/+c)側へオフセットして配置する
  for (let i = 0; i < N_BOATS - 1; i++) {
    const targetC = -54 + i * (113 / (N_BOATS - 2)); // -54 .. +59 (本部船 c=65 のすぐ内側まで均一)
    const a0 = -32 - (i % 3) * 8;
    const c0 = targetC + Math.abs(a0) * 0.78;
    slots.push({ a: a0, c: c0, targetC });
  }
  // 自艇は本部船(c=LINE_HALF)のやや右後方からスタート
  const pslot = { a: -95, c: LINE_HALF + 15, targetC: LINE_HALF - 10 };
  for (let i = slots.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0;[slots[i], slots[j]] = [slots[j], slots[i]]; }
  const used = new Set([cfg.sailNo]);
  for (let k = 0; k < N_BOATS; k++) {
    const isP = k === 0;
    let no; do { no = String(1000 + ((rng() * 30999) | 0)); } while (used.has(no)); used.add(no);
    const color = new THREE.Color().setHSL((k * 0.618) % 1, 0.65, 0.5).getHex();
    const s = isP ? pslot : slots.pop();
    const b = new Boat({ id: k, isPlayer: isP, sailNo: isP ? cfg.sailNo : no, nat: isP ? 'JPN' : NATS[(rng() * NATS.length) | 0], color: isP ? 0xff5a1f : color, skill: isP ? 1 : 1.04 + rng() * 0.05, startTargetC: s.targetC });
    const p = toWorld(s.a + lineA(s.c), s.c);
    b.place(p.x, p.z, W0 - 0.75 + (rng() - 0.5) * 0.05);
    b.v = 0.4; b.sheet = sheetOpt(b.twa);
    boats.push(b);
    let helm, crew;
    if (isP) {
      const jacket = 0xff7a1a;
      helm = { type: cfg.helm, style: { ...humanStyle(false), jacket } };
      crew = { type: cfg.crew, style: { ...humanStyle(false), jacket } };
    } else { helm = randomCrewSpec(); crew = randomCrewSpec(); }
    const m = new BoatModel(b, helm, crew); scene.add(m.root); models.push(m);
    if (!isP) ais.push(new AI(b, rng));
  }
  player = boats[0];
  cam.mount = models[0].mount;
}

// ---------- HUD ----------
const hud = {
  clock: $('clock'), phase: $('phase'), big: $('bigCount'), wkt: $('windKt'), wdir: $('windDir'), needle: $('needle'), spd: $('spd'), hdg: $('hdg'), twa: $('twa'),
  tack: $('tackLbl'), sheet: $('sheetFill'), pen: $('penBadge'), leg: $('legLbl'), legDist: $('legDist'), legArrow: $('legArrow'), leaders: $('leaders'), rank: $('rank'),
  cam: $('camLabel'), toasts: $('toasts'), ocs: $('ocsBadge'), blk: $('blkBadge'), sheetOpt: $('sheetOpt'), autoLbl: $('autoLbl'), pole: $('poleLbl'), tCam: $('tCam'),
};
function toast(text, kind = 'info', ms = 5200) {
  const d = document.createElement('div'); d.className = 'toast ' + kind; d.textContent = text;
  hud.toasts.prepend(d);
  while (hud.toasts.children.length > 5) hud.toasts.lastChild.remove();
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 500); }, ms);
}
// 他艇同士の出来事など、重要度の低い通知は画面端に小さく
function miniLog(text, ms = 3500) {
  const box = $('miniLog'); if (!box) return;
  const d = document.createElement('div'); d.textContent = text; box.prepend(d);
  while (box.children.length > 3) box.lastChild.remove();
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 500); }, ms);
}
const nameOf = (b) => (b.isPlayer ? 'あなた' : `${b.nat} ${b.sailNo}`);
const fmt = (t) => { const s = t < 0 ? Math.ceil(-t) : Math.floor(t), m = Math.floor(s / 60), r = s % 60; return (t < 0 ? '−' : '') + m + ':' + String(r).padStart(2, '0'); };
const fmtMs = (t) => { const m = Math.floor(t / 60), r = t - m * 60; return m + ':' + r.toFixed(1).padStart(4, '0'); };

let lastLeaders = 0;
function computeRanks() {
  const sorted = [...boats].sort((a, b) => progressOf(b) - progressOf(a));
  sorted.forEach((b, i) => (b.rank = i + 1));
  return sorted;
}
function updateLeaders(sorted) {
  const rows = [];
  const top = sorted.slice(0, 8);
  if (!top.includes(player)) top.push(player);
  for (const b of top) {
    const st = b.dsq ? 'DSQ' : (b.dnf && !b.finished) || b.late ? 'DNF' : b.finished ? fmtMs(b.finishTime) : b.ocs ? 'OCS' : b.penalty ? 'PEN' : '';
    rows.push(`<li class="${b.isPlayer ? 'me' : ''}"><span class="pos">${b.dsq ? '−' : b.rank}</span><span class="sw" style="background:#${b.color.toString(16).padStart(6, '0')}"></span><span class="nm">${nameOf(b)}</span><span class="st">${st}</span></li>`);
  }
  hud.leaders.innerHTML = rows.join('');
  hud.rank.textContent = player.dsq ? `DSQ / ${boats.length}` : `${player.rank} / ${boats.length}`;
}

const mm = $('minimap'), mctx = mm.getContext('2d');
function drawMinimap() {
  const W = mm.width, H = mm.height, pad = 16;
  const amin = -170, amax = 320, cmin = -220, cmax = 130;
  const s = Math.min((W - pad * 2) / (cmax - cmin), (H - pad * 2) / (amax - amin));
  const X = (c) => pad + (c - cmin) * s, Y = (a) => H - pad - (a - amin) * s;
  mctx.clearRect(0, 0, W, H);
  mctx.fillStyle = 'rgba(8,24,44,0.55)'; mctx.fillRect(0, 0, W, H);
  mctx.strokeStyle = 'rgba(255,255,255,0.25)'; mctx.setLineDash([4, 4]); mctx.lineWidth = 1;
  const M = MARKS;
  const path = [[0, 0], [M.m1.a, M.m1.c], [M.m1a.a, M.m1a.c], [40, 0], [M.m1.a, M.m1.c], [M.m2.a, M.m2.c], [M.m3.a, M.m3.c], [(M.fcom.a + M.fm.a) / 2, (M.fcom.c + M.fm.c) / 2]];
  mctx.beginPath(); path.forEach(([a, c], i) => (i ? mctx.lineTo(X(c), Y(a)) : mctx.moveTo(X(c), Y(a)))); mctx.stroke(); mctx.setLineDash([]);
  mctx.strokeStyle = '#ffe36a'; mctx.lineWidth = 2; mctx.beginPath(); mctx.moveTo(X(M.pin.c), Y(M.pin.a)); mctx.lineTo(X(M.com.c), Y(M.com.a)); mctx.stroke();
  mctx.strokeStyle = '#6ab4ff'; mctx.beginPath(); mctx.moveTo(X(M.fcom.c), Y(M.fcom.a)); mctx.lineTo(X(M.fm.c), Y(M.fm.a)); mctx.stroke();
  for (const [k, lb] of [['m1', '1'], ['m1a', '1a'], ['m2', '2'], ['m3', '3'], ['gL', '4S'], ['gR', '4P']]) {
    mctx.fillStyle = '#ffb21a'; mctx.beginPath(); mctx.arc(X(M[k].c), Y(M[k].a), 4, 0, 7); mctx.fill();
    mctx.fillStyle = '#fff'; mctx.font = '11px sans-serif'; mctx.fillText(lb, X(M[k].c) + 6, Y(M[k].a) - 4);
  }
  // 次のマーク強調
  const L = LEGS[Math.min(player.leg, LEGS.length - 1)];
  const tg = L.type === 'mark' ? L.mark : L.center;
  mctx.strokeStyle = '#7dffb2'; mctx.lineWidth = 2; mctx.beginPath(); mctx.arc(X(tg.c), Y(tg.a), 9 + Math.sin(performance.now() / 200) * 2, 0, 7); mctx.stroke();
  for (const b of boats) {
    if (b.isPlayer) continue;
    mctx.fillStyle = '#' + b.color.toString(16).padStart(6, '0'); mctx.beginPath(); mctx.arc(X(b.c), Y(b.a), 2.6, 0, 7); mctx.fill();
  }
  mctx.save(); mctx.translate(X(player.c), Y(player.a)); mctx.rotate(player.h - W0);
  mctx.fillStyle = '#ffd23f'; mctx.beginPath(); mctx.moveTo(0, -9); mctx.lineTo(5.5, 6); mctx.lineTo(-5.5, 6); mctx.closePath(); mctx.fill(); mctx.restore();
  // 風向矢印
  mctx.save(); mctx.translate(W - 28, 28); mctx.rotate(player.windFrom - W0);
  mctx.strokeStyle = '#9ad8ff'; mctx.fillStyle = '#9ad8ff'; mctx.lineWidth = 2;
  mctx.beginPath(); mctx.moveTo(0, -14); mctx.lineTo(0, 12); mctx.stroke();
  mctx.beginPath(); mctx.moveTo(0, 16); mctx.lineTo(-6, 6); mctx.lineTo(6, 6); mctx.closePath(); mctx.fill(); mctx.restore();
  mctx.fillStyle = '#9ad8ff'; mctx.font = '10px sans-serif'; mctx.fillText('風', W - 33, 52);
}

function updateHUD(sorted) {
  const b = player, t = state.t;
  const L = LEGS[Math.min(b.leg, LEGS.length - 1)];
  const nextMarkTxt = L.type === 'finish' ? 'フィニッシュ' : L.type === 'gate' ? '4ゲート(4S/4P)' : `${L.name}マーク`;
  hud.clock.textContent = fmt(t);
  hud.phase.textContent = t < 0 ? `1分前 ― 次: スタート → 1マーク` : b.dsq ? 'DSQ (失格)' : b.finished ? 'フィニッシュ!' : `レース中 ― 次: ${nextMarkTxt}`;
  hud.wkt.textContent = (BASE_WIND_KT * b.windF).toFixed(1);
  const wd = ((b.windFrom * 180) / Math.PI + 360) % 360;
  hud.wdir.textContent = Math.round(wd) + '°';
  if (hud.needle) hud.needle.style.transform = `rotate(${b.rel}rad)`;
  hud.spd.textContent = (b.v / SPEED_SCALE / KT).toFixed(1);
  hud.hdg.textContent = Math.round(((b.h * 180) / Math.PI + 360) % 360) + '°';
  hud.twa.textContent = Math.round((b.twa * 180) / Math.PI) + '°';
  if (hud.tack) { hud.tack.textContent = b.tack > 0 ? '右舷' : '左舷'; hud.tack.className = b.tack > 0 ? 'stbd' : 'port'; }
  hud.sheet.style.width = Math.round(b.sheet * 100) + '%';
  hud.sheetOpt.style.left = Math.round(b.sOpt * 100) + '%';
  hud.autoLbl.textContent = autoTrim ? 'セールAUTO' : 'MANUAL'; hud.autoLbl.className = autoTrim ? '' : 'off';
  if (hud.pole) {
    const st = b.pole ? (b.poleK < 1 ? 'UP…' : 'UP') : b.poleK > 0 ? 'DOWN…' : 'DOWN';
    hud.pole.textContent = st; hud.pole.className = b.pole ? 'on' : '';
    const tp = $('tPole'); if (tp) tp.classList.toggle('on', b.pole);
  }
  if (b.cover > 0.3) { hud.blk.style.display = 'block'; hud.blk.textContent = `ブランケット(風影)中 ${Math.round(b.cover * 100)}%`; } else hud.blk.style.display = 'none';
  hud.leg.textContent = b.dsq ? 'DSQ (失格)' : b.finished ? 'フィニッシュ' : t < 0 ? 'スタート準備' : L.label;
  const tg = L.type === 'mark' ? L.mark : L.center;
  const tw = toWorld(tg.a, tg.c);
  const brg = Math.atan2(tw.x - b.x, -(tw.z - b.z));
  hud.legArrow.style.transform = `rotate(${wrap(brg - b.h)}rad)`;
  if (b.penalty && !b.finished) { hud.pen.style.display = 'block'; hud.pen.textContent = `ペナルティ(ルール${b.penalty.rule}) 360°ターン ${Math.min(99, Math.round((b.penalty.turned / (2 * Math.PI)) * 100))}% ― フィニッシュ前に消化必須!`; } else hud.pen.style.display = 'none';
  hud.ocs.style.display = b.ocs && t >= 0 && !b.finished ? 'block' : 'none';
  hud.cam.textContent = '📷 ' + CAM_MODES[cam.mode] + ' [C]';
  if (hud.tCam) { const nx = cam.mode === COCKPIT ? 'ドローン' : '船内'; if (hud.tCam.textContent !== '📷 ' + nx) hud.tCam.textContent = '📷 ' + nx; }
  const c = Math.ceil(-t);
  if (t < 0 && t > -11) { hud.big.textContent = c; hud.big.style.opacity = 1; hud.big.classList.toggle('flash', t > -1); }
  else if (t >= 0 && t < 2.5) { hud.big.textContent = 'START!'; hud.big.style.opacity = 1 - t / 2.5; }
  else hud.big.style.opacity = 0;
  if (performance.now() - lastLeaders > 400) { lastLeaders = performance.now(); updateLeaders(sorted); }
}

// ---------- イベント処理 ----------
function finishRankOf(b) { let n = 1; for (const o of boats) if (o !== b && o.finished && !o.late && !o.dsq && o.finishTime < b.finishTime) n++; return n; }
function handleProgress(b, evs) {
  for (const e of evs) {
    if (e.type === 'finish') {
      // 違反(ペナルティ未消化 または OCS未解消)がある状態でフィニッシュした場合はプロテスト成立によりDSQ(失格)
      if (b.penalty || b.ocs) {
        b.dsq = true;
        b.dsqReason = b.ocs ? 'OCS未解消' : `ルール${b.penalty.rule}違反・ペナルティ未消化`;
        if (b.isPlayer) {
          toast(`プロテスト成立 → DSQ (失格)!\n${b.dsqReason}のままフィニッシュしたため失格となりました`, 'bad', 9000);
          state.pFinish = state.t;
          state.pAI = new AI(b, rng);
        } else if (!state.ff) {
          miniLog(`${nameOf(b)} が違反未消化でフィニッシュ → DSQ`);
        }
        continue;
      }
      const top = state.firstFinish === null;
      if (top) state.firstFinish = b.finishTime;
      if (b.finishTime > state.firstFinish + FINISH_WINDOW) b.late = true;
      // フィニッシュ毎に本部船がホーンを鳴らす(トップは長め)
      if (!state.ff) { if (top) signalHorn('short'); else horn(b.isPlayer ? 0.5 : 0.35, 440); }
      if (b.isPlayer) {
        b.finalRank = finishRankOf(b);
        toast(`フィニッシュ! ${b.finalRank}位 / ${boats.length}艇  タイム ${fmtMs(b.finishTime)}`, 'good', 8000);
        state.pFinish = state.t;
        state.pAI = new AI(b, rng); // フィニッシュ後は自動でコース外へ
      } else if (top && !state.ff) toast(`${nameOf(b)} がトップフィニッシュ ${fmtMs(b.finishTime)}`, 'info', 4000);
      continue;
    }
    if (!b.isPlayer) continue;
    if (e.type === 'rounded') toast(`${e.leg.name}マーク回航 ✓`, 'good', 2500);
    else if (e.type === 'gate') toast('3ゲート通過 ✓ ― 風上の1マークへ', 'good', 3000);
    else if (e.type === 'wrongSide') toast('回航方向が違います(ルール28): マークを左舷に見て、マークの外側を回り直してください', 'warn');
  }
}
const soundVol = (x, z) => clamp(1 - Math.hypot(x - player.x, z - player.z) / 90, 0, 1);
function handleCollision(e) {
  const quiet = state.ff;
  if (e.type === 'contact') {
    const { gw, row } = e;
    if (!quiet) thud(soundVol(gw.x, gw.z));
    const issued = gw.startPenalty(e.rule === 18 ? 18 : e.rule);
    if (quiet) return;
    if (gw.isPlayer) toast(`ペナルティ! ${nameOf(row)} と接触\n${e.text}\n→ 360°ターン(タック+ジャイブ)で消化`, 'bad', 7000);
    else if (row.isPlayer) miniLog(`${nameOf(gw)} が違反(ルール${e.rule}) → 360°ターン`);
    else if (Math.hypot(gw.x - player.x, gw.z - player.z) < 60) miniLog(`${nameOf(gw)} 違反(R${e.rule}) → 360°`);
    if (!issued) return;
  } else if (e.type === 'touch') {
    const b = e.boat; const ok = b.startPenalty(31);
    if (quiet) return;
    const v = soundVol(b.x, b.z);
    if (e.mark === 'com') thud(v); else markHit(v);
    if (b.isPlayer && ok) toast('マークに接触!(ルール31) → 360°ターンで消化', 'bad', 6000);
  }
}

// ---------- レース進行 ----------
function startRace() {
  initAudio();
  applyVenue();
  makeFleet();
  state.phase = 'race'; state.t = START_T - 0.02; state.sig = 0; state.pFinish = null; state.firstFinish = null; state.resultShown = false; state.count = -1; state.ff = false; state.pAI = null;
  state.lastTack = undefined; state.lastPole = undefined; hTarget = null;
  $('menu').classList.add('hidden'); $('result').classList.add('hidden'); $('hud').classList.remove('hidden');
  cam.mode = 0; cam.inited = false; cam.zoom = 1; cam.yaw = 0; cam.pitch = 0;
  document.body.classList.add('hintOn'); clearTimeout(window.__hintT); window.__hintT = setTimeout(() => document.body.classList.remove('hintOn'), 5000);
  const deg = Math.abs((LINE_SKEW * 180) / Math.PI).toFixed(0);
  toast(`スタート1分前、${FAVORED === 'pin' ? 'ピン(左端)' : '本部船(右端)'}側が${deg}度有利`, 'info', 6500);
}
const SIGS = [[-60, 'down'], [0, 'gun']];
function signals(prevT, t) {
  for (const [st, k] of SIGS) if (prevT < st && t >= st) {
    if (k === 'gun') { signalHorn('short'); atGun(); } else signalHorn('long');
  }
  const c = Math.ceil(-t);
  if (t < 0 && t > -6 && c !== state.count) { state.count = c; beep(c <= 1 ? 1200 : 880); }
}
function atGun() {
  for (const b of boats) if (b.a > lineA(b.c)) {
    b.ocs = true;
    if (b.isPlayer) toast('OCS(スタート前にラインを越えた)! ラインの下へ戻って再スタートしてください', 'bad', 7000);
  }
}

function setAuto(v) { autoTrim = v; toast(v ? 'オートトリムON(↑絞る/↓緩める は押している間だけ)' : 'マニュアルトリム(↑絞る/↓緩める で調整・黄色の印が最適)', 'info', 2500); const ta = $('tAuto'); if (ta) ta.classList.toggle('on', v); }
function setPlayerPole(on) {
  if (!player || state.phase !== 'race' || player.finished) return;
  if (on === player.pole) return;
  if (on && !player.setPole(true)) { toast('ランチャーは下レグ(真風角100°以上)でのみ上げられます', 'warn', 2500); return; }
  if (!on) player.setPole(false);
  toast(on ? 'ランチャーアップ — 下レグで少し速くなる(風上には向けない)' : 'ランチャーダウン', 'info', 2200);
}
function tryManeuver(kind) {
  if (player.finished && state.pAI) return;
  if (!player.startManeuver(kind) && player.pole && !player.maneuver) toast('ランチャーを下ろしてからタックしてください', 'warn', 2500);
}
// 舵: 矢印を短く押すと針路が1°ずつ変わる。押し続けると徐々に速く回頭(タック/ジャイブも舵で風をまたぐ)
let hTarget = null, hErrT = 0;
const steerHold = { L: 0, R: 0 };
function playerControl(dt) {
  const b = player, DEG = Math.PI / 180;
  const L = keys.has('ArrowLeft') || keys.has('KeyA'), R = keys.has('ArrowRight') || keys.has('KeyD');
  if (hTarget === null || b.maneuver) hTarget = b.h;
  for (const [on, k, s] of [[L, 'L', -1], [R, 'R', 1]]) {
    if (on) {
      if (steerHold[k] === 0) hTarget = wrap(hTarget + s * DEG); // タップ = 1°
      steerHold[k] += dt;
      if (steerHold[k] > 0.25) hTarget = wrap(hTarget + s * Math.min(60, 20 + (steerHold[k] - 0.25) * 60) * DEG * dt);
    } else steerHold[k] = 0;
  }
  let err = wrap(hTarget - b.h);
  if (Math.abs(err) > 0.12) { hTarget = wrap(b.h + Math.sign(err) * 0.12); err = wrap(hTarget - b.h); } // 目標針路の先行を約7°に制限(舵の慣性を抑える)
  // ランチャー制限などで目標針路へ向けない状態が続いたら目標を現在の針路に合わせる
  if (!L && !R && Math.abs(err) > 0.05) { hErrT += dt; if (hErrT > 3) { hTarget = b.h; hErrT = 0; } } else hErrT = 0;
  if (!b.maneuver) b.steer = clamp(err * 10, -1, 1);
  const up = keys.has('ArrowUp') || keys.has('KeyW'), dn = keys.has('ArrowDown') || keys.has('KeyS');
  if (autoTrim) {
    let tg = b.sOpt;
    if (dn) tg = Math.max(0.05, b.sOpt - 0.6); else if (up) tg = Math.min(1, b.sOpt + 0.3);
    b.sheet += (tg - b.sheet) * (1 - Math.exp(-dt * (dn ? 5 : 2.5)));
  } else {
    if (up) b.sheet = Math.min(1, b.sheet + dt * 0.6);
    if (dn) b.sheet = Math.max(0.05, b.sheet - dt * 1.5);
  }
}

function simStep(dt) {
  const prev = state.t;
  state.t += dt;
  const t = state.t;
  signals(prev, t);
  for (const a of ais) a.update(dt, t, boats);
  if (player.finished && state.pAI) state.pAI.update(dt, t, boats);
  else if (window.__ap) window.__ap.update(dt, t, boats); else playerControl(dt);
  if (player.maneuverStarted) player.maneuverStarted = null;
  // タック/ジャイブ(風をまたいだ瞬間)にセールの「バサッ」、ランチャー上下で「シャキン」
  if (player.tack !== state.lastTack) { if (state.lastTack !== undefined && !state.ff && !player.finished) sailFlog(0.85); state.lastTack = player.tack; }
  if (player.pole !== state.lastPole) { if (state.lastPole !== undefined && !state.ff && !player.finished) poleClank(player.pole); state.lastPole = player.pole; }
  computeBlanket(boats);
  for (const b of boats) b.update(dt, t);
  for (const e of resolveCollisions(boats, t)) handleCollision(e);
  for (const b of boats) {
    handleProgress(b, updateProgress(b, t));
    if (b.ocs && t >= 0 && b.a < lineA(b.c) - 2) { b.ocs = false; if (b.isPlayer) toast('OCS解消 ✓ 再スタート!', 'good', 3000); }
    if (b.penaltyDone) { b.penaltyDone = false; if (b.isPlayer && !state.ff) toast('ペナルティ消化 ✓', 'good', 3000); }
  }
}

// 自艇フィニッシュ後: 残りの艇を早送りで走らせ、制限時間内のフィニッシュタイムを計測する
function fastForwardFinishers() {
  const limit = Math.min(RACE_LIMIT, (state.firstFinish ?? state.t) + FINISH_WINDOW);
  state.ff = true;
  let guard = 0;
  while (state.t < limit && boats.some((b) => !b.finished) && guard++ < 20000) simStep(1 / 30);
  state.ff = false;
}

function showResult() {
  state.resultShown = true;
  const ok = (b) => b.finished && !b.late && !b.dsq;
  const fin = boats.filter(ok).sort((a, b) => a.finishTime - b.finishTime);
  const dnf = boats.filter((b) => !ok(b) && !b.dsq).sort((a, b) => progressOf(b) - progressOf(a));
  const dsq = boats.filter((b) => b.dsq);
  const row = (b, pos, tm) => `<tr class="${b.isPlayer ? 'me' : ''}"><td>${pos}</td><td>${nameOf(b)}</td><td>${tm}</td></tr>`;
  $('resultBody').innerHTML =
    fin.map((b, i) => row(b, i + 1, fmtMs(b.finishTime))).join('') +
    dnf.map((b) => row(b, '−', 'DNF')).join('') +
    dsq.map((b) => row(b, 'DSQ', `DSQ (${b.dsqReason || 'プロテスト'})`)).join('');
  const p = fin.indexOf(player) + 1;
  $('resultTitle').textContent = player.dsq ? `DSQ (失格 — ${player.dsqReason})` : p ? `${p}位 / ${boats.length}艇` : 'DNF';
  $('result').classList.remove('hidden');
}

// ---------- メインループ ----------
const clock = new THREE.Clock();
let frameAvg = 16, lowTime = 0, hudAcc = 0;
function togglePause(p) {
  state.paused = p !== undefined ? p : !state.paused;
  const modal = $('pauseModal');
  if (state.paused) {
    modal.classList.remove('hidden');
    toast('レースを一時中断中', 'info', 2000);
  } else {
    modal.classList.add('hidden');
    toast('レース再開', 'info', 1500);
  }
}

function loop() {
  requestAnimationFrame(loop);
  const raw = Math.min(0.1, clock.getDelta());
  frameAvg += (raw * 1000 - frameAvg) * 0.05;
  if (frameAvg > 26) lowTime += raw; else lowTime = Math.max(0, lowTime - raw);
  if (lowTime > 2.5 && pixelRatio > 0.6) { pixelRatio = Math.max(0.6, pixelRatio - 0.15); renderer.setPixelRatio(pixelRatio); renderer.setSize(window.innerWidth, window.innerHeight); lowTime = 0; }
  const dt = Math.min(0.05, raw);
  const time = performance.now() / 1000;
  
  if (state.phase === 'race' && !state.paused) {
    let rem = dt;
    while (rem > 1e-6) { const s = Math.min(rem, 1 / 60); simStep(s); rem -= s; }
  }
  
  const vt = state.phase === 'race' ? state.t : time;
  for (const m of models) m.sync(dt, time);
  if (models[0]) models[0].setFirstPerson(cam.mode === COCKPIT && state.phase !== 'menu');
  world.wake.update(boats, state.paused ? 0 : dt);
  
  if (player) {
    if (state.phase === 'menu') { cam.mode = 0; cam.update(dt, time, player, boats); }
    else cam.update(dt, time, player, boats);
    world.update(time, camera, dt, state.phase === 'race' ? state.t : START_T);
    setWind(clamp(player.v / 6, 0, 1));
    const active = state.phase === 'race' && !state.paused;
    if (active) updateSailingAudio(dt, player, active);
    setCameraAudio(cam.mode === COCKPIT);
    updateNearbyBoatSound(player, boats, active);
  }
  
  if (state.phase === 'race' && player) {
    world.setLine(state.t >= 0 ? 'finish' : 'start', player.finished ? 0 : player.leg === 6 ? 1 : state.t >= 0 ? 0.15 : 0);
    if (world.setTargetMark) world.setTargetMark(player.leg, state.t, player.finished);
  }
  
  if (state.phase === 'race' && player) {
    hudAcc += raw;
    if (hudAcc >= 1 / 12) {
      hudAcc = 0;
      const sorted = computeRanks();
      updateHUD(sorted);
      drawMinimap();
    }
    if (!state.resultShown) {
      if (state.pFinish !== null && state.t - state.pFinish > 4) { fastForwardFinishers(); showResult(); }
      else if (state.t > RACE_LIMIT || (state.firstFinish !== null && state.t > state.firstFinish + FINISH_WINDOW)) showResult();
    }
  }
  renderer.render(scene, camera);
}

// ---------- 入力 ----------
window.addEventListener('keydown', (e) => {
  if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (state.phase !== 'race') return;
  
  if (e.code === 'Space' && !e.repeat) tryManeuver();
  if (e.code === 'KeyT' && !e.repeat) tryManeuver('tack');
  if (e.code === 'KeyJ' && !e.repeat) tryManeuver('gybe');
  if (e.code === 'KeyL' && !e.repeat) setPlayerPole(!player.pole);
  if (e.code === 'KeyR' && !e.repeat) setAuto(!autoTrim);
  if (e.code === 'KeyC' && !e.repeat) setCamera(cam.mode + 1);
  
  // クイックルック（風上・風下・正面・後方）
  if (e.code === 'KeyQ') cam.lookWindward(player.tack);
  if (e.code === 'KeyE') cam.lookLeeward(player.tack);
  if (e.code === 'KeyW' && !keys.has('ArrowUp')) cam.lookAhead();
  if (e.code === 'KeyS' && !keys.has('ArrowDown')) cam.lookStern();

  if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
  if (e.code === 'KeyM') toast(toggleMute() ? 'ミュート' : 'サウンドON', 'info', 1200);
  if (e.code === 'KeyH') $('help').classList.toggle('hidden');
});

window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function setCamera(m) {
  cam.setMode(m);
}

// タッチ & ボタンUI操作
function initTouch() {
  const tap = (id, fn) => {
    const el = $(id);
    if (!el) return;
    let lastTap = 0;
    const onTap = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = performance.now();
      if (now - lastTap < 350) return;
      lastTap = now;
      fn();
    };
    el.addEventListener('pointerdown', onTap);
    el.addEventListener('click', onTap);
  };
  
  // ポーズモーダル & ボタン
  tap('pauseBtn', () => togglePause());
  tap('resumeBtn', () => togglePause(false));
  tap('restartBtn', () => { togglePause(false); startRace(); });
  tap('exitMenuBtn', () => { togglePause(false); $('result').classList.add('hidden'); $('hud').classList.add('hidden'); $('menu').classList.remove('hidden'); state.phase = 'menu'; makeFleet(); });

  // ランチャー アップ/ダウン
  tap('poleUpBtn', () => setPlayerPole(true));
  tap('poleDownBtn', () => setPlayerPole(false));

  if (!IS_TOUCH) return;
  document.body.classList.add('touch'); $('touch').classList.remove('hidden');
  const hold = (id, code) => {
    const el = $(id);
    const on = (e) => { keys.add(code); el.classList.add('on'); e.preventDefault(); };
    const off = () => { keys.delete(code); el.classList.remove('on'); };
    el.addEventListener('pointerdown', on);
    for (const n of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(n, off);
  };
  hold('tLeft', 'ArrowLeft'); hold('tRight', 'ArrowRight'); hold('tUp', 'ArrowUp'); hold('tDown', 'ArrowDown');
  
  const tapTouch = (id, fn) => $(id).addEventListener('pointerdown', (e) => { e.preventDefault(); if (state.phase === 'race') fn(); });
  tapTouch('tPole', () => setPlayerPole(!player.pole));
  tapTouch('tCam', () => setCamera(cam.mode + 1)); tapTouch('tAuto', () => setAuto(!autoTrim));
  $('tAuto').classList.add('on');
  document.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- メニューUI ----------
function applyVenue() {
  world.setVenue(cfg.venue);
  rebuildObstacles();
  const v = VENUES.find((x) => x.id === cfg.venue) || VENUES[0];
  const eb = $('menuEyebrow');
  if (eb) eb.textContent = v.eyebrow;
}
function buildVenueChoices() {
  const box = $('venueChoices'); if (!box) return;
  box.innerHTML = '';
  for (const v of VENUES) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'choice' + (cfg.venue === v.id ? ' sel' : ''); btn.id = `venue-${v.id}`;
    btn.innerHTML = `<span class="ic">${v.icon}</span><span class="lb">${v.label}</span>`;
    btn.onclick = () => { cfg.venue = v.id; saveCfg(); applyVenue(); makeFleet(); cam.inited = false; buildVenueChoices(); };
    box.appendChild(btn);
  }
}
function buildChoices(containerId, key) {
  const box = $(containerId); box.innerHTML = '';
  for (const c of crewOptions) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'choice' + (cfg[key] === c.id ? ' sel' : ''); btn.id = `${containerId}-${c.id.replace(/[^a-z0-9]/gi, '_')}`;
    btn.innerHTML = `<span class="ic">${c.icon}</span><span class="lb">${c.label}</span>`;
    btn.onclick = () => { cfg[key] = c.id; saveCfg(); buildChoices(containerId, key); updatePreview(); };
    box.appendChild(btn);
  }
}
let pv = null;
function initPreview() {
  const cv = $('preview');
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
  r.setSize(300, 220, false); r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x446677, 2.2)); const dl = new THREE.DirectionalLight(0xffffff, 2); dl.position.set(2, 4, 3); sc.add(dl);
  const cm = new THREE.PerspectiveCamera(35, 300 / 220, 0.1, 50); cm.position.set(0, 0.9, 2.9); cm.lookAt(0, 0.55, 0);
  pv = { r, sc, cm, g: new THREE.Group() }; sc.add(pv.g);
  updatePreview();
  const spin = () => { requestAnimationFrame(spin); if (state.phase !== 'menu') return; pv.g.rotation.y += 0.012; r.render(sc, cm); };
  spin();
}
function updatePreview() {
  if (!pv) return;
  pv.g.clear();
  const st = { skin: hexNum(cfg.skin), shirt: hexNum(cfg.shirt), hat: hexNum(cfg.hat), jacket: 0xff7a1a };
  const a = buildFigure(cfg.helm, st); a.position.x = -0.5; pv.g.add(a);
  const b = buildFigure(cfg.crew, st); b.position.x = 0.5; pv.g.add(b);
}
function initMenu() {
  applyVenue();
  buildVenueChoices();
  buildChoices('helmChoices', 'helm'); buildChoices('crewChoices', 'crew');
  for (const [id, key] of [['skinColor', 'skin'], ['shirtColor', 'shirt'], ['hatColor', 'hat']]) {
    const el = $(id); el.value = cfg[key];
    el.oninput = () => { cfg[key] = el.value; saveCfg(); updatePreview(); };
  }
  const sn = $('sailNo'); sn.value = cfg.sailNo;
  sn.oninput = () => { cfg.sailNo = sn.value.replace(/\D/g, '').slice(0, 5) || '31804'; saveCfg(); };
  $('startBtn').onclick = startRace;
  $('againBtn').onclick = () => { $('result').classList.add('hidden'); $('hud').classList.add('hidden'); $('menu').classList.remove('hidden'); state.phase = 'menu'; makeFleet(); };
  initPreview();
}

(async function boot() {
  if (window.__setLoad) window.__setLoad(95);
  const extra = await loadCustomCrew();
  crewOptions = [...CREW_TYPES, ...extra];
  if (!crewOptions.find((c) => c.id === cfg.helm)) cfg.helm = 'human';
  if (!crewOptions.find((c) => c.id === cfg.crew)) cfg.crew = 'cat';
  const q = new URLSearchParams(location.search);
  if (q.has('venue') && VENUES.find((v) => v.id === q.get('venue'))) cfg.venue = q.get('venue');
  applyVenue();
  makeFleet();
  initMenu();
  initTouch();
  if (window.__setLoad) window.__setLoad(100);
  setTimeout(() => $('loading').classList.add('hidden'), 250);
  loop();
  window.__game = { state, get boats() { return boats; }, get player() { return player; }, simStep, cam };
  if (q.has('auto')) {
    startRace();
    const skip = parseFloat(q.get('skip') || '0');
    if (q.has('autopilot')) { const ap = new AI(player, rng); window.__ap = ap; }
    for (let s = 0; s < skip * 60; s++) simStep(1 / 60);
    if (q.has('cam')) cam.setMode(+q.get('cam'));
  }
})();

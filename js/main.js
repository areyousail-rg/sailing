// ゲーム本体: 初期化・状態管理・HUD
import * as THREE from 'three';
import { createWorld, MOBILE } from './world.js';
import { Boat, resolveCollisions, computeBlanket, sheetOpt, KT, SPEED_SCALE, BASE_WIND_KT, SIDE_BIAS, setWindParams, wrap, clamp, rebuildObstacles, SEA, setSeaState, randomizeWindShifts, SHIFT_LOG, shiftAt, windAt } from './sim.js';
import { Recorder, openReview } from './review.js';
import { AI } from './ai.js';
import { BoatModel } from './boatmodel.js';
import { CREW_TYPES, buildFigure, loadCustomCrew } from './crew.js';
import { DroneCam, CAM_MODES, COCKPIT } from './camera.js';
import { LEGS, W0, LINE_HALF, LINE_SKEW, FAVORED, lineA, MARKS, COURSE_MODE, setCourseMode, randomizeStartLine, updateProgress, progressOf, toCourse, toWorld } from './course.js';
import { initAudio, horn, beep, setWind, toggleMute, thud, markHit, updateNearbyBoatSound, signalHorn, updateSailingAudio, setCameraAudio, sailFlog, poleClank } from './audio.js';

const $ = (id) => document.getElementById(id);
const RACE_LIMIT = 600;
const FINISH_WINDOW = 150; // トップフィニッシュからこの秒数以内にフィニッシュした艇はタイムを記録(超過はDNF)
const N_BOATS = 16; // 自艇1 + CP艇15 (うち4艇はやや遅めのCP船)
const START_T = -60;
const IS_TOUCH = MOBILE || (window.matchMedia && matchMedia('(pointer: coarse)').matches) || new URLSearchParams(location.search).has('touch');
const NATS = ['JPN', 'ITA', 'BRA', 'USA', 'ESP', 'POR', 'ARG', 'FRA', 'GER', 'GBR', 'AUS', 'NZL', 'CAN', 'KOR', 'CHN'];

// ---------- 乱数 ----------
let rs = Date.now() % 2147483647 || 7;
const rng = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };

// ---------- 設定(保存) ----------
const VENUES = [
  { id: 'hakkeijima', label: '八景島 (横浜)', icon: '', eyebrow: 'SNIPE CLASS ・ HAKKEIJIMA, YOKOHAMA', lat: 35.337, lon: 139.658, defaultWindDeg: 15, defaultWindKt: 9 },
  { id: 'enoshima', label: '江の島 (湘南)', icon: '', eyebrow: 'SNIPE CLASS ・ ENOSHIMA, SHONAN', lat: 35.292, lon: 139.488, defaultWindDeg: 200, defaultWindKt: 9 },
];
const COURSE_MODES = [
  { id: 'trapezoid', label: 'トラペゾイド', icon: '' },
  { id: 'upwind', label: '上マークフィニッシュ', icon: '' },
];
const PENALTY_MODES = [
  { id: 'off', label: 'ペナルティなし', icon: '' },
  { id: 'on', label: 'ペナルティあり (360°/720°・DSQ)', icon: '' },
];
const weatherCache = {}; // Open-Meteo 取得結果キャッシュ(スタート前のメニュー時のみ1回取得しレース中の負荷ゼロ)
const defaults = { venue: 'hakkeijima', courseMode: 'trapezoid', penaltyMode: 'off', helm: 'human_m', crew: 'cat', skin: '#f1c7a0', shirt: '#2b6cff', hat: '#ffffff', sailNo: '31804' };
let cfg = { ...defaults };
try { cfg = { ...defaults, ...JSON.parse(localStorage.getItem('snipe-cfg') || '{}') }; } catch (e) {}
if (cfg.sailNo === '31415' || cfg.sailNo === '30804') cfg.sailNo = '31804';
// デフォルト選択は常にレース海面＝八景島(hakkeijima)、ヘルムスマン＝男性(human_m)、クルー＝ネコ(cat)で初期化
cfg.venue = 'hakkeijima';
cfg.helm = 'human_m';
cfg.crew = 'cat';
if (!COURSE_MODES.find((m) => m.id === cfg.courseMode)) cfg.courseMode = 'trapezoid';
if (!PENALTY_MODES.find((m) => m.id === cfg.penaltyMode)) cfg.penaltyMode = 'off';
const saveCfg = () => { try { localStorage.setItem('snipe-cfg', JSON.stringify(cfg)); } catch (e) {} };
const hexNum = (s) => parseInt(s.replace('#', ''), 16);

// ---------- Three ----------
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
const pixelRatio = Math.min(window.devicePixelRatio || 1, MOBILE ? 1.0 : 1.25);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.5, 150000);
const world = createWorld(scene);
const cam = new DroneCam(camera, canvas);
cam.menuOffset = true;
document.body.classList.add('menuOpen');
window.addEventListener('resize', () => { renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); });

// ---------- 状態 ----------
const state = { phase: 'menu', t: START_T, paused: false, sig: 0, pFinish: null, firstFinish: null, resultShown: false, count: -1, ff: false, pAI: null };
let autoTrim = true, lastFlap = 0, recorder = null;
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
  const type = r < 0.25 ? 'human_m' : r < 0.45 ? 'human_f' : pool[(rng() * pool.length) | 0].id;
  return { type, style: { ...humanStyle(true), jacket: new THREE.Color().setHSL(rng(), 0.9, 0.55).getHex() } };
}

function clearFleet() {
  for (const m of models) {
    if (m.dispose) m.dispose();
    scene.remove(m.root);
  }
  boats = []; ais = []; models = []; world.wake.reset();
}
function makeFleet() {
  clearFleet();
  hTarget = null; hErrT = 0; steerHold.L = 0; steerHold.R = 0;
  // 強いCP艇(k=1..4)が特に上側の端っこ(本部船すぐ内側 c=+62..+71)や下端(ピンすぐ内側 c=-70..-62)からも積極的に出るようにスロットを構成
  const endTargets = FAVORED === 'pin'
    ? [70.5, -69.5, 65.5, -63.0]
    : [71.0, 66.5, 62.0, -68.5];
  for (let i = endTargets.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [endTargets[i], endTargets[j]] = [endTargets[j], endTargets[i]];
  }
  const midTargets = [];
  const nMid = N_BOATS - 1 - endTargets.length;
  for (let i = 0; i < nMid; i++) {
    midTargets.push(-55 + i * (112 / Math.max(1, nMid - 1)) + (rng() - 0.5) * 3.0);
  }
  for (let i = midTargets.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [midTargets[i], midTargets[j]] = [midTargets[j], midTargets[i]];
  }
  const allTargets = [...endTargets, ...midTargets];
  const slots = allTargets.map((targetC, i) => {
    const isUpperEnd = targetC >= 60;
    const a0 = isUpperEnd ? -24 - (i % 3) * 6.0 : -30 - (i % 4) * 7.0;
    const c0 = targetC + Math.abs(a0) * 0.85;
    return { a: a0, c: c0, targetC };
  });
  // 自艇は低速時の1.5倍の下流れを考慮し、本部船(c=LINE_HALF)の右側(c=LINE_HALF+32)に配置
  const pslot = { a: -82, c: LINE_HALF + 32, targetC: LINE_HALF - 8 };
  const used = new Set([cfg.sailNo]);
  for (let k = 0; k < N_BOATS; k++) {
    const isP = k === 0;
    let no; do { no = String(1000 + ((rng() * 30999) | 0)); } while (used.has(no)); used.add(no);
    const color = new THREE.Color().setHSL((k * 0.618) % 1, 0.65, 0.5).getHex();
    const s = isP ? pslot : slots[k - 1];
    // 1マークで全艇が団子になってごった返さないよう、上位群・中上位群・中下位群・下位群でCPのレベル(艇速・スキル)に自然なばらつきを持たせる
    // 強いCP艇(k=1..4)には端っこ(上端・下端)のスロットを割り当てる
    const cpSkill =
      k <= 4 ? 1.06 + rng() * 0.045 :
      k <= 8 ? 1.00 + rng() * 0.045 :
      k <= 12 ? 0.94 + rng() * 0.045 :
      0.87 + rng() * 0.055;
    const b = new Boat({ id: k, isPlayer: isP, sailNo: isP ? cfg.sailNo : no, nat: isP ? 'JPN' : NATS[(rng() * NATS.length) | 0], color: isP ? 0xff5a1f : color, skill: isP ? 1 : cpSkill, startTargetC: s.targetC });
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
    const m = new BoatModel(b, helm, crew);
    m.sync(0, 0);
    scene.add(m.root);
    models.push(m);
    if (!isP) ais.push(new AI(b, rng));
  }
  player = boats[0];
  cam.mount = models[0].mount;
}
function rebuildPlayerModel() {
  if (!player || !models[0]) return;
  if (models[0].dispose) models[0].dispose();
  scene.remove(models[0].root);
  player.sailNo = cfg.sailNo;
  const jacket = 0xff7a1a;
  const helm = { type: cfg.helm, style: { ...humanStyle(false), jacket } };
  const crew = { type: cfg.crew, style: { ...humanStyle(false), jacket } };
  const m = new BoatModel(player, helm, crew);
  m.sync(0, 0);
  scene.add(m.root);
  models[0] = m;
  cam.mount = m.mount;
}

// ---------- HUD ----------
const hud = {
  clock: $('clock'), phase: $('phase'), big: $('bigCount'), wkt: $('windKt'), wdir: $('windDir'), needle: $('needle'), spd: $('spd'), hdg: $('hdg'), twa: $('twa'),
  tack: $('tackLbl'), sheet: $('sheetFill'), pen: $('penBadge'), leg: $('legLbl'), legDist: $('legDist'), legArrow: $('legArrow'), leaders: $('leaders'), rank: $('rank'),
  cam: $('camLabel'), toasts: $('toasts'), ocs: $('ocsBadge'), blk: $('blkBadge'), blkTxt: $('blkTxt'), blkFill: $('blkFill'), sheetOpt: $('sheetOpt'), autoLbl: $('autoLbl'), pole: $('poleLbl'), tCam: $('tCam'),
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
  const isUpwind = COURSE_MODE === 'upwind';
  const amin = isUpwind ? -110 : -170, amax = isUpwind ? 635 : 320, cmin = isUpwind ? -180 : -220, cmax = isUpwind ? 180 : 130;
  const s = Math.min((W - pad * 2) / (cmax - cmin), (H - pad * 2) / (amax - amin));
  const X = (c) => pad + (c - cmin) * s, Y = (a) => H - pad - (a - amin) * s;
  mctx.clearRect(0, 0, W, H);
  mctx.fillStyle = 'rgba(8,24,44,0.55)'; mctx.fillRect(0, 0, W, H);
  mctx.strokeStyle = 'rgba(255,255,255,0.25)'; mctx.setLineDash([4, 4]); mctx.lineWidth = 1;
  const M = MARKS;
  const path = isUpwind
    ? [[0, 0], [(M.fcom.a + M.fm.a) / 2, (M.fcom.c + M.fm.c) / 2]]
    : [[0, 0], [M.m1.a, M.m1.c], [M.m1a.a, M.m1a.c], [40, 0], [M.m1.a, M.m1.c], [M.m2.a, M.m2.c], [M.m3.a, M.m3.c], [(M.fcom.a + M.fm.a) / 2, (M.fcom.c + M.fm.c) / 2]];
  mctx.beginPath(); path.forEach(([a, c], i) => (i ? mctx.lineTo(X(c), Y(a)) : mctx.moveTo(X(c), Y(a)))); mctx.stroke(); mctx.setLineDash([]);
  mctx.strokeStyle = '#ffe36a'; mctx.lineWidth = 2; mctx.beginPath(); mctx.moveTo(X(M.pin.c), Y(M.pin.a)); mctx.lineTo(X(M.com.c), Y(M.com.a)); mctx.stroke();
  // スタート前のみ: 有利サイド(赤丸＋「5°下有利」等のコンパクト表記)をミニマップに表示
  const isPreStart = (state.phase === 'race' && state.t < 0) || state.phase === 'menu';
  if (isPreStart) {
    mctx.save();
    const skewDeg = Math.round(Math.abs((LINE_SKEW * 180) / Math.PI));
    const isEven = FAVORED === 'even' || skewDeg === 0;
    if (!isEven) {
      const favM = FAVORED === 'com' ? M.com : M.pin;
      mctx.fillStyle = '#ff3b3b';
      mctx.beginPath(); mctx.arc(X(favM.c), Y(favM.a), 4.6, 0, Math.PI * 2); mctx.fill();
      mctx.strokeStyle = '#fde047'; mctx.lineWidth = 1.4; mctx.stroke();
    }
    const favTxt = isEven ? '0°有利なし' : `${skewDeg}°${FAVORED === 'com' ? '上有利' : '下有利'}`;
    mctx.fillStyle = '#fca5a5';
    mctx.font = 'bold 10px sans-serif';
    mctx.textAlign = 'center';
    mctx.fillText(favTxt, X(0), Y(Math.max(M.pin.a, M.com.a)) - 6);
    mctx.restore();
  }
  mctx.strokeStyle = '#6ab4ff'; mctx.beginPath(); mctx.moveTo(X(M.fcom.c), Y(M.fcom.a)); mctx.lineTo(X(M.fm.c), Y(M.fm.a)); mctx.stroke();
  const markList = isUpwind ? [['m1', '1']] : [['m1', '1'], ['m1a', '1a'], ['m2', '2'], ['m3', '3'], ['gL', '4S'], ['gR', '4P']];
  for (const [k, lb] of markList) {
    mctx.fillStyle = '#ffb21a'; mctx.beginPath(); mctx.arc(X(M[k].c), Y(M[k].a), 4, 0, 7); mctx.fill();
    mctx.fillStyle = '#fff'; mctx.font = '11px sans-serif'; mctx.fillText(lb, X(M[k].c) + 6, Y(M[k].a) - 4);
  }
  if (isUpwind) {
    mctx.fillStyle = '#38bdf8'; mctx.beginPath(); mctx.arc(X(M.fcom.c), Y(M.fcom.a), 3.8, 0, 7); mctx.fill();
    mctx.fillStyle = '#e0f2fe'; mctx.font = 'bold 10px sans-serif'; mctx.fillText('FIN(S旗)', X(M.fcom.c) + 6, Y(M.fcom.a) + 3);
  }
  // 次のマーク強調
  const L = LEGS[Math.min(player.leg, LEGS.length - 1)];
  const tg = L.type === 'mark' ? L.mark : L.center;
  mctx.strokeStyle = '#ff3b3b'; mctx.lineWidth = 2; mctx.beginPath(); mctx.arc(X(tg.c), Y(tg.a), 9 + Math.sin(performance.now() / 200) * 2, 0, 7); mctx.stroke();
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

const markPtr = { box: $('markPointer'), arrow: $('mpArrow'), label: $('mpText'), v3: new THREE.Vector3() };
function updateMarkPointer(b) {
  if (!markPtr.box || !b || b.finished || b.dsq || state.phase === 'menu') {
    if (markPtr.box) markPtr.box.classList.add('hidden');
    return;
  }
  const L = LEGS[Math.min(b.leg, LEGS.length - 1)];
  const tg = L.type === 'mark' ? L.mark : L.center;
  const tw = toWorld(tg.a, tg.c);
  const distM = Math.round(Math.hypot(tw.x - b.x, tw.z - b.z) / 1.5);
  const shortName = L.type === 'finish' ? 'FINISH' : L.type === 'gate' ? '4G' : L.name;

  markPtr.v3.set(tw.x, 4.2, tw.z);
  markPtr.v3.project(camera);

  const behind = markPtr.v3.z > 1;
  let nx = behind ? -markPtr.v3.x : markPtr.v3.x;
  let ny = behind ? -markPtr.v3.y : markPtr.v3.y;
  const marginX = 0.88, marginY = 0.80;
  const offScreen = behind || Math.abs(nx) > marginX || Math.abs(ny) > marginY;

  // ドローン視点で画面内にマークが入っている場合は3D矢印が見えるので端ポインターは非表示、
  // 船内視点(COCKPIT)または画面外にある場合は常時表示して位置を分かりやすくする
  if (!offScreen && cam.mode !== COCKPIT) {
    markPtr.box.classList.add('hidden');
    return;
  }
  markPtr.box.classList.remove('hidden');

  const W = window.innerWidth, H = window.innerHeight;
  let sx, sy, ang;
  if (offScreen) {
    ang = Math.atan2( nx, ny ); // 0 = 画面上方向, +π/2 = 右
    const k = Math.max(Math.abs(nx) / marginX, Math.abs(ny) / marginY, 1e-4);
    const cx = nx / k, cy = ny / k;
    sx = (cx * 0.5 + 0.5) * W;
    sy = (-cy * 0.5 + 0.5) * H;
  } else {
    sx = (nx * 0.5 + 0.5) * W;
    sy = Math.max(54, (-ny * 0.5 + 0.5) * H - 28);
    ang = Math.PI; // 下向き矢印でその直下のマークを指す
  }
  sx = clamp(sx, 48, W - 48);
  sy = clamp(sy, 52, H - 52);
  markPtr.box.style.left = `${sx}px`;
  markPtr.box.style.top = `${sy}px`;
  if (markPtr.arrow) markPtr.arrow.style.transform = `rotate(${ang}rad)`;
  if (markPtr.label) markPtr.label.textContent = `${shortName} ${distM}m`;
}

// ---------- 艇内カメラ(COCKPIT)専用: カメラ視界外(死角)から近づいている15m以内の他艇のみ画面端に表示 ----------
const nearBoatsBox = $('nearBoats');
const nearBoatPool = [];
const nearBoatV3 = new THREE.Vector3();
function updateNearBoatsHUD(b) {
  if (!nearBoatsBox) return;
  if (!b || cam.mode !== COCKPIT || b.finished || b.dsq || state.phase === 'menu') {
    for (const el of nearBoatPool) el.style.display = 'none';
    return;
  }
  const near = [];
  const bvx = Math.sin(b.h) * b.v, bvz = -Math.cos(b.h) * b.v;
  for (const o of boats) {
    if (o === b || o.dsq) continue;
    const dx = o.x - b.x, dz = o.z - b.z;
    const distM = Math.hypot(dx, dz) / 1.5; // ワールド距離(1.5x)から実距離[m]へ換算
    if (distM > 15) continue; // 15m以内から表記
    // 離れていく船は表示しない (相対速度ベクトルと位置ベクトルの内積が負＝接近中のみ表示)
    const ovx = Math.sin(o.h) * o.v, ovz = -Math.cos(o.h) * o.v;
    const closingDot = dx * (ovx - bvx) + dz * (ovz - bvz);
    if (closingDot >= -0.02) continue;
    // カメラ視界内に入っている他艇は直接見えるため表示せず、カメラに見えない(画面外の)接近艇だけ表示する
    nearBoatV3.set(o.x, 1.8, o.z).project(camera);
    const behind = nearBoatV3.z > 1;
    const inView = !behind && Math.abs(nearBoatV3.x) <= 0.90 && Math.abs(nearBoatV3.y) <= 0.84;
    if (inView) continue;
    near.push({ o, dx, dz, distM });
  }
  near.sort((a, c) => a.distM - c.distM);
  const count = Math.min(near.length, 3);
  const W = window.innerWidth, H = window.innerHeight;
  const viewHdg = b.h + (cam.yaw || 0); // 現在のカメラ視線方位

  for (let i = 0; i < count; i++) {
    let el = nearBoatPool[i];
    if (!el) {
      el = document.createElement('div');
      el.className = 'nearBoatTag';
      nearBoatsBox.appendChild(el);
      nearBoatPool.push(el);
    }
    const { o, dx, dz, distM } = near[i];
    const brg = Math.atan2(dx, -dz);
    const relB = wrap(brg - b.h);       // 自艇船首基準の相対角(左舷/右舷表現用)
    const relCam = wrap(brg - viewHdg); // カメラ画面基準の方向角(画面端の配置用)

    const dirX = Math.sin(relCam);
    const dirY = Math.cos(relCam);
    const edgeX = 0.85, edgeY = 0.76;
    const scale = Math.max(Math.abs(dirX) / edgeX, Math.abs(dirY) / edgeY, 1e-4);
    const nx = dirX / scale;
    const ny = dirY / scale;
    const sx = clamp((nx * 0.5 + 0.5) * W, 68, W - 68);
    const sy = clamp((-ny * 0.5 + 0.5) * H, 58, H - 58);

    const degB = (relB * 180) / Math.PI;
    let sector = '後方';
    if (degB >= -22 && degB <= 22) sector = '前方';
    else if (degB > 22 && degB <= 68) sector = '右前';
    else if (degB > 68 && degB <= 115) sector = '右横';
    else if (degB > 115 && degB <= 158) sector = '右後';
    else if (degB < -22 && degB >= -68) sector = '左前';
    else if (degB < -68 && degB >= -115) sector = '左横';
    else if (degB < -115 && degB >= -158) sector = '左後';

    const distStr = distM < 10 ? `${distM.toFixed(1)}m` : `${Math.round(distM)}m`;
    const colHex = '#' + o.color.toString(16).padStart(6, '0');
    // 15m〜10mまでは薄い表示(.faint)、10m以内ははっきり警告表示
    const lv = distM < 6.5 ? ' danger' : distM <= 10 ? ' warn' : ' faint';
    el.className = 'nearBoatTag' + lv;
    el.style.display = 'flex';
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
    el.innerHTML = `<span class="mpArrow" style="transform:rotate(${relCam}rad)">▲</span><span class="nbSw" style="background:${colHex}"></span><span>${sector} ${distStr}</span>`;
  }
  for (let i = count; i < nearBoatPool.length; i++) {
    nearBoatPool[i].style.display = 'none';
  }
}

function updateHUD(sorted) {
  const b = player, t = state.t;
  const isMenu = state.phase === 'menu';
  const isPrac = isMenu || state.phase === 'practice';
  document.body.classList.toggle('menuOpen', isMenu);
  cam.menuOffset = isMenu;
  const L = LEGS[Math.min(b.leg, LEGS.length - 1)];
  const nextMarkTxt = L.type === 'finish' ? 'フィニッシュ' : L.type === 'gate' ? '4ゲート(4S/4P)' : `${L.name}マーク`;
  const skewDeg = Math.round(Math.abs((LINE_SKEW * 180) / Math.PI));
  const favShort = (FAVORED === 'even' || skewDeg === 0) ? '0°有利なし' : `${skewDeg}°${FAVORED === 'com' ? '上有利' : '下有利'}`;
  hud.clock.textContent = isPrac ? '練習中' : fmt(t);
  hud.phase.textContent = isPrac ? `練習航行モード ― 次: ${nextMarkTxt}` : t < 0 ? `スタート前 (${favShort}) ― 次: 1マーク` : b.dsq ? 'DSQ (失格)' : b.finished ? 'フィニッシュ!' : `レース中 ― 次: ${nextMarkTxt}`;
  hud.wkt.textContent = (BASE_WIND_KT * b.windF).toFixed(1);
  const wd = ((b.windFrom * 180) / Math.PI + 360) % 360;
  hud.wdir.textContent = Math.round(wd) + '°';
  if (hud.needle) hud.needle.style.transform = `rotate(${b.rel}rad)`;
  hud.spd.textContent = (Math.abs(b.v) / SPEED_SCALE / KT).toFixed(1);
  hud.hdg.textContent = Math.round(((b.h * 180) / Math.PI + 360) % 360) + '°';
  hud.twa.textContent = Math.round(b.effTwaDeg ?? (b.twa * 180) / Math.PI) + '°';
  if (hud.tack) { hud.tack.textContent = b.tack > 0 ? '右舷' : '左舷'; hud.tack.className = b.tack > 0 ? 'stbd' : 'port'; }
  hud.sheet.style.width = Math.round(b.sheet * 100) + '%';
  hud.sheetOpt.style.left = Math.round(b.sOpt * 100) + '%';
  hud.autoLbl.textContent = autoTrim ? 'AUTO' : 'MANUAL'; hud.autoLbl.className = autoTrim ? '' : 'off';
  if (hud.pole) {
    const st = b.pole ? (b.poleK < 1 ? 'UP…' : 'UP') : b.poleK > 0 ? 'DOWN…' : 'DOWN';
    hud.pole.textContent = st; hud.pole.className = b.pole ? 'on' : '';
    const tp = $('tPole'); if (tp) tp.classList.toggle('on', b.pole);
  }
  // ブランケット/バックウインド表示: 風上艇の風影=ブランケット、風下艇のリーチからの吹き返し(風上側で失速)=バックウインド
  const blkPct = Math.round(b.cover * 100);
  if (blkPct >= 5) {
    hud.blk.style.display = 'flex';
    const isBack = b.back > 0.03 && b.back >= (b.cover - b.back);
    if (hud.blkTxt) hud.blkTxt.textContent = `${isBack ? 'バックウインド' : 'ブランケット'} ${blkPct}%`;
    if (hud.blkFill) hud.blkFill.style.width = `${blkPct}%`;
    hud.blk.classList.toggle('mid', blkPct >= 35 && blkPct < 65);
    hud.blk.classList.toggle('high', blkPct >= 65);
  } else {
    hud.blk.style.display = 'none';
  }
  hud.leg.textContent = isPrac ? '練習航行' : b.dsq ? 'DSQ (失格)' : b.finished ? 'フィニッシュ' : t < 0 ? `スタート前 (${favShort})` : L.label;
  const tg = L.type === 'mark' ? L.mark : L.center;
  const tw = toWorld(tg.a, tg.c);
  const brg = Math.atan2(tw.x - b.x, -(tw.z - b.z));
  hud.legArrow.style.transform = `rotate(${wrap(brg - b.h)}rad)`;
  if (b.penalty && !b.finished && !b.dsq && !isPrac) {
    hud.pen.style.display = 'block';
    const deg = b.penalty.reqDeg || 360;
    const turns = deg === 720 ? '720°(2回転)' : '360°(1回転)';
    const pct = Math.min(99, Math.round((b.penalty.turned / (b.penalty.reqRad || 2 * Math.PI)) * 100));
    const sec = Math.ceil(b.penalty.timer);
    const cw = !b.penalty.clearWater ? ' [クリアウオーター確保中]' : '';
    hud.pen.textContent = `ペナルティ(ルール${b.penalty.rule}) 残り${sec}秒以内に${turns}ターンせよ (${pct}%)${cw}`;
  } else hud.pen.style.display = 'none';
  hud.ocs.style.display = !isPrac && b.ocs && t >= 0 && !b.finished && !b.dsq ? 'block' : 'none';
  hud.cam.textContent = 'CAM  ' + CAM_MODES[cam.mode] + ' [C]';
  if (hud.tCam) { const nx = cam.mode === COCKPIT ? 'ドローン' : '船内'; if (hud.tCam.textContent !== nx) hud.tCam.textContent = nx; }
  if (!isPrac) {
    const c = Math.ceil(-t);
    if (t < 0 && t > -11) { hud.big.textContent = c; hud.big.style.opacity = 1; hud.big.classList.toggle('flash', t > -1); }
    else if (t >= 0 && t < 2.5) { hud.big.textContent = 'START!'; hud.big.style.opacity = 1 - t / 2.5; }
    else hud.big.style.opacity = 0;
  } else {
    hud.big.style.opacity = 0;
  }
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
        b.dsqReason = b.ocs ? 'OCS未解消' : `ルール${b.penalty.rule}違反・${b.penalty.reqDeg || 360}°ペナルティ未消化`;
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
    if (e.type === 'rounded') toast(`${e.leg.name}マーク回航`, 'good', 2500);
    else if (e.type === 'gate') toast('4ゲート通過 ― 風上の1マークへ', 'good', 3000);
    else if (e.type === 'wrongSide') toast('回航方向が違います(ルール28): マークを左舷に見て、マークの外側を回り直してください', 'warn');
  }
}
const soundVol = (x, z) => clamp(1 - Math.hypot(x - player.x, z - player.z) / 90, 0, 1);
function handleCollision(e) {
  const quiet = state.ff;
  const penOn = cfg.penaltyMode === 'on';
  if (e.type === 'contact') {
    const { gw, row } = e;
    if (!quiet) thud(soundVol(gw.x, gw.z));
    if (!penOn) {
      if (quiet) return;
      if (gw.isPlayer) toast(`【違反判定】${nameOf(row)} と接触 (${e.text})\n本来は ルール${e.rule}違反 → 720°(2回転)ペナルティ ですが、ペナルティ無モードのためそのままレース続行`, 'warn', 6500);
      else if (row.isPlayer) miniLog(`${nameOf(gw)} が違反(ルール${e.rule}・本来720°ターン) ※ペナルティ無のため続行`);
      return;
    }
    const issued = gw.startPenalty(e.rule === 18 ? 18 : e.rule);
    if (quiet) return;
    if (gw.isPlayer) toast(`ペナルティ! ${nameOf(row)} と接触\n${e.text}\n→ 速やかに(25秒以内に) 720°(2回転)ターン で消化せよ!`, 'bad', 7500);
    else if (row.isPlayer) miniLog(`${nameOf(gw)} が違反(ルール${e.rule}) → 720°(2回転)ターン`);
    else if (Math.hypot(gw.x - player.x, gw.z - player.z) < 60) miniLog(`${nameOf(gw)} 違反(R${e.rule}) → 720°`);
    if (!issued) return;
  } else if (e.type === 'touch') {
    const b = e.boat;
    if (!quiet) {
      const v = soundVol(b.x, b.z);
      if (e.mark === 'com') thud(v); else markHit(v);
    }
    if (!penOn) {
      if (!quiet && b.isPlayer) toast('【違反判定】マークに接触! (ルール31)\n本来は 360°(1回転)ペナルティ ですが、ペナルティ無モードのためそのままレース続行', 'warn', 5500);
      return;
    }
    const ok = b.startPenalty(31);
    if (quiet) return;
    if (b.isPlayer && ok) {
      const isUpgraded = b.penalty && b.penalty.reqDeg === 720;
      toast(isUpgraded ? 'ペナルティ中の追加接触!(ルール31) → 720°(2回転)ターン へ格上げ!' : 'マークに接触!(ルール31) → 速やかに(20秒以内に) 360°(1回転)ターン で消化せよ!', 'bad', 6500);
    }
  }
}

// ---------- レース進行 ----------
function startRace() {
  initAudio();
  randomizeStartLine();
  randomizeWindShifts(Date.now() ^ (rng() * 1e9));
  applyVenue();
  makeFleet();
  recorder = new Recorder(boats, LEGS, {
    venue: cfg.venue,
    courseMode: cfg.courseMode,
    sea: SEA.label,
    windDeg: currentWindDeg,
    baseWindKt: BASE_WIND_KT,
    sideBias: SIDE_BIAS,
    sideBiasDesc: currentSideBiasDesc,
    shiftLog: [...SHIFT_LOG],
    shiftAt,
    windAt,
    toWorld,
  });
  state.phase = 'race'; state.t = START_T - 0.02; state.sig = 0; state.pFinish = null; state.firstFinish = null; state.resultShown = false; state.count = -1; state.ff = false; state.pAI = null;
  state.lastTack = undefined; state.lastPole = undefined; hTarget = null;
  document.body.classList.remove('menuOpen'); cam.menuOffset = false;
  $('menu').classList.add('hidden'); $('result').classList.add('hidden'); $('hud').classList.remove('hidden');
  cam.mode = 0; cam.inited = false; cam.zoom = 1; cam.yaw = 0; cam.pitch = 0;
  document.body.classList.add('hintOn'); clearTimeout(window.__hintT); window.__hintT = setTimeout(() => document.body.classList.remove('hintOn'), 5000);
  const deg = Math.round(Math.abs((LINE_SKEW * 180) / Math.PI));
  const favLabel = (FAVORED === 'even' || deg === 0) ? '0°有利なし' : `${deg}°${FAVORED === 'com' ? '上有利' : '下有利'}`;
  toast(`スタート1分前 (${favLabel})`, 'info', 6500);
}
function startPractice() {
  initAudio();
  applyVenue();
  makeFleet();
  state.phase = 'practice'; state.t = 0; state.paused = false; state.pFinish = null; state.firstFinish = null; state.resultShown = false; state.ff = false; state.pAI = null;
  state.lastTack = undefined; state.lastPole = undefined; hTarget = null;
  document.body.classList.remove('menuOpen'); cam.menuOffset = false;
  $('menu').classList.add('hidden'); $('result').classList.add('hidden'); $('hud').classList.remove('hidden');
  toast('練習モード開始 ― 自由にコースを航行できます（右上「⏸ 中断」からいつでもスタート画面へ戻れます）', 'info', 5500);
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
  if (!player || (state.phase !== 'race' && state.phase !== 'menu' && state.phase !== 'practice') || player.finished || player.dsq) return;
  if (on === player.pole) return;
  if (on && !player.setPole(true)) { toast('ランチャーは下レグ(真風角100°以上)でのみ上げられます', 'warn', 2500); return; }
  if (!on) player.setPole(false);
  toast(on ? 'ランチャーアップ' : 'ランチャーダウン', 'info', 1600);
}
function tryManeuver(kind) {
  if (!player || ((player.finished || player.dsq) && state.pAI)) return;
  if (!player.startManeuver(kind) && player.pole && !player.maneuver) toast('ランチャーを下ろしてからタックしてください', 'warn', 2500);
}
// 舵: 矢印を短く押すと針路が1°ずつ変わる。押し続けると徐々に速く回頭(タック/ジャイブも舵で風をまたぐ)
let hTarget = null, hErrT = 0;
const steerHold = { L: 0, R: 0 };
function playerControl(dt) {
  const b = player, DEG = Math.PI / 180;
  const L = keys.has('ArrowLeft') || keys.has('KeyA'), R = keys.has('ArrowRight') || keys.has('KeyD');
  if (hTarget === null || b.maneuver) hTarget = b.h;
  else if (b.aeroClimb && !L && !R) hTarget = wrap(hTarget + b.aeroClimb); // リーバウ・別タック後方通過リフト時の自然な風上のぼせを目標針路にも反映
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

// スタート画面(メニュー)表示中または練習モード中の航行ステップ
function practiceStep(dt, time) {
  if (!player) return;
  playerControl(dt);
  if (player.maneuverStarted) player.maneuverStarted = null;
  if (player.tack !== state.lastTack) { if (state.lastTack !== undefined) sailFlog(0.85); state.lastTack = player.tack; }
  if (player.pole !== state.lastPole) { if (state.lastPole !== undefined) poleClank(player.pole); state.lastPole = player.pole; }
  computeBlanket(boats);
  player.update(dt, time, boats);
  if (state.phase === 'practice') {
    for (const e of updateProgress(player, 10)) {
      if (e.type === 'rounded') toast(`${e.leg.name}マーク回航`, 'good', 2500);
      else if (e.type === 'gate') toast('4ゲート通過 ― 風上の1マークへ', 'good', 3000);
      else if (e.type === 'finish') { player.finished = false; player.leg = 0; toast('フィニッシュ通過 ― 1マークへ戻って練習を続けられます', 'good', 3500); }
    }
  }
}

function simStep(dt) {
  const prev = state.t;
  state.t += dt;
  const t = state.t;
  signals(prev, t);
  for (const a of ais) a.update(dt, t, boats);
  if ((player.finished || player.dsq) && state.pAI) state.pAI.update(dt, t, boats);
  else if (window.__ap) window.__ap.update(dt, t, boats); else playerControl(dt);
  if (player.maneuverStarted) player.maneuverStarted = null;
  // タック/ジャイブ(風をまたいだ瞬間)にセールの「バサッ」、ランチャー上下で「シャキン」
  if (player.tack !== state.lastTack) { if (state.lastTack !== undefined && !state.ff && !player.finished && !player.dsq) sailFlog(0.85); state.lastTack = player.tack; }
  if (player.pole !== state.lastPole) { if (state.lastPole !== undefined && !state.ff && !player.finished && !player.dsq) poleClank(player.pole); state.lastPole = player.pole; }
  computeBlanket(boats);
  for (const b of boats) b.update(dt, t, boats);
  for (const e of resolveCollisions(boats, t)) { if (recorder) recorder.event(e, t); handleCollision(e); }
  for (const b of boats) {
    if (b.penaltyUpgraded !== null) {
      const r = b.penaltyUpgraded;
      b.penaltyUpgraded = null;
      if (b.isPlayer && !state.ff) {
        if (!state.ff) horn(0.4, 380);
        toast(`ペナルティ格上げ! (ルール${r})\n20秒以内に360°ターンが完了しなかったため 720°(2回転)ターン へ格上げされました!`, 'bad', 7000);
      }
    }
    if (b.penaltyExpired !== null) {
      const r = b.penaltyExpired;
      b.penaltyExpired = null;
      if (b.isPlayer) {
        if (!state.ff) horn(0.6, 320);
        toast(`プロテスト成立 → DSQ (失格)!\n${b.dsqReason} のため失格となりました`, 'bad', 9000);
        if (state.pFinish === null) { state.pFinish = state.t; state.pAI = new AI(b, rng); }
      } else if (!state.ff) {
        miniLog(`${nameOf(b)} ペナルティ未履行によりDSQ`);
      }
    }
    if (!b.dsq) handleProgress(b, updateProgress(b, t));
    if (b.ocs && t >= 0 && b.a < lineA(b.c) - 2) { b.ocs = false; if (b.isPlayer) toast('OCS解消 再スタート!', 'good', 3000); }
    if (b.penaltyDone) { b.penaltyDone = false; if (b.isPlayer && !state.ff) toast('ペナルティ消化', 'good', 3000); }
  }
  if (recorder) recorder.step(dt, t, boats, progressOf, lineA);
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
  if (recorder) {
    recorder.finalize(boats, state.t);
    const rec = recorder;
    let rb = $('reviewBtn');
    if (!rb) {
      rb = document.createElement('button');
      rb.id = 'reviewBtn'; rb.type = 'button'; rb.className = 'btnSec'; rb.textContent = '振り返り';
      const again = $('againBtn');
      if (again && again.parentNode) again.parentNode.insertBefore(rb, again); else $('result').appendChild(rb);
    }
    rb.onclick = () => openReview(rec, { nameOf, playerId: player.id, marks: MARKS, courseMode: COURSE_MODE, legs: LEGS, lineA, speedScale: SPEED_SCALE, kt: KT });
  }
}

// ---------- メインループ ----------
const clock = new THREE.Clock();
let hudAcc = 0;
function togglePause(p) {
  if (state.phase === 'menu') { startPractice(); return; }
  if (state.phase !== 'race' && state.phase !== 'practice') return;
  state.paused = p !== undefined ? p : !state.paused;
  const modal = $('pauseModal');
  if (state.paused) {
    modal.classList.remove('hidden');
    toast('一時中断中', 'info', 2000);
  } else {
    modal.classList.add('hidden');
    toast('再開', 'info', 1500);
  }
}

function loop() {
  requestAnimationFrame(loop);
  const raw = Math.min(0.1, clock.getDelta());
  const dt = Math.min(0.05, raw);
  const time = performance.now() / 1000;
  SEA.clock = state.phase === 'race' ? state.t : time; // 艇モデル・マーク・航跡の上下動を物理と同じ海面時刻で同期
  
  if (state.phase === 'race' && !state.paused) {
    let rem = dt;
    while (rem > 1e-6) { const s = Math.min(rem, 1 / 60); simStep(s); rem -= s; }
  } else if ((state.phase === 'menu' || state.phase === 'practice') && !state.paused) {
    let rem = dt;
    while (rem > 1e-6) { const s = Math.min(rem, 1 / 60); practiceStep(s, time); rem -= s; }
  }
  
  for (const m of models) m.sync(dt, time);
  if (models[0]) models[0].setFirstPerson(cam.mode === COCKPIT);
  world.wake.update(boats, state.paused ? 0 : dt);
  
  if (player) {
    cam.update(dt, time, player, boats);
    world.update(time, camera, dt, state.phase === 'race' ? state.t : time, player);
    setWind(clamp(Math.abs(player.v) / 6, 0, 1));
    const active = (state.phase === 'race' || state.phase === 'menu' || state.phase === 'practice') && !state.paused;
    if (active) updateSailingAudio(dt, player, active);
    setCameraAudio(cam.mode === COCKPIT);
    updateNearbyBoatSound(player, boats, active);
  }
  
  if (player) {
    const showPreStart = (state.phase === 'race' && state.t < 0) || state.phase === 'menu';
    const curLeg = LEGS[Math.min(player.leg, LEGS.length - 1)];
    const isFinLeg = curLeg && curLeg.type === 'finish';
    world.setLine(state.phase === 'race' && state.t >= 0 ? 'finish' : 'start', player.finished ? 0 : isFinLeg ? 1 : state.phase === 'race' && state.t >= 0 ? 0.15 : 0, showPreStart);
    if (world.setTargetMark) world.setTargetMark(player.leg, state.phase === 'race' ? state.t : 1, player.finished);
    updateMarkPointer(player);
    updateNearBoatsHUD(player);
  }
  
  if (player) {
    hudAcc += raw;
    if (hudAcc >= 1 / 12) {
      hudAcc = 0;
      const sorted = computeRanks();
      updateHUD(sorted);
      drawMinimap();
    }
    if (state.phase === 'race' && !state.resultShown) {
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
  if (state.phase !== 'race' && state.phase !== 'menu' && state.phase !== 'practice') return;
  
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

  if ((state.phase === 'race' || state.phase === 'practice') && (e.code === 'KeyP' || e.code === 'Escape')) togglePause();
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
  tap('exitMenuBtn', () => { togglePause(false); $('result').classList.add('hidden'); $('hud').classList.remove('hidden'); $('menu').classList.remove('hidden'); state.phase = 'menu'; document.body.classList.add('menuOpen'); cam.menuOffset = true; makeFleet(); });

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
  
  const tapTouch = (id, fn) => $(id).addEventListener('pointerdown', (e) => { e.preventDefault(); if (state.phase === 'race' || state.phase === 'menu' || state.phase === 'practice') fn(); });
  tapTouch('tPole', () => setPlayerPole(!player.pole));
  tapTouch('tCam', () => setCamera(cam.mode + 1)); tapTouch('tAuto', () => setAuto(!autoTrim));
  $('tAuto').classList.add('on');
  document.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- 気象モード・Open-Meteo連携・海面有利傾向 ----------
const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compassDir(deg) {
  const d = ((deg % 360) + 360) % 360;
  return COMPASS_16[Math.round(d / 22.5) % 16];
}
// 実際のレース海面(江の島・八景島)の風向別有利サイド傾向 (-1=左海面伸び, +1=右海面伸び)
function computeSideBias(venueId, windDeg) {
  const d = ((windDeg % 360) + 360) % 360;
  if (venueId === 'hakkeijima') {
    // 八景島: 北〜北東風(340°〜65°)は住友・八景島水道側(左海面)にブローとリフトが入りやすく、南〜南東の東京湾シーブリーズは沖(右海面)が伸びる傾向
    if (d >= 330 || d <= 75) return { bias: -0.70, desc: '左海面(八景島・住友岸寄り)リフト・ブロー優勢傾向' };
    if (d >= 130 && d <= 230) return { bias: 0.65, desc: '右海面(東京湾沖出し)風速・伸び優勢傾向' };
    return { bias: -0.45, desc: 'やや左海面ブロー優勢傾向' };
  }
  // 江の島: 南南西〜南西シーブリーズ(195°〜245°)は沖・西側(左海面)が江の島ブランケットを避けて伸び、北〜北東の陸風や南東風は岸・鎌倉側(右海面)がリフトする傾向
  if (d >= 195 && d <= 250) return { bias: -0.65, desc: '左海面(沖・西側)ブロー安定傾向' };
  if (d >= 330 || d <= 75) return { bias: 0.75, desc: '右海面(片瀬・鎌倉岸側)陸風リフト優勢傾向' };
  if (d >= 120 && d < 195) return { bias: 0.60, desc: '右海面(鎌倉・逗子側)リフト傾向' };
  return { bias: -0.50, desc: 'やや左海面ブロー優勢傾向' };
}

// 海面・風向・風速から波の種類(三角波/うねり/短周期の風浪)を決めて物理と海面描画へ反映
function applySea(windDeg, kt) {
  setSeaState(cfg.venue, windDeg, kt);
  if (world.setSea) world.setSea(SEA);
}

async function fetchRealWeather(venueId) {
  if (weatherCache[venueId]) return weatherCache[venueId];
  const v = VENUES.find((x) => x.id === venueId) || VENUES[0];
  const infoEl = $('realWeatherInfo');
  if (infoEl) {
    infoEl.classList.remove('hidden');
    infoEl.textContent = `${v.label} 実況気象を取得中 — Open-Meteo / 気象庁MSM`;
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${v.lat}&longitude=${v.lon}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cur = data.current || {};
    const rawKt = typeof cur.wind_speed_10m === 'number' ? cur.wind_speed_10m : v.defaultWindKt;
    const gustKt = typeof cur.wind_gusts_10m === 'number' ? cur.wind_gusts_10m : rawKt * 1.25;
    const windDeg = typeof cur.wind_direction_10m === 'number' ? Math.round(cur.wind_direction_10m) : v.defaultWindDeg;
    // 微風すぎてレースにならない場合のみ最低5ktを保証しつつ実測風速を反映
    const effKt = clamp(Math.round(rawKt * 10) / 10, 5, 22);
    weatherCache[venueId] = { rawKt: Math.round(rawKt * 10) / 10, gustKt: Math.round(gustKt * 10) / 10, effKt, windDeg };
  } catch (e) {
    weatherCache[venueId] = { rawKt: v.defaultWindKt, gustKt: v.defaultWindKt + 3, effKt: v.defaultWindKt, windDeg: v.defaultWindDeg, fallback: true };
  }
  return weatherCache[venueId];
}

// ---------- メニューUI ----------
let currentWindDeg = 15;
let currentSideBiasDesc = '';

function updateWeatherInfoUI(windDeg, kt, gustKt, desc, fallback) {
  currentWindDeg = windDeg;
  currentSideBiasDesc = desc;
  const infoEl = $('realWeatherInfo');
  if (!infoEl) return;
  infoEl.classList.remove('hidden');
  const dirStr = `${compassDir(windDeg)} (${windDeg}°)`;
  const note = fallback ? '(標準風速・ブロー移動あり)' : `(ガスト ${gustKt}kt・ブロー移動あり)`;
  infoEl.textContent = `現地実況  風向 ${dirStr}  風速 ${kt}kt ${note}  ｜  ${desc}${SEA.label ? `  ｜  波: ${SEA.label}` : ''}`;
}

function applyVenue() {
  const v = VENUES.find((x) => x.id === cfg.venue) || VENUES[0];
  const eb = $('menuEyebrow');
  if (eb) eb.textContent = v.eyebrow;

  setCourseMode(cfg.courseMode);

  const cached = weatherCache[cfg.venue];
  if (cached) {
    const { bias, desc } = computeSideBias(cfg.venue, cached.windDeg);
    setWindParams(cached.effKt, bias);
    world.setVenue(cfg.venue, cached.windDeg, bias); applySea(cached.windDeg, cached.effKt);
    rebuildObstacles();
    updateWeatherInfoUI(cached.windDeg, cached.rawKt, cached.gustKt, desc, cached.fallback);
  } else {
    // 初回取得: まずデフォルトで初期化し、非同期で1回だけ取得して反映
    const { bias, desc } = computeSideBias(cfg.venue, v.defaultWindDeg);
    setWindParams(v.defaultWindKt, bias);
    world.setVenue(cfg.venue, v.defaultWindDeg, bias); applySea(v.defaultWindDeg, v.defaultWindKt);
    rebuildObstacles();
    updateWeatherInfoUI(v.defaultWindDeg, v.defaultWindKt, v.defaultWindKt + 3, desc, false);
    fetchRealWeather(cfg.venue).then((w) => {
      if (state.phase !== 'menu') return;
      const bInfo = computeSideBias(cfg.venue, w.windDeg);
      setWindParams(w.effKt, bInfo.bias);
      world.setVenue(cfg.venue, w.windDeg, bInfo.bias); applySea(w.windDeg, w.effKt);
      rebuildObstacles();
      makeFleet();
      cam.inited = false;
      if (player) cam.update(0, performance.now() / 1000, player, boats);
      updateWeatherInfoUI(w.windDeg, w.rawKt, w.gustKt, bInfo.desc, w.fallback);
    });
  }
}
function buildVenueChoices() {
  const box = $('venueChoices'); if (!box) return;
  box.innerHTML = '';
  for (const v of VENUES) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'choice' + (cfg.venue === v.id ? ' sel' : ''); btn.id = `venue-${v.id}`;
    btn.innerHTML = `<span class="ic">${v.icon}</span><span class="lb">${v.label}</span>`;
    btn.onclick = () => {
      cfg.venue = v.id; saveCfg(); applyVenue(); makeFleet();
      cam.inited = false; cam.yaw = 0; cam.pitch = 0;
      if (player) cam.update(0, performance.now() / 1000, player, boats);
      buildVenueChoices();
    };
    box.appendChild(btn);
  }
}
function buildCourseChoices() {
  const box = $('courseChoices'); if (!box) return;
  box.innerHTML = '';
  for (const m of COURSE_MODES) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'choice' + (cfg.courseMode === m.id ? ' sel' : ''); btn.id = `courseMode-${m.id}`;
    btn.innerHTML = `<span class="ic">${m.icon}</span><span class="lb">${m.label}</span>`;
    btn.onclick = () => {
      cfg.courseMode = m.id; saveCfg(); applyVenue(); makeFleet();
      cam.inited = false; cam.yaw = 0; cam.pitch = 0;
      if (player) cam.update(0, performance.now() / 1000, player, boats);
      buildCourseChoices();
    };
    box.appendChild(btn);
  }
}
function buildPenaltyChoices() {
  const box = $('penaltyChoices'); if (!box) return;
  box.innerHTML = '';
  for (const m of PENALTY_MODES) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'choice' + (cfg.penaltyMode === m.id ? ' sel' : ''); btn.id = `penaltyMode-${m.id}`;
    btn.innerHTML = `<span class="ic">${m.icon}</span><span class="lb">${m.label}</span>`;
    btn.onclick = () => { cfg.penaltyMode = m.id; saveCfg(); buildPenaltyChoices(); };
    box.appendChild(btn);
  }
}
function buildChoices(containerId, key) {
  const box = $(containerId); if (!box) return;
  box.innerHTML = '';
  for (const c of crewOptions) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'choice' + (cfg[key] === c.id ? ' sel' : ''); btn.id = `${containerId}-${c.id.replace(/[^a-z0-9]/gi, '_')}`;
    btn.innerHTML = `<span class="ic">${c.icon}</span><span class="lb">${c.label}</span>`;
    btn.onclick = () => { cfg[key] = c.id; saveCfg(); buildChoices(containerId, key); updatePreview(); rebuildPlayerModel(); };
    box.appendChild(btn);
  }
}
let pv = null;
function initPreview() {
  const cv = $('preview');
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
  r.setSize(220, 156, false); r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x446677, 2.2)); const dl = new THREE.DirectionalLight(0xffffff, 2); dl.position.set(2, 4, 3); sc.add(dl);
  const cm = new THREE.PerspectiveCamera(35, 220 / 156, 0.1, 50); cm.position.set(0, 0.85, 3.05); cm.lookAt(0, 0.45, 0);
  pv = { r, sc, cm, g: new THREE.Group() }; sc.add(pv.g);
  updatePreview();
}
function updatePreview() {
  if (!pv) return;
  pv.g.clear();
  const st = { skin: hexNum(cfg.skin), shirt: hexNum(cfg.shirt), hat: hexNum(cfg.hat), jacket: 0xff7a1a };
  // buildFigureは顔が -z 向きなので、Math.PI 回転してカメラ(+z)側・正面を向かせる
  const a = buildFigure(cfg.helm, st); a.position.set(-0.5, a.userData.upper ? 0.16 : 0, 0); a.rotation.y = Math.PI + 0.22; pv.g.add(a);
  const b = buildFigure(cfg.crew, st); b.position.set(0.5, b.userData.upper ? 0.16 : 0, 0); b.rotation.y = Math.PI - 0.22; pv.g.add(b);
  pv.g.rotation.y = 0;
  pv.r.render(pv.sc, pv.cm);
}
function initMenu() {
  applyVenue();
  buildVenueChoices();
  buildCourseChoices();
  buildPenaltyChoices();
  buildChoices('helmChoices', 'helm'); buildChoices('crewChoices', 'crew');
  const sn = $('sailNo');
  if (sn) {
    sn.value = cfg.sailNo;
    sn.oninput = () => { cfg.sailNo = sn.value.replace(/\D/g, '').slice(0, 5) || '31804'; saveCfg(); rebuildPlayerModel(); };
  }
  $('startBtn').onclick = startRace;
  if ($('practiceBtn')) $('practiceBtn').onclick = startPractice;
  $('againBtn').onclick = () => { $('result').classList.add('hidden'); $('hud').classList.remove('hidden'); $('menu').classList.remove('hidden'); state.phase = 'menu'; document.body.classList.add('menuOpen'); cam.menuOffset = true; makeFleet(); };
  initPreview();
}

(async function boot() {
  if (window.__setLoad) window.__setLoad(95);
  const extra = await loadCustomCrew();
  crewOptions = [...CREW_TYPES, ...extra];
  if (!crewOptions.find((c) => c.id === cfg.helm)) cfg.helm = 'human_m';
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

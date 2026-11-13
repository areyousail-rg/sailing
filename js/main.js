// ゲーム本体: 初期化・状態管理・HUD
import * as THREE from 'three';
import { createWorld, MOBILE, SUN_DIR } from './world.js';
import { Boat, resolveCollisions, computeBlanket, sheetOpt, KT, SPEED_SCALE, BOAT_LEN, OBSTACLES, BASE_WIND_KT, SIDE_BIAS, setWindParams, wrap, clamp, rebuildObstacles, SEA, setSeaState, TIDE, setTideState, randomizeWindShifts, SHIFT_LOG, shiftAt, windAt } from './sim.js';
import { Recorder, openReview, serializeReviewSnapshot, deserializeReviewSnapshot, buildFallbackReviewFromRecord } from './review.js';
import { AI } from './ai.js';
import { BoatModel } from './boatmodel.js';
import { CREW_TYPES, buildFigure, loadCustomCrew, animatePreviewFigure } from './crew.js';
import { DroneCam, CAM_MODES, COCKPIT } from './camera.js';
import { LEGS, W0, LINE_HALF, LINE_SKEW, FAVORED, lineA, MARKS, COURSE_MODE, setCourseMode, randomizeStartLine, setFixedStartLine, updateProgress, progressOf, toCourse, toWorld } from './course.js';
import { initAudio, isAudioRunning, isBgmPlaying, unlockAudioNow, horn, beep, setWind, toggleMute, thud, markHit, updateNearbyBoatSound, signalHorn, updateSailingAudio, setCameraAudio, sailFlog, poleClank, orientStepSfx, prewarmBgm, playBgm, stopBgm, setBgmVoiceEnabled, playRightOfWayHail, playCrewSelectSound, playRateTickSound, playChallengerSplashSound } from './audio.js';

const $ = (id) => document.getElementById(id);
const RACE_LIMIT = 600;
const FINISH_WINDOW = 150; // トップフィニッシュからこの秒数以内にフィニッシュした艇はタイムを記録(超過はDNF)
const N_BOATS = 20; // 自艇1 + CP艇19 (20艇フリート)
const START_T = -60;
const IS_TOUCH = MOBILE || (window.matchMedia && matchMedia('(pointer: coarse)').matches) || new URLSearchParams(location.search).has('touch');
const NATS = ['JPN', 'ITA', 'BRA', 'USA', 'ESP', 'POR', 'ARG', 'FRA', 'GER', 'GBR', 'AUS', 'NZL', 'CAN', 'KOR', 'CHN'];

// ---------- 乱数 ----------
let rs = Date.now() % 2147483647 || 7;
const rng = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };

// ---------- 設定(保存) ----------
const VENUES = [
  { id: 'hakkeijima', label: '八景島', icon: '', eyebrow: '八景島沖レース海面', lat: 35.337, lon: 139.658, defaultWindDeg: 15, defaultWindKt: 9 },
  { id: 'enoshima', label: '江の島', icon: '', eyebrow: '江の島沖レース海面', lat: 35.292, lon: 139.488, defaultWindDeg: 200, defaultWindKt: 9 },
];
const COURSE_MODES = [
  { id: 'trapezoid', label: 'トラペゾイド(IL2)', icon: '' },
  { id: 'upwind', label: '上マークフィニッシュ', icon: '' },
];
const RATE_MODES = [
  { id: 'on', label: 'ON (CPレベル変動有)', icon: '' },
  { id: 'off', label: 'OFF (CPレベル変動無)', icon: '' },
];
const PENALTY_MODES = [
  { id: 'off', label: '無', icon: '' },
  { id: 'on', label: '有', icon: '' },
];
const BGM_MODES = [
  { id: 'on', label: 'ON', icon: '' },
  { id: 'off', label: 'OFF', icon: '' },
];

// ---------- レート＆キャラクター解放管理 (ブラウザ内 localStorage 保存) ----------
const RATE_KEY = 'snipe-rate-v1';
const DEFAULT_RATE = 1500;
function loadRateData() {
  try {
    const raw = JSON.parse(localStorage.getItem(RATE_KEY) || '{}');
    const rate = typeof raw.rate === 'number' && isFinite(raw.rate) ? Math.max(0, Math.round(raw.rate)) : DEFAULT_RATE;
    const peakRate = typeof raw.peakRate === 'number' && isFinite(raw.peakRate) ? Math.max(rate, Math.round(raw.peakRate)) : Math.max(DEFAULT_RATE, rate);
    const unlocked = Array.isArray(raw.unlocked) ? raw.unlocked.filter((x) => typeof x === 'string') : [];
    for (const c of CREW_TYPES) {
      if (c.unlockRate && peakRate >= c.unlockRate && !unlocked.includes(c.id)) unlocked.push(c.id);
    }
    return { rate, peakRate, unlocked };
  } catch (e) {
    return { rate: DEFAULT_RATE, peakRate: DEFAULT_RATE, unlocked: [] };
  }
}
let rateData = loadRateData();
function saveRateData() {
  try { localStorage.setItem(RATE_KEY, JSON.stringify(rateData)); } catch (e) {}
}
// ブラウザの自動ストレージ削除(Storage Eviction / ITP等)から戦績・レートデータを保護するため永続化ストレージを要求
try {
  if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
  }
} catch (e) {}
function isCrewUnlocked(id) {
  const spec = CREW_TYPES.find((c) => c.id === id);
  if (!spec || !spec.unlockRate) return true;
  return rateData.unlocked.includes(id) || rateData.peakRate >= spec.unlockRate || rateData.rate >= spec.unlockRate;
}
function updateMenuRateUI() {
  const badge = $('menuRateBadge');
  const valEl = $('menuRateVal');
  if (valEl) valEl.textContent = String(rateData.rate);
  if (badge) badge.classList.toggle('hidden', cfg.rateMode === 'off');
}

const PLAYER_BIB = 0x0e52b8; // 自艇クルー・スキッパーの青ビブス
const CP_BIBS = [0x181c24, 0xf1f5f9, 0xc8242b]; // CP艇のビブス色（黒・白・赤）
const weatherCache = {}; // Open-Meteo 取得結果キャッシュ(スタート前のメニュー時のみ1回取得しレース中の負荷ゼロ)
const defaults = { venue: 'hakkeijima', courseMode: 'trapezoid', rateMode: 'on', penaltyMode: 'off', bgmMode: 'on', helm: 'human_m', crew: 'cat', skin: '#d68e66', shirt: '#1a1d22', hat: '#ffffff', sailNo: '31804' };
let cfg = { ...defaults };
try { cfg = { ...defaults, ...JSON.parse(localStorage.getItem('snipe-cfg') || '{}') }; } catch (e) {}
if (cfg.sailNo === '31415' || cfg.sailNo === '30804') cfg.sailNo = '31804';
if (cfg.skin === '#f1c7a0') cfg.skin = '#d68e66';
// デフォルト選択は常にレース海面＝八景島(hakkeijima)、レート＝ON、ペナルティ＝OFF、ヘルムスマン＝男性(human_m)、クルー＝ネコ(cat)で初期化
cfg.venue = 'hakkeijima';
cfg.rateMode = 'on';
cfg.penaltyMode = 'off';
cfg.helm = 'human_m';
cfg.crew = 'cat';
if (!COURSE_MODES.find((m) => m.id === cfg.courseMode)) cfg.courseMode = 'trapezoid';
if (!RATE_MODES.find((m) => m.id === cfg.rateMode)) cfg.rateMode = 'on';
if (!PENALTY_MODES.find((m) => m.id === cfg.penaltyMode)) cfg.penaltyMode = 'off';
if (!BGM_MODES.find((m) => m.id === cfg.bgmMode)) cfg.bgmMode = 'on';
setBgmVoiceEnabled(cfg.bgmMode !== 'off');
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
const state = { phase: 'menu', t: START_T, paused: false, sig: 0, pFinish: null, firstFinish: null, resultShown: false, count: -1, ff: false, pAI: null, raceStartRate: DEFAULT_RATE, raceRateInfo: null };
let autoTrim = true, lastFlap = 0, recorder = null;
let boats = [], ais = [], models = [], player = null, crewOptions = [...CREW_TYPES];
const keys = new Set();

function humanStyle(random) {
  if (!random) return { skin: hexNum(cfg.skin), shirt: hexNum(cfg.shirt), hat: hexNum(cfg.hat) };
  const skins = [0xd68e66, 0xcf855c, 0xc68642, 0x8d5524, 0xdba07b];
  const c = new THREE.Color().setHSL(rng(), 0.7, 0.5), h = new THREE.Color().setHSL(rng(), 0.5, 0.75);
  return { skin: skins[(rng() * skins.length) | 0], shirt: c.getHex(), hat: h.getHex() };
}
function makeCpPairForType(primaryType, effRate) {
  const jacket = CP_BIBS[(rng() * CP_BIBS.length) | 0];
  const isHuman = primaryType === 'human_m' || primaryType === 'human_f';
  if (isHuman) {
    const h1 = rng() < 0.55 ? 'human_m' : 'human_f';
    const h2 = rng() < 0.55 ? 'human_f' : 'human_m';
    return {
      helm: { type: h1, style: { ...humanStyle(true), jacket } },
      crew: { type: h2, style: { ...humanStyle(true), jacket } },
    };
  }
  // 動物艇: 動物がスキッパーまたは両乗り(または人間＋動物ペア)で登場
  const secondPool = ['human_m', 'human_f', primaryType];
  if (effRate >= 1500) secondPool.push('cat', 'dog', 'shiba');
  const secType = rng() < 0.58 ? primaryType : secondPool[(rng() * secondPool.length) | 0];
  return {
    helm: { type: primaryType, style: { ...humanStyle(true), jacket } },
    crew: { type: secType, style: { ...humanStyle(true), jacket } },
  };
}

// レート(1700＝現在のCP平均レベル1.00想定)からCPの艇速・操船スキル倍率への換算
function rateToSkill(r) {
  return clamp(1.00 + ((r - 1700) / 100) * 0.042, 0.78, 1.16);
}

// レートに応じた15艇のCPプロフィール生成:
// ・犬・猫・柴犬はずっと登場し、各種動物キャラの参戦基準は-50 (アヒル:1550解放/CP1450〜、タヌキ:1650解放/CP1550〜、ウサギ:1750解放/CP1650〜、イルカ:1850解放/CP1750〜)
// ・動物ごとにそのレートの強さ(レベル)を持ち、人間はずっと登場して弱い船から強い船まで様々なレベルが存在
// ・1500前後では弱いCP3艇と中くらいのレベル1艇がマストトップに黒球(hasBlackBall)を装着
function buildCpFleetProfiles(effRate) {
  const nCp = N_BOATS - 1; // 15艇
  const animalEntries = [
    // 犬・猫はずっといる (初級〜中級レベル)
    { type: 'cat', rate: clamp(effRate - 65 + (rng() - 0.5) * 45, 1380, 1620) },
    { type: 'dog', rate: clamp(effRate - 40 + (rng() - 0.5) * 45, 1410, 1650) },
    { type: 'shiba', rate: clamp(effRate - 15 + (rng() - 0.5) * 45, 1440, 1680) },
  ];
  if (effRate >= 1450) {
    animalEntries.push({ type: 'duck', rate: 1475 + (rng() - 0.5) * 40 });
    if (effRate < 1600 && rng() < 0.65) animalEntries.push({ type: 'duck', rate: 1505 + (rng() - 0.5) * 36 });
  }
  if (effRate >= 1550) {
    animalEntries.push({ type: 'tanuki', rate: 1580 + (rng() - 0.5) * 40 });
    if (effRate < 1700 && rng() < 0.65) animalEntries.push({ type: 'tanuki', rate: 1610 + (rng() - 0.5) * 36 });
  }
  if (effRate >= 1650) {
    animalEntries.push({ type: 'rabbit', rate: 1680 + (rng() - 0.5) * 40 });
    if (effRate < 1800 && rng() < 0.65) animalEntries.push({ type: 'rabbit', rate: 1715 + (rng() - 0.5) * 36 });
  }
  if (effRate >= 1750) {
    animalEntries.push({ type: 'dolphin', rate: 1790 + (rng() - 0.5) * 45 });
    if (rng() < 0.75) animalEntries.push({ type: 'dolphin', rate: 1835 + (rng() - 0.5) * 45 });
  }

  const profiles = [];
  for (const ae of animalEntries) {
    if (profiles.length >= nCp - 5) break;
    const pair = makeCpPairForType(ae.type, effRate);
    profiles.push({
      rate: ae.rate,
      skill: rateToSkill(ae.rate),
      helm: pair.helm,
      crew: pair.crew,
      hasBlackBall: false,
    });
  }

  // 残りの枠は人間クルー艇で、effRateを中心に弱いレベル〜強いレベルまで幅広く配置
  const rem = nCp - profiles.length;
  for (let i = 0; i < rem; i++) {
    const u = rem > 1 ? i / (rem - 1) : 0.5; // 0(上位) .. 1(下位)
    const spread = (0.5 - u) * 2.0; // +1.0 .. -1.0
    const humanRate = effRate + spread * 185 + (rng() - 0.5) * 32;
    const pair = makeCpPairForType(rng() < 0.5 ? 'human_m' : 'human_f', effRate);
    profiles.push({
      rate: humanRate,
      skill: rateToSkill(humanRate),
      helm: pair.helm,
      crew: pair.crew,
      hasBlackBall: false,
    });
  }

  // CP全体の平均レベル(meanSkill)は一切変えず、1マークでの密集を防ぐため平均周りのばらつきのみをわずかに拡大(1.24倍)
  if (profiles.length > 1) {
    const meanSkill = profiles.reduce((acc, p) => acc + p.skill, 0) / profiles.length;
    for (const p of profiles) {
      p.skill = clamp(meanSkill + (p.skill - meanSkill) * 1.24, 0.74, 1.20);
    }
  }

  // スキル順(降順: index 0 が最強 k=1、index nCp-1 が最弱)にソート
  profiles.sort((a, b) => b.skill - a.skill);

  // マストトップ黒球(浮力体): 1500前後では弱いCP艇と中位艇に装着
  const last = profiles.length - 1;
  const midIdx = Math.floor(profiles.length * 0.6);
  if (effRate <= 1640) {
    if (profiles[last - 2]) profiles[last - 2].hasBlackBall = true;
    if (profiles[last - 1]) profiles[last - 1].hasBlackBall = true;
    if (profiles[last]) profiles[last].hasBlackBall = true;
    if (profiles[midIdx]) profiles[midIdx].hasBlackBall = true;
  } else if (effRate <= 1780) {
    if (profiles[last - 1]) profiles[last - 1].hasBlackBall = true;
    if (profiles[last]) profiles[last].hasBlackBall = true;
    if (profiles[midIdx]) profiles[midIdx].hasBlackBall = true;
  } else {
    if (profiles[last - 1]) profiles[last - 1].hasBlackBall = true;
    if (profiles[last]) profiles[last].hasBlackBall = true;
  }
  return profiles;
}

function clearFleet() {
  for (const m of models) {
    if (m.dispose) m.dispose();
    scene.remove(m.root);
  }
  boats = []; ais = []; models = []; world.wake.reset();
}
function makeFleet(onlyPlayer = state.phase === 'menu') {
  clearFleet();
  hTarget = null; hErrT = 0; steerHold.L = 0; steerHold.R = 0;
  resetCloseHoldLock();
  globalHailCD = 0;
  pairHailUntil.clear();
  if (world.setCourseVisible) world.setCourseVisible(state.phase !== 'menu');
  // スタートライン半幅 LINE_HALF = 75 (従来の1.5倍 = 全幅150m) に合わせ、24艇がライン全域にバランスよく散らばるよう配置
  const endTargets = FAVORED === 'pin'
    ? [-69.0, -63.5, -57.5, 69.5, 64.0, 57.5, 51.0, 44.0]
    : FAVORED === 'com'
      ? [70.0, 65.5, 60.5, 55.5, 49.5, 43.5, -67.5, -60.5]
      : [69.5, 64.0, 58.0, 51.5, 45.0, -68.0, -61.5, -54.5];
  for (let i = endTargets.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [endTargets[i], endTargets[j]] = [endTargets[j], endTargets[i]];
  }
  const midTargets = [];
  const nMid = N_BOATS - 1 - endTargets.length;
  for (let i = 0; i < nMid; i++) {
    const t = i / Math.max(1, nMid - 1);
    const u = FAVORED === 'com'
      ? Math.pow(t, 0.68)
      : FAVORED === 'pin'
        ? 1 - Math.pow(1 - t, 0.72)
        : Math.pow(t, 0.85);
    const minC = FAVORED === 'com' ? -42 : -49;
    const maxC = FAVORED === 'pin' ? 37 : 40;
    midTargets.push(minC + u * (maxC - minC) + (rng() - 0.5) * 3.0);
  }
  for (let i = midTargets.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [midTargets[i], midTargets[j]] = [midTargets[j], midTargets[i]];
  }
  const allTargets = [...endTargets, ...midTargets];
  const slots = allTargets.map((targetC, i) => {
    const kIdx = i + 1;
    // 20艇フリート(CP19艇)用スタート隊形: 第二線スタート(secondRow: 2艇)、本部船上待機(highComFail: 1艇)、ギャップ狙い(gapShooter: 3艇)、残り13艇は第一線(firstRow)
    const startRole =
      (kIdx === 19) ? 'highComFail' :
      (kIdx === 15 || kIdx === 18) ? 'secondRow' :
      (kIdx === 5 || kIdx === 10 || kIdx === 14) ? 'gapShooter' :
      'firstRow';
    if (startRole === 'highComFail') {
      const a0 = -22 - (i % 2) * 2.5;
      const c0 = LINE_HALF + 20 + (i % 2) * 5.0;
      return { a: a0, c: c0, targetC: LINE_HALF - 5.5, startRole };
    }
    const isUpperEnd = targetC >= 30;
    const baseA0 = isUpperEnd ? -30 - (i % 2) * 2.2 : -33 - (i % 3) * 2.4;
    const a0 = startRole === 'secondRow'
      ? baseA0 - 8.5
      : startRole === 'gapShooter'
        ? baseA0 - 9.5
        : baseA0;
    // 1分間のスターボードタック前進と低速下流れによる左(-c)への移動量を見越し、
    // 0秒時点で狙ったtargetC付近のスタートライン直下へ到達できるよう右(+c)余裕を持たせて配置する
    const driftMargin = isUpperEnd ? 21 : 15;
    const c0 = targetC + Math.abs(a0) * 0.88 + driftMargin;
    return { a: a0, c: c0, targetC, startRole };
  });
  // 自艇は1分前の状況を見て上(本部船側)・下(アウター側)どちらからでもスタートできるよう、CP艇団のさらに後ろ(a=-64)かつ中央やや上寄り(c=28)に配置
  const pslot = { a: -64, c: 28, targetC: 0, startRole: 'firstRow' };
  const used = new Set([cfg.sailNo]);
  const count = onlyPlayer ? 1 : N_BOATS;
  const effRate = cfg.rateMode !== 'off' ? (state.raceStartRate || rateData.rate || DEFAULT_RATE) : DEFAULT_RATE;
  const cpProfiles = onlyPlayer ? [] : buildCpFleetProfiles(effRate);

  for (let k = 0; k < count; k++) {
    const isP = k === 0;
    let no; do { no = String(1000 + ((rng() * 30999) | 0)); } while (used.has(no)); used.add(no);
    const color = new THREE.Color().setHSL((k * 0.618) % 1, 0.65, 0.5).getHex();
    const s = isP ? pslot : slots[k - 1];
    const prof = isP ? null : cpProfiles[k - 1];
    const cpSkill = prof ? prof.skill : 1.0;
    const hasBlackBall = prof ? !!prof.hasBlackBall : false;
    const b = new Boat({ id: k, isPlayer: isP, sailNo: isP ? cfg.sailNo : no, nat: isP ? 'JPN' : NATS[(rng() * NATS.length) | 0], color: isP ? 0xff5a1f : color, skill: isP ? 1 : cpSkill, startTargetC: s.targetC, startRole: s.startRole, hasBlackBall });
    const p = toWorld(s.a + lineA(s.targetC), s.c);
    if (isP && onlyPlayer && state.phase === 'menu') {
      // スタート画面(メニュー待機中)で向いているデフォルトの方角は太陽の方面にする(画がきれいなため)
      const sunHeading = Math.atan2(SUN_DIR.x, -SUN_DIR.z);
      b.place(p.x, p.z, sunHeading);
      b.v = 2.4 * SPEED_SCALE;
      b.sheet = sheetOpt(Math.max(0.75, b.twa));
      b.luff = 0;
      hTarget = sunHeading;
    } else {
      b.place(p.x, p.z, W0 - 0.75 + (rng() - 0.5) * 0.05);
      b.v = 0.4; b.sheet = sheetOpt(b.twa);
    }
    boats.push(b);
    let helm, crew;
    if (isP) {
      const jacket = PLAYER_BIB;
      helm = { type: cfg.helm, style: { ...humanStyle(false), jacket } };
      crew = { type: cfg.crew, style: { ...humanStyle(false), jacket } };
    } else {
      helm = prof.helm;
      crew = prof.crew;
    }
    b.helmType = helm.type;
    b.crewType = crew.type;
    b.hailCD = 1.5 + rng() * 2.0;
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
  player.helmType = cfg.helm;
  player.crewType = cfg.crew;
  const jacket = PLAYER_BIB;
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
  cam: $('camLabel'), toasts: $('toasts'), ocs: $('ocsBadge'), blk: $('blkBadge'), blkTxt: $('blkTxt'), blkFill: $('blkFill'), sheetOpt: $('sheetOpt'), autoLbl: $('autoLbl'), pole: $('poleLbl'), tCam: $('tCam'), tCamReset: $('tCamReset'),
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
  const isPreStart = state.t < 0;
  const bp = $('boardPanel');
  if (bp) bp.style.display = isPreStart ? 'none' : '';
  if (isPreStart) {
    hud.leaders.innerHTML = '';
    hud.rank.textContent = '';
    return;
  }
  const rows = [];
  const top = sorted.slice(0, 8);
  if (!top.includes(player)) top.push(player);
  for (const b of top) {
    const st = b.dsq ? 'DSQ' : (b.dnf && !b.finished) || b.late ? 'DNF' : b.finished ? fmtMs(b.finishTime) : b.penalty ? 'PEN' : '';
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
    mctx.fillStyle = '#e0f2fe'; mctx.font = 'bold 10px sans-serif'; mctx.fillText('FIN', X(M.fcom.c) + 6, Y(M.fcom.a) + 3);
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
  if (!markPtr.box || !b || b.finished || b.dsq || state.phase === 'menu' || state.resultShown || state.t < 0) {
    if (markPtr.box) markPtr.box.classList.add('hidden');
    return;
  }
  const L = LEGS[Math.min(b.leg, LEGS.length - 1)];
  if (!L || L.type === 'finish') {
    markPtr.box.classList.add('hidden');
    return;
  }
  const tg = L.type === 'mark' ? L.mark : L.center;
  const tw = toWorld(tg.a, tg.c);
  const distM = Math.round(Math.hypot(tw.x - b.x, tw.z - b.z) / 1.5);
  const shortName = L.type === 'gate' ? '4G' : L.name;

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

// ---------- 周囲の接近艇インジケーター (画面外の衝突危険艇・タック時衝突危険艇・リーチング/ランニング時の後方接近艇のみ表示) ----------
const nearBoatsBox = $('nearBoats');
const nearBoatPool = [];
const nearBoatV3 = new THREE.Vector3();
function updateNearBoatsHUD(b) {
  if (!nearBoatsBox) return;
  // スタート前(state.t < 0 または未スタート)、メニュー中、オリエンテーション中、フィニッシュ後は非表示
  if (!b || b.finished || b.dsq || state.phase !== 'race' || state.t < 0 || !b.started || state.resultShown) {
    for (const el of nearBoatPool) el.style.display = 'none';
    return;
  }
  const bfx = Math.sin(b.h), bfz = -Math.cos(b.h);
  const bvx = bfx * b.v, bvz = bfz * b.v;
  const isUpwind = (b.twa || 0) < 1.35 && !b.pole;
  const isReachOrRun = (b.twa || 0) >= 1.10 || !!b.pole;
  // タックした場合の想定方位・速度ベクトル
  const hTack = wrap((b.windFrom || 0) + (b.tack || 1) * clamp(b.twa || 0.75, 0.68, 0.90));
  const tfx = Math.sin(hTack), tfz = -Math.cos(hTack);
  const vTack = Math.max(2.2, b.v * 0.82);
  const wfx = -Math.sin(b.windFrom || 0), wfz = Math.cos(b.windFrom || 0); // 風上向き単位ベクトル

  const near = [];
  for (const o of boats) {
    if (o === b || o.dsq || o.finished) continue;
    const dx = o.x - b.x, dz = o.z - b.z;
    const distM = Math.hypot(dx, dz) / 1.5; // ワールド距離(1.5x)から実距離[m]へ換算
    if (distM > 20.0) continue;

    // カメラ画面内に見えている船は表示不要
    nearBoatV3.set(o.x, 1.4, o.z).project(camera);
    const inFront = nearBoatV3.z > 0 && nearBoatV3.z < 1.0;
    const onScreen = inFront && Math.abs(nearBoatV3.x) <= 0.90 && Math.abs(nearBoatV3.y) <= 0.84;
    if (onScreen) continue;

    const rx = dx / 1.5, rz = dz / 1.5;
    const ofx = Math.sin(o.h), ofz = -Math.cos(o.h);
    const ovx = ofx * o.v, ovz = ofz * o.v;
    const rvx = ovx - bvx, rvz = ovz - bvz;
    const rv2 = rvx * rvx + rvz * rvz;
    const closingSpd = -(rx * rvx + rz * rvz) / (distM || 1);
    const tCPA = rv2 > 0.04 ? -(rx * rvx + rz * rvz) / rv2 : -1;
    const cpaT = clamp(tCPA, 0, 6.5);
    const dCPA = Math.hypot(rx + rvx * cpaT, rz + rvz * cpaT);

    // 条件1: 明らかにこのままだとぶつかる船 (進路交差・直近衝突コース)
    const isCollisionCourse =
      (distM < 3.8 && closingSpd > -0.15) ||
      (distM <= 19.0 && closingSpd > 0.45 && tCPA > 0 && tCPA <= 6.2 && dCPA <= 3.6);

    // 条件2: タックしたらぶつかる可能性がある船 (クローズホールド時に今タックすると交錯する他艇)
    let isTackRisk = false;
    if (isUpwind && distM <= 18.0) {
      let minTackDist = 999;
      for (const ts of [0.8, 1.5, 2.2, 3.0, 3.8, 4.6]) {
        // タック開始〜1.2秒は風上へ回り込み、その後新タック方位(tfx, tfz)へ加速
        const turnT = Math.min(ts, 1.2);
        const sailT = Math.max(0, ts - 1.2);
        const pxT = (bfx * 0.55 + wfx * 0.45) * (b.v * 0.72) * turnT + tfx * vTack * sailT;
        const pzT = (bfz * 0.55 + wfz * 0.45) * (b.v * 0.72) * turnT + tfz * vTack * sailT;
        const oxT = rx + ovx * ts;
        const ozT = rz + ovz * ts;
        const dT = Math.hypot(oxT - pxT, ozT - pzT);
        if (dT < minTackDist) minTackDist = dT;
      }
      if (minTackDist <= 4.3) isTackRisk = true;
    }

    // 条件3: ランニングとリーチングで後ろからきている近い船
    let isAsternClose = false;
    if (isReachOrRun && distM <= 15.0) {
      const alongM = rx * bfx + rz * bfz; // < 0 が自艇より後方
      const latM = Math.abs(-rx * bfz + rz * bfx);
      if (alongM <= -0.8 && alongM >= -15.0 && latM <= 9.0 && (closingSpd > -0.3 || distM <= 8.5)) {
        isAsternClose = true;
      }
    }

    if (!isCollisionCourse && !isTackRisk && !isAsternClose) continue;
    near.push({ o, dx, dz, distM, isCollisionCourse, isTackRisk });
  }
  near.sort((a, c) => a.distM - c.distM);
  const count = Math.min(near.length, 4);
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
    const { o, dx, dz, distM, isCollisionCourse } = near[i];
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
    const lv = (isCollisionCourse || distM < 7.5) ? ' danger' : distM < 15 ? ' warn' : '';
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

// ---------- 接近時の権利主張コール (RRS 10 スタボ / RRS 11 風下権利艇 / RRS 18 3艇身ゾーン) ----------
let globalHailCD = 0;
const pairHailUntil = new Map();
const isAnimalCrew = (t) => t === 'cat' || t === 'dog' || t === 'shiba' || t === 'duck' || t === 'tanuki' || t === 'rabbit' || t === 'dolphin';
const FALLBACK_HAIL_VOICES = ['shiba', 'cat', 'dog', 'duck'];

function getBoatAnimalVoice(b) {
  if (!b) return null;
  if (isAnimalCrew(b.helmType)) return b.helmType;
  if (isAnimalCrew(b.crewType)) return b.crewType;
  // 人間ペアの艇でもレース中の権利主張コール(動物の鳴き声)がしっかり機能するようフォールバック音色を割り当てる
  return FALLBACK_HAIL_VOICES[Math.abs(b.id || 0) % FALLBACK_HAIL_VOICES.length];
}

function clearHailBubbles() {}
function updateHailBubbles() {}

function evaluatePairHailSituation(a, b, isPreStart) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const distW = Math.hypot(dx, dz);
  if (distW < 1.4 || distW > 28.0) return null;

  // -------------------------------------------------------------------------
  // 1) RRS 18 (3艇身ルール): マークの3艇身ゾーン(3 * BOAT_LEN = 14.16)に先に入った艇が、
  //    後方・外側からマーク内側へ割り込もうとする艇(バージング懸念艇)を牽制して「ノー・ルーム！」とコール
  // -------------------------------------------------------------------------
  if (!isPreStart && a.started && b.started && !a.ocs && !b.ocs && a.leg === b.leg && a.v > 0.55 && b.v > 0.55 && distW <= 16.8) {
    const L = LEGS[Math.min(a.leg, LEGS.length - 1)];
    if (L && (L.type === 'mark' || L.type === 'gate')) {
      const ZONE_W = BOAT_LEN * 3; // 3艇身 = 14.16 ワールド単位
      for (const obs of OBSTACLES) {
        const k = obs.key;
        if (k !== 'm1' && k !== 'm1a' && k !== 'm2' && k !== 'm3' && k !== 'gL' && k !== 'gR') continue;
        if (L.type === 'mark' && MARKS[k] !== L.mark) continue;
        if (L.type === 'gate' && k !== 'gL' && k !== 'gR') continue;

        const dA = Math.hypot(a.x - obs.x, a.z - obs.z);
        const dB = Math.hypot(b.x - obs.x, b.z - obs.z);
        const leadBoat = dA <= dB ? a : b;
        const trailBoat = dA <= dB ? b : a;
        const dLead = Math.min(dA, dB);
        const dTrail = Math.max(dA, dB);

        // 先行艇が3艇身ゾーン境界〜内側におり、後続艇がすぐ後ろ(差0.75以上・ゾーン約2倍以内)から迫っているか
        if (dLead >= 2.0 && dLead <= ZONE_W * 1.18 && dTrail - dLead >= 0.75 && dTrail <= ZONE_W * 1.98) {
          const toMx = (obs.x - trailBoat.x) / Math.max(0.1, dTrail);
          const toMz = (obs.z - trailBoat.z) / Math.max(0.1, dTrail);
          const tvx = Math.sin(trailBoat.h) * trailBoat.v, tvz = -Math.cos(trailBoat.h) * trailBoat.v;
          const closingToMark = tvx * toMx + tvz * toMz;
          if (closingToMark > 0.30 * trailBoat.v) {
            const lhx = Math.sin(leadBoat.h), lhz = -Math.cos(leadBoat.h);
            const lrx = Math.cos(leadBoat.h), lrz = Math.sin(leadBoat.h);
            const relTx = trailBoat.x - leadBoat.x, relTz = trailBoat.z - leadBoat.z;
            const alongLead = relTx * lhx + relTz * lhz;
            const latLead = relTx * lrx + relTz * lrz;
            // 左舷回航マーク(gL以外)は左(-lat)がマーク内側、4S(gL)は右(+lat)がマーク内側
            const insideSign = k === 'gL' ? 1 : -1;
            const trailInsideOffset = latLead * insideSign;
            // 後続艇がクリアアスターン(alongLead < -2.4)から迫っているか、イン側〜真後ろの狭い隙間(trailInsideOffset > -2.2)を狙っている場合にコール
            if (alongLead < -2.4 || (alongLead < 1.2 && trailInsideOffset > -2.2 && Math.abs(latLead) < 7.5)) {
              return { rowBoat: leadBoat, gwBoat: trailBoat, callKind: 'zone', markKey: k };
            }
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2) RRS 10 (ポート・スターボード): 自分がスターボードタック(tack > 0)で相手がポートタック(tack < 0)の交差接近時、
  //    ポート艇に避けさせたい(タックまたはダックさせたい)明確な意図がある場面で「スタボ！」とコール
  // -------------------------------------------------------------------------
  if (a.tack !== b.tack) {
    const stbd = a.tack > 0 ? a : b;
    const port = a.tack > 0 ? b : a;
    if (stbd.v >= 0.65 && port.v >= 0.65 && distW <= (isPreStart ? 20.5 : 30.0)) {
      const shx = Math.sin(stbd.h), shz = -Math.cos(stbd.h);
      const srx = Math.cos(stbd.h), srz = Math.sin(stbd.h);
      const p2sX = port.x - stbd.x, p2sZ = port.z - stbd.z;
      const alongStbdW = p2sX * shx + p2sZ * shz;
      const crossStbdW = p2sX * srx + p2sZ * srz;

      if (alongStbdW >= -1.5 && alongStbdW <= (isPreStart ? 18.5 : 27.5) && crossStbdW >= -26.5 && crossStbdW <= 11.5) {
        const svx = shx * stbd.v, svz = shz * stbd.v;
        const pvx = Math.sin(port.h) * port.v, pvz = -Math.cos(port.h) * port.v;
        const rvx = pvx - svx, rvz = pvz - svz;
        const rv2 = rvx * rvx + rvz * rvz;
        if (rv2 > 0.04) {
          const tCPA = -(p2sX * rvx + p2sZ * rvz) / rv2;
          const maxT = isPreStart ? 4.2 : 6.2;
          if (tCPA >= 0.08 && tCPA <= maxT) {
            const dCPAW = Math.hypot(p2sX + rvx * tCPA, p2sZ + rvz * tCPA);
            if (dCPAW <= (isPreStart ? 7.5 : 10.8)) {
              // スタボ艇自身がすでに大きくベアアウェイ(stbd.steer < -0.22)して逃げる軌道か、ポート艇が十分前方(>1.75艇身)をクリア済みでなければコール
              const phx = Math.sin(port.h), phz = -Math.cos(port.h);
              const stbdCpaRelX = (stbd.x + svx * tCPA) - (port.x + pvx * tCPA);
              const stbdCpaRelZ = (stbd.z + svz * tCPA) - (port.z + pvz * tCPA);
              const alongPortAtCPAW = stbdCpaRelX * phx + stbdCpaRelZ * phz;
              if (stbd.steer > -0.22 && alongPortAtCPAW > -8.2) {
                return { rowBoat: stbd, gwBoat: port, callKind: 'starboard', markKey: null };
              }
            }
          }
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 3) RRS 11 (同一タックのオーバーラップ・風下権利艇): 自分が風下(下)で相手が風上(上)にいる際、
  //    風上艇に頭を上げさせたい・避けさせたい・もう少し自艇を気持ちよく伸ばさせたい場面でコール
  // -------------------------------------------------------------------------
  if (distW <= (isPreStart ? 11.5 : 13.0)) {
    const wf = a.windFrom ?? W0;
    const dwx = -Math.sin(wf), dwz = Math.cos(wf); // 風下方向単位ベクトル
    const leeA = a.x * dwx + a.z * dwz;
    const leeB = b.x * dwx + b.z * dwz;
    const windGapW = Math.abs(leeA - leeB);
    if (windGapW >= 0.95 && windGapW <= (isPreStart ? 7.4 : 8.6)) {
      const leeBoat = leeA >= leeB ? a : b;
      const windBoat = leeA >= leeB ? b : a;
      if (leeBoat.v > 0.35 || isPreStart) {
        const lhx = Math.sin(leeBoat.h), lhz = -Math.cos(leeBoat.h);
        const relWx = windBoat.x - leeBoat.x, relWz = windBoat.z - leeBoat.z;
        const alongLeeW = relWx * lhx + relWz * lhz;
        // 同タックで前後オーバーラップ範囲内(|alongLeeW| < 約1.08艇身)
        if (Math.abs(alongLeeW) < BOAT_LEN * 1.08) {
          const wvx = Math.sin(windBoat.h) * windBoat.v, wvz = -Math.cos(windBoat.h) * windBoat.v;
          const lvx = lhx * leeBoat.v, lvz = lhz * leeBoat.v;
          const leeClosingSpeed = (wvx - lvx) * dwx + (wvz - lvz) * dwz; // +なら風上艇が風下艇へ被せてきている
          const leeTurnUp = leeBoat.steer * (leeBoat.tack || 1); // +なら風下艇がラフしている

          const closeSqueeze = windGapW < 4.8 && leeClosingSpeed > -0.10;
          const windSaggingDown = leeClosingSpeed > 0.08 && windGapW < 8.0;
          const upwindExtend = leeBoat.twa < 1.18 && windBoat.twa < 1.28 && windGapW < 6.6 && alongLeeW > -3.8 && alongLeeW < 3.8 && leeTurnUp >= -0.05;
          const activeLuff = leeTurnUp > 0.045 && windGapW < 7.8;

          if (closeSqueeze || windSaggingDown || upwindExtend || activeLuff) {
            return { rowBoat: leeBoat, gwBoat: windBoat, callKind: 'leeward', markKey: null };
          }
        }
      }
    }
  }

  return null;
}

function checkRightOfWayHails(dt) {
  if (!player || state.ff || (state.phase !== 'race' && state.phase !== 'practice') || cfg.bgmMode === 'off') return;
  if (globalHailCD > 0) globalHailCD -= dt;
  for (const b of boats) {
    if (b.hailCD > 0) b.hailCD -= dt;
  }
  if (globalHailCD > 0) return;

  const isPreStart = state.phase === 'race' && state.t < 0;
  const n = boats.length;
  // 自艇が絡むペアを最優先で判定し、その後に自艇周囲(約22m以内)のCP同士のコールを判定する
  const candidatePairs = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const a = boats[i];
      if (a.dsq || a.finished || a.penalty) continue;
      for (let j = i + 1; j < n; j++) {
        const b = boats[j];
        if (b.dsq || b.finished || b.penalty) continue;
        const involvesPlayer = a === player || b === player;
        if ((pass === 0) !== involvesPlayer) continue;
        if (!involvesPlayer) {
          const dPlayerW = Math.min(Math.hypot(a.x - player.x, a.z - player.z), Math.hypot(b.x - player.x, b.z - player.z));
          if (dPlayerW > 34.0) continue;
        }
        candidatePairs.push([a, b, involvesPlayer]);
      }
    }
  }

  for (let k = 0; k < candidatePairs.length; k++) {
    const [a, b, involvesPlayer] = candidatePairs[k];
    const hit = evaluatePairHailSituation(a, b, isPreStart);
    if (!hit) continue;
    const { rowBoat, gwBoat, callKind, markKey } = hit;
    if (rowBoat.hailCD > 0) continue;

    const pairKey = `${Math.min(a.id, b.id)}_${Math.max(a.id, b.id)}_${callKind}`;
    const blockedUntil = pairHailUntil.get(pairKey);
    if (blockedUntil !== undefined && state.t < blockedUntil) continue;

    const animalVoice = getBoatAnimalVoice(rowBoat);
    if (!animalVoice) continue;

    rowBoat.hailCD = (involvesPlayer ? 4.4 : 8.5) + rng() * 1.8;
    globalHailCD = involvesPlayer ? 1.45 : 2.8;
    pairHailUntil.set(pairKey, state.t + (involvesPlayer ? 7.2 : 11.5));

    // コールを受けた非権利艇(CP艇)が反応できるようフラグを付与
    if (callKind === 'starboard') {
      gwBoat.hailedStbdUntil = state.t + 2.8;
    } else if (callKind === 'leeward') {
      gwBoat.hailedLeewardUntil = state.t + 2.6;
    } else if (callKind === 'zone') {
      gwBoat.hailedNoBargeUntil = state.t + 3.0;
      gwBoat.hailedMarkKey = markKey;
    }

    const rx = Math.cos(player.h), rz = Math.sin(player.h);
    const pdx = rowBoat.x - player.x, pdz = rowBoat.z - player.z;
    const pDist = Math.hypot(pdx, pdz) || 1;
    const pan = rowBoat === player ? 0 : clamp(((pdx * rx + pdz * rz) / pDist) * 0.85, -0.88, 0.88);
    window.__lastHail = { t: state.t, kind: callKind, voice: animalVoice, rowId: rowBoat.id, gwId: gwBoat.id, markKey };
    playRightOfWayHail(animalVoice, callKind, pan);
    return;
  }
}

function updateHUD(sorted) {
  const b = player, t = state.t;
  const isMenu = state.phase === 'menu';
  const isOrient = state.phase === 'orientation';
  const isPrac = isMenu;
  document.body.classList.toggle('menuOpen', isMenu);
  document.body.classList.toggle('orientOpen', isOrient);
  cam.menuOffset = isMenu;
  const L = LEGS[Math.min(b.leg, LEGS.length - 1)];
  const nextMarkTxt = L.type === 'finish' ? 'フィニッシュ' : L.type === 'gate' ? '4ゲート(4S/4P)' : `${L.name}マーク`;
  const skewDeg = Math.round(Math.abs((LINE_SKEW * 180) / Math.PI));
  const favShort = (FAVORED === 'even' || skewDeg === 0) ? '0°有利なし' : `${skewDeg}°${FAVORED === 'com' ? '上有利' : '下有利'}`;
  hud.clock.textContent = isMenu ? '待機中' : fmt(t);
  hud.phase.textContent = isMenu
    ? `スタート画面 ― 次: ${nextMarkTxt}`
    : isOrient
      ? `HOW TO PLAY ― STEP 0${orientState.step + 1} / 08`
      : t < 0 ? `スタート前 (${favShort}) ― 次: 1マーク` : b.dsq ? 'DSQ (失格)' : b.finished ? 'フィニッシュ!' : `レース中 ― 次: ${nextMarkTxt}`;
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
  // ブランケット/バックウインド表示: 風上艇の風影=ブランケット、風下艇のリーチからの吹き返し=バックウインド (両方同時もあり得る)
  const blkPct = Math.round(b.cover * 100);
  const backPct = Math.round(b.back * 100);
  const hasBlk = blkPct >= 5;
  const hasBack = backPct >= 5;
  if (hasBlk || hasBack) {
    hud.blk.style.display = 'flex';
    const totalPct = hasBlk && hasBack ? Math.min(100, blkPct + backPct) : (hasBlk ? blkPct : backPct);
    const label = hasBlk && hasBack
      ? `ブランケット・バックウインド ${totalPct}%`
      : hasBlk
        ? `ブランケット ${blkPct}%`
        : `バックウインド ${backPct}%`;
    if (hud.blkTxt) hud.blkTxt.textContent = label;
    if (hud.blkFill) hud.blkFill.style.width = `${totalPct}%`;
    hud.blk.classList.toggle('mid', totalPct >= 35 && totalPct < 65);
    hud.blk.classList.toggle('high', totalPct >= 65);
  } else {
    hud.blk.style.display = 'none';
  }
  hud.leg.textContent = isMenu ? 'エントリー待機' : b.dsq ? 'DSQ (失格)' : b.finished ? 'フィニッシュ' : t < 0 ? `スタート前 (${favShort})` : L.label;
  const tg = L.type === 'mark' ? L.mark : L.center;
  const tw = toWorld(tg.a, tg.c);
  const brg = Math.atan2(tw.x - b.x, -(tw.z - b.z));
  hud.legArrow.style.transform = `rotate(${wrap(brg - b.h)}rad)`;
  if (b.penalty && !b.finished && !b.dsq && !isPrac && !isOrient) {
    hud.pen.style.display = 'block';
    const deg = b.penalty.reqDeg || 360;
    const turns = deg === 720 ? '720°(2回転)' : '360°(1回転)';
    const pct = Math.min(99, Math.round((b.penalty.turned / (b.penalty.reqRad || 2 * Math.PI)) * 100));
    const sec = Math.ceil(b.penalty.timer);
    const cw = !b.penalty.clearWater ? ' [クリアウオーター確保中]' : '';
    hud.pen.textContent = `ペナルティ(ルール${b.penalty.rule}) 残り${sec}秒以内に${turns}ターンせよ (${pct}%)${cw}`;
  } else hud.pen.style.display = 'none';
  if (hud.ocs) hud.ocs.style.display = 'none';
  hud.cam.textContent = 'CAM  ' + CAM_MODES[cam.mode] + ' [C]';
  if (hud.tCam) { const nx = cam.mode === COCKPIT ? 'ドローン' : '船内'; if (hud.tCam.textContent !== nx) hud.tCam.textContent = nx; }
  if (hud.tCamReset) hud.tCamReset.classList.toggle('hidden', !cam.isMoved());
  if (!isPrac) {
    const c = Math.ceil(-t);
    if (t < 0 && t > -11) { hud.big.textContent = c; hud.big.style.opacity = 1; hud.big.classList.toggle('flash', t > -1); }
    else if (t >= 0 && t < 2.5) { hud.big.textContent = 'START!'; hud.big.style.opacity = 1 - t / 2.5; }
    else hud.big.style.opacity = 0;
  } else {
    hud.big.style.opacity = 0;
  }
  const bp = $('boardPanel');
  if (bp) bp.style.display = t < 0 ? 'none' : '';
  if (t < 0) {
    if (hud.rank.textContent !== '') hud.rank.textContent = '';
    if (hud.leaders.innerHTML !== '') hud.leaders.innerHTML = '';
  } else if (performance.now() - lastLeaders > 400 || hud.leaders.innerHTML === '') {
    lastLeaders = performance.now();
    updateLeaders(sorted);
  }
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
      // ホーンを鳴らすのはトップフィニッシュのみ(2位以降は表示のみ)
      if (top && !state.ff) signalHorn('short');
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
    const imp = e.impact ?? clamp(Math.max(Math.abs(gw.v), Math.abs(row.v)) / (2.15 * SPEED_SCALE), 0.08, 1.25);
    if (!quiet) thud(soundVol(gw.x, gw.z), imp);
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
      const imp = e.impact ?? clamp(Math.abs(b.v) / (2.10 * SPEED_SCALE), 0.10, 1.20);
      if (e.mark === 'com') thud(v, imp); else markHit(v, imp);
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
  } else if (e.type === 'anchorSnag') {
    const b = e.boat;
    if (!quiet) thud(soundVol(b.x, b.z) * 0.85);
  }
}

// ---------- レース進行 ----------
function startRace() {
  initAudio();
  clearHailBubbles();
  resetCloseHoldLock();
  playBgm(cfg.venue === 'hakkeijima' ? 'prestart_hakkeijima' : 'prestart_enoshima');
  prewarmBgm([cfg.venue === 'hakkeijima' ? 'race_hakkeijima' : 'race_enoshima', 'result']);
  state.phase = 'race'; state.t = START_T - 0.02; state.sig = 0; state.pFinish = null; state.firstFinish = null; state.resultShown = false; state.count = -1; state.ff = false; state.pAI = null;
  state.lastTack = undefined; state.lastPole = undefined; hTarget = null;
  // レートON時はレース開始時にトラペゾイドなら100、上マークフィニッシュなら50を引く
  const beforeRate = rateData.rate;
  state.raceStartRate = beforeRate;
  if (cfg.rateMode !== 'off') {
    const entryCost = cfg.courseMode === 'upwind' ? 50 : 100;
    const afterEntry = Math.max(0, beforeRate - entryCost);
    rateData.rate = afterEntry;
    saveRateData();
    updateMenuRateUI();
    state.raceRateInfo = { active: true, before: beforeRate, entryCost, afterEntry, courseMode: cfg.courseMode, settled: false };
  } else {
    state.raceRateInfo = { active: false, before: beforeRate };
  }
  randomizeStartLine();
  randomizeWindShifts(Date.now() ^ (rng() * 1e9));
  applyVenue();
  if (world.setCourseVisible) world.setCourseVisible(true);
  makeFleet(false);
  recorder = new Recorder(boats, LEGS, {
    venue: cfg.venue,
    courseMode: cfg.courseMode,
    sea: SEA.label,
    tide: TIDE.label,
    windDeg: currentWindDeg,
    baseWindKt: BASE_WIND_KT,
    sideBias: SIDE_BIAS,
    sideBiasDesc: currentSideBiasDesc,
    shiftLog: [...SHIFT_LOG],
    shiftAt,
    windAt,
    toWorld,
  });
  document.body.classList.remove('menuOpen', 'orientOpen'); cam.menuOffset = false;
  $('menu').classList.add('hidden'); $('result').classList.add('hidden'); $('orientation').classList.add('hidden'); $('hud').classList.remove('hidden');
  clearOrientHighlight();
  cam.mode = 0; cam.inited = false; cam.zoom = 1; cam.yaw = 0; cam.pitch = 0;
  clock.getDelta(); // シーン切替直後のフレームスパイクを防止
  const deg = Math.round(Math.abs((LINE_SKEW * 180) / Math.PI));
  const favLabel = (FAVORED === 'even' || deg === 0) ? '0°有利なし' : `${deg}°${FAVORED === 'com' ? '上有利' : '下有利'}`;
  toast(`P旗降下、スタート1分前 (${favLabel})`, 'info', 6500);
}

// ---------- オリエンテーション ----------
const ORIENT_STEPS = [
  {
    en: '',
    title: 'スタート1分前・有利なサイドと海面を見極めよう',
    body: 'ゲームはレーススタート<strong>1分前</strong>から始まる！ <strong>画面左上のタイマー</strong>と、海上の<strong>「START LINE」下の有利サイド表記</strong>、海面のブローを判断して出たいポジションを確保しよう。',
    dur: 11.2,
  },
  {
    en: '',
    title: '角度を上したりセールを出してスピードを調整しよう',
    body: 'ポジションを確保するためには、<strong>左下の「◀ ▶」ボタン（←→キー）</strong>で風上へ角度を上したり、<strong>右下の「出す」ボタン（↓キー）</strong>でセールを緩めてスピードを調整しよう！',
    dur: 11.5,
  },
  {
    en: '',
    title: '0:00に合わせてスタートラインぎりぎりから出られるように加速してスタートしよう',
    body: '<strong>0:00</strong>に合わせてスタートラインぎりぎりから出られるように加速してスタートしよう',
    dur: 11.0,
  },
  {
    en: '',
    title: 'クローズホールドは真風角38°〜44°でVMGを維持！',
    body: 'スタート後のクローズホールドでは<strong>下の計器バー中央「真風角」</strong>を確認！ 風速や波の高さにもよるが<strong>38°〜44°</strong>がベスト。<strong>ブローに入ったら「◀ ▶」で少し上し、抜けたら少し落とし気味</strong>で走ってVMGを維持しよう！',
    dur: 11.5,
  },
  {
    en: '',
    title: 'ブロー・風の振れを見てタック判断しNextマークへ！',
    body: 'クローズ中は海面のブローや風の振れを確認して<strong>「◀ ▶」（または[T]キー）</strong>でタック判断をし、<strong>下計器バー右端「次のマーク」</strong>の矢印方向へ近づこう！',
    dur: 11.2,
  },
  {
    en: '',
    title: '上マーク回航後はランチャーUP！ 下マーク(4S)回航前はDOWNして回航！',
    body: '<strong>上マーク回航後</strong>の風下レグでは、<strong>画面左の「ランチャー」ボタン（[L]キー）</strong>でランチャーを上げて加速しよう！ そして<strong>4Sマーク回航前</strong>にはランチャーを下げ、クローズに上した時にマークが真横になる軌道できれいに回航しよう。',
    dur: 13.6,
  },
  {
    en: '',
    title: '下マーク回航後も有利な海面と艇速を維持しフィニッシュへ！',
    body: '下マーク回航後も有利な海面と艇速を維持して、チェッカーフラッグの<strong>「FINISH」ライン</strong>を目指して最後まで走り切ろう！',
    dur: 10.8,
  },
  {
    en: '',
    title: 'フィニッシュ後は「振り返り」ボタンで分析して次に繋げよう！',
    body: 'フィニッシュ後の<strong>結果画面にある「振り返り」ボタン</strong>を押すと分析画面が開く！ <strong>「▶ 再生」で各艇のコース取り</strong>を確認し、<strong>スタート順位・走行距離・平均艇速・平均角度</strong>を振り返って次のレースに繋げよう！',
    dur: 12.5,
  },
];

const orientState = { step: 0, elapsed: 0, subDone: false, phase2: false, finSign0: 1 };
const orientPointerPool = [];
const orientProjV3 = new THREE.Vector3();

function getOrientPointerItem(idx) {
  const layer = $('orientPointerLayer');
  if (!layer) return null;
  while (orientPointerPool.length <= idx) {
    const box = document.createElement('div');
    box.className = 'orientFocusBox';
    const arr = document.createElement('div');
    arr.className = 'orientFocusArrow';
    arr.innerHTML = `<svg viewBox="0 0 68 68"><path d="M 4 24 L 36 24 L 36 10 L 64 34 L 36 58 L 36 44 L 4 44 Z" fill="#ff1414" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round"/></svg>`;
    layer.appendChild(box);
    layer.appendChild(arr);
    orientPointerPool.push({ box, arr });
  }
  return orientPointerPool[idx];
}

function clearOrientHighlight() {
  document.querySelectorAll('.orientTargetHighlight').forEach((el) => el.classList.remove('orientTargetHighlight'));
  for (const item of orientPointerPool) {
    item.box.style.display = 'none';
    item.arr.style.display = 'none';
  }
  ['tLeft', 'tRight', 'tUp', 'tDown', 'tPole', 'tCam'].forEach((id) => {
    const el = $(id);
    if (el) el.classList.remove('on');
  });
  const revDemo = $('orientReviewDemo');
  if (revDemo) revDemo.classList.add('hidden');
}

// 説明テキストは上部のカード(#orientCard)のみに表示し、対象ボタン・計器・海上看板にはゆっくり点滅する赤枠と太い赤矢印を表示する
function updateOrientVisualPointer(targets) {
  const activeDomSet = new Set();
  const rects = [];
  const W = window.innerWidth, H = window.innerHeight;
  camera.updateMatrixWorld();

  for (const t of targets) {
    if (typeof t === 'string') {
      const nodes = document.querySelectorAll(t);
      nodes.forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        const r = el.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) {
          activeDomSet.add(el);
          if (!el.classList.contains('orientTargetHighlight')) el.classList.add('orientTargetHighlight');
          rects.push({ left: r.left - 5, top: r.top - 5, width: r.width + 10, height: r.height + 10 });
        }
      });
    } else if (t && t.worldObj) {
      const obj = t.worldObj;
      // カメラ空間(View Space)でTHREE.Spriteの実際の描画矩形(u0..u1, v0..v1)を厳密に投影して赤枠のズレを完全にゼロにする
      orientProjV3.copy(obj.position);
      if (t.offsetY) orientProjV3.y += t.offsetY;
      orientProjV3.applyMatrix4(camera.matrixWorldInverse);
      const vz = orientProjV3.z;
      if (vz < -0.5) {
        const sw = obj.scale ? obj.scale.x : 12;
        const sh = obj.scale ? obj.scale.y : 4.5;
        const u0 = t.u0 !== undefined ? t.u0 : 0.08;
        const u1 = t.u1 !== undefined ? t.u1 : 0.92;
        const v0 = t.v0 !== undefined ? t.v0 : 0.06;
        const v1 = t.v1 !== undefined ? t.v1 : 0.94;
        const vx0 = orientProjV3.x + (u0 - 0.5) * sw;
        const vx1 = orientProjV3.x + (u1 - 0.5) * sw;
        const vyTop = orientProjV3.y + (0.5 - v0) * sh;
        const vyBot = orientProjV3.y + (0.5 - v1) * sh;
        const pe = camera.projectionMatrix.elements;
        const invZ = 1 / (-vz);
        const ndcX0 = vx0 * pe[0] * invZ;
        const ndcX1 = vx1 * pe[0] * invZ;
        const ndcYTop = vyTop * pe[5] * invZ;
        const ndcYBot = vyBot * pe[5] * invZ;
        const leftPx = (ndcX0 * 0.5 + 0.5) * W - 6;
        const rightPx = (ndcX1 * 0.5 + 0.5) * W + 6;
        const topPx = (-ndcYTop * 0.5 + 0.5) * H - 6;
        const botPx = (-ndcYBot * 0.5 + 0.5) * H + 6;
        const pw = Math.max(48, rightPx - leftPx);
        const ph = Math.max(24, botPx - topPx);
        rects.push({
          left: clamp(leftPx, 8, W - pw - 8),
          top: clamp(topPx, 8, H - ph - 8),
          width: pw,
          height: ph,
          arrowDir: t.arrowDir || 'down',
        });
      }
    }
  }
  document.querySelectorAll('.orientTargetHighlight').forEach((el) => {
    if (!activeDomSet.has(el)) el.classList.remove('orientTargetHighlight');
  });

  const bob = Math.sin(performance.now() * 0.0055) * 8;
  for (let i = 0; i < rects.length; i++) {
    const item = getOrientPointerItem(i);
    if (!item) continue;
    const r = rects[i];
    item.box.style.display = 'block';
    item.box.style.left = `${r.left}px`;
    item.box.style.top = `${r.top}px`;
    item.box.style.width = `${r.width}px`;
    item.box.style.height = `${r.height}px`;

    const cx = r.left + r.width * 0.5;
    const cy = r.top + r.height * 0.5;
    let dir = r.arrowDir;
    if (!dir) {
      if (r.left < 180 && r.top + r.height < H - 140) dir = 'left'; // 右側から左の対象を指す
      else if (r.left + r.width > W - 180 && r.top + r.height < H - 140) dir = 'right'; // 左側から右の対象を指す
      else if (r.top > 210) dir = 'down'; // 上側から下の対象を指す
      else dir = 'up'; // 下側から上の対象を指す
    }

    let ax = cx - 34, ay = cy - 34, deg = 90;
    if (dir === 'left') {
      // 対象の右側に配置して左(180°)を指す
      ax = r.left + r.width + 10 + bob;
      ay = cy - 34;
      deg = 180;
    } else if (dir === 'right') {
      // 対象の左側に配置して右(0°)を指す
      ax = r.left - 68 - 10 - bob;
      ay = cy - 34;
      deg = 0;
    } else if (dir === 'up') {
      // 対象の下側に配置して上(-90°)を指す
      ax = cx - 34;
      ay = r.top + r.height + 10 + bob;
      deg = -90;
    } else {
      // 対象の上側に配置して下(90°)を指す
      ax = cx - 34;
      ay = r.top - 68 - 10 - bob;
      deg = 90;
    }
    item.arr.style.display = 'block';
    item.arr.style.left = `${clamp(ax, 4, W - 72)}px`;
    item.arr.style.top = `${clamp(ay, 4, H - 72)}px`;
    item.arr.style.transform = `rotate(${deg}deg)`;
  }

  for (let i = rects.length; i < orientPointerPool.length; i++) {
    orientPointerPool[i].box.style.display = 'none';
    orientPointerPool[i].arr.style.display = 'none';
  }
}

function applyOrientStepHighlights(stepIdx, elapsed) {
  const onButtons = new Set();
  if (stepIdx === 1) {
    if (elapsed < 5.6) {
      onButtons.add('tRight');
      onButtons.add('tDown');
    } else {
      onButtons.add('tLeft');
    }
  } else if (stepIdx === 5) {
    if (elapsed < 4.8 || (elapsed >= 5.2 && elapsed < 6.4)) onButtons.add('tPole');
  }
  ['tLeft', 'tRight', 'tUp', 'tDown', 'tPole', 'tCam'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const want = onButtons.has(id);
    if (el.classList.contains('on') !== want) el.classList.toggle('on', want);
  });
  if (hud.blk) hud.blk.style.display = 'none';
  if (stepIdx !== 7) {
    $('result').classList.add('hidden');
    const revDemo = $('orientReviewDemo');
    if (revDemo) revDemo.classList.add('hidden');
  }

  if (stepIdx === 0) {
    updateOrientVisualPointer([
      '#timerPanel',
      // startCanvas (1280x440) 内の START LINE プレート＋大型有利サイドポッド描画領域 (x=86..1194, y=20..394) を正確に囲む
      { worldObj: world.startLabel, u0: 0.062, u1: 0.938, v0: 0.04, v1: 0.90, arrowDir: 'down' },
    ]);
  } else if (stepIdx === 1) {
    if (elapsed < 5.6) {
      updateOrientVisualPointer(['#tLeft', '#tRight', '#tDown']);
    } else {
      updateOrientVisualPointer(['#tLeft', '#tRight']);
    }
  } else if (stepIdx === 2) {
    updateOrientVisualPointer(['#timerPanel']);
  } else if (stepIdx === 3) {
    updateOrientVisualPointer(['#instr .cell:nth-child(3)', '#tLeft', '#tRight']);
  } else if (stepIdx === 4) {
    updateOrientVisualPointer(['#instr .cell.mark', '#tLeft', '#tRight']);
  } else if (stepIdx === 5) {
    updateOrientVisualPointer(['#tPole']);
  } else if (stepIdx === 6) {
    updateOrientVisualPointer([]);
  } else if (stepIdx === 7) {
    const revDemo = $('orientReviewDemo');
    if (elapsed < 5.2) {
      if (revDemo) revDemo.classList.add('hidden');
      // 実際の結果画面(#result)と「振り返り」ボタン(#reviewBtn)を表示して指し示す (毎フレームDOMを再生成して点滅するのを防ぐため初回のみ設定)
      if (!orientState.resultPopulated) {
        orientState.resultPopulated = true;
        $('resultTitle').textContent = '1位 / 24艇';
        $('resultBody').innerHTML =
          '<tr class="me"><td>1</td><td>あなた</td><td>4:12.4</td></tr>' +
          '<tr><td>2</td><td>JPN 29410</td><td>4:15.8</td></tr>' +
          '<tr><td>3</td><td>ITA 31022</td><td>4:19.1</td></tr>';
      }
      let rb = $('reviewBtn');
      if (!rb) {
        rb = document.createElement('button');
        rb.id = 'reviewBtn'; rb.type = 'button'; rb.className = 'btnSec'; rb.textContent = '振り返り';
        const again = $('againBtn');
        if (again && again.parentNode) again.parentNode.insertBefore(rb, again); else $('result').appendChild(rb);
      }
      $('result').classList.remove('hidden');
      updateOrientVisualPointer(['#reviewBtn']);
    } else {
      $('result').classList.add('hidden');
      if (revDemo) revDemo.classList.remove('hidden');
      // 振り返り画面全体(.orientRevCard)はCSS側の固定赤枠で表示し、画面全体の点滅を防ぐため点滅オーバーレイは消去する
      updateOrientVisualPointer([]);
    }
  }
}

function setupOrientStepScene(stepIdx) {
  orientState.subDone = false;
  orientState.poleUpDone = false;
  orientState.phase2 = false;
  orientState.resultPopulated = false;
  clearOrientHighlight();

  if (!player) return;
  player.maneuver = null; player.tacking = false; player.ocs = false; player.penalty = null; player.finished = false; player.postFinishStop = false;
  cam.inited = false;
  if (stepIdx === 0) {
    // STEP 1: スタート1分前・海上のSTART LINE＆有利サイド表記が画面中央にはっきり映る位置に配置
    state.t = -50;
    if (world.setLine) world.setLine('start', 0, true);
    if (world.updateStartLabel) world.updateStartLabel();
    const p = toWorld(-40 + lineA(9), 9);
    player.place(p.x, p.z, W0 - 0.30);
    player.v = 0.72 * SPEED_SCALE; player.pole = false; player.poleK = 0; player.leg = 0;
    cam.yaw = cam.targetYaw = 0.06; cam.pitch = cam.targetPitch = -0.03;
  } else if (stepIdx === 1) {
    // STEP 2: 角度を上してセールを出して減速・ポジションキープ (他艇のブランケットや航跡干渉を受けないクリアな海面に配置)
    state.t = -18;
    const p = toWorld(-18 + lineA(18), 18);
    player.place(p.x, p.z, W0 - 0.42);
    player.v = 0.75 * SPEED_SCALE; player.sheet = 0.16; player.pole = false; player.poleK = 0; player.leg = 0;
    cam.yaw = cam.targetYaw = -0.42; cam.pitch = cam.targetPitch = -0.02;
  } else if (stepIdx === 2) {
    // STEP 3: 号砲3.2秒前 → 0:00の瞬間にスタートライン手前に余裕(艇中心-5.4m / バウ先端約-3.6m)を持って加速し、0:00直後にラインを切る
    state.t = -3.2; state.count = 4;
    const bestV = 3.15 * SPEED_SCALE;
    const vA = bestV * Math.cos(0.73);
    const vC = -bestV * Math.sin(0.73);
    const cCross = 16;
    const aCross = lineA(cCross) - 5.4;
    const aStart = aCross + state.t * vA;
    const cStart = cCross + state.t * vC;
    const p = toWorld(aStart, cStart);
    player.place(p.x, p.z, W0 - 0.73);
    player.v = bestV; player.sheet = sheetOpt(0.73); player.pole = false; player.poleK = 0; player.leg = 0;
    cam.yaw = cam.targetYaw = 0.22; cam.pitch = cam.targetPitch = 0.04;
  } else if (stepIdx === 3) {
    // STEP 4: クローズホールド 40°〜44° VMG走行
    state.t = 28;
    const p = toWorld(95, 32);
    player.place(p.x, p.z, W0 - 0.73);
    player.v = 3.1 * SPEED_SCALE; player.sheet = sheetOpt(0.73); player.pole = false; player.poleK = 0; player.leg = 0; player.started = true;
    cam.yaw = cam.targetYaw = -0.38; cam.pitch = cam.targetPitch = -0.03;
  } else if (stepIdx === 4) {
    // STEP 5: タック判断とNext(1マーク)へのアプローチ
    state.t = 65;
    const m1 = MARKS.m1;
    const p = toWorld(m1.a - 75, -34);
    player.place(p.x, p.z, W0 - 0.73);
    player.v = 3.05 * SPEED_SCALE; player.sheet = sheetOpt(0.73); player.pole = false; player.poleK = 0; player.leg = 0; player.started = true;
    cam.yaw = cam.targetYaw = 0.15; cam.pitch = cam.targetPitch = 0.04;
  } else if (stepIdx === 5) {
    // STEP 6: 前半＝上マーク(1a)回航直後にランチャーUP ／ 後半＝下マーク(3)回航前にランチャーDOWNしてきれいなアウト・イン・アウト回航
    state.t = 125;
    const m1a = MARKS.m1a || MARKS.m1;
    const p = toWorld(m1a.a - 7, m1a.c - 4);
    player.place(p.x, p.z, wrap(W0 + 2.68));
    player.v = 3.25 * SPEED_SCALE; player.pole = false; player.poleK = 0; player.leg = Math.min(2, LEGS.length - 1); player.started = true;
    cam.yaw = cam.targetYaw = 0.56; cam.pitch = cam.targetPitch = 0.03;
  } else if (stepIdx === 6) {
    // STEP 7: 下マーク回航からフィニッシュへ → フィニッシュラインを切った瞬間にホーンを鳴らす
    state.t = 210;
    const finA = (MARKS.fm.a + MARKS.fcom.a) * 0.5;
    const finC = (MARKS.fm.c + MARKS.fcom.c) * 0.5;
    const a0 = finA - 36, c0 = finC + 16;
    const p = toWorld(a0, c0);
    player.place(p.x, p.z, W0 - 0.72);
    player.v = 3.1 * SPEED_SCALE; player.pole = false; player.poleK = 0; player.leg = LEGS.length - 1; player.started = true;
    const F = MARKS.fcom, G = MARKS.fm;
    orientState.finSign0 = Math.sign((G.a - F.a) * (c0 - F.c) - (G.c - F.c) * (a0 - F.a)) || 1;
    cam.yaw = cam.targetYaw = -0.18; cam.pitch = cam.targetPitch = 0.02;
  } else if (stepIdx === 7) {
    // STEP 8: フィニッシュ後の結果画面＆振り返りモード紹介
    state.t = 245;
    const finA = (MARKS.fm.a + MARKS.fcom.a) * 0.5;
    const finC = (MARKS.fm.c + MARKS.fcom.c) * 0.5;
    const p = toWorld(finA + 10, finC - 8);
    player.place(p.x, p.z, W0 - 0.74);
    player.v = 3.0 * SPEED_SCALE; player.pole = false; player.poleK = 0; player.leg = LEGS.length - 1; player.started = true;
    cam.yaw = cam.targetYaw = 0.15; cam.pitch = cam.targetPitch = 0.14;
  }
  state.lastTack = player.tack;
  state.lastPole = player.pole;
  const nowSec = performance.now() / 1000;
  cam.update(0, nowSec, player, boats);
  world.update(nowSec, camera, 0, state.t, player, boats);
  camera.updateMatrixWorld();
  applyOrientStepHighlights(stepIdx, orientState.elapsed);
}

function renderOrientStepUI() {
  const idx = orientState.step;
  const st = ORIENT_STEPS[idx];
  const numEl = $('orientStepNum'), enEl = $('orientEnTag'), titleEl = $('orientTitle'), bodyEl = $('orientBody');
  if (numEl) numEl.textContent = String(idx + 1).padStart(2, '0');
  if (enEl) enEl.textContent = st.en;
  if (titleEl) titleEl.textContent = st.title;
  if (bodyEl) bodyEl.innerHTML = st.body;

  const card = $('orientCard'), flash = $('orientFlash');
  if (card) { card.classList.remove('stepAnim'); void card.offsetWidth; card.classList.add('stepAnim'); }
  if (flash) { flash.classList.remove('slash'); void flash.offsetWidth; flash.classList.add('slash'); }
}

function setOrientStep(idx) {
  if (idx >= ORIENT_STEPS.length) {
    // 最後まで終わったらループせずスタート画面(#menu)に戻る
    exitOrientation(false);
    return;
  }
  orientState.step = clamp(idx, 0, ORIENT_STEPS.length - 1);
  orientState.elapsed = 0;
  orientStepSfx(orientState.step === 0 || orientState.step === ORIENT_STEPS.length - 1);
  renderOrientStepUI();
  setupOrientStepScene(orientState.step);
}

function toggleOrientPause() {
  if (state.phase !== 'orientation') return;
  state.paused = !state.paused;
  const btn = $('orientPauseBtn');
  if (btn) {
    btn.textContent = state.paused ? '再開' : '停止';
    btn.classList.toggle('paused', state.paused);
  }
}

function startOrientation() {
  initAudio();
  playBgm('orientation');
  state.phase = 'orientation'; state.t = -50; state.paused = false; state.pFinish = null; state.firstFinish = null; state.resultShown = false; state.ff = false; state.pAI = null;
  // オリエンテーション動画は複数パターン不要・常に「八景島の北風(15°・9kt・トラペゾイド・5°上有利)」の1パターンに固定
  setFixedStartLine(5);
  setCourseMode('trapezoid');
  const { bias } = computeSideBias('hakkeijima', 15);
  setWindParams(9, bias);
  world.setVenue('hakkeijima', 15, bias);
  applySea(15, 9);
  rebuildObstacles();
  if (world.setCourseVisible) world.setCourseVisible(true);
  makeFleet(true);
  const pBtn = $('orientPauseBtn');
  if (pBtn) { pBtn.textContent = '停止'; pBtn.classList.remove('paused'); }
  document.body.classList.remove('menuOpen');
  document.body.classList.add('orientOpen');
  cam.menuOffset = false; cam.mode = 0; cam.inited = false;
  $('menu').classList.add('hidden'); $('result').classList.add('hidden'); $('hud').classList.remove('hidden'); $('orientation').classList.remove('hidden');
  setOrientStep(0);
}

function exitOrientation(toRace = false) {
  clearOrientHighlight();
  stopBgm();
  state.paused = false;
  const pBtn = $('orientPauseBtn');
  if (pBtn) { pBtn.textContent = '停止'; pBtn.classList.remove('paused'); }
  document.body.classList.remove('orientOpen');
  $('orientation').classList.add('hidden');
  if (toRace) {
    startRace();
  } else {
    $('result').classList.add('hidden'); $('hud').classList.remove('hidden'); $('menu').classList.remove('hidden');
    state.phase = 'menu'; document.body.classList.add('menuOpen'); cam.menuOffset = true;
    randomizeStartLine();
    applyVenue();
    makeFleet(true);
    cam.inited = false; cam.yaw = 0; cam.pitch = 0;
    if (player) cam.update(0, performance.now() / 1000, player, boats);
    playBgm('menu');
  }
}

function orientationStep(dt, time) {
  if (!player) return;
  const st = ORIENT_STEPS[orientState.step];
  orientState.elapsed += dt;
  const fill = $('orientTimerFill');
  if (fill) fill.style.width = `${clamp((orientState.elapsed / st.dur) * 100, 0, 100).toFixed(1)}%`;

  const prev = state.t;
  state.t += dt;
  const idx = orientState.step;

  // 各ステップごとの自動デモンストレーション操船 (cam.targetYaw / cam.targetPitch も同期してフレーム時間変動によるカメラ揺れを防止)
  if (idx === 0) {
    // STEP 1: 海上のSTART LINE＆有利サイド表記が画面中央にはっきり映るよう穏やかな艇速でキープ
    player.throttle = 0.20;
    player.sheet = sheetOpt(player.twa);
    player.steer = clamp(wrap((W0 - 0.30) - player.h) * 2.2, -0.6, 0.6);
    cam.yaw = cam.targetYaw = 0.06 + Math.sin(orientState.elapsed * 0.30) * 0.04;
    cam.pitch = cam.targetPitch = -0.03;
  } else if (idx === 1) {
    // STEP 2: 風上へ上してセールを出してスピード調整 → 後半(5.0s〜6.2s)で滑らかにベアして加速 (ステップ切り替え時のカクつきを防止)
    const uBear = clamp((orientState.elapsed - 5.0) / 1.2, 0, 1);
    const sBear = uBear * uBear * (3 - 2 * uBear);
    const tgtAngle = 0.42 + (0.73 - 0.42) * sBear;
    const tgtH = wrap(W0 - tgtAngle);
    player.steer = clamp(wrap(tgtH - player.h) * 2.2, -0.65, 0.65);
    const tgtSheet = 0.16 + (sheetOpt(player.twa) - 0.16) * sBear;
    player.sheet += (tgtSheet - player.sheet) * (1 - Math.exp(-dt * 5));
    player.throttle = 0.26 + (0.95 - 0.26) * sBear;
    cam.yaw = cam.targetYaw = -0.42 + Math.sin(orientState.elapsed * 0.40) * 0.10;
    cam.pitch = cam.targetPitch = -0.02;
  } else if (idx === 2) {
    // STEP 3: カウントダウン → 0:00に合わせてスタートライン手前に余裕を持って加速しスタート！
    player.throttle = 1.0;
    player.sheet = sheetOpt(0.73);
    player.steer = clamp(wrap((W0 - 0.73) - player.h) * 4.0, -1, 1);
    const bestV = 3.15 * SPEED_SCALE;
    if (player.v < bestV) player.v = bestV;
    cam.yaw = cam.targetYaw = 0.22;
    cam.pitch = cam.targetPitch = 0.04;
  } else if (idx === 3) {
    // STEP 4: クローズホールド 38°〜44° + ブローで少し上す動き
    const inPuff = orientState.elapsed > 2.5 && orientState.elapsed < 7.2;
    const optRad = ((inPuff ? 39.0 : 42.6) * Math.PI) / 180;
    const tgtH = wrap(player.windFrom - player.tack * optRad);
    player.steer = clamp(wrap(tgtH - player.h) * 3.2, -1, 1);
    player.sheet = sheetOpt(player.twa);
    player.throttle = 1.0;
    cam.yaw = cam.targetYaw = -0.38;
    cam.pitch = cam.targetPitch = -0.03;
  } else if (idx === 4) {
    // STEP 5: タック判断 → オートタック実演
    if (orientState.elapsed > 3.2 && !orientState.subDone) {
      orientState.subDone = true;
      player.startManeuver('tack');
    }
    if (!player.maneuver) {
      const tgtH = wrap(player.windFrom - player.tack * 0.73);
      player.steer = clamp(wrap(tgtH - player.h) * 3.0, -1, 1);
    }
    player.sheet = sheetOpt(player.twa);
    player.throttle = 1.0;
    cam.yaw = cam.targetYaw = 0.15;
    cam.pitch = cam.targetPitch = 0.04;
  } else if (idx === 5) {
    // STEP 6: 前半(0〜4.8s)＝上マーク(1a)回航直後にランチャーUP ／ 後半(4.8s〜)＝4Sマーク(MARKS.gL)回航前にランチャーDOWN → クローズの角度に上した時に4Sマークが右舷真横にあるきれいなアウト・イン・アウト回航
    if (orientState.elapsed >= 0.55 && !orientState.poleUpDone) {
      orientState.poleUpDone = true;
      player.setPole(true);
      poleClank(true);
    }
    if (orientState.elapsed >= 4.8 && !orientState.phase2) {
      orientState.phase2 = true;
      player.pole = true; player.poleK = 1;
      player.leg = Math.min(2, LEGS.length - 1); // 4ゲート(4S/4P)レグにして4Sマークと看板を表示
      cam.inited = false;
    }
    if (!orientState.phase2) {
      const tgtH = wrap(W0 + 2.66);
      player.steer = clamp(wrap(tgtH - player.h) * 2.6, -1, 1);
      player.sheet = sheetOpt(player.twa);
      player.throttle = 1.0;
      cam.yaw = cam.targetYaw = 0.56 + Math.sin(orientState.elapsed * 0.35) * 0.08;
      cam.pitch = cam.targetPitch = 0.03;
    } else {
      if (orientState.elapsed >= 5.5 && !orientState.subDone) {
        orientState.subDone = true;
        player.setPole(false);
        poleClank(false);
      }
      // 4Sマーク(MARKS.gL: 右舷回航＝時計回り)のアウト・イン・アウト回航軌道:
      // ゲート内側(c > gL.c)から進入し、スターボード・クローズホールド角度(theta1 = -0.73 rad ≒ -41.8°)に上し切った瞬間に、
      // 4Sマーク(gL)が右舷真横(90° abeam, 距離3.0m)に来る円弧軌道
      const gL = MARKS.gL || MARKS.m3;
      const theta0 = -(Math.PI - 0.12); // 進入角 (約-173° スターボード・ランニング)
      const theta1 = -0.73;             // 脱出クローズホールド角 (約-41.8° スターボード・クローズ)
      const R_turn = 8.4;               // 回航旋回半径 [m]
      const R_abeam = 3.0;              // クローズに上した瞬間のマーク真横クリアランス [m]
      const centerA = gL.a - (R_turn - R_abeam) * Math.sin(theta1);
      const centerC = gL.c + (R_turn - R_abeam) * Math.cos(theta1);
      const L_arc = R_turn * (theta1 - theta0);
      const vRound = 3.22 * SPEED_SCALE;
      const t2 = orientState.elapsed - 4.8;
      const s = (t2 - 1.55) * vRound;
      let desA, desC, theta, steerCmd = 0;
      if (s < 0) {
        theta = theta0;
        const a0 = centerA + R_turn * Math.sin(theta0);
        const c0 = centerC - R_turn * Math.cos(theta0);
        desA = a0 + s * Math.cos(theta0);
        desC = c0 + s * Math.sin(theta0);
        steerCmd = 0;
      } else if (s <= L_arc) {
        theta = theta0 + s / R_turn;
        desA = centerA + R_turn * Math.sin(theta);
        desC = centerC - R_turn * Math.cos(theta);
        steerCmd = 0.52;
      } else {
        theta = theta1;
        const a1 = centerA + R_turn * Math.sin(theta1);
        const c1 = centerC - R_turn * Math.cos(theta1);
        desA = a1 + (s - L_arc) * Math.cos(theta1);
        desC = c1 + (s - L_arc) * Math.sin(theta1);
        steerCmd = 0;
      }
      player.leg = Math.min(2, LEGS.length - 1); // 4Sの表示を維持
      orientState._m3Sync = { a: desA, c: desC, h: wrap(W0 + theta), v: vRound, steer: steerCmd, twa: Math.abs(theta) };
      player.steer = steerCmd;
      player.sheet = sheetOpt(Math.abs(theta));
      player.throttle = 1.0;
      cam.yaw = cam.targetYaw = 0.22;
      cam.pitch = cam.targetPitch = 0.05;
    }
  } else if (idx === 6) {
    // STEP 7: 下マーク回航後 → フィニッシュを目指し、フィニッシュラインを切った瞬間にホーンを鳴らす
    const tgtH = wrap(player.windFrom - player.tack * 0.72);
    player.steer = clamp(wrap(tgtH - player.h) * 3.0, -1, 1);
    player.sheet = sheetOpt(player.twa);
    player.throttle = 1.0;
    cam.yaw = cam.targetYaw = -0.18;
    cam.pitch = cam.targetPitch = 0.02;
  } else if (idx === 7) {
    // STEP 8: フィニッシュ後の結果画面＆振り返り紹介
    const tgtH = wrap(player.windFrom - player.tack * 0.73);
    player.steer = clamp(wrap(tgtH - player.h) * 3.0, -1, 1);
    player.sheet = sheetOpt(player.twa);
    player.throttle = 1.0;
    cam.yaw += dt * 0.28;
    cam.targetYaw = cam.yaw;
    cam.pitch = cam.targetPitch = 0.16;
  }

  if (player.tack !== state.lastTack) { if (state.lastTack !== undefined) sailFlog(0.85); state.lastTack = player.tack; }
  // オリエンテーション02では他艇の風影変動による艇速・ヒールの揺れを防ぐため自艇をクリアエアに保つ
  computeBlanket(idx === 1 ? [player] : boats);
  for (const b of boats) {
    b.update(dt, state.t, boats);
    if (idx === 2) {
      // STEP 3: ベストスピードを維持しつつ、0:00の瞬間にスタートライン手前に余裕(艇中心-5.4m / バウ先端約-3.6m)がある軌道に同期
      const bestV = Math.max(b.v, 3.15 * SPEED_SCALE);
      b.v = bestV;
      if (b.isPlayer && state.t <= 0.05) {
        const vA = bestV * Math.cos(0.73);
        const vC = -bestV * Math.sin(0.73);
        const cCross = 16;
        const aCross = lineA(cCross) - 5.4;
        const desiredA = aCross + state.t * vA;
        const desiredC = cCross + state.t * vC;
        const pSync = toWorld(desiredA, desiredC);
        b.x = pSync.x;
        b.z = pSync.z;
        b.a = desiredA;
        b.c = desiredC;
        b.ocs = false;
      } else if (!b.isPlayer && state.t <= 0.05) {
        const cur = toCourse(b.x, b.z);
        const vUp = bestV * Math.cos(0.73);
        const desiredA = lineA(cur.c) - 6.2 + state.t * vUp;
        const pSync = toWorld(desiredA, cur.c);
        b.x = pSync.x;
        b.z = pSync.z;
        b.ocs = false;
      }
    } else if (idx === 5 && orientState.phase2 && b.isPlayer && orientState._m3Sync) {
      const ms = orientState._m3Sync;
      const pSync = toWorld(ms.a, ms.c);
      b.x = pSync.x;
      b.z = pSync.z;
      b.a = ms.a;
      b.c = ms.c;
      b.h = ms.h;
      b.v = ms.v;
      b.steer = ms.steer;
      b.rel = wrap(b.windFrom - b.h);
      b.twa = Math.abs(b.rel);
      b.effTwaDeg = (b.twa * 180) / Math.PI;
      b.tack = b.rel >= 0 ? 1 : -1;
      b.sOpt = sheetOpt(b.twa);
      b.sheet = b.sOpt;
      b.heel = -b.tack * Math.sin(b.twa) * 0.20;
    }
    if (!(idx === 5 && orientState.phase2)) updateProgress(b, state.t);
    if (idx === 6) {
      // フィニッシュラインの表示が消えないよう finished フラグは抑止しつつ、バウがフィニッシュラインを切った瞬間にホーンを鳴らす
      b.finished = false;
      if (b.isPlayer && !orientState.subDone) {
        const F = MARKS.fcom, G = MARKS.fm;
        const bowA = b.a + Math.cos(b.h - W0) * 1.65;
        const bowC = b.c + Math.sin(b.h - W0) * 1.65;
        const sideNow = (G.a - F.a) * (bowC - F.c) - (G.c - F.c) * (bowA - F.a);
        if (sideNow * orientState.finSign0 <= 0) {
          orientState.subDone = true;
          signalHorn('short');
        }
      }
    }
  }
  if (idx === 2) signals(prev, state.t);

  if (orientState.elapsed >= st.dur) {
    if (orientState.step < ORIENT_STEPS.length - 1) setOrientStep(orientState.step + 1);
    else exitOrientation(false); // 最後まで終わったらスタート画面へ戻る
  }
}
const SIGS = [[-60, 'down'], [0, 'gun']];
function signals(prevT, t) {
  for (const [st, k] of SIGS) if (prevT < st && t >= st) {
    if (k === 'gun') {
      signalHorn('short');
      atGun();
      if (state.phase === 'race') playBgm(cfg.venue === 'hakkeijima' ? 'race_hakkeijima' : 'race_enoshima');
    } else signalHorn('long');
  }
  const c = Math.ceil(-t);
  if (t < 0 && t > -6 && c !== state.count) { state.count = c; beep(c <= 1 ? 1200 : 880); }
}
function atGun() {
  let anyOcs = false;
  for (let i = 0; i < boats.length; i++) {
    const b = boats[i];
    const ai = !b.isPlayer ? ais.find((a) => a.b === b) : null;
    if (b.a > lineA(b.c) || (ai && ai.willOcs && b.a > lineA(b.c) - 2.5)) {
      if (b.a <= lineA(b.c)) b.a = lineA(b.c) + 0.5;
      b.ocs = true;
      anyOcs = true;
    }
  }
  if (anyOcs) {
    // リコール艇がいる場合: RRS規則29.1(個別リコール)に基づき本部船にX旗を掲揚し、追加のホーン1回(スタート号砲と合わせて明確に計2回)を鳴らす(文字通知は出さない)
    if ((state.phase === 'race' || state.phase === 'orientation') && !state.paused && !state.ff) {
      signalHorn('recall');
    }
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
// クローズホールド(対風角30°〜50°)走行中は、風の振れに対して同じ対風角を保つよう自動追従操舵を行う(手動操舵時は即座に手動優先)
let hTarget = null, hErrT = 0;
const steerHold = { L: 0, R: 0 };
const closeHoldLock = {
  active: false,
  twa: 0,
  tack: 1,
  prevWind: null,
  anchorWind: 0,
  windRate: 0,
  manualSettleT: 0,
  autoDir: 0,
  holdT: 0,
};

function syncSteerButtonsUI(manualL, manualR, autoDir) {
  if (state.phase === 'orientation') return;
  const btnL = $('tLeft'), btnR = $('tRight');
  if (btnL) {
    const isAutoL = !manualL && !manualR && autoDir < 0;
    const isOnL = manualL || isAutoL;
    if (btnL.classList.contains('on') !== isOnL) btnL.classList.toggle('on', isOnL);
    if (btnL.classList.contains('autoSteer') !== isAutoL) btnL.classList.toggle('autoSteer', isAutoL);
  }
  if (btnR) {
    const isAutoR = !manualL && !manualR && autoDir > 0;
    const isOnR = manualR || isAutoR;
    if (btnR.classList.contains('on') !== isOnR) btnR.classList.toggle('on', isOnR);
    if (btnR.classList.contains('autoSteer') !== isAutoR) btnR.classList.toggle('autoSteer', isAutoR);
  }
}

function resetCloseHoldLock() {
  closeHoldLock.active = false;
  closeHoldLock.twa = 0;
  closeHoldLock.tack = 1;
  closeHoldLock.prevWind = null;
  closeHoldLock.anchorWind = 0;
  closeHoldLock.windRate = 0;
  closeHoldLock.manualSettleT = 0;
  closeHoldLock.autoDir = 0;
  closeHoldLock.holdT = 0;
  syncSteerButtonsUI(false, false, 0);
}

function playerControl(dt) {
  const b = player, DEG = Math.PI / 180;
  const CLOSE_MIN = 30 * DEG, CLOSE_MAX = 50 * DEG;
  const L = keys.has('ArrowLeft') || keys.has('ArrowLeft_Touch') || keys.has('KeyA'), R = keys.has('ArrowRight') || keys.has('ArrowRight_Touch') || keys.has('KeyD');
  const isUpwindAutoLeg = state.phase === 'race'
    && state.t >= 0
    && !b.ocs
    && (COURSE_MODE === 'upwind' ? b.leg === 0 : (b.leg === 0 || b.leg === 3));
  const canAutoClose = isUpwindAutoLeg
    && !b.maneuver && !b.tacking && !b.penalty && !b.pole && !b.capsized && !b.finished && !b.dsq;

  const curWind = Number.isFinite(b.windFrom) ? b.windFrom : W0;
  const dWind = closeHoldLock.prevWind !== null ? wrap(curWind - closeHoldLock.prevWind) : 0;
  closeHoldLock.prevWind = curWind;
  const instWindRate = dt > 1e-4 ? dWind / dt : 0;
  closeHoldLock.windRate += (instWindRate - closeHoldLock.windRate) * (1 - Math.exp(-dt * 9.0));
  if (closeHoldLock.manualSettleT > 0) closeHoldLock.manualSettleT = Math.max(0, closeHoldLock.manualSettleT - dt);

  if (hTarget === null || b.maneuver || Math.abs(wrap(hTarget - b.h)) > 0.28) {
    hTarget = b.h;
    closeHoldLock.active = false;
    closeHoldLock.autoDir = 0;
    closeHoldLock.holdT = 0;
  } else if (b.aeroClimb && !L && !R && !closeHoldLock.active) {
    hTarget = wrap(hTarget + b.aeroClimb); // リーバウ・別タック後方通過リフト時の自然な風上のぼせを目標針路にも反映
  }

  if (L || R) {
    steerHold.L = L ? steerHold.L : 0;
    steerHold.R = R ? steerHold.R : 0;
    for (const [on, k, s] of [[L, 'L', -1], [R, 'R', 1]]) {
      if (on) {
        if (steerHold[k] === 0) hTarget = wrap(hTarget + s * DEG); // タップ = 1°
        steerHold[k] += dt;
        if (steerHold[k] > 0.25) hTarget = wrap(hTarget + s * Math.min(60, 20 + (steerHold[k] - 0.25) * 60) * DEG * dt);
      }
    }
    closeHoldLock.autoDir = 0;
    closeHoldLock.holdT = 0;
    closeHoldLock.manualSettleT = 0.42;
    if (canAutoClose) {
      const tgtRel = wrap(curWind - hTarget);
      const tgtTwa = Math.abs(tgtRel);
      const actualTwa = Math.abs(wrap(curWind - b.h));
      if (tgtTwa >= CLOSE_MIN && tgtTwa <= CLOSE_MAX && actualTwa >= CLOSE_MIN - 2 * DEG && actualTwa <= CLOSE_MAX + 2 * DEG) {
        closeHoldLock.active = true;
        closeHoldLock.twa = tgtTwa;
        closeHoldLock.tack = tgtRel >= 0 ? 1 : -1;
        closeHoldLock.anchorWind = curWind;
      } else {
        closeHoldLock.active = false;
      }
    } else {
      closeHoldLock.active = false;
    }
  } else {
    steerHold.L = 0;
    steerHold.R = 0;
    if (!canAutoClose) {
      closeHoldLock.active = false;
      closeHoldLock.autoDir = 0;
      closeHoldLock.holdT = 0;
    } else {
      if (!closeHoldLock.active) {
        // 手動操作後に30°〜50°のクローズホールドへ収まったら現在の対風角をロック
        if (b.twa >= CLOSE_MIN && b.twa <= CLOSE_MAX && Math.abs(wrap(hTarget - b.h)) < 0.06) {
          closeHoldLock.active = true;
          closeHoldLock.twa = b.twa;
          closeHoldLock.tack = b.tack || (wrap(curWind - b.h) >= 0 ? 1 : -1);
          closeHoldLock.anchorWind = curWind;
          closeHoldLock.manualSettleT = 0.25;
        }
      }
      if (closeHoldLock.active) {
        const desH = wrap(curWind - closeHoldLock.tack * closeHoldLock.twa);
        const windErr = wrap(desH - b.h);
        // 衝突やブローチ等で反対タックや大きく外れた角度へ飛ばされた場合はロック解除
        if ((b.tack !== closeHoldLock.tack && b.twa > 12 * DEG) || Math.abs(windErr) > 38 * DEG) {
          closeHoldLock.active = false;
          closeHoldLock.autoDir = 0;
          closeHoldLock.holdT = 0;
        } else {
          hTarget = wrap(b.h + clamp(windErr, -0.12, 0.12));
          if (closeHoldLock.manualSettleT > 0 && Math.abs(wrap(curWind - closeHoldLock.anchorWind)) > 0.20 * DEG) {
            closeHoldLock.manualSettleT = 0;
          }
          const activelyFollowingShift = closeHoldLock.manualSettleT <= 0
            && (Math.abs(windErr) > 0.20 * DEG || Math.abs(closeHoldLock.windRate) > 0.14 * DEG);
          if (activelyFollowingShift) {
            const dir = Math.abs(windErr) > 0.16 * DEG ? Math.sign(windErr) : Math.sign(closeHoldLock.windRate);
            if (dir !== 0) {
              closeHoldLock.autoDir = dir;
              closeHoldLock.holdT = 0.24;
            }
          } else if (closeHoldLock.holdT > 0) {
            closeHoldLock.holdT = Math.max(0, closeHoldLock.holdT - dt);
            if (closeHoldLock.holdT <= 0) closeHoldLock.autoDir = 0;
          } else {
            closeHoldLock.autoDir = 0;
          }
        }
      }
    }
  }

  let err = wrap(hTarget - b.h);
  if (Math.abs(err) > 0.12) { hTarget = wrap(b.h + Math.sign(err) * 0.12); err = wrap(hTarget - b.h); } // 目標針路の先行を約7°に制限(舵の慣性を抑える)
  // ランチャー制限などで目標針路へ向けない状態が続いたら目標を現在の針路に合わせる
  if (!L && !R && !closeHoldLock.active && Math.abs(err) > 0.05) { hErrT += dt; if (hErrT > 3) { hTarget = b.h; hErrT = 0; } } else hErrT = 0;
  if (!b.maneuver) b.steer = clamp(err * 10, -1, 1);
  syncSteerButtonsUI(L, R, closeHoldLock.active && closeHoldLock.holdT > 0 ? closeHoldLock.autoDir : 0);

  const up = keys.has('ArrowUp') || keys.has('KeyW'), dn = keys.has('ArrowDown') || keys.has('KeyS');
  b.pullingSheet = up;
  b.easingSheet = dn;
  if (autoTrim) {
    let tg = b.sOpt;
    if (dn) tg = Math.max(0.05, b.sOpt - 0.55);
    else if (up) tg = Math.min(1, b.sOpt + 0.62);
    const rate = up ? 6.8 : 3.0;
    b.sheet += (tg - b.sheet) * (1 - Math.exp(-dt * rate));
  } else {
    if (up) b.sheet = Math.min(1, b.sheet + dt * 1.35);
    if (dn) b.sheet = Math.max(0.05, b.sheet - dt * 0.7);
  }
}

function handlePlayerSailingEvents(b) {
  if (!b || state.ff) return;
  if (b.justWildGybed) {
    b.justWildGybed = false;
    sailFlog(1.25);
    thud(0.75, 0.88);
  }
}

// スタート画面(メニュー)表示中または練習モード中の航行ステップ
function practiceStep(dt, time) {
  if (!player) return;
  playerControl(dt);
  if (player.maneuverStarted) player.maneuverStarted = null;
  if (player.tack !== state.lastTack) { if (state.lastTack !== undefined && state.phase !== 'menu') sailFlog(0.85); state.lastTack = player.tack; }
  if (player.pole !== state.lastPole) { if (state.lastPole !== undefined) poleClank(player.pole); state.lastPole = player.pole; }
  computeBlanket(boats);
  player.update(dt, time, boats);
  handlePlayerSailingEvents(player);
  if (state.phase === 'menu' && player.twa < 0.68 && !player.capsized) {
    player.v = Math.max(player.v, 2.1 * SPEED_SCALE);
    player.luff = 0;
  }
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
  handlePlayerSailingEvents(player);
  for (const e of resolveCollisions(boats, t)) { if (recorder) recorder.event(e, t); handleCollision(e); }
  checkRightOfWayHails(dt);
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
    if (b.ocs && t >= 0 && b.a < lineA(b.c) - 2) { b.ocs = false; }
    if (b.penaltyDone) { b.penaltyDone = false; if (b.isPlayer && !state.ff) toast('ペナルティ消化', 'good', 3000); }
  }
  if (recorder) recorder.step(dt, t, boats, progressOf, lineA);
}

// 自艇フィニッシュ後: 背景で3マーク側から後続艇が次々とフィニッシュしてくるライブ映像をそのまま継続できるよう、
// 現在の各艇・AIの状態をスナップショット保存した上で早送り計測を行い、リザルト＆振り返り確定後にライブ状態を復元する
let _liveFinishSnap = null;
function snapshotLiveFleet() {
  return {
    t: state.t,
    firstFinish: state.firstFinish,
    rs,
    boats: boats.map((b) => ({
      x: b.x, z: b.z, h: b.h, v: b.v, steer: b.steer, sheet: b.sheet, throttle: b.throttle,
      tack: b.tack, tacking: b.tacking, tackTimer: b.tackTimer, tackCount: b.tackCount, gybeCount: b.gybeCount,
      rel: b.rel, twa: b.twa, effTwaDeg: b.effTwaDeg, byTheLee: b.byTheLee, windFrom: b.windFrom, windF: b.windF,
      maneuver: b.maneuver ? { ...b.maneuver } : null,
      penalty: b.penalty ? { ...b.penalty } : null,
      penaltyDone: b.penaltyDone, penaltyExpired: b.penaltyExpired, penaltyUpgraded: b.penaltyUpgraded,
      leg: b.leg, ocs: b.ocs, started: b.started, finished: b.finished, finishTime: b.finishTime, finishHeading: b.finishHeading, finishTack: b.finishTack, postFinishStop: b.postFinishStop, late: b.late,
      a: b.a, c: b.c, visit: b.visit ? { ...b.visit } : null,
      contactCD: b.contactCD, touchCD: b.touchCD, heel: b.heel, rollBias: b.rollBias, hike: b.hike, turned: b.turned,
      sOpt: b.sOpt, luff: b.luff, stall: b.stall, cover: b.cover, coverT: b.coverT, back: b.back, backT: b.backT,
      waveF: b.waveF, waveH: b.waveH, waveSlope: b.waveSlope, waveLoss: b.waveLoss,
      windBend: b.windBend, windBendT: b.windBendT, flowBoost: b.flowBoost, flowBoostT: b.flowBoostT,
      aeroTag: b.aeroTag, aeroClimb: b.aeroClimb, awa: b.awa, aws: b.aws, awx: b.awx, awz: b.awz,
      dnf: b.dnf, dsq: b.dsq, dsqReason: b.dsqReason, pole: b.pole, poleK: b.poleK, gybePoleRestore: b.gybePoleRestore,
      rudderDrag: b.rudderDrag, snagCD: b.snagCD, wakeWave: b.wakeWave,
    })),
    ais: ais.map((ai) => ({ ...ai })),
  };
}
function restoreLiveFleet(snap) {
  if (!snap) return;
  state.t = snap.t;
  state.firstFinish = snap.firstFinish;
  rs = snap.rs;
  for (let i = 0; i < boats.length && i < snap.boats.length; i++) {
    Object.assign(boats[i], snap.boats[i]);
  }
  for (let i = 0; i < ais.length && i < snap.ais.length; i++) {
    Object.assign(ais[i], snap.ais[i]);
  }
}
function fastForwardFinishers() {
  _liveFinishSnap = snapshotLiveFleet();
  const limit = Math.min(RACE_LIMIT, (state.firstFinish ?? state.t) + FINISH_WINDOW);
  state.ff = true;
  let guard = 0;
  while (state.t < limit && boats.some((b) => !b.finished) && guard++ < 20000) simStep(1 / 30);
  state.ff = false;
}

// ---------- 戦績データ管理 (方式A: localStorage + 振り返りスナップショット保存) ----------
const RECORDS_KEY = 'snipe-records-v1';
const REVIEWS_KEY = 'snipe-reviews-v1';
function loadRaceRecords() {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}
function loadReviewSnapshots() {
  try {
    const raw = localStorage.getItem(REVIEWS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (e) {
    return {};
  }
}
function saveReviewSnapshot(revId, snap) {
  if (!revId || !snap) return;
  try {
    const map = loadReviewSnapshots();
    map[revId] = snap;
    // localStorage容量を圧迫しないよう直近15レース分のフルリプレイを保持
    const keys = Object.keys(map).sort();
    while (keys.length > 15) {
      const oldKey = keys.shift();
      delete map[oldKey];
    }
    localStorage.setItem(REVIEWS_KEY, JSON.stringify(map));
  } catch (e) {}
}
function saveRaceRecord(entry, revSnap = null) {
  try {
    const revId = `rv_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const recordWithId = { ...entry, revId };
    if (revSnap) saveReviewSnapshot(revId, revSnap);
    const list = loadRaceRecords();
    list.unshift(recordWithId);
    if (list.length > 100) list.length = 100;
    localStorage.setItem(RECORDS_KEY, JSON.stringify(list));
  } catch (e) {}
}
function openReviewFromRecord(r) {
  if (!r) return;
  const fallbackOpts = {
    marks: MARKS,
    courseMode: String(r.course || '').includes('上マーク') ? 'upwind' : 'trapezoid',
    legs: LEGS,
    speedScale: SPEED_SCALE,
    kt: KT,
    returnBgm: state.phase === 'menu' ? 'menu' : 'result',
  };
  const snaps = loadReviewSnapshots();
  const snap = r.revId && snaps[r.revId] ? snaps[r.revId] : null;
  const restored = snap
    ? deserializeReviewSnapshot(snap, fallbackOpts)
    : buildFallbackReviewFromRecord(r, fallbackOpts);
  if (restored && restored.rec) {
    openReview(restored.rec, restored.o);
  }
}
function renderRecordsModal() {
  const list = loadRaceRecords();
  const sumEl = $('recordsSummary');
  const bodyEl = $('recordsBody');
  if (!sumEl || !bodyEl) return;

  const total = list.length;
  const validRanks = list.filter((r) => typeof r.rank === 'number' && r.rank >= 1);
  const wins = validRanks.filter((r) => r.rank === 1).length;
  const podiums = validRanks.filter((r) => r.rank <= 3).length;
  const avgRank = validRanks.length > 0
    ? (validRanks.reduce((acc, r) => acc + r.rank, 0) / validRanks.length).toFixed(1) + '位'
    : '−';

  sumEl.innerHTML =
    `<div class="recStat rateStat"><span>現在レート</span><b>${rateData.rate}</b></div>` +
    `<div class="recStat rateStat"><span>最高レート</span><b>${rateData.peakRate}</b></div>` +
    `<div class="recStat"><span>総出走数</span><b>${total}回</b></div>` +
    `<div class="recStat"><span>1位回数</span><b>${wins}回</b></div>` +
    `<div class="recStat"><span>3位以内</span><b>${podiums}回</b></div>` +
    `<div class="recStat"><span>平均着順</span><b>${avgRank}</b></div>`;

  if (list.length === 0) {
    bodyEl.innerHTML = `<tr><td colspan="9" class="recordsEmpty">まだ戦績記録がありません。レースをフィニッシュすると自動的に記録されます。</td></tr>`;
    return;
  }
  bodyEl.innerHTML = list.map((r, idx) => {
    const rankStr = r.status === 'DSQ' ? 'DSQ' : r.status === 'DNF' ? 'DNF' : `${r.rank}位 / ${r.fleet || 24}艇`;
    const isWin = r.rank === 1;
    let rateCellHtml = '<span class="rateDeltaZero">OFF</span>';
    if (typeof r.rateAfter === 'number' && typeof r.rateBefore === 'number') {
      const diff = r.rateAfter - r.rateBefore;
      const sign = diff > 0 ? `+${diff}` : String(diff);
      const cls = diff > 0 ? 'rateDeltaPlus' : diff < 0 ? 'rateDeltaMinus' : 'rateDeltaZero';
      rateCellHtml = `${r.rateBefore} → <b>${r.rateAfter}</b> <span class="${cls}">(${sign})</span>`;
    }
    return `<tr class="${isWin ? 'me' : ''}">` +
      `<td>${r.date || '−'}</td>` +
      `<td>${r.venue || '−'}</td>` +
      `<td>${r.course || '−'}</td>` +
      `<td>${r.wind || '−'}</td>` +
      `<td>${rankStr}</td>` +
      `<td>${rateCellHtml}</td>` +
      `<td>${r.time || '−'}</td>` +
      `<td>${r.avgKt ? r.avgKt + 'kt' : '−'}</td>` +
      `<td><button type="button" class="btnSec btnSm recRevBtn" data-idx="${idx}">振り返り</button></td>` +
      `</tr>`;
  }).join('');
  for (const btn of bodyEl.querySelectorAll('.recRevBtn')) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const idx = +btn.dataset.idx;
      if (list[idx]) openReviewFromRecord(list[idx]);
    };
  }
}
function openRecordsModal() {
  renderRecordsModal();
  const m = $('recordsModal');
  if (m) m.classList.remove('hidden');
}
function closeRecordsModal() {
  const m = $('recordsModal');
  if (m) m.classList.add('hidden');
}

// ---------- スプラトゥーン風レート演出 ＆ スマブラ風新キャラ解放演出 ----------
let rateAnimTimer = null;
let challengerPv = null;
let challengerQueue = [];

function ensureChallengerPreview() {
  if (challengerPv) return challengerPv;
  const cv = $('challengerCanvas');
  if (!cv) return null;
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
  r.setSize(280, 280, false);
  r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x335577, 2.4));
  const dl = new THREE.DirectionalLight(0xfff4d0, 2.4);
  dl.position.set(2.5, 4.2, 3.5);
  sc.add(dl);
  const cm = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
  cm.position.set(0, 0.48, 2.95);
  cm.lookAt(0, 0.42, 0);
  const g = new THREE.Group();
  sc.add(g);
  challengerPv = { r, sc, cm, g, fig: null, baseScale: 1.0, active: false };
  return challengerPv;
}

function showNextChallengerInQueue() {
  const overlay = $('challengerOverlay');
  if (!overlay) return;
  if (challengerQueue.length === 0) {
    overlay.classList.add('hidden');
    if (challengerPv) challengerPv.active = false;
    return;
  }
  const spec = challengerQueue.shift();
  const nameEl = $('challengerName');
  const noteEl = $('challengerJpNote');
  if (nameEl) nameEl.textContent = spec.splashName || spec.id;
  if (noteEl) noteEl.textContent = `レート${spec.unlockRate}達成！「${spec.label}」がスキッパー・クルーとして使用可能になりました！`;

  const cpv = ensureChallengerPreview();
  if (cpv) {
    cpv.g.clear();
    const st = { skin: hexNum(cfg.skin), shirt: hexNum(cfg.shirt), hat: hexNum(cfg.hat), jacket: PLAYER_BIB };
    const fig = buildFigure(spec.id, st);
    // 耳の長いウサギや尾びれのあるイルカ等も見切れないよう円形枠内に余裕をもって収める
    const bScale = spec.id === 'rabbit' ? 0.90 : spec.id === 'dolphin' ? 0.96 : 1.02;
    const yOff = spec.id === 'rabbit' ? -0.06 : -0.01;
    fig.position.set(0, yOff, 0);
    fig.scale.setScalar(bScale);
    fig.rotation.y = Math.PI + 0.28;
    cpv.g.add(fig);
    cpv.fig = fig;
    cpv.baseScale = bScale;
    cpv.baseY = yOff;
    cpv.active = true;
    cpv.r.render(cpv.sc, cpv.cm);
  }
  buildChoices('helmChoices', 'helm');
  buildChoices('crewChoices', 'crew');
  overlay.classList.remove('hidden');
  playChallengerSplashSound(spec.id);
}

function runSplatoonRateAnimation(info, newlyUnlocked) {
  const box = $('resRateBox');
  if (!box) return;
  if (rateAnimTimer) { clearInterval(rateAnimTimer); rateAnimTimer = null; }
  if (!info || !info.active) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const { before, entryCost, rankBonus, after, netDelta, isUpwind, placeLabel } = info;
  const subEl = $('resRateCourseSub');
  const valEl = $('resRateVal');
  const deltaEl = $('resRateDelta');
  const entryEl = $('resRateEntryChip');
  const rewardEl = $('resRateRewardChip');
  const baseBar = $('resRateBarBase');
  const diffBar = $('resRateBarDiff');
  const floorEl = $('resRateFloor');
  const ceilEl = $('resRateCeil');

  if (subEl) subEl.textContent = isUpwind ? '上マークF (参加 −50 / 順位 +0〜100)' : 'トラペゾイド(IL2) (参加 −100 / 順位 +0〜200)';
  if (entryEl) entryEl.textContent = `参加 −${entryCost}`;
  if (rewardEl) rewardEl.textContent = `${placeLabel} +${rankBonus}`;

  const deltaSign = netDelta > 0 ? `+${netDelta}` : String(netDelta);
  if (deltaEl) {
    deltaEl.textContent = deltaSign;
    deltaEl.className = 'splatRateDelta ' + (netDelta > 0 ? 'plus' : netDelta < 0 ? 'minus' : 'zero');
  }

  // ゲージ範囲: 100刻みの現在帯を表示
  const minRef = Math.min(before, after);
  const maxRef = Math.max(before, after);
  const gaugeFloor = Math.min(Math.floor(minRef / 100) * 100, 1400);
  const gaugeCeil = Math.max(Math.ceil((maxRef + 20) / 100) * 100, gaugeFloor + 200);
  const span = Math.max(100, gaugeCeil - gaugeFloor);
  const pct = (v) => clamp(((v - gaugeFloor) / span) * 100, 0, 100);

  if (floorEl) floorEl.textContent = String(gaugeFloor);
  if (ceilEl) ceilEl.textContent = String(gaugeCeil);

  // 初期状態(変動前)
  if (valEl) valEl.textContent = String(before);
  if (baseBar) baseBar.style.width = `${pct(Math.min(before, after)).toFixed(1)}%`;
  if (diffBar) {
    diffBar.className = 'splatGaugeDiff ' + (netDelta >= 0 ? 'plus' : 'minus');
    diffBar.style.left = `${pct(Math.min(before, after)).toFixed(1)}%`;
    diffBar.style.width = '0%';
  }

  // カウントアップ/ダウン演出
  const steps = 22;
  let step = 0;
  setTimeout(() => {
    if (diffBar) {
      diffBar.style.left = `${pct(Math.min(before, after)).toFixed(1)}%`;
      diffBar.style.width = `${Math.abs(pct(after) - pct(before)).toFixed(1)}%`;
    }
    if (deltaEl) {
      deltaEl.classList.add('pop');
      setTimeout(() => deltaEl.classList.remove('pop'), 320);
    }
    rateAnimTimer = setInterval(() => {
      step++;
      const u = clamp(step / steps, 0, 1);
      const cur = Math.round(before + (after - before) * u);
      if (valEl) valEl.textContent = String(cur);
      if (step % 2 === 0 || step === steps) {
        playRateTickSound(u, netDelta >= 0);
      }
      if (step >= steps) {
        clearInterval(rateAnimTimer);
        rateAnimTimer = null;
        if (newlyUnlocked && newlyUnlocked.length > 0) {
          challengerQueue = [...newlyUnlocked];
          setTimeout(() => showNextChallengerInQueue(), 480);
        }
      }
    }, 34);
  }, 220);
}

function showResult() {
  state.resultShown = true;
  updateSailingAudio(0, player, false);
  playBgm('result');
  const ok = (b) => b.finished && !b.late && !b.dsq;
  const fin = boats.filter(ok).sort((a, b) => a.finishTime - b.finishTime);
  const dnf = boats.filter((b) => !ok(b) && !b.dsq).sort((a, b) => progressOf(b) - progressOf(a));
  const dsq = boats.filter((b) => b.dsq);
  const row = (b, pos, tm) => `<tr class="${b.isPlayer ? 'me' : ''}"><td>${pos}</td><td>${nameOf(b)}</td><td>${tm}</td></tr>`;
  $('resultBody').innerHTML =
    fin.map((b, i) => row(b, i + 1, fmtMs(b.finishTime))).join('') +
    dnf.map((b, i) => row(b, '−', 'DNF')).join('') +
    dsq.map((b) => row(b, 'DSQ', `DSQ (${b.dsqReason || 'プロテスト'})`)).join('');
  const p = fin.indexOf(player) + 1;
  $('resultTitle').textContent = player.dsq ? `DSQ (失格 — ${player.dsqReason})` : p ? `${p}位 / ${boats.length}艇` : 'DNF';
  $('result').classList.remove('hidden');

  // レート精算と新キャラクター解放判定
  let rateBeforeRec = null;
  let rateAfterRec = null;
  let newlyUnlocked = [];
  if (cfg.rateMode !== 'off') {
    const isUpwind = cfg.courseMode === 'upwind';
    const entryCost = state.raceRateInfo && state.raceRateInfo.active ? state.raceRateInfo.entryCost : (isUpwind ? 50 : 100);
    const before = state.raceRateInfo && state.raceRateInfo.active ? state.raceRateInfo.before : rateData.rate;
    const maxReward = isUpwind ? 100 : 200;
    const validFinish = !player.dsq && p >= 1 && p <= N_BOATS;
    const rankBonus = validFinish ? Math.round((maxReward * (N_BOATS - p)) / (N_BOATS - 1)) : 0;
    const after = Math.max(0, before - entryCost + rankBonus);
    const netDelta = after - before;

    rateBeforeRec = before;
    rateAfterRec = after;
    rateData.rate = after;
    if (after > (rateData.peakRate || DEFAULT_RATE)) rateData.peakRate = after;

    for (const c of CREW_TYPES) {
      if (c.unlockRate && after >= c.unlockRate && !rateData.unlocked.includes(c.id)) {
        rateData.unlocked.push(c.id);
        newlyUnlocked.push(c);
      }
    }
    saveRateData();
    updateMenuRateUI();
    if (newlyUnlocked.length > 0) {
      buildChoices('helmChoices', 'helm');
      buildChoices('crewChoices', 'crew');
    }
    if (state.raceRateInfo) state.raceRateInfo.settled = true;

    const placeLabel = player.dsq ? 'DSQ' : p > 0 ? `${p}位` : 'DNF';
    runSplatoonRateAnimation({ active: true, before, entryCost, rankBonus, after, netDelta, isUpwind, placeLabel }, newlyUnlocked);
  } else {
    runSplatoonRateAnimation({ active: false }, []);
  }

  if (recorder) {
    recorder.finalize(boats, state.t);
    const rec = recorder;
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const pSt = rec.d && rec.d.get ? rec.d.get(player.id) : null;
    const avgKt = pSt && pSt.avgV > 0 ? (pSt.avgV / SPEED_SCALE / KT).toFixed(2) : null;
    const revOpts = { nameOf, playerId: player.id, marks: MARKS, courseMode: COURSE_MODE, legs: LEGS, lineA, speedScale: SPEED_SCALE, kt: KT };
    const revSnap = serializeReviewSnapshot(rec, revOpts);
    saveRaceRecord({
      date: dateStr,
      venue: cfg.venue === 'enoshima' ? '江の島' : '八景島',
      course: cfg.courseMode === 'upwind' ? '上マークF' : 'トラペゾイド(IL2)',
      wind: `${currentWindDeg}° ${BASE_WIND_KT}kt`,
      rank: player.dsq ? null : p > 0 ? p : null,
      fleet: boats.length,
      status: player.dsq ? 'DSQ' : p > 0 ? 'FIN' : 'DNF',
      rateBefore: rateBeforeRec,
      rateAfter: rateAfterRec,
      time: player.dsq ? 'DSQ' : p > 0 ? fmtMs(player.finishTime) : 'DNF',
      avgKt,
    }, revSnap);
    let rb = $('reviewBtn');
    if (!rb) {
      rb = document.createElement('button');
      rb.id = 'reviewBtn'; rb.type = 'button'; rb.className = 'btnSec'; rb.textContent = '振り返り';
      const again = $('againBtn');
      if (again && again.parentNode) again.parentNode.insertBefore(rb, again); else $('result').appendChild(rb);
    }
    rb.onclick = () => openReview(rec, revOpts);
    // 振り返りデータを確定した後は recorder を切り離し、背景の3D艇群を早送り前の位置へ戻してライブで次々とフィニッシュさせる
    recorder = null;
  }
  if (_liveFinishSnap) {
    restoreLiveFleet(_liveFinishSnap);
    _liveFinishSnap = null;
  }
}

// ---------- メインループ ----------
const clock = new THREE.Clock();
let hudAcc = 0;
function togglePause(p) {
  if (state.phase === 'menu') { startOrientation(); return; }
  if (state.phase === 'orientation') { exitOrientation(false); return; }
  if (state.phase !== 'race') return;
  state.paused = p !== undefined ? p : !state.paused;
  const modal = $('pauseModal');
  if (state.paused) {
    stopBgm();
    modal.classList.remove('hidden');
    toast('一時中断中', 'info', 2000);
  } else {
    clock.getDelta();
    const bgmMode = state.t < 0
      ? (cfg.venue === 'hakkeijima' ? 'prestart_hakkeijima' : 'prestart_enoshima')
      : (cfg.venue === 'hakkeijima' ? 'race_hakkeijima' : 'race_enoshima');
    playBgm(bgmMode);
    modal.classList.add('hidden');
    toast('再開', 'info', 1500);
  }
}

function loop() {
  requestAnimationFrame(loop);
  const raw = Math.min(0.1, clock.getDelta());
  const dt = Math.min(0.05, raw);
  const time = performance.now() / 1000;
  SEA.clock = (state.phase === 'race' || state.phase === 'orientation') ? state.t : time; // 艇モデル・マーク・航跡の上下動を物理と同じ海面時刻で同期
  TIDE.active = state.phase !== 'orientation';
  
  if (state.phase === 'race' && !state.paused) {
    let rem = dt;
    while (rem > 1e-6) { const s = Math.min(rem, 1 / 60); simStep(s); rem -= s; }
  } else if (state.phase === 'orientation' && !state.paused) {
    let rem = dt;
    while (rem > 1e-6) { const s = Math.min(rem, 1 / 60); orientationStep(s, time); rem -= s; }
  } else if (state.phase === 'menu' && !state.paused) {
    let rem = dt;
    while (rem > 1e-6) { const s = Math.min(rem, 1 / 60); practiceStep(s, time); rem -= s; }
  }

  // スタート画面のキャラクタープレビュー(#preview)に待機モーションを付与
  if (state.phase === 'menu' && pv && pv.helmFig && pv.crewFig) {
    animatePreviewFigure(pv.helmFig, time, 0.0, Math.PI + 0.22);
    animatePreviewFigure(pv.crewFig, time, 1.7, Math.PI - 0.22);
    pv.r.render(pv.sc, pv.cm);
  }
  // スマブラ風新キャラ解放演出中の3Dモデル待機モーション
  if (challengerPv && challengerPv.active && challengerPv.fig) {
    animatePreviewFigure(challengerPv.fig, time * 1.35, 0.0, Math.PI + 0.25 + Math.sin(time * 1.4) * 0.22);
    challengerPv.fig.scale.setScalar(challengerPv.baseScale || 1.0);
    if (challengerPv.baseY !== undefined) challengerPv.fig.position.y = challengerPv.baseY + Math.sin(time * 3.0) * 0.012;
    challengerPv.r.render(challengerPv.sc, challengerPv.cm);
  }
  
  for (const m of models) m.sync(dt, time);
  // フィニッシュ船のカメラマン視点への切り替えは、リザルト画面が表示されてから(state.resultShown === true)にする
  const isPostFinishView = state.phase === 'race' && state.resultShown;
  if (models[0]) models[0].setFirstPerson(!isPostFinishView && cam.mode === COCKPIT);
  world.wake.update(boats, state.paused ? 0 : dt);
  
  if (player) {
    if (isPostFinishView && world.markObjs && world.markObjs.fcom) {
      // フィニッシュ後の背景映像(リザルト画面表示後):
      // カメラマン本人のタヌキが映り込むのではなく、カメラマンが構えているカメラのファインダー映像(レンズ視点)として
      // フィニッシュライン〜3マーク側の海面と後続艇群を直接映す
      const fc = world.markObjs.fcom;
      if (fc.userData && fc.userData.tanukiCam) {
        fc.userData.tanukiCam.visible = false;
      }
      const isUpwindFin = COURSE_MODE === 'upwind';
      // 船首デッキ先端のカメラレンズ位置(local: 0.34, 1.68, 3.35)にカメラを配置
      const camLocal = new THREE.Vector3(0.34, 1.68, 3.35);
      fc.updateMatrixWorld(true);
      const camWorld = camLocal.applyMatrix4(fc.matrixWorld);
      camera.position.copy(camWorld);
      // 視線ターゲット: 3マーク〜フィニッシュラインの中間(後続艇が3マークを回ってフィニッシュへ向かってくる海面)
      const lookCourse = isUpwindFin
        ? toWorld(MARKS.m1.a - 36, (MARKS.m1.c + MARKS.fcom.c) * 0.42 + Math.sin(time * 0.45) * 3.5)
        : toWorld((MARKS.fm.a * 0.56 + MARKS.m3.a * 0.44), (MARKS.fm.c * 0.56 + MARKS.m3.c * 0.44) + Math.sin(time * 0.45) * 3.5);
      camera.lookAt(lookCourse.x, 1.45, lookCourse.z);
    } else {
      if (world.markObjs && world.markObjs.fcom && world.markObjs.fcom.userData && world.markObjs.fcom.userData.tanukiCam) {
        world.markObjs.fcom.userData.tanukiCam.visible = true;
      }
      cam.update(dt, time, player, boats);
      if (hud.tCamReset) hud.tCamReset.classList.toggle('hidden', !cam.isMoved());
    }
    // ドローンカメラ時に他艇(CP艇)が「カメラと自艇の視線上(水平射影)」に入って自艇と重なった時だけ半透明化する
    if (models.length > 1) {
      const isDrone = !isPostFinishView && cam.mode !== COCKPIT;
      const cx = camera.position.x, cz = camera.position.z;
      const px = player.x, pz = player.z;
      const rdx = px - cx, rdz = pz - cz;
      const rhLen = Math.hypot(rdx, rdz) || 1;
      const uhx = rdx / rhLen, uhz = rdz / rhLen;
      for (let i = 1; i < models.length; i++) {
        const m = models[i], b = boats[i];
        if (!m || !b || !m.setOccludingAlpha) continue;
        let tgtAlpha = 1.0;
        if (isDrone) {
          // CP艇のバウ・中央・スターン・リーワード側セールの複数サンプル点で、カメラ〜自艇の視線セグメントとの水平距離を判定
          const fx = Math.sin(b.h), fz = -Math.cos(b.h);
          const rx = Math.cos(b.h), rz = Math.sin(b.h);
          const leeSgn = -(b.tack || 1);
          const pts = [
            [b.x, b.z],
            [b.x + fx * 1.9, b.z + fz * 1.9],
            [b.x - fx * 1.9, b.z - fz * 1.9],
            [b.x + fx * 0.8, b.z + fz * 0.8],
            [b.x - fx * 0.8 + rx * leeSgn * 0.85, b.z - fz * 0.8 + rz * leeSgn * 0.85],
          ];
          let minPerpH = 999;
          for (let k = 0; k < pts.length; k++) {
            const sx = pts[k][0] - cx, sz = pts[k][1] - cz;
            const along = sx * uhx + sz * uhz;
            if (along > 0.8 && along < rhLen + 1.0) {
              const clampedAlong = clamp(along, 1.0, rhLen + 0.4);
              const ox = sx - uhx * clampedAlong, oz = sz - uhz * clampedAlong;
              const perpH = Math.hypot(ox, oz);
              if (perpH < minPerpH) minPerpH = perpH;
            }
          }
          if (minPerpH < 2.35) {
            tgtAlpha = clamp(0.22 + (Math.max(0, minPerpH - 0.95) / 1.40) * 0.78, 0.22, 1.0);
          }
        }
        const curA = m._curOccAlpha ?? 1.0;
        const nextA = curA + (tgtAlpha - curA) * (1 - Math.exp(-dt * 14));
        m._curOccAlpha = nextA;
        m.setOccludingAlpha(nextA);
      }
    }
    world.update(time, camera, dt, (state.phase === 'race' || state.phase === 'orientation') ? state.t : time, player, boats);
    const isReviewOpen = !!document.getElementById('review');
    const active = (state.phase === 'race' || state.phase === 'menu' || state.phase === 'orientation') && !state.paused && !state.resultShown && !isReviewOpen;
    if (active && state.phase !== 'menu') setWind(clamp(Math.abs(player.v) / 6, 0, 1));
    updateSailingAudio(dt, player, active);
    setCameraAudio(cam.mode === COCKPIT);
    updateNearbyBoatSound(player, boats, active);
  }
  
  if (player) {
    const showPreStart = ((state.phase === 'race' || state.phase === 'orientation') && state.t < 0) || state.phase === 'menu';
    const curLeg = LEGS[Math.min(player.leg, LEGS.length - 1)];
    const isFinLeg = curLeg && curLeg.type === 'finish';
    world.setLine((state.phase === 'race' || state.phase === 'orientation') && state.t >= 0 ? 'finish' : 'start', player.finished ? 0 : isFinLeg ? 1 : (state.phase === 'race' || state.phase === 'orientation') && state.t >= 0 ? 0.15 : 0, showPreStart);
    if (world.setTargetMark) world.setTargetMark(player.leg, (state.phase === 'race' || state.phase === 'orientation') ? state.t : 1, player.finished);
    updateMarkPointer(player);
    updateNearBoatsHUD(player);
    updateHailBubbles(dt);
    if (state.phase === 'orientation') applyOrientStepHighlights(orientState.step, orientState.elapsed);
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
  if (state.phase === 'orientation') {
    if ((e.code === 'Space' || e.code === 'KeyP') && !e.repeat) toggleOrientPause();
    else if (e.code === 'Escape' && !e.repeat) exitOrientation(false);
    return;
  }
  if (state.phase !== 'race' && state.phase !== 'menu') return;
  
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

  if (state.phase === 'race' && (e.code === 'KeyP' || e.code === 'Escape')) togglePause();
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
  tap('exitMenuBtn', () => { clearHailBubbles(); togglePause(false); $('result').classList.add('hidden'); $('hud').classList.remove('hidden'); $('menu').classList.remove('hidden'); state.phase = 'menu'; state.resultShown = false; document.body.classList.add('menuOpen'); cam.menuOffset = true; makeFleet(true); updateMenuRateUI(); playBgm('menu'); });

  // ランチャー アップ/ダウン
  tap('poleUpBtn', () => setPlayerPole(true));
  tap('poleDownBtn', () => setPlayerPole(false));

  if (IS_TOUCH) document.body.classList.add('touch');
  if ($('touch')) $('touch').classList.remove('hidden');
  const hold = (id, code) => {
    const el = $(id);
    if (!el) return;
    const on = (e) => { keys.add(code); el.classList.add('on'); el.classList.remove('autoSteer'); e.preventDefault(); };
    const off = () => { keys.delete(code); el.classList.remove('on', 'autoSteer'); };
    el.addEventListener('pointerdown', on);
    for (const n of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(n, off);
  };
  hold('tLeft', 'ArrowLeft'); hold('tRight', 'ArrowRight'); hold('tUp', 'ArrowUp'); hold('tDown', 'ArrowDown');

  const tapTouch = (id, fn) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (state.phase === 'race' || state.phase === 'menu' || state.phase === 'practice') fn();
    });
  };
  tapTouch('tPole', () => setPlayerPole(!player.pole));
  tapTouch('tCam', () => setCamera(cam.mode + 1));
  tapTouch('tCamReset', () => {
    cam.resetAngle();
    if (hud.tCamReset) hud.tCamReset.classList.add('hidden');
  });
  tapTouch('tAuto', () => setAuto(!autoTrim));
  if ($('tAuto')) $('tAuto').classList.add('on');
  if (IS_TOUCH) document.addEventListener('contextmenu', (e) => e.preventDefault());
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

// 海面・風向・風速から波の種類(三角波/うねり/短周期の風浪)と潮汐流を決めて物理と海面描画へ反映
function applySea(windDeg, kt) {
  setSeaState(cfg.venue, windDeg, kt);
  setTideState(cfg.venue, windDeg, Date.now());
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
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const tid = ctrl ? setTimeout(() => ctrl.abort(), 1400) : null;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${v.lat}&longitude=${v.lon}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn`;
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (tid) clearTimeout(tid);
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
let selectedWindPreset = 'real'; // 'real' (現地風) | 'moderate' (順風)

function isRedFlagWeather(venueId, baseW) {
  if (!baseW) return false;
  const maxKt = Math.max(baseW.rawKt || 0, baseW.gustKt || 0);
  const redThreshold = venueId === 'hakkeijima' ? 18 : 20;
  return maxKt > redThreshold;
}

function syncWindPresetButtons(venueId, baseW) {
  const redFlag = isRedFlagWeather(venueId, baseW);
  if (redFlag) selectedWindPreset = 'moderate';
  const presetBox = $('mwhPresets');
  if (!presetBox) return;
  presetBox.querySelectorAll('.mwhBtn').forEach((b) => {
    const mode = b.getAttribute('data-wmode');
    b.classList.toggle('sel', mode === selectedWindPreset);
  });
}

function resolveEffectiveWeather(venueId, baseW) {
  const windDeg = baseW.windDeg;
  if (isRedFlagWeather(venueId, baseW)) {
    selectedWindPreset = 'moderate';
  }
  if (selectedWindPreset === 'moderate') {
    return { windDeg, rawKt: 10, gustKt: 12, effKt: 10, fallback: false };
  }
  return baseW;
}

function updateWeatherInfoUI(windDeg, kt, gustKt, desc, fallback) {
  currentWindDeg = windDeg;
  currentSideBiasDesc = desc;
  const dirStr = `${windDeg}°`;
  const maxKt = Math.max(kt, gustKt || kt);

  // スタート画面上部に現地風向・現地風速・最大風速・赤旗/黄旗を大きく表示
  const dirEl = $('mwhDir');
  const spdEl = $('mwhSpd');
  const maxEl = $('mwhMax');
  const flagEl = $('mwhFlag');
  if (dirEl) dirEl.textContent = dirStr;
  if (spdEl) spdEl.innerHTML = `${kt}<small>kt</small>`;
  if (maxEl) maxEl.textContent = `(最大 ${maxKt}kt)`;
  if (flagEl) {
    // 最大風速が八景島では18knot、江の島では20knotを超えると赤旗、それぞれ16knot、18knot以上で黄旗
    const redThreshold = cfg.venue === 'hakkeijima' ? 18 : 20;
    const yellowThreshold = cfg.venue === 'hakkeijima' ? 16 : 18;
    if (maxKt > redThreshold) {
      flagEl.className = 'mwhFlag red';
      flagEl.textContent = '🚩 赤旗 (出艇禁止基準)';
    } else if (maxKt >= yellowThreshold) {
      flagEl.className = 'mwhFlag yellow';
      flagEl.textContent = '🏳️ 黄旗 (強風注意)';
    } else {
      flagEl.className = 'mwhFlag hidden';
      flagEl.textContent = '';
    }
  }
  syncWindPresetButtons(cfg.venue, { rawKt: kt, gustKt: maxKt });

  // 下部には風速や風向の文字は入れず、海面特性・波・潮汐のみを記載
  const infoEl = $('realWeatherInfo');
  if (!infoEl) return;
  infoEl.classList.remove('hidden');
  const tideStr = TIDE && TIDE.phaseLabel ? `  ｜  潮汐: ${TIDE.tideType}・${TIDE.phaseLabel} (${TIDE.dirLabel}へ ${TIDE.kt.toFixed(2)}kt)` : '';
  infoEl.textContent = `${desc}${SEA.label ? `  ｜  波: ${SEA.label}` : ''}${tideStr}`;
}

function applyVenue() {
  const v = VENUES.find((x) => x.id === cfg.venue) || VENUES[0];
  const eb = $('menuEyebrow');
  if (eb) eb.textContent = v.eyebrow;

  setCourseMode(cfg.courseMode);

  const cached = weatherCache[cfg.venue];
  if (cached) {
    const effW = resolveEffectiveWeather(cfg.venue, cached);
    const { bias, desc } = computeSideBias(cfg.venue, effW.windDeg);
    setWindParams(effW.effKt, bias);
    world.setVenue(cfg.venue, effW.windDeg, bias); applySea(effW.windDeg, effW.effKt);
    rebuildObstacles();
    updateWeatherInfoUI(cached.windDeg, cached.rawKt, cached.gustKt, desc, cached.fallback);
  } else {
    // 初回取得: まずデフォルトで初期化し、非同期で1回だけ取得して反映
    const baseDef = { windDeg: v.defaultWindDeg, rawKt: v.defaultWindKt, gustKt: v.defaultWindKt + 3, effKt: v.defaultWindKt, fallback: false };
    const effW = resolveEffectiveWeather(cfg.venue, baseDef);
    const { bias, desc } = computeSideBias(cfg.venue, effW.windDeg);
    setWindParams(effW.effKt, bias);
    world.setVenue(cfg.venue, effW.windDeg, bias); applySea(effW.windDeg, effW.effKt);
    rebuildObstacles();
    updateWeatherInfoUI(baseDef.windDeg, baseDef.rawKt, baseDef.gustKt, desc, false);
    fetchRealWeather(cfg.venue).then((w) => {
      if (state.phase !== 'menu') return;
      const effW = resolveEffectiveWeather(cfg.venue, w);
      const bInfo = computeSideBias(cfg.venue, effW.windDeg);
      setWindParams(effW.effKt, bInfo.bias);
      world.setVenue(cfg.venue, effW.windDeg, bInfo.bias); applySea(effW.windDeg, effW.effKt);
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
      prewarmBgm([v.id === 'hakkeijima' ? 'prestart_hakkeijima' : 'prestart_enoshima', v.id === 'hakkeijima' ? 'race_hakkeijima' : 'race_enoshima']);
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
function buildRateChoices() {
  const box = $('rateChoices'); if (!box) return;
  box.innerHTML = '';
  for (const m of RATE_MODES) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'choice' + (cfg.rateMode === m.id ? ' sel' : ''); btn.id = `rateMode-${m.id}`;
    btn.innerHTML = `<span class="ic">${m.icon}</span><span class="lb">${m.label}</span>`;
    btn.onclick = () => {
      cfg.rateMode = m.id;
      saveCfg();
      updateMenuRateUI();
      buildRateChoices();
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
function buildBgmChoices() {
  const box = $('bgmChoices'); if (!box) return;
  box.innerHTML = '';
  for (const m of BGM_MODES) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'choice' + (cfg.bgmMode === m.id ? ' sel' : ''); btn.id = `bgmMode-${m.id}`;
    btn.innerHTML = `<span class="ic">${m.icon}</span><span class="lb">${m.label}</span>`;
    btn.onclick = () => {
      cfg.bgmMode = m.id;
      saveCfg();
      setBgmVoiceEnabled(cfg.bgmMode !== 'off');
      if (cfg.bgmMode !== 'off' && state.phase === 'menu') playBgm('menu');
      buildBgmChoices();
    };
    box.appendChild(btn);
  }
}
function buildChoices(containerId, key) {
  const box = $(containerId); if (!box) return;
  box.innerHTML = '';
  for (const c of crewOptions) {
    // まだ解放されていない(プレイできない)キャラクターはスタート画面に表示しない
    if (!isCrewUnlocked(c.id)) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice' + (cfg[key] === c.id ? ' sel' : '');
    btn.id = `${containerId}-${c.id.replace(/[^a-z0-9]/gi, '_')}`;
    btn.innerHTML = `<span class="ic">${c.icon}</span><span class="lb">${c.label}</span>`;
    btn.onclick = () => {
      initAudio();
      playCrewSelectSound(c.id);
      cfg[key] = c.id;
      saveCfg();
      buildChoices(containerId, key);
      updatePreview();
      rebuildPlayerModel();
    };
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
  pv = { r, sc, cm, g: new THREE.Group(), helmFig: null, crewFig: null }; sc.add(pv.g);
  updatePreview();
}
function updatePreview() {
  if (!pv) return;
  pv.g.clear();
  const st = { skin: hexNum(cfg.skin), shirt: hexNum(cfg.shirt), hat: hexNum(cfg.hat), jacket: PLAYER_BIB };
  // buildFigureは顔が -z 向きなので、Math.PI 回転してカメラ(+z)側・正面を向かせる
  const a = buildFigure(cfg.helm, st); a.position.set(-0.5, a.userData.upper ? 0.16 : 0, 0); a.rotation.y = Math.PI + 0.22; pv.g.add(a);
  const b = buildFigure(cfg.crew, st); b.position.set(0.5, b.userData.upper ? 0.16 : 0, 0); b.rotation.y = Math.PI - 0.22; pv.g.add(b);
  pv.helmFig = a;
  pv.crewFig = b;
  pv.g.rotation.y = 0;
  pv.r.render(pv.sc, pv.cm);
}
function initMenu() {
  applyVenue();
  buildVenueChoices();
  buildCourseChoices();
  buildRateChoices();
  buildPenaltyChoices();
  buildBgmChoices();
  const presetBox = $('mwhPresets');
  if (presetBox) {
    presetBox.querySelectorAll('.mwhBtn').forEach((btn) => {
      btn.onclick = () => {
        const mode = btn.getAttribute('data-wmode') || 'real';
        const cached = weatherCache[cfg.venue];
        if (mode === 'real' && isRedFlagWeather(cfg.venue, cached)) {
          selectedWindPreset = 'moderate';
          syncWindPresetButtons(cfg.venue, cached);
          toast('赤旗(出艇禁止基準)のため順風が選択されます', 'warn', 2500);
          return;
        }
        selectedWindPreset = mode;
        syncWindPresetButtons(cfg.venue, cached);
        applyVenue();
        makeFleet();
        cam.inited = false;
        if (player) cam.update(0, performance.now() / 1000, player, boats);
      };
    });
  }
  if (!isCrewUnlocked(cfg.helm)) cfg.helm = 'human_m';
  if (!isCrewUnlocked(cfg.crew)) cfg.crew = 'cat';
  buildChoices('helmChoices', 'helm'); buildChoices('crewChoices', 'crew');
  updateMenuRateUI();
  const sn = $('sailNo');
  if (sn) {
    sn.value = cfg.sailNo;
    sn.oninput = () => { cfg.sailNo = sn.value.replace(/\D/g, '').slice(0, 5) || '31804'; saveCfg(); rebuildPlayerModel(); };
  }
  const startBtnEl = $('startBtn');
  if (startBtnEl) {
    const lblEl = startBtnEl.querySelector('.startBtnLabel');
    if (lblEl) lblEl.textContent = 'レーススタート';
    startBtnEl.onclick = startRace;
  }
  if ($('practiceBtn')) $('practiceBtn').onclick = startOrientation;
  if ($('recordsBtn')) $('recordsBtn').onclick = openRecordsModal;
  if ($('recordsCloseBtn')) $('recordsCloseBtn').onclick = closeRecordsModal;
  if ($('recordsClearBtn')) {
    $('recordsClearBtn').onclick = () => {
      if (confirm('保存されている戦績記録をすべて消去しますか？')) {
        try {
          localStorage.removeItem(RECORDS_KEY);
          localStorage.removeItem(REVIEWS_KEY);
        } catch (e) {}
        renderRecordsModal();
      }
    };
  }
  if ($('challengerCloseBtn')) {
    $('challengerCloseBtn').onclick = () => showNextChallengerInQueue();
  }
  if ($('orientPauseBtn')) $('orientPauseBtn').onclick = toggleOrientPause;
  if ($('orientExitBtn')) $('orientExitBtn').onclick = () => exitOrientation(false);
  $('againBtn').onclick = () => {
    if (rateAnimTimer) { clearInterval(rateAnimTimer); rateAnimTimer = null; }
    clearHailBubbles();
    $('result').classList.add('hidden');
    if ($('challengerOverlay')) $('challengerOverlay').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('menu').classList.remove('hidden');
    state.phase = 'menu';
    state.resultShown = false;
    document.body.classList.add('menuOpen');
    cam.menuOffset = true;
    makeFleet(true);
    buildChoices('helmChoices', 'helm');
    buildChoices('crewChoices', 'crew');
    updateMenuRateUI();
    clock.getDelta();
    playBgm('menu');
  };
  initPreview();
  setBgmVoiceEnabled(cfg.bgmMode !== 'off');
  prewarmBgm([
    'menu',
    cfg.venue === 'hakkeijima' ? 'prestart_hakkeijima' : 'prestart_enoshima',
    cfg.venue === 'hakkeijima' ? 'race_hakkeijima' : 'race_enoshima',
  ]);
  if (state.phase === 'menu' && cfg.bgmMode !== 'off') {
    playBgm('menu');
  }
  // ブラウザの自動再生制限で初期状態がsuspendedだった場合のフォールバック（captureフェーズで画面上のどこに触れても即座にアンロック）
  const unlockEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'click', 'wheel'];
  const unlockMenuBgm = () => {
    if (state.phase === 'menu' && cfg.bgmMode !== 'off') {
      unlockAudioNow().then((ok) => {
        if (ok && state.phase === 'menu' && cfg.bgmMode !== 'off') {
          playBgm('menu');
        }
      });
      playBgm('menu');
    } else {
      unlockAudioNow();
    }
    if (isAudioRunning() && (state.phase !== 'menu' || cfg.bgmMode === 'off' || isBgmPlaying())) {
      unlockEvents.forEach((ev) => window.removeEventListener(ev, unlockMenuBgm, true));
    }
  };
  unlockEvents.forEach((ev) => window.addEventListener(ev, unlockMenuBgm, { capture: true, passive: true }));
}

(async function boot() {
  if (window.__setLoad) window.__setLoad(92);
  let extra = [];
  try {
    extra = await Promise.race([
      loadCustomCrew(),
      new Promise((resolve) => setTimeout(() => resolve([]), 2500))
    ]);
  } catch (e) {
    extra = [];
  }
  crewOptions = [...CREW_TYPES, ...(Array.isArray(extra) ? extra : [])];
  if (!crewOptions.find((c) => c.id === cfg.helm) || !isCrewUnlocked(cfg.helm)) cfg.helm = 'human_m';
  if (!crewOptions.find((c) => c.id === cfg.crew) || !isCrewUnlocked(cfg.crew)) cfg.crew = 'cat';
  const q = new URLSearchParams(location.search);
  if (q.has('venue') && VENUES.find((v) => v.id === q.get('venue'))) cfg.venue = q.get('venue');

  // Loading表示中に気象データを先行取得して、Loading解除直後の非同期makeFleet再生成によるカクつきを防ぐ
  try {
    await Promise.race([
      fetchRealWeather(cfg.venue),
      new Promise((resolve) => setTimeout(resolve, 2500))
    ]);
  } catch (e) {}
  if (window.__setLoad) window.__setLoad(96);

  try {
    applyVenue();
    makeFleet();
    initMenu();
    initTouch();
  } catch (e) {
    console.error('Boot init error:', e);
  }

  // WebGLシェーダおよびテクスチャをLoading画面の裏で事前コンパイル＆ウォームアップ描画し、Loading直後のカクつきを解消
  try {
    if (world.setCourseVisible) world.setCourseVisible(true);
    if (player) cam.update(0, performance.now() / 1000, player, boats);
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    if (world.setCourseVisible) world.setCourseVisible(state.phase !== 'menu');
    renderer.render(scene, camera);
  } catch (e) {}

  if (window.__setLoad) window.__setLoad(100);
  clock.getDelta();
  loop();

  let enteredStartMenu = false;
  const enterStartMenu = () => {
    if (enteredStartMenu) return;
    enteredStartMenu = true;
    clock.getDelta();
    const ld = $('loading');
    if (ld) ld.classList.add('hidden');
    if (state.phase === 'menu' && cfg.bgmMode !== 'off') {
      playBgm('menu');
      unlockAudioNow().then((ok) => {
        if (ok && state.phase === 'menu' && cfg.bgmMode !== 'off') playBgm('menu');
      });
    }
  };

  window.__game = {
    state,
    get boats() { return boats; },
    get player() { return player; },
    simStep,
    cam,
    world,
    closeHoldLock,
    checkRightOfWayHails,
    isAudioRunning,
    isBgmPlaying,
    enterStartMenu,
    resetHailCooldowns: () => { globalHailCD = 0; pairHailUntil.clear(); for (const b of boats) b.hailCD = 0; },
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(() => enterStartMenu());
  });
  setTimeout(enterStartMenu, 220);

  if (q.has('auto')) {
    enterStartMenu();
    startRace();
    const skip = parseFloat(q.get('skip') || '0');
    if (q.has('autopilot')) { const ap = new AI(player, rng); window.__ap = ap; }
    for (let s = 0; s < skip * 60; s++) simStep(1 / 60);
    if (q.has('cam')) cam.setMode(+q.get('cam'));
  }
})();

// リアルなヨットオーディオ(WebAudio)
//  - 号砲/1分前ホーン: エアホーン(倍音・息継ぎ・残響)
//  - 船が水を切る音: 船体を流れる水の「シャー」+ バウウェーブの低いうねり + 気泡のポコポコ + 波打ち(スラップ)
//  - セールのシバー: 連続的なバタバタ音 + タック時のパンッ
//  - 他艇が近づくと相手の波切り音が大きく・左右定位つきで聞こえる
let ctx = null, master = null, fx = null, windGain = null, muted = false, noiseBuf = null;
let boatBus = null, hissGain = null, hissHP = null, hissLP = null, rushGain = null, rushFilter = null, swellGain = null;
let chineGain = null, chineFilter = null;
let shiverGain = null, shiverLfo = null;
let nearGain = null, nearFilter = null, nearPan = null;
let camMul = 1, tBubble = 0, tSlap = 0, tSlice = 0, tGurgle = 0, tShiver = 0, wPhase = 0;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clampN = (x, a, b) => Math.max(a, Math.min(b, x));

function softClip(k) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
  return c;
}
function makeImpulse(sec, decay) {
  const len = Math.floor(ctx.sampleRate * sec), buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
function loopSource(buf, rate = 1) {
  const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(); return s;
}

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.25;
    master = ctx.createGain(); master.gain.value = 0.62; master.connect(comp); comp.connect(ctx.destination);
    // 開けた水面の残響(ホーンに奥行きを与える)
    const conv = ctx.createConvolver(); conv.buffer = makeImpulse(2.2, 3.2);
    fx = ctx.createGain(); fx.gain.value = 1; fx.connect(conv);
    const wet = ctx.createGain(); wet.gain.value = 0.55; conv.connect(wet); wet.connect(master);

    // ノイズ素材: 白色 / ブラウン(風・水流用)
    const sr = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, sr * 2, sr);
    const wn = noiseBuf.getChannelData(0); for (let i = 0; i < wn.length; i++) wn[i] = Math.random() * 2 - 1;
    const brown = ctx.createBuffer(1, sr * 3, sr), bd = brown.getChannelData(0);
    let last = 0; for (let i = 0; i < bd.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; bd[i] = last * 3.5; }

    // 風(ガストでゆっくり強弱)
    const wsrc = loopSource(brown);
    const wlp = ctx.createBiquadFilter(); wlp.type = 'lowpass'; wlp.frequency.value = 720;
    windGain = ctx.createGain(); windGain.gain.value = 0.18;
    const gust = ctx.createOscillator(); gust.frequency.value = 0.11;
    const gustAmp = ctx.createGain(); gustAmp.gain.value = 0.05; gust.connect(gustAmp); gustAmp.connect(windGain.gain); gust.start();
    wsrc.connect(wlp); wlp.connect(windGain); windGain.connect(master);

    // 艇の音バス(カメラがドローンの時は小さく、艇内では大きく)
    boatBus = ctx.createGain(); boatBus.gain.value = 1; boatBus.connect(master);

    // 1) 船体を流れる水のシャー(高域スプレー＆水切り) — 波との出会いに合わせてフィルタと音量が有機的に変化
    const hsrc = loopSource(noiseBuf, 0.92);
    hissHP = ctx.createBiquadFilter(); hissHP.type = 'highpass'; hissHP.frequency.value = 1350;
    hissLP = ctx.createBiquadFilter(); hissLP.type = 'lowpass'; hissLP.frequency.value = 6800; hissLP.Q.value = 0.7;
    swellGain = ctx.createGain(); swellGain.gain.value = 0.75;
    const swell = ctx.createOscillator(); swell.frequency.value = 0.37;
    const swellAmp = ctx.createGain(); swellAmp.gain.value = 0.22; swell.connect(swellAmp); swellAmp.connect(swellGain.gain); swell.start();
    hissGain = ctx.createGain(); hissGain.gain.value = 0;
    hsrc.connect(hissHP); hissHP.connect(hissLP); hissLP.connect(swellGain); swellGain.connect(hissGain); hissGain.connect(boatBus);

    // 2) バウウェーブ/ハルのゴォーッ・ザァーッという中低域水流
    const rsrc = loopSource(brown, 1.65);
    rushFilter = ctx.createBiquadFilter(); rushFilter.type = 'bandpass'; rushFilter.frequency.value = 420; rushFilter.Q.value = 0.95;
    rushGain = ctx.createGain(); rushGain.gain.value = 0;
    rsrc.connect(rushFilter); rushFilter.connect(rushGain); rushGain.connect(boatBus);

    // 3) チャイン＆船底の「シュルル・コポコポ」という水脈共鳴レイヤー
    const csrc = loopSource(noiseBuf, 0.68);
    chineFilter = ctx.createBiquadFilter(); chineFilter.type = 'bandpass'; chineFilter.frequency.value = 820; chineFilter.Q.value = 2.4;
    chineGain = ctx.createGain(); chineGain.gain.value = 0;
    csrc.connect(chineFilter); chineFilter.connect(chineGain); chineGain.connect(boatBus);

    // セールのシバー(連続したバサバサ・バタバタ): 中低域の厚みを持たせたバンドパスと鋸波LFO
    const ssrc = loopSource(noiseBuf, 0.95);
    const sbp = ctx.createBiquadFilter(); sbp.type = 'bandpass'; sbp.frequency.value = 520; sbp.Q.value = 0.65;
    shiverGain = ctx.createGain(); shiverGain.gain.value = 0;
    shiverLfo = ctx.createOscillator(); shiverLfo.type = 'sawtooth'; shiverLfo.frequency.value = 10;
    const shiverAmp = ctx.createGain(); shiverAmp.gain.value = 0; shiverAmp._base = shiverGain;
    shiverLfo.connect(shiverAmp); shiverAmp.connect(shiverGain.gain); shiverLfo.start();
    ssrc.connect(sbp); sbp.connect(shiverGain); shiverGain.connect(boatBus);
    shiverGain._amp = shiverAmp;

    // 近づく他艇の波切り音(左右定位)
    const nsrc = loopSource(noiseBuf, 1.0);
    nearFilter = ctx.createBiquadFilter(); nearFilter.type = 'bandpass'; nearFilter.frequency.value = 1100; nearFilter.Q.value = 0.8;
    nearGain = ctx.createGain(); nearGain.gain.value = 0;
    nearPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    nsrc.connect(nearFilter); nearFilter.connect(nearGain);
    if (nearPan) { nearGain.connect(nearPan); nearPan.connect(master); } else nearGain.connect(master);
  } catch (e) { console.warn('audio init failed', e); ctx = null; }
}

export function setWind(speedNorm) { if (windGain && ctx) windGain.gain.setTargetAtTime(0.10 + 0.22 * speedNorm, ctx.currentTime, 0.3); }
export function setCameraAudio(cockpit) { camMul = cockpit ? 1.0 : 0.45; }
export function toggleMute() { muted = !muted; if (master) master.gain.value = muted ? 0 : 0.62; return muted; }

// ---- 艇の連続音＆多彩な水切りバリエーション(毎フレーム) ----
// 1) 気泡・水滴のポコポコ/ピチャッ (単発〜2連で音程・音色をランダム変化)
function bubble(sp) {
  const t = ctx.currentTime;
  const count = Math.random() < 0.42 ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const dt0 = i * (0.025 + Math.random() * 0.035);
    const o = ctx.createOscillator(), g = ctx.createGain();
    const f = 220 + Math.random() * 880;
    const dur = 0.045 + Math.random() * 0.045;
    o.type = Math.random() < 0.7 ? 'sine' : 'triangle';
    o.frequency.setValueAtTime(f, t + dt0);
    o.frequency.exponentialRampToValueAtTime(f * (1.35 + Math.random() * 1.35), t + dt0 + dur);
    const amp = (0.028 * sp + 0.005) * (0.75 + Math.random() * 0.5);
    g.gain.setValueAtTime(0.0001, t + dt0);
    g.gain.linearRampToValueAtTime(amp, t + dt0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dt0 + dur + 0.015);
    o.connect(g); g.connect(boatBus);
    o.start(t + dt0); o.stop(t + dt0 + dur + 0.025);
  }
}

// 2) バウが波頭を切り裂く「ザシュッ / シュワァーッ」という水切りスウィッシュ音
function bowSlice(sp, heel, upwind) {
  const t = ctx.currentTime;
  const dur = (upwind ? 0.28 : 0.44) + Math.random() * 0.26;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  s.playbackRate.value = 0.68 + Math.random() * 0.52;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.Q.value = 1.1 + Math.random() * 0.9;
  const fStart = 550 + Math.random() * 450;
  const fPeak = 1350 + sp * 1300 + Math.random() * 750;
  const fEnd = 340 + Math.random() * 260;
  bp.frequency.setValueAtTime(fStart, t);
  bp.frequency.exponentialRampToValueAtTime(fPeak, t + dur * 0.28);
  bp.frequency.exponentialRampToValueAtTime(fEnd, t + dur);

  const g = ctx.createGain();
  const vol = (0.06 + 0.20 * sp) * (1 + heel * 1.4) * (0.8 + Math.random() * 0.4);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + dur * 0.22);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.04);
  s.connect(bp); bp.connect(g); g.connect(boatBus);
  s.start(t, Math.random() * 1.3); s.stop(t + dur + 0.06);
}

// 3) チャイン・スターン渦の「チャプッ / シュルル / コポッ」という水流の揺らぎ
function wakeGurgle(sp, heel) {
  const t = ctx.currentTime;
  const pulses = 2 + ((Math.random() * 2) | 0);
  for (let i = 0; i < pulses; i++) {
    const t0 = t + i * (0.055 + Math.random() * 0.05);
    const dur = 0.09 + Math.random() * 0.09;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    s.playbackRate.value = 0.55 + Math.random() * 0.45;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.Q.value = 3.2 + Math.random() * 2.8;
    const f0 = 320 + Math.random() * 520;
    const f1 = f0 * (0.65 + Math.random() * 0.85);
    bp.frequency.setValueAtTime(f0, t0);
    bp.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    const vol = (0.045 + 0.14 * sp) * (1 + heel * 1.1) * (0.7 + Math.random() * 0.5);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.02);
    s.connect(bp); bp.connect(g); g.connect(boatBus);
    s.start(t0, Math.random() * 1.2); s.stop(t0 + dur + 0.03);
  }
}

// 4) ハルが波を叩くスラップ＆飛沫 (軽快なチョップ波・飛沫を伴うスプラッシュ・重めのバウバンプの3パターン)
function waveSlap(sp, heel) {
  const t = ctx.currentTime;
  const variant = Math.random();
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  s.playbackRate.value = 0.65 + Math.random() * 0.65;
  const f = ctx.createBiquadFilter();
  f.type = variant < 0.45 ? 'lowpass' : 'bandpass';
  f.Q.value = variant < 0.45 ? 1.3 : 0.95;
  const fHi = (variant < 0.35 ? 1100 : variant < 0.75 ? 1850 : 2400) + Math.random() * 700;
  const fLo = 180 + Math.random() * 160;
  const dur = (variant < 0.35 ? 0.28 : 0.42) + Math.random() * 0.18;
  f.frequency.setValueAtTime(fHi, t);
  f.frequency.exponentialRampToValueAtTime(fLo, t + dur);

  const g = ctx.createGain();
  const vol = (0.08 + 0.24 * sp) * (1 + heel * 1.5) * (0.8 + Math.random() * 0.4);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.010);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.04);
  s.connect(f); f.connect(g); g.connect(boatBus);
  s.start(t, Math.random() * 1.0); s.stop(t + dur + 0.06);

  // 船体のFRP共鳴音 (波の当たり方でピッチと深さが変化)
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = variant > 0.65 ? 'triangle' : 'sine';
  const bodyF0 = 78 + Math.random() * 42;
  o.frequency.setValueAtTime(bodyF0, t);
  o.frequency.exponentialRampToValueAtTime(bodyF0 * 0.48, t + 0.24);
  og.gain.setValueAtTime(0.0001, t);
  og.gain.linearRampToValueAtTime((0.11 + Math.random() * 0.08) * sp, t + 0.01);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  o.connect(og); og.connect(boatBus); o.start(t); o.stop(t + 0.32);
}

// 5) 三角波・短周期波にはたかれた際、海に船底がたたきつけられる控えめな「ドン / バシャン」という水叩き音
function hullWaveSlam(slam) {
  if (!ctx || !noiseBuf || !boatBus) return;
  const t = ctx.currentTime;
  const intensity = clamp01(slam);
  // 水面を叩く中低域スプラッシュ(控えめな音量)
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  s.playbackRate.value = 0.58 + Math.random() * 0.25;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.4;
  lp.frequency.setValueAtTime(780 + intensity * 420, t);
  lp.frequency.exponentialRampToValueAtTime(160, t + 0.26);
  const g = ctx.createGain();
  const vol = (0.045 + 0.075 * intensity) * (0.85 + Math.random() * 0.3);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  s.connect(lp); lp.connect(g); g.connect(boatBus);
  s.start(t, Math.random() * 1.0); s.stop(t + 0.30);

  // FRPハルが海面に着水・叩きつけられる重みのある「ドン」という共鳴音(抑え目)
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'triangle';
  const f0 = 92 + Math.random() * 22;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(38, t + 0.19);
  const thudVol = (0.055 + 0.085 * intensity) * (0.85 + Math.random() * 0.3);
  og.gain.setValueAtTime(0.0001, t);
  og.gain.linearRampToValueAtTime(thudVol, t + 0.008);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.21);
  o.connect(og); og.connect(boatBus);
  o.start(t); o.stop(t + 0.23);
}

// シバー時の「バサバサッ」というセールクロスの連続はためきパルス
function shiverFlap(lv) {
  if (!ctx || !noiseBuf) return;
  const t = ctx.currentTime;
  const dur = 0.08 + Math.random() * 0.06;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  s.playbackRate.value = 0.75 + Math.random() * 0.4;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.setValueAtTime(520 + Math.random() * 380, t);
  bp.frequency.exponentialRampToValueAtTime(240 + Math.random() * 140, t + dur);
  bp.Q.value = 0.75;
  const g = ctx.createGain();
  const peak = (0.28 + 0.52 * lv) * (0.85 + Math.random() * 0.3);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.014);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(bp); bp.connect(g); g.connect(master);
  s.start(t, Math.random() * 1.2); s.stop(t + dur + 0.02);

  // 布が風を叩く低音の「ボワッ/バサッ」成分
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'triangle';
  const f0 = 115 + Math.random() * 45;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(52, t + dur * 0.9);
  og.gain.setValueAtTime(0.0001, t);
  og.gain.linearRampToValueAtTime(0.22 * lv, t + 0.01);
  og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(og); og.connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

// active=false(一時停止/メニュー)で無音。b は自艇。
export function updateSailingAudio(dt, b, active = true) {
  if (!ctx || !hissGain) return;
  const now = ctx.currentTime;
  boatBus.gain.setTargetAtTime(active ? camMul : 0, now, 0.25);
  const v = active && b ? Math.abs(b.v) : 0;
  const sp = clamp01(v / 8);
  const heel = active && b ? Math.min(0.4, Math.abs(b.heel)) : 0;
  const twa = active && b ? b.twa || 1.0 : 1.0;
  const upwind = twa < 1.35;

  // 波との出会い周期(クローズでは波に突っ込むため周期が速く、ランニングでは波に乗ってゆったりうねる)
  const encRate = (0.8 + sp * (upwind ? 3.2 : 1.7)) * 1.4;
  wPhase += dt * encRate;
  const waveMod1 = Math.sin(wPhase);
  const waveMod2 = Math.sin(wPhase * 1.618 + 0.9);
  const waveMod3 = Math.sin(wPhase * 0.47 + 2.1);
  const dynWave = clampN(0.5 + 0.28 * waveMod1 + 0.18 * waveMod2 + 0.12 * waveMod3, 0.1, 1.15);

  // 連続水流音のゲインとフィルタ周波数を波のうねり・ヒール・艇速で絶えず表情付けする
  hissGain.gain.setTargetAtTime((0.008 + 0.26 * Math.pow(sp, 1.35)) * (1 + heel * 2.2) * (0.72 + 0.55 * dynWave), now, 0.08);
  if (hissHP && hissLP) {
    hissHP.frequency.setTargetAtTime(1050 + sp * 480 - heel * 500 + waveMod2 * 220, now, 0.10);
    hissLP.frequency.setTargetAtTime(3800 + sp * 3600 + dynWave * 1600, now, 0.10);
  }
  rushGain.gain.setTargetAtTime((0.015 + 0.25 * sp) * (0.78 + 0.45 * (1 - dynWave)), now, 0.12);
  rushFilter.frequency.setTargetAtTime(260 + sp * 780 + waveMod1 * 140 + heel * 260, now, 0.12);

  if (chineGain && chineFilter) {
    chineGain.gain.setTargetAtTime(sp * (0.04 + 0.12 * heel + 0.05 * Math.abs(waveMod2)), now, 0.10);
    chineFilter.frequency.setTargetAtTime(580 + sp * 620 + waveMod3 * 240, now, 0.10);
  }

  // シバー (バサバサ音を大きく・はっきりと再生)
  const luff = active && b ? clamp01(b.luff) : 0;
  const lv = luff > 0.08 ? luff : 0;
  shiverGain.gain.setTargetAtTime(lv * 0.58, now, 0.04);
  shiverGain._amp.gain.setTargetAtTime(lv * 0.52, now, 0.04);
  tShiver -= dt;
  if (tShiver <= 0) {
    tShiver = 0.075 + Math.random() * 0.055;
    shiverLfo.frequency.setValueAtTime(8 + Math.random() * 7, now);
    if (active && lv > 0.08) shiverFlap(lv);
  }
  if (!active) return;

  // 三角波・急な波にはたかれた際の船底着水スラム音(抑え目)
  if (b && b.waveSlam > 0) {
    const slam = b.waveSlam;
    b.waveSlam = 0;
    hullWaveSlam(slam);
  }

  // 気泡・チャインの水滴音
  tBubble -= dt;
  if (tBubble <= 0 && sp > 0.06) {
    tBubble = (0.05 + Math.random() * 0.15) / (0.35 + sp * 1.85);
    bubble(sp);
  }
  // バウが波を切り裂く「ザシュッ / シュワァー」バリエーション
  tSlice -= dt;
  if (tSlice <= 0 && sp > 0.10) {
    tSlice = (0.38 + Math.random() * 0.68) / (0.45 + sp * (upwind ? 1.55 : 1.05));
    bowSlice(sp, heel, upwind);
  }
  // 船底・スターン渦の「チャプッ / コポッ」バリエーション
  tGurgle -= dt;
  if (tGurgle <= 0 && sp > 0.08) {
    tGurgle = (0.28 + Math.random() * 0.55) / (0.4 + sp * 1.4);
    wakeGurgle(sp, heel);
  }
  // 波打ちスラップ音
  tSlap -= dt;
  if (tSlap <= 0 && sp > 0.14) {
    tSlap = (0.35 + Math.random() * 0.88) / (0.35 + sp * (upwind ? 1.45 : 1.05));
    waveSlap(sp, heel);
  }
}

// 他艇が近づくと波切り音が大きく。player の進行方向に対する左右へ定位。
export function updateNearbyBoatSound(player, boats, active = true) {
  if (!ctx || !nearGain || !player) return;
  let best = null, bd = 1e9;
  for (const b of boats) {
    if (b === player) continue;
    const d = Math.hypot(b.x - player.x, b.z - player.z);
    if (d < bd) { bd = d; best = b; }
  }
  const now = ctx.currentTime;
  if (active && best && bd < 40) {
    const prox = 1 - bd / 40;
    const fwd = clamp01(best.v / 6) * 0.7 + 0.3;
    nearGain.gain.setTargetAtTime(Math.pow(prox, 1.4) * 0.5 * fwd * camMul, now, 0.1);
    nearFilter.frequency.setTargetAtTime(800 + prox * 1100, now, 0.1);
    if (nearPan) {
      const rx = Math.cos(player.h), rz = Math.sin(player.h);
      nearPan.pan.setTargetAtTime(clampN(((best.x - player.x) * rx + (best.z - player.z) * rz) / (bd || 1), -1, 1), now, 0.1);
    }
  } else nearGain.gain.setTargetAtTime(0, now, 0.15);
}

// ---- エアホーン ----
// dur: 吹鳴秒数, f0: 基音(Hz), vol: 音量
export function airHorn(dur = 1.0, f0 = 392, vol = 0.5) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(vol, t + 0.065);               // 空気が立ち上がる
  env.gain.setValueAtTime(vol * 0.93, t + Math.max(0.12, dur - 0.04));
  env.gain.exponentialRampToValueAtTime(0.0006, t + dur + 0.2);   // 余韻
  const shaper = ctx.createWaveShaper(); shaper.curve = softClip(2.4); shaper.oversample = '2x';
  const form = ctx.createBiquadFilter(); form.type = 'peaking'; form.frequency.value = 1150; form.gain.value = 7; form.Q.value = 1.0;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400; lp.Q.value = 0.6;
  const mix = ctx.createGain(); mix.gain.value = 0.2;
  mix.connect(shaper); shaper.connect(form); form.connect(lp); lp.connect(env);
  env.connect(master);
  const send = ctx.createGain(); send.gain.value = 0.5; env.connect(send); send.connect(fx);
  const oscs = [];
  [[1, 'sawtooth', 0], [1.006, 'sawtooth', 4], [0.994, 'sawtooth', -4], [2, 'square', 0], [3.01, 'sawtooth', 0]].forEach(([m, type, det], i) => {
    const o = ctx.createOscillator(); o.type = type; o.detune.value = det;
    o.frequency.setValueAtTime(f0 * m * 0.9, t);
    o.frequency.exponentialRampToValueAtTime(f0 * m, t + 0.14);               // 吹き始めの音程上昇
    o.frequency.setValueAtTime(f0 * m, t + Math.max(0.2, dur - 0.1));
    o.frequency.exponentialRampToValueAtTime(f0 * m * 0.965, t + dur + 0.15); // 終わりに少し下がる
    const g = ctx.createGain(); g.gain.value = i >= 3 ? 0.35 / (i - 1) : 1;
    o.connect(g); g.connect(mix); o.start(t); o.stop(t + dur + 0.4); oscs.push(o);
  });
  // 空気の吹き出しノイズ
  const ns = ctx.createBufferSource(); ns.buffer = noiseBuf; ns.loop = true;
  const nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 2300; nb.Q.value = 0.6;
  const ng = ctx.createGain(); ng.gain.value = 0.16;
  ns.connect(nb); nb.connect(ng); ng.connect(mix); ns.start(t); ns.stop(t + dur + 0.4);
  // 微かな震え
  const lfo = ctx.createOscillator(); lfo.frequency.value = 34;
  const la = ctx.createGain(); la.gain.value = f0 * 0.005; lfo.connect(la);
  oscs.forEach((o) => la.connect(o.frequency)); lfo.start(t); lfo.stop(t + dur + 0.4);
}
// 競技委員会の信号: 'long'=1分前(長い1音) / 'short'=スタート(短い1音)
export function signalHorn(kind) {
  if (kind === 'long') airHorn(1.7, 415, 0.55);
  else airHorn(0.75, 415, 0.62);
}
// 互換: 旧API
export function horn(dur = 0.25, freq = 440) { airHorn(dur, freq * 0.9, 0.42); }

export function beep(freq = 880, dur = 0.08) {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.2, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  o.connect(g); g.connect(master); o.start(); o.stop(ctx.currentTime + dur + 0.02);
}

function noiseBurst(dur, freq, type, vol) {
  if (!ctx) return;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
  const g = ctx.createGain(); const t = ctx.currentTime;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random() * 1.2); s.stop(t + dur + 0.02);
}
function tone(freq, dur, type, vol, endFreq) {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
}

// 艇同士の衝突(FRPの「ゴツン」+ きしみ)
export function thud(vol = 1) {
  if (!ctx || vol <= 0.02) return;
  tone(130, 0.22, 'sine', 0.7 * vol, 45);
  noiseBurst(0.18, 600, 'lowpass', 0.8 * vol);
  noiseBurst(0.07, 2200, 'bandpass', 0.35 * vol);
}
// マーク接触(ブイの「ボコン」という中空音)
export function markHit(vol = 1) {
  if (!ctx || vol <= 0.02) return;
  tone(210, 0.5, 'triangle', 0.55 * vol, 150);
  tone(330, 0.35, 'sine', 0.3 * vol, 260);
  tone(540, 0.2, 'sine', 0.15 * vol);
  noiseBurst(0.06, 1500, 'bandpass', 0.4 * vol);
}
// セールが「パンッ」と返る音(タック/ジャイブ時)
export function flap(vol = 0.6) {
  if (!ctx || vol <= 0.02) return;
  noiseBurst(0.07, 1300 + Math.random() * 500, 'bandpass', 0.42 * vol);
  tone(70 + Math.random() * 25, 0.09, 'sawtooth', 0.1 * vol);
}
// タック/ジャイブでセールが返る自然な「バサッ」: セールクロスが風を切って裏返る柔らかい布擦れ音と風をはらむ低い「バサッ」
export function sailFlog(vol = 0.8) {
  if (!ctx || vol <= 0.02) return;
  const t0 = ctx.currentTime;
  // 1) 「シュッ…バサッ」: セール布が大きくしなって空気を切る中低域〜中域の布音 (機械的な連打をなくし、1回の自然な布の返しにする)
  const s1 = ctx.createBufferSource(); s1.buffer = noiseBuf; s1.playbackRate.value = 0.72;
  const bp1 = ctx.createBiquadFilter(); bp1.type = 'bandpass'; bp1.Q.value = 0.65;
  bp1.frequency.setValueAtTime(320, t0);
  bp1.frequency.exponentialRampToValueAtTime(780, t0 + 0.08);
  bp1.frequency.exponentialRampToValueAtTime(260, t0 + 0.34);
  const g1 = ctx.createGain();
  g1.gain.setValueAtTime(0.0001, t0);
  g1.gain.linearRampToValueAtTime(0.38 * vol, t0 + 0.035); // 風をまたぐ瞬間の「バ」
  g1.gain.linearRampToValueAtTime(0.55 * vol, t0 + 0.095); // 裏返って張る「サッ」
  g1.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.38);
  s1.connect(bp1); bp1.connect(g1); g1.connect(master);
  s1.start(t0, Math.random() * 1.0); s1.stop(t0 + 0.42);

  // 2) ジブのリーチが軽く一度だけ揺れる柔らかい余韻
  const s2 = ctx.createBufferSource(); s2.buffer = noiseBuf; s2.playbackRate.value = 0.85;
  const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.setValueAtTime(950, t0 + 0.12); lp2.frequency.exponentialRampToValueAtTime(280, t0 + 0.45);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.0001, t0 + 0.12);
  g2.gain.linearRampToValueAtTime(0.32 * vol, t0 + 0.17);
  g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.46);
  s2.connect(lp2); lp2.connect(g2); g2.connect(master);
  s2.start(t0 + 0.12, Math.random() * 1.0); s2.stop(t0 + 0.5);

  // 3) 新しいタックでセールが風をはらむ柔らかい低域の「ボフッ」
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(92, t0 + 0.06); o.frequency.exponentialRampToValueAtTime(42, t0 + 0.28);
  og.gain.setValueAtTime(0.0001, t0 + 0.06); og.gain.linearRampToValueAtTime(0.28 * vol, t0 + 0.09); og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.30);
  o.connect(og); og.connect(master); o.start(t0 + 0.06); o.stop(t0 + 0.32);
}
// ランチャー上げ下げの実艇音「シャキンッ！＋バサッ！」:
// ①アルミポールとステンレスリングが擦れる鮮明な金属スライド音「シャ」→
// ②ストッパー金具・ステンレスフックとアルミパイプがぶつかり共鳴するクリアな高域金属音「キンッ！」→ ③ジブが張るダクロン布の「バサッ」
export function poleClank(up = true, vol = 0.85) {
  if (!ctx || vol <= 0.02) return;
  const t = ctx.currentTime;
  const slideDur = 0.088;

  // 1) 「シャ」: アルミポールがステンレス製ランチャーリングを高速で滑る金属擦過音(高域レゾナンス付き)
  const sSlide = ctx.createBufferSource(); sSlide.buffer = noiseBuf;
  sSlide.playbackRate.value = up ? 1.18 : 0.96;
  const bpSlide = ctx.createBiquadFilter(); bpSlide.type = 'bandpass'; bpSlide.Q.value = 4.2;
  bpSlide.frequency.setValueAtTime(up ? 2600 : 4800, t);
  bpSlide.frequency.exponentialRampToValueAtTime(up ? 5800 : 2300, t + slideDur);
  const gSlide = ctx.createGain();
  gSlide.gain.setValueAtTime(0.0001, t);
  gSlide.gain.linearRampToValueAtTime(0.52 * vol, t + 0.010);
  gSlide.gain.setValueAtTime(0.48 * vol, t + slideDur - 0.012);
  gSlide.gain.exponentialRampToValueAtTime(0.0001, t + slideDur + 0.020);
  sSlide.connect(bpSlide); bpSlide.connect(gSlide); gSlide.connect(master);
  sSlide.start(t, Math.random() * 1.2); sSlide.stop(t + slideDur + 0.028);

  // アルミチューブがリングを滑る金属倍音スイープ(「シャ」に金属の質感を付与)
  for (const [f0, f1, a] of [[2400, 3900, 0.14], [3850, 6200, 0.12]]) {
    const om = ctx.createOscillator(), ogm = ctx.createGain();
    om.type = 'sine';
    om.frequency.setValueAtTime(up ? f0 : f1, t);
    om.frequency.exponentialRampToValueAtTime(up ? f1 : f0, t + slideDur);
    ogm.gain.setValueAtTime(0.0001, t);
    ogm.gain.linearRampToValueAtTime(a * vol, t + 0.012);
    ogm.gain.exponentialRampToValueAtTime(0.0001, t + slideDur);
    om.connect(ogm); ogm.connect(master);
    om.start(t); om.stop(t + slideDur + 0.01);
  }

  // 2) 「キンッ！」: アルミポール先端金具・ステンレスリング・カムクリートが噛み合う硬く澄んだ金属打撃＆高域非整数次倍音リング
  const tk = t + slideDur * 0.85;
  const sClick = ctx.createBufferSource(); sClick.buffer = noiseBuf;
  const hpClick = ctx.createBiquadFilter(); hpClick.type = 'bandpass'; hpClick.frequency.value = up ? 6200 : 5200; hpClick.Q.value = 3.2;
  const gClick = ctx.createGain();
  gClick.gain.setValueAtTime(0.0001, tk);
  gClick.gain.linearRampToValueAtTime(0.68 * vol, tk + 0.0015);
  gClick.gain.exponentialRampToValueAtTime(0.0001, tk + 0.024);
  sClick.connect(hpClick); hpClick.connect(gClick); gClick.connect(master);
  sClick.start(tk, Math.random() * 1.0); sClick.stop(tk + 0.030);

  // アルミパイプ＋ステンレス金具特有の非整数倍音モード(「キーン/キンッ」という鮮明な金属の響き)
  for (const [f, a, d, delay] of [
    [1940, 0.24, 0.085, 0.0],
    [2890, 0.34, 0.105, 0.0],
    [4180, 0.36, 0.095, 0.002],
    [5640, 0.28, 0.080, 0.002],
    [7420, 0.20, 0.065, 0.004],
    [9150, 0.12, 0.048, 0.004],
    // 二段目のわずかな金具ラッチ音(「カチンッ」の立体感)
    [3480, 0.22, 0.070, 0.018],
    [5220, 0.20, 0.060, 0.018],
  ]) {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine';
    const tStart = tk + delay;
    const fStart = f * (up ? 1.0 : 0.90);
    o.frequency.setValueAtTime(fStart * 1.05, tStart);
    o.frequency.exponentialRampToValueAtTime(fStart, tStart + 0.009);
    og.gain.setValueAtTime(0.0001, tStart);
    og.gain.linearRampToValueAtTime(a * vol, tStart + 0.0012);
    og.gain.exponentialRampToValueAtTime(0.0001, tStart + d);
    o.connect(og); og.connect(master);
    o.start(tStart); o.stop(tStart + d + 0.01);
  }

  // 3) 「バサッ！」: ポールが突き出てジブセールが風をはらむ(または収納で裏返る)リアルなダクロン布音
  const tf = tk + 0.038;
  // 布の先端が弾けるアタック
  const sSnap = ctx.createBufferSource(); sSnap.buffer = noiseBuf; sSnap.playbackRate.value = 0.82;
  const bpSnap = ctx.createBiquadFilter(); bpSnap.type = 'bandpass'; bpSnap.frequency.value = up ? 860 : 720; bpSnap.Q.value = 1.1;
  const gSnap = ctx.createGain();
  gSnap.gain.setValueAtTime(0.0001, tf);
  gSnap.gain.linearRampToValueAtTime((up ? 0.52 : 0.38) * vol, tf + 0.008);
  gSnap.gain.exponentialRampToValueAtTime(0.0001, tf + 0.065);
  sSnap.connect(bpSnap); bpSnap.connect(gSnap); gSnap.connect(master);
  sSnap.start(tf, Math.random() * 1.0); sSnap.stop(tf + 0.075);

  // セールクロス全体の「バサッ」という中低域の布擦れ＋膨らみ音
  const sf = ctx.createBufferSource(); sf.buffer = noiseBuf;
  sf.playbackRate.value = up ? 0.72 : 0.78;
  const bpf = ctx.createBiquadFilter(); bpf.type = 'bandpass'; bpf.Q.value = 0.70;
  bpf.frequency.setValueAtTime(up ? 340 : 420, tf);
  bpf.frequency.exponentialRampToValueAtTime(up ? 680 : 540, tf + 0.055);
  bpf.frequency.exponentialRampToValueAtTime(210, tf + 0.25);
  const gf = ctx.createGain();
  const flapVol = (up ? 0.58 : 0.44) * vol;
  gf.gain.setValueAtTime(0.0001, tf);
  gf.gain.linearRampToValueAtTime(flapVol * 0.85, tf + 0.020);
  gf.gain.linearRampToValueAtTime(flapVol, tf + 0.068);
  gf.gain.exponentialRampToValueAtTime(0.0001, tf + 0.27);
  sf.connect(bpf); bpf.connect(gf); gf.connect(master);
  sf.start(tf, Math.random() * 1.0); sf.stop(tf + 0.29);

  // セールが風を受け止める低い「ボフッ」という空気圧音
  const bf = ctx.createOscillator(), bfg = ctx.createGain();
  bf.type = 'sine';
  bf.frequency.setValueAtTime(up ? 98 : 84, tf + 0.015);
  bf.frequency.exponentialRampToValueAtTime(42, tf + 0.19);
  bfg.gain.setValueAtTime(0.0001, tf + 0.015);
  bfg.gain.linearRampToValueAtTime((up ? 0.30 : 0.20) * vol, tf + 0.042);
  bfg.gain.exponentialRampToValueAtTime(0.0001, tf + 0.21);
  bf.connect(bfg); bfg.connect(master);
  bf.start(tf + 0.015); bf.stop(tf + 0.23);
}

// オリエンテーション(スマブラ風 HOW TO PLAY)のステップ切り替え効果音: シャープな風切りスラッシュ＋重厚なインパクト音
export function orientStepSfx(accent = false) {
  if (!ctx) return;
  const t = ctx.currentTime;
  // 1) 高速スラッシュ風切り音
  const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 1.15;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.6;
  bp.frequency.setValueAtTime(650, t);
  bp.frequency.exponentialRampToValueAtTime(2800, t + 0.055);
  bp.frequency.exponentialRampToValueAtTime(420, t + 0.16);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.38, t + 0.018);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
  s.connect(bp); bp.connect(g); g.connect(master);
  s.start(t, Math.random() * 0.8); s.stop(t + 0.19);

  // 2) 低域インパクト + キレのあるブラス風コードヒット
  const punch = ctx.createOscillator(), pg = ctx.createGain();
  punch.type = 'triangle';
  punch.frequency.setValueAtTime(accent ? 165 : 135, t);
  punch.frequency.exponentialRampToValueAtTime(46, t + 0.16);
  pg.gain.setValueAtTime(0.0001, t);
  pg.gain.linearRampToValueAtTime(0.42, t + 0.006);
  pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  punch.connect(pg); pg.connect(master);
  punch.start(t); punch.stop(t + 0.20);

  const notes = accent ? [523.25, 659.25, 783.99, 1046.5] : [440, 554.37, 659.25];
  notes.forEach((freq, i) => {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sawtooth';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(680, t + 0.22);
    o.frequency.setValueAtTime(freq, t + i * 0.008);
    og.gain.setValueAtTime(0.0001, t + i * 0.008);
    og.gain.linearRampToValueAtTime(0.085, t + i * 0.008 + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t + (accent ? 0.34 : 0.22));
    o.connect(lp); lp.connect(og); og.connect(master);
    o.start(t + i * 0.008); o.stop(t + 0.36);
  });
}

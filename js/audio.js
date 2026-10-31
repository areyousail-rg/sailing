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
let bgmMode = null, bgmTimer = null, bgmBus = null;
let bgmVoiceEnabled = true;

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

let unlockListenersBound = false;
function ensureAudioUnlockListeners() {
  if (unlockListenersBound || typeof window === 'undefined') return;
  unlockListenersBound = true;
  const events = ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchend', 'keydown', 'wheel', 'click', 'focus'];
  const tryUnlock = () => {
    if (!ctx) initAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    if (ctx.state === 'running') {
      events.forEach((ev) => {
        window.removeEventListener(ev, tryUnlock, true);
        document.removeEventListener(ev, tryUnlock, true);
      });
    }
  };
  events.forEach((ev) => {
    window.addEventListener(ev, tryUnlock, { capture: true, passive: true });
    document.addEventListener(ev, tryUnlock, { capture: true, passive: true });
  });
}
ensureAudioUnlockListeners();

export function initAudio() {
  ensureAudioUnlockListeners();
  if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.onstatechange = () => {
      if (ctx && ctx.state === 'running' && bgmMode && bgmVoiceEnabled) {
        const curMode = bgmMode;
        bgmMode = null;
        playBgm(curMode);
      }
    };
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
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
export function isBgmVoiceEnabled() { return bgmVoiceEnabled; }
export function setBgmVoiceEnabled(on) {
  bgmVoiceEnabled = !!on;
  if (!bgmVoiceEnabled) {
    if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
    if (bgmBus && ctx) {
      const oldBus = bgmBus;
      bgmBus = null;
      try {
        oldBus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
        setTimeout(() => { try { oldBus.disconnect(); } catch (e) {} }, 200);
      } catch (e) {}
    }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
  } else if (bgmMode) {
    const m = bgmMode;
    bgmMode = null;
    playBgm(m);
  }
}

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

// シバー時の「バサバサッ」というセールクロスの連続はためきパルス (0度風位でもうるさくならないよう控えめな布音のみにする)
function shiverFlap(lv) {
  if (!ctx || !noiseBuf || !boatBus) return;
  const t = ctx.currentTime;
  const dur = 0.075 + Math.random() * 0.05;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  s.playbackRate.value = 0.78 + Math.random() * 0.35;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.setValueAtTime(540 + Math.random() * 320, t);
  bp.frequency.exponentialRampToValueAtTime(260 + Math.random() * 120, t + dur);
  bp.Q.value = 0.85;
  const g = ctx.createGain();
  const peak = (0.08 + 0.14 * lv) * (0.85 + Math.random() * 0.3);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.014);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(bp); bp.connect(g); g.connect(boatBus);
  s.start(t, Math.random() * 1.2); s.stop(t + dur + 0.02);
}

// active=false(一時停止/メニュー/リザルト/振り返り)で無音。レース中BGM('race_enoshima'/'race_hakkeijima')は帆走音と同時に鳴らす。
export function updateSailingAudio(dt, b, active = true) {
  if (!ctx || !hissGain) return;
  const now = ctx.currentTime;
  const isSilentBgm = bgmMode === 'result' || bgmMode === 'review' || bgmMode === 'menu';
  if (!active || isSilentBgm) {
    boatBus.gain.setTargetAtTime(0, now, 0.05);
    hissGain.gain.setTargetAtTime(0, now, 0.04);
    rushGain.gain.setTargetAtTime(0, now, 0.04);
    if (chineGain) chineGain.gain.setTargetAtTime(0, now, 0.04);
    shiverGain.gain.setTargetAtTime(0, now, 0.02);
    shiverGain._amp.gain.setTargetAtTime(0, now, 0.02);
    if (nearGain) nearGain.gain.setTargetAtTime(0, now, 0.05);
    if (windGain && isSilentBgm) windGain.gain.setTargetAtTime(0.015, now, 0.12);
    return;
  }
  boatBus.gain.setTargetAtTime(camMul, now, 0.20);
  const v = b ? Math.abs(b.v) : 0;
  const sp = clamp01(v / 8);
  const heel = b ? Math.min(0.4, Math.abs(b.heel)) : 0;
  const twa = b ? b.twa || 1.0 : 1.0;
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

  // シバー (0度風位でもうるさくならないよう控えめな音量で再生)
  const luff = active && b ? clamp01(b.luff) : 0;
  const lv = luff > 0.08 ? luff : 0;
  shiverGain.gain.setTargetAtTime(lv * 0.20, now, 0.04);
  shiverGain._amp.gain.setTargetAtTime(lv * 0.16, now, 0.04);
  tShiver -= dt;
  if (tShiver <= 0) {
    tShiver = 0.095 + Math.random() * 0.065;
    shiverLfo.frequency.setValueAtTime(8 + Math.random() * 6, now);
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
// セールが「パンッ」と返る音(タック/ジャイブ時: 低音ブザー成分を排し、セール布の音のみ)
export function flap(vol = 0.6) {
  if (!ctx || vol <= 0.02) return;
  noiseBurst(0.07, 1300 + Math.random() * 500, 'bandpass', 0.42 * vol);
}
// タック/ジャイブでセールが返る自然な「バサッ」: 低音の「ブウ」というオシレーター音を廃し、純粋なセールクロスの布音だけで表現
export function sailFlog(vol = 0.8) {
  if (!ctx || vol <= 0.02) return;
  const t0 = ctx.currentTime;
  // 1) 「シュッ…バサッ」: セール布が大きくしなって空気を切る中低域〜中域の布音
  const s1 = ctx.createBufferSource(); s1.buffer = noiseBuf; s1.playbackRate.value = 0.78;
  const bp1 = ctx.createBiquadFilter(); bp1.type = 'bandpass'; bp1.Q.value = 0.72;
  bp1.frequency.setValueAtTime(380, t0);
  bp1.frequency.exponentialRampToValueAtTime(860, t0 + 0.08);
  bp1.frequency.exponentialRampToValueAtTime(310, t0 + 0.34);
  const g1 = ctx.createGain();
  g1.gain.setValueAtTime(0.0001, t0);
  g1.gain.linearRampToValueAtTime(0.38 * vol, t0 + 0.035); // 風をまたぐ瞬間の「バ」
  g1.gain.linearRampToValueAtTime(0.55 * vol, t0 + 0.095); // 裏返って張る「サッ」
  g1.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.36);
  s1.connect(bp1); bp1.connect(g1); g1.connect(master);
  s1.start(t0, Math.random() * 1.0); s1.stop(t0 + 0.40);

  // 2) ジブのリーチが軽く一度だけ揺れる柔らかい布の余韻
  const s2 = ctx.createBufferSource(); s2.buffer = noiseBuf; s2.playbackRate.value = 0.90;
  const lp2 = ctx.createBiquadFilter(); lp2.type = 'bandpass'; lp2.Q.value = 0.85;
  lp2.frequency.setValueAtTime(980, t0 + 0.11);
  lp2.frequency.exponentialRampToValueAtTime(360, t0 + 0.42);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.0001, t0 + 0.11);
  g2.gain.linearRampToValueAtTime(0.30 * vol, t0 + 0.16);
  g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.43);
  s2.connect(lp2); lp2.connect(g2); g2.connect(master);
  s2.start(t0 + 0.11, Math.random() * 1.0); s2.stop(t0 + 0.46);
}
// ランチャー上げ下げの実艇音「シャキンーーッ！＋バサッ！」:
// ①アルミポールとステンレスリングが擦れる長めで鮮明な金属スライド音「シャーー」→
// ②ストッパー金具・ステンレスフックとアルミパイプがぶつかり共鳴する伸びのある高域金属音「キーンッ！」→ ③ジブが風をはらむ明確なダクロン布音「バサッ！」
export function poleClank(up = true, vol = 0.88) {
  if (!ctx || vol <= 0.02) return;
  const t = ctx.currentTime;
  const slideDur = up ? 0.195 : 0.105;

  // 1) 「シャーー」: アルミポールがステンレス製ランチャーリングを滑る長めの金属擦過音(高域レゾナンス付き)
  const sSlide = ctx.createBufferSource(); sSlide.buffer = noiseBuf;
  sSlide.playbackRate.value = up ? 1.12 : 0.96;
  const bpSlide = ctx.createBiquadFilter(); bpSlide.type = 'bandpass'; bpSlide.Q.value = up ? 4.8 : 4.0;
  bpSlide.frequency.setValueAtTime(up ? 2350 : 4800, t);
  bpSlide.frequency.exponentialRampToValueAtTime(up ? 6200 : 2300, t + slideDur);
  const gSlide = ctx.createGain();
  gSlide.gain.setValueAtTime(0.0001, t);
  gSlide.gain.linearRampToValueAtTime(0.56 * vol, t + 0.016);
  gSlide.gain.setValueAtTime(0.52 * vol, t + slideDur - 0.018);
  gSlide.gain.exponentialRampToValueAtTime(0.0001, t + slideDur + 0.032);
  sSlide.connect(bpSlide); bpSlide.connect(gSlide); gSlide.connect(master);
  sSlide.start(t, Math.random() * 1.2); sSlide.stop(t + slideDur + 0.040);

  // アルミチューブがリングを滑る金属倍音スイープ(長めの「シャーー」にリアルな金属管の擦れ感を付与)
  for (const [f0, f1, a] of [[2200, 4150, 0.16], [3600, 6450, 0.14], [5100, 8200, 0.08]]) {
    const om = ctx.createOscillator(), ogm = ctx.createGain();
    om.type = 'sine';
    om.frequency.setValueAtTime(up ? f0 : f1, t);
    om.frequency.exponentialRampToValueAtTime(up ? f1 : f0, t + slideDur);
    ogm.gain.setValueAtTime(0.0001, t);
    ogm.gain.linearRampToValueAtTime(a * vol, t + 0.018);
    ogm.gain.setValueAtTime(a * 0.9 * vol, t + slideDur * 0.78);
    ogm.gain.exponentialRampToValueAtTime(0.0001, t + slideDur + 0.015);
    om.connect(ogm); ogm.connect(master);
    om.start(t); om.stop(t + slideDur + 0.02);
  }

  // 2) 「キーンッ！」: アルミポール先端金具・ステンレスリング・ストッパーが噛み合う硬く澄んだ金属打撃＆長めの高域余韻リング
  const tk = t + slideDur * 0.84;
  const sClick = ctx.createBufferSource(); sClick.buffer = noiseBuf;
  const hpClick = ctx.createBiquadFilter(); hpClick.type = 'bandpass'; hpClick.frequency.value = up ? 6300 : 5100; hpClick.Q.value = 3.5;
  const gClick = ctx.createGain();
  gClick.gain.setValueAtTime(0.0001, tk);
  gClick.gain.linearRampToValueAtTime(0.72 * vol, tk + 0.0015);
  gClick.gain.exponentialRampToValueAtTime(0.0001, tk + 0.032);
  sClick.connect(hpClick); hpClick.connect(gClick); gClick.connect(master);
  sClick.start(tk, Math.random() * 1.0); sClick.stop(tk + 0.038);

  // アルミパイプ＋ステンレス金具特有の非整数倍音モード(アップ時は余韻を約2倍長くして「シャキンーーッ！」を強調)
  const ringMul = up ? 2.15 : 1.15;
  for (const [f, a, d, delay] of [
    [1940, 0.26, 0.105, 0.0],
    [2890, 0.38, 0.130, 0.0],
    [4180, 0.40, 0.120, 0.002],
    [5640, 0.30, 0.095, 0.002],
    [7420, 0.22, 0.080, 0.004],
    [9150, 0.14, 0.060, 0.004],
    // 二段目の金具ラッチ音(「カチンッ」の立体感と余韻)
    [3480, 0.25, 0.095, 0.024],
    [5220, 0.22, 0.085, 0.024],
  ]) {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine';
    const tStart = tk + delay;
    const dur = d * ringMul;
    const fStart = f * (up ? 1.0 : 0.90);
    o.frequency.setValueAtTime(fStart * 1.05, tStart);
    o.frequency.exponentialRampToValueAtTime(fStart, tStart + 0.011);
    og.gain.setValueAtTime(0.0001, tStart);
    og.gain.linearRampToValueAtTime(a * vol, tStart + 0.0014);
    og.gain.exponentialRampToValueAtTime(0.0001, tStart + dur);
    o.connect(og); og.connect(master);
    o.start(tStart); o.stop(tStart + dur + 0.015);
  }

  // 3) 「バサッ！」: ポールが突き出てジブセールが風をはらむ(または収納で裏返る)明確で厚みのあるダクロンセール布音
  const tf = tk + (up ? 0.072 : 0.038);
  // 布のリーチ・クリューが弾ける鮮明なアタック(2連フラップで「バサッ！」の質感を再現)
  for (const [subDelay, rate, freq, gainA, dur] of [
    [0.000, 0.88, up ? 920 : 760, up ? 0.72 : 0.48, 0.085],
    [0.052, 0.76, up ? 680 : 580, up ? 0.64 : 0.40, 0.110],
  ]) {
    const tSub = tf + subDelay;
    const sSnap = ctx.createBufferSource(); sSnap.buffer = noiseBuf; sSnap.playbackRate.value = rate;
    const bpSnap = ctx.createBiquadFilter(); bpSnap.type = 'bandpass'; bpSnap.frequency.value = freq; bpSnap.Q.value = 1.05;
    const gSnap = ctx.createGain();
    gSnap.gain.setValueAtTime(0.0001, tSub);
    gSnap.gain.linearRampToValueAtTime(gainA * vol, tSub + 0.009);
    gSnap.gain.exponentialRampToValueAtTime(0.0001, tSub + dur);
    sSnap.connect(bpSnap); bpSnap.connect(gSnap); gSnap.connect(master);
    sSnap.start(tSub, Math.random() * 1.0); sSnap.stop(tSub + dur + 0.015);
  }

  // セールクロス全体の「バサッ」という中低域の布擦れ＋膨らみ音
  const sf = ctx.createBufferSource(); sf.buffer = noiseBuf;
  sf.playbackRate.value = up ? 0.72 : 0.78;
  const bpf = ctx.createBiquadFilter(); bpf.type = 'bandpass'; bpf.Q.value = 0.68;
  bpf.frequency.setValueAtTime(up ? 380 : 420, tf);
  bpf.frequency.exponentialRampToValueAtTime(up ? 760 : 540, tf + 0.068);
  bpf.frequency.exponentialRampToValueAtTime(210, tf + 0.34);
  const gf = ctx.createGain();
  const flapVol = (up ? 0.78 : 0.52) * vol;
  gf.gain.setValueAtTime(0.0001, tf);
  gf.gain.linearRampToValueAtTime(flapVol * 0.90, tf + 0.022);
  gf.gain.linearRampToValueAtTime(flapVol, tf + 0.082);
  gf.gain.exponentialRampToValueAtTime(0.0001, tf + 0.35);
  sf.connect(bpf); bpf.connect(gf); gf.connect(master);
  sf.start(tf, Math.random() * 1.0); sf.stop(tf + 0.37);
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

// ---- リザルト画面BGM ('result') ＆ 振り返り画面BGM ('review') ----
function silenceSailingNow() {
  if (!ctx) return;
  const now = ctx.currentTime;
  if (boatBus) boatBus.gain.setTargetAtTime(0, now, 0.03);
  if (hissGain) hissGain.gain.setTargetAtTime(0, now, 0.03);
  if (rushGain) rushGain.gain.setTargetAtTime(0, now, 0.03);
  if (chineGain) chineGain.gain.setTargetAtTime(0, now, 0.03);
  if (shiverGain) {
    shiverGain.gain.setTargetAtTime(0, now, 0.015);
    if (shiverGain._amp) shiverGain._amp.gain.setTargetAtTime(0, now, 0.015);
  }
  if (nearGain) nearGain.gain.setTargetAtTime(0, now, 0.03);
  if (windGain) windGain.gain.setTargetAtTime(0.015, now, 0.10);
}

export function stopBgm() {
  bgmMode = null;
  if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
  if (bgmBus && ctx) {
    const oldBus = bgmBus;
    bgmBus = null;
    try {
      oldBus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08);
      setTimeout(() => { try { oldBus.disconnect(); } catch (e) {} }, 350);
    } catch (e) {}
  }
}

export function playBgm(mode = 'result') {
  initAudio();
  const isSilentSailing = mode === 'result' || mode === 'review' || mode === 'menu';
  if (isSilentSailing) silenceSailingNow();
  if (!bgmVoiceEnabled) {
    if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
    bgmMode = mode;
    return;
  }
  if (!ctx) { bgmMode = mode; return; }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (bgmMode === mode && bgmTimer) return;
  stopBgm();
  bgmMode = mode;

  const bus = ctx.createGain();
  bus.gain.setValueAtTime(0.001, ctx.currentTime);
  // BGMを全体的に少し大きめ・聴き応えのある音量バランスに調整
  const targetGain = mode === 'result' ? 0.54
    : mode === 'review' ? 0.48
    : mode === 'menu' ? 0.44
    : mode === 'orientation' ? 0.40
    : 0.34;
  bus.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 0.28);
  bus.connect(master);
  const revSend = ctx.createGain();
  revSend.gain.value = mode === 'result' ? 0.28 : mode === 'review' ? 0.36 : 0.24;
  bus.connect(revSend);
  if (fx) revSend.connect(fx);
  bgmBus = bus;

  const playNote = (freq, t0, dur, type, vol, lpFreq = 2400) => {
    if (!ctx || ctx.state !== 'running' || !bgmBus || bgmBus !== bus || !bgmVoiceEnabled) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(lpFreq, t0);
    lp.frequency.exponentialRampToValueAtTime(Math.max(260, lpFreq * 0.42), t0 + dur);
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.018);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(lp); lp.connect(g); g.connect(bus);
    o.start(t0); o.stop(t0 + dur + 0.03);
  };

  const playHat = (t0, vol = 0.035, open = false) => {
    if (!ctx || ctx.state !== 'running' || !noiseBuf || !bgmBus || bgmBus !== bus || !bgmVoiceEnabled) return;
    const dur = open ? 0.14 : 0.045;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(hp); hp.connect(g); g.connect(bus);
    s.start(t0, Math.random() * 1.2); s.stop(t0 + dur + 0.02);
  };

  const playSnare = (t0, vol = 0.055) => {
    if (!ctx || !noiseBuf || !bgmBus || bgmBus !== bus || !bgmVoiceEnabled) return;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1850; bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
    s.connect(bp); bp.connect(g); g.connect(bus);
    s.start(t0, Math.random() * 1.0); s.stop(t0 + 0.13);
  };

  let step = 0;
  if (mode === 'menu') {
    // スタート画面BGM: 出艇前のヨットハーバーをイメージした爽やかで心地よいブリージー・マリーナBGM (112 BPM, 8分音符=0.268s)
    const chords = [
      { bass: 65.41, notes: [261.63, 329.63, 392.00, 493.88, 587.33] }, // Cmaj9
      { bass: 55.00, notes: [220.00, 261.63, 329.63, 392.00, 493.88] }, // Am9
      { bass: 87.31, notes: [349.23, 440.00, 523.25, 659.25, 783.99] }, // Fmaj9
      { bass: 98.00, notes: [392.00, 493.88, 587.33, 659.25, 783.99] }, // G6/9
    ];
    const melody = [
      523.25, 0, 659.25, 783.99,  659.25, 0, 587.33, 523.25,
      493.88, 0, 523.25, 659.25,  587.33, 0, 523.25, 440.00,
      523.25, 0, 659.25, 880.00,  783.99, 0, 659.25, 523.25,
      587.33, 659.25, 783.99, 0,  659.25, 0, 587.33, 0,
    ];
    const arpIdx = [0, 2, 4, 3, 1, 3, 4, 2];
    const tick = () => {
      if (bgmMode !== 'menu' || bgmBus !== bus || !ctx) return;
      const t0 = ctx.currentTime + 0.03;
      const s = step % 32;
      const ch = chords[Math.floor(s / 8)];
      const sub = s % 8;
      if (sub === 0 || sub === 4) {
        ch.notes.forEach((f, i) => playNote(f, t0 + i * 0.015, sub === 0 ? 0.95 : 0.65, 'triangle', 0.048, 1900));
      }
      if (sub === 0) playNote(ch.bass * 2, t0, 0.55, 'sine', 0.12, 520);
      else if (sub === 4) playNote(ch.bass * 3, t0, 0.38, 'sine', 0.08, 520);
      const af = ch.notes[arpIdx[sub] % ch.notes.length] * 2;
      playNote(af, t0, 0.26, 'sine', 0.036, 2400);
      const mf = melody[s];
      if (mf > 0) playNote(mf, t0, 0.42, 'sine', 0.072, 3000);
      playHat(t0, sub % 2 === 0 ? 0.022 : 0.012, sub === 6);
      step++;
    };
    tick();
    bgmTimer = setInterval(tick, 268);
  } else if (mode === 'orientation') {
    // オリエンテーションBGM: スマブラの「あそびかた / 戦場」風のヒロイックで疾走感あるシンフォニック・ロックBGM (142 BPM, 8分音符=0.211s)
    // キー: Dマイナー / Dm -> Bb -> C -> F/A -> Gm7 -> A7 -> Dm -> C/A7
    const chords = [
      { bass: 73.42, notes: [293.66, 349.23, 440.00, 587.33] }, // Dm
      { bass: 58.27, notes: [233.08, 293.66, 349.23, 466.16] }, // Bb
      { bass: 65.41, notes: [261.63, 329.63, 392.00, 523.25] }, // C
      { bass: 87.31, notes: [349.23, 440.00, 523.25, 659.25] }, // Fmaj7
      { bass: 98.00, notes: [293.66, 349.23, 392.00, 466.16] }, // Gm7
      { bass: 55.00, notes: [220.00, 277.18, 329.63, 440.00] }, // A7
      { bass: 73.42, notes: [293.66, 349.23, 440.00, 587.33] }, // Dm
      { bass: 55.00, notes: [277.18, 329.63, 392.00, 554.37] }, // A7(#9)
    ];
    const melody = [
      587.33, 0, 587.33, 659.25,  698.46, 0, 659.25, 587.33,
      523.25, 0, 587.33, 659.25,  783.99, 0, 698.46, 659.25,
      698.46, 783.99, 880.00, 0,  880.00, 783.99, 698.46, 659.25,
      587.33, 0, 698.46, 659.25,  587.33, 0, 0, 0,
    ];
    const tick = () => {
      if (bgmMode !== 'orientation' || bgmBus !== bus || !ctx) return;
      const t0 = ctx.currentTime + 0.03;
      const s = step % 32;
      const ch = chords[Math.floor(s / 4)];
      const sub = s % 4;
      // ブラス＆ストリングス風コードヒット
      if (sub === 0 || sub === 2) {
        ch.notes.forEach((f, i) => playNote(f, t0 + i * 0.007, sub === 0 ? 0.36 : 0.22, 'sawtooth', 0.042, 2450));
      }
      // 疾走する8ビート・ロックベース
      playNote(ch.bass * (sub % 2 === 0 ? 2 : 3), t0, 0.19, 'sawtooth', sub === 0 ? 0.105 : 0.072, 760);
      // ヒロイックなブラス・リードメロディ
      const mf = melody[s];
      if (mf > 0) {
        playNote(mf, t0, 0.30, 'sawtooth', 0.058, 3200);
        playNote(mf * 0.5, t0, 0.28, 'square', 0.036, 1900);
      }
      // ドラムビート(ハイハット＆裏拍スネア)
      playHat(t0, sub % 2 === 0 ? 0.026 : 0.016, sub === 3);
      if (sub === 2) playSnare(t0, 0.052);
      step++;
    };
    tick();
    bgmTimer = setInterval(tick, 211);
  } else if (mode === 'prestart_enoshima' || mode === 'prestart_hakkeijima') {
    // スタート前(1分前〜0:00)BGM: スタートラインでのポジショニング・加速の緊張感と高揚感を高めるカウントダウン・パルスBGM (124 BPM, 8分音符=0.242s)
    const isHakkei = mode === 'prestart_hakkeijima';
    const chords = isHakkei
      ? [
          { bass: 65.41, notes: [261.63, 311.13, 392.00, 466.16] }, // Cm7
          { bass: 58.27, notes: [233.08, 293.66, 349.23, 466.16] }, // Bb
          { bass: 51.91, notes: [207.65, 261.63, 311.13, 392.00] }, // Abmaj7
          { bass: 49.00, notes: [196.00, 246.94, 293.66, 392.00] }, // G7
        ]
      : [
          { bass: 73.42, notes: [293.66, 369.99, 440.00, 523.25] }, // D7sus4
          { bass: 65.41, notes: [261.63, 329.63, 392.00, 493.88] }, // Cmaj7
          { bass: 58.27, notes: [233.08, 293.66, 349.23, 440.00] }, // Bbmaj7
          { bass: 55.00, notes: [220.00, 277.18, 329.63, 392.00] }, // A7
        ];
    const arpSeq = [0, 1, 2, 3, 2, 1, 3, 2];
    const tick = () => {
      if (bgmMode !== mode || bgmBus !== bus || !ctx) return;
      const t0 = ctx.currentTime + 0.03;
      const s = step % 32;
      const ch = chords[Math.floor(s / 8)];
      const sub = s % 8;
      // 緊張感のあるパルス・シンセアルペジオ
      const af = ch.notes[arpSeq[sub] % ch.notes.length] * 2;
      playNote(af, t0, 0.18, 'triangle', sub % 2 === 0 ? 0.056 : 0.038, 2400);
      // タイトな低音パルスベース
      if (sub % 2 === 0) {
        playNote(ch.bass * 2, t0, 0.22, 'sawtooth', sub === 0 ? 0.095 : 0.068, 560);
      }
      // 小節頭のサステインパッド
      if (sub === 0) {
        ch.notes.forEach((f, i) => playNote(f, t0 + i * 0.01, 0.85, 'sine', 0.036, 1500));
      }
      // 秒針を刻むようなクリスプなハイハット＆リム
      playHat(t0, sub % 2 === 0 ? 0.026 : 0.014, sub === 7);
      if (sub === 4) playSnare(t0, 0.034);
      step++;
    };
    tick();
    bgmTimer = setInterval(tick, 242);
  } else if (mode === 'race_enoshima') {
    // 江の島レース中BGM: 湘南・相模湾の太陽と潮風を感じる爽快オーシャン・レガッタフュージョン (128 BPM, 8分音符=0.234s)
    // キー: Aメジャー / Dmaj7 -> E7 -> C#m7 -> F#m7 -> Bm7 -> E7 -> Amaj7 -> A7
    const chords = [
      { bass: 73.42, notes: [293.66, 369.99, 440.00, 554.37] }, // Dmaj7
      { bass: 82.41, notes: [329.63, 415.30, 493.88, 587.33] }, // E7
      { bass: 69.30, notes: [277.18, 329.63, 415.30, 493.88] }, // C#m7
      { bass: 92.50, notes: [369.99, 440.00, 554.37, 659.25] }, // F#m7
      { bass: 61.74, notes: [246.94, 293.66, 369.99, 440.00] }, // Bm7
      { bass: 82.41, notes: [329.63, 415.30, 493.88, 659.25] }, // E7
      { bass: 55.00, notes: [220.00, 277.18, 329.63, 415.30] }, // Amaj7
      { bass: 55.00, notes: [220.00, 277.18, 329.63, 392.00] }, // A7
    ];
    const melody = [
      659.25, 0, 739.99, 880.00,  739.99, 0, 659.25, 587.33,
      554.37, 0, 659.25, 880.00,  1108.73, 0, 987.77, 880.00,
      739.99, 0, 659.25, 587.33,  659.25, 739.99, 880.00, 987.77,
      880.00, 0, 659.25, 554.37,  659.25, 0, 0, 0,
    ];
    const tick = () => {
      if (bgmMode !== 'race_enoshima' || bgmBus !== bus || !ctx) return;
      const t0 = ctx.currentTime + 0.03;
      const s = step % 32;
      const ch = chords[Math.floor(s / 4)];
      const sub = s % 4;
      if (sub === 0 || sub === 2) {
        ch.notes.forEach((f, i) => playNote(f, t0 + i * 0.010, sub === 0 ? 0.42 : 0.26, 'triangle', 0.048, 2300));
      }
      if (sub === 0) playNote(ch.bass * 2, t0, 0.32, 'sawtooth', 0.085, 620);
      else if (sub === 2) playNote(ch.bass * 3, t0, 0.22, 'triangle', 0.070, 620);
      else if (sub === 3) playNote(ch.bass * 2, t0, 0.16, 'sine', 0.055, 520);
      const mf = melody[s];
      if (mf > 0) {
        playNote(mf, t0, 0.34, 'sine', 0.078, 3600);
        playNote(mf * 0.5, t0, 0.28, 'triangle', 0.036, 2000);
      }
      playHat(t0, sub % 2 === 0 ? 0.025 : 0.015, sub === 2);
      step++;
    };
    tick();
    bgmTimer = setInterval(tick, 234);
  } else if (mode === 'race_hakkeijima') {
    // 八景島レース中BGM: 横浜・東京湾の都会的な疾走感を表現したアーバン・ベイブリーズ・シンセファンク (134 BPM, 8分音符=0.224s)
    // キー: Cマイナー/Ebメジャー / Fm9 -> Bb13 -> Ebmaj9 -> Abmaj7 -> Dm7b5 -> G7 -> Cm9 -> C7
    const chords = [
      { bass: 87.31, notes: [349.23, 415.30, 523.25, 622.25] }, // Fm7
      { bass: 58.27, notes: [233.08, 349.23, 415.30, 493.88] }, // Bb7
      { bass: 77.78, notes: [311.13, 392.00, 466.16, 587.33] }, // Ebmaj7
      { bass: 103.83, notes: [415.30, 523.25, 622.25, 783.99] }, // Abmaj7
      { bass: 73.42, notes: [293.66, 349.23, 415.30, 523.25] }, // Dm7b5
      { bass: 98.00, notes: [392.00, 493.88, 587.33, 698.46] }, // G7
      { bass: 65.41, notes: [261.63, 311.13, 392.00, 466.16] }, // Cm7
      { bass: 65.41, notes: [261.63, 329.63, 392.00, 466.16] }, // C7
    ];
    const melody = [
      783.99, 698.46, 622.25, 0,   698.46, 0, 783.99, 932.33,
      783.99, 0, 698.46, 622.25,   523.25, 0, 622.25, 783.99,
      698.46, 622.25, 587.33, 0,   698.46, 783.99, 932.33, 783.99,
      1046.50, 0, 932.33, 783.99,  698.46, 622.25, 523.25, 0,
    ];
    const tick = () => {
      if (bgmMode !== 'race_hakkeijima' || bgmBus !== bus || !ctx) return;
      const t0 = ctx.currentTime + 0.03;
      const s = step % 32;
      const ch = chords[Math.floor(s / 4)];
      const sub = s % 4;
      // シンコペーションの効いたアーバン・シンセブラスバッキング
      if (sub === 0 || sub === 3) {
        ch.notes.forEach((f, i) => playNote(f, t0 + i * 0.008, sub === 0 ? 0.36 : 0.22, 'sawtooth', 0.032, 1850));
      }
      // オクターブ・スラップ風ベース
      if (sub === 0) playNote(ch.bass * 2, t0, 0.24, 'sawtooth', 0.095, 740);
      else if (sub === 1) playNote(ch.bass * 4, t0, 0.14, 'triangle', 0.065, 920);
      else if (sub === 2) playNote(ch.bass * 2, t0, 0.22, 'sawtooth', 0.080, 680);
      else if (sub === 3) playNote(ch.bass * 3, t0, 0.16, 'triangle', 0.060, 780);
      // 都会的なスクエア＆ベル・リード
      const mf = melody[s];
      if (mf > 0) {
        playNote(mf, t0, 0.28, 'square', 0.038, 2600);
        playNote(mf, t0, 0.32, 'sine', 0.055, 3800);
      }
      playHat(t0, sub % 2 === 1 ? 0.028 : 0.016, sub === 1 || sub === 3);
      step++;
    };
    tick();
    bgmTimer = setInterval(tick, 224);
  } else if (mode === 'result') {
    // リザルト画面BGM: 爽やかで華やかなヨットレガッタ・フィニッシュBGM (120 BPM, 8分音符ステップ=0.25s)
    // コード進行: Fmaj7 -> G7 -> Em7 -> Am7 -> Dm7 -> G7 -> Cmaj7 -> C7 (32ステップ1周)
    const chords = [
      { bass: 87.31, notes: [349.23, 440.00, 523.25, 659.25] }, // Fmaj7
      { bass: 98.00, notes: [392.00, 493.88, 587.33, 698.46] }, // G7
      { bass: 82.41, notes: [329.63, 392.00, 493.88, 587.33] }, // Em7
      { bass: 110.00, notes: [440.00, 523.25, 659.25, 783.99] }, // Am7
      { bass: 73.42, notes: [293.66, 349.23, 440.00, 523.25] }, // Dm7
      { bass: 98.00, notes: [392.00, 493.88, 587.33, 698.46] }, // G7
      { bass: 65.41, notes: [261.63, 329.63, 392.00, 493.88] }, // Cmaj7
      { bass: 65.41, notes: [261.63, 329.63, 392.00, 466.16] }, // C7
    ];
    const melody = [
      659.25, 0, 783.99, 880.00,  783.99, 0, 698.46, 587.33,
      659.25, 0, 783.99, 987.77,  1046.50, 0, 987.77, 783.99,
      880.00, 0, 698.46, 587.33,  659.25, 783.99, 880.00, 987.77,
      1046.50, 0, 783.99, 659.25, 783.99, 0, 0, 0,
    ];
    const tick = () => {
      if (bgmMode !== 'result' || bgmBus !== bus || !ctx) return;
      const t0 = ctx.currentTime + 0.03;
      const s = step % 32;
      const ch = chords[Math.floor(s / 4)];
      const sub = s % 4;
      // エレピ風コードバッキング
      if (sub === 0 || sub === 3) {
        ch.notes.forEach((f, i) => playNote(f, t0 + i * 0.012, sub === 0 ? 0.65 : 0.35, 'triangle', 0.055, 2200));
      }
      // ベースライン
      if (sub === 0) playNote(ch.bass, t0, 0.42, 'sine', 0.14, 650);
      else if (sub === 2) playNote(ch.bass * 1.5, t0, 0.28, 'sine', 0.10, 650);
      // 爽やかなシンセベル・リードメロディ
      const mf = melody[s];
      if (mf > 0) {
        playNote(mf, t0, 0.38, 'sine', 0.085, 3400);
        playNote(mf * 2, t0, 0.22, 'triangle', 0.025, 4200);
      }
      // 軽快なシェイカー/ハイハット
      playHat(t0, sub % 2 === 0 ? 0.028 : 0.018, sub === 2);
      step++;
    };
    tick();
    bgmTimer = setInterval(tick, 250);
  } else if (mode === 'review') {
    // 振り返り画面BGM: 落ち着いた戦術分析・スポーツハイライト風のチル/ローファイ・ジャズフュージョンBGM (96 BPM, 8分音符=0.312s)
    // コード進行: Am9 -> Fmaj7 -> Dm9 -> E7sus4/E7 (32ステップ1周)
    const chords = [
      { bass: 55.00, notes: [220.00, 261.63, 329.63, 392.00, 493.88] }, // Am9
      { bass: 43.65, notes: [174.61, 220.00, 261.63, 329.63, 392.00] }, // Fmaj7
      { bass: 73.42, notes: [293.66, 349.23, 440.00, 523.25, 659.25] }, // Dm9
      { bass: 82.41, notes: [329.63, 440.00, 493.88, 587.33, 659.25] }, // E7sus4
    ];
    const arpOrder = [0, 2, 3, 4, 3, 2, 1, 3];
    const tick = () => {
      if (bgmMode !== 'review' || bgmBus !== bus || !ctx) return;
      const t0 = ctx.currentTime + 0.03;
      const s = step % 32;
      const ch = chords[Math.floor(s / 8)];
      const sub = s % 8;
      // 温かいローズピアノ風パッドコード
      if (sub === 0) {
        ch.notes.forEach((f, i) => playNote(f, t0 + i * 0.025, 1.95, 'sine', 0.048, 1200));
      }
      // 落ち着いたディープベース
      if (sub === 0) playNote(ch.bass * 2, t0, 0.90, 'triangle', 0.11, 480);
      else if (sub === 5) playNote(ch.bass * 3, t0, 0.45, 'sine', 0.075, 480);
      // 思考を邪魔しないクリアなプラック・アルペジオ
      const af = ch.notes[arpOrder[sub] % ch.notes.length] * 2;
      playNote(af, t0, 0.36, 'sine', 0.042, 1800);
      // 控えめなブラシハイハット
      if (sub % 2 === 0) playHat(t0, sub === 4 ? 0.022 : 0.012, sub === 4);
      step++;
    };
    tick();
    bgmTimer = setInterval(tick, 312);
  }
}

// ---- 接近時の権利主張コール (動物キャラクターのみ鳴き声を鳴らし、人間は声を出さない) ----
// crewType: 'cat' | 'dog' | 'duck' | 'tanuki' | 'rabbit' | 'dolphin' (human_m / human_f はスキップ)
// callKind: 'starboard' (スタボ) | 'leeward' (下)
export function playRightOfWayHail(crewType = 'human_m', _callKind = 'starboard', pan = 0) {
  if (!bgmVoiceEnabled || muted) return;
  if (crewType !== 'cat' && crewType !== 'dog' && crewType !== 'shiba' && crewType !== 'duck' && crewType !== 'tanuki' && crewType !== 'rabbit' && crewType !== 'dolphin') return;
  initAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();

  const t0 = ctx.currentTime + 0.01;
  const out = ctx.createGain();
  out.gain.value = 0.85;
  if (ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = clampN(pan, -0.88, 0.88);
    out.connect(panner);
    panner.connect(master);
  } else {
    out.connect(master);
  }

  if (crewType === 'cat') {
    // 猫: かわいらしい「ニャン♪」(ny -> a -> n の2フォルマント母音遷移＋丸みのある可愛い高音ピッチ)
    const dur = 0.38;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'triangle';
    o1.frequency.setValueAtTime(560, t0);
    o1.frequency.exponentialRampToValueAtTime(940, t0 + 0.13);
    o1.frequency.exponentialRampToValueAtTime(830, t0 + 0.25);
    o1.frequency.exponentialRampToValueAtTime(680, t0 + dur);
    o2.frequency.setValueAtTime(560, t0);
    o2.frequency.exponentialRampToValueAtTime(940, t0 + 0.13);
    o2.frequency.exponentialRampToValueAtTime(830, t0 + 0.25);
    o2.frequency.exponentialRampToValueAtTime(680, t0 + dur);

    // 第1フォルマント (ny: 380Hz -> a: 1120Hz -> n: 440Hz)
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.Q.value = 3.6;
    f1.frequency.setValueAtTime(380, t0);
    f1.frequency.exponentialRampToValueAtTime(1120, t0 + 0.07);
    f1.frequency.setValueAtTime(1080, t0 + 0.23);
    f1.frequency.exponentialRampToValueAtTime(440, t0 + dur);

    // 第2フォルマント (ny: 2550Hz -> a: 2150Hz -> n: 1480Hz)
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.Q.value = 4.0;
    f2.frequency.setValueAtTime(2550, t0);
    f2.frequency.exponentialRampToValueAtTime(2150, t0 + 0.08);
    f2.frequency.setValueAtTime(2080, t0 + 0.23);
    f2.frequency.exponentialRampToValueAtTime(1480, t0 + dur);

    const mix = ctx.createGain();
    const g1 = ctx.createGain(); g1.gain.value = 0.55;
    const g2 = ctx.createGain(); g2.gain.value = 0.75;
    o1.connect(g1); o2.connect(g2);
    g1.connect(f1); g1.connect(f2);
    g2.connect(f1); g2.connect(f2);
    f1.connect(mix); f2.connect(mix);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.42, t0 + 0.028);
    g.gain.setValueAtTime(0.38, t0 + 0.22);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.025);

    mix.connect(g); g.connect(out);
    o1.start(t0); o2.start(t0);
    o1.stop(t0 + dur + 0.04); o2.stop(t0 + dur + 0.04);
    return;
  }

  if (crewType === 'dog' || crewType === 'shiba') {
    // 犬: かわいらしい単発の「ワン！」(w -> a -> n の母音フォルマント遷移＋明るい子犬風ピッチ)
    const dur = 0.25;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'triangle';
    o1.frequency.setValueAtTime(410, t0);
    o1.frequency.exponentialRampToValueAtTime(690, t0 + 0.065);
    o1.frequency.exponentialRampToValueAtTime(590, t0 + 0.16);
    o1.frequency.exponentialRampToValueAtTime(460, t0 + dur);
    o2.frequency.setValueAtTime(410, t0);
    o2.frequency.exponentialRampToValueAtTime(690, t0 + 0.065);
    o2.frequency.exponentialRampToValueAtTime(590, t0 + 0.16);
    o2.frequency.exponentialRampToValueAtTime(460, t0 + dur);

    // 第1フォルマント (w: 350Hz -> a: 1180Hz -> n: 430Hz)
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.Q.value = 3.2;
    f1.frequency.setValueAtTime(350, t0);
    f1.frequency.exponentialRampToValueAtTime(1180, t0 + 0.05);
    f1.frequency.setValueAtTime(1120, t0 + 0.16);
    f1.frequency.exponentialRampToValueAtTime(430, t0 + dur);

    // 第2フォルマント (w: 780Hz -> a: 2150Hz -> n: 1380Hz)
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.Q.value = 3.6;
    f2.frequency.setValueAtTime(780, t0);
    f2.frequency.exponentialRampToValueAtTime(2150, t0 + 0.055);
    f2.frequency.setValueAtTime(2020, t0 + 0.16);
    f2.frequency.exponentialRampToValueAtTime(1380, t0 + dur);

    const g1 = ctx.createGain(); g1.gain.value = 0.55;
    const g2 = ctx.createGain(); g2.gain.value = 0.70;
    o1.connect(g1); o2.connect(g2);
    g1.connect(f1); g1.connect(f2);
    g2.connect(f1); g2.connect(f2);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.45, t0 + 0.018);
    g.gain.setValueAtTime(0.40, t0 + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.02);

    f1.connect(g); f2.connect(g); g.connect(out);
    o1.start(t0); o2.start(t0);
    o1.stop(t0 + dur + 0.03); o2.stop(t0 + dur + 0.03);
    return;
  }

  if (crewType === 'duck') {
    // アヒル: かわいらしい単発の「ぐわっ♪」(gu -> wa! の2音節フォルマント遷移＋愛嬌のあるピッチ)
    const dur = 0.24;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'triangle';
    // 「ぐ(gu)」(0〜0.055s) から 「わっ(wa!)」(0.055〜0.24s) へ跳ねる可愛いピッチ
    o1.frequency.setValueAtTime(360, t0);
    o1.frequency.exponentialRampToValueAtTime(420, t0 + 0.05);
    o1.frequency.exponentialRampToValueAtTime(610, t0 + 0.105);
    o1.frequency.exponentialRampToValueAtTime(480, t0 + dur);
    o2.frequency.setValueAtTime(362, t0);
    o2.frequency.exponentialRampToValueAtTime(422, t0 + 0.05);
    o2.frequency.exponentialRampToValueAtTime(612, t0 + 0.105);
    o2.frequency.exponentialRampToValueAtTime(482, t0 + dur);

    // 第1フォルマント (gu: 360Hz -> w: 520Hz -> a!: 1380Hz -> 920Hz)
    const bp1 = ctx.createBiquadFilter();
    bp1.type = 'bandpass'; bp1.Q.value = 3.8;
    bp1.frequency.setValueAtTime(360, t0);
    bp1.frequency.exponentialRampToValueAtTime(520, t0 + 0.055);
    bp1.frequency.exponentialRampToValueAtTime(1380, t0 + 0.11);
    bp1.frequency.exponentialRampToValueAtTime(920, t0 + dur);

    // 第2フォルマント (gu: 1050Hz -> wa!: 2450Hz -> 1820Hz)
    const bp2 = ctx.createBiquadFilter();
    bp2.type = 'bandpass'; bp2.Q.value = 4.2;
    bp2.frequency.setValueAtTime(1050, t0);
    bp2.frequency.exponentialRampToValueAtTime(1280, t0 + 0.055);
    bp2.frequency.exponentialRampToValueAtTime(2450, t0 + 0.11);
    bp2.frequency.exponentialRampToValueAtTime(1820, t0 + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.30, t0 + 0.015);
    g.gain.linearRampToValueAtTime(0.22, t0 + 0.05);
    g.gain.linearRampToValueAtTime(0.46, t0 + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.018);

    o1.connect(bp1); o1.connect(bp2);
    o2.connect(bp1); o2.connect(bp2);
    bp1.connect(g); bp2.connect(g); g.connect(out);
    o1.start(t0); o2.start(t0);
    o1.stop(t0 + dur + 0.03); o2.stop(t0 + dur + 0.03);
    return;
  }

  if (crewType === 'tanuki') {
    // タヌキ: 愛嬌のある「ポン！ポコッ！」(ぽんぽこ腹鼓＋可愛い鳴き声)
    [0, 0.15].forEach((offset, idx) => {
      const ts = t0 + offset;
      const dur = 0.15;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle';
      const f0 = idx === 0 ? 235 : 295;
      o.frequency.setValueAtTime(f0 * 1.35, ts);
      o.frequency.exponentialRampToValueAtTime(f0, ts + 0.035);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.18, ts + dur);
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.linearRampToValueAtTime(0.45, ts + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + dur + 0.02);
      o.connect(g); g.connect(out);
      o.start(ts); o.stop(ts + dur + 0.03);
    });
    return;
  }

  if (crewType === 'rabbit') {
    // ウサギ: 可愛らしい「ピョン！キュッ！」(高めのキュートなチャープ音)
    [0, 0.13].forEach((offset, idx) => {
      const ts = t0 + offset;
      const dur = 0.12;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      const f0 = idx === 0 ? 740 : 880;
      o.frequency.setValueAtTime(f0, ts);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.55, ts + 0.055);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.15, ts + dur);
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.linearRampToValueAtTime(0.32, ts + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + dur + 0.02);
      o.connect(g); g.connect(out);
      o.start(ts); o.stop(ts + dur + 0.03);
    });
    return;
  }

  if (crewType === 'dolphin') {
    // イルカ: 爽やかな「キュイーーッ！キュキュッ！」(ドルフィンホイッスル＆クリック)
    [0, 0.12, 0.24].forEach((offset, idx) => {
      const ts = t0 + offset;
      const dur = idx === 2 ? 0.20 : 0.095;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      const f0 = idx === 0 ? 1320 : idx === 1 ? 1560 : 1420;
      o.frequency.setValueAtTime(f0, ts);
      o.frequency.exponentialRampToValueAtTime(f0 * (idx === 2 ? 1.65 : 1.38), ts + dur * 0.72);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.12, ts + dur);
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.linearRampToValueAtTime(0.28, ts + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + dur + 0.015);
      o.connect(g); g.connect(out);
      o.start(ts); o.stop(ts + dur + 0.025);
    });
  }
}

// スタート画面でキャラクターを選択したときのボイス・鳴き声再生
export function playCrewSelectSound(crewType = 'human_m') {
  if (!bgmVoiceEnabled || muted) return;
  initAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();

  if (crewType === 'cat' || crewType === 'dog' || crewType === 'shiba' || crewType === 'duck' || crewType === 'tanuki' || crewType === 'rabbit' || crewType === 'dolphin') {
    playRightOfWayHail(crewType, 'starboard', 0);
    return;
  }

  // 人間キャラクター選択時: 爽やかな決定チャイム＋明るい「よし！ / いくよ！」フォルマントボイス
  const isFemale = crewType === 'human_f';
  const t0 = ctx.currentTime + 0.01;
  const fBase = isFemale ? 265 : 155;
  const notes = isFemale ? [523.25, 659.25, 1046.5] : [392.00, 523.25, 783.99];
  notes.forEach((f, idx) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f, t0 + idx * 0.045);
    g.gain.setValueAtTime(0.0001, t0 + idx * 0.045);
    g.gain.linearRampToValueAtTime(0.14, t0 + idx * 0.045 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + idx * 0.045 + 0.22);
    o.connect(g); g.connect(master);
    o.start(t0 + idx * 0.045); o.stop(t0 + idx * 0.045 + 0.24);
  });

  // 短い元気な掛け声フォルマント
  [
    { dt: 0.00, dur: 0.075, f0: fBase * 1.15, f1: fBase * 1.38, form1: 680, form2: 1750 },
    { dt: 0.08, dur: 0.130, f0: fBase * 1.32, f1: fBase * 1.08, form1: 520, form2: 1420 },
  ].forEach((syl) => {
    const ts = t0 + syl.dt;
    const o = ctx.createOscillator(), bp1 = ctx.createBiquadFilter(), bp2 = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(syl.f0, ts);
    o.frequency.exponentialRampToValueAtTime(syl.f1, ts + syl.dur);
    bp1.type = 'bandpass'; bp1.frequency.value = syl.form1; bp1.Q.value = 3.2;
    bp2.type = 'bandpass'; bp2.frequency.value = syl.form2; bp2.Q.value = 3.6;
    g.gain.setValueAtTime(0.0001, ts);
    g.gain.linearRampToValueAtTime(0.16, ts + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ts + syl.dur + 0.02);
    o.connect(bp1); o.connect(bp2); bp1.connect(g); bp2.connect(g); g.connect(master);
    o.start(ts); o.stop(ts + syl.dur + 0.03);
  });
}

// スプラトゥーン風レートゲージのカウントアップ・効果音
export function playRateTickSound(up = true, progress = 0.5, isFinish = false) {
  if (!bgmVoiceEnabled || muted) return;
  initAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t0 = ctx.currentTime + 0.005;
  if (isFinish) {
    const chord = up ? [523.25, 659.25, 783.99, 1046.5] : [392.00, 349.23, 293.66];
    chord.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = up ? 'triangle' : 'sawtooth';
      o.frequency.setValueAtTime(f, t0 + i * 0.035);
      g.gain.setValueAtTime(0.0001, t0 + i * 0.035);
      g.gain.linearRampToValueAtTime(0.16, t0 + i * 0.035 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.035 + 0.28);
      o.connect(g); g.connect(master);
      o.start(t0 + i * 0.035); o.stop(t0 + i * 0.035 + 0.30);
    });
    return;
  }
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'square';
  const f = up ? 480 + progress * 460 : 540 - progress * 220;
  o.frequency.setValueAtTime(f, t0);
  o.frequency.exponentialRampToValueAtTime(f * (up ? 1.12 : 0.92), t0 + 0.035);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(0.09, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.04);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + 0.045);
}

// スマブラ風「＊＊ Joins the Race!」新キャラ解放スプラッシュ効果音
export function playChallengerSplashSound(crewType = 'duck') {
  if (!bgmVoiceEnabled || muted) return;
  initAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t0 = ctx.currentTime + 0.01;
  // 1) 強烈なスラッシュ風切り＋重低音ドン！インパクト
  if (noiseBuf) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 1.05;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(420, t0);
    bp.frequency.exponentialRampToValueAtTime(3400, t0 + 0.07);
    bp.frequency.exponentialRampToValueAtTime(280, t0 + 0.32);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.52, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
    s.connect(bp); bp.connect(g); g.connect(master);
    s.start(t0, Math.random() * 0.5); s.stop(t0 + 0.36);
  }
  const sub = ctx.createOscillator(), sg = ctx.createGain();
  sub.type = 'triangle';
  sub.frequency.setValueAtTime(190, t0 + 0.05);
  sub.frequency.exponentialRampToValueAtTime(42, t0 + 0.38);
  sg.gain.setValueAtTime(0.0001, t0 + 0.05);
  sg.gain.linearRampToValueAtTime(0.58, t0 + 0.062);
  sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.42);
  sub.connect(sg); sg.connect(master);
  sub.start(t0 + 0.05); sub.stop(t0 + 0.44);

  // 2) ヒロイックなブラス・ファンファーレコード (D5 -> G5 -> A5 -> D6)
  const fanfare = [
    { dt: 0.06, notes: [293.66, 440.00, 587.33, 739.99], dur: 0.16 },
    { dt: 0.22, notes: [392.00, 587.33, 783.99, 987.77], dur: 0.16 },
    { dt: 0.38, notes: [293.66, 440.00, 587.33, 739.99, 1174.66], dur: 0.65 },
  ];
  fanfare.forEach((ch) => {
    ch.notes.forEach((f, i) => {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'sawtooth';
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3200, t0 + ch.dt);
      lp.frequency.exponentialRampToValueAtTime(1100, t0 + ch.dt + ch.dur);
      o.frequency.setValueAtTime(f, t0 + ch.dt + i * 0.006);
      og.gain.setValueAtTime(0.0001, t0 + ch.dt + i * 0.006);
      og.gain.linearRampToValueAtTime(0.11, t0 + ch.dt + i * 0.006 + 0.015);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + ch.dt + ch.dur);
      o.connect(lp); lp.connect(og); og.connect(master);
      o.start(t0 + ch.dt + i * 0.006); o.stop(t0 + ch.dt + ch.dur + 0.03);
    });
  });
  // 少し遅れてその動物の鳴き声も再生
  setTimeout(() => {
    playRightOfWayHail(crewType, 'starboard', 0);
  }, 340);
}




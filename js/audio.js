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

const MASTER_GAIN = 0.48;

function softClip(k) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
  return c;
}
// 通常域(|x| <= 0.64)は完全リニア(無歪み)のまま通し、突発的な大音量重畳時のみ ±0.90 未満へ滑らかに収めるブリックウォール・ソフトリミッター
function makeMasterLimiterCurve() {
  const n = 8192, c = new Float32Array(n);
  const knee = 0.64, ceil = 0.90, span = ceil - knee;
  for (let i = 0; i < n; i++) {
    const s = (i / (n - 1)) * 2 - 1;
    const x = s * 2;
    const a = Math.abs(x);
    if (a <= knee) {
      c[i] = x;
    } else {
      c[i] = Math.sign(x) * (knee + span * Math.tanh((a - knee) / span));
    }
  }
  return c;
}
function makeImpulse(sec, decay) {
  const sr = ctx.sampleRate || 44100;
  const len = Math.floor(sr * sec), buf = ctx.createBuffer(2, len, sr);
  const hpAlpha = Math.exp((-2 * Math.PI * 165) / sr);
  const lpAlpha = 1 - Math.exp((-2 * Math.PI * 4200) / sr);
  const fadeIn = Math.max(1, Math.floor(sr * 0.012));
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let prevIn = 0, hp = 0, lp = 0, peak = 1e-6;
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, decay) * Math.min(1, i / fadeIn);
      const raw = (Math.random() * 2 - 1) * env;
      hp = hpAlpha * (hp + raw - prevIn);
      prevIn = raw;
      lp += lpAlpha * (hp - lp);
      d[i] = lp;
      const al = Math.abs(lp);
      if (al > peak) peak = al;
    }
    const norm = 0.34 / peak;
    for (let i = 0; i < len; i++) d[i] *= norm;
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
  const events = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'click'];
  const tryUnlock = () => {
    unlockAudioNow().then((ok) => {
      if (ok || (ctx && ctx.state === 'running')) {
        events.forEach((ev) => {
          window.removeEventListener(ev, tryUnlock, true);
          document.removeEventListener(ev, tryUnlock, true);
        });
      }
    });
  };
  events.forEach((ev) => {
    window.addEventListener(ev, tryUnlock, { capture: true, passive: true });
    document.addEventListener(ev, tryUnlock, { capture: true, passive: true });
  });
}
ensureAudioUnlockListeners();

export function isAudioRunning() {
  return !!(ctx && ctx.state === 'running');
}
export function isBgmPlaying() {
  return !!(ctx && ctx.state === 'running' && bgmTimer && bgmVoiceEnabled);
}
export function unlockAudioNow() {
  initAudio();
  if (!ctx) return Promise.resolve(false);
  try {
    const sb = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
    const src = ctx.createBufferSource();
    src.buffer = sb;
    src.connect(ctx.destination);
    src.start(0);
  } catch (e) {}
  if (ctx.state === 'running') return Promise.resolve(true);
  return ctx.resume().then(() => !!(ctx && ctx.state === 'running')).catch(() => false);
}

export function initAudio() {
  ensureAudioUnlockListeners();
  if (ctx) { if (ctx.state !== 'running') ctx.resume().catch(() => {}); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.onstatechange = () => {
      if (ctx && ctx.state === 'running' && bgmMode && !bgmTimer && bgmVoiceEnabled) {
        const curMode = bgmMode;
        bgmMode = null;
        playBgm(curMode);
      }
    };
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const dcBlock = ctx.createBiquadFilter();
    dcBlock.type = 'highpass'; dcBlock.frequency.value = 28; dcBlock.Q.value = 0.707;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.18;
    const limiterPad = ctx.createGain();
    limiterPad.gain.value = 0.5;
    const limiter = ctx.createWaveShaper();
    limiter.curve = makeMasterLimiterCurve();
    limiter.oversample = '4x';
    master = ctx.createGain(); master.gain.value = muted ? 0 : MASTER_GAIN;
    master.connect(dcBlock); dcBlock.connect(comp); comp.connect(limiterPad); limiterPad.connect(limiter); limiter.connect(ctx.destination);
    // 開けた水面の自然な残響(過大レベルによる音割れを防ぐ帯域制限＆正規化インパルス)
    const conv = ctx.createConvolver(); conv.buffer = makeImpulse(2.0, 3.4);
    fx = ctx.createGain(); fx.gain.value = 1; fx.connect(conv);
    const wet = ctx.createGain(); wet.gain.value = 0.24; conv.connect(wet); wet.connect(master);

    // ノイズ素材: 白色 / ブラウン(風・水流用)
    const sr = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, sr * 2, sr);
    const wn = noiseBuf.getChannelData(0); for (let i = 0; i < wn.length; i++) wn[i] = Math.random() * 2 - 1;
    const brown = ctx.createBuffer(1, sr * 3, sr), bd = brown.getChannelData(0);
    let last = 0; for (let i = 0; i < bd.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; bd[i] = last * 3.5; }

    // 風(初期値は0にしてロード中のホワイトノイズ鳴動を防止、レース・スタート画面遷移時に目標値へ)
    const wsrc = loopSource(brown);
    const wlp = ctx.createBiquadFilter(); wlp.type = 'lowpass'; wlp.frequency.value = 720;
    windGain = ctx.createGain(); windGain.gain.value = 0;
    const gust = ctx.createOscillator(); gust.frequency.value = 0.11;
    const gustAmp = ctx.createGain(); gustAmp.gain.value = 0; gust.connect(gustAmp); gustAmp.connect(windGain.gain); gust.start();
    windGain._gust = gustAmp;
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

export function setWind(speedNorm) {
  if (windGain && ctx) {
    windGain.gain.setTargetAtTime(0.08 + 0.16 * speedNorm, ctx.currentTime, 0.3);
    if (windGain._gust) windGain._gust.gain.setTargetAtTime(0.04, ctx.currentTime, 0.3);
  }
}
export function setCameraAudio(cockpit) { camMul = cockpit ? 1.0 : 0.45; }
export function toggleMute() { muted = !muted; if (master) master.gain.value = muted ? 0 : MASTER_GAIN; return muted; }
export function isBgmVoiceEnabled() { return bgmVoiceEnabled; }
export function setBgmVoiceEnabled(on) {
  bgmVoiceEnabled = !!on;
  if (!bgmVoiceEnabled) {
    if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
    if (bgmBus && ctx) {
      const oldBus = bgmBus;
      bgmBus = null;
      if (oldBus._cleanup) oldBus._cleanup(0.05, 220);
      else {
        try {
          oldBus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
          setTimeout(() => { try { oldBus.disconnect(); } catch (e) {} }, 200);
        } catch (e) {}
      }
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

// 4) ハルが細かいさざ波に触れる控えめなリップルスラップ
function waveSlap(sp, heel) {
  const t = ctx.currentTime;
  const variant = Math.random();
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  s.playbackRate.value = 0.68 + Math.random() * 0.55;
  const f = ctx.createBiquadFilter();
  f.type = variant < 0.45 ? 'lowpass' : 'bandpass';
  f.Q.value = variant < 0.45 ? 1.15 : 0.90;
  const fHi = (variant < 0.35 ? 1050 : variant < 0.75 ? 1650 : 2100) + Math.random() * 550;
  const fLo = 190 + Math.random() * 140;
  const dur = (variant < 0.35 ? 0.24 : 0.34) + Math.random() * 0.14;
  f.frequency.setValueAtTime(fHi, t);
  f.frequency.exponentialRampToValueAtTime(fLo, t + dur);

  const g = ctx.createGain();
  const vol = (0.032 + 0.095 * sp) * (1 + heel * 1.1) * (0.8 + Math.random() * 0.35);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.04);
  s.connect(f); f.connect(g); g.connect(boatBus);
  s.start(t, Math.random() * 1.0); s.stop(t + dur + 0.06);

  // 船体の微かなFRP共鳴
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'sine';
  const bodyF0 = 80 + Math.random() * 34;
  o.frequency.setValueAtTime(bodyF0, t);
  o.frequency.exponentialRampToValueAtTime(bodyF0 * 0.52, t + 0.20);
  og.gain.setValueAtTime(0.0001, t);
  og.gain.linearRampToValueAtTime((0.038 + Math.random() * 0.03) * sp, t + 0.01);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(og); og.connect(boatBus); o.start(t); o.stop(t + 0.25);
}

// 5) 波が高いときに風上へ向かう際、バウが波にはたかれる控えめな「パシャン / トン…ザッ」というリアルな波叩き音
function hullWaveSlam(slam) {
  if (!ctx || !noiseBuf || !boatBus) return;
  const t = ctx.currentTime;
  const intensity = clamp01(slam);
  // ① バウフレアが波頭を叩いて水しぶきが散る控えめなスプラッシュ音
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  s.playbackRate.value = 0.66 + Math.random() * 0.26;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.05;
  bp.frequency.setValueAtTime(980 + intensity * 480 + Math.random() * 180, t);
  bp.frequency.exponentialRampToValueAtTime(240 + Math.random() * 60, t + 0.21);
  const g = ctx.createGain();
  const vol = (0.026 + 0.048 * intensity) * (0.85 + Math.random() * 0.28);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.009);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.23);
  s.connect(bp); bp.connect(g); g.connect(boatBus);
  s.start(t, Math.random() * 1.1); s.stop(t + 0.26);

  // ② スナイプ級のFRPハルが波にはたかれる控えめで自然な「トン」という中空共鳴
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'triangle';
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
  const f0 = 98 + Math.random() * 20 + intensity * 12;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(46, t + 0.15);
  const thudVol = (0.024 + 0.042 * intensity) * (0.85 + Math.random() * 0.25);
  og.gain.setValueAtTime(0.0001, t);
  og.gain.linearRampToValueAtTime(thudVol, t + 0.007);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
  o.connect(lp); lp.connect(og); og.connect(boatBus);
  o.start(t); o.stop(t + 0.20);
}

let _lastAudioTack = null;
let _sinceWindCross = 99;
let _luffHoldTime = 0;
let _lastSailFlogAt = -99;

// シバー時の「バサバサッ」というセールクロスの連続はためきパルス (0度風位でもうるさくならないよう控えめな布音のみにする)
function shiverFlap(lv) {
  if (!ctx || !noiseBuf || !boatBus) return;
  const t = ctx.currentTime;
  const dur = 0.065 + Math.random() * 0.04;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  s.playbackRate.value = 0.78 + Math.random() * 0.35;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.setValueAtTime(520 + Math.random() * 280, t);
  bp.frequency.exponentialRampToValueAtTime(250 + Math.random() * 110, t + dur);
  bp.Q.value = 0.95;
  const g = ctx.createGain();
  const peak = (0.032 + 0.065 * lv) * (0.85 + Math.random() * 0.3);
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
  hissGain.gain.setTargetAtTime((0.006 + 0.20 * Math.pow(sp, 1.35)) * (1 + heel * 2.0) * (0.72 + 0.50 * dynWave), now, 0.08);
  if (hissHP && hissLP) {
    hissHP.frequency.setTargetAtTime(1050 + sp * 480 - heel * 500 + waveMod2 * 220, now, 0.10);
    hissLP.frequency.setTargetAtTime(3800 + sp * 3600 + dynWave * 1600, now, 0.10);
  }
  rushGain.gain.setTargetAtTime((0.012 + 0.20 * sp) * (0.78 + 0.45 * (1 - dynWave)), now, 0.12);
  rushFilter.frequency.setTargetAtTime(260 + sp * 780 + waveMod1 * 140 + heel * 260, now, 0.12);

  if (chineGain && chineFilter) {
    chineGain.gain.setTargetAtTime(sp * (0.032 + 0.10 * heel + 0.04 * Math.abs(waveMod2)), now, 0.10);
    chineFilter.frequency.setTargetAtTime(580 + sp * 620 + waveMod3 * 240, now, 0.10);
  }

  // シバー: セールの「バサッ」音(shiverFlap)は元の音量・反応に戻し、0度付近での連続ノイズ(ザーっという音)のみ抑える
  const luff = active && b ? clamp01(b.luff) : 0;
  const lv = luff > 0.08 ? luff : 0;
  const zeroHissScale = twa < 0.18 ? 0.35 + 0.65 * clamp01(twa / 0.18) : 1.0;
  shiverGain.gain.setTargetAtTime(lv * 0.042 * zeroHissScale, now, 0.06);
  shiverGain._amp.gain.setTargetAtTime(lv * 0.035 * zeroHissScale, now, 0.06);
  tShiver -= dt;
  if (tShiver <= 0) {
    tShiver = 0.11 + Math.random() * 0.07;
    shiverLfo.frequency.setValueAtTime(8 + Math.random() * 5, now);
    if (active && lv > 0.10) shiverFlap(lv);
  }
  if (!active) return;

  // 波が高いときに風上へ向かう際など、波にはたかれた控えめなハル波叩き音
  if (b && (b.upwindWaveHit > 0 || b.waveSlam > 0)) {
    const slam = Math.max(b.upwindWaveHit || 0, b.waveSlam || 0);
    b.upwindWaveHit = 0;
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
  // さざ波リップルスラップ音(控えめな頻度)
  tSlap -= dt;
  if (tSlap <= 0 && sp > 0.16) {
    tSlap = (0.65 + Math.random() * 1.25) / (0.35 + sp * (upwind ? 1.25 : 0.90));
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
// dur: 吹鳴秒数, f0: 基音(Hz), vol: 音量, delay: 開始遅延(秒)
export function airHorn(dur = 1.0, f0 = 392, vol = 0.42, delay = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(vol, t + 0.065);               // 空気が立ち上がる
  env.gain.setValueAtTime(vol * 0.93, t + Math.max(0.12, dur - 0.04));
  env.gain.exponentialRampToValueAtTime(0.0006, t + dur + 0.2);   // 余韻
  const shaper = ctx.createWaveShaper(); shaper.curve = softClip(2.1); shaper.oversample = '2x';
  const form = ctx.createBiquadFilter(); form.type = 'peaking'; form.frequency.value = 1150; form.gain.value = 4.2; form.Q.value = 1.0;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3300; lp.Q.value = 0.6;
  const mix = ctx.createGain(); mix.gain.value = 0.13;
  mix.connect(shaper); shaper.connect(form); form.connect(lp); lp.connect(env);
  env.connect(master);
  const send = ctx.createGain(); send.gain.value = 0.28; env.connect(send); send.connect(fx);
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
  const ng = ctx.createGain(); ng.gain.value = 0.14;
  ns.connect(nb); nb.connect(ng); ng.connect(mix); ns.start(t); ns.stop(t + dur + 0.4);
  // 微かな震え
  const lfo = ctx.createOscillator(); lfo.frequency.value = 34;
  const la = ctx.createGain(); la.gain.value = f0 * 0.005; lfo.connect(la);
  oscs.forEach((o) => la.connect(o.frequency)); lfo.start(t); lfo.stop(t + dur + 0.4);
}
// 競技委員会の信号: 'long'=1分前(長い1音) / 'short'=スタート(短い1音) / 'recall'=個別リコール追加ホーン(1音目から約2秒の間を置いて2音目を鳴らす)
export function signalHorn(kind) {
  if (kind === 'long') airHorn(1.7, 415, 0.42);
  else if (kind === 'recall') airHorn(0.68, 415, 0.48, 2.55);
  else airHorn(0.55, 415, 0.46);
}
// 互換: 旧API
export function horn(dur = 0.25, freq = 440) { airHorn(dur, freq * 0.9, 0.34); }

export function beep(freq = 880, dur = 0.08) {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.15, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
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

// 艇同士の衝突(FRPの「ゴツン」+ きしみ): 艇速(speedNorm)に応じて音量・音色・鋭さを変化させ、スタート前の停止・微速時の接触は小さく控えめな音にする
export function thud(vol = 1, speedNorm = 1) {
  if (!ctx || vol <= 0.02) return;
  const sp = clampN(speedNorm, 0.08, 1.25);
  const sp01 = clamp01((sp - 0.08) / 0.92);
  const velGain = 0.22 + 0.78 * Math.pow(sp01, 1.20);
  const v = vol * velGain * 0.56;
  const dur = 0.11 + 0.12 * sp01;
  tone(90 + 44 * sp01, dur, 'sine', 0.65 * v, 42);
  noiseBurst(0.085 + 0.10 * sp01, 330 + 310 * sp01, 'lowpass', 0.72 * v);
  if (sp01 > 0.18) {
    noiseBurst(0.04 + 0.035 * sp01, 1600 + 700 * sp01, 'bandpass', 0.35 * v * sp01);
  }
}
// マーク接触(ブイの「ボコン」という中空音): 艇速に応じて強弱をつける
export function markHit(vol = 1, speedNorm = 1) {
  if (!ctx || vol <= 0.02) return;
  const sp01 = clamp01((clampN(speedNorm, 0.10, 1.20) - 0.10) / 0.90);
  const velGain = 0.26 + 0.74 * Math.pow(sp01, 1.15);
  const v = vol * velGain * 0.58;
  tone(185 + 30 * sp01, 0.32 + 0.18 * sp01, 'triangle', 0.52 * v, 145);
  tone(300 + 35 * sp01, 0.22 + 0.13 * sp01, 'sine', 0.28 * v, 250);
  if (sp01 > 0.20) {
    tone(540, 0.18, 'sine', 0.15 * v * sp01);
  }
  noiseBurst(0.045 + 0.02 * sp01, 1200 + 400 * sp01, 'bandpass', 0.36 * v);
}
// セールが「パンッ」と返る音(タック/ジャイブ時: 低音ブザー成分を排し、セール布の音のみ)
export function flap(vol = 0.6) {
  if (!ctx || vol <= 0.02) return;
  noiseBurst(0.07, 1300 + Math.random() * 500, 'bandpass', 0.30 * vol);
}
// タック/ジャイブでセールが返る自然な「バサッ」: 通常のタック・ジャイブは自然な音量で鳴らし、ごく短時間に連続で風軸を行き来した時のみ抑える
export function sailFlog(vol = 0.8) {
  if (!ctx || vol <= 0.02) return;
  const t0 = ctx.currentTime;
  const dtFlog = t0 - _lastSailFlogAt;
  if (dtFlog < 0.22) return;
  const effVol = (dtFlog < 1.4 ? vol * 0.35 : vol) * 0.68;
  _lastSailFlogAt = t0;
  // 1) 「シュッ…バサッ」: セール布が大きくしなって空気を切る中低域〜中域の布音
  const s1 = ctx.createBufferSource(); s1.buffer = noiseBuf; s1.playbackRate.value = 0.78;
  const bp1 = ctx.createBiquadFilter(); bp1.type = 'bandpass'; bp1.Q.value = 0.72;
  bp1.frequency.setValueAtTime(380, t0);
  bp1.frequency.exponentialRampToValueAtTime(860, t0 + 0.08);
  bp1.frequency.exponentialRampToValueAtTime(310, t0 + 0.34);
  const g1 = ctx.createGain();
  g1.gain.setValueAtTime(0.0001, t0);
  g1.gain.linearRampToValueAtTime(0.38 * effVol, t0 + 0.035); // 風をまたぐ瞬間の「バ」
  g1.gain.linearRampToValueAtTime(0.55 * effVol, t0 + 0.095); // 裏返って張る「サッ」
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
  g2.gain.linearRampToValueAtTime(0.30 * effVol, t0 + 0.16);
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
  const v = vol * 0.46;
  const slideDur = up ? 0.195 : 0.105;

  // 1) 「シャーー」: アルミポールがステンレス製ランチャーリングを滑る長めの金属擦過音(高域レゾナンス付き)
  const sSlide = ctx.createBufferSource(); sSlide.buffer = noiseBuf;
  sSlide.playbackRate.value = up ? 1.12 : 0.96;
  const bpSlide = ctx.createBiquadFilter(); bpSlide.type = 'bandpass'; bpSlide.Q.value = up ? 4.8 : 4.0;
  bpSlide.frequency.setValueAtTime(up ? 2350 : 4800, t);
  bpSlide.frequency.exponentialRampToValueAtTime(up ? 6200 : 2300, t + slideDur);
  const gSlide = ctx.createGain();
  gSlide.gain.setValueAtTime(0.0001, t);
  gSlide.gain.linearRampToValueAtTime(0.56 * v, t + 0.016);
  gSlide.gain.setValueAtTime(0.52 * v, t + slideDur - 0.018);
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
    ogm.gain.linearRampToValueAtTime(a * v, t + 0.018);
    ogm.gain.setValueAtTime(a * 0.9 * v, t + slideDur * 0.78);
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
  gClick.gain.linearRampToValueAtTime(0.72 * v, tk + 0.0015);
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
    og.gain.linearRampToValueAtTime(a * v, tStart + 0.0014);
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
    gSnap.gain.linearRampToValueAtTime(gainA * v, tSub + 0.009);
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
  const flapVol = (up ? 0.78 : 0.52) * v;
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
  g.gain.linearRampToValueAtTime(0.24, t + 0.018);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
  s.connect(bp); bp.connect(g); g.connect(master);
  s.start(t, Math.random() * 0.8); s.stop(t + 0.19);

  // 2) 低域インパクト + キレのあるブラス風コードヒット
  const punch = ctx.createOscillator(), pg = ctx.createGain();
  punch.type = 'triangle';
  punch.frequency.setValueAtTime(accent ? 165 : 135, t);
  punch.frequency.exponentialRampToValueAtTime(46, t + 0.16);
  pg.gain.setValueAtTime(0.0001, t);
  pg.gain.linearRampToValueAtTime(0.26, t + 0.006);
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
    og.gain.linearRampToValueAtTime(0.055, t + i * 0.008 + 0.01);
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
  if (windGain) {
    windGain.gain.setTargetAtTime(0.012, now, 0.10);
    if (windGain._gust) windGain._gust.gain.setTargetAtTime(0.004, now, 0.10);
  }
}

// ---- スタジオ品質マルチトラックBGMエンジン (サンプル精度16分音符ルックアヘッド・FMエレピ/ストリングス/ホーン/ギター/リード/スタジオドラム) ----
const NOTE_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function noteMidi(tok) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(tok);
  if (!m) return 0;
  const semi = NOTE_SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return (parseInt(m[3], 10) + 1) * 12 + semi;
}
const m2f = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
function parseBars(barList) {
  const out = [];
  for (let b = 0; b < barList.length; b++) {
    const toks = barList[b].trim().split(/\s+/).filter((t) => t !== '|');
    for (let i = 0; i < 16; i++) {
      const tk = toks[i] || '.';
      out.push(tk === '.' ? 0 : tk === '-' ? -1 : noteMidi(tk));
    }
  }
  return out;
}
function chordSpec(bassTok, voicingStr) {
  const bm = noteMidi(bassTok);
  const midis = voicingStr.trim().split(/\s+/).map(noteMidi);
  return { bassMidi: bm, bass: m2f(bm), midis, notes: midis.map(m2f) };
}
function heldSteps(seq, idx) {
  let n = 1;
  const L = seq.length;
  while (n < 32 && seq[(idx + n) % L] === -1) n++;
  return n;
}

export function stopBgm() {
  bgmMode = null;
  if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
  if (bgmBus && ctx) {
    const oldBus = bgmBus;
    bgmBus = null;
    if (oldBus._cleanup) oldBus._cleanup(0.08, 360);
    else {
      try {
        oldBus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08);
        setTimeout(() => { try { oldBus.disconnect(); } catch (e) {} }, 350);
      } catch (e) {}
    }
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
  if (ctx.state !== 'running') {
    bgmMode = mode;
    ctx.resume().then(() => {
      if (ctx && ctx.state === 'running' && bgmMode === mode && !bgmTimer && bgmVoiceEnabled) {
        bgmMode = null;
        playBgm(mode);
      }
    }).catch(() => {});
    return;
  }
  if (bgmMode === mode && bgmTimer) return;
  stopBgm();
  bgmMode = mode;

  // --- スタジオBGMマスターバス + ステレオ・ピンポンディレイ + ホールリバーブセンド ---
  const outBus = ctx.createGain();
  outBus.gain.setValueAtTime(0.0008, ctx.currentTime);
  const targetGain = mode === 'result' ? 0.46
    : mode === 'review' ? 0.42
    : mode === 'menu' ? 0.40
    : mode === 'orientation' ? 0.38
    : mode.startsWith('prestart') ? 0.29
    : 0.27;
  outBus.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 0.32);
  outBus.connect(master);

  const inBus = ctx.createGain();
  inBus.gain.value = 1.0;
  const lowShelf = ctx.createBiquadFilter();
  lowShelf.type = 'lowshelf'; lowShelf.frequency.value = 115; lowShelf.gain.value = 1.4;
  const airShelf = ctx.createBiquadFilter();
  airShelf.type = 'highshelf'; airShelf.frequency.value = 7200; airShelf.gain.value = 1.2;
  // レース・スタート前は信号ホーン帯域(約415Hz)をわずかにすっきりさせ、効果音との分離を極上にする
  const hornDip = ctx.createBiquadFilter();
  hornDip.type = 'peaking'; hornDip.frequency.value = 415; hornDip.Q.value = 1.6;
  hornDip.gain.value = (mode.startsWith('race') || mode.startsWith('prestart')) ? -2.4 : 0.0;
  inBus.connect(lowShelf); lowShelf.connect(hornDip); hornDip.connect(airShelf); airShelf.connect(outBus);

  const revSend = ctx.createGain();
  revSend.gain.value = mode === 'review' ? 0.24 : mode === 'menu' ? 0.20 : mode === 'result' ? 0.20 : 0.16;
  airShelf.connect(revSend);
  if (fx) revSend.connect(fx);

  // ステレオ・ピンポンディレイ (リード・エレピ・ベル・ブラスに立体的な奥行きと広がりを付与)
  const dlySend = ctx.createGain();
  dlySend.gain.value = 0.18;
  const dlyHP = ctx.createBiquadFilter(); dlyHP.type = 'highpass'; dlyHP.frequency.value = 420;
  const dlyLP = ctx.createBiquadFilter(); dlyLP.type = 'lowpass'; dlyLP.frequency.value = 3900;
  const dlyL = ctx.createDelay(1.0), dlyR = ctx.createDelay(1.0);
  dlyL.delayTime.value = 0.34; dlyR.delayTime.value = 0.46;
  const fbL = ctx.createGain(), fbR = ctx.createGain();
  fbL.gain.value = 0.27; fbR.gain.value = 0.25;
  const panL = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  const panR = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (panL && panR) { panL.pan.value = -0.72; panR.pan.value = 0.72; }
  dlySend.connect(dlyHP); dlyHP.connect(dlyLP);
  dlyLP.connect(dlyL);
  dlyL.connect(fbL); fbL.connect(dlyR);
  dlyR.connect(fbR); fbR.connect(dlyL);
  if (panL && panR) {
    dlyL.connect(panL); panL.connect(outBus);
    dlyR.connect(panR); panR.connect(outBus);
  } else {
    dlyL.connect(outBus); dlyR.connect(outBus);
  }

  let cleaned = false;
  outBus._cleanup = (tc = 0.08, ms = 350) => {
    if (cleaned) return;
    cleaned = true;
    try {
      const now = ctx ? ctx.currentTime : 0;
      outBus.gain.cancelScheduledValues(now);
      outBus.gain.setTargetAtTime(0.0001, now, tc);
      revSend.gain.setTargetAtTime(0.0001, now, tc);
      fbL.gain.setValueAtTime(0, now + 0.02);
      fbR.gain.setValueAtTime(0, now + 0.02);
      setTimeout(() => {
        try { fbL.disconnect(); fbR.disconnect(); dlyL.disconnect(); dlyR.disconnect(); } catch (e) {}
        try { revSend.disconnect(); outBus.disconnect(); } catch (e) {}
      }, ms);
    } catch (e) {}
  };
  bgmBus = outBus;

  const isAlive = () => !!(ctx && ctx.state === 'running' && bgmBus === outBus && bgmVoiceEnabled && !cleaned);
  const routePan = (node, panVal = 0, sendDelay = 0, sendRev = 0) => {
    if (panVal !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clampN(panVal, -0.95, 0.95);
      node.connect(p);
      p.connect(inBus);
    } else {
      node.connect(inBus);
    }
    if (sendDelay > 0.001) {
      const ds = ctx.createGain(); ds.gain.value = sendDelay;
      node.connect(ds); ds.connect(dlySend);
    }
    if (sendRev > 0.001 && fx) {
      const rs = ctx.createGain(); rs.gain.value = sendRev;
      node.connect(rs); rs.connect(fx);
    }
  };

  // 1) スタジオ・キックドラム (重厚なローエンドの胴鳴り＋ビーターのアタッククリック)
  const playKick = (t0, vel = 1.0) => {
    if (!isAlive()) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(152, t0);
    o.frequency.exponentialRampToValueAtTime(56, t0 + 0.042);
    o.frequency.exponentialRampToValueAtTime(44, t0 + 0.22);
    const v = 0.21 * vel;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(v, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(v * 0.42, t0 + 0.065);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
    o.connect(g); g.connect(inBus);
    o.start(t0); o.stop(t0 + 0.26);
    if (noiseBuf && vel > 0.55) {
      const c = ctx.createBufferSource(); c.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2300; bp.Q.value = 1.4;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.042 * vel, t0);
      cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.014);
      c.connect(bp); bp.connect(cg); cg.connect(inBus);
      c.start(t0, Math.random() * 0.8); c.stop(t0 + 0.018);
    }
  };

  // 2) スタジオ・スネア＆クロススティック (胴鳴りトーン＋スナッピーワイヤー＋プレート残響)
  const playSnare = (t0, vel = 1.0, rim = false) => {
    if (!isAlive()) return;
    if (rim) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1280; bp.Q.value = 3.2;
      o.type = 'triangle';
      o.frequency.setValueAtTime(860, t0);
      o.frequency.exponentialRampToValueAtTime(430, t0 + 0.028);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.095 * vel, t0 + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.055);
      o.connect(bp); bp.connect(g);
      routePan(g, -0.10, 0, 0.16);
      o.start(t0); o.stop(t0 + 0.065);
      return;
    }
    const body = ctx.createOscillator(), bg = ctx.createGain();
    body.type = 'triangle';
    body.frequency.setValueAtTime(218, t0);
    body.frequency.exponentialRampToValueAtTime(132, t0 + 0.075);
    bg.gain.setValueAtTime(0.0001, t0);
    bg.gain.linearRampToValueAtTime(0.095 * vel, t0 + 0.003);
    bg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.095);
    body.connect(bg); bg.connect(inBus);
    body.start(t0); body.stop(t0 + 0.11);
    if (noiseBuf) {
      const s = ctx.createBufferSource(); s.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2450; bp.Q.value = 0.78;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 950;
      const ng = ctx.createGain();
      const dur = 0.145 + 0.035 * vel;
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.linearRampToValueAtTime(0.105 * vel, t0 + 0.003);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      s.connect(bp); bp.connect(hp); hp.connect(ng);
      routePan(ng, -0.06, 0, 0.22 * vel);
      s.start(t0, Math.random() * 1.1); s.stop(t0 + dur + 0.02);
    }
  };

  // 3) クリスプ・メタルハイハット＆シェイカー
  const playHat = (t0, vel = 0.7, open = false, pan = 0.22) => {
    if (!isAlive() || !noiseBuf) return;
    const dur = open ? 0.22 : 0.046;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = open ? 5800 : 7200;
    const pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 9600; pk.Q.value = 1.8; pk.gain.value = 3.5;
    const g = ctx.createGain();
    const v = (open ? 0.052 : 0.038) * vel;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(v, t0 + 0.0025);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(hp); hp.connect(pk); pk.connect(g);
    routePan(g, pan, 0, open ? 0.12 : 0);
    s.start(t0, Math.random() * 1.3); s.stop(t0 + dur + 0.02);
  };

  // 4) シンバルクラッシュ / ウィンドチャイム・スウェル (サビ突入やセクション転換の華やかさ)
  const playCrash = (t0, vel = 0.85) => {
    if (!isAlive() || !noiseBuf) return;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4400;
    const bp = ctx.createBiquadFilter(); bp.type = 'peaking'; bp.frequency.value = 7800; bp.Q.value = 1.1; bp.gain.value = 4.0;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.082 * vel, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.024 * vel, t0 + 0.28);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.45);
    s.connect(hp); hp.connect(bp); bp.connect(g);
    routePan(g, -0.28, 0.08, 0.36);
    s.start(t0, 0.1); s.stop(t0 + 1.5);
  };

  // 5) スタジオ・タム (フィルインの疾走感・立体パンニング)
  const playTom = (t0, freq = 145, vel = 0.9, pan = 0) => {
    if (!isAlive()) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 1.42, t0);
    o.frequency.exponentialRampToValueAtTime(freq, t0 + 0.055);
    o.frequency.exponentialRampToValueAtTime(freq * 0.78, t0 + 0.19);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.145 * vel, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.20);
    o.connect(g);
    routePan(g, pan, 0, 0.18);
    o.start(t0); o.stop(t0 + 0.22);
  };

  // 6) マルチレイヤー・エレキベース (サブサイン波＋倍音グロウ＋エンベロープフィルタ: slap / fusion / warm / rock)
  const playBass = (freq, t0, dur, vel = 1.0, style = 'fusion') => {
    if (!isAlive() || freq <= 0) return;
    const d = Math.max(0.08, dur);
    const sub = ctx.createOscillator(), body = ctx.createOscillator();
    const lp = ctx.createBiquadFilter(), g = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(freq, t0);
    body.type = style === 'warm' ? 'triangle' : 'sawtooth';
    body.frequency.setValueAtTime(freq * (style === 'slap' ? 1.0015 : 1.001), t0);
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = style === 'warm' ? 0.36 : style === 'slap' ? 0.68 : 0.52;
    lp.type = 'lowpass';
    lp.Q.value = style === 'slap' ? 3.2 : style === 'fusion' ? 2.0 : 1.1;
    const fPeak = style === 'slap' ? 2350 : style === 'rock' ? 1650 : style === 'fusion' ? 1380 : 680;
    const fEnd = style === 'warm' ? 260 : 340;
    lp.frequency.setValueAtTime(fPeak, t0);
    lp.frequency.exponentialRampToValueAtTime(fEnd, t0 + Math.min(0.18, d * 0.72));
    const amp = (style === 'warm' ? 0.145 : 0.135) * vel;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + 0.006);
    g.gain.setValueAtTime(amp * 0.84, t0 + Math.min(0.04, d * 0.35));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.025);
    sub.connect(g);
    body.connect(bodyGain); bodyGain.connect(lp); lp.connect(g);
    g.connect(inBus);
    sub.start(t0); body.start(t0);
    sub.stop(t0 + d + 0.04); body.stop(t0 + d + 0.04);
  };

  // 7) 2オペレータFM Fender Rhodes / クリスタルEP (倍音タインのアタックと温かいサステイン)
  const playEPiano = (freqs, t0, dur, vel = 0.85, pan = -0.18, crystal = false) => {
    if (!isAlive()) return;
    const d = Math.max(0.14, dur);
    const out = ctx.createGain();
    out.gain.value = 1.0;
    routePan(out, pan, crystal ? 0.22 : 0.12, 0.20);
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      const ts = t0 + i * 0.011;
      const car = ctx.createOscillator(), mod = ctx.createOscillator();
      const modG = ctx.createGain(), vG = ctx.createGain();
      car.type = 'sine'; car.frequency.setValueAtTime(f, ts);
      mod.type = 'sine'; mod.frequency.setValueAtTime(f * (crystal ? 7.0 : 2.0), ts);
      modG.gain.setValueAtTime(f * (crystal ? 1.55 : 1.15) * vel, ts);
      modG.gain.exponentialRampToValueAtTime(f * 0.10, ts + Math.min(0.16, d * 0.55));
      const amp = (0.040 / Math.sqrt(freqs.length * 0.55)) * vel;
      vG.gain.setValueAtTime(0.0001, ts);
      vG.gain.linearRampToValueAtTime(amp, ts + 0.007);
      vG.gain.exponentialRampToValueAtTime(amp * 0.46, ts + Math.min(0.24, d * 0.5));
      vG.gain.exponentialRampToValueAtTime(0.0001, ts + d + 0.04);
      mod.connect(modG); modG.connect(car.frequency);
      car.connect(vG); vG.connect(out);
      car.start(ts); mod.start(ts);
      car.stop(ts + d + 0.06); mod.stop(ts + d + 0.06);
    }
  };

  // 8) クリーン・カッティングギター / アコースティック・ストラム
  const playGuitar = (freqs, t0, dur, vel = 0.8, mute = false, pan = 0.34) => {
    if (!isAlive()) return;
    const d = mute ? 0.052 : Math.max(0.10, dur);
    const out = ctx.createGain();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(mute ? 2200 : 3800, t0);
    lp.frequency.exponentialRampToValueAtTime(mute ? 780 : 1250, t0 + d);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 240;
    out.connect(hp); hp.connect(lp);
    routePan(lp, pan, mute ? 0.08 : 0.18, 0.14);
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      const ts = t0 + i * (mute ? 0.004 : 0.009);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = i % 2 === 0 ? 'sawtooth' : 'triangle';
      o.frequency.setValueAtTime(f, ts);
      const amp = (mute ? 0.026 : 0.030) * vel;
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.linearRampToValueAtTime(amp, ts + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + d + 0.015);
      o.connect(g); g.connect(out);
      o.start(ts); o.stop(ts + d + 0.03);
    }
  };

  // 9) シンフォニック・ステレオストリングス・アンサンブル (デチューン多重ノコギリ波＋優美なボウイング)
  const playStrings = (freqs, t0, dur, vel = 0.8, slow = true) => {
    if (!isAlive()) return;
    const d = Math.max(0.25, dur);
    const outL = ctx.createGain(), outR = ctx.createGain();
    const lpL = ctx.createBiquadFilter(), lpR = ctx.createBiquadFilter();
    lpL.type = 'lowpass'; lpL.frequency.value = 2650;
    lpR.type = 'lowpass'; lpR.frequency.value = 2750;
    outL.connect(lpL); outR.connect(lpR);
    routePan(lpL, -0.52, 0.08, 0.34);
    routePan(lpR, 0.52, 0.08, 0.34);
    const atk = slow ? Math.min(0.22, d * 0.32) : 0.035;
    const perNote = (0.022 / Math.sqrt(Math.max(1, freqs.length * 0.5))) * vel;
    for (let i = 0; i < freqs.length; i++) {
      const baseF = freqs[i];
      const dets = [-7.5, 7.5];
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(baseF, t0);
        o.detune.setValueAtTime(dets[k] + (i % 2 === 0 ? -2 : 2), t0);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(perNote, t0 + atk);
        g.gain.setValueAtTime(perNote * 0.88, t0 + Math.max(atk + 0.01, d * 0.72));
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.14);
        o.connect(g); g.connect(k === 0 ? outL : outR);
        o.start(t0); o.stop(t0 + d + 0.16);
      }
    }
  };

  // 10) ビッグバンド / シンフォニック・ブラスセクション (リップ・スクープ＆フィルタフレア)
  const playBrass = (freqs, t0, dur, vel = 0.9, pan = -0.22) => {
    if (!isAlive()) return;
    const d = Math.max(0.11, dur);
    const mix = ctx.createGain();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.45;
    lp.frequency.setValueAtTime(680, t0);
    lp.frequency.exponentialRampToValueAtTime(3600 * Math.min(1.15, 0.7 + 0.4 * vel), t0 + Math.min(0.055, d * 0.4));
    lp.frequency.exponentialRampToValueAtTime(1550, t0 + d);
    mix.connect(lp);
    routePan(lp, pan, 0.18, 0.28);
    const amp = (0.036 / Math.sqrt(Math.max(1, freqs.length * 0.55))) * vel;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      const ts = t0 + i * 0.005;
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
      o1.type = 'sawtooth'; o2.type = 'sawtooth';
      o1.frequency.setValueAtTime(f * 0.985, ts);
      o1.frequency.exponentialRampToValueAtTime(f, ts + 0.022);
      o2.frequency.setValueAtTime(f * 0.988, ts);
      o2.frequency.exponentialRampToValueAtTime(f * 1.0035, ts + 0.026);
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.linearRampToValueAtTime(amp, ts + 0.018);
      g.gain.setValueAtTime(amp * 0.78, ts + Math.max(0.024, d * 0.68));
      g.gain.exponentialRampToValueAtTime(0.0001, ts + d + 0.045);
      o1.connect(g); o2.connect(g); g.connect(mix);
      o1.start(ts); o2.start(ts);
      o1.stop(ts + d + 0.06); o2.stop(ts + d + 0.06);
    }
  };

  // 11) FMヴィブラフォン / グロッケンシュピール・ベル (海面の煌めき・ファンファーレ装飾)
  const playBell = (freq, t0, dur, vel = 0.75, pan = 0.28) => {
    if (!isAlive() || freq <= 0) return;
    const d = Math.max(0.18, dur);
    const car = ctx.createOscillator(), mod = ctx.createOscillator();
    const modG = ctx.createGain(), g = ctx.createGain();
    car.type = 'sine'; car.frequency.setValueAtTime(freq, t0);
    mod.type = 'sine'; mod.frequency.setValueAtTime(freq * 3.5, t0);
    modG.gain.setValueAtTime(freq * 1.35 * vel, t0);
    modG.gain.exponentialRampToValueAtTime(freq * 0.04, t0 + 0.14);
    const amp = 0.042 * vel;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.08);
    mod.connect(modG); modG.connect(car.frequency);
    car.connect(g);
    routePan(g, pan, 0.28, 0.26);
    car.start(t0); mod.start(t0);
    car.stop(t0 + d + 0.10); mod.stop(t0 + d + 0.10);
  };

  // 12) エクスプレッシブ・ソロリード (ポルタメント＋ディレイドLFOビブラート＋ステレオピンポンエコー)
  // patch: 'ewi' (T-Square風リリカルウインドシンセ) | 'fusion' (Casiopea/都会派ポリリード) | 'heroic' (トランペット＆ストリングス) | 'flute' (爽風フルート)
  const playLead = (freq, prevFreq, t0, dur, vel = 1.0, patch = 'ewi', pan = 0.06) => {
    if (!isAlive() || freq <= 0) return;
    const d = Math.max(0.09, dur);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    const lp = ctx.createBiquadFilter(), g = ctx.createGain();
    const glide = prevFreq > 0 && Math.abs(prevFreq - freq) < freq * 0.38 ? 0.028 : 0;
    const fStart = glide > 0 ? prevFreq : freq * 0.996;

    if (patch === 'flute') {
      o1.type = 'sine'; o2.type = 'triangle';
    } else if (patch === 'fusion') {
      o1.type = 'sawtooth'; o2.type = 'square';
    } else {
      o1.type = 'sawtooth'; o2.type = 'triangle';
    }
    o1.frequency.setValueAtTime(fStart, t0);
    o2.frequency.setValueAtTime(patch === 'ewi' ? fStart * 0.5 : fStart * 1.003, t0);
    if (glide > 0) {
      o1.frequency.exponentialRampToValueAtTime(freq, t0 + glide);
      o2.frequency.exponentialRampToValueAtTime(patch === 'ewi' ? freq * 0.5 : freq * 1.003, t0 + glide);
    } else {
      o1.frequency.exponentialRampToValueAtTime(freq, t0 + 0.012);
      o2.frequency.exponentialRampToValueAtTime(patch === 'ewi' ? freq * 0.5 : freq * 1.003, t0 + 0.012);
    }

    // ロングトーンに自然な表情を与えるディレイド・ビブラート
    if (d >= 0.22) {
      const vib = ctx.createOscillator(), vg = ctx.createGain();
      vib.type = 'sine'; vib.frequency.value = patch === 'flute' ? 5.2 : 5.8;
      vg.gain.setValueAtTime(0.0001, t0);
      vg.gain.setValueAtTime(0.0001, t0 + 0.11);
      vg.gain.linearRampToValueAtTime(freq * (patch === 'flute' ? 0.0085 : 0.0075), t0 + Math.min(0.28, d * 0.75));
      vib.connect(vg); vg.connect(o1.frequency);
      vib.start(t0); vib.stop(t0 + d + 0.06);
    }

    const g2 = ctx.createGain();
    g2.gain.value = patch === 'ewi' ? 0.42 : patch === 'flute' ? 0.35 : 0.58;
    lp.type = 'lowpass';
    lp.Q.value = patch === 'fusion' ? 2.1 : patch === 'ewi' ? 1.5 : 1.0;
    const cutPeak = patch === 'flute' ? 2900 : patch === 'ewi' ? 3900 : 4400;
    lp.frequency.setValueAtTime(cutPeak * 0.48, t0);
    lp.frequency.exponentialRampToValueAtTime(cutPeak, t0 + Math.min(0.045, d * 0.35));
    lp.frequency.exponentialRampToValueAtTime(cutPeak * 0.62, t0 + d);

    const amp = (patch === 'flute' ? 0.088 : patch === 'ewi' ? 0.068 : 0.060) * vel;
    const atk = patch === 'flute' ? 0.024 : 0.012;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + atk);
    g.gain.setValueAtTime(amp * 0.86, t0 + Math.max(atk + 0.01, d * 0.76));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.035);

    o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g);
    routePan(g, pan, 0.34, 0.24);
    o1.start(t0); o2.start(t0);
    o1.stop(t0 + d + 0.055); o2.stop(t0 + d + 0.055);
  };

  // --- サンプル精度 16分音符ルックアヘッド・スケジューラ ---
  const startSequencer = (bpm, swing, totalSteps, renderStep) => {
    const stepSec = 60 / bpm / 4; // 16分音符1ステップの秒数
    dlyL.delayTime.value = clampN(stepSec * 3, 0.12, 0.85); // 付点8分ディレイ
    dlyR.delayTime.value = clampN(stepSec * 4, 0.16, 0.95); // 4分ディレイ
    let step = 0;
    let nextTime = ctx.currentTime + 0.035;
    const sched = () => {
      if (!isAlive() || bgmMode !== mode) return;
      const now = ctx.currentTime;
      if (nextTime < now - 0.24) nextTime = now + 0.025; // バックグラウンドタブ復帰時のバースト防止
      while (nextTime < now + 0.165) {
        const s = step % totalSteps;
        const swOffset = (s % 2 === 1) ? stepSec * swing : 0;
        renderStep(s, nextTime + swOffset, stepSec, step);
        nextTime += stepSec;
        step++;
      }
    };
    sched();
    bgmTimer = setInterval(sched, 42);
  };

  if (mode === 'menu') {
    // 1) メニュー画面BGM: "Shonan Marina Breeze" (114 BPM, 16小節=256ステップ, リゾート・ジャズボッサ＆FMローズ・フルート・ストリングス)
    const chords = [
      // Section A (Bars 1-8: 陽だまりのヨットハーバー)
      chordSpec('C2', 'E4 G4 B4 D5'),   chordSpec('A2', 'G4 B4 C5 E5'),
      chordSpec('D2', 'F4 A4 C5 E5'),   chordSpec('G2', 'F4 A4 B4 E5'),
      chordSpec('E2', 'G4 B4 D5 F#5'),  chordSpec('A2', 'G4 C#5 E5 F#5'),
      chordSpec('D2', 'F4 A4 C5 E5'),   chordSpec('G2', 'F4 B4 D5 E5'),
      // Section B (Bars 9-16: 水平線へ広がる潮風とストリングス)
      chordSpec('F2', 'A4 C5 E5 G5'),   chordSpec('Bb2', 'Ab4 C5 D5 G5'),
      chordSpec('E2', 'G4 B4 D5 F#5'),  chordSpec('A2', 'G4 B4 C5 E5'),
      chordSpec('D2', 'F4 A4 C5 E5'),   chordSpec('E2', 'G#4 C5 D5 G5'),
      chordSpec('A2', 'G4 B4 C5 E5'),   chordSpec('G2', 'F4 A4 B4 E5'),
    ];
    const mel = parseBars([
      // Section A
      'G5 - - E5 | - D5 C5 - | E5 - - - | . . D5 E5',
      'C5 - - B4 | - A4 G4 - | B4 - - - | . . A4 B4',
      'C5 - - D5 | - E5 G5 - | A5 - - G5 | - E5 D5 -',
      'G5 - - - | F5 - E5 D5 | E5 - - - | . . . .',
      'B5 - - G5 | - F#5 E5 - | G5 - - - | . . F#5 G5',
      'A5 - - G5 | - E5 C#5 - | E5 - - - | . . D5 E5',
      'F5 - - G5 | - A5 C6 - | B5 - - A5 | - G5 E5 -',
      'D5 - - - | E5 - G5 - | D5 - - - | . . . .',
      // Section B
      'A5 - - G5 | - E5 C5 - | E5 - G5 - | A5 - - -',
      'Ab5 - - G5 | - F5 D5 - | G5 - - - | . . F5 G5',
      'B5 - - A5 | - G5 E5 - | G5 - B5 - | D6 - - -',
      'C6 - - B5 | - A5 G5 - | E5 - - - | . . E5 G5',
      'A5 - - B5 | - C6 D6 - | B5 - - A5 | - G#5 E5 -',
      'E6 - - D6 | - B5 G#5 - | B5 - - - | . . A5 B5',
      'C6 - - B5 | - A5 G5 - | E5 - G5 - | A5 - C6 -',
      'B5 - - A5 | - G5 E5 - | D5 - - - | . . . .',
    ]);
    const arpPat = [0, 2, 3, 1, 2, 3, 1, 2];
    let prevM = 0;
    startSequencer(114, 0.14, 256, (s, t0, stepSec, absStep) => {
      const bar = Math.floor(s / 16), sub = s % 16, sec = bar >= 8 ? 1 : 0;
      const ch = chords[bar];
      if (s === 0 || s === 128) playCrash(t0, absStep === 0 ? 0.55 : 0.72);
      // 温かいFMローズのボサノヴァ・シンコペーションバッキング
      if (sub === 0 || sub === 6 || sub === 10 || sub === 14) {
        const dur = (sub === 0 ? 5.2 : sub === 6 ? 3.5 : 2.2) * stepSec;
        playEPiano(ch.notes, t0, dur, sub === 0 ? 0.88 : 0.66, -0.24, false);
      }
      // ナイロン・アコースティックギターの軽快なカッティング
      if (sub === 3 || sub === 6 || sub === 11 || sub === 14) {
        playGuitar(ch.notes.slice(0, 3), t0, (sub === 6 ? 2.6 : 1.4) * stepSec, 0.65, sub === 3 || sub === 11, 0.36);
      }
      // セクションBから優雅なステレオ・ストリングスパッドを重ねる
      if (sec === 1 && sub === 0) {
        playStrings(ch.notes, t0, 15.5 * stepSec, 0.74, true);
      }
      // 煌めくヴィブラフォン・アルペジオ
      if (sub % 2 === 0 && (sec === 1 || sub === 4 || sub === 12)) {
        const bf = ch.notes[arpPat[(sub >> 1) % 8] % ch.notes.length] * 2;
        playBell(bf, t0, 2.8 * stepSec, 0.42, 0.30);
      }
      // ボサノヴァ・フィンガーベース (1拍目ルート・2拍裏ゴースト・3拍目5度・4拍裏アプローチ)
      if (sub === 0) playBass(ch.bass, t0, 5.4 * stepSec, 0.95, 'warm');
      else if (sub === 6) playBass(ch.bass * 1.5, t0, 1.8 * stepSec, 0.62, 'warm');
      else if (sub === 8) playBass(ch.bass * 1.5, t0, 5.2 * stepSec, 0.85, 'warm');
      else if (sub === 14) playBass(ch.bass * 2, t0, 1.8 * stepSec, 0.68, 'warm');
      // 爽やかなフルート・リード＋セクションBのベル・ユニゾン
      const m = mel[s];
      if (m > 0) {
        const hLen = heldSteps(mel, s) * stepSec * 0.94;
        const mf = m2f(m);
        playLead(mf, prevM, t0, hLen, 0.92, 'flute', 0.05);
        if (sec === 1) playBell(mf, t0, Math.min(0.45, hLen), 0.36, -0.18);
        prevM = mf;
      }
      // ドラム＆パーカッション (ボッサ・キック＋クロススティック＋繊細な16分シェイカー)
      if (sub === 0 || sub === 6 || sub === 8 || (bar % 4 === 3 && sub === 15)) {
        playKick(t0, sub === 0 || sub === 8 ? 0.78 : 0.52);
      }
      if (sub === 4 || sub === 10 || (bar % 2 === 1 && sub === 13)) {
        playSnare(t0, sub === 4 ? 0.72 : 0.58, true);
      }
      playHat(t0, sub % 4 === 0 ? 0.65 : sub % 2 === 0 ? 0.44 : 0.25, sub === 14, 0.24);
    });
  } else if (mode === 'orientation') {
    // 2) オリエンテーションBGM: "Heroic Regatta Briefing" (140 BPM, 16小節=256ステップ, シンフォニック・ブラス＆ロック)
    const chords = [
      // Section A (Bars 1-8)
      chordSpec('D2', 'D4 F4 A4 D5'),   chordSpec('Bb1', 'D4 F4 Bb4 D5'),
      chordSpec('C2', 'E4 G4 C5 E5'),   chordSpec('F2', 'F4 A4 C5 E5'),
      chordSpec('G2', 'F4 Bb4 D5 G5'),  chordSpec('A1', 'E4 G4 C#5 E5'),
      chordSpec('D2', 'F4 A4 D5 E5'),   chordSpec('A1', 'E4 G4 C#5 F5'),
      // Section B (Bars 9-16)
      chordSpec('Bb1', 'F4 Bb4 D5 F5'), chordSpec('C2', 'E4 G4 C5 E5'),
      chordSpec('A1', 'E4 A4 C5 E5'),   chordSpec('D2', 'F4 A4 C5 D5'),
      chordSpec('G2', 'F4 Bb4 D5 F5'),  chordSpec('C2', 'E4 G4 Bb4 D5'),
      chordSpec('F2', 'F4 A4 C5 E5'),   chordSpec('A1', 'E4 G#4 C#5 F5'),
    ];
    const mel = parseBars([
      // Section A
      'D5 - - . | D5 - E5 - | F5 - - E5 | - D5 C5 -',
      'D5 - - . | F5 - G5 - | A5 - - - | . . G5 F5',
      'E5 - - . | E5 - F5 - | G5 - - A5 | - G5 F5 -',
      'A5 - - . | C6 - A5 - | F5 - - - | . . . .',
      'Bb5 - A5 - | G5 - F5 - | G5 - A5 - | Bb5 - - -',
      'A5 - G5 - | F5 - E5 - | A5 - - - | G5 - E5 -',
      'D5 - - E5 | F5 - G5 - | A5 - - - | D6 - - -',
      'C#6 - - B5 | - A5 G5 - | A5 - - - | . . . .',
      // Section B: Soaring Symphonic Anthem
      'D6 - - C6 | - Bb5 A5 - | Bb5 - D6 - | F6 - - -',
      'E6 - - D6 | - C6 G5 - | C6 - - - | . . Bb5 C6',
      'C6 - - B5 | - A5 E5 - | A5 - C6 - | E6 - - -',
      'D6 - - C6 | - A5 F5 - | D5 - - - | . . D5 F5',
      'G5 - A5 - | Bb5 - C6 - | D6 - - C6 | - Bb5 A5 -',
      'G5 - C6 - | D6 - E6 - | C6 - - - | . . Bb5 A5',
      'A5 - - C6 | - F6 E6 - | D6 - C6 - | A5 - F5 -',
      'A5 - - B5 | - C#6 D6 - | E6 - - - | . . . .',
    ]);
    let prevM = 0;
    startSequencer(140, 0.0, 256, (s, t0, stepSec) => {
      const bar = Math.floor(s / 16), sub = s % 16, sec = bar >= 8 ? 1 : 0;
      const ch = chords[bar];
      if (s === 0 || s === 128) playCrash(t0, 0.90);
      // 壮麗なシンフォニック・ストリングス＋刻みオスティナート
      if (sub === 0) playStrings(ch.notes, t0, 15.2 * stepSec, sec === 1 ? 0.92 : 0.72, false);
      if (sub % 2 === 0) {
        playGuitar([ch.notes[0], ch.notes[1], ch.notes[2]], t0, 1.3 * stepSec, sub % 4 === 0 ? 0.72 : 0.48, sub % 4 !== 0, 0.38);
      }
      // 力強いブラス・コードヒット
      if (sub === 0 || sub === 6 || sub === 12) {
        playBrass(ch.notes, t0, (sub === 0 ? 3.8 : 2.2) * stepSec, sub === 0 ? 0.88 : 0.68, -0.26);
      }
      // 疾走する8分・16分ロックベース
      if (sub % 2 === 0 || sub === 15) {
        const bf = sub === 12 || sub === 14 ? ch.bass * 1.5 : sub === 15 ? ch.bass * 2 : ch.bass;
        playBass(bf, t0, 1.7 * stepSec, sub % 4 === 0 ? 0.98 : 0.74, 'rock');
      }
      // ヒロイック・ブラス＆リードユニゾン
      const m = mel[s];
      if (m > 0) {
        const hLen = heldSteps(mel, s) * stepSec * 0.92;
        const mf = m2f(m);
        playLead(mf, prevM, t0, hLen, 0.96, 'heroic', 0.06);
        if (sec === 1) playBrass([mf * 0.5, mf], t0, Math.min(0.42, hLen), 0.56, -0.18);
        prevM = mf;
      }
      // ロックドラム＋8小節目・16小節目のタムフィル
      const isFill = (bar === 7 || bar === 15) && sub >= 8;
      if (isFill) {
        const tf = sub < 10 ? 210 : sub < 12 ? 165 : sub < 14 ? 128 : 98;
        const tp = ((sub - 8) / 7) * 1.1 - 0.55;
        playTom(t0, tf, 0.92, tp);
        if (sub === 12 || sub === 14) playSnare(t0, 0.88, false);
      } else {
        if (sub === 0 || sub === 6 || sub === 8 || sub === 10) playKick(t0, sub === 0 || sub === 8 ? 0.95 : 0.72);
        if (sub === 4 || sub === 12) playSnare(t0, 0.92, false);
        playHat(t0, sub % 4 === 0 ? 0.75 : sub % 2 === 0 ? 0.52 : 0.30, sub === 14, 0.24);
      }
    });
  } else if (mode === 'prestart_enoshima' || mode === 'prestart_hakkeijima') {
    // 3) プリスタート(1分前〜スタート)BGM: 緊張感と高揚感が交錯する16小節タクティカル・カウントダウン
    const isHakkei = mode === 'prestart_hakkeijima';
    const chords = isHakkei
      ? [
          // 八景島: 都会的でスリリングな Cm9 -> Abmaj9 -> Fm9 -> G7alt 進行 (16小節)
          chordSpec('C2', 'Eb4 G4 Bb4 D5'), chordSpec('C2', 'Eb4 G4 Bb4 D5'),
          chordSpec('Ab1', 'Eb4 G4 C5 D5'), chordSpec('G1', 'F4 Ab4 B4 Eb5'),
          chordSpec('F2', 'Eb4 G4 Ab4 C5'), chordSpec('C2', 'Eb4 G4 Bb4 D5'),
          chordSpec('D2', 'F4 Ab4 C5 Eb5'), chordSpec('G1', 'F4 B4 Eb5 Ab5'),
          chordSpec('Ab1', 'Eb4 G4 Bb4 C5'), chordSpec('Bb1', 'F4 Ab4 C5 D5'),
          chordSpec('G1', 'F4 Bb4 D5 G5'),   chordSpec('C2', 'Eb4 G4 Bb4 D5'),
          chordSpec('F2', 'Eb4 Ab4 C5 Eb5'), chordSpec('D2', 'F#4 A4 C5 Eb5'),
          chordSpec('G1', 'F4 C5 D5 G5'),    chordSpec('G1', 'F4 B4 Eb5 Ab5'),
        ]
      : [
          // 江の島: 潮風とスタートラインの駆け引きを描く D9sus4 -> Cmaj9 -> Bbmaj7#11 -> A7sus4 (16小節)
          chordSpec('D2', 'G4 A4 C5 E5'),   chordSpec('C2', 'E4 G4 B4 D5'),
          chordSpec('Bb1', 'F4 A4 C5 E5'),  chordSpec('A1', 'E4 G4 C#5 E5'),
          chordSpec('B1', 'F#4 A4 D5 E5'),  chordSpec('G2', 'F#4 A4 B4 D5'),
          chordSpec('E2', 'G4 B4 D5 F#5'),  chordSpec('A1', 'E4 G4 B4 D5'),
          chordSpec('G2', 'F#4 A4 B4 E5'),  chordSpec('A1', 'E4 G4 C#5 E5'),
          chordSpec('F#2', 'E4 A4 C#5 E5'), chordSpec('B1', 'F#4 A4 D5 F#5'),
          chordSpec('E2', 'G4 B4 D5 F#5'),  chordSpec('F2', 'A4 C5 E5 G5'),
          chordSpec('A1', 'E4 G4 B4 D5'),   chordSpec('A1', 'E4 G4 C#5 F5'),
        ];
    const mel = isHakkei
      ? parseBars([
          'G5 - . Eb5 | . C5 - D5 | Eb5 - . G5 | - . . .',
          'F5 - . Eb5 | . D5 - C5 | D5 - . . | . . . .',
          'Eb5 - . G5 | . Bb5 - Ab5 | G5 - . F5 | - Eb5 D5 -',
          'D5 - . Eb5 | . F5 - B4 | C5 - - - | . . . .',
          'Ab5 - . G5 | . F5 - Eb5 | G5 - . Eb5 | - C5 - .',
          'F5 - . Eb5 | . D5 - C5 | G5 - - - | . . . .',
          'F5 - G5 - | Ab5 - Bb5 - | B5 - - C6 | - G5 Ab5 -',
          'G5 - - - | . . . . | . . . . | . . . .',
          'C6 - . Bb5 | . Ab5 - G5 | Bb5 - . Ab5 | - G5 F5 -',
          'F5 - . G5 | . Ab5 - Bb5 | D6 - - - | . . C6 Bb5',
          'B5 - . C6 | . D6 - G5 | Eb6 - - D6 | - C6 Bb5 -',
          'Ab5 - . G5 | . F5 - Eb5 | D5 - - - | . . . .',
          'F5 - G5 - | Ab5 - C6 - | D6 - . C6 | - A5 F#5 -',
          'G5 - A5 - | Bb5 - C6 - | D6 - - - | Eb6 - D6 -',
          'C6 - - B5 | - G5 Ab5 - | G5 - - - | . . . .',
          '. . . . | . . . . | G5 - Ab5 - | B5 - D6 -',
        ])
      : parseBars([
          'A5 - . G5 | . E5 - D5 | E5 - . G5 | - A5 - .',
          'G5 - . F#5 | . E5 - D5 | E5 - - - | . . . .',
          'F5 - . G5 | . A5 - C6 | A5 - . G5 | - E5 - .',
          'E5 - . F#5 | . G5 - E5 | C#5 - - - | . . . .',
          'F#5 - . A5 | . B5 - C#6 | D6 - . C#6 | - B5 A5 -',
          'B5 - . A5 | . G5 - F#5 | E5 - - - | . . . .',
          'G5 - A5 - | B5 - D6 - | E6 - - D6 | - B5 A5 -',
          'A5 - - - | . . . . | . . . . | . . . .',
          'B5 - . A5 | . G5 - F#5 | A5 - . B5 | - C#6 - .',
          'C#6 - . B5 | . A5 - G5 | A5 - - - | . . B5 C#6',
          'D6 - . C#6 | . B5 - A5 | B5 - D6 - | F#6 - - -',
          'E6 - - D6 | - B5 A5 - | G5 - - - | . . . .',
          'A5 - B5 - | C6 - E6 - | G6 - - E6 | - C6 A5 -',
          'B5 - C#6 - | D6 - E6 - | F#6 - - - | E6 - D6 -',
          'E6 - - D6 | - B5 A5 - | B5 - - - | . . . .',
          '. . . . | . . . . | A5 - B5 - | C#6 - E6 -',
        ]);
    const arpIdx = isHakkei ? [0, 2, 1, 3, 2, 3, 1, 2] : [0, 1, 2, 3, 1, 2, 3, 2];
    let prevM = 0;
    startSequencer(isHakkei ? 130 : 126, 0.04, 256, (s, t0, stepSec) => {
      const bar = Math.floor(s / 16), sub = s % 16, sec = bar >= 8 ? 1 : 0;
      const ch = chords[bar];
      // 秒針と鼓動を感じさせる16分クリスタルEPシーケンス
      if (sub % 2 === 0 || (sec === 1 && sub % 4 === 3)) {
        const af = ch.notes[arpIdx[(sub >> 1) % 8] % ch.notes.length] * 2;
        playEPiano([af], t0, 1.5 * stepSec, sub % 4 === 0 ? 0.68 : 0.44, (sub % 4 === 0 ? -0.3 : 0.3), true);
      }
      // ギター・ミュートカッティング
      if (isHakkei && (sub === 2 || sub === 6 || sub === 11 || sub === 14)) {
        playGuitar(ch.notes.slice(0, 3), t0, stepSec, 0.65, true, 0.35);
      }
      // 緊張感を持続させるストリングスパッド
      if (sub === 0) {
        playStrings(ch.notes, t0, 15.4 * stepSec, sec === 1 ? 0.72 : 0.54, true);
      }
      // タイトなシンコペーション・パルスベース
      if (sub === 0 || sub === 3 || sub === 6 || sub === 8 || sub === 10 || sub === 14) {
        const bf = sub === 14 ? ch.bass * 2 : sub === 10 ? ch.bass * 1.5 : ch.bass;
        playBass(bf, t0, (sub === 0 || sub === 8 ? 2.4 : 1.4) * stepSec, sub % 8 === 0 ? 0.92 : 0.72, isHakkei ? 'slap' : 'fusion');
      }
      // タクティカル・リードモチーフ
      const m = mel[s];
      if (m > 0) {
        const hLen = heldSteps(mel, s) * stepSec * 0.92;
        const mf = m2f(m);
        playLead(mf, prevM, t0, hLen, 0.84, isHakkei ? 'fusion' : 'ewi', 0.08);
        prevM = mf;
      }
      // クロノメーターのような精密なドラムグルーヴ
      if (sub === 0 || sub === 10 || (isHakkei && sub === 6)) playKick(t0, sub === 0 ? 0.88 : 0.66);
      if (sub === 4 || sub === 12) playSnare(t0, 0.76, !isHakkei && sec === 0);
      playHat(t0, sub % 4 === 0 ? 0.72 : sub % 2 === 0 ? 0.46 : 0.28, sub === 14, 0.25);
    });
  } else if (mode === 'race_enoshima') {
    // 4) 江の島レース中BGM: "Shonan Breeze Lounge" (104 BPM, 32小節=512ステップ)
    // 海と風の音に溶け込む、落ち着いた上質メロウ・コースタルジャズ＆フェンダーローズ・ラウンジ
    const chords = [
      // Section A (Bars 1-8: 穏やかな相模湾の潮風 — Dmaj9 -> Bm11 -> Em9 -> A13sus4)
      chordSpec('D2', 'F#4 A4 C#5 E5'), chordSpec('B1', 'F#4 A4 D5 E5'),
      chordSpec('E2', 'G4 B4 D5 F#5'),  chordSpec('A1', 'E4 G4 B4 D5'),
      chordSpec('F#2', 'E4 A4 C#5 E5'), chordSpec('B1', 'F#4 A4 C5 D#5'),
      chordSpec('E2', 'G4 B4 D5 F#5'),  chordSpec('A1', 'E4 G4 B4 C#5'),
      // Section B (Bars 9-16: 陽光を映す緩やかなうねり — Gmaj9 -> F#m11 -> Em9 -> Dmaj9)
      chordSpec('G2', 'F#4 A4 B4 D5'),  chordSpec('F#2', 'E4 A4 B4 C#5'),
      chordSpec('E2', 'G4 B4 D5 F#5'),  chordSpec('A1', 'E4 G4 B4 D5'),
      chordSpec('D2', 'F#4 A4 C#5 E5'), chordSpec('C2', 'E4 G4 B4 D5'),
      chordSpec('B1', 'F#4 A4 D5 E5'),  chordSpec('E2', 'G#4 B4 D5 F#5'),
      // Section C (Bars 17-24: 水平線へ抜ける透明なフロー — Amaj9 -> F#m11 -> Dmaj9 -> E13sus4)
      chordSpec('A1', 'E4 G#4 B4 C#5'), chordSpec('F#2', 'E4 A4 C#5 E5'),
      chordSpec('D2', 'F#4 A4 C#5 E5'), chordSpec('E2', 'G4 B4 D5 F#5'),
      chordSpec('C#2', 'E4 G#4 B4 E5'), chordSpec('F#2', 'E4 A4 C#5 E5'),
      chordSpec('B1', 'F#4 A4 D5 F#5'), chordSpec('E2', 'A4 B4 D5 F#5'),
      // Section D (Bars 25-32: 余韻と静かなグルーヴの帰還)
      chordSpec('G2', 'F#4 A4 B4 D5'),  chordSpec('G2', 'F4 A4 B4 D5'),
      chordSpec('F#2', 'E4 A4 C#5 E5'), chordSpec('B1', 'F#4 A4 D5 E5'),
      chordSpec('E2', 'G4 B4 D5 F#5'),  chordSpec('G2', 'F4 A#4 D5 E5'),
      chordSpec('D2', 'F#4 A4 C#5 E5'), chordSpec('A1', 'E4 G4 B4 C#5'),
    ];
    // 余白をたっぷり取った控えめで叙情的なフルート＆ヴィブラフォン・モチーフ
    const mel = parseBars([
      // Section A (Bars 1-8)
      'A5 - - - | F#5 - E5 - | . . . . | . . . .',
      'G5 - - F#5 | - D5 - - | E5 - - - | . . . .',
      'A5 - - B5 | - C#6 - A5 | - F#5 - - | . . . .',
      'G5 - - F#5 | - E5 - D5 | E5 - - - | . . . .',
      // Section B (Bars 9-16)
      '. . F#5 - | A5 - B5 - | A5 - - - | . . . .',
      'G5 - - F#5 | - E5 - - | . . . . | . . D5 E5',
      'F#5 - - A5 | - G5 - E5 | - . . . | . . . .',
      'F#5 - - E5 | - D5 - B4 | E5 - - - | . . . .',
      // Section C (Bars 17-24)
      'C#6 - - B5 | - A5 - - | . . . . | . . E5 F#5',
      'A5 - - B5 | - G5 - F#5 | - E5 - - | . . . .',
      'G#5 - - A5 | - B5 - C#6 | - A5 - - | . . . .',
      'F#5 - - A5 | - B5 - - | A5 - - - | . . . .',
      // Section D (Bars 25-32)
      'B5 - - A5 | - F#5 - - | G5 - - F#5 | - D5 - -',
      'E5 - - F#5 | - A5 - - | . . . . | . . . .',
      'G5 - - F#5 | - E5 - D5 | E5 - - - | . . . .',
      'F#5 - - - | E5 - - - | . . . . | . . . .',
    ]);
    const vibeNotes = [0, 2, 3, 1, 3, 2, 0, 1];
    let prevM = 0;
    startSequencer(104, 0.11, 512, (s, t0, stepSec) => {
      const bar = Math.floor(s / 16), sub = s % 16, sec = Math.floor(bar / 8);
      const ch = chords[bar];

      // 温かく丸みのあるFMフェンダーローズ (耳に刺さらないソフトなボイシング)
      if (sub === 0 || sub === 10 || (bar % 2 === 1 && sub === 6)) {
        const durSteps = sub === 0 ? 8.5 : (sub === 10 ? 5.2 : 3.2);
        const vel = sub === 0 ? 0.72 : 0.50;
        playEPiano(ch.notes, t0, durSteps * stepSec, vel, -0.20, false);
      }
      // 控えめなアコースティック/クリーンギターの柔らかい裏拍コード
      if (sub === 6 || (bar % 2 === 0 && sub === 14)) {
        playGuitar(ch.notes, t0, 2.4 * stepSec, sub === 6 ? 0.42 : 0.32, true, 0.30);
      }
      // Section B・Cのみ: 遠くの水平線のように淡く広がるソフト・ストリングスパッド
      if ((sec === 1 || sec === 2) && bar % 2 === 0 && sub === 0) {
        playStrings(ch.notes, t0, 31.0 * stepSec, sec === 2 ? 0.48 : 0.38, true);
      }
      // 水面の光を思わせる控えめなヴィブラフォンの一雫
      if ((sub === 4 && bar % 2 === 0) || (sub === 12 && sec >= 1 && bar % 2 === 1)) {
        const bf = ch.notes[vibeNotes[(bar + (sub >> 2)) % 8] % ch.notes.length] * 2;
        playBell(bf, t0, 3.4 * stepSec, 0.26, 0.26);
      }
      // 深く落ち着いたウォーム・エレキベース (音数を絞ってゆったり支える)
      if (sub === 0) playBass(ch.bass, t0, 6.2 * stepSec, 0.80, 'warm');
      else if (sub === 8) playBass(ch.bass * 1.5, t0, 4.2 * stepSec, 0.60, 'warm');
      else if (sub === 14 && bar % 2 === 1) playBass(ch.bass * 2, t0, 1.8 * stepSec, 0.50, 'warm');

      // 余白を活かした穏やかなエアリー・フルートモチーフ
      const m = mel[s];
      if (m > 0) {
        const hLen = heldSteps(mel, s) * stepSec * 0.94;
        const mf = m2f(m);
        playLead(mf, prevM, t0, hLen, sec === 2 ? 0.56 : 0.50, 'flute', 0.06);
        prevM = mf;
      }

      // 落ち着いたクロススティック(リム)＆ソフトブラシ風ポケットグルーヴ
      if (sub === 0 || sub === 10) playKick(t0, sub === 0 ? 0.66 : 0.46);
      if (sub === 4 || sub === 12) playSnare(t0, 0.54, true);
      if (sub % 2 === 0 || sub === 15) {
        playHat(t0, sub % 4 === 0 ? 0.42 : 0.24, sub === 14 && bar % 4 === 3, 0.22);
      }
    });
  } else if (mode === 'race_hakkeijima') {
    // 5) 八景島レース中BGM: "Kanazawa Bay Cool Rhodes" (108 BPM, 32小節=512ステップ)
    // 洗練されたクール＆メロウなアーバン・エレクトリックジャズ・ラウンジ (落ち着きのある大人のベイサイドグルーヴ)
    const chords = [
      // Section A (Bars 1-8: クールな東京湾の潮風 — Fm9 -> Bb13 -> Ebmaj9 -> Abmaj7#11)
      chordSpec('F2', 'Eb4 G4 Ab4 C5'), chordSpec('Bb1', 'D4 F4 Ab4 C5'),
      chordSpec('Eb2', 'D4 G4 Bb4 D5'), chordSpec('Ab1', 'Eb4 G4 C5 D5'),
      chordSpec('D2', 'F4 Ab4 C5 Eb5'), chordSpec('G1', 'F4 B4 D5 Ab5'),
      chordSpec('C2', 'Eb4 G4 Bb4 D5'), chordSpec('C2', 'E4 G4 Bb4 D5'),
      // Section B (Bars 9-16: 静かな集中とタクティカル・フロウ)
      chordSpec('F2', 'Eb4 G4 Ab4 C5'), chordSpec('D2', 'F4 Ab4 C5 Eb5'),
      chordSpec('G1', 'F4 Bb4 D5 F5'),  chordSpec('C2', 'E4 G4 Bb4 D5'),
      chordSpec('Ab1', 'Eb4 G4 C5 Eb5'), chordSpec('Bb1', 'D4 F4 Ab4 C5'),
      chordSpec('G1', 'F4 Bb4 D5 F5'),  chordSpec('C2', 'E4 G4 Bb4 Db5'),
      // Section C (Bars 17-24: 都会の海面に広がるメロウ・ハーモニー)
      chordSpec('Db2', 'F4 Ab4 C5 Eb5'), chordSpec('Eb2', 'F4 G4 Bb4 D5'),
      chordSpec('C2', 'Eb4 G4 Bb4 D5'),  chordSpec('F2', 'Eb4 Ab4 C5 Eb5'),
      chordSpec('Bb1', 'D4 F4 Ab4 C5'),  chordSpec('C2', 'E4 G4 Bb4 D5'),
      chordSpec('F2', 'Eb4 G4 Ab4 C5'),  chordSpec('E2', 'D4 G#4 B4 D5'),
      // Section D (Bars 25-32: クールダウン・ターンアラウンド)
      chordSpec('Ab1', 'Eb4 G4 C5 D5'), chordSpec('G1', 'F4 B4 D5 G5'),
      chordSpec('C2', 'Eb4 G4 Bb4 D5'), chordSpec('Bb1', 'D4 F4 Ab4 C5'),
      chordSpec('A1', 'E4 G4 C5 D5'),   chordSpec('Ab1', 'Eb4 F#4 C5 Eb5'),
      chordSpec('G1', 'F4 Bb4 D5 F5'),  chordSpec('C2', 'E4 G4 Bb4 D5'),
    ];
    const mel = parseBars([
      // Section A (Bars 1-8)
      'C6 - - Bb5 | - Ab5 - G5 | . . . . | . . . .',
      'Bb5 - - G5 | - F5 - Eb5 | - . . . | . . . .',
      'Ab5 - - G5 | - F5 - - | B5 - - G5 | - . . .',
      'Bb5 - - G5 | - Eb5 - - | E5 - - - | . . . .',
      // Section B (Bars 9-16)
      '. . G5 Ab5 | C6 - Bb5 - | Ab5 - - - | . . . .',
      'Bb5 - - A5 | - G5 - E5 | - . . . | . . . .',
      'C6 - - Bb5 | - Ab5 - F5 | - . . . | . . . .',
      'Bb5 - - G5 | - F5 - E5 | - . . . | . . . .',
      // Section C (Bars 17-24)
      'C6 - - Eb6 | - D6 - Bb5 | - . . . | . . . .',
      'Bb5 - - G5 | - Ab5 - C6 | - . . . | . . . .',
      'Ab5 - - F5 | - G5 - Bb5 | - E5 - - | . . . .',
      'G5 - - Ab5 | - G5 - - | G#5 - - - | . . . .',
      // Section D (Bars 25-32)
      'C6 - - B5 | - G5 - - | Bb5 - - G5 | - F5 - -',
      'G5 - - E5 | - Eb5 - - | . . . . | . . . .',
      'F5 - - G5 | - Bb5 - - | E5 - - - | . . . .',
      '. . . . | . . . . | . . . . | . . . .',
    ]);
    const coolVibe = [0, 3, 2, 1, 2, 3, 1, 0];
    let prevM = 0;
    startSequencer(108, 0.13, 512, (s, t0, stepSec) => {
      const bar = Math.floor(s / 16), sub = s % 16, sec = Math.floor(bar / 8);
      const ch = chords[bar];

      // 艶やかで落ち着いたフェンダーローズ・ボイシング
      if (sub === 0 || sub === 10 || (sub === 6 && bar % 2 === 0)) {
        const durSteps = sub === 0 ? 7.5 : (sub === 10 ? 5.0 : 2.8);
        playEPiano(ch.notes, t0, durSteps * stepSec, sub === 0 ? 0.70 : 0.48, -0.22, false);
      }
      // さりげないミュート・ジャズギターのポケットアクセント
      if (sub === 6 || sub === 14) {
        playGuitar(ch.notes, t0, 1.4 * stepSec, sub === 6 ? 0.38 : 0.30, true, 0.32);
      }
      // Section C・Dのみ: 薄く上品なトワイライト・ストリングスパッド
      if (sec >= 2 && bar % 2 === 0 && sub === 0) {
        playStrings(ch.notes, t0, 31.0 * stepSec, 0.44, true);
      }
      // クールなヴィブラフォンのスパース・コードトーン
      if ((sub === 4 && bar % 2 === 1) || (sub === 12 && sec >= 1 && bar % 2 === 0)) {
        const bf = ch.notes[coolVibe[(bar + (sub >> 2)) % 8] % ch.notes.length] * 2;
        playBell(bf, t0, 3.0 * stepSec, 0.25, 0.24);
      }
      // 落ち着いたディープ・フィンガーベース (スラップを廃し丸くタイトな低音に)
      if (sub === 0) playBass(ch.bass, t0, 5.2 * stepSec, 0.82, 'warm');
      else if (sub === 6 && bar % 2 === 0) playBass(ch.bass * 1.5, t0, 2.4 * stepSec, 0.56, 'warm');
      else if (sub === 10) playBass(ch.bass, t0, 3.8 * stepSec, 0.68, 'warm');
      else if (sub === 14 && bar % 2 === 1) playBass(ch.bass * 2, t0, 1.6 * stepSec, 0.48, 'warm');

      // 控えめでクールなフルート＆ソフトベル・モチーフ (余白重視)
      const m = mel[s];
      if (m > 0) {
        const hLen = heldSteps(mel, s) * stepSec * 0.94;
        const mf = m2f(m);
        playLead(mf, prevM, t0, hLen, 0.50, 'flute', 0.05);
        if (sec === 2 && sub === 0) playBell(mf, t0, Math.min(0.45, hLen), 0.22, -0.18);
        prevM = mf;
      }

      // 抑えめで心地よいアーバン・ラウンジビート (リムショット主体)
      if (sub === 0 || sub === 10 || (sub === 6 && bar % 4 === 2)) playKick(t0, sub === 0 ? 0.68 : 0.48);
      if (sub === 4 || sub === 12) playSnare(t0, 0.56, true);
      playHat(t0, sub % 4 === 0 ? 0.40 : sub % 2 === 0 ? 0.24 : 0.14, sub === 14 && bar % 4 === 1, 0.22);
    });
  } else if (mode === 'result') {
    // 6) リザルト画面BGM: "Grand Regatta Podium" (122 BPM, 16小節=256ステップ, 祝祭ブラス＆シンフォニック・ウイニングアンセム)
    const chords = [
      // Section A (Bars 1-8)
      chordSpec('F2', 'A4 C5 E5 G5'),   chordSpec('G2', 'B4 D5 F5 A5'),
      chordSpec('E2', 'G4 B4 D5 F#5'),  chordSpec('A2', 'G4 C5 E5 G5'),
      chordSpec('D2', 'F4 A4 C5 E5'),   chordSpec('G2', 'F4 B4 D5 E5'),
      chordSpec('C2', 'E4 G4 B4 D5'),   chordSpec('C2', 'E4 G4 Bb4 D5'),
      // Section B (Bars 9-16: ドラマチック転調クライマックス！)
      chordSpec('Ab1', 'Eb4 Ab4 C5 Eb5'), chordSpec('Bb1', 'F4 Bb4 D5 F5'),
      chordSpec('G1', 'F4 B4 D5 G5'),     chordSpec('C2', 'Eb4 G4 Bb4 D5'),
      chordSpec('D2', 'F4 A4 C5 E5'),     chordSpec('E2', 'G#4 B4 D5 E5'),
      chordSpec('F2', 'A4 C5 E5 G5'),     chordSpec('G2', 'A4 C5 D5 G5'),
    ];
    const mel = parseBars([
      // Section A
      'E5 - G5 A5 | - C6 - B5 | - G5 - E5 | D5 - G5 -',
      'B5 - - A5 | - G5 E5 - | A5 - B5 C6 | - E6 - .',
      'D6 - - C6 | - A5 F5 - | G5 - A5 B5 | - D6 E6 -',
      'C6 - - - | G5 - E5 - | G5 - - - | . . E5 G5',
      'A5 - - C6 | - E6 - D6 | - B5 - G5 | A5 - B5 -',
      'G5 - - B5 | - D6 - E6 | - D6 - B5 | G5 - - .',
      'E6 - - D6 | - C6 B5 - | A5 - G5 E5 | - G5 C6 -',
      'D6 - - - | E6 - C6 - | D6 - - - | . . C6 D6',
      // Section B
      'Eb6 - - D6 | - C6 Ab5 - | C6 - Eb6 - | F6 - - -',
      'F6 - - Eb6 | - D6 Bb5 - | D6 - F6 - | G6 - - -',
      'G6 - - F6 | - D6 B5 - | G5 - B5 D6 | - F6 E6 -',
      'Eb6 - - D6 | - C6 G5 - | C6 - - - | . . B5 C6',
      'D6 - - C6 | - A5 F5 - | A5 - C6 D6 | - E6 - .',
      'E6 - - D6 | - B5 G#5 - | B5 - D6 E6 | - F#6 - .',
      'G6 - - E6 | - C6 A5 - | C6 - E6 G6 | - A6 - .',
      'G6 - - - | F6 - D6 - | G6 - - - | . . . .',
    ]);
    const glockArp = [0, 1, 2, 3, 2, 3, 1, 3];
    let prevM = 0;
    startSequencer(122, 0.05, 256, (s, t0, stepSec) => {
      const bar = Math.floor(s / 16), sub = s % 16, sec = bar >= 8 ? 1 : 0;
      const ch = chords[bar];
      if (s === 0 || s === 128) playCrash(t0, 0.90);
      // 華やかな祝祭ブラス＆FMローズ・アンサンブル
      if (sub === 0 || sub === 6 || sub === 12) {
        playEPiano(ch.notes, t0, (sub === 0 ? 5.0 : 2.8) * stepSec, 0.86, -0.24, true);
        if (sub === 0 || sub === 12) playBrass(ch.notes, t0, (sub === 0 ? 4.0 : 2.2) * stepSec, sec === 1 ? 0.85 : 0.70, -0.20);
      }
      if (sub === 0) playStrings(ch.notes, t0, 15.5 * stepSec, sec === 1 ? 0.90 : 0.74, true);
      // キラキラと降り注ぐグロッケンシュピール・ベル
      if (sub % 2 === 0) {
        const bf = ch.notes[glockArp[(sub >> 1) % 8] % ch.notes.length] * 2;
        playBell(bf, t0, 2.2 * stepSec, 0.44, 0.32);
      }
      if (sub === 0) playBass(ch.bass, t0, 4.5 * stepSec, 0.96, 'fusion');
      else if (sub === 6) playBass(ch.bass * 1.5, t0, 1.8 * stepSec, 0.74, 'fusion');
      else if (sub === 8) playBass(ch.bass, t0, 4.0 * stepSec, 0.88, 'fusion');
      else if (sub === 14) playBass(ch.bass * 2, t0, 1.8 * stepSec, 0.78, 'fusion');

      const m = mel[s];
      if (m > 0) {
        const hLen = heldSteps(mel, s) * stepSec * 0.94;
        const mf = m2f(m);
        playLead(mf, prevM, t0, hLen, 0.95, 'ewi', 0.05);
        playBell(mf, t0, Math.min(0.40, hLen), 0.42, -0.18);
        prevM = mf;
      }
      const isFill = (bar === 7 || bar === 15) && sub >= 10;
      if (isFill) {
        playTom(t0, sub < 12 ? 220 : sub < 14 ? 168 : 120, 0.88, ((sub - 10) / 5) * 0.9 - 0.45);
        if (sub === 12 || sub === 15) playSnare(t0, 0.86, false);
      } else {
        if (sub === 0 || sub === 6 || sub === 8 || sub === 10) playKick(t0, sub === 0 ? 0.90 : 0.68);
        if (sub === 4 || sub === 12) playSnare(t0, 0.84, false);
        playHat(t0, sub % 4 === 0 ? 0.70 : sub % 2 === 0 ? 0.48 : 0.26, sub === 14, 0.24);
      }
    });
  } else if (mode === 'review') {
    // 7) 振り返り画面BGM: "Afterglow Tactical Lounge" (96 BPM, 16小節=256ステップ, グランツーリスモ・リプレイ風メロウ・ローズ＆ジャズラウンジ)
    const chords = [
      chordSpec('A1', 'G4 B4 C5 E5'),   chordSpec('F2', 'A4 C5 E5 G5'),
      chordSpec('D2', 'F4 A4 C5 E5'),   chordSpec('E2', 'G#4 B4 D5 G5'),
      chordSpec('A1', 'G4 B4 C5 E5'),   chordSpec('C2', 'E4 G4 Bb4 D5'),
      chordSpec('F2', 'A4 C5 E5 G5'),   chordSpec('E2', 'G#4 C5 D5 G5'),
      chordSpec('D2', 'F4 A4 C5 E5'),   chordSpec('G2', 'F4 A4 B4 E5'),
      chordSpec('E2', 'G4 B4 D5 F#5'),  chordSpec('A2', 'G4 B4 C#5 E5'),
      chordSpec('D2', 'F4 A4 C5 E5'),   chordSpec('F2', 'A4 C5 Eb5 G5'),
      chordSpec('E2', 'A4 B4 D5 E5'),   chordSpec('E2', 'G#4 B4 D5 F5'),
    ];
    const mel = parseBars([
      'E5 - - - | G5 - E5 - | C5 - - - | . . B4 C5',
      'E5 - - G5 | - A5 G5 - | E5 - - - | . . . .',
      'F5 - - E5 | - D5 C5 - | A4 - C5 E5 | - G5 - .',
      'G#5 - - E5 | - D5 B4 - | E5 - - - | . . . .',
      'B5 - - A5 | - G5 E5 - | G5 - - - | . . E5 G5',
      'Bb5 - - A5 | - G5 E5 - | D5 - - - | . . C5 D5',
      'E5 - G5 A5 | - C6 - B5 | - A5 - G5 | E5 - - .',
      'G#5 - - A5 | - B5 - E5 | - . . . | . . . .',
      'A5 - - G5 | - F5 E5 - | D5 - F5 A5 | - C6 - .',
      'B5 - - A5 | - G5 F5 - | E5 - - - | . . E5 F#5',
      'G5 - - B5 | - D6 - C#6 | - B5 - A5 | G5 - - .',
      'G5 - - F#5 | - E5 C#5 - | E5 - - - | . . D5 E5',
      'F5 - - A5 | - C6 - B5 | - A5 - F5 | E5 - - .',
      'Eb6 - - D6 | - C6 A5 - | C6 - - - | . . B5 A5',
      'B5 - - - | A5 - E5 - | A5 - - - | G#5 - - -',
      'E5 - - - | . . . . | . . . . | . . . .',
    ]);
    const loungeArp = [0, 2, 3, 1, 3, 2, 1, 2];
    let prevM = 0;
    startSequencer(96, 0.16, 256, (s, t0, stepSec) => {
      const bar = Math.floor(s / 16), sub = s % 16;
      const ch = chords[bar];
      // ベルベットのように温かいFMフェンダーローズのジャズコード
      if (sub === 0 || sub === 10) {
        playEPiano(ch.notes, t0, (sub === 0 ? 10.5 : 5.5) * stepSec, sub === 0 ? 0.88 : 0.62, -0.22, false);
      }
      if (bar >= 8 && sub === 0) {
        playStrings(ch.notes, t0, 15.6 * stepSec, 0.62, true);
      }
      // 思考を邪魔しない繊細なヴィブラフォンの水滴アルペジオ
      if (sub === 4 || sub === 12 || (bar % 2 === 1 && sub === 14)) {
        const bf = ch.notes[loungeArp[(sub >> 1) % 8] % ch.notes.length] * 2;
        playBell(bf, t0, 3.6 * stepSec, 0.36, 0.28);
      }
      // 深いフレットレス風ウォームベース
      if (sub === 0) playBass(ch.bass, t0, 7.2 * stepSec, 0.92, 'warm');
      else if (sub === 8) playBass(ch.bass * 1.5, t0, 5.0 * stepSec, 0.72, 'warm');
      else if (sub === 14) playBass(ch.bass * 2, t0, 2.0 * stepSec, 0.62, 'warm');

      // 夕凪のサックス/フルート風メロウ・リード
      const m = mel[s];
      if (m > 0) {
        const hLen = heldSteps(mel, s) * stepSec * 0.95;
        const mf = m2f(m);
        playLead(mf, prevM, t0, hLen, 0.80, 'flute', 0.06);
        prevM = mf;
      }
      // 控えめで心地よいラウンジ・ブラシビート
      if (sub === 0 || sub === 10) playKick(t0, sub === 0 ? 0.72 : 0.50);
      if (sub === 4 || sub === 12) playSnare(t0, 0.62, true);
      if (sub % 2 === 0 || sub === 15) playHat(t0, sub % 4 === 0 ? 0.52 : 0.30, sub === 14, 0.22);
    });
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
  out.gain.value = 0.48;
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
    g.gain.linearRampToValueAtTime(0.30, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
    s.connect(bp); bp.connect(g); g.connect(master);
    s.start(t0, Math.random() * 0.5); s.stop(t0 + 0.36);
  }
  const sub = ctx.createOscillator(), sg = ctx.createGain();
  sub.type = 'triangle';
  sub.frequency.setValueAtTime(190, t0 + 0.05);
  sub.frequency.exponentialRampToValueAtTime(42, t0 + 0.38);
  sg.gain.setValueAtTime(0.0001, t0 + 0.05);
  sg.gain.linearRampToValueAtTime(0.34, t0 + 0.062);
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
      og.gain.linearRampToValueAtTime(0.065, t0 + ch.dt + i * 0.006 + 0.015);
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




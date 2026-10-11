// リアルなヨットオーディオ(WebAudio)
//  - 号砲/1分前ホーン: エアホーン(倍音・息継ぎ・残響)
//  - 船が水を切る音: 船体を流れる水の「シャー」+ バウウェーブの低いうねり + 気泡のポコポコ + 波打ち(スラップ)
//  - セールのシバー: 連続的なバタバタ音 + タック時のパンッ
//  - 他艇が近づくと相手の波切り音が大きく・左右定位つきで聞こえる
let ctx = null, master = null, fx = null, windGain = null, muted = false, noiseBuf = null;
let boatBus = null, hissGain = null, rushGain = null, rushFilter = null, swellGain = null;
let shiverGain = null, shiverLfo = null;
let nearGain = null, nearFilter = null, nearPan = null;
let camMul = 1, tBubble = 0, tSlap = 0, tShiver = 0;

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

    // ノイズ素材: 白色 / ブラウン(風用)
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

    // 船体を流れる水のシャー(高域) — うねりでゆっくり揺れる
    const hsrc = loopSource(noiseBuf, 0.9);
    const hhp = ctx.createBiquadFilter(); hhp.type = 'highpass'; hhp.frequency.value = 1500;
    const hlp = ctx.createBiquadFilter(); hlp.type = 'lowpass'; hlp.frequency.value = 7500;
    swellGain = ctx.createGain(); swellGain.gain.value = 0.75;
    const swell = ctx.createOscillator(); swell.frequency.value = 0.31;
    const swellAmp = ctx.createGain(); swellAmp.gain.value = 0.25; swell.connect(swellAmp); swellAmp.connect(swellGain.gain); swell.start();
    hissGain = ctx.createGain(); hissGain.gain.value = 0;
    hsrc.connect(hhp); hhp.connect(hlp); hlp.connect(swellGain); swellGain.connect(hissGain); hissGain.connect(boatBus);

    // バウウェーブ/ハルのゴォーッという中低域
    const rsrc = loopSource(brown, 1.7);
    rushFilter = ctx.createBiquadFilter(); rushFilter.type = 'bandpass'; rushFilter.frequency.value = 450; rushFilter.Q.value = 0.9;
    rushGain = ctx.createGain(); rushGain.gain.value = 0;
    rsrc.connect(rushFilter); rushFilter.connect(rushGain); rushGain.connect(boatBus);

    // セールのシバー(連続したバタバタ): 鋸波LFOで「パッ・パッ」と立ち上がる
    const ssrc = loopSource(noiseBuf, 1.15);
    const sbp = ctx.createBiquadFilter(); sbp.type = 'bandpass'; sbp.frequency.value = 1250; sbp.Q.value = 0.7;
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
export function setCameraAudio(cockpit) { camMul = cockpit ? 1.0 : 0.38; }
export function toggleMute() { muted = !muted; if (master) master.gain.value = muted ? 0 : 0.62; return muted; }

// ---- 艇の連続音(毎フレーム) ----
function bubble(sp) {
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  const f = 240 + Math.random() * 760;
  o.type = 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * (1.5 + Math.random() * 1.2), t + 0.05);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.035 * sp + 0.005, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
  o.connect(g); g.connect(boatBus); o.start(t); o.stop(t + 0.1);
}
function waveSlap(sp, heel) {
  const t = ctx.currentTime, s = ctx.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 0.7 + Math.random() * 0.6;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 1.2;
  f.frequency.setValueAtTime(1400 + Math.random() * 800, t); f.frequency.exponentialRampToValueAtTime(220, t + 0.38);
  const g = ctx.createGain(); const vol = (0.10 + 0.26 * sp) * (1 + heel * 1.5);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
  s.connect(f); f.connect(g); g.connect(boatBus); s.start(t, Math.random() * 1.0); s.stop(t + 0.5);
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.25);
  og.gain.setValueAtTime(0.0001, t); og.gain.linearRampToValueAtTime(0.16 * sp, t + 0.01); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  o.connect(og); og.connect(boatBus); o.start(t); o.stop(t + 0.35);
}
// active=false(一時停止/メニュー)で無音。b は自艇。
export function updateSailingAudio(dt, b, active = true) {
  if (!ctx || !hissGain) return;
  const now = ctx.currentTime;
  boatBus.gain.setTargetAtTime(active ? camMul : 0, now, 0.25);
  const v = active && b ? b.v : 0;
  const sp = clamp01(v / 8);
  const heel = active && b ? Math.min(0.4, Math.abs(b.heel)) : 0;
  hissGain.gain.setTargetAtTime((0.01 + 0.34 * Math.pow(sp, 1.4)) * (1 + heel * 2.4), now, 0.12);
  rushGain.gain.setTargetAtTime(0.02 + 0.30 * sp, now, 0.2);
  rushFilter.frequency.setTargetAtTime(320 + sp * 900, now, 0.2);
  // シバー
  const luff = active && b ? clamp01(b.luff) : 0;
  const lv = luff > 0.12 ? luff : 0;
  shiverGain.gain.setTargetAtTime(0.5 * lv * 0.34, now, 0.05);
  shiverGain._amp.gain.setTargetAtTime(0.5 * lv * 0.34, now, 0.05);
  tShiver -= dt;
  if (tShiver <= 0) { tShiver = 0.11; shiverLfo.frequency.setValueAtTime(7 + Math.random() * 8, now); }
  if (!active) return;
  tBubble -= dt;
  if (tBubble <= 0 && sp > 0.08) { tBubble = (0.06 + Math.random() * 0.16) / (0.4 + sp * 1.8); bubble(sp); }
  tSlap -= dt;
  if (tSlap <= 0 && sp > 0.15) { tSlap = (0.35 + Math.random() * 0.9) / (0.35 + sp * 1.3); waveSlap(sp, heel); }
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

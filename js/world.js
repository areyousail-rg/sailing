// 江の島沖 / 八景島沖の世界: 海・空・島・海岸・ランドマーク・マーク・航跡
import * as THREE from 'three';
import { MARKS, LEGS, COURSE_MODE, toWorld, LINE_HALF, LINE_SKEW, FAVORED, lineA, U, W0, setWindDir } from './course.js';
import { makeMotorboat } from './powerboats.js';
import { buildFigure } from './crew.js';
import { shiftAt, waveSample, SEA, BASE_WIND_KT } from './sim.js';

export const FOG_COLOR = 0xbdd5e6;
export const FOG_DENSITY = 3.0e-5;
export const SUN_DIR = new THREE.Vector3(0.5, 0.55, 0.62).normalize();

// ---------- ノイズ ----------
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
let seed = 12345; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

// ---------- リアルな樹木ジオメトリ生成 (単なる多面体1個ではなく、複数の樹冠クラスター＋陰影頂点カラー＋枝分かれ幹) ----------
function mergePartGeos(parts) {
  let nv = 0, ni = 0;
  for (const g of parts) {
    nv += g.attributes.position.count;
    ni += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const g of parts) {
    const P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color, I = g.index;
    for (let i = 0; i < P.count; i++) {
      const k = (vo + i) * 3;
      pos[k] = P.getX(i); pos[k + 1] = P.getY(i); pos[k + 2] = P.getZ(i);
      nor[k] = N ? N.getX(i) : 0; nor[k + 1] = N ? N.getY(i) : 1; nor[k + 2] = N ? N.getZ(i) : 0;
      col[k] = C ? C.getX(i) : 1; col[k + 1] = C ? C.getY(i) : 1; col[k + 2] = C ? C.getZ(i) : 1;
    }
    const n = I ? I.count : P.count;
    for (let i = 0; i < n; i++) idx[io++] = vo + (I ? I.getX(i) : i);
    vo += P.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// 1) 広葉樹(ケヤキ・クスノキ等): 7つの葉塊(クラウン)が重なり、上部は陽が当たって明るく下部は葉陰で締まる自然な樹冠
let _broadCrownGeo = null, _pineCrownGeo = null, _treeTrunkGeo = null;
function getBroadTreeCrownGeo() {
  if (_broadCrownGeo) return _broadCrownGeo;
  const blobs = [
    [0, 0.34, 0, 0.62, 0.50, 0.62],
    [-0.38, 0.04, 0.24, 0.50, 0.40, 0.48],
    [0.40, 0.06, 0.20, 0.48, 0.39, 0.48],
    [0.05, 0.08, -0.40, 0.52, 0.42, 0.48],
    [-0.28, -0.10, -0.28, 0.46, 0.36, 0.45],
    [0.32, -0.08, -0.26, 0.45, 0.36, 0.45],
    [0.0, -0.06, 0.38, 0.46, 0.36, 0.44],
  ];
  const parts = [];
  for (let b = 0; b < blobs.length; b++) {
    const [bx, by, bz, sx, sy, sz] = blobs[b];
    const g = new THREE.IcosahedronGeometry(1, 1);
    const P = g.attributes.position;
    const C = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) {
      let x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const bump = 0.88 + 0.22 * Math.sin(x * 3.7 + b * 1.9) * Math.cos(z * 3.5 - b * 1.3);
      if (y < 0) y *= 0.68; // 樹冠の下側は少し平らに締める
      const px = bx + x * sx * bump;
      const py = by + y * sy * bump;
      const pz = bz + z * sz * bump;
      P.setXYZ(i, px, py, pz);
      // 樹冠の上部・外側は陽当たりで明るく、下部・内側は深い緑の陰影をつける
      const shade = clampN(0.58 + (py + 0.35) * 0.56 + (y > 0 ? 0.10 : -0.08), 0.48, 1.18);
      C[i * 3] = shade * 0.94;
      C[i * 3 + 1] = shade * 1.04;
      C[i * 3 + 2] = shade * 0.88;
    }
    g.computeVertexNormals();
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    parts.push(g);
  }
  _broadCrownGeo = mergePartGeos(parts);
  return _broadCrownGeo;
}

// 2) 海岸の黒松・防風林: 段状の枝ぶりと傘型の葉塊が重なる日本海岸らしい松の樹冠
function getPineTreeCrownGeo() {
  if (_pineCrownGeo) return _pineCrownGeo;
  const tiers = [
    [0, 0.44, 0, 0.56, 0.24, 0.56],
    [-0.32, 0.18, 0.18, 0.54, 0.22, 0.50],
    [0.34, 0.14, -0.14, 0.52, 0.22, 0.50],
    [-0.14, -0.06, -0.32, 0.58, 0.22, 0.54],
    [0.20, -0.10, 0.28, 0.56, 0.21, 0.52],
  ];
  const parts = [];
  for (let t = 0; t < tiers.length; t++) {
    const [tx, ty, tz, sx, sy, sz] = tiers[t];
    const g = new THREE.IcosahedronGeometry(1, 1);
    const P = g.attributes.position;
    const C = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) {
      let x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      if (y < 0) y *= 0.45;
      const wav = 0.90 + 0.18 * Math.cos(x * 4.1 + z * 3.3 + t);
      const px = tx + x * sx * wav;
      const py = ty + y * sy;
      const pz = tz + z * sz * wav;
      P.setXYZ(i, px, py, pz);
      const shade = clampN(0.54 + (py + 0.28) * 0.58 + (y > 0 ? 0.10 : -0.10), 0.44, 1.12);
      C[i * 3] = shade * 0.88;
      C[i * 3 + 1] = shade * 1.02;
      C[i * 3 + 2] = shade * 0.86;
    }
    g.computeVertexNormals();
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    parts.push(g);
  }
  _pineCrownGeo = mergePartGeos(parts);
  return _pineCrownGeo;
}

// 3) 樹木の主幹＋3本の枝分かれジオメトリ (根元 y=0 から樹冠内部 y=1.15 まで伸びるリアルな幹)
function getTreeTrunkGeo() {
  if (_treeTrunkGeo) return _treeTrunkGeo;
  const parts = [];
  const mainT = new THREE.CylinderGeometry(0.085, 0.165, 0.95, 7);
  mainT.translate(0, 0.475, 0);
  parts.push(mainT);
  for (const [ang, tilt, len] of [[0.4, 0.48, 0.46], [2.45, 0.52, 0.44], [4.55, 0.45, 0.42]]) {
    const br = new THREE.CylinderGeometry(0.042, 0.072, len, 5);
    br.translate(0, len / 2, 0);
    br.rotateZ(tilt);
    br.rotateY(ang);
    br.translate(0, 0.62, 0);
    parts.push(br);
  }
  for (const g of parts) {
    const P = g.attributes.position;
    const C = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) {
      const s = 0.78 + 0.22 * clampN(P.getY(i), 0, 1);
      C[i * 3] = s; C[i * 3 + 1] = s; C[i * 3 + 2] = s;
    }
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  }
  _treeTrunkGeo = mergePartGeos(parts);
  return _treeTrunkGeo;
}

// ---------- 海 ----------
const SKY_FN = `
uniform vec3 uSun;
vec3 skyBase(vec3 d){
  float h=clamp(d.y,0.0001,1.0);
  vec3 hor=vec3(0.74,0.86,0.94), zen=vec3(0.14,0.38,0.78);
  vec3 c=mix(hor,zen,pow(h,0.42));
  float s=clamp(dot(d,uSun),0.0001,1.0);
  c+=vec3(1.0,0.92,0.75)*(pow(s,600.0)*6.0+pow(s,12.0)*0.18);
  return c;
}`;
export const MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
const SEA_VS = `
uniform float uWT; uniform float uW0; uniform float uShift; uniform float uChop; uniform vec4 uSeaA[4]; uniform vec4 uSeaB[4]; uniform vec3 uPatchC; uniform float uPatchR; uniform float uBaseY; uniform vec4 uBoatPos; uniform vec4 uNearBoats[8];
varying vec3 vW; varying float vH;
void main(){
  vec4 w=modelMatrix*vec4(position,1.0);
  float h=0.0;
#ifdef PATCH
  // カメラ周辺の局所パッチでは waveSample と同じ波浪成分で頂点を上下させ、船体外側で波に沈んだり出たりする自然な海面高さを維持する
  for(int i=0;i<4;i++){
    vec4 A=uSeaA[i]; vec4 B=uSeaB[i];
    float wgt=B.z>0.5?1.24:0.86;
    if(A.w>0.001) h+=A.w*wgt*sin(A.z*dot(A.xy,w.xz)-B.x*uWT+B.y);
  }
  // 基底ベクトルは時間変化しない基準風向(uW0)に固定し、シフト変化時に遠方座標で波が横滑りする現象を完全に防止
  vec2 wdV=vec2(-sin(uW0),cos(uW0));
  vec2 wpV=vec2(-wdV.y,wdV.x);
  // 向きの異なる3つの短い風浪を交差させ、規則的な平行線状の起伏にならないようにする
  vec2 d2=wdV*0.825+wpV*0.565;
  vec2 d3=wdV*0.765-wpV*0.644;
  float vRip=(0.060*sin(dot(w.xz,wdV)*0.72-uWT*2.66+dot(w.xz,wpV)*0.16)+0.045*sin(dot(w.xz,d2)*1.18-uWT*3.40+1.1)+0.032*sin(dot(w.xz,d3)*1.63-uWT*4.00+2.3))*(1.0+0.35*uChop);
  h+=vRip;
  float r=length(w.xz-uPatchC.xz)/max(uPatchR,1.0);
  w.y=mix(h,uBaseY,smoothstep(0.70,1.0,r));
#endif
  vH=h;
  vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w;
}`;
const waterMat = new THREE.ShaderMaterial({
  defines: { NWAVE: MOBILE ? 3 : 4, NSPEC: MOBILE ? 7 : 11 },
  stencilWrite: true,
  stencilWriteMask: 0,
  stencilFunc: THREE.NotEqualStencilFunc,
  stencilRef: 1,
  stencilFail: THREE.KeepStencilOp,
  stencilZFail: THREE.KeepStencilOp,
  stencilZPass: THREE.KeepStencilOp,
  uniforms: {
    uTime: { value: 0 }, uWT: { value: 0 }, uW0: { value: W0 }, uWindKt: { value: 9.0 }, uSideBias: { value: -0.6 }, uSun: { value: SUN_DIR }, uShift: { value: 0 }, uGen: { value: 0.55 }, uChop: { value: 0.6 },
    uSeaA: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uSeaB: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uPatchC: { value: new THREE.Vector3() }, uPatchR: { value: 192 }, uBaseY: { value: 0 },
    uBoatPos: { value: new THREE.Vector4(0, -9999, -9999, 0) },
    uNearBoats: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, -9999, -9999, 0)) },
  },
  vertexShader: SEA_VS,
  fragmentShader: `
precision highp float;
varying vec3 vW; varying float vH; uniform float uTime; uniform float uWT; uniform float uW0; uniform float uWindKt; uniform float uSideBias; uniform float uShift; uniform float uGen; uniform float uChop; uniform vec4 uSeaA[4]; uniform vec4 uSeaB[4]; uniform vec4 uNearBoats[8];
${SKY_FN}
float hh(vec2 p){ p=mod(p,289.0); return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(hh(i),hh(i+vec2(1,0)),f.x),mix(hh(i+vec2(0,1)),hh(i+vec2(1,1)),f.x),f.y); }
void main(){
  vec2 p=vW.xz;
  vec3 V=normalize(cameraPosition-vW); float dist=length(cameraPosition-vW);
  // 風: sim.js windAt と完全に同じ式で、風上(uDir)から風下(wd0)へ流れるブローを算出する
  // 海面テクスチャの座標軸(wd0, wp0)は時間変化しない基準風向(uW0)に完全固定することで、シフト変化時に海面の流れが横滑りしたり風向とずれる現象を根絶する
  vec2 uDir=vec2(sin(uW0),-cos(uW0));
  vec2 rDir=vec2(cos(uW0),sin(uW0));
  float ca=dot(p,uDir), cc=dot(p,rDir);
  float adv=mod(ca+uWT*4.8,6283.185);
  float p1=sin(adv*0.032+cc*0.018+sin(cc*0.011-uWT*0.08)*1.4);
  float p2=sin(adv*0.055-cc*0.024+1.7);
  float p3=sin(adv*0.019+cc*0.038-0.9);
  float puff=smoothstep(-0.15,0.72,0.50*p1+0.32*p2+0.18*p3);
  float sideNorm=clamp(cc/160.0,-1.2,1.2);
  float wf=clamp(0.86+0.34*puff+uSideBias*sideNorm*0.065,0.72,1.32);
  // wd0 = 風が吹いていく風下方向単位ベクトル(-uDir)、wp0 = 風に直交する横方向単位ベクトル
  vec2 wd=vec2(-sin(uW0),cos(uW0));
  vec2 wp=vec2(-wd.y,wd.x);
  float wu=dot(p,wp), wv=dot(p,wd);
  float gust=smoothstep(0.84,1.18,wf);
  float blow=smoothstep(0.98,1.16,wf);
  // 局所風速[kt]: 14knotを超えたあたりから強風で波が高くなり波頭が崩れて白波(ホワイトキャップ)が発生し始め、風が強くなるほど密度・規模が増大する
  float localKt=uWindKt*(0.88+0.36*puff+uSideBias*sideNorm*0.065);
  float over14=max(localKt-13.8,(uWindKt-13.8)*0.92);
  float whitecapIntensity=clamp(over14/3.6,0.0,1.95);

  vec2 g=vec2(0.0);
  float wH=0.0;
  float farCrestField=0.0;
  // 1) 風下方向(wd)へ伝播する立体的なベース波浪(風向きと完全に一致して風上から風下へ進行)
  for(int i=0;i<NWAVE;i++){
    float fi=float(i);
    float spread=(fi-1.5)*0.12;
    vec2 d=normalize(wd*cos(spread)+wp*sin(spread));
    float k=0.14*pow(1.72,fi); float A=0.62*pow(0.54,fi);
    float w=sqrt(9.81*k)*0.95;
    float fade=exp(-dist*k*0.0032);
    if(fade<0.02) break;
    float ph=mod(dot(d,p)*k-uWT*w+fi*1.7,628.3185);
    float s=sin(ph), co=cos(ph);
    // 波頭が尖り谷がなだらかになるトロコイド風の勾配強調で立体感を高める
    float sharp=1.0+0.28*s;
    g+=d*(A*k*co*sharp)*fade*uGen*1.45;
    wH+=A*s*fade*uGen;
    farCrestField+=max(0.0,s+0.35*co)*pow(0.68,fi);
  }
  // 2) 海況(三角波・うねり・短周期の風浪): sim.js waveSample と完全に同じ成分・同じ進行方向で法線と高さを算出
  for(int i=0;i<4;i++){
    vec4 A=uSeaA[i]; vec4 B=uSeaB[i];
    float fd=exp(-dist*A.z*0.0040);
    if(fd>0.02){
      float ph=mod(A.z*dot(A.xy,p)-B.x*uWT+B.y,6.2831853);
      float s=sin(ph), co=cos(ph);
      float sharp=1.0+0.30*s;
      g+=A.xy*(A.w*A.z*co*sharp)*fd*1.90;
      wH+=A.w*s*fd;
      farCrestField+=max(0.0,s+0.40*co)*clamp(A.w*A.z*3.2,0.15,0.95);
    }
  }
  vec2 gBase=g;
  // 3) 実海面の風浪スペクトル: 風向まわりに広がる短い風浪を多数重ね、ざらざらとした自然な水面の凹凸を作る。
  //    uChop: 八景島(東京湾の短い吹送距離＋護岸反射)=1.0 で波長の短い切り立った三角波が密に立ち、
  //           江の島(相模湾のうねり)=0.5前後 で周期の長いうねりの上にやや大きめの風浪が乗る
  //    ブロー(gust)の中ほど短い波が立って海面がざらつき、明るい空の映り込みが減って自然に暗く見える
  float windAmp=clamp(uWindKt/11.0,0.50,1.25)*(0.66+0.55*gust);
  // 波群(ウェーブグループ): 場所ごとに波の立ち方が変化し、均一なタイル感をなくす
  float grp=0.72+0.56*vn(vec2(wu*0.018+3.1,wv*0.014-uWT*0.06));
  float lam0=mix(7.5,3.4,uChop);
  float spreadA=mix(0.95,1.30,uChop);
  float stpBase=mix(0.105,0.165,uChop);
  vec2 gs=vec2(0.0);
  float subRough=0.0;
  for(int i=0;i<NSPEC;i++){
    float fi=float(i);
    float lam=lam0*pow(0.72,fi);
    float k=6.2831853/lam;
    float ang=sin(fi*2.39996+0.6)*spreadA;
    vec2 d=normalize(wd*cos(ang)+wp*sin(ang));
    float stp=stpBase*(0.80+0.40*fract(fi*0.618+0.3))*windAmp*grp;
    // 画素より細かくなった波は法線から外し、代わりに「見えない粗さ」として反射のぼけに回す(遠景のちらつき防止)
    float fk=exp(-dist*k*0.0010);
    float om=sqrt(9.81*k);
    float ph=mod(dot(d,p)*k-om*uWT+fi*4.13,6.2831853);
    // 波頭が尖り谷が広い実際の風浪の形(チョップほど波頭が鋭い)
    gs+=d*(stp*cos(ph)*(1.0+(0.25+0.35*uChop)*sin(ph)))*fk;
    subRough+=stp*stp*(1.0-fk)*0.5;
  }

  vec2 gn=g+gs;
  vec3 n=normalize(vec3(-gn.x,1.0,-gn.y));
  float ndv=max(dot(n,V),0.0);
  float sig=sqrt(subRough);
  // フレネル反射(水の屈折率1.33: 真上から見ると約2%、浅い角度ほど空を強く映す)。細かい粗さがあるほど反射は弱く・青くなる
  float ndvR=clamp(ndv+sig*0.55,0.0,1.0);
  float F=min(0.02+0.98*pow(1.0-ndvR,5.0),0.82);
  vec3 R=reflect(-V,n); R.y=abs(R.y);
  // 空の映り込み(ほんのわずかに抑えめ)
  vec3 refl=skyBase(normalize(vec3(R.x,R.y+sig*0.35,R.z)))*0.86;

  // 水中から散乱して戻る光(海の地の色): 真上から見るほど深い紺、斜めに見るほどわずかに青緑寄り
  float sunLit=clamp(dot(n,uSun)*0.5+0.5,0.0,1.0);
  float elev=clamp(wH*1.45+vH*0.62,-1.0,1.0);
  vec3 deepCol=vec3(0.010,0.050,0.098);
  vec3 scatCol=vec3(0.020,0.118,0.165);
  vec3 body=mix(deepCol,scatCol,0.30+0.40*(1.0-ndv));
  // 波の峰の薄い水が透ける(サブサーフェス散乱)＋太陽に向いていない時も太陽光が水中に差し込んで透けるうっすらとした透明感
  float trans=pow(clamp(dot(V,normalize(-uSun+vec3(0.0,0.60,0.0))),0.0,1.0),3.0);
  vec2 vHoriz=normalize(vec2(-V.x,-V.z)+vec2(1e-6,0.0));
  float sunAz=dot(vHoriz,normalize(uSun.xz));
  float offSun=1.0-smoothstep(0.20,0.88,sunAz);
  float crestGlow=smoothstep(-0.08,0.72,elev)*(0.26+0.18*sunLit)*offSun;
  float sssAmt=smoothstep(0.0,0.9,elev)*(0.12+0.85*trans)+crestGlow;
  body+=vec3(0.020,0.150,0.140)*sssAmt;
  // 順光・側光でも海面下へ透過した光が波の斜面や浅層で青緑に澄んで見える水中散乱(近〜中景中心にうっすら付与)
  float sunPen=pow(sunLit,1.35)*(0.42+0.58*smoothstep(-0.32,0.55,elev));
  float rippleClarity=clamp(length(gs)*2.2,0.0,1.0)*exp(-dist*0.006);
  body+=vec3(0.016,0.115,0.125)*offSun*(0.30*sunPen+0.14*rippleClarity)*exp(-dist*0.0016);
  body*=0.82+0.28*sunLit;

  vec3 col=mix(body,refl,F);
  // 太陽のきらめき(サングリッター): 近くは鋭い粒状のきらめき、遠くは粗さで広がった光の道になる
  float shin=mix(900.0,60.0,clamp(sig*5.0,0.0,1.0));
  float sd=max(dot(R,uSun),0.0);
  float spec=pow(sd,shin)*(shin*0.012)+pow(sd,shin*0.12)*0.035;
  col+=vec3(1.0,0.94,0.82)*spec*clamp(F*6.0,0.15,1.0);
  // 太陽側のサングリッターはそのまま維持し、太陽と逆方向(sunAz < 0)では不自然な白い点々を出さず、
  // 太陽寄りの斜め方向(sunAz > 0)の繊細な周辺きらめきと、逆光以外の自然な空色波面ツヤのみを控えめに重ねる
  vec2 gnGlint=g*0.35+gs*1.25;
  vec3 nGlint=normalize(vec3(-gnGlint.x,1.0,-gnGlint.y));
  vec3 Rglint=reflect(-V,nGlint);
  float vTan=V.y/max(length(V.xz),0.25);
  float nearK=smoothstep(0.06,0.42,vTan);
  float targetTan=vTan+mix(0.38,0.28,nearK);
  vec3 skyGlintDir=normalize(vec3(vHoriz.x,targetTan,vHoriz.y));
  float sdSky=max(dot(Rglint,skyGlintDir),0.0);
  float frontFace=smoothstep(0.11,0.28,ndv);
  float solarCoronaAz=smoothstep(-0.02,0.56,sunAz)*offSun;
  float shinSky=mix(920.0,260.0,clamp(sig*4.2,0.0,1.0));
  float specSky=pow(sdSky,shinSky)*(shinSky*0.0020);
  float skyGlintMask=solarCoronaAz*frontFace*(0.35+0.65*sunLit)*(0.25+0.75*smoothstep(-0.05,0.58,elev))*exp(-dist*0.0115);
  vec3 skyGlintCol=mix(vec3(0.88,0.95,1.0),vec3(1.0,0.95,0.84),sunLit);
  col+=skyGlintCol*min(specSky*skyGlintMask*0.11,0.16);
  // 太陽と逆方向〜横方向では白い点ではなく、波の表斜面が空の青みを柔らかく拾う控えめなツヤのみ付与
  float shinBroad=mix(76.0,28.0,clamp(sig*4.0,0.0,1.0));
  float broadSheen=pow(sdSky,shinBroad)*0.024*offSun*frontFace*(0.35+0.65*smoothstep(-0.08,0.52,elev))*exp(-dist*0.0065);
  col+=vec3(0.46,0.68,0.86)*broadSheen;

  // ブロー(風の強い海面のさざ波): 物理のブロー移動速度(adv = ca + uWT*4.8)と完全に同期して風上から風下へ流れる
  float catpaw=0.55+0.45*vn(vec2(wu*0.35,adv*0.16));
  col*=mix(1.02,0.91,smoothstep(0.76,1.22,wf));
  col=mix(col,col*vec3(0.82,0.87,0.93),blow*(0.16+0.16*catpaw)*exp(-dist*0.0006));
  if(dist<4000.0){
    float streak=smoothstep(0.75,0.94,vn(vec2(wu*0.28,adv*0.10)));
    col+=vec3(0.22,0.38,0.50)*streak*0.035*(0.4+gust)*exp(-dist*0.0012);
  }
  col=min(col,vec3(1.6));
  // 14knot超の強風白波(現在の白波表現をそのまま採用)
  if(dist<3200.0 && whitecapIntensity>0.001){
    float wci=clamp(whitecapIntensity,0.0,1.95);
    float fwdSlope=max(0.0,dot(gBase,wd));
    float wcCrestSlope=length(gBase)*2.15+fwdSlope*1.85+max(0.0,elev)*0.95+farCrestField*0.28;
    float wcN1=vn(vec2(wu*0.34,wv*0.78-uWT*2.15));
    float wcN2=vn(vec2(wu*1.35+3.7,wv*2.15-uWT*3.05));
    float wcN3=vn(vec2(wu*3.80-6.2,wv*4.60-uWT*3.90));
    float wcDetail=0.50*wcN1+0.32*wcN2+0.18*wcN3;
    float wcMetric=wcCrestSlope+wcDetail*0.36;

    float warp1=vn(vec2(wu*0.09+1.3,wv*0.09-uWT*0.35))*4.2;
    float warp2=vn(vec2(wu*0.14-3.8,wv*0.13-uWT*0.48))*4.2;
    float wv1=sin(wv*0.48-uWT*2.40+warp1);
    float wv2=sin(wv*0.76-uWT*3.10+warp2+1.7);
    float sharpCrestLine=smoothstep(0.68-0.10*min(wci,1.3),0.96,wv1)*smoothstep(0.15-0.12*min(wci,1.3),0.82,wv2);
    float patchCell=vn(vec2(wu*0.24+2.1,wv*0.36-uWT*1.05))*0.62+vn(vec2(wu*0.58-4.7,wv*0.72-uWT*1.55))*0.38;
    float patchGate=smoothstep(0.66-0.11*min(wci,1.4),0.84,patchCell);
    float lipEdge=sharpCrestLine*patchGate*smoothstep(0.62-0.14*min(wci,1.3),0.98,wcMetric*0.65+wcDetail*0.45);
    float wakePhase=sin(wv*0.48-uWT*2.40+warp1+0.55);
    float wakeZone=smoothstep(0.42,0.90,wakePhase)*(1.0-sharpCrestLine*0.5)*patchGate;
    float laceTex=smoothstep(0.48,0.82,wcN2*0.48+wcN3*0.52);
    float wcMidFar=lipEdge*(0.78+0.22*wcN3)+wakeZone*laceTex*0.42*smoothstep(0.58,0.86,patchCell);

    float onset=smoothstep(0.0,0.20,wci)*(0.62+0.38*min(wci,1.35));
    float galeFoam=clamp(wcMidFar*onset,0.0,0.96)*exp(-dist*0.00075);
    vec3 foamShadow=vec3(0.84,0.92,0.97);
    vec3 foamBright=vec3(0.995,0.998,1.0);
    vec3 foamCol=mix(foamShadow,foamBright,clamp(0.35+0.42*sunLit+0.32*galeFoam+0.20*wcN3,0.0,1.0));
    col=mix(col,foamCol,galeFoam);
  }
  float fd0=dist*${FOG_DENSITY.toFixed(7)};
  float fogF=1.0-exp(-(fd0*fd0));
  col=mix(col,vec3(0.741,0.835,0.902),fogF);
  gl_FragColor=vec4(col,1.0);
}`,
  fog: false,
});

// ---------- 空 ----------
const skyMat = new THREE.ShaderMaterial({
  uniforms: { uSun: { value: SUN_DIR }, uTime: { value: 0 } },
  side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: `varying vec3 vD; void main(){ vD=normalize(position); gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0); }`,
  fragmentShader: `
precision highp float; varying vec3 vD; uniform float uTime;
${SKY_FN}
float hh(vec2 p){ p=mod(p,289.0); return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(hh(i),hh(i+vec2(1,0)),f.x),mix(hh(i+vec2(0,1)),hh(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float a=0.5,s=0.0; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+1.7; a*=0.5;} return s; }
void main(){
  vec3 d=normalize(vD);
  vec3 c=skyBase(vec3(d.x,max(d.y,0.0),d.z));
  if(d.y<0.0) c=mix(c,vec3(0.74,0.86,0.94),smoothstep(0.0,-0.2,d.y));
  if(d.y>0.0){
    vec2 uv=d.xz/(d.y+0.12)*0.9+vec2(uTime*0.004,uTime*0.002);
    float cl=smoothstep(0.52,0.85,fbm(uv*1.4));
    float lit=0.75+0.25*clamp(dot(normalize(vec3(d.x,0.0,d.z)),normalize(vec3(uSun.x,0.0,uSun.z)))*0.5+0.5,0.0,1.0);
    vec3 cc=mix(vec3(0.72,0.78,0.86),vec3(1.0),lit);
    c=mix(c,cc,cl*smoothstep(0.0,0.25,d.y)*0.9);
  }
  gl_FragColor=vec4(c,1.0);
}`,
});

// ---------- 地形 ----------
// 江の島: コースから約800m(島の南端)。海成段丘の平頂な2つの丘陵(亀ヶ岡〜奥津宮とコッキング苑)を「山二つ」の鞍部が分け、南側は海食崖と隆起波食台(稚児ヶ淵)、北側は参道と街並み
export const ISLAND = { x: 450, z: -1150, rx: 520, rz: 230 };
function islandPolar(x, z) {
  const dx = (x - ISLAND.x) / ISLAND.rx, dz = (z - ISLAND.z) / ISLAND.rz;
  const ang = -0.15, rx = dx * Math.cos(ang) - dz * Math.sin(ang), rz = dx * Math.sin(ang) + dz * Math.cos(ang);
  // 「山二つ」(rx ≒ -0.16)の海食洞崩落谷によるくびれと、北西側「洲鼻」参道入口への張り出しを再現
  const yamafutatsuPinch = 0.095 * Math.exp(-((rx + 0.16) * (rx + 0.16)) / 0.015) * smooth(-0.12, 0.48, rz);
  const subanaSpit = -0.12 * Math.exp(-((rx + 0.66) * (rx + 0.66)) / 0.032) * Math.exp(-((rz + 0.42) * (rz + 0.42)) / 0.08);
  const cliffRibs = (noise2(x * 0.035, z * 0.035) - 0.5) * 0.045 * smooth(-0.1, 0.45, rz);
  const n = noise2(x * 0.0065, z * 0.0065) * 0.16 + noise2(x * 0.022, z * 0.022) * 0.05 + cliffRibs;
  return { rx, rz, r: Math.sqrt(rx * rx * 0.88 + rz * rz * 1.14) + n - 0.10 + yamafutatsuPinch + subanaSpit };
}
export function islandH(x, z) {
  const { rx, rz, r } = islandPolar(x, z);
  const south = smooth(-0.22, 0.52, rz); // 南側(外海側)ほど海食崖が切り立つ
  if (r >= 1) {
    // 隆起波食台: 南西端「稚児ヶ淵〜岩屋前」に広く張り出す平坦な岩棚 ＋ 南崖直下の大平・磯棚
    const chigo = Math.max(0.32 * south, smooth(-0.15, -0.56, rx) * smooth(-0.28, 0.28, rz));
    const shelfReach = rx < -0.28 ? 1.28 : 1.15;
    const shelf = chigo * (1 - smooth(1.0, shelfReach, r)) * (1 - smooth(0.14, 0.26, rx));
    const base = -6.5 + Math.max(0, 1.32 - r) * 12;
    if (shelf > 0.04) {
      const rockBench = 0.35 + 1.45 * shelf + (noise2(x * 0.12, z * 0.12) - 0.45) * 0.65;
      return Math.max(base, rockBench);
    }
    return base;
  }
  const t = 1 - r;
  // 東側(rx > 0.11 -> 0.29)でコッキング苑東崖から湘南港(ヨットハーバー)の低い埋立地エプロン(標高約1.5m)へ完全に降りきる
  const eastHarbor = smooth(0.11, 0.29, rx);
  const northTown = smooth(-0.12, -0.62, rz) * smooth(-0.82, -0.28, rx) * (1 - eastHarbor);
  // 南面・西端・東端段丘崖は急峻な海食崖(ex≒0.23)で一気に立ち上がり、段丘上面はテーブル状に緩やかになる江の島特有の断面
  const westTip = smooth(-0.45, -0.82, rx);
  const cliffSteep = Math.max(south, westTip * 0.78);
  const ex = 0.64 - 0.41 * cliffSteep + 0.22 * northTown;
  const plateauProfile = Math.min(1.0, Math.pow(t, ex) * 1.16);
  // 「山二つ」(rx ≒ -0.16) の深い鞍部切れ込みで、西の奥津宮丘陵(約52m)と東寄りのコッキング苑台地(約60m)の2峰シルエットを鮮明に作る
  const yamafutatsuDip = 0.34 * Math.exp(-((rx + 0.16) * (rx + 0.16)) / 0.012) * (0.55 + 0.45 * south);
  const westTaper = 0.11 * smooth(-0.22, -0.74, rx);
  const hillH = plateauProfile * (61.5 * (1 - yamafutatsuDip - westTaper)) * (1 - eastHarbor);
  const terraceH = eastHarbor * smooth(1.0, 0.76, r) * 2.5 + northTown * smooth(1.0, 0.84, r) * 2.5;
  const micro = (1 - 0.92 * eastHarbor) * (noise2(x * 0.048, z * 0.048) * 2.1 + noise2(x * 0.13, z * 0.13) * 0.95);
  return hillH + terraceH - 1.5 + micro;
}
const COAST = 1850; // 湘南海岸(片瀬海岸)までの距離
const COAST_Z = -COAST;
// 片瀬西浜〜鵠沼〜辻堂〜茅ヶ崎〜平塚〜大磯の緩やかな弓なり砂浜＋相模川河口(x≒-8100)の自然な入り込み
const shonanShoreZ = (x) => {
  const bow = -110 * Math.pow(clampN((-x - 800) / 8800, 0, 1), 1.45); // 茅ヶ崎・平塚へ向かう緩やかな湾曲后退, 大磯で再び前へ出る
  const oisoProm = 135 * Math.exp(-((x + 9750) * (x + 9750)) / 1.3e6);
  const sagamiMouth = -68 * Math.exp(-((x + 8100) * (x + 8100)) / 95000);
  return -COAST - 34 * Math.sin(x / 760) - 18 * Math.sin(x / 250 + 1) - bow + oisoProm + sagamiMouth;
};
const coastD = (x, z) => shonanShoreZ(x) - z;
function landH(x, z) {
  if (x < -10550 || x > 11400) return -18;
  const d = coastD(x, z);
  if (d < -40) return -6;
  const westJoin = smooth(-10500, -9550, x); // 大磯以西は addEnoshimaScenery の西湘・箱根・伊豆メッシュへシームレス接続
  const eastJoin = 1 - smooth(5200, 10800, x); // 三浦半島東端の裏側ではみ出さないよう収める
  const ramp = smooth(-12, 110, d);
  // 藤沢・片瀬・鵠沼・辻堂・茅ヶ崎の奥は平坦な湘南平野〜相模野台地(標高4〜18m程度、藤沢背後に山脈なし)
  const plain = smooth(240, 2800, d) * (8.5 + 6.5 * noise2(x / 1800, d / 1800));
  // 東側(腰越・七里ヶ浜・鎌倉山 x > 950)のみ、鎌倉へ続く実際のなだらかな緑の丘陵(約45〜95m)を配置し、奥で低く収める
  const eastK = smooth(950, 2600, x) * (1 - 0.55 * smooth(2800, 6500, d));
  const kamakuraHills = eastK * smooth(140, 1350, d) * (42 + 52 * noise2(x / 900, d / 800));
  const baseH = -0.5 + 3.8 * ramp + plain + kamakuraHills;
  return -14 + (baseH + 14) * westJoin * eastJoin;
}
function colorLand(x, z, h, out) {
  const d = coastD(x, z);
  const sagamiRiver = Math.exp(-((x + 8100) * (x + 8100)) / 42000);
  if (h < 0.15) out.setRGB(0.36, 0.34, 0.30); // 波打ち際(濡れた砂)
  else if (sagamiRiver > 0.45 && h < 9) out.setRGB(0.20, 0.33, 0.42); // 相模川河口の水面帯
  else if (d < 125) { const g = noise2(x / 40, z / 40) * 0.04; out.setRGB(0.54 + g, 0.50 + g, 0.42 + g); } // 湘南の砂浜(片瀬・鵠沼・辻堂・茅ヶ崎)
  else if (d < 160) out.setRGB(0.44, 0.45, 0.47); // 防潮堤・国道134号
  else if (d < 360 && h < 18) {
    // 国道134号沿いの湘南海岸クロマツ防砂林帯（濃い松林の緑）
    const g = noise2(x / 55, z / 55);
    out.setRGB(0.10 + 0.04 * g, 0.24 + 0.06 * g, 0.12 + 0.03 * g);
  } else {
    const g = noise2(x / 160, z / 160);
    const u = smooth(25, 160, h);
    const distHaze = smooth(1800, 6200, d);
    // 湘南の緑地・鎌倉山の常緑樹色と、藤沢・片瀬・鵠沼・腰越の市街地ブロックを距離霞みへ自然になじませる
    let r = 0.15 + 0.05 * g, gg = 0.31 + 0.07 * g, b = 0.16 + 0.04 * g;
    if (d < 5200 && h < 42) {
      const townNoise = noise2(x / 52, z / 52);
      if (townNoise > 0.36) {
        const bldTone = noise2(x / 18, z / 18);
        r = 0.54 + 0.08 * bldTone;
        gg = 0.52 + 0.07 * bldTone;
        b = 0.49 + 0.07 * bldTone;
      }
    }
    const r1 = 0.44 + 0.05 * u, g1 = 0.54 + 0.05 * u, b1 = 0.62 + 0.05 * u;
    const k = Math.max(u * 0.35, distHaze * 0.72);
    out.setRGB(r + (r1 - r) * k, gg + (g1 - gg) * k, b + (b1 - b) * k);
  }
}

// 遠景の陸地(三浦半島・伊豆半島・箱根・丹沢・伊豆大島): 楕円の高さ場+ノイズ (参考画像2枚目の薄い霞んだ山肌色)
function distantLand(scene, cx, cz, rx, rz, hmax, rot = 0, n = 48) {
  const xs = [], zs = [];
  const R = Math.max(rx, rz) * 1.15;
  for (let i = 0; i <= n; i++) { xs.push(cx - R + (2 * R * i) / n); zs.push(cz - R + (2 * R * i) / n); }
  const c = Math.cos(rot), s = Math.sin(rot);
  const hf = (x, z) => {
    const dx = x - cx, dz = z - cz;
    const u = (dx * c - dz * s) / rx, v = (dx * s + dz * c) / rz;
    const r = Math.sqrt(u * u + v * v) + (noise2(x / (rx * 0.35), z / (rz * 0.35)) - 0.5) * 0.35;
    if (r >= 1) return -30;
    const ridge = 0.55 + 0.45 * noise2(x / (rx * 0.18) + 9, z / (rz * 0.18) - 3);
    return Math.pow(1 - r, 0.8) * hmax * ridge - 4;
  };
  const geo = buildGrid(xs, zs, hf, (x, z, h, out) => {
    const g = noise2(x / 900, z / 900);
    const u = smooth(10, Math.max(80, hmax * 0.7), h);
    if (h < 5) out.setRGB(0.48, 0.52, 0.56);
    else out.setRGB(0.50 + 0.08 * u + 0.03 * g, 0.60 + 0.08 * u + 0.04 * g, 0.71 + 0.07 * u + 0.03 * g);
  });
  scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));
}

function buildGrid(xs, zs, hf, cf) {
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3);
  const c = new THREE.Color();
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, h = hf(xs[i], zs[j]);
    pos[k * 3] = xs[i]; pos[k * 3 + 1] = h; pos[k * 3 + 2] = zs[j];
    cf(xs[i], zs[j], h, c); col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
  }
  const idx = [];
  const flip = (xs[nx - 1] - xs[0]) * (zs[nz - 1] - zs[0]) < 0;
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, cc = a + nx, d = cc + 1;
    if (flip) idx.push(a, b, cc, b, d, cc);
    else idx.push(a, cc, b, b, cc, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export function createWorld(scene) {
  scene.background = new THREE.Color(FOG_COLOR);
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x4a6770, 1.35));
  const sun = new THREE.DirectionalLight(0xfff0d6, 2.7); sun.position.copy(SUN_DIR).multiplyScalar(200); scene.add(sun);

  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), waterMat);
  sea.geometry.rotateX(-Math.PI / 2); sea.scale.set(120000, 1, 120000); sea.frustumCulled = false; scene.add(sea);
  // カメラ周辺の立体波浪変位パッチ(うねり・三角波・風浪すべてで常時表示し、波の立体感を表現)
  const PATCH_R = 192, PATCH_SEG = MOBILE ? 96 : 144;
  const seaPatchMat = new THREE.ShaderMaterial({
    defines: { ...waterMat.defines, PATCH: 1 },
    uniforms: waterMat.uniforms,
    vertexShader: waterMat.vertexShader,
    fragmentShader: waterMat.fragmentShader,
    fog: false,
    stencilWrite: true,
    stencilWriteMask: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilRef: 1,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
  });
  const patchGeo = new THREE.PlaneGeometry(PATCH_R * 2, PATCH_R * 2, PATCH_SEG, PATCH_SEG); patchGeo.rotateX(-Math.PI / 2);
  const seaPatch = new THREE.Mesh(patchGeo, seaPatchMat); seaPatch.frustumCulled = false; seaPatch.renderOrder = -5; seaPatch.visible = true; scene.add(seaPatch);
  sea.renderOrder = -4;
  waterMat.uniforms.uPatchR.value = PATCH_R;
  let seaBaseY = -0.35;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(70000, 32, 16), skyMat); sky.frustumCulled = false; sky.renderOrder = -10; scene.add(sky);

  // ---------- ステージ風景: 江の島 / 八景島 ----------
  const enoshimaGroup = new THREE.Group();
  const hakkeijimaGroup = new THREE.Group();
  hakkeijimaGroup.visible = false;
  scene.add(enoshimaGroup, hakkeijimaGroup);

  // 白波(磯・浜に砕ける波): 等高線に沿った帯を作り、波のテクスチャを流す
  const foamTex = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64; const x = c.getContext('2d');
    for (let i = 0; i < 900; i++) {
      const px = Math.random() * 256, py = Math.random() * 64, a = Math.pow(1 - py / 64, 1.6) * (0.25 + Math.random() * 0.5);
      x.fillStyle = `rgba(255,255,255,${a})`; x.beginPath(); x.ellipse(px, py, 3 + Math.random() * 9, 1 + Math.random() * 3, 0, 0, 7); x.fill();
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; return t;
  })();
  const surfMat = new THREE.MeshBasicMaterial({ map: foamTex, transparent: true, opacity: 0.8, depthWrite: false, color: 0xf2f7f8 });
  const surfStrip = (parent, pts, width) => {
    const pos = [], uv = [], idx = [];
    let acc = 0;
    pts.forEach((p, i) => {
      if (i) acc += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      const w = width * (0.6 + 0.8 * noise2(p.x * 0.02, p.z * 0.02));
      pos.push(p.x - p.ux * 1.5, 0.22, p.z - p.uz * 1.5, p.x + p.ux * w, 0.22, p.z + p.uz * w);
      uv.push(acc / 40, 0, acc / 40, 1);
      if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    const m = new THREE.Mesh(g, surfMat); m.renderOrder = 1; parent.add(m); return m;
  };

  // ===== 1. 江の島ステージ =====
  const xs = [], zs = [];
  for (let i = 0; i <= 260; i++) xs.push(ISLAND.x - 660 + (1320 * i) / 260);
  for (let j = 0; j <= 148; j++) zs.push(ISLAND.z - 350 + (700 * j) / 148);
  const islandGeo = buildGrid(xs, zs, islandH, (x, z, h, out) => out.setRGB(0, 0, 0));
  {
    // 実景準拠: 上部は深い照葉樹林、南〜南西面(稚児ヶ淵〜山二つ〜コッキング苑南崖)は黄褐色〜灰褐色の水平地層を持つ海食崖と隆起波食台(岩棚)
    const P = islandGeo.attributes.position, N = islandGeo.attributes.normal, C = islandGeo.attributes.color;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), h = P.getY(i), z = P.getZ(i), ny = N.getY(i);
      const g = noise2(x / 11, z / 11), g2 = noise2(x / 32 + 5, z / 32), crev = noise2(x / 5.5 + 13, z / 5.5 - 7);
      const isEastHarbor = x > ISLAND.x + 125 && h < 12;
      const southExposure = Math.max(smooth(ISLAND.z - 45, ISLAND.z + 45, z), smooth(ISLAND.x - 190, ISLAND.x - 285, x)) * (1 - smooth(ISLAND.x + 105, ISLAND.x + 165, x));
      let r, gg, b;
      if (h < 0.55) {
        // 潮間帯の濡れた暗褐色岩礁・タイドプール
        r = 0.20 + 0.04 * g; gg = 0.19 + 0.04 * g; b = 0.18 + 0.03 * g;
      } else if (h < 2.4 && southExposure > 0.25) {
        // 稚児ヶ淵・南岸の隆起波食台(乾いた黄灰色の砂岩質岩棚＋潮溜まりの濃淡)
        const pool = smooth(0.62, 0.84, crev) * smooth(1.9, 0.7, h);
        r = (0.47 + 0.06 * g) * (1 - 0.42 * pool);
        gg = (0.43 + 0.05 * g) * (1 - 0.40 * pool);
        b = (0.37 + 0.04 * g) * (1 - 0.35 * pool);
      } else if (h < 3.4 || isEastHarbor) {
        // 北岸護岸・湘南港基部エプロン
        r = 0.53 + 0.05 * g; gg = 0.50 + 0.05 * g; b = 0.45 + 0.04 * g;
      } else {
        // 照葉樹林の林床・樹冠ベース(自然な深緑と陽当たりのオリーブグリーン)
        r = 0.095 + 0.042 * g + 0.022 * g2;
        gg = 0.235 + 0.068 * g + 0.038 * g2;
        b = 0.095 + 0.030 * g + 0.018 * g2;
      }
      // 南面〜西面・山二つの急斜面は第三紀凝灰質砂岩の水平地層縞を持つリアルな海食崖(黄土〜灰褐色)を露出させる
      const steepK = smooth(0.84, 0.46, ny);
      const cliffZone = southExposure * steepK * (1 - 0.55 * smooth(36, 52, h));
      if (cliffZone > 0.02 && h >= 0.55) {
        const strata = Math.sin(h * 1.45 + g * 2.4 + g2 * 1.6); // 水平方向の地層バンディング
        const cr = 0.53 + 0.065 * strata + 0.04 * g - 0.08 * (1 - crev);
        const cg = 0.46 + 0.055 * strata + 0.04 * g - 0.07 * (1 - crev);
        const cb = 0.36 + 0.040 * strata + 0.03 * g - 0.06 * (1 - crev);
        r += (cr - r) * cliffZone;
        gg += (cg - gg) * cliffZone;
        b += (cb - b) * cliffZone;
      }
      C.setXYZ(i, r, gg, b);
    }
    C.needsUpdate = true;
  }
  enoshimaGroup.add(new THREE.Mesh(islandGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  {
    const pts = [];
    for (let k = 0; k <= 360; k++) {
      const a = (k / 360) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
      let rr = 0;
      for (let s = 780; s > 0; s -= 2) { if (islandH(ISLAND.x + ux * s, ISLAND.z + uz * s) > -0.22) { rr = s; break; } }
      pts.push({ x: ISLAND.x + ux * rr, z: ISLAND.z + uz * rr, ux, uz });
    }
    surfStrip(enoshimaGroup, pts, 10.5);
    const cpts = [];
    for (let x = -9800; x <= 3000; x += 40) cpts.push({ x, z: shonanShoreZ(x) - 52, ux: 0, uz: 1 });
    surfStrip(enoshimaGroup, cpts, 14);
  }

  // 湘南海岸 (片瀬〜鵠沼〜辻堂〜茅ヶ崎〜平塚〜大磯: x・zとも昇順にして法線が正しく上向き+Yになるようにする)
  const lx = gridAxis([[-10600, -4500, 135], [-4500, 3800, 65], [3800, 11500, 340]]);
  const lz = [];
  for (let j = 47; j >= 0; j--) lz.push(COAST_Z + 100 - (25 * (Math.pow(1.095, j) - 1)) / 0.095);
  const landGeo = buildGrid(lx, lz, landH, colorLand);
  enoshimaGroup.add(new THREE.Mesh(landGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  // 富士山: 江の島からの実方位(約276.3°・西北西やや西)と地球曲率込みの見かけスケールに忠実な造形
  // ・懸垂曲線(カテナリー)の優美な左右稜線、平らな山頂火口と左端の最高峰「剣ヶ峰(3776m)」・右端の「白山岳」
  // ・江の島から左手前(南東斜面)に見える象徴的な「宝永山(2693m)」の出っ張りと「宝永火口」の窪み
  // ・放射状の沢筋(雪筋)と、高度に応じた大気遠近(裾野は箱根・足柄の奥に霞み、冠雪の山頂は澄んだ空に映える)
  let fgeo = null;
  {
    const nRad = 96, nRing = 56;
    const rBase = 10500, rTop = 760, hBase = 2475;
    const vCount = (nRing + 1) * (nRad + 1) + 1;
    const fPos = new Float32Array(vCount * 3);
    const fCol = new Float32Array(vCount * 3);
    const fMeta = new Float32Array(vCount * 2); // [hoeiCraterMask, ridgeRelief]
    const fIdx = [];
    const wrapAng = (a, c) => {
      let d = a - c;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d;
    };
    let vi = 0;
    for (let j = 0; j <= nRing; j++) {
      const t = j / nRing; // 0 = 裾野, 1 = 山頂火口縁
      const baseR = rTop + (rBase - rTop) * Math.pow(1 - t, 1.76) * (1 - 0.045 * Math.sin(Math.PI * t));
      for (let i = 0; i <= nRad; i++) {
        const ang = (i / nRad) * Math.PI * 2 - Math.PI; // -PI..PI (+X=東/手前, +Z=南/江の島から見て左側)
        let r = baseR;
        let y = hBase * t;

        // 1) 山頂火口縁のリアルな起伏: 江の島から見て左端(+Z側)に鋭く聳える剣ヶ峰、右端(-Z側)に白山岳
        if (t > 0.86) {
          const wRim = smooth(0.86, 1.0, t);
          const dKenga = wrapAng(ang, 1.28); // 南〜南西縁(左端) = 剣ヶ峰
          const dHaku = wrapAng(ang, -1.18); // 北縁(右端) = 白山岳
          const dIzusan = wrapAng(ang, 0.12); // 東縁(成就岳・伊豆岳)
          y += wRim * (
            76 * Math.exp(-(dKenga * dKenga) / 0.14)
            + 38 * Math.exp(-(dHaku * dHaku) / 0.18)
            + 20 * Math.exp(-(dIzusan * dIzusan) / 0.22)
            - 18 * Math.cos(ang * 4.0 + 0.6)
          );
        }

        // 2) 南東斜面(江の島から見て左稜線〜左手前)の象徴的な「宝永山」の出っ張りと「宝永火口」の抉れ
        const dCraterA = wrapAng(ang, 1.06);
        const dHoeiPeakA = wrapAng(ang, 1.38);
        const craterElev = Math.exp(-((t - 0.64) * (t - 0.64)) / 0.0085);
        const craterMask = Math.exp(-(dCraterA * dCraterA) / 0.058) * craterElev;
        const hoeiShoulder = Math.exp(-(dHoeiPeakA * dHoeiPeakA) / 0.068) * Math.exp(-((t - 0.58) * (t - 0.58)) / 0.0105);
        r += hoeiShoulder * 540 - craterMask * 235;
        y += hoeiShoulder * 138 - craterMask * 82;

        // 3) 放射状の沢筋と尾根の微細な凹凸 (太陽光で立体的な山肌の陰影を生む)
        const gully = (
          0.52 * Math.cos(ang * 17.0 + 0.8 * Math.sin(t * 5.0))
          + 0.31 * Math.cos(ang * 31.0 - 1.4 + 0.6 * Math.cos(t * 7.0))
          + 0.17 * Math.cos(ang * 53.0 + 2.1)
        );
        const gullyEnv = smooth(0.12, 0.42, t) * (1 - 0.35 * smooth(0.88, 1.0, t));
        r += gully * 52 * gullyEnv;
        y += gully * 14 * gullyEnv;

        const px = r * Math.cos(ang);
        const pz = r * Math.sin(ang);
        fPos[vi * 3] = px;
        fPos[vi * 3 + 1] = y;
        fPos[vi * 3 + 2] = pz;
        const sn = smooth(0.60, 0.74, t - gully * 0.04 - craterMask * 0.14);
        fCol[vi * 3] = 0.24 + sn * 0.74;
        fCol[vi * 3 + 1] = 0.34 + sn * 0.65;
        fCol[vi * 3 + 2] = 0.52 + sn * 0.48;
        fMeta[vi * 2] = craterMask;
        fMeta[vi * 2 + 1] = gully * gullyEnv;
        vi++;
      }
    }
    // 火口底の中心頂点
    const centerIdx = vi;
    fPos[vi * 3] = 0; fPos[vi * 3 + 1] = hBase - 95; fPos[vi * 3 + 2] = 0;
    fCol[vi * 3] = 0.92; fCol[vi * 3 + 1] = 0.96; fCol[vi * 3 + 2] = 1.0;
    fMeta[vi * 2] = 0; fMeta[vi * 2 + 1] = 0;

    const stride = nRad + 1;
    for (let j = 0; j < nRing; j++) {
      for (let i = 0; i < nRad; i++) {
        const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
        fIdx.push(a, b, c, b, d, c);
      }
    }
    const topStart = nRing * stride;
    for (let i = 0; i < nRad; i++) {
      fIdx.push(topStart + i, topStart + i + 1, centerIdx);
    }

    fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
    fgeo.setAttribute('color', new THREE.BufferAttribute(fCol, 3));
    fgeo.setAttribute('aMeta', new THREE.BufferAttribute(fMeta, 2));
    fgeo.setIndex(fIdx);
    fgeo.computeVertexNormals();

    const fujiMat = new THREE.ShaderMaterial({
      uniforms: { uSun: { value: SUN_DIR } },
      fog: false,
      vertexShader: `
        attribute vec2 aMeta;
        varying vec3 vLPos;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying vec2 vMeta;
        void main() {
          vLPos = position;
          vMeta = aMeta;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWPos = wp.xyz;
          vWNrm = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec3 vLPos;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying vec2 vMeta;
        ${SKY_FN}
        float fh(vec2 p){ p=mod(p,289.0); return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
        float fvn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(fh(i),fh(i+vec2(1,0)),f.x),mix(fh(i+vec2(0,1)),fh(i+vec2(1,1)),f.x),f.y); }
        void main() {
          vec3 N = normalize(vWNrm);
          float ang = atan(vLPos.z, vLPos.x);
          float hNorm = clamp(vLPos.y / 2520.0, 0.0, 1.05);

          // 沢筋に沿って鋭く切れ込むリアルな雪化粧と雪筋パターン
          float streak1 = sin(ang * 22.0 + fvn(vec2(ang * 5.5, hNorm * 9.0)) * 2.4);
          float streak2 = sin(ang * 47.0 - 1.3 + fvn(vec2(ang * 11.0 + 3.1, hNorm * 16.0)) * 2.0);
          float streak3 = fvn(vec2(ang * 28.0 + 7.0, hNorm * 24.0)) * 2.0 - 1.0;
          // 谷筋(vMeta.y < 0)に雪が深く残り、尾根筋や宝永火口壁(vMeta.x)は風で岩肌が覗く
          float gullySnow = -vMeta.y * 0.11 + 0.055 * streak1 + 0.032 * streak2 + 0.025 * streak3;
          float hoeiBare = vMeta.x * 0.16;
          float snowLine = 0.665 - gullySnow + hoeiBare;
          float snow = smoothstep(snowLine - 0.055, snowLine + 0.045, hNorm);
          // 6〜7合目付近の細い残雪の雪筋ディテール
          float lowerStreaks = smoothstep(0.46, 0.66, hNorm) * smoothstep(0.32, 0.78, -vMeta.y * 0.9 + 0.45 * streak2 + 0.35 * streak3);
          snow = clamp(max(snow, lowerStreaks * 0.72 * (1.0 - vMeta.x * 0.8)), 0.0, 1.0);

          // 太陽光ライティング (南東からの陽射しで左手前〜正面が明るく輝き、北西斜面は気品ある青影に締まる)
          float sunDiff = clamp(dot(N, normalize(uSun)), 0.0, 1.0);
          float skyAmb = 0.5 + 0.5 * N.y;

          // 火山岩の群青〜藍鼠色 (宝永火口周辺はわずかに赤褐色のスコリア岩肌を帯びる)
          vec3 rockShadow = vec3(0.20, 0.29, 0.46);
          vec3 rockLit = mix(vec3(0.34, 0.42, 0.58), vec3(0.43, 0.39, 0.50), clamp(vMeta.x * 1.3, 0.0, 1.0));
          vec3 rockCol = mix(rockShadow, rockLit, clamp(0.22 + 0.78 * sunDiff, 0.0, 1.0));

          // 冠雪の純白〜青白い陰影
          vec3 snowShadow = vec3(0.74, 0.84, 0.94);
          vec3 snowLit = vec3(0.985, 0.992, 1.0);
          vec3 snowCol = mix(snowShadow, snowLit, clamp(0.28 + 0.76 * sunDiff + 0.12 * skyAmb, 0.0, 1.0));

          vec3 surf = mix(rockCol, snowCol, snow);

          // 高度別・大気遠近法: 裾野は相模湾の湿潤な霞に溶け込み、標高が高い山頂部ほど澄んだ青空にくっきり浮かび上がる
          vec3 viewVec = vWPos - cameraPosition;
          float dist = length(viewVec);
          vec3 viewDir = viewVec / max(dist, 1.0);
          vec3 skyHaze = mix(vec3(0.741, 0.835, 0.902), skyBase(vec3(viewDir.x, max(viewDir.y, 0.002), viewDir.z)), smoothstep(0.01, 0.065, viewDir.y));
          float baseFog = 1.0 - exp(-pow(dist * 0.000024, 2.0));
          float altClear = mix(1.08, 0.50, smoothstep(0.22, 0.88, hNorm));
          float haze = clamp(baseFog * altClear, 0.26, 0.86);
          vec3 finalCol = mix(surf, skyHaze, haze);
          gl_FragColor = vec4(finalCol, 1.0);
        }
      `,
    });

    const fuji = new THREE.Mesh(fgeo, fujiMat);
    fuji.userData.noBake = true;
    fuji.position.set(-42680, -2, -4730);
    enoshimaGroup.add(fuji);
  }

  // 江の島の森: タブノキ・スダジイ等の照葉樹林(広葉樹クラウン)をベースに、海食崖の縁・稚児ヶ淵上・参道・さざえ島周辺に海岸クロマツを混交配置
  const broadCount = 1560, pineCount = 420;
  const trees = new THREE.InstancedMesh(getBroadTreeCrownGeo(), new THREE.MeshLambertMaterial({ vertexColors: true }), broadCount);
  const pines = new THREE.InstancedMesh(getPineTreeCrownGeo(), new THREE.MeshLambertMaterial({ vertexColors: true }), pineCount);
  const treeTrunks = new THREE.InstancedMesh(getTreeTrunkGeo(), new THREE.MeshLambertMaterial({ color: 0x543c2c, vertexColors: true }), broadCount + pineCount);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), tc = new THREE.Color(), eul = new THREE.Euler();
  let nb = 0, npTree = 0, nTrk = 0;
  const lhx = ISLAND.x + 6, lhz = ISLAND.z - 14; // サムエル・コッキング苑 / 江の島シーキャンドル位置(東寄り主峰台地)
  for (let tries = 0; tries < 18000 && (nb < broadCount || npTree < pineCount); tries++) {
    const x = ISLAND.x - 495 + rnd() * 710, z = ISLAND.z - 225 + rnd() * 445;
    const h = islandH(x, z);
    if (h < 5.4) continue;
    if (x > ISLAND.x + 145 && h < 12) continue; // 東側下部は湘南港・ヨットハーバー広場
    if (Math.hypot(x - lhx, z - lhz) < 26) continue; // シーキャンドル足元のコッキング苑広場は空けて展望灯台を際立たせる
    // 弁財天仲見世通り〜瑞心門〜辺津宮の参道ラインは木を空けて参道と朱塗りの社殿を見せる
    const nakamiseLine = Math.abs((z - (ISLAND.z - 115)) - 0.34 * (x - (ISLAND.x - 235)));
    if (x > ISLAND.x - 325 && x < ISLAND.x - 115 && nakamiseLine < 14) continue;
    // 北〜北東麓の旅館・仲見世エリアは建物を優先
    if (z < ISLAND.z - 105 && x > ISLAND.x - 355 && x < ISLAND.x + 95 && h < 12.5) continue;
    // 南〜南西の切り立った海食崖の中腹以下は黄褐色の地層岩肌を見せる
    const slope = Math.abs(islandH(x + 3.5, z) - h) + Math.abs(islandH(x, z + 3.5) - h);
    const onSouthCliff = (z > ISLAND.z + 38 || x < ISLAND.x - 245) && slope > 5.0 && h < 36;
    if (onSouthCliff || slope > 8.6) continue;

    const cliffRim = (z > ISLAND.z + 22 && h < 44) || x < ISLAND.x - 265 || x > ISLAND.x + 95 || slope > 4.2;
    const wantPine = (cliffRim && rnd() < 0.58) || rnd() < 0.16;
    const s = 5.2 + rnd() * 5.4;
    const ry = rnd() * 6.28;
    q.setFromEuler(eul.set(0, ry, 0));
    if ((wantPine && npTree < pineCount) || nb >= broadCount) {
      if (npTree >= pineCount) continue;
      m4.compose(new THREE.Vector3(x, h + s * 0.66, z), q, new THREE.Vector3(s * (1.02 + rnd() * 0.30), s * (0.78 + rnd() * 0.22), s * (1.02 + rnd() * 0.30)));
      pines.setMatrixAt(npTree, m4);
      tc.setRGB(0.08 + rnd() * 0.04, 0.20 + rnd() * 0.07, 0.09 + rnd() * 0.03);
      pines.setColorAt(npTree++, tc);
    } else {
      m4.compose(new THREE.Vector3(x, h + s * 0.64, z), q, new THREE.Vector3(s * (1.08 + rnd() * 0.32), s * (0.76 + rnd() * 0.22), s * (1.08 + rnd() * 0.32)));
      trees.setMatrixAt(nb, m4);
      // 照葉樹林の深い常緑(タブノキ・スダジイ・クスノキ)の自然な濃淡
      tc.setRGB(0.09 + rnd() * 0.055, 0.22 + rnd() * 0.095, 0.09 + rnd() * 0.04);
      trees.setColorAt(nb++, tc);
    }
    m4.compose(new THREE.Vector3(x, h - 0.25, z), q, new THREE.Vector3(s * 0.52, s * 0.72, s * 0.52));
    treeTrunks.setMatrixAt(nTrk++, m4);
  }
  q.identity();
  trees.count = nb; pines.count = npTree; treeTrunks.count = nTrk;
  enoshimaGroup.add(treeTrunks, trees, pines);

  const BOXMAX = 3600;
  const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), BOXMAX);
  let bn = 0;
  const addBox = (x, y, z, w, h, d, color, rotY = 0) => {
    if (bn >= BOXMAX) return;
    if (rotY !== 0) q.setFromEuler(eul.set(0, rotY, 0)); else q.identity();
    m4.compose(new THREE.Vector3(x, y + h / 2, z), q, new THREE.Vector3(w, h, d));
    boxes.setMatrixAt(bn, m4); tc.setHex(color); boxes.setColorAt(bn, tc); bn++;
  };
  const pal = [0xf3efe6, 0xe9e2d3, 0xd9d4c8, 0xf6f0e0, 0xc9b8a0, 0xe8ddd0, 0xb9c4cc];
  const roofPal = [0x42484f, 0x5e4f42, 0x364352, 0x6c382d, 0x52575d, 0x2b3638];
  const house = (x, y, z, w, h, d, rotY = 0) => {
    addBox(x, y, z, w, h, d, pal[(rnd() * pal.length) | 0], rotY);
    addBox(x, y + h, z, w + 0.8, 0.85, d + 0.8, roofPal[(rnd() * roofPal.length) | 0], rotY);
  };

  // 1) 江の島北西〜北東岸の老舗旅館・ホテル・商店群 (南側の海食崖には一切はみ出させず、実際の北岸護岸〜参道麓に整然と配置)
  const innColors = [0xf5f0e6, 0xebe3d3, 0xe2d9c8, 0xf8f4ec, 0xdcd3c2];
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const ix = ISLAND.x - 340 + t * 410 + (rnd() - 0.5) * 8;
    const iz = ISLAND.z - 125 - Math.sin(t * Math.PI) * 58 + (rnd() - 0.5) * 10;
    const ih = Math.max(2.6, islandH(ix, iz));
    if (ih > 14) continue;
    const w = 13 + rnd() * 9, d = 10 + rnd() * 7, bh = 8.5 + rnd() * 6.5;
    const ry = -0.18 + t * 0.35;
    const cWall = innColors[i % innColors.length];
    addBox(ix, ih - 0.8, iz, w, bh, d, cWall, ry);
    // 旅館の横連窓・バルコニー帯と瓦風ダークスレート屋根
    addBox(ix, ih + bh * 0.42, iz, w + 0.5, 1.4, d + 0.5, 0x3b4754, ry);
    addBox(ix, ih + bh * 0.74, iz, w + 0.5, 1.4, d + 0.5, 0x3b4754, ry);
    addBox(ix, ih + bh - 0.8, iz, w + 1.4, 1.2, d + 1.4, i % 3 === 0 ? 0x2f3b44 : 0x474a4f, ry);
  }
  // 弁財天仲見世通りの参道両側に階段状に連なる土産物店・食事処の町家列
  for (let s = 0; s < 11; s++) {
    const f = s / 10;
    const cx = ISLAND.x - 305 + f * 145;
    const cz = ISLAND.z - 135 + f * 48;
    const ch = Math.max(3.0, islandH(cx, cz));
    for (const side of [-1, 1]) {
      const sx = cx - side * 3.2, sz = cz + side * 8.5;
      const bw = 9.5 + rnd() * 3.5, bd = 7.5 + rnd() * 2.5, bh = 5.2 + rnd() * 2.6;
      addBox(sx, ch - 0.6, sz, bw, bh, bd, s % 2 === 0 ? 0xefe7d6 : 0xe4d7c3, 0.32);
      addBox(sx, ch + bh - 0.6, sz, bw + 1.1, 0.9, bd + 1.1, 0x363c42, 0.32);
    }
  }
  // 北東麓〜湘南港付け根(北緑地背後の低地)の低層建物群 (z < ISLAND.z - 55 に厳密限定)
  for (let tries = 0, k = 0; tries < 5000 && k < 95; tries++) {
    const x = ISLAND.x - 330 + rnd() * 445, z = ISLAND.z - 215 + rnd() * 155;
    const h = islandH(x, z);
    if (h < 2.4 || h > 13.5) continue;
    house(x, h - 0.5, z, 7.5 + rnd() * 8.5, 5.2 + rnd() * 5.5, 7.5 + rnd() * 8.5, (rnd() - 0.5) * 0.4);
    k++;
  }

  // 2) 海岸の街並み(片瀬江ノ島駅周辺・鵠沼・腰越・藤沢): 風致地区らしい2〜3階建て低層中心＋R134沿いの中層マンション(4〜5階程度)に抑える
  for (let k = 0; k < 1350; k++) {
    const x = -9000 + rnd() * 12400, z = COAST_Z - 165 - Math.pow(rnd(), 1.25) * 1650;
    const h = landH(x, z); if (h < 1.5 || h > 42) continue;
    const nearKatase = Math.abs(x + 150) < 1500 && z > COAST_Z - 950;
    const midRise = rnd() < (nearKatase ? 0.10 : 0.12);
    const bh = nearKatase
      ? (midRise ? 9.5 + rnd() * 4.5 : 4.5 + rnd() * 4.0)
      : (midRise ? 10.5 + rnd() * 6.0 : 5.0 + rnd() * 4.5);
    house(x, h - 0.5, z, 8 + rnd() * 13, bh, 8 + rnd() * 13);
  }
  boxes.count = bn; q.identity(); enoshimaGroup.add(boxes);

  // 3) 江島神社 (青銅の鳥居・竜宮造りの瑞心門・辺津宮・朱塗りの中津宮・奥津宮) & 稚児ヶ淵の遊歩道・べんてん丸船着場
  {
    const enoLandmarks = new THREE.Group();
    const vermilion = new THREE.MeshLambertMaterial({ color: 0xc93829 });
    const plasterWhite = new THREE.MeshLambertMaterial({ color: 0xf4f1ea });
    const kawaraMat = new THREE.MeshLambertMaterial({ color: 0x2d353b });
    const bronzePatina = new THREE.MeshLambertMaterial({ color: 0x4d7365 });
    const stoneStepMat = new THREE.MeshLambertMaterial({ color: 0xbab5aa });

    // (a) 参道入口「青銅の鳥居」(緑青を帯びた歴史ある青銅色)
    const btX = ISLAND.x - 312, btZ = ISLAND.z - 138, btY = Math.max(2.8, islandH(btX, btZ));
    const btGrp = new THREE.Group();
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 8.8, 8), bronzePatina);
      p.position.set(s * 3.5, 4.4, 0); btGrp.add(p);
    }
    const kasagi = new THREE.Mesh(new THREE.BoxGeometry(10.6, 0.78, 1.1), bronzePatina); kasagi.position.y = 8.9; btGrp.add(kasagi);
    const nuki = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.58, 0.8), bronzePatina); nuki.position.y = 7.0; btGrp.add(nuki);
    btGrp.position.set(btX, btY, btZ); btGrp.rotation.y = 0.35; enoLandmarks.add(btGrp);

    // (b) 大石段と竜宮城を模した楼門「瑞心門」(白漆喰の城壁基壇＋朱塗りの上層楼閣＋入母屋瓦屋根)
    const zmX = ISLAND.x - 165, zmZ = ISLAND.z - 92, zmY = Math.max(9.0, islandH(zmX, zmZ));
    const steps = new THREE.Mesh(new THREE.BoxGeometry(7.5, 4.2, 18), stoneStepMat);
    steps.position.set(zmX - 10, zmY - 1.5, zmZ - 6); steps.rotation.y = 0.32; steps.rotation.x = -0.22; enoLandmarks.add(steps);
    const zmBase = new THREE.Mesh(new THREE.BoxGeometry(11.5, 5.2, 8.2), plasterWhite);
    zmBase.position.set(zmX, zmY + 2.2, zmZ); zmBase.rotation.y = 0.32; enoLandmarks.add(zmBase);
    const zmUpper = new THREE.Mesh(new THREE.BoxGeometry(9.6, 4.4, 6.8), vermilion);
    zmUpper.position.set(zmX, zmY + 6.8, zmZ); zmUpper.rotation.y = 0.32; enoLandmarks.add(zmUpper);
    const zmRoof = new THREE.Mesh(new THREE.ConeGeometry(8.8, 4.0, 4), kawaraMat);
    zmRoof.position.set(zmX, zmY + 10.8, zmZ); zmRoof.rotation.y = Math.PI / 4 + 0.32; enoLandmarks.add(zmRoof);

    // (c) 江島神社「辺津宮」(北側中腹の社殿) &「中津宮」(北東斜面から緑の中に映える朱塗りの社殿)
    const sx = ISLAND.x - 122, sz = ISLAND.z - 84, sh = islandH(sx, sz);
    const shrine = new THREE.Mesh(new THREE.BoxGeometry(17, 6.8, 13), vermilion);
    shrine.position.set(sx, sh + 3.0, sz); shrine.rotation.y = 0.22; enoLandmarks.add(shrine);
    const sroof = new THREE.Mesh(new THREE.ConeGeometry(14.5, 5.4, 4), kawaraMat);
    sroof.rotation.y = Math.PI / 4 + 0.22; sroof.position.set(sx, sh + 9.0, sz); enoLandmarks.add(sroof);

    const nx = ISLAND.x + 18, nz = ISLAND.z - 76, nh = islandH(nx, nz);
    const naka = new THREE.Mesh(new THREE.BoxGeometry(13, 5.8, 10), vermilion);
    naka.position.set(nx, nh + 2.5, nz); naka.rotation.y = -0.18; enoLandmarks.add(naka);
    const nakaRoof = new THREE.Mesh(new THREE.ConeGeometry(11, 4.5, 4), kawaraMat);
    nakaRoof.rotation.y = Math.PI / 4 - 0.18; nakaRoof.position.set(nx, nh + 7.4, nz); enoLandmarks.add(nakaRoof);

    // (d) 西側の「稚児ヶ淵」(隆起波食台)に伸びる海辺のコンクリート遊歩道・べんてん丸船着場・海食岩礁ブロック
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x6f6659 });
    const walkMat = new THREE.MeshLambertMaterial({ color: 0xd1cdc4 });
    // べんてん丸渡船桟橋 (稚児ヶ淵西端)
    const pier = new THREE.Mesh(new THREE.BoxGeometry(42, 2.2, 6.5), walkMat);
    pier.position.set(ISLAND.x - 498, 1.3, ISLAND.z + 58); pier.rotation.y = 0.28; enoLandmarks.add(pier);
    // 海食崖足元を縫う稚児ヶ淵〜岩屋連絡遊歩道と手すり柱
    for (let i = 0; i < 7; i++) {
      const wx = ISLAND.x - 470 + i * 32;
      const wz = ISLAND.z + 78 + Math.sin(i * 0.55) * 18;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(34, 1.5, 3.6), walkMat);
      seg.position.set(wx, 2.2, wz); seg.rotation.y = -0.15 + Math.cos(i * 0.55) * 0.18;
      enoLandmarks.add(seg);
    }
    // 稚児ヶ淵〜山二つ下の波食棚に点在する海食奇岩・岩礁マウンド
    for (const [rx, rz, rw, rh] of [
      [-455, 118, 18, 3.2], [-410, 134, 22, 2.8], [-355, 138, 16, 3.6],
      [-285, 128, 19, 4.2], [-135, 136, 15, 3.4], [-72, 132, 17, 3.0], [15, 124, 14, 2.6],
    ]) {
      const rk = new THREE.Mesh(new THREE.CylinderGeometry(rw * 0.55, rw, rh, 7), rockMat);
      rk.position.set(ISLAND.x + rx, rh * 0.35, ISLAND.z + rz);
      rk.rotation.y = rx * 0.03;
      enoLandmarks.add(rk);
    }
    // 北西〜北岸を縁取る護岸プロムナード擁壁
    const northWall = new THREE.Mesh(new THREE.BoxGeometry(430, 3.4, 10), stoneStepMat);
    northWall.position.set(ISLAND.x - 135, 1.3, ISLAND.z - 168);
    northWall.rotation.y = 0.08;
    enoLandmarks.add(northWall);

    enoshimaGroup.add(enoLandmarks);
  }

  // 4) 江の島シーキャンドル(展望灯台) & サムエル・コッキング苑:
  // 実物の特徴である「白い逆円錐ラチストラス(斜め格子ブレース)＋中央エレベーターシャフト＋青ガラス展望室＋屋外展望デッキ＋避雷針スパイア」を精密再現
  const topH = islandH(lhx, lhz);
  const lh = new THREE.Group();
  const towerM = new THREE.MeshLambertMaterial({ color: 0xf8f7f3, emissive: 0x1e232b });
  const frameM = new THREE.MeshLambertMaterial({ color: 0xe6e4dc, emissive: 0x171b22 });
  const brickM = new THREE.MeshLambertMaterial({ color: 0x9c5543 });
  const gardenStoneM = new THREE.MeshLambertMaterial({ color: 0xd8d2c5 });
  // サムエル・コッキング苑の円形石畳プラザ・白パーゴラ・歴史的赤レンガ温室遺構
  const basePlaza = new THREE.Mesh(new THREE.CylinderGeometry(14.5, 16.5, 3.0, 24), gardenStoneM);
  basePlaza.position.y = 1.5; lh.add(basePlaza);
  const cockingBrick = new THREE.Mesh(new THREE.BoxGeometry(14, 3.6, 8.5), brickM);
  cockingBrick.position.set(-15, 2.4, 8); cockingBrick.rotation.y = 0.35; lh.add(cockingBrick);
  const pergola = new THREE.Mesh(new THREE.BoxGeometry(12, 3.2, 7.5), towerM);
  pergola.position.set(14, 2.5, 7); pergola.rotation.y = -0.25; lh.add(pergola);
  const baseGlass = new THREE.Mesh(new THREE.CylinderGeometry(6.8, 7.4, 3.4, 20), new THREE.MeshLambertMaterial({ color: 0x7ca6bf, emissive: 0x182c3a }));
  baseGlass.position.y = 4.6; lh.add(baseGlass);

  // 中央エレベーターコアシャフト (外周トラス越しに透けて見える細身の白い円筒コア)
  const coreShaft = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.35, 38.5, 16), new THREE.MeshLambertMaterial({ color: 0xdce4ec, emissive: 0x18222d }));
  coreShaft.position.y = 22.8; lh.add(coreShaft);

  // 外周12本の傾斜メイン支柱 + 4段の水平リング + 双曲面斜め格子(ラチス)ブレース
  const rBotT = 6.1, rTopT = 3.55, yBotT = 5.8, yTopT = 41.2, spanH = yTopT - yBotT;
  const addStrut = (x1, y1, z1, x2, y2, z2, thick, mat) => {
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.hypot(dx, dy, dz);
    const m = new THREE.Mesh(new THREE.BoxGeometry(thick, len, thick), mat);
    m.position.set((x1 + x2) * 0.5, (y1 + y2) * 0.5, (z1 + z2) * 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
    lh.add(m);
  };
  const NCOL = 12;
  for (let i = 0; i < NCOL; i++) {
    const a = (i / NCOL) * Math.PI * 2;
    addStrut(Math.cos(a) * rBotT, yBotT, Math.sin(a) * rBotT, Math.cos(a) * rTopT, yTopT, Math.sin(a) * rTopT, 0.52, towerM);
  }
  const NTIER = 5;
  for (let ti = 0; ti <= NTIER; ti++) {
    const f0 = ti / NTIER;
    const y0 = yBotT + spanH * f0;
    const r0 = rBotT + (rTopT - rBotT) * f0;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(r0, r0, 0.46, 20, 1, true), frameM);
    ring.position.y = y0; lh.add(ring);
    if (ti < NTIER) {
      const f1 = (ti + 1) / NTIER;
      const y1 = yBotT + spanH * f1;
      const r1 = rBotT + (rTopT - rBotT) * f1;
      for (let i = 0; i < NCOL; i++) {
        const a0 = (i / NCOL) * Math.PI * 2;
        const a1 = ((i + 1) / NCOL) * Math.PI * 2;
        const aPrev = ((i - 1 + NCOL) / NCOL) * Math.PI * 2;
        addStrut(Math.cos(a0) * r0, y0, Math.sin(a0) * r0, Math.cos(a1) * r1, y1, Math.sin(a1) * r1, 0.34, frameM);
        addStrut(Math.cos(a0) * r0, y0, Math.sin(a0) * r0, Math.cos(aPrev) * r1, y1, Math.sin(aPrev) * r1, 0.34, frameM);
      }
    }
  }
  // 逆円錐状に広がるガラス張り屋内展望フロア＆屋外スカイデッキ
  const deckLower = new THREE.Mesh(new THREE.CylinderGeometry(5.8, 3.55, 2.2, 24), towerM);
  deckLower.position.y = 42.2; lh.add(deckLower);
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(6.9, 5.8, 5.0, 24), new THREE.MeshLambertMaterial({ color: 0x7fb4d4, emissive: 0x203c52 }));
  deck.position.y = 45.8; lh.add(deck);
  const deckRoof = new THREE.Mesh(new THREE.CylinderGeometry(7.8, 7.2, 1.0, 24), towerM);
  deckRoof.position.y = 48.8; lh.add(deckRoof);
  const openDeck = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.5, 2.1, 20), frameM);
  openDeck.position.y = 50.3; lh.add(openDeck);
  // 灯室(ランタン)と避雷針スパイア(全高約59.8m)
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(2.15, 2.15, 3.8, 16), new THREE.MeshLambertMaterial({ color: 0xfff8d6, emissive: 0x947d34 }));
  lantern.position.y = 53.2; lh.add(lantern);
  const lanternCap = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.7, 16), towerM);
  lanternCap.position.y = 55.9; lh.add(lanternCap);
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.52, 6.8, 10), new THREE.MeshLambertMaterial({ color: 0xd8dee6, emissive: 0x242930 }));
  spire.position.y = 59.8; lh.add(spire);
  lh.position.set(lhx, topH - 1.0, lhz); enoshimaGroup.add(lh);

  // 5) 江の島弁天橋(歩道橋) & 江の島大橋(車道橋): 片瀬洲鼻から江の島北西入口へ平行して架かる2本の連絡橋
  const bx1 = ISLAND.x - 356, bz1 = ISLAND.z - 108;
  const bx2 = ISLAND.x - 576, bz2 = -(COAST + 70);
  const bmx = (bx1 + bx2) / 2, bmz = (bz1 + bz2) / 2;
  const blen = Math.hypot(bx2 - bx1, bz2 - bz1);
  const bAng = Math.atan2(bx2 - bx1, bz2 - bz1);
  const bCos = Math.cos(bAng), bSin = Math.sin(bAng);
  addTori(enoshimaGroup, bx1 + 26, Math.max(2.6, islandH(bx1 + 26, bz1 + 14)) + 0.2, bz1 + 14);
  // 西側: 江の島弁天橋(歩道・やや細身) / 東側(+19m並行): 江の島大橋(2車線道路橋)
  const bentenBridge = new THREE.Mesh(new THREE.BoxGeometry(6.8, 1.5, blen), new THREE.MeshLambertMaterial({ color: 0xdedad0 }));
  bentenBridge.position.set(bmx - 8 * bCos, 4.5, bmz + 8 * bSin); bentenBridge.rotation.y = bAng; enoshimaGroup.add(bentenBridge);
  const ohashiBridge = new THREE.Mesh(new THREE.BoxGeometry(12.5, 1.9, blen + 12), new THREE.MeshLambertMaterial({ color: 0xcfcac0 }));
  ohashiBridge.position.set(bmx + 11 * bCos, 5.1, bmz - 11 * bSin); ohashiBridge.rotation.y = bAng; enoshimaGroup.add(ohashiBridge);
  const np = Math.floor(blen / 34);
  const piers = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 6.8, 2.2), new THREE.MeshLambertMaterial({ color: 0x8a8882 }), np * 4);
  let pIdx = 0;
  for (let i = 0; i < np; i++) {
    const t = (i + 0.5) / np;
    const px = bx1 + (bx2 - bx1) * t, pz = bz1 + (bz2 - bz1) * t;
    for (const off of [-10.2, -5.8, 7.2, 14.8]) {
      m4.compose(new THREE.Vector3(px + off * bCos, 0.9, pz - off * bSin), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), bAng), new THREE.Vector3(1, 1, 1));
      piers.setMatrixAt(pIdx++, m4);
    }
  }
  piers.count = pIdx;
  enoshimaGroup.add(piers);

  // ===== 江の島ヨットハーバー (湘南港): 島の東〜南東側(レース海面から正面に見える位置)に広がるリアルなオリンピックハーバー =====
  const yhGroup = new THREE.Group();
  const hx = ISLAND.x + 210, hz = ISLAND.z + 35;
  const conc = new THREE.MeshLambertMaterial({ color: 0xd6d3cb });
  const concDark = new THREE.MeshLambertMaterial({ color: 0x9ca3af });
  const brk = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
  const tetraMat = new THREE.MeshLambertMaterial({ color: 0x7d8590 });
  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x0369a1, emissive: 0x0c4a6e });
  const woodMat = new THREE.MeshLambertMaterial({ color: 0xb0865c });

  // 1) ディンギーパーク広大埋立地エプロン & 北緑地プロムナード・駐車場区画
  const mainApron = new THREE.Mesh(new THREE.BoxGeometry(316, 3.6, 236), conc);
  mainApron.position.set(hx + 22, 1.2, hz - 10); yhGroup.add(mainApron);
  const apronEdge = new THREE.Mesh(new THREE.BoxGeometry(320, 1.2, 5.5), concDark);
  apronEdge.position.set(hx + 22, 2.8, hz + 106); yhGroup.add(apronEdge);
  const northApron = new THREE.Mesh(new THREE.BoxGeometry(265, 3.8, 142), new THREE.MeshLambertMaterial({ color: 0xcad2dc }));
  northApron.position.set(hx - 15, 1.3, hz - 185); yhGroup.add(northApron);
  // 泊地へ緩やかに降りるディンギー出艇コンクリートスロープ (2面)
  for (const sz of [hz - 56, hz + 34]) {
    const slip = new THREE.Mesh(new THREE.BoxGeometry(52, 1.6, 72), new THREE.MeshLambertMaterial({ color: 0xb5b1a6 }));
    slip.position.set(hx + 194, 0.55, sz);
    slip.rotation.z = -0.065;
    yhGroup.add(slip);
  }

  // 2) 江の島ヨットハウス (クラブハウス: 特徴的な白い大波型うねりルーフ・大庇・全面ガラスカーテンウォール・2階展望デッキ)
  const yhX = hx - 12, yhZ = hz - 22;
  const yhBody = new THREE.Mesh(new THREE.BoxGeometry(92, 9.2, 38), whiteMat);
  yhBody.position.set(yhX, 7.4, yhZ); yhGroup.add(yhBody);
  const yhGlass = new THREE.Mesh(new THREE.BoxGeometry(88, 6.8, 40.2), glassMat);
  yhGlass.position.set(yhX, 7.6, yhZ + 0.8); yhGroup.add(yhGlass);
  const yhBalcony = new THREE.Mesh(new THREE.BoxGeometry(98, 1.1, 11), whiteMat);
  yhBalcony.position.set(yhX, 7.8, yhZ + 22); yhGroup.add(yhBalcony);
  // 4連の滑らかな白い波型シェルルーフで実際の江の島ヨットハウスの優美な屋根線を再現 (+Z を上向き +Y へ起こすため rotation.x = -PI/2)
  const shellMat = new THREE.MeshLambertMaterial({ color: 0xf8fafc, side: THREE.DoubleSide });
  for (let w = -1.5; w <= 1.5; w += 1.0) {
    const waveRoof = new THREE.Mesh(new THREE.CylinderGeometry(15.5, 15.5, 44, 18, 1, true, -Math.PI * 0.38, Math.PI * 0.76), shellMat);
    waveRoof.rotation.x = -Math.PI / 2;
    waveRoof.scale.set(0.86, 1.0, 0.34);
    waveRoof.position.set(yhX + w * 22.5, 10.2 + ((w + 1.5) % 2) * 0.5, yhZ + 1.5);
    yhGroup.add(waveRoof);
  }
  // センタープロムナードのウッドデッキ＆さざえ島(石積み段丘と芝・松のある親水小丘、単なる円錐ではなく段状のリアル造形)
  const woodDeck = new THREE.Mesh(new THREE.BoxGeometry(150, 1.2, 26), woodMat);
  woodDeck.position.set(yhX + 36, 3.35, yhZ + 34); yhGroup.add(woodDeck);
  const szX = hx + 122, szZ = hz + 80;
  const sazaeBase = new THREE.Mesh(new THREE.CylinderGeometry(28, 33, 4.2, 16), new THREE.MeshLambertMaterial({ color: 0x9b9283 }));
  sazaeBase.position.set(szX, 4.6, szZ); yhGroup.add(sazaeBase);
  const sazaeMid = new THREE.Mesh(new THREE.CylinderGeometry(19, 25, 3.6, 16), new THREE.MeshLambertMaterial({ color: 0xa89f8f }));
  sazaeMid.position.set(szX - 2, 7.9, szZ + 1); yhGroup.add(sazaeMid);
  const sazaeLawn = new THREE.Mesh(new THREE.CylinderGeometry(14, 18.5, 2.4, 16), new THREE.MeshLambertMaterial({ color: 0x2f5e32 }));
  sazaeLawn.position.set(szX - 2, 10.2, szZ + 1); yhGroup.add(sazaeLawn);

  // 湘南港本館(ポートハウス・白い船型デザインの管理棟と管制塔)
  const portHouse = new THREE.Mesh(new THREE.BoxGeometry(48, 13, 30), whiteMat);
  portHouse.position.set(hx + 78, 9.2, hz - 96); yhGroup.add(portHouse);
  const portWin = new THREE.Mesh(new THREE.BoxGeometry(49.2, 4.2, 26), glassMat);
  portWin.position.set(hx + 78, 11.2, hz - 96); yhGroup.add(portWin);
  const portTower = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 6.4, 21, 14), whiteMat);
  portTower.position.set(hx + 96, 13.5, hz - 85); yhGroup.add(portTower);
  const portGlass = new THREE.Mesh(new THREE.CylinderGeometry(6.0, 6.0, 4.0, 14), glassMat);
  portGlass.position.set(hx + 96, 21.8, hz - 85); yhGroup.add(portGlass);

  // 3) 泊地を囲む長大な南防波堤(外海側に消波テトラポッド帯を完備)・東防波堤と、先端の白い「湘南港灯台(江の島白灯台)」
  const southBrk = new THREE.Mesh(new THREE.BoxGeometry(375, 5.2, 13), brk);
  southBrk.position.set(hx + 272, 2.1, hz + 125); yhGroup.add(southBrk);
  const southParapet = new THREE.Mesh(new THREE.BoxGeometry(372, 1.8, 3.2), conc);
  southParapet.position.set(hx + 272, 5.2, hz + 129); yhGroup.add(southParapet);
  // 南防波堤の沖側足元に連なるリアルな消波ブロック(テトラポッド)群
  const tetras = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(2.6, 0), tetraMat, 130);
  for (let i = 0; i < 130; i++) {
    const tx = hx + 92 + (i / 130) * 352 + (rnd() - 0.5) * 4;
    const tz = hz + 133.5 + (i % 2) * 3.8 + (rnd() - 0.5) * 1.8;
    q.setFromEuler(eul.set(rnd() * 3.1, rnd() * 6.2, rnd() * 3.1));
    m4.compose(new THREE.Vector3(tx, 1.1 + (1 - (i % 2)) * 1.1, tz), q, new THREE.Vector3(1.15, 0.95, 1.15));
    tetras.setMatrixAt(i, m4);
  }
  q.identity();
  yhGroup.add(tetras);

  // 東防波堤 & 北防波堤
  const eastBrk = new THREE.Mesh(new THREE.BoxGeometry(14, 5.2, 282), brk);
  eastBrk.position.set(hx + 452, 2.0, hz - 24); yhGroup.add(eastBrk);
  const northBrk = new THREE.Mesh(new THREE.BoxGeometry(292, 4.8, 12), brk);
  northBrk.position.set(hx + 306, 1.8, hz - 165); yhGroup.add(northBrk);
  // 防波堤先端の象徴的な白い「湘南港灯台」(フレア状の白塔・縦リブ・展望バルコニー・灯室)
  const hLighthouse = new THREE.Group();
  const hlPed = new THREE.Mesh(new THREE.CylinderGeometry(4.8, 5.6, 3.6, 16), conc); hlPed.position.y = 2.8; hLighthouse.add(hlPed);
  const hlBase = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 4.4, 4.8, 16), whiteMat); hlBase.position.y = 6.8; hLighthouse.add(hlBase);
  const hlBody = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 3.2, 14.5, 16), whiteMat); hlBody.position.y = 16.2; hLighthouse.add(hlBody);
  const hlGallery = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 2.6, 1.6, 16), whiteMat); hlGallery.position.y = 23.8; hLighthouse.add(hlGallery);
  const hlRail = new THREE.Mesh(new THREE.CylinderGeometry(3.45, 3.45, 0.9, 16, 1, true), concDark); hlRail.position.y = 25.0; hLighthouse.add(hlRail);
  const hlLamp = new THREE.Mesh(new THREE.CylinderGeometry(1.65, 1.65, 2.6, 12), new THREE.MeshBasicMaterial({ color: 0xeaffd0 })); hlLamp.position.y = 25.8; hLighthouse.add(hlLamp);
  const hlCap = new THREE.Mesh(new THREE.ConeGeometry(2.0, 1.4, 12), whiteMat); hlCap.position.y = 27.8; hLighthouse.add(hlCap);
  hLighthouse.position.set(hx + 452, 1.2, hz + 122);
  yhGroup.add(hLighthouse);

  // 4) 泊地内の浮桟橋(ポンツーン)と係留クルーザー群
  for (let p = 0; p < 5; p++) {
    const pz = hz - 110 + p * 44;
    const pontoon = new THREE.Mesh(new THREE.BoxGeometry(190, 1.0, 3.2), concDark);
    pontoon.position.set(hx + 305, 0.6, pz); yhGroup.add(pontoon);
  }
  const mastsG = new THREE.CylinderGeometry(0.16, 0.16, 12, 5);
  const hulls = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 1.1, 7.5), new THREE.MeshLambertMaterial({ color: 0xffffff }), 72);
  const masts = new THREE.InstancedMesh(mastsG, new THREE.MeshLambertMaterial({ color: 0xcfd3d8 }), 72);
  for (let i = 0; i < 72; i++) {
    const x = hx + 225 + (i % 12) * 15 + (rnd() - 0.5) * 1.5, z = hz - 105 + Math.floor(i / 12) * 38 + (rnd() - 0.5) * 2;
    m4.makeTranslation(x, 0.65, z); hulls.setMatrixAt(i, m4); tc.setHSL(rnd(), 0.25, 0.88); hulls.setColorAt(i, tc);
    m4.makeTranslation(x, 6.8, z); masts.setMatrixAt(i, m4);
  }
  yhGroup.add(hulls, masts);

  // 5) ディンギーパークにずらりと並ぶスナイプ/470等の小型ヨット群 (140艇)
  const dh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.5, 4.7), new THREE.MeshLambertMaterial(), 140);
  const dm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, 6.8, 4), new THREE.MeshLambertMaterial({ color: 0xd8dde3 }), 140);
  for (let i = 0; i < 140; i++) {
    const colIdx = i % 14, rowIdx = Math.floor(i / 14);
    const x = hx - 95 + colIdx * 18 + (rnd() - 0.5) * 2, z = hz - 75 + rowIdx * 16 + (rnd() - 0.5) * 2;
    m4.makeTranslation(x, 3.2, z); dh.setMatrixAt(i, m4); tc.setHSL(rnd(), 0.55, 0.72 + rnd() * 0.22); dh.setColorAt(i, tc);
    m4.makeTranslation(x, 6.6, z - 0.6); dm.setMatrixAt(i, m4);
  }
  yhGroup.add(dh, dm);
  enoshimaGroup.add(yhGroup);

  // 6) 江の島周辺・腰越・片瀬沖の漁船(スパンカー帆付き小型漁船)と大型クルーザー・外洋ヨット群 (海面上をゆっくり移動する演出付き)
  const movingShips = [];
  const enoShips = new THREE.Group();
  enoShips.userData.noBake = true;
  const enoWhite = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const enoBlue = new THREE.MeshLambertMaterial({ color: 0x0284c7 });
  const enoNavy = new THREE.MeshLambertMaterial({ color: 0x1e3a8a });
  const enoDark = new THREE.MeshLambertMaterial({ color: 0x1e293b });
  const enoTeak = new THREE.MeshLambertMaterial({ color: 0xb48a60 });
  const enoGlass = new THREE.MeshLambertMaterial({ color: 0x0ea5e9, emissive: 0x0c4a6e });
  // (6-a) 腰越・片瀬・江の島沖のシラス漁船・釣り船 (白い船体・青ライン・船尾スパンカー帆)
  const enoFishCoords = [
    [620, -480, 0.65], [960, -360, -0.45], [1180, -640, 1.15],
    [-460, -520, 0.35], [-740, -680, -0.85], [-580, 260, 0.9],
    [540, 480, -1.2], [860, 220, 0.25], [-420, 560, 1.6]
  ];
  for (let fi = 0; fi < enoFishCoords.length; fi++) {
    const [fx, fz, fry] = enoFishCoords[fi];
    const fg = new THREE.Group();
    const fh = new THREE.Mesh(new THREE.BoxGeometry(3.5, 1.3, 11.5), enoWhite);
    fh.position.y = 0.55; fg.add(fh);
    const fb = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.38, 11.6), enoBlue);
    fb.position.y = 1.15; fg.add(fb);
    const fc = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.0, 3.4), enoWhite);
    fc.position.set(0, 2.0, -0.4); fg.add(fc);
    const fWin = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.65, 1.8), enoGlass);
    fWin.position.set(0, 2.35, 0.3); fg.add(fWin);
    const spanker = new THREE.Mesh(new THREE.ConeGeometry(1.55, 4.2, 3), enoWhite);
    spanker.position.set(0, 3.5, -4.1); fg.add(spanker);
    fg.position.set(fx, 0, fz); fg.rotation.y = fry;
    enoShips.add(fg);
    movingShips.push({ obj: fg, x0: fx, z0: fz, ry: fry, speed: 0.75 + (fi % 3) * 0.25, range: 130 + (fi % 4) * 35, ph: fi * 1.3 });
  }
  // (6-b) 湘南港・相模湾を航行する大型モータークルーザー & 大型外洋セーリングクルーザー
  const enoCruiserConfigs = [
    { x: 740, z: -210, ry: -0.35, scale: 1.25, col: 0xf8fafc, stripe: 0x1e3a8a, sail: false },
    { x: -520, z: -240, ry: 0.55, scale: 1.35, col: 0x1e293b, stripe: 0x38bdf8, sail: false },
    { x: 640, z: 160, ry: 2.35, scale: 1.18, col: 0xf8fafc, stripe: 0x0284c7, sail: true },
    { x: -640, z: -40, ry: -0.75, scale: 1.28, col: 0xf1f5f9, stripe: 0xdc2626, sail: true },
    { x: 1080, z: -80, ry: -1.1, scale: 1.45, col: 0xf8fafc, stripe: 0x0f172a, sail: false },
    { x: 380, z: 640, ry: 0.18, scale: 1.22, col: 0xf8fafc, stripe: 0x2563eb, sail: true },
  ];
  for (let ci = 0; ci < enoCruiserConfigs.length; ci++) {
    const cc = enoCruiserConfigs[ci];
    const cg = new THREE.Group();
    const hullMat = new THREE.MeshLambertMaterial({ color: cc.col });
    const strMat = new THREE.MeshLambertMaterial({ color: cc.stripe });
    // 船体 (全長約20〜26m級の大型ラグジュアリークルーザー)
    const hull = new THREE.Mesh(new THREE.BoxGeometry(5.6, 2.4, 21.0), hullMat);
    hull.position.y = 1.0; cg.add(hull);
    const bow = new THREE.Mesh(new THREE.ConeGeometry(3.96, 6.8, 4), hullMat);
    bow.rotation.x = Math.PI / 2; bow.rotation.y = Math.PI / 4;
    bow.scale.set(1, 0.62, 1); bow.position.set(0, 1.05, 13.8); cg.add(bow);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(5.72, 0.42, 21.2), strMat);
    stripe.position.y = 1.85; cg.add(stripe);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.3, 20.0), enoTeak);
    deck.position.y = 2.25; cg.add(deck);
    if (cc.sail) {
      // 大型外洋セーリングクルーザー(45〜55ft級: キャビン＋高いマスト＆メイン・ジブセール)
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.3, 8.5), enoWhite);
      cabin.position.set(0, 2.8, 1.2); cg.add(cabin);
      const cWin = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.55, 6.2), enoGlass);
      cWin.position.set(0, 3.0, 1.4); cg.add(cWin);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 24.0, 8), enoWhite);
      mast.position.set(0, 14.0, 2.5); cg.add(mast);
      const mainSail = new THREE.Mesh(new THREE.ConeGeometry(4.2, 20.0, 3), new THREE.MeshLambertMaterial({ color: 0xf8fafc, side: THREE.DoubleSide }));
      mainSail.position.set(0, 13.5, -1.2); mainSail.scale.set(0.12, 1, 1.35); cg.add(mainSail);
      const jibSail = new THREE.Mesh(new THREE.ConeGeometry(3.5, 17.5, 3), new THREE.MeshLambertMaterial({ color: 0xf1f5f9, side: THREE.DoubleSide }));
      jibSail.position.set(0, 12.0, 7.6); jibSail.scale.set(0.12, 1, 1.15); cg.add(jibSail);
    } else {
      // フライブリッジ付き大型モータークルーザー (サロンクルーザー)
      const salon = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.2, 11.5), enoWhite);
      salon.position.set(0, 3.3, -0.5); cg.add(salon);
      const sWin = new THREE.Mesh(new THREE.BoxGeometry(4.72, 1.1, 9.8), enoGlass);
      sWin.position.set(0, 3.5, 0.2); cg.add(sWin);
      const fly = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.4, 6.8), enoWhite);
      fly.position.set(0, 5.0, -1.2); cg.add(fly);
      const radarArch = new THREE.Mesh(new THREE.BoxGeometry(3.9, 1.8, 1.2), enoWhite);
      radarArch.position.set(0, 6.2, -3.2); cg.add(radarArch);
      const hardTop = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.3, 6.2), enoWhite);
      hardTop.position.set(0, 7.1, -1.2); cg.add(hardTop);
    }
    cg.scale.setScalar(cc.scale);
    cg.position.set(cc.x, 0, cc.z);
    cg.rotation.y = cc.ry;
    enoShips.add(cg);
    movingShips.push({ obj: cg, x0: cc.x, z0: cc.z, ry: cc.ry, speed: 1.25 + (ci % 3) * 0.35, range: 210 + (ci % 3) * 50, ph: ci * 2.1 });
  }
  enoshimaGroup.add(enoShips);

  // ===== 2. 八景島ステージ (横浜・八景島シーパラダイス沖) =====
  buildHakkeijima(hakkeijimaGroup, surfStrip, fgeo, movingShips);

  // 実地調査に基づく周辺景観の追加 → 静的メッシュをマテリアル特性ごとに結合してドローコールを大幅削減
  addEnoshimaScenery(enoshimaGroup, surfStrip);
  addHakkeiScenery(hakkeijimaGroup, movingShips);
  bakeStatic(enoshimaGroup);
  bakeStatic(hakkeijimaGroup);

  // ---------- マーク類 (実艇画像5枚目準拠: 全マーク統一の光沢オレンジPVCインフレータブル円錐ティアドロップ型ブイ) ----------
  const bob = [];
  const markObjs = {};
  let _unifiedBuoyGeo = null;
  let _unifiedBuoyMat = null;
  const getUnifiedBuoyAssets = () => {
    if (_unifiedBuoyGeo && _unifiedBuoyMat) return { geo: _unifiedBuoyGeo, mat: _unifiedBuoyMat };
    // 1) プロファイル: 下部がふっくら膨らみ、上に向かって滑らかな円錐状に絞られる実物インフレータブルブイ形状 (高さ約2.15m・最大半径約1.08m)
    const profilePts = [
      [0.00, -0.12],
      [0.86, -0.10],
      [1.02, 0.00],
      [1.08, 0.16],
      [1.06, 0.32],
      [0.98, 0.50],
      [0.88, 0.68],
      [0.74, 0.94],
      [0.58, 1.22],
      [0.42, 1.50],
      [0.27, 1.76],
      [0.15, 1.96],
      [0.08, 2.08],
      [0.00, 2.12],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const geo = new THREE.LatheGeometry(profilePts, 36);
    // インフレータブルビニール特有の空気圧によるわずかな縦ジワ・たるみ凹凸を下部〜中腹に付与
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      const r = Math.hypot(px, pz);
      if (r > 0.05 && py > -0.02 && py < 1.65) {
        const ang = Math.atan2(pz, px);
        const lowEnv = Math.sin(Math.PI * clampN((py + 0.02) / 0.85, 0, 1));
        const midEnv = Math.sin(Math.PI * clampN((py - 0.25) / 1.35, 0, 1));
        const crease = 1.0
          + 0.020 * lowEnv * Math.sin(ang * 9.0 + py * 6.2)
          + 0.012 * lowEnv * Math.cos(ang * 14.0 - py * 8.5)
          + 0.008 * midEnv * Math.sin(ang * 4.0);
        pos.setX(i, px * crease);
        pos.setZ(i, pz * crease);
      }
    }
    geo.computeVertexNormals();

    // 2) PVCターポリン生地の質感テクスチャ (鮮やかなオレンジ色・中腹の熱溶着シームライン・下部のシワ陰影・4面パネル継ぎ目)
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0.0, '#ff6d14');
    grad.addColorStop(0.55, '#ff5e06');
    grad.addColorStop(0.88, '#f24f00');
    grad.addColorStop(1.0, '#d94300');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 512);

    // 縦パネルの溶着シーム (4本)
    for (const sx of [64, 192, 320, 448]) {
      ctx.strokeStyle = 'rgba(180, 48, 0, 0.34)';
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, 512); ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 165, 95, 0.28)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx + 2, 0); ctx.lineTo(sx + 2, 512); ctx.stroke();
    }
    // 中腹(画像の水平シーム位置)の円周熱溶着ライン
    const seamY = 342;
    ctx.fillStyle = 'rgba(175, 42, 0, 0.38)';
    ctx.fillRect(0, seamY - 3, 512, 6);
    ctx.fillStyle = 'rgba(255, 175, 110, 0.32)';
    ctx.fillRect(0, seamY - 5, 512, 2);

    // 下部(水面〜シーム下)のビニール特有の斜め・縦のシワ陰影
    for (let i = 0; i < 28; i++) {
      const wx = (i * 18.3) % 512;
      const wy0 = 335 + (i % 5) * 14;
      const wy1 = 465 + (i % 4) * 10;
      const dx = ((i % 3) - 1) * 14;
      ctx.strokeStyle = 'rgba(155, 36, 0, 0.22)';
      ctx.lineWidth = 3.0;
      ctx.beginPath(); ctx.moveTo(wx, wy0); ctx.quadraticCurveTo(wx + dx * 0.6, (wy0 + wy1) * 0.5, wx + dx, wy1); ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 168, 100, 0.20)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(wx + 2, wy0); ctx.quadraticCurveTo(wx + dx * 0.6 + 2, (wy0 + wy1) * 0.5, wx + dx + 2, wy1); ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;

    const mat = new THREE.MeshPhysicalMaterial({
      map: tex,
      roughness: 0.22,
      metalness: 0.03,
      clearcoat: 0.82,
      clearcoatRoughness: 0.18,
    });
    _unifiedBuoyGeo = geo;
    _unifiedBuoyMat = mat;
    return { geo, mat };
  };

  const buoyHandleMat = new THREE.MeshStandardMaterial({ color: 0x181c22, roughness: 0.55, metalness: 0.15 });
  const buoy = () => {
    const g = new THREE.Group();
    const body = new THREE.Group();
    const { geo, mat } = getUnifiedBuoyAssets();
    const mesh = new THREE.Mesh(geo, mat);
    body.add(mesh);

    // 下部側面の黒いPVCグラブハンドル＆補強パッチ (画像5枚目準拠)
    for (const ang of [0.35, 1.85, 3.50, 5.00]) {
      const hr = 1.03, hy = 0.34;
      const patch = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.11, 0.035), buoyHandleMat);
      patch.position.set(Math.sin(ang) * hr, hy, Math.cos(ang) * hr);
      patch.rotation.y = ang;
      patch.rotation.x = -0.16;
      body.add(patch);
    }
    // 頂部の黒いバルブ・アイパッチ
    const topCap = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.085, 0.04, 12), buoyHandleMat);
    topCap.position.y = 2.11;
    body.add(topCap);

    // 水面との接地感を高めるごく控えめな白波リング
    const ringGeo = new THREE.RingGeometry(0.98, 1.18, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.02;
    body.add(ring);

    g.add(body);
    g.userData.isMarkBuoy = true;
    g.userData.body = body;
    return g;
  };
  const place = (key, obj) => { const p = toWorld(MARKS[key].a, MARKS[key].c); obj.position.set(p.x, 0, p.z); scene.add(obj); bob.push(obj); markObjs[key] = obj; };
  place('m1', buoy()); place('m1a', buoy()); place('m2', buoy()); place('m3', buoy());
  place('gL', buoy()); place('gR', buoy());

  // アウター艇(ピン側のオレンジ旗艇) — 船首を風上に向けてアンカリング
  const flagSway = [];
  const courseBoats = [];
  const putBoat = (b, a, c, relRot, isSpectator = false, idx = 0, markRef = null, daRef = 0, dcRef = 0) => {
    const head = Math.atan2(U.x, U.z);
    const p = toWorld(a, c);
    b.position.set(p.x, 0, p.z);
    b.rotation.y = head + relRot;
    scene.add(b); bob.push(b);
    courseBoats.push({ b, a, c, relRot, isSpectator, ph: idx * 1.47, markRef, daRef, dcRef });
    b.traverse((o) => { if (o.userData.flag) flagSway.push(o); });
    return b;
  };
  const ORG = { color: '#ff7a1a', w: 1.5, h: 1.0, key: 'ORG' };
  markObjs.pin = putBoat(makeMotorboat('outer', { flags: [ORG] }), MARKS.pin.a, MARKS.pin.c, 0.06);

  // スタート運営艇(右端): オレンジ旗 + スナイプ級クラス旗(0秒で降下) + P旗(1分前に降下) + X旗(個別リコール時に掲揚)
  const com = putBoat(makeMotorboat('committee', {
    flags: [
      ORG,
      { color: '#ffffff', w: 1.40, h: 0.90, text: 'SNIPE', key: 'SNIPE' },
      { color: '#1d4ed8', w: 1.35, h: 0.88, text: 'P', key: 'P' },
      { color: '#ffffff', w: 1.38, h: 0.88, text: 'X', key: 'X', topY: 2.45, initHidden: true },
    ],
  }), MARKS.com.a, MARKS.com.c, -0.05);
  markObjs.com = com;

  // 1マーク・2マークの風上側近めに配置するRIB観覧・コーチボート ＋ コース外周の観覧艇(濃紺・赤・水色のゴムボート＆クルーザー)
  const specPositions = [
    // 1マーク風上側近めの赤色RIB観覧・コーチボート
    { markRef: 'm1', da: 26, dc: 10, rot: 2.75, type: 'rib', tube: 0xd93829, noFlag: true },
    // 2マーク風上側近めの水色RIB観覧・コーチボート
    { markRef: 'm2', da: 25, dc: -9, rot: 2.55, type: 'rib', tube: 0x2ea8e6, noFlag: true },
    // コース外周の観覧艇・サポート艇 (濃紺・赤・水色のRIBゴムボートとクルーザー)
    { a: 365, c: 52, rot: 1.2, type: 'cruiser' },
    { a: 95, c: 135, rot: -1.1, type: 'rib', tube: 0x2ea8e6 },
    { a: -32, c: -138, rot: 0.8, type: 'rib', tube: 0xd93829 },
    { a: 180, c: 175, rot: -0.8, type: 'rib', tube: 0x263759 },
    { a: 245, c: -232, rot: 2.1, type: 'cruiser' },
    { a: 60, c: -210, rot: 0.4, type: 'rib', tube: 0x2ea8e6 },
    { a: 195, c: -195, rot: 1.4, type: 'rib', tube: 0xd93829 },
    { a: -90, c: -232, rot: -1.5, type: 'cruiser' },
    { a: 20, c: 190, rot: -2.2, type: 'cruiser' },
    { a: 290, c: 185, rot: 0.1, type: 'rib', tube: 0x263759 },
    { a: -195, c: -20, rot: 2.6, type: 'cruiser' },
  ];
  const TUBES = [0x263759, 0xd93829, 0x2ea8e6, 0x263759];
  specPositions.forEach((s, i) => {
    const a0 = s.markRef ? MARKS[s.markRef].a + s.da : s.a;
    const c0 = s.markRef ? MARKS[s.markRef].c + s.dc : s.c;
    const flags = s.type === 'rib' && !s.noFlag ? [{ color: i % 2 ? '#ffffff' : '#ffd23f', w: 0.8, h: 0.5 }] : [];
    putBoat(makeMotorboat(s.type, { tube: s.tube ?? TUBES[i % 4], flags }), a0, c0, s.rot, true, i, s.markRef || null, s.da || 0, s.dc || 0);
  });

  // ジュリー(審判)ボート: 1艇のみ配置し、スタート時は遠く離れた海面で静かに待機して目立たないようにする
  const juryBoats = [0].map((ji) => {
    const jb = makeMotorboat('jury', {
      flags: [{ color: '#0f3c8a', w: 1.38, h: 0.88, text: 'JURY', key: 'JURY' }],
    });
    const initA = -82;
    const initC = -72;
    const p = toWorld(initA, initC);
    jb.position.set(p.x, 0, p.z);
    jb.rotation.y = Math.atan2(U.x, U.z);
    scene.add(jb);
    bob.push(jb);
    jb.traverse((o) => { if (o.userData.flag) flagSway.push(o); });
    return {
      b: jb,
      idx: ji,
      targetBoatIdx: 3,
      nextSwitchT: 40,
      followDist: 38.0,
      latOffset: -18.0,
    };
  });

  // スタートライン: 船や本部船の手前に透けて見えないよう depthTest: true とし、波で隠れないよう細分化して海面波高に追従させる
  const pa0 = toWorld(MARKS.pin.a, MARKS.pin.c), pb0 = toWorld(MARKS.com.a, MARKS.com.c);
  const len = Math.hypot(pb0.x - pa0.x, pb0.z - pa0.z);
  const lineGeo = new THREE.PlaneGeometry(len, 0.58, 64, 1);
  const lineMesh = new THREE.Mesh(
    lineGeo,
    new THREE.MeshBasicMaterial({ color: 0xffe36a, transparent: true, opacity: 0.68, depthTest: true, depthWrite: false, side: THREE.DoubleSide })
  );
  lineMesh.rotation.x = -Math.PI / 2;
  lineMesh.renderOrder = 2;
  scene.add(lineMesh);

  // フィニッシュライン(チェッカー柄の帯 + 縦のカーテン + FINISH表示)
  const fpa0 = toWorld(MARKS.fm.a, MARKS.fm.c), fpb0 = toWorld(MARKS.fcom.a, MARKS.fcom.c);
  const flen = Math.hypot(fpb0.x - fpa0.x, fpb0.z - fpa0.z);
  const checker = (rx, ry) => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 64); x.fillStyle = '#111'; x.fillRect(0, 0, 32, 32); x.fillRect(32, 32, 32, 32);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const finBand = new THREE.Mesh(new THREE.PlaneGeometry(flen, 2.4), new THREE.MeshBasicMaterial({ map: checker(flen / 3, 1), transparent: true, opacity: 0.88, depthWrite: false }));
  finBand.rotation.x = -Math.PI / 2;
  const finCurtainMat = new THREE.MeshBasicMaterial({ map: checker(flen / 3.5, 1), transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
  const finCurtain = new THREE.Mesh(new THREE.PlaneGeometry(flen, 2.2), finCurtainMat);
  const fin = new THREE.Group(); fin.add(finBand, finCurtain); scene.add(fin);

  // START LINE ラベル(AI風の斜め枠やSFフォントを廃し、クリーンで視認性の高い大型スポーツ中継プレート)
  const startCanvas = document.createElement('canvas');
  startCanvas.width = 1200; startCanvas.height = 440;
  const startTex = new THREE.CanvasTexture(startCanvas);
  startTex.anisotropy = 4;
  const startLabel = new THREE.Sprite(new THREE.SpriteMaterial({ map: startTex, transparent: true, depthWrite: false }));
  startLabel.scale.set(34.0, 12.5, 1);
  startLabel.position.set(0, 6.4, 0);
  startLabel.renderOrder = 5;
  scene.add(startLabel);
  let showPreStartFav = true;

  const drawRoundPlate = (ctx, x, y, w, h, r = 14) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.closePath();
  };

  const updateStartLabel = () => {
    const skewDeg = Math.round(Math.abs((LINE_SKEW * 180) / Math.PI));
    const favStr = FAVORED === 'even' || skewDeg === 0 ? 'EVEN  0° 有利なし' : `${skewDeg}° ${FAVORED === 'com' ? '上有利 (本部船側)' : '下有利 (アウター側)'}`;
    const ctx = startCanvas.getContext('2d');
    ctx.clearRect(0, 0, 1200, 440);

    // メインプレート (落ち着いた濃紺ソリッド＋白太枠の大型サインボード)
    ctx.save();
    ctx.shadowColor = 'rgba(0, 8, 20, 0.65)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 6;
    drawRoundPlate(ctx, 36, 18, 1128, 204, 20);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.fill();
    ctx.restore();

    drawRoundPlate(ctx, 36, 18, 1128, 204, 20);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 8;
    ctx.stroke();

    // 左端のオレンジフラッグ色バー
    ctx.save();
    drawRoundPlate(ctx, 36, 18, 1128, 204, 20);
    ctx.clip();
    ctx.fillStyle = '#f97316';
    ctx.fillRect(36, 18, 30, 204);
    ctx.restore();

    // START LINE タイトル文字 (遠目でもくっきり大きく読める特大ボールド文字)
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 134px "Outfit", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('START LINE', 612, 122);
    ctx.restore();

    // 下段: 有利サイドバッジ
    if (showPreStartFav) {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 8, 20, 0.6)';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 5;
      drawRoundPlate(ctx, 150, 242, 900, 128, 16);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = '#fde047';
      ctx.font = '800 68px "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(favStr, 600, 308);
    }
    startTex.needsUpdate = true;
  };

  const lineLabel = (txt, _bg, lx, lz) => {
    const c = document.createElement('canvas'); c.width = 768; c.height = 200; const x = c.getContext('2d');
    x.save();
    x.shadowColor = 'rgba(0, 8, 20, 0.55)';
    x.shadowBlur = 12;
    x.shadowOffsetY = 5;
    drawRoundPlate(x, 56, 22, 656, 156, 14);
    x.fillStyle = 'rgba(15, 23, 42, 0.94)';
    x.fill();
    x.restore();

    // 左端のチェッカー柄アクセント
    x.save();
    drawRoundPlate(x, 56, 22, 656, 156, 14);
    x.clip();
    const sq = 26;
    for (let r = 0; r < 6; r++) {
      for (let col = 0; col < 2; col++) {
        x.fillStyle = (r + col) % 2 === 0 ? '#ffffff' : '#0f172a';
        x.fillRect(56 + col * sq, 22 + r * sq, sq, sq);
      }
    }
    x.restore();

    drawRoundPlate(x, 56, 22, 656, 156, 14);
    x.strokeStyle = '#ffffff';
    x.lineWidth = 6;
    x.stroke();

    x.fillStyle = '#ffffff';
    x.font = '800 88px "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(txt, 404, 102);

    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    s.scale.set(24, 6.25, 1); s.position.set(lx, 5.2, lz); s.renderOrder = 5; scene.add(s); return s;
  };
  const finLabel = lineLabel('FINISH', 'rgba(20,20,20,0.88)', 0, 0);

  // フィニッシュ運営艇(アウターと同じ種類の和船型サポートボート + 青色旗のみ掲揚)と反対側の通常マークブイ
  const fComBoat = putBoat(makeMotorboat('outer', { isFinishBoat: true, flags: [{ color: '#1d4ed8', w: 1.5, h: 1.0, key: 'BLUE' }] }), MARKS.fcom.a, MARKS.fcom.c, 0.95);
  // フィニッシュ船の船首オープンデッキ先端に、3マーク〜フィニッシュライン側へ「大きい白レンズの一眼レフ」を構えるたぬきカメラマンを配置
  {
    const tanukiCam = buildFigure('tanuki', { vest: 0xf97316, suit: 0x1e293b });
    tanukiCam.scale.setScalar(1.30);
    // キャビン風防(z=1.56)より十分前方のオープンなバウデッキ先端(z=2.55, x=0.34, y=0.88)に立ち、船首前方(+z)の海面・3マーク側へ望遠レンズを向ける
    tanukiCam.position.set(0.34, 0.88, 2.55);
    tanukiCam.rotation.y = Math.PI - 0.18;
    if (tanukiCam.userData.upper) {
      const tu = tanukiCam.userData.upper;
      if (tu.userData.armL) tu.userData.armL.rotation.set(-0.78, 0.26, -0.18);
      if (tu.userData.armR) tu.userData.armR.rotation.set(-0.78, -0.26, 0.18);
    }
    // 一眼レフ本体 ＋ 白い超望遠大口径レンズ(赤リング・黒い大型レンズフード・前玉ガラス・一脚付き)
    const dslr = new THREE.Group();
    dslr.position.set(0.0, 0.34, -0.22);
    dslr.rotation.x = 0.04;
    const camMat = new THREE.MeshStandardMaterial({ color: 0x181c24, roughness: 0.42, metalness: 0.28 });
    const whiteLensMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.24, metalness: 0.20 });
    const redRingMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, roughness: 0.08, metalness: 0.65, emissive: 0x0369a1, emissiveIntensity: 0.40 });
    const bodyBox = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.15, 0.12), camMat);
    const prismBox = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.055, 0.095), camMat);
    prismBox.position.set(0, 0.095, 0);
    // 大型望遠レンズ鏡筒 (たぬきの正面 -z 方向へ大きく突き出す白レンズ)
    const barrel1 = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.056, 0.22, 16), whiteLensMat);
    barrel1.rotation.x = Math.PI / 2; barrel1.position.set(0, 0, -0.15);
    const barrel2 = new THREE.Mesh(new THREE.CylinderGeometry(0.076, 0.062, 0.24, 16), whiteLensMat);
    barrel2.rotation.x = Math.PI / 2; barrel2.position.set(0, 0, -0.36);
    const redRing = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.078, 0.022, 16), redRingMat);
    redRing.rotation.x = Math.PI / 2; redRing.position.set(0, 0, -0.45);
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.078, 0.18, 16), camMat);
    hood.rotation.x = Math.PI / 2; hood.position.set(0, 0, -0.56);
    const frontGlass = new THREE.Mesh(new THREE.CircleGeometry(0.078, 16), glassMat);
    frontGlass.rotation.y = Math.PI; frontGlass.position.set(0, 0, -0.652);
    // 望遠レンズを支える一脚(モノポッド)
    const monopod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.009, 0.56, 8), camMat);
    monopod.position.set(0, -0.28, -0.26);
    dslr.add(bodyBox, prismBox, barrel1, barrel2, redRing, hood, frontGlass, monopod);
    tanukiCam.add(dslr);
    fComBoat.add(tanukiCam);
    fComBoat.userData.tanukiCam = tanukiCam;
  }
  markObjs.fcom = fComBoat;
  const fPinObj = buoy(); scene.add(fPinObj); bob.push(fPinObj); markObjs.fm = fPinObj;

  let courseVisible = true;

  // 風向(W0)やコースモード(COURSE_MODE)変更時にすべてのコースマーク・ライン・観覧艇のワールド座標と表示状態を更新
  const syncCourseObjects = () => {
    const isUpwindMode = COURSE_MODE === 'upwind';
    for (const k of ['m1', 'm1a', 'm2', 'm3', 'gL', 'gR', 'fm']) {
      const p = toWorld(MARKS[k].a, MARKS[k].c);
      markObjs[k].position.x = p.x; markObjs[k].position.z = p.z;
    }
    // 上マークフィニッシュモード時は 1a, 2, 3, 4S(gL), 4P(gR), fm(下フィニッシュピン: 上マーク1がピンになるため) を非表示化
    for (const k of ['m1a', 'm2', 'm3', 'gL', 'gR', 'fm']) {
      markObjs[k].visible = courseVisible && !isUpwindMode;
    }
    for (const k of ['m1', 'pin', 'com', 'fcom']) {
      if (markObjs[k]) markObjs[k].visible = courseVisible;
    }
    const head = Math.atan2(U.x, U.z);
    for (const cb of courseBoats) {
      let ca = cb.a, cc = cb.c;
      if (cb.b === fComBoat) {
        ca = MARKS.fcom.a; cc = MARKS.fcom.c;
        // フィニッシュ船のバウ(+z)を3マーク〜フィニッシュライン(上マークF時は1マーク手前海面)方向へ向け、キャビンがカメラ視界を遮らないようにする
        cb.relRot = isUpwindMode ? (Math.PI - 0.55) : 0.95;
      } else if (cb.b === markObjs.pin) {
        ca = MARKS.pin.a; cc = MARKS.pin.c;
      } else if (cb.b === markObjs.com) {
        ca = MARKS.com.a; cc = MARKS.com.c;
      } else if (cb.markRef && MARKS[cb.markRef]) {
        ca = MARKS[cb.markRef].a + cb.daRef;
        cc = MARKS[cb.markRef].c + cb.dcRef;
        cb.b.visible = courseVisible && (cb.markRef === 'm2' ? !isUpwindMode : true);
      } else if (isUpwindMode && cb.a >= 350) {
        // 1マーク北側の観覧艇は2倍レグ(a=600)の上側に退避
        ca = cb.a + 300;
        cb.b.visible = courseVisible;
      } else {
        cb.b.visible = courseVisible;
      }
      cb.baseA = ca; cb.baseC = cc;
      const p = toWorld(ca, cc);
      cb.b.position.x = p.x; cb.b.position.z = p.z;
      cb.b.rotation.y = head + cb.relRot;
    }
    for (const jb of juryBoats) {
      jb.b.visible = courseVisible;
      const initP = toWorld(-82, -72);
      jb.b.position.x = initP.x;
      jb.b.position.z = initP.z;
      jb.b.rotation.y = head;
    }
    const pa = toWorld(MARKS.pin.a, MARKS.pin.c), pb = toWorld(MARKS.com.a, MARKS.com.c);
    const lcx = (pa.x + pb.x) / 2, lcz = (pa.z + pb.z) / 2, lrot = -Math.atan2(pb.z - pa.z, pb.x - pa.x);
    lineMesh.rotation.z = lrot; lineMesh.position.set(lcx, 0, lcz);
    lineMesh.visible = courseVisible;
    startLabel.position.set(lcx, 4.8, lcz);
    startLabel.visible = courseVisible;
    updateStartLabel();

    const fpa = toWorld(MARKS.fm.a, MARKS.fm.c), fpb = toWorld(MARKS.fcom.a, MARKS.fcom.c);
    const curFlen = Math.hypot(fpb.x - fpa.x, fpb.z - fpa.z);
    const flcx = (fpa.x + fpb.x) / 2, flcz = (fpa.z + fpb.z) / 2, flrot = -Math.atan2(fpb.z - fpa.z, fpb.x - fpa.x);
    finBand.scale.x = curFlen / flen;
    finCurtain.scale.x = curFlen / flen;
    finBand.rotation.z = flrot; finBand.position.set(flcx, 0.08, flcz);
    finCurtain.rotation.y = flrot; finCurtain.position.set(flcx, 1.35, flcz);
    fin.visible = courseVisible;
    finLabel.position.set(flcx, 5.0, flcz);
    finLabel.visible = courseVisible;
  };
  syncCourseObjects();

  // マークの番号ラベル (装飾過多なコンパスノッチを排し、見やすいシンプル丸バッジ)
  const markSprites = {};
  const label = (txt, key, y = 4.6) => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 320; const x = c.getContext('2d');
    const cx0 = 160, cy0 = 160;
    x.save();
    x.shadowColor = 'rgba(0, 8, 20, 0.55)';
    x.shadowBlur = 12;
    x.shadowOffsetY = 4;
    x.beginPath();
    x.arc(cx0, cy0, 128, 0, Math.PI * 2);
    x.fillStyle = 'rgba(15, 23, 42, 0.94)';
    x.fill();
    x.restore();

    x.beginPath();
    x.arc(cx0, cy0, 128, 0, Math.PI * 2);
    x.strokeStyle = '#ffffff';
    x.lineWidth = 10;
    x.stroke();

    // マーク番号テキスト
    x.fillStyle = '#ffffff';
    const fontSize = txt.length >= 2 ? 120 : 146;
    x.font = `800 ${fontSize}px "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(txt, cx0, cy0 + 6);

    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true, opacity: 0.96 }));
    s.scale.set(5.5, 5.5, 1); s.position.y = y; s.renderOrder = 4; markObjs[key].add(s);
    markSprites[key] = s;
  };
  label('1', 'm1'); label('1a', 'm1a'); label('2', 'm2'); label('3', 'm3'); label('4S', 'gL'); label('4P', 'gR');

  // ---------- 次向かうマークの赤い矢印 + 上部「NEXT」バッジ (黄色を一切排除し、純粋な赤＋白枠のみで構成) ----------
  const makeNextTextTex = () => {
    const c = document.createElement('canvas'); c.width = 420; c.height = 160; const x = c.getContext('2d');
    x.save();
    x.shadowColor = 'rgba(0, 6, 20, 0.55)';
    x.shadowBlur = 10;
    x.shadowOffsetY = 4;
    drawRoundPlate(x, 36, 22, 348, 116, 14);
    x.fillStyle = '#dc2626';
    x.fill();
    x.restore();

    drawRoundPlate(x, 36, 22, 348, 116, 14);
    x.strokeStyle = '#ffffff';
    x.lineWidth = 6;
    x.stroke();

    x.fillStyle = '#ffffff';
    x.font = '800 72px "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('NEXT', 210, 82);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  };
  const nextTex = makeNextTextTex();
  const makeTargetArrow = () => {
    const g = new THREE.Group();
    const coneMat = new THREE.MeshBasicMaterial({ color: 0xe11d48, transparent: true, opacity: 0.96, depthWrite: false });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.8, 4.6, 6), coneMat);
    cone.rotation.x = Math.PI;
    cone.position.y = -1.2;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 3.6, 6), coneMat);
    shaft.position.y = 2.4;
    const nextMat = new THREE.SpriteMaterial({ map: nextTex, transparent: true, opacity: 0.98, depthWrite: false });
    const nextSp = new THREE.Sprite(nextMat);
    nextSp.scale.set(8.6, 3.3, 1);
    nextSp.position.y = 6.5;
    nextSp.renderOrder = 6;
    g.add(cone, shaft, nextSp);
    g.userData.mat = coneMat;
    g.userData.nextMat = nextMat;
    g.visible = false;
    scene.add(g);
    return g;
  };
  const targetArrows = [makeTargetArrow(), makeTargetArrow()];
  let activeMarkKeys = ['m1'];
  const camDir = new THREE.Vector3();

  // ---------- バウしぶき・引き波・ラダー抵抗泡 (実艇動画 0:40〜0:45 / 1:01 準拠) ----------
  // ・バウ(船首)が波にぶつかって水を切った時に白いしぶきが上がる
  // ・艇の左右後方にはごくわずかに引き波(ケルビンV字波紋)が立つ(黒ずみや不自然な白い帯は出さない)
  // ・ラダー周辺には、舵を切ってラダーに抵抗があった時だけわずかに白くなる
  const TRAIL_N = 28, MAXB = 40, PER = 4, LIFE = 2.8;
  const wakeTex = (() => {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 128, 128);
    // 端が滑らかに0へ減衰するソフトなしぶき・波紋テクスチャ(Additive合成で黒くならないよう純白アルファで構成)
    for (let py = 0; py < 128; py++) {
      const ny = (py - 64) / 64;
      const envY = Math.exp(-ny * ny * 3.0);
      for (let px = 0; px < 128; px++) {
        const nx = (px - 64) / 64;
        const envX = Math.exp(-nx * nx * 3.8);
        const ripple = 0.78 + 0.22 * Math.cos(nx * Math.PI * 2.5);
        const a = Math.max(0, Math.min(1, envX * envY * ripple));
        if (a > 0.01) {
          x.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
          x.fillRect(px, py, 1, 1);
        }
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const trailGeo = new THREE.PlaneGeometry(1.4, 1.7, 1, 1); trailGeo.rotateX(-Math.PI / 2);
  // AdditiveBlending にすることで col=(0,0,0) の箇所が完全に透明になり、航跡が黒くなる現象を完全に防ぐ
  const trailMat = new THREE.MeshBasicMaterial({ map: wakeTex, color: 0xffffff, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false });
  const trail = new THREE.InstancedMesh(trailGeo, trailMat, TRAIL_N * PER * MAXB);
  trail.frustumCulled = false; trail.position.y = 0.04; scene.add(trail);
  trail.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const hist = new Map();
  const col = new THREE.Color();
  const tv = new THREE.Vector3(), ts = new THREE.Vector3(), tq = new THREE.Quaternion(), yAx = new THREE.Vector3(0, 1, 0);
  const hide = (k) => { m4.makeScale(0, 0, 0); trail.setMatrixAt(k, m4); col.setScalar(0); trail.setColorAt(k, col); };
  const wake = {
    update(boats, dt) {
      let k = 0;
      for (const b of boats) {
        let h = hist.get(b.id);
        if (!h) { h = { pts: [], acc: 0 }; hist.set(b.id, h); }
        h.acc += dt;
        const rDrag = clampN(b.rudderDrag || 0, 0, 1);
        if (h.acc > (rDrag > 0.22 ? 0.048 : 0.068) && (b.v > 0.38 || rDrag > 0.16)) {
          h.acc = 0;
          const fx = Math.sin(b.h), fz = -Math.cos(b.h);
          const sternX = b.x - fx * 2.68, sternZ = b.z - fz * 2.68;
          const bowX = b.x + fx * 1.65, bowZ = b.z + fz * 1.65;
          // 通常走行時(v > 0.72)は上に噴き上げず海面がほんのわずかに白くなる程度(cruiseFoam)とし、波にはたかれた時だけslamSprayを加える
          const wsBow = waveSample(bowX, bowZ, SEA.clock, fx, fz);
          const hitCrest = (wsBow.h > 0.045 && wsBow.slope > 0.052)
            ? (wsBow.h - 0.045) * 3.2 + (wsBow.slope - 0.052) * 4.5
            : 0;
          const slamCut = Math.max(b.waveSlam || 0, b.visualSlam || 0);
          const spdBase = clampN((b.v - 0.72) / 2.2, 0, 1.0);
          const cruiseFoam = b.v > 0.72 ? spdBase * (0.55 + 0.25 * Math.max(0, Math.sin(SEA.clock * 6.5 + b.id * 1.9))) : 0;
          const slamSpray = b.v > 0.72 ? clampN((hitCrest + slamCut * 1.45) * clampN((b.v - 0.65) / 1.4, 0.25, 1.2), 0, 1) : 0;
          h.pts.unshift({
            x: sternX, z: sternZ,
            bowX, bowZ,
            midX: b.x - fx * 1.65, midZ: b.z - fz * 1.65,
            h: b.h, age: 0,
            s: clampN(b.v / 5.6, 0.12, 0.95),
            rudder: rDrag,
            cruiseFoam,
            slamSpray,
          });
          if (h.pts.length > TRAIL_N) h.pts.pop();
        }
        const curFx = Math.sin(b.h), curFz = -Math.cos(b.h);
        const curRx = Math.cos(b.h), curRz = Math.sin(b.h);
        for (const p of h.pts) p.age += dt;
        for (let i = 0; i < TRAIL_N; i++) {
          const p = h.pts[i];
          if (!p || p.age >= LIFE) { for (let j = 0; j < PER; j++) hide(k++); continue; }
          const life = 1 - p.age / LIFE, fade = life * life;
          const rx = Math.cos(p.h), rz = Math.sin(p.h); // 艇の右方向
          const rFoam = (p.rudder || 0) * Math.pow(life, 0.78);

          // 1, 2) 通常走行時はバウ外側の海面がほんのわずかに白くなるフラットな泡、波にはたかれた時だけ少し強い白泡(船体との接地点は絶対に白くしないよう船体周囲1.15m以内はマスク)
          if ((p.cruiseFoam > 0.08 || p.slamSpray > 0.08) && p.age > 0.10 && p.age < 0.62) {
            const bLife = 1 - (p.age - 0.10) / 0.52;
            const bFade = Math.pow(clampN(bLife, 0, 1), 1.45);
            const wsB = waveSample(p.bowX, p.bowZ, SEA.clock);
            const bowY = wsB.hLong * 0.95 + (wsB.h - wsB.hLong) * 0.55 + 0.015;
            const sprayOff = 0.96 + p.age * (1.20 + p.s * 0.85);
            for (const s of [-1, 1]) {
              const px = p.bowX + rx * s * sprayOff;
              const pz = p.bowZ + rz * s * sprayOff;
              const relF = (px - b.x) * curFx + (pz - b.z) * curFz;
              const relR = Math.abs((px - b.x) * curRx + (pz - b.z) * curRz);
              if (relF > -2.65 && relF < 2.55 && relR < 1.15) {
                hide(k++);
                continue;
              }
              const sa = p.h - s * 0.42;
              tq.setFromAxisAngle(yAx, -sa);
              ts.set(0.165 + p.age * 0.21, 1, 0.48 + p.age * 0.34);
              m4.compose(tv.set(px, bowY, pz), tq, ts);
              trail.setMatrixAt(k, m4);
              const sprayBright = (0.056 * (p.cruiseFoam || 0) + 0.145 * (p.slamSpray || 0)) * bFade;
              col.setRGB(0.90, 0.96, 1.0).multiplyScalar(sprayBright);
              trail.setColorAt(k++, col);
            }
          } else {
            hide(k++);
            hide(k++);
          }

          // 3) わずかに立つ引き波(ケルビンV字波紋): 船体後方の離れた位置からごく控えめな水面光沢筋として左右交互に配置
          if (p.s > 0.18 && p.age > 0.16) {
            const sideS = i % 2 === 0 ? 1 : -1;
            const wakeOff = 0.94 + p.age * (0.74 + p.s * 0.92);
            const wx = p.midX + rx * sideS * wakeOff;
            const wz = p.midZ + rz * sideS * wakeOff;
            const relF = (wx - b.x) * curFx + (wz - b.z) * curFz;
            const relR = Math.abs((wx - b.x) * curRx + (wz - b.z) * curRz);
            if (relF > -2.65 && relF < 2.55 && relR < 1.15) {
              hide(k++);
            } else {
              const wsW = waveSample(wx, wz, SEA.clock);
              const wy = wsW.hLong * 0.95 + (wsW.h - wsW.hLong) * 0.55 + 0.015;
              const wa = p.h - sideS * 0.38;
              tq.setFromAxisAngle(yAx, -wa);
              ts.set(0.060 + p.age * 0.042, 1, 0.96 + p.age * 0.52);
              m4.compose(tv.set(wx, wy, wz), tq, ts);
              trail.setMatrixAt(k, m4);
              const wakeGlint = 0.032 * p.s * fade;
              col.setRGB(0.58, 0.78, 0.90).multiplyScalar(wakeGlint);
              trail.setColorAt(k++, col);
            }
          } else {
            hide(k++);
          }

          // 4) ラダー周辺の白泡: ラダーに抵抗があった時(rFoam > 0.20)だけ船尾後方がわずかに白くなる(船体と海面の接地点は白くしない)
          if (rFoam > 0.20 && p.age > 0.06 && p.age < 1.00) {
            const rFade = Math.pow(1 - p.age / 1.00, 1.55);
            const wsR = waveSample(p.x, p.z, SEA.clock);
            const ry = wsR.hLong * 0.95 + (wsR.h - wsR.hLong) * 0.55 + 0.02;
            tq.setFromAxisAngle(yAx, -p.h + (i % 2 === 0 ? 0.14 : -0.14));
            ts.set(0.175 + p.age * 0.16, 1, 0.42 + p.age * 0.26);
            m4.compose(tv.set(p.x, ry, p.z), tq, ts);
            trail.setMatrixAt(k, m4);
            col.setRGB(0.86, 0.94, 0.99).multiplyScalar(0.165 * rFoam * rFade);
            trail.setColorAt(k++, col);
          } else {
            hide(k++);
          }
        }
      }
      for (; k < TRAIL_N * PER * MAXB; k++) { m4.makeScale(0, 0, 0); trail.setMatrixAt(k, m4); }
      trail.instanceMatrix.needsUpdate = true;
      if (trail.instanceColor) trail.instanceColor.needsUpdate = true;
    },
    reset() { hist.clear(); },
  };

  return {
    markObjs,
    startLabel,
    finLabel,
    updateStartLabel,
    wake,
    syncCourseObjects,
    setCourseVisible(vis) {
      courseVisible = !!vis;
      syncCourseObjects();
      if (!courseVisible) {
        for (const ar of targetArrows) ar.visible = false;
        for (const sp of Object.values(markSprites)) sp.visible = false;
      }
    },
    // 海況を海面シェーダーへ反映(最大4成分)。すべての海況でカメラ周辺の立体変位パッチを有効化する
    setSea(sea) {
      const U4 = waterMat.uniforms;
      for (let i = 0; i < 4; i++) {
        const c = sea.comps[i];
        if (c) { U4.uSeaA.value[i].set(c.dx, c.dz, c.k, c.A); U4.uSeaB.value[i].set(c.w, c.ph, c.long ? 1 : 0, 0); }
        else { U4.uSeaA.value[i].set(1, 0, 0.1, 0); U4.uSeaB.value[i].set(0, 0, 0, 0); }
      }
      U4.uGen.value = clampN(0.82 - sea.H * 0.5, 0.35, 0.72);
      // 海面のざらつき(短い風浪の密度・鋭さ): 八景島の三角波=1.0 / 江の島北風の短い風浪=0.72 / 江の島のうねり=0.5
      U4.uChop.value = sea.type === 'chop' ? 1.0
        : sea.type === 'short' ? 0.72
          : sea.type === 'swell' ? 0.5
            : (sea.venue === 'hakkeijima' ? 0.9 : 0.58);
      seaBaseY = -(Math.max(sea.longAmp, sea.H * 0.65) + 0.22);
      U4.uBaseY.value = seaBaseY;
      seaPatch.visible = true;
    },
    setVenue(venue, customWindDeg = null, sideBias = -0.6) {
      const isHakkei = venue === 'hakkeijima';
      enoshimaGroup.visible = !isHakkei;
      hakkeijimaGroup.visible = isHakkei;
      // 八景島は北風スタート(15°北北東の風)、江の島は南南西(200°)。リアル気象時は取得した風向を使用
      const deg = (typeof customWindDeg === 'number' && Number.isFinite(customWindDeg)) ? customWindDeg : (isHakkei ? 15 : 200);
      setWindDir(deg);
      if (isHakkei) {
        // 風向に応じてコース海面を沖側へオフセットし、東風・北東風・西風のいずれでも上マークやレイラインが進入禁止の岸際(福浦岸壁・横浜ヘリポート・幸浦岸壁・八景島防波堤)に近づきすぎないよう距離を確保
        const shoreWind = Math.max(0, -U.x);      // 西寄り(風上が陸側 -x)成分
        const eastWind = Math.max(0, U.x);        // 東寄り(風上が +x, 左レイライン・下マークが陸側)成分
        const southWind = Math.max(0, U.z);       // 南寄り(風上が八景島・ヘリポート側 +z)成分
        const northWind = Math.max(0, -U.z);      // 北寄り(風上が幸浦埋立地側 -z)成分
        const hxOff = -390 - 340 * shoreWind - 110 * eastWind - 75 * northWind;
        const hzOff = 1240 + 230 * southWind - 90 * northWind * eastWind;
        hakkeijimaGroup.position.set(hxOff, 0, hzOff);
        hakkeijimaGroup.updateMatrixWorld(true);
      } else {
        enoshimaGroup.updateMatrixWorld(true);
      }
      waterMat.uniforms.uW0.value = W0;
      waterMat.uniforms.uSideBias.value = sideBias;
      syncCourseObjects();
    },
    setTargetMark(legIndex, wt, finished) {
      if (!courseVisible || finished) {
        for (const ar of targetArrows) ar.visible = false;
        activeMarkKeys = [];
        return;
      }
      const L = LEGS[Math.min(Math.max(0, legIndex || 0), LEGS.length - 1)];
      if (!L) return;
      // フィニッシュレグではマーク(fm)の上ではなく「FINISH」看板(finLabel)の真上にNext矢印を表示する
      if (L.type === 'finish') {
        activeMarkKeys = COURSE_MODE === 'upwind' ? ['m1'] : [];
        const ar0 = targetArrows[0];
        ar0.visible = true;
        ar0.position.x = finLabel.position.x;
        ar0.position.z = finLabel.position.z;
        ar0.userData.isFinish = true;
        ar0.userData.markKey = null;
        targetArrows[1].visible = false;
        return;
      }
      activeMarkKeys = L.type === 'gate' ? ['gL', 'gR'] : [L.markKey || 'm1'];
      for (let i = 0; i < targetArrows.length; i++) {
        const key = activeMarkKeys[i];
        const ar = targetArrows[i];
        if (key && markObjs[key]) {
          ar.visible = true;
          ar.position.x = markObjs[key].position.x;
          ar.position.z = markObjs[key].position.z;
          ar.userData.isFinish = false;
          ar.userData.markKey = key;
        } else {
          ar.visible = false;
          ar.userData.markKey = null;
        }
      }
    },
    // mode: 'start' | 'finish'  emph: 0..1 (プレイヤーが最終レグで強調)  showPreStart: スタート前のみtrue
    setLine(mode, emph, showPreStart = false) {
      finCurtainMat.opacity = 0.25 + 0.3 * emph + (emph > 0.5 ? 0.12 * Math.sin(performance.now() / 250) : 0);
      const wantFav = !!showPreStart;
      if (wantFav !== showPreStartFav) {
        showPreStartFav = wantFav;
        updateStartLabel();
      }
    },
    update(t, camera, dt, wt = 0, player = null, boats = null) {
      waterMat.uniforms.uTime.value = t; waterMat.uniforms.uWT.value = wt; waterMat.uniforms.uW0.value = W0; skyMat.uniforms.uTime.value = t;
      waterMat.uniforms.uShift.value = shiftAt(wt);
      waterMat.uniforms.uWindKt.value = BASE_WIND_KT;
      const nbArr = waterMat.uniforms.uNearBoats.value;
      for (let i = 0; i < 8; i++) nbArr[i].set(0, -9999, -9999, 0);
      if (player) {
        const wsB = waveSample(player.x, player.z, SEA.clock);
        const hB = wsB.hLong * 0.95 + (wsB.h - wsB.hLong) * 0.45;
        waterMat.uniforms.uBoatPos.value.set(player.x, player.z, hB - 0.08, player.h);
        nbArr[0].set(player.x, player.z, hB - 0.08, player.h);
      }
      if (boats && boats.length > 1) {
        const cx = camera.position.x, cz = camera.position.z;
        let count = 1;
        for (let i = 1; i < boats.length && count < 8; i++) {
          const b = boats[i];
          if (!b) continue;
          const dx = b.x - cx, dz = b.z - cz;
          if (dx * dx + dz * dz < 85 * 85) {
            const wsB = waveSample(b.x, b.z, SEA.clock);
            const hB = wsB.hLong * 0.95 + (wsB.h - wsB.hLong) * 0.45;
            nbArr[count++].set(b.x, b.z, hB - 0.08, b.h);
          }
        }
      }
      sky.position.copy(camera.position);
      sea.position.set(camera.position.x, seaBaseY, camera.position.z);
      if (seaPatch.visible) {
        const cs = (PATCH_R * 2) / PATCH_SEG; // グリッド単位でスナップして頂点の揺らぎ(泳ぎ)を防ぐ
        seaPatch.position.set(Math.round(camera.position.x / cs) * cs, 0, Math.round(camera.position.z / cs) * cs);
        waterMat.uniforms.uPatchC.value.copy(seaPatch.position);
      }
      // 観覧艇・大型船のわずかな移動演出
      const head = Math.atan2(U.x, U.z);
      for (const cb of courseBoats) {
        if (!cb.isSpectator || !cb.b.visible) continue;
        // 1マーク・2マーク風上近傍の観覧RIBはマーク近くをキープしつつわずかに漂い、外周観覧艇はゆったり移動
        const ampA = cb.markRef ? 2.4 : 14.0;
        const ampC = cb.markRef ? 2.0 : 10.0;
        const spd = cb.markRef ? 0.22 : 0.11;
        const da = Math.sin(t * spd + cb.ph) * ampA;
        const dc = Math.cos(t * (spd * 0.8) + cb.ph * 1.3) * ampC;
        const p = toWorld((cb.baseA ?? cb.a) + da, (cb.baseC ?? cb.c) + dc);
        cb.b.position.x = p.x;
        cb.b.position.z = p.z;
        cb.b.rotation.y = head + cb.relRot + (cb.markRef ? 0.08 : 0.16) * Math.cos(t * spd + cb.ph);
      }
      // ジュリー(審判)ボート(1艇): ヨットの速さ程度(最大2.1m/s)で常にゆっくり航行し、コース外周(c=-84付近)を保ってヨットの近く(38m以内)には絶対に近づかない
      if (boats && boats.length > 0 && courseVisible) {
        for (const jb of juryBoats) {
          jb.b.visible = true;
          const safeDt = clampN(dt || 0, 0, 0.05);
          const maxStep = 2.1 * safeDt; // スナイプ級ヨットの巡航速度以下に厳密制限
          let targetA = -82 + Math.sin(t * 0.12) * 2.5;
          let targetC = -84 + Math.cos(t * 0.10) * 2.0;
          if (wt >= 18) {
            // 船団の後方かつ左外周(c = -84)の安全な見守り位置を算出 (船団の中を横切る動きは一切しない)
            let sumA = 0, minC = -50, cnt = 0;
            for (const b of boats) {
              if (!b || b.dsq) continue;
              const ba = b.a !== undefined ? b.a : (b.x * U.x + b.z * U.z);
              const bc = b.c !== undefined ? b.c : (b.x * R.x + b.z * R.z);
              sumA += ba;
              if (bc < minC) minC = bc;
              cnt++;
            }
            const avgA = cnt > 0 ? sumA / cnt : 0;
            targetA = clampN(avgA - 36, -82, 210);
            targetC = Math.min(-84, minC - 42) + Math.sin(t * 0.12) * 1.8;
          }
          const desP = toWorld(targetA, targetC);
          let dxJ = desP.x - jb.b.position.x;
          let dzJ = desP.z - jb.b.position.z;
          let distJ = Math.hypot(dxJ, dzJ);
          let stepX = 0, stepZ = 0;
          if (distJ > 0.05 && maxStep > 0) {
            const moveLen = Math.min(maxStep, distJ * 0.35);
            stepX = (dxJ / distJ) * moveLen;
            stepZ = (dzJ / distJ) * moveLen;
          }
          let nextX = jb.b.position.x + stepX;
          let nextZ = jb.b.position.z + stepZ;

          // 全ヨットとの距離をチェックし、42m以内にヨットがいる場合は外側へ避けるベクトルを加算 (ヨットの近くを通ることは絶対にないようにする)
          const MIN_YACHT_CLEAR = 42.0;
          let pushX = 0, pushZ = 0;
          for (const b of boats) {
            if (!b) continue;
            const bx = nextX - b.x, bz = nextZ - b.z;
            const dB = Math.hypot(bx, bz);
            if (dB < MIN_YACHT_CLEAR) {
              const ux = dB > 0.1 ? bx / dB : -R.x;
              const uz = dB > 0.1 ? bz / dB : -R.z;
              const strength = (MIN_YACHT_CLEAR - dB) / MIN_YACHT_CLEAR;
              pushX += ux * strength * 3.0;
              pushZ += uz * strength * 3.0;
            }
          }
          if (pushX !== 0 || pushZ !== 0) {
            let totX = stepX + pushX * maxStep;
            let totZ = stepZ + pushZ * maxStep;
            const totLen = Math.hypot(totX, totZ);
            if (totLen > maxStep && totLen > 1e-5) {
              totX = (totX / totLen) * maxStep;
              totZ = (totZ / totLen) * maxStep;
            }
            nextX = jb.b.position.x + totX;
            nextZ = jb.b.position.z + totZ;
            stepX = totX;
            stepZ = totZ;
          }
          jb.b.position.x = nextX;
          jb.b.position.z = nextZ;
          const moveMag = Math.hypot(stepX, stepZ);
          const desRotY = moveMag > 0.008 ? Math.atan2(stepX, stepZ) : head + 0.04 * Math.sin(t * 0.18);
          let dRot = ((desRotY - jb.b.rotation.y + Math.PI) % (Math.PI * 2));
          if (dRot < 0) dRot += Math.PI * 2;
          dRot -= Math.PI;
          jb.b.rotation.y += dRot * clampN(safeDt * 0.9, 0, 0.05);
        }
      }
      for (const ms of movingShips) {
        // 船首方向(+zがry回転した方向: sin(ry), cos(ry))へゆっくり巡航移動し、一定範囲で滑らかに往復/巡回
        const d = Math.sin(t * (ms.speed / ms.range) + ms.ph) * ms.range;
        ms.obj.position.x = ms.x0 + Math.sin(ms.ry) * d;
        ms.obj.position.z = ms.z0 + Math.cos(ms.ry) * d;
      }
      // マークブイは波に合わせて軽快に揺れ、クルーザーやエンジンボート(運営艇・観覧艇)は排水量が大きいため波の影響・揺れをごく少なく抑える
      for (const o of bob) {
        if (!o.visible) continue;
        const ox = o.position.x, oz = o.position.z;
        const wsX = waveSample(ox, oz, SEA.clock, 1, 0);
        const slX = wsX.slope;
        const wsZ = waveSample(ox, oz, SEA.clock, 0, 1);
        const slZ = wsZ.slope;
        if (o.userData && o.userData.isMarkBuoy) {
          // インフレータブルマークブイ: 海面にしっかり浮かせつつ、実際のアンカー固定マークと同様に波による過度な揺れを抑えて安定させる
          const waveY = wsX.hLong * 0.85 + (wsX.h - wsX.hLong) * 0.32;
          const vRip = 0.016 * Math.sin(ox * 0.42 + oz * 0.31 - SEA.clock * 2.4);
          const bobRip = 0.015 * Math.sin(t * 1.7 + ox * 0.17 + oz * 0.13);
          o.position.y = waveY + vRip + 0.06 + bobRip;
          const body = o.userData.body;
          if (body) {
            body.rotation.z = clampN(-Math.atan(slX) * 0.22 + 0.016 * Math.sin(t * 1.5 + ox * 0.19), -0.042, 0.042);
            body.rotation.x = clampN(Math.atan(slZ) * 0.22 + 0.016 * Math.cos(t * 1.4 + oz * 0.17), -0.042, 0.042);
          }
        } else {
          // クルーザー・エンジンボート: 波による上下動や傾きをごくわずかに抑えてどっしり安定させる
          o.position.y = wsX.hLong * 0.35 + (wsX.h - wsX.hLong) * 0.12 + 0.02 + 0.008 * Math.sin(t * 1.2 + ox * 0.1);
          o.rotation.z = clampN(-Math.atan(slX) * 0.12, -0.024, 0.024) + 0.006 * Math.sin(t * 1.1 + oz * 0.1);
          o.rotation.x = clampN(Math.atan(slZ) * 0.10, -0.018, 0.018) + 0.005 * Math.cos(t * 1.0 + ox * 0.1);
        }
      }
      // 信号旗のはためき＋スタート1分前のP旗降下・0秒のスナイプ級旗降下アニメーション
      flagSway.forEach((f, i) => {
        f.rotation.y = Math.sin(t * 2.6 + i * 1.7) * 0.12;
        const fk = f.userData && f.userData.flagKey;
        const topY = (f.userData && f.userData.topY) ?? f.position.y;
        const botY = (f.userData && f.userData.botY) ?? 0.28;
        if (fk === 'P') {
          // 1分前(wt = -60)の号砲とともにP旗がポール上からスッと降下する演出 (-59.9s 〜 -57.3s で降下完了)
          if (wt < -59.9) {
            f.visible = true;
            f.position.y = topY;
          } else if (wt < -57.3) {
            f.visible = true;
            const prog = clampN((wt - (-59.9)) / 2.6, 0, 1);
            const ease = prog * prog * (3 - 2 * prog);
            f.position.y = topY + (botY - topY) * ease;
          } else {
            f.visible = false;
            f.position.y = botY;
          }
        } else if (fk === 'SNIPE') {
          // 0秒(wt = 0)のスタート号砲の瞬間にスナイプ級旗を勢いよくスパッと降下させる (0.0s 〜 0.26s で急速降下完了)
          if (wt < 0.0) {
            f.visible = true;
            f.position.y = topY;
          } else if (wt < 0.26) {
            f.visible = true;
            const prog = clampN(wt / 0.26, 0, 1);
            const ease = Math.pow(prog, 1.65);
            f.position.y = topY + (botY - topY) * ease;
          } else {
            f.visible = false;
            f.position.y = botY;
          }
        } else if (fk === 'X') {
          // 個別リコール「X旗」: スタート(wt >= 0.12)時点でリコール(OCS)艇がいる場合に掲揚し、全リコール艇がライン下へ戻ったら降下
          const hasOcs = wt >= 0.12 && wt < 240 && Array.isArray(boats) && boats.some((b) => b && b.ocs && !b.dsq);
          if (wt < 0.12) {
            f.visible = false;
            f.position.y = botY;
            f.userData.hoistT = null;
            f.userData.dropT = null;
          } else if (hasOcs) {
            if (f.userData.hoistT == null) f.userData.hoistT = wt;
            f.userData.dropT = null;
            const prog = clampN((wt - f.userData.hoistT) / 0.30, 0, 1);
            const ease = 1 - Math.pow(1 - prog, 2.2);
            f.visible = true;
            f.position.y = botY + (topY - botY) * ease;
          } else if (f.userData.hoistT != null) {
            if (f.userData.dropT == null) f.userData.dropT = wt;
            const prog = clampN((wt - f.userData.dropT) / 0.40, 0, 1);
            if (prog < 1) {
              f.visible = true;
              f.position.y = topY + (botY - topY) * prog;
            } else {
              f.visible = false;
              f.position.y = botY;
              f.userData.hoistT = null;
            }
          } else {
            f.visible = false;
            f.position.y = botY;
          }
        }
      });

      if (!courseVisible) {
        foamTex.offset.x = t * 0.004; foamTex.offset.y = 0.12 * Math.sin(t * 0.7);
        surfMat.opacity = 0.62 + 0.22 * Math.sin(t * 0.7 + 1.2);
        return;
      }

      // スタート後しばらくしたら(wt > 12s〜18s)スタートライン帯とSTART LINEラベルをフェードアウトして消去
      const postStartFade = wt <= 12 ? 1.0 : clampN(1.0 - (wt - 12) / 6.0, 0, 1);
      lineMesh.visible = courseVisible && postStartFade > 0.01;
      lineMesh.material.opacity = 0.68 * postStartFade;
      if (lineMesh.visible) {
        // 波に隠れず、かつ船や本部船より手前に優先描画されない(depthTest: true)よう、ライン各頂点の高さを海面波高+0.16mに追従させる
        const paL = toWorld(MARKS.pin.a, MARKS.pin.c), pbL = toWorld(MARKS.com.a, MARKS.com.c);
        const posAttr = lineGeo.attributes.position;
        for (let vi = 0; vi < posAttr.count; vi++) {
          const uL = (posAttr.getX(vi) / len) + 0.5;
          const wx = paL.x + (pbL.x - paL.x) * uL;
          const wz = paL.z + (pbL.z - paL.z) * uL;
          const wsL = waveSample(wx, wz, SEA.clock);
          posAttr.setZ(vi, wsL.h + 0.16);
        }
        posAttr.needsUpdate = true;
      }

      camera.getWorldDirection(camDir);
      const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      // ドローンカメラと自艇の視線上(0 < along < 44m)にマークが入った場合やカメラ接近時は完全に非表示(0)にして視界を遮らない
      const calcVis = (wx, wy, wz, minDist, fadeRange, checkLos = true) => {
        const dx = wx - cx, dy = wy - cy, dz = wz - cz;
        const dCam = Math.hypot(dx, dz);
        const distFade = clampN((dCam - minDist) / fadeRange, 0, 1);
        if (distFade <= 0.01) return 0;
        if (checkLos) {
          const along = dx * camDir.x + dy * camDir.y + dz * camDir.z;
          if (along > -4 && along < 44) {
            const px = dx - camDir.x * along, py = dy - camDir.y * along, pz = dz - camDir.z * along;
            const perp = Math.hypot(px, py, pz);
            const losFade = clampN((perp - 8) / 9, 0, 1);
            return distFade * losFade;
          }
        }
        return distFade;
      };

      // 1) マーク番号ラベル: 遠方でもはっきり大きく視認でき、近づいた際は大きくなりすぎないよう距離比例スケールを調整
      for (const [k, sp] of Object.entries(markSprites)) {
        const mo = markObjs[k];
        if (!mo.visible) { sp.visible = false; continue; }
        const isAct = activeMarkKeys.includes(k);
        const dCam = Math.hypot(mo.position.x - cx, mo.position.z - cz);
        const s = clampN(1.2 + dCam * (isAct ? 0.078 : 0.062), 2.3, isAct ? 46.0 : 36.0);
        sp.scale.set(s, s, 1);
        sp.position.y = 2.4 + s * 0.56;
        const v = calcVis(mo.position.x, sp.position.y, mo.position.z, isAct ? 18 : 38, 18, true);
        sp.material.opacity = 0.96 * v;
        sp.visible = v > 0.02;
      }

      // 2) START LINE / FINISH ラベル: 遠くからでもしっかり大きく読めつつ、接近時も十分な大きさを保つよう距離比例スケールを調整
      if (startLabel) {
        const dStart = Math.hypot(startLabel.position.x - cx, startLabel.position.z - cz);
        const sw = clampN(7.2 + dStart * 0.34, 12.0, 82.0);
        const sh = sw * (440 / 1200);
        startLabel.scale.set(sw, sh, 1);
        startLabel.position.y = 2.6 + sh * 0.56;
        const v = calcVis(startLabel.position.x, startLabel.position.y, startLabel.position.z, 7, 8, false) * postStartFade;
        startLabel.material.opacity = 0.98 * v;
        startLabel.visible = courseVisible && v > 0.02;
      }
      if (finLabel) {
        const dFin = Math.hypot(finLabel.position.x - cx, finLabel.position.z - cz);
        const fw = clampN(2.2 + dFin * 0.19, 4.8, 50.0);
        const fh = fw * (200 / 768);
        finLabel.scale.set(fw, fh, 1);
        finLabel.position.y = 2.0 + fh * 0.60;
        const v = calcVis(finLabel.position.x, finLabel.position.y, finLabel.position.z, 8, 9, false);
        finLabel.material.opacity = 0.96 * v;
        finLabel.visible = courseVisible && v > 0.02;
      }

      // 3) マークの数字ラベル(またはFINISH)の「さらに上」に赤矢印＋NEXT表記を配置 (遠方でも大きく明瞭に見え、接近時は控えめに縮小)
      for (const ar of targetArrows) {
        if (!ar.visible) continue;
        const dCam = Math.hypot(ar.position.x - cx, ar.position.z - cz);
        const arScale = clampN(0.24 + dCam * 0.0125, 0.42, 6.2);
        ar.scale.setScalar(arScale);
        if (ar.userData.isFinish) {
          const finTopY = finLabel ? (finLabel.position.y + finLabel.scale.y * 0.56) : 4.5;
          ar.position.y = finTopY + 3.8 * arScale + 0.35 * arScale * Math.sin(t * 3.2);
        } else {
          const mk = ar.userData.markKey;
          const sp = mk && markSprites[mk];
          const spTopY = sp ? (sp.position.y + sp.scale.y * 0.56) : 3.5;
          ar.position.y = spTopY + 3.85 * arScale + 0.35 * arScale * Math.sin(t * 3.2);
        }
        ar.rotation.y = t * 1.6;
        const v = calcVis(ar.position.x, ar.position.y, ar.position.z, 18, 15, !ar.userData.isFinish);
        ar.userData.mat.opacity = 0.96 * v;
        if (ar.userData.ringMat) ar.userData.ringMat.opacity = 0.96 * v;
        if (ar.userData.nextMat) ar.userData.nextMat.opacity = 0.98 * v;
      }
      // 磯波: 白波が寄せては引く
      foamTex.offset.x = t * 0.004; foamTex.offset.y = 0.12 * Math.sin(t * 0.7);
      surfMat.opacity = 0.62 + 0.22 * Math.sin(t * 0.7 + 1.2);
    },
  };
}

function addTori(scene, x, h, z) {
  const m = new THREE.MeshLambertMaterial({ color: 0xd2382a });
  const g = new THREE.Group();
  for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 10, 8), m); p.position.set(s * 4, 5, 0); g.add(p); }
  const b1 = new THREE.Mesh(new THREE.BoxGeometry(12.5, 0.9, 1.4), m); b1.position.y = 10.2; g.add(b1);
  const b2 = new THREE.Mesh(new THREE.BoxGeometry(10, 0.7, 1), m); b2.position.y = 8; g.add(b2);
  g.position.set(x, h, z); scene.add(g);
}

// ---------- 八景島ステージ構築 (実地図・セーリングガイド準拠) ----------
// ワールド座標: x=東(+), 西(-), z=南(+), 北(-)。コースは八景島の東側海面(x≈0, z≈0)で北風(15°)スタート(北が風上)。
function buildHakkeijima(root, surfStrip, fgeo, movingShips = []) {
  // 八景島のローカルルール「横浜市大医学部病院(福浦岸壁・ヘリポート)より南側・岸際進入禁止区域ではレースをしない」を厳守し、
  // 東風・西風を含む全風向で上マーク・サイドマーク・スタートラインが岸やヘリポートから十分な沖合距離を保つよう配置
  root.position.set(-390, 0, 1240);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), tc = new THREE.Color(), eul = new THREE.Euler();
  // 八景島本島 (従来より沖側+x・横浜側-zへ移動)
  const H_ISLAND = { x: -1010, z: -60, rx: 430, rz: 460 };

  const hakkeiIslandH = (x, z) => {
    const dx = (x - H_ISLAND.x) / H_ISLAND.rx, dz = (z - H_ISLAND.z) / H_ISLAND.rz;
    const u = dx * 0.92 + dz * 0.38, v = -dx * 0.38 + dz * 0.92;
    const n = noise2(x * 0.007, z * 0.007) * 0.1;
    const r = Math.pow(Math.pow(Math.abs(u), 2.5) + Math.pow(Math.abs(v), 2.5), 1 / 2.5) + n - 0.04;
    if (r >= 1.04) return -6;
    if (r >= 0.96) return -2 + (1.04 - r) * 70; // 人工島の護岸
    const hill = Math.max(0, 1 - Math.hypot(dx + 0.12, dz + 0.05) * 1.6) * 20;
    return 3.5 + hill + noise2(x * 0.03, z * 0.03) * 1.2;
  };

  const xs = [], zs = [];
  for (let i = 0; i <= 130; i++) xs.push(H_ISLAND.x - 520 + (1040 * i) / 130);
  for (let j = 0; j <= 130; j++) zs.push(H_ISLAND.z - 540 + (1080 * j) / 130);
  const islGeo = buildGrid(xs, zs, hakkeiIslandH, (x, z, h, out) => {
    const g = noise2(x / 18, z / 18);
    if (h < 3.6) out.setRGB(0.68, 0.67, 0.64); // コンクリート護岸・プロムナード
    else if (h < 7.2 && x > H_ISLAND.x - 180) out.setRGB(0.76 + 0.05 * g, 0.72 + 0.04 * g, 0.66); // ボードウォーク・広場
    else out.setRGB(0.12 + 0.06 * g, 0.30 + 0.08 * g, 0.11 + 0.04 * g); // 芝生・丘の緑地
  });
  root.add(new THREE.Mesh(islGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  // 1) アクアミュージアム (島の北側・白いピラミッド型の屋根を持つ大水族館) & その手前(東側海面)の防波堤(堤防)
  const aqx = H_ISLAND.x + 40, aqz = H_ISLAND.z - 190;
  const aq = new THREE.Group();
  const aqBase = new THREE.Mesh(new THREE.BoxGeometry(115, 18, 95), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
  aqBase.position.y = 9; aq.add(aqBase);
  const aqRoof = new THREE.Mesh(new THREE.ConeGeometry(68, 36, 4), new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x1e293b }));
  aqRoof.rotation.y = Math.PI / 4; aqRoof.position.set(0, 36, 0); aq.add(aqRoof);
  const aqSubRoof = new THREE.Mesh(new THREE.ConeGeometry(38, 22, 4), new THREE.MeshLambertMaterial({ color: 0xf1f5f9, emissive: 0x1e293b }));
  aqSubRoof.rotation.y = Math.PI / 4; aqSubRoof.position.set(38, 27, 25); aq.add(aqSubRoof);
  aq.position.set(aqx, Math.max(3.5, hakkeiIslandH(aqx, aqz) - 0.5), aqz);
  root.add(aq);

  // アクアミュージアム手前(東・北東側海面)に突き出るコンクリートの堤防(防波堤)と桟橋棟
  const aqBrkGroup = new THREE.Group();
  const aqBrkMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const aqBrkTopMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
  // 北側から東へ伸びる堤防と、水族館正面を囲むように南へ折れ曲がる外堤防・内桟橋
  for (const [bx, bz, bw, bd, rotY] of [
    [H_ISLAND.x + 310, aqz - 95, 230, 14, 0.08],   // 北側〜沖へ突き出る堤防
    [H_ISLAND.x + 425, aqz + 5, 15, 215, -0.10],   // 水族館の手前正面(東側沖)を南北に走る堤防
    [H_ISLAND.x + 355, aqz + 115, 140, 14, 0.25],  // 南端の折れ曲がり堤防
    [H_ISLAND.x + 255, aqz + 90, 145, 16, 0.0]     // 水族館南東側から伸びる桟橋護岸
  ]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(bw, 4.6, bd), aqBrkMat);
    wall.position.set(bx, 1.4, bz); wall.rotation.y = rotY;
    aqBrkGroup.add(wall);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(bw - 1, 0.8, bd + 1.2), aqBrkTopMat);
    cap.position.set(bx, 3.8, bz); cap.rotation.y = rotY;
    aqBrkGroup.add(cap);
  }
  // 堤防先端の赤・白灯台標識と内側の白い2階建て桟橋ハウス(うみファーム/客船ターミナル棟)
  const lhPole = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, 8.5, 10), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
  lhPole.position.set(H_ISLAND.x + 415, 7.5, aqz - 98); aqBrkGroup.add(lhPole);
  const pierBldg = new THREE.Mesh(new THREE.BoxGeometry(34, 8.5, 16), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
  pierBldg.position.set(H_ISLAND.x + 275, 6.2, aqz + 90); aqBrkGroup.add(pierBldg);
  const pierRoof = new THREE.Mesh(new THREE.ConeGeometry(22, 4.2, 4), new THREE.MeshLambertMaterial({ color: 0x94a3b8 }));
  pierRoof.rotation.y = Math.PI / 4; pierRoof.scale.set(1.2, 1, 0.7);
  pierRoof.position.set(H_ISLAND.x + 275, 12.4, aqz + 90); aqBrkGroup.add(pierRoof);
  root.add(aqBrkGroup);

  // 2) 旧ブルーフォール跡 (高さ107mのタワーは2020年3月に営業終了・同年解体済み → 跡地の中型アトラクション「フライトイーグル」級の門型フレームに置き換え)
  const bfx = H_ISLAND.x - 175, bfz = H_ISLAND.z - 210;
  const bfGroup = new THREE.Group();
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(2.2, 30, 2.2), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
    leg.position.set(s * 11, 15, 0); leg.rotation.z = s * 0.12; bfGroup.add(leg);
  }
  const bfTop = new THREE.Mesh(new THREE.BoxGeometry(20, 2.6, 3.2), new THREE.MeshLambertMaterial({ color: 0x0284c7 }));
  bfTop.position.y = 30; bfGroup.add(bfTop);
  const bfCap = new THREE.Mesh(new THREE.BoxGeometry(6, 3.5, 9), new THREE.MeshLambertMaterial({ color: 0xf59e0b }));
  bfCap.position.y = 18; bfGroup.add(bfCap);
  bfGroup.position.set(bfx, Math.max(3.5, hakkeiIslandH(bfx, bfz)), bfz);
  root.add(bfGroup);

  // 3) シーパラダイスタワー (高さ90mのパノラマ展望タワー: アクアミュージアムの少し南)
  const stx = H_ISLAND.x + 95, stz = H_ISLAND.z - 55;
  const stGroup = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.8, 88, 16), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
  mast.position.y = 44; stGroup.add(mast);
  for (let i = 0; i < 4; i++) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.65, 5, 16), new THREE.MeshLambertMaterial({ color: 0x1d4ed8 }));
    band.position.y = 18 + i * 18; stGroup.add(band);
  }
  const cabin = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, 4.2, 24), new THREE.MeshLambertMaterial({ color: 0x38bdf8, emissive: 0x0c4a6e }));
  cabin.position.y = 74; stGroup.add(cabin);
  const cabinRing = new THREE.Mesh(new THREE.CylinderGeometry(9.0, 9.0, 1.2, 24), new THREE.MeshLambertMaterial({ color: 0xffffff }));
  cabinRing.position.y = 76.2; stGroup.add(cabinRing);
  stGroup.position.set(stx, Math.max(3.5, hakkeiIslandH(stx, stz)), stz);
  root.add(stGroup);

  // 4) サーフコースター リヴァイアサン (水族館の南側・少し奥寄りに位置する青い海上ジェットコースター)
  const coaster = new THREE.Group();
  const railMat = new THREE.MeshLambertMaterial({ color: 0x0284c7 }); // 青色のコースターレール
  const trussMat = new THREE.MeshLambertMaterial({ color: 0x38bdf8 });
  const pillarMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
  const loopCx = H_ISLAND.x + 150, loopCz = H_ISLAND.z + 35; // 以前より少し奥側(西寄り)に配置
  for (let i = 0; i < 36; i++) {
    const t = (i / 36) * Math.PI * 2;
    const rx = loopCx + Math.cos(t) * 105, rz = loopCz + Math.sin(t) * 150;
    const ry = 10 + 25 * Math.pow(Math.sin(t * 2 + 0.3) * 0.5 + 0.5, 1.35);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(30, 2.4, 3.6), railMat);
    seg.position.set(rx, ry, rz);
    seg.rotation.y = -Math.atan2(Math.cos(t) * 150, -Math.sin(t) * 105);
    coaster.add(seg);
    const sub = new THREE.Mesh(new THREE.BoxGeometry(30, 1.0, 2.2), trussMat);
    sub.position.set(rx, ry - 1.6, rz); sub.rotation.y = seg.rotation.y;
    coaster.add(sub);
    if (i % 2 === 0) {
      const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.9, ry + 3, 6), pillarMat);
      pil.position.set(rx, ry / 2 - 1.5, rz);
      coaster.add(pil);
    }
  }
  root.add(coaster);

  // 5) ホテル シーパラダイス イン & その手前(海側・東側)の八景島マリーナ
  const htx = H_ISLAND.x + 40, htz = H_ISLAND.z + 310;
  const hotel = new THREE.Mesh(new THREE.BoxGeometry(42, 30, 95), new THREE.MeshLambertMaterial({ color: 0xfef3c7 }));
  hotel.position.set(htx, 18, htz); root.add(hotel);
  const hotelRoof = new THREE.Mesh(new THREE.BoxGeometry(45, 3, 98), new THREE.MeshLambertMaterial({ color: 0xb45309 }));
  hotelRoof.position.set(htx, 34, htz); root.add(hotelRoof);

  // 八景島マリーナ (ホテル棟のすぐ手前＝コース側、屋根は赤ではなく白〜明るいシルバーグレーのクラブハウス)
  const mhx = H_ISLAND.x + 290, mhz = H_ISLAND.z + 310;
  const conc = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const yard = new THREE.Mesh(new THREE.BoxGeometry(150, 3.2, 230), conc); yard.position.set(mhx, 0.6, mhz); root.add(yard);
  const club = new THREE.Mesh(new THREE.BoxGeometry(42, 9.5, 26), new THREE.MeshLambertMaterial({ color: 0xf8fafc })); club.position.set(mhx - 28, 6.8, mhz - 50); root.add(club);
  const clubRotunda = new THREE.Mesh(new THREE.CylinderGeometry(9.5, 9.5, 10.5, 16), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 })); clubRotunda.position.set(mhx - 7, 7.2, mhz - 50); root.add(clubRotunda);
  const clubRoof = new THREE.Mesh(new THREE.ConeGeometry(26, 4.5, 4), new THREE.MeshLambertMaterial({ color: 0xcbd5e1 })); clubRoof.rotation.y = Math.PI / 4; clubRoof.scale.set(1.15, 1, 0.8); clubRoof.position.set(mhx - 28, 13.8, mhz - 50); root.add(clubRoof);
  const clubRotRoof = new THREE.Mesh(new THREE.ConeGeometry(10.5, 3.2, 16), new THREE.MeshLambertMaterial({ color: 0x94a3b8 })); clubRotRoof.position.set(mhx - 7, 14.0, mhz - 50); root.add(clubRotRoof);
  const brk = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
  for (const [x, z, w, d] of [[mhx + 240, mhz, 10, 250], [mhx + 150, mhz - 125, 190, 10], [mhx + 130, mhz + 125, 150, 10]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, 4.2, d), brk); b.position.set(x, 1.0, z); root.add(b);
  }
  const hulls = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 1, 7), new THREE.MeshLambertMaterial({ color: 0xffffff }), 55);
  const masts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.15, 11, 5), new THREE.MeshLambertMaterial({ color: 0xcfd3d8 }), 55);
  for (let i = 0; i < 55; i++) {
    const x = mhx + 85 + (i % 11) * 13, z = mhz - 95 + Math.floor(i / 11) * 44;
    m4.makeTranslation(x, 0.6, z); hulls.setMatrixAt(i, m4); tc.setHSL(rnd(), 0.25, 0.88); hulls.setColorAt(i, tc);
    m4.makeTranslation(x, 6.4, z); masts.setMatrixAt(i, m4);
  }
  root.add(hulls, masts);

  // 八景島内の木々 (複数の葉塊クラスター＋陰影頂点カラー＋枝分かれ幹を持つリアルな広葉樹＆海岸黒松)
  const hTreeCount = 620, hPineCount = 260;
  const hTrees = new THREE.InstancedMesh(getBroadTreeCrownGeo(), new THREE.MeshLambertMaterial({ vertexColors: true }), hTreeCount);
  const hPines = new THREE.InstancedMesh(getPineTreeCrownGeo(), new THREE.MeshLambertMaterial({ vertexColors: true }), hPineCount);
  const hTrunks = new THREE.InstancedMesh(getTreeTrunkGeo(), new THREE.MeshLambertMaterial({ color: 0x563d2d, vertexColors: true }), hTreeCount + hPineCount);
  let tn = 0, pn = 0, trkN = 0;
  for (let tries = 0; tries < 5500 && (tn < hTreeCount || pn < hPineCount); tries++) {
    const x = H_ISLAND.x + (rnd() * 2 - 1) * 390, z = H_ISLAND.z + (rnd() * 2 - 1) * 410;
    const h = hakkeiIslandH(x, z); if (h < 4.2) continue;
    if (Math.hypot(x - aqx, z - aqz) < 75) continue;
    const s = 4.2 + rnd() * 4.6;
    const ry = rnd() * 6.28;
    q.setFromEuler(eul.set(0, ry, 0));
    const isPine = (h < 7.8 || rnd() < 0.30) && pn < hPineCount;
    if (isPine || tn >= hTreeCount) {
      if (pn >= hPineCount) continue;
      m4.compose(new THREE.Vector3(x, h + s * 0.76, z), q, new THREE.Vector3(s * (0.98 + rnd() * 0.25), s * (0.82 + rnd() * 0.22), s * (0.98 + rnd() * 0.25)));
      hPines.setMatrixAt(pn, m4);
      tc.setRGB(0.09 + rnd() * 0.05, 0.24 + rnd() * 0.09, 0.08 + rnd() * 0.04);
      hPines.setColorAt(pn, tc);
      pn++;
    } else {
      m4.compose(new THREE.Vector3(x, h + s * 0.74, z), q, new THREE.Vector3(s * (0.95 + rnd() * 0.28), s * (0.80 + rnd() * 0.22), s * (0.95 + rnd() * 0.28)));
      hTrees.setMatrixAt(tn, m4);
      tc.setRGB(0.11 + rnd() * 0.06, 0.27 + rnd() * 0.12, 0.09 + rnd() * 0.04);
      hTrees.setColorAt(tn, tc);
      tn++;
    }
    m4.compose(new THREE.Vector3(x, h - 0.15, z), q, new THREE.Vector3(s * 0.58, s * 0.80, s * 0.58));
    hTrunks.setMatrixAt(trkN++, m4);
  }
  q.identity();
  hTrees.count = tn; hPines.count = pn; hTrunks.count = trkN;
  root.add(hTrunks, hTrees, hPines);

  // 6) 八景島大橋 & シーサイドライン高架橋 (福浦・海の公園側から水道を大きく跨いで八景島へ伸びる非常に長い橋と中央主塔)
  const ohGroup = new THREE.Group();
  const ohX = H_ISLAND.x - 420, ohZ = H_ISLAND.z - 480;
  const ohRot = 0.22;
  // 長大な連続高架橋デッキ (全長約1,150m)
  const ohDeck = new THREE.Mesh(new THREE.BoxGeometry(20, 3.6, 1150), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
  ohDeck.position.set(ohX, 15.5, ohZ); ohDeck.rotation.y = ohRot; ohGroup.add(ohDeck);
  // 特徴的な中央の白い主塔 (斜張橋・エクストラドーズド風の白い1本主塔とケーブル、および青いアーチ桁)
  const pylon = new THREE.Mesh(new THREE.BoxGeometry(5.5, 56, 7.5), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
  pylon.position.set(ohX, 34, ohZ); pylon.rotation.y = ohRot; ohGroup.add(pylon);
  for (const s of [-7.5, 7.5]) {
    const archRib = new THREE.Mesh(new THREE.TorusGeometry(95, 2.2, 8, 32, Math.PI), new THREE.MeshLambertMaterial({ color: 0x0284c7 }));
    archRib.rotation.y = Math.PI / 2 + ohRot;
    archRib.scale.set(1.2, 0.55, 1);
    archRib.position.set(ohX + s * Math.cos(ohRot), 16.0, ohZ - s * Math.sin(ohRot));
    ohGroup.add(archRib);
  }
  // 長い橋を支える多数の橋脚列
  for (let dz = -520; dz <= 520; dz += 80) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(22, 18, 6.5), new THREE.MeshLambertMaterial({ color: 0x94a3b8 }));
    pier.position.set(ohX + dz * Math.sin(ohRot), 7, ohZ + dz * Math.cos(ohRot));
    pier.rotation.y = ohRot; ohGroup.add(pier);
  }
  // マリンゲート橋 (八景島西側〜海の公園側を結ぶ長い連絡橋)
  const brMesh = new THREE.Mesh(new THREE.BoxGeometry(780, 3.0, 13), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
  brMesh.position.set(H_ISLAND.x - 660, 12.0, H_ISLAND.z - 160); ohGroup.add(brMesh);
  for (let dx = -340; dx <= 340; dx += 85) {
    const mp = new THREE.Mesh(new THREE.BoxGeometry(6, 14, 15), new THREE.MeshLambertMaterial({ color: 0x94a3b8 }));
    mp.position.set(H_ISLAND.x - 660 + dx, 5.5, H_ISLAND.z - 160); ohGroup.add(mp);
  }
  const mgArch = new THREE.Mesh(new THREE.TorusGeometry(48, 1.8, 8, 24, Math.PI), new THREE.MeshLambertMaterial({ color: 0x38bdf8 }));
  mgArch.position.set(H_ISLAND.x - 510, 13.0, H_ISLAND.z - 160); ohGroup.add(mgArch);
  root.add(ohGroup);

  // 7) 八景島の北側: 福浦エリア・セーリングガイド記載の名物ランドマーク群と海岸線の並木
  // (横浜市大病院・ヘリポート・海岸線の並木・テクノタワーホテル・ヤグラ型エントツ・焼却炉・三菱重工)
  const fukuura = new THREE.Group();
  const fkLand = new THREE.Mesh(new THREE.BoxGeometry(2250, 4.5, 3200), new THREE.MeshLambertMaterial({ color: 0xd6d3c9 }));
  fkLand.position.set(-1675, 1.2, -2250); fukuura.add(fkLand);
  const fkWall = new THREE.Mesh(new THREE.BoxGeometry(16, 5.2, 3200), new THREE.MeshLambertMaterial({ color: 0xcbd5e1 }));
  fkWall.position.set(-555, 1.6, -2250); fukuura.add(fkWall);

  // (7-a) 海岸線の並木 (ヘリポート北側からヤグラ型エントツ手前まで海岸線に沿ってリアルな広葉樹と黒松が並ぶ)
  const coastTreeCount = 130, coastPineCount = 80;
  const coastTrees = new THREE.InstancedMesh(getBroadTreeCrownGeo(), new THREE.MeshLambertMaterial({ vertexColors: true }), coastTreeCount);
  const coastPines = new THREE.InstancedMesh(getPineTreeCrownGeo(), new THREE.MeshLambertMaterial({ vertexColors: true }), coastPineCount);
  const coastTrunks = new THREE.InstancedMesh(getTreeTrunkGeo(), new THREE.MeshLambertMaterial({ color: 0x583e2e, vertexColors: true }), coastTreeCount + coastPineCount);
  let ctn = 0, cpn = 0, ctrk = 0;
  for (let z = -700; z >= -2140; z -= 16) {
    for (const row of [0, 1]) {
      const tx = -572 - row * 16 + (rnd() - 0.5) * 5;
      const tz = z - row * 9 + (rnd() - 0.5) * 5;
      const s = 9.2 + rnd() * 4.2;
      const ry = rnd() * 6.28;
      q.setFromEuler(eul.set(0, ry, 0));
      if ((row === 0 && rnd() < 0.42 && cpn < coastPineCount) || ctn >= coastTreeCount) {
        if (cpn >= coastPineCount) continue;
        m4.compose(new THREE.Vector3(tx, 3.5 + s * 0.80, tz), q, new THREE.Vector3(s * 0.98, s * 0.85, s * 0.98));
        coastPines.setMatrixAt(cpn, m4);
        tc.setRGB(0.09 + rnd() * 0.05, 0.26 + rnd() * 0.09, 0.08 + rnd() * 0.04);
        coastPines.setColorAt(cpn, tc);
        cpn++;
      } else {
        m4.compose(new THREE.Vector3(tx, 3.5 + s * 0.78, tz), q, new THREE.Vector3(s * 0.96, s * 0.84, s * 0.96));
        coastTrees.setMatrixAt(ctn, m4);
        tc.setRGB(0.11 + rnd() * 0.06, 0.30 + rnd() * 0.11, 0.09 + rnd() * 0.05);
        coastTrees.setColorAt(ctn, tc);
        ctn++;
      }
      m4.compose(new THREE.Vector3(tx, 3.2, tz), q, new THREE.Vector3(s * 0.55, s * 0.82, s * 0.55));
      coastTrunks.setMatrixAt(ctrk++, m4);
    }
  }
  q.identity();
  coastTrees.count = ctn; coastPines.count = cpn; coastTrunks.count = ctrk;
  fukuura.add(coastTrunks, coastTrees, coastPines);

  // (7-b) 海に突き出た「横浜ヘリポート」
  const hpx = -390, hpz = -780;
  const hpPad = new THREE.Mesh(new THREE.BoxGeometry(340, 4.2, 240), new THREE.MeshLambertMaterial({ color: 0x64748b }));
  hpPad.position.set(hpx, 1.1, hpz); fukuura.add(hpPad);
  const hpApron = new THREE.Mesh(new THREE.PlaneGeometry(300, 200), new THREE.MeshBasicMaterial({ color: 0x334155 }));
  hpApron.rotation.x = -Math.PI / 2; hpApron.position.set(hpx, 3.3, hpz); fukuura.add(hpApron);
  const hRing = new THREE.Mesh(new THREE.RingGeometry(34, 40, 32), new THREE.MeshBasicMaterial({ color: 0xfacc15, side: THREE.DoubleSide }));
  hRing.rotation.x = -Math.PI / 2; hRing.position.set(hpx + 45, 3.4, hpz); fukuura.add(hRing);
  for (const dx of [-13, 13]) {
    const hBar = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 36), new THREE.MeshBasicMaterial({ color: 0xfacc15 }));
    hBar.rotation.x = -Math.PI / 2; hBar.position.set(hpx + 45 + dx, 3.42, hpz); fukuura.add(hBar);
  }
  const hCross = new THREE.Mesh(new THREE.PlaneGeometry(26, 5.5), new THREE.MeshBasicMaterial({ color: 0xfacc15 }));
  hCross.rotation.x = -Math.PI / 2; hCross.position.set(hpx + 45, 3.42, hpz); fukuura.add(hCross);

  // (7-c) 横浜市大病院 (ヘリポートのすぐ背後 x=-635, z=-800 に建つ十字・段差型の大きな大学病院棟: 窓帯と赤十字看板付きで海上からしっかり見える)
  const hospGroup = new THREE.Group();
  const hospX = -635, hospZ = -800;
  const hospMat = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const hospSubMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
  const hospWinMat = new THREE.MeshLambertMaterial({ color: 0x334155 });
  // 中央高層病棟 + 南北ウイング + 東側外来棟 (イラストの立体十字形状を再現)
  for (const [dx, dz, bw, bh, bd, mat] of [
    [0, 0, 95, 74, 150, hospMat],       // 中央主病棟
    [55, 0, 75, 54, 95, hospSubMat],    // 海側(東)ウイング
    [-55, 0, 75, 58, 105, hospSubMat],  // 西ウイング
    [15, -85, 80, 46, 65, hospMat],     // 北ウイング
    [15, 85, 80, 46, 65, hospMat],      // 南ウイング
  ]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
    wing.position.set(dx, bh / 2 + 3, dz); hospGroup.add(wing);
    for (let wy = 12; wy < bh - 4; wy += 9) {
      const wBand = new THREE.Mesh(new THREE.BoxGeometry(bw + 1.5, 3.2, bd + 1.5), hospWinMat);
      wBand.position.set(dx, wy + 3, dz); hospGroup.add(wBand);
    }
  }
  // 病院屋上のペントハウス
  const hospTop = new THREE.Mesh(new THREE.BoxGeometry(48, 14, 52), new THREE.MeshLambertMaterial({ color: 0x0284c7 }));
  hospTop.position.set(0, 84, 0); hospGroup.add(hospTop);
  hospGroup.position.set(hospX, 0, hospZ);
  fukuura.add(hospGroup);

  // (7-d) 横浜テクノタワーホテル (参考写真準拠: 白い高層タワー・四角い窓グリッド・上層部の青いガラス展望フロア帯・屋上の四角い吹き抜けフレーム冠・低層の三角ガラス屋根アトリウム)
  // 手前にあった無機質な箱型ビル群は削除し、海岸線の並木越しに高く聳える実際の景観を再現
  const tthGroup = new THREE.Group();
  const tthX = -675, tthZ = -1460;
  const tthMat = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const tthSideMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
  const tthBlueGlass = new THREE.MeshLambertMaterial({ color: 0x0369a1, emissive: 0x082f49 });
  // 1) メイン高層ホワイトタワー (高さ148m + 屋上吹き抜けフレーム冠20m = 全高168m)
  const tthShaft = new THREE.Mesh(new THREE.BoxGeometry(54, 148, 50), tthMat);
  tthShaft.position.set(0, 76, 0); tthGroup.add(tthShaft);
  // 背後の段差ウイング
  const tthWing = new THREE.Mesh(new THREE.BoxGeometry(48, 118, 44), tthSideMat);
  tthWing.position.set(-18, 61, -22); tthGroup.add(tthWing);
  // 2) 上層部の青いガラス展望フロア帯 (写真の特徴的な最上階下の青ガラス帯)
  const obsGlass = new THREE.Mesh(new THREE.BoxGeometry(55.2, 11, 51.2), tthBlueGlass);
  obsGlass.position.set(0, 136, 0); tthGroup.add(obsGlass);
  // 3) 白い外壁に整然と並ぶ四角い窓グリッド帯
  for (let wy = 22; wy <= 124; wy += 8.5) {
    const wRow = new THREE.Mesh(new THREE.BoxGeometry(54.8, 3.4, 44), hospWinMat);
    wRow.position.set(0, wy, 0); tthGroup.add(wRow);
  }
  // 4) 屋上の特徴的な白い四角い吹き抜けフレーム冠 (4本の白柱 + 上部四辺フレーム梁)
  const crownY = 150, crownH = 18;
  for (const [cx, cz] of [[-21, -19], [21, -19], [-21, 19], [21, 19]]) {
    const col = new THREE.Mesh(new THREE.BoxGeometry(5.2, crownH, 5.2), tthMat);
    col.position.set(cx, crownY + crownH / 2, cz); tthGroup.add(col);
  }
  for (const cz of [-19, 19]) {
    const beamX = new THREE.Mesh(new THREE.BoxGeometry(47.2, 4.5, 5.2), tthMat);
    beamX.position.set(0, crownY + crownH, cz); tthGroup.add(beamX);
  }
  for (const cx of [-21, 21]) {
    const beamZ = new THREE.Mesh(new THREE.BoxGeometry(5.2, 4.5, 43.2), tthMat);
    beamZ.position.set(cx, crownY + crownH, 0); tthGroup.add(beamZ);
  }
  // 5) 足元の低層ホール棟 + 写真手前に見える特徴的な青い三角ガラス屋根アトリウム
  const lowBase = new THREE.Mesh(new THREE.BoxGeometry(68, 22, 92), tthSideMat);
  lowBase.position.set(16, 13, 18); tthGroup.add(lowBase);
  const atrium = new THREE.Mesh(new THREE.CylinderGeometry(24, 24, 56, 3), tthBlueGlass);
  atrium.rotation.x = Math.PI / 2; atrium.rotation.y = Math.PI;
  atrium.scale.set(1.15, 1, 0.55);
  atrium.position.set(34, 26, 26); tthGroup.add(atrium);
  tthGroup.position.set(tthX, 0, tthZ);
  fukuura.add(tthGroup);

  // (7-d2) テクノタワー周辺(福浦1・2丁目〜幸浦1・2丁目 金沢工業団地)のリアルな工場・研究所・プラント・煙突群
  // 単調な箱ではなく、カーテンウォール窓帯・縦ルーバー・越屋根・屋上空調塔・ステンレスサイロ・煙道ダクト・点検デッキ付き煙突で精密に構築
  const indWhiteMat = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const indLightMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
  const indWarmMat = new THREE.MeshLambertMaterial({ color: 0xe7e5e4 });
  const indSilverMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const indSteelMat = new THREE.MeshLambertMaterial({ color: 0x475569 });
  const indDarkWinMat = new THREE.MeshLambertMaterial({ color: 0x1e293b });
  const indBlueGlassMat = new THREE.MeshLambertMaterial({ color: 0x0369a1, emissive: 0x082f49 });
  const indAccentBlueMat = new THREE.MeshLambertMaterial({ color: 0x0284c7 });
  const indRedMat = new THREE.MeshLambertMaterial({ color: 0xdc2626 });

  // ヘルパー1: 窓帯・縦マリオン・屋上設備棟・コーポレートカラー帯を備えたリアルな研究棟・工場ビル
  const addDetailedFacility = (gx, gz, w, h, d, wallMat, winMat, accentMat, opts = {}) => {
    const g = new THREE.Group();
    const main = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    main.position.y = h / 2 + 3; g.add(main);
    // 1階基壇部(重厚なグレーのポディウム)
    const podium = new THREE.Mesh(new THREE.BoxGeometry(w + 1.8, 5.5, d + 1.8), indSilverMat);
    podium.position.y = 5.2; g.add(podium);
    // 水平連窓ガラス帯
    const floors = Math.max(2, Math.floor((h - 7) / 6.2));
    for (let f = 0; f < floors; f++) {
      const wy = 9.5 + f * 6.2;
      if (wy > h - 1.5) break;
      const wb = new THREE.Mesh(new THREE.BoxGeometry(w + 0.9, 2.5, d - 3.5), winMat);
      wb.position.y = wy; g.add(wb);
      const wbZ = new THREE.Mesh(new THREE.BoxGeometry(w - 3.5, 2.5, d + 0.9), winMat);
      wbZ.position.y = wy; g.add(wbZ);
    }
    // 外壁の縦ピラスター(柱型・ルーバーフィン)
    const pilStep = Math.max(12, Math.round(d / 6));
    for (let pz = -d / 2 + 6; pz <= d / 2 - 6; pz += pilStep) {
      const pil = new THREE.Mesh(new THREE.BoxGeometry(w + 1.4, h - 2, 1.3), wallMat);
      pil.position.set(0, h / 2 + 3, pz); g.add(pil);
    }
    // パラペット上端のコーポレートライン帯
    if (accentMat) {
      const fascia = new THREE.Mesh(new THREE.BoxGeometry(w + 1.6, 2.2, d + 1.6), accentMat);
      fascia.position.y = h + 2.4; g.add(fascia);
    }
    // 屋上スラブ縁と機械室ペントハウス＋冷却塔ルーバー
    const roofCap = new THREE.Mesh(new THREE.BoxGeometry(w - 2, 1.2, d - 2), indSteelMat);
    roofCap.position.y = h + 3.4; g.add(roofCap);
    const phW = w * 0.36, phH = opts.phH || 6.5, phD = d * 0.32;
    const pent = new THREE.Mesh(new THREE.BoxGeometry(phW, phH, phD), indLightMat);
    pent.position.set(-w * 0.14, h + 3 + phH / 2, -d * 0.12); g.add(pent);
    const pentLouv = new THREE.Mesh(new THREE.BoxGeometry(phW + 0.6, phH * 0.45, phD * 0.7), indSteelMat);
    pentLouv.position.set(-w * 0.14, h + 3 + phH * 0.55, -d * 0.12); g.add(pentLouv);
    // 外付けエレベーター/階段コア塔
    if (opts.coreSide) {
      const cw = 11, ch = h + phH + 2.5, cd = 13;
      const core = new THREE.Mesh(new THREE.BoxGeometry(cw, ch, cd), indSilverMat);
      core.position.set((w / 2 + cw / 2 - 1) * opts.coreSide, ch / 2 + 3, d * 0.22); g.add(core);
      const coreGlass = new THREE.Mesh(new THREE.BoxGeometry(cw + 0.5, ch - 6, 4.2), indBlueGlassMat);
      coreGlass.position.set((w / 2 + cw / 2 - 1) * opts.coreSide, ch / 2 + 3, d * 0.22); g.add(coreGlass);
    }
    // ノコギリ屋根/採光モニター屋根(工場棟オプション)
    if (opts.monitors) {
      const mCount = opts.monitors;
      const mSpan = (d - 14) / mCount;
      for (let i = 0; i < mCount; i++) {
        const mz = -d / 2 + 7 + (i + 0.5) * mSpan;
        const mon = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, w - 8, 3), wallMat);
        mon.rotation.z = Math.PI / 2; mon.scale.set(0.65, 1, 1.3);
        mon.position.set(0, h + 4.8, mz); g.add(mon);
      }
    }
    g.position.set(gx, 0, gz);
    fukuura.add(g);
    return g;
  };

  // ヘルパー2: 点検キャットウォーク・航空障害灯赤白帯・基礎煙道ダクト付きのリアルな工業煙突
  const addDetailedChimney = (cx, cz, height, rTop, rBot, style = 'redwhite') => {
    const g = new THREE.Group();
    // コンクリート基礎台座 + 工場からの煙道ダクト
    const ped = new THREE.Mesh(new THREE.BoxGeometry(rBot * 3.1, 9, rBot * 3.1), indSilverMat);
    ped.position.y = 6.5; g.add(ped);
    const duct = new THREE.Mesh(new THREE.BoxGeometry(22, 4.8, rBot * 1.3), indSteelMat);
    duct.position.set(-10, 8.5, 0); duct.rotation.z = -0.12; g.add(duct);

    if (style === 'twin') {
      // 2本束ねのシルバー集合煙突 + 外周鉄骨リングフレーム
      for (const sz of [-rBot * 0.68, rBot * 0.68]) {
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(rTop * 0.58, rBot * 0.62, height, 14), indSilverMat);
        pipe.position.set(0, height / 2 + 4, sz); g.add(pipe);
        const tip = new THREE.Mesh(new THREE.CylinderGeometry(rTop * 0.60, rTop * 0.60, 4.5, 14), indDarkWinMat);
        tip.position.set(0, height + 2.5, sz); g.add(tip);
        const blueBand = new THREE.Mesh(new THREE.CylinderGeometry(rTop * 0.62, rTop * 0.64, 5.5, 14), indAccentBlueMat);
        blueBand.position.set(0, height - 6, sz); g.add(blueBand);
      }
      for (let y = 18; y <= height - 6; y += 14) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(rBot * 1.7, 1.4, rBot * 2.5), indSteelMat);
        brace.position.set(0, y + 4, 0); g.add(brace);
      }
    } else {
      // テーパー円筒煙突本体
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, height, 16), indWhiteMat);
      shaft.position.y = height / 2 + 4; g.add(shaft);
      if (style === 'redwhite') {
        // 上部〜中部の紅白縞(航空障害標識)
        const bandH = 8.5;
        for (let b = 0; b < 4; b++) {
          const by = height + 4 - (b * 2 + 0.6) * bandH;
          if (by < 22) break;
          const tFrac = 1 - (by - 4) / height;
          const br = rTop + (rBot - rTop) * tFrac + 0.16;
          const band = new THREE.Mesh(new THREE.CylinderGeometry(br - 0.08, br + 0.08, bandH, 16), indRedMat);
          band.position.y = by; g.add(band);
        }
      } else if (style === 'blueband') {
        for (const dy of [6, 16]) {
          const band = new THREE.Mesh(new THREE.CylinderGeometry(rTop + 0.22, rTop + 0.32, 4.8, 16), indAccentBlueMat);
          band.position.y = height + 4 - dy; g.add(band);
        }
      }
      // 先端の黒色排煙ノズル
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(rTop * 0.86, rTop * 0.96, 4.0, 16), indDarkWinMat);
      nozzle.position.y = height + 5.5; g.add(nozzle);
      // 3段の点検キャットウォーク(円形手すりデッキ)とタラップ支柱
      for (const frac of [0.38, 0.66, 0.88]) {
        const py = 4 + height * frac;
        const pr = rTop + (rBot - rTop) * (1 - frac) + 1.35;
        const catwalk = new THREE.Mesh(new THREE.CylinderGeometry(pr, pr, 1.1, 16), indSteelMat);
        catwalk.position.y = py; g.add(catwalk);
      }
      const ladder = new THREE.Mesh(new THREE.BoxGeometry(0.9, height - 6, 1.1), indSteelMat);
      ladder.position.set(rTop + (rBot - rTop) * 0.45 + 0.6, height / 2 + 4, 0); g.add(ladder);
    }
    g.position.set(cx, 0, cz);
    fukuura.add(g);
    return g;
  };

  // [A] テクノタワー南側エリア (z = -1040 〜 -1350: 精密機器R&Dセンター・製薬プラント・食品サイロ工場と紅白煙突・2本束ね煙突)
  // 1) 南側先端: 大型精密機器R&Dセンター棟 (ガラスカーテンウォール＋青帯＋エレベーターコア)
  addDetailedFacility(-725, -1085, 68, 38, 118, indWhiteMat, indBlueGlassMat, indAccentBlueMat, { coreSide: 1, phH: 7.5 });
  // 2) 製薬・バイオ研究プラント棟 + 高さ84mの紅白縞ボイラー煙突 (海上からテクノタワー左隣に鮮やかに見えるランドマーク煙突)
  addDetailedFacility(-740, -1245, 76, 32, 110, indLightMat, indDarkWinMat, null, { coreSide: -1, monitors: 3 });
  addDetailedChimney(-692, -1210, 84, 3.0, 4.8, 'redwhite');
  // 3) 食品・飲料プラント棟 + ステンレス6連貯蔵サイロ群 + 2本束ねシルバー集合煙突(高さ68m)
  addDetailedFacility(-785, -1355, 72, 26, 92, indWarmMat, indDarkWinMat, indAccentBlueMat, { monitors: 4 });
  addDetailedChimney(-715, -1340, 68, 2.8, 3.8, 'twin');
  const siloGroup = new THREE.Group();
  for (let sx = 0; sx < 2; sx++) {
    for (let sz = 0; sz < 3; sz++) {
      const sMesh = new THREE.Mesh(new THREE.CylinderGeometry(5.8, 5.8, 28, 14), indSilverMat);
      sMesh.position.set(sx * 14, 17, sz * 14); siloGroup.add(sMesh);
      const sCone = new THREE.Mesh(new THREE.ConeGeometry(6.1, 4.5, 14), indWhiteMat);
      sCone.position.set(sx * 14, 33.2, sz * 14); siloGroup.add(sCone);
    }
  }
  const siloBridge = new THREE.Mesh(new THREE.BoxGeometry(20, 2.6, 36), indSteelMat);
  siloBridge.position.set(7, 35.8, 14); siloGroup.add(siloBridge);
  siloGroup.position.set(-702, 0, -1370);
  fukuura.add(siloGroup);

  // [B] テクノタワー直近・産業振興センター複合研究棟群 (z = -1420 〜 -1580: テクノタワーの足元〜すぐ背後・北隣を固める中層インテリジェントビル)
  addDetailedFacility(-765, -1485, 64, 46, 96, indWhiteMat, indBlueGlassMat, indAccentBlueMat, { coreSide: 1, phH: 8.5 });
  addDetailedFacility(-720, -1595, 66, 36, 98, indLightMat, indBlueGlassMat, null, { coreSide: 1, phH: 6.5 });
  // テクノタワー低層棟と隣接研究棟を結ぶ空中連絡ブリッジ(スカイウォーク)
  const skyBridge = new THREE.Mesh(new THREE.BoxGeometry(52, 4.5, 8.5), indBlueGlassMat);
  skyBridge.position.set(-720, 18.5, -1470); fukuura.add(skyBridge);

  // [C] テクノタワー北側エリア (z = -1680 〜 -2080: コージェネエネルギーセンター＋高層煙突・大型物流センター・化学プラント群)
  // 1) 福浦エネルギーセンター・ボイラータービン建屋 + 高さ96mの紅白高層煙突(点検デッキ・煙道ダクト付き)
  addDetailedFacility(-745, -1735, 78, 34, 108, indWarmMat, indDarkWinMat, null, { coreSide: 1, phH: 9.0 });
  addDetailedChimney(-685, -1705, 96, 3.4, 5.4, 'redwhite');
  // 屋外球形ガスタンク(2基)と配管ラック
  for (const gz of [-1665, -1690]) {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(8.5, 14, 12), indLightMat);
    sphere.position.set(-702, 13.5, gz); fukuura.add(sphere);
    const sRing = new THREE.Mesh(new THREE.CylinderGeometry(8.8, 8.8, 1.0, 14), indAccentBlueMat);
    sRing.position.set(-702, 13.5, gz); fukuura.add(sRing);
    for (let l = 0; l < 4; l++) {
      const a = (l / 4) * Math.PI * 2 + 0.4;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 11, 6), indSteelMat);
      leg.position.set(-702 + Math.cos(a) * 6.2, 6.5, gz + Math.sin(a) * 6.2); fukuura.add(leg);
    }
  }
  // 2) 幸浦2丁目 大型多層物流・製造センター棟 (らせんランプウェイ塔＋青帯ファサード) + シルバー青帯煙突(高さ64m)
  addDetailedFacility(-735, -1910, 84, 30, 145, indWhiteMat, indDarkWinMat, indAccentBlueMat, { monitors: 5 });
  const rampTower = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 31, 18), indSilverMat);
  rampTower.position.set(-686, 18.5, -1850); fukuura.add(rampTower);
  for (let ry = 8; ry <= 28; ry += 6.5) {
    const rBand = new THREE.Mesh(new THREE.CylinderGeometry(16.5, 16.5, 2.2, 18), indDarkWinMat);
    rBand.position.set(-686, ry, -1850); fukuura.add(rBand);
  }
  addDetailedChimney(-698, -2035, 64, 2.6, 4.0, 'blueband');
  // 3) ヤグラ型煙突の南隣プラント棟
  addDetailedFacility(-750, -2090, 74, 28, 102, indLightMat, indDarkWinMat, null, { coreSide: 1, monitors: 3 });

  // (7-e) ヤグラ型エントツ (海岸線の北寄り角にある鉄骨トラスの櫓煙突と付属プラント建屋: 斜めブレース・点検デッキ・煙道ダクト付き)
  const yagX = -680, yagZ = -2220;
  const yagCore = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 7.2, 108, 16), indLightMat);
  yagCore.position.set(yagX, 56, yagZ); fukuura.add(yagCore);
  const yagRed = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.9, 15, 16), indRedMat);
  yagRed.position.set(yagX, 99, yagZ); fukuura.add(yagRed);
  const yagRed2 = new THREE.Mesh(new THREE.CylinderGeometry(5.9, 6.3, 12, 16), indRedMat);
  yagRed2.position.set(yagX, 74, yagZ); fukuura.add(yagRed2);
  const yagNozzle = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 5.2, 5, 16), indDarkWinMat);
  yagNozzle.position.set(yagX, 111.5, yagZ); fukuura.add(yagNozzle);
  const trussCol = new THREE.MeshLambertMaterial({ color: 0x475569 });
  for (const sx of [-12, 12]) for (const sz of [-12, 12]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(2.4, 104, 2.4), trussCol);
    post.position.set(yagX + sx, 54, yagZ + sz); fukuura.add(post);
  }
  for (let h = 16; h <= 100; h += 14) {
    const ring = new THREE.Mesh(new THREE.BoxGeometry(27.5, 1.8, 27.5), trussCol);
    ring.position.set(yagX, h, yagZ); fukuura.add(ring);
    if (h < 100) {
      // トラスの斜材(Xブレース)を四面に配置してリアルな鉄骨ヤグラ構造を表現
      for (const s of [-1, 1]) {
        const diagZ = new THREE.Mesh(new THREE.BoxGeometry(28, 1.2, 1.2), trussCol);
        diagZ.position.set(yagX, h + 7, yagZ + s * 12); diagZ.rotation.z = s * 0.48; fukuura.add(diagZ);
        const diagX = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 28), trussCol);
        diagX.position.set(yagX + s * 12, h + 7, yagZ); diagX.rotation.x = -s * 0.48; fukuura.add(diagX);
      }
    }
  }
  addDetailedFacility(yagX - 62, yagZ + 18, 86, 30, 82, indWarmMat, indDarkWinMat, null, { coreSide: 1, phH: 6.5 });
  const yagFlue = new THREE.Mesh(new THREE.BoxGeometry(36, 5.5, 6.5), trussCol);
  yagFlue.position.set(yagX - 22, 16, yagZ + 4); yagFlue.rotation.z = 0.14; fukuura.add(yagFlue);

  // (7-f) 焼却炉 (横浜市資源循環局金沢工場: 白地に水色トップの130m高層煙突と段差工場棟・煙道・サイロ) & 三菱重工 (4棟並んだ白い三角屋根の大工場群)
  // 北端の幸浦埋立地張り出し
  const northPier = new THREE.Mesh(new THREE.BoxGeometry(750, 4.5, 750), new THREE.MeshLambertMaterial({ color: 0xd6d3c9 }));
  northPier.position.set(-720, 1.2, -2850); fukuura.add(northPier);
  const incX = -1020, incZ = -2820;
  addDetailedFacility(incX, incZ, 152, 46, 142, indLightMat, indBlueGlassMat, indAccentBlueMat, { coreSide: 1, phH: 10 });
  // 金沢工場(資源循環局)の煙突: 実際の高さ130m + 点検デッキ + 傾斜煙道ダクト
  const incStack = new THREE.Mesh(new THREE.CylinderGeometry(8.2, 12.2, 124, 20), indWhiteMat);
  incStack.position.set(incX - 95, 64, incZ); fukuura.add(incStack);
  const incCap = new THREE.Mesh(new THREE.CylinderGeometry(8.6, 9.2, 15, 20), indAccentBlueMat);
  incCap.position.set(incX - 95, 127, incZ); fukuura.add(incCap);
  const incSubBand = new THREE.Mesh(new THREE.CylinderGeometry(9.4, 9.7, 5, 20), indAccentBlueMat);
  incSubBand.position.set(incX - 95, 108, incZ); fukuura.add(incSubBand);
  const incFlue = new THREE.Mesh(new THREE.BoxGeometry(46, 7.5, 9.5), indSilverMat);
  incFlue.position.set(incX - 68, 22, incZ); incFlue.rotation.z = -0.15; fukuura.add(incFlue);

  // 三菱重工の4連白い蒲鉾/三角屋根工場棟 (イラスト右上・焼却炉の右隣に4棟並ぶ)
  for (let i = 0; i < 4; i++) {
    const hx = -820 + i * 82, hz = -2820;
    const hall = new THREE.Mesh(new THREE.BoxGeometry(74, 34, 210), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
    hall.position.set(hx, 19, hz); fukuura.add(hall);
    const hallWin = new THREE.Mesh(new THREE.BoxGeometry(75.2, 5.5, 204), indDarkWinMat);
    hallWin.position.set(hx, 26, hz); fukuura.add(hallWin);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(38, 38, 210, 3), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
    roof.rotation.x = Math.PI / 2; roof.rotation.y = Math.PI;
    roof.position.set(hx, 38, hz); roof.scale.set(1, 1, 0.45); fukuura.add(roof);
  }

  // シーサイドライン高架(x=-825)の西側に並ぶ第2列の大型研究・工場棟群 (すべて窓帯・屋上ペントハウス付き)
  const fukuColors = [0xf8fafc, 0xe2e8f0, 0xf1f5f9, 0xdbeafe, 0xe5e7eb, 0xd6d3d1];
  const fukuStripeBlue = new THREE.MeshLambertMaterial({ color: 0x0284c7 });
  for (const [bx, bz, bw, bh, bd, ci] of [
    [-935, -1120, 86, 28, 88, 1],
    [-940, -1340, 84, 32, 92, 0],
    [-945, -1580, 90, 34, 96, 2],
    [-935, -1820, 86, 28, 90, 4],
    [-940, -2060, 88, 30, 92, 1],
    [-1110, -1240, 92, 26, 84, 1],
    [-1110, -1520, 96, 30, 88, 0],
    [-1110, -1800, 92, 28, 86, 2],
  ]) {
    const wMat = new THREE.MeshLambertMaterial({ color: fukuColors[ci] });
    addDetailedFacility(bx, bz, bw, bh, bd, wMat, indDarkWinMat, ci % 2 === 0 ? indAccentBlueMat : null, { phH: 5.5 });
  }

  // 2) 金沢シーサイドラインの高架軌道と駅舎 (市大医学部駅〜福浦駅〜産業振興センター駅〜幸浦駅: x=-825付近を南北に貫く)
  const viaductMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const pierMat = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
  const viaBeam = new THREE.Mesh(new THREE.BoxGeometry(9.5, 3.2, 1680), viaductMat);
  viaBeam.position.set(-825, 12.5, -1540); fukuura.add(viaBeam);
  for (let pz = -740; pz >= -2340; pz -= 60) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(3.6, 11, 4.2), pierMat);
    pier.position.set(-825, 6.5, pz); fukuura.add(pier);
  }
  for (const stZ of [-820, -1180, -1480, -1920]) {
    const stBox = new THREE.Mesh(new THREE.BoxGeometry(18, 7.5, 58), new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
    stBox.position.set(-825, 16.2, stZ); fukuura.add(stBox);
    const stRoof = new THREE.Mesh(new THREE.BoxGeometry(20, 1.5, 60), fukuStripeBlue);
    stRoof.position.set(-825, 20.4, stZ); fukuura.add(stRoof);
  }

  // 3) 八景大橋(x≈-1670)と横浜市大医学部病院の間の内陸側建物群
  const midBldColors = [0xf8fafc, 0xe2e8f0, 0xf1f5f9, 0xdbeafe, 0xe7e5e4];
  for (const [bx, bz, bw, bh, bd, ci] of [
    [-925, -790, 74, 30, 58, 1],
    [-1040, -740, 62, 22, 48, 2],
    [-1150, -780, 58, 20, 52, 0],
    [-1260, -730, 64, 24, 46, 3],
    [-1370, -760, 56, 18, 48, 1],
    [-1480, -710, 60, 22, 50, 4],
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), new THREE.MeshLambertMaterial({ color: midBldColors[ci] }));
    m.position.set(bx, bh / 2 + 3, bz); fukuura.add(m);
    const rf = new THREE.Mesh(new THREE.BoxGeometry(bw + 2, 1.8, bd + 2), new THREE.MeshLambertMaterial({ color: 0x64748b }));
    rf.position.set(bx, bh + 3.8, bz); fukuura.add(rf);
  }
  root.add(fukuura);

  // 8) 西岸の陸地 (海の公園の砂浜〜野島公園〜南側の横須賀・追浜・夏島エリアの緑の丘陵)
  const westX = [], westZ = [];
  for (let i = 0; i <= 90; i++) westX.push(-9500 + (8200 * i) / 90);
  for (let j = 0; j <= 120; j++) westZ.push(-4500 + (11000 * j) / 120);
  const wCoastX = (z) => -1750 + 220 * Math.sin(z / 950) + (z > 900 ? Math.min(750, (z - 900) * 0.42) : 0);
  const wLandH = (x, z) => {
    const d = wCoastX(z) - x;
    if (d < 0) return -6;
    const ramp = smooth(0, 120, d);
    const isYokosuka = smooth(600, 1400, z);
    const hillBase = isYokosuka ? smooth(80, 900, d) * 145 : Math.pow(smooth(450, 4000, d), 1.3) * 130;
    return -1.0 + 3.2 * ramp + hillBase * (0.45 + 0.55 * noise2(x / 900, z / 900));
  };
  const wColorLand = (x, z, h, out) => {
    const d = wCoastX(z) - x;
    if (h < 0.2) out.setRGB(0.42, 0.40, 0.35);
    else if (z > -600 && z < 750 && d < 130) out.setRGB(0.78, 0.73, 0.60); // 海の公園の白砂ビーチ
    else if (z >= 900 && z <= 2500 && d < 320) out.setRGB(0.54, 0.56, 0.58); // 夏島・住友重機械の工場敷地岸壁
    else {
      const g = noise2(x / 120, z / 120);
      out.setRGB(0.11 + 0.05 * g, 0.24 + 0.08 * g, 0.09 + 0.03 * g);
    }
  };
  const wGeo = buildGrid(westX, westZ, wLandH, wColorLand);
  root.add(new THREE.Mesh(wGeo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  // 海の公園の波打ち際白波
  const wcpts = [];
  for (let z = -550; z <= 750; z += 35) wcpts.push({ x: wCoastX(z), z, ux: 1, uz: 0 });
  surfStrip(root, wcpts, 12);

  // 9) 横須賀側 (南〜南西 z = +1150 〜 +2350): 住友重機械工業 横須賀製造所のオレンジ色ゴライアスクレーンと白い大工場棟 (画像準拠)
  const shi = new THREE.Group();
  const shiX = -1050, shiZ = 1650;
  const shiYard = new THREE.Mesh(new THREE.BoxGeometry(660, 4.5, 1180), new THREE.MeshLambertMaterial({ color: 0x64748b }));
  shiYard.position.set(shiX, 1.2, shiZ); shi.add(shiYard);
  // クレーンの右手(西側)に並ぶ白い大型工場建屋 (暗い横連窓ストライプ入り)
  for (const [dx, dz, w, h, d, cBody, cRoof] of [
    [-90, 90, 290, 54, 340, 0xf8fafc, 0x475569],   // 写真右側の白い巨大工場棟
    [-110, -250, 250, 42, 210, 0xf1f5f9, 0x334155],
    [-95, 380, 230, 38, 180, 0xe2e8f0, 0x334155],
    [110, 140, 140, 30, 190, 0xf8fafc, 0x475569],
  ]) {
    const bld = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: cBody }));
    bld.position.set(shiX + dx, h / 2 + 3, shiZ + dz); shi.add(bld);
    const rf = new THREE.Mesh(new THREE.BoxGeometry(w + 4, 2.5, d + 4), new THREE.MeshLambertMaterial({ color: cRoof }));
    rf.position.set(shiX + dx, h + 4.2, shiZ + dz); shi.add(rf);
    // 工場壁面の横連窓バンド
    for (const wy of [h * 0.45, h * 0.75]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(w + 1.5, 3.5, d * 0.92), new THREE.MeshLambertMaterial({ color: 0x334155 }));
      win.position.set(shiX + dx, wy + 3, shiZ + dz); shi.add(win);
    }
  }
  // 住友重工の象徴: 鮮やかなオレンジ色(赤橙)の巨大ゴライアスクレーン (脚に白帯・上部にSUMITOMO白文字プレート)
  const craneOrange = new THREE.MeshLambertMaterial({ color: 0xea580c });
  const craneOrangeSub = new THREE.MeshLambertMaterial({ color: 0xf97316 });
  const craneWhite = new THREE.MeshLambertMaterial({ color: 0xffffff });
  for (const [cz, ch, span] of [[shiZ - 140, 112, 185], [shiZ + 220, 98, 160]]) {
    const cx = shiX + 135;
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(6.5, ch, 8.5), craneOrange);
      leg.position.set(cx, ch / 2 + 3, cz + s * (span / 2)); shi.add(leg);
      // 脚の紅白(オレンジ×白)ストライプ帯
      for (const bh of [ch * 0.35, ch * 0.68]) {
        const wBand = new THREE.Mesh(new THREE.BoxGeometry(7.0, 10, 9.0), craneWhite);
        wBand.position.set(cx, bh + 3, cz + s * (span / 2)); shi.add(wBand);
      }
      const brace = new THREE.Mesh(new THREE.BoxGeometry(5.2, ch * 0.92, 5.2), craneOrange);
      brace.position.set(cx - 14, ch * 0.46 + 3, cz + s * (span / 2)); brace.rotation.z = -0.22; shi.add(brace);
    }
    // 上部オレンジガーダー(横桁) + SUMITOMO白ロゴ帯
    const girder = new THREE.Mesh(new THREE.BoxGeometry(13, 9.5, span + 34), craneOrange);
    girder.position.set(cx - 4, ch + 5, cz); shi.add(girder);
    const logo = new THREE.Mesh(new THREE.BoxGeometry(13.6, 5.2, span * 0.58), craneWhite);
    logo.position.set(cx - 4, ch + 5, cz); shi.add(logo);
  }
  // 周囲のオレンジ色ジブクレーン群
  for (const [jx, jz] of [[shiX + 215, shiZ - 310], [shiX + 225, shiZ + 20], [shiX + 205, shiZ + 360]]) {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 5, 28, 8), craneOrange);
    base.position.set(jx, 16, jz); shi.add(base);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 2.2, 85, 6), craneOrangeSub);
    boom.position.set(jx + 18, 52, jz); boom.rotation.z = -0.46; shi.add(boom);
  }
  root.add(shi);

  // 10) 東京湾の大型商船・コンテナ船・自動車運搬船と海上標識 (フラットな不自然船やコース近くの小型船・シーバースは除外)
  const bayShips = new THREE.Group();
  const pBlack = new THREE.MeshLambertMaterial({ color: 0x1e293b });
  const pRed = new THREE.MeshLambertMaterial({ color: 0xdc2626 });
  const pWhite = new THREE.MeshLambertMaterial({ color: 0xf8fafc });

  // (10-b) 東京湾の大型コンテナ船・自動車運搬船 (東風時の上マークからも十分な距離を保つ沖合航路を移動)
  const cargoConfigs = [
    { x: 2180, z: -850, ry: -0.18, len: 210, w: 32, col: 0x991b1b, type: 'container' },
    { x: 2620, z: 420, ry: 0.12, len: 195, w: 30, col: 0x1e3a8a, type: 'container' },
    { x: 2380, z: -2200, ry: 0.05, len: 190, w: 30, col: 0x1d4ed8, type: 'car' },
    { x: 3120, z: -1450, ry: -0.1, len: 230, w: 35, col: 0x047857, type: 'container' },
  ];
  const contColors = [0xdc2626, 0x2563eb, 0xd97706, 0x059669, 0x9333ea, 0xe11d48];
  for (let si = 0; si < cargoConfigs.length; si++) {
    const cfg = cargoConfigs[si];
    const sg = new THREE.Group();
    sg.userData.noBake = true;
    const hull = new THREE.Mesh(new THREE.BoxGeometry(cfg.w, 13, cfg.len), new THREE.MeshLambertMaterial({ color: cfg.col }));
    hull.position.y = 5.5; sg.add(hull);
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(cfg.w * 0.82, 24, 22), pWhite);
    bridge.position.set(0, 22, -cfg.len * 0.34); sg.add(bridge);
    const funnel = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.0, 14, 10), new THREE.MeshLambertMaterial({ color: 0xea580c }));
    funnel.position.set(0, 36, -cfg.len * 0.38); sg.add(funnel);
    if (cfg.type === 'container') {
      for (let cz = -cfg.len * 0.18; cz <= cfg.len * 0.34; cz += 26) {
        const cMat = new THREE.MeshLambertMaterial({ color: contColors[Math.abs(Math.round(cz)) % contColors.length] });
        const stack = new THREE.Mesh(new THREE.BoxGeometry(cfg.w * 0.86, 11, 22), cMat);
        stack.position.set(0, 17, cz); sg.add(stack);
      }
    } else if (cfg.type === 'car') {
      const boxHull = new THREE.Mesh(new THREE.BoxGeometry(cfg.w * 0.96, 16, cfg.len * 0.88), new THREE.MeshLambertMaterial({ color: 0x3b82f6 }));
      boxHull.position.set(0, 18, 0); sg.add(boxHull);
    }
    sg.position.set(cfg.x, 0, cfg.z); sg.rotation.y = cfg.ry;
    bayShips.add(sg);
    movingShips.push({ obj: sg, x0: cfg.x, z0: cfg.z, ry: cfg.ry, speed: 1.85 + si * 0.35, range: 360 + si * 70, ph: si * 1.65 });
  }

  // (10-d) 海上標識: 小柴2/3/4号灯浮標・沖ノ根ビーコン
  const oki = new THREE.Group();
  const okiPole = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, 11, 10), pBlack);
  okiPole.position.y = 5.5; oki.add(okiPole);
  const okiBand = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.45, 3.5, 10), pRed);
  okiBand.position.y = 6.0; oki.add(okiBand);
  oki.position.set(-450, 0, 520); bayShips.add(oki);

  const gMat = new THREE.MeshLambertMaterial({ color: 0x16a34a });
  for (const [bx, bz, mat] of [[1220, -420, pRed], [1420, -820, gMat], [1660, -1420, pRed]]) {
    const bg = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 2.0, 10), mat);
    base.position.y = 1.0; bg.add(base);
    const tw = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.4, 5.5, 8), mat);
    tw.position.y = 4.5; bg.add(tw);
    bg.position.set(bx, 0, bz); bayShips.add(bg);
  }
  root.add(bayShips);

  // 11) 幸浦・並木〜南本牧・本牧ふ頭に見える赤と白(紅白塗り分け)のガントリークレーン群 (参考写真準拠) + 遠方の横浜ランドマークタワー
  const metro = new THREE.Group();
  const cRed = new THREE.MeshLambertMaterial({ color: 0xe0351f });
  const cWhite = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
  const cCream = new THREE.MeshLambertMaterial({ color: 0xf1f5f9 });
  const cDark = new THREE.MeshLambertMaterial({ color: 0x334155 });

  // 紅白塗り分けのリアルなガントリークレーン生成(Aフレーム脚・白い機械室ハウス・赤白ブーム・一部はブーム跳ね上げ姿勢)
  const addRedWhiteGantry = (gx, gz, scale = 1.0, boomRaised = false) => {
    const cg = new THREE.Group();
    // 1) 海側・陸側の4本ポータル脚 (赤と白の交互塗り分けバンド)
    const legH = 44;
    for (const lx of [-13, 13]) {
      for (const lz of [-8, 8]) {
        for (let b = 0; b < 5; b++) {
          const segH = legH / 5;
          const legSeg = new THREE.Mesh(new THREE.BoxGeometry(2.8, segH, 2.8), b % 2 === 0 ? cRed : cWhite);
          legSeg.position.set(lx * (1 - b * 0.03), b * segH + segH / 2, lz);
          cg.add(legSeg);
        }
      }
      // 脚間の水平タイビーム(白/赤)
      const tie = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.4, 18), lx > 0 ? cWhite : cRed);
      tie.position.set(lx * 0.92, 22, 0);
      cg.add(tie);
    }
    // 2) 中央ガーダー上の白い大型機械室ハウス (写真の「YOK」「HAC」と書かれた白い箱型機械室)
    const machHouse = new THREE.Mesh(new THREE.BoxGeometry(26, 9.5, 14), cCream);
    machHouse.position.set(-2, legH + 5.5, 0);
    cg.add(machHouse);
    const machStripe = new THREE.Mesh(new THREE.BoxGeometry(26.4, 1.8, 14.4), cDark);
    machStripe.position.set(-2, legH + 3.2, 0);
    cg.add(machStripe);
    // 3) ガーダー上部のAフレームタワー (赤・白・赤の紅白塗り分け)
    const topH = 34;
    for (let b = 0; b < 4; b++) {
      const sh = topH / 4;
      const twSeg = new THREE.Mesh(new THREE.BoxGeometry(5.5 - b * 0.5, sh, 8.5 - b * 0.6), b % 2 === 0 ? cWhite : cRed);
      twSeg.position.set(4, legH + 9 + b * sh + sh / 2, 0);
      cg.add(twSeg);
    }
    // 4) ガージョー・ブーム (海側+xへ長く突き出す赤白ブーム、または跳ね上げ姿勢)
    const RearBoom = new THREE.Mesh(new THREE.BoxGeometry(36, 3.6, 5.5), cRed);
    RearBoom.position.set(-20, legH + 2.0, 0);
    cg.add(RearBoom);
    const boomGroup = new THREE.Group();
    boomGroup.position.set(11, legH + 2.0, 0);
    for (let s = 0; s < 4; s++) {
      const bSeg = new THREE.Mesh(new THREE.BoxGeometry(16.5, 3.4, 5.0), s % 2 === 0 ? cRed : cWhite);
      bSeg.position.set(8.25 + s * 16.5, 0, 0);
      boomGroup.add(bSeg);
    }
    if (boomRaised) boomGroup.rotation.z = 1.12; // 写真左側のブームを跳ね上げた駐機姿勢
    cg.add(boomGroup);
    // 5) タワー頂部からブーム先端へ張られたフォアステイ・バックステイテンションロッド
    const stay = new THREE.Mesh(new THREE.BoxGeometry(boomRaised ? 36 : 58, 1.1, 1.1), cWhite);
    stay.position.set(boomRaised ? 16 : 34, legH + (boomRaised ? 34 : 20), 0);
    stay.rotation.z = boomRaised ? 0.45 : -0.46;
    cg.add(stay);

    cg.scale.setScalar(scale);
    cg.position.set(gx, 2, gz);
    metro.add(cg);
  };

  // (a) 幸浦・並木北東岸〜南本牧ふ頭手前に並んでいた紅白ガントリークレーン群 (海上から赤と白のコントラストが鮮やかに見える位置)
  const sachiuraCranes = [
    [-510, -3080, 1.05, true],
    [-420, -3130, 1.08, true],
    [-325, -3180, 1.08, false],
    [-230, -3230, 1.06, false],
    [-135, -3280, 1.05, false],
  ];
  for (const [gx, gz, sc, up] of sachiuraCranes) addRedWhiteGantry(gx, gz, sc, up);

  // (b) 本牧ふ頭・南本牧ふ頭の紅白ガントリークレーン列
  for (let i = 0; i < 7; i++) {
    const gx = -380 + i * 105, gz = -3760 - (i % 3) * 120;
    addRedWhiteGantry(gx, gz, 1.12, i < 2);
  }

  // クレーンの奥側〜横浜・東京方面の低い遠方陸地プレート
  const metroLand = new THREE.Mesh(new THREE.BoxGeometry(12000, 4, 18000), new THREE.MeshLambertMaterial({ color: 0x6b7c90 }));
  metroLand.position.set(-1400, 0.8, -14500); metro.add(metroLand);

  // 横浜みなとみらい21・横浜ランドマークタワーと周辺建物:
  // クレーンと重なる奥の過密な都会ビル群は削除し、クレーン右側の控えめな規模感の港湾建物のみ残しつつ、
  // ランドマークタワーとその直近のみなとみらい建物(クイーンズスクエアA/B/C・インターコンチネンタル・ランドマークプラザ等)だけを水平線上に「ほんのうっすら」霞んで見えるように配置
  const lmkX = -760, lmkZ = -6850;
  const hazedTowerMat = new THREE.MeshLambertMaterial({ color: 0xc9daec, emissive: 0x384d63, transparent: true, opacity: 0.19, depthWrite: false });
  const hazedSubMat = new THREE.MeshLambertMaterial({ color: 0xc2d5e8, emissive: 0x33475c, transparent: true, opacity: 0.17, depthWrite: false });
  // 1) 横浜ランドマークタワー (296m: 上に向かって段状に細くなる四角柱シルエット)
  const lmkBase = new THREE.Mesh(new THREE.CylinderGeometry(36, 50, 225, 4), hazedTowerMat);
  lmkBase.rotation.y = Math.PI / 4; lmkBase.position.set(lmkX, 112.5, lmkZ); metro.add(lmkBase);
  const lmkTop = new THREE.Mesh(new THREE.CylinderGeometry(26, 36, 72, 4), hazedTowerMat);
  lmkTop.rotation.y = Math.PI / 4; lmkTop.position.set(lmkX, 261, lmkZ); metro.add(lmkTop);
  // ランドマークプラザ・三菱重工横浜ビル(左隣の中層棟)
  const mhiBldg = new THREE.Mesh(new THREE.BoxGeometry(58, 145, 48), hazedSubMat);
  mhiBldg.position.set(lmkX - 95, 72.5, lmkZ - 20); metro.add(mhiBldg);
  // 2) クイーンズスクエア横浜 3連棟 (A棟172m・B棟138m・C棟109m: ランドマークのすぐ右隣に階段状に並ぶ実在配置)
  const queensHeights = [172, 138, 109];
  for (let i = 0; i < 3; i++) {
    const qh = queensHeights[i];
    const qb = new THREE.Mesh(new THREE.BoxGeometry(46, qh, 46), hazedSubMat);
    qb.position.set(lmkX + 125 + i * 68, qh / 2, lmkZ + 35 + i * 22); metro.add(qb);
  }
  // 3) ヨコハマ グランド インターコンチネンタル ホテル (140m: クイーンズスクエア右海側の半月ヨットセール型シルエット)
  const interCon = new THREE.Mesh(new THREE.CylinderGeometry(68, 68, 20, 20, 1, false, 0, Math.PI), hazedTowerMat);
  interCon.rotation.z = Math.PI / 2; interCon.rotation.y = 0.35; interCon.position.set(lmkX + 355, 52, lmkZ + 95); interCon.scale.set(2.0, 1, 1); metro.add(interCon);

  // 4) 横浜ベイブリッジ (本牧ふ頭右奥にほんのうっすら見える斜張橋)
  const bbX = 480, bbZ = -6350;
  const bbDeck = new THREE.Mesh(new THREE.BoxGeometry(1950, 7, 20), hazedSubMat);
  bbDeck.position.set(bbX, 56, bbZ); bbDeck.rotation.y = -0.22; metro.add(bbDeck);
  for (const s of [-360, 360]) {
    const tw = new THREE.Mesh(new THREE.BoxGeometry(16, 160, 22), hazedTowerMat);
    tw.position.set(bbX + s * Math.cos(0.22), 80, bbZ + s * Math.sin(0.22)); metro.add(tw);
  }

  // 5) クレーン右側にある控えめな規模感の港湾・沿岸建物群のみ残す (クレーン背後と重なる都会ビル群は完全削除)
  const HBOX = 28;
  const hBoxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ emissive: 0x223246, transparent: true, opacity: 0.42 }), HBOX);
  let hbn = 0;
  const cityPal = [0xb4c8de, 0xa5bcd4, 0xc2d5ea, 0x9cb3cb];
  for (let k = 0; k < 24 && hbn < HBOX; k++) {
    // クレーン列の右側(東側: x = +220 .. +1080, z = -3950 .. -5400)の控えめな中低層港湾施設
    const x = 220 + rnd() * 860, z = -3950 - rnd() * 1450;
    const bh = 16 + rnd() * 28, bw = 32 + rnd() * 38, bd = 32 + rnd() * 38;
    m4.compose(new THREE.Vector3(x, bh / 2 + 2, z), q, new THREE.Vector3(bw, bh, bd));
    hBoxes.setMatrixAt(hbn, m4); tc.setHex(cityPal[(rnd() * cityPal.length) | 0]); hBoxes.setColorAt(hbn, tc); hbn++;
  }
  hBoxes.count = hbn; metro.add(hBoxes);
  root.add(metro);

  // 遠景陸地: 磯子・根岸の緑の丘陵(みなとみらいの視線を遮らないよう西側 x = -3350 に配置)、東京側奥の陸地
  distantLand(root, -3350, -5800, 1150, 2200, 68, 0.08);
  distantLand(root, 2200, -21000, 8500, 6500, 65, 0.15);   // 東京側奥の陸地
  // (千葉・房総半島は addHakkeiScenery で実際の海岸線(富津岬・君津・木更津・鋸山)に沿って作成)

  // 八景島からも西〜西南西の丘陵越しにわずかに見える遠方の富士山
  if (fgeo) {
    const fujiHMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      color: 0xd8e6f2,
      emissive: 0x3b4d5e,
      transparent: true,
      opacity: 0.45,
    });
    const fujiH = new THREE.Mesh(fgeo, fujiHMat);
    fujiH.position.set(-41500, -320, -1500); // 八景島から見た富士山はほぼ真西(方位約272°)
    fujiH.scale.set(0.45, 0.54, 0.45);
    root.add(fujiH);
  }
}




// =====================================================================
// 静的メッシュの一括結合 (ドローコール削減)
// group 配下の静的な Lambert / Basic メッシュを「マテリアル特性(種類・発光色・面・透明度)」ごとに 1 メッシュへ結合する。
// マテリアル色(×既存の頂点色)は頂点色へ焼き込むので、色違いの建物・船・標識もまとめて 1 ドローコールになる。
// テクスチャ付き(白波など)は同一マテリアル同士だけを結合し、元のマテリアル(アニメーション付き)をそのまま使う。
// =====================================================================
function bakeStatic(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.geometry || !o.geometry.attributes.position) return;
    const m = o.material;
    if (Array.isArray(m) || !(m.isMeshLambertMaterial || m.isMeshBasicMaterial)) return;
    for (let p = o; p && p !== root; p = p.parent) if (!p.visible || (p.userData && p.userData.noBake)) return;
    const key = m.map ? `map|${m.uuid}|${o.renderOrder}`
      : [m.type, m.emissive ? m.emissive.getHex() : 0, m.side, m.transparent ? m.opacity : 1, m.depthWrite, m.fog, o.renderOrder].join('|');
    let b = buckets.get(key);
    if (!b) { b = { m, items: [], nv: 0, ni: 0, ro: o.renderOrder }; buckets.set(key, b); }
    const g = o.geometry, nv = g.attributes.position.count;
    b.items.push(o); b.nv += nv; b.ni += g.index ? g.index.count : nv;
  });
  const mtx = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3(), c = new THREE.Color(), vc = new THREE.Color();
  for (const b of buckets.values()) {
    if (b.items.length < 2) continue;
    const textured = !!b.m.map;
    const pos = new Float32Array(b.nv * 3), nor = new Float32Array(b.nv * 3);
    const col = textured ? null : new Float32Array(b.nv * 3), uvs = textured ? new Float32Array(b.nv * 2) : null;
    const idx = new Uint32Array(b.ni);
    let vo = 0, io = 0;
    for (const o of b.items) {
      const g = o.geometry, P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color, UV = g.attributes.uv, I = g.index;
      const mm = o.material, useVC = mm.vertexColors && C;
      mtx.multiplyMatrices(inv, o.matrixWorld); nm.getNormalMatrix(mtx);
      const flip = mtx.determinant() < 0;
      for (let i = 0; i < P.count; i++) {
        const k = (vo + i) * 3;
        v.fromBufferAttribute(P, i).applyMatrix4(mtx); pos[k] = v.x; pos[k + 1] = v.y; pos[k + 2] = v.z;
        if (N) v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); else v.set(0, 1, 0);
        nor[k] = v.x; nor[k + 1] = v.y; nor[k + 2] = v.z;
        if (col) {
          c.copy(mm.color); if (useVC) c.multiply(vc.fromBufferAttribute(C, i));
          col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
        }
        if (uvs) { uvs[(vo + i) * 2] = UV ? UV.getX(i) : 0; uvs[(vo + i) * 2 + 1] = UV ? UV.getY(i) : 0; }
      }
      const n = I ? I.count : P.count;
      for (let i = 0; i < n; i += 3) {
        const a = I ? I.getX(i) : i, bb = I ? I.getX(i + 1) : i + 1, cc = I ? I.getX(i + 2) : i + 2;
        idx[io++] = vo + a; idx[io++] = vo + (flip ? cc : bb); idx[io++] = vo + (flip ? bb : cc);
      }
      vo += P.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (uvs) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    let mat = b.m;
    if (!textured) {
      mat = b.m.isMeshBasicMaterial ? new THREE.MeshBasicMaterial({ vertexColors: true }) : new THREE.MeshLambertMaterial({ vertexColors: true });
      if (mat.emissive) mat.emissive.copy(b.m.emissive);
      mat.side = b.m.side; mat.transparent = b.m.transparent; mat.opacity = b.m.opacity; mat.depthWrite = b.m.depthWrite; mat.fog = b.m.fog;
    }
    for (const o of b.items) o.parent.remove(o);
    const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = b.ro; mesh.frustumCulled = false; root.add(mesh);
  }
  // 空になったグループを取り除き、シーングラフの走査コストも減らす
  const prune = (o) => { for (const ch of [...o.children]) { prune(ch); if (!ch.isMesh && !ch.isSprite && !ch.isLight && ch.children.length === 0 && ch.type !== 'Scene') o.remove(ch); } };
  prune(root);
  root.updateMatrixWorld(true);
}

// ---------- 静的オブジェクト用の小道具 (bakeStatic で結合される前提。マテリアル・ジオメトリは使い回す) ----------
const _sgeo = new Map(), _smat = new Map();
const sGeo = (key, make) => { let g = _sgeo.get(key); if (!g) { g = make(); _sgeo.set(key, g); } return g; };
const sMat = (hex, emissive = 0) => { const k = `${hex}|${emissive}`; let m = _smat.get(k); if (!m) { m = new THREE.MeshLambertMaterial({ color: hex, emissive }); _smat.set(k, m); } return m; };
// 底面中心 (x, y, z) に置く直方体
function sBox(parent, x, y, z, w, h, d, hex, ry = 0) {
  const m = new THREE.Mesh(sGeo('box', () => new THREE.BoxGeometry(1, 1, 1)), sMat(hex));
  m.position.set(x, y + h / 2, z); m.scale.set(w, h, d); m.rotation.y = ry; parent.add(m); return m;
}
// 底面中心に置く円柱/円錐台 (seg=4 で角柱)。sx/sz で楕円断面
function sCyl(parent, x, y, z, rTop, rBot, h, hex, seg = 8, sx = 1, sz = 1, ry = 0) {
  const m = new THREE.Mesh(sGeo(`cyl|${(rTop / rBot).toFixed(3)}|${seg}`, () => new THREE.CylinderGeometry(rTop / rBot, 1, 1, seg)), sMat(hex));
  m.position.set(x, y + h / 2, z); m.scale.set(rBot * sx, h, rBot * sz); m.rotation.y = ry; parent.add(m); return m;
}
// 紅白(または任意2色)の帯を巻いた煙突・鉄塔
function sBanded(parent, x, y, z, rTop, rBot, h, bands, c1, c2, seg = 8) {
  for (let i = 0; i < bands; i++) {
    const t0 = i / bands, t1 = (i + 1) / bands;
    const r0 = rBot + (rTop - rBot) * t0, r1 = rBot + (rTop - rBot) * t1;
    sCyl(parent, x, y + h * t0, z, r1, r0, h / bands, i % 2 ? c2 : c1, seg);
  }
}
// 遠景の簡易船舶 (船体 + 船橋 + 積荷)。全部で 3〜4 個の箱
function sShip(parent, x, z, ry, len, type, hullHex) {
  const g = new THREE.Group();
  const w = len * 0.15;
  sBox(g, 0, -1, 0, w, 9 + len * 0.02, len, hullHex);
  sBox(g, 0, 7.5 + len * 0.02, -len * 0.36, w * 0.9, 14 + len * 0.03, len * 0.1, 0xf1f5f9);
  if (type === 'container') sBox(g, 0, 7.5 + len * 0.02, len * 0.07, w * 0.92, 9, len * 0.6, [0xb45309, 0x1d4ed8, 0x991b1b, 0x0f766e][Math.abs(Math.round(x)) % 4]);
  else if (type === 'car') sBox(g, 0, 7.5 + len * 0.02, len * 0.04, w * 0.97, 15, len * 0.74, 0xe2e8f0);
  else if (type === 'tanker') sBox(g, 0, 7.5 + len * 0.02, len * 0.08, w * 0.3, 1.6, len * 0.62, 0x9ca3af);
  else sBox(g, 0, 7.5 + len * 0.02, len * 0.1, w * 0.85, 3, len * 0.5, 0x6b7280); // バルカー(ハッチ)
  g.position.set(x, 0, z); g.rotation.y = ry; parent.add(g); return g;
}

// 海岸線ポリラインからの符号付き距離 (陸側が正)。coast は海岸線(開いた折れ線)、closing は内陸側を閉じる頂点列
function makeCoastField(coast, closing) {
  const poly = coast.concat(closing);
  const inside = (x, z) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  return (x, z) => {
    let best = 1e18;
    for (let i = 0; i < coast.length - 1; i++) {
      const ax = coast[i][0], az = coast[i][1], dx = coast[i + 1][0] - ax, dz = coast[i + 1][1] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      const ex = ax + dx * t - x, ez = az + dz * t - z;
      best = Math.min(best, ex * ex + ez * ez);
    }
    const d = Math.sqrt(best);
    return inside(x, z) ? d : -d;
  };
}
// 不等間隔グリッド座標列 [[start, end, step], ...]
const gridAxis = (segs) => { const a = []; for (const [s, e, st] of segs) for (let v = s; v < e - 1e-6; v += st) a.push(v); a.push(segs[segs.length - 1][1]); return a; };

// =====================================================================
// 江の島ステージ: 実際の地理(相模湾の海岸線・山並み)に合わせた周辺景観の追加
// ワールド座標 ≒ 江の島中心からの実距離 × 0.62 (遠景を圧縮して霧の内側に収めている既存スケールに合わせる)
// =====================================================================
function addEnoshimaScenery(grp, surfStrip) {
  const sc = new THREE.Group();

  // ---- 1) 鎌倉〜逗子〜葉山〜三浦半島: 稲村ヶ崎で海へ突き出し、由比ヶ浜・逗子湾を経て南へ折れる実際の海岸線 ----
  const MIURA = [
    [2900, -1960], [3150, -1700], [3330, -1350], [3470, -1150], [3640, -1330], [3900, -1680], [4300, -1770], [4700, -1640],
    [4950, -1450], [5200, -1230], [5520, -1000], [5850, -860], [6100, -420], [6330, 350], [6650, 1200], [7050, 2250],
    [7450, 3250], [7700, 4500], [8000, 5800], [8200, 7400], [8300, 9000], [8100, 10500], [9100, 11250], [10500, 10700],
    [11800, 9000], [12500, 6000], [12900, 2500], [13300, -1000], [13600, -2600],
  ];
  const sdM = makeCoastField(MIURA, [[13600, -3600], [2900, -3600]]);
  const isBeach = (x, z) => (x > 3650 && x < 4900 && z < -1450) || (x > 5300 && x < 6050 && z > -1150 && z < -650) || (x > 6150 && x < 6700 && z > -100 && z < 1300) || (x > 7200 && x < 7600 && z > 2600 && z < 3500);
  const miuraH = (x, z) => {
    const d = sdM(x, z);
    if (d <= 0) return Math.max(-30, -3 + d * 0.08);
    const fade = smooth(0, 1100, x - 2900) * (1 - smooth(-1900, -1300, z)) + smooth(-1900, -1300, z);
    const top = 150 + 85 * smooth(-1200, 0, z) - 175 * smooth(5500, 10500, z);
    const n = 0.45 + 0.55 * noise2(x / 1100 + 3, z / 1100 - 7);
    let h = 2.2 * smooth(0, 35, d) + top * Math.pow(smooth(20, 1500, d), 0.9) * n * fade;
    h += 36 * Math.exp(-((x - 3440) ** 2 + (z + 1250) ** 2) / 60000) * smooth(0, 30, d); // 稲村ヶ崎の断崖
    h += 95 * Math.exp(-((x - 8350) ** 2 + (z - 1950) ** 2) / 1.6e6); // 大楠山 (241m)
    return h - 1.0;
  };
  const miuraC = (x, z, h, out) => {
    const d = sdM(x, z), g = noise2(x / 150, z / 150);
    if (h < 0.3) out.setRGB(0.36, 0.35, 0.32);
    else if (d < 50 && isBeach(x, z)) out.setRGB(0.54 + g * 0.04, 0.49 + g * 0.04, 0.41); // 由比ヶ浜・材木座・逗子海岸・森戸・秋谷の砂浜
    else if (d < 55) out.setRGB(0.46 + g * 0.05, 0.44 + g * 0.05, 0.39); // 岩礁・崖
    else if (h < 75 && d < 1500 && noise2(x / 90, z / 90) > 0.47) out.setRGB(0.53 + g * 0.04, 0.54 + g * 0.04, 0.55); // 市街地
    else {
      const distK = smooth(250, 2600, d);
      out.setRGB(0.34 + 0.18 * distK + 0.04 * g, 0.45 + 0.18 * distK + 0.05 * g, 0.46 + 0.24 * distK + 0.04 * g);
    }
  };
  const mxs = gridAxis([[2800, 7200, 85], [7200, 13700, 270]]);
  const mzs = gridAxis([[-3600, -2200, 280], [-2200, 1400, 90], [1400, 11700, 280]]);
  sc.add(new THREE.Mesh(buildGrid(mxs, mzs, miuraH, miuraC), new THREE.MeshLambertMaterial({ vertexColors: true })));
  // 鎌倉〜葉山の砂浜の白波
  {
    const pts = [];
    for (let i = 3; i < 13; i++) {
      const [ax, az] = MIURA[i], [bx, bz] = MIURA[i + 1];
      const L = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / L, nz = (bx - ax) / L; // 進行方向の右手(海側)
      for (let s = 0; s < L; s += 40) pts.push({ x: ax + (bx - ax) * s / L, z: az + (bz - az) * s / L, ux: nx, uz: nz });
    }
    surfStrip(sc, pts, 10);
  }
  // 鎌倉・逗子・葉山・秋谷の低層住宅地(海岸段丘〜谷戸に沿って)
  const pal = [0xf3efe6, 0xe9e2d3, 0xd9d4c8, 0xf6f0e0, 0xc9b8a0, 0xe8ddd0, 0xb9c4cc];
  const roofs = [0x4a4f55, 0x6b5a4a, 0x3d4a5a, 0x7a3b2e, 0x5c6065];
  for (let k = 0, tries = 0; k < 420 && tries < 6000; tries++) {
    const x = 3000 + rnd() * 5200, z = -2500 + rnd() * 6200;
    const d = sdM(x, z); if (d < 45 || d > 1500) continue;
    const h = miuraH(x, z); if (h < 2 || h > 85) continue;
    if (noise2(x / 90, z / 90) < 0.42) continue;
    const w = 9 + rnd() * 9, dd = 9 + rnd() * 9, bh = 6 + rnd() * 7;
    sBox(sc, x, h - 1.5, z, w, bh + 1.5, dd, pal[(rnd() * pal.length) | 0]);
    sBox(sc, x, h + bh, z, w + 0.8, 0.9, dd + 0.8, roofs[(rnd() * roofs.length) | 0]);
    k++;
  }
  // 逗子マリーナ(小坪): 海に張り出した白いリゾートマンション群とマリーナ防波堤
  for (let i = 0; i < 4; i++) sBox(sc, 4930 + i * 70, 1, -1420 + i * 40, 26, 30 + (i % 2) * 6, 58, 0xf4f1ea, -0.7);
  sBox(sc, 5230, -2, -1150, 260, 5, 12, 0x9ca3af, -0.75);
  sBox(sc, 5120, 0, -1300, 160, 3, 90, 0xcfcac0, -0.75);
  // 葉山・森戸沖の名島(菜島): 白い鳥居と紅白の小灯台(葉山灯台)
  sCyl(sc, 6060, -2, 520, 14, 30, 9, 0x4a4540, 7);
  sBanded(sc, 6070, 6, 520, 1.1, 1.4, 9, 4, 0xf8fafc, 0xdc2626, 8);
  sBox(sc, 6045, 6, 505, 0.7, 6, 0.7, 0xf8fafc); sBox(sc, 6045, 6, 513, 0.7, 6, 0.7, 0xf8fafc); sBox(sc, 6045, 11.6, 509, 1, 0.7, 11, 0xf8fafc);

  // ---- 2) 江の島周辺: 片瀬洲鼻の砂州(トンボロ浅瀬)・片瀬漁港の紅白灯台・新江ノ島水族館・腰越漁港 ----
  {
    // 干潮時に洲鼻〜弁天橋東側に現れる特徴的な砂州(トンボロ)の浅瀬マウンド
    sCyl(sc, ISLAND.x - 430, -1.3, -(COAST + 20), 68, 125, 1.55, 0x8f8570, 12, 1.0, 2.2, -0.28);
  }
  // 片瀬漁港 (境川河口・弁天橋の西隣): 港口の右(東)に赤灯台、左(西)に白灯台
  {
    const zc = -(COAST + 60);
    sBox(sc, 330, -1, zc + 90, 10, 4.2, 230, 0x9ca3af, 0.12);
    sBox(sc, 175, -1, zc + 80, 10, 4.2, 210, 0x9ca3af, -0.1);
    sBanded(sc, 343, 3, zc + 205, 1.4, 1.9, 11, 1, 0xdc2626, 0xdc2626, 10); sCyl(sc, 343, 14, zc + 205, 1.6, 1.6, 1.2, 0x7f1d1d, 10);
    sBanded(sc, 165, 3, zc + 185, 1.4, 1.9, 11, 1, 0xf8fafc, 0xf8fafc, 10); sCyl(sc, 165, 14, zc + 185, 1.6, 1.6, 1.2, 0x475569, 10);
  }
  // 新江ノ島水族館 (片瀬西浜): 空色に見えない落ち着いたベージュ・グレーの低層棟
  {
    const ax = -120, az = -(COAST + 175), ah = landH(ax, az);
    sBox(sc, ax, ah - 1, az, 140, 11, 48, 0xd6d3cb);
    sBox(sc, ax + 35, ah - 1, az + 22, 65, 8, 4, 0x94a3b8);
  }
  // 腰越漁港 (小動岬の脇) の防波堤
  sBox(sc, 1250, -1, -(COAST + 10), 9, 4, 150, 0x9ca3af, 0.2);
  sBox(sc, 1180, -1, -(COAST - 60), 90, 4, 9, 0x9ca3af, 0.2);

  // ---- 3) 湘南西海岸 (片瀬西浜〜鵠沼〜辻堂〜茅ヶ崎〜平塚〜大磯): クロマツ防砂林・烏帽子岩・湘南大橋・大磯港 ----
  {
    // 独立シード乱数(既存の江の島・八景島オブジェクト配置乱数に影響を与えない)
    let wSeed = 77321;
    const wrnd = () => { wSeed = (wSeed * 16807) % 2147483647; return wSeed / 2147483647; };

    // 国道134号沿いに連なる湘南海岸のクロマツ防砂林帯 (片瀬西浜〜鵠沼〜辻堂〜茅ヶ崎〜平塚〜大磯)
    const pineMax = 540;
    const pines = new THREE.InstancedMesh(getPineTreeCrownGeo(), new THREE.MeshLambertMaterial({ vertexColors: true }), pineMax);
    const pineTrunks = new THREE.InstancedMesh(getTreeTrunkGeo(), new THREE.MeshLambertMaterial({ color: 0x4e3829, vertexColors: true }), pineMax);
    const pm4 = new THREE.Matrix4(), pq = new THREE.Quaternion(), peul = new THREE.Euler(), ptc = new THREE.Color();
    let pn = 0;
    for (let tries = 0; tries < 3200 && pn < pineMax; tries++) {
      const px = -9550 + Math.pow(wrnd(), 0.88) * 9300; // 西浜(-250)〜大磯(-9550)
      if (px > -8280 && px < -7920) continue; // 相模川河口は除外
      const shoreZ = shonanShoreZ(px);
      const pz = shoreZ - 155 - wrnd() * 185;
      const ph = landH(px, pz);
      if (ph < 1.8 || ph > 18) continue;
      const ps = 4.6 + wrnd() * 3.8;
      pq.setFromEuler(peul.set(0, wrnd() * 6.28, 0));
      pm4.compose(new THREE.Vector3(px, ph + ps * 0.62, pz), pq, new THREE.Vector3(ps * (1.10 + wrnd() * 0.28), ps * (0.72 + wrnd() * 0.20), ps * (1.10 + wrnd() * 0.28)));
      pines.setMatrixAt(pn, pm4);
      ptc.setRGB(0.08 + wrnd() * 0.04, 0.19 + wrnd() * 0.07, 0.09 + wrnd() * 0.04);
      pines.setColorAt(pn, ptc);
      pm4.compose(new THREE.Vector3(px, ph - 0.2, pz), pq, new THREE.Vector3(ps * 0.45, ps * 0.65, ps * 0.45));
      pineTrunks.setMatrixAt(pn, pm4);
      pn++;
    }
    pines.count = pn; pineTrunks.count = pn;
    sc.add(pineTrunks, pines);

    // 茅ヶ崎: 烏帽子岩(姥島)と周囲の岩礁群・白波・茅ヶ崎ヘッドランド(T字突堤)・茅ヶ崎漁港
    const ex = -6450, ez = -1480;
    const rock = new THREE.Mesh(sGeo('eboshi', () => {
      const prof = [[0, -3], [12, -3], [10.5, 1.2], [8.0, 5.2], [5.8, 9.5], [3.8, 13.5], [1.9, 17.0], [0.45, 19.0], [0, 19.3]].map(([r, y]) => new THREE.Vector2(r, y));
      return new THREE.LatheGeometry(prof, 7);
    }), sMat(0x45403a));
    rock.position.set(ex, 0, ez); rock.rotation.set(0.05, 0.42, 0.12); rock.scale.set(1.08, 1.0, 0.76); sc.add(rock);
    for (const [dx, dz, r, h] of [[-28, 10, 9.5, 3.6], [19, -14, 7.5, 2.8], [38, 8, 10.5, 2.3], [-14, -26, 6.5, 2.9], [54, -6, 5.5, 1.7], [-46, -8, 7.5, 1.9]]) {
      sCyl(sc, ex + dx, -2, ez + dz, r * 0.45, r, h + 2, 0x4b463f, 6);
    }
    const eboPts = [];
    for (let k = 0; k <= 28; k++) {
      const a = (k / 28) * Math.PI * 2;
      eboPts.push({ x: ex + Math.cos(a) * 46, z: ez + Math.sin(a) * 26, ux: Math.cos(a), uz: Math.sin(a) });
    }
    surfStrip(sc, eboPts, 7);

    const hx = -5600, hz = shonanShoreZ(hx);
    sBox(sc, hx, -1, hz + 65, 9, 3.4, 145, 0x8f8b84);
    sBox(sc, hx, -1, hz + 138, 122, 3.4, 12, 0x8f8b84);
    // 平塚・相模川河口の湘南大橋と平塚新港防波堤
    const sgZ = shonanShoreZ(-8100);
    sBox(sc, -8100, 7.5, sgZ - 135, 310, 2.2, 13, 0xcbd5e1);
    for (let p = -1; p <= 1; p++) sBox(sc, -8100 + p * 95, -2, sgZ - 135, 6, 9.5, 11, 0x94a3b8);
    sBox(sc, -7680, -1, shonanShoreZ(-7680) + 85, 150, 3.8, 10, 0x94a3b8, -0.15);
    // 大磯港の防波堤と白灯台
    const oiZ = shonanShoreZ(-9920);
    sBox(sc, -9920, -1, oiZ + 95, 12, 4.2, 195, 0x9ca3af, 0.22);
    sBox(sc, -9850, -1, oiZ + 185, 115, 4.2, 11, 0x9ca3af, 0.12);
    sCyl(sc, -9800, 3, oiZ + 190, 1.5, 2.0, 11, 0xf8fafc, 8);
  }

  // ---- 4) 相模湾西岸〜丹沢・大山〜足柄〜箱根〜真鶴半島〜伊豆半島・大室山・天城連山 (連続実地形メッシュ) ----
  {
    // 大磯から二宮・国府津・小田原を経て南西へ湾曲し、真鶴半島・湯河原・熱海・伊東・川奈崎・城ヶ崎・稲取・河津へ至る実際の海岸線
    const WEST_COAST = [
      [-9150, -1890],   // 平塚・大磯境界 (landGeo とシームレス接続)
      [-9950, -1810],   // 大磯港・照ヶ崎
      [-11150, -1460],  // 大磯西・国府本郷
      [-12400, -860],   // 二宮・梅沢海岸
      [-13650, -180],   // 二宮・袖ヶ浦
      [-15200, 620],    // 国府津海岸
      [-16750, 1620],   // 酒匂川河口
      [-18050, 2920],   // 小田原・御幸の浜・早川港
      [-18950, 4650],   // 石橋・米神
      [-19650, 6650],   // 根府川・江之浦
      [-20050, 8350],   // 真鶴半島付け根(北側)
      [-18750, 9750],   // 真鶴半島北岸
      [-18195, 10610],  // 真鶴岬先端 (三ツ石の手前)
      [-19250, 10820],  // 真鶴港(南岸)
      [-21150, 10520],  // 福浦・吉浜(湯河原東)
      [-22350, 11650],  // 湯河原海岸
      [-22650, 12650],  // 伊豆山
      [-22930, 13580],  // 熱海サンビーチ・熱海湾奥
      [-22120, 14850],  // 錦ヶ浦・曽我浦
      [-22750, 16850],  // 網代湾
      [-22080, 18250],  // 宇佐美北岬
      [-22550, 20150],  // 宇佐美海岸
      [-21850, 22050],  // 伊東オレンジビーチ・伊東港
      [-20150, 22620],  // 汐吹崎
      [-18985, 23360],  // 川奈崎
      [-19680, 25450],  // 富戸
      [-19820, 27650],  // 城ヶ崎海岸・門脇埼
      [-20950, 29850],  // 伊豆高原・八幡野
      [-22250, 31900],  // 赤沢・大川
      [-23350, 33850],  // 北川・熱川
      [-24250, 35350],  // 稲取北
      [-24450, 36250],  // 稲取岬
      [-26250, 38300],  // 今井浜・河津
      [-28500, 41500],  // 白浜・下田方面
    ];
    const sdW = makeCoastField(WEST_COAST, [[-34000, 41500], [-34000, -17200], [-9150, -17200]]);

    // 鋭い尾根筋と谷筋を刻むマルチオクターブ・リッジノイズ
    const ridgeTex = (x, z) => {
      const n1 = 1 - Math.abs(2 * noise2(x / 1550 + 3.7, z / 1550 - 2.1) - 1);
      const n2 = 1 - Math.abs(2 * noise2(x / 680 - 5.3, z / 680 + 4.4) - 1);
      const n3 = noise2(x / 290 + 1.9, z / 290 - 6.2);
      return 0.56 * n1 + 0.30 * n2 + 0.14 * n3; // 0..1
    };
    // 2頂点間を自然な鞍部(サドル)付きで結ぶ山稜セグメント関数
    const ridgeSeg = (x, z, ax, az, bx, bz, hA, hB, width, sag = 0.12, p = 1.42) => {
      const dx = bx - ax, dz = bz - az;
      const L2 = dx * dx + dz * dz;
      const t = clampN(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
      const px = ax + dx * t - x, pz = az + dz * t - z;
      const u = Math.sqrt(px * px + pz * pz) / width;
      if (u >= 1) return 0;
      const hCrest = (hA + (hB - hA) * t) * (1 - sag * 4 * t * (1 - t));
      return hCrest * Math.pow(1 - u, p);
    };
    // 独立峰・火山ドーム関数 (flatTop > 0 で駒ヶ岳・大室山のような台形/お椀頂上を表現)
    const peakCone = (x, z, cx, cz, rx, rz, h, p = 1.5, flatTop = 0) => {
      const u = Math.hypot((x - cx) / rx, (z - cz) / rz);
      if (u >= 1) return 0;
      const ue = flatTop > 0 ? Math.max(0, (u - flatTop) / (1 - flatTop)) : u;
      return h * Math.pow(1 - ue, p);
    };

    const westH = (x, z) => {
      const d = sdW(x, z);
      if (d <= 0) return Math.max(-32, -3.5 + d * 0.08);

      const eastBlend = smooth(-9180, -9850, x);
      const westBack = smooth(-33800, -30600, x);
      const rt = ridgeTex(x, z);
      const rMod = 0.74 + 0.36 * rt;

      // 基本の海岸段丘・平野 (小田原・足柄平野や伊勢原・秦野盆地のベース)
      let mtn = 0;
      let plain = smooth(0, 65, d) * 3.2 + smooth(80, 1800, d) * (11 + 8 * noise2(x / 1600, z / 1600));

      // (A) 丹沢山地＆大山 (方位282°〜306°: 富士山の右裾野から西丹沢・表尾根・大山へと連なる重厚な山塊。x > -11900 は平地にして藤沢背後に山を作らない)
      if (z < -2200 && x < -11800) {
        const tanzawaEastCut = smooth(-11900, -13350, x);
        // 大山(1252m): 伊勢原平野から端正な三角錐で立ち上がる象徴的な独立峰シルエット (方位305°)
        const oyama = peakCone(x, z, -14300, -10250, 2850, 2550, 885, 1.50) * (0.82 + 0.24 * rt);
        // 表尾根(三ノ塔〜塔ノ岳)〜丹沢主脈(丹沢山〜神奈川県最高峰・蛭ヶ岳1673m)〜主稜(檜洞丸〜丹沢大室山)
        const r1 = ridgeSeg(x, z, -14300, -10250, -16700, -9650, 760, 845, 2550, 0.16, 1.44);
        const r2 = ridgeSeg(x, z, -16700, -9650, -18135, -11050, 845, 1055, 2900, 0.09, 1.38);
        const r3 = ridgeSeg(x, z, -18135, -11050, -19500, -13250, 1055, 1175, 3350, 0.08, 1.38);
        const r4 = ridgeSeg(x, z, -19500, -13250, -21750, -12750, 1175, 1105, 3350, 0.10, 1.40);
        const r5 = ridgeSeg(x, z, -21750, -12750, -23700, -14150, 1105, 1065, 3400, 0.10, 1.42);
        // 西丹沢稜線: 塔ノ岳〜鍋割山(方位297°)〜檜洞丸〜畦ヶ丸(方位294°)〜大野山・不老山(方位283°)〜三国山稜へなだらかに降りて富士山右裾へ繋がる実景スカイライン
        const w1 = ridgeSeg(x, z, -18135, -11050, -19650, -10250, 1020, 915, 2850, 0.10, 1.40);
        const w2 = ridgeSeg(x, z, -19650, -10250, -24200, -10750, 915, 845, 3300, 0.10, 1.42);
        const w3 = ridgeSeg(x, z, -24200, -10750, -25800, -6350, 845, 635, 3500, 0.12, 1.44);
        // 秦野・松田側の前衛山稜(弘法山・高松山 801m・大野山 723m)
        const frontT1 = ridgeSeg(x, z, -15200, -7200, -19800, -6400, 310, 565, 2700, 0.12, 1.46);
        const frontT2 = ridgeSeg(x, z, -19800, -6400, -24400, -5650, 565, 520, 2900, 0.12, 1.46);
        mtn = Math.max(mtn, oyama, Math.max(r1, r2, r3, r4, r5, w1, w2, w3, frontT1, frontT2) * rMod) * tanzawaEastCut;
      }

      // (B) 大磯丘陵(高麗山・湘南平)・二宮吾妻山・国府津曽我丘陵・足柄山地(矢倉岳)
      if (z > -8500 && z < 4500) {
        // 高麗山〜湘南平(181m): 大磯の海岸すぐ背後に迫るこんもりした常緑樹の丘陵
        const shonandaira = Math.max(
          ridgeSeg(x, z, -10150, -2100, -11400, -1980, 114, 122, 920, 0.05, 1.25),
          peakCone(x, z, -11280, -2010, 720, 580, 124, 1.25, 0.22)
        ) * (0.88 + 0.16 * rt);
        // 二宮・吾妻山(136m) & 大磯〜二宮の低丘陵
        const azuma = peakCone(x, z, -13200, -650, 980, 760, 84, 1.38);
        const oisoHills = ridgeSeg(x, z, -11600, -2350, -14200, -1850, 95, 115, 1250, 0.10, 1.45);
        // 国府津・松田の曽我丘陵(不動山・浅間山 320m: 酒匂川・小田原平野の北縁を限る丘陵)
        const soga = ridgeSeg(x, z, -15550, -1150, -17650, -2450, 178, 210, 1450, 0.08, 1.40) * (0.84 + 0.22 * rt);
        // 足柄峠〜矢倉岳(870m): 富士山のすぐ右手前の裾野にちょこんと尖るおむすび型の名峰
        const ashigaraBase = ridgeSeg(x, z, -25600, -8200, -26400, -400, 620, 445, 3600, 0.16, 1.48) * rMod;
        const yagura = peakCone(x, z, -25320, -3020, 1950, 1750, 565, 1.55) * (0.84 + 0.22 * rt);
        mtn = Math.max(mtn, shonandaira, azuma, oisoHills, soga, ashigaraBase, yagura);
      }

      // (C) 箱根連山(金時山・明神ヶ岳・明星ヶ岳・神山・駒ヶ岳・二子山・大観山・十国峠) & 真鶴半島
      if (z > -2600 && z < 15500) {
        // 金時山(1212m): 富士山の左手前に鋭く聳える箱根北端の秀峰
        const kintoki = peakCone(x, z, -27060, 195, 2350, 2050, 805, 1.60) * (0.84 + 0.24 * rt);
        // 北東外輪山: 明神ヶ岳(1169m)〜明星ヶ岳(924m)〜小田原早川へ降りる長い稜線
        const myojin = ridgeSeg(x, z, -27060, 195, -24830, 1365, 765, 780, 2800, 0.12, 1.42) * rMod;
        const myojo = ridgeSeg(x, z, -24830, 1365, -23900, 2950, 780, 605, 2550, 0.10, 1.42) * rMod;
        const odawaraSpur = ridgeSeg(x, z, -23900, 2950, -20200, 4200, 560, 185, 2200, 0.08, 1.48) * rMod;
        // 中央火口丘: 箱根最高峰・神山(1438m) と 平頂ドームの箱根駒ヶ岳(1356m)
        const kamiyama = peakCone(x, z, -26160, 4060, 3200, 2850, 965, 1.40) * (0.84 + 0.22 * rt);
        const komagatake = peakCone(x, z, -25850, 4620, 2600, 2300, 905, 1.32, 0.24) * (0.88 + 0.16 * rt);
        // 二子山(1099m): 江の島からもはっきり識別できる丸みを帯びた双耳溶岩ドーム(上二子・下二子)
        const futago1 = peakCone(x, z, -24780, 5260, 1550, 1250, 725, 1.28, 0.14);
        const futago2 = peakCone(x, z, -24660, 5920, 1500, 1250, 710, 1.28, 0.14);
        // 南外輪山: 大観山・鞍掛山(1011m)〜白銀山(根府川奥)〜十国峠(770m)
        const taikan = ridgeSeg(x, z, -25550, 6350, -25250, 7950, 685, 655, 3100, 0.08, 1.42) * rMod;
        const shirogane = ridgeSeg(x, z, -25250, 7200, -21200, 7900, 610, 265, 2300, 0.10, 1.45) * rMod;
        const jukkoku = ridgeSeg(x, z, -25250, 7950, -24990, 11600, 655, 472, 3100, 0.10, 1.42) * rMod;
        // 真鶴半島: 海へ細長く突き出した標高45〜58mの平坦な照葉樹林台地(お林)
        let manazuru = 0;
        if (x > -20400 && z > 8200 && z < 11000) {
          manazuru = smooth(0, 95, d) * (46 + 10 * smooth(220, 900, d) + 4 * noise2(x / 260, z / 260));
        }
        mtn = Math.max(mtn, kintoki, myojin, myojo, odawaraSpur, kamiyama, komagatake, futago1, futago2, taikan, shirogane, jukkoku, manazuru);
      }

      // (D) 伊豆半島(熱海・玄岳〜宇佐美〜伊東〜川奈・城ヶ崎〜伊豆大室山〜天城連山〜稲取・河津)
      if (z > 10500) {
        // 熱海峠・玄岳(798m)〜多賀・宇佐美(巣雲山 581m)〜伊東奥の山並み
        const kurotake = ridgeSeg(x, z, -24990, 11600, -26195, 14605, 472, 478, 3400, 0.08, 1.40) * rMod;
        const usamiMtn = ridgeSeg(x, z, -26195, 14605, -25350, 19085, 478, 360, 3400, 0.12, 1.42) * rMod;
        const itoPass = ridgeSeg(x, z, -25350, 19085, -25200, 25200, 360, 385, 3600, 0.22, 1.45) * rMod;
        const coastalApron = smooth(30, 2600, d) * (155 + 95 * noise2(x / 1800, z / 1800));
        // 伊豆・大室山(580m): 伊豆高原にぽっこり浮かぶ美しいお椀型の単成火山スコリア丘
        const izuOmuro = peakCone(x, z, -21985, 26795, 1550, 1550, 285, 1.26, 0.26);
        const kogenTerrace = peakCone(x, z, -21600, 26900, 3600, 4200, 125, 1.35);
        // 天城連山: 遠笠山(1197m)〜万二郎岳(1299m)〜伊豆最高峰・万三郎岳(1406m)〜高根山・稲取〜河津
        const amagi1 = ridgeSeg(x, z, -25200, 25200, -25855, 27835, 385, 695, 3700, 0.08, 1.38) * rMod;
        const amagi2 = ridgeSeg(x, z, -25855, 27835, -26020, 29460, 695, 758, 3900, 0.08, 1.36) * rMod;
        const amagi3 = ridgeSeg(x, z, -26020, 29460, -27215, 29575, 758, 828, 4100, 0.06, 1.36) * rMod;
        const amagi4 = ridgeSeg(x, z, -27215, 29575, -27040, 33555, 828, 470, 3900, 0.12, 1.40) * rMod;
        const amagi5 = ridgeSeg(x, z, -27040, 33555, -28200, 40500, 470, 275, 3600, 0.12, 1.45) * rMod;
        // 川奈崎・城ヶ崎海岸の溶岩海食崖台地
        const jogasaki = (z > 22400 && z < 30500 && d < 1200) ? smooth(0, 70, d) * 34 : 0;
        mtn = Math.max(mtn, kurotake, usamiMtn, itoPass, coastalApron, izuOmuro, kogenTerrace, amagi1, amagi2, amagi3, amagi4, amagi5, jogasaki);
      }

      const coastRise = smooth(0, 130, d);
      const totalH = plain + mtn * coastRise * westBack;
      return -12 + (totalH + 12) * eastBlend;
    };

    const westC = (x, z, h, out) => {
      if (h < -1.5) { out.setRGB(0.28, 0.32, 0.35); return; }
      const d = sdW(x, z);
      const dist = Math.hypot(x, z);
      const g = noise2(x / 220, z / 220);
      const gFine = noise2(x / 65, z / 65);
      // 砂浜区間 (大磯・二宮・国府津・小田原・湯河原・熱海サンビーチ・宇佐美・伊東) と 断崖区間 (真鶴・錦ヶ浦・川奈・城ヶ崎)
      const rockyCoast = (z > 7800 && z < 11100) || (z > 14200 && z < 16200) || (z > 22400 && z < 30200);
      if (h < 0.35) {
        out.setRGB(0.35, 0.34, 0.31);
        return;
      }
      if (d < 85 && !rockyCoast && h < 14) {
        out.setRGB(0.50 + 0.04 * gFine, 0.46 + 0.04 * gFine, 0.39 + 0.03 * gFine); // 西湘〜伊東の砂浜・礫浜
        return;
      }
      if (d < 95 && rockyCoast && h < 38) {
        out.setRGB(0.24 + 0.04 * gFine, 0.22 + 0.03 * gFine, 0.20 + 0.03 * gFine); // 真鶴・城ヶ崎の玄武岩海食崖
        return;
      }
      // 小田原・二宮・国府津・熱海・伊東の海沿い低地市街地トーン
      if (h < 52 && d < 1800 && !rockyCoast && gFine > 0.44) {
        out.setRGB(0.38 + 0.06 * g, 0.37 + 0.05 * g, 0.36 + 0.05 * g);
        return;
      }
      // 距離に応じた物理ベース常緑樹林〜群青・藍鼠色の重層山岳カラー (FogExp2 と合わさって実際の相模湾の空気遠近を再現)
      const farT = smooth(11500, 27500, dist);
      const altT = smooth(120, 920, h);
      // 近景(高麗山・真鶴): 深い照葉樹・黒松の緑 -> 中遠景(大山・箱根・天城): 気品あるスレート群青〜藍鼠色
      let r = 0.070 * (1 - farT) + 0.062 * farT + 0.016 * g + 0.012 * altT;
      let gg = 0.172 * (1 - farT) + 0.112 * farT + 0.024 * g + 0.014 * altT;
      let b = 0.092 * (1 - farT) + 0.208 * farT + 0.018 * g + 0.026 * altT;
      // 伊豆・大室山は特徴的なススキ草原の明るい若草〜黄緑色をほんのり帯びさせる
      const omuroK = Math.exp(-((x + 21985) * (x + 21985) + (z - 26795) * (z - 26795)) / 1.4e6) * smooth(120, 230, h);
      if (omuroK > 0.02) {
        r += (0.14 - r) * omuroK * 0.65;
        gg += (0.24 - gg) * omuroK * 0.65;
        b += (0.13 - b) * omuroK * 0.65;
      }
      out.setRGB(r, gg, b);
    };

    const wxs = gridAxis([[-33800, -27800, 420], [-27800, -17600, 180], [-17600, -9150, 145]]);
    const wzs = gridAxis([[-17000, -8800, 230], [-8800, 12600, 165], [12600, 31500, 240], [31500, 41500, 420]]);
    sc.add(new THREE.Mesh(buildGrid(wxs, wzs, westH, westC), new THREE.MeshLambertMaterial({ vertexColors: true })));

    // 西湘〜真鶴〜熱海〜伊東〜川奈の海岸線に砕ける白波ストリップ
    const wSurfPts = [];
    for (let i = 0; i < 25; i++) {
      const [ax, az] = WEST_COAST[i], [bx, bz] = WEST_COAST[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      // 北東→南西へ進む折れ線の左手側(東・海側)法線 = (bz - az, -(bx - ax)) / L
      const nx = (bz - az) / L, nz = -(bx - ax) / L;
      for (let s = 0; s < L; s += 90) {
        wSurfPts.push({ x: ax + ((bx - ax) * s) / L, z: az + ((bz - az) * s) / L, ux: nx, uz: nz });
      }
    }
    surfStrip(sc, wSurfPts, 13);

    // 湘南平(181m・高麗山西峰): 実際のランドマークである紅白の細身なテレビ鉄塔1基と白い円筒形展望レストハウス
    {
      const tx = -11280, tz = -2010, th = westH(tx, tz);
      // 展望レストハウス
      sCyl(sc, tx + 42, th - 2, tz + 14, 11, 12, 11, 0xeae6dc, 12);
      sCyl(sc, tx + 42, th + 9, tz + 14, 7, 9, 4.5, 0x94a3b8, 12);
      // 湘南平テレビ塔 (巨大な煙突3本ではなく、スレンダーな紅白トラス電波塔1基)
      sBanded(sc, tx, th - 3, tz, 0.55, 2.4, 38, 7, 0xdc2626, 0xf8fafc, 4);
      sCyl(sc, tx, th + 22, tz, 2.8, 2.8, 2.2, 0xe2e8f0, 8);
      sCyl(sc, tx, th + 35, tz, 0.18, 0.45, 9, 0xf8fafc, 6);
    }

    // 真鶴岬先端の象徴「三ツ石(笠島)」の岩礁
    for (const [mx, mz, mr, mh] of [[-18075, 10685, 11, 8.5], [-18040, 10712, 9.5, 7.2], [-18010, 10730, 8.0, 6.0]]) {
      sCyl(sc, mx, -2, mz, mr * 0.45, mr, mh + 2, 0x3b3733, 6);
    }

    // 小田原・熱海湾・伊東湾の海辺に控えめに佇む白い街並み・温泉リゾートホテル群
    for (const [cx, cz, count, spread, maxBh] of [
      [-18280, 2750, 26, 780, 20],  // 小田原市街
      [-23080, 13620, 24, 560, 28], // 熱海サンビーチ沿いのホテル群
      [-22020, 22080, 18, 520, 22], // 伊東湾沿いの街並み
    ]) {
      for (let i = 0; i < count; i++) {
        const a = (i * 2.39996) % (Math.PI * 2), r = ((i + 0.5) / count) * spread;
        const bx = cx - Math.abs(Math.cos(a)) * r * 0.7 - 60;
        const bz = cz + Math.sin(a) * r;
        const bh0 = westH(bx, bz);
        if (bh0 < 2 || bh0 > 75) continue;
        const bw = 14 + (i % 4) * 5, bh = 10 + (i % 5) * ((maxBh - 10) / 4);
        sBox(sc, bx, bh0 - 2, bz, bw, bh + 2, bw * 0.85, i % 3 === 0 ? 0xe5e0d5 : 0xd6d9de, 0.35);
      }
    }
  }

  // ---- 5) 初島 (熱海沖・方位約225°) & 伊豆大島・三原山 (南方水平線・方位約187°) ----
  {
    // 初島: 相模湾に浮かぶ平坦な台形状の緑の島(最高標高約31m)と白い初島灯台
    const hx0 = -17620, hz0 = 17340;
    const hxs = gridAxis([[hx0 - 650, hx0 + 650, 52]]);
    const hzs = gridAxis([[hz0 - 450, hz0 + 450, 48]]);
    const hatsuH = (x, z) => {
      const dx = (x - hx0) / 460, dz = (z - hz0) / 285;
      const r = Math.hypot(dx * 0.92 + dz * 0.38, -dx * 0.38 + dz * 0.92) + (noise2(x / 180, z / 180) - 0.5) * 0.16;
      if (r >= 1.0) return -22;
      // 海面から急な海食崖で立ち上がり、島の上面がテーブル状に平らな初島特有のシルエット
      return smooth(1.0, 0.76, r) * (20.5 + 2.5 * noise2(x / 140, z / 140)) - 2.0;
    };
    const hatsuC = (x, z, h, out) => {
      if (h < 0.3) out.setRGB(0.32, 0.32, 0.30);
      else if (h < 7.0) out.setRGB(0.28, 0.27, 0.25);
      else out.setRGB(0.075, 0.155, 0.145);
    };
    sc.add(new THREE.Mesh(buildGrid(hxs, hzs, hatsuH, hatsuC), new THREE.MeshLambertMaterial({ vertexColors: true })));
    sCyl(sc, hx0 + 240, 18, hz0 - 40, 2.2, 3.0, 14, 0xf8fafc, 8); // 初島灯台

    // 伊豆大島: 南の水平線に広くゆったりと裾野を広げる楯状火山(カルデラ外輪山＋中央の三原山 758m)
    const ox0 = -5070, oz0 = 39070;
    const oxs = gridAxis([[ox0 - 5200, ox0 + 5200, 210]]);
    const ozs = gridAxis([[oz0 - 2900, oz0 + 2900, 190]]);
    const oshimaH = (x, z) => {
      const u = (x - ox0) / 4450, v = (z - oz0) / 2250;
      const r = Math.hypot(u, v) + (noise2(x / 1100, z / 1100) - 0.5) * 0.14;
      if (r >= 1.0) return -28;
      // なだらかな楯状火山の裾野＋カルデラ台地＋中央やや南寄りの三原山内輪山ピーク
      const shield = Math.pow(1 - r, 0.88) * 215;
      const mihara = 148 * Math.pow(Math.max(0, 1 - Math.hypot((x - (ox0 - 220)) / 1450, (z - (oz0 + 180)) / 1050)), 1.35);
      return shield + mihara * smooth(0.85, 0.35, r) - 4.0;
    };
    const oshimaC = (x, z, h, out) => {
      if (h < 1.0) out.setRGB(0.28, 0.32, 0.38);
      else out.setRGB(0.062, 0.108, 0.215);
    };
    sc.add(new THREE.Mesh(buildGrid(oxs, ozs, oshimaH, oshimaC), new THREE.MeshLambertMaterial({ vertexColors: true })));
  }

  grp.add(sc);
}

// =====================================================================
// 八景島ステージ: 実際の東京湾西岸〜房総の景観 (root ローカル座標: 八景島中心 ≒ (-1250, 150)、コース ≒ (280, -980))
// =====================================================================
function addHakkeiScenery(root, movingShips = []) {
  const sc = new THREE.Group();

  // ---- 1) 横須賀 (追浜・夏島の南〜猿島の対岸): 八景島から南に見える丘陵と市街・港 ----
  const YOKO = [[-1300, 2350], [-1020, 2300], [-600, 2600], [-150, 3100], [300, 3500], [700, 3800], [1000, 4300], [1400, 5000], [2000, 5700], [2600, 6600], [3200, 7800], [3600, 9500], [3800, 12500]];
  const sdY = makeCoastField(YOKO, [[-1300, 12500]]);
  const yokoH = (x, z) => {
    const d = sdY(x, z);
    if (d <= 0) return Math.max(-30, -3 + d * 0.08);
    return 2.6 * smooth(0, 30, d) + 128 * Math.pow(smooth(40, 1300, d), 0.9) * (0.45 + 0.55 * noise2(x / 900 + 11, z / 900)) - 1.0;
  };
  const yokoC = (x, z, h, out) => {
    const d = sdY(x, z), g = noise2(x / 140, z / 140);
    if (h < 0.3) out.setRGB(0.36, 0.35, 0.33);
    else if (d < 70) out.setRGB(0.52, 0.53, 0.54); // 岸壁
    else if (h < 60 && d < 1300 && noise2(x / 80, z / 80) > 0.42) out.setRGB(0.48 + g * 0.05, 0.47 + g * 0.05, 0.45);
    else out.setRGB(0.1 + 0.05 * g, 0.22 + 0.08 * g, 0.09 + 0.03 * g);
  };
  sc.add(new THREE.Mesh(buildGrid(gridAxis([[-1300, 4300, 110]]), gridAxis([[2200, 6200, 110], [6200, 12500, 300]]), yokoH, yokoC), new THREE.MeshLambertMaterial({ vertexColors: true })));
  const cityPal = [0xe5e7eb, 0xd6d3d1, 0xf1f5f9, 0xcbd5e1, 0xe7e5e4];
  for (let k = 0, tries = 0; k < 150 && tries < 4000; tries++) {
    const x = -900 + rnd() * 3300, z = 2500 + rnd() * 4200;
    const d = sdY(x, z); if (d < 50 || d > 1100) continue;
    const h = yokoH(x, z); if (h < 2 || h > 50) continue;
    const w = 14 + rnd() * 18, dd = 14 + rnd() * 18, bh = 9 + rnd() * 22;
    sBox(sc, x, h - 2, z, w, bh + 2, dd, cityPal[(rnd() * cityPal.length) | 0], rnd() * 0.6);
    k++;
  }
  // 横須賀中央の高層ビル群 (ベイスクエアよこすか等 ~100m) と港のクレーン
  for (const [x, z, w, h] of [[520, 4150, 30, 104], [610, 4230, 26, 72], [430, 4300, 24, 62], [700, 4120, 22, 55]]) sBox(sc, x, 2, z, w, h, w, 0xe2e8f0);
  for (const [x, z] of [[860, 3880], [960, 4050]]) { sBox(sc, x, 2, z, 4, 45, 4, 0x64748b); sBox(sc, x + 14, 44, z, 40, 3, 3, 0x64748b); }
  // 猿島 (東京湾唯一の自然島: 横須賀沖の緑の小島)
  distantLand(sc, 1600, 2950, 240, 130, 42, 0.5, 14);
  // 野島 (野島公園の小高い丘・展望台)
  distantLand(sc, -1650, 950, 300, 220, 58, 0.3, 14);
  sCyl(sc, -1650, 40, 950, 3, 4, 14, 0xf1f5f9, 8);

  // ---- 2) 北側: 磯子火力発電所(扁平な200m煙突)・根岸製油所(タンク群と紅白煙突) ----
  sCyl(sc, -1900, 1, -4400, 12, 15, 200, 0xd9dde2, 12, 1, 0.55);
  sCyl(sc, -1900, 186, -4400, 12.2, 12.4, 14, 0x9aa5b1, 12, 1, 0.55);
  sBox(sc, -2010, 1, -4330, 70, 72, 55, 0xe5e7eb); sBox(sc, -2090, 1, -4440, 65, 64, 50, 0xd6dbe0);
  for (const dz of [-80, 0]) sCyl(sc, -1790, 1, -4560 + dz, 26, 28, 48, 0xcbd5e1, 14);
  for (let i = 0; i < 18; i++) sCyl(sc, -2250 - (i % 6) * 70, 1, -5000 - Math.floor(i / 6) * 75, 27, 27, 16 + (i % 3) * 4, i % 4 ? 0xeef0f2 : 0xd1d5db, 12);
  sBanded(sc, -2350, 1, -5300, 3.5, 5, 120, 6, 0xdc2626, 0xf8fafc, 8);
  sBanded(sc, -2600, 1, -5150, 3, 4.4, 95, 6, 0xdc2626, 0xf8fafc, 8);

  // ---- 3) 対岸の房総半島: 富津岬の細長い砂州・君津製鉄所・東京湾アクアライン(海ほたる/風の塔)・鋸山〜鹿野山の稜線 ----
  const BOSO = [[10400, 30000], [9800, 13000], [10450, 1600], [12950, 650], [14000, -3000], [14950, -7150], [18000, -9500], [22000, -12000], [25000, -18000], [26000, -26000]];
  const sdB = makeCoastField(BOSO, [[42000, -26000], [42000, 30000]]);
  const bosoH = (x, z) => {
    const d = sdB(x, z);
    if (d <= 0) return -30;
    const south = smooth(-2000, 6000, z);
    const top = 70 + 260 * south;
    let h = 3 * smooth(0, 60, d) + top * Math.pow(smooth(200, 4500, d), 0.8) * (0.4 + 0.6 * noise2(x / 2600 + 1, z / 2600 + 5));
    h += 150 * Math.exp(-((x - 18100) ** 2 + (z - 6800) ** 2) / 1.2e7); // 鹿野山 (379m)
    h += 120 * Math.exp(-((x - 10600) ** 2 + (z - 12600) ** 2) / 1.5e6); // 鋸山 (329m)
    return h - 2;
  };
  const bosoC = (x, z, h, out) => {
    const g = noise2(x / 900, z / 900);
    // 東京湾の対岸(約12〜25km先)の千葉・房総半島は大気遠近でうっすら霞んだ淡い青灰緑色にする
    if (h < 3) out.setRGB(0.54, 0.61, 0.69);
    else if (h < 40 && z < 3000) out.setRGB(0.52, 0.59, 0.67); // 君津・木更津の臨海部
    else out.setRGB(0.46 + 0.04 * g, 0.56 + 0.05 * g, 0.66 + 0.04 * g);
  };
  sc.add(new THREE.Mesh(buildGrid(gridAxis([[9000, 34000, 600]]), gridAxis([[-26000, 30000, 700]]), bosoH, bosoC), new THREE.MeshLambertMaterial({ vertexColors: true })));
  distantLand(sc, 8700, 1500, 2000, 260, 12, 0.157, 24); // 富津岬
  // 君津製鉄所: 高炉と煙突も遠景の霞になじむ淡いトーンに調整
  for (const [x, z] of [[13300, -300], [13700, 600], [14200, 1500]]) { sBox(sc, x, 0, z, 70, 70, 60, 0xa8b8c8); sCyl(sc, x + 30, 0, z + 10, 7, 9, 105, 0x9cb0c4, 8); }
  for (const [x, z, h] of [[13000, -900, 190], [13500, 1000, 170], [14000, 2200, 150], [12900, 1800, 120]]) sBanded(sc, x, 0, z, 5, 7, h, 7, 0xd97777, 0xe2e8f0, 8);
  // 東京湾アクアライン: 海ほたるPA(船型の人工島) と木更津へ伸びる低い橋、川崎側の換気塔「風の塔」
  sBox(sc, 13300, -1, -9800, 110, 26, 640, 0xd8e2ec, 0.557);
  sBox(sc, 13300, 24, -9800, 60, 10, 260, 0xcbd5e1, 0.557);
  {
    const ax = 13300 + 320 * Math.sin(0.557), az = -9800 + 320 * Math.cos(0.557);
    const bx = 14950, bz = -7150, L = Math.hypot(bx - ax, bz - az), ry = Math.atan2(bx - ax, bz - az);
    const N = 8;
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N, hump = 12 + 30 * Math.exp(-((t - 0.25) ** 2) / 0.01);
      sBox(sc, ax + (bx - ax) * t, hump, az + (bz - az) * t, 22, 3, L / N + 4, 0xd1d5db, ry);
    }
  }
  sCyl(sc, 10450, -1, -11750, 22, 26, 75, 0xd8e2ec, 10); sCyl(sc, 10560, -1, -11720, 18, 22, 90, 0xd8e2ec, 10);

  // ---- 4) 東京湾の錨泊船・航行船 (横浜港外の錨地〜浦賀水道をゆっくり航行) ----
  const bayLaneShips = [
    [3600, -3200, 0.4, 190, 'bulk', 0x7f1d1d], [5200, -1900, -0.2, 230, 'container', 0x1e3a8a], [6400, -4300, 0.9, 170, 'tanker', 0x111827],
    [5600, 1200, 1.4, 200, 'car', 0xe5e7eb], [7900, -2600, 0.1, 250, 'container', 0x0f172a], [4300, 3600, -0.6, 160, 'bulk', 0x374151],
    [8800, 3900, 1.6, 210, 'tanker', 0x7c2d12], [9300, -6200, 0.3, 180, 'bulk', 0x1f2937], [3200, -6800, -0.9, 200, 'container', 0x064e3b],
  ];
  bayLaneShips.forEach(([x, z, ry, len, type, hex], idx) => {
    const sg = sShip(sc, x, z, ry, len, type, hex);
    sg.userData.noBake = true;
    movingShips.push({ obj: sg, x0: x, z0: z, ry, speed: 1.6 + (idx % 3) * 0.45, range: 380 + (idx % 4) * 90, ph: idx * 1.2 });
  });

  // ---- 5) 遠景の丹沢(大山)・箱根: 西の丘陵越しにわずかに稜線が覗く ----
  distantLand(sc, -26500, -8300, 1600, 1500, 880, 0.2, 22);
  distantLand(sc, -33000, -12000, 3800, 1600, 940, -0.44, 30);
  distantLand(sc, -38000, 9000, 4200, 3200, 740, 0.25, 28);

  root.add(sc);
}


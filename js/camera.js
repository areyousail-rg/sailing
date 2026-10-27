// ドローンカメラ & 艇内オンボードカメラ（風上・風下クイックルック対応）
import * as THREE from 'three';
import { U, toWorld, LEGS } from './course.js';
import { wrap, clamp } from './sim.js';

export const CAM_MODES = ['ドローンカメラ', '艇内カメラ(オンボード)'];
export const COCKPIT = 1;
// スマホ(小さい画面)ではドローンを少し引いて周囲を見やすくする
const SMALL = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
// 海面近くを低空チェイスして波・航跡・スプレーが勢いよく後方へ流れるスピード感重視のドローン設定
const DRONE_D = SMALL ? 19.5 : 15.0, DRONE_H = SMALL ? 6.6 : 4.7, DRONE_FOV = SMALL ? 66 : 63;

export class DroneCam {
  constructor(camera, dom) {
    this.cam = camera; this.mode = 0; this.mount = null;
    this.pos = new THREE.Vector3(0, 30, 80); this.look = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0; this.targetYaw = 0; this.targetPitch = 0;
    this.chaseH = 0; this.bank = 0;
    this.zoom = 1; this.inited = false;
    this.tmp = new THREE.Vector3(); this.want = new THREE.Vector3(); this.wantLook = new THREE.Vector3();
    this.cp = new THREE.Vector3(); this.cq = new THREE.Quaternion(); this.cs = new THREE.Vector3();
    
    let drag = false, lx = 0, ly = 0, lt = 0;
    let downX = 0, downY = 0, downT = 0, lastTapT = 0, lastTapX = 0, lastTapY = 0;
    this.vYaw = 0; this.vPitch = 0; this.dragging = false;
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', (e) => {
      drag = true; this.dragging = true; this.vYaw = 0; this.vPitch = 0;
      lx = e.clientX; ly = e.clientY; lt = e.timeStamp;
      downX = e.clientX; downY = e.clientY; downT = performance.now();
    });
    const release = (e) => {
      if (drag && e) {
        const now = performance.now();
        const moveDist = Math.hypot(e.clientX - downX, e.clientY - downY);
        if (moveDist < 16 && now - downT < 280) {
          if (now - lastTapT < 350 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 42) {
            this.resetAngle();
            lastTapT = 0;
          } else {
            lastTapT = now; lastTapX = e.clientX; lastTapY = e.clientY;
          }
        }
      }
      drag = false; this.dragging = false;
      if (e && e.timeStamp - lt > 90) { this.vYaw = 0; this.vPitch = 0; } // 止めてから離した場合は慣性なし
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    dom.addEventListener('dblclick', () => this.resetAngle());
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dyaw = (e.clientX - lx) * 0.005;
      const dpitch = (e.clientY - ly) * 0.004;
      const dtm = Math.max(1, e.timeStamp - lt);
      this.vYaw = clamp(this.vYaw * 0.6 + (-dyaw / dtm * 1000) * 0.4, -5, 5);
      this.vPitch = clamp(this.vPitch * 0.6 + (dpitch / dtm * 1000) * 0.4, -3, 3);
      this.targetYaw -= dyaw;
      this.targetPitch = clamp(this.targetPitch + dpitch, -0.5, 0.9);
      if (this.mode === COCKPIT) this.targetYaw = clamp(this.targetYaw, -2.5, 2.5);
      lx = e.clientX; ly = e.clientY; lt = e.timeStamp;
    });
    dom.addEventListener('wheel', (e) => { this.zoom = clamp(this.zoom * (1 + Math.sign(e.deltaY) * 0.08), 0.4, 3); e.preventDefault(); }, { passive: false });
  }

  resetAngle() {
    this.targetYaw = 0;
    this.targetPitch = 0;
    this.vYaw = 0;
    this.vPitch = 0;
    this.zoom = 1;
  }

  setMode(m) {
    const n = (m + CAM_MODES.length) % CAM_MODES.length;
    if (n !== this.mode) { this.yaw = 0; this.pitch = 0; this.targetYaw = 0; this.targetPitch = 0; this.zoom = 1; this.inited = false; }
    this.mode = n;
  }

  // 風上確認 (Look Windward): 風上側の他艇・風の入り方を見る
  lookWindward(tack) {
    if (this.mode !== COCKPIT) this.setMode(COCKPIT);
    // tack > 0 (右舷タック) は風が右から来る = 右(+x)が風上 → 右を向く(yaw負)
    this.targetYaw = tack > 0 ? -1.2 : 1.2;
    this.targetPitch = -0.05;
  }

  // 風下確認 (Look Leeward): ブームの下をくぐって風下側の他艇を見る
  lookLeeward(tack) {
    if (this.mode !== COCKPIT) this.setMode(COCKPIT);
    this.targetYaw = tack > 0 ? 1.35 : -1.35;
    this.targetPitch = 0.2;
  }

  // 後方/他艇確認 (Look Stern)
  lookStern() {
    if (this.mode !== COCKPIT) this.setMode(COCKPIT);
    this.targetYaw = Math.PI * 0.85;
    this.targetPitch = 0.05;
  }

  // 前方/セール集中 (Center Look): ジブのテルテールを見上げる
  lookAhead() {
    if (this.mode !== COCKPIT) this.setMode(COCKPIT);
    this.targetYaw = 0;
    this.targetPitch = -0.12;
  }

  update(dt, t, boat, boats) {
    // フリック後の慣性(指を離しても滑らかに減衰しながら回り続ける)
    if (!this.dragging && (this.vYaw || this.vPitch)) {
      this.targetYaw += this.vYaw * dt;
      this.targetPitch = clamp(this.targetPitch + this.vPitch * dt, -0.5, 0.9);
      if (this.mode === COCKPIT) this.targetYaw = clamp(this.targetYaw, -2.5, 2.5);
      const k = Math.exp(-dt * 3.2);
      this.vYaw *= k; this.vPitch *= k;
      if (Math.abs(this.vYaw) < 0.01) this.vYaw = 0;
      if (Math.abs(this.vPitch) < 0.01) this.vPitch = 0;
    }
    // スムーズなカメラ回転補間
    this.yaw += (this.targetYaw - this.yaw) * (1 - Math.exp(-dt * 7));
    this.pitch += (this.targetPitch - this.pitch) * (1 - Math.exp(-dt * 7));

    if (this.mode === COCKPIT && this.mount) {
      this.mount.updateWorldMatrix(true, false);
      this.mount.matrixWorld.decompose(this.cp, this.cq, this.cs);
      this.cam.position.copy(this.cp); this.cam.quaternion.copy(this.cq);
      this.cam.rotateY(this.yaw); this.cam.rotateX(0.11 - this.pitch * 0.6); this.cam.rotateZ(-boat.heel * 0.45);
      
      if (this.cam.near !== 0.16) { this.cam.near = 0.16; this.cam.updateProjectionMatrix(); }
      if (Math.abs(this.cam.fov - 124) > 0.05) { this.cam.fov += (124 - this.cam.fov) * 0.25; this.cam.updateProjectionMatrix(); }
      return;
    }

    if (this.cam.near !== 0.6) { this.cam.near = 0.6; this.cam.updateProjectionMatrix(); }
    const w = this.want, lk = this.wantLook;
    const spdRatio = clamp(Math.abs(boat.v) / 6.2, 0, 1.3);
    if (!this.inited) this.chaseH = boat.h;
    const hDiff = wrap(boat.h - this.chaseH);
    this.chaseH = wrap(this.chaseH + hDiff * (1 - Math.exp(-dt * 4.2)));

    // 速度が上がるほど海面すれすれを低空で追いかけ、広角FOV＋ダイナミックなロールで疾走感を演出
    const follow = 3.8 + spdRatio * 1.8, lookRate = 7.5;
    const vib = 0.08 + spdRatio * 0.22;
    const wob = (a) => (Math.sin(t * 1.4 * a + a) * 0.28 + Math.sin(t * 4.2 * a) * 0.14) * vib;

    // ドローンカメラ視点 (スタート画面表示中はヨットがカメラの下側に来るよう視線lk.yを高くする)
    const ang = (this.menuOffset ? boat.h : this.chaseH) + this.yaw;
    const menuLift = this.menuOffset ? (SMALL ? 6.8 : 5.4) : 0;
    const menuDistAdd = this.menuOffset ? 4.5 : 0;
    const menuHgtAdd = this.menuOffset ? 2.2 : 0;
    const speedLow = this.menuOffset ? 0 : spdRatio * 0.85;
    const d = (DRONE_D + menuDistAdd - spdRatio * 1.1) * this.zoom;
    const hgt = (DRONE_H + menuHgtAdd - speedLow + this.pitch * 10) * this.zoom;
    // ヒールや回頭に合わせてカメラがわずかに外측へスイングし、船体とセールの迫力を見せる
    const latOffset = this.menuOffset ? 0 : clamp(-hDiff * 3.2 - boat.heel * 1.4, -2.4, 2.4);
    const rx = Math.cos(ang), rz = Math.sin(ang);
    w.set(boat.x - Math.sin(ang) * d + rx * latOffset, hgt, boat.z + Math.cos(ang) * d + rz * latOffset);
    const yawAlign = Math.max(0, Math.cos(this.yaw));
    const lookAhead = (9.5 + spdRatio * 3.5) * yawAlign;
    lk.set(boat.x + Math.sin(boat.h) * lookAhead, 1.45 + (1 - yawAlign) * 0.45 + menuLift - spdRatio * 0.18, boat.z - Math.cos(boat.h) * lookAhead);

    w.x += wob(1); w.y += wob(1.7) * 0.7; w.z += wob(2.3);
    if (!this.inited) { this.pos.copy(w); this.look.copy(lk); this.inited = true; }
    const k = 1 - Math.exp(-dt * follow), kl = 1 - Math.exp(-dt * lookRate);
    this.pos.lerp(w, k); this.look.lerp(lk, kl);
    const minY = Math.max(1.85, (boat.waveH || 0) + 1.75);
    if (this.pos.y < minY) this.pos.y = minY;
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
    const targetBank = this.menuOffset ? 0 : clamp(-hDiff * 0.14 - boat.heel * 0.08, -0.09, 0.09);
    this.bank += (targetBank - this.bank) * (1 - Math.exp(-dt * 6));
    this.cam.rotateZ(this.bank + Math.sin(t * 0.9) * 0.003 + Math.sin(t * 3.1) * 0.002 * (0.5 + spdRatio));

    const fov = (this.menuOffset ? DRONE_FOV - 5 : DRONE_FOV) + spdRatio * 12.5;
    if (Math.abs(this.cam.fov - fov) > 0.01) { this.cam.fov += (fov - this.cam.fov) * 0.08; this.cam.updateProjectionMatrix(); }
  }
}


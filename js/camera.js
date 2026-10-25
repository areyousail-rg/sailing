// ドローンカメラ & 艇内オンボードカメラ（風上・風下クイックルック対応）
import * as THREE from 'three';
import { U, toWorld, LEGS } from './course.js';
import { wrap, clamp } from './sim.js';

export const CAM_MODES = ['ドローンカメラ', '艇内カメラ(オンボード)'];
export const COCKPIT = 1;
// スマホ(小さい画面)ではドローンを少し引いて周囲を見やすくする
const SMALL = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
const DRONE_D = SMALL ? 29 : 22, DRONE_H = SMALL ? 11 : 8, DRONE_FOV = SMALL ? 58 : 54;

export class DroneCam {
  constructor(camera, dom) {
    this.cam = camera; this.mode = 0; this.mount = null;
    this.pos = new THREE.Vector3(0, 30, 80); this.look = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0; this.targetYaw = 0; this.targetPitch = 0;
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

    if (this.cam.near !== 1.0) { this.cam.near = 1.0; this.cam.updateProjectionMatrix(); }
    const w = this.want, lk = this.wantLook;
    const follow = 2.4, lookRate = 5.5;
    const wob = (a) => Math.sin(t * 0.9 * a + a) * 0.4 + Math.sin(t * 2.3 * a) * 0.2;

    // ドローンカメラ視点 (スタート画面表示中はヨットがカメラの下側に来るよう視線lk.yを高くする)
    const ang = boat.h + this.yaw;
    const menuLift = this.menuOffset ? (SMALL ? 7.2 : 5.8) : 0;
    const d = (DRONE_D - (this.menuOffset ? 2 : 0)) * this.zoom;
    const hgt = (DRONE_H - (this.menuOffset ? 1.6 : 0) + this.pitch * 12) * this.zoom;
    w.set(boat.x - Math.sin(ang) * d, hgt, boat.z + Math.cos(ang) * d);
    lk.set(boat.x + Math.sin(boat.h) * 8, 1.6 + menuLift, boat.z - Math.cos(boat.h) * 8);

    w.x += wob(1) * 0.25; w.y += wob(1.7) * 0.2; w.z += wob(2.3) * 0.25;
    if (!this.inited) { this.pos.copy(w); this.look.copy(lk); this.inited = true; }
    const k = 1 - Math.exp(-dt * follow), kl = 1 - Math.exp(-dt * lookRate);
    this.pos.lerp(w, k); this.look.lerp(lk, kl);
    if (this.pos.y < 2.5) this.pos.y = 2.5;
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
    this.cam.rotateZ(Math.sin(t * 0.7) * 0.003 + Math.sin(t * 1.9) * 0.002);
    
    const fov = DRONE_FOV + clamp(boat.v / 7, 0, 1) * 6;
    if (Math.abs(this.cam.fov - fov) > 0.01) { this.cam.fov += (fov - this.cam.fov) * 0.05; this.cam.updateProjectionMatrix(); }
  }
}


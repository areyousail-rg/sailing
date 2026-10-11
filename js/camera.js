// ドローンカメラ & 艇内オンボードカメラ（風上・風下クイックルック対応）
import * as THREE from 'three';
import { U, toWorld, LEGS } from './course.js';
import { wrap, clamp } from './sim.js';

export const CAM_MODES = ['ドローンカメラ', '艇内カメラ(オンボード)'];
export const COCKPIT = 1;

export class DroneCam {
  constructor(camera, dom) {
    this.cam = camera; this.mode = 0; this.mount = null;
    this.pos = new THREE.Vector3(0, 30, 80); this.look = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0; this.targetYaw = 0; this.targetPitch = 0;
    this.zoom = 1; this.inited = false;
    this.tmp = new THREE.Vector3(); this.want = new THREE.Vector3(); this.wantLook = new THREE.Vector3();
    this.cp = new THREE.Vector3(); this.cq = new THREE.Quaternion(); this.cs = new THREE.Vector3();
    
    let drag = false, lx = 0, ly = 0;
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', (e) => { drag = true; lx = e.clientX; ly = e.clientY; });
    window.addEventListener('pointerup', () => { drag = false; });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dyaw = (e.clientX - lx) * 0.005;
      const dpitch = (e.clientY - ly) * 0.004;
      this.targetYaw -= dyaw;
      this.targetPitch = clamp(this.targetPitch + dpitch, -0.5, 0.9);
      if (this.mode === COCKPIT) this.targetYaw = clamp(this.targetYaw, -2.5, 2.5);
      lx = e.clientX; ly = e.clientY;
    });
    dom.addEventListener('wheel', (e) => { this.zoom = clamp(this.zoom * (1 + Math.sign(e.deltaY) * 0.08), 0.4, 3); e.preventDefault(); }, { passive: false });
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
    // スムーズなカメラ回転補間
    this.yaw += (this.targetYaw - this.yaw) * (1 - Math.exp(-dt * 12));
    this.pitch += (this.targetPitch - this.pitch) * (1 - Math.exp(-dt * 12));

    if (this.mode === COCKPIT && this.mount) {
      this.mount.updateWorldMatrix(true, false);
      this.mount.matrixWorld.decompose(this.cp, this.cq, this.cs);
      this.cam.position.copy(this.cp); this.cam.quaternion.copy(this.cq);
      this.cam.rotateY(this.yaw); this.cam.rotateX(0.13 - this.pitch * 0.6); this.cam.rotateZ(-boat.heel * 0.45);
      
      if (this.cam.near !== 0.08) { this.cam.near = 0.08; this.cam.updateProjectionMatrix(); }
      if (Math.abs(this.cam.fov - 80) > 0.05) { this.cam.fov += (80 - this.cam.fov) * 0.2; this.cam.updateProjectionMatrix(); }
      return;
    }

    if (this.cam.near !== 0.5) { this.cam.near = 0.5; this.cam.updateProjectionMatrix(); }
    const w = this.want, lk = this.wantLook;
    const follow = 2.4, lookRate = 5.5;
    const wob = (a) => Math.sin(t * 0.9 * a + a) * 0.4 + Math.sin(t * 2.3 * a) * 0.2;

    // ドローンカメラ視点
    const ang = boat.h + this.yaw;
    const d = 22 * this.zoom, hgt = (8 + this.pitch * 12) * this.zoom;
    w.set(boat.x - Math.sin(ang) * d, hgt, boat.z + Math.cos(ang) * d);
    lk.set(boat.x + Math.sin(boat.h) * 8, 1.6, boat.z - Math.cos(boat.h) * 8);

    w.x += wob(1) * 0.25; w.y += wob(1.7) * 0.2; w.z += wob(2.3) * 0.25;
    if (!this.inited) { this.pos.copy(w); this.look.copy(lk); this.inited = true; }
    const k = 1 - Math.exp(-dt * follow), kl = 1 - Math.exp(-dt * lookRate);
    this.pos.lerp(w, k); this.look.lerp(lk, kl);
    if (this.pos.y < 2.5) this.pos.y = 2.5;
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
    this.cam.rotateZ(Math.sin(t * 0.7) * 0.003 + Math.sin(t * 1.9) * 0.002);
    
    const fov = 54 + clamp(boat.v / 7, 0, 1) * 6;
    if (Math.abs(this.cam.fov - fov) > 0.01) { this.cam.fov += (fov - this.cam.fov) * 0.05; this.cam.updateProjectionMatrix(); }
  }
}


// Mixed-Reality-Modus: volle Durchsicht, dein Unterkoerper wird blau eingefaerbt.
// Quest 3 (Tiefensensor): Erkennung in leg-tracker.js – nur Beine/Fuesse, Boden live gemessen,
// Oberkoerper und Haende ausgespart. Die Maske ist spaeter auch fuer Kleidung gedacht.
// Ohne Tiefensensor: Beine werden aus der Kopfposition geschaetzt (als "geschaetzt" angezeigt).
import * as THREE from 'three';
import { ICON_PATHS } from '/icons.js';
import { LegTracker } from '/leg-tracker.js';

const BLUE = new THREE.Color(0x3d8bff);
const JOINTS = [['wrist', 0.08], ['middle-finger-metacarpal', 0.08], ['index-finger-tip', 0.045], ['thumb-tip', 0.045], ['pinky-finger-tip', 0.045]];

export class MixedReality {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 50);
    this.floorY = 0;
    this.strength = 1;

    // Bein-Erkennung per Tiefensensor (nur Beine/Fuesse, kein Oberkoerper, keine Haende)
    this.legs = new LegTracker(this.renderer, this.scene);

    // Ersatz ohne Tiefensensor: geschaetzte Beine unter dem Kopf
    const mat = new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0.4, depthWrite: false });
    this.est = new THREE.Group();
    for (const x of [-0.1, 0.1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.75, 6, 14), mat); leg.position.set(x, 0.45, 0); leg.userData.leg = true;
      const foot = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.16, 4, 10).rotateX(Math.PI / 2), mat); foot.position.set(x, 0.05, 0.08);
      this.est.add(leg, foot);
    }
    this.est.visible = false;
    this.scene.add(this.est);

    // kleiner Griff "Beenden | Blau" unten im Blickfeld (Brille)
    this.hc = document.createElement('canvas'); this.hc.width = 640; this.hc.height = 150;
    this.htex = new THREE.CanvasTexture(this.hc); this.htex.colorSpace = THREE.SRGBColorSpace;
    this.handle = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42 * 150 / 640),
      new THREE.MeshBasicMaterial({ map: this.htex, transparent: true, depthTest: false }));
    this.handle.renderOrder = 30; this.handle.visible = false;
    this.scene.add(this.handle);
    this.hover = null;

    this.ctrls = [0, 1].map((i) => {
      const c = this.renderer.xr.getController(i);
      c.addEventListener('connected', (e) => { c.userData.mode = e.data.targetRayMode; });
      c.addEventListener('select', () => this._press(c));
      this.scene.add(c);
      return c;
    });
    this.raycaster = new THREE.Raycaster();
    this._drawHandle();
    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);
    this.resize();
    this.renderer.setAnimationLoop((t, f) => this._frame(t, f));
  }

  resize() {
    const w = this.container.clientWidth || innerWidth, h = this.container.clientHeight || innerHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w, h, false);
  }

  async start(overlay) {
    const fmts = ['float32', 'luminance-alpha', 'unsigned-short'];
    const init = {
      optionalFeatures: ['local-floor', 'depth-sensing', 'hand-tracking'],
      depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: fmts, formatPreference: fmts },
    };
    if (overlay) { init.optionalFeatures.push('dom-overlay'); init.domOverlay = { root: overlay }; }
    const s = await navigator.xr.requestSession('immersive-ar', init);
    try { await this.renderer.xr.setSession(s); }
    catch { this.renderer.xr.setReferenceSpaceType('local'); await this.renderer.xr.setSession(s); this.floorY = -1.55; }
    this.session = s;
    this.phone = !!s.domOverlayState;
    this.depth = !!s.enabledFeatures?.includes?.('depth-sensing');
    this.legs.setBase(this.floorY);
    s.addEventListener('end', () => { this.session = null; this.onEnd?.(); });
    this._needPlace = true;
    return s;
  }

  end() { this.session?.end(); }

  get status() {
    return this.depthOk ? 'Beine per Tiefensensor erkannt' : this.depth ? 'Warte auf Tiefensensor …' : 'Kein Tiefensensor – Beine geschätzt';
  }

  toggleBlue() {
    this.strength = this.strength > 0.5 ? 0.45 : this.strength > 0.2 ? 0 : 1;
    this.legs.setStrength(this.strength);
    this.est.children.forEach((m) => { m.material.opacity = 0.4 * this.strength; });
    this._drawHandle();
  }

  _press(c) {
    if (this.phone) return;
    const m = new THREE.Matrix4().extractRotation(c.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(m);
    const h = this.raycaster.intersectObject(this.handle, false)[0];
    if (!h) return;
    if (h.uv.x < 0.5) this.end(); else this.toggleBlue();
  }

  _drawHandle() {
    const ctx = this.hc.getContext('2d'), W = 640, H = 150;
    ctx.clearRect(0, 0, W, H);
    ctx.font = '500 22px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(22,19,31,0.8)';
    const t = this.status, tw = ctx.measureText(t).width + 30;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect((W - tw) / 2, 2, tw, 36, 18) : ctx.rect((W - tw) / 2, 2, tw, 36); ctx.fill();
    ctx.fillStyle = '#f1edf9'; ctx.fillText(t, W / 2, 20);
    const lbl = this.strength > 0.5 ? 'Blau: stark' : this.strength > 0.2 ? 'Blau: leicht' : 'Blau: aus';
    [['exit', 'close', 'Beenden', 0], ['blue', 'pan_tool', lbl, W / 2]].forEach(([id, ic, label, x0]) => {
      const on = this.hover === id;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0 + 6, 46, W / 2 - 12, 98, 49) : ctx.rect(x0 + 6, 46, W / 2 - 12, 98);
      ctx.fillStyle = on ? 'rgba(182,156,255,0.92)' : 'rgba(22,19,31,0.85)'; ctx.fill();
      ctx.save(); ctx.translate(x0 + 40, 74); ctx.scale(42 / 24, 42 / 24); ctx.fillStyle = on ? '#1f1638' : '#f1edf9';
      ctx.fill(new Path2D(ICON_PATHS[ic])); ctx.restore();
      ctx.font = '600 28px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = on ? '#1f1638' : '#f1edf9';
      ctx.fillText(label, x0 + 96, 96);
    });
    this.htex.needsUpdate = true;
  }

  // Griff folgt dem Blick lazy, unten im Sichtfeld
  _placeHandle(force) {
    const cam = this.renderer.xr.getCamera();
    const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld));
    dir.y = 0; if (dir.lengthSq() < 1e-4) return; dir.normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    if (!force && this._yaw !== undefined) {
      const d = Math.atan2(Math.sin(yaw - this._yaw), Math.cos(yaw - this._yaw));
      if (Math.abs(d) < 0.7) return;
      this._yaw += d * 0.08;
    } else this._yaw = yaw;
    const f = new THREE.Vector3(Math.sin(this._yaw), 0, Math.cos(this._yaw));
    this.handle.position.copy(pos).addScaledVector(f, 0.8);
    this.handle.position.y = pos.y - 0.38;
    this.handle.lookAt(pos);
  }

  _frame(t, frame) {
    if (!this.renderer.xr.isPresenting) { this.renderer.render(this.scene, this.camera); return; }
    const xr = this.renderer.xr, cam = xr.getCamera();
    const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    if (this._needPlace && frame) { this._needPlace = false; this._placeHandle(true); }
    if (!this.phone) { this.handle.visible = true; this._placeHandle(false); }

    // Tiefensensor: nur Bildpunkte, die zu deinen Beinen/Fuessen gehoeren
    const was = this.depthOk;
    this.legs.update(frame, t, this._handPoints(frame));
    this.depthOk = this.legs.ok;
    // sonst: geschaetzte Beine unter dem Kopf, mit dem Blick (weich) gedreht
    this.est.visible = !this.depthOk && this.strength > 0;
    if (this.est.visible) {
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); dir.y = 0;
      const yaw = dir.lengthSq() > 1e-4 ? Math.atan2(-dir.x, -dir.z) : 0;
      this._estYaw = this._estYaw === undefined ? yaw : this._estYaw + Math.atan2(Math.sin(yaw - this._estYaw), Math.cos(yaw - this._estYaw)) * 0.1;
      this.est.position.set(head.x, this.floorY, head.z);
      this.est.rotation.set(0, this._estYaw, 0);
      const legLen = Math.max(0.3, head.y - this.floorY - 0.75);
      this.est.children.forEach((m) => { if (m.userData.leg) { m.scale.y = legLen / 0.9; m.position.y = legLen / 2; } });
    }
    if (was !== this.depthOk) this._drawHandle();

    // Hover auf dem Griff
    let hov = null;
    for (const c of this.ctrls) {
      if (!c.userData.mode || this.phone) continue;
      const m = new THREE.Matrix4().extractRotation(c.matrixWorld);
      this.raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
      this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(m);
      const h = this.raycaster.intersectObject(this.handle, false)[0];
      if (h) hov = h.uv.x < 0.5 ? 'exit' : 'blue';
    }
    if (hov !== this.hover) { this.hover = hov; this._drawHandle(); }
    this.renderer.render(this.scene, this.camera);
  }

  // Haende/Controller als Kugeln, die nie eingefaerbt werden
  _handPoints(frame) {
    const out = [], ref = this.renderer.xr.getReferenceSpace();
    if (!frame || !ref) return out;
    for (const src of frame.session.inputSources) {
      if (src.hand) {
        for (const [name, r] of JOINTS) {
          const j = src.hand.get(name), p = j && frame.getJointPose?.(j, ref);
          if (p) out.push({ pos: p.transform.position, r });
        }
      } else if (src.gripSpace) {
        const p = frame.getPose(src.gripSpace, ref);
        if (p) out.push({ pos: p.transform.position, r: 0.13 });
      }
    }
    return out.slice(0, 10);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    removeEventListener('resize', this._onResize);
    this.legs.dispose(this.scene); this.htex.dispose();
    this.renderer.dispose(); this.renderer.domElement.remove();
  }
}

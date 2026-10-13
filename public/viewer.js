// 360°-Viewer: Video als Textur innen auf einer Kugel, Blick per Ziehen,
// Bewegungssensor (Handy) oder WebXR (VR-Brille).
import * as THREE from 'three';
import { VRButton } from '/vendor/VRButton.js';

export class Viewer {
  constructor(container, video) {
    this.container = container;
    this.video = video;
    this.lon = 0; this.lat = 0; this.fov = 75;
    this.gyro = false; this.gyroOffset = 0;
    this.orient = null; this.screenAngle = 0;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.1, 1100);
    this.camera.rotation.order = 'YXZ';

    const geo = new THREE.SphereGeometry(500, 96, 64);
    geo.scale(-1, 1, 1); // von innen sichtbar
    this.texture = new THREE.VideoTexture(video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.texture }));
    this.scene.add(this.mesh);

    this._bindInput();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  vrButton() {
    const b = VRButton.createButton(this.renderer, { optionalFeatures: ['local-floor'] });
    // Optik an die App anpassen, Funktion bleibt die von three.js
    b.removeAttribute('style');
    b.className = 'vr-btn glass';
    return b;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  recenter() {
    this.lat = 0;
    if (this.gyro && this.orient) this.gyroOffset = -this._gyroYawDeg();
    else this.lon = 0;
  }

  async setGyro(on) {
    if (on) {
      const DO = window.DeviceOrientationEvent;
      if (DO && typeof DO.requestPermission === 'function') {
        const p = await DO.requestPermission().catch(() => 'denied');
        if (p !== 'granted') return false;
      }
      if (!DO) return false;
      this._onOrient = (e) => { if (e.alpha !== null) this.orient = e; };
      this._onScreen = () => { this.screenAngle = (screen.orientation?.angle ?? window.orientation ?? 0); };
      this._onScreen();
      window.addEventListener('deviceorientation', this._onOrient);
      window.addEventListener('orientationchange', this._onScreen);
      screen.orientation?.addEventListener?.('change', this._onScreen);
      this.gyro = true;
      setTimeout(() => this.recenter(), 300);
      return true;
    }
    window.removeEventListener('deviceorientation', this._onOrient);
    window.removeEventListener('orientationchange', this._onScreen);
    screen.orientation?.removeEventListener?.('change', this._onScreen);
    this.gyro = false; this.orient = null;
    return false;
  }

  _gyroYawDeg() {
    // grober Yaw-Wert nur fuers Ausrichten
    return (this.orient?.alpha || 0);
  }

  _bindInput() {
    const el = this.renderer.domElement;
    const pts = new Map();
    let last = null, pinch = null;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      last = { x: e.clientX, y: e.clientY };
      this.onInteract?.();
    });
    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this._zoom((pinch - d) * 0.15);
        pinch = d; return;
      }
      if (!last) return;
      const k = this.fov / (el.clientHeight || 600);
      const dx = (e.clientX - last.x) * k, dy = (e.clientY - last.y) * k;
      if (this.gyro) this.gyroOffset += dx; else this.lon += dx;
      this.lat = Math.max(-85, Math.min(85, this.lat + dy));
      last = { x: e.clientX, y: e.clientY };
    });
    const up = (e) => { pts.delete(e.pointerId); pinch = null; last = pts.size ? [...pts.values()][0] : null; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => { e.preventDefault(); this._zoom(e.deltaY * 0.05); }, { passive: false });
  }

  _zoom(d) {
    this.fov = Math.max(35, Math.min(100, this.fov + d));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  _frame() {
    if (this.renderer.xr.isPresenting) {
      // In VR steuert die Brille die Kamera
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.gyro && this.orient) {
      const deg = THREE.MathUtils.degToRad;
      const euler = new THREE.Euler(deg(this.orient.beta), deg(this.orient.alpha + this.gyroOffset), -deg(this.orient.gamma), 'YXZ');
      const q = new THREE.Quaternion().setFromEuler(euler);
      q.multiply(new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5))); // Kamera schaut nach hinten aus dem Geraet
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -deg(this.screenAngle)));
      // Zusatz-Neigung per Finger
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg(this.lat)));
      this.camera.quaternion.copy(q);
    } else {
      this.camera.rotation.set(THREE.MathUtils.degToRad(this.lat), THREE.MathUtils.degToRad(this.lon), 0, 'YXZ');
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.setGyro(false);
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

// 360°-Viewer: Video als Textur innen auf einer Kugel, Blick per Ziehen,
// Bewegungssensor (Handy) oder WebXR (VR-Brille).
import * as THREE from 'three';
import { VRButton } from '/vendor/VRButton.js';
import { VRMenu } from '/vr-menu.js';

export class Viewer {
  constructor(container, video, { title = '' } = {}) {
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

    this.texture = new THREE.VideoTexture(video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture });
    // Alle Video-Kugeln haengen an einer Gruppe, damit "Ausrichten" alle dreht
    this.mesh = new THREE.Group();
    this.scene.add(this.mesh);
    this._setLayout('mono');
    // 3D-360°-Videos erkennen: 1:1 = uebereinander (oben links), 4:1 = nebeneinander
    this._onMeta = () => {
      const r = video.videoWidth / video.videoHeight;
      this._setLayout(Math.abs(r - 1) < 0.08 ? 'tb' : r > 3 ? 'lr' : 'mono');
    };
    video.addEventListener('loadedmetadata', this._onMeta);

    // Steuer-Menue in der VR-Brille
    this.vrMenu = new VRMenu({
      renderer: this.renderer, scene: this.scene, video, title,
      onRecenter: () => this._recenterXR(),
    });
    this.renderer.xr.addEventListener('sessionend', () => { this.mesh.rotation.y = 0; });

    this._bindInput();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  // Pro Auge eine Kugel mit passendem Bildausschnitt. Ebene 1 = linkes Auge (auch fuer
  // die normale Ansicht), Ebene 2 = rechtes Auge; three.js ordnet sie in VR automatisch zu.
  _setLayout(layout) {
    if (this.layout === layout) return;
    this.layout = layout;
    for (const m of [...this.mesh.children]) { m.geometry.dispose(); this.mesh.remove(m); }
    const eye = (u0, v0, su, sv, layer) => {
      const geo = new THREE.SphereGeometry(500, 96, 64);
      geo.scale(-1, 1, 1); // von innen sichtbar
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * su, v0 + uv.getY(i) * sv);
      const m = new THREE.Mesh(geo, this.material);
      m.layers.set(layer);
      this.mesh.add(m);
    };
    if (layout === 'tb') { eye(0, 0.5, 1, 0.5, 1); eye(0, 0, 1, 0.5, 2); }
    else if (layout === 'lr') { eye(0, 0, 0.5, 1, 1); eye(0.5, 0, 0.5, 1, 2); }
    else { eye(0, 0, 1, 1, 0); }
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

  // In VR: Videomitte dorthin drehen, wo man gerade hinschaut
  _recenterXR() {
    const cam = this.renderer.xr.getCamera();
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld));
    this.mesh.rotation.y = Math.atan2(-dir.x, -dir.z);
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
      // three.js gibt dem linken Auge Ebene 1, dem rechten Ebene 2 – die normale Kamera
      // darf Ebene 1 hier nicht haben, sonst saehe das rechte Auge beide Bilder
      this.camera.layers.disable(1);
      this.vrMenu.update();
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.camera.layers.enable(1); // 3D-Videos: ausserhalb von VR das linke Auge zeigen
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
    this.vrMenu.dispose();
    window.removeEventListener('resize', this._onResize);
    this.texture.dispose();
    this.video.removeEventListener('loadedmetadata', this._onMeta);
    for (const m of this.mesh.children) m.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

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

    // alpha: true, damit ausgestanzte (gruene) Stellen durchsichtig sind –
    // dahinter liegt dann der Raum (AR-Durchsicht) oder das Kamerabild vom Handy
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.1, 1100);
    this.camera.rotation.order = 'YXZ';

    this.texture = new THREE.VideoTexture(video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true });
    this._initChroma();
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
      chroma: { get: () => this.chromaState().on, toggle: () => this.setChroma({ on: !this.chromaState().on }) },
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
      m.rotation.y = -Math.PI / 2; // Bildmitte des Videos liegt vorne (Blickrichtung beim Start)
      m.layers.set(layer);
      this.mesh.add(m);
    };
    if (layout === 'tb') { eye(0, 0.5, 1, 0.5, 1); eye(0, 0, 1, 0.5, 2); }
    else if (layout === 'lr') { eye(0, 0, 0.5, 1, 1); eye(0.5, 0, 0.5, 1, 2); }
    else { eye(0, 0, 1, 1, 0); }
  }

  // Greenscreen: Pixel nahe an der Schluesselfarbe werden durchsichtig.
  // Vergleich im CbCr-Farbraum (Helligkeit egal -> Schatten auf dem Gruen gehen mit weg),
  // weiche Kante per smoothstep, Gruenstich an den Raendern wird entsaettigt.
  _initChroma() {
    this.chroma = {
      on: { value: 0 },
      key: { value: new THREE.Color(0x00ff00) },   // sRGB-Werte, nicht linear
      sim: { value: 0.18 },
      smooth: { value: 0.08 },
      spill: { value: 0.5 },
    };
    const u = this.chroma;
    this.material.customProgramCacheKey = () => 'anja-chroma';
    this.material.onBeforeCompile = (sh) => {
      sh.uniforms.uKeyOn = u.on; sh.uniforms.uKey = u.key;
      sh.uniforms.uKeySim = u.sim; sh.uniforms.uKeySmooth = u.smooth; sh.uniforms.uKeySpill = u.spill;
      sh.fragmentShader = `uniform float uKeyOn; uniform vec3 uKey; uniform float uKeySim, uKeySmooth, uKeySpill;
vec2 anjaCbCr(vec3 c) { float y = dot(c, vec3(0.299, 0.587, 0.114)); return vec2((c.b - y) * 0.565, (c.r - y) * 0.713); }
` + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
if (uKeyOn > 0.5) {
  vec3 srgb = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));
  float d = distance(anjaCbCr(srgb), anjaCbCr(uKey));
  float a = smoothstep(uKeySim, uKeySim + uKeySmooth, d);
  diffuseColor.a *= a;
  float sp = pow(1.0 - smoothstep(uKeySim, uKeySim + uKeySmooth + uKeySpill * 0.4, d), 1.5) * uKeySpill;
  float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l), clamp(sp, 0.0, 1.0));
}`);
    };
  }

  // { on, color: '#00ff00', sim, smooth, spill }
  setChroma(opts) {
    const u = this.chroma;
    if ('on' in opts) u.on.value = opts.on ? 1 : 0;
    if (opts.color) u.key.value.setStyle(opts.color, THREE.NoColorSpace);
    if ('sim' in opts) u.sim.value = opts.sim;
    if ('smooth' in opts) u.smooth.value = opts.smooth;
    if ('spill' in opts) u.spill.value = opts.spill;
    this.onChroma?.(this.chromaState());
  }

  chromaState() {
    const u = this.chroma;
    return { on: u.on.value > 0.5, color: '#' + u.key.value.getHexString(THREE.NoColorSpace),
      sim: u.sim.value, smooth: u.smooth.value, spill: u.spill.value };
  }

  // Pipette: Farbe des Videos an einer Bildschirmstelle (Mittelwert 5×5 Pixel)
  pickColor(clientX, clientY) {
    const v = this.video;
    if (!v.videoWidth) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.layers.enableAll();
    rc.setFromCamera(ndc, this.camera);
    const hit = rc.intersectObjects(this.mesh.children.filter((m) => m.layers.mask & 3), false)[0];
    if (!hit?.uv) return null;
    const c = this._pickCanvas || (this._pickCanvas = document.createElement('canvas'));
    c.width = 5; c.height = 5;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const x = hit.uv.x * v.videoWidth, y = (1 - hit.uv.y) * v.videoHeight;
    try {
      ctx.drawImage(v, x - 2.5, y - 2.5, 5, 5, 0, 0, 5, 5);
      const d = ctx.getImageData(0, 0, 5, 5).data;
      let R = 0, G = 0, B = 0;
      for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
      const hex = (n) => Math.round(n / 25).toString(16).padStart(2, '0');
      return `#${hex(R)}${hex(G)}${hex(B)}`;
    } catch { return null; }
  }

  // Durchsicht: WebXR-AR (Quest-Passthrough, Android-Handy mit Kamera)
  async startAR() {
    const session = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: ['local-floor', 'hand-tracking'],
    });
    if (!this.chromaState().on) this.setChroma({ on: true });
    await this.renderer.xr.setSession(session);
    return session;
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

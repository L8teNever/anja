// 360°-Viewer: Video innen auf einer Kugel, alle gaengigen 360°/180°/3D-Formate, Blick per Ziehen,
// Bewegungssensor (Handy) oder WebXR (VR-Brille).
import * as THREE from 'three';
import { VRButton } from '/vendor/VRButton.js';
import { VRMenu } from '/vr-menu.js';
import { DEFAULT_FORMAT, CHROMA_DEFAULT, normalize, params, dirToUV, fromSize } from '/projection.js';


const VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Gleiche Rechnung wie dirToUV() in projection.js
const FRAG = `
uniform sampler2D map;
uniform int uProj, uStereo;
uniform vec2 uRange, uGrid, uTexSize;
uniform int uFacePos[6];
uniform int uFaceRot[6];
uniform float uSwap, uWrap, uEye;
uniform float uKeyOn, uKeyMask; uniform vec3 uKey;
uniform float uKeyHue, uKeySat, uKeySoft, uKeyChoke, uKeySpill, uKeyLumMin, uKeyLumMax;
varying vec3 vDir;
const float PI = 3.141592653589793;

vec2 anjaCbCr(vec3 c) { float y = dot(c, vec3(0.299, 0.587, 0.114)); return vec2((c.b - y) * 0.565, (c.r - y) * 0.713); }

bool toUV(vec3 d, out vec2 uv) {
  vec3 n = normalize(vec3(d.x, -d.y, -d.z));   // wie ffmpeg: x rechts, y unten, z vorne
  float x = n.x, y = n.y, z = n.z;
  float u, w;
  if (uProj == 0) {            // equirektangular (360/180)
    u = 0.5 * (atan(x, z) / uRange.x) + 0.5;
    w = 0.5 * (asin(clamp(y, -1.0, 1.0)) / uRange.y) + 0.5;
    if (uWrap > 0.5) u = fract(u);
    if (u < 0.0 || u > 1.0 || w < 0.0 || w > 1.0) return false;
  } else if (uProj == 1) {     // Leinwand
    if (z <= 1e-6) return false;
    u = 0.5 * ((x / z) / uRange.x) + 0.5;
    w = 0.5 * ((y / z) / uRange.y) + 0.5;
    if (u < 0.0 || u > 1.0 || w < 0.0 || w > 1.0) return false;
  } else if (uProj == 2) {     // Fischauge
    float h = length(vec2(x, y)); float lh = h > 0.0 ? h : 1.0;
    float phi = atan(h, z) / PI;
    float uf = (x / lh) * phi / uRange.x, vf = (y / lh) * phi / uRange.y;
    if (abs(uf) >= 0.5 || abs(vf) >= 0.5) return false;
    u = uf + 0.5; w = vf + 0.5;
  } else if (uProj == 3) {     // Doppel-Fischauge
    float h = length(vec2(x, y)); float lh = h > 0.0 ? h : 1.0;
    float t = acos(min(1.0, abs(z))) / PI;
    float uh = clamp(0.5 * (t * (x / lh) / uRange.x) + 0.5, 0.0, 1.0);
    w = clamp(0.5 * (t * (y / lh) / uRange.y) + 0.5, 0.0, 1.0);
    u = z >= 0.0 ? 0.5 + 0.5 * uh : 0.5 * (1.0 - uh);
  } else {                     // Wuerfel / EAC
    float phi = atan(x, z), theta = asin(clamp(y, -1.0, 1.0));
    float Q = PI / 4.0, H = PI / 2.0, pn;
    int dir;
    if (phi >= -Q && phi < Q) { dir = 4; pn = phi; }
    else if (phi >= -(H + Q) && phi < -Q) { dir = 1; pn = phi + H; }
    else if (phi >= Q && phi < H + Q) { dir = 0; pn = phi - H; }
    else { dir = 5; pn = phi + (phi > 0.0 ? -PI : PI); }
    float th = atan(cos(pn));
    if (theta > th) dir = 3; else if (theta < -th) dir = 2;
    float uf, vf;
    if (dir == 0) { uf = -z / x; vf = y / x; }
    else if (dir == 1) { uf = -z / x; vf = -y / x; }
    else if (dir == 2) { uf = -x / y; vf = -z / y; }
    else if (dir == 3) { uf = x / y; vf = -z / y; }
    else if (dir == 4) { uf = x / z; vf = y / z; }
    else { uf = x / z; vf = -y / z; }
    int pos = uFacePos[dir];
    int r = uFaceRot[pos];
    float t;
    if (r == 1) { t = uf; uf = -vf; vf = t; }
    else if (r == 2) { uf = -uf; vf = -vf; }
    else if (r == 3) { t = uf; uf = vf; vf = -t; }
    float cols = uGrid.x, rows = uGrid.y;
    float col = mod(float(pos), cols), row = floor(float(pos) / cols);
    if (uProj == 5) {
      uf = (2.0 / PI) * atan(uf) + 0.5; vf = (2.0 / PI) * atan(vf) + 0.5;
      vec2 pad = 2.0 / uTexSize;
      u = ((uf + col) * (1.0 - 2.0 * pad.x)) / 3.0 + pad.x;
      w = vf * (0.5 - 2.0 * pad.y) + pad.y + 0.5 * row;
    } else {
      u = (col + 0.5 * uf + 0.5) / cols;
      w = (row + 0.5 * vf + 0.5) / rows;
    }
  }
  float e = uSwap > 0.5 ? 1.0 - uEye : uEye;
  if (uStereo == 1) w = 0.5 * w + 0.5 * e;
  else if (uStereo == 2) u = 0.5 * u + 0.5 * e;
  uv = vec2(u, 1.0 - w);
  return true;
}

// Greenscreen: wie stark gehoert ein Pixel zum Hintergrund? (0 = Vordergrund, 1 = weg)
// Gemessen am Farbton (Winkel in der CbCr-Ebene), an der Saettigung (Farbstaerke) und an
// der Helligkeit – so klappt auch blasses/helles Gruen, waehrend
// Haut, Weiss und Grau sicher stehen bleiben.
// three.js liefert Video-Texturen als sRGB (nicht linear) -> hier selbst umrechnen
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }

float keyness(vec3 srgb) {
  vec2 c = anjaCbCr(srgb), k = anjaCbCr(uKey);
  float kl = max(length(k), 0.02), cl = length(c);
  float ang = cl > 1e-4 ? acos(clamp(dot(c / cl, k / kl), -1.0, 1.0)) : PI;
  float hue = 1.0 - smoothstep(uKeyHue, uKeyHue + 0.05 + uKeySoft * 1.2, ang);
  float sat = smoothstep(uKeySat, uKeySat + 0.004 + uKeySoft * 0.12, cl);
  float y = dot(srgb, vec3(0.299, 0.587, 0.114));
  float lum = smoothstep(uKeyLumMin - 0.04, uKeyLumMin, y) * (1.0 - smoothstep(uKeyLumMax, uKeyLumMax + 0.04, y));
  return hue * sat * lum;
}

void main() {
  vec2 uv;
  if (!toUV(vDir, uv)) { gl_FragColor = vec4(0.0); return; }
  vec4 c = texture2D(map, uv);
  if (uKeyOn > 0.5) {
    float a = 1.0 - keyness(c.rgb);
    // Kante schrumpfen: auch die Nachbarn duerfen den Pixel "wegnehmen"
    if (uKeyChoke > 0.0) {
      vec2 o = uKeyChoke / uTexSize;
      a = min(a, 1.0 - keyness(texture2D(map, uv + vec2(o.x, 0.0)).rgb));
      a = min(a, 1.0 - keyness(texture2D(map, uv - vec2(o.x, 0.0)).rgb));
      a = min(a, 1.0 - keyness(texture2D(map, uv + vec2(0.0, o.y)).rgb));
      a = min(a, 1.0 - keyness(texture2D(map, uv - vec2(0.0, o.y)).rgb));
    }
    // Gruenstich: den Farbanteil in Richtung Schluesselfarbe herausnehmen (Helligkeit bleibt)
    vec3 srgb = c.rgb;
    vec2 cc = anjaCbCr(srgb), kd = normalize(anjaCbCr(uKey) + vec2(1e-5));
    float y = dot(srgb, vec3(0.299, 0.587, 0.114));
    float along = max(0.0, dot(cc, kd));
    cc -= kd * along * uKeySpill;
    vec3 fixedC = vec3(y + cc.y / 0.713, 0.0, y + cc.x / 0.565);
    fixedC.g = (y - 0.299 * fixedC.r - 0.114 * fixedC.b) / 0.587;
    c.rgb = clamp(fixedC, 0.0, 1.0);
    c.a *= a;
    if (uKeyMask > 0.5) c = vec4(vec3(a), 1.0);
  }
  c.rgb = srgbToLinear(c.rgb);
  gl_FragColor = c;
  #include <colorspace_fragment>
}`;

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
    this._initMaterial();
    // Alle Video-Kugeln haengen an einer Gruppe, damit "Ausrichten" alle dreht
    this.mesh = new THREE.Group();
    this.scene.add(this.mesh);
    this._geo = new THREE.SphereGeometry(500, 128, 64);
    this.format = normalize(DEFAULT_FORMAT);
    this.formatSource = 'Standard';
    this.setFormat(this.format, this.formatSource);
    // Sobald die Bildgroesse bekannt ist: erste Vermutung (wird spaeter durch Dateiname,
    // Metadaten oder Bildanalyse ersetzt – siehe app.js)
    this._onMeta = () => {
      this.u.uTexSize.value.set(video.videoWidth, video.videoHeight);
      if (this.formatSource === 'Standard') this.setFormat(fromSize(video.videoWidth, video.videoHeight), 'Seitenverhältnis');
      else this.setFormat(this.format, this.formatSource); // Leinwand braucht das Seitenverhaeltnis
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

  // Ein Shader fuer alle Formate: aus der Blickrichtung wird berechnet, welcher Bildpunkt
  // des Videos dorthin gehoert (Formeln wie ffmpeg v360, siehe projection.js).
  // Danach Greenscreen: Pixel nahe der Schluesselfarbe werden durchsichtig (Vergleich im
  // CbCr-Farbraum, weiche Kante, Gruenstich an den Raendern wird entsaettigt).
  _initMaterial() {
    this.u = {
      map: { value: this.texture },
      uProj: { value: 0 }, uRange: { value: new THREE.Vector2(Math.PI, Math.PI / 2) },
      uGrid: { value: new THREE.Vector2(1, 1) },
      uFacePos: { value: [0, 1, 2, 3, 4, 5] }, uFaceRot: { value: [0, 0, 0, 0, 0, 0] },
      uStereo: { value: 0 }, uSwap: { value: 0 }, uWrap: { value: 1 },
      uTexSize: { value: new THREE.Vector2(4096, 2048) },
      uKeyOn: { value: 0 }, uKeyMask: { value: 0 }, uKey: { value: new THREE.Color(0x00ff00) },   // sRGB-Werte, nicht linear
      uKeyHue: { value: 0 }, uKeySat: { value: 0 }, uKeySoft: { value: 0 }, uKeyChoke: { value: 0 },
      uKeySpill: { value: 0 }, uKeyLumMin: { value: 0 }, uKeyLumMax: { value: 1 },
    };
    this._chroma = { ...CHROMA_DEFAULT };
    this.setChroma({}, true);
  }

  _makeMaterial(eye) {
    return new THREE.ShaderMaterial({
      uniforms: { ...this.u, uEye: { value: eye } },
      vertexShader: VERT, fragmentShader: FRAG,
      side: THREE.BackSide, transparent: true, depthWrite: false,
    });
  }

  // 2D: eine Kugel. 3D: pro Auge eine Kugel – Ebene 1 = linkes Auge (auch fuer die normale
  // Ansicht), Ebene 2 = rechtes Auge; three.js ordnet sie in VR automatisch zu.
  _buildMeshes(stereo) {
    if (this._stereoBuilt === stereo) return;
    this._stereoBuilt = stereo;
    for (const m of [...this.mesh.children]) { m.material.dispose(); this.mesh.remove(m); }
    const add = (eye, layer) => {
      const m = new THREE.Mesh(this._geo, this._makeMaterial(eye));
      m.layers.set(layer);
      this.mesh.add(m);
    };
    if (stereo) { add(0, 1); add(1, 2); } else add(0, 0);
  }

  // f: { kind, fov, stereo, swap } – siehe projection.js
  setFormat(f, source = 'Manuell') {
    this.format = normalize(f);
    this.formatSource = source;
    const v = this.video;
    const p = params(this.format, v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9);
    this._params = p;
    const u = this.u;
    u.uProj.value = p.proj; u.uRange.value.set(p.range[0], p.range[1]); u.uGrid.value.set(p.grid[0], p.grid[1]);
    u.uFacePos.value = p.facePos; u.uFaceRot.value = p.faceRot;
    u.uStereo.value = p.stereo; u.uSwap.value = p.swap; u.uWrap.value = p.wrap;
    this._buildMeshes(p.stereo !== 0);
    this.onFormat?.(this.format, source);
  }

  // { on, color, hue (Grad), sat, soft, choke (Pixel), spill, lumMin, lumMax, mask }
  setChroma(opts, silent = false) {
    const ch = this._chroma;
    for (const k of Object.keys(CHROMA_DEFAULT)) if (opts[k] !== undefined) ch[k] = k === 'on' || k === 'mask' ? !!opts[k] : k === 'color' ? opts[k] : Number(opts[k]);
    const u = this.u;
    u.uKeyOn.value = ch.on ? 1 : 0; u.uKeyMask.value = ch.mask ? 1 : 0;
    u.uKey.value.setStyle(ch.color, THREE.NoColorSpace);
    u.uKeyHue.value = (ch.hue * Math.PI) / 180; u.uKeySat.value = ch.sat; u.uKeySoft.value = ch.soft;
    u.uKeyChoke.value = ch.choke; u.uKeySpill.value = ch.spill; u.uKeyLumMin.value = ch.lumMin; u.uKeyLumMax.value = ch.lumMax;
    if (!silent) this.onChroma?.(this.chromaState());
  }

  chromaState() { return { ...this._chroma }; }

  // Pipette: Farbe des Videos an einer Bildschirmstelle (Mittelwert 5×5 Pixel)
  pickColor(clientX, clientY) {
    const v = this.video;
    if (!v.videoWidth) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const dir = rc.ray.direction.clone().applyQuaternion(this.mesh.quaternion.clone().invert());
    const uv = dirToUV(this._params, dir, 0, v.videoWidth, v.videoHeight);
    if (!uv) return null;
    const c = this._pickCanvas || (this._pickCanvas = document.createElement('canvas'));
    c.width = 5; c.height = 5;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const x = uv.u * v.videoWidth, y = uv.v * v.videoHeight;
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
  // overlay: HTML-Element mit Knoepfen, das am Handy ueber dem Kamerabild liegt (DOM-Overlay)
  async startAR(overlay) {
    const init = { optionalFeatures: ['local-floor', 'hand-tracking'] };
    if (overlay) { init.optionalFeatures.push('dom-overlay'); init.domOverlay = { root: overlay }; }
    const session = await navigator.xr.requestSession('immersive-ar', init);
    if (!this.chromaState().on) this.setChroma({ on: true });
    await this.renderer.xr.setSession(session);
    // Handy: Bildschirm-Knoepfe statt 3D-Menue
    if (session.domOverlayState) {
      this.vrMenu.disabled = true;
      session.addEventListener('end', () => { this.vrMenu.disabled = false; });
    }
    return session;
  }

  endXR() { this.renderer.xr.getSession()?.end(); }

  get inXR() { return this.renderer.xr.isPresenting; }

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
    for (const m of this.mesh.children) m.material.dispose();
    this._geo.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

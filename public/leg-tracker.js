// Bein-Erkennung ueber den Tiefensensor (WebXR depth-sensing, gpu-optimized, z. B. Quest 3).
// Fuer jeden Bildpunkt: Tiefe -> echte Raumposition (mit den Angaben des Sensors je Auge:
// Nah/Fern bzw. Meter-Faktor, Ausrichtung des Tiefenbilds zur Ansicht). Ein Punkt gehoert zu
// deinen Beinen/Fuessen, wenn er
//   - deutlich ueber dem Boden liegt (Boden wird live aus der Tiefe um dich herum gemessen),
//   - unterhalb deiner Huefte liegt,
//   - in einem schmalen Bereich unter deinem Koerper liegt (nach vorne laenger fuer sitzende Beine),
//   - nicht an deinen Haenden/Controllern ist.
// Das Ergebnis ist eine Maske, die man einfaerben kann (heute blau, spaeter Kleidung).
import * as THREE from 'three';

const COMMON = `
uniform sampler2DArray depthColor;
uniform vec2 vpSize;                 // Pixelgroesse eines Auges
uniform mat4 normDepth[2];           // Tiefenbild <- Ansicht (normiert)
uniform vec4 proj[2];                // P0, P5, P8, P9 der Ansicht
uniform mat4 viewW[2];               // Ansicht -> Welt
uniform vec3 depthNF[2];             // nah, fern (<=0: unendlich), Modus (0 = NDC-Tiefe, 1 = Meter)
uniform float rawToM;

// Weltposition des Bildpunkts uv (0..1, links unten) im Auge e; w = 0 wenn keine Tiefe
vec4 worldAt(vec2 uv, int e) {
  vec2 du = (normDepth[e] * vec4(uv.x, 1.0 - uv.y, 0.0, 1.0)).xy;
  du.y = 1.0 - du.y;
  if (du.x < 0.0 || du.x > 1.0 || du.y < 0.0 || du.y > 1.0) return vec4(0.0);
  float d = texture(depthColor, vec3(du, float(e))).r;
  vec3 nf = depthNF[e];
  float z;
  if (nf.z > 0.5) z = d * rawToM;
  else {
    if (d <= 0.0 || d >= 0.99999) return vec4(0.0);
    z = nf.y <= 0.0 ? nf.x / (1.0 - d) : nf.x * nf.y / (nf.y - d * (nf.y - nf.x));
  }
  if (z <= 0.05 || z > 8.0) return vec4(0.0);
  vec2 n = uv * 2.0 - 1.0;
  vec4 p = proj[e];
  vec3 v = vec3((n.x + p.z) * z / p.x, (n.y + p.w) * z / p.y, -z);
  return vec4((viewW[e] * vec4(v, 1.0)).xyz, 1.0);
}

uniform vec2 bodyXZ;                 // Koerperachse (Boden)
uniform vec2 fwdXZ;                  // Blickrichtung waagrecht
uniform float floorY, hipY;
uniform vec4 hands[10];              // Kugeln um Haende/Controller (xyz, r)

// <1 innerhalb des Beinbereichs (Ellipse: vorne 0.8 m, hinten 0.28 m, seitlich 0.36 m)
float zone(vec3 w) {
  vec2 r = w.xz - bodyXZ;
  float f = dot(r, fwdXZ), s = dot(r, vec2(fwdXZ.y, -fwdXZ.x));
  float a = f > 0.0 ? f / 0.8 : -f / 0.28;
  float b = s / 0.36;
  return sqrt(a * a + b * b);
}
`;

const VERT = `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Maske einfaerben (pro Auge, nebeneinander im Bildpuffer)
const MASK_FRAG = COMMON + `
uniform vec3 color; uniform float strength, time;
void main() {
  int e = gl_FragCoord.x >= vpSize.x ? 1 : 0;
  vec2 uv = vec2(gl_FragCoord.x - float(e) * vpSize.x, gl_FragCoord.y) / vpSize;
  vec4 w = worldAt(uv, e);
  if (w.w < 0.5) discard;
  float h = w.y - floorY;
  if (h < 0.045 || w.y > hipY) discard;
  float zn = zone(w.xyz);
  if (zn > 1.0) discard;
  for (int i = 0; i < 10; i++) if (hands[i].w > 0.0 && distance(w.xyz, hands[i].xyz) < hands[i].w) discard;
  float edge = smoothstep(1.0, 0.85, zn) * smoothstep(0.045, 0.07, h) * smoothstep(hipY, hipY - 0.06, w.y);
  float wave = 0.5 + 0.5 * sin(time * 3.0 + h * 18.0);
  gl_FragColor = vec4(color + 0.12 * wave, (0.5 + 0.15 * wave) * edge * strength);
}`;

// Boden messen: Hoehe aller Punkte im Ring um dich herum (Auge 0), verpackt in RG
const FLOOR_FRAG = COMMON + `
uniform vec2 rtSize;
void main() {
  vec2 uv = gl_FragCoord.xy / rtSize;
  vec4 w = worldAt(uv, 0);
  float zn = w.w > 0.5 ? zone(w.xyz) : 0.0;
  if (w.w < 0.5 || zn < 1.0 || zn > 3.0 || abs(w.y - floorY) > 0.35) { gl_FragColor = vec4(0.0); return; }
  float v = clamp((w.y + 1.0) / 3.0, 0.0, 1.0) * 255.0;
  gl_FragColor = vec4(floor(v) / 255.0, fract(v), 0.0, 1.0);
}`;

export class LegTracker {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.floorY = 0;            // gemessener Boden (startet bei local-floor)
    this.floorBase = 0;
    this.ok = false;
    const u = this.u = {
      depthColor: { value: null }, vpSize: { value: new THREE.Vector2(1, 1) },
      normDepth: { value: [new THREE.Matrix4(), new THREE.Matrix4()] },
      proj: { value: [new THREE.Vector4(1, 1, 0, 0), new THREE.Vector4(1, 1, 0, 0)] },
      viewW: { value: [new THREE.Matrix4(), new THREE.Matrix4()] },
      depthNF: { value: [new THREE.Vector3(0.1, 0, 0), new THREE.Vector3(0.1, 0, 0)] },
      rawToM: { value: 0.001 },
      bodyXZ: { value: new THREE.Vector2() }, fwdXZ: { value: new THREE.Vector2(0, -1) },
      floorY: { value: 0 }, hipY: { value: 0.9 },
      hands: { value: Array.from({ length: 10 }, () => new THREE.Vector4(0, 0, 0, 0)) },
      color: { value: new THREE.Color(0x3d8bff) }, strength: { value: 1 }, time: { value: 0 },
      rtSize: { value: new THREE.Vector2(64, 48) },
    };
    this.mask = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: MASK_FRAG, uniforms: u, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.mask.frustumCulled = false; this.mask.renderOrder = 20; this.mask.visible = false;
    scene.add(this.mask);
    // Boden-Messung: kleiner Zwischenpuffer, alle paar Frames ausgelesen
    this.rt = new THREE.WebGLRenderTarget(64, 48, { depthBuffer: false });
    this.floorScene = new THREE.Scene();
    this.floorQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FLOOR_FRAG, uniforms: u }));
    this.floorQuad.frustumCulled = false;
    this.floorScene.add(this.floorQuad);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.buf = new Uint8Array(64 * 48 * 4);
    this.n = 0;
    this._yaw = null;
  }

  // pro XR-Frame; handPoints: Liste von {pos: Vector3, r} (Haende/Controller)
  update(frame, t, handPoints = []) {
    const r = this.renderer, xr = r.xr, session = xr.getSession();
    const tex = xr.getDepthTexture?.();
    this.ok = false;
    if (!frame || !session || !tex) { this.mask.visible = false; return; }
    const pose = frame.getViewerPose(xr.getReferenceSpace());
    if (!pose) { this.mask.visible = false; return; }
    this.bind = this.bind || new XRWebGLBinding(session, r.getContext());
    const u = this.u;
    let good = 0;
    pose.views.slice(0, 2).forEach((view, e) => {
      let di = null;
      try { di = this.bind.getDepthInformation(view); } catch { di = null; }
      if (!di) return;
      const P = view.projectionMatrix;
      u.proj.value[e].set(P[0], P[5], P[8], P[9]);
      u.viewW.value[e].fromArray(view.transform.matrix);
      u.normDepth.value[e].fromArray(di.normDepthBufferFromNormView?.matrix || new THREE.Matrix4().toArray());
      const hasNF = typeof di.depthNear === 'number' && di.depthNear > 0;
      const far = hasNF && isFinite(di.depthFar) ? di.depthFar : 0;
      u.depthNF.value[e].set(hasNF ? di.depthNear : 0.1, far, hasNF ? 0 : 1);
      u.rawToM.value = di.rawValueToMeters || 0.001;
      good++;
    });
    if (!good) { this.mask.visible = false; return; }
    const cam = xr.getCamera();
    u.depthColor.value = tex;
    u.vpSize.value.set(cam.cameras[0].viewport.z, cam.cameras[0].viewport.w);

    // Koerperachse: unter dem Kopf, etwas hinter dem Blick (beim Runterschauen ist der Kopf vorne)
    const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld));
    const yaw = Math.atan2(look.x, look.z);
    this._yaw = this._yaw === null ? yaw : this._yaw + Math.atan2(Math.sin(yaw - this._yaw), Math.cos(yaw - this._yaw)) * 0.15;
    const fx = Math.sin(this._yaw), fz = Math.cos(this._yaw);
    u.fwdXZ.value.set(fx, fz);
    u.bodyXZ.value.set(head.x - fx * 0.12, head.z - fz * 0.12);
    u.floorY.value = this.floorY;
    u.hipY.value = Math.max(this.floorY + 0.3, Math.min(head.y - 0.62, this.floorY + 1.0));
    u.time.value = t / 1000;
    u.hands.value.forEach((h, i) => { const p = handPoints[i]; if (p) h.set(p.pos.x, p.pos.y, p.pos.z, p.r); else h.set(0, 0, 0, 0); });

    // Boden alle 8 Frames nachmessen
    if (this.n++ % 8 === 0) this._measureFloor();
    this.ok = true;
    this.mask.visible = true;
  }

  _measureFloor() {
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    this.u.rtSize.value.set(64, 48);
    r.xr.enabled = false;
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(this.floorScene, this.ortho);
    r.readRenderTargetPixels(this.rt, 0, 0, 64, 48, this.buf);
    r.setRenderTarget(prevRT);
    r.xr.enabled = true;
    const ys = [];
    for (let i = 0; i < this.buf.length; i += 4) {
      if (this.buf[i + 3] < 128) continue;
      const v = (this.buf[i] + this.buf[i + 1] / 255) / 255;
      ys.push(v * 3 - 1);
    }
    if (ys.length < 25) return;
    ys.sort((a, b) => a - b);
    const est = ys[Math.floor(ys.length * 0.3)];          // Boden: untere Haelfte der Punkte im Ring
    if (Math.abs(est - this.floorBase) > 0.3) return;
    this.floorY += (est - this.floorY) * 0.3;              // weich nachfuehren
  }

  setBase(y) { this.floorBase = y; this.floorY = y; }
  setStrength(s) { this.u.strength.value = s; }

  dispose(scene) {
    scene.remove(this.mask);
    this.mask.geometry.dispose(); this.mask.material.dispose();
    this.floorQuad.geometry.dispose(); this.floorQuad.material.dispose();
    this.rt.dispose();
  }
}

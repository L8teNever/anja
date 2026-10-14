// Koerper-Erkennung ueber den Tiefensensor (WebXR depth-sensing, z. B. Quest 3) – stehend, sitzend, liegend.
// 1. Jeder Bildpunkt -> echte Raumposition (Sensor-Angaben je Auge: Nah/Fern bzw. Meter-Faktor, Ausrichtung).
// 2. Mehrmals pro Sekunde ein kleines Tiefenbild (Auge links) auf der CPU auswerten:
//    - Auflageflaechen finden (Boden, Bett, Sitzflaeche, Tisch): grosse waagrechte Flaechen gleicher Hoehe.
//    - Startpunkte auf deinem Koerper: Haende/Controller, Koerper-Gelenke (falls die Brille Body-Tracking
//      liefert) und Brust/Bauch direkt unter dem Kinn.
//    - Von dort aus zusammenhaengende Flaeche wachsen lassen (Nachbarpunkte ohne Tiefensprung), aber nie
//      in Auflageflaechen hinein -> dein ganzer Koerper, auch wenn du auf dem Bett liegst oder sitzt.
// 3. Die Maske wird pro Bildpunkt in voller Aufloesung angewendet (in den aktuellen Blick umgerechnet,
//    damit sie bei Kopfbewegung nicht hinterherhaengt). Haende werden zusaetzlich direkt aus dem
//    Hand-Tracking eingefaerbt. Die Maske ist spaeter auch fuer Kleidung gedacht.
import * as THREE from 'three';

const W = 96, H = 72;            // Aufloesung der Auswertung
const MAX_PLANES = 4;

const COMMON = `
uniform sampler2DArray depthColor;
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
`;

const VERT = `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// kleines Tiefenbild fuer die CPU: Weltposition je Punkt
const GRAB_FRAG = COMMON + `
uniform vec2 rtSize;
void main() { gl_FragColor = worldAt(gl_FragCoord.xy / rtSize, 0); }`;

// Einfaerben (pro Auge, nebeneinander im Bildpuffer)
const MASK_FRAG = COMMON + `
uniform vec2 vpSize;
uniform sampler2D bodyMask;
uniform mat4 maskVP;                 // Welt -> Bild der Auswertung
uniform float maskOn, floorY;
uniform vec4 planes[${MAX_PLANES}];   // Auflageflaechen: Hoehe (x), aktiv (y)
uniform vec4 hands[16];              // Kugeln um Haende/Controller (xyz, r)
uniform vec3 head, color;
uniform float strength, time;
void main() {
  int e = gl_FragCoord.x >= vpSize.x ? 1 : 0;
  vec2 uv = vec2(gl_FragCoord.x - float(e) * vpSize.x, gl_FragCoord.y) / vpSize;
  vec4 w = worldAt(uv, e);
  vec3 dx = dFdx(w.xyz), dy = dFdy(w.xyz);
  if (w.w < 0.5) discard;
  float hand = 0.0;
  for (int i = 0; i < 16; i++) if (hands[i].w > 0.0) hand = max(hand, smoothstep(hands[i].w, hands[i].w * 0.7, distance(w.xyz, hands[i].xyz)));
  float k = hand;
  if (k < 0.99 && maskOn > 0.5) {
    float ny = abs(normalize(cross(dx, dy)).y);
    bool support = w.y - floorY < 0.035;
    for (int i = 0; i < ${MAX_PLANES}; i++) if (planes[i].y > 0.5 && ny > 0.75 && abs(w.y - planes[i].x) < 0.03) support = true;
    if (!support && distance(w.xyz, head) < 2.3) {
      vec4 c = maskVP * vec4(w.xyz, 1.0);
      vec2 m = c.xy / c.w * 0.5 + 0.5;
      if (c.w > 0.0 && m.x > 0.0 && m.x < 1.0 && m.y > 0.0 && m.y < 1.0) k = max(k, smoothstep(0.35, 0.65, texture(bodyMask, m).r));
    }
  }
  if (k < 0.01) discard;
  float wave = 0.5 + 0.5 * sin(time * 3.0 + w.y * 14.0);
  gl_FragColor = vec4(color + 0.12 * wave, (0.5 + 0.15 * wave) * k * strength);
}`;

export class BodyTracker {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.floorY = 0; this.floorBase = 0;
    this.ok = false;
    const u = this.u = {
      depthColor: { value: null }, vpSize: { value: new THREE.Vector2(1, 1) },
      normDepth: { value: [new THREE.Matrix4(), new THREE.Matrix4()] },
      proj: { value: [new THREE.Vector4(1, 1, 0, 0), new THREE.Vector4(1, 1, 0, 0)] },
      viewW: { value: [new THREE.Matrix4(), new THREE.Matrix4()] },
      depthNF: { value: [new THREE.Vector3(0.1, 0, 0), new THREE.Vector3(0.1, 0, 0)] },
      rawToM: { value: 0.001 }, rtSize: { value: new THREE.Vector2(W, H) },
      bodyMask: { value: null }, maskVP: { value: new THREE.Matrix4() }, maskOn: { value: 0 },
      floorY: { value: 0 }, planes: { value: Array.from({ length: MAX_PLANES }, () => new THREE.Vector4()) },
      hands: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
      head: { value: new THREE.Vector3() },
      color: { value: new THREE.Color(0x3d8bff) }, strength: { value: 1 }, time: { value: 0 },
    };
    this.maskData = new Uint8Array(W * H);
    this.maskTex = new THREE.DataTexture(this.maskData, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    this.maskTex.magFilter = this.maskTex.minFilter = THREE.LinearFilter;
    u.bodyMask.value = this.maskTex;

    this.mask = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: MASK_FRAG, uniforms: u, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.mask.frustumCulled = false; this.mask.renderOrder = 20; this.mask.visible = false;
    scene.add(this.mask);

    this.rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: false, type: THREE.FloatType });
    this.grabScene = new THREE.Scene();
    this.grabQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: GRAB_FRAG, uniforms: u }));
    this.grabQuad.frustumCulled = false;
    this.grabScene.add(this.grabQuad);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.buf = new Float32Array(W * H * 4);
    this.ny = new Float32Array(W * H);
    this.lab = new Uint8Array(W * H);
    this.queue = new Int32Array(W * H);
    this.n = 0;
    this.grabFail = false;
  }

  // pro XR-Frame; points: Liste von {pos, r} (Haende/Controller/Koerper-Gelenke)
  update(frame, t, points = []) {
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
      if (e === 0) { this._P = P; this._V = view.transform.inverse.matrix; }
      good++;
    });
    if (!good) { this.mask.visible = false; return; }
    const cam = xr.getCamera();
    u.depthColor.value = tex;
    u.vpSize.value.set(cam.cameras[0].viewport.z, cam.cameras[0].viewport.w);
    const head = u.head.value.setFromMatrixPosition(cam.matrixWorld);
    u.time.value = t / 1000;
    // nur die echten Hand-Punkte direkt einfaerben, Gelenke dienen als Startpunkte
    const handPts = points.filter((p) => p.hand);
    u.hands.value.forEach((h, i) => { const p = handPts[i]; if (p) h.set(p.pos.x, p.pos.y, p.pos.z, p.r); else h.set(0, 0, 0, 0); });

    if (!this.grabFail && this.n++ % 2 === 0) {
      try { this._segment(head, points); } catch (err) { this.grabFail = true; console.warn('Koerper-Auswertung aus:', err); }
    }
    u.floorY.value = this.floorY;
    this.ok = true;
    this.mask.visible = true;
  }

  _segment(head, points) {
    const r = this.renderer, u = this.u;
    const prevRT = r.getRenderTarget();
    r.xr.enabled = false;
    r.setRenderTarget(this.rt);
    r.render(this.grabScene, this.ortho);
    r.readRenderTargetPixels(this.rt, 0, 0, W, H, this.buf);
    r.setRenderTarget(prevRT);
    r.xr.enabled = true;
    const B = this.buf, ny = this.ny, lab = this.lab, N = W * H;
    const ok = (i) => B[i * 4 + 3] > 0.5;
    const P = (i, k) => B[i * 4 + k];

    // Normalen (Hoehenanteil) aus Nachbarn
    let valid = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; ny[i] = 0;
      if (!ok(i)) continue; valid++;
      const a = x > 0 ? i - 1 : i, b = x < W - 1 ? i + 1 : i, c = y > 0 ? i - W : i, d = y < H - 1 ? i + W : i;
      if (!ok(a) || !ok(b) || !ok(c) || !ok(d)) continue;
      const ux = P(b, 0) - P(a, 0), uy = P(b, 1) - P(a, 1), uz = P(b, 2) - P(a, 2);
      const vx = P(d, 0) - P(c, 0), vy = P(d, 1) - P(c, 1), vz = P(d, 2) - P(c, 2);
      const nx = uy * vz - uz * vy, nY = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, nY, nz);
      ny[i] = l > 1e-9 ? Math.abs(nY) / l : 0;
    }
    if (valid < 200) return;

    // Auflageflaechen: Hoehen-Histogramm waagrechter Punkte (2 cm), grosse Flaechen
    const BINS = 200, y0 = this.floorBase - 0.6;
    const cnt = new Float32Array(BINS), mnx = new Float32Array(BINS).fill(1e9), mxx = new Float32Array(BINS).fill(-1e9);
    const mnz = new Float32Array(BINS).fill(1e9), mxz = new Float32Array(BINS).fill(-1e9);
    let flat = 0;
    for (let i = 0; i < N; i++) {
      if (ny[i] < 0.9) continue;
      const b = Math.floor((P(i, 1) - y0) / 0.02);
      if (b < 0 || b >= BINS) continue;
      flat++; cnt[b]++;
      const px = P(i, 0), pz = P(i, 2);
      if (px < mnx[b]) mnx[b] = px; if (px > mxx[b]) mxx[b] = px;
      if (pz < mnz[b]) mnz[b] = pz; if (pz > mxz[b]) mxz[b] = pz;
    }
    const planes = [];
    for (let b = 1; b < BINS - 1; b++) {
      const s = cnt[b - 1] + cnt[b] + cnt[b + 1];
      if (cnt[b] < cnt[b - 1] || cnt[b] < cnt[b + 1] || s < Math.max(60, valid * 0.05)) continue;
      const ex = Math.max(mxx[b - 1], mxx[b], mxx[b + 1]) - Math.min(mnx[b - 1], mnx[b], mnx[b + 1]);
      const ez = Math.max(mxz[b - 1], mxz[b], mxz[b + 1]) - Math.min(mnz[b - 1], mnz[b], mnz[b + 1]);
      if (Math.min(ex, ez) < 0.55) continue;
      const yb = y0 + (b + 0.5) * 0.02;
      planes.push({ y: yb, s });
    }
    planes.sort((a, b) => b.s - a.s);
    planes.length = Math.min(planes.length, MAX_PLANES);
    // Boden = tiefste grosse Flaeche nahe local-floor
    const fl = planes.filter((p) => Math.abs(p.y - this.floorBase) < 0.3).sort((a, b) => a.y - b.y)[0];
    if (fl) this.floorY += (fl.y - this.floorY) * 0.3;
    u.planes.value.forEach((v, k) => { const p = planes[k]; v.set(p ? p.y : 0, p ? 1 : 0, 0, 0); });
    const support = (i) => {
      const py = P(i, 1);
      if (py - this.floorY < 0.035) return true;
      if (ny[i] > 0.75) for (const p of planes) if (Math.abs(py - p.y) < 0.03) return true;
      return false;
    };

    // Startpunkte
    lab.fill(0);
    const q = this.queue; let qh = 0, qt = 0;
    const hx = head.x, hy = head.y, hz = head.z;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!ok(i)) continue;
      const px = P(i, 0), py = P(i, 1), pz = P(i, 2);
      const dh = Math.hypot(px - hx, py - hy, pz - hz);
      if (dh > 2.3) { lab[i] = 2; continue; }
      if (support(i)) { lab[i] = 2; continue; }
      let seed = false;
      for (const p of points) {
        const dx = px - p.pos.x, dy = py - p.pos.y, dz = pz - p.pos.z;
        if (dx * dx + dy * dy + dz * dz < p.r * p.r) { seed = true; break; }
      }
      // Brust/Bauch: nah unter dem Kinn, unteres Bilddrittel
      if (!seed && y < H * 0.4 && dh > 0.15 && dh < 0.6 && py < hy - 0.05) seed = true;
      if (seed) { lab[i] = 1; q[qt++] = i; }
    }
    // Wachsen ueber zusammenhaengende Tiefe
    while (qh < qt) {
      const i = q[qh++], x = i % W, y = (i / W) | 0;
      const px = P(i, 0), py = P(i, 1), pz = P(i, 2);
      const range = Math.hypot(px - hx, py - hy, pz - hz);
      const thr = 0.03 + 0.04 * range;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0 || lab[j] || !ok(j)) continue;
        const dx = P(j, 0) - px, dy = P(j, 1) - py, dz = P(j, 2) - pz;
        if (dx * dx + dy * dy + dz * dz > thr * thr) continue;
        lab[j] = 1; q[qt++] = j;
      }
    }
    // Maske (1 Punkt aufgeweitet fuer weiche Kanten; die Feinarbeit macht der Shader)
    const M = this.maskData;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = lab[i] === 1 ? 255 : 0;
      if (!v && ((x > 0 && lab[i - 1] === 1) || (x < W - 1 && lab[i + 1] === 1) || (y > 0 && lab[i - W] === 1) || (y < H - 1 && lab[i + W] === 1))) v = 160;
      M[i] = v;
    }
    this.maskTex.needsUpdate = true;
    u.maskVP.value.fromArray(this._P).multiply(new THREE.Matrix4().fromArray(this._V));
    u.maskOn.value = 1;
  }

  setBase(y) { this.floorBase = y; this.floorY = y; }
  setStrength(s) { this.u.strength.value = s; }

  dispose(scene) {
    scene.remove(this.mask);
    this.mask.geometry.dispose(); this.mask.material.dispose();
    this.grabQuad.geometry.dispose(); this.grabQuad.material.dispose();
    this.rt.dispose(); this.maskTex.dispose();
  }
}

// Mixed-Reality-Modus: volle Durchsicht, dein Unterkoerper wird blau eingefaerbt.
// Quest 3 (Tiefensensor): Erkennung in body-tracker.js – dein ganzer Koerper (Beine, Oberkoerper,
// Arme, Haende), stehend, sitzend oder liegend; Boden/Bett/Sitz werden ausgespart.
// Die Maske ist spaeter auch fuer Kleidung gedacht.
// Wuerfel (mr-cubes.js): erzeugen, greifen, an Hand/Arm/Bein/Brust anheften – sie bewegen sich mit dir.
// Ohne Tiefensensor: Beine werden aus der Kopfposition geschaetzt (als "geschaetzt" angezeigt).
import * as THREE from 'three';
import { ICON_PATHS } from '/icons.js';
import { BodyTracker } from '/body-tracker.js';
import { BodyCubes } from '/mr-cubes.js';
import { MeasurePanel, loadProfile } from '/mr-measure.js';

const BLUE = new THREE.Color(0x3d8bff);
// Hand-Knochen (Handflaeche, Daumen, Finger) aus den WebXR-Gelenken
const F = (f) => [[`${f}-phalanx-proximal`, `${f}-phalanx-intermediate`], [`${f}-phalanx-intermediate`, `${f}-tip`]];
const HAND_BONES = [
  ['wrist', 'index-finger-phalanx-proximal', 0.02], ['wrist', 'middle-finger-phalanx-proximal', 0.022],
  ['wrist', 'ring-finger-phalanx-proximal', 0.02], ['wrist', 'pinky-finger-phalanx-proximal', 0.018],
  ['thumb-metacarpal', 'thumb-phalanx-proximal'], ['thumb-phalanx-proximal', 'thumb-phalanx-distal'], ['thumb-phalanx-distal', 'thumb-tip'],
  ...F('index-finger'), ...F('middle-finger'), ...F('ring-finger'), ...F('pinky-finger'),
];
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

    // Koerper-Erkennung per Tiefensensor
    this.legs = new BodyTracker(this.renderer, this.scene);

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

    this.cubes = new BodyCubes(this.scene, this.legs);
    // Koerpermasse (Groesse, Huefte, Knie) -> Knochenlaengen
    this.legs.skel.setProfile(loadProfile());
    this.legMode = 'off';
    this.measure = new MeasurePanel(this.scene, {
      onLegCal: () => this.startLegCalib(),
      onLegOff: () => this.stopLegCalib(),
      onChange: (p) => this.legs.skel.setProfile(p),
      eyeHeight: () => new THREE.Vector3().setFromMatrixPosition(this.renderer.xr.getCamera().matrixWorld).y - this.legs.floorY,
    });
    this.ctx = { anchors: new Map() };
    // Skelett sichtbar machen (Knopf "Skelett")
    this.skelLines = new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
    this.skelLines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((this.legs.skel.bones.length + 30) * 6), 3));
    this.skelLines.frustumCulled = false; this.skelLines.renderOrder = 26; this.skelLines.visible = false;
    this.scene.add(this.skelLines);

    // kleiner Griff "Beenden | Blau | Wuerfel | Weg" unten im Blickfeld (Brille)
    this.hc = document.createElement('canvas'); this.hc.width = 768; this.hc.height = 150;
    this.htex = new THREE.CanvasTexture(this.hc); this.htex.colorSpace = THREE.SRGBColorSpace;
    this.handle = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5 * 150 / 768),
      new THREE.MeshBasicMaterial({ map: this.htex, transparent: true, depthTest: false }));
    this.handle.renderOrder = 30; this.handle.visible = false;
    this.scene.add(this.handle);
    this.hover = null;

    this.ctrls = [0, 1].map((i) => {
      const c = this.renderer.xr.getController(i);
      c.addEventListener('connected', (e) => { c.userData.mode = e.data.targetRayMode; c.userData.src = e.data; });
      c.addEventListener('disconnected', () => { this.cubes.release(c, this.ctx, null); c.userData.mode = null; });
      c.addEventListener('selectstart', () => {
        if (this._legCtrl(c)) { c.userData.grabbing = true; return; }   // Controller am Bein: keine Klicks
        const cube = this.phone ? null : this.cubes.pick(c);
        c.userData.grabbing = !!cube;
        if (cube) this.cubes.grab(c, cube);
      });
      c.addEventListener('selectend', () => {
        if (c.userData.grabbing) this.cubes.release(c, this.ctx, 'hand-' + (c.userData.src?.handedness || ''));
      });
      c.addEventListener('select', () => { if (!c.userData.grabbing) this._press(c); });
      this.scene.add(c);
      return c;
    });
    this.raycaster = new THREE.Raycaster();
    // Blick-Zeiger: Ring + fuellender Punkt
    this.reticle = new THREE.Group();
    const rm = (g, c) => { const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: c, transparent: true, depthTest: false })); m.renderOrder = 40; return m; };
    this.reticle.add(rm(new THREE.RingGeometry(0.011, 0.014, 32), 0xffffff), rm(new THREE.CircleGeometry(0.011, 32), 0xb69cff));
    this.reticle.visible = false;
    this.scene.add(this.reticle);
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
      optionalFeatures: ['local-floor', 'depth-sensing', 'hand-tracking', 'body-tracking'],
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
    return this.depthOk ? 'Körper per Tiefensensor erkannt' : this.depth ? 'Warte auf Tiefensensor …' : 'Kein Tiefensensor – Beine geschätzt';
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
    this._pressRay(new THREE.Vector3().setFromMatrixPosition(c.matrixWorld), new THREE.Vector3(0, 0, -1).applyMatrix4(m));
  }

  _pressRay(o, d) {
    this.raycaster.ray.origin.copy(o);
    this.raycaster.ray.direction.copy(d);
    if (this.measure.open) {
      const mh = this.raycaster.intersectObject(this.measure.mesh, false)[0];
      if (mh) { this.measure.press(mh.uv); return; }
    }
    const h = this.raycaster.intersectObject(this.handle, false)[0];
    if (!h) return;
    const k = Math.min(6, Math.floor(h.uv.x * 7));
    if (k === 0) this.end();
    else if (k === 1) this.toggleBlue();
    else if (k === 2) this.cubes.spawn(this.renderer.xr.getCamera());
    else if (k === 3) this.cubes.clear();
    else if (k === 4) { this.showSkel = !this.showSkel; this._drawHandle(); }
    else if (k === 5) { this.cubes.cycleBreasts(); this._drawHandle(); }
    else {
      if (this.measure.open) this.measure.hide(); else this.measure.show(this.renderer.xr.getCamera(), this.legs.floorY);
      this._drawHandle();
    }
  }

  _drawHandle() {
    const ctx = this.hc.getContext('2d'), W = 768, H = 150;
    ctx.clearRect(0, 0, W, H);
    ctx.font = '500 22px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(22,19,31,0.8)';
    const t = this.status, tw = ctx.measureText(t).width + 30;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect((W - tw) / 2, 2, tw, 36, 18) : ctx.rect((W - tw) / 2, 2, tw, 36); ctx.fill();
    ctx.fillStyle = '#f1edf9'; ctx.fillText(t, W / 2, 20);
    const lbl = this.strength > 0.5 ? 'Blau: stark' : this.strength > 0.2 ? 'Blau: leicht' : 'Blau: aus';
    const bw = W / 7;
    const bs = ['Brust', 'Brust S', 'Brust M', 'Brust L'][this.cubes.breastSize || 0];
    [['exit', 'close', 'Beenden'], ['blue', 'pan_tool', lbl], ['cube', 'add_box', 'Würfel'], ['clear', 'delete_sweep', 'Weg'],
      ['skel', 'accessibility_new', 'Skelett'], ['breasts', 'person', bs], ['measure', 'tune', 'Maße']].forEach(([id, ic, label], k) => {
      const on = this.hover === id || (id === 'skel' && this.showSkel) || (id === 'breasts' && this.cubes.breastSize > 0)
        || (id === 'measure' && this.measure?.open), x0 = k * bw;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0 + 4, 46, bw - 8, 98, 30) : ctx.rect(x0 + 4, 46, bw - 8, 98);
      ctx.fillStyle = on ? 'rgba(182,156,255,0.92)' : 'rgba(22,19,31,0.85)'; ctx.fill();
      ctx.save(); ctx.translate(x0 + bw / 2 - 18, 52); ctx.scale(36 / 24, 36 / 24); ctx.fillStyle = on ? '#1f1638' : '#f1edf9';
      ctx.fill(new Path2D(ICON_PATHS[ic])); ctx.restore();
      ctx.font = '600 18px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = on ? '#1f1638' : '#f1edf9';
      ctx.fillText(label, x0 + bw / 2, 118);
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

    // Tiefensensor: alle Bildpunkte, die zu deinem Koerper gehoeren
    const was = this.depthOk;
    const pts = this._handPoints(frame, cam);
    this._legCalib();
    if (this.legMode === 'on') this.wrists.legs = this.legMats;
    // Finger als Beruehrungspunkte (Brust-Physik)
    this.ctx.fingers = [];
    for (const caps of [this.handCaps.l, this.handCaps.r]) if (caps && caps.length > 1) for (const cp of caps) this.ctx.fingers.push(cp.b);
    this.legs.update(frame, t, pts, this.wrists || {}, this.handCaps || {});
    this._drawSkeleton();
    this.depthOk = this.legs.ok;
    this.cubes.update(this.ctx);
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
    let hov = null, mhov = null;
    for (const c of this.ctrls) {
      if (!c.userData.mode || this.phone) continue;
      const m = new THREE.Matrix4().extractRotation(c.matrixWorld);
      this.raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
      this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(m);
      const h = this.raycaster.intersectObject(this.handle, false)[0];
      if (h) hov = ['exit', 'blue', 'cube', 'clear', 'skel', 'breasts', 'measure'][Math.min(6, Math.floor(h.uv.x * 7))];
      if (this.measure.open) { const mh = this.raycaster.intersectObject(this.measure.mesh, false)[0]; if (mh) mhov = mh.uv; }
    }
    this.measure.setHover(mhov);
    this._gaze(cam);
    this.measure.update(this.legs.skel.j.pelvis, this.legs.floorY);
    if (hov !== this.hover) { this.hover = hov; this._drawHandle(); }
    this.renderer.render(this.scene, this.camera);
  }

  // Haende/Controller (direkt eingefaerbt) und Koerper-Gelenke (Startpunkte der Erkennung).
  // Nebenbei: Ankerpunkte fuer angeheftete Wuerfel (this.ctx).
  _handPoints(frame, cam) {
    const out = [], ref = this.renderer.xr.getReferenceSpace();
    const anchors = this.ctx.anchors;
    this.wrists = {}; this.handCaps = {}; this.legMats = {};
    if (!frame || !ref) return out;
    const V = (p) => new THREE.Vector3(p.x, p.y, p.z);
    // inputSources = aktive Eingaben; trackedSources = zusaetzlich getrackte (z. B. Controller am Bein,
    // waehrend die Haende aktiv sind) – nur wenn die Brille Haende + Controller gleichzeitig anbietet.
    const srcs = [...frame.session.inputSources, ...(frame.session.trackedSources || [])];
    for (const src of srcs) {
      const key = 'hand-' + src.handedness;
      if (src.hand) {
        const pts = [];
        for (const [name, r] of JOINTS) {
          const j = src.hand.get(name), p = j && frame.getJointPose?.(j, ref);
          if (p) { out.push({ pos: p.transform.position, r, hand: true }); pts.push(V(p.transform.position)); }
        }
        // Hand-Knochen fuers Einfaerben und das Skelett
        const jp = {};
        for (const [name, j] of src.hand) { const p = frame.getJointPose?.(j, ref); if (p) jp[name] = p; }
        const caps = [];
        for (const [a, b, r] of HAND_BONES) {
          const pa = jp[a], pb = jp[b];
          if (pa && pb) caps.push({ a: V(pa.transform.position), b: V(pb.transform.position), r: (r || Math.max(pa.radius || 0.01, pb.radius || 0.01)) + 0.004 });
        }
        if (caps.length) this.handCaps[src.handedness === 'left' ? 'l' : 'r'] = caps;
        const w = src.hand.get('wrist'), wp = w && frame.getJointPose?.(w, ref);
        if (wp) {
          const m = new THREE.Matrix4().fromArray(wp.transform.matrix);
          // Unterarm: vom Handgelenk entlang +Z (Richtung Ellbogen)
          for (const d of [0.1, 0.2]) pts.push(new THREE.Vector3(0, 0, d).applyMatrix4(m));
          anchors.set(key, { m, pts, r: 0.07 });
          this.wrists[src.handedness === 'left' ? 'l' : 'r'] = new THREE.Vector3().setFromMatrixPosition(m);
          this.wrists[src.handedness === 'left' ? 'ld' : 'rd'] = new THREE.Vector3(0, 0, 1).transformDirection(m);   // Richtung Ellbogen
        }
      } else if (src.gripSpace) {
        const p = frame.getPose(src.gripSpace, ref);
        if (p && this.legMode !== 'off') {
          // Controller haengt am Schienbein -> Bein-Tracker, nicht Hand
          this.legMats[src.handedness === 'left' ? 'l' : 'r'] = new THREE.Matrix4().fromArray(p.transform.matrix);
        } else if (p) {
          out.push({ pos: p.transform.position, r: 0.11, hand: true });
          anchors.set(key, { m: new THREE.Matrix4().fromArray(p.transform.matrix), pts: [V(p.transform.position)], r: 0.1 });
          this.wrists[src.handedness === 'left' ? 'l' : 'r'] = V(p.transform.position);
          this.handCaps[src.handedness === 'left' ? 'l' : 'r'] = [{ a: V(p.transform.position), b: V(p.transform.position), r: 0.09 }];
        }
      }
    }
    // Body-Tracking der Brille (falls vorhanden)
    try {
      if (frame.body) for (const [name, space] of frame.body) {
        const p = frame.getPose(space, ref);
        if (!p) continue;
        out.push({ pos: p.transform.position, r: 0.09 });
        anchors.set('joint-' + name, { m: new THREE.Matrix4().fromArray(p.transform.matrix), pts: [V(p.transform.position)], r: 0.07 });
      }
    } catch { /* nicht unterstuetzt */ }
    return out;
  }

  // Steuerung per Blick: Knopf 1,2 s anschauen -> ausgeloest. Aktiv, wenn keine Hand/kein Controller zeigt
  // (z. B. Controller am Bein und die Quest hat die Haende abgeschaltet).
  _gaze(cam) {
    const pointing = this.ctrls.some((c) => c.userData.mode && !this._legCtrl(c) && c.userData.src && (c.userData.src.hand || this.legMode === 'off'));
    let key = null, hit = null;
    const o = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld));
    if (!pointing && !this.phone) {
      this.raycaster.ray.origin.copy(o); this.raycaster.ray.direction.copy(d);
      const mh = this.measure.open ? this.raycaster.intersectObject(this.measure.mesh, false)[0] : null;
      const a = mh && this.measure._at(mh.uv);
      if (a) { key = 'm:' + a; hit = mh; }
      else {
        const h = this.raycaster.intersectObject(this.handle, false)[0];
        if (h && h.uv.y < 0.69) { key = 'h:' + Math.min(6, Math.floor(h.uv.x * 7)); hit = h; }
      }
    }
    const now = performance.now();
    if (key !== this._gKey) { this._gKey = key; this._gT0 = now; this._gDone = false; }
    const prog = key && !this._gDone ? Math.min(1, (now - this._gT0) / 1200) : 0;
    this.reticle.visible = !!hit;
    if (hit) {
      this.reticle.position.copy(hit.point).addScaledVector(d, -0.005);
      this.reticle.lookAt(o);
      this.reticle.children[1].scale.setScalar(Math.max(0.001, prog));
    }
    if (prog >= 1) { this._gDone = true; this._pressRay(o, d); }
  }

  _legCtrl(c) { return this.legMode !== 'off' && c.userData.src && !c.userData.src.hand; }

  // Controller an den Schienbeinen: 10 s Zeit zum Anlegen, dann gerade stehen -> kalibrieren
  startLegCalib() { this.legMode = 'wait'; this._legT0 = performance.now(); this._legSec = -1; }
  stopLegCalib() { this.legMode = 'off'; this.legs.skel.clearLegCtrl(); this.measure.note = 'Controller-Beine aus'; this.measure.draw(); }
  _legCalib() {
    if (this.legMode !== 'wait') return;
    const left = Math.ceil(10 - (performance.now() - this._legT0) / 1000);
    if (left > 0) {
      if (left !== this._legSec) {
        this._legSec = left;
        this.measure.note = `Controller vorne unters Knie, gerade hinstellen … ${left}`;
        this.measure.draw();
      }
      return;
    }
    const n = this.legs.skel.calibrateLegs(this.legMats);
    this.legMode = n ? 'on' : 'off';
    this.measure.note = n ? `${n} Bein${n > 1 ? 'e' : ''} per Controller verbunden` : 'Kein Controller gefunden';
    this.measure.draw();
  }

  _drawSkeleton() {
    this.skelLines.visible = !!this.showSkel && this.legs.skel.ready;
    if (!this.skelLines.visible) return;
    const a = this.skelLines.geometry.attributes.position;
    const segs = [...this.legs.skel.bones, ...(this.handCaps?.l || []), ...(this.handCaps?.r || [])].slice(0, a.count / 2);
    segs.forEach((b, i) => { a.setXYZ(i * 2, b.a.x, b.a.y, b.a.z); a.setXYZ(i * 2 + 1, b.b.x, b.b.y, b.b.z); });
    this.skelLines.geometry.setDrawRange(0, segs.length * 2);
    a.needsUpdate = true;
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    removeEventListener('resize', this._onResize);
    this.cubes.dispose(); this.measure.dispose(); this.legs.dispose(this.scene); this.htex.dispose();
    this.renderer.dispose(); this.renderer.domElement.remove();
  }
}

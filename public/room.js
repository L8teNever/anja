// Raum-Modus: Durchsicht ohne Video, Wuerfel in den echten Raum stellen.
// Die Wuerfel liegen im Raum-Koordinatensystem der Brille (local-floor) – laeuft man
// herum, bleiben sie stehen. Bewegen nur, wenn man sie greift:
//  - Hand: Pinch/Greifen am Wuerfel = festhalten, loslassen = abstellen (dreht mit der Hand)
//  - Controller: Grifftaste/Abzug nah am Wuerfel oder per Strahl aus der Ferne
//  - Handy: Finger auf den Wuerfel und ziehen
// Pinch/Abzug/Tippen ins Leere stellt einen neuen Wuerfel hin.
import * as THREE from 'three';
import { ICON_PATHS } from '/icons.js';

const SIZE = 0.2;                       // Kantenlaenge in Metern
const COLORS = [0xb69cff, 0x7ee0b0, 0xffb86b, 0xff7a8a, 0x7cc4ff, 0xf5e17a];
const STORE = 'anja-room-cubes';
const TW = 768, TH = 160;               // Werkzeugleiste (Canvas-Pixel)
const TOOLS = [
  { id: 'add', icon: 'add_box', label: 'Würfel +' },
  { id: 'undo', icon: 'undo', label: 'Letzten weg' },
  { id: 'clear', icon: 'delete', label: 'Alle weg' },
  { id: 'exit', icon: 'close', label: 'Beenden' },
];

export class Room {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.01, 50);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 3, 2); this.scene.add(sun);

    this.geo = new THREE.BoxGeometry(SIZE, SIZE, SIZE);
    this.edges = new THREE.EdgesGeometry(this.geo);
    this.cubes = [];
    this.grabs = new Map();             // Eingabe-Index -> { cube, ... }
    this.pending = [];                  // Druecke werden im naechsten Frame mit frischer Pose verarbeitet

    // Eingaben: Strahl (controller), Griff (grip), Hand (joints)
    this.inputs = [0, 1].map((i) => {
      const ray = this.renderer.xr.getController(i);
      const grip = this.renderer.xr.getControllerGrip(i);
      const hand = this.renderer.xr.getHand(i);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: 0xb69cff, transparent: true, opacity: 0.7 }));
      line.scale.z = 0.6; line.visible = false; ray.add(line);
      const inp = { i, ray, grip, hand, line, mode: null };
      ray.addEventListener('connected', (e) => { inp.mode = e.data.targetRayMode; inp.source = e.data; line.visible = inp.mode === 'tracked-pointer' && !e.data.hand; });
      ray.addEventListener('disconnected', () => { inp.mode = null; this._release(i); line.visible = false; });
      ray.addEventListener('selectstart', () => this.pending.push({ i, kind: 'select' }));
      ray.addEventListener('selectend', () => this.pending.push({ i, kind: 'end', src: 'select' }));
      ray.addEventListener('squeezestart', () => this.pending.push({ i, kind: 'squeeze' }));
      ray.addEventListener('squeezeend', () => this.pending.push({ i, kind: 'end', src: 'squeeze' }));
      this.scene.add(ray, grip, hand);
      return inp;
    });

    // Ziel-Ring auf echten Flaechen (Hit-Test, v. a. am Handy)
    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    this.reticle.matrixAutoUpdate = false; this.reticle.visible = false;
    this.scene.add(this.reticle);

    // Werkzeugleiste (fuer Brillen; am Handy gibt es Bildschirm-Knoepfe)
    this.tcanvas = document.createElement('canvas'); this.tcanvas.width = TW; this.tcanvas.height = TH;
    this.ttex = new THREE.CanvasTexture(this.tcanvas); this.ttex.colorSpace = THREE.SRGBColorSpace;
    this.toolbar = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.56 * TH / TW),
      new THREE.MeshBasicMaterial({ map: this.ttex, transparent: true, depthTest: false }));
    this.toolbar.renderOrder = 10; this.toolbar.visible = false;
    this.scene.add(this.toolbar);
    this.toolHover = null;
    this._drawToolbar();

    this.raycaster = new THREE.Raycaster();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    this.renderer.setAnimationLoop((t, frame) => this._frame(t, frame));
  }

  resize() {
    const w = this.container.clientWidth || innerWidth, h = this.container.clientHeight || innerHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w, h, false);
  }

  // overlay: HTML-Knoepfe fuers Handy (DOM-Overlay)
  async start(overlay) {
    const init = { optionalFeatures: ['local-floor', 'hand-tracking', 'hit-test'] };
    if (overlay) { init.optionalFeatures.push('dom-overlay'); init.domOverlay = { root: overlay }; }
    const session = await navigator.xr.requestSession('immersive-ar', init);
    try { await this.renderer.xr.setSession(session); }
    catch { this.renderer.xr.setReferenceSpaceType('local'); await this.renderer.xr.setSession(session); }
    this.session = session;
    this.phone = !!session.domOverlayState;
    this._load();
    this._needToolbar = true;          // erst im ersten Frame, wenn die Kopfposition bekannt ist
    try {
      const viewer = await session.requestReferenceSpace('viewer');
      this.hitSource = await session.requestHitTestSource({ space: viewer });
    } catch { this.hitSource = null; }
    session.addEventListener('end', () => { this.hitSource = null; this.session = null; this.onEnd?.(); });
    return session;
  }

  end() { this.session?.end(); }

  /* ---------- Wuerfel ---------- */
  addCube(pos, quat, color) {
    const col = color ?? COLORS[this.cubes.length % COLORS.length];
    const m = new THREE.Mesh(this.geo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.45, metalness: 0.05, emissive: 0x000000 }));
    m.add(new THREE.LineSegments(this.edges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })));
    m.position.copy(pos);
    if (quat) m.quaternion.copy(quat);
    m.userData.color = col;
    this.scene.add(m); this.cubes.push(m);
    this._save();
    return m;
  }

  removeCube(m) {
    if (!m) return;
    for (const [i, g] of this.grabs) if (g.cube === m) this.grabs.delete(i);
    this.scene.remove(m); m.material.dispose(); m.children.forEach((c) => c.material.dispose());
    this.cubes = this.cubes.filter((c) => c !== m);
    this._save();
  }

  clear() { [...this.cubes].forEach((c) => this.removeCube(c)); }
  undo() { this.removeCube(this.cubes[this.cubes.length - 1]); }

  // Am Handy: Wuerfel auf die erkannte Flaeche (Ziel-Ring) bzw. 80 cm vor die Kamera
  addInFront() {
    if (this.reticle.visible) {
      const p = new THREE.Vector3().setFromMatrixPosition(this.reticle.matrix);
      return this.addCube(p.add(new THREE.Vector3(0, SIZE / 2, 0)));
    }
    const cam = this.renderer.xr.getCamera();
    const p = new THREE.Vector3(0, 0, -0.8).applyMatrix4(cam.matrixWorld);
    return this.addCube(p);
  }

  _save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.cubes.map((c) => ({ p: c.position.toArray(), q: c.quaternion.toArray(), c: c.userData.color }))));
    } catch {}
  }

  _load() {
    if (this.cubes.length) return;
    let list = [];
    try { list = JSON.parse(localStorage.getItem(STORE)) || []; } catch {}
    for (const o of list) this.addCube(new THREE.Vector3().fromArray(o.p), new THREE.Quaternion().fromArray(o.q), o.c);
  }

  /* ---------- Eingaben ---------- */
  // Greifpunkt: Hand = zwischen Daumen- und Zeigefingerspitze, Controller = Griffposition
  _point(inp) {
    const j = inp.hand.joints;
    if (j && j['index-finger-tip'] && j['thumb-tip'] && j['index-finger-tip'].visible) {
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      j['index-finger-tip'].getWorldPosition(a); j['thumb-tip'].getWorldPosition(b);
      const q = new THREE.Quaternion(); (j.wrist || j['index-finger-tip']).getWorldQuaternion(q);
      return { pos: a.add(b).multiplyScalar(0.5), quat: q, hand: true };
    }
    if (inp.mode === 'tracked-pointer') {
      const p = new THREE.Vector3(), q = new THREE.Quaternion();
      (inp.grip.visible ? inp.grip : inp.ray).getWorldPosition(p);
      (inp.grip.visible ? inp.grip : inp.ray).getWorldQuaternion(q);
      return { pos: p, quat: q, hand: false };
    }
    return null;
  }

  _rayHit(inp, objects) {
    const m = new THREE.Matrix4().extractRotation(inp.ray.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(inp.ray.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(m);
    return this.raycaster.intersectObjects(objects, false)[0] || null;
  }

  _nearest(pos, reach) {
    let best = null, bd = reach;
    for (const c of this.cubes) {
      const d = c.position.distanceTo(pos);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  _press(i, kind) {
    const inp = this.inputs[i];
    if (!inp.mode) return;
    // 1) Werkzeugleiste
    if (this.toolbar.visible) {
      const h = this._rayHit(inp, [this.toolbar]);
      if (h) { this._tool(TOOLS[Math.min(TOOLS.length - 1, Math.floor(h.uv.x * TOOLS.length))].id); return; }
    }
    // 2) nah greifen (Hand/Controller am Wuerfel)
    const pt = this._point(inp);
    if (pt) {
      const c = this._nearest(pt.pos, SIZE * 0.9 + (pt.hand ? 0.04 : 0.06));
      if (c) { this._grab(i, c, pt); return; }
    }
    // 3) per Strahl aus der Ferne greifen (Controller, Handy-Finger)
    const hit = this._rayHit(inp, this.cubes);
    if (hit) { this._grabRay(i, hit.object, hit.distance); return; }
    // 4) ins Leere: neuen Wuerfel hinstellen
    if (kind !== 'select') return;
    if (pt) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(inp.ray.matrixWorld));
      this.addCube(pt.hand ? pt.pos.clone() : pt.pos.clone().addScaledVector(fwd, 0.35));
    } else if (this.phone) this.addInFront();
  }

  _grab(i, cube, pt) {
    const inv = pt.quat.clone().invert();
    this.grabs.set(i, { cube, near: true,
      offset: cube.position.clone().sub(pt.pos).applyQuaternion(inv),
      rel: inv.multiply(cube.quaternion.clone()) });
    this._pulse(i, 0.5, 40);
  }

  _grabRay(i, cube, dist) {
    const inp = this.inputs[i];
    const origin = new THREE.Vector3().setFromMatrixPosition(inp.ray.matrixWorld);
    this.grabs.set(i, { cube, near: false, dist, offset: cube.position.clone().sub(origin) });
    this._pulse(i, 0.5, 40);
  }

  _release(i) {
    if (this.grabs.delete(i)) { this._save(); this._pulse(i, 0.3, 20); }
  }

  _pulse(i, v, ms) { try { this.inputs[i].source?.gamepad?.hapticActuators?.[0]?.pulse(v, ms); } catch {} }

  _tool(id) {
    if (id === 'add') {
      const cam = this.renderer.xr.getCamera();
      this.addCube(new THREE.Vector3(0, -0.15, -0.6).applyMatrix4(cam.matrixWorld));
    } else if (id === 'undo') this.undo();
    else if (id === 'clear') this.clear();
    else if (id === 'exit') this.end();
  }

  /* ---------- Werkzeugleiste ---------- */
  _placeToolbar(force) {
    const cam = this.renderer.xr.getCamera();
    const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld));
    dir.y = 0; if (dir.lengthSq() < 1e-4) return; dir.normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    if (!force && this._tYaw !== undefined) {
      let d = Math.atan2(Math.sin(yaw - this._tYaw), Math.cos(yaw - this._tYaw));
      if (Math.abs(d) < 0.7) return;
      this._tYaw += d * 0.08;
    } else this._tYaw = yaw;
    const f = new THREE.Vector3(Math.sin(this._tYaw), 0, Math.cos(this._tYaw));
    this.toolbar.position.copy(pos).addScaledVector(f, 0.75);
    this.toolbar.position.y = pos.y - 0.45;
    this.toolbar.lookAt(pos);
  }

  _drawToolbar() {
    const ctx = this.tcanvas.getContext('2d');
    ctx.clearRect(0, 0, TW, TH);
    const w = TW / TOOLS.length;
    TOOLS.forEach((t, k) => {
      const x = k * w, on = this.toolHover === t.id;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x + 6, 6, w - 12, TH - 12, 28) : ctx.rect(x + 6, 6, w - 12, TH - 12);
      ctx.fillStyle = on ? 'rgba(182,156,255,0.92)' : 'rgba(22,19,31,0.85)'; ctx.fill();
      ctx.save(); ctx.translate(x + w / 2 - 26, 22); ctx.scale(52 / 24, 52 / 24);
      ctx.fillStyle = on ? '#1f1638' : '#f1edf9'; ctx.fill(new Path2D(ICON_PATHS[t.icon] || ICON_PATHS.close)); ctx.restore();
      ctx.font = '600 26px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = on ? '#1f1638' : '#f1edf9'; ctx.fillText(t.label, x + w / 2, TH - 36);
    });
    this.ttex.needsUpdate = true;
  }

  /* ---------- Frame ---------- */
  _frame(t, frame) {
    if (!this.renderer.xr.isPresenting) { this.renderer.render(this.scene, this.camera); return; }
    if (this._needToolbar && frame) { this._needToolbar = false; this._placeToolbar(true); }
    // Ziel-Ring auf erkannten Flaechen
    if (this.hitSource && frame) {
      const hits = frame.getHitTestResults(this.hitSource);
      const pose = hits[0]?.getPose(this.renderer.xr.getReferenceSpace());
      this.reticle.visible = !!pose && this.phone;
      if (pose) this.reticle.matrix.fromArray(pose.transform.matrix);
    }
    // gesammelte Druecke mit aktueller Pose verarbeiten
    const pend = this.pending; this.pending = [];
    for (const e of pend) {
      if (e.kind === 'end') { const g = this.grabs.get(e.i); if (g) this._release(e.i); }
      else if (!this.grabs.has(e.i)) this._press(e.i, e.kind);
    }
    // gegriffene Wuerfel mitbewegen
    for (const [i, g] of this.grabs) {
      const inp = this.inputs[i];
      if (g.near) {
        const pt = this._point(inp);
        if (!pt) continue;
        g.cube.position.copy(pt.pos).add(g.offset.clone().applyQuaternion(pt.quat));
        g.cube.quaternion.copy(pt.quat).multiply(g.rel);
      } else {
        const m = new THREE.Matrix4().extractRotation(inp.ray.matrixWorld);
        const origin = new THREE.Vector3().setFromMatrixPosition(inp.ray.matrixWorld);
        const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(m);
        g.cube.position.copy(origin).addScaledVector(dir, g.dist);
      }
    }
    // Hervorheben, was man gerade greifen koennte
    let hoverTool = null;
    const hot = new Set([...this.grabs.values()].map((g) => g.cube));
    for (const inp of this.inputs) {
      if (!inp.mode) continue;
      const pt = this._point(inp);
      const c = pt && this._nearest(pt.pos, SIZE * 0.9 + 0.05);
      if (c) hot.add(c);
      if (this.toolbar.visible) {
        const h = this._rayHit(inp, [this.toolbar]);
        if (h) hoverTool = TOOLS[Math.min(TOOLS.length - 1, Math.floor(h.uv.x * TOOLS.length))].id;
      }
      if (inp.line.visible) {
        const h = this._rayHit(inp, [...this.cubes, ...(this.toolbar.visible ? [this.toolbar] : [])]);
        inp.line.scale.z = h ? h.distance : 0.6;
        if (h && h.object !== this.toolbar) hot.add(h.object);
      }
    }
    for (const c of this.cubes) c.material.emissive.setHex(hot.has(c) ? 0x333333 : 0x000000);
    if (hoverTool !== this.toolHover) { this.toolHover = hoverTool; this._drawToolbar(); }
    this.toolbar.visible = !this.phone;
    if (!this.phone) this._placeToolbar(false);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
    this.cubes.forEach((c) => { c.material.dispose(); c.children.forEach((k) => k.material.dispose()); });
    this.geo.dispose(); this.edges.dispose(); this.ttex.dispose();
    this.renderer.dispose(); this.renderer.domElement.remove();
  }
}

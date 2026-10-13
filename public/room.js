// Raum-Modus: Durchsicht ohne Video – Wuerfel und Figuren in den echten Raum stellen.
// - Objekte liegen im Raum und bleiben stehen, wenn man herumlaeuft; bewegt wird nur per Greifen.
// - Hand: Pinch/Greifen = festhalten, loslassen = abstellen. Controller: Grifftaste/Abzug
//   nah dran oder per Strahl aus der Ferne. Handy: Finger drauf und ziehen.
// - Figur (echtes 3D-Modell): Becken/Bauch greifen = ganze Figur bewegen/drehen; jedes andere
//   Koerperteil greifen = dieses Gelenk drehen (Oberarm, Unterarm, Oberschenkel, ...);
//   lila Punkte an Haenden/Fuessen ziehen = ganzer Arm/Bein folgt. "Pose ▸" schaltet Posen durch.
// - Schwerkraft: losgelassene Wuerfel fallen auf den Boden oder auf andere Wuerfel, Figuren auf den Boden.
// - Boden: Wuerfel und Figuren koennen nicht unter den Boden; nah am Boden losgelassene
//   Wuerfel legen sich flach hin. (Quest: Bodenhoehe aus der Begrenzung, kein Scan noetig.)
// - Dauerhafter Raum-Anker (Quest): Objekte stehen nach Neustart/App-Update wieder am selben Platz.
import * as THREE from 'three';
import { ICON_PATHS } from '/icons.js';
import { Figure, POSE_NAMES, loadFigureModel } from '/figure.js';

const SIZE = 0.2;                       // Wuerfel-Kantenlaenge in Metern
const COLORS = [0xb69cff, 0x7ee0b0, 0xffb86b, 0xff7a8a, 0x7cc4ff, 0xf5e17a];
const STORE = 'anja-room-items';
const OLD_STORE = 'anja-room-cubes';
const ANCHOR_KEY = 'anja-room-anchor';
const TW = 900, STATUS_H = 46, ROW_H = 124, COLS = 3;
const TOOLS = [
  { id: 'add', icon: 'add_box', label: 'Würfel +' },
  { id: 'fig', icon: 'person', label: 'Figur +' },
  { id: 'pose', icon: 'accessibility', label: 'Pose ▸' },
  { id: 'undo', icon: 'undo', label: 'Letztes weg' },
  { id: 'clear', icon: 'delete', label: 'Alle weg' },
  { id: 'exit', icon: 'close', label: 'Beenden' },
];
const TH = STATUS_H + Math.ceil(TOOLS.length / COLS) * ROW_H;
const UP = new THREE.Vector3(0, 1, 0);

// Drehung, die den Wuerfel flach hinlegt: die am meisten senkrechte Achse auf "oben" drehen
function alignTo(quat, n) {
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((a) => a.applyQuaternion(quat));
  let best = axes[0], bd = -1;
  for (const a of axes) { const d = Math.abs(a.dot(n)); if (d > bd) { bd = d; best = a; } }
  const from = best.clone().multiplyScalar(Math.sign(best.dot(n)) || 1);
  return new THREE.Quaternion().setFromUnitVectors(from, n).multiply(quat);
}

// wie weit ein gedrehter Wuerfel unter seine Mitte reicht
function halfHeight(quat) {
  const ax = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((a) => a.applyQuaternion(quat));
  return (SIZE / 2) * (Math.abs(ax[0].y) + Math.abs(ax[1].y) + Math.abs(ax[2].y));
}

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
    this.items = [];                    // Wuerfel und Figuren in Reihenfolge (fuer "Letztes weg")
    this.grabs = new Map();             // Eingabe-Index -> Griff
    this.pending = [];                  // Druecke: im naechsten Frame mit frischer Pose verarbeiten
    this.anchorM = new THREE.Matrix4(); // Raum-Anker (Welt <- Anker)
    this.anchored = false;
    this.vel = new Map();               // Fallgeschwindigkeit je Objekt
    loadFigureModel().catch(() => {});  // 3D-Modell schon mal laden

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
      ray.addEventListener('selectend', () => this.pending.push({ i, kind: 'end' }));
      ray.addEventListener('squeezestart', () => this.pending.push({ i, kind: 'squeeze' }));
      ray.addEventListener('squeezeend', () => this.pending.push({ i, kind: 'end' }));
      this.scene.add(ray, grip, hand);
      return inp;
    });

    // Ziel-Ring auf echten Flaechen (Hit-Test, v. a. am Handy)
    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    this.reticle.matrixAutoUpdate = false; this.reticle.visible = false;
    this.scene.add(this.reticle);

    this.floorY = 0;                        // Bodenhoehe (local-floor: 0)
    this.settling = new Map();              // Wuerfel -> Ausricht-Animation

    // Werkzeugleiste (Brille; am Handy gibt es Bildschirm-Knoepfe)
    this.tcanvas = document.createElement('canvas'); this.tcanvas.width = TW; this.tcanvas.height = TH;
    this.ttex = new THREE.CanvasTexture(this.tcanvas); this.ttex.colorSpace = THREE.SRGBColorSpace;
    this.toolbar = new THREE.Mesh(new THREE.PlaneGeometry(0.74, 0.74 * TH / TW),
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

  get cubes() { return this.items.filter((o) => !o.isFigure); }
  get figures() { return this.items.filter((o) => o.isFigure); }

  resize() {
    const w = this.container.clientWidth || innerWidth, h = this.container.clientHeight || innerHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w, h, false);
  }

  // overlay: HTML-Knoepfe fuers Handy (DOM-Overlay)
  async start(overlay) {
    const init = { optionalFeatures: ['local-floor', 'hand-tracking', 'hit-test', 'anchors'] };
    if (overlay) { init.optionalFeatures.push('dom-overlay'); init.domOverlay = { root: overlay }; }
    const session = await navigator.xr.requestSession('immersive-ar', init);
    try { await this.renderer.xr.setSession(session); }
    catch {
      // ohne Bodenhoehe: Boden grob 1,5 m unter dem Kopf, am Handy aus erkannten Flaechen genauer
      this.renderer.xr.setReferenceSpaceType('local'); await this.renderer.xr.setSession(session);
      this.floorY = -1.5; this.floorGuess = true;
    }
    this.session = session;
    this.phone = !!session.domOverlayState;
    this._needToolbar = true;          // erst im ersten Frame, wenn die Kopfposition bekannt ist
    this._anchorStep = 'start';        // Anker im ersten Frame holen/anlegen, dann laden
    this._t0 = performance.now();
    try {
      const viewer = await session.requestReferenceSpace('viewer');
      this.hitSource = await session.requestHitTestSource({ space: viewer });
    } catch { this.hitSource = null; }
    session.addEventListener('end', () => { this.hitSource = null; this.session = null; this.onEnd?.(); });
    return session;
  }

  end() { this.session?.end(); }

  /* ---------- Raum-Anker (Plaetze ueber Neustarts/Updates behalten) ---------- */
  async _anchorInit(frame) {
    const s = this.session, ref = this.renderer.xr.getReferenceSpace();
    const uuid = localStorage.getItem(ANCHOR_KEY);
    try {
      if (uuid && s.restorePersistentAnchor) { this.anchor = await s.restorePersistentAnchor(uuid); }
    } catch { this.anchor = null; }
    if (!this.anchor && frame.createAnchor) {
      try {
        this.anchor = await frame.createAnchor(new XRRigidTransform(), ref);
        const h = await this.anchor.requestPersistentHandle?.();
        if (h) {
          if (uuid && uuid !== h) s.deletePersistentAnchor?.(uuid).catch(() => {});
          localStorage.setItem(ANCHOR_KEY, h);
          this._newAnchor = true;   // neuer Anker: gespeicherte Plaetze passen nicht mehr dazu
        }
      } catch { this.anchor = null; }
    }
    this._anchorStep = 'wait';
  }

  _updateAnchor(frame) {
    if (!this.anchor || !frame) return false;
    const pose = frame.getPose(this.anchor.anchorSpace, this.renderer.xr.getReferenceSpace());
    if (!pose) return false;
    this.anchorM.fromArray(pose.transform.matrix);
    this.anchored = true;
    return true;
  }

  /* ---------- Objekte ---------- */
  addCube(pos, quat, color, silent = false) {
    const col = color ?? COLORS[this.cubes.length % COLORS.length];
    const m = new THREE.Mesh(this.geo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.45, metalness: 0.05, emissive: 0x000000 }));
    m.add(new THREE.LineSegments(this.edges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })));
    m.position.copy(pos);
    if (quat) m.quaternion.copy(quat);
    m.userData.color = col;
    this.scene.add(m); this.items.push(m);
    if (!silent) { this._floorClamp(m); this._save(); }   // faellt danach per Schwerkraft
    return m;
  }

  // Figur hinstellen, zum Betrachter gedreht, Fuesse auf dem Boden
  async addFigure(pos, yaw, joints, silent = false) {
    let gltf;
    try { gltf = await loadFigureModel(); } catch { this.note = 'Figur-Modell konnte nicht geladen werden'; this._drawToolbar(); return null; }
    const f = new Figure(gltf);
    f.position.copy(pos);
    if (yaw === undefined) {
      const cam = new THREE.Vector3().setFromMatrixPosition(this.renderer.xr.getCamera().matrixWorld);
      yaw = Math.atan2(cam.x - pos.x, cam.z - pos.z);
    }
    f.rotation.set(0, yaw, 0);
    if (joints) f.setJoints(joints);
    this.scene.add(f); this.items.push(f);
    f.measureBottom();
    if (!silent) { f.ground(this.floorY); this._save(); }
    this.activeFigure = f;
    return f;
  }

  removeItem(o) {
    if (!o) return;
    for (const [i, g] of this.grabs) if (g.obj === o || g.fig === o) this.grabs.delete(i);
    this.scene.remove(o);
    if (o.isFigure) o.dispose(); else { o.material.dispose(); o.children.forEach((c) => c.material.dispose()); }
    this.items = this.items.filter((c) => c !== o);
    if (this.activeFigure === o) this.activeFigure = this.figures.at(-1) || null;
    this._save();
  }

  clear() { [...this.items].forEach((c) => this.removeItem(c)); }
  undo() { this.removeItem(this.items[this.items.length - 1]); }

  nextPose() {
    const f = this.activeFigure || this.figures.at(-1);
    if (!f) { this.note = 'Erst eine Figur hinstellen'; this._drawToolbar(); return; }
    const k = (POSE_NAMES.indexOf(f.poseName) + 1) % POSE_NAMES.length;
    f.setPose(POSE_NAMES[k]);
    f.ground(this.floorY);
    this.note = `Pose: ${POSE_NAMES[k]} – Gelenke (lila Punkte) ziehen zum Anpassen`;
    this._drawToolbar(); this._save();
  }

  // Am Handy: auf die erkannte Flaeche (Ziel-Ring) bzw. vor die Kamera
  addInFront(kind = 'cube') {
    const cam = this.renderer.xr.getCamera();
    if (this.reticle.visible) {
      const p = new THREE.Vector3().setFromMatrixPosition(this.reticle.matrix);
      const q = new THREE.Quaternion().setFromRotationMatrix(this.reticle.matrix);
      const n = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      if (kind === 'fig') return this.addFigure(p.clone());
      return this.addCube(p.addScaledVector(n, SIZE / 2), q);
    }
    const p = new THREE.Vector3(0, 0, kind === 'fig' ? -1.5 : -0.8).applyMatrix4(cam.matrixWorld);
    return kind === 'fig' ? this.addFigure(p) : this.addCube(p);
  }

  // Speichern relativ zum Raum-Anker -> passt nach Neustart wieder an dieselbe Stelle
  _save() {
    if (this._loading || this._anchorStep !== 'done') return;
    const inv = this.anchorM.clone().invert();
    const loc = (o) => {
      const m = new THREE.Matrix4().compose(o.position, o.quaternion, new THREE.Vector3(1, 1, 1)).premultiply(inv);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(); m.decompose(p, q, new THREE.Vector3());
      return { p: p.toArray(), q: q.toArray() };
    };
    const data = { v: 2, anchored: this.anchored, items: this.items.map((o) => (o.isFigure
      ? { t: 'fig', ...loc(o), j: o.getJoints(), pose: o.poseName }
      : { t: 'cube', ...loc(o), c: o.userData.color })) };
    try { localStorage.setItem(STORE, JSON.stringify(data)); } catch {}
  }

  async _load() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORE)); } catch {}
    if (!data) {   // altes Format (nur Wuerfel, ohne Anker)
      let old = [];
      try { old = JSON.parse(localStorage.getItem(OLD_STORE)) || []; } catch {}
      data = { anchored: false, items: old.map((o) => ({ t: 'cube', p: o.p, q: o.q, c: o.c })) };
    }
    // nur mit demselben Anker umrechnen; sonst wie gespeichert hinstellen
    const M = data.anchored && this.anchored && !this._newAnchor ? this.anchorM : new THREE.Matrix4();
    this._loading = true;
    for (const o of data.items || []) {
      const m = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(o.p), new THREE.Quaternion().fromArray(o.q), new THREE.Vector3(1, 1, 1)).premultiply(M);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(); m.decompose(p, q, new THREE.Vector3());
      if (o.t === 'fig') {
        const f = await this.addFigure(p, 0, o.j, true);
        if (f) { f.quaternion.copy(q); f.poseName = o.pose || 'Stehen'; f.update(); f.measureBottom(); }
      } else this.addCube(p, q, o.c, true);
    }
    this._loading = false;
    if (this.items.length && M !== this.anchorM) this.note = '';
    else if (this.items.length) this.note = 'Am gespeicherten Platz wiederhergestellt';
    this._drawToolbar();
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

  _rayHit(inp, objects, recursive = false) {
    const m = new THREE.Matrix4().extractRotation(inp.ray.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(inp.ray.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(m);
    return this.raycaster.intersectObjects(objects, recursive)[0] || null;
  }

  // Was liegt nah an der Hand? Gelenk-Griff > Figur-Koerper > Wuerfel
  _nearTarget(pos, hand) {
    const reach = hand ? 0.05 : 0.07;
    let best = null, bd = reach;
    const w = new THREE.Vector3();
    for (const f of this.figures) for (const h of f.handles) {
      const d = h.getWorldPosition(w).distanceTo(pos);
      if (d < bd) { bd = d; best = { kind: 'handle', fig: f, handle: h, obj: h }; }
    }
    if (best) return best;
    let bs = null;
    for (const f of this.figures) {
      const sg = f.nearestSeg(pos);
      if (sg.dist < (hand ? 0.03 : 0.05) && (!bs || sg.dist < bs.sg.dist)) bs = { f, sg };
    }
    if (bs) return bs.sg.body ? { kind: 'fig', fig: bs.f, obj: bs.f }
      : { kind: 'seg', fig: bs.f, obj: bs.f, seg: bs.f.grabSeg(bs.sg.name, pos) };
    bd = SIZE * 0.9 + (hand ? 0.04 : 0.06);
    for (const c of this.cubes) {
      const d = c.position.distanceTo(pos);
      if (d < bd) { bd = d; best = { kind: 'cube', obj: c }; }
    }
    return best;
  }

  _toolAt(uv) {
    const x = uv.x * TW, y = (1 - uv.y) * TH;
    if (y < STATUS_H) return null;
    const k = Math.floor((y - STATUS_H) / ROW_H) * COLS + Math.floor(x / (TW / COLS));
    return TOOLS[k]?.id || null;
  }

  _press(i, kind) {
    const inp = this.inputs[i];
    if (!inp.mode) return;
    // 1) Werkzeugleiste
    if (this.toolbar.visible) {
      const h = this._rayHit(inp, [this.toolbar]);
      if (h) { const id = this._toolAt(h.uv); if (id) this._tool(id); return; }
    }
    // 2) nah greifen
    const pt = this._point(inp);
    if (pt) {
      const t = this._nearTarget(pt.pos, pt.hand);
      if (t) { this._grabNear(i, t, pt); return; }
    }
    // 3) per Strahl aus der Ferne greifen (Controller, Handy-Finger)
    const handles = this.figures.flatMap((f) => f.handles), parts = this.figures.flatMap((f) => f.parts);
    const hit = this._rayHit(inp, [...handles, ...parts, ...this.cubes]);
    if (hit) {
      this.vel.delete(this._figOf(hit.object) || hit.object);
      const o = hit.object;
      let t;
      if (o.userData.handle) t = { kind: 'handle', handle: o, obj: o, fig: this._figOf(o) };
      else if (parts.includes(o)) {
        const f = this._figOf(o); const sg = f.nearestSeg(hit.point);
        t = sg.body ? { kind: 'fig', fig: f, obj: f } : { kind: 'seg', fig: f, obj: f, seg: f.grabSeg(sg.name, hit.point) };
      }
      else t = { kind: 'cube', obj: o };
      this._grabRay(i, t, hit.distance);
      return;
    }
    // 4) ins Leere: neuen Wuerfel hinstellen
    if (kind !== 'select') return;
    if (pt && !pt.hand) {      // Controller zielt auf den Boden: genau dort hinsetzen
      const r = this.raycaster.ray;
      this._rayHit(inp, []);   // Strahl setzen
      if (r.direction.y < -0.05) {
        const tt = (this.floorY - r.origin.y) / r.direction.y;
        if (tt > 0 && tt < 6) {
          const p = r.origin.clone().addScaledVector(r.direction, tt);
          p.y = this.floorY + SIZE / 2;
          const yaw = Math.atan2(r.direction.x, r.direction.z);
          this.addCube(p, new THREE.Quaternion().setFromAxisAngle(UP, yaw));
          return;
        }
      }
    }
    if (pt) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(inp.ray.matrixWorld));
      this.addCube(pt.hand ? pt.pos.clone() : pt.pos.clone().addScaledVector(fwd, 0.35));
    } else if (this.phone) this.addInFront();
  }

  _figOf(o) { let p = o; while (p && !p.isFigure) p = p.parent; return p; }

  _grabNear(i, t, pt) {
    const g = { ...t, near: true };
    this.vel.delete(t.fig || t.obj);
    if (t.kind === 'handle' || t.kind === 'seg') {
      g.offset = t.handle.getWorldPosition(new THREE.Vector3()).sub(pt.pos);
    } else {
      const inv = pt.quat.clone().invert();
      g.offset = t.obj.position.clone().sub(pt.pos).applyQuaternion(inv);
      g.rel = inv.multiply(t.obj.quaternion.clone());
    }
    if (t.fig) this.activeFigure = t.fig;
    this.grabs.set(i, g);
    this._pulse(i, 0.5, 40);
  }

  _grabRay(i, t, dist) {
    const inp = this.inputs[i];
    const origin = new THREE.Vector3().setFromMatrixPosition(inp.ray.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(inp.ray.matrixWorld));
    const hitP = origin.clone().addScaledVector(dir, dist);
    const g = { ...t, near: false, dist };
    if (t.kind !== 'handle' && t.kind !== 'seg') g.offset = t.obj.position.clone().sub(hitP);
    if (t.fig) this.activeFigure = t.fig;
    this.grabs.set(i, g);
    this._pulse(i, 0.5, 40);
  }

  _release(i) {
    const g = this.grabs.get(i);
    if (!this.grabs.delete(i)) return;
    if (g.fig) {
      g.fig.measureBottom();
      // nicht im Boden stecken lassen; schwebt sie, faellt sie (Schwerkraft)
      if (g.fig.position.y + g.fig.bottom < this.floorY) g.fig.ground(this.floorY);
    }
    this._save(); this._pulse(i, 0.3, 20);
  }

  // nicht unter den Boden
  _floorClamp(cube) {
    const h = halfHeight(cube.quaternion);
    if (cube.position.y - h < this.floorY) cube.position.y = this.floorY + h;
  }

  // gelandet: flach hinlegen (sanft animiert)
  _settle(cube) {
    this.settling.set(cube, { q0: cube.quaternion.clone(), q1: alignTo(cube.quaternion, UP), t0: performance.now() });
  }

  // worauf ein Wuerfel fallen kann: Boden oder Oberseite eines Wuerfels darunter
  _support(cube) {
    let s = this.floorY;
    const bottom = cube.position.y - halfHeight(cube.quaternion);
    const held = new Set([...this.grabs.values()].map((g) => g.obj));
    for (const o of this.cubes) {
      if (o === cube || held.has(o)) continue;
      if (Math.abs(o.position.x - cube.position.x) < SIZE * 0.9 && Math.abs(o.position.z - cube.position.z) < SIZE * 0.9) {
        const top = o.position.y + halfHeight(o.quaternion);
        if (top <= bottom + 0.06 && top > s) s = top;
      }
    }
    return s;
  }

  // Schwerkraft: alles, was nicht gehalten wird, faellt bis zur Unterlage
  _gravity(dt) {
    const held = new Set([...this.grabs.values()].map((g) => g.fig || g.obj));
    for (const o of this.items) {
      if (held.has(o) || this.settling.has(o)) continue;
      const fig = o.isFigure;
      const bottom = fig ? o.position.y + (o.bottom ?? 0) : o.position.y - halfHeight(o.quaternion);
      const support = fig ? this.floorY : this._support(o);
      if (bottom > support + 0.002) {
        const v = (this.vel.get(o) || 0) + 9.81 * dt;
        this.vel.set(o, v);
        o.position.y -= Math.min(v * dt, bottom - support);
        if (fig) o.update();
        if (bottom - v * dt <= support + 0.002) {        // gelandet
          this.vel.delete(o);
          if (!fig) this._settle(o); else this._save();
        }
      } else if (bottom < support - 0.002) {             // steckt drin: obendrauf setzen
        o.position.y += support - bottom; if (fig) o.update();
      }
    }
  }

  _pulse(i, v, ms) { try { this.inputs[i].source?.gamepad?.hapticActuators?.[0]?.pulse(v, ms); } catch {} }

  _tool(id) {
    const cam = this.renderer.xr.getCamera();
    if (id === 'add') this.addCube(new THREE.Vector3(0, -0.15, -0.6).applyMatrix4(cam.matrixWorld));
    else if (id === 'fig') {
      this.note = 'Figur wird geladen …'; this._drawToolbar();
      this.addFigure(new THREE.Vector3(0, 0, -1.4).applyMatrix4(cam.matrixWorld)).then((f) => {
        if (f) { this.note = 'Bauch greifen = bewegen · Arm/Bein greifen = Gelenk drehen · lila Punkte = Hand/Fuß'; this._drawToolbar(); }
      });
    } else if (id === 'pose') this.nextPose();
    else if (id === 'undo') this.undo();
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
      const d = Math.atan2(Math.sin(yaw - this._tYaw), Math.cos(yaw - this._tYaw));
      if (Math.abs(d) < 0.7) return;
      this._tYaw += d * 0.08;
    } else this._tYaw = yaw;
    const f = new THREE.Vector3(Math.sin(this._tYaw), 0, Math.cos(this._tYaw));
    this.toolbar.position.copy(pos).addScaledVector(f, 0.75);
    this.toolbar.position.y = pos.y - 0.42;
    this.toolbar.lookAt(pos);
  }

  _drawToolbar() {
    const ctx = this.tcanvas.getContext('2d');
    ctx.clearRect(0, 0, TW, TH);
    const status = this.note || `Pinch/Abzug ins Leere: Würfel · Boden erkannt${this.anchored ? ' · Plätze werden gemerkt' : ''}`;
    ctx.font = '500 22px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const sw = Math.min(TW - 16, ctx.measureText(status).width + 36);
    ctx.fillStyle = 'rgba(22,19,31,0.85)';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect((TW - sw) / 2, 3, sw, 38, 19) : ctx.rect((TW - sw) / 2, 3, sw, 38); ctx.fill();
    ctx.fillStyle = '#f1edf9'; ctx.fillText(status, TW / 2, 22);
    const w = TW / COLS;
    TOOLS.forEach((t, k) => {
      const x = (k % COLS) * w, y = STATUS_H + Math.floor(k / COLS) * ROW_H;
      const on = this.toolHover === t.id;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x + 6, y + 4, w - 12, ROW_H - 10, 26) : ctx.rect(x + 6, y + 4, w - 12, ROW_H - 10);
      ctx.fillStyle = on ? 'rgba(182,156,255,0.92)' : 'rgba(22,19,31,0.85)'; ctx.fill();
      ctx.save(); ctx.translate(x + w / 2 - 22, y + 14); ctx.scale(44 / 24, 44 / 24);
      ctx.fillStyle = on ? '#1f1638' : '#f1edf9'; ctx.fill(new Path2D(ICON_PATHS[t.icon] || ICON_PATHS.close)); ctx.restore();
      ctx.font = '600 22px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = on ? '#1f1638' : '#f1edf9'; ctx.fillText(t.label, x + w / 2, y + ROW_H - 30);
    });
    this.ttex.needsUpdate = true;
  }

  /* ---------- Frame ---------- */
  _frame(t, frame) {
    if (!this.renderer.xr.isPresenting) { this.renderer.render(this.scene, this.camera); return; }
    if (this._needToolbar && frame) { this._needToolbar = false; this._placeToolbar(true); }
    // Raum-Anker holen/anlegen, danach die gespeicherten Objekte an ihren Platz stellen
    if (this._anchorStep === 'start' && frame) { this._anchorStep = 'busy'; this._anchorInit(frame); }
    const hasAnchor = this._updateAnchor(frame);
    if (this._anchorStep === 'wait' && (hasAnchor || performance.now() - this._t0 > 2500)) {
      this._anchorStep = 'loading';
      this._load().finally(() => { this._anchorStep = 'done'; this._save(); });
    }
    // Ziel-Ring auf erkannten Flaechen
    if (this.hitSource && frame) {
      const hits = frame.getHitTestResults(this.hitSource);
      const pose = hits[0]?.getPose(this.renderer.xr.getReferenceSpace());
      this.reticle.visible = !!pose && this.phone;
      if (pose) {
        this.reticle.matrix.fromArray(pose.transform.matrix);
        // ohne bekannte Bodenhoehe: tiefste waagrechte Flaeche unter dem Kopf ist der Boden
        if (this.floorGuess) {
          const n = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(this.reticle.matrix));
          const y = pose.transform.position.y;
          const head = new THREE.Vector3().setFromMatrixPosition(this.renderer.xr.getCamera().matrixWorld).y;
          if (n.y > 0.9 && y < head - 0.8 && (this._floorSeen === undefined || y < this._floorSeen)) { this._floorSeen = y; this.floorY = y; }
        }
      }
    }
    // gesammelte Druecke mit aktueller Pose verarbeiten
    const pend = this.pending; this.pending = [];
    for (const e of pend) {
      if (e.kind === 'end') this._release(e.i);
      else if (!this.grabs.has(e.i)) this._press(e.i, e.kind);
    }
    // gegriffene Objekte mitbewegen
    for (const [i, g] of this.grabs) {
      const inp = this.inputs[i];
      let target, quat = null;
      if (g.near) {
        const pt = this._point(inp);
        if (!pt) continue;
        if (g.kind === 'handle' || g.kind === 'seg') target = pt.pos.clone().add(g.offset);
        else { target = pt.pos.clone().add(g.offset.clone().applyQuaternion(pt.quat)); quat = pt.quat.clone().multiply(g.rel); }
      } else {
        const origin = new THREE.Vector3().setFromMatrixPosition(inp.ray.matrixWorld);
        const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(inp.ray.matrixWorld));
        target = origin.addScaledVector(dir, g.dist);
        if (g.offset) target.add(g.offset);
      }
      if (g.kind === 'handle') { g.fig.drag(g.handle, target); continue; }
      if (g.kind === 'seg') { g.fig.dragSeg(g.seg, target); continue; }
      g.obj.position.copy(target);
      if (g.kind === 'fig') {
        // Figur bleibt aufrecht: nur die Drehung um die Hochachse uebernehmen
        if (quat) { const e = new THREE.Euler().setFromQuaternion(quat, 'YXZ'); g.obj.rotation.set(0, e.y, 0); }
        if (g.obj.position.y + (g.obj.bottom ?? 0) < this.floorY) g.obj.position.y = this.floorY - g.obj.bottom;   // nicht in den Boden
        g.obj.update();
      } else {
        if (quat) g.obj.quaternion.copy(quat);
        this._floorClamp(g.obj);                                  // nicht unter den Boden
      }
    }
    // Schwerkraft
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this._lastT || now)) / 1000); this._lastT = now;
    this._gravity(dt);
    // sanft flach anlegen (auf Boden oder Wuerfel)
    for (const [c, a] of this.settling) {
      const k = Math.min(1, (now - a.t0) / 180);
      c.quaternion.slerpQuaternions(a.q0, a.q1, k);
      c.position.y = this._support(c) + halfHeight(c.quaternion);
      if (k >= 1) { this.settling.delete(c); this._save(); }
    }
    // Hervorheben, was man gerade greifen koennte
    let hoverTool = null;
    const hot = new Set(), hotHandles = new Set();
    for (const g of this.grabs.values()) { if (g.kind === 'handle') hotHandles.add(g.handle); else hot.add(g.fig || g.obj); }
    const handles = this.figures.flatMap((f) => f.handles), parts = this.figures.flatMap((f) => f.parts);
    for (const inp of this.inputs) {
      if (!inp.mode) continue;
      const pt = this._point(inp);
      const nt = pt && this._nearTarget(pt.pos, pt.hand);
      if (nt) { if (nt.kind === 'handle') hotHandles.add(nt.handle); else hot.add(nt.fig || nt.obj); }
      if (this.toolbar.visible) {
        const h = this._rayHit(inp, [this.toolbar]);
        if (h) hoverTool = this._toolAt(h.uv);
      }
      if (inp.line.visible) {
        const h = this._rayHit(inp, [...handles, ...parts, ...this.cubes, ...(this.toolbar.visible ? [this.toolbar] : [])]);
        inp.line.scale.z = h ? h.distance : 0.6;
        if (h && h.object !== this.toolbar) {
          if (h.object.userData.handle) hotHandles.add(h.object);
          else hot.add(parts.includes(h.object) ? this._figOf(h.object) : h.object);
        }
      }
    }
    for (const c of this.cubes) c.material.emissive.setHex(hot.has(c) ? 0x333333 : 0x000000);
    for (const f of this.figures) {
      f.parts.forEach((m) => m.material.emissive?.setHex(hot.has(f) ? 0x222222 : 0x000000));
      for (const h of f.handles) h.scale.setScalar(hotHandles.has(h) ? 0.042 : 0.028);
    }
    if (hoverTool !== this.toolHover) { this.toolHover = hoverTool; this._drawToolbar(); }
    this.toolbar.visible = !this.phone;
    if (!this.phone) this._placeToolbar(false);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
    for (const o of this.items) { if (o.isFigure) o.dispose(); else { o.material.dispose(); o.children.forEach((k) => k.material.dispose()); } }
    this.geo.dispose(); this.edges.dispose(); this.ttex.dispose();
    this.renderer.dispose(); this.renderer.domElement.remove();
  }
}

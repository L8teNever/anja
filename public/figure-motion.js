// Spiel-Modus einer Figur: Beruehrungs-Physik, Blick zum Spieler, Laufen, Hinsetzen, Hinlegen.
// Die Grundpose (base) setzen Posen/Animationen; darueber legt die Physik pro Gelenk eine
// gefederte Auslenkung (Feder + Daempfung). Haende/Controller sind Kollider: drueckt man
// z. B. gegen den Kopf, gibt er nach, nimmt Hals und Oberkoerper ein Stueck mit und federt zurueck.
import * as THREE from 'three';
import { POSES } from '/figure.js';

const D = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
const UP = new THREE.Vector3(0, 1, 0);

// Elternkette (fuer Weitergabe von Stoessen)
const PARENT = {
  head: 'neck', neck: 'chest', chest: 'spine', spine: 'root', root: null,
  lShoulder: 'chest', rShoulder: 'chest', lElbow: 'lShoulder', rElbow: 'rShoulder', lWrist: 'lElbow', rWrist: 'rElbow',
  lHip: 'root', rHip: 'root', lKnee: 'lHip', rKnee: 'rHip', lAnkle: 'lKnee', rAnkle: 'rKnee',
};
// Gelenk: [Steifigkeit, Daempfung, Traegheit, max. Auslenkung (rad)]
const PHYS = {
  root: [60, 13, 5, 0.22], spine: [40, 9, 1.6, 0.45], chest: [40, 9, 1.3, 0.45], neck: [26, 7, 0.35, 0.6], head: [22, 6, 0.25, 0.75],
  lShoulder: [26, 6, 0.4, 1.0], rShoulder: [26, 6, 0.4, 1.0], lElbow: [22, 5, 0.18, 1.0], rElbow: [22, 5, 0.18, 1.0],
  lWrist: [18, 4, 0.05, 0.8], rWrist: [18, 4, 0.05, 0.8],
  lHip: [45, 9, 1.0, 0.45], rHip: [45, 9, 1.0, 0.45], lKnee: [40, 8, 0.5, 0.45], rKnee: [40, 8, 0.5, 0.45],
  lAnkle: [35, 7, 0.1, 0.35], rAnkle: [35, 7, 0.1, 0.35],
};
// Koerperabschnitt -> Kapsel-Radius (wie SEGS in figure.js)
const SEG_R = { root: 0.16, spine: 0.15, chest: 0.15, neck: 0.06, head: 0.11, lShoulder: 0.06, rShoulder: 0.06, lElbow: 0.05, rElbow: 0.05,
  lWrist: 0.05, rWrist: 0.05, lHip: 0.09, rHip: 0.09, lKnee: 0.07, rKnee: 0.07, lAnkle: 0.06, rAnkle: 0.06 };
const PUSH_K = 600, PUSH_V = 10, PASS = 0.45;   // Druck je m Eindringen, je m/s, Anteil an das Elterngelenk

const ease = (t) => t * t * (3 - 2 * t);
const yawOf = (d) => Math.atan2(d[0] ?? d.x, d[1] ?? d.z);
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// Gang-Pose zur Phase (Figurraum: vorne +Z, links +X)
function walkPose(ph, amt = 1) {
  const leg = (p, side) => {
    const s = Math.sin(p), c = Math.cos(p);
    return {
      hip: D(0.04 * side, -1, 0.45 * s * amt),
      knee: D(0.02 * side, -1, (0.45 * s - 0.85 * Math.max(0, c)) * amt),
    };
  };
  const L = leg(ph, 1), R = leg(ph + Math.PI, -1), s = Math.sin(ph);
  return {
    lHip: L.hip, lKnee: L.knee, rHip: R.hip, rKnee: R.knee,
    lShoulder: D(0.16, -1, -0.32 * s * amt), lElbow: D(0.1, -1, (-0.32 * s + 0.3) * amt),
    rShoulder: D(-0.16, -1, 0.32 * s * amt), rElbow: D(-0.1, -1, (0.32 * s + 0.3) * amt),
  };
}

export class Motion {
  constructor(fig) {
    this.f = fig;
    this.theta = {}; this.omega = {};
    for (const k of Object.keys(fig.j)) { this.theta[k] = new THREE.Vector3(); this.omega[k] = new THREE.Vector3(); }
    this.tasks = [];
    this.look = 0;          // Blick zum Spieler (0..1, weich)
    this.state = 'stand';   // stand | sit | lie (fuer das Menue)
    this.captureBase();
  }

  get busy() { return this.tasks.length > 0; }

  captureBase() {
    this.base = {};
    for (const [k, j] of Object.entries(this.f.j)) this.base[k] = j.quaternion.clone();
    this.rootPos = this.f.j.root.position.clone();
  }

  // Physik-Auslenkung entfernen (z. B. vor dem Bau-Modus)
  reset() {
    for (const k of Object.keys(this.theta)) { this.theta[k].set(0, 0, 0); this.omega[k].set(0, 0, 0); }
    for (const [k, q] of Object.entries(this.base)) this.f.j[k].quaternion.copy(q);
    this.f.j.root.position.copy(this.rootPos);
    this.tasks = []; this.look = 0;
    this.f.updateMatrixWorld(true); this.f.update();
  }

  /* ---------- Zustaende berechnen (ohne sichtbar zu springen) ---------- */
  _snap() { return { j: this.f.getJoints(), p: this.f.position.clone(), q: this.f.quaternion.clone(), name: this.f.poseName }; }
  _restore(s) { this.f.position.copy(s.p); this.f.quaternion.copy(s.q); this.f.setJoints(s.j); this.f.poseName = s.name; }

  // Ziel-Zustand: Pose an einem Ort ausrechnen und zurueckgeben
  _solve(poseName, yaw, place) {
    const keep = this._snap();
    this.f.quaternion.setFromAxisAngle(UP, yaw);
    this.f.setPose(poseName);
    place(this.f);
    const out = this._snap();
    this._restore(keep);
    return out;
  }

  // Stehend auf dem Boden an (x, z)
  solveStand(x, z, yaw, floorY) {
    return this._solve('Stehen', yaw, (f) => { f.position.set(x, f.position.y, z); f.ground(floorY); });
  }

  // Sitzend: Gesaess auf dem Sitzpunkt, Blick nach aussen, Fuesse auf dem Boden
  solveSit(spot, floorY) {
    const yaw = yawOf(spot.dir);
    return this._solve('Stuhl', yaw, (f) => {
      f.position.set(0, 0, 0); f.updateMatrixWorld(true);
      const hp = f.j.root.getWorldPosition(new THREE.Vector3());
      f.position.set(spot.seat.x - hp.x, 0, spot.seat.z - hp.z);
      // Gesaess = tiefster Punkt hinter den Knien
      const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const kz = (s) => f.j[s].getWorldPosition(new THREE.Vector3()).dot(fwd);
      const lim = Math.min(kz('lKnee'), kz('rKnee')) - 0.12;
      const seatY = f.lowestWhere((v) => v.dot(fwd) < lim);
      f.position.y += spot.seat.y - seatY;
      f.updateMatrixWorld(true);
      // Fuesse auf den Boden (wenn moeglich)
      for (const h of f.handles) {
        if (h.userData.kind !== 'ikLeg') continue;
        const p = f._handlePos(h);
        f.drag(h, new THREE.Vector3(p.x + fwd.x * 0.04, floorY + f.ankleH * 0.6, p.z + fwd.z * 0.04));
      }
    });
  }

  // Liegend auf dem Ruecken, laengs der Flaeche, Kopf zum Ende weiter weg von 'away'
  solveLie(spot, away) {
    let ax = spot.axis;
    const toAway = [away.x - spot.center.x, away.z - spot.center.z];
    if (ax[0] * toAway[0] + ax[1] * toAway[1] > 0) ax = [-ax[0], -ax[1]];   // Fuesse zum Spieler, Kopf weg
    // Liegen dreht das Becken so, dass der Kopf nach -Z der Figur zeigt
    const yaw = Math.atan2(-ax[0], -ax[1]);
    return this._solve('Liegen', yaw, (f) => {
      f.position.set(0, 0, 0); f.measureBottom();
      const c = f.box.getCenter(new THREE.Vector3());
      f.position.set(spot.center.x - c.x, spot.center.y - f.box.min.y + 0.01, spot.center.z - c.z);
      f.updateMatrixWorld(true); f.update();
    });
  }

  /* ---------- Aufgaben ---------- */
  clearTasks() { this.tasks = []; }
  // aus einer call-Aufgabe heraus eingereihte Aufgaben kommen direkt als naechstes dran
  queue(...t) { if (this._inCall) { this.tasks.splice(this._ins, 0, ...t); this._ins += t.length; } else this.tasks.push(...t); }

  // Weg ablaufen: path = Punkte [x,z] oder Funktion, die den Weg erst beim Loslaufen rechnet
  walk(path, floorY, onFail) { this.queue({ type: 'walk', path, floorY, ph: 0, onFail }); }
  turn(yaw) { this.queue({ type: 'turn', yaw }); }
  // weicher Uebergang in einen Zustand (lazy: Funktion, die den Zustand erst beim Start rechnet)
  blend(target, dur = 0.8, after) { this.queue({ type: 'blend', target, dur, after }); }
  call(fn) { this.queue({ type: 'call', fn }); }

  _startBlend(t) {
    t.to = typeof t.target === 'function' ? t.target() : t.target;
    t.from = this._snap(); t.t = 0;
    t.fromQ = Object.fromEntries(Object.entries(this.base).map(([k, q]) => [k, q.clone()]));
    t.toQ = Object.fromEntries(Object.entries(t.to.j).map(([k, a]) => [k, new THREE.Quaternion().fromArray(a)]));
  }

  // Fussboden-Korrektur beim Laufen: tiefstes Fussgelenk auf Hoehe 'ankle' ueber dem Boden
  _plant(floorY) {
    this.f.updateMatrixWorld(true);
    const y = Math.min(this.f.j.lAnkle.getWorldPosition(new THREE.Vector3()).y, this.f.j.rAnkle.getWorldPosition(new THREE.Vector3()).y);
    this.f.position.y += floorY + this.f.ankleH - y;
  }

  _runTask(dt) {
    const t = this.tasks[0];
    if (!t) return;
    const f = this.f;
    if (t.type === 'call') { this.tasks.shift(); this._inCall = true; this._ins = 0; try { t.fn(); } finally { this._inCall = false; } return; }
    if (t.type === 'turn') {
      const cur = new THREE.Euler().setFromQuaternion(f.quaternion, 'YXZ').y;
      const d = angDiff(cur, t.yaw), step = Math.sign(d) * Math.min(Math.abs(d), 2.6 * dt);
      f.quaternion.setFromAxisAngle(UP, cur + step);
      // kleine Schritte beim Drehen
      t.ph = (t.ph || 0) + dt * 7;
      f.setPoseDirs({ ...POSES.Stehen, ...walkPose(t.ph, 0.35) }, 'Gehen'); this.captureBase();
      if (t.floorY !== undefined) this._plant(t.floorY);
      if (Math.abs(d) < 0.02) { f.setPose('Stehen'); this.captureBase(); this.tasks.shift(); }
      return;
    }
    if (t.type === 'walk') {
      if (typeof t.path === 'function' || !t.started) {
        t.started = true;
        const p = typeof t.path === 'function' ? t.path() : t.path;
        if (!p) { this.tasks = []; f.setPose('Stehen'); this.captureBase(); t.onFail?.(); return; }
        t.path = p.slice(1);
      }
      if (!t.path.length) { f.setPose('Stehen'); this.captureBase(); this._plant(t.floorY); this.tasks.shift(); return; }
      const [tx, tz] = t.path[0];
      const p = f.position, dx = tx - p.x, dz = tz - p.z, dist = Math.hypot(dx, dz);
      const want = Math.atan2(dx, dz), cur = new THREE.Euler().setFromQuaternion(f.quaternion, 'YXZ').y;
      const d = angDiff(cur, want);
      f.quaternion.setFromAxisAngle(UP, cur + Math.sign(d) * Math.min(Math.abs(d), 3.2 * dt));
      const speed = Math.abs(d) > 1.0 ? 0.08 : 0.7 * (1 - Math.min(0.6, Math.abs(d)));   // erst drehen, dann gehen
      const step = Math.min(dist, speed * dt);
      if (dist > 1e-4) { p.x += (dx / dist) * step; p.z += (dz / dist) * step; }
      t.ph += (step / 1.25) * Math.PI * 2 + (speed < 0.1 ? dt * 5 : 0);
      f.setPoseDirs({ ...POSES.Stehen, ...walkPose(t.ph) }, 'Gehen'); this.captureBase();
      this._plant(t.floorY);
      if (dist < 0.03) t.path.shift();
      return;
    }
    if (t.type === 'blend') {
      if (!t.to) this._startBlend(t);
      t.t = Math.min(1, t.t + dt / t.dur);
      const k = ease(t.t);
      for (const [n, q] of Object.entries(t.toQ)) this.base[n] = t.fromQ[n].clone().slerp(q, k);
      f.position.lerpVectors(t.from.p, t.to.p, k);
      f.quaternion.slerpQuaternions(t.from.q, t.to.q, k);
      if (t.t >= 1) { f.poseName = t.to.name; this.tasks.shift(); t.after?.(); }
    }
  }

  /* ---------- pro Frame ---------- */
  // colliders: [{ p: Vector3 (Welt), v: Vector3 (m/s), r }], viewer: Kopfposition des Spielers
  update(dt, colliders, viewer) {
    dt = Math.min(dt, 0.05);
    this._runTask(dt);
    const f = this.f;
    // Grundpose setzen, dann Kraefte aus Beruehrungen messen
    for (const [k, q] of Object.entries(this.base)) f.j[k].quaternion.copy(q);
    f.updateMatrixWorld(true);
    const torque = {};
    if (colliders.length) {
      const seg = new THREE.Line3(), q = new THREE.Vector3(), jp = new THREE.Vector3(), cp = new THREE.Vector3();
      for (const c of colliders) {
        for (const [name, r] of Object.entries(SEG_R)) {
          seg.set(f.j[name].getWorldPosition(jp), f.c[name].getWorldPosition(cp));
          seg.closestPointToPoint(c.p, true, q);
          const dist = q.distanceTo(c.p), pen = r + c.r - dist;
          if (pen <= 0) continue;
          const n = q.clone().sub(c.p); if (n.lengthSq() < 1e-10) n.copy(c.v); n.normalize();   // Richtung: von der Hand in den Koerper
          const mag = PUSH_K * pen + PUSH_V * Math.max(0, c.v.dot(n));
          const contact = c.p.clone().addScaledVector(n, c.r);
          let k = name, share = 1;
          while (k && share > 0.05) {
            const pivot = f.j[k].getWorldPosition(new THREE.Vector3());
            const tq = contact.clone().sub(pivot).cross(n.clone().multiplyScalar(mag * share));
            (torque[k] || (torque[k] = new THREE.Vector3())).add(tq);
            k = PARENT[k]; share *= PASS;
          }
        }
      }
    }
    // Federn integrieren (in Gelenk-Koordinaten)
    let moving = false;
    for (const k of Object.keys(this.base)) {
      const [K, Dm, I, max] = PHYS[k] || PHYS.spine;
      const th = this.theta[k], om = this.omega[k];
      const acc = th.clone().multiplyScalar(-K).addScaledVector(om, -Dm);
      if (torque[k]) {
        const local = torque[k].clone().applyQuaternion(f.j[k].getWorldQuaternion(new THREE.Quaternion()).invert());
        acc.addScaledVector(local, 1 / I);
      }
      om.addScaledVector(acc, dt);
      th.addScaledVector(om, dt);
      if (th.length() > max) { th.setLength(max); om.multiplyScalar(0.5); }
      if (th.lengthSq() > 1e-8 || om.lengthSq() > 1e-8) moving = true;
    }
    // Blick zum Spieler (nur stehend/sitzend, nicht beim Liegen)
    const wantLook = viewer && this.state !== 'lie' ? 1 : 0;
    this.look += (wantLook - this.look) * Math.min(1, dt * 2.5);
    // Auslenkungen anwenden
    if (moving) {
      const dq = new THREE.Quaternion();
      for (const k of Object.keys(this.base)) {
        const th = this.theta[k], a = th.length();
        if (a < 1e-6) continue;
        dq.setFromAxisAngle(th.clone().divideScalar(a), a);
        f.j[k].quaternion.multiply(dq);
      }
      f.updateMatrixWorld(true);
    }
    if (this.look > 0.01 && viewer) this._lookAt(viewer, this.look);
    f.update();
  }

  // Kopf (60 %) und Hals (40 %) drehen sich zum Spieler, begrenzt auf 65 Grad
  _lookAt(target, w) {
    const f = this.f;
    const hp = f.j.head.getWorldPosition(new THREE.Vector3());
    const want = target.clone().sub(hp).normalize(), face = f.faceDir();
    let ang = face.angleTo(want);
    if (ang < 1e-3) return;
    const lim = THREE.MathUtils.degToRad(65);
    if (ang > lim + 0.6) return;                                      // Spieler hinter ihr: nicht verrenken
    const axis = face.clone().cross(want).normalize();
    ang = Math.min(ang, lim) * w;
    for (const [k, part] of [['neck', 0.4], ['head', 0.6]]) {
      const j = f.j[k];
      const r = new THREE.Quaternion().setFromAxisAngle(axis, ang * part);
      const wq = j.getWorldQuaternion(new THREE.Quaternion());
      const pq = j.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      j.quaternion.copy(pq.multiply(r.multiply(wq)));
      j.updateMatrixWorld(true);
    }
  }
}

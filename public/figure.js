// Weibliche Gliederpuppe (Zeichenpuppen-Stil, aus einfachen Formen gebaut) mit Gelenken.
// - ganze Figur: am Becken/Rumpf greifen -> verschieben/drehen (macht room.js)
// - Hand/Fuss ziehen: Arm/Bein folgt (Zwei-Knochen-IK, Ellbogen/Knie knicken natuerlich)
// - Ellbogen/Knie ziehen: Knickrichtung aendern (Oberarm/Oberschenkel zeigt dorthin)
// - Kopf ziehen: Kopf dreht sich hin; Brust ziehen: Oberkoerper beugt sich
// Vorne = +Z, oben = +Y. Gliedmassen zeigen in ihrer Grundstellung nach unten (-Y).
import * as THREE from 'three';

const SKIN = 0xd9b89c, JOINT = 0xb69cff;
const DOWN = new THREE.Vector3(0, -1, 0), UP = new THREE.Vector3(0, 1, 0);

// Posen: lokale Drehungen in Grad [x, y, z] je Gelenk (fehlende = 0); root.y = Beckenhoehe-Anpassung
export const POSES = {
  Stehen: { lShoulder: [0, 0, 8], rShoulder: [0, 0, -8] },
  'Arme hoch': { lShoulder: [0, 0, 165], rShoulder: [0, 0, -165], lElbow: [0, 0, 10], rElbow: [0, 0, -10] },
  Sitzen: { lHip: [-90, 0, 4], rHip: [-90, 0, -4], lKnee: [90, 0, 0], rKnee: [90, 0, 0], lShoulder: [-20, 0, 8], rShoulder: [-20, 0, -8], lElbow: [-50, 0, 0], rElbow: [-50, 0, 0] },
  Knien: { lKnee: [90, 0, 0], rKnee: [90, 0, 0], lShoulder: [0, 0, 8], rShoulder: [0, 0, -8] },
  Hocke: { lHip: [-120, 0, 10], rHip: [-120, 0, -10], lKnee: [140, 0, 0], rKnee: [140, 0, 0], spine: [25, 0, 0], lShoulder: [-60, 0, 10], rShoulder: [-60, 0, -10] },
  Liegen: { root: [-90, 0, 0], lShoulder: [0, 0, 20], rShoulder: [0, 0, -20] },
};
export const POSE_NAMES = Object.keys(POSES);

export class Figure extends THREE.Group {
  constructor() {
    super();
    this.isFigure = true;
    this.mat = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.6, metalness: 0.02 });
    this.hmat = new THREE.MeshStandardMaterial({ color: JOINT, roughness: 0.4, emissive: 0x000000, transparent: true, opacity: 0.85 });
    this.parts = [];      // Koerperteile (Greifen der ganzen Figur)
    this.handles = [];    // Gelenk-Griffe
    this.j = {};          // Gelenke nach Name

    const J = (name, parent, x, y, z) => { const o = new THREE.Object3D(); o.name = name; o.position.set(x, y, z); parent.add(o); this.j[name] = o; return o; };
    const blob = (parent, sx, sy, sz, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(this._sphere(), this.mat); m.scale.set(sx / 2, sy / 2, sz / 2); m.position.set(x, y, z);
      parent.add(m); this.parts.push(m); return m;
    };
    const limb = (parent, r, len, dir = -1) => {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, len - 2 * r), 6, 12), this.mat);
      m.position.y = (dir * len) / 2; parent.add(m); this.parts.push(m); return m;
    };

    // Rumpf (Becken = Wurzel)
    const root = J('root', this, 0, 0.93, 0);
    blob(root, 0.34, 0.2, 0.22, 0, -0.02, 0);                       // Becken/Huefte
    const spine = J('spine', root, 0, 0.07, 0);
    blob(spine, 0.25, 0.2, 0.17, 0, 0.08, 0);                        // Taille
    const chest = J('chest', spine, 0, 0.2, 0);
    blob(chest, 0.31, 0.24, 0.19, 0, 0.08, 0);                       // Brustkorb
    blob(chest, 0.12, 0.11, 0.1, 0.068, 0.04, 0.08);                 // Brust
    blob(chest, 0.12, 0.11, 0.1, -0.068, 0.04, 0.08);
    const neck = J('neck', chest, 0, 0.2, 0);
    limb(neck, 0.038, 0.11, 1);
    const head = J('head', neck, 0, 0.1, 0);
    blob(head, 0.155, 0.21, 0.185, 0, 0.1, 0.01);                    // Kopf
    blob(head, 0.165, 0.09, 0.19, 0, 0.17, -0.015);                  // Haaransatz/Hinterkopf

    // Arme (links = +X)
    for (const [s, x] of [['l', 1], ['r', -1]]) {
      const sh = J(`${s}Shoulder`, chest, 0.17 * x, 0.15, 0);
      blob(sh, 0.09, 0.09, 0.09);
      limb(sh, 0.043, 0.27);
      const el = J(`${s}Elbow`, sh, 0, -0.27, 0);
      limb(el, 0.037, 0.24);
      const wr = J(`${s}Wrist`, el, 0, -0.24, 0);
      blob(wr, 0.065, 0.16, 0.035, 0, -0.08, 0.005);                 // Hand
      // Beine
      const hip = J(`${s}Hip`, root, 0.09 * x, -0.06, 0);
      limb(hip, 0.072, 0.43);
      const kn = J(`${s}Knee`, hip, 0, -0.43, 0);
      limb(kn, 0.05, 0.42);
      const an = J(`${s}Ankle`, kn, 0, -0.42, 0);
      blob(an, 0.08, 0.06, 0.22, 0, -0.03, 0.06);                    // Fuss
    }

    // Griffe an den Gelenken
    const grip = (name, onJoint, kind, pos = [0, 0, 0]) => {
      const h = new THREE.Mesh(this._sphere(), this.hmat); h.scale.setScalar(0.022);
      h.position.set(...pos); this.j[onJoint].add(h);
      h.userData = { handle: name, kind }; this.handles.push(h); return h;
    };
    grip('head', 'head', 'look', [0, 0.1, 0.11]);
    grip('chest', 'chest', 'bend', [0, 0.08, 0.12]);
    for (const s of ['l', 'r']) {
      grip(`${s}Hand`, `${s}Wrist`, 'ikArm', [0, -0.09, 0]);
      grip(`${s}Elbow`, `${s}Elbow`, 'aimUpper', [0, 0, -0.045]);
      grip(`${s}Foot`, `${s}Ankle`, 'ikLeg', [0, -0.03, 0.06]);
      grip(`${s}Knee`, `${s}Knee`, 'aimThigh', [0, 0, 0.06]);
    }
    this.setPose('Stehen');
  }

  _sphere() { return Figure._sph || (Figure._sph = new THREE.SphereGeometry(1, 20, 14)); }

  /* ---------- Posen ---------- */
  setPose(name) {
    const p = POSES[name] || {};
    for (const [k, o] of Object.entries(this.j)) {
      const r = p[k] || [0, 0, 0];
      o.quaternion.setFromEuler(new THREE.Euler(...r.map(THREE.MathUtils.degToRad), 'XYZ'));
    }
    this.poseName = name;
    this.updateMatrixWorld(true);
  }

  getJoints() { const o = {}; for (const [k, j] of Object.entries(this.j)) o[k] = j.quaternion.toArray(); return o; }
  setJoints(o) { for (const [k, q] of Object.entries(o || {})) this.j[k]?.quaternion.fromArray(q); this.updateMatrixWorld(true); }

  /* ---------- Gelenke ziehen ---------- */
  // Knochen eines Gelenks (lokale Achse axis) in Weltrichtung zum Ziel drehen, Verdrehung bleibt
  _aim(joint, target, axis = DOWN) {
    const jp = joint.getWorldPosition(new THREE.Vector3());
    const w = target.clone().sub(jp);
    if (w.lengthSq() < 1e-8) return;
    w.normalize();
    const q0 = joint.getWorldQuaternion(new THREE.Quaternion());
    const d0 = axis.clone().applyQuaternion(q0);
    const qw = new THREE.Quaternion().setFromUnitVectors(d0, w).multiply(q0);
    const pq = joint.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    joint.quaternion.copy(pq.multiply(qw));
    joint.updateMatrixWorld(true);
  }

  // Zwei-Knochen-IK: a (Schulter/Huefte) -> b (Ellbogen/Knie) -> Ziel; Knick zur Pol-Seite
  _ik2(ja, jb, jc, target, pole) {
    const a = ja.getWorldPosition(new THREE.Vector3());
    const b = jb.getWorldPosition(new THREE.Vector3());
    const c = jc.getWorldPosition(new THREE.Vector3());
    const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
    const t = target.clone();
    let d = t.distanceTo(a);
    const maxD = (l1 + l2) * 0.999, minD = Math.abs(l1 - l2) + 1e-3;
    const dir = t.clone().sub(a).normalize();
    d = Math.min(maxD, Math.max(minD, d));
    t.copy(a).addScaledVector(dir, d);
    const cosA = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
    const angA = Math.acos(cosA);
    // Knickebene aus Ziel-Richtung und Pol
    let n = dir.clone().cross(pole.clone().sub(a));
    if (n.lengthSq() < 1e-8) n = dir.clone().cross(new THREE.Vector3(1, 0, 0));
    n.normalize();
    const toElbow = dir.clone().applyAxisAngle(n, angA);
    const elbow = a.clone().addScaledVector(toElbow, l1);
    this._aim(ja, elbow);
    this._aim(jb, t);
  }

  // Griff zu einer Weltposition ziehen
  drag(handle, target) {
    const { handle: name, kind } = handle.userData;
    const s = name[0];
    if (kind === 'ikArm' || kind === 'ikLeg') {
      const arm = kind === 'ikArm';
      const [a, b, c] = arm ? [`${s}Shoulder`, `${s}Elbow`, `${s}Wrist`] : [`${s}Hip`, `${s}Knee`, `${s}Ankle`];
      const back = new THREE.Vector3(0, 0, arm ? -0.15 : 0.15).applyQuaternion(this.getWorldQuaternion(new THREE.Quaternion()));
      // Der Griff sitzt auf Hand/Fuss, nicht im Gelenk: Versatz mitrechnen (3 Durchlaeufe genuegen)
      for (let k = 0; k < 3; k++) {
        const off = handle.getWorldPosition(new THREE.Vector3()).sub(this.j[c].getWorldPosition(new THREE.Vector3()));
        const pole = this.j[b].getWorldPosition(new THREE.Vector3()).add(back);
        this._ik2(this.j[a], this.j[b], this.j[c], target.clone().sub(off), pole);
      }
    } else if (kind === 'aimUpper') this._aim(this.j[`${s}Shoulder`], target);
    else if (kind === 'aimThigh') this._aim(this.j[`${s}Hip`], target);
    else if (kind === 'look') this._aim(this.j.neck, target, UP);
    else if (kind === 'bend') this._aim(this.j.spine, target, UP);
  }

  // Figur auf den Boden stellen (tiefster Punkt auf floorY)
  ground(floorY = 0) {
    this.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const p of this.parts) box.expandByObject(p);
    this.position.y += floorY - box.min.y;
    this.updateMatrixWorld(true);
  }

  highlight(handle) { for (const h of this.handles) h.scale.setScalar(h === handle ? 0.032 : 0.022); }

  dispose() {
    this.traverse((o) => { if (o.geometry && o.geometry !== Figure._sph) o.geometry.dispose(); });
    this.mat.dispose(); this.hmat.dispose();
  }
}

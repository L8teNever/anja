// Bewegliche Figur mit echtem 3D-Modell (models/*.glb, alle mit demselben Mixamo-Skelett).
// michelle.glb kommt aus den three.js-Beispielen; die anderen wurden mit tools/autorig.js
// auf Michelles Skelett geriggt, deshalb funktionieren Posen und Griffe bei allen gleich.
// Bewegen:
//  - Becken/Bauch greifen: ganze Figur verschieben/drehen (macht room.js)
//  - jedes Koerperteil greifen: Oberarm dreht die Schulter, Unterarm den Ellbogen, Oberschenkel
//    die Huefte, Unterschenkel das Knie, Brust beugt den Oberkoerper, Kopf dreht den Kopf
//  - Griffpunkte an Haenden/Fuessen: ganzer Arm/Bein folgt (Zwei-Knochen-IK)
//  - Griffpunkte an Ellbogen/Knien: Knickrichtung
// Posen werden als Richtungen je Knochen beschrieben (funktioniert unabhaengig vom Skelett).
// Vorne = +Z, oben = +Y, links (der Figur) = +X.
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/GLTFLoader.js';
import * as SkeletonUtils from '/vendor/SkeletonUtils.js';

export const MODELS = [
  { id: 'michelle', name: 'Michelle', url: '/models/michelle.glb' },
  { id: 'tsunade', name: 'Tsunade', url: '/models/tsunade.glb' },
  { id: 'miss-white', name: 'Miss White', url: '/models/miss-white.glb' },
  { id: 'mei', name: 'Mei', url: '/models/mei.glb', family: 'mei' },   // eigenes Skelett (andere Grundpose)
];
// Quest-freundlich: Physical-Material (Spiegelung, IOR) -> Standard, Transparenz -> Alpha-Test (keine Sortierung)
function lightMaterial(m) {
  let out;
  if (m.isMeshPhysicalMaterial) {
    out = new THREE.MeshStandardMaterial();
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'color', 'roughness',
      'metalness', 'emissive', 'side', 'alphaTest', 'transparent', 'opacity', 'normalScale', 'name']) if (m[k] !== undefined) out[k] = m[k]?.clone && !m[k].isTexture ? m[k].clone() : m[k];
  } else out = m.clone();
  if (out.transparent && (out.map || out.alphaMap)) { out.transparent = false; out.alphaTest = Math.max(out.alphaTest || 0, 0.4); out.depthWrite = true; }
  return out;
}
export const modelInfo = (id) => MODELS.find((m) => m.id === id) || MODELS[0];
const B = (n) => `mixamorig${n}`;

// Logische Gelenke -> Knochen; dir = Knochen, dessen Lage die Richtung bestimmt (Kind)
const RIG = {
  root: ['Hips', 'Spine'], spine: ['Spine', 'Spine2'], chest: ['Spine2', 'Neck'], neck: ['Neck', 'Head'], head: ['Head', 'HeadTop_End'],
  lShoulder: ['LeftArm', 'LeftForeArm'], lElbow: ['LeftForeArm', 'LeftHand'], lWrist: ['LeftHand', 'LeftHandMiddle1'],
  rShoulder: ['RightArm', 'RightForeArm'], rElbow: ['RightForeArm', 'RightHand'], rWrist: ['RightHand', 'RightHandMiddle1'],
  lHip: ['LeftUpLeg', 'LeftLeg'], lKnee: ['LeftLeg', 'LeftFoot'], lAnkle: ['LeftFoot', 'LeftToeBase'],
  rHip: ['RightUpLeg', 'RightLeg'], rKnee: ['RightLeg', 'RightFoot'], rAnkle: ['RightFoot', 'RightToeBase'],
};
// Greifbare Koerperabschnitte: Gelenk, Radius; 'body' = ganze Figur
const SEGS = [
  ['root', 0.17, 'body'], ['spine', 0.16, 'body'], ['chest', 0.15], ['neck', 0.07], ['head', 0.13],
  ['lShoulder', 0.07], ['lElbow', 0.06], ['lWrist', 0.06], ['rShoulder', 0.07], ['rElbow', 0.06], ['rWrist', 0.06],
  ['lHip', 0.1], ['lKnee', 0.08], ['lAnkle', 0.07], ['rHip', 0.1], ['rKnee', 0.08], ['rAnkle', 0.07],
];

// Posen: Richtung je Gelenk (Figurraum), root = zusaetzliche Drehung des Beckens in Grad [x, y, z]
const D = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
const ARMS_DOWN = { lShoulder: D(0.18, -1, 0.04), lElbow: D(0.1, -1, 0.15), rShoulder: D(-0.18, -1, 0.04), rElbow: D(-0.1, -1, 0.15) };
const LEGS_STRAIGHT = { lHip: D(0.04, -1, 0), lKnee: D(0.02, -1, 0), rHip: D(-0.04, -1, 0), rKnee: D(-0.02, -1, 0) };
export const POSES = {
  Stehen: { ...ARMS_DOWN, ...LEGS_STRAIGHT },
  'Arme hoch': { ...LEGS_STRAIGHT, lShoulder: D(0.3, 1, 0), lElbow: D(0.15, 1, 0.05), rShoulder: D(-0.3, 1, 0), rElbow: D(-0.15, 1, 0.05) },
  'T-Pose': { ...LEGS_STRAIGHT, lShoulder: D(1, 0, 0), lElbow: D(1, 0, 0), rShoulder: D(-1, 0, 0), rElbow: D(-1, 0, 0) },
  Sitzen: { lHip: D(0.08, 0, 1), lKnee: D(0.05, 0, 1), rHip: D(-0.08, 0, 1), rKnee: D(-0.05, 0, 1),
    lShoulder: D(0.25, -1, -0.35), lElbow: D(0.15, -1, -0.3), rShoulder: D(-0.25, -1, -0.35), rElbow: D(-0.15, -1, -0.3) },
  Stuhl: { lHip: D(0.1, -0.05, 1), lKnee: D(0.06, -1, 0.08), rHip: D(-0.1, -0.05, 1), rKnee: D(-0.06, -1, 0.08),
    lShoulder: D(0.12, -1, 0.3), lElbow: D(0.08, -0.35, 1), rShoulder: D(-0.12, -1, 0.3), rElbow: D(-0.08, -0.35, 1) },
  Knien: { lHip: D(0.05, -1, 0.05), lKnee: D(0, -0.05, -1), rHip: D(-0.05, -1, 0.05), rKnee: D(0, -0.05, -1), ...ARMS_DOWN },
  Hocke: { lHip: D(0.3, -0.1, 1), lKnee: D(0.05, -1, -0.3), rHip: D(-0.3, -0.1, 1), rKnee: D(-0.05, -1, -0.3),
    chest: D(0, 1, 0.35), lShoulder: D(0.15, -0.25, 1), lElbow: D(0.1, -0.2, 1), rShoulder: D(-0.15, -0.25, 1), rElbow: D(-0.1, -0.2, 1) },
  Liegen: { ...LEGS_STRAIGHT, lShoulder: D(0.4, -1, 0), lElbow: D(0.3, -1, 0), rShoulder: D(-0.4, -1, 0), rElbow: D(-0.3, -1, 0), root: [-90, 0, 0] },
};
export const POSE_NAMES = Object.keys(POSES);
const POSE_ORDER = ['spine', 'chest', 'neck', 'lShoulder', 'lElbow', 'rShoulder', 'rElbow', 'lHip', 'lKnee', 'rHip', 'rKnee'];

const gltfP = new Map();
export function loadFigureModel(id) {
  const m = modelInfo(id);
  if (!gltfP.has(m.id)) {
    const p = new GLTFLoader().loadAsync(m.url);
    p.catch(() => gltfP.delete(m.id));   // beim naechsten Mal neu versuchen
    gltfP.set(m.id, p);
  }
  return gltfP.get(m.id);
}

export class Figure extends THREE.Group {
  // erst loadFigureModel(id) abwarten, dann new Figure(gltf, id)
  constructor(gltf, modelId = 'michelle') {
    super();
    this.isFigure = true;
    this.modelId = modelInfo(modelId).id;
    this.model = SkeletonUtils.clone(gltf.scene);
    this.add(this.model);
    this.parts = [];                       // fuer Strahl-Treffer
    this.model.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        o.material = lightMaterial(o.material);   // eigenes, schlankes Material (Hervorheben, Quest)
        o.material.emissive = o.material.emissive || new THREE.Color(0);
        this.parts.push(o);
        this.mat = o.material;
      }
    });
    this.j = {}; this.c = {};
    for (const [k, [a, b]] of Object.entries(RIG)) {
      this.j[k] = this.model.getObjectByName(B(a));
      this.c[k] = this.model.getObjectByName(B(b));
    }
    this.rest = {};
    for (const [k, o] of Object.entries(this.j)) this.rest[k] = o.quaternion.clone();
    this.restRootPos = this.j.root.position.clone();

    // Griffpunkte (lila), groesser als vorher
    this.hmat = new THREE.MeshStandardMaterial({ color: 0xb69cff, roughness: 0.4, transparent: true, opacity: 0.9, depthTest: false });
    this.handleGroup = new THREE.Group(); this.add(this.handleGroup);
    this.handles = [];
    const grip = (name, kind) => {
      const h = new THREE.Mesh(Figure.ball || (Figure.ball = new THREE.SphereGeometry(1, 18, 12)), this.hmat);
      h.renderOrder = 5; h.scale.setScalar(0.028); h.userData = { handle: name, kind };
      this.handleGroup.add(h); this.handles.push(h);
    };
    for (const s of ['l', 'r']) { grip(`${s}Hand`, 'ikArm'); grip(`${s}Elbow`, 'elbow'); grip(`${s}Foot`, 'ikLeg'); grip(`${s}Knee`, 'knee'); }
    grip('head', 'head'); grip('chest', 'chest');
    // Treffer-Kapseln statt Haut-Mesh (Strahl gegen 50.000 Dreiecke ist zu teuer fuer die Quest)
    this.hits = [];
    const hmat = Figure.hitMat || (Figure.hitMat = new THREE.MeshBasicMaterial({ visible: false }));
    for (const [name, r] of SEGS) {
      const a = this.j[name], b = this.c[name];
      const pa = this._wp(a), pb = this._wp(b), len = pa.distanceTo(pb);
      const cap = new THREE.Mesh(new THREE.CapsuleGeometry(r * 1.15, Math.max(0.01, len), 3, 8), hmat);
      const mid = pa.clone().lerp(pb, 0.5), dir = pb.clone().sub(pa).normalize();
      a.add(cap);
      cap.position.copy(a.worldToLocal(mid));
      const wq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      cap.quaternion.copy(a.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(wq));
      cap.userData.seg = name;
      this.hits.push(cap);
    }
    // Physik-Knochen (Brust, Haare), falls das Modell welche hat
    this.jiggle = [];
    for (const [n, kind] of [['BreastL', 'breast'], ['BreastR', 'breast'], ['HairBack', 'hair'], ['HairL', 'hair'], ['HairR', 'hair']]) {
      const b = this.model.getObjectByName(B(n)), e = this.model.getObjectByName(B(n + '_End'));
      if (b && e) this.jiggle.push({ bone: b, end: e, kind, rest: b.quaternion.clone() });
    }
    this.setPose('Stehen');
    // Gesicht zeigt in der Grundpose nach vorne (+Z der Figur): im Kopf-Raum merken
    this.faceLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.j.head.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(this._fq()));
    // Hoehe der Fussgelenke ueber der Sohle (zum Aufsetzen beim Laufen)
    this.measureBottom();
    this.ankleH = Math.min(this._wp(this.j.lAnkle).y, this._wp(this.j.rAnkle).y) - (this.position.y + this.bottom);
  }

  /* ---------- Grundlagen ---------- */
  _wp(o) { return o.getWorldPosition(new THREE.Vector3()); }
  _fq() { return this.getWorldQuaternion(new THREE.Quaternion()); }

  // Gelenk so drehen, dass ein Punkt (Welt) zur Zielrichtung zeigt; Verdrehung bleibt erhalten
  aimPoint(joint, point, target) {
    const jp = this._wp(joint);
    const d0 = point.clone().sub(jp), d1 = target.clone().sub(jp);
    if (d0.lengthSq() < 1e-8 || d1.lengthSq() < 1e-8) return;
    const q0 = joint.getWorldQuaternion(new THREE.Quaternion());
    const qw = new THREE.Quaternion().setFromUnitVectors(d0.normalize(), d1.normalize()).multiply(q0);
    const pq = joint.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    joint.quaternion.copy(pq.multiply(qw));
    joint.updateMatrixWorld(true);
  }

  // Knochen eines logischen Gelenks in eine Richtung (Figurraum) zeigen lassen
  aimDir(name, dirLocal) {
    const j = this.j[name], c = this.c[name];
    const jp = this._wp(j);
    this.aimPoint(j, this._wp(c), jp.clone().add(dirLocal.clone().applyQuaternion(this._fq())));
  }

  /* ---------- Posen ---------- */
  setPose(name) { this.setPoseDirs(POSES[name] || POSES.Stehen, POSES[name] ? name : 'Stehen'); }

  // Pose aus Richtungen je Gelenk (wie in POSES), z. B. fuer berechnete Gang-Posen
  setPoseDirs(p, name = 'Eigene') {
    for (const [k, q] of Object.entries(this.rest)) this.j[k].quaternion.copy(q);
    this.j.root.position.copy(this.restRootPos);
    this.updateMatrixWorld(true);
    for (const k of POSE_ORDER) if (p[k]) this.aimDir(k, p[k]);
    if (p.root) {
      const r = p.root.map(THREE.MathUtils.degToRad);
      const qf = this._fq();
      const qWorldRot = qf.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...r))).multiply(qf.clone().invert());
      const jq = this.j.root.getWorldQuaternion(new THREE.Quaternion());
      const pq = this.j.root.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      this.j.root.quaternion.copy(pq.multiply(qWorldRot.multiply(jq)));
    }
    this.poseName = name;
    this.updateMatrixWorld(true);
    this.update();
  }

  // Blickrichtung des Gesichts (Welt), aus der Kopfdrehung
  faceDir() { return this.faceLocal.clone().applyQuaternion(this.j.head.getWorldQuaternion(new THREE.Quaternion())); }

  getJoints() { const o = {}; for (const [k, j] of Object.entries(this.j)) o[k] = j.quaternion.toArray(); return o; }
  setJoints(o) {
    for (const [k, q] of Object.entries(o || {})) if (this.j[k] && q.length === 4) this.j[k].quaternion.fromArray(q);
    this.updateMatrixWorld(true); this.update();
  }

  /* ---------- Ziehen ---------- */
  _ik2(a, b, c, target, pole) {
    const ja = this.j[a], jb = this.j[b], jc = this.j[c];
    const pa = this._wp(ja), pb = this._wp(jb), pc = this._wp(jc);
    const l1 = pa.distanceTo(pb), l2 = pb.distanceTo(pc);
    const dir = target.clone().sub(pa).normalize();
    const d = Math.min((l1 + l2) * 0.999, Math.max(Math.abs(l1 - l2) + 1e-3, target.distanceTo(pa)));
    const t = pa.clone().addScaledVector(dir, d);
    const angA = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
    let n = dir.clone().cross(pole.clone().sub(pa));
    if (n.lengthSq() < 1e-8) n = dir.clone().cross(new THREE.Vector3(1, 0, 0));
    n.normalize();
    const elbow = pa.clone().addScaledVector(dir.clone().applyAxisAngle(n, angA), l1);
    this.aimPoint(ja, pb, elbow);
    this.aimPoint(jb, this._wp(jc), t);
  }

  _handlePos(h) {
    const { handle: n } = h.userData, s = n[0];
    const mid = (a, b, k = 0.5) => this._wp(a).lerp(this._wp(b), k);
    if (n.endsWith('Hand')) return mid(this.j[`${s}Wrist`], this.c[`${s}Wrist`], 0.6);
    if (n.endsWith('Foot')) return mid(this.j[`${s}Ankle`], this.c[`${s}Ankle`], 0.5);
    if (n.endsWith('Elbow')) return this._wp(this.j[`${s}Elbow`]);
    if (n.endsWith('Knee')) return this._wp(this.j[`${s}Knee`]);
    if (n === 'head') return mid(this.j.head, this.c.head, 0.55).add(new THREE.Vector3(0, 0, 0.1).applyQuaternion(this.j.head.getWorldQuaternion(new THREE.Quaternion())));
    return mid(this.j.chest, this.c.chest, 0.4).add(new THREE.Vector3(0, 0, 0.13).applyQuaternion(this._fq()));
  }

  // Griffpunkt zu einer Weltposition ziehen
  drag(h, target) {
    const { handle: n, kind } = h.userData, s = n[0];
    const fq = this._fq();
    if (kind === 'ikArm' || kind === 'ikLeg') {
      const arm = kind === 'ikArm';
      const [a, b, c] = arm ? [`${s}Shoulder`, `${s}Elbow`, `${s}Wrist`] : [`${s}Hip`, `${s}Knee`, `${s}Ankle`];
      const bend = new THREE.Vector3(0, 0, arm ? -0.2 : 0.2).applyQuaternion(fq);
      for (let k = 0; k < 3; k++) {     // Griff sitzt auf Hand/Fuss, nicht im Gelenk: Versatz mitrechnen
        const off = this._handlePos(h).sub(this._wp(this.j[c]));
        this._ik2(a, b, c, target.clone().sub(off), this._wp(this.j[b]).add(bend));
      }
    } else if (kind === 'elbow') this.aimPoint(this.j[`${s}Shoulder`], this._wp(this.j[`${s}Elbow`]), target);
    else if (kind === 'knee') this.aimPoint(this.j[`${s}Hip`], this._wp(this.j[`${s}Knee`]), target);
    else if (kind === 'head') this.aimPoint(this.j.neck, this._handlePos(h), target);
    else if (kind === 'chest') this.aimPoint(this.j.spine, this._handlePos(h), target);
    this.update();
  }

  /* ---------- Koerperteil greifen ---------- */
  // naechster Koerperabschnitt zu einem Weltpunkt: { name, body, dist }
  nearestSeg(p) {
    let best = null;
    const ab = new THREE.Line3(), q = new THREE.Vector3();
    for (const [name, r, kind] of SEGS) {
      ab.set(this._wp(this.j[name]), this._wp(this.c[name]));
      ab.closestPointToPoint(p, true, q);
      const d = q.distanceTo(p) - r;
      if (!best || d < best.dist) best = { name, body: kind === 'body', dist: d };
    }
    return best;
  }

  // Abschnitt greifen: der gegriffene Punkt bleibt am Knochen haengen
  grabSeg(name, worldPoint) {
    const j = this.j[name];
    return { name, local: j.worldToLocal(worldPoint.clone()) };
  }

  dragSeg(g, target) {
    const j = this.j[g.name];
    const name = g.name === 'head' ? 'neck' : g.name === 'chest' ? 'spine' : g.name;   // Kopf/Brust drehen ueber Hals/Wirbelsaeule
    const joint = this.j[name];
    const p = j.localToWorld(g.local.clone());
    this.aimPoint(joint, p, target);
    this.update();
  }

  /* ---------- Boden, Anzeige ---------- */
  // Abstand Unterkante -> Figur-Ursprung (genau, mit Haut), fuer Schwerkraft und Boden
  measureBottom() {
    this.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const m of this.parts) {
      m.computeBoundingBox();
      box.union(m.boundingBox.clone().applyMatrix4(m.matrixWorld));
    }
    this.box = box;
    this.bottom = box.min.y - this.position.y;
    return this.bottom;
  }

  // tiefster Hautpunkt (Welt-y), der eine Bedingung erfuellt (z. B. nur Gesaess beim Sitzen)
  lowestWhere(pred, step = 3) {
    this.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    let y = Infinity;
    for (const m of this.parts) {
      const n = m.geometry.attributes.position.count;
      for (let i = 0; i < n; i += step) {
        m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld);
        if (v.y < y && pred(v)) y = v.y;
      }
    }
    return y;
  }

  ground(floorY = 0) { this.measureBottom(); this.position.y = floorY - this.bottom; this.updateMatrixWorld(true); this.update(); }

  update() {
    this.updateMatrixWorld(true);
    for (const h of this.handles) h.position.copy(this.handleGroup.worldToLocal(this._handlePos(h)));
  }

  dispose() {
    this.parts.forEach((m) => m.material.dispose());
    this.hits.forEach((h) => h.geometry.dispose());
    this.hmat.dispose();
  }
}

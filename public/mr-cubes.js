// Wuerfel im Mixed-Reality-Modus: erzeugen, greifen (Pinch/Trigger, nah oder per Strahl), loslassen.
// Beim Loslassen haftet er an dem, was er beruehrt:
//   - Hand/Controller (auch Unterarm nah am Handgelenk): bewegt sich exakt mit der Hand.
//   - Koerper-Gelenk (falls die Brille Body-Tracking liefert): exakt mit dem Gelenk.
//   - Koerper laut Tiefensensor (Bein, Bauch, Brust, Arm): haftet am Koerper (Bezug: Nacken + Blickrichtung
//     des Koerpers) und wird bei jedem Blick auf die Stelle wieder an die echte Oberflaeche gezogen.
//   - sonst: bleibt im Raum stehen.
import * as THREE from 'three';

const SIZE = 0.1;
const COLORS = [0xffb03d, 0xff5d8f, 0x5dffb0, 0xb69cff, 0xffe45d];

export class BodyCubes {
  constructor(scene, tracker) {
    this.scene = scene; this.tracker = tracker;
    this.cubes = [];
    this.lights = [new THREE.HemisphereLight(0xffffff, 0x445566, 1.6), new THREE.DirectionalLight(0xffffff, 1.4)];
    this.lights[1].position.set(0.5, 2, 1);
    this.lights.forEach((l) => scene.add(l));
    this.geo = new THREE.BoxGeometry(SIZE, SIZE, SIZE);
    this.raycaster = new THREE.Raycaster();
    this._m = new THREE.Matrix4();
  }

  get count() { return this.cubes.length; }

  // vor dir in Brusthoehe
  spawn(cam) {
    const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld));
    dir.y = 0; if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1); dir.normalize();
    const mesh = new THREE.Mesh(this.geo, new THREE.MeshStandardMaterial({ color: COLORS[this.cubes.length % COLORS.length], roughness: 0.45, metalness: 0.1, transparent: true }));
    mesh.renderOrder = 25;       // ueber der blauen Maske (transparent, damit nach ihr gezeichnet)
    mesh.matrixAutoUpdate = false;
    mesh.matrix.compose(pos.clone().addScaledVector(dir, 0.45).add(new THREE.Vector3(0, -0.25, 0)),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dir.x, dir.z)), new THREE.Vector3(1, 1, 1));
    mesh.matrixWorld.copy(mesh.matrix);
    this.scene.add(mesh);
    const c = { mesh, mode: 'world', key: null, rel: new THREE.Matrix4(), dist: 0, by: null };
    this.cubes.push(c);
    return c;
  }

  clear() {
    for (const c of this.cubes) { this.scene.remove(c.mesh); c.mesh.material.dispose(); }
    this.cubes = [];
  }

  // Wuerfel an dieser Hand/diesem Controller (nah) oder auf dem Strahl
  pick(ctrl) {
    const o = new THREE.Vector3().setFromMatrixPosition(ctrl.matrixWorld);
    let best = null, bd = 0.13;
    for (const c of this.cubes) {
      const d = o.distanceTo(new THREE.Vector3().setFromMatrixPosition(c.mesh.matrixWorld));
      if (d < bd) { bd = d; best = c; }
    }
    if (best) return best;
    this.raycaster.ray.origin.copy(o);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(ctrl.matrixWorld));
    const hit = this.raycaster.intersectObjects(this.cubes.map((c) => c.mesh), false)[0];
    return hit ? this.cubes.find((c) => c.mesh === hit.object) : null;
  }

  grab(ctrl, c) {
    c.mode = 'held'; c.by = ctrl;
    c.rel.copy(ctrl.matrixWorld).invert().multiply(c.mesh.matrixWorld);
  }

  // ctx: { anchors: Map key -> {m: Matrix4, pts: [Vector3], r, kind}, body: Matrix4 }
  release(ctrl, ctx, ownKey) {
    for (const c of this.cubes) {
      if (c.by !== ctrl) continue;
      c.by = null;
      const p = new THREE.Vector3().setFromMatrixPosition(c.mesh.matrixWorld);
      // 1. Hand/Controller/Gelenk in der Naehe
      let best = null, bd = Infinity;
      for (const [key, a] of ctx.anchors) {
        if (key === ownKey) continue;
        for (const q of a.pts) { const d = p.distanceTo(q) - a.r; if (d < 0 && d < bd) { bd = d; best = key; } }
      }
      if (best) { this._attach(c, 'anchor', best, ctx.anchors.get(best).m); continue; }
      // 2. Koerper laut Tiefensensor
      const q = this.tracker.ok ? this.tracker.nearest(p, 0.14) : null;
      if (q && ctx.body) {
        this._attach(c, 'body', null, ctx.body);
        c.dist = p.distanceTo(q); c.seg = this.tracker.segId;
        continue;
      }
      c.mode = 'world';
    }
  }

  _attach(c, mode, key, m) {
    c.mode = mode; c.key = key;
    c.rel.copy(m).invert().multiply(c.mesh.matrixWorld);
  }

  update(ctx) {
    const tmp = this._m;
    for (const c of this.cubes) {
      if (c.mode === 'held' && c.by) c.mesh.matrix.multiplyMatrices(c.by.matrixWorld, c.rel);
      else if (c.mode === 'anchor') {
        const a = ctx.anchors.get(c.key);
        if (a) c.mesh.matrix.multiplyMatrices(a.m, c.rel);     // Hand nicht sichtbar: bleibt, wo sie zuletzt war
      } else if (c.mode === 'body' && ctx.body) {
        c.mesh.matrix.multiplyMatrices(ctx.body, c.rel);
        // an die echte Koerperoberflaeche nachziehen, sobald die Stelle wieder gesehen wird
        if (this.tracker.ok && this.tracker.segId !== c.seg) {
          c.seg = this.tracker.segId;
          const p = new THREE.Vector3().setFromMatrixPosition(c.mesh.matrix);
          const q = this.tracker.nearest(p, 0.2);
          if (q) {
            const dir = p.clone().sub(q); const d = dir.length();
            const target = d > 1e-4 ? q.clone().addScaledVector(dir.divideScalar(d), c.dist) : p;
            p.lerp(target, 0.4);
            c.mesh.matrix.setPosition(p);
            c.rel.copy(tmp.copy(ctx.body).invert().multiply(c.mesh.matrix));
          }
        }
      }
      c.mesh.matrixWorld.copy(c.mesh.matrix);
    }
  }

  dispose() {
    this.clear();
    this.lights.forEach((l) => this.scene.remove(l));
    this.geo.dispose();
  }
}

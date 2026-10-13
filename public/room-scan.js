// Erkannter Raum (WebXR plane-detection / mesh-detection, z. B. Quest-Raumeinrichtung):
// Waende, Boden, Tische als Flaechen, dazu das gescannte Raumnetz.
// Damit koennen Wuerfel nicht in Waende/Boden/Moebel geschoben werden (Kollision),
// legen sich beim Abstellen flach an die Flaeche (Ausrichten) und lassen sich per
// Strahl direkt auf eine Flaeche setzen.
import * as THREE from 'three';

const COL = { horizontal: 0x7ee0b0, vertical: 0x7cc4ff, mesh: 0xb69cff };

export class RoomScan {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.planes = new Map();       // XRPlane -> Eintrag
    this.meshes = new Map();       // XRMesh  -> Eintrag
    this.show = true;
  }

  get count() { return { planes: this.planes.size, meshes: this.meshes.size }; }

  // Hoehe des Bodens: tiefste nach oben zeigende Flaeche, sonst 0 (local-floor)
  floorY() {
    let y = null;
    for (const e of this.planes.values()) {
      if (e.normal.y < 0.8) continue;
      const py = new THREE.Vector3().setFromMatrixPosition(e.matrix).y;
      if (y === null || py < y) y = py;
    }
    return y === null ? 0 : Math.min(y, 0.3);
  }

  setShow(on) { this.show = on; for (const e of [...this.planes.values(), ...this.meshes.values()]) e.viz.visible = on; }

  // Pro XR-Frame aufrufen
  update(frame, ref) {
    if (!frame) return;
    const planes = frame.detectedPlanes, meshes = frame.detectedMeshes;
    if (planes) {
      for (const [p, e] of this.planes) if (!planes.has(p)) { this._drop(e); this.planes.delete(p); }
      planes.forEach((p) => {
        const pose = frame.getPose(p.planeSpace, ref);
        if (!pose) return;
        let e = this.planes.get(p);
        if (!e || e.changed !== p.lastChangedTime) { if (e) this._drop(e); e = this._makePlane(p); this.planes.set(p, e); }
        e.matrix.fromArray(pose.transform.matrix);
        e.inv.copy(e.matrix).invert();
        e.normal.set(0, 1, 0).transformDirection(e.matrix);
        e.viz.matrix.copy(e.matrix);
      });
    }
    if (meshes) {
      for (const [m, e] of this.meshes) if (!meshes.has(m)) { this._drop(e); this.meshes.delete(m); }
      meshes.forEach((m) => {
        const pose = frame.getPose(m.meshSpace, ref);
        if (!pose) return;
        let e = this.meshes.get(m);
        const changed = !e || e.changed !== m.lastChangedTime;
        if (changed) { if (e) this._drop(e); e = this._makeMesh(m); this.meshes.set(m, e); }
        const mat = new THREE.Matrix4().fromArray(pose.transform.matrix);
        if (changed || !mat.equals(e.matrix)) {
          e.matrix.copy(mat);
          e.viz.matrix.copy(mat);
          e.viz.matrixWorldNeedsUpdate = true;
          // Dreiecke in Weltkoordinaten fuer die Kollision
          const v = m.vertices, out = new Float32Array(v.length), t = new THREE.Vector3();
          for (let k = 0; k < v.length; k += 3) { t.set(v[k], v[k + 1], v[k + 2]).applyMatrix4(mat); out[k] = t.x; out[k + 1] = t.y; out[k + 2] = t.z; }
          e.world = out; e.index = m.indices;
          e.box = new THREE.Box3().setFromArray(out);
        }
      });
    }
  }

  _makePlane(p) {
    const pts = p.polygon.map((q) => [q.x, q.z]);
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z)));
    const geo = new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2);   // (x, y) -> (x, 0, y)
    const horiz = p.orientation === 'horizontal';
    const color = horiz ? COL.horizontal : COL.vertical;
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, 0.002, z))),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
    fill.add(line);
    fill.matrixAutoUpdate = false;
    fill.visible = this.show;
    fill.userData.surface = true;
    this.group.add(fill);
    return { changed: p.lastChangedTime, poly: pts, viz: fill, matrix: new THREE.Matrix4(), inv: new THREE.Matrix4(),
      normal: new THREE.Vector3(0, 1, 0), horiz, label: p.semanticLabel || '' };
  }

  _makeMesh(m) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.vertices), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(m.indices), 1));
    geo.computeVertexNormals();
    const viz = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COL.mesh, wireframe: true, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
    viz.matrixAutoUpdate = false;
    viz.visible = this.show;
    viz.userData.surface = true;
    this.group.add(viz);
    return { changed: m.lastChangedTime, viz, matrix: new THREE.Matrix4(), world: null, index: null, box: null, label: m.semanticLabel || '' };
  }

  _drop(e) {
    this.group.remove(e.viz);
    e.viz.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }

  // Alle Flaechen/Netze fuer Strahl-Treffer
  get surfaces() { return this.group.children; }

  /* ---------- Kollision ---------- */
  // Wuerfel (Kantenlaenge s) aus Flaechen und Netz herausschieben.
  // prev: letzte Position (bestimmt, auf welcher Seite einer Flaeche der Wuerfel war)
  resolve(cube, s, prev) {
    const c = cube.position;
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((a) => a.applyQuaternion(cube.quaternion));
    for (let it = 0; it < 2; it++) {
      for (const e of this.planes.values()) {
        const n = e.normal;
        const h = (s / 2) * (Math.abs(n.dot(axes[0])) + Math.abs(n.dot(axes[1])) + Math.abs(n.dot(axes[2])));
        const lc = c.clone().applyMatrix4(e.inv);
        if (!insidePoly(lc.x, lc.z, e.poly, s * 0.35)) continue;
        const d = lc.y;
        if (Math.abs(d) > h + 0.5) continue;
        const dp = prev ? prev.clone().applyMatrix4(e.inv).y : d;
        const side = dp >= -h * 0.5 ? 1 : -1;
        if (side > 0 && d < h) c.addScaledVector(n, h - d);
        else if (side < 0 && d > -h) c.addScaledVector(n, -h - d);
      }
      const r = s * 0.5;
      for (const e of this.meshes.values()) {
        if (!e.world || !e.box || e.box.distanceToPoint(c) > r) continue;
        pushOutOfTriangles(c, r, e.world, e.index);
      }
    }
  }

  // Naechste Flaeche in Kontakt (Abstand < tol) -> { normal, gap }
  contact(cube, s, tol = 0.04) {
    const c = cube.position;
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((a) => a.applyQuaternion(cube.quaternion));
    let best = null;
    for (const e of this.planes.values()) {
      const n = e.normal;
      const h = (s / 2) * (Math.abs(n.dot(axes[0])) + Math.abs(n.dot(axes[1])) + Math.abs(n.dot(axes[2])));
      const lc = c.clone().applyMatrix4(e.inv);
      if (!insidePoly(lc.x, lc.z, e.poly, s * 0.35)) continue;
      const gap = Math.abs(lc.y) - h;
      if (gap < tol && (!best || gap < best.gap)) best = { normal: n.clone().multiplyScalar(Math.sign(lc.y) || 1), gap };
    }
    const r = s * 0.5;
    for (const e of this.meshes.values()) {
      if (!e.world || !e.box || e.box.distanceToPoint(c) > r + tol) continue;
      const q = closestOnTriangles(c, e.world, e.index);
      if (!q) continue;
      const gap = q.dist - r;
      if (gap < tol && (!best || gap < best.gap)) best = { normal: c.clone().sub(q.point).normalize(), gap };
    }
    return best;
  }
}

// Drehung, die den Wuerfel flach an die Flaeche (Normale n) legt: die passendste Wuerfelachse auf n drehen
export function alignTo(quat, n) {
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((a) => a.applyQuaternion(quat));
  let best = axes[0], bd = -1;
  for (const a of axes) { const d = Math.abs(a.dot(n)); if (d > bd) { bd = d; best = a; } }
  const from = best.clone().multiplyScalar(Math.sign(best.dot(n)) || 1);
  return new THREE.Quaternion().setFromUnitVectors(from, n).multiply(quat);
}

function insidePoly(x, z, poly, margin) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  if (inside || margin <= 0) return inside;
  // knapp ausserhalb zaehlt auch (Wuerfel ragt ueber die Kante)
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segDist(x, z, poly[j][0], poly[j][1], poly[i][0], poly[i][1]) < margin) return true;
  }
  return false;
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Vector3();
const _tri = new THREE.Triangle();

function closestOnTriangles(p, w, idx) {
  let best = null;
  for (let k = 0; k < idx.length; k += 3) {
    _a.fromArray(w, idx[k] * 3); _b.fromArray(w, idx[k + 1] * 3); _c.fromArray(w, idx[k + 2] * 3);
    _tri.set(_a, _b, _c).closestPointToPoint(p, _q);
    const d = _q.distanceTo(p);
    if (!best || d < best.dist) best = { point: _q.clone(), dist: d };
  }
  return best;
}

function pushOutOfTriangles(p, r, w, idx) {
  for (let k = 0; k < idx.length; k += 3) {
    _a.fromArray(w, idx[k] * 3); _b.fromArray(w, idx[k + 1] * 3); _c.fromArray(w, idx[k + 2] * 3);
    _tri.set(_a, _b, _c).closestPointToPoint(p, _q);
    const d = _q.distanceTo(p);
    if (d < r && d > 1e-5) p.addScaledVector(p.clone().sub(_q).divideScalar(d), r - d);
  }
}

// Erkannte Moebel-Flaechen (WebXR plane-detection / mesh-detection, Quest-Raumeinrichtung).
// Genutzt nur als Auflage: Wuerfel und Figuren landen auf Bett, Tisch, Sofa statt darin.
// Der Boden bleibt der echte Boden (local-floor), Waende werden nicht beachtet.
// Ausserdem: Platzfinder fuer den Spiel-Modus (Sitz-/Liegeplaetze, freier Boden zum Laufen).
import * as THREE from 'three';

const SKIP = new Set(['floor', 'ceiling', 'wall', 'door frame', 'window frame', 'wall art', 'global mesh', 'screen', 'window', 'door']);

// Punkt im Polygon (xz)
export function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// konvexe Huelle (xz), Monotone Chain
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

function area(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

// Abstand Punkt -> Polygonrand (xz)
function edgeDist(x, z, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i];
    const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
    d = Math.min(d, Math.hypot(x - ax - t * ex, z - az - t * ez));
  }
  return d;
}

export class Surfaces {
  constructor(scene) {
    this.group = new THREE.Group(); this.group.visible = false;
    scene.add(this.group);
    this.planes = new Map();   // XRPlane/XRMesh -> { changed, s }
    this.list = [];            // { y, poly:[[x,z]], label, area, center:[x,z] }
    this.walls = [];           // senkrechte Flaechen als Strecken [[x,z],[x,z]] (fuer das Laufraster)
    this.floorPoly = null;     // Boden-Umriss, falls erkannt
    this.version = 0;
  }

  get count() { return this.list.length; }

  // Pro XR-Frame
  update(frame, ref) {
    if (!frame) return;
    const seen = new Set();
    let dirty = false;
    const take = (src, space, kind) => {
      seen.add(src);
      const e = this.planes.get(src);
      if (e && e.changed === src.lastChangedTime && e.ok) return;
      const pose = frame.getPose(space, ref);
      if (!pose) return;
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      this.planes.set(src, { changed: src.lastChangedTime, ok: true, s: kind === 'plane' ? this._fromPlane(src, m) : this._fromMesh(src, m) });
      dirty = true;
    };
    frame.detectedPlanes?.forEach((p) => take(p, p.planeSpace, 'plane'));
    frame.detectedMeshes?.forEach((m) => take(m, m.meshSpace, 'mesh'));
    for (const k of [...this.planes.keys()]) if (!seen.has(k)) { this.planes.delete(k); dirty = true; }
    if (dirty) this._rebuild();
  }

  // Testen ohne Brille: Flaechen direkt setzen ({ y, poly, label } bzw. { wall: [[x,z],[x,z]] })
  setManual(list, floorPoly = null) {
    this.planes.clear();
    list.forEach((s, i) => this.planes.set('m' + i, { ok: true, s: s.wall ? { wall: s.wall } : { ...s, area: area(s.poly) } }));
    if (floorPoly) this.planes.set('floor', { ok: true, s: { floor: floorPoly } });
    this._rebuild();
  }

  _fromPlane(p, m) {
    const label = (p.semanticLabel || '').toLowerCase();
    const pts = p.polygon.map((q) => new THREE.Vector3(q.x, q.y, q.z).applyMatrix4(m));
    if (p.orientation === 'vertical' || label === 'wall') {
      // Wand als Strecke am Boden: die zwei am weitesten auseinanderliegenden Punkte
      let a = pts[0], b = pts[0], best = -1;
      for (const u of pts) for (const v of pts) { const d = (u.x - v.x) ** 2 + (u.z - v.z) ** 2; if (d > best) { best = d; a = u; b = v; } }
      return { wall: [[a.x, a.z], [b.x, b.z]] };
    }
    const n = new THREE.Vector3(0, 1, 0).transformDirection(m);
    if (n.y < 0.8) return null;
    const poly = pts.map((v) => [v.x, v.z]);
    if (label === 'floor') return { floor: poly };
    if (SKIP.has(label)) return null;
    const y = pts.reduce((s, v) => s + v.y, 0) / pts.length;
    return { y, poly, label: label || 'other', area: area(poly) };
  }

  _fromMesh(mesh, m) {
    const label = (mesh.semanticLabel || '').toLowerCase();
    if (SKIP.has(label)) return null;
    const v = mesh.vertices, w = [];
    let top = -Infinity;
    for (let k = 0; k < v.length; k += 3) { const t = new THREE.Vector3(v[k], v[k + 1], v[k + 2]).applyMatrix4(m); w.push(t); top = Math.max(top, t.y); }
    if (w.length > 5000) return null;                // grosses Raumnetz, keine Moebel-Box
    const topPts = w.filter((t) => t.y > top - 0.03).map((t) => [t.x, t.z]);
    if (topPts.length < 3) return null;
    const poly = hull(topPts);
    if (poly.length < 3) return null;
    return { y: top, poly, label: label || 'other', area: area(poly) };
  }

  _rebuild() {
    const all = [...this.planes.values()].map((e) => e.s).filter(Boolean);
    this.walls = all.filter((s) => s.wall).map((s) => s.wall);
    this.floorPoly = all.find((s) => s.floor)?.floor || null;
    // gleiche Flaeche aus Ebene und Netz nur einmal
    const flat = all.filter((s) => s.poly && s.area > 0.02).sort((a, b) => b.area - a.area);
    this.list = [];
    for (const s of flat) {
      const c = s.poly.reduce((a, p) => [a[0] + p[0] / s.poly.length, a[1] + p[1] / s.poly.length], [0, 0]);
      s.center = c;
      if (this.list.some((o) => Math.abs(o.y - s.y) < 0.06 && inPoly(c[0], c[1], o.poly))) continue;
      this.list.push(s);
    }
    this.version++;
    this._drawViz();
  }

  // Hoechste Auflage unter einem Punkt, die nicht hoeher als maxY liegt (sonst null)
  supportAt(x, z, maxY) {
    let best = null;
    for (const s of this.list) if (s.y <= maxY && inPoly(x, z, s.poly) && (best === null || s.y > best)) best = s.y;
    return best;
  }

  // Liegt der Punkt auf/in einem Moebel (fuer das Laufraster)?
  blocked(x, z, floorY, margin = 0.2) {
    for (const s of this.list) {
      if (s.y - floorY > 1.6) continue;              // hoch haengend (Regal ueber Kopf) blockiert nicht
      if (inPoly(x, z, s.poly) || edgeDist(x, z, s.poly) < margin) return true;
    }
    for (const [[ax, az], [bx, bz]] of this.walls) {
      const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
      if (Math.hypot(x - ax - t * ex, z - az - t * ez) < margin + 0.05) return true;
    }
    if (this.floorPoly && !inPoly(x, z, this.floorPoly)) return true;
    return false;
  }

  /* ---------- Anzeige der erkannten Flaechen ---------- */
  setShow(on) { this.group.visible = on; }

  _drawViz() {
    for (const c of [...this.group.children]) { this.group.remove(c); c.geometry.dispose(); c.material.dispose(); }
    for (const s of this.list) {
      const pts = s.poly.map(([x, z]) => new THREE.Vector3(x, s.y + 0.005, z));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x7ee0b0, transparent: true, opacity: 0.8 }));
      this.group.add(line);
    }
  }
}

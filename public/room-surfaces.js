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

/* ---------- Platzfinder ---------- */
const SEAT_MIN = 0.28, SEAT_MAX = 0.8;     // Sitzhoehe ueber dem Boden
const LIE_MIN = 0.15, LIE_MAX = 0.9;

// Hauptachse eines Polygons (PCA): { center, axis:[x,z], len, wid }
function principal(poly) {
  const n = poly.length;
  const cx = poly.reduce((s, p) => s + p[0], 0) / n, cz = poly.reduce((s, p) => s + p[1], 0) / n;
  let xx = 0, xz = 0, zz = 0;
  for (const [x, z] of poly) { xx += (x - cx) ** 2; xz += (x - cx) * (z - cz); zz += (z - cz) ** 2; }
  const a = 0.5 * Math.atan2(2 * xz, xx - zz);
  const ax = [Math.cos(a), Math.sin(a)], bx = [-ax[1], ax[0]];
  let l0 = Infinity, l1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (const [x, z] of poly) {
    const u = (x - cx) * ax[0] + (z - cz) * ax[1], v = (x - cx) * bx[0] + (z - cz) * bx[1];
    l0 = Math.min(l0, u); l1 = Math.max(l1, u); w0 = Math.min(w0, v); w1 = Math.max(w1, v);
  }
  const c = [cx + ax[0] * (l0 + l1) / 2 + bx[0] * (w0 + w1) / 2, cz + ax[1] * (l0 + l1) / 2 + bx[1] * (w0 + w1) / 2];
  return l1 - l0 >= w1 - w0 ? { center: c, axis: ax, len: l1 - l0, wid: w1 - w0 } : { center: c, axis: bx, len: w1 - w0, wid: l1 - l0 };
}

// Sitzplaetze: Kante einer Flaeche in Sitzhoehe, davor freier Boden fuer die Fuesse
// -> [{ seat: Vector3 (Sitzpunkt), dir: [x,z] (Blickrichtung nach aussen), approach: Vector3, s }]
export function findSitSpots(surfaces, floorY, grid) {
  const out = [], cand = [];
  for (const s of surfaces.list) {
    const h = s.y - floorY;
    if (h < SEAT_MIN || h > SEAT_MAX || s.label === 'table' || s.area < 0.12) continue;
    const [cx, cz] = s.center;
    for (let i = 0, j = s.poly.length - 1; i < s.poly.length; j = i++) {
      const [ax, az] = s.poly[j], [bx, bz] = s.poly[i];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.4) continue;
      let nx = (bz - az) / len, nz = -(bx - ax) / len;                 // Normale der Kante
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (nx * (mx - cx) + nz * (mz - cz) < 0) { nx = -nx; nz = -nz; }  // nach aussen
      const k = Math.max(1, Math.floor((len - 0.2) / 0.6));
      for (let q = 0; q < k; q++) {
        const t = (q + 0.5) / k;
        const ex = ax + (bx - ax) * t, ez = az + (bz - az) * t;
        const seat = new THREE.Vector3(ex - nx * 0.14, s.y, ez - nz * 0.14);
        const approach = new THREE.Vector3(ex + nx * 0.5, floorY, ez + nz * 0.5);
        if (grid && !grid.isFree(approach.x, approach.z)) continue;
        if (surfaces.supportAt(ex + nx * 0.3, ez + nz * 0.3, s.y + 0.5) !== null) continue;   // davor steht etwas
        if (surfaces.walls.some((w) => crosses([ex, ez], [approach.x, approach.z], w[0], w[1]))) continue;   // Wand davor
        // Platz vor dem Sitz: freie Rasterzellen bis 1,2 m
        let score = 0;
        if (grid) for (let d = 0.3; d <= 1.2; d += 0.1) { if (grid.isFree(ex + nx * d, ez + nz * d)) score++; else break; }
        cand.push({ seat, dir: [nx, nz], approach, s, score });
      }
    }
  }
  // je Stelle der Sitz mit dem meisten Platz davor
  cand.sort((a, b) => b.score - a.score);
  for (const c of cand) if (!out.some((o) => o.seat.distanceTo(c.seat) < 0.45)) out.push(c);
  return out;
}

// schneiden sich die Strecken a-b und c-d (xz)?
function crosses(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

// Liegeplaetze: Bett oder grosse Flaeche in Bett-Hoehe -> [{ center: Vector3, axis:[x,z], len, wid, s }]
export function findLieSpots(surfaces, floorY) {
  const out = [];
  for (const s of surfaces.list) {
    const h = s.y - floorY;
    if (h < LIE_MIN || h > LIE_MAX || s.label === 'table') continue;
    const pa = principal(s.poly);
    if (!(s.label === 'bed' || (pa.len >= 1.5 && pa.wid >= 0.7))) continue;
    if (pa.len < 1.2) continue;
    out.push({ center: new THREE.Vector3(pa.center[0], s.y, pa.center[1]), axis: pa.axis, len: pa.len, wid: pa.wid, s });
  }
  return out;
}

/* ---------- Laufraster (A*) ---------- */
export class NavGrid {
  constructor(surfaces, floorY, cx, cz, radius = 5, cell = 0.2) {
    this.cell = cell; this.n = Math.ceil((2 * radius) / cell);
    this.x0 = cx - radius; this.z0 = cz - radius;
    this.free = new Uint8Array(this.n * this.n);
    for (let i = 0; i < this.n; i++) for (let k = 0; k < this.n; k++) {
      const [x, z] = this.pos(i, k);
      this.free[k * this.n + i] = surfaces.blocked(x, z, floorY, 0.22) ? 0 : 1;
    }
  }

  pos(i, k) { return [this.x0 + (i + 0.5) * this.cell, this.z0 + (k + 0.5) * this.cell]; }
  idx(x, z) { return [Math.floor((x - this.x0) / this.cell), Math.floor((z - this.z0) / this.cell)]; }
  inside(i, k) { return i >= 0 && k >= 0 && i < this.n && k < this.n; }
  isFreeCell(i, k) { return this.inside(i, k) && this.free[k * this.n + i] === 1; }
  isFree(x, z) { const [i, k] = this.idx(x, z); return this.isFreeCell(i, k); }

  // naechste freie Zelle (Breitensuche nach aussen)
  nearestFree(x, z) {
    const [i0, k0] = this.idx(x, z);
    for (let r = 0; r < this.n; r++) {
      let best = null, bd = Infinity;
      for (let i = i0 - r; i <= i0 + r; i++) for (let k = k0 - r; k <= k0 + r; k++) {
        if (Math.max(Math.abs(i - i0), Math.abs(k - k0)) !== r || !this.isFreeCell(i, k)) continue;
        const [px, pz] = this.pos(i, k), d = (px - x) ** 2 + (pz - z) ** 2;
        if (d < bd) { bd = d; best = [px, pz]; }
      }
      if (best) return best;
    }
    return null;
  }

  // freie Sichtlinie (fuer das Glaetten des Wegs)
  clear(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az), steps = Math.ceil(d / (this.cell * 0.5));
    for (let s = 0; s <= steps; s++) { const t = s / (steps || 1); if (!this.isFree(ax + (bx - ax) * t, az + (bz - az) * t)) return false; }
    return true;
  }

  // Weg von a nach b ([x,z]) -> Liste von Punkten [x,z] oder null
  path(a, b) {
    const s = this.nearestFree(a[0], a[1]), g = this.nearestFree(b[0], b[1]);
    if (!s || !g) return null;
    const [si, sk] = this.idx(...s), [gi, gk] = this.idx(...g), n = this.n;
    const start = sk * n + si, goal = gk * n + gi;
    const gs = new Float32Array(n * n).fill(Infinity), from = new Int32Array(n * n).fill(-1), done = new Uint8Array(n * n);
    const open = [[0, start]]; gs[start] = 0;
    const hh = (c) => Math.hypot((c % n) - gi, Math.floor(c / n) - gk);
    while (open.length) {
      let bi = 0; for (let q = 1; q < open.length; q++) if (open[q][0] < open[bi][0]) bi = q;
      const [, c] = open.splice(bi, 1)[0];
      if (c === goal) break;
      if (done[c]) continue; done[c] = 1;
      const ci = c % n, ck = Math.floor(c / n);
      for (let di = -1; di <= 1; di++) for (let dk = -1; dk <= 1; dk++) {
        if (!di && !dk) continue;
        const ni = ci + di, nk = ck + dk;
        if (!this.isFreeCell(ni, nk) || (di && dk && (!this.isFreeCell(ci + di, ck) || !this.isFreeCell(ci, ck + dk)))) continue;
        const nc = nk * n + ni, ng = gs[c] + (di && dk ? Math.SQRT2 : 1);
        if (ng < gs[nc]) { gs[nc] = ng; from[nc] = c; open.push([ng + hh(nc), nc]); }
      }
    }
    if (start !== goal && from[goal] < 0) return null;
    const cells = [];
    for (let c = goal; c >= 0; c = c === start ? -1 : from[c]) cells.unshift(this.pos(c % n, Math.floor(c / n)));
    cells[0] = [a[0], a[1]];
    if (this.isFree(b[0], b[1])) cells.push([b[0], b[1]]);
    // glaetten: Punkte weglassen, solange die Sichtlinie frei ist
    const out = [cells[0]];
    let k = 0;
    while (k < cells.length - 1) {
      let j = cells.length - 1;
      while (j > k + 1 && !this.clear(cells[k][0], cells[k][1], cells[j][0], cells[j][1])) j--;
      out.push(cells[j]); k = j;
    }
    return out;
  }
}

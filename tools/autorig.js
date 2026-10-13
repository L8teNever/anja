// Auto-Rig: Michelles Mixamo-Skelett + Hautgewichte auf ein statisches T-Pose-Modell uebertragen.
// So wurden models/tsunade.glb und models/miss-white.glb gebaut (Originale ohne Skelett).
// Ablauf: Koerper beider Modelle vermessen (Schritt, Armlinie, Rumpf-/Huefbreite, Spannweite),
// Michelle stueckweise auf die Form des Ziels verzerren, Gelenke dorthin setzen und je Punkt
// die Hautgewichte der 4 naechsten Michelle-Punkte uebernehmen. Ergebnis: GLB mit mixamorig-Knochen.
// Benutzen: im Browser als Modul laden, z. B. rig.html?m=<name>&h=<hoehe in m>, mit
// /m/michelle.glb, /m/<name>.glb und /vendor/GLTFExporter.js (three r170) daneben;
// das fertige GLB liegt danach base64-kodiert in window.glb.
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/GLTFLoader.js';
import { GLTFExporter } from '/vendor/GLTFExporter.js';

const q = new URLSearchParams(location.search);
const NAME = q.get('m'), HEIGHT = +q.get('h');
const L = new GLTFLoader();
const src = await L.loadAsync('/m/michelle.glb');
const tgt = await L.loadAsync('/m/' + NAME + '.glb');
src.scene.updateMatrixWorld(true);

// --- Michelle: Punkte, Gewichte, Gelenke (Welt, Ruhepose)
let sm; src.scene.traverse((o) => { if (o.isSkinnedMesh) sm = o; });
const sPos = [], sIdx = sm.geometry.attributes.skinIndex, sW = sm.geometry.attributes.skinWeight;
const v = new THREE.Vector3();
for (let i = 0; i < sm.geometry.attributes.position.count; i++) { sm.getVertexPosition(i, v); v.applyMatrix4(sm.matrixWorld); sPos.push(v.clone()); }
const bones = sm.skeleton.bones;
const sJ = bones.map((b) => b.getWorldPosition(new THREE.Vector3()));

// --- Ziel: alle Meshes in Weltkoordinaten backen, auf Hoehe skalieren, Fuesse auf 0, mittig
tgt.scene.updateMatrixWorld(true);
const tMeshes = [];
tgt.scene.traverse((o) => { if (o.isMesh) tMeshes.push(o); });
const box = new THREE.Box3().setFromObject(tgt.scene);
const sc = HEIGHT / (box.max.y - box.min.y);
const c = box.getCenter(new THREE.Vector3());
const norm = new THREE.Matrix4().makeScale(sc, sc, sc).multiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z));
const geos = tMeshes.map((m) => { const g = m.geometry.clone(); g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(norm, m.matrixWorld)); return g; });
const tPos = []; for (const g of geos) { const p = g.attributes.position; for (let i = 0; i < p.count; i++) tPos.push(new THREE.Vector3().fromBufferAttribute(p, i)); }

// --- Landmarken (gleich gemessen an beiden Koerpern)
function marks(P) {
  let top = -1e9, span = 0; for (const p of P) { top = Math.max(top, p.y); span = Math.max(span, Math.abs(p.x)); }
  const H = top;
  // Armlinie: y = a + b*|x| aus Punkten weit aussen
  const arm = P.filter((p) => Math.abs(p.x) > 0.45 * span && Math.abs(p.x) < 0.85 * span);
  let n = arm.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of arm) { const x = Math.abs(p.x); sx += x; sy += p.y; sxx += x * x; sxy += x * p.y; }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
  let thick = 0; for (const p of arm) thick += Math.abs(p.y - (a + b * Math.abs(p.x))); thick /= n;
  const armY = a + b * 0.15 * span;
  const slice = (y0, y1, f = () => true) => P.filter((p) => p.y > y0 && p.y < y1 && f(p));
  const maxAbs = (S, k) => S.reduce((m, p) => Math.max(m, Math.abs(p[k])), 0);
  let crotch = 1e9; for (const p of P) if (Math.abs(p.x) < 0.01 && p.y > 0.3 * H && p.y < 0.6 * H) crotch = Math.min(crotch, p.y);
  const fy = (f) => crotch + f * (armY - crotch);
  const torsoS = slice(fy(0.82), fy(0.88), (p) => Math.abs(p.x) < 0.4 * span);
  const torsoW = maxAbs(torsoS, 'x');
  const hipS = slice(crotch + 0.02 * H, crotch + 0.06 * H, (p) => Math.abs(p.x) < 0.4 * span);
  const hipW = maxAbs(hipS, 'x');
  const zc = (S) => { let lo = 1e9, hi = -1e9; for (const p of S) { lo = Math.min(lo, p.z); hi = Math.max(hi, p.z); } return [(lo + hi) / 2, hi - lo]; };
  const [torsoZ, torsoD] = zc(torsoS), [hipZ, hipD] = zc(hipS);
  return { top, span, a, b, thick, armY, torsoW, crotch, hipW, torsoZ, torsoD, hipZ, hipD };
}
const M = marks(sPos), T = marks(tPos);

const lerp = (x, xs, ys) => { if (x <= xs[0]) return ys[0] + (x - xs[0]) * (ys[1] - ys[0]) / (xs[1] - xs[0]);
  for (let i = 1; i < xs.length; i++) if (x <= xs[i] || i === xs.length - 1) return ys[i - 1] + (x - xs[i - 1]) * (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]); };
const sstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// Michelle-Raum -> Ziel-Raum
function warp(p) {
  const ax = Math.abs(p.x), sg = Math.sign(p.x) || 1;
  const y = lerp(p.y, [0, M.crotch, M.armY, M.top], [0, T.crotch, T.armY, T.top]);
  const k = sstep(M.crotch, M.armY - 0.1 * M.top, p.y);
  const rx = THREE.MathUtils.lerp(T.hipW / M.hipW, T.torsoW / M.torsoW, k);
  const z = THREE.MathUtils.lerp(T.hipZ + (p.z - M.hipZ) * T.hipD / M.hipD, T.torsoZ + (p.z - M.torsoZ) * T.torsoD / M.torsoD, k);
  const body = new THREE.Vector3(p.x * rx, y, z);
  // Arm: entlang der Armlinie strecken
  const xa = lerp(ax, [M.torsoW, M.span], [T.torsoW, T.span]);
  const dy = (p.y - (M.a + M.b * ax)) * T.thick / M.thick;
  const armP = new THREE.Vector3(sg * xa, T.a + T.b * xa + dy, T.torsoZ + (p.z - M.torsoZ) * T.thick / M.thick);
  const w = (ax > M.torsoW && p.y > M.armY - 0.15 * M.top) ? sstep(M.torsoW, M.torsoW + 0.08, ax) : 0;
  return body.lerp(armP, w);
}
const wPos = sPos.map(warp), wJ = sJ.map(warp);

// --- Gitter fuer naechste Nachbarn
const CELL = 0.03, grid = new Map(), key = (x, y, z) => `${x},${y},${z}`;
wPos.forEach((p, i) => { const k = key(Math.floor(p.x / CELL), Math.floor(p.y / CELL), Math.floor(p.z / CELL)); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
function nearest(p, K = 4) {
  const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL), cz = Math.floor(p.z / CELL);
  for (let r = 1; r < 40; r++) {
    const res = [];
    for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
      const g = grid.get(key(x, y, z)); if (g) for (const i of g) res.push([wPos[i].distanceToSquared(p), i]);
    }
    if (res.length >= K) { res.sort((a, b) => a[0] - b[0]); if (Math.sqrt(res[K - 1][0]) <= r * CELL) return res.slice(0, K); if (r > 8) return res.slice(0, K); }
  }
  return [];
}

// --- Skelett fuer das Ziel: gleiche Hierarchie, gleiche Armature-Lage und Drehungen wie Michelle
// (dann sind die lokalen Gelenk-Drehungen austauschbar), Gelenke an den verzerrten Stellen
const armRoot = bones[0].parent;   // Michelles Armature-Knoten (Drehung/Massstab)
const A = armRoot.matrixWorld.clone();
const nb = bones.map((b) => { const n = new THREE.Bone(); n.name = b.name; return n; });
const W = bones.map((b, i) => {
  const q = b.getWorldQuaternion(new THREE.Quaternion()), sc3 = b.getWorldScale(new THREE.Vector3());
  return new THREE.Matrix4().compose(wJ[i], q, sc3);
});
bones.forEach((b, i) => {
  const pi = bones.indexOf(b.parent);
  if (pi >= 0) nb[pi].add(nb[i]);
  const local = (pi >= 0 ? W[pi].clone() : A.clone()).invert().multiply(W[i]);
  local.decompose(nb[i].position, nb[i].quaternion, nb[i].scale);
});
const root = { nb, rootBones: nb.filter((n, i) => bones.indexOf(bones[i].parent) < 0) };

// --- Gewichte uebertragen und SkinnedMeshes bauen
const out = new THREE.Group(); out.name = NAME;
const armature = new THREE.Group(); armature.name = 'Armature'; out.add(armature);
A.decompose(armature.position, armature.quaternion, armature.scale);
root.rootBones.forEach((b) => armature.add(b));
out.updateMatrixWorld(true);
const skeleton = new THREE.Skeleton(root.nb);
geos.forEach((g, gi) => {
  const p = g.attributes.position, n = p.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), t = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    t.fromBufferAttribute(p, i);
    const nn = nearest(t, 4), acc = new Map();
    for (const [d2, j] of nn) {
      const w0 = 1 / (Math.sqrt(d2) + 1e-4);
      for (let c = 0; c < 4; c++) { const w = sW.getComponent(j, c); if (w > 0) { const b = sIdx.getComponent(j, c); acc.set(b, (acc.get(b) || 0) + w * w0); } }
    }
    const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4); const s = top.reduce((m, x) => m + x[1], 0) || 1;
    top.forEach(([b, w], c) => { si[i * 4 + c] = b; sw[i * 4 + c] = w / s; });
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const m = new THREE.SkinnedMesh(g, tMeshes[gi].material); m.name = tMeshes[gi].name || 'Body' + gi;
  out.add(m); m.bind(skeleton, new THREE.Matrix4());
});
window.rigged = out;
const glb = await new GLTFExporter().parseAsync(out, { binary: true });
window.glb = btoa(new Uint8Array(glb).reduce((s, b) => s + String.fromCharCode(b), ''));
window.done = 1;

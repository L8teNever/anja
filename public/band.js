// Rotes Band verfolgen.
// 1. Maske: Pixel im Farbton des Bands (Farbton, Saettigung, Helligkeit – Haut und Holz fallen raus)
// 2. Zusammenhaengende Flecken finden, den groessten (bzw. den nahe der letzten Stelle) nehmen
// 3. Lage und Laenge des Bands aus der Form des Flecks
// 4. "One-Euro"-Filter: ruhig, wenn die Hand still ist, kaum Verzoegerung bei schneller Bewegung

export const BAND_DEFAULT = { hue: 6, tol: 16, sat: 0.38, val: 0.2 };

function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx / 255];
}

// data: RGBA, w/h: Groesse, color: {hue,tol,sat,val}, sens 0..1 weitet die Grenzen, flipY: Zeilen von unten
// prev: letzte Position {x,y} (normiert) zum Bevorzugen des richtigen Flecks
export function findBand(data, w, h, color = BAND_DEFAULT, sens = 0.5, flipY = false, prev = null) {
  const tol = color.tol * (0.6 + sens * 0.8);
  const smin = Math.max(0.12, color.sat * (1.3 - sens * 0.6));
  const vmin = Math.max(0.08, color.val * (1.3 - sens * 0.6));
  const N = w * h;
  const lab = new Int32Array(N).fill(-1);
  const parent = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  // Maske + Verbinden mit linkem/oberem Nachbarn (Union-Find)
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const p = i * 4;
      const [hh, s, v] = hsv(data[p], data[p + 1], data[p + 2]);
      let dh = Math.abs(hh - color.hue); if (dh > 180) dh = 360 - dh;
      if (dh > tol || s < smin || v < vmin) continue;
      const l = x > 0 ? lab[i - 1] : -1, u = y > 0 ? lab[i - w] : -1;
      if (l < 0 && u < 0) { lab[i] = parent.length; parent.push(parent.length); }
      else if (l >= 0 && u >= 0) { const a = find(l), b = find(u); lab[i] = a; if (a !== b) parent[b] = a; }
      else lab[i] = l >= 0 ? l : u;
    }
  }
  if (!parent.length) return null;
  // Flecken auswerten
  const st = new Map();
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (lab[i] < 0) continue;
      const r = find(lab[i]);
      let o = st.get(r);
      if (!o) st.set(r, (o = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 }));
      o.n++; o.sx += x; o.sy += y; o.sxx += x * x; o.syy += y * y; o.sxy += x * y;
    }
  }
  const minN = Math.max(6, N * 0.0006);
  let best = null, bestScore = 0, maxN = 0;
  for (const o of st.values()) maxN = Math.max(maxN, o.n);
  for (const o of st.values()) {
    if (o.n < minN) continue;
    let score = o.n;
    if (prev) {                      // in der Naehe der letzten Stelle bevorzugen
      const dx = o.sx / o.n / w - prev.x, dy = o.sy / o.n / h - (flipY ? 1 - prev.y : prev.y);
      score *= 1 / (1 + 6 * Math.hypot(dx, dy));
    }
    if (score > bestScore && o.n > maxN * 0.25) { bestScore = score; best = o; }
  }
  if (!best) return null;
  const n = best.n, cx = best.sx / n, cy = best.sy / n;
  // Form: Hauptachse aus den Momenten -> Laenge des Bands
  const vxx = best.sxx / n - cx * cx, vyy = best.syy / n - cy * cy, vxy = best.sxy / n - cx * cy;
  const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const half = Math.max(2 * Math.sqrt(Math.max(l1, 0)), Math.sqrt(n / Math.PI));   // halbe Laenge in Pixeln
  const y = (cy + 0.5) / h;
  return { x: (cx + 0.5) / w, y: flipY ? 1 - y : y, r: half / w, n };
}

// Farbe des Bands anlernen: kraeftigste Farbe im Bereich um (x,y) (normiert), Radius rad (normiert)
export function learnBand(data, w, h, x = 0.5, y = 0.5, rad = 0.18) {
  const bins = new Float64Array(36);
  const px = [];
  const x0 = Math.floor((x - rad) * w), x1 = Math.ceil((x + rad) * w), y0 = Math.floor((y - rad) * h), y1 = Math.ceil((y + rad) * h);
  for (let yy = Math.max(0, y0); yy < Math.min(h, y1); yy++) {
    for (let xx = Math.max(0, x0); xx < Math.min(w, x1); xx++) {
      const p = (yy * w + xx) * 4;
      const [hh, s, v] = hsv(data[p], data[p + 1], data[p + 2]);
      if (s < 0.35 || v < 0.2) continue;
      bins[Math.floor(hh / 10) % 36] += s * s;
      px.push([hh, s, v]);
    }
  }
  if (px.length < 10) return null;
  let b = 0;
  for (let i = 1; i < 36; i++) if (bins[i] > bins[b]) b = i;
  const c = b * 10 + 5;
  const near = px.filter((p) => { let d = Math.abs(p[0] - c); if (d > 180) d = 360 - d; return d < 15; });
  if (near.length < 10) return null;
  // Mittelwert des Farbtons (ueber Winkel), untere Grenzen fuer Saettigung/Helligkeit
  let sx = 0, sy = 0;
  for (const p of near) { sx += Math.cos((p[0] * Math.PI) / 180); sy += Math.sin((p[0] * Math.PI) / 180); }
  let hue = (Math.atan2(sy, sx) * 180) / Math.PI; if (hue < 0) hue += 360;
  const ss = near.map((p) => p[1]).sort((a, b2) => a - b2), vv = near.map((p) => p[2]).sort((a, b2) => a - b2);
  return { hue: Math.round(hue), tol: 16, sat: Math.round(ss[Math.floor(ss.length * 0.15)] * 0.8 * 100) / 100, val: Math.round(vv[Math.floor(vv.length * 0.1)] * 0.7 * 100) / 100 };
}

// One-Euro-Filter (Casiez et al.): wenig Zittern bei Stillstand, wenig Verzoegerung bei Bewegung
export class OneEuro {
  constructor(minCutoff = 1.5, beta = 8, dCutoff = 1) { Object.assign(this, { minCutoff, beta, dCutoff }); this.x = null; this.dx = 0; this.t = 0; }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(1e-3, (t - this.t) / 1000); this.t = t;
    const a = (c) => 1 / (1 + 1 / (2 * Math.PI * c * dt));
    const dv = (v - this.x) / dt;
    this.dx += a(this.dCutoff) * (dv - this.dx);
    const cut = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += a(cut) * (v - this.x);
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}

// Alte Schnittstelle (wird nicht mehr genutzt, bleibt fuer Kompatibilitaet)
export function detectRed(data, w, h, sens = 0.5, flipY = false) {
  return findBand(data, w, h, BAND_DEFAULT, sens, flipY);
}

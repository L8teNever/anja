// 360°-Formate: Projektionen, Erkennung und Umrechnung Blickrichtung -> Bildpunkt.
// Die Formeln entsprechen ffmpeg (libavfilter/vf_v360.c, Eingangsseite), damit alles,
// was ffmpeg/Kameras/YouTube in diesen Formaten erzeugen, richtig herum erscheint.
// Der Shader in viewer.js rechnet genau dasselbe auf der Grafikkarte.

export const PROJ = {
  equirect: 0,   // klassisch 360° (2:1) bzw. 180° (VR180) mit Blickwinkel
  flat: 1,       // normales Video als Kino-Leinwand
  fisheye: 2,    // eine Fischaugen-Linse (z. B. VR180-Kameras, 180–220°)
  dfisheye: 3,   // zwei Fischaugen nebeneinander (Rohformat vieler 360°-Kameras)
  cube: 4,       // Würfel 3×2 / 6×1 / 1×6
  eac: 5,        // YouTube „Equi-Angular Cubemap“
};

export const PROJ_LABEL = {
  equirect360: '360° (Standard)',
  equirect180: '180° (VR180)',
  fisheye: 'Fischauge',
  dfisheye: 'Doppel-Fischauge 360°',
  eac: 'YouTube-Würfel (EAC)',
  c3x2: 'Würfel 3×2',
  c6x1: 'Würfel 6×1',
  c1x6: 'Würfel 1×6',
  flat: 'Flach (Kino-Leinwand)',
};
export const STEREO_LABEL = { mono: 'Kein 3D', tb: '3D übereinander', lr: '3D nebeneinander' };

// Wuerfel-Anordnungen wie bei ffmpeg: Zeichen pro Position (r l u d f b) und Drehung (0–3 × 90°)
const CUBES = {
  c3x2: { cols: 3, rows: 2, order: 'rludfb', rot: '000000' },
  c6x1: { cols: 6, rows: 1, order: 'rludfb', rot: '000000' },
  c1x6: { cols: 1, rows: 6, order: 'rludfb', rot: '000000' },
  eac:  { cols: 3, rows: 2, order: 'lfrdbu', rot: '000313' },
};
const DIRS = 'rludfb'; // RIGHT, LEFT, UP, DOWN, FRONT, BACK

// Ein Format: { kind, fov, stereo: 'mono'|'tb'|'lr', swap }
//   kind: equirect360 | equirect180 | fisheye | dfisheye | eac | c3x2 | c6x1 | c1x6 | flat
//   fov:  Blickwinkel in Grad (Fischauge, Doppel-Fischauge, Leinwand)
// Greenscreen-Standardwerte: Farbton-Bereich in Grad, Mindest-Saettigung als Farbstaerke (0–0.5)
export const CHROMA_DEFAULT = { on: false, color: '#00ff00', hue: 26, sat: 0.05, soft: 0.12, choke: 0, spill: 0.6, lumMin: 0.04, lumMax: 1, mask: false };

export const DEFAULT_FORMAT = { kind: 'equirect360', fov: 0, stereo: 'mono', swap: false };

export function defaultFov(kind) {
  return { fisheye: 190, dfisheye: 195, flat: 70 }[kind] || 0;
}

export function normalize(f = {}) {
  const kind = PROJ_LABEL[f.kind] ? f.kind : 'equirect360';
  const stereo = STEREO_LABEL[f.stereo] ? f.stereo : 'mono';
  const fov = Number(f.fov) > 0 ? Math.min(360, Math.max(20, Number(f.fov))) : defaultFov(kind);
  return { kind, fov, stereo, swap: !!f.swap };
}

export function describe(f) {
  f = normalize(f);
  const fov = ['fisheye', 'dfisheye'].includes(f.kind) ? ` ${f.fov}°` : '';
  return `${PROJ_LABEL[f.kind]}${fov}${f.stereo !== 'mono' ? ` · ${STEREO_LABEL[f.stereo]}` : ''}`;
}

/* ---------- Parameter fuer Shader und JS-Umrechnung ---------- */

// aspect = Breite/Hoehe des ganzen Videobilds (fuer die Leinwand)
export function params(f, aspect = 16 / 9) {
  f = normalize(f);
  const rad = Math.PI / 180;
  const p = { proj: PROJ.equirect, range: [Math.PI, Math.PI / 2], grid: [1, 1], facePos: [0, 1, 2, 3, 4, 5], faceRot: [0, 0, 0, 0, 0, 0],
    stereo: f.stereo === 'tb' ? 1 : f.stereo === 'lr' ? 2 : 0, swap: f.swap ? 1 : 0, wrap: 0 };
  switch (f.kind) {
    case 'equirect360': p.range = [Math.PI, Math.PI / 2]; p.wrap = 1; break;
    case 'equirect180': p.range = [Math.PI / 2, Math.PI / 2]; break;
    case 'fisheye': p.proj = PROJ.fisheye; p.range = [f.fov / 180, f.fov / 180]; break;
    case 'dfisheye': p.proj = PROJ.dfisheye; p.range = [f.fov / 360, f.fov / 360]; break;
    case 'flat': {
      p.proj = PROJ.flat;
      const eyeAspect = aspect * (p.stereo === 2 ? 0.5 : 1) / (p.stereo === 1 ? 0.5 : 1);
      const rx = Math.tan((f.fov * rad) / 2);
      p.range = [rx, rx / eyeAspect];
      break;
    }
    default: {
      const c = CUBES[f.kind];
      p.proj = f.kind === 'eac' ? PROJ.eac : PROJ.cube;
      p.grid = [c.cols, c.rows];
      for (let pos = 0; pos < 6; pos++) {
        p.facePos[DIRS.indexOf(c.order[pos])] = pos;
        p.faceRot[pos] = Number(c.rot[pos]);
      }
    }
  }
  return p;
}

/* ---------- Richtung -> Bildpunkt (JS-Fassung, gleich wie der Shader) ----------
 * dir: three.js-Raum (x rechts, y oben, -z vorne), Laenge egal.
 * Rueckgabe: {u, v} im ganzen Videobild, u nach rechts, v nach UNTEN, 0..1 – oder null (ausserhalb).
 */
export function dirToUV(p, dir, eye = 0, texW = 4096, texH = 2048) {
  const n = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const x = dir.x / n, y = -dir.y / n, z = -dir.z / n; // ffmpeg-Achsen: y unten, z vorne
  let u, v, ok = true;
  const [rx, ry] = p.range;
  if (p.proj === PROJ.equirect) {
    u = 0.5 * (Math.atan2(x, z) / rx) + 0.5;
    v = 0.5 * (Math.asin(Math.max(-1, Math.min(1, y))) / ry) + 0.5;
    if (p.wrap) u = ((u % 1) + 1) % 1;
    ok = u >= 0 && u <= 1 && v >= 0 && v <= 1;
  } else if (p.proj === PROJ.flat) {
    if (z <= 1e-6) return null;
    u = 0.5 * ((x / z) / rx) + 0.5; v = 0.5 * ((y / z) / ry) + 0.5;
    ok = u >= 0 && u <= 1 && v >= 0 && v <= 1;
  } else if (p.proj === PROJ.fisheye) {
    const h = Math.hypot(x, y), lh = h > 0 ? h : 1;
    const phi = Math.atan2(h, z) / Math.PI;
    const uf = (x / lh) * phi / rx, vf = (y / lh) * phi / ry;
    ok = Math.abs(uf) < 0.5 && Math.abs(vf) < 0.5;
    u = uf + 0.5; v = vf + 0.5;
  } else if (p.proj === PROJ.dfisheye) {
    const h = Math.hypot(x, y), lh = h > 0 ? h : 1;
    const t = Math.acos(Math.min(1, Math.abs(z))) / Math.PI;
    let uh = 0.5 * (t * (x / lh) / rx) + 0.5;
    const vh = 0.5 * (t * (y / lh) / ry) + 0.5;
    uh = Math.min(1, Math.max(0, uh));
    u = z >= 0 ? 0.5 + 0.5 * uh : 0.5 * (1 - uh);
    v = Math.min(1, Math.max(0, vh));
  } else {
    const c = cubeFace(x, y, z, p);
    const pos = c.pos, cols = p.grid[0], rows = p.grid[1];
    const col = pos % cols, row = Math.floor(pos / cols);
    if (p.proj === PROJ.eac) {
      const uf = (2 / Math.PI) * Math.atan(c.uf) + 0.5, vf = (2 / Math.PI) * Math.atan(c.vf) + 0.5;
      const up = 2 / texW, vp = 2 / texH;
      u = ((uf + col) * (1 - 2 * up)) / 3 + up;
      v = vf * (0.5 - 2 * vp) + vp + 0.5 * row;
    } else {
      u = (col + 0.5 * c.uf + 0.5) / cols;
      v = (row + 0.5 * c.vf + 0.5) / rows;
    }
  }
  if (!ok) return null;
  return toEye(p, u, v, eye);
}

function cubeFace(x, y, z, p) {
  const phi = Math.atan2(x, z), theta = Math.asin(Math.max(-1, Math.min(1, y)));
  const Q = Math.PI / 4, H = Math.PI / 2;
  let dir, pn;
  if (phi >= -Q && phi < Q) { dir = 4; pn = phi; }
  else if (phi >= -(H + Q) && phi < -Q) { dir = 1; pn = phi + H; }
  else if (phi >= Q && phi < H + Q) { dir = 0; pn = phi - H; }
  else { dir = 5; pn = phi + (phi > 0 ? -Math.PI : Math.PI); }
  const th = Math.atan(Math.cos(pn));
  if (theta > th) dir = 3; else if (theta < -th) dir = 2;
  let uf, vf;
  switch (dir) {
    case 0: uf = -z / x; vf = y / x; break;
    case 1: uf = -z / x; vf = -y / x; break;
    case 2: uf = -x / y; vf = -z / y; break;
    case 3: uf = x / y; vf = -z / y; break;
    case 4: uf = x / z; vf = y / z; break;
    default: uf = x / z; vf = -y / z;
  }
  const pos = p.facePos[dir];
  const r = p.faceRot[pos];
  if (r === 1) [uf, vf] = [-vf, uf];
  else if (r === 2) [uf, vf] = [-uf, -vf];
  else if (r === 3) [uf, vf] = [vf, -uf];
  return { pos, uf, vf };
}

function toEye(p, u, v, eye) {
  const e = p.swap ? 1 - eye : eye;
  if (p.stereo === 1) v = 0.5 * v + 0.5 * e;
  else if (p.stereo === 2) u = 0.5 * u + 0.5 * e;
  return { u, v };
}

/* ---------- Erkennung ---------- */

// 1) Dateiname – gaengige Kennungen von Skybox, DeoVR, Kameras und YouTube
export function fromName(name) {
  const s = decodeURIComponent(name).toLowerCase().replace(/\.[a-z0-9]+$/, '');
  const t = new Set(s.split(/[^a-z0-9]+/).filter(Boolean));
  const has = (...k) => k.some((x) => t.has(x));
  const f = {};
  const fish = [...t].map((x) => /^(?:fisheye|fish|mkx|rf)(\d{3})$/.exec(x)).find(Boolean);
  if (has('dfisheye', 'dualfisheye')) f.kind = 'dfisheye';
  else if (fish || has('fisheye', 'fish', 'mkx200', 'mkx220', 'rf52', 'vrca220')) {
    f.kind = 'fisheye';
    if (fish) f.fov = Number(fish[1]);
    else if (has('mkx220', 'vrca220')) f.fov = 220;
    else if (has('mkx200')) f.fov = 200;
  }
  else if (has('eac')) f.kind = 'eac';
  else if (has('c6x1')) f.kind = 'c6x1';
  else if (has('c1x6')) f.kind = 'c1x6';
  else if (has('c3x2', 'cube', 'cubemap')) f.kind = 'c3x2';
  else if (has('180', 'vr180', 'half')) f.kind = 'equirect180';
  else if (has('360', 'vr360', 'equirect', 'equi')) f.kind = 'equirect360';
  else if (has('flat', '2d')) f.kind = 'flat';
  if (has('tb', 'ou', 'overunder', '3dv', 'topbottom', 'tab')) f.stereo = 'tb';
  else if (has('bt')) { f.stereo = 'tb'; f.swap = true; }
  else if (has('lr', 'sbs', '3dh', 'sidebyside', 'hsbs')) f.stereo = 'lr';
  else if (has('rl')) { f.stereo = 'lr'; f.swap = true; }
  else if (has('mono', '2d')) f.stereo = 'mono';
  if (has('rf52')) { f.stereo = f.stereo || 'lr'; }
  return f;
}

// 2) Metadaten im Video: Google Spatial Media (MP4: st3d/sv3d, v1-XML) und Matroska/WebM
export function fromMeta(bytes) {
  const b = bytes, f = {};
  const find = (str, from = 0) => {
    const c = [...str].map((ch) => ch.charCodeAt(0));
    outer: for (let i = from; i < b.length - c.length; i++) {
      for (let j = 0; j < c.length; j++) if (b[i + j] !== c[j]) continue outer;
      return i;
    }
    return -1;
  };
  const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

  // MP4 st3d: Stereo-Modus 0 mono, 1 oben/unten, 2 links/rechts
  const st = find('st3d');
  if (st > 0 && u32(st - 4) >= 13) f.stereo = ['mono', 'tb', 'lr'][b[st + 8]] || undefined;
  // MP4 sv3d/proj: equi (mit Ausschnitt -> 180°), cbmp (Wuerfel), mshp (Mesh, meist YouTube-EAC)
  const eq = find('equi');
  if (eq > 0 && find('prhd') > 0) {
    const top = u32(eq + 8) / 2 ** 32, bottom = u32(eq + 12) / 2 ** 32, left = u32(eq + 16) / 2 ** 32, right = u32(eq + 20) / 2 ** 32;
    const hfov = 360 * (1 - left - right);
    f.kind = hfov < 270 ? 'equirect180' : 'equirect360';
    if (top + bottom > 0.2 && hfov >= 270) f.kind = 'equirect360';
  } else if (find('cbmp') > 0 && find('prhd') > 0) f.kind = 'c3x2';
  else if (find('mshp') > 0 && find('prhd') > 0) f.kind = 'eac';
  // Spatial Media v1 (XML im uuid-Block)
  const xml = find('GSpherical');
  if (xml > 0) {
    const txt = String.fromCharCode(...b.subarray(xml, Math.min(b.length, xml + 2000)));
    const sm = /StereoMode>\s*([a-z-]+)/i.exec(txt)?.[1]?.toLowerCase();
    if (sm === 'top-bottom') f.stereo = 'tb'; else if (sm === 'left-right') f.stereo = 'lr'; else if (sm === 'mono') f.stereo = 'mono';
    if (/Spherical>\s*true/i.test(txt) && !f.kind) {
      const cw = Number(/CroppedAreaImageWidthPixels>\s*(\d+)/i.exec(txt)?.[1]);
      const fw = Number(/FullPanoWidthPixels>\s*(\d+)/i.exec(txt)?.[1]);
      f.kind = cw && fw && cw / fw < 0.75 ? 'equirect180' : 'equirect360';
    }
  }
  // Matroska/WebM: StereoMode (53 B8) und ProjectionType (76 71), jeweils 1-Byte-Wert
  for (let i = 0; i < b.length - 3; i++) {
    if (b[i] === 0x53 && b[i + 1] === 0xb8 && b[i + 2] === 0x81) {
      // 0 mono, 1 nebeneinander (links zuerst), 11 nebeneinander (rechts zuerst),
      // 3 uebereinander (links oben), 2 uebereinander (rechts oben)
      const m = b[i + 3];
      if (m === 0) f.stereo = 'mono';
      else if (m === 1 || m === 11) { f.stereo = 'lr'; f.swap = m === 11; }
      else if (m === 2 || m === 3) { f.stereo = 'tb'; f.swap = m === 2; }
    }
    if (b[i] === 0x76 && b[i + 1] === 0x71 && b[i + 2] === 0x81) {
      const pt = b[i + 3];
      if (pt === 1) f.kind = f.kind || 'equirect360'; else if (pt === 2) f.kind = 'c3x2'; else if (pt === 3) f.kind = 'eac';
    }
  }
  return f;
}

// Liest Anfang (und bei Bedarf Ende) der Datei per Range-Anfrage und sucht Metadaten
export async function metaFromUrl(url) {
  const get = async (range) => {
    const r = await fetch(url, { headers: { Range: range } });
    if (!r.ok) return { bytes: new Uint8Array(0), total: 0 };
    const total = Number(/\/(\d+)$/.exec(r.headers.get('Content-Range') || '')?.[1]) || 0;
    return { bytes: new Uint8Array(await r.arrayBuffer()), total };
  };
  try {
    const head = await get('bytes=0-2097151');
    let f = fromMeta(head.bytes);
    if (!f.kind && !f.stereo && head.total > head.bytes.length) {
      const start = Math.max(head.bytes.length, head.total - 4194304);
      f = fromMeta((await get(`bytes=${start}-`)).bytes);
    }
    return f;
  } catch { return {}; }
}

export async function metaFromFile(file) {
  try {
    let f = fromMeta(new Uint8Array(await file.slice(0, 2097152).arrayBuffer()));
    if (!f.kind && !f.stereo && file.size > 2097152) {
      f = fromMeta(new Uint8Array(await file.slice(Math.max(2097152, file.size - 4194304)).arrayBuffer()));
    }
    return f;
  } catch { return {}; }
}

// 3) Bildanalyse: Seitenverhaeltnis + Vergleich der Bildhaelften + dunkle Ecken (Fischauge)
// img: ImageData eines verkleinerten Videobilds (z. B. 256 breit)
export function fromFrame(img) {
  const { width: w, height: h, data } = img;
  const r = w / h;
  const gray = (x, y) => { const i = (y * w + x) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
  // Helligkeits-Spannweite: ist das Bild ueberhaupt aussagekraeftig?
  let min = 255, max = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { const g = gray(x, y); if (g < min) min = g; if (g > max) max = g; }
  const informative = max - min > 40;
  // Aehnlichkeit zweier Bildbereiche: Korrelation der Details. Pro Zeile wird der Mittelwert
  // abgezogen, damit Himmel-oben/Boden-unten nicht als "gleich" zaehlt – bei 3D sind die
  // Details beider Haelften fast deckungsgleich, bei Vorne/Hinten nicht.
  const corr0 = (ax, ay, bx, by, cw, ch) => {
    let sab = 0, saa = 0, sbb = 0;
    for (let y = 0; y < ch; y += 2) {
      let ma = 0, mb = 0, k = 0;
      for (let x = 0; x < cw; x += 2) { ma += gray(ax + x, ay + y); mb += gray(bx + x, by + y); k++; }
      ma /= k; mb /= k;
      for (let x = 0; x < cw; x += 2) {
        const a = gray(ax + x, ay + y) - ma, bb = gray(bx + x, by + y) - mb;
        sab += a * bb; saa += a * a; sbb += bb * bb;
      }
    }
    if (saa < 1e-6 || sbb < 1e-6) return 0;
    return sab / Math.sqrt(saa * sbb);
  };
  // 3D-Augen sind gegeneinander leicht verschoben (Parallaxe): beste Verschiebung suchen
  const corr = (ax, ay, bx, by, cw, ch, horiz = true) => {
    const m = Math.max(2, Math.round((horiz ? cw : ch) * 0.06));
    let best = -1;
    for (let d = -m; d <= m; d += 1) {
      const c = horiz
        ? corr0(ax + Math.max(0, d), ay, bx + Math.max(0, -d), by, cw - Math.abs(d), ch)
        : corr0(ax, ay + Math.max(0, d), bx, by + Math.max(0, -d), cw, ch - Math.abs(d));
      if (c > best) best = c;
    }
    return best;
  };
  // Innenbereich eines Fischaugen-Kreises (eingeschriebenes Quadrat)
  const inner = (ox, oy, cw, ch) => {
    const s = Math.floor(Math.min(cw, ch) * 0.68);
    return [ox + Math.floor((cw - s) / 2), oy + Math.floor((ch - s) / 2), s];
  };
  // Fischauge: Ecken ausserhalb des Kreises sind (fast) schwarz
  const darkCorners = (ox, oy, cw, ch) => {
    const s = Math.max(2, Math.floor(Math.min(cw, ch) * 0.08));
    let sum = 0, n = 0;
    for (const [cx, cy] of [[0, 0], [cw - s, 0], [0, ch - s], [cw - s, ch - s]]) {
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { sum += gray(ox + cx + x, oy + cy + y); n++; }
    }
    return sum / n < 24;
  };
  const half = Math.floor(w / 2), halfH = Math.floor(h / 2);
  // typische Zeile (Median), damit einzelne Kanten an der Naht nicht stoeren
  const seamless = () => {
    const seam = [], inner = [];
    for (let y = 0; y < h; y++) {
      seam.push(Math.abs(gray(0, y) - gray(w - 1, y)));
      inner.push(Math.abs(gray(1, y) - gray(2, y)), Math.abs(gray(w - 2, y) - gray(w - 3, y)));
    }
    const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
    return med(seam) < Math.max(8, med(inner) * 4);
  };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  if (near(r, 4, 0.25)) return { f: { kind: 'equirect360', stereo: 'lr' }, informative };
  if (near(r, 6, 0.4)) return { f: { kind: 'c6x1', stereo: 'mono' }, informative };
  if (near(r, 1 / 6, 0.03)) return { f: { kind: 'c1x6', stereo: 'mono' }, informative };
  if (near(r, 1.5, 0.06)) return { f: { kind: 'eac', stereo: 'mono' }, informative };
  if (near(r, 3, 0.15)) return { f: { kind: 'eac', stereo: 'tb' }, informative };       // 3D-EAC uebereinander? selten
  if (near(r, 2, 0.12)) {
    if (darkCorners(0, 0, half, h) && darkCorners(half, 0, half, h)) {
      const [ax, ay, s] = inner(0, 0, half, h), [bx] = inner(half, 0, half, h);
      const similar = corr(ax, ay, bx, ay, s, s) > 0.6;
      return { f: similar ? { kind: 'fisheye', stereo: 'lr' } : { kind: 'dfisheye', stereo: 'mono' }, informative };
    }
    const similar = corr(0, 0, half, 0, half, h) > 0.6;
    if (similar) return { f: { kind: 'equirect180', stereo: 'lr' }, informative };
    // echtes 360° ist rundum: linker und rechter Rand gehen nahtlos ineinander ueber.
    // Passt die Naht nicht, ist es ein auf 2:1 gestrecktes 180°-Video.
    return { f: { kind: seamless() ? 'equirect360' : 'equirect180', stereo: 'mono' }, informative };
  }
  if (near(r, 1, 0.08)) {
    if (corr(0, 0, 0, halfH, w, halfH, true) > 0.6) return { f: { kind: 'equirect360', stereo: 'tb' }, informative };
    if (darkCorners(0, 0, w, h)) return { f: { kind: 'fisheye', stereo: 'mono' }, informative };
    return { f: { kind: 'equirect180', stereo: 'mono' }, informative };
  }
  if (near(r, 0.5, 0.05)) return { f: { kind: 'equirect180', stereo: 'tb' }, informative };
  return { f: { kind: 'flat', stereo: 'mono' }, informative };
}

// Schnelle erste Vermutung nur aus der Bildgroesse (bevor ein Bild analysiert ist)
export function fromSize(w, h) {
  const r = w / h;
  if (Math.abs(r - 4) < 0.25) return { kind: 'equirect360', stereo: 'lr' };
  if (Math.abs(r - 2) < 0.12) return { kind: 'equirect360', stereo: 'mono' };
  if (Math.abs(r - 1) < 0.08) return { kind: 'equirect360', stereo: 'tb' };
  if (Math.abs(r - 1.5) < 0.06) return { kind: 'eac', stereo: 'mono' };
  if (Math.abs(r - 6) < 0.4) return { kind: 'c6x1', stereo: 'mono' };
  if (Math.abs(r - 0.5) < 0.05) return { kind: 'equirect180', stereo: 'tb' };
  return { kind: 'flat', stereo: 'mono' };
}

// Zusammenfuehren: Dateiname schlaegt Metadaten schlaegt Bildanalyse
export function combine(...parts) {
  const out = {};
  for (const p of parts.reverse()) Object.assign(out, Object.fromEntries(Object.entries(p || {}).filter(([, v]) => v !== undefined)));
  return normalize(out);
}

// Kleines Videobild als ImageData (fuer fromFrame)
export function grabFrame(video, maxW = 256) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const s = Math.min(1, maxW / w);
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w * s)); c.height = Math.max(2, Math.round(h * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  try { ctx.drawImage(video, 0, 0, c.width, c.height); return ctx.getImageData(0, 0, c.width, c.height); } catch { return null; }
}

// Vorschaubild 2:1 (wie ein normales 360°-Bild) aus jedem Format erzeugen
export function renderPreview(video, f, outW = 768) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const sw = Math.min(w, 2048), sh = Math.round(h * (sw / w));
  const src = document.createElement('canvas'); src.width = sw; src.height = sh;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(video, 0, 0, sw, sh);
  const sd = sctx.getImageData(0, 0, sw, sh).data;
  const p = params(f, w / h);
  const half = normalize(f).kind === 'flat' || ['equirect180', 'fisheye'].includes(normalize(f).kind);
  const outH = outW / 2;
  const out = new ImageData(outW, outH);
  // 180°/Fischauge/Leinwand: nur die vordere Haelfte zeigen, sonst ganz rundum
  const lonSpan = half ? Math.PI : 2 * Math.PI, latSpan = half ? Math.PI / 2 : Math.PI;
  for (let y = 0; y < outH; y++) {
    const lat = (0.5 - (y + 0.5) / outH) * latSpan;
    for (let x = 0; x < outW; x++) {
      const lon = ((x + 0.5) / outW - 0.5) * lonSpan;
      const d = { x: Math.cos(lat) * Math.sin(lon), y: Math.sin(lat), z: -Math.cos(lat) * Math.cos(lon) };
      const uv = dirToUV(p, d, 0, w, h);
      const o = (y * outW + x) * 4;
      if (!uv) { out.data[o + 3] = 255; continue; }
      const sx = Math.min(sw - 1, Math.max(0, Math.floor(uv.u * sw))), sy = Math.min(sh - 1, Math.max(0, Math.floor(uv.v * sh)));
      const i = (sy * sw + sx) * 4;
      out.data[o] = sd[i]; out.data[o + 1] = sd[i + 1]; out.data[o + 2] = sd[i + 2]; out.data[o + 3] = 255;
    }
  }
  const c = document.createElement('canvas'); c.width = outW; c.height = outH;
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

/* ---------- Greenscreen-Farbe automatisch finden ----------
 * Haeufigster kraeftige Farbton im Bild (meist der Hintergrund). Liefert Farbe,
 * passenden Farbton-Bereich und Mindest-Saettigung.
 */
export function autoKey(img) {
  const { data } = img;
  const BINS = 72, hist = new Float64Array(BINS);
  const px = [];
  for (let i = 0; i < data.length; i += 4 * 3) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = (b - y) * 0.565, cr = (r - y) * 0.713, cl = Math.hypot(cb, cr);
    if (cl < 0.025 || y < 0.08 || y > 0.97) continue;
    const ang = Math.atan2(cr, cb);
    const bin = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * BINS) % BINS;
    hist[bin] += cl; // kraeftige Farben zaehlen mehr
    px.push([ang, cl, data[i], data[i + 1], data[i + 2]]);
  }
  if (!px.length) return null;
  let best = 0, bestV = -1;
  for (let k = 0; k < BINS; k++) {
    const v = hist[(k + BINS - 1) % BINS] + 2 * hist[k] + hist[(k + 1) % BINS];
    if (v > bestV) { bestV = v; best = k; }
  }
  const center = ((best + 0.5) / BINS) * 2 * Math.PI - Math.PI;
  const near = px.filter((p) => Math.abs(Math.atan2(Math.sin(p[0] - center), Math.cos(p[0] - center))) < 0.35);
  if (near.length < 20) return null;
  const med = (k) => { const a = near.map((p) => p[k]).sort((x, y) => x - y); return a[a.length >> 1]; };
  const hex = (n) => Math.round(n).toString(16).padStart(2, '0');
  const color = `#${hex(med(2))}${hex(med(3))}${hex(med(4))}`;
  // Streuung des Farbtons -> Bereich, Saettigung -> Mindestwert
  const devs = near.map((p) => Math.abs(Math.atan2(Math.sin(p[0] - center), Math.cos(p[0] - center)))).sort((a, b) => a - b);
  const p90 = devs[Math.floor(devs.length * 0.9)];
  const hue = Math.round(Math.min(40, Math.max(14, (p90 * 180) / Math.PI + 6)));
  const cls = near.map((p) => p[1]).sort((a, b) => a - b);
  const p10 = cls[Math.floor(cls.length * 0.1)];
  const sat = Math.round(Math.min(0.25, Math.max(0.025, p10 * 0.6)) * 1000) / 1000;
  return { color, hue, sat, share: near.length / px.length };
}

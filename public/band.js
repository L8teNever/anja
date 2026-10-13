// Rotes Band finden: im (kleinen) Kamerabild alle deutlich roten Pixel sammeln.
// data: RGBA-Pixel, w/h: Groesse, sens: Empfindlichkeit 0..1, flipY: Zeilen von unten (readPixels)
// Rueckgabe: { x, y, r } normiert (x/y 0..1 von links oben, r relativ zur Bildbreite) oder null
export function detectRed(data, w, h, sens = 0.5, flipY = false) {
  const thr = 30 + (1 - sens) * 90;
  let n = 0, sx = 0, sy = 0;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 70 && r - Math.max(g, b) > thr && r > 1.5 * g) { n++; sx += x; sy += y; }
    }
  }
  if (n < w * h * 0.0015) return null;
  let cy = sy / n / h;
  if (flipY) cy = 1 - cy;
  return { x: sx / n / w, y: cy, r: Math.sqrt(n / Math.PI) / w };
}

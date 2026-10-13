// Einstellungen direkt in der Brille: eine Tafel mit Reitern (Videos, Format, Greenscreen,
// Position, Haende). Alles wird per Strahl/Pinch bedient und wirkt sofort live im Video.
//
// Seiten kommen als Funktion (immer frische Werte):
//   pages() -> [{ title, items: [...] }]
// Elemente:
//   { type: 'slider', label, min, max, step, get(), set(v), fmt(v) }
//   { type: 'toggle', label, get(), set(bool) }
//   { type: 'choice', label, options: [{ v, l }], get(), set(v) }
//   { type: 'buttons', buttons: [{ label, action(), accent }] }
//   { type: 'chips', chips: [{ label, active, action() }] }       // z. B. Videoliste
//   { type: 'info', text, color }                                 // Hinweis, optional Farbfeld
// Jedes Element kann hidden: true haben.
import * as THREE from 'three';

export const SW = 1024, SH = 820;          // Canvas-Pixel
export const SET_W = 0.92;                 // Meter
export const SET_H = SET_W * SH / SW;

const C = {
  bg: 'rgba(22, 19, 31, 0.9)', line: 'rgba(255,255,255,0.10)', text: '#f1edf9', muted: '#a49cba',
  accent: '#b69cff', ink: '#1f1638', btn: 'rgba(255,255,255,0.08)', hover: 'rgba(182,156,255,0.30)',
  track: 'rgba(255,255,255,0.16)', ok: '#7ee0b0',
};
const X0 = 32, CX = 360, CX1 = SW - 36;   // Beschriftung links, Bedienelement rechts

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

export class VRSettings {
  constructor(scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SW; this.canvas.height = SH;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(SET_W, SET_H),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }));
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.pages = () => [];
    this.tab = 0;
    this.rects = [];
    this.hover = new Map();        // Controller -> Rechteck
    this.drag = null;              // { c, rect }
    this.page = 0;                 // Blaettern in langen Listen
    this.lastDraw = 0;
  }

  get visible() { return this.mesh.visible; }
  set visible(v) { this.mesh.visible = v; if (v) this.draw(); else { this.drag = null; this.hover.clear(); } }

  _px(uv) { return { x: uv.x * SW, y: (1 - uv.y) * SH }; }

  _at(uv) {
    const { x, y } = this._px(uv);
    return this.rects.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) || null;
  }

  setHover(c, uv) {
    const r = uv ? this._at(uv) : null;
    if (this.hover.get(c) !== r) { this.hover.set(c, r); this.draw(); }
    if (this.drag?.c === c && uv) { this.drag.rect.slide?.(this._px(uv).x); this.draw(); }
    return r;
  }

  press(c, uv) {
    const r = this._at(uv);
    if (!r) return false;
    if (r.slide) { this.drag = { c, rect: r }; r.slide(this._px(uv).x); }
    else r.act?.();
    this.draw();
    return true;
  }

  release(c) { if (this.drag?.c === c) { this.drag = null; this.draw(); } }

  // Text auf Breite kuerzen
  _fit(t, w) {
    const ctx = this.ctx;
    if (ctx.measureText(t).width <= w) return t;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > w) t = t.slice(0, -1);
    return `${t}…`;
  }

  draw() {
    if (!this.mesh.visible) return;
    this.lastDraw = performance.now();
    const ctx = this.ctx;
    const hov = new Set(this.hover.values());
    const pages = this.pages();
    if (this.tab >= pages.length) this.tab = 0;
    this.rects = [];
    ctx.clearRect(0, 0, SW, SH);
    rrect(ctx, 2, 2, SW - 4, SH - 4, 40); ctx.fillStyle = C.bg; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = C.line; ctx.stroke();
    ctx.textBaseline = 'middle';

    // Reiter
    const tw = (SW - 2 * X0) / Math.max(1, pages.length);
    pages.forEach((p, k) => {
      const r = { x: X0 + k * tw + 4, y: 18, w: tw - 8, h: 62, act: () => { this.tab = k; this.page = 0; } };
      this.rects.push(r);
      const on = k === this.tab;
      rrect(ctx, r.x, r.y, r.w, r.h, 31);
      ctx.fillStyle = on ? C.accent : hov.has(r) ? C.hover : C.btn; ctx.fill();
      ctx.font = '600 26px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = on ? C.ink : C.text;
      ctx.fillText(this._fit(p.title, r.w - 16), r.x + r.w / 2, r.y + r.h / 2 + 1);
    });

    let y = 104;
    const page = pages[this.tab];
    for (const it of page?.items || []) {
      if (it.hidden) continue;
      if (y > SH - 50) break;
      y = this[`_${it.type}`]?.(it, y, hov) ?? y;
      y += 8;
    }
    this.texture.needsUpdate = true;
  }

  _label(text, y, h) {
    const ctx = this.ctx;
    ctx.font = '500 25px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = C.text;
    ctx.fillText(this._fit(text, CX - X0 - 14), X0, y + h / 2);
  }

  _slider(it, y, hov) {
    const ctx = this.ctx, h = 62;
    const v = Number(it.get());
    const frac = Math.min(1, Math.max(0, (v - it.min) / (it.max - it.min)));
    this._label(`${it.label}`, y, h);
    ctx.font = '600 23px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = C.accent;
    ctx.fillText(it.fmt ? it.fmt(v) : String(v), CX - 16, y + h / 2);
    const tx = CX + 14, tw = CX1 - tx - 14, cy = y + h / 2;
    const r = { x: CX, y, w: CX1 - CX, h,
      slide: (px) => {
        let f = Math.min(1, Math.max(0, (px - tx) / tw));
        let nv = it.min + f * (it.max - it.min);
        if (it.step) nv = Math.round(nv / it.step) * it.step;
        it.set(Number(nv.toFixed(4)));
      } };
    this.rects.push(r);
    const on = hov.has(r) || this.drag?.rect === r;
    rrect(ctx, tx, cy - 7, tw, 14, 7); ctx.fillStyle = C.track; ctx.fill();
    rrect(ctx, tx, cy - 7, Math.max(14, tw * frac), 14, 7); ctx.fillStyle = C.accent; ctx.fill();
    ctx.beginPath(); ctx.arc(tx + tw * frac, cy, on ? 18 : 13, 0, Math.PI * 2); ctx.fillStyle = C.text; ctx.fill();
    return y + h;
  }

  _toggle(it, y, hov) {
    const ctx = this.ctx, h = 58;
    this._label(it.label, y, h);
    const on = !!it.get();
    const w = 84, x = CX1 - w, cy = y + h / 2;
    const r = { x: CX, y, w: CX1 - CX, h, act: () => it.set(!it.get()) };
    this.rects.push(r);
    rrect(ctx, x, cy - 22, w, 44, 22); ctx.fillStyle = on ? C.ok : (hov.has(r) ? C.hover : C.track); ctx.fill();
    ctx.beginPath(); ctx.arc(on ? x + w - 22 : x + 22, cy, 17, 0, Math.PI * 2); ctx.fillStyle = C.text; ctx.fill();
    ctx.font = '600 22px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = on ? C.ok : C.muted;
    ctx.fillText(on ? 'An' : 'Aus', x - 16, cy);
    return y + h;
  }

  // Chips nebeneinander, mit Zeilenumbruch; Rueckgabe: neue y-Position
  _chipRow(list, x0, x1, y, hov, isActive) {
    const ctx = this.ctx, ch = 48, gap = 10;
    ctx.font = '600 23px system-ui, sans-serif';
    let x = x0;
    for (const c of list) {
      const label = this._fit(c.label, x1 - x0 - 30);
      const w = Math.min(x1 - x0, ctx.measureText(label).width + 34);
      if (x + w > x1) { x = x0; y += ch + gap; }
      const r = { x, y, w, h: ch, act: c.action };
      this.rects.push(r);
      const on = isActive(c);
      rrect(ctx, x, y, w, ch, 24);
      ctx.fillStyle = on ? C.accent : hov.has(r) ? C.hover : C.btn; ctx.fill();
      ctx.textAlign = 'center'; ctx.fillStyle = on ? C.ink : C.text;
      ctx.fillText(label, x + w / 2, y + ch / 2 + 1);
      x += w + gap;
    }
    return y + ch;
  }

  _choice(it, y, hov) {
    const cur = it.get();
    this._label(it.label, y, 48);
    return this._chipRow(it.options.map((o) => ({ label: o.l, v: o.v, action: () => it.set(o.v) })), CX, CX1, y, hov, (c) => c.v === cur);
  }

  _buttons(it, y, hov) {
    return this._chipRow(it.buttons.map((b) => ({ ...b, action: b.action })), X0, CX1, y, hov, (b) => !!b.accent);
  }

  _chips(it, y, hov) {
    const per = it.perPage || 14;
    const pages = Math.max(1, Math.ceil(it.chips.length / per));
    if (this.page >= pages) this.page = 0;
    const list = it.chips.slice(this.page * per, this.page * per + per);
    y = this._chipRow(list, X0, CX1, y, hov, (c) => !!c.active);
    if (pages > 1) {
      y += 10;
      y = this._chipRow([
        { label: '◀ Zurück', action: () => { this.page = (this.page + pages - 1) % pages; } },
        { label: `Seite ${this.page + 1}/${pages}`, action: () => {} },
        { label: 'Weiter ▶', action: () => { this.page = (this.page + 1) % pages; } },
      ], X0, CX1, y, hov, () => false);
    }
    return y;
  }

  _info(it, y) {
    const ctx = this.ctx, h = 40;
    let x = X0;
    if (it.color) {
      rrect(ctx, x, y + 6, 28, 28, 6); ctx.fillStyle = it.color; ctx.fill();
      x += 40;
    }
    ctx.font = '400 22px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = C.muted;
    ctx.fillText(this._fit(it.text || '', CX1 - x), x, y + h / 2);
    return y + h;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture.dispose();
  }
}

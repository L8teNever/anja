// Koerpermasse im Mixed-Reality-Modus: Groesse, Hueftgelenk-Hoehe, Knie-Hoehe (cm) per +/- einstellen.
// Waehrend das Menue offen ist, fahren leuchtende Ringe vom Boden auf die eingestellte Hueft- und Knie-Hoehe
// hoch, damit du an dir selbst pruefen kannst, ob es stimmt. Gespeichert im Browser (bleibt erhalten).
import * as THREE from 'three';
import { bodyDims } from '/skeleton.js';

const KEY = 'anja-body';
const W = 768, H = 560;
const ROWS = [
  ['height', 'Größe', 120, 220],
  ['hip', 'Hüfte (Gelenk, Leiste)', 50, 125],
  ['knee', 'Knie (Mitte)', 25, 70],
];
const STEPS = [-5, -1, 1, 5];
const RING_COL = { hip: 0xffb03d, knee: 0x5dffb0 };

export function loadProfile() {
  try { return { height: 175, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { height: 175 }; }
}
function saveProfile(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* egal */ } }

export class MeasurePanel {
  constructor(scene, { onChange, eyeHeight }) {
    this.scene = scene; this.onChange = onChange; this.eyeHeight = eyeHeight;
    this.profile = loadProfile();
    this.hover = null; this.note = '';
    this.c = document.createElement('canvas'); this.c.width = W; this.c.height = H;
    this.tex = new THREE.CanvasTexture(this.c); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5 * H / W),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false }));
    this.mesh.renderOrder = 31; this.mesh.visible = false;
    scene.add(this.mesh);
    // Ringe um dich herum
    this.rings = {};
    for (const k of ['hip', 'knee']) {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.006, 8, 96).rotateX(Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: RING_COL[k], transparent: true, opacity: 0.95, depthTest: false }));
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.32, 64).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: RING_COL[k], transparent: true, opacity: 0.12, depthTest: false, side: THREE.DoubleSide }));
      const lc = document.createElement('canvas'); lc.width = 256; lc.height = 64;
      const lt = new THREE.CanvasTexture(lc); lt.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.04), new THREE.MeshBasicMaterial({ map: lt, transparent: true, depthTest: false }));
      [ring, disc, label].forEach((m) => { m.renderOrder = 29; g.add(m); });
      g.visible = false;
      scene.add(g);
      this.rings[k] = { g, label, lc, lt, y: 0, from: 0, t0: -1e9, text: '' };
    }
    this.draw();
  }

  get open() { return this.mesh.visible; }

  dims() { return bodyDims(this.profile); }
  value(k) { const d = this.dims(); return Math.round(k === 'height' ? d.H * 100 : k === 'hip' ? d.hip * 100 : d.knee * 100); }

  show(cam, floorY) {
    const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld));
    dir.y = 0; if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1); dir.normalize();
    this.mesh.position.copy(pos).addScaledVector(dir, 0.65); this.mesh.position.y = pos.y - 0.1;
    this.mesh.lookAt(pos.x, pos.y - 0.1, pos.z);
    this.mesh.visible = true;
    this.floorY = floorY;
    for (const k of ['hip', 'knee']) this._rise(k, true);
    this.draw();
  }

  hide() { this.mesh.visible = false; for (const r of Object.values(this.rings)) r.g.visible = false; }

  _rise(k, fromFloor) {
    const r = this.rings[k];
    r.from = fromFloor ? 0 : r.y; r.t0 = performance.now();
  }

  // uv -> Aktion
  _at(uv) {
    const x = uv.x * W, y = (1 - uv.y) * H;
    for (let i = 0; i < ROWS.length; i++) {
      const y0 = 92 + i * 108;
      if (y >= y0 && y < y0 + 92) for (let j = 0; j < 4; j++) {
        const x0 = 330 + j * 108;
        if (x >= x0 && x < x0 + 100) return `${ROWS[i][0]}:${STEPS[j]}`;
      }
    }
    if (y >= 430 && y < 540) return ['measure', 'auto', 'done'][Math.min(2, Math.floor((x - 16) / 246))] || null;
    return null;
  }

  setHover(uv) { const h = uv ? this._at(uv) : null; if (h !== this.hover) { this.hover = h; this.draw(); } }

  press(uv) {
    const a = this._at(uv);
    if (!a) return;
    const p = this.profile;
    if (a === 'done') { this.hide(); return; }
    if (a === 'auto') { delete p.hip; delete p.knee; this.note = 'Hüfte und Knie aus der Größe geschätzt'; this._rise('hip'); this._rise('knee'); }
    else if (a === 'measure') {
      const eye = this.eyeHeight();
      if (eye > 1.0) { p.height = Math.round(eye / 0.936 * 100); this.note = `Gemessen: ${p.height} cm (gerade stehen, geradeaus schauen)`; }
      else this.note = 'Zum Messen gerade hinstellen und geradeaus schauen';
      this._rise('hip'); this._rise('knee');
    } else {
      const [k, st] = a.split(':'); const row = ROWS.find((r) => r[0] === k);
      p[k] = Math.max(row[2], Math.min(row[3], this.value(k) + Number(st)));
      if (k === 'height') { this._rise('hip'); this._rise('knee'); } else this._rise(k);
      this.note = '';
    }
    saveProfile(p);
    this.onChange?.(p);
    this.draw();
  }

  // pro Frame: Ringe um die Koerpermitte (xz), Hoehe animiert vom Boden
  update(center, floorY) {
    if (!this.open) return;
    const now = performance.now();
    for (const k of ['hip', 'knee']) {
      const r = this.rings[k], target = this.value(k) / 100;
      const t = Math.min(1, (now - r.t0) / 900), e = 1 - Math.pow(1 - t, 3);
      r.y = r.from + (target - r.from) * e;
      r.g.visible = true;
      r.g.position.set(center.x, floorY + r.y, center.z);
      const text = `${k === 'hip' ? 'Hüfte' : 'Knie'} ${this.value(k)} cm`;
      if (text !== r.text) {
        r.text = text;
        const ctx = r.lc.getContext('2d'); ctx.clearRect(0, 0, 256, 64);
        ctx.fillStyle = 'rgba(22,19,31,0.85)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(0, 4, 256, 56, 28) : ctx.rect(0, 4, 256, 56); ctx.fill();
        ctx.fillStyle = '#' + RING_COL[k].toString(16).padStart(6, '0'); ctx.font = '600 30px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 128, 33);
        r.lt.needsUpdate = true;
      }
      // Schild seitlich am Ring, zum Panel gedreht
      r.label.position.set(0.34, 0.03, 0);
      r.label.lookAt(this.mesh.position.x, floorY + r.y + 0.03, this.mesh.position.z);
    }
  }

  draw() {
    const ctx = this.c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(22,19,31,0.9)';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(0, 0, W, H, 36) : ctx.rect(0, 0, W, H); ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f1edf9'; ctx.font = '700 30px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Körpermaße', 28, 44);
    ctx.font = '400 19px system-ui, sans-serif'; ctx.fillStyle = '#b9b2cc'; ctx.textAlign = 'right';
    ctx.fillText(this.note || 'Ringe zeigen Hüfte und Knie an dir', W - 28, 46);
    ROWS.forEach(([k, label], i) => {
      const y0 = 92 + i * 108;
      ctx.textAlign = 'left'; ctx.fillStyle = '#f1edf9'; ctx.font = '600 24px system-ui, sans-serif';
      ctx.fillText(label, 28, y0 + 28);
      const auto = k !== 'height' && this.profile[k] == null;
      ctx.font = '700 34px system-ui, sans-serif'; ctx.fillStyle = k === 'height' ? '#b69cff' : '#' + RING_COL[k].toString(16).padStart(6, '0');
      ctx.fillText(`${this.value(k)} cm`, 28, y0 + 68);
      if (auto) { ctx.font = '400 18px system-ui, sans-serif'; ctx.fillStyle = '#b9b2cc'; ctx.fillText('geschätzt', 190, y0 + 70); }
      STEPS.forEach((st, j) => {
        const x0 = 330 + j * 108, id = `${k}:${st}`, on = this.hover === id;
        ctx.fillStyle = on ? 'rgba(182,156,255,0.92)' : 'rgba(255,255,255,0.08)';
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0, y0, 100, 92, 22) : ctx.rect(x0, y0, 100, 92); ctx.fill();
        ctx.fillStyle = on ? '#1f1638' : '#f1edf9'; ctx.font = '700 32px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText((st > 0 ? '+' : '−') + Math.abs(st), x0 + 50, y0 + 46);
      });
    });
    [['measure', 'Größe messen'], ['auto', 'Aus Größe'], ['done', 'Fertig']].forEach(([id, label], j) => {
      const x0 = 16 + j * 246, on = this.hover === id;
      ctx.fillStyle = on ? 'rgba(182,156,255,0.92)' : id === 'done' ? 'rgba(182,156,255,0.35)' : 'rgba(255,255,255,0.08)';
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0, 430, 236, 100, 26) : ctx.rect(x0, 430, 236, 100); ctx.fill();
      ctx.fillStyle = on ? '#1f1638' : '#f1edf9'; ctx.font = '600 25px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(label, x0 + 118, 480);
    });
    this.tex.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.tex.dispose();
    for (const r of Object.values(this.rings)) { this.scene.remove(r.g); r.g.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); r.lt.dispose(); }
  }
}

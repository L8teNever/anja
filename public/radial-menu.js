// Rundes Menue im Raum (Spiel-Modus): Knoepfe im Kreis um einen Punkt, zum Spieler gedreht.
// Auswahl per Strahl (Controller, Hand-Pinch, Handy-Tippen) oder durch Antippen mit dem Finger.
import * as THREE from 'three';
import { ICON_PATHS } from '/icons.js';

const R = 0.17, BTN = 0.062, TEX = 256;

export class RadialMenu extends THREE.Group {
  // items: [{ id, icon, label }]
  constructor(items) {
    super();
    this.items = items;
    this.buttons = [];
    this.renderOrder = 20;
    const geo = new THREE.CircleGeometry(BTN, 40);
    items.forEach((it, k) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = TEX;
      const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
      const a = Math.PI / 2 - (k / items.length) * Math.PI * 2;
      m.position.set(Math.cos(a) * R, Math.sin(a) * R, 0);
      m.renderOrder = 21;
      m.userData = { item: it, canvas, tex, hot: null };
      this.add(m); this.buttons.push(m);
      this._draw(m, false);
    });
    // Mitte: schliessen
    const c = document.createElement('canvas'); c.width = c.height = TEX;
    const ct = new THREE.CanvasTexture(c); ct.colorSpace = THREE.SRGBColorSpace;
    this.center = new THREE.Mesh(new THREE.CircleGeometry(BTN * 0.7, 32), new THREE.MeshBasicMaterial({ map: ct, transparent: true, depthTest: false }));
    this.center.renderOrder = 21;
    this.center.userData = { item: { id: 'close', icon: 'close', label: '' }, canvas: c, tex: ct, hot: null };
    this.add(this.center); this.buttons.push(this.center);
    this._draw(this.center, false);
    this.scale.setScalar(0.01); this.t0 = performance.now();   // aufploppen
  }

  _draw(m, hot) {
    if (m.userData.hot === hot) return;
    m.userData.hot = hot;
    const { canvas, tex, item } = m.userData, ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, TEX, TEX);
    ctx.beginPath(); ctx.arc(TEX / 2, TEX / 2, TEX / 2 - 4, 0, Math.PI * 2);
    ctx.fillStyle = hot ? 'rgba(182,156,255,0.96)' : 'rgba(22,19,31,0.88)'; ctx.fill();
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(182,156,255,0.9)'; ctx.stroke();
    const fg = hot ? '#1f1638' : '#f1edf9';
    const ic = item.label ? 92 : 110;
    ctx.save(); ctx.translate(TEX / 2 - ic / 2, item.label ? 40 : TEX / 2 - ic / 2); ctx.scale(ic / 24, ic / 24);
    ctx.fillStyle = fg; ctx.fill(new Path2D(ICON_PATHS[item.icon] || ICON_PATHS.close)); ctx.restore();
    if (item.label) {
      ctx.fillStyle = fg; ctx.font = '600 38px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(item.label, TEX / 2, 178, TEX - 30);
    }
    tex.needsUpdate = true;
  }

  // zum Betrachter drehen, Aufploppen animieren
  face(viewer) {
    this.lookAt(viewer);
    const k = Math.min(1, (performance.now() - this.t0) / 160);
    this.scale.setScalar(0.01 + 0.99 * k * (2 - k));
  }

  // Strahl -> Knopf (Mesh) oder null
  pick(raycaster) { return raycaster.intersectObjects(this.buttons, false)[0]?.object || null; }

  // Fingerspitze nah am Knopf?
  poke(p) {
    const w = new THREE.Vector3();
    for (const b of this.buttons) {
      const local = b.worldToLocal(p.clone());
      if (Math.abs(local.z) < 0.025 && Math.hypot(local.x, local.y) < BTN) return b;
      void w;
    }
    return null;
  }

  setHot(btns) { for (const b of this.buttons) this._draw(b, btns.has(b)); }

  dispose() {
    for (const b of this.buttons) { b.material.map.dispose(); b.material.dispose(); }
    this.buttons[0]?.geometry.dispose(); this.center.geometry.dispose();
  }
}

// Ziel-Markierung (Sitz/Liege-Platz), anklickbar
export function makeMarker(kind) {
  const g = new THREE.Group();
  const col = kind === 'lie' ? 0x7cc4ff : 0x7ee0b0;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.13, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35, depthTest: false }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.13, 0.16, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, depthTest: false }));
  const pin = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.1, 16).rotateX(Math.PI),
    new THREE.MeshBasicMaterial({ color: col, depthTest: false }));
  pin.position.y = 0.22;
  for (const m of [disc, ring, pin]) { m.renderOrder = 15; g.add(m); }
  g.userData.pickables = [disc, ring, pin];
  g.userData.base = col;
  return g;
}

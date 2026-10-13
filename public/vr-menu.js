// Eigenes Steuer-Menue fuer den VR-Modus: eine schwebende Tafel in der 3D-Szene,
// bedienbar per Controller-Strahl, Hand-Pinch oder Blick+Pinch (Vision Pro).
// Abzug/Pinch ins Leere blendet das Menue ein bzw. aus.
import * as THREE from 'three';
import { ICON_PATHS } from '/icons.js';

const W = 1024, H = 400;          // Canvas-Pixel
const PANEL_W = 1.0;               // Meter in der Szene
const PANEL_H = PANEL_W * H / W;
const BAR = { x: 48, y: 112, w: W - 96, h: 14, hit: 34 };
const ROW_Y = 236;
const AUTO_HIDE_MS = 8000;

const C = {
  bg: 'rgba(22, 19, 31, 0.88)', line: 'rgba(255,255,255,0.10)',
  text: '#f1edf9', muted: '#a49cba', accent: '#b69cff', ink: '#1f1638',
  btn: 'rgba(255,255,255,0.08)', hover: 'rgba(182,156,255,0.28)', track: 'rgba(255,255,255,0.16)',
};

function fmt(s) {
  if (!isFinite(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export class VRMenu {
  constructor({ renderer, scene, video, title = '', onRecenter, chroma }) {
    this.renderer = renderer;
    this.scene = scene;
    this.video = video;
    this.title = title;
    this.onRecenter = onRecenter;
    this.chroma = chroma;          // { get(): bool, toggle() } – Greenscreen
    this.visible = false;
    this.hover = new Map();        // controller -> Button-ID
    this.drag = null;              // { ctrl, frac } beim Spulen
    this.lastActivity = 0;
    this.lastDraw = 0;
    this._place = false;

    const slot = (W - 48) / 8;
    this.buttons = [
      { id: 'back', icon: 'fast_rewind', label: '−10 s' },
      { id: 'play', icon: 'pause', label: 'Pause', big: true },
      { id: 'fwd', icon: 'fast_forward', label: '+10 s' },
      { id: 'mute', icon: 'volume_up', label: 'Ton' },
      { id: 'center', icon: 'center_focus_strong', label: 'Ausrichten' },
      { id: 'key', icon: 'layers', label: 'Grün weg' },
      { id: 'hide', icon: 'expand_more', label: 'Ausblenden' },
      { id: 'exit', icon: 'close', label: 'Beenden' },
    ].map((b, i) => ({ ...b, cx: 24 + slot * (i + 0.5), cy: ROW_Y, r: b.big ? 54 : 42 }));

    // Tafel
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_W, PANEL_H),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }),
    );
    this.panel.renderOrder = 10;
    this.panel.visible = false;
    scene.add(this.panel);

    // Controller mit Zeigestrahl
    this.raycaster = new THREE.Raycaster();
    this._m = new THREE.Matrix4();
    this.controllers = [0, 1].map((i) => {
      const c = renderer.xr.getController(i);
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: 0xb69cff, transparent: true, opacity: 0.8, depthTest: false }),
      );
      ray.renderOrder = 11;
      ray.visible = false;
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(0.008, 20),
        new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }),
      );
      dot.renderOrder = 12; dot.visible = false;
      scene.add(dot);
      c.userData = { ray, dot, mode: null, source: null };
      c.add(ray);
      c.addEventListener('connected', (e) => { c.userData.mode = e.data.targetRayMode; c.userData.source = e.data; });
      c.addEventListener('disconnected', () => { c.userData.mode = null; c.userData.source = null; ray.visible = false; dot.visible = false; this.hover.delete(c); });
      c.addEventListener('selectstart', () => this._press(c));
      c.addEventListener('selectend', () => this._release(c));
      c.addEventListener('squeezestart', () => this.toggle());
      scene.add(c);
      return c;
    });

    this._onStart = () => this.show();
    this._onEnd = () => this.hide();
    renderer.xr.addEventListener('sessionstart', this._onStart);
    renderer.xr.addEventListener('sessionend', this._onEnd);
  }

  show() {
    this.visible = true;
    this._place = true;            // beim naechsten Frame vor den Blick setzen
    this.lastActivity = performance.now();
    this.draw();
  }

  hide() {
    this.visible = false;
    this.panel.visible = false;
    this.drag = null;
    this.hover.clear();
  }

  toggle() { this.visible ? this.hide() : this.show(); }

  // Pro Frame aus der Render-Schleife aufrufen (nur im VR-Modus)
  update() {
    const now = performance.now();
    if (this._place) { this._placeInFront(); this._place = false; this.panel.visible = true; }

    let changed = false;
    for (const c of this.controllers) {
      const { ray, dot, mode } = c.userData;
      const pointer = mode === 'tracked-pointer';
      const hit = this.visible && mode ? this._hit(c) : null;
      ray.visible = pointer && this.visible;
      dot.visible = !!hit;
      if (hit) {
        ray.scale.z = hit.distance;
        dot.position.copy(hit.point);
        dot.quaternion.copy(this.panel.quaternion);
        dot.translateZ(0.002);
      } else {
        ray.scale.z = 2;
      }
      const id = hit ? this._targetAt(hit.uv) : null;
      if (this.drag?.ctrl === c && hit) {
        this.drag.frac = this._barFrac(hit.uv);
        changed = true;
      }
      if (this.hover.get(c) !== id) {
        if (id) this._pulse(c, 0.25, 15);
        this.hover.set(c, id);
        changed = true;
      }
      if (id) this.lastActivity = now;
    }

    if (this.visible && !this.video.paused && !this.drag && now - this.lastActivity > AUTO_HIDE_MS) this.hide();
    if (this.visible && (changed || now - this.lastDraw > 250)) this.draw();
  }

  _placeInFront() {
    const cam = this.renderer.xr.getCamera();
    const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld));
    dir.y = 0;
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize();
    this.panel.position.copy(pos).addScaledVector(dir, 1.3);
    this.panel.position.y = pos.y - 0.32;
    this.panel.lookAt(pos);
  }

  _hit(c) {
    this._m.identity().extractRotation(c.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this._m);
    return this.raycaster.intersectObject(this.panel, false)[0] || null;
  }

  _px(uv) { return { x: uv.x * W, y: (1 - uv.y) * H }; }

  _barFrac(uv) { return Math.min(1, Math.max(0, (this._px(uv).x - BAR.x) / BAR.w)); }

  _targetAt(uv) {
    const { x, y } = this._px(uv);
    if (x >= BAR.x - 10 && x <= BAR.x + BAR.w + 10 && Math.abs(y - (BAR.y + BAR.h / 2)) <= BAR.hit) return 'seek';
    const b = this.buttons.find((b) => Math.hypot(x - b.cx, y - b.cy) <= b.r + 8);
    return b ? b.id : null;
  }

  _press(c) {
    const hit = this.visible ? this._hit(c) : null;
    if (!hit) { this.toggle(); return; }  // ins Leere: Menue ein/aus
    this.lastActivity = performance.now();
    const id = this._targetAt(hit.uv);
    if (!id) return;
    this._pulse(c, 0.6, 30);
    const v = this.video;
    switch (id) {
      case 'seek': this.drag = { ctrl: c, frac: this._barFrac(hit.uv) }; break;
      case 'play': v.paused ? v.play().catch(() => {}) : v.pause(); break;
      case 'back': v.currentTime = Math.max(0, v.currentTime - 10); break;
      case 'fwd': if (v.duration) v.currentTime = Math.min(v.duration - 0.25, v.currentTime + 10); break;
      case 'mute': v.muted = !v.muted; break;
      case 'center': this.onRecenter?.(); this._place = true; break;
      case 'key': this.chroma?.toggle(); break;
      case 'hide': this.hide(); break;
      case 'exit': this.renderer.xr.getSession()?.end(); break;
    }
    this.draw();
  }

  _release(c) {
    if (this.drag?.ctrl !== c) return;
    if (this.video.duration) this.video.currentTime = this.drag.frac * this.video.duration;
    this.drag = null;
    this.lastActivity = performance.now();
    this.draw();
  }

  _pulse(c, intensity, ms) {
    try { c.userData.source?.gamepad?.hapticActuators?.[0]?.pulse(intensity, ms); } catch { /* kein Vibrieren */ }
  }

  _icon(name, cx, cy, size, color) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.fillStyle = color;
    ctx.fill(new Path2D(ICON_PATHS[name] || ICON_PATHS.close));
    ctx.restore();
  }

  draw() {
    this.lastDraw = performance.now();
    const ctx = this.ctx, v = this.video;
    const hovered = new Set(this.hover.values());
    ctx.clearRect(0, 0, W, H);

    rrect(ctx, 2, 2, W - 4, H - 4, 44);
    ctx.fillStyle = C.bg; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = C.line; ctx.stroke();

    // Titel + Zeit
    const dur = v.duration || 0;
    const cur = this.drag ? this.drag.frac * dur : v.currentTime;
    ctx.textBaseline = 'middle';
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.fillStyle = C.muted; ctx.textAlign = 'right';
    const time = `${fmt(cur)} / ${fmt(dur)}`;
    ctx.fillText(time, W - 48, 62);
    const timeW = ctx.measureText(time).width;
    ctx.font = '700 32px system-ui, sans-serif';
    ctx.fillStyle = C.text; ctx.textAlign = 'left';
    let t = this.title || 'Video';
    const maxW = W - 96 - timeW - 32;
    while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -2) + '…';
    ctx.fillText(t, 48, 62);

    // Fortschritt
    const frac = dur ? Math.min(1, cur / dur) : 0;
    const barHover = hovered.has('seek') || this.drag;
    const bh = barHover ? BAR.h + 6 : BAR.h, by = BAR.y + (BAR.h - bh) / 2;
    rrect(ctx, BAR.x, by, BAR.w, bh, bh / 2); ctx.fillStyle = C.track; ctx.fill();
    if (frac > 0) { rrect(ctx, BAR.x, by, Math.max(bh, BAR.w * frac), bh, bh / 2); ctx.fillStyle = C.accent; ctx.fill(); }
    ctx.beginPath(); ctx.arc(BAR.x + BAR.w * frac, BAR.y + BAR.h / 2, barHover ? 16 : 11, 0, Math.PI * 2);
    ctx.fillStyle = C.text; ctx.fill();

    // Knoepfe
    for (const b of this.buttons) {
      let name = b.icon, label = b.label;
      if (b.id === 'play') { name = v.paused ? 'play_arrow' : 'pause'; label = v.paused ? 'Abspielen' : 'Pause'; }
      if (b.id === 'mute') { name = v.muted ? 'volume_off' : 'volume_up'; label = v.muted ? 'Ton an' : 'Ton aus'; }
      const keyOn = b.id === 'key' && this.chroma?.get();
      const on = hovered.has(b.id);
      ctx.beginPath(); ctx.arc(b.cx, b.cy, on ? b.r + 4 : b.r, 0, Math.PI * 2);
      ctx.fillStyle = b.big ? C.accent : on ? C.hover : keyOn ? 'rgba(126,224,176,0.30)' : C.btn; ctx.fill();
      if (b.big && on) { ctx.lineWidth = 5; ctx.strokeStyle = C.text; ctx.stroke(); }
      this._icon(name, b.cx, b.cy, b.big ? 60 : 44, b.big ? C.ink : C.text);
      ctx.font = '500 20px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = on ? C.text : C.muted;
      ctx.fillText(label, b.cx, ROW_Y + 82);
    }

    ctx.font = '400 19px system-ui, sans-serif';
    ctx.fillStyle = C.muted; ctx.textAlign = 'center';
    ctx.fillText('Abzug oder Pinch ins Leere: Menü ein/aus', W / 2, H - 30);

    this.texture.needsUpdate = true;
  }

  dispose() {
    this.renderer.xr.removeEventListener('sessionstart', this._onStart);
    this.renderer.xr.removeEventListener('sessionend', this._onEnd);
    for (const c of this.controllers) {
      const { ray, dot } = c.userData;
      ray.geometry.dispose(); ray.material.dispose();
      dot.geometry.dispose(); dot.material.dispose();
      this.scene.remove(dot); this.scene.remove(c);
    }
    this.scene.remove(this.panel);
    this.panel.geometry.dispose(); this.panel.material.dispose();
    this.texture.dispose();
  }
}

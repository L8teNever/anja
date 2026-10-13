// Bowling-Wertung (10 Frames, Strike/Spare, Bonuswuerfe im 10. Frame) und Anzeigetafel.

export class Game {
  constructor() { this.reset(); }

  reset() {
    this.rolls = [];        // alle Wuerfe (umgefallene Pins)
    this.frame = 0;         // 0..9
    this.ball = 0;          // Wurf im Frame (0, 1, 2)
    this.frameRolls = [];   // Wuerfe im aktuellen Frame
    this.over = false;
  }

  // Wurf eintragen -> { reset: alle Pins neu aufstellen?, over: Spiel vorbei?, strike, spare }
  add(n) {
    if (this.over) return { reset: true, over: true };
    this.rolls.push(n); this.frameRolls.push(n);
    const r = this.frameRolls;
    let reset = false, next = false, strike = false, spare = false;
    if (this.frame < 9) {
      if (r.length === 1 && n === 10) { strike = true; reset = true; next = true; }
      else if (r.length === 2) { spare = r[0] + r[1] === 10; reset = true; next = true; }
    } else {
      // 10. Frame
      if (r.length === 1) { if (n === 10) { strike = true; reset = true; } }
      else if (r.length === 2) {
        if (r[0] === 10) { if (n === 10) { strike = true; reset = true; } }
        else if (r[0] + r[1] === 10) { spare = true; reset = true; }
        else { this.over = true; reset = true; }
      } else { this.over = true; reset = true; }
    }
    if (next) { this.frame++; this.frameRolls = []; }
    this.ball = this.frameRolls.length;
    return { reset, over: this.over, strike, spare };
  }

  // Frames mit Zeichen und laufender Summe
  frames() {
    const out = [], R = this.rolls;
    let i = 0, sum = 0;
    for (let f = 0; f < 10; f++) {
      const marks = [];
      let total = null;
      if (i >= R.length) { out.push({ marks, total }); continue; }
      if (f < 9) {
        if (R[i] === 10) {
          marks.push('', 'X');
          if (R[i + 2] !== undefined) total = sum += 10 + R[i + 1] + R[i + 2];
          i += 1;
        } else {
          marks.push(mark(R[i]));
          if (R[i + 1] !== undefined) {
            const sp = R[i] + R[i + 1] === 10;
            marks.push(sp ? '/' : mark(R[i + 1]));
            if (!sp) total = sum += R[i] + R[i + 1];
            else if (R[i + 2] !== undefined) total = sum += 10 + R[i + 2];
          }
          i += 2;
        }
      } else {
        const t = R.slice(i, i + 3), x = (n) => (n === 10 ? 'X' : mark(n));
        if (t.length > 0) marks.push(x(t[0]));
        if (t.length > 1) marks.push(t[0] === 10 ? x(t[1]) : t[0] + t[1] === 10 ? '/' : mark(t[1]));
        if (t.length > 2) {
          if (t[0] === 10 && t[1] === 10) marks.push(x(t[2]));
          else if (t[0] === 10) marks.push(t[1] + t[2] === 10 ? '/' : mark(t[2]));
          else marks.push(x(t[2]));
        }
        const needed = t[0] === 10 || t[0] + (t[1] ?? 0) === 10 ? 3 : 2;
        if (t.length >= needed) total = sum += t.slice(0, needed).reduce((a, b) => a + b, 0);
        i += t.length;
      }
      out.push({ marks, total });
    }
    return out;
  }

  get total() { return this.frames().reduce((m, f) => (f.total ?? m), 0); }
}

const mark = (n) => (n === 0 ? '–' : String(n));

// Anzeigetafel auf eine Canvas zeichnen (1024 x 300)
export function drawBoard(ctx, game, msg) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(20,16,30,0.88)';
  round(ctx, 0, 0, W, H, 28); ctx.fill();
  const fr = game.frames(), bw = (W - 40) / 11, top = 70, bh = 150;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffb3d1'; ctx.font = '700 40px system-ui, sans-serif';
  ctx.fillText(msg || `Frame ${Math.min(game.frame + 1, 10)} · Wurf ${game.ball + 1}`, W / 2, 36);
  for (let f = 0; f < 10; f++) {
    const x = 20 + f * bw, cur = f === game.frame && !game.over;
    ctx.strokeStyle = cur ? '#ff7ab6' : 'rgba(255,255,255,0.35)'; ctx.lineWidth = cur ? 5 : 2;
    ctx.strokeRect(x + 3, top, bw - 6, bh);
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '500 20px system-ui, sans-serif';
    ctx.fillText(String(f + 1), x + bw / 2, top + bh + 22);
    const m = fr[f].marks, n = f === 9 ? 3 : 2, cw = (bw - 6) / n;
    ctx.font = '700 34px system-ui, sans-serif'; ctx.fillStyle = '#fff';
    for (let k = 0; k < n; k++) if (m[k] !== undefined) ctx.fillText(m[k], x + 3 + cw * (k + 0.5), top + 32);
    ctx.font = '700 46px system-ui, sans-serif'; ctx.fillStyle = '#ffd4e6';
    if (fr[f].total !== null) ctx.fillText(String(fr[f].total), x + bw / 2, top + 105);
  }
  const x = 20 + 10 * bw;
  ctx.strokeStyle = '#ffb3d1'; ctx.lineWidth = 4; ctx.strokeRect(x + 3, top, bw - 6, bh);
  ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '500 20px system-ui, sans-serif'; ctx.fillText('Summe', x + bw / 2, top + bh + 22);
  ctx.fillStyle = '#fff'; ctx.font = '800 52px system-ui, sans-serif'; ctx.fillText(String(game.total), x + bw / 2, top + bh / 2);
}

function round(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

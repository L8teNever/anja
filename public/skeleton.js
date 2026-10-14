// Koerper-Skelett fuer den Mixed-Reality-Modus.
// Bekannt sind: Kopf (Brille) und Haende/Controller. Daraus folgen Nacken, Schultern, Becken und Arme
// (Arme per 2-Knochen-IK zwischen Schulter und getracktem Handgelenk). Ellbogen-Stellung und Rumpf-Neigung
// werden an den Tiefensensor angepasst. Die Hand selbst (Handflaeche, Finger) kommt direkt aus dem Hand-Tracking. Die Beine werden aus dem Tiefensensor
// eingepasst (Knie, Knoechel, Zehen mit festen Knochenlaengen) und im Koerper-Bezug gemerkt,
// damit sie mitgehen, wenn du dich bewegst und nicht hinschaust.
// Jeder Knochen ist eine Kapsel (Strecke + Radius): nur was darin liegt, kann zu dir gehoeren.
import * as THREE from 'three';

export const BONES = [
  ['torso', 0.17], ['shoulders', 0.09], ['pelvis', 0.14],
  ['upperarm-l', 0.075], ['forearm-l', 0.06], ['upperarm-r', 0.075], ['forearm-r', 0.06],
  ['thigh-l', 0.105], ['shin-l', 0.075], ['foot-l', 0.065],
  ['thigh-r', 0.105], ['shin-r', 0.075], ['foot-r', 0.065],
];

const UPPER_ARM = 0.29, FOREARM = 0.27, FOOT = 0.19, TORSO = 0.68;   // Nacken-Drehpunkt -> Hueftgelenk
const DOWN = new THREE.Vector3(0, -1, 0), UP = new THREE.Vector3(0, 1, 0);

// Abstand Punkt (x,y,z) zur Strecke a-b
export function segDist(x, y, z, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = x - a.x, apy = y - a.y, apz = z - a.z;
  const l = abx * abx + aby * aby + abz * abz;
  const t = l > 1e-9 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / l)) : 0;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class Skeleton {
  constructor() {
    const v = () => new THREE.Vector3();
    this.j = {};
    for (const n of ['neck', 'pelvis', 'shL', 'shR', 'elL', 'elR', 'wrL', 'wrR', 'hipL', 'hipR', 'knL', 'knR', 'anL', 'anR', 'toL', 'toR']) this.j[n] = v();
    this.torsoDir = new THREE.Vector3(0, -1, 0);
    this.side = new THREE.Vector3(1, 0, 0);    // nach rechts
    this.fwd = new THREE.Vector3(0, 0, -1);    // nach vorne (Brust)
    this.yaw = undefined;
    this.lying = false;
    this.legLen = 0.86;
    this.ready = false;
    this.bones = BONES.map(([name, r]) => ({ name, r, a: v(), b: v(), m: new THREE.Matrix4() }));
    this.boneMap = Object.fromEntries(this.bones.map((b) => [b.name, b]));
    // eingepasste Beine im Becken-Bezug (lokal): {kn, an, to}
    this.leg = { l: null, r: null };
    this.torsoBase = new THREE.Vector3(0, -1, 0);
    this.lean = 0;                       // Vor-/Zuruecklehnen (rad)
    this.swivel = { L: 0, R: 0 };        // Ellbogen-Drehung um die Schulter-Hand-Achse (rad)
    this.ik = { L: null, R: null };
    this.def = { l: null, r: null };
    this._B = new THREE.Matrix4(); this._Bi = new THREE.Matrix4();
  }

  // pro Frame: Kopf-Position/-Drehung, Handgelenke ({l, r}: Vector3|null), Boden
  predict(head, q, wrists, floorY) {
    const up = UP.clone().applyQuaternion(q), f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    if (this.lying ? up.y > 0.5 : up.y < 0.25) this.lying = !this.lying;
    const k = this.ready ? 0.15 : 1;

    // Koerperrichtung (traege: der Kopf darf sich drehen, ohne dass der Koerper mitdreht)
    const hx = f.x + up.x * Math.max(0, -f.y), hz = f.z + up.z * Math.max(0, -f.y);
    if (hx * hx + hz * hz > 1e-4) {
      const yaw = Math.atan2(hx, hz);
      if (this.yaw === undefined) this.yaw = yaw;
      const d = Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw));
      if (Math.abs(d) > 0.6) this.yaw += (d - Math.sign(d) * 0.6) * 0.2;
    }
    const yawFwd = new THREE.Vector3(Math.sin(this.yaw || 0), 0, Math.cos(this.yaw || 0));
    let td, side;
    if (!this.lying) {
      td = DOWN.clone().addScaledVector(yawFwd, 0.05).normalize();
      side = new THREE.Vector3(-yawFwd.z, 0, yawFwd.x);
    } else {
      td = up.clone().negate(); td.y = Math.max(-0.6, Math.min(0.2, td.y)); td.normalize();
      side = right.clone().addScaledVector(td, -right.dot(td)).normalize();
    }
    this.torsoBase.lerp(td, k).normalize();
    this.side.lerp(side, k); this.side.addScaledVector(this.torsoBase, -this.side.dot(this.torsoBase)).normalize();
    this.fwd.crossVectors(this.side, this.torsoBase).negate().normalize();   // Brust-Richtung
    if (this.fwd.dot(this.lying ? UP : yawFwd) < 0) this.fwd.negate();
    // Vor-/Zuruecklehnen (aus dem Tiefensensor eingepasst)
    this.torsoDir.copy(this.torsoBase).multiplyScalar(Math.cos(this.lean)).addScaledVector(this.fwd, Math.sin(this.lean)).normalize();
    this.fwd.addScaledVector(this.torsoDir, -this.fwd.dot(this.torsoDir)).normalize();

    const J = this.j, T = this.torsoDir, S = this.side;
    J.neck.copy(head).add(new THREE.Vector3(0, -0.1, 0.08).applyQuaternion(q));   // Drehpunkt hinter/unter den Augen
    J.pelvis.copy(J.neck).addScaledVector(T, TORSO);
    J.shL.copy(J.neck).addScaledVector(T, 0.15).addScaledVector(S, -0.18);
    J.shR.copy(J.neck).addScaledVector(T, 0.15).addScaledVector(S, 0.18);
    J.hipL.copy(J.pelvis).addScaledVector(S, -0.1);
    J.hipR.copy(J.pelvis).addScaledVector(S, 0.1);

    // Beinlaenge im Stehen lernen (Huefte bis Knoechel)
    if (!this.lying && J.pelvis.y - floorY > 0.68) {
      const ll = Math.max(0.65, Math.min(1.05, J.pelvis.y - floorY - 0.07));
      this.legLen += (ll - this.legLen) * (this.learned ? 0.03 : 1);
      this.learned = true;
    }

    // Arme
    for (const s of ['L', 'R']) {
      const sh = J['sh' + s], el = J['el' + s], wr = J['wr' + s], w = wrists[s.toLowerCase()];
      this.ik[s] = null;
      if (w) {
        // Unterarm endet immer genau am getrackten Handgelenk
        wr.copy(w);
        const dir = wr.clone().sub(sh); let d = dir.length();
        if (d < 1e-4) { dir.copy(T); d = 0.01; } else dir.divideScalar(d);
        const reach = UPPER_ARM + FOREARM;
        let a, h = 0;
        if (d >= reach) a = d * UPPER_ARM / reach;          // gestreckt
        else {
          a = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + d * d) / (2 * d);
          h = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - a * a));
        }
        // Ellbogen-Richtung: nach unten/aussen/hinten, gedreht um die Schulter-Hand-Achse (eingepasst)
        const pole = T.clone().addScaledVector(S, s === 'L' ? -0.4 : 0.4).addScaledVector(this.fwd, -0.3);
        pole.addScaledVector(dir, -pole.dot(dir)); if (pole.lengthSq() < 1e-6) pole.copy(S); pole.normalize();
        const bi = new THREE.Vector3().crossVectors(dir, pole);
        this.ik[s] = { sh: sh.clone(), wr: wr.clone(), dir, a, h, pole: pole.clone(), bi };
        const sw = this.swivel[s];
        el.copy(sh).addScaledVector(dir, a).addScaledVector(pole, h * Math.cos(sw)).addScaledVector(bi, h * Math.sin(sw));
      } else {
        el.copy(sh).addScaledVector(T, UPPER_ARM);
        wr.copy(el).addScaledVector(T, FOREARM);
      }
    }

    // Beine: eingepasst (lokal gemerkt) oder Grundhaltung
    this._basis();
    const thigh = this.legLen * 0.52, shin = this.legLen * 0.48;
    const standing = !this.lying && J.pelvis.y - floorY > this.legLen * 0.82;
    const lowSit = !this.lying && J.pelvis.y - floorY < 0.35;
    const posture = this.lying ? 'lie' : standing ? 'stand' : lowSit ? 'floor' : 'sit';
    if (posture !== this.posture) { this.posture = posture; this.leg = { l: null, r: null }; }
    for (const s of ['L', 'R']) {
      const hip = J['hip' + s], kn = J['kn' + s], an = J['an' + s], to = J['to' + s];
      // Grundhaltung je nach Haltung
      if (this.lying) {
        kn.copy(hip).addScaledVector(T, thigh); an.copy(kn).addScaledVector(T, shin); to.copy(an).addScaledVector(this.fwd, FOOT);
      } else if (standing) {
        kn.copy(hip).addScaledVector(DOWN, thigh); an.copy(kn).addScaledVector(DOWN, shin); to.copy(an).addScaledVector(yawFwd, FOOT);
      } else if (lowSit) {
        kn.copy(hip).addScaledVector(yawFwd, thigh); an.copy(kn).addScaledVector(yawFwd, shin); to.copy(an).addScaledVector(UP, FOOT);
      } else {
        kn.copy(hip).addScaledVector(yawFwd, thigh); an.copy(kn).addScaledVector(DOWN, shin); to.copy(an).addScaledVector(yawFwd, FOOT);
      }
      const key = s === 'L' ? 'l' : 'r';
      // Grundhaltung als Richtungen im Becken-Bezug merken (Ziel, wenn nichts gesehen wird)
      this.def[key] = this._toDirs(hip, kn, an, to);
      const fit = this.leg[key];
      if (fit) this._fromDirs(hip, fit, kn, an, to, thigh, shin);
      // Knochenlaengen und Boden einhalten
      kn.sub(hip).setLength(thigh).add(hip);
      an.sub(kn).setLength(shin).add(kn);
      to.sub(an).setLength(FOOT).add(an);
      if (an.y < floorY + 0.06) an.y = floorY + 0.06;
      if (to.y < floorY + 0.03) to.y = floorY + 0.03;
    }
    this._bones();
    this.ready = true;
  }

  // Becken-Bezug: Ursprung Becken, Achsen side / -torsoDir / fwd
  _basis() {
    const yAx = this.torsoDir.clone().negate();
    this._B.makeBasis(this.side, yAx, this.fwd).setPosition(this.j.pelvis);
    this._Bi.copy(this._B).invert();
  }

  _bones() {
    const J = this.j, set = (n, a, b) => { const bn = this.boneMap[n]; bn.a.copy(a); bn.b.copy(b); };
    set('torso', J.neck.clone().addScaledVector(this.torsoDir, 0.14), J.pelvis); set('shoulders', J.shL, J.shR); set('pelvis', J.hipL, J.hipR);
    set('upperarm-l', J.shL, J.elL); set('forearm-l', J.elL, J.wrL);
    set('upperarm-r', J.shR, J.elR); set('forearm-r', J.elR, J.wrR);
    set('thigh-l', J.hipL, J.knL); set('shin-l', J.knL, J.anL); set('foot-l', J.anL, J.toL);
    set('thigh-r', J.hipR, J.knR); set('shin-r', J.knR, J.anR); set('foot-r', J.anR, J.toR);
    // Matrix je Knochen: Ursprung a, Y entlang des Knochens (fuer angeheftete Objekte / Kleidung)
    for (const b of this.bones) {
      const y = b.b.clone().sub(b.a); if (y.lengthSq() < 1e-8) y.copy(this.torsoDir); y.normalize();
      const ref = Math.abs(y.dot(this.side)) > 0.8 ? this.fwd : this.side;
      const x = ref.clone().addScaledVector(y, -ref.dot(y)).normalize();
      const z = new THREE.Vector3().crossVectors(x, y);
      b.m.makeBasis(x, y, z).setPosition(b.a);
    }
  }

  // kleinster Abstand zur Kapsel-Oberflaeche (negativ = innen); legsOnly: nur Beinknochen
  dist(x, y, z, legsOnly = false) {
    let best = Infinity;
    for (let i = legsOnly ? 7 : 0; i < this.bones.length; i++) {
      const b = this.bones[i], d = segDist(x, y, z, b.a, b.b) - b.r;
      if (d < best) best = d;
    }
    return best;
  }

  nearestBone(p, maxD) {
    let best = null, bd = maxD;
    for (const b of this.bones) { const d = segDist(p.x, p.y, p.z, b.a, b.b) - b.r; if (d < bd) { bd = d; best = b; } }
    return best;
  }

  // Oberkoerper und Arme aus erkannten Punkten einpassen (A: Float32Array xyz, n Punkte)
  fitUpper(A, n) {
    if (!this.ready || n < 10) return;
    const J = this.j;
    const count = (test) => { let c = 0; for (let k = 0; k < n; k++) if (test(A[k * 3], A[k * 3 + 1], A[k * 3 + 2])) c++; return c; };
    const nearLegs = (x, y, z) => this.dist(x, y, z, true) < 0.02;
    // Ellbogen: Drehwinkel, bei dem Ober- und Unterarm die meisten Punkte treffen (nicht im Rumpf)
    for (const s of ['L', 'R']) {
      const ik = this.ik[s];
      if (!ik || ik.h < 0.03) continue;
      const neck = J.neck, pel = J.pelvis;
      let best = this.swivel[s], bestScore = -1, cur = -1;
      for (const off of [0, -0.25, 0.25, -0.5, 0.5, -0.85, 0.85, -1.3, 1.3]) {
        const sw = Math.max(-1.7, Math.min(1.7, this.swivel[s] + off));
        const el = ik.sh.clone().addScaledVector(ik.dir, ik.a).addScaledVector(ik.pole, ik.h * Math.cos(sw)).addScaledVector(ik.bi, ik.h * Math.sin(sw));
        const sc = count((x, y, z) => segDist(x, y, z, neck, pel) > 0.16 && !nearLegs(x, y, z)
          && (segDist(x, y, z, ik.sh, el) < 0.085 || segDist(x, y, z, el, ik.wr) < 0.07));
        if (off === 0) cur = sc;
        if (sc > bestScore) { bestScore = sc; best = sw; }
      }
      if (bestScore >= 6 && bestScore > cur + 2) this.swivel[s] += (best - this.swivel[s]) * 0.5;
    }
    // Rumpf: Neigung, bei der die meisten Punkte im Rumpf liegen (Arme/Beine ausgenommen)
    const T0 = this.torsoBase, F = this.fwd;
    let bestL = this.lean, bestS = -1, curS = -1;
    for (const off of [0, -0.12, 0.12, -0.25, 0.25]) {
      const l = Math.max(-0.4, Math.min(0.45, this.lean + off));
      const t = T0.clone().multiplyScalar(Math.cos(l)).addScaledVector(F, Math.sin(l)).normalize();
      const a = J.neck.clone().addScaledVector(t, 0.14), b = J.neck.clone().addScaledVector(t, TORSO);
      const sc = count((x, y, z) => !nearLegs(x, y, z) && segDist(x, y, z, a, b) < 0.17);
      if (off === 0) curS = sc;
      if (sc > bestS) { bestS = sc; bestL = l; }
    }
    if (bestS >= 15 && bestS > curS * 1.08 + 2) this.lean += (bestL - this.lean) * 0.3;
    else this.lean *= 0.995;          // ohne Hinweise langsam zurueck zur Grundhaltung
  }

  // Bein als Knochen-Richtungen im Becken-Bezug (lokal: x = rechts, y = Richtung Kopf, z = Brust)
  _toDirs(hip, kn, an, to) {
    const R = new THREE.Matrix3().setFromMatrix4(this._Bi);
    return {
      t: kn.clone().sub(hip).applyMatrix3(R).normalize(),
      s: an.clone().sub(kn).applyMatrix3(R).normalize(),
      f: to.clone().sub(an).applyMatrix3(R).normalize(),
    };
  }

  _fromDirs(hip, d, kn, an, to, thigh, shin) {
    const R = new THREE.Matrix3().setFromMatrix4(this._B);
    kn.copy(hip).addScaledVector(d.t.clone().applyMatrix3(R), thigh);
    an.copy(kn).addScaledVector(d.s.clone().applyMatrix3(R), shin);
    to.copy(an).addScaledVector(d.f.clone().applyMatrix3(R), FOOT);
  }

  // was ein Bein anatomisch kann (lokal, sg = -1 links / +1 rechts)
  _limit(d, sg) {
    const t = d.t;
    t.y = Math.min(t.y, 0.3);                    // Oberschenkel nicht Richtung Kopf
    t.z = Math.max(t.z, -0.4);                   // nicht weit nach hinten
    const out = Math.max(-0.2, Math.min(0.65, t.x * sg)); t.x = out * sg;   // kaum nach innen, etwas nach aussen
    t.normalize();
    const sh = d.s;
    if (sh.dot(t) < -0.8) sh.lerp(t, 0.5);       // Knie beugt hoechstens ~145 Grad
    sh.z = Math.min(sh.z, Math.max(t.z, 0) + 0.25);   // Unterschenkel nicht nach vorne ueberstrecken
    sh.normalize();
    const f = d.f;
    if (f.dot(sh) > 0.6) f.lerp(new THREE.Vector3(0, 0, 1), 0.5);   // Fuss steht etwa quer zum Schienbein
    f.normalize();
  }

  // Richtung hoechstens um maxA (rad) aendern
  static _step(old, nu, maxA) {
    const a = old.angleTo(nu);
    if (a <= maxA) return nu;
    return old.clone().lerp(nu, maxA / a).normalize();
  }

  // Beine aus erkannten Punkten einpassen (A: Float32Array xyz, n Punkte; skip(x,y,z): Haende usw.)
  fit(A, n, skip = () => false) {
    const J = this.j, thigh = this.legLen * 0.52, shin = this.legLen * 0.48;
    const P = J.pelvis, T = this.torsoDir;
    const dirFrom = (o, test, minD, maxD) => {
      const d = new THREE.Vector3(); let c = 0;
      for (let k = 0; k < n; k++) {
        const x = A[k * 3], y = A[k * 3 + 1], z = A[k * 3 + 2];
        const dx = x - o.x, dy = y - o.y, dz = z - o.z, l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (l < minD || l > maxD || !test(x, y, z)) continue;
        d.x += dx / l; d.y += dy / l; d.z += dz / l; c++;
      }
      return c >= 8 ? d.normalize() : null;
    };
    for (const s of ['L', 'R']) {
      const sg = s === 'L' ? -1 : 1, S = this.side, key = s === 'L' ? 'l' : 'r';
      const ok = (x, y, z) => {
        const lx = (x - P.x) * S.x + (y - P.y) * S.y + (z - P.z) * S.z;
        const ly = -((x - P.x) * T.x + (y - P.y) * T.y + (z - P.z) * T.z);
        if (lx * sg < -0.04 || ly > 0.05) return false;             // eigene Seite, unterhalb der Huefte
        for (let i = 3; i <= 6; i++) { const b = this.bones[i]; if (segDist(x, y, z, b.a, b.b) < b.r + 0.04) return false; }  // Arme
        return !skip(x, y, z);
      };
      const hip = J['hip' + s], kn = J['kn' + s].clone(), an = J['an' + s].clone(), to = J['to' + s].clone();
      let seen = 0;
      const dT = dirFrom(hip, (x, y, z) => ok(x, y, z) && segDist(x, y, z, hip, kn) < 0.22, 0.12, thigh + 0.06);
      if (dT) { kn.copy(hip).addScaledVector(dT, thigh); seen++; }
      const dS = dirFrom(kn, (x, y, z) => ok(x, y, z) && segDist(x, y, z, kn, an) < 0.2 && segDist(x, y, z, hip, kn) > 0.06, 0.1, shin + 0.05);
      if (dS) { an.copy(kn).addScaledVector(dS, shin); seen++; }
      const dF = dirFrom(an, (x, y, z) => ok(x, y, z) && segDist(x, y, z, an, to) < 0.16 && segDist(x, y, z, kn, an) > 0.08, 0.05, FOOT + 0.06);
      if (dF) { to.copy(an).addScaledVector(dF, FOOT); seen++; }
      const def = this.def[key];
      if (!def) continue;
      const cur = this.leg[key] || { t: def.t.clone(), s: def.s.clone(), f: def.f.clone() };
      if (seen) {
        const nu = this._toDirs(hip, kn, an, to);
        this._limit(nu, sg);
        cur.t = Skeleton._step(cur.t, cur.t.clone().lerp(nu.t, 0.5).normalize(), 0.3);
        cur.s = Skeleton._step(cur.s, cur.s.clone().lerp(nu.s, 0.5).normalize(), 0.35);
        cur.f = Skeleton._step(cur.f, cur.f.clone().lerp(nu.f, 0.5).normalize(), 0.4);
        cur.miss = 0;
      } else if ((cur.miss = (cur.miss || 0) + 1) > 15) {
        // lange nichts gesehen: langsam zurueck zur Grundhaltung
        cur.t.lerp(def.t, 0.05).normalize(); cur.s.lerp(def.s, 0.05).normalize(); cur.f.lerp(def.f, 0.05).normalize();
      }
      this._limit(cur, sg);
      this.leg[key] = cur;
    }
  }
}

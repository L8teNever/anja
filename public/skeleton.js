// Koerper-Skelett fuer den Mixed-Reality-Modus.
// Bekannt sind: Kopf (Brille) und Haende/Controller. Daraus folgen Nacken, Schultern, Becken und Arme
// (Arme per 2-Knochen-IK zwischen Schulter und Handgelenk). Die Beine werden aus dem Tiefensensor
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
    this.torsoDir.lerp(td, k).normalize();
    this.side.lerp(side, k); this.side.addScaledVector(this.torsoDir, -this.side.dot(this.torsoDir)).normalize();
    this.fwd.crossVectors(this.side, this.torsoDir).negate().normalize();   // Brust-Richtung
    if (this.fwd.dot(this.lying ? UP : yawFwd) < 0) this.fwd.negate();

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
      if (w) {
        wr.copy(w);
        const dir = wr.clone().sub(sh); let d = dir.length();
        if (d < 1e-4) { dir.copy(T); d = 0.01; } else dir.divideScalar(d);
        d = Math.min(d, UPPER_ARM + FOREARM - 1e-3);
        const a = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + d * d) / (2 * d);
        const h = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - a * a));
        const pole = T.clone().addScaledVector(S, s === 'L' ? -0.4 : 0.4).addScaledVector(this.fwd, -0.3);
        pole.addScaledVector(dir, -pole.dot(dir)); if (pole.lengthSq() < 1e-6) pole.copy(S); pole.normalize();
        el.copy(sh).addScaledVector(dir, a).addScaledVector(pole, h);
        wr.copy(sh).addScaledVector(dir, d);
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
      const fit = this.leg[s === 'L' ? 'l' : 'r'];
      if (fit) {
        kn.copy(fit.kn).applyMatrix4(this._B); an.copy(fit.an).applyMatrix4(this._B); to.copy(fit.to).applyMatrix4(this._B);
      } else if (this.lying) {
        kn.copy(hip).addScaledVector(T, thigh); an.copy(kn).addScaledVector(T, shin); to.copy(an).addScaledVector(this.fwd, FOOT);
      } else if (standing) {
        kn.copy(hip).addScaledVector(DOWN, thigh); an.copy(kn).addScaledVector(DOWN, shin); to.copy(an).addScaledVector(yawFwd, FOOT);
      } else if (lowSit) {
        kn.copy(hip).addScaledVector(yawFwd, thigh); an.copy(kn).addScaledVector(yawFwd, shin); to.copy(an).addScaledVector(UP, FOOT);
      } else {
        kn.copy(hip).addScaledVector(yawFwd, thigh); an.copy(kn).addScaledVector(DOWN, shin); to.copy(an).addScaledVector(yawFwd, FOOT);
      }
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

  // Beine aus erkannten Punkten einpassen (A: Float32Array xyz, n Punkte)
  fit(A, n) {
    const J = this.j, thigh = this.legLen * 0.5, shin = this.legLen * 0.47;
    const dirFrom = (o, test, minD, maxD) => {
      const d = new THREE.Vector3(); let c = 0;
      for (let k = 0; k < n; k++) {
        const x = A[k * 3], y = A[k * 3 + 1], z = A[k * 3 + 2];
        const dx = x - o.x, dy = y - o.y, dz = z - o.z, l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (l < minD || l > maxD || !test(x, y, z)) continue;
        d.x += dx / l; d.y += dy / l; d.z += dz / l; c++;
      }
      return c >= 6 ? d.normalize() : null;
    };
    for (const s of ['L', 'R']) {
      const sg = s === 'L' ? -1 : 1, P = J.pelvis, S = this.side;
      const mine = (x, y, z) => ((x - P.x) * S.x + (y - P.y) * S.y + (z - P.z) * S.z) * sg > -0.04;
      const hip = J['hip' + s], kn = J['kn' + s].clone(), an = J['an' + s].clone(), to = J['to' + s].clone();
      let seen = false;
      const dT = dirFrom(hip, (x, y, z) => mine(x, y, z) && segDist(x, y, z, hip, kn) < 0.3, 0.12, thigh + 0.06);
      if (dT) { kn.copy(hip).addScaledVector(dT, thigh); seen = true; }
      const dS = dirFrom(kn, (x, y, z) => mine(x, y, z) && segDist(x, y, z, kn, an) < 0.25 && segDist(x, y, z, hip, kn) > 0.06, 0.1, shin + 0.05);
      if (dS) { an.copy(kn).addScaledVector(dS, shin); seen = true; }
      const dF = dirFrom(an, (x, y, z) => mine(x, y, z) && segDist(x, y, z, an, to) < 0.2 && segDist(x, y, z, kn, an) > 0.08, 0.05, FOOT + 0.08);
      if (dF) { to.copy(an).addScaledVector(dF, FOOT); seen = true; }
      if (!seen) continue;
      const key = s === 'L' ? 'l' : 'r';
      const loc = { kn: kn.applyMatrix4(this._Bi), an: an.applyMatrix4(this._Bi), to: to.applyMatrix4(this._Bi) };
      const old = this.leg[key];
      if (old) { old.kn.lerp(loc.kn, 0.5); old.an.lerp(loc.an, 0.5); old.to.lerp(loc.to, 0.5); }
      else this.leg[key] = loc;
    }
  }
}

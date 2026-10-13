# Rig fuer "Mei" (Asian Female, Character Creator-Export ohne Skelett, feste Pose):
# Blender (4.0) im Hintergrund:  blender -b asian_norm.blend --python tools/rig-mei.py -- public/models/mei.glb
# asian_norm.blend = Original mit reduzierten Polygonen, auf 1,66 m skaliert, Fuesse auf 0.
# - Gelenke aus Messansichten (Arme ueber Querschnitt-Mittelpunkte, Beine per Hoehenscheiben verfolgt)
# - Gewichte: Blender Bone Heat, dann Arme ueber Mesh-Flutung sauber vom Rumpf getrennt (rechte Hand lag
#   an der Huefte), Bruecken-Dreiecke Hand/Huefte entfernt, Kleidung uebernimmt Gewichte vom Koerper
# - Physik-Knochen: BreastL/R, HairBack/L/R (je mit _End), werden in figure-motion.js simuliert
# - Haut unter enger Kleidung 7 mm nach innen (kein Durchstechen), Texturen verkleinert (JPEG)
# Skelett (Mixamo-Namen) fuer das posierte Asian-Female-Modell, Gewichte, Brust- und Haar-Knochen, Export als GLB.
# Koordinaten unten in glTF-Raum (x, y oben, z vorne) -> Blender (x, -z, y)
import bpy, sys, numpy as np, mathutils, collections
out = sys.argv[-1]
G = lambda x, y, z: mathutils.Vector((x, -z, y))
J = {  # name: (kopf, eltern)
 'Hips': ((-0.01, 0.97, -0.04), None), 'Spine': ((-0.01, 1.07, -0.03), 'Hips'), 'Spine1': ((-0.01, 1.16, -0.03), 'Spine'),
 'Spine2': ((-0.02, 1.25, -0.04), 'Spine1'), 'Neck': ((-0.02, 1.40, -0.06), 'Spine2'), 'Head': ((-0.03, 1.48, -0.05), 'Neck'),
 'HeadTop_End': ((-0.04, 1.66, -0.04), 'Head'),
 'LeftShoulder': ((0.03, 1.37, -0.05), 'Spine2'), 'LeftArm': ((0.11, 1.335, -0.025), 'LeftShoulder'), 'LeftForeArm': ((0.25, 1.262, 0.105), 'LeftArm'),
 'LeftHand': ((0.343, 1.272, 0.30), 'LeftForeArm'), 'LeftHandMiddle1': ((0.338, 1.30, 0.36), 'LeftHand'), 'LeftHandMiddle_End': ((0.335, 1.31, 0.43), 'LeftHandMiddle1'),
 'RightShoulder': ((-0.06, 1.37, -0.05), 'Spine2'), 'RightArm': ((-0.135, 1.335, -0.05), 'RightShoulder'), 'RightForeArm': ((-0.132, 1.205, -0.26), 'RightArm'),
 'RightHand': ((-0.136, 1.01, -0.155), 'RightForeArm'), 'RightHandMiddle1': ((-0.16, 0.975, -0.11), 'RightHand'), 'RightHandMiddle_End': ((-0.17, 0.94, -0.06), 'RightHandMiddle1'),
 'LeftUpLeg': ((0.075, 0.92, -0.02), 'Hips'), 'LeftLeg': ((0.012, 0.60, 0.013), 'LeftUpLeg'), 'LeftFoot': ((-0.033, 0.15, 0.0), 'LeftLeg'),
 'LeftToeBase': ((-0.08, 0.04, 0.06), 'LeftFoot'), 'LeftToe_End': ((-0.10, 0.005, 0.09), 'LeftToeBase'),
 'RightUpLeg': ((-0.08, 0.92, -0.05), 'Hips'), 'RightLeg': ((-0.013, 0.60, -0.133), 'RightUpLeg'), 'RightFoot': ((0.103, 0.15, -0.22), 'RightLeg'),
 'RightToeBase': ((0.086, 0.04, -0.165), 'RightFoot'), 'RightToe_End': ((0.086, 0.005, -0.14), 'RightToeBase'),
 # Physik-Knochen
 'BreastL': ((0.03, 1.26, 0.0), 'Spine2'), 'BreastL_End': ((-0.02, 1.23, 0.12), 'BreastL'),
 'BreastR': ((-0.11, 1.26, -0.03), 'Spine2'), 'BreastR_End': ((-0.18, 1.23, 0.06), 'BreastR'),
 'HairBack': ((-0.03, 1.60, -0.10), 'Head'), 'HairBack_End': ((-0.03, 1.50, -0.17), 'HairBack'),
 'HairL': ((0.06, 1.58, -0.02), 'Head'), 'HairL_End': ((0.09, 1.44, 0.0), 'HairL'),
 'HairR': ((-0.12, 1.58, -0.04), 'Head'), 'HairR_End': ((-0.14, 1.44, -0.02), 'HairR'),
}
CHILD = {}  # Haupt-Kind (bestimmt das Knochenende)
for n, (h, p) in J.items():
    if p and p not in CHILD and not n.startswith(('Left', 'Right', 'Breast', 'Hair')) or (p and p.startswith(('Left', 'Right', 'Breast', 'Hair'))): CHILD.setdefault(p, n)
CHILD.update({'Spine2': 'Neck', 'Hips': 'Spine', 'Head': 'HeadTop_End'})

# Haut unter enger Kleidung minimal nach innen schieben, damit sie beim Bewegen nicht durchsticht
from mathutils.kdtree import KDTree as _KD
_body = bpy.data.objects['body']
_done = set()
_hands = [(G(*J[a][0]), G(*J[b][0])) for a, b in (('LeftHand', 'LeftHandMiddle_End'), ('RightHand', 'RightHandMiddle_End'))]
def _nearhand(p):
    for a, b in _hands:
        ab = b - a; t = max(0, min(1, (p - a).dot(ab) / ab.length_squared))
        if (p - (a + ab * t)).length < 0.1: return True
    return False
for cn in ('shirt', 'short', 'L_sock', 'R_sock', 'boot'):
    c = bpy.data.objects.get(cn)
    if not c: continue
    kd_ = _KD(len(c.data.vertices))
    for v in c.data.vertices: kd_.insert(c.matrix_world @ v.co, v.index)
    kd_.balance()
    moved = 0
    for v in _body.data.vertices:
        p = _body.matrix_world @ v.co
        _, _, d = kd_.find(p)
        if d < 0.03 and v.index not in _done and not _nearhand(p): v.co -= v.normal * 0.007; moved += 1; _done.add(v.index)
    print('TUCK', cn, moved)
arm_data = bpy.data.armatures.new('Armature'); arm = bpy.data.objects.new('Armature', arm_data)
bpy.context.scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = {}
for n, (h, p) in J.items():
    b = arm_data.edit_bones.new('mixamorig' + n); b.head = G(*h); eb[n] = b
for n, (h, p) in J.items():
    b = eb[n]
    c = CHILD.get(n)
    if c: b.tail = G(*J[c][0])
    else:
        d = (G(*h) - G(*J[p][0])) if p else mathutils.Vector((0, 0, 0.1))
        b.tail = G(*h) + d.normalized() * 0.03
    if p: b.parent = eb[p]
    b.use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')

PHYS = {'BreastL', 'BreastR', 'HairBack', 'HairL', 'HairR'}
ENDS = {n for n in J if n.endswith('_End')} | {'HeadTop_End'}
deform = [n for n in J if n not in ENDS]
for n in ENDS: arm_data.bones['mixamorig' + n].use_deform = False

body = bpy.data.objects['body']
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
# Koerper: automatische Gewichte (Bone Heat) ohne Physik-Knochen
for n in PHYS: arm_data.bones['mixamorig' + n].use_deform = False
bpy.ops.object.select_all(action='DESELECT'); body.select_set(True); arm.select_set(True); bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
for n in PHYS: arm_data.bones['mixamorig' + n].use_deform = True

def seg_dist(P, a, b):
    ab = b - a; t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-9), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)
gl = lambda v: np.array([v[0], v[2], -v[1]])   # Blender -> glTF
HEAD = {n: np.array(J[n][0]) for n in J}
TAIL = {n: np.array(J[CHILD[n]][0]) if n in CHILD else HEAD[n] for n in J}
LIMIT = {'Arm': 0.075, 'ForeArm': 0.065, 'Hand': 0.08, 'HandMiddle1': 0.06, 'UpLeg': 0.13, 'Leg': 0.085, 'Foot': 0.08, 'ToeBase': 0.06}

def weights_of(o):
    V = np.array([gl(o.matrix_world @ v.co) for v in o.data.vertices])
    W = np.zeros((len(V), len(deform)))
    idx = {g.index: deform.index(g.name[9:]) for g in o.vertex_groups if g.name[9:] in deform}
    for v in o.data.vertices:
        for g in v.groups:
            if g.group in idx: W[v.index, idx[g.group]] = g.weight
    return V, W

def write(o, W):
    for g in list(o.vertex_groups): o.vertex_groups.remove(g)
    groups = [o.vertex_groups.new(name='mixamorig' + n) for n in deform]
    for k, g in enumerate(groups):
        nz = np.nonzero(W[:, k] > 1e-3)[0]
        for i in nz: g.add([int(i)], float(W[i, k]), 'REPLACE')

V, W = weights_of(body)
# Lecks entfernen: Arm-/Bein-Knochen nur nahe an ihrem Knochen (z. B. Hand an der Huefte, Beine ueberkreuzt)
for k, n in enumerate(deform):
    key = n.replace('Left', '').replace('Right', '')
    if key in LIMIT:
        d = seg_dist(V, HEAD[n], TAIL[n]); W[d > LIMIT[key], k] = 0
# ohne Gewicht: naechster Knochen
empty = W.sum(1) < 1e-4
if empty.any():
    D = np.stack([seg_dist(V[empty], HEAD[n], TAIL[n]) for n in deform], 1)
    for n in PHYS: D[:, deform.index(n)] = 9
    W[np.nonzero(empty)[0], D.argmin(1)] = 1
ARMB = [deform.index(sd + n) for sd in ('Left', 'Right') for n in ('Shoulder', 'Arm', 'ForeArm', 'Hand', 'HandMiddle1')]
def arm_regions(o, V, W, wide=1.0, relax=False):
    mask = np.zeros(len(V), bool)
    # Arme sauber abtrennen: vom Unterarm aus ueber Mesh-Kanten fluten, nicht ueber die Schulter-Ebene hinaus
    import collections
    nb = collections.defaultdict(list)
    for f in o.data.polygons:
        vs = list(f.vertices)
        for a_, b_ in zip(vs, vs[1:] + vs[:1]): nb[a_].append(b_); nb[b_].append(a_)
    for side in ('Left', 'Right'):
        sh, up, fo, ha, hm = (HEAD[side + n] for n in ('Arm', 'Arm', 'ForeArm', 'Hand', 'HandMiddle1'))
        axis = (fo - sh) / np.linalg.norm(fo - sh)
        cut = sh + axis * 0.015                                   # knapp rumpfseitig vom Schultergelenk
        side_ok = ((V - cut) @ axis) > 0
        near = (seg_dist(V, HEAD[side + 'Arm'], HEAD[side + 'ForeArm']) < 0.055 * wide) | (seg_dist(V, HEAD[side + 'ForeArm'], HEAD[side + 'Hand']) < 0.048 * wide)         | (seg_dist(V, HEAD[side + 'Hand'], HEAD[side + 'HandMiddle_End'] + (HEAD[side + 'HandMiddle_End'] - HEAD[side + 'Hand']) * 0.4) < 0.09 * wide)
        dArm = np.minimum.reduce([seg_dist(V, HEAD[side + a_], HEAD[side + b_]) for a_, b_ in (('Arm', 'ForeArm'), ('ForeArm', 'Hand'), ('Hand', 'HandMiddle_End'))])
        dSpine = seg_dist(V, HEAD['Hips'], HEAD['Neck'])
        side_ok &= near & ((dArm * 2.2 < dSpine) | (relax & (seg_dist(V, HEAD[side + 'Hand'], HEAD[side + 'HandMiddle_End']) < 0.09)))
        if ha[1] < fo[1] - 0.1: side_ok &= ~((V[:, 1] < ha[1] + 0.02) & (dArm > 0.042 * wide) & (dSpine < 0.185))   # unter dem Handgelenk nur die Hand selbst
        seed = np.nonzero((seg_dist(V, fo + (ha - fo) * 0.15, fo + (ha - fo) * 0.6) < 0.04) & side_ok)[0]   # nur Unterarm-Mitte
        region = np.zeros(len(V), bool); region[seed] = True
        q = collections.deque(seed.tolist())
        while q:
            i = q.popleft()
            for j in nb[i]:
                if not region[j] and side_ok[j]: region[j] = True; q.append(j)
        # Rumpf von der anderen Seite fluten: kommt nicht durch den Arm-Kern, markiert z. B. die Huefte unter der Hand
        core = side_ok & (dArm < 0.045 * wide)
        torso = np.zeros(len(V), bool)
        tseed = np.nonzero((dArm > 0.15) & (dSpine < 0.2))[0]; torso[tseed] = True
        q = collections.deque(tseed.tolist())
        while q:
            i = q.popleft()
            for j in nb[i]:
                if not torso[j] and not core[j]: torso[j] = True; q.append(j)
        region &= ~(torso & (dArm > 0.03))
        bones = [side + n for n in ('Arm', 'ForeArm', 'Hand', 'HandMiddle1')]
        ks = [deform.index(n) for n in bones]
        D = np.stack([seg_dist(V, HEAD[n], TAIL[n]) for n in bones], 1)
        G2 = 1 / np.maximum(D, 0.004) ** 4; G2 /= G2.sum(1, keepdims=True)
        # Uebergang an der Schulter: nah an der Schnittebene mit den alten (Rumpf-)Gewichten mischen
        t = np.clip(((V - cut) @ axis) / 0.07, 0, 1)[:, None]
        newW = np.zeros_like(W); newW[:, ks] = G2
        W[region] = (W[region] * (1 - t[region]) + newW[region] * t[region])
        # ausserhalb: keine Gewichte dieses Arms
        for k in ks: W[~region, k] = 0
        print('ARM', o.name, side, region.sum())
        mask |= region

    W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
    empty = W.sum(1) < 1e-4
    if empty.any():
        D = np.stack([seg_dist(V[empty], HEAD[n], TAIL[n]) for n in deform], 1)
        for n in PHYS: D[:, deform.index(n)] = 9
        for k in ARMB: D[:, k] = 9
        W[np.nonzero(empty)[0], D.argmin(1)] = 1
    MASKS[o.name] = mask
    return W

MASKS = {}
W0 = W.copy()
W = arm_regions(body, V, W)
W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
empty = W.sum(1) < 1e-4
if empty.any():
    D = np.stack([seg_dist(V[empty], HEAD[n], TAIL[n]) for n in deform], 1)
    for n in PHYS: D[:, deform.index(n)] = 9
    W[np.nonzero(empty)[0], D.argmin(1)] = 1
# Brust: weiche Kugel um die Brustmitte, nur vorne
for side in ('L', 'R'):
    n = 'Breast' + side; k = deform.index(n)
    c = HEAD[n] * 0.35 + HEAD[n + '_End'] * 0.65
    d = np.linalg.norm(V - c, axis=1); r = 0.095
    w = np.clip(1 - d / r, 0, 1) ** 1.5
    front = ((V - HEAD[n]) @ (HEAD[n + '_End'] - HEAD[n])) > -0.005
    w = w * front * 0.95
    W *= (1 - w)[:, None]; W[:, k] += w
W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
# auf 4 Einfluesse begrenzen
for i in range(len(W)):
    row = W[i]; 
    if (row > 0).sum() > 4: row[np.argsort(row)[:-4]] = 0; W[i] = row / row.sum()
# kleine Einzelteile (Naegel usw.): Gewichte vom naechsten Punkt des Hauptkoerpers
nbb = collections.defaultdict(list)
for e in body.data.edges: i, j = e.vertices; nbb[i].append(j); nbb[j].append(i)
comp = -np.ones(len(V), int); c = 0
for s0 in range(len(V)):
    if comp[s0] >= 0: continue
    st = [s0]; comp[s0] = c
    while st:
        i = st.pop()
        for j in nbb[i]:
            if comp[j] < 0: comp[j] = c; st.append(j)
    c += 1
main = np.bincount(comp).argmax()
mi = np.nonzero(comp == main)[0]
for k in np.nonzero(comp != main)[0]:
    j = mi[np.argmin(np.linalg.norm(V[mi] - V[k], axis=1))]; W[k] = W[j]
# Brueckendreiecke zwischen Hand und Huefte entfernen (beruehren sich im Ausgangsmodell)
armw = W[:, [deform.index('Right' + n) for n in ('ForeArm', 'Hand', 'HandMiddle1')] + [deform.index('Left' + n) for n in ('ForeArm', 'Hand', 'HandMiddle1')]].sum(1)
import bmesh
bm = bmesh.new(); bm.from_mesh(body.data); bm.faces.ensure_lookup_table()
bad = [f for f in bm.faces if (lambda a: a.max() > 0.8 and a.min() < 0.2)(np.array([armw[v.index] for v in f.verts]))]
print('BRIDGE', len(bad))
bmesh.ops.delete(bm, geom=bad, context='FACES_ONLY'); bm.to_mesh(body.data); bm.free()
# nach dem Trennen nochmal: jetzt erreicht die Flut auch die Fingerspitzen an der Huefte
W = arm_regions(body, V, W0.copy(), relax=True)
for k in np.nonzero(comp != main)[0]:
    j = mi[np.argmin(np.linalg.norm(V[mi] - V[k], axis=1))]; W[k] = W[j]
write(body, W)
BW = W; BV = V

# Kleidung: Gewichte vom naechsten Koerperpunkt uebernehmen
from mathutils.kdtree import KDTree
keep = np.nonzero(~MASKS['body'])[0]
kd = KDTree(len(keep))
for i in keep: kd.insert(BV[i], int(i))
kd.balance()
hk = deform.index('Head')
for o in meshes:
    if o is body: continue
    V = np.array([gl(o.matrix_world @ v.co) for v in o.data.vertices])
    W = np.zeros((len(V), len(deform)))
    if o.name in ('L_eyes', 'R_eyes', 'teeth_lower', 'teeth_upper', 'tongue', 'eyelashes'): W[:, hk] = 1
    elif o.name == 'hair1':
        # Haare: Kopf, untere/aeussere Straehnen an die Haar-Knochen
        for i, p in enumerate(V):
            hang = np.clip((1.60 - p[1]) / 0.14, 0, 1)
            ds = {n: seg_dist(p[None], HEAD[n], HEAD[n + '_End'])[0] for n in ('HairBack', 'HairL', 'HairR')}
            n = min(ds, key=ds.get)
            w = hang * np.clip(1 - ds[n] / 0.12, 0, 1) * 0.9
            W[i, hk] = 1 - w; W[i, deform.index(n)] = w
    else:
        for i, p in enumerate(V):
            res = kd.find_n(p, 3)
            tot = 0
            for (_, j, d) in res:
                f = 1 / (d + 1e-4); W[i] += BW[j] * f; tot += f
            W[i] /= tot
        if o.name in ('shirt', 'bra'): W = arm_regions(o, V, W, wide=1.6)
    write(o, W)
    o.parent = arm
    m = o.modifiers.new('Armature', 'ARMATURE'); m.object = arm
for o in meshes:
    print('W', o.name, len(o.data.vertices), len(o.vertex_groups))
for img in bpy.data.images:
    if img.size[0] == 0: continue
    big = 2048 if img.name.startswith('body_basecolor') else 1024
    if 'specular' in img.name or 'Eye_' in img.name: big = 512
    if 'teeth' in img.name or 'metallic' in img.name: big = 512
    if max(img.size) > big:
        f = big / max(img.size); img.scale(int(img.size[0] * f), int(img.size[1] * f))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_image_format='JPEG', export_jpeg_quality=85, export_yup=True, export_skins=True, export_def_bones=False, export_animations=False)
print('EXPORTED', out)

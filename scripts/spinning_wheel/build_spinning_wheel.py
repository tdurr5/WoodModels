"""Build the craftsmanspace.com Castle spinning wheel as a COLLADA model.

    blender -b --python scripts/spinning_wheel/build_spinning_wheel.py -- out.dae
    python3 parse_dae.py out.dae -o viewer/models/spinning-wheel/

Every part is made to the plan's own dimensions (millimetres). Turned parts
whose drawings give a few diameters on a 10 mm grid (pillars, holder, legs,
maidens, wool carrier, wool bar, treadle axle, bobbin) use profiles traced
off the 300 dpi drawings into profiles.json - accurate to about 0.3 mm,
checked against every labelled diameter. Parts drawn with full arc
dimensions (hub, toggle, whorl, tension knob, disc) are built from those
numbers. Parts are placed as the assembly drawings (pages 5 and 26) show and
written as one COLLADA node per part, grouped by the plan's three
subassemblies.

World axes: Z up, floor at z=0. The main pillar stands on the origin; +Y runs
along base plank 2 toward the secondary pillar, the maidens and the flyer's
orifice; +X is the side the wool carrier swings out to (the treadle is on -X).

Set SW_DUMP=path.json to also write every part's world-space vertices (used
to overlay the model on the plan's assembly drawings).
"""
import bmesh
import bpy
import json
import math
import os
import sys
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else os.path.join(HERE, 'spinning_wheel.dae')
PROF = json.load(open(os.path.join(HERE, 'profiles.json')))

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

SEG = 40

# ---------------------------------------------------------------- geometry


def mesh_obj(name, verts, faces):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.validate()
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


# turn a solid built along local Z to lie along X or Y
TO_X = Matrix.Rotation(math.pi / 2, 4, 'Y')
TO_Y = Matrix.Rotation(-math.pi / 2, 4, 'X')


def simplify(pts, tol=0.05):
    """Douglas-Peucker: drop profile points within tol (mm) of the line through their neighbours."""
    if len(pts) < 3:
        return pts
    (z0, r0), (z1, r1) = pts[0], pts[-1]
    L = math.hypot(z1 - z0, r1 - r0) or 1.0
    d = [abs((z1 - z0) * (r - r0) - (r1 - r0) * (z - z0)) / L for z, r in pts]
    i = max(range(len(pts)), key=d.__getitem__)
    if d[i] <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[:i + 1], tol)[:-1] + simplify(pts[i:], tol)


def lathe(name, prof, segs=SEG, axis='Z'):
    """Solid of revolution of [(z, r)] about local Z (r=0 points become poles)."""
    pts = simplify([(float(z), max(0.0, float(r))) for z, r in prof])
    if pts[0][1] > 1e-6:
        pts.insert(0, (pts[0][0], 0.0))
    if pts[-1][1] > 1e-6:
        pts.append((pts[-1][0], 0.0))
    verts, rings = [], []
    for z, r in pts:
        if r <= 1e-6:
            rings.append([len(verts)])
            verts.append((0, 0, z))
        else:
            ring = []
            for k in range(segs):
                a = 2 * math.pi * k / segs
                ring.append(len(verts))
                verts.append((r * math.cos(a), r * math.sin(a), z))
            rings.append(ring)
    faces = []
    for A, B in zip(rings, rings[1:]):
        if len(A) == 1 and len(B) == 1:
            continue
        for k in range(segs):
            k2 = (k + 1) % segs
            if len(A) == 1:
                faces.append((A[0], B[k2], B[k]))
            elif len(B) == 1:
                faces.append((A[k], A[k2], B[0]))
            else:
                faces.append((A[k], A[k2], B[k2], B[k]))
    ob = mesh_obj(name, verts, faces)
    if axis != 'Z':
        ob.data.transform(TO_X if axis == 'X' else TO_Y)
    return ob


def cyl(name, r, z0, z1, segs=32, axis='Z'):
    return lathe(name, [(z0, r), (z1, r)], segs, axis)


# (u, v, w) of prism() -> the axes the polygon lies in
PLANE = {
    'XY': Matrix.Identity(4),
    'XZ': Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1))),   # extruded along Y
    'YZ': Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1))),   # extruded along X
}


def prism(name, poly, z0, z1, plane='XY'):
    """Polygon [(u, v)] extruded from w=z0 to w=z1."""
    n = len(poly)
    area = sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1] for i in range(n))
    if area < 0:
        poly = poly[::-1]
    bm = bmesh.new()
    bottom = [bm.verts.new((u, v, z0)) for u, v in poly]
    top = [bm.verts.new((u, v, z1)) for u, v in poly]
    bm.faces.new(bottom[::-1])
    bm.faces.new(top)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bottom[i], bottom[j], top[j], top[i]))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if plane != 'XY':
        ob.data.transform(PLANE[plane])
        if plane == 'XZ':    # that remap is a reflection
            ob.data.flip_normals()
    return ob


def box(name, x0, x1, y0, y1, z0, z1):
    return prism(name, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z1)


def arc(cx, cy, r, a0, a1, n=24):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def tube(name, path, r, segs=10, closed=False):
    """A wire of radius r swept along a polyline (parallel-transport frames)."""
    P = [Vector(p) for p in path]
    n = len(P)
    tang = []
    for i in range(n):
        t = (P[(i + 1) % n] - P[i - 1]) if closed else (P[min(i + 1, n - 1)] - P[max(i - 1, 0)])
        tang.append(t.normalized())
    ref = Vector((0, 0, 1)) if abs(tang[0].z) < 0.9 else Vector((1, 0, 0))
    nrm = (ref - tang[0] * ref.dot(tang[0])).normalized()
    verts = []
    for i in range(n):
        nrm = (nrm - tang[i] * nrm.dot(tang[i])).normalized()
        b = tang[i].cross(nrm)
        for k in range(segs):
            a = 2 * math.pi * k / segs
            verts.append(P[i] + r * (math.cos(a) * nrm + math.sin(a) * b))
    faces = []
    for i in range(n if closed else n - 1):
        j = (i + 1) % n
        for k in range(segs):
            k2 = (k + 1) % segs
            faces.append((i * segs + k, i * segs + k2, j * segs + k2, j * segs + k))
    if not closed:
        c0, c1 = len(verts), len(verts) + 1
        verts += [P[0], P[-1]]
        for k in range(segs):
            k2 = (k + 1) % segs
            faces.append((c0, k2, k))
            faces.append((c1, (n - 1) * segs + k, (n - 1) * segs + k2))
    return mesh_obj(name, verts, faces)


def boolean(ob, tool, op):
    m = ob.modifiers.new('b', 'BOOLEAN')
    m.operation = op
    m.solver = 'EXACT'
    m.object = tool
    ev = ob.evaluated_get(bpy.context.evaluated_depsgraph_get())
    me = bpy.data.meshes.new_from_object(ev)
    ob.modifiers.clear()
    old, ob.data = ob.data, me
    bpy.data.meshes.remove(old)
    bpy.data.objects.remove(tool, do_unlink=True)
    if not ob.data.vertices:
        raise RuntimeError(f'{op} left {ob.name} empty')
    return ob


def cut(ob, *tools):
    for t in tools:
        boolean(ob, t, 'DIFFERENCE')
    return ob


def unite(ob, *tools):
    for t in tools:
        boolean(ob, t, 'UNION')
    return ob


def keep(ob, tool):
    return boolean(ob, tool, 'INTERSECT')


def xf(ob, M):
    """Move a solid's mesh (puts cutters in place in the part's own frame)."""
    ob.data.transform(M)
    return ob


def T(x=0, y=0, z=0):
    return Matrix.Translation((x, y, z))


def R(deg, axis):
    return Matrix.Rotation(math.radians(deg), 4, axis)


def frame(origin, zdir, xdir=None):
    """Matrix taking local Z to zdir at origin, local X toward xdir."""
    z = Vector(zdir).normalized()
    x = Vector(xdir) if xdir is not None else (Vector((1, 0, 0)) if abs(z.x) < 0.9 else Vector((0, 1, 0)))
    x = (x - z * x.dot(z)).normalized()
    M = Matrix((x, z.cross(x), z)).transposed().to_4x4()
    M.translation = Vector(origin)
    return M


def axes(x, y, z, origin):
    M = Matrix((Vector(x), Vector(y), Vector(z))).transposed().to_4x4()
    M.translation = Vector(origin)
    return M


def traced(key, length, lead=0.0):
    """A traced profile [(z, r)] stretched to the plan's labelled length (it
    is within 0.5 mm of it already) and shifted along by `lead`."""
    p = PROF[key]
    s = (length - lead) / p['length']
    return simplify([(lead + z * s, r) for z, r in p['profile']], 0.25)   # the trace is good to ~0.3 mm


def drill(ob, M, r, z0, z1, segs=16):
    """Bore a part already placed where a pin, bar or nail goes: a cylinder from z0 to z1
    along local Z of the world-space frame M (the boolean works in world space)."""
    return cut(ob, xf(cyl('drill', r, z0, z1, segs), M))


def radius_at(prof, z):
    for (z0, r0), (z1, r1) in zip(prof, prof[1:]):
        if z0 <= z <= z1 and z1 > z0:
            return r0 + (r1 - r0) * (z - z0) / (z1 - z0)
    return None

# ---------------------------------------------------------------- parts


PARTS = []   # (group, name, object, material)


def part(group, name, ob, mat, M):
    ob.matrix_world = M
    ob.name = name
    PARTS.append((group, name, ob, mat))
    return ob


WHEEL, FLYER, FRAME = 'Wheel Assembly', 'Flyer Assembly', 'Frame Assembly'
FRAME_WOOD, WHEEL_WOOD, STEEL = 'Walnut', 'Cherry', 'Steel'   # the plan's render: brown frame, red wheel & flyer

# ---------------------------------------------------------------- key positions (mm)

PB, PT = 146.5, 176.5          # base planks' underside / top (146 from the floor, 30 thick)
AXLE_Z = PT + 200              # wheel axle, in the pillars' slots 233 from the tenon end (33 tenon)
HOLDER_Z = 614.0               # main holder axis (section A-A: 614 from the floor, 437.5 above the plank)
SEC_Y = 159.0                  # secondary pillar, 159 behind the main pillar
MAID_Y = SEC_Y + 97            # maidens, 97 further along the holder
FLYER_Z = 723.0                # flyer axis: its bearing in the maidens' U, 8.5 below their top

# ================================================================ FRAME


def axle_slot(z0):
    """The hooked slot the wheel axle drops into: 8 wide on an R36 arc, R4 bottom at z0."""
    inner = arc(-36, z0, 32, 0, 80, 30)
    outer = arc(-36, z0, 40, 80, 0, 30)
    tip = [(4 * math.cos(math.radians(a)), z0 + 4 * math.sin(math.radians(a))) for a in range(0, -181, -15)]
    return prism('slot', outer + tip + inner, -40, 40, 'XZ')


# --- 3.04 Main Pillar, tenon down through base plank 1 and plank 2's tenon
mp = lathe('mp', traced('main_pillar', 643))
cut(mp,
    xf(cyl('h18', 9, -40, 40, 24, 'Y'), T(0, 0, 470.5)),       # Ø18 for the holder's tenon (172.5 from the top)
    axle_slot(233),
    xf(cyl('pin', 4, -40, 40, 20, 'X'), T(0, 0, 242)),          # Ø8 for the axle pin
    box('win', -10.5, 10.5, -40, 40, 548, 604),                 # 21 x 55 window for the movable bearing
    cyl('bore', 10, 538, 650, 32))                              # Ø20 bore for the tension screw
part(FRAME, 'Main Pillar', mp, FRAME_WOOD, T(0, 0, PT - 33))

# --- 3.07 Secondary Pillar
sp_prof = traced('secondary_pillar', 493)
sp = lathe('sp', sp_prof)
cut(sp, axle_slot(233), xf(cyl('pin', 4, -40, 40, 20, 'X'), T(0, 0, 242)))
part(FRAME, 'Secondary Pillar', sp, FRAME_WOOD, T(0, SEC_Y, PT - 33))
sp_shoulder = max(z for z, r in sp_prof if r > 12.5)

# --- 3.08 Main Holder: front (cone) tip at local z=0, tenon through the main pillar
mh_prof = [(0.0, 0.0)] + traced('main_holder', 340, lead=1.0)
mh = lathe('mh', mh_prof)
TENON_END_Y = SEC_Y - 205             # 205 from the Ø20 hole to the tenon's end
z_maid = 340 - (MAID_Y - TENON_END_Y)
z_sec = 340 - (SEC_Y - TENON_END_Y)
cut(mh,
    xf(cyl('h18', 9, -30, 30, 24, 'Y'), T(0, 0, z_maid)),       # Ø18 for the maidens
    xf(cyl('h8', 4, -30, 30, 20, 'X'), T(0, 0, z_maid)),        # Ø8 lock pin across it
    xf(cyl('h20', 10, -30, 30, 24, 'Y'), T(0, 0, z_sec)))       # Ø20 for the secondary pillar's tenon
part(FRAME, 'Main Holder', mh, FRAME_WOOD, axes((1, 0, 0), (0, 0, 1), (0, -1, 0), (0, TENON_END_Y + 340, HOLDER_Z)))
holder_r_at_sec = radius_at(mh_prof, z_sec)


def disc():
    d = lathe('disc', [(0, 0), (0, 30), (3, 30), (20, 12), (20, 0)])
    return cut(d, cyl('b', 9, -1, 21, 24))


# --- 3.09 Disc 1 caps the holder's tenon behind the main pillar, flange outward
part(FRAME, 'Disc', disc(), WHEEL_WOOD, frame((0, TENON_END_Y + 0.5, HOLDER_Z), (0, 1, 0)))

# --- 3.06 Tension Knob: head and Ø28 boss above the pillar, screw down through the bearing


def knob_profile():
    p = [(0, 0), (0, 17)]
    p += [(9 - 9 * math.cos(math.radians(a)), 17 + 9 * math.sin(math.radians(a))) for a in range(10, 91, 10)]       # R9 to Ø52
    p += [(9 + 8.85 * (1 - math.cos(math.radians(a))), 26 - 8.5 * math.sin(math.radians(a))) for a in range(10, 181, 10)]  # R9 cove, Ø35
    p += [(26.7 + 15.3 * a / 90, 26 + 3 * math.sin(math.radians(a))) for a in range(10, 91, 10)]                   # rise to Ø58
    p += [(42 + 9 * math.sin(math.radians(a)), 20 + 9 * math.cos(math.radians(a))) for a in range(10, 91, 10)]     # R9 to the face
    p += [(51, 14), (57, 14), (57, 9), (91.3, 9), (91.3, 6.1), (95.5, 6.1), (95.5, 7.15),                     # boss Ø28 x 6, Ø18 x 34.3
          (158.5, 7.15), (165.0, 2.5), (165.0, 0)]                                                            # thread Ø14.3, 70° point
    return p


part(FRAME, 'Tension Knob', lathe('kn', knob_profile()), WHEEL_WOOD, frame((0, 0, PT - 33 + 643 + 57), (0, 0, -1)))

# --- 3.05 Movable Bearing: 20 (X) x 45 (Y) x 34 (Z) in the pillar's window, sticking out toward the flyer
mb = box('mb', -10, 10, -12, 33, -17, 17)
cut(mb, cyl('thr', 6, -20, 20, 24),                                # Ø12 thread, on the screw
    xf(cyl('ax', 3, 0, 22.5, 16, 'Y'), T(0, 10.5, 0)))             # Ø6 x 22 for the flyer axle's tip
part(FRAME, 'Movable Bearing', mb, FRAME_WOOD, T(0, 0, FLYER_Z))

# --- 3.10 Maidens: shoulder on the holder, fork head up. Local z=0 is the head's tip.
HEAD = 29.5
md = lathe('md', traced('maidens', 235))
# side view: the head is sawn to 12.3 thick at the tip, flaring to full width 29.5 down
half = [(z, min(15.5, 6.15 + 8.85 * (z / HEAD) ** 2)) for z in [HEAD * i / 30 for i in range(31)]]
side = [(-0.5, -6.15)] + [(z, -t) for z, t in half] + [(240, -20), (240, 20)] + [(z, t) for z, t in half[::-1]] + [(-0.5, 6.15)]
keep(md, xf(prism('flats', [(t, z) for z, t in side], -20, 20), PLANE['YZ']))
uslot = [(-6.5, -1)] + arc(0, 8.5, 6.5, 180, 0, 18) + [(6.5, -1)]    # U: R6.5 centred 8.5 below the tip
cut(md, prism('u', uslot, -20, 20, 'XZ'),
    xf(cyl('pin', 4, -20, 20, 16, 'X'), T(0, 0, 235 - 117.5)))
MAID_TOP = HOLDER_Z + 22.5 + (235 - 140)
part(FRAME, 'Maidens', md, WHEEL_WOOD, frame((0, MAID_Y, MAID_TOP), (0, 0, -1), (1, 0, 0)))

# --- 3.11 Pin D8 x 44mm through the holder and the maidens
part(FRAME, 'Pin D8 x 44mm', lathe('pn', [(0, 0), (0.6, 3.2), (1.2, 4), (42.8, 4), (43.4, 3.2), (44, 0)], 24),
     WHEEL_WOOD, frame((-22, MAID_Y, HOLDER_Z), (1, 0, 0)))

# --- 3.13 Skin over the fork head (holds the flyer bearing in), 3.22 Nail D1.5 x 15 through it
w, ht = 16.0, MAID_TOP
strap = [(-w, ht - 20), (-w, ht - 2)]
strap += [(-w + 2 - 2 * math.cos(math.radians(a)), ht - 2 + 2 * math.sin(math.radians(a))) for a in range(15, 91, 15)]
strap += [(w - 2 + 2 * math.cos(math.radians(90 - a)), ht - 2 + 2 * math.sin(math.radians(90 - a))) for a in range(0, 91, 15)]
strap += [(w, ht - 22), (w + 4, ht - 40), (w + 10, ht - 52)]
outline = strap + [(x + (0.8 if x > 0 else -0.8), z) for x, z in strap[::-1]]
part(FRAME, 'Skin', prism('sk', outline, MAID_Y - 6, MAID_Y + 6, 'XZ'), 'Leather', Matrix.Identity(4))
M_nail = frame((-w - 0.9, MAID_Y, ht - 12), (1, 0, 0))
part(FRAME, 'Nail D1.5 x 15mm', lathe('nl', [(0, 0), (0, 1.6), (0.4, 1.6), (0.4, 0.75), (13.5, 0.75), (15, 0)], 12), STEEL, M_nail)
drill(md, M_nail, 0.75, 0, 16, 8)                                           # pilot

# --- 3.12 Wool Carrier: square end on the maidens under the holder, knob out to +X
wc = lathe('wc', traced('wool_carrier', 250) + [(250, 0)])
cut(wc, xf(cyl('h19', 9.5, -30, 30, 24, 'Y'), T(0, 0, 45)), xf(cyl('h16', 8, -30, 30, 24, 'Y'), T(0, 0, 200)))
CARRIER_Z = HOLDER_Z - 22.5 - 20
part(FRAME, 'Wool Carrier', wc, FRAME_WOOD, frame((-45, MAID_Y, CARRIER_Z), (1, 0, 0), (0, 1, 0)))

# --- disc 2 on the maidens under the carrier, flange up against it
part(FRAME, 'Disc', disc(), WHEEL_WOOD, frame((0, MAID_Y, CARRIER_Z - 20), (0, 0, -1)))

# --- 3.24 Wool Bar: in the drawings it stands on the floor in front of the carrier, leaning back 13°
WB_BOT, WB_TOP = Vector((110, 426, 0)), Vector((110, 161, 1146))
part(FRAME, 'Wool Bar', lathe('wb', traced('wool_bar', 1194), 32), WHEEL_WOOD, frame(WB_BOT, WB_TOP - WB_BOT))

# --- 3.01 / 3.02 Base planks (R30 ends in plan)


def r30_end(u_end, sign, n=16):
    """Plan arc of an R30 end with its apex at u_end, across the 52 width."""
    a = math.degrees(math.asin(26 / 30))
    return [(u_end - sign * (30 - 30 * math.cos(math.radians(t))), 30 * math.sin(math.radians(t)))
            for t in [sign * (a - 2 * a * i / n) for i in range(n + 1)]]


DOWN15 = math.cos(math.radians(15))
leg_holes = {   # where each leg's hole axis meets the planks' underside (55 from the end), and its direction down
    'A': (Vector((-160, 0, PB)), Vector((-math.sin(math.radians(15)), 0, -DOWN15))),
    'B': (Vector((160, 0, PB)), Vector((math.sin(math.radians(15)), 0, -DOWN15))),
    'C': (Vector((0, SEC_Y + 50, PB)), Vector((0, math.sin(math.radians(15)), -DOWN15))),
}

bp1 = prism('bp1', r30_end(-215, -1) + r30_end(215, 1), PB, PT)
cut(bp1, cyl('c', 13, PB - 5, PT + 5, 32),                                # Ø26 for the main pillar's tenon
    box('mort', -26.1, 26.1, -30, 30, PT - 19.5, PT - 9),                  # 52 x 10.5 mortise for plank 2's tenon
    xf(cyl('w', 9, PB - 5, PT + 5, 24), T(-75, 0, 0)),                     # Ø18, 140 from the end
    *[xf(cyl('lh', 9, -10, 60, 24), frame(o, -v)) for o, v in (leg_holes['A'], leg_holes['B'])])   # Ø18 at 75°
part(FRAME, 'Base Plank 1', bp1, FRAME_WOOD, Matrix.Identity(4))

bp2 = prism('bp2', [(v, u) for u, v in r30_end(264, 1)] + [(-26, 26), (26, 26)], PB, PT)
unite(bp2, box('ten', -26, 26, -26, 26.5, PB + 10.5, PB + 19.5))          # 52 x 9 tenon into plank 1
cut(bp2, cyl('c', 13, PB - 5, PT + 5, 32),                                # Ø26 in the tenon, under the main pillar
    xf(cyl('c2', 13, PB - 5, PT + 5, 32), T(0, SEC_Y, 0)),                 # Ø26 for the secondary pillar
    xf(cyl('lh', 9, -10, 60, 24), frame(leg_holes['C'][0], -leg_holes['C'][1])))
part(FRAME, 'Base Plank 2', bp2, FRAME_WOOD, Matrix.Identity(4))

# --- 3.03 Leg (x3), shoulder against the planks' underside, tenon up through.
# Section A-A of the leg gives 154 / 149 from the shoulder to the foot's long / short side,
# so it is 193 on its long side (the 190 overall is along its axis); the foot is sawn at 12°.
LEG_LONG = 193.0
lg_prof = traced('leg', LEG_LONG, lead=LEG_LONG - PROF['leg']['length'])
lg_prof.insert(0, (0.0, lg_prof[0][1]))
legs, leg_obs = {}, {}
for k, (o, v) in leg_holes.items():
    lg = lathe('lg', lg_prof, 40)
    cut(lg, xf(box('foot', -40, 40, -40, 40, -60, 0), T(0, 0, 2.5) @ R(-12, 'Y')),
        box('kerf', -0.5, 0.5, -15, 15, LEG_LONG - 25, LEG_LONG + 5))       # 1 x 25 kerf for the wedge
    out = Vector((v.x, v.y, 0)).normalized()
    legs[k] = frame(o + v * (LEG_LONG - 39), -v, -out)                     # local -X (long side) outward
    leg_obs[k] = part(FRAME, 'Leg', lg, FRAME_WOOD, legs[k])
    # 3.21 Thin Wedge (3 x 17 x 35) in the kerf, thick end 10 proud of the tenon
    part(FRAME, 'Thin Wedge', prism('wd', [(0, 0), (0, 3), (35, 0)], -8.5, 8.5), FRAME_WOOD,
         legs[k] @ T(0, 0, LEG_LONG + 10) @ Matrix(((0, 1, 0, 0), (0, 0, 1, 0), (-1, 0, 0, 0), (0, 0, 0, 1))) @ T(0, -1.5, 0))

# --- 3.14 Axle Pin (x2): 9 -> 6 taper, 80 long, across each pillar above the axle
for y in (0.0, SEC_Y):
    part(FRAME, 'Axle Pin', lathe('ap', [(0, 0), (0, 3), (80, 4.5), (80, 0)], 20), FRAME_WOOD, frame((-40, y, PT + 209), (1, 0, 0)))

# --- 3.15 Treadle Axle between legs A and C on 3.17 treadle bars (holes drilled at assembly)
PA, PC = legs['A'] @ Vector((0, 0, 37.5)), legs['C'] @ Vector((0, 0, 37.5))
ax_dir = (PC - PA).normalized()
GAP = ((PC - PA).length - 283) / 2
ta = lathe('ta', traced('treadle_axle', 283), 40)
# the square middle, its corners turned off where it meets the round ends
blk = keep(box('blk', -13, 13, -13, 13, 86, 197),
           lathe('cone', [(86, 0), (86, 10.25), (141.5, 32.45), (197, 10.25), (197, 0)], 40))
unite(ta, blk)
cut(ta, cyl('b1', 3, -1, 60, 16), cyl('b2', 3, 223, 284, 16))              # Ø6 x 60 for the treadle bars
# dovetail across the top at 69°: 10 deep, 60° sides, 44.8 wide at the top (48 along the axle)
SLOT = 69.0
dv = prism('dv', [(-22.4, 13.01), (22.4, 13.01), (28.0, 3.0), (-28.0, 3.0)], -60, 60)
xf(dv, Matrix(((0, 0, 1, 0), (0, 1, 0, 0), (-1, 0, 0, 0), (0, 0, 0, 1))))  # run along local X, height up local Y
cut(ta, xf(dv, T(0, 0, 141.5) @ R(90 - SLOT, 'Y')))
up = Vector((0, 0, 1))
M_ta = axes(ax_dir.cross(up), up, ax_dir, PA + ax_dir * GAP)                # local Y up, Z along the axle
part(FRAME, 'Treadle Axle', ta, FRAME_WOOD, M_ta)
for k, P0, d in (('A', PA, ax_dir), ('C', PC, -ax_dir)):
    M_bar = frame(P0 + d * (GAP + 60 - 90), d)                             # 60 in the axle, the rest through the leg
    part(FRAME, 'Treadle Bar', cyl('tb', 3, 0, 90, 16), STEEL, M_bar)
    drill(leg_obs[k], M_bar, 3, -1, 45)   # Ø6 through the leg, 35 up it

# --- 3.16 Treadle Pedal: bevelled end in the dovetail, nose with the cord holes under the footman
pedal = [(0.0, 26.0)]
pedal += [(27 - 25 * math.sin(math.radians(a)), 25 - 25 * math.cos(math.radians(a))) for a in range(80, -1, -10)]   # R25 nose
pedal += [(245.0, 0.0), (245 - 56 / math.tan(math.radians(SLOT)), 56.0), (19.5, 56.0)]                              # 69° end, 120° corner
tp = prism('tp', pedal, 0, 10)
for yedge, s in ((0.0, 1), (56.0, -1)):      # 62° bevels along both edges over the last 116
    bev = prism('bev', [(yedge - s * 0.01, 10.01), (yedge + s * 10 / math.tan(math.radians(62)), 10.01), (yedge - s * 0.01, 0)],
                245 - 116, 260)
    cut(tp, xf(bev, PLANE['YZ']))
cut(tp, xf(cyl('c1', 2.5, -1, 11, 16), T(16.7, 32, 0)), xf(cyl('c2', 2.5, -1, 11, 16), T(34.3, 22, 0)),   # Ø5 cord holes
    xf(cyl('n1', 1, -1, 11, 8), T(200, 28, 0)), xf(cyl('n2', 1, -1, 11, 8), T(220, 28, 0)))                 # nail holes
ped_dir = (Matrix.Rotation(math.radians(-(180 - SLOT)), 4, 'Z') @ ax_dir.to_4d()).to_3d()
ped_dir = Vector((ped_dir.x, ped_dir.y, 0)).normalized()
cross_x = 245 - 28 / math.tan(math.radians(SLOT)) - 13 / math.sin(math.radians(SLOT))   # where the axle's centre line crosses it
side = up.cross(ped_dir)
slot_c = M_ta @ Vector((0, 3, 141.5))
M_tp = axes(-ped_dir, -side, up, slot_c + ped_dir * cross_x + side * 28)
part(FRAME, 'Treadle Pedal', tp, WHEEL_WOOD, M_tp)
pedal_holes = M_tp @ Vector((16.7, 32, 10)), M_tp @ Vector((34.3, 22, 10))
for xn in (200, 220):
    M_nail = frame(M_tp @ Vector((xn, 28, 10.6)), (0, 0, -1))
    part(FRAME, 'Nail D2 x 20mm', lathe('nl', [(0, 0), (0, 2.6), (0.6, 2.6), (0.6, 1.0), (18, 1.0), (20, 0)], 12), STEEL, M_nail)
    drill(ta, M_nail, 1.0, 0, 21, 8)                                       # pilot into the axle

# ================================================================ WHEEL

HUB_Y0 = (SEC_Y - 100) / 2            # hub centred between the pillars
RIM_Y = HUB_Y0 + 34                    # spokes (and the rim) 34 from the hub's crank-side end


def hub_profile():
    p = [(0, 0)]
    p += [(50.3 - math.sqrt(50.3 ** 2 - r ** 2), r) for r in [35 * i / 12 for i in range(1, 13)]]   # R50.3 end
    p += [(59.2, 35)] + [(65.2 - 6 * math.cos(math.radians(a)), 35.2 - 6 * math.sin(math.radians(a))) for a in range(15, 166, 15)] + [(71.2, 35)]   # R6 cove, Ø56.4
    p += [(74, 35.5), (74, 36.0)] + [(76.5 - 2.5 * math.cos(math.radians(a)), 36 + 2.5 * math.sin(math.radians(a))) for a in range(15, 91, 15)]
    p += [(86.5 + 2.5 * math.sin(math.radians(a)), 36 + 2.5 * math.cos(math.radians(a))) for a in range(0, 91, 15)]   # Ø77 x 15 flange
    p += [(89, 32.5)] + [(89 + 11 * math.sin(math.radians(a)), 32.5 * math.cos(math.radians(a))) for a in range(15, 91, 15)]   # Ø65 end
    return p


hb = lathe('hb', hub_profile())
cut(hb, cyl('ax', 3.25, -1, 101, 16))                                      # Ø6.5 for the axle
for i in range(6):                                                         # Ø16 x 20 spoke sockets, 34 from the end
    cut(hb, xf(cyl('sh', 8, 15, 40, 24), R(60 * i, 'Z') @ T(0, 0, 34) @ TO_Y.inverted()))
part(WHEEL, 'Hub', hb, WHEEL_WOOD, axes((1, 0, 0), (0, 0, -1), (0, 1, 0), (0, HUB_Y0, AXLE_Z)))   # local Z along +Y


def toggle_r(z):
    zz = z if z <= 80 else 160 - z
    if zz < 20:
        return 8.0                                                         # Ø16 x 20 tenons
    s = 11.4 - (120 - math.sqrt(120 ** 2 - (zz - 46.5) ** 2))              # R120 swell, Ø22.8, Ø16.4 at the ends
    if abs(zz - 73.5) < 3:
        s = min(s, 8.85 - math.sqrt(9 - (zz - 73.5) ** 2))                 # R3 cove, Ø11.7
    if abs(zz - 80) < 5:
        s = max(s, 7 + math.sqrt(25 - (zz - 80) ** 2))                     # R5 bead, Ø24
    elif zz > 73.5:
        s = max(s, 5.85)
    return s


tg_prof = [(z, toggle_r(z)) for z in sorted({0, 19.999, 20, 140, 140.001, 160, *[20 + i * 0.5 for i in range(241)]})]
for i in range(6):
    a = math.radians(60 * i)
    d = Vector((math.sin(a), 0, -math.cos(a)))                             # spoke 0 straight down
    part(WHEEL, 'Toggle', lathe('tg', tg_prof, 32), WHEEL_WOOD, frame(Vector((0, RIM_Y, AXLE_Z)) + d * 15, d, (0, 1, 0)))


def sector(a0, a1, z0, z1):
    pts = [(0, 0)] + [(220 * math.sin(math.radians(a0 + (a1 - a0) * i / 10)), -220 * math.cos(math.radians(a0 + (a1 - a0) * i / 10))) for i in range(11)]
    return prism('sec', pts, z0, z1)


def wheel_plank():
    """70° of rim, R155-R195 x 35, centred on its spoke (local -Y), thickness along local Z."""
    n = 70
    outer = [(195 * math.sin(math.radians(-35 + 70 * i / n)), -195 * math.cos(math.radians(-35 + 70 * i / n))) for i in range(n + 1)]
    inner = [(155 * math.sin(math.radians(35 - 70 * i / n)), -155 * math.cos(math.radians(35 - 70 * i / n))) for i in range(n + 1)]
    pl = prism('pl', outer + inner, -17.5, 17.5)
    # 10° laps at each end, bridled: the + end keeps its middle 13 (tongue), the - end its 11 cheeks (fork)
    cut(pl, sector(25, 36, 6.5, 18), sector(25, 36, -18, -6.5), sector(-36, -25, -6.5, 6.5))
    for zc in (-12.2, 12.2):                                               # drive-band grooves, 4 wide x 1.4 deep
        cut(pl, lathe('gr', [(zc - 2, 193.6), (zc - 2, 200), (zc + 2, 200), (zc + 2, 193.6)], 140))
    cut(pl, xf(cyl('s', 8, 0, 21, 24), T(0, -154, 0) @ TO_Y.inverted()))   # Ø16 x 20 toggle socket
    for a in (30, -30):                                                    # Ø6 pins through the laps
        cut(pl, xf(cyl('p', 3, -20, 20, 16), T(175 * math.sin(math.radians(a)), -175 * math.cos(math.radians(a)), 0)))
    return pl


for i in range(6):
    part(WHEEL, 'Wheel Plank', wheel_plank(), WHEEL_WOOD,
         T(0, RIM_Y, AXLE_Z) @ Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1))) @ R(60 * i, 'Z'))
for i in range(6):
    a = math.radians(60 * i + 30)
    part(WHEEL, 'Pin D6 x 35mm', lathe('pin', [(0, 0), (0.5, 3), (34.5, 3), (35, 0)], 16), WHEEL_WOOD,
         frame((175 * math.sin(a), RIM_Y - 17.5, AXLE_Z - 175 * math.cos(a)), (0, 1, 0)))

# --- 1.05 Wheel Axle: 100 square in the hub, round 65 on the crank side, 50 on the other
wa = unite(cyl('r1', 3, 0, 65, 16), box('sq', -3, 3, -3, 3, 65, 165), cyl('r2', 3, 165, 215, 16))
part(WHEEL, 'Wheel Axle', wa, STEEL, frame((0, HUB_Y0 - 65, AXLE_Z), (0, 1, 0), (1, 0, 0)))

# --- 1.06 Excenter (crank, holes 35 apart) and 1.07 Rotation Pin. The crank is turned so the
# footman, hung from the pin, reaches down to the pedal's cord holes.
ex_out = arc(0, 0, 22.5, 180, 360, 36) + arc(17.5, 0, 5, 0, 180, 12)[1:] + arc(0, 0, 12.5, 360, 180, 24)[1:] + arc(-17.5, 0, 5, 0, 180, 12)[1:-1]
ex = prism('ex', ex_out, 0, 3)
cut(ex, xf(cyl('h1', 3, -1, 4, 16), T(-17.5, 0, 0)), xf(cyl('h2', 3, -1, 4, 16), T(17.5, 0, 0)))
EX_Y = -31.5
FOOT_Y = EX_Y - 9.5                    # footman's mid-thickness on the pin
PIN_TO_HOLE = 315.4 - 15               # pin at the top of the keyhole slot to the Ø5 hole at the bottom
foot_hole = (pedal_holes[0] + pedal_holes[1]) / 2 + Vector((0, 0, 2 + 15))


def pin_at(th):
    return Vector((35 * math.sin(th), FOOT_Y, AXLE_Z - 35 * math.cos(th)))


fit, TH = min((abs((pin_at(math.radians(i / 10)) - foot_hole).length - PIN_TO_HOLE), math.radians(i / 10))
              for i in range(0, 1801))    # pin on the +X side, where the plan view shows the footman
pin_c = Vector((35 * math.sin(TH), 0, AXLE_Z - 35 * math.cos(TH)))
crank = pin_c - Vector((0, 0, AXLE_Z))
part(WHEEL, 'Excenter', ex, STEEL, frame((0, EX_Y, AXLE_Z), (0, -1, 0), (crank.x, 0, crank.z)) @ T(17.5, 0, 0))
part(WHEEL, 'Rotation Pin', lathe('rp', [(0, 0), (0, 5), (3, 5), (3, 3), (22, 3), (22, 0)], 16), STEEL,
     frame((pin_c.x, EX_Y + 3, pin_c.z), (0, -1, 0)))

# --- 3.18 Footman: hung on the rotation pin by its keyhole; local Y along it from the bottom
fm = prism('fm', [(-7, 0), (7, 0), (7, 288), (13, 290), (13, 350), (-13, 350), (-13, 290), (-7, 288)], -5, 5)
cut(fm, xf(cyl('k1', 6, -6, 6, 24), T(0, 295, 0)), box('k2', -3, 3, 295, 315.4, -6, 6),   # keyhole
    xf(cyl('k3', 3, -6, 6, 16), T(0, 315.4, 0)), xf(cyl('h', 2.5, -6, 6, 16), T(0, 15, 0)))  # Ø5 for the cord
pin_pt = Vector((pin_c.x, FOOT_Y, pin_c.z))
fy = (pin_pt - foot_hole).normalized()
fx = fy.cross(Vector((0, 1, 0))).normalized()
M_fm = axes(fx, fy, fx.cross(fy), pin_pt - fy * 315.4)
part(FRAME, 'Footman', fm, WHEEL_WOOD, M_fm)

# --- 3.19 Cord: a wire staple through the footman's foot and the pedal's two holes
fh = M_fm @ Vector((0, 15, 0))
h1, h2 = pedal_holes
part(FRAME, 'Cord', tube('cord', [h1 + Vector((0, 0, -12)), h1 + Vector((0, 0, 1)), fh + (h1 - fh) * 0.15, fh,
                                  fh + (h2 - fh) * 0.15, h2 + Vector((0, 0, 1)), h2 + Vector((0, 0, -12))], 1.0, 8),
     'Cord', Matrix.Identity(4))

# ================================================================ FLYER

FLY_Y0 = MAID_Y - 236.5     # the flyer axle's tip (u = 0); u runs along the flyer toward the orifice


def along(u, xdir=(1, 0, 0)):
    return frame((0, FLY_Y0 + u, FLYER_Z), (0, 1, 0), xdir)


# --- 2.03 Flyer Axle: Ø4 x 9 tip, M5 left-hand x 39, Ø6, 19 tapered square into the flyer
fa = unite(lathe('fa', [(0, 0), (0, 1.6), (0.4, 2), (9, 2), (11, 2.5), (48, 2.5), (48, 3), (175, 3), (175, 0)], 16),
           keep(box('sq', -2, 2, -2, 2, 175, 194), lathe('tp', [(175, 0), (175, 3.2), (194, 2.2), (194, 0)], 16)))
part(FLYER, 'Flyer Axle', fa, STEEL, along(0))


def whorl_profile():
    p = [(0, 0), (0, 12)]
    p += [(12 - math.sqrt(35 ** 2 - r ** 2) + math.sqrt(35 ** 2 - 28.6 ** 2), r) for r in [12 + 16.6 * i / 10 for i in range(1, 11)]]   # R35 dome
    p += [(7 + 5 * math.sin(math.radians(a)), 33.6 - 5 * math.cos(math.radians(a))) for a in range(15, 91, 15)]    # R5 into the pulley
    p += [(12, 38), (12.5, 39.6), (14, 40), (15.5, 39.6), (16.5, 38.0)]                                          # Ø80 rim, R2
    p += [(22 - 3 * math.cos(math.radians(a)), 34 - 3 * math.sin(math.radians(a))) for a in range(0, 181, 30)]   # V groove, R3 bottom
    p += [(27.5, 38.0), (28.5, 39.6), (30, 40), (31.5, 39.6), (32, 38), (32, 0)]
    return p


# --- 2.05 Flyer Whorl: dome toward the main pillar, 12 x 12 x 10 nut pocket toward the bobbin
wh = lathe('wh', whorl_profile())
cut(wh, cyl('b', 3, -1, 33, 16), box('nut', -6, 6, -6, 6, 22, 33))
part(FLYER, 'Flyer Whorl', wh, WHEEL_WOOD, along(15))
nut = cut(box('nut', -6, 6, -6, 6, 0, 10), cyl('t', 2.5, -1, 11, 16))
part(FLYER, 'Rectangle Nut', nut, STEEL, along(37))

# --- 2.04 Bobbin: grooved flange next to the whorl, dome toward the flyer (traced dome-first)
bb = lathe('bb', [(129 - z, r) for z, r in traced('bobbin', 129)][::-1])
cut(bb, cyl('b', 3.5, -1, 130, 16))
part(FLYER, 'Bobbin', bb, WHEEL_WOOD, along(48))

# --- 2.02 Flyer: elliptical arms (outer 125 x 69, inner 102 x 59), 22 thick at the knob, 15 at the tips.
# Local X along the axis from the tips (x=0) to the orifice, Y across the arms, Z through the thickness.


def ell(a, b, t0, t1, n=60):
    return [(a * math.cos(math.radians(t)), b * math.sin(math.radians(t))) for t in [t0 + (t1 - t0) * i / n for i in range(n + 1)]]


fl = prism('fl', ell(125, 69, 90, -90) + ell(102, 59, -90, 90), -11, 11)
keep(fl, prism('taper', [(-1, -7.5), (130, -11.01), (130, 11.01), (-1, 7.5)], -80, 80, 'XZ'))
unite(fl, lathe('knob', [(118, 0), (118, 11), (125, 7), (126.5, 6.5), (128.5, 10), (131.5, 13.5), (134, 12),
                         (135.5, 8), (136.5, 6), (142, 6), (142, 0)], 32, 'X'))     # turned orifice knob, Ø12 x 11 end
cut(fl, cyl('ax', 2.5, 101, 119, 16, 'X'),         # Ø5 x 17 for the axle's square end
    cyl('or', 3.5, 131, 143, 16, 'X'),             # Ø7 orifice
    box('tang', 123, 143, -1.0, 1.0, -2.2, 2.2))   # slot for the bearing's tang
HOLES = [(0, 0), (12, -1), (24, -2), (36, -5), (48, -8), (60, -12), (72, -18), (84, -26),            # hole table, holes 1-8
         (-3, -129), (5, -129), (13, -128), (21, -127), (29, -126), (37, -124), (45, -122), (53, -119),
         (61, -116), (69, -112), (77, -108), (85, -102)]                                             # holes 9-20
holes_xy = [(7 + x, 64 + y) for x, y in HOLES]       # hole 1 is 7 in from the tip, on the top arm's centre line
for x, y in holes_xy:
    cut(fl, xf(cyl('h', 0.5, -12, 12, 8), T(x, y, 0)))
M_fl = axes((0, 1, 0), (0, 0, 1), (1, 0, 0), (0, FLY_Y0 + 75, FLYER_Z))
part(FLYER, 'Flyer', fl, WHEEL_WOOD, M_fl)

# --- 2.08 Hook 2 (x8, top arm) and 2.07 Hook 1 (x12, bottom arm): Ø1.5 wire in the hole table's holes
for i, (x, y) in enumerate(holes_xy):
    t = (15 + 7 * max(0.0, x) / 125) / 2
    if i < 8:     # 9 leg, R1.5 bend, open R6 ring
        path = [(0, 0, -8.5 + k) for k in range(10)] + [(0, 6.75 - 6.75 * math.cos(math.radians(a)), 1.5 + 6 * math.sin(math.radians(a))) for a in range(15, 301, 15)]
        name, M = 'Hook 2', M_fl @ T(x, y, t) @ R(180, 'Z')
    else:         # 11.5 leg, out 6, R3 U, 9 back down
        path = [(0, 0, -11 + k) for k in range(12)] + [(0, 1.5, 1.5), (0, 3, 3), (0, 4.5, 4.5)]
        path += [(0, 7.5 - 3 * math.cos(math.radians(a)), 6 + 3 * math.sin(math.radians(a))) for a in range(0, 181, 20)]
        path += [(0, 10.5, 6 - k) for k in range(1, 10)]
        name, M = 'Hook 1', M_fl @ T(x, y, -t) @ R(180, 'X')
    part(FLYER, name, tube('hk', path, 0.75, 8), STEEL, M)

# --- 2.01 Flyer Bearing: Ø12 tube (Ø8 bore) x 17, Ø16 x 3 flange, 19 tang into the orifice, 8 clear of it
fb = unite(lathe('fb', [(0, 0), (0, 8), (3, 8), (3, 6), (20, 6), (20, 0)], 24),
           prism('tang', [(-1, -19), (1, -19), (6, 0.5), (-6, 0.5)], -2, 2, 'XZ'))
cut(fb, cyl('b', 4, 3, 21, 16))
part(FLYER, 'Flyer Bearing', fb, STEEL, along(225, (0, 0, 1)))

# --- 3.23 Drive Band: doubled, one loop wheel -> whorl, one wheel -> bobbin


def band(y_wheel, y_pulley, r_pulley, n=90):
    r1 = 195 - 1.4
    beta = math.asin((r1 - r_pulley) / (FLYER_Z - AXLE_Z))
    loop = []
    for i in range(n + 1):           # round the bottom of the wheel
        a = math.pi - beta + (math.pi + 2 * beta) * i / n
        loop.append((r1 * math.cos(a), y_wheel, AXLE_Z + r1 * math.sin(a)))
    for i in range(n // 3 + 1):      # over the top of the pulley
        a = beta + (math.pi - 2 * beta) * i / (n // 3)
        loop.append((r_pulley * math.cos(a), y_pulley, FLYER_Z + r_pulley * math.sin(a)))
    return loop


db = unite(tube('b1', band(RIM_Y - 12.2, FLY_Y0 + 37, 31.2), 0.9, 8, closed=True),
           tube('b2', band(RIM_Y + 12.2, FLY_Y0 + 58, 35.2), 0.9, 8, closed=True))
part(FRAME, 'Drive Band', db, 'Cord', Matrix.Identity(4))

# ================================================================ stand it on its feet, export

low = min((ob.matrix_world @ v.co).z for _, n, ob, _ in PARTS if n == 'Leg' for v in ob.data.vertices)
for _, n, ob, _ in PARTS:
    if n != 'Wool Bar':    # placed on the floor by itself
        ob.matrix_world = T(0, 0, -low) @ ob.matrix_world

COLORS = {'Walnut': (0.42, 0.28, 0.17), 'Cherry': (0.62, 0.26, 0.17), 'Steel': (0.62, 0.64, 0.67),
          'Leather': (0.55, 0.38, 0.22), 'Cord': (0.85, 0.80, 0.68)}


def write_dae(path):
    from xml.sax.saxutils import escape
    geo, groups = [], {}
    for gi, (group, name, ob, mat) in enumerate(PARTS):
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        pos = ' '.join(f'{c:.4f}' for v in bm.verts for c in v.co)
        tris = ' '.join(str(v.index) for f in bm.faces for v in f.verts)
        nv, nt = len(bm.verts), len(bm.faces)
        bm.free()
        g = f'geom{gi}'
        geo.append(f'<geometry id="{g}" name="{g}"><mesh>'
                   f'<source id="{g}-pos"><float_array id="{g}-pos-a" count="{3 * nv}">{pos}</float_array>'
                   f'<technique_common><accessor source="#{g}-pos-a" count="{nv}" stride="3">'
                   f'<param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>'
                   f'</accessor></technique_common></source>'
                   f'<vertices id="{g}-v"><input semantic="POSITION" source="#{g}-pos"/></vertices>'
                   f'<triangles material="m" count="{nt}"><input semantic="VERTEX" source="#{g}-v" offset="0"/><p>{tris}</p></triangles>'
                   f'</mesh></geometry>')
        mtx = ' '.join(f'{ob.matrix_world[r][c]:.6f}' for r in range(4) for c in range(4))
        groups.setdefault(group, []).append(
            f'<node id="n{gi}" name="{escape(name)}"><matrix>{mtx}</matrix><instance_geometry url="#{g}">'
            f'<bind_material><technique_common><instance_material symbol="m" target="#mat-{mat}"/>'
            f'</technique_common></bind_material></instance_geometry></node>')
    mats = sorted({m for *_, m in PARTS})
    effects = ''.join(f'<effect id="fx-{m}"><profile_COMMON><technique sid="c"><lambert><diffuse><color>'
                      f'{" ".join(f"{c:.3f}" for c in COLORS[m])} 1</color></diffuse></lambert></technique></profile_COMMON></effect>' for m in mats)
    materials = ''.join(f'<material id="mat-{m}" name="{m}"><instance_effect url="#fx-{m}"/></material>' for m in mats)
    scene = ''.join(f'<node id="g{i}" name="{g}">{"".join(ns)}</node>' for i, (g, ns) in enumerate(groups.items()))
    with open(path, 'w') as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">'
                '<asset><contributor><authoring_tool>build_spinning_wheel.py (Blender)</authoring_tool></contributor>'
                '<unit name="millimeter" meter="0.001"/><up_axis>Z_UP</up_axis></asset>'
                f'<library_effects>{effects}</library_effects><library_materials>{materials}</library_materials>'
                f'<library_geometries>{"".join(geo)}</library_geometries>'
                f'<library_visual_scenes><visual_scene id="scene" name="Spinning Wheel">{scene}</visual_scene></library_visual_scenes>'
                '<scene><instance_visual_scene url="#scene"/></scene></COLLADA>')


if os.environ.get('SW_DUMP'):
    dump = {}
    for _, n, ob, _ in PARTS:
        dump.setdefault(n, []).append([tuple(round(c, 1) for c in ob.matrix_world @ v.co) for v in ob.data.vertices])
    json.dump(dump, open(os.environ['SW_DUMP'], 'w'))

write_dae(OUT)
print(f'WROTE {OUT}: {len(PARTS)} parts')
print(f'check: secondary pillar shoulder z={PT - 33 + sp_shoulder:.1f}, holder underside there z={HOLDER_Z - holder_r_at_sec:.1f}')
print(f'check: crank {math.degrees(TH):.1f} deg, footman fit {fit:.2f} mm; treadle axle {GAP:.1f} mm from each leg axis')
print(f'check: feet reached z={low:.2f} before standing it on them')

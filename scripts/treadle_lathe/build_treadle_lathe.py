"""Build Steve Schmeck's treadle lathe ("Make Your Own Treadle Lathe") as a COLLADA model.

    blender -b --python scripts/treadle_lathe/build_treadle_lathe.py -- out.dae
    python3 parse_dae.py out.dae -o viewer/models/treadle-lathe/

Every part is made to the book's materials list (inches; nominal lumber at
its actual size: 3x3 = 2-3/4 square, 2x4 = 1-1/2 x 3-1/2, 1x = 3/4 thick) and
placed as its text and measured drawing give it: ways' top 30" above the
bottom of the base, spindle 8" above that, flywheel axle 12-1/2" above the
base, 24" flywheel. Where the book leaves a size open (the gap between the
headstock uprights, where the tailstock and tool rest sit) it is chosen to
fit, and said so in model.json's notes.

World axes: Z up, floor at z=0. +X runs along the bed from the headstock
(flywheel) end to the tail; the turner stands on the -Y side.
"""
import bpy
import math
import os
import sys
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from blender_parts import *  # noqa: E402,F403  (geometry helpers, part(), write_dae())

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else os.path.join(HERE, 'treadle_lathe.dae')

clear_scene()

FRAME, HEAD, WHEEL, TAIL, REST = 'Frame', 'Headstock', 'Flywheel & Treadle', 'Tailstock', 'Tool Rest'
MAPLE, CHERRY, STEEL, LEATHER = 'Maple', 'Cherry', 'Steel', 'Leather'

# ---------------------------------------------------------------- key positions (inches)

S3 = 2.75                  # a 3x3's actual size
BASE_TOP = 1.5             # base and stabilizer: 2x4s flat on the floor, half-lapped where they cross
WAY_TOP, WAY_BOT = 30.0, 26.5
SPINDLE_Z = WAY_TOP + 8    # 38: "measure up another 8" to establish the spindle's center"
FLY_Z = BASE_TOP + 12.5    # 14: "12-1/2" up from the base", halfway to the ways' bottom
LU = (0.75, 3.5)           # left headstock upright (x), behind the end brace
CU = (7.25, 10.0)          # centre headstock upright: a 3-3/4 gap for the flywheel and pulley
MID = (LU[1] + CU[0]) / 2  # the belt's plane, midway in the gap
TU = (37.75, 40.5)         # tail upright, at the base's end
WAY_Y = (S3 / 2, S3 / 2 + 1.5)    # the ways sandwich the uprights
BR_R, BR_W = 0.5625, 0.3125       # 1/2" ID sealed ball bearing (R8): 1-1/8 OD x 5/16
PIVOT = Vector((0, 0, 33.6))      # tensioner's pivot dowel, in the gap (y, z used)

# ================================================================ FRAME

base = box('base', 0, 40.5, -1.75, 1.75, 0, BASE_TOP)
cut(base, box('lap', -0.1, 3.5, -2, 2, -0.1, 0.75))
part(FRAME, 'Base', base, MAPLE, T())

stab = box('stab', 0, 3.5, -12, 12, 0, BASE_TOP)
cut(stab, box('lap', -0.1, 3.6, -1.75, 1.75, 0.75, 1.6))
part(FRAME, 'Stabilizer', stab, MAPLE, T())

# 1x10 x 12, standing on the stabilizer against the left upright's outer face, tapering to its width
part(FRAME, 'Headstock End Brace', prism('eb', [(-4.625, BASE_TOP), (4.625, BASE_TOP), (S3 / 2, BASE_TOP + 12), (-S3 / 2, BASE_TOP + 12)],
                                         0, 0.75, 'YZ'), MAPLE, T())


def pocket(face_x, into, z, through=False):
    """Bearing pocket bored into an upright's face (into = +1/-1 along X), with the 3/4 clearance hole through."""
    x0, x1 = sorted((face_x - into * 0.1, face_x + into * BR_W))
    tools = [xf(cyl('bp', BR_R, x0, x1, 40, 'X'), T(0, 0, z))]
    if through:
        tools.append(xf(cyl('cl', 0.375, CU[0] - 0.1, CU[1] + 0.1, 24, 'X'), T(0, 0, z)))
    return tools


lu = box('lu', LU[0], LU[1], -S3 / 2, S3 / 2, BASE_TOP, BASE_TOP + 38.5)
cut(lu, *pocket(LU[1], -1, SPINDLE_Z), *pocket(LU[1], -1, FLY_Z),
    xf(cyl('pv', 0.125, LU[1] - 0.5, LU[1] + 0.1, 16, 'X'), T(0, PIVOT.y, PIVOT.z)))
part(FRAME, 'Headstock Upright', lu, MAPLE, T())

cu = box('cu', CU[0], CU[1], -S3 / 2, S3 / 2, BASE_TOP, BASE_TOP + 38.5)
cut(cu, *pocket(CU[0], 1, FLY_Z, True), *pocket(CU[1], -1, SPINDLE_Z, True),
    xf(cyl('pv', 0.125, CU[0] - 0.1, CU[1] + 0.1, 16, 'X'), T(0, PIVOT.y, PIVOT.z)))
part(FRAME, 'Headstock Upright', cu, MAPLE, T())

part(FRAME, 'Tail Upright', box('tu', TU[0], TU[1], -S3 / 2, S3 / 2, BASE_TOP, BASE_TOP + 27.5), MAPLE, T())

for s in (-1, 1):
    part(FRAME, 'Way', box('way', 0, 42, *sorted((s * WAY_Y[0], s * WAY_Y[1])), WAY_BOT, WAY_TOP), MAPLE, T())

# ================================================================ HEADSTOCK

part(HEAD, 'Spindle Shaft', cyl('sp', 0.25, 0, 8, 24, 'X'), STEEL, T(LU[1] - BR_W, 0, SPINDLE_Z))


def bearing():
    return cut(cyl('br', BR_R, 0, BR_W, 32), cyl('bore', 0.25, -0.1, BR_W + 0.1, 24))


SCREW = [(0, 0), (0, 0.12), (0.04, 0.155), (0.11, 0.155), (0.11, 0.08), (0.75, 0.08), (0.86, 0)]   # #8 x 3/4 pan head
for face_x, into, z in [(LU[1], -1, SPINDLE_Z), (LU[1], -1, FLY_Z), (CU[0], 1, FLY_Z), (CU[1], -1, SPINDLE_Z)]:
    part(HEAD, 'Ball Bearing', bearing(), STEEL, frame((face_x, 0, z), (into, 0, 0)))
    upright = lu if face_x == LU[1] else cu
    for dz in (-1, 1):    # "retained by a couple of pan-head screws, 180 deg apart just outside the hole"
        M = frame((face_x - into * 0.11, 0, z + dz * (BR_R + 0.12)), (into, 0, 0))
        part(HEAD, 'Pan-Head Screw', lathe('ps', SCREW, 16), STEEL, M)
        drill(upright, M, 0.06, 0.0, 0.9, 8)

part(HEAD, 'Retaining Washer', cut(cyl('rw', 0.45, 0, 0.0625, 32), cyl('b', 0.265, -0.1, 0.2, 24)), STEEL,
     frame((CU[1], 0, SPINDLE_Z), (1, 0, 0)))

# 3" adjustable V-belt pulley in the gap, hub toward the centre upright
pul = lathe('pul', [(-0.375, 0), (-0.375, 1.5), (-0.3, 1.5), (0, 1.05), (0.3, 1.5), (0.375, 1.5), (0.375, 0.55), (0.875, 0.55), (0.875, 0)], 48)
cut(pul, cyl('b', 0.25, -0.5, 1, 24))
part(HEAD, 'Spindle Pulley', pul, STEEL, frame((MID, 0, SPINDLE_Z), (1, 0, 0)))

# spur drive center on the spindle's end (in the book's photos, not its parts list)
DC0 = CU[1] + 0.0625
dc = unite(lathe('dc', [(0, 0), (0, 0.4375), (1.0, 0.4375), (1.25, 0.3), (1.25, 0)], 32),
           box('s1', -0.32, 0.32, -0.04, 0.04, 1.2, 1.45), box('s2', -0.04, 0.04, -0.32, 0.32, 1.2, 1.45),
           lathe('pt', [(1.2, 0), (1.2, 0.1), (1.7, 0)], 16))
cut(dc, cyl('b', 0.25, -0.1, LU[1] - BR_W + 8 - DC0, 24))
part(HEAD, 'Drive Center', dc, STEEL, frame((DC0, 0, SPINDLE_Z), (1, 0, 0)))

# ---------------------------------------------------------------- the belt's path, in the gap's plane (y, z)

R_PUL, R_WHEEL, R_IDLER = 1.275, 11.958, 1.31   # belt centre on the pulley's V, in the wheel's V groove, in the idler's groove


def tangent(A, ra, B, rb):
    """Outer tangent from circle A to circle B for a loop run counter-clockwise (y right, z up)."""
    d = (B - A).normalized()
    s = (ra - rb) / (B - A).length
    n = s * d + math.sqrt(1 - s * s) * Vector((d.y, -d.x))
    return A + ra * n, B + rb * n


P_C, W_C = Vector((0, SPINDLE_Z)), Vector((0, FLY_Z))
# the idler pushes the front run out 0.6" a little above the ways
a, b = tangent(P_C, R_PUL, W_C, R_WHEEL)
q = a + (b - a) * ((a.y - 32.3) / (a.y - b.y))
n_out = (a - P_C).normalized()
I_C = q - (R_IDLER - 0.6) * n_out
loop = [(P_C, R_PUL), (I_C, R_IDLER), (W_C, R_WHEEL)]
runs = [tangent(*loop[i], *loop[(i + 1) % 3]) for i in range(3)]
belt = []
for i, (c, r) in enumerate(loop):
    t_in, t_out = runs[i - 1][1], runs[i][0]
    a0 = math.atan2(t_in.y - c.y, t_in.x - c.x)
    a1 = math.atan2(t_out.y - c.y, t_out.x - c.x)
    sweep = (a1 - a0) % (2 * math.pi)
    assert sweep < math.pi * 1.9, 'belt does not wrap circle %d' % i
    k = max(2, int(sweep / math.radians(4)))
    belt += [(MID, c.x + r * math.cos(a0 + sweep * j / k), c.y + r * math.sin(a0 + sweep * j / k)) for j in range(k + 1)]
idler_wrap = math.degrees((math.atan2(*reversed(runs[1][0] - I_C)) - math.atan2(*reversed(runs[0][1] - I_C))) % (2 * math.pi))
part(HEAD, 'Leather Belt', tube('belt', belt, 0.125, 10, closed=True), LEATHER, T())

# ---------------------------------------------------------------- tensioner: U frame on a 1/4" dowel, idler in the U

arm = I_C - PIVOT.yz
L_ARM = arm.length
ux = Vector((0, arm.x, arm.y)).normalized()
M_tf = axes(ux, Vector((0, -ux.z, ux.y)), (1, 0, 0), (MID, PIVOT.y, PIVOT.z))   # local x along the arm, z along the bed
tf = box('tf', -1.25, L_ARM + 1.25, -0.6, 0.6, -1.125, 1.125)     # 5 diameters of wood past each hole
cut(tf, box('u', L_ARM - 1.6, L_ARM + 1.35, -0.7, 0.7, -0.4375, 0.4375),
    cyl('pv', 0.125, -1.2, 1.2, 16), xf(cyl('ax', 0.094, -1.2, 1.2, 12), T(L_ARM, 0, 0)))
part(HEAD, 'Tensioner Frame', tf, MAPLE, M_tf)

g = math.sqrt(0.135 ** 2 - (1.4375 - R_IDLER) ** 2)
groove = [(0.135 * math.sin(math.radians(t)), R_IDLER - 0.135 * math.cos(math.radians(t)))
          for t in range(-int(math.degrees(math.asin(g / 0.135))), int(math.degrees(math.asin(g / 0.135))) + 1, 10)]
idl = lathe('idl', [(-0.375, 0), (-0.375, 1.4375)] + groove + [(0.375, 1.4375), (0.375, 0)], 48)
cut(idl, cyl('b', 0.094, -1, 1, 12))
part(HEAD, 'Idler Pulley', idl, MAPLE, frame((MID, I_C.x, I_C.y), (1, 0, 0)))
part(HEAD, 'Idler Axle', cyl('ia', 0.094, -1.125, 1.125, 12), STEEL, M_tf @ T(L_ARM, 0, 0))

# pivot dowel: blind in the left upright, out through the centre one to a 1/2" dowel handle
part(HEAD, 'Pivot Dowel', cyl('pd', 0.125, LU[1] - 0.5, CU[1] + 0.75, 16, 'X'), MAPLE, T(0, PIVOT.y, PIVOT.z))
part(HEAD, 'Pivot Handle', cut(cyl('ph', 0.25, 0, 1, 20, 'X'), cyl('h', 0.125, -0.1, 0.5, 16, 'X')), MAPLE,
     T(CU[1] + 0.25, PIVOT.y, PIVOT.z))

# ================================================================ FLYWHEEL & TREADLE

# local frame: axle along z (world +X), boards long along x (world up)
M_w = frame((MID, 0, FLY_Z), (1, 0, 0), (0, 0, 1))
WHEEL_PROFILE = [(-1.3, 0), (-1.3, 12), (-0.1875, 12), (0, 11.75), (0.1875, 12), (1.3, 12), (1.3, 0)]   # V groove round the edge
for y0, y1, length in [(-14.5, -7.25, 22), (-7.25, 0, 26), (0, 7.25, 26), (7.25, 14.5, 22)]:
    bd = box('bd', -length / 2, length / 2, y0, y1, -0.375, 0.375)
    keep(bd, xf(lathe('wp', WHEEL_PROFILE, 120), R(1.5, 'Z')))
    cut(bd, xf(cyl('hole', 0.25, -1, 1, 24), R(7.5, 'Z')))    # turned so no facet lies on the boards' joint
    part(WHEEL, 'Wheel Board, Long' if length == 26 else 'Wheel Board, Short', bd, MAPLE, M_w)

for side, start in ((1, 45), (-1, 0)):     # joints at 45 deg to the boards' joints; the two sides staggered
    for k in range(4):
        rs = prism('rs', arc(0, 0, 12, 0, 90, 40) + arc(0, 0, 10, 90, 0, 34), 0.375, 1.125)
        for a in (0, 90):                  # the small arcs where the inner arc meets each end line
            cut(rs, xf(cyl('sc', 0.75, -0.1, 1.3, 24), T(10 * math.cos(math.radians(a)), 10 * math.sin(math.radians(a)), 0)))
        part(WHEEL, 'Rim Section', rs, CHERRY, M_w @ (R(180, 'Y') if side < 0 else T()) @ R(start + 90 * k, 'Z'))

for side in (-1, 1):     # 3/8 floor flanges bored out to the 1/2 shaft, plate against the centre boards
    fl = lathe('fl', [(0, 0), (0, 1.4375), (0.1875, 1.4375), (0.25, 0.6), (0.65, 0.55), (0.65, 0)], 48)
    cut(fl, xf(cyl('b', 0.25, -0.1, 0.8, 24), R(3.75, 'Z')), *[xf(cyl('h', 0.09, -0.1, 0.3, 12), T(1.1 * math.cos(a), 1.1 * math.sin(a), 0))
                                            for a in (0.82, 2.39, 3.96, 5.53)])
    part(WHEEL, 'Floor Flange', fl, STEEL, frame((MID + side * 0.375, 0, FLY_Z), (side, 0, 0)))


def fillet(path, r, n=8):
    """A polyline with each corner rounded to radius r (a bent rod)."""
    P = [Vector(p) for p in path]
    out = [P[0]]
    for A, B, C in zip(P, P[1:], P[2:]):
        u1, u2 = (A - B).normalized(), (C - B).normalized()
        th = u1.angle(u2)
        t = r / math.tan(th / 2)
        ctr = B + (u1 + u2).normalized() * (r / math.sin(th / 2))
        v1, v2 = B + u1 * t - ctr, B + u2 * t - ctr
        sweep = math.pi - th
        out += [ctr + (v1 * math.sin((1 - i / n) * sweep) + v2 * math.sin(i / n * sweep)) / math.sin(sweep) for i in range(n + 1)]
    return out + [P[-1]]


# crank: 1/2" rod from the left bearing, out through the centre upright, 1-1/4" throw toward the turner
CRANK_X, THROW, PIN_END = CU[1] + 0.75, 1.25, CU[1] + 2.0
crank = tube('cr', fillet([(LU[1] - BR_W, 0, FLY_Z), (CRANK_X, 0, FLY_Z), (CRANK_X, -THROW, FLY_Z), (PIN_END, -THROW, FLY_Z)], 0.375), 0.25, 16)
pin_x = lambda x: (x, -THROW, FLY_Z)    # noqa: E731
COTTERS = (CRANK_X + 0.43, CRANK_X + 0.85)
for x in COTTERS:
    drill(crank, frame(pin_x(x), (0, 0, 1)), 0.05, -0.3, 0.3, 8)
part(WHEEL, 'Crank Shaft', crank, STEEL, T())

# the crank "bearing" on the pin: cotter pin, flat washer, heavy washer (connector brazed to its edge), flat washer, cotter pin
HW = (CRANK_X + 0.5625, 0.125, 0.6875)  # heavy washer: x, thickness, radius
for x in COTTERS:
    part(WHEEL, 'Cotter Pin', unite(cyl('cp', 0.045, -0.4, 0.45, 8), xf(cyl('eye', 0.06, -0.05, 0.05, 8, 'Y'), T(0, 0, 0.5))),
         STEEL, frame(pin_x(x), (0, 0, 1)))
for x in (HW[0] - 0.0625, HW[0] + HW[1]):
    part(WHEEL, 'Flat Washer 1/2"', cut(cyl('fw', 0.53, 0, 0.0625, 32), cyl('b', 0.27, -0.1, 0.2, 24)), STEEL, frame(pin_x(x), (1, 0, 0)))
part(WHEEL, 'Heavy Washer 1/2"', cut(cyl('hw', HW[2], 0, HW[1], 32), cyl('b', 0.27, -0.1, 0.2, 24)), STEEL, frame(pin_x(HW[0]), (1, 0, 0)))

# treadle connector: 1/4" rod hanging from the heavy washer's edge through the treadle, nut and washer under it
ROD = Vector((HW[0] + HW[1] / 2, -THROW, FLY_Z - HW[2]))
ROD_BOT = ROD.z - 11
part(WHEEL, 'Treadle Connector', cyl('tc', 0.125, -11, 0, 12), STEEL, T(*ROD))
NUT_TOP = ROD_BOT + 0.05 + 0.22
part(WHEEL, 'Hex Nut 1/4"', cut(cyl('nut', 0.25, 0, 0.22, 6), cyl('b', 0.125, -0.1, 0.3, 12)), STEEL, T(ROD.x, ROD.y, ROD_BOT + 0.05))
part(WHEEL, 'Flat Washer 1/4"', cut(cyl('w', 0.3125, 0, 0.0625, 24), cyl('b', 0.14, -0.1, 0.2, 12)), STEEL, T(ROD.x, ROD.y, NUT_TOP))

# treadle: 1x2 x 28, rod through a loose hole 1" from its raised end, far end on the floor, angled out toward the turner
TR_Z = NUT_TOP + 0.0625 + 0.04
h = Vector((math.cos(math.radians(-30)), math.sin(math.radians(-30)), 0))
dip = math.asin(TR_Z / 27)
tx = (h * math.cos(dip) - Vector((0, 0, math.sin(dip)))).normalized()
ty = Vector((0, 0, 1)).cross(tx).normalized()
tr = box('tr', -1, 27, -0.75, 0.75, 0, 0.75)
cut(tr, cyl('h', 0.22, -0.1, 0.85, 16))    # 7/16: loose, so the treadle can swing about
part(WHEEL, 'Treadle', tr, MAPLE, axes(tx, ty, tx.cross(ty), (ROD.x, ROD.y, TR_Z)))

# ================================================================ TAILSTOCK

TS = 26.5                       # tailstock block's headstock-side face
XC = TS + 0.375 + 1.75          # the tailstock upright's centre line along the bed
part(TAIL, 'Tailstock Block', cut(box('blk', TS, TS + S3, -3, 3, WAY_TOP, WAY_TOP + S3),
                                  box('rab', TS + 0.375, TS + S3 + 0.1, -0.75, 0.75, WAY_TOP - 0.1, WAY_TOP + S3 + 0.1)), MAPLE, T())


def wedge_h(y):
    """The wedge: 2-1/4 at its wide (front) end at y=-3.25, tapering to 1-1/2 over 7"."""
    return 2.25 - 0.75 * (y + 3.25) / 7


ts = prism('ts', [(XC - 1.75, SPINDLE_Z - 16.25), (XC + 1.75, SPINDLE_Z - 16.25)] + arc(XC, SPINDLE_Z, 1.75, 0, 180, 24), -0.75, 0.75, 'XZ')
cut(ts, xf(cyl('cup', 0.5, -0.1, 2.0, 32, 'X'), T(XC - 1.75, 0, SPINDLE_Z)),
    prism('mortise', [(-0.85, WAY_BOT - wedge_h(-0.85)), (0.85, WAY_BOT - wedge_h(0.85)), (0.85, WAY_BOT + 0.25), (-0.85, WAY_BOT + 0.25)],
          XC - 0.25, XC + 0.25, 'YZ'))
part(TAIL, 'Tailstock', ts, MAPLE, T())

for s in (-1, 1):
    part(TAIL, 'Tailstock Brace', box('tb', XC - 1.25, XC + 1.25, *sorted((s * 0.75, s * 1.5)), WAY_TOP + S3, WAY_TOP + S3 + 6), MAPLE, T())

wd = prism('wd', [(-3.25, WAY_BOT - wedge_h(-3.25)), (3.75, WAY_BOT - wedge_h(3.75)), (3.75, WAY_BOT), (-3.25, WAY_BOT)], XC - 0.25, XC + 0.25, 'YZ')
STOP = Vector((XC, 2.75, WAY_BOT - wedge_h(2.75) / 2))      # an inch from the narrow end
cut(wd, xf(cyl('h', 0.125, -1, 1, 16, 'X'), T(*STOP)))
part(TAIL, 'Tailstock Wedge', wd, MAPLE, T())
part(TAIL, 'Wedge Stop Dowel', cyl('wsd', 0.125, -0.625, 0.625, 16, 'X'), MAPLE, T(*STOP))

# fixed cup center in a 1" hole, cup toward the headstock
part(TAIL, 'Cup Center', lathe('cc', [(-2.0, 0), (-2.0, 0.5), (0.15, 0.5), (0.55, 0.32), (0.8, 0.32), (0.8, 0.22), (0.68, 0.12), (0.82, 0)], 32),
     STEEL, frame((XC - 1.75, 0, SPINDLE_Z), (-1, 0, 0)))

# ================================================================ TOOL REST

TR = 19.0                       # along the bed, about halfway between the centers
POST = Vector((TR, -3.0, 0))    # the post's lag-bolt pivot; the top's working edge 2-1/4 from the spindle's axis
BASE_Y0 = -4.5                  # the 12" base's front end: its slot (3" to 9" from that end) is round the bolt at y=0

rb = box('rb', TR - 1.75, TR + 1.75, BASE_Y0, BASE_Y0 + 12, WAY_TOP, WAY_TOP + 0.75)
cut(rb, box('slot', TR - 0.1875, TR + 0.1875, BASE_Y0 + 3, BASE_Y0 + 9, WAY_TOP - 0.1, WAY_TOP + 1),
    *[xf(cyl('end', 0.1875, WAY_TOP - 0.1, WAY_TOP + 1, 16), T(TR, BASE_Y0 + e, 0)) for e in (3, 9)],
    xf(cyl('cb', 0.375, WAY_TOP - 0.1, WAY_TOP + 0.25, 24), T(POST.x, POST.y, 0)),
    xf(cyl('lh', 0.17, WAY_TOP - 0.1, WAY_TOP + 1, 16), T(POST.x, POST.y, 0)))
part(REST, 'Tool Rest Base', rb, MAPLE, T())

POST_TOP = WAY_TOP + 0.75 + 5
pst = box('pst', TR - S3 / 2, TR + S3 / 2, POST.y - S3 / 2, POST.y + S3 / 2, WAY_TOP + 0.75, POST_TOP)
cut(pst, xf(cyl('pilot', 0.1, WAY_TOP + 0.7, WAY_TOP + 3.35, 12), T(POST.x, POST.y, 0)))
part(REST, 'Tool Rest Post', pst, MAPLE, T())

part(REST, 'Tool Rest Top', prism('trt', [(TR - S3 / 2, POST_TOP), (TR + S3 / 2, POST_TOP), (TR + 4, POST_TOP + 3.5), (TR - 4, POST_TOP + 3.5)],
                                  POST.y - 0.75, POST.y + 0.75, 'XZ'), MAPLE, T())

BOLT = 0.21     # 7/16 clearance for the 3/8 bolt
part(REST, 'Tool Rest Spacer', cut(box('sp', TR - 1.5, TR + 1.5, -S3 / 2, S3 / 2, WAY_TOP - S3, WAY_TOP), xf(cyl('h', BOLT, 0, 40, 16), T(TR, 0, 0))), MAPLE, T())
part(REST, 'Clamp Piece', cut(box('cp', TR - 1.75, TR + 1.75, -3, 3, WAY_BOT - 0.75, WAY_BOT), xf(cyl('h', BOLT, 0, 40, 16), T(TR, 0, 0))), MAPLE, T())

WN = (WAY_BOT - 0.75 - 0.0625 - 1, WAY_BOT - 0.75 - 0.0625)   # the wooden wing nut, under a flat washer
wn = box('wn', TR - 0.5, TR + 0.5, -2, 2, *WN)
keep(wn, prism('ends', [(-2.1, WN[0] + 0.55), (-0.95, WN[0] - 0.1), (0.95, WN[0] - 0.1), (2.1, WN[0] + 0.55), (2.1, WN[1] + 0.1), (-2.1, WN[1] + 0.1)], TR - 1, TR + 1, 'YZ'))
cut(wn, xf(cyl('h', BOLT, 0, 40, 16), T(TR, 0, 0)), box('nut', TR - 0.3125, TR + 0.3125, -0.3125, 0.3125, WN[0] - 0.1, WN[0] + 0.33))
part(REST, 'Wing Nut', wn, MAPLE, T())

part(REST, 'Square Nut 3/8"', cut(box('sn', -0.3125, 0.3125, -0.3125, 0.3125, 0, 0.32), cyl('b', 0.1875, -0.1, 0.5, 16)), STEEL, T(TR, 0, WN[0] + 0.005))
part(REST, 'Flat Washer 3/8"', cut(cyl('w', 0.4375, 0, 0.0625, 32), cyl('b', 0.2, -0.1, 0.2, 16)), STEEL, T(TR, 0, WN[1]))

# 3/8 x 6 carriage bolt: dome head on the base, square neck in its slot, down to the wing nut
cbolt = unite(lathe('cbh', [(0, 0), (0, 0.15), (0.06, 0.32), (0.13, 0.42), (0.2, 0.44), (0.2, 0)], 32),
              box('neck', -0.1875, 0.1875, -0.1875, 0.1875, 0.19, 0.575), lathe('shank', [(0.5, 0), (0.5, 0.1875), (6.2, 0.1875), (6.2, 0)], 16))
part(REST, 'Carriage Bolt 3/8 x 6"', cbolt, STEEL, frame((TR, 0, WAY_TOP + 0.75 + 0.2), (0, 0, -1)))

# 5/16 x 3 lag screw: the post's pivot, head recessed into the base's underside
lag = unite(cyl('hd', 0.2887, 0, 0.21, 6), lathe('ls', [(0.2, 0), (0.2, 0.156), (2.95, 0.156), (3.21, 0)], 16))
part(REST, 'Lag Screw 5/16 x 3"', lag, STEEL, T(POST.x, POST.y, WAY_TOP + 0.04))

# ================================================================ checks, export

COLORS = {MAPLE: (0.80, 0.62, 0.40), CHERRY: (0.62, 0.30, 0.18), STEEL: (0.62, 0.64, 0.67), LEATHER: (0.45, 0.28, 0.15)}

if os.environ.get('LATHE_OVERLAPS'):
    # points of one part buried more than 0.02" inside another (parts that only touch, or a rod in its hole, pass)
    import bmesh
    from mathutils.bvhtree import BVHTree

    def solid(ob):
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        tris = bmesh.ops.triangulate(bm, faces=bm.faces[:])['faces']   # before moving it: triangulate projects on the face normals
        bm.transform(ob.matrix_world)
        pts = [v.co.copy() for v in bm.verts] + [f.calc_center_median() for f in tris]
        tree = BVHTree.FromBMesh(bm)
        bm.free()
        return tree, pts

    RAYS = [Vector(d).normalized() for d in ((0.3127, 0.7891, 0.5287), (-0.8123, 0.2461, 0.5289), (0.1709, -0.4517, -0.8757))]

    def inside(tree, pt):
        votes = 0
        for d in RAYS:    # parity along three skew rays, majority wins (a ray can graze an edge)
            hits, o = 0, pt
            while True:
                loc = tree.ray_cast(o, d)[0]
                if loc is None:
                    break
                hits, o = hits + 1, loc + d * 1e-5
            votes += hits % 2
        return votes >= 2

    solids = [(n, *solid(ob)) for _, n, ob, _ in PARTS]
    for i, (n1, t1, p1) in enumerate(solids):
        for n2, t2, p2 in solids[i + 1:]:
            if not t1.overlap(t2):
                continue
            deep = [d for t, pts in ((t2, p1), (t1, p2)) for q in pts if inside(t, q) for d in [t.find_nearest(q)[3]] if d > 0.02]
            if deep:
                print(f'overlap: {n1} / {n2}: {len(deep)} points, deepest {max(deep):.3f}"')

write_dae(OUT, COLORS, 'build_treadle_lathe.py', 'Treadle Lathe', unit=('inch', 0.0254))
print(f'WROTE {OUT}: {len(PARTS)} parts')
top = max((ob.matrix_world @ v.co).z for _, n, ob, _ in PARTS for v in ob.data.vertices)
low = min((ob.matrix_world @ v.co).z for _, n, ob, _ in PARTS for v in ob.data.vertices)
print(f'check: stands {low:.3f} to {top:.3f}"; idler wraps the belt {idler_wrap:.1f} deg, '
      f'idler centre y={I_C.x:.2f} z={I_C.y:.2f}, its bottom {I_C.y - 1.4375:.2f}" (ways\' top {WAY_TOP})')
print(f'check: treadle dips {math.degrees(dip):.1f} deg; rod bottom z={ROD_BOT:.2f}; cup center tip x={XC - 1.75 - 0.82:.2f}, '
      f'drive center point x={DC0 + 1.7:.2f}')

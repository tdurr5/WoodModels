"""Build Wayne C. Leckey's foot-powered scroll saw (Popular Mechanics, two parts) as a COLLADA model.

    blender -b --python scripts/scroll_saw/build_scroll_saw.py -- out.dae
    python3 parse_dae.py out.dae -o viewer/models/scroll-saw/

Sizes are the article's (inches): the plywood sides laid out two to a 41 x
63-1/2 panel (Fig. 9), the 2x4 core and stand (Figs. 5, 6, 8), the drive head
in a 1-qt paint can (Figs. 1-4), the blade-tension unit (Figs. 12-15), the
12" tilting table on its trunnions (Figs. 16-20) and the 18" pedal pulley
(Fig. 11). Fig. 8 is drawn to scale, so heights it doesn't label (the
pulley's axle, the table) are measured off it; where the article leaves a
size open the part's note in model.json says what was chosen.

Built in plan coordinates - x from the front (the seat) to the back, y up
from the floor, z across, the 18" pulley on +z - then turned Z-up for
Blender at the end. The blade is on x=0, z=0.
"""
import math
import os
import sys
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from blender_parts import *  # noqa: E402,F403  (geometry helpers, part(), write_dae())

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else os.path.join(HERE, 'scroll_saw.dae')

clear_scene()

FRAME, STAND, DRIVE, TENSION, TABLE, PEDALS = 'Frame', 'Stand', 'Drive Head', 'Tension Unit', 'Table', 'Pedal Drive'
PLY, FIR, MAPLE, PINE, HARDBOARD = 'Plywood', 'Fir', 'Maple', 'Pine', 'Hardboard'
STEEL, BRONZE, RUBBER, FELT = 'Steel', 'Bronze', 'Rubber', 'Felt'

# ---------------------------------------------------------------- key positions

PLY_T = 0.75
CORE = 0.75                    # the 2x4 core is 1-1/2 thick: sides at |z| 0.75..1.5
SIDE_Z = (CORE, CORE + PLY_T)
SEAT_TOP = 29.0                # Fig. 8
ARM_TOP = SEAT_TOP + 17.5      # Fig. 8: 17-1/2 from the seat to the top of the arm
PANEL = Vector((-15.85, ARM_TOP - 36))   # Fig. 9's lower side: its corner, so panel (x, y) -> plan (x + 15.85, y + 10.5)
ARM_BOT = ARM_TOP - 4          # the arm is 4 deep (Fig. 15)
THROAT = 18.0                  # "18-in. throat capacity"
BASE_BOT, BASE_TOP = 28.0, 28.75     # the drive head's 3/4 base, in the sides' 4-1/2 slots
CAN_TOP = BASE_TOP + 5               # standard 1-qt can, 5" tall (Fig. 4)
FRAME_TOP = BASE_TOP + 6.25          # top of the frame block over the can (Fig. 4: 6-1/4)
CRANK_Y = BASE_TOP + 2.875
TABLE_TOP = 38.25                    # the trunnions' axis: guides flush with the prongs' tops
PRONG_TOP = TABLE_TOP - math.sqrt(2.625 ** 2 - 1.5 ** 2)
SLOT = 2.25                          # half the 4-1/2 slot for the drive head
PEDAL_C = Vector((1.4, 16.9))        # the 18" pulley's axle, measured off Fig. 8
BELT_Z = 2.675                       # plane of both pulleys, outside side A


def rear_x(y):
    """The sides' rear edge (and the rear post's back face): Fig. 9's slope, 5-1/4 in over 23 down."""
    return 20.9 + (ARM_TOP - y) * 5.25 / 23


POST_W = 3.5 / math.cos(math.atan(5.25 / 23))      # the post's 3-1/2 measured across its slope


def front_x(y):
    """The sides' front edge below the drive head (and the front leg's front face)."""
    return PANEL.x + 1 + (y - PANEL.y) * 11.6 / 22


# ================================================================ FRAME: the two plywood sides


def side_outline():
    C = Vector((rear_x(23.5), 23.5))
    B = Vector((PANEL.x + 22, PANEL.y))
    M, d = (B + C) / 2, (C - B).normalized()
    ctr = M + math.sqrt(20.5 ** 2 - ((C - B).length / 2) ** 2) * Vector((d.y, -d.x))    # R20-1/2, centred off the bottom corner
    a0 = math.degrees(math.atan2(B.y - ctr.y, B.x - ctr.x))
    a1 = math.degrees(math.atan2(C.y - ctr.y, C.x - ctr.x))
    pts = [(front_x(PANEL.y), PANEL.y)]
    pts += arc(ctr.x, ctr.y, 20.5, a0, a1, 30)
    pts += [(rear_x(ARM_TOP), ARM_TOP), (-2.85, ARM_TOP), (-2.85, ARM_BOT)]
    pts += arc(THROAT - 3.5, ARM_BOT - 3.5, 3.5, 90, 0, 12)                 # R3-1/2 corners at the throat's back
    pts += arc(THROAT - 3.5, FRAME_TOP + 3.5, 3.5, 0, -90, 12)
    pts += [(SLOT + 1, FRAME_TOP), (SLOT + 1, PRONG_TOP), (SLOT, PRONG_TOP), (SLOT, BASE_BOT), (-SLOT, BASE_BOT),
            (-SLOT, PRONG_TOP), (-SLOT - 1, PRONG_TOP), (-SLOT - 1, 32.5)]
    return pts


SIDES = []
for sgn, label in ((1, 'Side'), (-1, 'Side')):
    sd = prism('side', side_outline(), *sorted((sgn * SIDE_Z[0], sgn * SIDE_Z[1])))
    SIDES.append(sd)
    part(FRAME, label, sd, PLY, T())
SIDE_A, SIDE_B = SIDES                # A on +z (the pulley side), B on -z (the seat member's)

# ---------------------------------------------------------------- 2x4 core between the sides

post = prism('post', [(rear_x(0) - POST_W, 0), (rear_x(0), 0), (rear_x(ARM_TOP), ARM_TOP), (rear_x(ARM_TOP) - POST_W, ARM_TOP)], -CORE, CORE)
part(FRAME, 'Rear Post', post, FIR, T())

AC_X = 1.875                            # behind the tension unit and its hold-down
part(FRAME, 'Arm Core', prism('ac', [(AC_X, ARM_TOP - 3.5), (rear_x(ARM_TOP - 3.5) - POST_W, ARM_TOP - 3.5),
                                     (rear_x(ARM_TOP) - POST_W, ARM_TOP), (AC_X, ARM_TOP)], -CORE, CORE), FIR, T())
part(FRAME, 'Arm Filler Block', box('af', -2.85, -1.5, ARM_BOT, ARM_TOP, -CORE, CORE), FIR, T())

FL_W = 3.5 / math.cos(math.atan(11.6 / 22))
part(FRAME, 'Front Leg', prism('fl', [(front_x(0), 0), (front_x(0) + FL_W, 0), (front_x(27) + FL_W, 27), (front_x(27), 27)], -CORE, CORE), FIR, T())

# ================================================================ STAND: seat member, rear legs, crossbar, seat

SEAT_A = math.asin((SEAT_TOP - 0.75) / 52.5)       # the 4'-4-1/2" seat member, floor to seat, through the pulley's axle
dxs = 1 / math.tan(SEAT_A)
hw = 1.75 / math.sin(SEAT_A)


def seat_cx(y):
    return PEDAL_C.x + (PEDAL_C.y - y) * dxs


sm = prism('sm', [(seat_cx(0) - hw, 0), (seat_cx(0) + hw, 0), (seat_cx(SEAT_TOP - 0.75) + hw, SEAT_TOP - 0.75),
                  (seat_cx(SEAT_TOP - 0.75) - hw, SEAT_TOP - 0.75)], -SIDE_Z[1] - 1.5, -SIDE_Z[1])
part(STAND, 'Seat Member', sm, FIR, T())

SEAT_X = seat_cx(SEAT_TOP - 0.75)
part(STAND, 'Seat', prism('seat', [(SEAT_X - 9, -5.5), (SEAT_X + 5, -3), (SEAT_X + 5, 3), (SEAT_X - 9, 5.5)], SEAT_TOP - 0.75, SEAT_TOP, 'XZ'),
     PINE, T())

# rear legs: down the post's slope, splayed out to 10" either side at the floor, one 3/8 x 4 bolt each into the post
n_post = Vector((1, 5.25 / 23, 0)).normalized()     # the post's back face looks this way
LEG_TOP = 31.0


def post_cx(y):
    return rear_x(y) - POST_W / 2


BOLTS = []    # (parts it passes through, frame: local z along the bolt from the top of its head)
for sgn in (1, -1):
    top = Vector((post_cx(LEG_TOP), LEG_TOP, sgn * (SIDE_Z[1] + 0.75)))
    bot = Vector((post_cx(0), 0, sgn * 10))
    u = (bot - top).normalized()
    t = u.cross(n_post).normalized()
    leg = xf(box('rl', -1.75, 1.75, -0.75, 0.75, 0, (bot - top).length + 3), axes(n_post, t, u, top))
    keep(leg, box('floor', -50, 50, 0, 60, -30, 30))
    part(STAND, 'Rear Leg', leg, FIR, T())
    yb = 29.5 if sgn > 0 else 28.0     # staggered, so the two don't meet in the post
    zc = top.z + (bot.z - top.z) * (LEG_TOP - yb) / LEG_TOP
    M = frame((post_cx(yb), yb, zc + sgn * (0.85 + 0.23)), (0, 0, -sgn))
    BOLTS.append(([leg, SIDE_A, SIDE_B, post], M))

M_cb = axes(n_post, Vector((-n_post.y, n_post.x, 0)), (0, 0, 1), Vector((rear_x(7), 7, 0)) + n_post * 0.75)
cbar = part(STAND, 'Crossbar', xf(box('cb', -0.75, 0.75, -1.75, 1.75, -9.25, 9.25), M_cb), FIR, T())
BOLTS.append(([cbar, post], M_cb @ T(0.98, 0.8, 0) @ R(-90, 'Y')))     # through the crossbar into the post

for obs, M in BOLTS:
    for ob in obs:
        drill(ob, M, 0.1875, 0.0, 4.4, 16)
    part(STAND, 'Machine Bolt 3/8 x 4"', unite(cyl('h', 0.32, 0, 0.23, 6), cyl('s', 0.1875, 0.2, 4.23, 16)), STEEL, M)

# ================================================================ DRIVE HEAD (Figs. 1-4): the crank in a 1-qt can

part(DRIVE, 'Drive Base', box('db', -SLOT, SLOT, BASE_BOT, BASE_TOP, -2.125, 4.125), MAPLE, T())
for sgn in (1, -1):    # cleats on the sides' outer faces hold the base in its slots
    part(DRIVE, 'Cleat', box('cl', -SLOT, SLOT, BASE_BOT - 0.75, BASE_BOT, *sorted((sgn * SIDE_Z[1], sgn * (SIDE_Z[1] + 0.75)))), FIR, T())

CAN_R = 2.125
can = cut(cyl('can', CAN_R, BASE_TOP, CAN_TOP - 0.06, 48, 'Y'), cyl('in', CAN_R - 0.03, BASE_TOP + 0.03, CAN_TOP, 48, 'Y'),
          xf(cyl('h', 0.3, 0, 3, 16), T(0, CRANK_Y, 0)))
part(DRIVE, 'Paint Can (1 qt)', can, STEEL, T())
part(DRIVE, 'Can Lid', cut(cyl('lid', CAN_R, CAN_TOP - 0.06, CAN_TOP, 48, 'Y'), cyl('h', 0.35, 30, 40, 16, 'Y')), STEEL, T())
part(DRIVE, 'Felt Washer', cut(cyl('fw', 0.6, CAN_TOP, CAN_TOP + 0.125, 24, 'Y'), cyl('h', 0.25, 30, 40, 16, 'Y')), FELT, T())
part(DRIVE, 'Felt Washer', cut(cyl('fw', 0.5, CAN_R, CAN_R + 0.125, 24), cyl('h', 0.25, 0, 3, 16)), FELT, T(0, CRANK_Y, 0))

FB = (CAN_TOP + 0.125, FRAME_TOP)     # the frame block over the can, between the sides, with the upper bushing
fb = box('fb', -SLOT, SLOT, *FB, -CORE, CORE)
cut(fb, cyl('b', 0.34375, 30, 40, 24, 'Y'))
part(DRIVE, 'Frame Block', fb, MAPLE, T())


def bushing(length, flange=True):
    """Ford Model-T spindle-body bushing: 11/16 OD bronze, 1/2 bore, flanged."""
    prof = [(0, 0), (0, 0.34375), (length, 0.34375), (length, 0)]
    if flange:
        prof = [(0, 0), (0, 0.5), (0.125, 0.5), (0.125, 0.34375), (length, 0.34375), (length, 0)]
    return cut(lathe('bu', prof, 24), cyl('b', 0.25, -0.1, length + 0.1, 20))


part(DRIVE, 'Spindle-Body Bushing', bushing(FB[1] - FB[0], False), BRONZE, T(0, FB[0], 0) @ R(-90, 'X'))

# lower bushing in a flat-iron bracket screwed through the can's bottom to the base
BR_TOP = BASE_TOP + 1.125
bracket = prism('br', [(-1.5, BASE_TOP + 0.03), (-1.0, BASE_TOP + 0.03), (-1.0, BR_TOP - 0.125), (1.0, BR_TOP - 0.125), (1.0, BASE_TOP + 0.03),
                       (1.5, BASE_TOP + 0.03), (1.5, BASE_TOP + 0.155), (1.125, BASE_TOP + 0.155), (1.125, BR_TOP), (-1.125, BR_TOP),
                       (-1.125, BASE_TOP + 0.155), (-1.5, BASE_TOP + 0.155)], -0.5, 0.5)
cut(bracket, cyl('b', 0.34375, 0, 40, 24, 'Y'), *[xf(cyl('s', 0.08, 0, 40, 8, 'Y'), T(x, 0, 0)) for x in (-1.3, 1.3)])
part(DRIVE, 'Bushing Bracket', bracket, STEEL, T())
part(DRIVE, 'Spindle-Body Bushing', bushing(1.0), BRONZE, frame((0, BR_TOP + 0.125, 0), (0, -1, 0)))
for x in (-1.3, 1.3):
    drill(PARTS[[n for _, n, _, _ in PARTS].index('Drive Base')][2], T(x, BASE_TOP + 0.31, 0) @ R(90, 'X'), 0.05, 0, 1.2, 8)    # pilots
    part(DRIVE, 'Round-Head Screw', unite(lathe('rh', [(0, 0), (0.08, 0.16), (0.155, 0.2), (0.155, 0)], 12), cyl('s', 0.08, 0.15, 1.0, 8)),
         STEEL, frame((x, BASE_TOP + 0.31, 0), (0, -1, 0)))

# the vertical shaft, at mid-stroke: crank pin straight behind the crankshaft
SHAFT = (BASE_TOP + 0.5, BASE_TOP + 7.0)
sh = cyl('vs', 0.25, *SHAFT, 24, 'Y')
part(DRIVE, 'Drive Shaft', sh, STEEL, T())

# Scotch yoke: a channel clamped to the shaft, a bar sliding in it on the crank pin
CH = 0.375
part(DRIVE, 'Channel', unite(box('web', -1.5, 1.5, CRANK_Y - CH, CRANK_Y + CH, 0.25, 0.3125),
           box('f1', -1.5, 1.5, CRANK_Y - CH, CRANK_Y - CH + 0.0625, 0.3125, 0.6),
           box('f2', -1.5, 1.5, CRANK_Y + CH - 0.0625, CRANK_Y + CH, 0.3125, 0.6)), STEEL, T())
bar = cut(box('bar', 0.5 - 0.53, 0.5 + 0.53, CRANK_Y - CH + 0.0625, CRANK_Y + CH - 0.0625, 0.3125, 0.6), xf(cyl('p', 0.1875, 0, 1, 16), T(0.5, CRANK_Y, 0)))
part(DRIVE, 'Slide Bar', bar, STEEL, T())

# crank: disk pinned to the crankshaft, hardened pin 1/2 off centre (1" stroke), counterweight opposite
part(DRIVE, 'Crank Disk', cut(cyl('cd', 0.625, 0.625, 1.0, 32), xf(cyl('p', 0.1875, 0, 2, 16), T(0.5, 0, 0)), cyl('s', 0.25, 0.9, 2, 16)),
     STEEL, T(0, CRANK_Y, 0))
part(DRIVE, 'Crank Pin', cyl('cp', 0.1875, 0.3125, 1.0, 16), STEEL, T(0.5, CRANK_Y, 0))
part(DRIVE, 'Counterweight', box('cw', -0.72, -0.28, -0.22, 0.22, 1.0, 1.3125), STEEL, T(0, CRANK_Y, 0))
part(DRIVE, 'Crankshaft', cyl('ck', 0.25, 0.9, 4.6, 24), STEEL, T(0, CRANK_Y, 0))

PUL_Z = BELT_Z
pul4 = cut(lathe('p4', [(-0.4, 0), (-0.4, 2), (-0.3, 2), (0, 1.4), (0.3, 2), (0.4, 2), (0.4, 0)], 48), cyl('b', 0.25, -1, 1, 20))
part(DRIVE, 'Crank Pulley 4"', pul4, STEEL, T(0, CRANK_Y, PUL_Z))

bb = prism('bb', [(-1.25, BASE_TOP), (1.25, BASE_TOP), (0.75, BASE_TOP + 3.75), (-0.75, BASE_TOP + 3.75)], 3.125, 4.125)
cut(bb, xf(cyl('b', 0.34375, 0, 5, 24), T(0, CRANK_Y, 0)), xf(cyl('oil', 0.06, 0, 5, 8, 'Y'), T(0, 0, 3.625)))
part(DRIVE, 'Bearing Block', bb, MAPLE, T())
part(DRIVE, 'Spindle-Body Bushing', bushing(1.0), BRONZE, T(0, CRANK_Y, 4.25) @ R(180, 'X'))
part(DRIVE, 'Collar', cut(cyl('co', 0.5, 4.25, 4.55, 24), cyl('b', 0.25, 4, 5, 20)), STEEL, T(0, CRANK_Y, 0))

# frame block's carriage bolt, through both sides (Fig. 4)
M_fbb = frame((-1.5, (FB[0] + FB[1]) / 2, SIDE_Z[1]), (0, 0, -1))


def carriage(length, r=0.125):
    head = lathe('ch', [(0, 0), (0, 2.2 * r), (0.6 * r, 2.0 * r), (1.0 * r, 1.4 * r), (1.2 * r, 0)], 16)
    return unite(xf(head, R(180, 'X')), box('sq', -r, r, -r, r, 0, r), cyl('s', r, r * 0.9, length, 12))


part(DRIVE, 'Carriage Bolt 1/4 x 3-1/4"', carriage(3.25), STEEL, M_fbb)
for ob in (SIDE_A, SIDE_B, fb):
    drill(ob, M_fbb, 0.135, -0.1, 3.3, 12)

# ================================================================ TENSION UNIT (Figs. 12-15), in the arm's front end

BLK = (ARM_BOT - 0.5, ARM_BOT - 0.5 + 7)         # the 1-1/2 x 3 x 7 housing, adjustable up and down in the arm
hb = box('hb', -1.5, 1.5, *BLK, -CORE, CORE)
cut(hb, cyl('top', 0.34375, BLK[1] - 3, BLK[1] + 0.1, 24, 'Y'),        # 11/16 bit, 3" deep from the top
    cyl('bot', 0.5, BLK[0] - 0.1, BLK[0] + 4, 32, 'Y'),                 # 1" bit, through to meet it
    box('groove', 1.125, 1.6, BLK[0] - 0.1, BLK[1] + 0.1, -0.375, 0.375))   # groove for the hold-down
part(TENSION, 'Tension Housing', hb, MAPLE, T())

part(TENSION, 'Spindle-Body Bushing', bushing(1.25), BRONZE, frame((0, BLK[1] + 0.125, 0), (0, -1, 0)))
SLEEVE = (BLK[0] + 0.125, BLK[0] + 1.375)
part(TENSION, 'Wood Sleeve', cut(cyl('ws', 0.5, *SLEEVE, 32, 'Y'), cyl('b', 0.34375, 0, 60, 24, 'Y')), MAPLE, T())
part(TENSION, 'Spindle-Body Bushing', bushing(SLEEVE[1] - SLEEVE[0], False), BRONZE, T(0, SLEEVE[0], 0) @ R(-90, 'X'))
part(TENSION, 'Felt Washer', cut(cyl('fw', 0.5, BLK[0], BLK[0] + 0.125, 24, 'Y'), cyl('h', 0.25, 0, 60, 16, 'Y')), FELT, T())
part(TENSION, 'Bushing Plate', cut(box('pl', -1.5, 1.0, BLK[0] - 0.125, BLK[0], -CORE, CORE), cyl('h', 0.27, 0, 60, 16, 'Y')), STEEL, T())

TUBE = (SLEEVE[1], BLK[0] + 4)
PIN_Y = TUBE[1] - 0.5
tb = cut(cyl('tu', 0.5, *TUBE, 32, 'Y'), cyl('in', 0.47, 0, 60, 32, 'Y'),
         box('s1', 0.4, 0.6, TUBE[1] - 1.375, TUBE[1] + 0.1, -0.0625, 0.0625), box('s2', -0.6, -0.4, TUBE[1] - 1.375, TUBE[1] + 0.1, -0.0625, 0.0625))
part(TENSION, 'Slotted Tube', tb, STEEL, T())

TSHAFT = (ARM_BOT - 1.5, ARM_BOT - 1.5 + 9.375)
ts = cut(cyl('ts', 0.25, *TSHAFT, 24, 'Y'), xf(cyl('ph', 0.0625, -1, 1, 12, 'X'), T(0, PIN_Y, 0)))
part(TENSION, 'Tension Shaft', ts, STEEL, T())
part(TENSION, 'Cross Pin', cyl('xp', 0.0625, -0.5, 0.5, 12, 'X'), STEEL, T(0, PIN_Y, 0))
SPRING = (TUBE[0] + 0.05, PIN_Y - 0.12)      # between the sleeve and the cross pin
coil = [(0.34 * math.cos(t), SPRING[0] + (SPRING[1] - SPRING[0]) * t / (20 * math.pi), 0.34 * math.sin(t)) for t in
        [20 * math.pi * i / 400 for i in range(401)]]
part(TENSION, 'Spring', tube('sp', coil, 0.045, 6), STEEL, T())

# the blade chucks: hex nuts on the shafts' ends, setscrew across, and the blade between them
NUT = 0.625


def chuck(ss):
    n = cut(cyl('nut', 0.4, 0, NUT, 6, 'Y'), cyl('b', 0.25, -0.1, NUT + 0.1, 16, 'Y'))
    return cut(n, xf(cyl('ss', 0.095, 0, 1, 8), T(0, ss, 0)))


LOW_CHUCK = SHAFT[1] - 0.25
UP_CHUCK = TSHAFT[0] + 0.25 - NUT
part(DRIVE, 'Blade Chuck', chuck(0.44), STEEL, T(0, LOW_CHUCK, 0))
part(TENSION, 'Blade Chuck', chuck(0.19), STEEL, T(0, UP_CHUCK, 0))
for y, grp in ((LOW_CHUCK + 0.44, DRIVE), (UP_CHUCK + 0.19, TENSION)):    # across the bore, clear of the shaft's end
    part(grp, 'Setscrew', cyl('ss', 0.095, 0.015, 0.55, 8), STEEL, T(0, y, 0))
BLADE = (SHAFT[1] + 0.05, TSHAFT[0] - 0.05)
part(TENSION, 'Scroll-Saw Blade', box('bl', -0.125, 0.125, *BLADE, -0.01, 0.01), STEEL, T())

# handwheel clamp: carriage bolt through side A, the filler block and side B into a nut in the handwheel
CL = Vector((-2.175, ARM_TOP - 2, 0))
M_cl = frame((CL.x, CL.y, SIDE_Z[1]), (0, 0, -1))
part(TENSION, 'Carriage Bolt 1/4 x 4"', carriage(3.6), STEEL, M_cl)
hw = cut(cyl('hw', 1.25, -SIDE_Z[1] - 0.75, -SIDE_Z[1], 32), cyl('b', 0.14, -3, 0, 12), box('nut', -0.22, 0.22, -0.22, 0.22, -SIDE_Z[1] - 0.6, -SIDE_Z[1] - 0.35))
part(TENSION, 'Handwheel', hw, MAPLE, T(CL.x, CL.y, 0))
part(TENSION, 'Square Nut 1/4"', cut(box('sn', -0.2, 0.2, -0.2, 0.2, -SIDE_Z[1] - 0.58, -SIDE_Z[1] - 0.37), cyl('b', 0.125, -3, 0, 12)), STEEL, T(CL.x, CL.y, 0))
for ob in [o for _, n, o, _ in PARTS if n == 'Arm Filler Block'] + [SIDE_A, SIDE_B]:
    drill(ob, M_cl, 0.135, -0.1, 3.7, 12)

# hold-down: a 3/4 square stick in the housing's groove, locked by a thumbnut; fork and 1-1/2 disk at its foot
HD = (TABLE_TOP + 1.25, TABLE_TOP + 9.25)
part(TENSION, 'Hold-Down Stick', box('hd', 1.125, 1.875, *HD, -0.375, 0.375), MAPLE, T())
DISK_Y = HD[0] + 0.5
disk = cut(cyl('dk', 0.75, 1.0625, 1.125, 32, 'X'), xf(box('sl', -0.1, 0.1, -0.14, 0.14, -0.5, 0.5), T(1.09, 0, 0)))
part(TENSION, 'Hold-Down Disk', disk, STEEL, T(0, DISK_Y, 0))
for sgn in (1, -1):    # the fork's two outer tines, soldered to the disk, straddling the blade
    path = [(1.07, DISK_Y - 0.3, sgn * 0.3), (0.6, DISK_Y - 0.6, sgn * 0.3), (-0.3, TABLE_TOP + 0.1, sgn * 0.3), (-0.75, TABLE_TOP + 0.25, sgn * 0.3)]
    part(TENSION, 'Hold-Down Tine', tube('ti', fillet(path, 0.2, 6), 0.04, 6), STEEL, T())
gb = cut(unite(cyl('gh', 0.3, 0.125, 0.3, 16, 'X'), cyl('gs', 0.125, 0.3, 2.1, 12, 'X')), box('slot', 0.12, 0.2, -0.4, 0.4, -0.02, 0.02))
part(TENSION, 'Blade Guide Bolt', gb, STEEL, T(0, DISK_Y, 0))
part(TENSION, 'Hex Nut 1/4"', cut(cyl('n', 0.25, 1.875, 2.09, 6, 'X'), cyl('b', 0.125, 0, 3, 12, 'X')), STEEL, T(0, DISK_Y, 0))
for ob in [o for _, n, o, _ in PARTS if n == 'Hold-Down Stick']:
    cut(ob, xf(cyl('h', 0.13, 1.0, 2.0, 12, 'X'), T(0, DISK_Y, 0)))

TH = Vector((1.5, ARM_TOP - 2, 0))
part(TENSION, 'Thumb Screw 1/4"', cyl('tsc', 0.125, -SIDE_Z[1] - 0.85, -0.375, 12), STEEL, T(TH.x, TH.y, 0))
part(TENSION, 'Thumb Nut', cut(unite(cyl('tn', 0.42, -SIDE_Z[1] - 0.3, -SIDE_Z[1], 16), box('w', -0.7, 0.7, -0.1, 0.1, -SIDE_Z[1] - 0.3, -SIDE_Z[1] - 0.05)),
                               cyl('b', 0.125, -3, 0, 12)), STEEL, T(TH.x, TH.y, 0))
cut(SIDE_B, xf(cyl('h', 0.14, -2, 0, 12), T(TH.x, TH.y, 0)))

# ================================================================ TABLE (Figs. 16-20): 12" square, tilting 45 deg on two trunnions

tbl = cut(box('t', -6, 6, TABLE_TOP - 0.75, TABLE_TOP, -6, 6), cyl('h', 0.75, 0, 50, 32, 'Y'),
          cyl('rec', 1.0, TABLE_TOP - 0.0625, TABLE_TOP + 0.1, 32, 'Y'))
part(TABLE, 'Table', tbl, PLY, T())
part(TABLE, 'Table Insert', cut(cyl('ti', 1.0, TABLE_TOP - 0.0625, TABLE_TOP, 32, 'Y'), box('s', -0.3, 0.3, 0, 50, -0.04, 0.04)), STEEL, T())

T_R, G_IN, G_OUT, SLOT_R = 3.0, 2.625, 3.25, 2.75
BOLT_Z = 1.125                                     # in side A's prong
BOLT_A = math.asin(BOLT_Z / SLOT_R)                # from straight down, toward +z
for sgn in (-1, 1):                                # front trunnion (x<0), rear (x>0): one right-hand, one left
    face = sgn * (SLOT + 1)                        # the prong's outer face
    out = sgn                                      # outward along x
    xin, xout = face, face + out * 0.75
    lo, hi = sorted((xin, xout))
    half = [(z, TABLE_TOP - math.sqrt(T_R ** 2 - z ** 2)) for z in [-math.sqrt(T_R ** 2 - 0.5625) * (1 - 2 * i / 40) for i in range(41)]]
    tr = prism('tr', [(y, z) for z, y in half], lo, hi, 'YZ')
    r0, r1 = sorted((xin - out * 0.1, xin + out * 0.125))     # rabbet on the inner face, R2-5/8 out, for the guide
    rab = cut(box('r1', r0, r1, TABLE_TOP - 4, TABLE_TOP, -4, 4), xf(cyl('r2', G_IN, r0 - 1, r1 + 1, 48, 'X'), T(0, TABLE_TOP, 0)))
    cut(tr, rab)
    sweep = [BOLT_A - math.radians(45) + math.radians(45) * i / 20 for i in range(21)]
    slot_pts = [(SLOT_R + 0.125, a) for a in sweep] + [(SLOT_R - 0.125, a) for a in reversed(sweep)]
    cut(tr, prism('sl', [(TABLE_TOP - r * math.cos(a), r * math.sin(a)) for r, a in slot_pts], lo - 0.1, hi + 0.1, 'YZ'),
        *[xf(cyl('e', 0.125, lo - 0.1, hi + 0.1, 12, 'X'), T(0, TABLE_TOP - SLOT_R * math.cos(a), SLOT_R * math.sin(a))) for a in (sweep[0], sweep[-1])])
    part(TABLE, 'Trunnion', tr, PLY, T())

    gd = cut(cyl('g', G_OUT, 0, 0.125, 64, 'X'), cyl('gi', G_IN, -1, 1, 64, 'X'))
    keep(gd, box('k', -1, 1, -5, 0, -1.5, 1.5))
    bolt_p = Vector((0, TABLE_TOP - SLOT_R * math.cos(BOLT_A), BOLT_Z))
    cut(gd, xf(cyl('bh', 0.14, -1, 1, 12, 'X'), T(0, bolt_p.y - TABLE_TOP, bolt_p.z)))
    part(TABLE, 'Trunnion Guide', gd, HARDBOARD, T(face if sgn > 0 else face - 0.125, TABLE_TOP, 0))

    # square-head bolt, head let into the prong under the guide; washer and wing nut outside the trunnion
    M_b = frame((face - out * 0.17, bolt_p.y, bolt_p.z), (out, 0, 0))
    part(TABLE, 'Trunnion Bolt 1/4 x 1-1/2"', unite(box('sh', -0.22, 0.22, -0.22, 0.22, 0, 0.17), cyl('s', 0.125, 0.15, 1.5, 12)), STEEL, M_b)
    cut(SIDE_A, xf(box('rec', -0.23, 0.23, -0.23, 0.23, -0.01, 0.18), M_b))
    part(TABLE, 'Flat Washer 1/4"', cut(cyl('w', 0.3125, 0.92, 0.98, 20), cyl('b', 0.14, 0, 2, 12)), STEEL, M_b)
    part(TABLE, 'Wing Nut 1/4"', cut(unite(cyl('wn', 0.25, 0.98, 1.3, 12), box('w', -0.65, 0.65, -0.08, 0.08, 1.0, 1.25)), cyl('b', 0.125, 0, 2, 12)),
         STEEL, M_b)
    part(TABLE, 'Table Cleat', box('tc', *sorted((xout, xout + out * 0.75)), TABLE_TOP - 1.5, TABLE_TOP - 0.75, -2.5, 2.5), MAPLE, T())

# ================================================================ PEDAL DRIVE (Fig. 11): 18" pulley on a 1/2 pipe, bicycle pedals

PC = Vector((PEDAL_C.x, PEDAL_C.y, 0))
PIPE_R = 0.42
SHAFT_Z = (-SIDE_Z[1] - 1.8, SIDE_Z[1] + 2.6)
part(PEDALS, 'Pipe Shaft 1/2"', cyl('ps', PIPE_R, *SHAFT_Z, 24), STEEL, T(PC.x, PC.y, 0))
for ob in [SIDE_A, SIDE_B, sm]:
    cut(ob, xf(cyl('h', 0.44 if ob is SIDE_B else 0.625, -5, 5, 24), T(PC.x, PC.y, 0)))
for z0, z1 in ((SIDE_Z[0], SIDE_Z[1]), (-SIDE_Z[1] - 1.5, -SIDE_Z[1])):    # maple bushings in side A and the seat member
    part(PEDALS, 'Shaft Bushing', cut(cyl('sb', 0.625, z0, z1, 24), cyl('b', 0.44, -5, 5, 24)), MAPLE, T(PC.x, PC.y, 0))

pul = cut(lathe('p18', [(-0.375, 0), (-0.375, 9), (-0.3, 9), (0, 8.4), (0.3, 9), (0.375, 9), (0.375, 0)], 120), cyl('b', 0.44, -1, 1, 24))
part(PEDALS, 'Drive Pulley 18"', pul, PLY, T(PC.x, PC.y, BELT_Z))
FLANGE = [(0, 0), (0, 1.5), (0.2, 1.5), (0.25, 0.6), (0.8, 0.55), (0.8, 0)]
for sgn in (-1, 1):    # 1/2" floor flanges, screwed opposite each other
    fl = cut(lathe('fl', FLANGE, 48), cyl('b', PIPE_R, -1, 1, 24),
             *[xf(cyl('h', 0.09, -0.1, 0.3, 12), T(1.15 * math.cos(a), 1.15 * math.sin(a), 0)) for a in (0.82, 2.39, 3.96, 5.53)])
    part(PEDALS, 'Floor Flange 1/2"', fl, STEEL, frame((PC.x, PC.y, BELT_Z + sgn * 0.375), (0, 0, sgn)))

# cranks: an elbow and a short pipe arm on each end, half a turn apart, pedals on the flattened ends
THROW = 4.0
for z_end, plane, dirx, sgn in ((SHAFT_Z[1], SHAFT_Z[1] + 0.5, -1, 1), (SHAFT_Z[0], SHAFT_Z[0] - 0.5, 1, -1)):
    path = [(PC.x, PC.y, z_end), (PC.x, PC.y, plane), (PC.x + dirx * THROW, PC.y, plane)]
    part(PEDALS, 'Pipe Crank', tube('pc', fillet(path, 0.55, 8), PIPE_R, 16), STEEL, T())
    end = Vector((PC.x + dirx * THROW, PC.y, plane + sgn * PIPE_R))    # the spindle screws into the flattened end's face
    part(PEDALS, 'Pedal Spindle', cyl('psp', 0.25, 0, 4.0, 12), STEEL, frame(end, (0, 0, sgn)))
    pd = cut(box('pd', -1.375, 1.375, -0.5, 0.5, 0.6, 4.0), box('in', -1.1, 1.1, -0.6, 0.6, 0.85, 3.75))
    cut(unite(pd, cyl('hub', 0.4, 0.6, 4.0, 16)), cyl('b', 0.25, 0, 5, 12))
    part(PEDALS, 'Bicycle Pedal', pd, RUBBER, frame(end, (0, 0, sgn), (1, 0, 0)))

# V-belt from the 18" pulley up to the 4" pulley on the crankshaft
loop = [(Vector(PEDAL_C), 8.85), (Vector((0, CRANK_Y)), 1.85)]
part(PEDALS, 'V-Belt', tube('belt', [(x, y, BELT_Z) for x, y in belt_path(loop)], 0.2, 10, closed=True), RUBBER, T())

# ================================================================ stand it up (Z up), checks, export

G = R(90, 'X')    # plan (x, y up, z across) -> Blender (x, -z, y)
for _, _, ob, _ in PARTS:
    ob.matrix_world = G @ ob.matrix_world

COLORS = {PLY: (0.86, 0.74, 0.55), FIR: (0.82, 0.66, 0.44), MAPLE: (0.80, 0.62, 0.40), PINE: (0.85, 0.70, 0.48),
          HARDBOARD: (0.35, 0.24, 0.15), STEEL: (0.62, 0.64, 0.67), BRONZE: (0.72, 0.55, 0.30), RUBBER: (0.10, 0.10, 0.10),
          FELT: (0.55, 0.52, 0.45)}

if os.environ.get('SAW_OVERLAPS'):
    report_overlaps()

write_dae(OUT, COLORS, 'build_scroll_saw.py', 'Foot-Powered Scroll Saw', unit=('inch', 0.0254))
print(f'WROTE {OUT}: {len(PARTS)} parts')
print(f'check: seat member {SEAT_X:.2f} at the seat, {seat_cx(0):.2f} at the floor; table top {TABLE_TOP}, '
      f'throat {THROAT}, lower chuck tops out at {LOW_CHUCK + NUT + 0.5:.2f} under the table\'s {TABLE_TOP - 0.75}')
print(f'check: blade {BLADE[1] - BLADE[0]:.2f}" from {BLADE[0]:.2f} to {BLADE[1]:.2f}; arm top {ARM_TOP}, side bottom {PANEL.y}')

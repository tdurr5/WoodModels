"""Geometry helpers for building a model's parts in Blender and writing them
as COLLADA for parse_dae.py (used by the build scripts under scripts/).

Run inside Blender: solids are built along local axes in the script's units,
placed with part(group, name, object, material, matrix), then written with
write_dae(). World axes are Z up.
"""
import bmesh
import bpy
import math
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

SEG = 40


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


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



def drill(ob, M, r, z0, z1, segs=16):
    """Bore a part already placed where a pin, bar or nail goes: a cylinder from z0 to z1
    along local Z of the world-space frame M (the boolean works in world space)."""
    return cut(ob, xf(cyl('drill', r, z0, z1, segs), M))



# ---------------------------------------------------------------- parts


PARTS = []   # (group, name, object, material)


def part(group, name, ob, mat, M):
    ob.matrix_world = M
    ob.name = name
    PARTS.append((group, name, ob, mat))
    return ob


def write_dae(path, colors, tool, title, unit=('millimeter', 0.001)):
    """Every part() as one COLLADA node, grouped by assembly; colors: {material: (r, g, b)}."""
    from xml.sax.saxutils import escape as esc
    escape = lambda t: esc(t, {'"': '&quot;'})    # noqa: E731  (names go in attributes)
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
                      f'{" ".join(f"{c:.3f}" for c in colors[m])} 1</color></diffuse></lambert></technique></profile_COMMON></effect>' for m in mats)
    materials = ''.join(f'<material id="mat-{m}" name="{m}"><instance_effect url="#fx-{m}"/></material>' for m in mats)
    scene = ''.join(f'<node id="g{i}" name="{escape(g)}">{"".join(ns)}</node>' for i, (g, ns) in enumerate(groups.items()))
    with open(path, 'w') as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">'
                f'<asset><contributor><authoring_tool>{tool} (Blender)</authoring_tool></contributor>'
                f'<unit name="{unit[0]}" meter="{unit[1]}"/><up_axis>Z_UP</up_axis></asset>'
                f'<library_effects>{effects}</library_effects><library_materials>{materials}</library_materials>'
                f'<library_geometries>{"".join(geo)}</library_geometries>'
                f'<library_visual_scenes><visual_scene id="scene" name="{escape(title)}">{scene}</visual_scene></library_visual_scenes>'
                '<scene><instance_visual_scene url="#scene"/></scene></COLLADA>')


# ---------------------------------------------------------------- bent rod, belts


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


def tangent(A, ra, B, rb):
    """Outer tangent from circle A to circle B for a loop run counter-clockwise (y right, z up)."""
    d = (B - A).normalized()
    s = (ra - rb) / (B - A).length
    n = s * d + math.sqrt(1 - s * s) * Vector((d.y, -d.x))
    return A + ra * n, B + rb * n


def belt_path(loop, step=4):
    """Points round a belt wrapped on circles [(centre, radius)] given counter-clockwise in a plane (2D Vectors)."""
    runs = [tangent(*loop[i], *loop[(i + 1) % len(loop)]) for i in range(len(loop))]
    pts = []
    for i, (c, r) in enumerate(loop):
        t_in, t_out = runs[i - 1][1], runs[i][0]
        a0 = math.atan2(t_in.y - c.y, t_in.x - c.x)
        a1 = math.atan2(t_out.y - c.y, t_out.x - c.x)
        sweep = (a1 - a0) % (2 * math.pi)
        assert sweep < math.pi * 1.9, 'belt does not wrap circle %d' % i
        k = max(2, int(sweep / math.radians(step)))
        pts += [(c.x + r * math.cos(a0 + sweep * j / k), c.y + r * math.sin(a0 + sweep * j / k)) for j in range(k + 1)]
    return pts


# ---------------------------------------------------------------- checks


def report_overlaps(tol=0.02):
    """Print each pair of parts where points of one are buried more than tol inside the other
    (parts that only touch, or a rod in its hole, pass)."""
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
            deep = [d for t, pts in ((t2, p1), (t1, p2)) for q in pts if inside(t, q) for d in [t.find_nearest(q)[3]] if d > tol]
            if deep:
                print(f'overlap: {n1} / {n2}: {len(deep)} points, deepest {max(deep):.3f}"')

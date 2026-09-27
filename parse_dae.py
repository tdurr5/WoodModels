"""Turn a SketchUp COLLADA (.dae) export into the cut-list viewer's data files.

    python3 parse_dae.py path/to/model.dae -o viewer/

Writes into the output directory:
  scene.obj / scene.mtl  geometry, one OBJ object per part instance (Y-up)
  materials.json         OBJ material id -> SketchUp material name
  object_dims.json       per-instance oriented length/width/thickness axes
  parts_report.json      the cut list: one row per distinct part, with qty

Standard library only. Lengths are converted to inches from the file's
declared unit, and Z-up files (SketchUp) are turned Y-up for three.js.
viewer/collada.js is a line-for-line JavaScript port used for uploads in the
browser; tests/parser_parity.mjs checks the two agree.
"""
import argparse
import json
import math
import os
import re
import shutil
import sys
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from fractions import Fraction

# COLLADA 1.4 namespace; use_namespace() switches to whatever a file declares
# (1.5 is 'http://www.collada.org/2008/03/COLLADASchema', some files have none).
NS = {'c': 'http://www.collada.org/2005/11/COLLADASchema'}


def use_namespace(root):
    m = re.match(r'^\{([^}]*)\}', root.tag)
    NS['c'] = m.group(1) if m else ''

# Parts under a top-level group with this prefix are the printed plan sheet
# SketchUp embeds in the model, not something you build.
PLAN_SHEET_PREFIX = 'Plan_Lie_Nielson_Boggs'


def q(tag):
    return f'c:{tag}'


# ---------- formatting ----------

def to_frac(x):
    sixteenths = round(x * 16)
    whole, rem = divmod(sixteenths, 16)
    if rem == 0:
        return f'{whole}"'
    fr = Fraction(rem, 16)
    return f'{whole}-{fr.numerator}/{fr.denominator}"' if whole else f'{fr.numerator}/{fr.denominator}"'


def fmt(v):
    return f"{v:.3f}".rstrip('0').rstrip('.')


# ---------- vector / matrix helpers ----------

def vsub(a, b): return (a[0]-b[0], a[1]-b[1], a[2]-b[2])
def vdot(a, b): return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]
def vcross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def vnorm(a):
    n = math.sqrt(vdot(a, a))
    return (a[0]/n, a[1]/n, a[2]/n) if n > 1e-12 else (1.0, 0.0, 0.0)


def normalize(v):
    n = (v[0]**2 + v[1]**2 + v[2]**2) ** 0.5
    return (v[0]/n, v[1]/n, v[2]/n) if n > 1e-9 else (0, 0, 0)


def mat_vec3(m, v):
    return tuple(sum(m[i][j]*v[j] for j in range(3)) for i in range(3))


IDENTITY4 = (1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)


def mat_mul(a, b):
    # 4x4 row-major matrices as flat 16-tuples
    r = [0]*16
    for i in range(4):
        for j in range(4):
            r[i*4+j] = sum(a[i*4+k]*b[k*4+j] for k in range(4))
    return tuple(r)


def apply_matrix(m, p):
    x, y, z = p
    return (
        m[0]*x+m[1]*y+m[2]*z+m[3],
        m[4]*x+m[5]*y+m[6]*z+m[7],
        m[8]*x+m[9]*y+m[10]*z+m[11],
    )


def apply_rotation(m, v):
    # transform a direction vector (ignore translation)
    x, y, z = v
    return (
        m[0]*x+m[1]*y+m[2]*z,
        m[4]*x+m[5]*y+m[6]*z,
        m[8]*x+m[9]*y+m[10]*z,
    )


def to_yup(p, up='Z_UP'):
    # SketchUp (and most COLLADA) is Z-up; OBJ/three.js are Y-up. Files that
    # declare <up_axis>Y_UP</up_axis> are already Y-up.
    if up == 'Y_UP':
        return tuple(p)
    x, y, z = p
    return (x, z, -y)


def read_up_axis(root):
    el = root.find(f'{q("asset")}/{q("up_axis")}', NS)
    return 'Y_UP' if el is not None and (el.text or '').strip().upper() == 'Y_UP' else 'Z_UP'


# ---------- oriented bounding boxes ----------

def power_iteration(m, seed, iterations=60):
    v = seed
    for _ in range(iterations):
        v = vnorm(mat_vec3(m, v))
    return v, vdot(v, mat_vec3(m, v))


def principal_axes(points):
    # Oriented-bounding-box axes via PCA (power iteration + deflation on the
    # 3x3 covariance matrix). Needed because some parts in this file were
    # authored pre-rotated directly in their own local mesh coordinates, so a
    # naive axis-aligned local bbox measures the diagonal footprint instead of
    # the true board dimensions.
    n = len(points)
    centroid = tuple(sum(p[k] for p in points) / n for k in range(3))
    cov = [[0.0]*3 for _ in range(3)]
    for p in points:
        d = vsub(p, centroid)
        for i in range(3):
            for j in range(3):
                cov[i][j] += d[i]*d[j] / n

    v1, e1 = power_iteration(cov, (1.0, 0.6, 0.2))
    cov2 = [[cov[i][j] - e1*v1[i]*v1[j] for j in range(3)] for i in range(3)]
    v2, _ = power_iteration(cov2, (0.2, 1.0, 0.6))
    v2 = vnorm(vsub(v2, tuple(vdot(v1, v2)*x for x in v1)))  # re-orthogonalize
    v3 = vcross(v1, v2)
    return centroid, (v1, v2, v3)


def fit_box(positions):
    """Returns (extents, local_center, local_axes) for a mesh's vertices."""
    if not positions:
        return (0, 0, 0), (0, 0, 0), ((1, 0, 0), (0, 1, 0), (0, 0, 1))
    lo = [min(p[k] for p in positions) for k in range(3)]
    hi = [max(p[k] for p in positions) for k in range(3)]
    aabb_ext = tuple(hi[k] - lo[k] for k in range(3))
    aabb_center = tuple((hi[k] + lo[k]) / 2 for k in range(3))
    aabb_vol = aabb_ext[0] * aabb_ext[1] * aabb_ext[2]

    centroid, axes = principal_axes(positions)
    proj = [[vdot(vsub(p, centroid), ax) for p in positions] for ax in axes]
    pca_ext = tuple(max(pr) - min(pr) for pr in proj)
    pca_vol = pca_ext[0] * pca_ext[1] * pca_ext[2]

    # Only trust the PCA orientation when it's a meaningfully tighter fit
    # (i.e. the part is genuinely rotated in its own local mesh data).
    # Otherwise PCA noise on axis-aligned-but-detailed parts (chamfers,
    # mortises) can nudge a perfectly good axis-aligned box off true.
    if pca_vol < aabb_vol * 0.92:
        mids = tuple((max(pr) + min(pr)) / 2 for pr in proj)
        center = tuple(centroid[k] + sum(mids[a] * axes[a][k] for a in range(3)) for k in range(3))
        return pca_ext, center, axes
    return aabb_ext, aabb_center, ((1, 0, 0), (0, 1, 0), (0, 0, 1))


# ---------- compound angles ----------

CARDINALS = {
    '+Y (vertical)': (0, 1, 0), '-Y (vertical)': (0, -1, 0),
    '+X': (1, 0, 0), '-X': (-1, 0, 0),
    '+Z': (0, 0, 1), '-Z': (0, 0, -1),
}


def compute_axis_angle(d):
    # Finds the nearest cardinal (world, Y-up) axis to direction d, then reports
    # the total lean off that axis plus its two orthogonal components - the two
    # numbers you'd dial into a bevel gauge / angle jig in the shop.
    #
    # Components are named by the world axis they tilt toward ('x', 'z',
    # 'vertical'), not 'side-to-side' / 'front-to-back': which of X/Z is the
    # front of the piece depends on how the model was drawn. The viewer maps
    # axes to shop terms per model (viewer/model.json "axisNames").
    best_name, best_dot = None, -2
    for name, axis in CARDINALS.items():
        dot = d[0]*axis[0] + d[1]*axis[1] + d[2]*axis[2]
        if dot > best_dot:
            best_dot, best_name = dot, name
    best_dot = max(-1.0, min(1.0, best_dot))
    total_deg = math.degrees(math.acos(best_dot))
    if total_deg < 0.5:
        return None  # essentially square to the world axes, no angle to call out
    if 'Y' in best_name:
        comp = [('x', math.degrees(math.atan2(d[0], abs(d[1])))),
                ('z', math.degrees(math.atan2(d[2], abs(d[1]))))]
    elif 'X' in best_name:
        comp = [('vertical', math.degrees(math.atan2(d[1], abs(d[0])))),
                ('z', math.degrees(math.atan2(d[2], abs(d[0]))))]
    else:
        comp = [('x', math.degrees(math.atan2(d[0], abs(d[2])))),
                ('vertical', math.degrees(math.atan2(d[1], abs(d[2]))))]
    return dict(
        reference=best_name,
        total_deg=round(total_deg, 1),
        components=[{'label': lbl, 'deg': round(v, 1)} for lbl, v in comp],
    )


# ---------- COLLADA reading ----------

def add_area(material_area, symbol, positions, faces):
    """Adds the faces' surface area to material_area[symbol]."""
    if not symbol:
        return
    total = 0.0
    for a, b, c in faces:
        pa, pb, pc = positions[a], positions[b], positions[c]
        u = (pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2])
        v = (pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2])
        cx, cy, cz = u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]
        total += math.sqrt(cx * cx + cy * cy + cz * cz) / 2
    material_area[symbol] = material_area.get(symbol, 0.0) + total


def load_geometries(root, scale=1.0):
    """id -> dict(positions, faces, bbox, local_center, local_axes, materials).
    Positions are multiplied by `scale` (file units -> inches)."""
    geoms = {}
    for g in root.findall(f'.//{q("library_geometries")}/{q("geometry")}', NS):
        gid = g.get('id')
        mesh = g.find(q('mesh'), NS)
        if mesh is None:
            continue
        sources = {}
        for src in mesh.findall(q('source'), NS):
            farr = src.find(q('float_array'), NS)
            if farr is None or not farr.text:
                continue
            vals = [float(x) for x in farr.text.split()]
            acc = src.find(f'{q("technique_common")}/{q("accessor")}', NS)
            stride = int(acc.get('stride')) if acc is not None and acc.get('stride') else 3
            sources[src.get('id')] = [tuple(vals[i:i+stride]) for i in range(0, len(vals), stride)]

        pos_src_id = None
        vtx = mesh.find(q('vertices'), NS)
        if vtx is not None:
            for inp in vtx.findall(q('input'), NS):
                if inp.get('semantic') == 'POSITION':
                    pos_src_id = inp.get('source').lstrip('#')
        positions = [tuple(v * scale for v in p[:3]) for p in sources.get(pos_src_id, [])]

        # gather faces from triangles / polylist, indexing the VERTEX input
        faces = []
        materials_used = set()
        material_area = {}  # material symbol -> surface area it covers (pick_material)
        for prim in list(mesh.findall(q('triangles'), NS)) + list(mesh.findall(q('polylist'), NS)):
            if prim.get('material'):
                materials_used.add(prim.get('material'))
            first_face = len(faces)
            inputs = prim.findall(q('input'), NS)
            stride = len(set(i.get('offset') for i in inputs)) or 1
            vertex_offset = next((int(i.get('offset')) for i in inputs if i.get('semantic') == 'VERTEX'), 0)
            p = prim.find(q('p'), NS)
            if p is None or not p.text:
                continue
            idx = [int(x) for x in p.text.split()]
            vcount_el = prim.find(q('vcount'), NS)
            if vcount_el is not None and vcount_el.text:
                # polylist: fan-triangulate each polygon
                pos = 0
                for vc in (int(x) for x in vcount_el.text.split()):
                    verts = [idx[(pos+k)*stride + vertex_offset] for k in range(vc)]
                    pos += vc
                    for k in range(1, vc-1):
                        faces.append((verts[0], verts[k], verts[k+1]))
            else:
                n = len(idx) // stride
                for t in range(0, n - n % 3, 3):
                    faces.append(tuple(idx[(t+k)*stride + vertex_offset] for k in range(3)))
            add_area(material_area, prim.get('material'), positions, faces[first_face:])
        # <polygons>: one <p> per polygon (used by some non-SketchUp exporters)
        for prim in mesh.findall(q('polygons'), NS):
            if prim.get('material'):
                materials_used.add(prim.get('material'))
            first_face = len(faces)
            inputs = prim.findall(q('input'), NS)
            stride = len(set(i.get('offset') for i in inputs)) or 1
            vertex_offset = next((int(i.get('offset')) for i in inputs if i.get('semantic') == 'VERTEX'), 0)
            for p in prim.findall(q('p'), NS):
                idx = [int(x) for x in (p.text or '').split()]
                verts = [idx[k*stride + vertex_offset] for k in range(len(idx) // stride)]
                for k in range(1, len(verts)-1):
                    faces.append((verts[0], verts[k], verts[k+1]))
            add_area(material_area, prim.get('material'), positions, faces[first_face:])

        bbox, local_center, local_axes = fit_box(positions)
        geoms[gid] = dict(positions=positions, faces=faces, bbox=bbox, local_center=local_center,
                          local_axes=local_axes, materials=materials_used, material_area=material_area)
    return geoms


def load_materials(root):
    """material id -> dict(name, color, image)"""
    image_by_id = {}
    for im in root.findall(f'.//{q("library_images")}/{q("image")}', NS):
        init = im.find(q('init_from'), NS)
        image_by_id[im.get('id')] = init.text if init is not None else None

    effect_diffuse = {}
    for eff in root.findall(f'.//{q("library_effects")}/{q("effect")}', NS):
        color = tex_image = None
        diffuse = eff.find(f'.//{q("diffuse")}', NS)
        if diffuse is not None:
            c = diffuse.find(q('color'), NS)
            t = diffuse.find(q('texture'), NS)
            if c is not None:
                color = tuple(float(x) for x in c.text.split())
            if t is not None:
                # texture -> newparam sampler2D -> surface -> image id
                params = {np_el.get('sid'): np_el for np_el in eff.findall(f'.//{q("newparam")}', NS)}
                samp = params.get(t.get('texture'))
                src = samp.find(f'{q("sampler2D")}/{q("source")}', NS) if samp is not None else None
                surf = params.get(src.text) if src is not None else None
                init = surf.find(f'{q("surface")}/{q("init_from")}', NS) if surf is not None else None
                if init is not None:
                    tex_image = image_by_id.get(init.text)
        effect_diffuse[eff.get('id')] = dict(color=color, image=tex_image)

    material_info = {}
    for m in root.findall(f'.//{q("library_materials")}/{q("material")}', NS):
        inst_eff = m.find(q('instance_effect'), NS)
        eff = effect_diffuse.get(inst_eff.get('url').lstrip('#') if inst_eff is not None else None, {})
        material_info[m.get('id')] = dict(name=m.get('name'), color=eff.get('color'), image=eff.get('image'))
    return material_info


INCH_IN_METERS = 0.0254


def read_unit_scale(root):
    """Factor converting the file's length unit to inches, from
    <asset><unit meter="...">. SketchUp writes inches (meter="0.0254"); a
    file that doesn't say is in metres, per the COLLADA spec."""
    unit = root.find(f'{q("asset")}/{q("unit")}', NS)
    try:
        meter = float(unit.get('meter')) if unit is not None and unit.get('meter') else 1.0
    except (TypeError, ValueError):
        meter = 1.0
    return meter / INCH_IN_METERS if meter > 0 else 1.0


def rotation4(axis, deg):
    x, y, z = normalize(axis) if any(axis) else (1.0, 0.0, 0.0)
    a = math.radians(deg)
    c, s_, t = math.cos(a), math.sin(a), 1 - math.cos(a)
    return (t*x*x + c, t*x*y - s_*z, t*x*z + s_*y, 0,
            t*x*y + s_*z, t*y*y + c, t*y*z - s_*x, 0,
            t*x*z - s_*y, t*y*z + s_*x, t*z*z + c, 0,
            0, 0, 0, 1)


def parse_matrix(node, scale=1.0):
    """The node's local transform: its <matrix>, <translate>, <rotate> and
    <scale> elements composed in document order. Translations are converted to
    inches with `scale`."""
    m = IDENTITY4
    for el in node:
        tag = el.tag.split('}')[-1]
        if tag not in ('matrix', 'translate', 'rotate', 'scale'):
            continue
        vals = [float(x) for x in (el.text or '').split()]
        if tag == 'matrix' and len(vals) == 16:
            vals[3] *= scale; vals[7] *= scale; vals[11] *= scale  # translation -> inches
            m = mat_mul(m, tuple(vals))
        elif tag == 'translate' and len(vals) == 3:
            m = mat_mul(m, (1, 0, 0, vals[0]*scale, 0, 1, 0, vals[1]*scale, 0, 0, 1, vals[2]*scale, 0, 0, 0, 1))
        elif tag == 'rotate' and len(vals) == 4:
            m = mat_mul(m, rotation4(vals[:3], vals[3]))
        elif tag == 'scale' and len(vals) == 3:
            m = mat_mul(m, (vals[0], 0, 0, 0, 0, vals[1], 0, 0, 0, 0, vals[2], 0, 0, 0, 0, 1))
    return m


def get_material_bindings(instance_geometry_el):
    bindings = {}
    bm = instance_geometry_el.find(q('bind_material'), NS)
    if bm is not None:
        for im in bm.findall(f'.//{q("instance_material")}', NS):
            bindings[im.get('symbol')] = im.get('target').lstrip('#')
    return bindings


def resolve_instances(root, scale=1.0):
    """Walks the scene graph; one dict per placed geometry:
    label, path, top_group, geom_id, world_matrix, material_bindings."""
    lib_nodes_by_id = {}
    lib_nodes_root = root.find(f'.//{q("library_nodes")}', NS)
    if lib_nodes_root is not None:
        for n in lib_nodes_root.iter():
            if n.tag.split('}')[-1] == 'node' and n.get('id'):
                lib_nodes_by_id[n.get('id')] = n

    # skinned meshes: <instance_controller> -> controller/skin -> its source
    # geometry, placed in its bind (rest) pose
    controllers = {}
    for c in root.findall(f'.//{q("library_controllers")}/{q("controller")}', NS):
        skin = c.find(q('skin'), NS)
        if skin is not None and skin.get('source'):
            bsm = skin.find(q('bind_shape_matrix'), NS)
            vals = [float(x) for x in bsm.text.split()] if bsm is not None and bsm.text else []
            if len(vals) == 16:
                vals[3] *= scale; vals[7] *= scale; vals[11] *= scale
            controllers[c.get('id')] = (skin.get('source').lstrip('#'), tuple(vals) if len(vals) == 16 else IDENTITY4)

    instances = []

    def add_instance(el, gid, world, name_path, top_group, visit_id=None):
        label = name_path[-1] if name_path else gid
        # Exporter quirk in the shaving horse model: the "Nut_3_4"
        # component's geometry group kept a leftover internal name
        # "Head__2__6" (copy-pasted from a bolt-head mesh); the meaningful
        # authored name is the parent, so relabel this one leaf.
        if label == 'Head__2__6' and len(name_path) >= 2 and name_path[-2] == 'Nut_3_4':
            label = 'Nut_3_4'
        instances.append(dict(
            label=label,
            path='/'.join(name_path) if name_path else gid,
            top_group=top_group or (name_path[0] if name_path else gid),
            geom_id=gid,
            world_matrix=world,
            material_bindings=get_material_bindings(el),
            visit=visit_id,
        ))

    visits = [0]

    def visit(node, parent_matrix, name_path, top_group):
        world = mat_mul(parent_matrix, parse_matrix(node, scale))
        name = node.get('name') or node.get('id')
        # SketchUp wraps component instances in anonymous "SketchUp_Instance_N"
        # nodes; skip those so the part keeps its component's real name.
        if not re.match(r'^SketchUp_Instance_\d+$', name or ''):
            name_path = name_path + [name]
            if top_group is None:
                top_group = name

        visits[0] += 1
        for ig in node.findall(q('instance_geometry'), NS):
            add_instance(ig, ig.get('url').lstrip('#'), world, name_path, top_group, visits[0])
        for ic in node.findall(q('instance_controller'), NS):
            ctrl = controllers.get(ic.get('url').lstrip('#'))
            if ctrl:
                add_instance(ic, ctrl[0], mat_mul(world, ctrl[1]), name_path, top_group)

        for inode in node.findall(q('instance_node'), NS):
            target = lib_nodes_by_id.get(inode.get('url').lstrip('#'))
            if target is not None:
                visit(target, world, name_path, top_group)

        for child in node.findall(q('node'), NS):
            visit(child, world, name_path, top_group)

    vs = root.find(f'.//{q("library_visual_scenes")}/{q("visual_scene")}', NS)
    roots = vs.findall(q('node'), NS) if vs is not None else []
    if len(roots) == 1 and roots[0].find(q('instance_geometry'), NS) is None and roots[0].find(q('instance_controller'), NS) is None:
        # SketchUp wraps everything in one "SketchUp" root node: its children
        # are the model's top-level groups
        top = roots[0]
        for child in top.findall(q('node'), NS):
            visit(child, parse_matrix(top, scale), [], None)
    else:
        for node in roots:
            visit(node, IDENTITY4, [], None)
    return instances


# ---------- one part per physical piece ----------

def vkey(p):
    # vertex position quantised to 1/10000" (same arithmetic as the JS port)
    return (math.floor(p[0] * 10000 + 0.5), math.floor(p[1] * 10000 + 0.5), math.floor(p[2] * 10000 + 0.5))


def mesh_topology(geo):
    """(vertex keys used by faces, closed?) for a geometry. Closed = every
    edge is shared by at least two distinct triangles (a solid), as opposed
    to a loose face or an open shell. Back-to-back duplicate triangles
    (double-sided faces) count once."""
    if 'vkeys' not in geo:
        keys = [vkey(p) for p in geo['positions']]
        tris = set()
        edges = {}
        for f in geo['faces']:
            a, b, c = keys[f[0]], keys[f[1]], keys[f[2]]
            if a == b or b == c or a == c:
                continue
            t = tuple(sorted((a, b, c)))
            if t in tris:
                continue
            tris.add(t)
            for e in ((t[0], t[1]), (t[0], t[2]), (t[1], t[2])):
                edges[e] = edges.get(e, 0) + 1
        geo['vkeys'] = {v for t in tris for v in t}
        geo['closed'] = bool(edges) and all(n >= 2 for n in edges.values())
    return geo['vkeys'], geo['closed']


def merge_open_shells(instances, geoms):
    """Newer SketchUp versions export one board as several meshes - one per
    face material (end grain painted differently), or as loose faces. Open
    meshes in the same group that touch are merged back into one part when
    together they still form a tight box (a board and its end faces, a board
    and its tenon), but not when they're separate boards drawn touching (a
    rail butting into a leg: the combined box would be far bigger than the
    two). Closed meshes (a dowel in a hole, a complete board) stay separate."""
    by_visit = {}
    for i, inst in enumerate(instances):
        geo = geoms.get(inst['geom_id'])
        if inst.get('visit') is not None and geo and geo['faces']:
            by_visit.setdefault(inst['visit'], []).append(i)
    drop = set()
    for idxs in by_visit.values():
        open_idx = [i for i in idxs if not mesh_topology(geoms[instances[i]['geom_id']])[1]]
        if len(open_idx) < 2:
            continue
        # boxes here are axis-aligned in the group's own frame (all siblings share it)
        comps = []
        for i in open_idx:
            g = geoms[instances[i]['geom_id']]
            pos = g['positions']
            lo = tuple(min(p[k] for p in pos) for k in range(3))
            hi = tuple(max(p[k] for p in pos) for k in range(3))
            comps.append(dict(members=[i], vkeys=set(mesh_topology(g)[0]), lo=lo, hi=hi,
                              flat=min(g['bbox']) < 1 / 64))

        def vol(lo, hi):
            return (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])

        def join(a, b):
            ca, cb = comps[a], comps[b]
            return dict(members=sorted(ca['members'] + cb['members']), vkeys=ca['vkeys'] | cb['vkeys'],
                        lo=tuple(min(ca['lo'][k], cb['lo'][k]) for k in range(3)),
                        hi=tuple(max(ca['hi'][k], cb['hi'][k]) for k in range(3)),
                        flat=ca['flat'] and cb['flat'])

        # loose flat faces that touch are one surface (e.g. a board drawn as faces)
        a = 0
        while a < len(comps):
            b = a + 1
            while b < len(comps):
                if comps[a]['flat'] and comps[b]['flat'] and not comps[a]['vkeys'].isdisjoint(comps[b]['vkeys']):
                    comps[a] = join(a, b)
                    del comps[b]
                    b = a + 1
                else:
                    b += 1
            a += 1
        # then merge touching pieces whose combined box is barely bigger than the two
        while True:
            best = None
            for a in range(len(comps)):
                for b in range(a + 1, len(comps)):
                    ca, cb = comps[a], comps[b]
                    if ca['vkeys'].isdisjoint(cb['vkeys']):
                        continue
                    lo = tuple(min(ca['lo'][k], cb['lo'][k]) for k in range(3))
                    hi = tuple(max(ca['hi'][k], cb['hi'][k]) for k in range(3))
                    ratio = vol(lo, hi) / (vol(ca['lo'], ca['hi']) + vol(cb['lo'], cb['hi']) + 1e-9)
                    if ratio <= 1.15 and (best is None or ratio < best[0]):
                        best = (ratio, a, b)
            if best is None:
                break
            _, a, b = best
            comps[a] = join(a, b)
            del comps[b]

        for comp in comps:
            members = comp['members']
            if len(members) < 2:
                continue
            gid = '+'.join(instances[m]['geom_id'] for m in members)
            if gid not in geoms:
                positions, faces, mats = [], [], set()
                for m in members:
                    g = geoms[instances[m]['geom_id']]
                    off = len(positions)
                    positions.extend(g['positions'])
                    faces.extend((a + off, b + off, c + off) for a, b, c in g['faces'])
                    mats |= g['materials']
                bbox, local_center, local_axes = fit_box(positions)
                geoms[gid] = dict(positions=positions, faces=faces, bbox=bbox, local_center=local_center,
                                  local_axes=local_axes, materials=mats)
            # the merged part takes the material covering most of it
            dominant = max(members, key=lambda m: len(geoms[instances[m]['geom_id']]['faces']))
            geoms[gid]['material_area'] = geoms[instances[dominant]['geom_id']].get('material_area', {})
            first = instances[members[0]]
            first['material_bindings'] = instances[dominant]['material_bindings']
            first['geom_id'] = gid
            drop.update(members[1:])
    return [inst for i, inst in enumerate(instances) if i not in drop]


# Names SketchUp and other tools give things nobody named: group_12,
# Component#3, instance_9, ID245, SketchUp's solid-tool results...
GENERIC_NAME = re.compile(
    r'^(?:group|component|instance|mesh|object|geometry|node|id|sketchup|difference|outershell|union|'
    r'intersection|trim|split|solid|untitled|default)?[\s_#.-]*\d*$', re.IGNORECASE)


def is_generic_name(name):
    return bool(GENERIC_NAME.match(name or ''))


def is_round(geo):
    """A turned/round part (dowel, rod): its sides face many directions
    around the length axis rather than 4 (square) or 6 (hex)."""
    ext = geo['bbox']
    a = geo['local_axes'][max(range(3), key=lambda k: ext[k])]
    dirs = set()
    pos = geo['positions']
    for f in geo['faces']:
        n = vcross(vsub(pos[f[1]], pos[f[0]]), vsub(pos[f[2]], pos[f[0]]))
        length = math.sqrt(vdot(n, n))
        if length < 1e-12:
            continue
        n = (n[0] / length, n[1] / length, n[2] / length)
        if abs(vdot(n, a)) > 0.2:
            continue
        k = tuple(math.floor(c * 20 + 0.5) for c in n)
        if k < tuple(-c for c in k):
            k = tuple(-c for c in k)  # a face and its back side are one direction
        dirs.add(k)
    return len(dirs) >= 6


def instance_extents(inst, geo):
    """The part's size along its own axes as placed: the mesh's box times the
    instance's scale along each axis (SketchUp components are often scaled -
    a copy stretched longer, or a whole tool scaled down)."""
    wm = inst['world_matrix']
    out = []
    for i in range(3):
        v = apply_rotation(wm, geo['local_axes'][i])
        out.append(geo['bbox'][i] * math.sqrt(vdot(v, v)))
    return tuple(out)


def shape_name(geo, ext):
    """A plain-English name for an unnamed part, from its shape (ext: its size as placed)."""
    L, W, T = sorted(ext, reverse=True)
    if T < 1 / 64:
        return 'Flat face'
    if W - T <= 0.1 * W and is_round(geo):
        return 'Dowel' if L >= 2 * W else 'Round'
    if T < 0.3:
        return 'Sheet' if W >= 4 else 'Strip'
    if W < 1.5 * T:
        return 'Square stock' if L >= 3 * W else 'Block'
    if W >= 8 and T <= 1.25:
        return 'Panel'
    if L >= 3 * W:
        return 'Board'
    return 'Block'


# ---------- outputs ----------

def is_plan_sheet(inst):
    return inst['path'].startswith(PLAN_SHEET_PREFIX)


def is_excluded_from_3d(inst):
    if is_plan_sheet(inst):
        return True
    # geometry data artifact in the shaving horse model (huge bogus bbox)
    return 'Nut_3_4' in inst['path'].split('/')


# SketchUp's name for faces left unpainted in a part whose other faces are
# painted ("material", "material_1"...)
DEFAULT_MATERIAL = re.compile(r'^material(_\d+)?$')


def pick_material(bindings, material_info, areas=None):
    """The one material a part is shown and listed with: the one covering most
    of its surface, never SketchUp's edge colours, and its unnamed default only
    if there's nothing else (a leg painted sapele with its end faces left
    unpainted is sapele)."""
    areas = areas or {}
    best = None
    for i, (sym, target) in enumerate(bindings.items()):
        name = material_info.get(target, {}).get('name') or ''
        if name.startswith('edge_color'):
            continue
        key = (1 if DEFAULT_MATERIAL.match(name) else 0, -areas.get(sym, 0.0), i)
        if best is None or key < best[0]:
            best = (key, target)
    if best:
        return best[1]
    return next(iter(bindings.values()), None)


def write_obj(instances, geoms, material_info, dae_path, out_dir, up='Z_UP'):
    """Writes scene.obj/.mtl; sets inst['safe_name'] / inst['in_obj'].
    Returns {obj material key: SketchUp material name}."""
    mat_key_to_name = {}
    seen_names = {}
    written_mtl = set()
    with open(os.path.join(out_dir, 'scene.obj'), 'w') as f, open(os.path.join(out_dir, 'scene.mtl'), 'w') as fm:
        f.write('mtllib scene.mtl\n')
        vertex_offset = 0
        for inst in instances:
            if is_excluded_from_3d(inst):
                continue
            geo = geoms.get(inst['geom_id'])
            if not geo or not geo['positions'] or not geo['faces']:
                continue
            base_name = re.sub(r'[^A-Za-z0-9_]', '_', inst['path'])[:55] or inst['geom_id']
            n = seen_names.get(base_name, 0)
            seen_names[base_name] = n + 1
            inst['safe_name'] = f"{base_name}_{n}" if n else base_name
            inst['in_obj'] = True
            f.write(f"o {inst['safe_name']}\n")
            wm = inst['world_matrix']
            for p in geo['positions']:
                wp = to_yup(apply_matrix(wm, p), up)
                f.write(f"v {wp[0]:.5f} {wp[1]:.5f} {wp[2]:.5f}\n")

            mat_target = pick_material(inst['material_bindings'], material_info, geo.get('material_area'))
            mat_key = mat_target or 'default'
            info = material_info.get(mat_target, {})
            mat_key_to_name[mat_key] = info.get('name') or 'default'
            if mat_key not in written_mtl:
                written_mtl.add(mat_key)
                color = info.get('color') or (0.7, 0.55, 0.35, 1.0)
                fm.write(f"newmtl {mat_key}\n")
                fm.write(f"Kd {color[0]:.3f} {color[1]:.3f} {color[2]:.3f}\n")
                img = info.get('image')
                if img:
                    src_img_path = os.path.join(os.path.dirname(dae_path), img)
                    if os.path.exists(src_img_path):
                        local_name = os.path.basename(img)
                        dst_img_path = os.path.join(out_dir, local_name)
                        if not os.path.exists(dst_img_path):
                            shutil.copyfile(src_img_path, dst_img_path)
                        fm.write(f"map_Kd {local_name}\n")
                fm.write("\n")
            f.write(f"usemtl {mat_key}\n")
            for face in geo['faces']:
                f.write("f {} {} {}\n".format(*(vertex_offset + vi + 1 for vi in face)))
            vertex_offset += len(geo['positions'])
    return mat_key_to_name


def compute_object_dims(instances, geoms, up='Z_UP'):
    # Uses each part's true LOCAL axes (not world-aligned), since parts are rotated
    # into the assembly. Gives exact length/width/thickness + world position/direction
    # so the viewer can draw CAD-style dimension lines on the actual board faces.
    object_dims = {}
    for inst in instances:
        if not inst.get('in_obj'):
            continue
        geo = geoms.get(inst['geom_id'])
        if not geo:
            continue
        wm = inst['world_matrix']
        world_center = to_yup(apply_matrix(wm, geo['local_center']), up)
        ext = instance_extents(inst, geo)
        axes = []
        for i in range(3):
            length = ext[i]
            if length < 1e-6:
                continue
            direction = to_yup(normalize(apply_rotation(wm, geo['local_axes'][i])), up)
            axes.append(dict(direction=[round(v, 6) for v in direction], length=round(length, 4)))
        axes.sort(key=lambda a: a['length'], reverse=True)
        for i, a in enumerate(axes):
            a['role'] = ['Length', 'Width', 'Thickness'][i] if i < 3 else f'axis{i}'
            a['label'] = to_frac(a['length'])
            angle = compute_axis_angle(a['direction'])
            if angle:
                a['angle'] = angle
        object_dims[inst['safe_name']] = dict(center=[round(v, 4) for v in world_center], axes=axes)
    return object_dims


def build_report(instances, geoms, material_info):
    """Groups instances into cut-list rows keyed by (label, sorted dims)."""
    report = {}
    for inst in instances:
        if is_plan_sheet(inst):
            continue
        geo = geoms.get(inst['geom_id'])
        if not geo or not geo['faces']:
            continue  # edges/guides only (SketchUp <lines>): nothing to cut
        ext = instance_extents(inst, geo)
        dims = tuple(round(d, 3) for d in sorted(ext, reverse=True))  # L,W,T sorted desc
        mat_names = [material_info.get(t, {}).get('name') for t in inst['material_bindings'].values()]
        # unnamed parts are named by shape, so identical ones share a row
        auto = is_generic_name(inst['label'])
        label = shape_name(geo, ext) if auto else inst['label']
        # unnamed parts within 1/16" of each other are the same part to a woodworker
        key = (label, tuple(to_frac(d) for d in dims)) if auto else (label, dims)
        rep = report.setdefault(key, dict(
            label=label, top_group=inst['top_group'], dims=list(dims),
            count=0, materials=set(), paths=[], obj_names=[],
        ))
        if auto:
            rep['auto_name'] = True
        if dims[2] < 1 / 64:
            rep['flat'] = True  # a loose face with no thickness: not a piece of wood
        rep['count'] += 1
        # the material it's shown with (pick_material), so the list and the 3D view agree
        picked = material_info.get(pick_material(inst['material_bindings'], material_info, geo.get('material_area')), {}).get('name')
        if 'material' not in rep and picked and not picked.startswith('edge_color'):
            rep['material'] = picked
        rep['materials'].update(nm for nm in mat_names if nm and not nm.startswith('edge_color'))
        rep['paths'].append(inst['path'])
        if inst.get('in_obj'):
            rep['obj_names'].append(inst['safe_name'])

    rows = sorted(report.values(), key=lambda r: (r['top_group'] or '', r['label']))
    out_rows = []
    for r in rows:
        d = r['dims']
        out_rows.append({**r, 'materials': sorted(r['materials']),
                         'dims_str': f"{to_frac(d[0])} x {to_frac(d[1])} x {to_frac(d[2])}"})
    for r in out_rows:
        w = named_length_warning(r['label'], r['dims'])
        if w:
            r['warning'] = w
    apply_manual_corrections(out_rows)
    return out_rows


# whole_numerator_denominator; a lookahead so matches can overlap (in
# 'Shaft_1_2_-13_8_1_4' the thread '13_8_1' must not swallow the '8_1_4')
NAMED_LENGTH = re.compile(r'(?<![0-9])(?=(\d+)_(\d+)_(\d+)(?![0-9]))')


def named_length_warning(label, dims):
    """SketchUp component names often carry a size, e.g. 'Shaft_1_2_-13_8_1_4'
    = a 1/2"-13 rod 8-1/4" long (whole_numerator_denominator). If a name
    states a length that none of the part's measured dimensions match (to
    1/16"), the model and its name disagree - worth checking the plan."""
    named = []
    for whole, num, den in NAMED_LENGTH.findall(label):
        whole, num, den = int(whole), int(num), int(den)
        if 0 < num < den and den in (2, 4, 8, 16, 32, 64):
            named.append(whole + num / den)
    if not named:
        return None
    if any(abs(n - d) <= 1 / 16 for n in named for d in dims):
        return None
    n = max(named)
    return f'Named {to_frac(n)} in the source model but modeled {to_frac(max(dims))} long - check the plan.'


def apply_manual_corrections(rows):
    # Shaving horse model: these two hardware rows are exported as per-facet
    # hex geometry (6-12 face pieces per real fastener), not one part per
    # instance. Traced by hand: 4 rods total -> 4 bolt-head caps + 4 hex nuts.
    for r in rows:
        if r['label'] == 'Bolt_Head__6':
            r['count'] = 4
            r['dims_str'] = '3/4" hex head (fits 1/2"-13 rod)'
            r['note'] = 'source file models each head as 6 face facets; qty corrected to real fastener count'
        elif r['label'] == 'Nut_3_4':
            r['count'] = 4
            r['dims_str'] = '3/4" hex nut (fits 1/2"-13 rod)'
            r['obj_names'] = []
            r['note'] = 'source geometry for this part is corrupted (huge bogus bbox); not shown in 3D view, qty inferred from matching rod count'


# (category, words found anywhere in the name, words that must stand alone -
# short ones, so 'Washer' isn't ash and 'First' isn't fir). Includes common
# French/German/Spanish wood names; accents are ignored (Mélèze = meleze).
CATEGORY_WORDS = [
    ('Wood', ('wood', 'maple', 'walnut', 'cherry', 'birch', 'poplar', 'plywood', 'mahogany', 'beech', 'cedar',
              'spruce', 'hemlock', 'cypress', 'hickory', 'larch', 'timber', 'lumber', 'plank', 'veneer', 'bamboo',
              'ebony', 'sapele', 'padauk', 'wenge', 'bubinga', 'sycamore', 'chestnut', 'masonite', 'hardboard',
              'particleboard', 'meleze', 'melese', 'noyer', 'sapin', 'eiche', 'buche', 'ahorn', 'kiefer', 'fichte',
              'larche', 'nussbaum', 'madera', 'nogal', 'holz'),
     ('oak', 'ash', 'fir', 'pine', 'elm', 'yew', 'teak', 'alder', 'mdf', 'osb', 'bois', 'chene', 'hetre', 'erable',
      'frene', 'pin', 'roble', 'pino', 'haya', 'arce')),
    ('Hardware', ('metal', 'steel', 'brass', 'bronze', 'alumin', 'chrome', 'screw', 'bolt', 'washer', 'hinge',
                  'rivet', 'nickel', 'copper', 'titanium', 'galvani'),
     ('iron', 'zinc', 'nut', 'nail')),
    ('Leather', ('leather',), ()),
]


def guess_category(material_name):
    n = unicodedata.normalize('NFKD', material_name or '').encode('ascii', 'ignore').decode()
    n = re.sub(r'([a-z])([A-Z])', r'\1 \2', n).lower()
    tokens = set(re.split(r'[^a-z]+', n))
    for category, anywhere, alone in CATEGORY_WORDS:
        if any(w in n for w in anywhere) or any(w in tokens for w in alone):
            return category
    return 'Other'


def starter_config(dae_path, mat_key_to_name, material_info):
    """A first model.json for a newly converted model: title from the file
    name, and each material's category guessed from its name. Edit it after."""
    base = re.sub(r'([a-z])(?=[A-Z])', r'\1 ', os.path.splitext(os.path.basename(dae_path))[0])  # CamelCase -> words
    title = re.sub(r'[_\-]+', ' ', base).strip().title() or 'Model'
    materials = {}
    info_by_name = {info.get('name'): info for info in material_info.values()}
    for name in sorted(set(mat_key_to_name.values())):
        color = (info_by_name.get(name) or {}).get('color') or (0.7, 0.55, 0.35, 1)
        hexcolor = '#' + ''.join(f'{max(0, min(255, round(c * 255))):02x}' for c in color[:3])
        entry = {'category': guess_category(name), 'color': hexcolor}
        if entry['category'] == 'Wood':
            entry['texture'] = {'base': '#c9975c', 'streak': '#a06f3b', 'ring': '#8a5a2c', 'tile': 5}
            image = (info_by_name.get(name) or {}).get('image')
            if image:
                # the model's own photo of the wood (copied next to scene.obj; see write_obj)
                entry['texture']['image'] = re.sub(r'^.*[\\/]', '', image)
        materials[name] = entry
    return {
        'title': title,
        'subtitle': '',
        'axisNames': {'x': 'front-to-back', 'y': 'vertical', 'z': 'side-to-side'},
        'views': {
            'iso': {'label': '3D', 'dir': [0.7, 0.5, 0.7]},
            'front': {'label': 'Front', 'dir': [1, 0, 0]},
            'side': {'label': 'Side', 'dir': [0, 0, 1]},
            'top': {'label': 'Top', 'dir': [0, 1, 0.0001]},
        },
        'materials': materials,
        'categoryOrder': ['Wood', 'Hardware', 'Leather', 'Other'],
        'displayNames': {},
        'notes': {},
    }


def convert(dae_path, out_dir, verbose=True):
    if zipfile.is_zipfile(dae_path):
        # a 3D Warehouse "Collada File" / KMZ download: the .dae and its textures in a zip
        with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(dae_path) as z:
            daes = [i for i in z.infolist() if i.filename.lower().endswith('.dae') and not i.filename.startswith('__MACOSX/')]
            if not daes:
                raise SystemExit(f'No .dae model inside {dae_path}')
            z.extractall(tmp)
            inner = os.path.join(tmp, max(daes, key=lambda i: i.file_size).filename)
            return convert_dae(inner, out_dir, verbose, name=dae_path)
    return convert_dae(dae_path, out_dir, verbose)


def convert_dae(dae_path, out_dir, verbose=True, name=None):
    log = print if verbose else (lambda *a, **k: None)
    os.makedirs(out_dir, exist_ok=True)
    root = ET.parse(dae_path).getroot()
    use_namespace(root)
    scale = read_unit_scale(root)
    if abs(scale - 1) > 1e-9:
        log(f"Model units: {scale * INCH_IN_METERS:g} m each; converting to inches (x{scale:g})")
    geoms = load_geometries(root, scale)
    material_info = load_materials(root)
    instances = merge_open_shells(resolve_instances(root, scale), geoms)
    log(f"Resolved {len(instances)} parts")

    up = read_up_axis(root)
    mat_key_to_name = write_obj(instances, geoms, material_info, dae_path, out_dir, up)
    log(f"Wrote {os.path.join(out_dir, 'scene.obj')} and scene.mtl")
    with open(os.path.join(out_dir, 'materials.json'), 'w') as jf:
        json.dump(mat_key_to_name, jf, indent=2)
    config_path = os.path.join(out_dir, 'model.json')
    if not os.path.exists(config_path):
        with open(config_path, 'w') as jf:
            json.dump(starter_config(name or dae_path, mat_key_to_name, material_info), jf, indent=2)
        log(f"Wrote a starter {config_path} - edit the title, part names, materials and axisNames")

    object_dims = compute_object_dims(instances, geoms, up)
    with open(os.path.join(out_dir, 'object_dims.json'), 'w') as jf:
        json.dump(object_dims, jf, indent=2)
    log(f"Wrote object_dims.json ({len(object_dims)} objects)")

    rows = build_report(instances, geoms, material_info)
    with open(os.path.join(out_dir, 'parts_report.json'), 'w') as jf:
        json.dump(rows, jf, indent=2)

    log("\n==== PARTS REPORT (label | top_group | qty | dims LxWxT in | materials) ====")
    for r in rows:
        d = r['dims']
        log(f"{r['label']:<28} | {str(r['top_group']):<16} | qty={r['count']:<3} | "
            f"{fmt(d[0])} x {fmt(d[1])} x {fmt(d[2])} in | {', '.join(r['materials']) or '-'}")
    log(f"\nWrote parts_report.json ({len(rows)} rows)")
    return rows


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('dae', nargs='?', default=os.environ.get('WOODMODELS_DAE'),
                    help='SketchUp COLLADA export .dae, or a 3D Warehouse Collada .zip / .kmz (or set WOODMODELS_DAE)')
    ap.add_argument('-o', '--out', default=os.path.join(here, 'viewer'),
                    help='output directory (default: the viewer/ folder next to this script)')
    ap.add_argument('-q', '--quiet', action='store_true')
    args = ap.parse_args(argv)
    if not args.dae:
        ap.error('pass the path to a .dae file (or set WOODMODELS_DAE)')
    if not os.path.exists(args.dae):
        ap.error(f'no such file: {args.dae}')
    convert(args.dae, args.out, verbose=not args.quiet)


if __name__ == '__main__':
    sys.exit(main())

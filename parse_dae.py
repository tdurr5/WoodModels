"""Turn a SketchUp COLLADA (.dae) export into the cut-list viewer's data files.

    python3 parse_dae.py path/to/model.dae -o viewer/

Writes into the output directory:
  scene.obj / scene.mtl  geometry, one OBJ object per part instance (Y-up)
  materials.json         OBJ material id -> SketchUp material name
  object_dims.json       per-instance oriented length/width/thickness axes
  parts_report.json      the cut list: one row per distinct part, with qty

Standard library only. Units are whatever the model was drawn in (inches for
the shaving horse); nothing is converted.
"""
import argparse
import json
import math
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET
from fractions import Fraction

NS = {'c': 'http://www.collada.org/2005/11/COLLADASchema'}

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


def to_yup(p):
    # source data is Z-up (SketchUp/COLLADA convention); OBJ/three.js default to Y-up
    x, y, z = p
    return (x, z, -y)


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
        for prim in list(mesh.findall(q('triangles'), NS)) + list(mesh.findall(q('polylist'), NS)):
            if prim.get('material'):
                materials_used.add(prim.get('material'))
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

        bbox, local_center, local_axes = fit_box(positions)
        geoms[gid] = dict(positions=positions, faces=faces, bbox=bbox, local_center=local_center,
                          local_axes=local_axes, materials=materials_used)
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
    <asset><unit meter="...">. SketchUp writes inches (meter="0.0254"); if a
    file doesn't say, assume inches too, as this script always has."""
    unit = root.find(f'{q("asset")}/{q("unit")}', NS)
    try:
        meter = float(unit.get('meter')) if unit is not None else INCH_IN_METERS
    except (TypeError, ValueError):
        meter = INCH_IN_METERS
    return meter / INCH_IN_METERS if meter > 0 else 1.0


def parse_matrix(node, scale=1.0):
    mel = node.find(q('matrix'), NS)
    if mel is not None and mel.text:
        vals = [float(x) for x in mel.text.split()]
        if len(vals) == 16:
            vals[3] *= scale; vals[7] *= scale; vals[11] *= scale  # translation -> inches
            return tuple(vals)
    return IDENTITY4


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
        for n in lib_nodes_root.iter(f'{{{NS["c"]}}}node'):
            if n.get('id'):
                lib_nodes_by_id[n.get('id')] = n

    instances = []

    def visit(node, parent_matrix, name_path, top_group):
        world = mat_mul(parent_matrix, parse_matrix(node, scale))
        name = node.get('name') or node.get('id')
        # SketchUp wraps component instances in anonymous "SketchUp_Instance_N"
        # nodes; skip those so the part keeps its component's real name.
        if not re.match(r'^SketchUp_Instance_\d+$', name or ''):
            name_path = name_path + [name]
            if top_group is None:
                top_group = name

        ig = node.find(q('instance_geometry'), NS)
        if ig is not None:
            gid = ig.get('url').lstrip('#')
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
                material_bindings=get_material_bindings(ig),
            ))

        inode = node.find(q('instance_node'), NS)
        if inode is not None:
            target = lib_nodes_by_id.get(inode.get('url').lstrip('#'))
            if target is not None:
                visit(target, world, name_path, top_group)

        for child in node.findall(q('node'), NS):
            visit(child, world, name_path, top_group)

    vs = root.find(f'.//{q("library_visual_scenes")}/{q("visual_scene")}', NS)
    top = vs.find(q('node'), NS)  # the single "SketchUp" root node
    for child in top.findall(q('node'), NS):
        visit(child, IDENTITY4, [], None)
    return instances


# ---------- outputs ----------

def is_plan_sheet(inst):
    return inst['path'].startswith(PLAN_SHEET_PREFIX)


def is_excluded_from_3d(inst):
    if is_plan_sheet(inst):
        return True
    # geometry data artifact in the shaving horse model (huge bogus bbox)
    return 'Nut_3_4' in inst['path'].split('/')


def pick_material(bindings, material_info):
    # prefer the first bound material that isn't one of SketchUp's edge colors
    for target in bindings.values():
        if not (material_info.get(target, {}).get('name') or '').startswith('edge_color'):
            return target
    return next(iter(bindings.values()), None)


def write_obj(instances, geoms, material_info, dae_path, out_dir):
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
                wp = to_yup(apply_matrix(wm, p))
                f.write(f"v {wp[0]:.5f} {wp[1]:.5f} {wp[2]:.5f}\n")

            mat_target = pick_material(inst['material_bindings'], material_info)
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


def compute_object_dims(instances, geoms):
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
        world_center = to_yup(apply_matrix(wm, geo['local_center']))
        axes = []
        for i in range(3):
            length = geo['bbox'][i]
            if length < 1e-6:
                continue
            direction = to_yup(normalize(apply_rotation(wm, geo['local_axes'][i])))
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
        if not geo:
            continue
        dims = tuple(round(d, 3) for d in sorted(geo['bbox'], reverse=True))  # L,W,T sorted desc
        mat_names = [material_info.get(t, {}).get('name') for t in inst['material_bindings'].values()]
        rep = report.setdefault((inst['label'], dims), dict(
            label=inst['label'], top_group=inst['top_group'], dims=list(dims),
            count=0, materials=set(), paths=[], obj_names=[],
        ))
        rep['count'] += 1
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


CATEGORY_WORDS = [
    ('Wood', ('wood', 'oak', 'maple', 'walnut', 'cherry', 'ash', 'pine', 'birch', 'poplar', 'plywood', 'mahogany', 'beech', 'cedar', 'fir')),
    ('Hardware', ('metal', 'steel', 'iron', 'brass', 'bronze', 'alumin', 'chrome', 'zinc', 'bolt', 'screw')),
    ('Leather', ('leather',)),
]


def guess_category(material_name):
    n = (material_name or '').lower()
    for category, words in CATEGORY_WORDS:
        if any(w in n for w in words):
            return category
    return 'Other'


def starter_config(dae_path, mat_key_to_name, material_info):
    """A first model.json for a newly converted model: title from the file
    name, and each material's category guessed from its name. Edit it after."""
    title = re.sub(r'[_\-]+', ' ', os.path.splitext(os.path.basename(dae_path))[0]).strip().title() or 'Model'
    materials = {}
    info_by_name = {info.get('name'): info for info in material_info.values()}
    for name in sorted(set(mat_key_to_name.values())):
        color = (info_by_name.get(name) or {}).get('color') or (0.7, 0.55, 0.35, 1)
        hexcolor = '#' + ''.join(f'{max(0, min(255, round(c * 255))):02x}' for c in color[:3])
        entry = {'category': guess_category(name), 'color': hexcolor}
        if entry['category'] == 'Wood':
            entry['texture'] = {'base': '#c9975c', 'streak': '#a06f3b', 'ring': '#8a5a2c', 'tile': 5}
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
    log = print if verbose else (lambda *a, **k: None)
    os.makedirs(out_dir, exist_ok=True)
    root = ET.parse(dae_path).getroot()
    scale = read_unit_scale(root)
    if abs(scale - 1) > 1e-9:
        log(f"Model units: {scale * INCH_IN_METERS:g} m each; converting to inches (x{scale:g})")
    geoms = load_geometries(root, scale)
    material_info = load_materials(root)
    instances = resolve_instances(root, scale)
    log(f"Resolved {len(instances)} geometry instances")

    mat_key_to_name = write_obj(instances, geoms, material_info, dae_path, out_dir)
    log(f"Wrote {os.path.join(out_dir, 'scene.obj')} and scene.mtl")
    with open(os.path.join(out_dir, 'materials.json'), 'w') as jf:
        json.dump(mat_key_to_name, jf, indent=2)
    config_path = os.path.join(out_dir, 'model.json')
    if not os.path.exists(config_path):
        with open(config_path, 'w') as jf:
            json.dump(starter_config(dae_path, mat_key_to_name, material_info), jf, indent=2)
        log(f"Wrote a starter {config_path} - edit the title, part names, materials and axisNames")

    object_dims = compute_object_dims(instances, geoms)
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
                    help='SketchUp COLLADA export (or set WOODMODELS_DAE); textures are read relative to it')
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

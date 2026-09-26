import xml.etree.ElementTree as ET
import os, json, re, math
from fractions import Fraction

def to_frac(x):
    sixteenths = round(x * 16)
    whole, rem = divmod(sixteenths, 16)
    if rem == 0:
        return f'{whole}"'
    fr = Fraction(rem, 16)
    return f'{whole}-{fr.numerator}/{fr.denominator}"' if whole else f'{fr.numerator}/{fr.denominator}"'

CARDINALS = {
    '+Y (vertical)': (0, 1, 0), '-Y (vertical)': (0, -1, 0),
    '+X': (1, 0, 0), '-X': (-1, 0, 0),
    '+Z': (0, 0, 1), '-Z': (0, 0, -1),
}

def compute_axis_angle(d):
    # Finds the nearest cardinal (world) axis to direction d, then reports the
    # total lean off that axis plus its two orthogonal components - i.e. the
    # two numbers you'd actually dial into a bevel gauge / angle jig in the shop.
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
        comp = [
            ('side-to-side', math.degrees(math.atan2(d[0], abs(d[1])))),
            ('front-to-back', math.degrees(math.atan2(d[2], abs(d[1])))),
        ]
    elif 'X' in best_name:
        comp = [
            ('vertical', math.degrees(math.atan2(d[1], abs(d[0])))),
            ('front-to-back', math.degrees(math.atan2(d[2], abs(d[0])))),
        ]
    else:
        comp = [
            ('side-to-side', math.degrees(math.atan2(d[0], abs(d[2])))),
            ('vertical', math.degrees(math.atan2(d[1], abs(d[2])))),
        ]
    return dict(
        reference=best_name,
        total_deg=round(total_deg, 1),
        components=[{'label': lbl, 'deg': round(v, 1)} for lbl, v in comp],
    )

def vsub(a, b): return (a[0]-b[0], a[1]-b[1], a[2]-b[2])
def vdot(a, b): return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]
def vcross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
def vnorm(a):
    n = math.sqrt(vdot(a, a))
    return (a[0]/n, a[1]/n, a[2]/n) if n > 1e-12 else (1.0, 0.0, 0.0)

def mat_vec3(m, v):
    return tuple(sum(m[i][j]*v[j] for j in range(3)) for i in range(3))

def power_iteration(m, seed, iterations=60):
    v = seed
    for _ in range(iterations):
        v = mat_vec3(m, v)
        v = vnorm(v)
    mv = mat_vec3(m, v)
    eigenvalue = vdot(v, mv)
    return v, eigenvalue

def principal_axes(points):
    # Oriented-bounding-box axes via PCA (power iteration + deflation on the
    # 3x3 covariance matrix). Needed because some parts in this file were
    # authored pre-rotated directly in their own local mesh coordinates, so a
    # naive axis-aligned local bbox measures the diagonal footprint instead of
    # the true board dimensions.
    n = len(points)
    cx = sum(p[0] for p in points) / n
    cy = sum(p[1] for p in points) / n
    cz = sum(p[2] for p in points) / n
    centroid = (cx, cy, cz)
    cov = [[0.0]*3 for _ in range(3)]
    for p in points:
        d = vsub(p, centroid)
        for i in range(3):
            for j in range(3):
                cov[i][j] += d[i]*d[j]
    for i in range(3):
        for j in range(3):
            cov[i][j] /= n

    v1, e1 = power_iteration(cov, (1.0, 0.6, 0.2))
    cov2 = [[cov[i][j] - e1*v1[i]*v1[j] for j in range(3)] for i in range(3)]
    v2, e2 = power_iteration(cov2, (0.2, 1.0, 0.6))
    v2 = vnorm(vsub(v2, tuple(vdot(v1, v2)*x for x in v1)))  # re-orthogonalize
    v3 = vcross(v1, v2)
    return centroid, (v1, v2, v3)

DAE = os.path.expanduser("~/Downloads/Lie+Nielson/model.dae")
OUT_DIR = os.path.expanduser("~/Desktop/Shaving-Horse-Plans/viewer")
os.makedirs(OUT_DIR, exist_ok=True)
NS = {'c': 'http://www.collada.org/2005/11/COLLADASchema'}

tree = ET.parse(DAE)
root = tree.getroot()

def q(tag):
    return f'c:{tag}'

# ---------- geometries ----------
geoms = {}  # id -> dict(positions:[(x,y,z)], faces:[(i,j,k)]->offset into VERTEX source, tex faces skipped)
for g in root.findall(f'.//{q("library_geometries")}/{q("geometry")}', NS):
    gid = g.get('id')
    mesh = g.find(q('mesh'), NS)
    if mesh is None:
        continue
    sources = {}
    for src in mesh.findall(q('source'), NS):
        sid = src.get('id')
        farr = src.find(q('float_array'), NS)
        if farr is None or not farr.text:
            continue
        vals = [float(x) for x in farr.text.split()]
        acc = src.find(f'{q("technique_common")}/{q("accessor")}', NS)
        stride = int(acc.get('stride')) if acc is not None else 3
        sources[sid] = [tuple(vals[i:i+stride]) for i in range(0, len(vals), stride)]

    vtx = mesh.find(q('vertices'), NS)
    pos_src_id = None
    if vtx is not None:
        for inp in vtx.findall(q('input'), NS):
            if inp.get('semantic') == 'POSITION':
                pos_src_id = inp.get('source').lstrip('#')
        vtx_id = vtx.get('id')
    positions = sources.get(pos_src_id, [])

    # gather faces from triangles / polylist, offset for VERTEX input
    faces = []
    materials_used = set()
    for tris in list(mesh.findall(q('triangles'), NS)) + list(mesh.findall(q('polylist'), NS)):
        mat_sym = tris.get('material')
        if mat_sym:
            materials_used.add(mat_sym)
        inputs = tris.findall(q('input'), NS)
        vertex_offset = 0
        num_inputs = len(set(i.get('offset') for i in inputs))
        for inp in inputs:
            if inp.get('semantic') == 'VERTEX':
                vertex_offset = int(inp.get('offset'))
        p = tris.find(q('p'), NS)
        if p is None or not p.text:
            continue
        idx = [int(x) for x in p.text.split()]
        stride = num_inputs
        vcount_el = tris.find(q('vcount'), NS)
        if vcount_el is not None:
            # polylist - assume triangulated already or fan-triangulate
            vcounts = [int(x) for x in vcount_el.text.split()]
            pos = 0
            for vc in vcounts:
                verts = [idx[(pos+k)*stride + vertex_offset] for k in range(vc)]
                pos += vc
                for k in range(1, vc-1):
                    faces.append((verts[0], verts[k], verts[k+1]))
        else:
            n = len(idx) // stride
            for t in range(0, n, 3):
                verts = [idx[(t+k)*stride + vertex_offset] for k in range(3)]
                faces.append(tuple(verts))

    if positions:
        xs = [p[0] for p in positions]; ys = [p[1] for p in positions]; zs = [p[2] for p in positions]
        aabb_ext = (max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs))
        aabb_center = ((max(xs)+min(xs))/2, (max(ys)+min(ys))/2, (max(zs)+min(zs))/2)
        aabb_vol = aabb_ext[0] * aabb_ext[1] * aabb_ext[2]

        centroid, (v1, v2, v3) = principal_axes(positions)
        proj = ([vdot(vsub(p, centroid), v1) for p in positions],
                [vdot(vsub(p, centroid), v2) for p in positions],
                [vdot(vsub(p, centroid), v3) for p in positions])
        pca_ext = tuple(max(p) - min(p) for p in proj)
        pca_vol = pca_ext[0] * pca_ext[1] * pca_ext[2]

        # Only trust the PCA orientation when it's a meaningfully tighter fit
        # (i.e. the part is genuinely rotated in its own local mesh data).
        # Otherwise PCA noise on axis-aligned-but-detailed parts (chamfers,
        # mortises) can nudge a perfectly good axis-aligned box off true.
        if pca_vol < aabb_vol * 0.92:
            mids = tuple((max(p) + min(p)) / 2 for p in proj)
            axes3 = (v1, v2, v3)
            local_center = tuple(
                centroid[k] + sum(mids[a] * axes3[a][k] for a in range(3))
                for k in range(3)
            )
            bbox = pca_ext
            local_axes_geo = axes3
        else:
            bbox = aabb_ext
            local_center = aabb_center
            local_axes_geo = ((1, 0, 0), (0, 1, 0), (0, 0, 1))
    else:
        bbox = (0, 0, 0)
        local_center = (0, 0, 0)
        local_axes_geo = ((1, 0, 0), (0, 1, 0), (0, 0, 1))

    geoms[gid] = dict(positions=positions, faces=faces, bbox=bbox, local_center=local_center, local_axes=local_axes_geo, materials=materials_used)

# ---------- materials -> effect -> diffuse color/texture ----------
mat_name_by_id = {}
for m in root.findall(f'.//{q("library_materials")}/{q("material")}', NS):
    mid = m.get('id')
    inst_eff = m.find(q('instance_effect'), NS)
    effect_id = inst_eff.get('url').lstrip('#') if inst_eff is not None else None
    mat_name_by_id[mid] = dict(name=m.get('name'), effect=effect_id)

image_by_id = {}
for im in root.findall(f'.//{q("library_images")}/{q("image")}', NS):
    init = im.find(q('init_from'), NS)
    image_by_id[im.get('id')] = init.text if init is not None else None

effect_diffuse = {}
for eff in root.findall(f'.//{q("library_effects")}/{q("effect")}', NS):
    eid = eff.get('id')
    diffuse = eff.find(f'.//{q("diffuse")}', NS)
    color = None
    tex_image = None
    if diffuse is not None:
        c = diffuse.find(q('color'), NS)
        t = diffuse.find(q('texture'), NS)
        if c is not None:
            color = tuple(float(x) for x in c.text.split())
        if t is not None:
            samp_sid = t.get('texture')
            # find newparam sampler2D -> surface -> image id
            surf_sid = None
            for np_el in eff.findall(f'.//{q("newparam")}', NS):
                if np_el.get('sid') == samp_sid:
                    samp = np_el.find(q('sampler2D'), NS)
                    if samp is not None:
                        src = samp.find(q('source'), NS)
                        surf_sid = src.text if src is not None else None
            if surf_sid:
                for np_el in eff.findall(f'.//{q("newparam")}', NS):
                    if np_el.get('sid') == surf_sid:
                        surf = np_el.find(q('surface'), NS)
                        if surf is not None:
                            init = surf.find(q('init_from'), NS)
                            if init is not None:
                                tex_image = image_by_id.get(init.text)
    effect_diffuse[eid] = dict(color=color, image=tex_image)

# material target id (e.g. ID6) -> resolved color/texture info + human name
material_info = {}
for mid, info in mat_name_by_id.items():
    eff = effect_diffuse.get(info['effect'], {})
    material_info[mid] = dict(name=info['name'], color=eff.get('color'), image=eff.get('image'))

# ---------- library_nodes (by id) ----------
lib_nodes_root = root.find(f'.//{q("library_nodes")}', NS)
lib_nodes_by_id = {}
if lib_nodes_root is not None:
    for n in lib_nodes_root.findall(q('node'), NS):
        lib_nodes_by_id[n.get('id')] = n

def mat3x4_identity():
    return (1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1)

def mat_mul(a, b):
    # 4x4 row-major matrices as flat 16-tuples
    r = [0]*16
    for i in range(4):
        for j in range(4):
            s = 0
            for k in range(4):
                s += a[i*4+k]*b[k*4+j]
            r[i*4+j] = s
    return tuple(r)

def parse_matrix(node):
    mel = node.find(q('matrix'), NS)
    if mel is not None and mel.text:
        vals = [float(x) for x in mel.text.split()]
        if len(vals) == 16:
            return tuple(vals)
    return mat3x4_identity()

def apply_matrix(m, p):
    x,y,z = p
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

def normalize(v):
    n = (v[0]**2 + v[1]**2 + v[2]**2) ** 0.5
    return (v[0]/n, v[1]/n, v[2]/n) if n > 1e-9 else (0, 0, 0)

def to_yup(p):
    # source data is Z-up (SketchUp/COLLADA convention); OBJ/three.js default to Y-up
    x, y, z = p
    return (x, z, -y)

instances = []  # list of dict(label, top_group, geom_id, world_matrix, material_bindings)

def get_material_bindings(instance_geometry_el):
    bindings = {}
    bm = instance_geometry_el.find(q('bind_material'), NS)
    if bm is not None:
        for im in bm.findall(f'.//{q("instance_material")}', NS):
            bindings[im.get('symbol')] = im.get('target').lstrip('#')
    return bindings

def resolve_node(node, parent_matrix, name_path, top_group):
    local = parse_matrix(node)
    world = mat_mul(parent_matrix, local)
    name = node.get('name') or node.get('id')
    is_generic = bool(re.match(r'^SketchUp_Instance_\d+$', name or ''))
    new_top_group = top_group
    new_path = name_path
    if not is_generic:
        new_path = name_path + [name]
        if top_group is None:
            new_top_group = name

    # known exporter quirk: "Nut_3_4" component's raw geometry group kept a
    # leftover internal name "Head__2__6" (copy-pasted from a bolt-head mesh);
    # the meaningful authored name is the parent, so relabel this one leaf.

    ig = node.find(q('instance_geometry'), NS)
    if ig is not None:
        gid = ig.get('url').lstrip('#')
        bindings = get_material_bindings(ig)
        label = new_path[-1] if new_path else gid
        if label == 'Head__2__6' and len(new_path) >= 2 and new_path[-2] == 'Nut_3_4':
            label = 'Nut_3_4'
        instances.append(dict(
            label=label,
            path='/'.join(new_path) if new_path else gid,
            top_group=new_top_group or (new_path[0] if new_path else gid),
            geom_id=gid,
            world_matrix=world,
            material_bindings=bindings,
        ))

    inode = node.find(q('instance_node'), NS)
    if inode is not None:
        target_id = inode.get('url').lstrip('#')
        target = lib_nodes_by_id.get(target_id)
        if target is not None:
            resolve_node(target, world, new_path, new_top_group)

    for child in node.findall(q('node'), NS):
        resolve_node(child, world, new_path, new_top_group)

vs = root.find(f'.//{q("library_visual_scenes")}/{q("visual_scene")}', NS)
top_sketchup = vs.find(q('node'), NS)  # the single "SketchUp" root node
for child in top_sketchup.findall(q('node'), NS):
    resolve_node(child, mat3x4_identity(), [], None)

print(f"Resolved {len(instances)} geometry instances")

# ---------- write OBJ + MTL for rendering ----------
obj_path = os.path.join(OUT_DIR, 'scene.obj')
mtl_path = os.path.join(OUT_DIR, 'scene.mtl')

used_materials = {}
mat_key_to_name = {}
seen_names = {}
with open(obj_path, 'w') as f, open(mtl_path, 'w') as fm:
    f.write('mtllib scene.mtl\n')
    vertex_offset = 0
    for inst in instances:
        if inst['path'].startswith('Plan_Lie_Nielson_Boggs'):
            continue  # flat printed reference sheet, not a physical part
        if 'Nut_3_4' in inst['path'].split('/'):
            continue  # geometry data artifact (huge bogus bbox), excluded from render
        geo = geoms.get(inst['geom_id'])
        if not geo or not geo['positions'] or not geo['faces']:
            continue
        base_name = re.sub(r'[^A-Za-z0-9_]', '_', inst['path'])[:55] or inst['geom_id']
        n = seen_names.get(base_name, 0)
        seen_names[base_name] = n + 1
        safe_name = f"{base_name}_{n}" if n else base_name
        inst['safe_name'] = safe_name
        inst['in_obj'] = True
        f.write(f"o {safe_name}\n")
        wm = inst['world_matrix']
        for p in geo['positions']:
            wp = to_yup(apply_matrix(wm, p))
            f.write(f"v {wp[0]:.5f} {wp[1]:.5f} {wp[2]:.5f}\n")
        # pick a material: prefer non-edge_color material bound
        mat_target = None
        for sym, target in inst['material_bindings'].items():
            name = material_info.get(target, {}).get('name', '') or ''
            if not name.startswith('edge_color'):
                mat_target = target
                break
        if mat_target is None and inst['material_bindings']:
            mat_target = list(inst['material_bindings'].values())[0]
        mat_key = mat_target or 'default'
        mat_key_to_name[mat_key] = material_info.get(mat_target, {}).get('name') or 'default'
        if mat_key not in used_materials:
            used_materials[mat_key] = True
            info = material_info.get(mat_target, {})
            color = info.get('color') or (0.7, 0.55, 0.35, 1.0)
            fm.write(f"newmtl {mat_key}\n")
            fm.write(f"Kd {color[0]:.3f} {color[1]:.3f} {color[2]:.3f}\n")
            img = info.get('image')
            if img:
                src_img_path = os.path.join(os.path.dirname(DAE), img)
                if os.path.exists(src_img_path):
                    local_name = os.path.basename(img)
                    dst_img_path = os.path.join(OUT_DIR, local_name)
                    if not os.path.exists(dst_img_path):
                        import shutil
                        shutil.copyfile(src_img_path, dst_img_path)
                    fm.write(f"map_Kd {local_name}\n")
            fm.write("\n")
        f.write(f"usemtl {mat_key}\n")
        for face in geo['faces']:
            idxs = [vertex_offset + vi + 1 for vi in face]
            f.write(f"f {idxs[0]} {idxs[1]} {idxs[2]}\n")
        vertex_offset += len(geo['positions'])

print(f"Wrote OBJ: {obj_path}")
print(f"Wrote MTL: {mtl_path}")

with open(os.path.join(OUT_DIR, 'materials.json'), 'w') as jf:
    json.dump(mat_key_to_name, jf, indent=2)
print(f"Wrote materials.json: {mat_key_to_name}")

# ---------- per-instance oriented dimension gizmo data (for 3D dimension callouts) ----------
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
    roles = ['Length', 'Width', 'Thickness']
    for i, a in enumerate(axes):
        a['role'] = roles[i] if i < len(roles) else f'axis{i}'
        a['label'] = to_frac(a['length'])
        angle = compute_axis_angle(a['direction'])
        if angle:
            a['angle'] = angle
    object_dims[inst['safe_name']] = dict(center=[round(v, 4) for v in world_center], axes=axes)

with open(os.path.join(OUT_DIR, 'object_dims.json'), 'w') as jf:
    json.dump(object_dims, jf, indent=2)
print(f"Wrote object_dims.json ({len(object_dims)} objects)")

# ---------- build cut list / hardware list ----------
def fmt(v):
    return f"{v:.3f}".rstrip('0').rstrip('.')

report = {}
for inst in instances:
    if inst['path'].startswith('Plan_Lie_Nielson_Boggs'):
        continue
    geo = geoms.get(inst['geom_id'])
    if not geo:
        continue
    bbox = geo['bbox']
    dims = tuple(round(d, 3) for d in sorted(bbox, reverse=True))  # L,W,T sorted desc
    key = (inst['label'], dims)
    mat_names = []
    for sym, target in inst['material_bindings'].items():
        nm = material_info.get(target, {}).get('name')
        if nm and not nm.startswith('edge_color'):
            mat_names.append(nm)
    rep = report.setdefault(key, dict(
        label=inst['label'], top_group=inst['top_group'], dims=list(dims),
        count=0, materials=set(), paths=[], obj_names=[],
    ))
    rep['count'] += 1
    rep['materials'].update(mat_names)
    rep['paths'].append(inst['path'])
    if inst.get('in_obj'):
        rep['obj_names'].append(inst['safe_name'])

rows = list(report.values())
rows.sort(key=lambda r: (r['top_group'] or '', r['label']))

print("\n==== PARTS REPORT (label | top_group | qty | dims LxWxT in | materials) ====")
for r in rows:
    d = r['dims']
    print(f"{r['label']:<28} | {str(r['top_group']):<16} | qty={r['count']:<3} | {fmt(d[0])} x {fmt(d[1])} x {fmt(d[2])} in | {', '.join(sorted(r['materials'])) or '-'}")

out_rows = []
for r in rows:
    d = r['dims']
    out_rows.append({
        **r,
        'materials': sorted(r['materials']),
        'dims_str': f"{to_frac(d[0])} x {to_frac(d[1])} x {to_frac(d[2])}",
    })

# Manual corrections: these two hardware rows are exported as per-facet hex
# geometry (6-12 face pieces per real fastener), not one part per instance.
# Traced by hand: 4 rods total -> 4 real bolt-head caps + 4 real hex nuts.
for r in out_rows:
    if r['label'] == 'Bolt_Head__6':
        r['count'] = 4
        r['dims_str'] = '3/4" hex head (fits 1/2"-13 rod)'
        r['note'] = 'source file models each head as 6 face facets; qty corrected to real fastener count'
    elif r['label'] == 'Nut_3_4':
        r['count'] = 4
        r['dims_str'] = '3/4" hex nut (fits 1/2"-13 rod)'
        r['obj_names'] = []
        r['note'] = 'source geometry for this part is corrupted (huge bogus bbox); not shown in 3D view, qty inferred from matching rod count'

with open(os.path.join(OUT_DIR, 'parts_report.json'), 'w') as jf:
    json.dump(out_rows, jf, indent=2)

print("\nSaved parts_report.json with obj_names for 3D-viewer linking")

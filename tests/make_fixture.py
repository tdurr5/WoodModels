"""Builds a small synthetic SketchUp-style COLLADA file for parser tests.

Covers the paths parse_dae.py has to handle in the real export:
  - <triangles> with several inputs (VERTEX + NORMAL offsets)
  - <polylist> quads that need fan triangulation
  - a part whose mesh is pre-rotated in its own local coordinates (the PCA
    oriented-bounding-box path), placed via <instance_node> from
    <library_nodes> under a generic "SketchUp_Instance_N" wrapper node
  - two instances of one component with different transforms (qty 2)
  - a real material plus an "edge_color" material that must be ignored
  - a flat printed plan sheet that must be excluded

Run directly to write tests/fixtures/mini.dae.
"""
import math
import os

NS = 'http://www.collada.org/2005/11/COLLADASchema'


def box_corners(lx, ly, lz):
    return [(x, y, z) for x in (0, lx) for y in (0, ly) for z in (0, lz)]


# 6 faces as quads over box_corners indexing (bit order x,y,z -> 4,2,1)
QUADS = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]


def rot_z(p, deg):
    a = math.radians(deg)
    x, y, z = p
    return (x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a), z)


def floats(vals):
    return ' '.join(f'{v:.6f}' for v in vals)


def triangles_geometry(gid, verts, material_symbol):
    tris = []
    for a, b, c, d in QUADS:
        tris += [(a, b, c), (a, c, d)]
    # VERTEX at offset 0, NORMAL at offset 1 (normals are dummies; parser ignores them)
    p = ' '.join(f'{i} 0' for t in tris for i in t)
    return f'''
    <geometry id="{gid}"><mesh>
      <source id="{gid}-pos"><float_array id="{gid}-pos-arr" count="{len(verts) * 3}">{floats(v for p in verts for v in p)}</float_array>
        <technique_common><accessor source="#{gid}-pos-arr" count="{len(verts)}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
      <source id="{gid}-nrm"><float_array id="{gid}-nrm-arr" count="3">0 0 1</float_array>
        <technique_common><accessor source="#{gid}-nrm-arr" count="1" stride="3"/></technique_common></source>
      <vertices id="{gid}-vtx"><input semantic="POSITION" source="#{gid}-pos"/></vertices>
      <triangles count="{len(tris)}" material="{material_symbol}">
        <input semantic="VERTEX" source="#{gid}-vtx" offset="0"/>
        <input semantic="NORMAL" source="#{gid}-nrm" offset="1"/>
        <p>{p}</p>
      </triangles>
      <triangles count="1" material="edge">
        <input semantic="VERTEX" source="#{gid}-vtx" offset="0"/>
        <input semantic="NORMAL" source="#{gid}-nrm" offset="1"/>
        <p>0 0 1 0 2 0</p>
      </triangles>
    </mesh></geometry>'''


def polylist_geometry(gid, verts, material_symbol):
    vcount = ' '.join('4' for _ in QUADS)
    p = ' '.join(str(i) for q in QUADS for i in q)
    return f'''
    <geometry id="{gid}"><mesh>
      <source id="{gid}-pos"><float_array id="{gid}-pos-arr" count="{len(verts) * 3}">{floats(v for p in verts for v in p)}</float_array>
        <technique_common><accessor source="#{gid}-pos-arr" count="{len(verts)}" stride="3"/></technique_common></source>
      <vertices id="{gid}-vtx"><input semantic="POSITION" source="#{gid}-pos"/></vertices>
      <polylist count="{len(QUADS)}" material="{material_symbol}">
        <input semantic="VERTEX" source="#{gid}-vtx" offset="0"/>
        <vcount>{vcount}</vcount>
        <p>{p}</p>
      </polylist>
    </mesh></geometry>'''


def matrix(m):
    return f'<matrix>{floats(m)}</matrix>'


IDENTITY = (1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)


def translate(x, y, z):
    return (1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1)


def rot_x_90(tx=0, ty=0, tz=0):
    # stands a part up: local +Y -> world +Z
    return (1, 0, 0, tx, 0, 0, -1, ty, 0, 1, 0, tz, 0, 0, 0, 1)


def bind(symbol='mat', target='ID_wood'):
    return f'''<bind_material><technique_common>
          <instance_material symbol="{symbol}" target="#{target}"/>
          <instance_material symbol="edge" target="#ID_edge"/>
        </technique_common></bind_material>'''


def build():
    board = box_corners(10, 4, 1)
    # Leg: a 12 x 3 x 1.5 board authored already rotated 30 deg about its
    # local Z, so its axis-aligned local bbox is much fatter than the board.
    leg = [rot_z(p, 30) for p in box_corners(12, 3, 1.5)]
    sheet = box_corners(11, 8.5, 0.01)
    geoms = (
        triangles_geometry('geom_board', board, 'mat')
        + polylist_geometry('geom_leg', leg, 'mat')
        + triangles_geometry('geom_sheet', sheet, 'mat')
    )
    return f'''<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="{NS}" version="1.4.1">
  <library_effects>
    <effect id="eff_wood"><profile_COMMON><technique sid="common"><lambert>
      <diffuse><color>0.9 0.7 0.5 1</color></diffuse></lambert></technique></profile_COMMON></effect>
    <effect id="eff_edge"><profile_COMMON><technique sid="common"><lambert>
      <diffuse><color>0 0 0 1</color></diffuse></lambert></technique></profile_COMMON></effect>
  </library_effects>
  <library_materials>
    <material id="ID_wood" name="Wood"><instance_effect url="#eff_wood"/></material>
    <material id="ID_edge" name="edge_color000255"><instance_effect url="#eff_edge"/></material>
  </library_materials>
  <library_geometries>{geoms}
  </library_geometries>
  <library_nodes>
    <node id="comp_leg" name="Leg">
      <instance_geometry url="#geom_leg">{bind()}</instance_geometry>
    </node>
  </library_nodes>
  <library_visual_scenes>
    <visual_scene id="scene">
      <node name="SketchUp">
        <node name="Body">{matrix(IDENTITY)}
          <node name="Board">{matrix(translate(0, 0, 20))}
            <instance_geometry url="#geom_board">{bind()}</instance_geometry>
          </node>
          <node name="Board">{matrix(translate(0, 6, 20))}
            <instance_geometry url="#geom_board">{bind()}</instance_geometry>
          </node>
        </node>
        <node name="Legs">{matrix(IDENTITY)}
          <node name="SketchUp_Instance_3">{matrix(rot_x_90(2, 0, 0))}
            <instance_node url="#comp_leg"/>
          </node>
        </node>
        <node name="Plan_Lie_Nielson_Boggs">
          <instance_geometry url="#geom_sheet">{bind()}</instance_geometry>
        </node>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>
'''


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'mini.dae')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w') as f:
        f.write(build())
    print(f'wrote {out}')

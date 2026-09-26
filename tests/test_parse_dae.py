"""Tests for parse_dae.py. Run with: python3 -m unittest discover -s tests"""
import contextlib
import json
import math
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import parse_dae  # noqa: E402
import make_fixture  # noqa: E402


def load_json(*parts):
    with open(os.path.join(*parts)) as f:
        return json.load(f)


class Helpers(unittest.TestCase):
    def test_to_frac(self):
        self.assertEqual(parse_dae.to_frac(12.4697), '12-1/2"')
        self.assertEqual(parse_dae.to_frac(0.5), '1/2"')
        self.assertEqual(parse_dae.to_frac(3), '3"')
        self.assertEqual(parse_dae.to_frac(2.999), '3"')

    def test_fit_box_axis_aligned(self):
        ext, center, axes = parse_dae.fit_box(make_fixture.box_corners(10, 4, 1))
        self.assertEqual(sorted(round(e, 6) for e in ext), [1, 4, 10])
        self.assertEqual(tuple(round(c, 6) for c in center), (5, 2, 0.5))
        self.assertEqual(axes, ((1, 0, 0), (0, 1, 0), (0, 0, 1)))

    def test_fit_box_pre_rotated_mesh_uses_pca(self):
        pts = [make_fixture.rot_z(p, 30) for p in make_fixture.box_corners(12, 3, 1.5)]
        ext, _, axes = parse_dae.fit_box(pts)
        self.assertEqual(sorted(round(e, 4) for e in ext), [1.5, 3, 12])
        long_axis = axes[max(range(3), key=lambda i: ext[i])]
        self.assertAlmostEqual(abs(long_axis[0]), math.cos(math.radians(30)), places=4)

    def test_fit_box_empty(self):
        self.assertEqual(parse_dae.fit_box([])[0], (0, 0, 0))

    def test_axis_angle(self):
        self.assertIsNone(parse_dae.compute_axis_angle((0, 1, 0)))
        a = parse_dae.compute_axis_angle((0.2065, 0.948805, 0.239014))  # rear leg
        self.assertEqual(a['reference'], '+Y (vertical)')
        self.assertEqual(a['total_deg'], 18.4)
        self.assertEqual([(c['label'], c['deg']) for c in a['components']], [('x', 12.3), ('z', 14.1)])


class ConvertFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        dae = os.path.join(cls.tmp.name, 'mini.dae')
        with open(dae, 'w') as f:
            f.write(make_fixture.build())
        cls.out = os.path.join(cls.tmp.name, 'out')
        parse_dae.main([dae, '-o', cls.out, '-q'])
        cls.rows = load_json(cls.out, 'parts_report.json')
        cls.dims = load_json(cls.out, 'object_dims.json')
        cls.materials = load_json(cls.out, 'materials.json')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def row(self, label):
        return next(r for r in self.rows if r['label'] == label)

    def test_cut_list_rows(self):
        self.assertEqual([r['label'] for r in self.rows], ['Board', 'Leg'])  # plan sheet excluded

    def test_identical_instances_are_counted(self):
        board = self.row('Board')
        self.assertEqual(board['count'], 2)
        self.assertEqual(board['dims'], [10, 4, 1])
        self.assertEqual(board['dims_str'], '10" x 4" x 1"')
        self.assertEqual(board['top_group'], 'Body')
        self.assertEqual(len(board['obj_names']), 2)

    def test_library_node_behind_generic_wrapper_keeps_component_name(self):
        leg = self.row('Leg')
        self.assertEqual(leg['top_group'], 'Legs')
        self.assertEqual(leg['paths'], ['Legs/Leg'])
        self.assertEqual(leg['dims'], [12, 3, 1.5])  # PCA recovers the true board

    def test_edge_color_materials_ignored(self):
        self.assertEqual(self.row('Board')['materials'], ['Wood'])
        self.assertEqual(self.materials, {'ID_wood': 'Wood'})

    def test_object_dims_follow_world_transform(self):
        leg = self.dims[self.row('Leg')['obj_names'][0]]
        length = leg['axes'][0]
        self.assertEqual(length['role'], 'Length')
        self.assertAlmostEqual(length['length'], 12, places=3)
        # local 30deg-about-Z, stood up by a 90deg rotation about X, then Z-up -> Y-up:
        # the leg rises 30 deg from horizontal along X
        d = length['direction']
        self.assertAlmostEqual(abs(d[0]), math.cos(math.radians(30)), places=4)
        self.assertAlmostEqual(abs(d[1]), math.sin(math.radians(30)), places=4)
        self.assertEqual(length['angle']['total_deg'], 30.0)

        board_a, board_b = (self.dims[n] for n in self.row('Board')['obj_names'])
        # 6" apart along source Y -> -Z in the Y-up output
        self.assertAlmostEqual(board_a['center'][2] - board_b['center'][2], 6, places=4)
        self.assertAlmostEqual(board_a['center'][1], 20.5, places=4)  # source Z 20 + half thickness

    def test_obj_is_well_formed(self):
        verts = faces = 0
        objects = []
        with open(os.path.join(self.out, 'scene.obj')) as f:
            for line in f:
                if line.startswith('v '):
                    verts += 1
                elif line.startswith('f '):
                    faces += 1
                    self.assertTrue(all(1 <= int(i) <= verts for i in line.split()[1:]))
                elif line.startswith('o '):
                    objects.append(line[2:].strip())
        self.assertEqual(len(objects), 3)
        self.assertEqual(verts, 24)
        # board: 12 tris + 1 edge-material tri; leg polylist: 6 quads -> 12 tris
        self.assertEqual(faces, 13 * 2 + 12)
        self.assertEqual(set(objects), set(self.dims))

    def test_cli_requires_input(self):
        env = os.environ.pop('WOODMODELS_DAE', None)
        try:
            with open(os.devnull, 'w') as devnull, contextlib.redirect_stderr(devnull), self.assertRaises(SystemExit):
                parse_dae.main([])
        finally:
            if env is not None:
                os.environ['WOODMODELS_DAE'] = env


class NamedLengths(unittest.TestCase):
    def test_flags_names_that_disagree_with_the_geometry(self):
        w = parse_dae.named_length_warning('Shaft_1_2_-13_8_1_4', [6.875, 0.5, 0.5])
        self.assertEqual(w, 'Named 8-1/4" in the source model but modeled 6-7/8" long - check the plan.')
        self.assertIsNotNone(parse_dae.named_length_warning('Shaft_1_2__-13_4_3_4', [5.0625, 0.5, 0.5]))

    def test_quiet_when_name_matches_or_has_no_length(self):
        self.assertIsNone(parse_dae.named_length_warning('Shaft_1_2_-13_6_7_8', [6.875, 0.5, 0.5]))
        self.assertIsNone(parse_dae.named_length_warning('Nut_3_4', [0.75, 0.65, 0.4]))
        self.assertIsNone(parse_dae.named_length_warning('Bolt_Head__6', [0.43, 0.375, 0.33]))
        self.assertIsNone(parse_dae.named_length_warning('Treadle_Jaw_Upper__8', [2.75, 1, 1]))
        self.assertIsNone(parse_dae.named_length_warning('Leg_2_3_5', [20, 3, 1]))  # not a real fraction


class Units(unittest.TestCase):
    def test_metric_model_is_converted_to_inches(self):
        with tempfile.TemporaryDirectory() as tmp:
            dae = os.path.join(tmp, 'mm.dae')
            with open(dae, 'w') as f:
                f.write(make_fixture.build(unit_meter=0.001, scale=25.4))  # same model, drawn in mm
            out = os.path.join(tmp, 'out')
            parse_dae.main([dae, '-o', out, '-q'])
            rows = load_json(out, 'parts_report.json')
            board = next(r for r in rows if r['label'] == 'Board')
            self.assertEqual(board['dims'], [10, 4, 1])
            self.assertEqual(next(r for r in rows if r['label'] == 'Leg')['dims'], [12, 3, 1.5])
            dims = load_json(out, 'object_dims.json')
            a, b = (dims[n] for n in board['obj_names'])
            self.assertAlmostEqual(a['center'][2] - b['center'][2], 6, places=3)

    def test_missing_unit_means_inches(self):
        import xml.etree.ElementTree as ET
        root = ET.fromstring('<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema"/>')
        self.assertEqual(parse_dae.read_unit_scale(root), 1.0)


class StarterConfig(unittest.TestCase):
    def test_written_once_with_guessed_categories(self):
        with tempfile.TemporaryDirectory() as tmp:
            dae = os.path.join(tmp, 'my_work-bench.dae')
            with open(dae, 'w') as f:
                f.write(make_fixture.build())
            out = os.path.join(tmp, 'out')
            parse_dae.main([dae, '-o', out, '-q'])
            cfg = load_json(out, 'model.json')
            self.assertEqual(cfg['title'], 'My Work Bench')
            self.assertEqual(cfg['materials']['Wood']['category'], 'Wood')
            self.assertEqual(cfg['materials']['Wood']['color'], '#e6b280')  # diffuse 0.9 0.7 0.5
            # an edited config is never overwritten
            cfg['title'] = 'Edited'
            with open(os.path.join(out, 'model.json'), 'w') as f:
                json.dump(cfg, f)
            parse_dae.main([dae, '-o', out, '-q'])
            self.assertEqual(load_json(out, 'model.json')['title'], 'Edited')

    def test_guess_category(self):
        self.assertEqual(parse_dae.guess_category('White_Oak'), 'Wood')
        self.assertEqual(parse_dae.guess_category('_____Metal'), 'Hardware')
        self.assertEqual(parse_dae.guess_category('Leather'), 'Leather')
        self.assertEqual(parse_dae.guess_category('Glass'), 'Other')


class CommittedViewerData(unittest.TestCase):
    """The checked-in viewer data must be internally consistent."""

    @classmethod
    def setUpClass(cls):
        v = os.path.join(ROOT, 'viewer')
        cls.rows = load_json(v, 'parts_report.json')
        cls.dims = load_json(v, 'object_dims.json')
        with open(os.path.join(v, 'scene.obj')) as f:
            cls.objects = {line[2:].strip() for line in f if line.startswith('o ')}

    def test_every_linked_mesh_exists(self):
        for r in self.rows:
            for n in r['obj_names']:
                self.assertIn(n, self.objects, f"{r['label']} links to missing mesh {n}")
                self.assertIn(n, self.dims)

    def test_every_mesh_belongs_to_one_row(self):
        linked = [n for r in self.rows for n in r['obj_names']]
        self.assertEqual(len(linked), len(set(linked)))
        self.assertEqual(set(linked), self.objects)

    def test_dims_sorted_and_axes_unit_length(self):
        for r in self.rows:
            self.assertEqual(r['dims'], sorted(r['dims'], reverse=True))
        for name, d in self.dims.items():
            for a in d['axes']:
                self.assertAlmostEqual(math.hypot(*a['direction']), 1, places=4, msg=name)


if __name__ == '__main__':
    unittest.main()

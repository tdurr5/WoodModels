"""Tests for scripts/update_prices.py (no network)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
import update_prices as up  # noqa: E402

FRED = """observation_date,WPU0812
2024-01-01,300.0
2024-12-01,.
2025-01-01,320.0
2025-06-01,336.0
2026-01-01,352.0
"""

BLS = json.dumps({'status': 'REQUEST_SUCCEEDED', 'Results': {'series': [{'seriesID': 'WPU0811', 'data': [
    {'year': '2026', 'period': 'M02', 'value': '210.0'},
    {'year': '2026', 'period': 'M13', 'value': '999'},
    {'year': '2025', 'period': 'M01', 'value': '200.0'},
]}]}})


class TestPrices(unittest.TestCase):
    def test_fred_csv(self):
        vals = up.parse_fred_csv(FRED)
        self.assertEqual(vals[0], ('2024-01', 300.0))
        self.assertNotIn('2024-12', [m for m, _ in vals])  # missing value skipped
        self.assertEqual(vals[-1], ('2026-01', 352.0))

    def test_bls_json(self):
        self.assertEqual(up.parse_bls_json(BLS), [('2025-01', 200.0), ('2026-02', 210.0)])  # annual average (M13) skipped

    def test_prices_move_with_the_index(self):
        data = up.build({'hardwood': up.parse_fred_csv(FRED), 'softwood': up.parse_bls_json(BLS)}, today='2026-02-10')
        self.assertAlmostEqual(data['indexes']['hardwood']['factor'], 1.1)  # 352 / 320
        self.assertAlmostEqual(data['indexes']['softwood']['factor'], 1.05)
        low, high, _ = up.BASELINE['walnut']
        self.assertAlmostEqual(data['species']['walnut']['typical'], round((low + high) / 2 * 1.1, 2))
        self.assertAlmostEqual(data['species']['pine']['low'], round(up.BASELINE['pine'][0] * 1.05, 2))
        self.assertEqual(data['indexes']['hardwood']['asOf'], '2026-01')

    def test_no_data_keeps_baseline(self):
        data = up.build({'hardwood': [], 'softwood': []})
        self.assertEqual(data['indexes']['hardwood']['factor'], 1.0)
        self.assertEqual(data['species']['poplar']['low'], up.BASELINE['poplar'][0])

    def test_species_match_the_viewer(self):
        with open(os.path.join(up.ROOT, 'viewer', 'woodtex.js'), encoding='utf-8') as f:
            src = f.read()
        for key in up.BASELINE:
            self.assertIn(f"'{key}':" if '-' in key else f'  {key}:', src, key)


if __name__ == '__main__':
    unittest.main()

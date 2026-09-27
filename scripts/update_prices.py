#!/usr/bin/env python3
"""Refresh viewer/prices.json: typical lumber prices, kept current.

Retailers don't publish lumber prices in a form anyone may reuse, so this
starts from typical US retail prices per board foot for each species (4/4,
early 2025 - BASELINE below) and moves them with the US producer price
indexes for hardwood and softwood lumber (Bureau of Labor Statistics,
series WPU0812 and WPU0811), which are public. Read from FRED (St. Louis
Fed) as CSV, or from the BLS API if FRED is unreachable. No API keys.

The viewer uses these as estimates for the cutting diagram's cost when you
haven't entered your own price. Run weekly by .github/workflows/prices.yml;
if neither source answers, prices.json is left as it is.

  python3 scripts/update_prices.py            # fetch and write
  python3 scripts/update_prices.py --dry-run  # fetch and print
"""
import argparse
import csv
import io
import json
import os
import sys
import urllib.request
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'viewer', 'prices.json')

BASE_MONTH = '2025-01'
# Typical US retail $/board foot, 4/4 surfaced, early 2025: (low, high).
# Keys match viewer/woodtex.js SPECIES. Hardwoods follow the hardwood
# index, softwoods the softwood one.
BASELINE = {
    'red-oak': (4.75, 7.5, 'hardwood'),
    'white-oak': (6.5, 10.5, 'hardwood'),
    'walnut': (9.5, 16.0, 'hardwood'),
    'cherry': (6.5, 10.0, 'hardwood'),
    'maple': (5.5, 9.0, 'hardwood'),
    'ash': (4.5, 7.5, 'hardwood'),
    'hickory': (5.0, 8.0, 'hardwood'),
    'beech': (5.5, 8.5, 'hardwood'),
    'birch': (4.5, 7.5, 'hardwood'),
    'poplar': (3.25, 5.0, 'hardwood'),
    'mahogany': (11.0, 18.0, 'hardwood'),
    'pine': (2.75, 5.0, 'softwood'),
    'larch': (3.5, 6.0, 'softwood'),
    'fir': (4.0, 7.5, 'softwood'),
    'cedar': (4.0, 7.5, 'softwood'),
}
# Thicker stock costs more per board foot (fewer, bigger logs).
THICKNESS_PREMIUM = {'4/4': 1.0, '5/4': 1.1, '6/4': 1.15, '8/4': 1.25, '10/4': 1.4, '12/4': 1.5, '16/4': 1.7}
SERIES = {'hardwood': 'WPU0812', 'softwood': 'WPU0811'}


def parse_fred_csv(text):
    """FRED graph CSV -> [(YYYY-MM, value)], skipping missing values ('.')."""
    rows = list(csv.reader(io.StringIO(text)))
    out = []
    for r in rows[1:]:
        if len(r) < 2 or r[1] in ('', '.'):
            continue
        try:
            out.append((r[0][:7], float(r[1])))
        except ValueError:
            continue
    return out


def parse_bls_json(text):
    """BLS API v1 response -> [(YYYY-MM, value)], oldest first."""
    data = json.loads(text)
    series = (data.get('Results') or {}).get('series') or []
    out = []
    for s in series:
        for d in s.get('data', []):
            period = d.get('period', '')
            if not period.startswith('M') or period == 'M13':
                continue
            try:
                out.append((f"{d['year']}-{period[1:]}", float(d['value'])))
            except (KeyError, ValueError):
                continue
    return sorted(out)


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': 'WoodModels price update (github.com/tdurr5/WoodModels)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8')


def get_series(series_id):
    """Monthly index values, oldest first; [] if no source answers."""
    try:
        return parse_fred_csv(fetch(f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}'))
    except Exception as e:  # noqa: BLE001 - any failure: try the other source
        print(f'FRED {series_id}: {e}', file=sys.stderr)
    try:
        return parse_bls_json(fetch(f'https://api.bls.gov/publicAPI/v1/timeseries/data/{series_id}'))
    except Exception as e:  # noqa: BLE001
        print(f'BLS {series_id}: {e}', file=sys.stderr)
    return []


def factor_since(values, base_month):
    """Latest value over the value in base_month; (None, None) if the series
    doesn't have that month (e.g. a source that only keeps recent years) -
    a guess from another month would move every price."""
    base = dict(values).get(base_month)
    if not values or not base:
        return None, None
    latest_month, latest = values[-1]
    return latest / base, latest_month


def year_change(values):
    """Change over the last 12 months, e.g. 0.03 for +3%."""
    if len(values) < 13:
        return None
    return values[-1][1] / values[-13][1] - 1


def build(indexes, today=None):
    """indexes: {'hardwood': [(month, value)...], 'softwood': [...]} -> prices.json content."""
    today = today or date.today().isoformat()
    kinds = {}
    for kind, values in indexes.items():
        f, month = factor_since(values, BASE_MONTH)
        kinds[kind] = {
            'series': SERIES[kind],
            'factor': round(f, 4) if f else 1.0,
            'asOf': month,
            'yearChange': round(year_change(values), 4) if year_change(values) is not None else None,
        }
    species = {}
    for key, (low, high, kind) in BASELINE.items():
        f = kinds.get(kind, {}).get('factor', 1.0)
        species[key] = {'low': round(low * f, 2), 'high': round(high * f, 2), 'typical': round((low + high) / 2 * f, 2), 'kind': kind}
    return {
        'updated': today,
        'note': 'Typical US retail $/board foot for 4/4 lumber, moved with the US producer price indexes for lumber. An estimate: prices vary a lot by yard, grade and region.',
        'baseMonth': BASE_MONTH,
        'thicknessPremium': THICKNESS_PREMIUM,
        'indexes': kinds,
        'species': species,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--dry-run', action='store_true', help='print instead of writing viewer/prices.json')
    args = ap.parse_args()
    indexes = {kind: get_series(sid) for kind, sid in SERIES.items()}
    if not all(indexes.values()):
        print('No price index data (sources unreachable); leaving prices.json as it is.')
        return 0
    data = build(indexes)
    missing = [k for k, v in data['indexes'].items() if not v['asOf']]
    if missing:
        print(f"No {BASE_MONTH} value for {', '.join(missing)} lumber; leaving prices.json as it is.")
        return 0
    text = json.dumps(data, indent=2) + '\n'
    if args.dry_run:
        print(text)
        return 0
    # only the date changed: nothing worth a commit
    try:
        with open(OUT, encoding='utf-8') as f:
            old = json.load(f)
        if {**old, 'updated': ''} == {**data, 'updated': ''}:
            print('Prices unchanged.')
            return 0
    except (OSError, ValueError):
        pass
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(text)
    print(f"Wrote {OUT}: hardwood x{data['indexes']['hardwood']['factor']}, softwood x{data['indexes']['softwood']['factor']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())

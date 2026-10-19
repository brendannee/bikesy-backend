#!/usr/bin/env python3
"""Draft a CANDIDATE regional review directory from a prepared, locked extract.

Run inside the pinned toolchain (needs osmium). This only automates the
mechanical inventory described in docs/REGIONS.md; it grants nothing:

- osm_motorway_mainlines: every highway=motorway way in region.osm.pbf.
- allow_motorway_ways / allow_directed_edges / walk_bicycle_ways / deny_ways:
  empty, i.e. conservative motorway exclusion. Candidates that a human should
  look at (motorway-class ways tagged with bicycle permission) are listed in
  the --candidates file, never applied.
- quality.json facilities: unambiguous two-way cycle-lane ways on each side of
  the configured admin states, chosen by tags only. The graph gate then proves
  the built graph agrees. A human must still confirm them on the ground.
- minimum_bicycle_nodes: a deliberately loose floor derived from the extract.

With --carry-forward, reviewed decisions (allowances, deny/walk lists, facility
checks, thresholds) are copied from a previous review directory and re-checked
against the new extract; the motorway inventory and input lock are always
regenerated. Output is labelled with review_status=candidate until edited.
"""
import argparse
import json
import math
import re
import shutil
import subprocess
import tempfile
from collections import Counter
from pathlib import Path

ROAD_CLASSES = {'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
                'primary_link', 'secondary_link', 'tertiary_link', 'living_street'}
NOT_ROUTABLE = {'proposed', 'construction', 'abandoned', 'platform', 'raceway', 'razed',
                'bus_stop', 'elevator', 'emergency_bay', 'rest_area', 'services', 'disused'}
CYCLELANE = {'shared_lane': 1, 'share_busway': 1, 'lane': 2, 'track': 3}


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--config', type=Path, required=True)
    p.add_argument('--data', type=Path, required=True, help='Prepared data directory with region.osm.pbf')
    p.add_argument('--input-lock', type=Path, required=True, help='Flat lock from lock-inputs.py --build-lock')
    p.add_argument('--output', type=Path, required=True, help='New review directory')
    p.add_argument('--candidates', type=Path, required=True, help='New JSON file for informational review candidates (kept outside the review directory)')
    p.add_argument('--carry-forward', type=Path, help='Previously reviewed directory whose decisions to reuse')
    p.add_argument('--facilities-per-state', type=int, default=2)
    return p.parse_args()


def unescape(value):
    return re.sub(r'%([0-9a-fA-F]+)%', lambda m: chr(int(m.group(1), 16)), value)


def read_ways(pbf):
    """Yield (id, tags, [(node, lon, lat)]) for highway ways using osmium OPL."""
    with tempfile.TemporaryDirectory() as tmp:
        filtered = Path(tmp) / 'highways.osm.pbf'
        subprocess.run(['osmium', 'tags-filter', '--overwrite', str(pbf), 'w/highway', '-o', str(filtered)], check=True)
        proc = subprocess.Popen(['osmium', 'add-locations-to-ways', '--ignore-missing-nodes', '-f', 'opl',
                                 str(filtered), '-o', '-'], stdout=subprocess.PIPE, text=True)
        for line in proc.stdout:
            if not line.startswith('w'):
                continue
            fields = {f[0]: f[1:] for f in line.rstrip('\n').split(' ') if f}
            tags = {}
            for pair in fields.get('T', '').split(','):
                if '=' in pair:
                    k, v = pair.split('=', 1)
                    tags[unescape(k)] = unescape(v)
            nodes = []
            for ref in fields.get('N', '').split(','):
                m = re.fullmatch(r'n(\d+)(?:x(-?[\d.]+)y(-?[\d.]+))?', ref)
                if m:
                    nodes.append((int(m.group(1)), float(m.group(2)) if m.group(2) else None,
                                  float(m.group(3)) if m.group(3) else None))
            yield int(fields['w']), tags, nodes
        if proc.wait():
            raise SystemExit('osmium add-locations-to-ways failed')


def length_m(nodes):
    total = 0.0
    pts = [(lon, lat) for _, lon, lat in nodes if lon is not None]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        dx = math.radians(x2 - x1) * math.cos(math.radians((y1 + y2) / 2))
        total += 6371000 * math.hypot(dx, math.radians(y2 - y1))
    return total


def ca_nv_side(lon, lat):
    """Approximate CA/NV side for candidate selection only (not used by the build).

    The CA/NV line is the 120th meridian north of 39N, then a straight oblique
    line to the Colorado River near 35.0019N 114.6335W. Returns a signed
    distance-ish value in degrees: positive = NV, negative = CA.
    """
    if lat >= 39.0:
        return lon + 120.0
    (y1, x1), (y2, x2) = (39.0, -120.0), (35.0019, -114.6335)
    # Point-to-line signed offset in a locally scaled plane.
    k = math.cos(math.radians(37))
    ax, ay, bx, by, px, py = x1 * k, y1, x2 * k, y2, lon * k, lat
    cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    return cross / math.hypot(bx - ax, by - ay)


def facility(tags):
    """Expected Valhalla cyclelane value if tags unambiguously give the same facility both ways."""
    if tags.get('highway') not in ROAD_CLASSES:
        return None
    if tags.get('oneway', 'no') not in ('no', 'false', '0'):
        return None
    if tags.get('bicycle') in ('no', 'dismount') or tags.get('access') in ('no', 'private'):
        return None
    keys = {k: v for k, v in tags.items() if k == 'cycleway' or k.startswith('cycleway:')}
    sides = {k: v for k, v in keys.items() if k in ('cycleway', 'cycleway:both', 'cycleway:left', 'cycleway:right')}
    if set(keys) != set(sides):  # extra cycleway:* sub-keys (lane widths, oneway, ...) -> skip
        return None
    if set(sides) == {'cycleway:left', 'cycleway:right'}:
        values = set(sides.values())
    elif len(sides) == 1 and set(sides) <= {'cycleway', 'cycleway:both'}:
        values = set(sides.values())
    else:
        return None
    if len(values) != 1:
        return None
    return CYCLELANE.get(values.pop())


def main():
    a = parse_args()
    config = json.loads(a.config.read_text())
    if a.output.exists():
        raise SystemExit('Use a new --output review directory')
    region_pbf = a.data / 'region.osm.pbf'
    lock = json.loads(a.input_lock.read_text())
    b = config['bounds']
    inset = config.get('bounds_inset', 0)
    if not isinstance(inset, dict):
        inset = {k: inset for k in ('left', 'bottom', 'right', 'top')}
    service = {'left': b['left'] + inset.get('left', 0), 'bottom': b['bottom'] + inset.get('bottom', 0),
               'right': b['right'] - inset.get('right', 0), 'top': b['top'] - inset.get('top', 0)}

    mainlines, motorway_candidates, facilities, way_ids = [], [], [], set()
    endpoint, uses = Counter(), Counter()
    mainline_groups = {}
    for wid, tags, nodes in read_ways(region_pbf):
        way_ids.add(wid)
        hw = tags.get('highway')
        if hw == 'motorway':
            mainlines.append(wid)
            key = (tags.get('ref'), tags.get('name'), tags.get('bicycle'))
            g = mainline_groups.setdefault(key, {'ref': key[0], 'name': key[1], 'bicycle': key[2], 'ways': 0, 'length_m': 0,
                                                 'lon_range': [180, -180], 'lat_range': [90, -90]})
            g['ways'] += 1
            g['length_m'] += round(length_m(nodes))
            for _, x, y in nodes:
                if x is not None:
                    g['lon_range'] = [min(g['lon_range'][0], x), max(g['lon_range'][1], x)]
                    g['lat_range'] = [min(g['lat_range'][0], y), max(g['lat_range'][1], y)]
        if hw in ('motorway', 'motorway_link') and tags.get('bicycle') in ('yes', 'designated', 'permissive'):
            motorway_candidates.append({'way': wid, 'highway': hw, 'bicycle': tags.get('bicycle'),
                                        'name': tags.get('name'), 'ref': tags.get('ref'),
                                        'length_m': round(length_m(nodes))})
        if hw in NOT_ROUTABLE or not nodes:
            continue
        for n, _, _ in nodes:
            uses[n] += 1
        endpoint[nodes[0][0]] += 1
        endpoint[nodes[-1][0]] += 1
        expected = facility(tags)
        if expected is None:
            continue
        pts = [(lon, lat) for _, lon, lat in nodes if lon is not None]
        if len(pts) != len(nodes) or not all(service['left'] < x < service['right'] and service['bottom'] < y < service['top'] for x, y in pts):
            continue
        sides = [ca_nv_side(x, y) for x, y in pts]
        margin = 0.01  # ~1 km: keep candidates clearly on one side of the line
        if all(s < -margin for s in sides):
            state = 'CA'
        elif all(s > margin for s in sides):
            state = 'NV'
        else:
            continue
        facilities.append({'way': wid, 'cyclelane': expected, 'state': state, 'name': tags.get('name'),
                           'highway': hw, 'length_m': round(length_m(nodes)),
                           'tags': {k: v for k, v in tags.items() if k == 'cycleway' or k.startswith('cycleway:')}})

    # Graph nodes are roughly intersections plus way ends. Use half as a loose floor.
    estimated_nodes = sum(1 for n, c in uses.items() if c > 1 or endpoint[n])
    chosen = []
    for state in config['admin_states']:
        pool = sorted((f for f in facilities if f['state'] == state), key=lambda f: (-f['length_m'], f['way']))
        names = set()
        for f in pool:
            if f['name'] in names and f['name']:
                continue
            names.add(f['name'])
            chosen.append(f)
            if sum(1 for c in chosen if c['state'] == state) >= a.facilities_per_state:
                break

    overrides = {
        'default': 'Clear bicycle access on every motorway-class or OSM motorway mainline edge except reviewed exact ways/directed edges.',
        'review_status': 'candidate: generated by scripts/propose-review.py; allowance arrays empty (conservative motorway exclusion)',
        'osm_motorway_mainlines': sorted(mainlines),
        'allow_motorway_ways': [], 'allow_directed_edges': [], 'walk_bicycle_ways': [], 'deny_ways': [],
    }
    quality = {'region': config['region'], 'review_status': 'candidate',
               'minimum_bicycle_nodes': max(1, estimated_nodes // 2),
               'expected_walking_edges': 0,
               'facilities': [{'way': f['way'], 'cyclelane': f['cyclelane']} for f in chosen]}
    edges = ''
    mainline_diff = None
    if a.carry_forward:
        prev_q = json.loads((a.carry_forward / 'quality.json').read_text())
        prev_o = json.loads((a.carry_forward / 'baseline-access-overrides.json').read_text())
        for key in ('allow_motorway_ways', 'allow_directed_edges', 'walk_bicycle_ways', 'deny_ways'):
            overrides[key] = prev_o.get(key, [])
        for key in prev_o:
            if key not in overrides and key not in ('input_graph_files', 'input_osm_sha256'):
                overrides[key] = prev_o[key]
        overrides['review_status'] = f'carried forward from {a.carry_forward}; motorway inventory regenerated'
        quality = {**prev_q, 'region': config['region']}
        quality['review_status'] = f'carried forward from {a.carry_forward}'
        edges = (a.carry_forward / 'baseline-graph-edges.jsonl').read_text()
        old_main = set(prev_o.get('osm_motorway_mainlines', []))
        mainline_diff = {'added': sorted(set(mainlines) - old_main), 'removed': sorted(old_main - set(mainlines))}
        missing = [w for w in [f['way'] for f in quality['facilities']] + overrides['allow_motorway_ways']
                   + overrides['walk_bicycle_ways'] + overrides['deny_ways'] if w not in way_ids]
        if missing:
            raise SystemExit(f'Carried-forward ways missing from the new extract; re-review: {missing}')
    targets = sorted({f['way'] for f in quality['facilities']} | set(overrides['allow_motorway_ways'])
                     | set(overrides['walk_bicycle_ways']) | set(overrides['deny_ways'])
                     | {e['way_id'] for e in overrides['allow_directed_edges']})

    a.output.mkdir(parents=True)
    shutil.copyfile(a.input_lock, a.output / 'inputs.lock.json')
    (a.output / 'quality.json').write_text(json.dumps(quality, indent=2) + '\n')
    (a.output / 'target-ways.json').write_text(json.dumps({'ways': targets}) + '\n')
    (a.output / 'baseline-access-overrides.json').write_text(json.dumps(overrides, indent=2) + '\n')
    (a.output / 'baseline-graph-edges.jsonl').write_text(edges)
    a.candidates.write_text(json.dumps({
        'note': 'Informational only; nothing here is applied. Requires human review.',
        'region_sha256': lock.get('region.osm.pbf'),
        'estimated_graph_nodes': estimated_nodes,
        'motorway_mainline_count': len(mainlines),
        'motorway_mainline_diff_vs_carry_forward': mainline_diff,
        'motorway_mainlines_by_ref_name_bicycle': sorted(mainline_groups.values(), key=lambda g: -g['length_m']),
        'motorway_class_with_bicycle_permission': motorway_candidates,
        'chosen_facilities': chosen,
        'other_facility_candidates': [f for f in facilities if f not in chosen][:50],
    }, indent=2) + '\n')
    print(json.dumps({'output': str(a.output), 'mainlines': len(mainlines), 'facilities': [(f['way'], f['state'], f['name'], f['cyclelane']) for f in chosen],
                      'minimum_bicycle_nodes': quality['minimum_bicycle_nodes'], 'motorway_bicycle_candidates': len(motorway_candidates)}, indent=2))


if __name__ == '__main__':
    main()

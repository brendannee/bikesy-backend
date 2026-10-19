#!/usr/bin/env python3
"""Prepare complete US state administrative inputs from matching OSM snapshots."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from region_common import US_STATES

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--config', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('inputs', type=Path, nargs='+')
a = p.parse_args()
states = json.loads(a.config.read_text())['admin_states']
if not states or len(set(states)) != len(states) or any(s not in US_STATES for s in states):
    p.error('Only reviewed US state administrative scope is supported')
if a.output.exists() or a.output.with_suffix('.provenance.json').exists():
    p.error('Use a new output path')
def run(*args, capture=False):
    return subprocess.run(['osmium', *map(str, args)], check=True, text=True, capture_output=capture)
times = [run('fileinfo', '-g', 'header.option.osmosis_replication_timestamp', x, capture=True).stdout.strip() for x in a.inputs]
if not all(times) or len(set(times)) != 1:
    p.error('Inputs must have the same nonempty OSM snapshot timestamp')
a.output.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(dir=a.output.parent) as temporary:
    root = Path(temporary)
    parts = []
    for i, source in enumerate(a.inputs):
        target = root / f'{i}.osm.pbf'
        run('tags-filter', '--remove-tags', source,
            'r/ISO3166-2=' + ','.join('US-' + s for s in states), '-o', target)
        parts.append(target)
    merged = root / 'admin.osm.pbf'
    run('merge', *parts, '-o', merged)
    # -r also requires every relation member. Without it a clipped sub-state extract
    # (e.g. Geofabrik norcal: 156 California boundary ways missing) passes here and
    # only fails much later in the gated build.
    try:
        run('check-refs', '-r', merged, capture=True)
    except subprocess.CalledProcessError as error:
        p.error('Administrative relations are incomplete; supply full state extracts that together '
                'contain every boundary member (e.g. california + nevada, not norcal):\n' + (error.stderr or ''))
    # Missing/extra/invalid polygons are also rejected by complete-regional-admin.py
    # against Valhalla's actual administrative DB during the gated build.
    with a.output.open('xb') as out, merged.open('rb') as src:
        import shutil
        shutil.copyfileobj(src, out)
receipt = {'states': states, 'snapshot': times[0], 'source_files': {},
           'method': 'complete ISO3166-2 state relations; tags removed on referenced objects; merge and check-refs -r (all relation members present)'}
for source in a.inputs:
    with source.open('rb') as stream:
        receipt['source_files'][str(source)] = hashlib.file_digest(stream, 'sha256').hexdigest()
with a.output.open('rb') as stream:
    receipt['output_sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
a.output.with_suffix('.provenance.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(a.output)

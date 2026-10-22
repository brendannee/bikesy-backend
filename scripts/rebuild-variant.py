"""Build an offline regional data release inside the pinned toolchain."""
from region_common import ADDING_A_REGION, default_review_dir, load_region_config, region_name
import sys
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--project', type=Path, default=Path('/work'))
parser.add_argument('--data', type=Path, default=Path('/data'))
parser.add_argument('--region', type=region_name, default='sf')
parser.add_argument('--review', type=Path, help='Reviewed input lock, facility checks and access baselines; defaults to PROJECT/graph/REGION, or PROJECT/graph for SF')
parser.add_argument('--output', type=Path, help='Build/evidence directory; defaults to PROJECT/build/REGION')
args = parser.parse_args()
W, D = args.project.resolve(), args.data.resolve()
B = (args.output or W / 'build' / args.region).resolve()
E, engine = B / 'evidence', W / 'engine'
review = (args.review or default_review_dir(args.region, W)).resolve()
config = load_region_config(args.region, W)
build_config = {key: config[key] for key in ['bounds', 'admin_states']}
quality_path = review / 'quality.json'
if not quality_path.is_file() or json.loads(quality_path.read_text()).get('region') != args.region:
    parser.error(f'No reviewed inputs for region {args.region!r} in {review}; pass --review DIR or add graph/{args.region}/. See {ADDING_A_REGION}')

def sha(path):
    with path.open('rb') as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
        return digest.hexdigest()

def run(command, log=None, cwd=None):
    if log:
        with (E / log).open('w') as out:
            subprocess.run(list(map(str, command)), cwd=cwd, stdout=out, stderr=subprocess.STDOUT, check=True)
    else:
        subprocess.run(list(map(str, command)), cwd=cwd, check=True)

# Validate all geographic inputs before compiling or modifying the data directory.
locked = json.loads((review / 'inputs.lock.json').read_text())
quality = json.loads((review / 'quality.json').read_text())
if quality['region'] != args.region or not quality['facilities'] or quality['minimum_bicycle_nodes'] < 1:
    raise ValueError('Reviewed region, positive node threshold and facility checks are required')
if not isinstance(quality.get('expected_walking_edges'), int) or quality['expected_walking_edges'] < 0:
    raise ValueError('Reviewed expected_walking_edges must be a nonnegative integer')
for name in ['region.osm.pbf', 'admin-input.osm.pbf']:
    if name not in locked:
        raise ValueError(f'Missing locked input: {name}')
for name, digest in locked.items():
    path = (D / name).resolve()
    if path.is_relative_to(D) and not path.is_file():
        raise ValueError(f'Missing input file: {name} in {D}')
    if not path.is_relative_to(D) or sha(path) != digest:
        raise ValueError(f'Input mismatch: {name}')
# Check DEM coverage for the extraction buffer, not just service bounds.
import math
for lat in range(math.floor(config['bounds']['bottom']), math.floor(config['bounds']['top']) + 1):
    for lon in range(math.floor(config['bounds']['left']), math.floor(config['bounds']['right']) + 1):
        ns, ew = f'{"N" if lat >= 0 else "S"}{abs(lat):02}', f'{"E" if lon >= 0 else "W"}{abs(lon):03}'
        name = f'elevation/{ns}/{ns}{ew}.hgt'
        if name not in locked or (D / name).stat().st_size not in (1201 * 1201 * 2, 3601 * 3601 * 2):
            raise ValueError(f'Missing locked DEM coverage: {name}')
for name in ['target-ways.json', 'baseline-access-overrides.json', 'baseline-graph-edges.jsonl']:
    if not (review / name).is_file():
        raise ValueError(f'Missing review file: {name}')
if any((D / name).exists() for name in ['tiles', 'tiles-before-access', 'admin.sqlite', 'bikesy-policy.bin', 'bikesy-stairs.txt']):
    raise ValueError('Fresh data directory required')
E.mkdir(parents=True, exist_ok=False)
for name in ['target-ways.json', 'baseline-access-overrides.json', 'baseline-graph-edges.jsonl', 'inputs.lock.json', 'quality.json']:
    shutil.copyfile(review / name, E / name)
run([sys.executable, engine / 'apply_patch.py', '--check'])
run(['sh', 'build.sh'], 'rebuild-engine.log', engine)
run([sys.executable, W / 'scripts/check-bicycle-access.py'], 'lua-access-tests.log')
run([sys.executable, W / 'scripts/check-facilities.py'], 'lua-facility-tests.log')
run([sys.executable, W / 'scripts/check-surfaces.py'], 'lua-surface-tests.log')
run([sys.executable, W / 'scripts/prepare-bicycle-access.py', D, *(['--paved-surface-defaults'] if config.get('paved_surface_defaults') else [])])
cfg = json.loads((W / 'config/valhalla-build.json').read_text())
cfg['mjolnir'].update(tile_dir=str(D / 'tiles'), tile_extract='', admin=str(D / 'admin.sqlite'), graph_lua_name=str(D / 'bikesy-graph.lua'))
cfg['additional_data']['elevation'] = str(D / 'elevation')
(D / 'valhalla.json').write_text(json.dumps(cfg, indent=2))
run(['valhalla_build_admins', '-c', D / 'valhalla.json', D / 'admin-input.osm.pbf'], 'rebuild-admin.log')
run([engine / 'out/export_country'], 'us-access-defaults.json')
run([sys.executable, W / 'scripts/complete-regional-admin.py', D / 'admin.sqlite', E / 'us-access-defaults.json', '--states', *config['admin_states']])
(D / 'tiles').mkdir()
run(['valhalla_build_tiles', '--concurrency', '2', '-c', D / 'valhalla.json', D / 'region.osm.pbf'], 'rebuild-graph.log')
run([engine / 'out/graph_quality', D / 'valhalla.json', E / 'target-ways.json', E / 'corrected-graph-edges.jsonl'], 'corrected-graph-quality.json')
run([sys.executable, W / 'scripts/check-graph-quality.py', E, E / 'quality.json'])
run([sys.executable, W / 'scripts/remap-access.py', B, E / 'baseline-access-overrides.json'])
policy = json.loads((E / 'access-overrides-rebound.json').read_text())
policy['input_graph_files'] = {str(p.relative_to(D / 'tiles')): sha(p) for p in sorted((D / 'tiles').rglob('*.gph'))}
(E / 'access-overrides.json').write_text(json.dumps(policy, indent=2))
shutil.copytree(D / 'tiles', D / 'tiles-before-access')
run([sys.executable, engine / 'apply-access.py', D / 'valhalla.json', E / 'access-overrides.json'], 'rebuild-access.log')
run([engine / 'out/validate_access', D / 'valhalla.json', E / 'access-overrides.json', D / 'tiles-before-access', quality['expected_walking_edges']], 'access-invariants.jsonl')
bounds = config['bounds']
# Optional per-region hill-cost exponent (config `hill_cost.exponent`); omitted means the original cubic.
hill_exponent = config.get('hill_cost', {}).get('exponent')
run([engine / 'out/build_policy', D / 'valhalla.json', D / 'bikesy-policy.bin', *[bounds[k] for k in ['left', 'bottom', 'right', 'top']],
     *([] if hill_exponent is None else [hill_exponent])], 'rebuild-policy.log')
run([sys.executable, W / 'scripts/extract-stair-tags.py', D / 'region.osm.pbf', E])
run([sys.executable, W / 'scripts/build-stairs.py', E / 'corrected-graph-edges.jsonl', E / 'stair-tags.json', D / 'bikesy-stairs.txt'])
os.environ.update(BIKESY_POLICY_DATA=str(D / 'bikesy-policy.bin'), BIKESY_STAIRS_DATA=str(D / 'bikesy-stairs.txt'))
run([engine / 'out/engine_cost_test', D / 'valhalla.json'], 'engine-cost-tests.json')
bound = [D / n for n in ['admin.sqlite', 'bikesy-policy.bin', 'bikesy-stairs.txt', 'valhalla.json']]
bound += sorted((D / 'tiles').rglob('*.gph')) + sorted((D / 'elevation').rglob('*.hgt'))
(E / 'gated-build.json').write_text(json.dumps({
    'passed': True, 'region': args.region, 'build_config': build_config,
    'engine_sha256': sha(engine / 'out/valhalla_service'),
    'review_files': {p.name: sha(p) for p in E.iterdir() if p.name in ['inputs.lock.json', 'quality.json', 'target-ways.json', 'baseline-access-overrides.json', 'baseline-graph-edges.jsonl']},
    'files': {str(p.relative_to(D)): sha(p) for p in bound},
}, indent=2) + '\n')
print(f'{args.region} gates passed; evidence: {E}. No service started.')

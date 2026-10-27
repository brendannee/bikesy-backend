#!/usr/bin/env python3
"""Package a gated rebuild into a NEW private runtime-image build context."""
from region_common import load_region_config, region_name
import sys
import argparse,pathlib,json,hashlib,shutil
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('data',type=pathlib.Path)
p.add_argument('destination',type=pathlib.Path)
p.add_argument('--region', type=region_name, default='sf')
p.add_argument('--build', type=pathlib.Path, help='Build directory from rebuild-variant.py')
a=p.parse_args();root=pathlib.Path(__file__).resolve().parents[1]
e=(a.build or root/'build'/a.region)/'evidence';source=a.data.resolve();dest=a.destination.resolve()
assert not dest.exists(),'Destination must be new'
gate=json.loads((e/'graph-quality-gate.json').read_text());assert gate['passed']
# Valhalla logs to stdout ahead of engine_cost_test's one-line JSON summary.
assert json.loads((e/'engine-cost-tests.json').read_text().splitlines()[-1]).get('passed') is True and (e/'access-invariants.jsonl').stat().st_size
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
receipt=json.loads((e/'gated-build.json').read_text());assert receipt['passed']
assert receipt['region']==a.region and gate['region']==a.region
config=load_region_config(a.region,root)
assert {key:config[key] for key in ['bounds','admin_states']}==receipt['build_config']
for name,digest in receipt['review_files'].items():assert sha(e/name)==digest,name
assert sha(root/'engine/out/valhalla_service')==receipt['engine_sha256']
for name,expected in receipt['files'].items():assert sha(source/name)==expected,name
for name,expected in json.loads((e/'inputs.lock.json').read_text()).items():assert sha(source/name)==expected,name
dest.mkdir(parents=True);(dest/'engine').mkdir();out=dest/'data';out.mkdir()
for name in ['tiles','elevation']:shutil.copytree(source/name,out/name)
for name in ['admin.sqlite','bikesy-policy.bin','bikesy-stairs.txt']:shutil.copyfile(source/name,out/name)
shutil.copyfile(root/'config/valhalla-runtime.json',out/'valhalla.json')
shutil.copyfile(root/'engine/out/valhalla_service',dest/'engine/valhalla_service')
files={str(f.relative_to(out)):sha(f) for f in sorted(out.rglob('*')) if f.is_file()}
lock={'region':a.region,'build_config':receipt['build_config'],'policy':'bikesy-distance-v1','graph_access_policy':'bikesy-access-v1','graph_import_policy':'bikesy-import-v2','stair_policy':'counted-stairs-v1','engine_sha256':sha(dest/'engine/valhalla_service'),'files':files}
(out/'engine-policy.json').write_text(json.dumps(lock,indent=2)+'\n')
shutil.copyfile(root/'engine/Dockerfile.data',dest/'Dockerfile')
print(f'Packaged {len(files)} files. This creates no registry upload or deployment. Validate routes before publishing {dest}.')

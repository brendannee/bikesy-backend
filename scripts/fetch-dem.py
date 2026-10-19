#!/usr/bin/env python3
"""Acquire uncompressed Skadi HGT tiles; lock-inputs.py freezes their checksums."""
import argparse
import gzip
import json
import math
import os
import tempfile
from pathlib import Path
from urllib.request import urlopen
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('config', type=Path)
parser.add_argument('data', type=Path)
parser.add_argument('--resume', action='store_true', help='Reuse complete tiles after an interrupted acquisition')
args = parser.parse_args()
if (args.data / 'inputs.lock.json').exists():
    raise SystemExit('Refusing to modify a locked data release')
config = json.loads(args.config.read_text())
b = config['bounds']
for lat in range(math.floor(b['bottom']), math.floor(b['top']) + 1):
    for lon in range(math.floor(b['left']), math.floor(b['right']) + 1):
        ns = f'{"N" if lat >= 0 else "S"}{abs(lat):02}'
        ew = f'{"E" if lon >= 0 else "W"}{abs(lon):03}'
        name = f'{ns}{ew}.hgt'
        destination = args.data / 'elevation' / ns / name
        if destination.exists():
            if args.resume and destination.stat().st_size in (1201 * 1201 * 2, 3601 * 3601 * 2):
                print(f'Reusing {destination}', flush=True)
                continue
            raise SystemExit(f'Refusing to replace {destination}; use --resume for complete tiles or a fresh data release directory')
        url = f'https://elevation-tiles-prod.s3.us-east-1.amazonaws.com/skadi/{ns}/{name}.gz'
        print(url, flush=True)
        with urlopen(url, timeout=120) as response:
            with gzip.GzipFile(fileobj=response) as compressed:
                payload = compressed.read(3601 * 3601 * 2 + 1)
        if len(payload) not in (1201 * 1201 * 2, 3601 * 3601 * 2):
            raise SystemExit(f'Unexpected DEM tile size: {name}')
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Publish only complete tiles, and never replace a concurrent download.
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as out:
                temporary = Path(out.name)
                out.write(payload)
            # NamedTemporaryFile is 0600; HGT inputs are shared read-only data.
            os.chmod(temporary, 0o644)
            os.link(temporary, destination)
        finally:
            if temporary is not None:
                temporary.unlink()

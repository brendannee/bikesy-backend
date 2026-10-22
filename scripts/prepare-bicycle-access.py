#!/usr/bin/env python3
"""Prepare or verify the pinned bicycle-only import profile in a fresh data release."""
import argparse
import hashlib
import json
from pathlib import Path

UPSTREAM_SHA256 = 'eda40a1a943e5f8347768018e03bb5500d4c09422334a28b91c40ab68f2ca8e5'
ROOT = Path(__file__).resolve().parent

def profile(paved_surface_defaults=False):
    upstream = (ROOT / 'vendor/valhalla-3.5.1-graph.lua').read_bytes()
    if hashlib.sha256(upstream).hexdigest() != UPSTREAM_SHA256:
        raise ValueError('Pinned upstream tag transformer checksum mismatch')
    wrapper = (ROOT / 'bicycle-access.lua').read_bytes()
    combined = upstream + b'\n' + wrapper
    manifest = {'profile': 'bikesy-bicycle-access-v2-facilities', 'routing_mode': 'bicycle-only',
                'engine_source': 'd377c8ace9ea88dfa989466258bf738b1080f22a',
                'upstream_sha256': UPSTREAM_SHA256,
                'wrapper_sha256': hashlib.sha256(wrapper).hexdigest(),
                'combined_sha256': hashlib.sha256(combined).hexdigest()}
    if paved_surface_defaults:
        # Opt-in layer (region config `paved_surface_defaults`). Without it the profile and
        # its lock are byte-identical to the facilities-only profile.
        layer = (ROOT / 'bicycle-surface-defaults.lua').read_bytes()
        combined = combined + b'\n' + layer
        manifest.update(profile='bikesy-bicycle-access-v3-surfaces',
                        surface_defaults_sha256=hashlib.sha256(layer).hexdigest(),
                        combined_sha256=hashlib.sha256(combined).hexdigest())
    return combined, manifest

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('data', type=Path)
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--paved-surface-defaults', action='store_true',
                        help='append bicycle-surface-defaults.lua (region config paved_surface_defaults)')
    args = parser.parse_args()
    combined, manifest = profile(args.paved_surface_defaults)
    output, lock = args.data / 'bikesy-graph.lua', args.data / 'graph-profile.lock.json'
    if args.verify:
        if output.read_bytes() != combined or json.loads(lock.read_text()) != manifest:
            raise SystemExit('Graph profile mismatch; use the matching source or build a fresh release')
        print('Pinned bicycle-only graph profile verified')
        return
    if output.exists() or lock.exists():
        raise SystemExit('Graph profile already exists; use a fresh release directory')
    with output.open('xb') as stream:
        stream.write(combined)
    with lock.open('x') as stream:
        json.dump(manifest, stream, indent=2)
        stream.write('\n')
    print(lock)

if __name__ == '__main__':
    main()

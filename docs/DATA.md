# Engine and routing-data releases

Normal Git pushes reuse the already-hosted immutable runtime image. No PBF, DEM, tiles, database or executable belongs in Git. The bootstrap data artifact is the existing VCR digest in `release.json`; no object-storage upload is needed.

For Tahoe, new regions or separate regional application images, follow [REGIONS.md](REGIONS.md). SF remains the default; region-specific build evidence lives under `build/REGION/`.

## Rebuild prerequisites

The tested build is Valhalla 3.5.1, source commit `d377c8ace9ea88dfa989466258bf738b1080f22a`, runtime digest in `engine/source-lock.json`. `engine/bikesy-3.5.1.patch` includes both the distance/ferry policy and counted stairs. `python3 engine/apply_patch.py --check` reconstructs it with strict context matching and validates the vendored upstream and complete patched source hashes. It does not download anything. `--apply` explicitly restores the two patched upstream source files.

The exact cached amd64 toolchain on the validation Mac is `sha256:0e8d3acfef285220db8359b346f8e4c33a78cbc96913a154d2ccc685b1f63953`. Compiling this package in that image reproduced the deployed engine SHA `82c32a1218531ac87de394699791212e32989147f3c17b705140cbac35fa755d` exactly. Another machine must obtain that toolchain backup or build and separately validate `engine/Dockerfile.toolchain`. Its upstream runtime is pinned, but apt package versions are not frozen; rebuilding that toolchain is not claimed to reproduce the same binary bytes. Do not install/build it merely to deploy ordinary JS changes.

Allow 2 CPUs, 6 GiB RAM and roughly 8 GiB temporary disk. Raw rebuild inputs are excluded from this source archive and from the runtime image:

- `region.osm.pbf`: `d4981aa8350a53dffc4e4263d2df7c77f87a89716296b7bee5541ebd5a4e84b6`.
- Full California extract, originally `california-260930.osm.pbf`, copied as `admin-input.osm.pbf`: `1c5d4f0f765fac1e56a2aa4f04ad48489a579a94e41edc12b57b7c7c13860db1`.
- Six decompressed HGT files under `elevation/`; all input paths/hashes are in `graph/inputs.lock.json`.

These originals remain in the validation workspace's `handoff/valhalla-backend/data/extended-bay/`. Keep an independent backup for long-term exact reproduction. A current download may contain different bytes and must not silently replace the input lock. The default SF admin correction uses California; Tahoe requires complete California and Nevada administrative polygons. Changing input geography/date requires renewed access/facility review and route calibration.

## Fresh offline build

From this source directory, set `BIKESY_INPUTS` to the directory containing those three inputs. Use a fresh disposable container and fresh output directories. This sequence starts no route server and publishes no port:

```sh
docker run -d --name bikesy-data-rebuild --network none --platform linux/amd64 \
  --cpus 2 --memory 6g --memory-swap 6g --entrypoint /bin/sleep \
  sha256:0e8d3acfef285220db8359b346f8e4c33a78cbc96913a154d2ccc685b1f63953 infinity
tar -czf /tmp/bikesy-rebuild-source.tar.gz scripts config graph engine test
docker cp /tmp/bikesy-rebuild-source.tar.gz bikesy-data-rebuild:/tmp/source.tar.gz
docker exec bikesy-data-rebuild sh -ec 'mkdir /work /data; tar -xzf /tmp/source.tar.gz -C /work'
docker cp "$BIKESY_INPUTS/region.osm.pbf" bikesy-data-rebuild:/data/region.osm.pbf
docker cp "$BIKESY_INPUTS/california-260930.osm.pbf" bikesy-data-rebuild:/data/admin-input.osm.pbf
docker cp "$BIKESY_INPUTS/elevation" bikesy-data-rebuild:/data/elevation
docker exec bikesy-data-rebuild python3 /work/scripts/rebuild-variant.py
docker exec bikesy-data-rebuild python3 /work/scripts/package-data.py /data /work/build/sf/runtime
mkdir -p build
docker cp bikesy-data-rebuild:/work/build/sf/runtime build/runtime
docker cp bikesy-data-rebuild:/work/build/sf/evidence build/rebuild-evidence
docker rm -f bikesy-data-rebuild
docker build --platform linux/amd64 -t bikesy-routing-data:candidate build/runtime
```

The rebuild compiles engine/helpers; verifies 27 access and 13 facility Lua fixtures; reconstructs the regional admin DB with US defaults; builds graph tiles; checks driving side and four facility ways; rebinds 13 directed exceptions by OSM way, orientation and full geometry; fingerprints the graph before applying the narrow access overlay; verifies allowed edge differences; and rebuilds hill/connectivity plus stair indexes (hill cost: `docs/HILL-COST.md`). The policy extraction buffer is **-123.15, 37.20, -121.51, 38.42**, larger than service bounds. The full-graph engine cost check must pass before a hash-bound `gated-build.json` receipt is written. The packager requires that receipt and matching inputs/outputs.

The source release was compiled and route-tested; a full graph rebuild was not repeated during packaging. The unchanged construction logic was previously reproduced in the isolated experiment. Newly added receipt/package steps need a fresh build receipt for a future data release. Preserve every failed gate; never bypass assertions by substituting old graph IDs or widening access.

## Startup verification after packaging

The final application image's `Dockerfile.vercel` runs exhaustive
`scripts/verify-release.mjs --image` after copying application files. It binds the
source lock, base-image manifest, every data file (including `valhalla.json`),
engine and application configuration to `release.json`. Normal immutable-image
startup uses lighter manifest/configuration hashes plus safe-path, regular-file
and readability checks, while retaining the full engine hash and readiness probes.

Use `BIKESY_DATA_VERIFICATION=full` when validating mutable local datasets. Both
modes require a matching release manifest and approved active configuration.
Light mode cannot detect same-path bulk-data content corruption after the image
was verified. See [startup timing and integrity checks](../README.md#startup-timing)
for mode selection, log fields and performance-measurement limits.

## Publish a future data release

After validating the candidate's route/bridge/stair cases, publish it under a new versioned tag in a private `routing-data` repository in the same Vercel project. This is a deliberate later upload/storage operation; it was not performed here. Use an authorized VCR login, `docker tag`, and `docker push`; record the resulting **manifest digest**, not the local image ID or a mutable tag.

Update these together in a reviewed commit:

1. `Dockerfile.vercel`'s default `BIKESY_RUNTIME_IMAGE` and `release.json.runtime_image` to the new `vcr.vercel.com/...@sha256:...`.
2. `graph/deployed-runtime.lock.json` to the exact bytes of `build/runtime/data/engine-policy.json`.
3. `release.json.data_lock_sha256`, `engine_sha256`, image size and validation metadata for the new artifact. Keep older validation labeled as historical.

Deploy a Preview, check build-time/runtime hash verification and rerun route regressions before main/Production use. Keep the previous source commit and its base image for rollback; a Git revert restores the pinned pair. Data updates have a separate cadence from code pushes. Do not fetch raw data or unpack archives on a request or cold start.

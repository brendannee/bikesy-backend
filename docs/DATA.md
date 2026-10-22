# Engine and routing-data releases

Normal Git pushes reuse the already-hosted immutable runtime image. No PBF, DEM, tiles, database or executable belongs in Git. The bootstrap data artifact is the existing VCR digest in `release.json`; no object-storage upload is needed.

For Tahoe, new regions or separate regional application images, follow [REGIONS.md](REGIONS.md). SF remains the default; region-specific build evidence lives under `build/REGION/`.

## Rebuild prerequisites

The tested build is Valhalla 3.5.1, source commit `d377c8ace9ea88dfa989466258bf738b1080f22a`, runtime digest in `engine/source-lock.json`. `engine/bikesy-3.5.1.patch` includes the distance/ferry policy, counted stairs, the opt-in two-class [surface preference](REGIONS.md#surface-preference) and the opt-in [busy-road preference](REGIONS.md#busy-roads). `python3 engine/apply_patch.py --check` reconstructs it with strict context matching and validates the vendored upstream and complete patched source hashes. It does not download anything. `--apply` explicitly restores the two patched upstream source files.

The exact cached amd64 toolchain on the validation Mac is `sha256:0e8d3acfef285220db8359b346f8e4c33a78cbc96913a154d2ccc685b1f63953`. Compiling the package as released (before the surface preference was added) in that image reproduced the deployed engine SHA `82c32a1218531ac87de394699791212e32989147f3c17b705140cbac35fa755d` exactly; the surface preference changes the engine bytes, so a release with it needs a new data package. Another machine must obtain that toolchain backup or build and separately validate `engine/Dockerfile.toolchain`. Its upstream runtime is pinned, but apt package versions are not frozen; rebuilding that toolchain is not claimed to reproduce the same binary bytes. Do not install/build it merely to deploy ordinary JS changes.

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

The rebuild compiles engine/helpers; verifies 27 access, 13 facility and 23 surface-default Lua fixtures; reconstructs the regional admin DB with US defaults; builds graph tiles; checks driving side and four facility ways; rebinds 13 directed exceptions by OSM way, orientation and full geometry; fingerprints the graph before applying the narrow access overlay; verifies allowed edge differences; and rebuilds hill/connectivity plus stair indexes (hill cost: `docs/HILL-COST.md`). The policy extraction buffer is **-123.15, 37.20, -121.51, 38.42**, larger than service bounds. The full-graph engine cost check must pass before a hash-bound `gated-build.json` receipt is written. The packager requires that receipt and matching inputs/outputs.

**Surface defaults (opt-in).** A region whose config sets `"paved_surface_defaults": true` (Tahoe) gets
`scripts/bicycle-surface-defaults.lua` appended to its import profile, after the access and
facility wrapper. It tags as paved the ways that Valhalla would otherwise call compacted but that
are paved for riding: untagged `highway=footway` sidewalks and crossings (unless `tracktype`,
`sac_scale` or `mtb:scale` imply a surface), `surface=wood` or `boardwalk` (wooden bridges and
boardwalks, as in the frontend's overlays), and untagged `bridge=boardwalk` ways. `mtb:scale` still
overrides the surface, and access never changes; `scripts/check-surfaces.py` runs 23 fixtures
through the real pinned Lua and asserts the filter and every non-surface field match the access
wrapper's (`lua-surface-tests.log` in the evidence). Without the option the combined profile and
`graph-profile.lock.json` are byte-identical to the facilities-only profile
(`bikesy-bicycle-access-v2-facilities`); with it the lock names `bikesy-bicycle-access-v3-surfaces`
and adds the layer's hash. SF does not set it. Effects, on the Tahoe 2026-10-19 graph with the
tuned scenarios (3,732 routes over four sets): 48 differ (1.3%; 35 of the 2,532 routes in the curated, sampled and realistic sets). Only four are in
scenarios 1 and 2 (the earlier estimate of about 3 in 1,120 default routes holds); the rest are in the
surface-preference scenarios, where paved or unpaved class changes the cost. Most differ by a few hundred metres, and most are shorter.

- Untagged crossings were already paved (pedestrian-crossing edges default to paved),
  and untagged sidewalks without a `bicycle` tag are pedestrian-only, so for bicycles
  the change mostly concerns wooden bridges (114 `surface=wood` ways) and about 0.4 km
  of bike-legal untagged sidewalk.
- Paths, cycleways, tracks and footways keep their cost; their time estimates use
  Hybrid's paved speed (about 22% faster than compacted).
- With the surface preference keys, a boardwalk now counts as paved, so Prefer Dirt avoids it and
  Prefer Paved uses it; the biggest effects are a few Prefer Dirt routes (Tahnu Leweh to Seven Owners
  Park reverse, 1.17 to 1.53 detour) and some Prefer Paved routes that gain a boardwalk shortcut.
- Valhalla halves the stored speed of edges from `paved_rough` down, and bicycle
  costing uses that speed as traffic stress on road-class edges. Wooden road and
  service bridges therefore cost 20-40% more per edge when `use_roads` is below 1
  (Tahoe scenario 1). With `use_roads` 1 (scenario 2) costs are unchanged. This is
  intended: the bridge carries the same traffic as the road on either side, and the
  lower stress only came from the halved speed. Keeping road bridges compacted would
  also make the surface preference (`unpaved_penalty`/`paved_penalty`) treat them as
  unpaved.

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

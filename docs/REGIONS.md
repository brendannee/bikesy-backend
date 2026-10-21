# Regional builds

SF remains the default; Tahoe is the second region. Each container serves one
region. Set `BIKESY_CONFIG` to select its self-contained config. To add another
region, follow [Adding a region](#adding-a-region). For local development with Node 22.9+:

```sh
cp .env.example .env
```

Use `BIKESY_CONFIG=./config/tahoe.json` in `.env` for Tahoe, then run:

```sh
npm run start:adapter
```

Both `npm start` and `npm run start:adapter` automatically load `.env` when present.
Shell environment variables take precedence. `BIKESY_CONFIG` is the only runtime
selector; when unset, it defaults to `config/sf.json`. Generated Docker images
set an absolute `BIKESY_CONFIG` path for their region and do not include `.env`.

This adapter command requires a separately running, patched Tahoe engine and data.
Changing the region does not download or replace routing data. The checked-in
Dockerfile still pins the existing SF image. Starting it with Tahoe selected fails
with a region mismatch, even if the application config hash is approved.

## Region config reference

A region is a single file, `config/REGION.json`, whose `region` value equals its file
name. Region configs are discovered automatically: `scripts/lock-source.mjs` locks
every one into `release.json`, the test suites validate every one, and
`node scripts/check-region.mjs [REGION]` (`npm run check:regions`) reports what each
still needs. Files without a `region` key, such as `valhalla-*.json`, are engine
settings. Startup rejects unknown keys and names the offending key and file.

| Key | Required | Meaning | Changing it requires |
| --- | --- | --- | --- |
| `region` | yes | Lowercase slug (`[a-z][a-z0-9-]{0,47}`), the data release identity. It does not load another file. | New data release |
| `bounds` | yes | `left`, `bottom`, `right`, `top` in degrees: the OSM extraction, DEM coverage and policy-index rectangle. Tahoe uses `-120.5,38.65,-119.55,39.5`. | New data release |
| `admin_states` | yes | Every US state the bounds touch, by postal code, each once. Complete state polygons are required for the build. | New data release |
| `bounds_inset` | no | Inward margin in degrees for the public service area (`/bounds` and route validation). A number applies to all sides; an object sets `left`, `bottom`, `right`, `top`. Omit or use zero to serve the whole rectangle. The SF/Tahoe per-side values preserve their original service areas exactly. | App release |
| `scenarios` | yes | Map of positive integer ids to bicycle costing options. `"1"` is required and is the default. `use_hills` and `use_roads` are 0 to 1; optional `maneuver_penalty` is nonnegative. Optional surface keys are validated too: `bicycle_type` (`Road`, `Cross`, `Hybrid` (the default) or `Mountain`), `avoid_bad_surfaces` (0 to 1), and `unpaved_penalty`/`paved_penalty` (0 to 10; see [Surface preference](#surface-preference)). Other keys pass through to Valhalla's bicycle costing unchecked. Ferries are always disabled. | App release |
| `readiness` | yes | `locations` (two `{lat, lon}` inside the service area) and a configured `scenario`. Startup routes this trip and samples its elevation before listening. | App release |
| `engine_policy` | yes | Must be `"bikesy-distance-v1"`. | Engine release |

Data manifests bind `bounds` and `admin_states`; startup rejects a mismatch with the
packaged data. The Tahoe readiness coordinates are a Tahoe City route. They routed
(999 m, both scenarios, with elevation) against a build of the 2026-10-12 Geofabrik
snapshot; re-validate them against each new graph before publishing. The backend serves JSON
APIs only; route responses include native elevation.

## Surface preference

The stock Valhalla surface term (`avoid_bad_surfaces`) grades surfaces in four steps
(factors 1, 2.5, 4.5 and 7) starting at a surface that depends on `bicycle_type`. For
the default Hybrid it starts at dirt, so compacted surfaces, which include every
untagged footway and path, cost the same as asphalt. A scenario can instead use a
two-class model:

| Key | Range | Adds to the edge factor on |
| --- | --- | --- |
| `unpaved_penalty` | 0 to 10, default 0 | Unpaved edges: compacted, dirt, gravel and path surfaces (untagged paths, tracks, singletrack, `fine_gravel`, `unpaved`) |
| `paved_penalty` | 0 to 10, default 0 | Paved edges: Valhalla's `paved_smooth`, `paved` and `paved_rough` |

The edge cost is meters times a factor, `1 + (1 - use_roads) * stress`, plus the
uphill term. When a scenario has either key, the engine adds
`paved_penalty` or `unpaved_penalty` to that factor, in the same units as the stock
term, and drops the stock `avoid_bad_surfaces` cost term. A penalty of 1 makes a meter
of that class cost like two meters of the other at zero stress. Use
`unpaved_penalty` to prefer pavement and `paved_penalty` to prefer dirt.

- **Without either key, costs are bit-identical** to the engine before this option:
  the stock surface term is unchanged, so existing scenarios (all of SF and Tahoe)
  route exactly as before.
- **`avoid_bad_surfaces`** has no cost effect alongside these keys, so config
  validation accepts only 0 or 1 there. Its value 1 still forbids surfaces worse than
  `bicycle_type` allows (compacted for Road, gravel for Cross, dirt for Hybrid).
- **Direct, ignore hills** (`use_roads` 1 and `use_hills` 1) normally costs pure
  meters. With a surface key, the penalty still applies (`meters * (1 + penalty)`),
  like the stair carrying penalty, so "shortest" means shortest on the preferred
  surface. Valhalla's explicit `shortest: true` means distance only, so validation
  rejects it alongside these keys.
- **Speed and time estimates** do not change; the surface still sets travel speed
  as before.
- **Classes come from the graph.** Valhalla takes `surface`, then `tracktype`;
  `mtb:scale` overrides both; an untagged footway, path, sidewalk or bridleway is
  compacted, an untagged track dirt, an untagged cycleway paved and roads paved.
  Tag `surface` in OSM rather than tuning around a missing tag.
- **Engine requirement.** The keys need an engine built from this repository's
  patch. An older engine silently ignores them, so pair a config that uses them only
  with a data image whose engine has the patch. `engine_policy` stays
  `"bikesy-distance-v1"` because requests without the keys are unchanged.

The engine links against the prebuilt `libvalhalla.a`, so it cannot add protobuf
fields. `ParseBicycleCostOptions` stores the two values in truck-only costing option
fields that bicycle costing and the shared `DynamicCost` base never read
(`low_class_penalty` and `hgv_no_access_penalty`), and sets them only when a key is
present. See the comment in `engine/src/bicyclecost.cc`.

### Tahoe scenarios

Tahoe pairs a "Traffic" select with a "Trail Surface" select, a 2 x 3 grid of scenarios.
Scenarios 1 and 2 keep their original meaning and costing (no surface keys), so old share
links route as before. Every scenario uses `use_hills` 0.5 and `maneuver_penalty` 2.

| Scenario | Traffic | Trail Surface | `use_roads` | Surface keys |
| --- | --- | --- | --- | --- |
| 1 (default) | Avoid Busy Roads | Paved and Dirt | 0 | none |
| 2 | Fastest Route | Paved and Dirt | 1 | none |
| 3 | Avoid Busy Roads | Prefer Paved | 0 | `unpaved_penalty` 2.5 |
| 4 | Fastest Route | Prefer Paved | 1 | `unpaved_penalty` 2.5 |
| 5 | Avoid Busy Roads | Prefer Dirt | 0 | `paved_penalty` 1.5, `bicycle_type` Mountain |
| 6 | Fastest Route | Prefer Dirt | 1 | `paved_penalty` 2, `bicycle_type` Mountain |

The surface keys need the engine with the two-class surface preference; without it
scenarios 3 to 6 route like 1 and 2. The penalties are starting values from the benchmark
sweeps in `bench/tunings/tahoe/`. Dirt scenarios can pass through wilderness the OSM data
does not mark `bicycle=no`.

## Adding a region

New regions must be within the United States and drive on the right (see
[Limits](#limits-of-the-region-abstraction)). Use a fresh slug, for example `reno`.

1. **Config.** Copy `config/tahoe.json` to `config/reno.json`. Set `region`, the
   extraction `bounds` (leave room for the inset; routes near the edge need
   surrounding roads), `admin_states` for every state the bounds touch,
   `bounds_inset`, `scenarios` and two in-region `readiness` locations on a
   bikeable road. Then run:

   ```sh
   node scripts/check-region.mjs reno
   ```

   It validates the config and prints the service area, required DEM tiles and what
   is still missing. Errors exit nonzero.
2. **Smoke trips.** Add representative trips under `"reno"` in
   `test/fixtures/smoke-regions.json`. Include trips crossing state lines or
   barriers (water, freeways) that the region has. Without them,
   `scripts/smoke-region.mjs` only routes the readiness trip.
3. **Lock and test.** Run `node scripts/lock-source.mjs`, `npm test` and
   `npm run test:data`. The tests pick up the new config automatically, including
   release-context generation for it. Commit the config, fixtures and `release.json`.
4. **Inputs.** Download same-snapshot OSM extracts for every state in
   `admin_states`, then follow [Prepare geographic inputs](#prepare-geographic-inputs-and-review)
   with `--config config/reno.json`: `prepare-admin.py`, `prepare-osm.py`,
   `fetch-dem.py` and `lock-inputs.py --build-lock graph/reno/inputs.lock.json`.
5. **Review.** Create `graph/reno/` with the other four review files described
   below. Inventory motorway mainlines and facilities from the actual extract; never
   copy another region's way IDs. `rebuild-variant.py --region reno` uses
   `graph/reno/` by default; `--review DIR` overrides it. Commit the reviewed files
   once approved, or keep them outside the repository and pass `--review`.
6. **Build and package** in the pinned toolchain with `--region reno`, as below.
   [`scripts/build-region.sh --region reno`](#one-command-build-scriptsbuild-regionsh)
   runs steps 4–7 in order and drafts the review files for step 5 (`propose-review.py`).
7. **Validate and release.** Build and run the image, then run
   `BIKESY_CONFIG=config/reno.json BIKESY_API_URL=... node scripts/smoke-region.mjs`.
   Use `prepare-release.py --region reno` and a separate Vercel project for the
   region, as in the [README](../README.md#deploy-to-vercel).
8. **Frontend.** Point the frontend's regional `BIKESY_API_URL` at the new
   deployment; the frontend needs its own region entry.

## One-command build (`scripts/build-region.sh`)

`scripts/build-region.sh` runs every step below in order on a Docker host and records
per-step wall-clock times in `WORKDIR/timings.tsv` and logs in `WORKDIR/logs/`. Each
step is skipped when its output already exists, so re-running resumes after a failure;
`--from STEP --to STEP` selects a range of
`preflight toolchain admin osm dem lock review build package app smoke`. It never
pushes an image or deploys. `--region` defaults to `sf`; pass `--region tahoe` explicitly.

```sh
# Inputs: one dated Geofabrik snapshot (replace YYMMDD), e.g.
#   https://download.geofabrik.de/north-america/us/california-YYMMDD.osm.pbf
#   https://download.geofabrik.de/north-america/us/nevada-YYMMDD.osm.pbf
#   https://download.geofabrik.de/north-america/us/california/norcal-YYMMDD.osm.pbf (optional)
scripts/build-region.sh --region tahoe --workdir /abs/path/tahoe-YYYY-MM-DD \
  --routing-pbf /abs/norcal-YYMMDD.osm.pbf --routing-pbf /abs/nevada-YYMMDD.osm.pbf \
  --admin-pbf /abs/california-YYMMDD.osm.pbf --admin-pbf /abs/nevada-YYMMDD.osm.pbf \
  --osm-source 'Geofabrik YYYY-MM-DD: routing norcal+nevada, admin california+nevada' \
  --carry-forward /abs/path/previous-reviewed-review-dir   # optional
```

- `--routing-pbf` may be `california` instead of `norcal` (same result for Tahoe, larger merge).
- `--admin-pbf` **must** be full state files. Geofabrik's `norcal` lacks 156 California
  boundary ways and `nevada` alone lacks one Nevada border way; `california` + `nevada`
  together contain both relations completely. `prepare-admin.py` checks this.
- Use a Python 3.12+ interpreter for host steps (`--python`, default `.venv/bin/python`).
- The toolchain image is tagged by the hash of `engine/Dockerfile.toolchain` and reused;
  DEM tiles can be reused from an earlier build with `--reuse-dem OLD/data/elevation`.
- The `review` step writes a **candidate** review (see below) and stops nothing: the
  following `build` proves the graph gates against it, but a human must review the
  candidate before the package is published. To build with an already reviewed
  directory, pass `--review DIR` (its `inputs.lock.json` must match this build's inputs).
- Measured on an Apple Silicon Mac (Docker Desktop, Rosetta, 8 CPUs/12 GiB) for Tahoe:
  toolchain image 220 s once; admin 12 s, osm 20 s, DEM 100 s (first fetch), review 4 s,
  gated build incl. engine compile 80 s, package 1 s, app 5 s, smoke 6 s — about 2 minutes
  for a rerun. Downloading the 1.3 GB California file dominated (about 23 minutes).
- Rebuilds are not byte-identical: `admin.sqlite` and some level-2 tiles differ between
  two runs on identical inputs (policy/stair indexes and routes matched). Bind and
  validate the package you actually built; don't expect old hashes to recur.
- `app` generates a `--bundle-data` application context with `prepare-release.py` and
  builds it locally; `smoke` runs it on `127.0.0.1:PORT` with full data verification
  and runs `scripts/smoke-region.mjs`.

### Drafting the review: `scripts/propose-review.py`

Runs in the toolchain against the prepared `region.osm.pbf` and only automates the
mechanical inventory:

- `baseline-access-overrides.json`: `osm_motorway_mainlines` = every `highway=motorway`
  way in the extract; `allow_motorway_ways`, `allow_directed_edges`, `walk_bicycle_ways`
  and `deny_ways` empty (conservative motorway exclusion). `review_status` says `candidate`.
- `quality.json`: two facility checks per admin state chosen only from unambiguous tags
  (two-way road, a single `cycleway`/`cycleway:both` value or equal left/right values),
  inside the service area and clearly away from the state line; `expected_walking_edges`
  0; `minimum_bicycle_nodes` = half of an intersection count estimated from the extract.
- `target-ways.json`, empty `baseline-graph-edges.jsonl`, and `inputs.lock.json`.
- `WORKDIR/review-candidates.json` (outside the review directory, informational only):
  motorway mainlines grouped by ref/name/bicycle tag with extents, motorway-class ways
  tagged with bicycle permission, chosen and alternative facility candidates, and with
  `--carry-forward` the mainline inventory diff against the previous review.

A human decides each run: which (if any) motorway ways/segments are legally and
practically rideable (`allow_motorway_ways` or exact `allow_directed_edges` with their
graph records), any `deny_ways`/`walk_bicycle_ways`, whether the facility checks are
real on the ground, and the node threshold (tighten it to about 95% of the
`bicycle_nodes` reported in `evidence/graph-quality-gate.json` after the first build).
With `--carry-forward`, these decisions are copied from the previous reviewed directory,
every referenced way must still exist, and the motorway inventory is regenerated; diff
the two directories (`diff -r OLD NEW`) and the `motorway_mainline_diff_vs_carry_forward`
list before approving.

## Prepare geographic inputs and review

Use Python 3.12+ for the acquisition/locking tools (on macOS, a virtualenv: the system
`python3` may be 3.9). Raw data, generated contexts and
build outputs stay outside Git. Download/extract OSM separately, retaining complete
ways and enough DEM coverage for the full extraction buffer. Examples below use
Tahoe, which spans CA and NV; substitute your region's config and states.

A fresh data directory needs:

- `region.osm.pbf`: the regional extraction matching the build buffer.
- `admin-input.osm.pbf`: complete administrative polygons for the config's
  `admin_states` (`CA` for SF, `CA` and `NV` for Tahoe), optionally their US
  parent. The admin helper rejects other administrative scope. A simple small routing bbox extract is not
  sufficient to supply complete state polygons, and neither is a sub-state extract:
  Geofabrik's `norcal` is missing California boundary ways. Use full state files from
  the same snapshot (Tahoe: `california` + `nevada`; each supplies border ways the other
  lacks). `scripts/prepare-admin.py` filters the state relations, merges, and rejects
  missing relation members (`osmium check-refs -r`).
- `elevation/`: uncompressed HGT rasters covering the full build buffer.

To merge state routing extracts (here California and Nevada), run this with `osmium-tool`
(it is included in the toolchain image, so on macOS run it there rather than
installing osmium on the host; `scripts/build-region.sh` does this):

```sh
python3 scripts/prepare-osm.py --config config/tahoe.json \
  --data /path/to/tahoe-data \
  --admin-input /path/to/prepared-ca-nv-admin.osm.pbf \
  /path/to/california.osm.pbf /path/to/nevada.osm.pbf
```

The helper merges the state files before extracting complete ways to `bounds`,
checks way-node references, and records source/output hashes. It accepts one input
for SF. Inputs must have the same nonempty replication timestamp; mismatched or
history snapshots fail. [Osmium merge](https://docs.osmcode.org/osmium/latest/osmium-merge.html)
deduplicates overlapping objects but does not reconcile different snapshots.
Allow temporary disk for the merged states plus the regional output.

`--admin-input` copies an already prepared administrative input unchanged. It does
not create complete state polygons from a clipped routing extract. Omit it only
if you will supply `admin-input.osm.pbf` separately before locking/building.

`node scripts/check-region.mjs REGION` lists the HGT tiles the bounds require; for
Tahoe these are N38/N39 × W120/W121. Acquisition is explicit:

```sh
python3 scripts/fetch-dem.py config/tahoe.json /path/to/tahoe-data
python3 scripts/lock-inputs.py /path/to/tahoe-data config/tahoe.json \
  --osm-source 'Describe dated regional AND administrative OSM inputs' \
  --dem-source 'Describe DEM source and acquisition date' \
  --build-lock /path/to/tahoe-review/inputs.lock.json
```

`--build-lock` includes the admin input and creates the flat hashes used by the
builder, alongside the normal provenance/coverage lock in the data directory.
Use `--verify --build-lock NEW_PATH` to export an already locked dataset.

A review directory contains five files. The builder uses `graph/REGION/` when it
exists; the original SF review lives directly in `graph/`. Pass `--review DIR` to
use another location. The build stops early if the directory's `quality.json`
names a different region.

| File | Contents |
| --- | --- |
| `inputs.lock.json` | Flat input filename → SHA-256 mapping from the command above. |
| `quality.json` | `region`, positive `minimum_bicycle_nodes`, nonnegative `expected_walking_edges`, and nonempty `facilities` array of `{ "way": OSM_WAY_ID, "cyclelane": EXPECTED_VALHALLA_VALUE }`. Choose reviewed bidirectional facilities across the region, including both sides of any state line. |
| `target-ways.json` | `{ "ways": [...] }`, including every facility check and any reviewed access exception. All stairs are exported independently. |
| `baseline-access-overrides.json` | Reviewed `osm_motorway_mainlines`, `allow_motorway_ways`, `allow_directed_edges`, `walk_bicycle_ways`, and `deny_ways` arrays. Inventory motorway mainlines from the actual extract. Empty allowance arrays retain conservative motorway exclusion. Do not copy SF allowances. |
| `baseline-graph-edges.jsonl` | Original graph records for any directed exceptions, including ID, way, orientation and full shape. May be empty only when there are no directed exceptions. |

The checked-in `graph/` review remains the SF baseline. Tahoe intentionally has no
fabricated facility IDs or approved input hashes. Obtain and review those against
its source extract before building. Existing full-graph driving-side, access,
positive-grade and stair checks remain mandatory. The stair gate still requires
stair metadata; it does not silently accept missing extraction results.

## Build and package in the pinned toolchain

Use the isolated toolchain setup in [DATA.md](DATA.md). Copy the project to `/work`,
fresh inputs to `/data`, and the Tahoe review directory to `/review` in that container.
The following commands are run **inside that toolchain**:

```sh
python3 /work/scripts/rebuild-variant.py --region tahoe --review /review
python3 /work/scripts/package-data.py /data /work/build/tahoe/runtime --region tahoe
```

`--review` may be omitted when the project copy contains `graph/REGION/`.
SF retains its existing input/review defaults:

```sh
python3 /work/scripts/rebuild-variant.py --region sf
python3 /work/scripts/package-data.py /data /work/build/sf/runtime --region sf
```

Evidence defaults to `/work/build/REGION/evidence`. To override it, pass
`--output BUILD_DIR` to the builder and `--build BUILD_DIR` to the packager.
Use separate source/toolchain containers for concurrent builds: engine outputs
are still shared under `engine/out` within each checkout.

Copy the runtime directory out, build its data image using the included Dockerfile,
then validate actual routes, elevations, border crossings and every configured scenario.
Review the generated graph/access evidence. Publish the data image only as a
separate authorized release action and record its immutable registry digest.

## Prepare the application image

Once a validated packaged runtime and its immutable image digest are available:

```sh
python3 scripts/prepare-release.py \
  --region tahoe \
  --runtime /path/to/tahoe-runtime \
  --image 'REGISTRY/IMAGE@sha256:ACTUAL_DIGEST' \
  --output build/tahoe-app

docker build --platform linux/amd64 -f build/tahoe-app/Dockerfile.vercel \
  -t bikesy:tahoe build/tahoe-app

docker run --rm --platform linux/amd64 -p 127.0.0.1:8080:80 bikesy:tahoe
```

The preparer verifies local package hashes and generates a separate Docker context,
release manifest and data lock. Its Dockerfile defaults to the selected region and
image. It does not alter the repository's SF release, download data, build images,
push or deploy. The Docker build verifies that the supplied image actually matches
the packaged data and engine. Data manifests bind the configured `bounds` and `admin_states`;
changing those requires rebuilding data. Inset/scenario/readiness changes only require a
new application release and route validation. Startup verifies region and build settings and probes
an in-region route and its elevation before listening.

The same workflow works with `--region sf` for a future SF data release. For ordinary
SF application edits, continue using the checked-in Dockerfile and
`node scripts/lock-source.mjs`; its engine/data pin is unchanged.

After deployment, configure the frontend's Tahoe `BIKESY_API_URL` to the Tahoe
endpoint and select `NEXT_PUBLIC_REGION=tahoe`. The frontend's old scenario `server`
fields do not select the current backend. This repository does not change that
frontend or its deployment.

## Limits of the region abstraction

- **US only.** `admin_states` accepts US postal codes; `prepare-admin.py` selects
  `ISO3166-2=US-XX` relations; `complete-regional-admin.py` creates or requires a
  `US` parent with US access defaults exported from the pinned Valhalla headers.
  A non-US region would need a country/subdivision admin scope in the config and
  those scripts, the matching country access defaults, and review of the Lua access
  profile's US-centric assumptions.
- **Right-hand traffic.** `check-graph-quality.py` requires every node to be
  drive-on-right. Left-hand regions would need that gate made configurable.
- **One rectangle.** Each region is a single bounding box; irregular areas need a
  larger box and inset, or a polygon extraction step that does not exist yet.
- DEM acquisition (`fetch-dem.py`) uses the global Skadi tiles and handles all
  hemispheres.

## Verification boundary

Offline tests cover region/config selection and validation for every
`config/REGION.json`, readiness requests, release binding, context generation and
geographic build gates. A full Tahoe graph/admin build,
C++ helper compilation, Docker build and live routing validation still require the
real inputs and pinned toolchain. Existing SF golden route fixtures remain SF-only;
`scripts/smoke-release.mjs` is the historical SF regression suite, not a Tahoe test.

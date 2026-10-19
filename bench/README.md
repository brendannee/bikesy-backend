# Route benchmark

Evaluate routing changes over a fixed set of origin/destination pairs and compare
tunings (costing options, hill-policy files, data images, or deployed APIs). It works
for any region with a `config/REGION.json`.

A **run** routes every trip (a pair in one direction) for every **mode** of every
**tuning**, computes per-route **metrics** and per-mode **aggregates**, and writes a
run directory. A **report** compares one or more runs against a baseline tuning in a
single static HTML file.

```sh
export BIKESY_BENCH_DIR=~/ws/ltbc/bikesy-data/bench        # runs/ and cache/ go here (default bench/out)
export BIKESY_BENCH_IMAGE=vcr.vercel.com/tahoebike/bikesy-backend/routing-data:v1-20261012
npm run bench -- --region tahoe                            # the production scenarios, curated + sampled pairs
npm run bench -- --region tahoe --tuning config --tuning hy50 --name hill-policy
npm run bench:report -- "$BIKESY_BENCH_DIR"/runs/2026-10-18-hill-policy
```

Requirements: Node 22.9+, Docker with the region's data image pulled locally, and
`osmium-tool` only for regenerating sampled pairs or wilderness areas. No npm packages.

## The engine

Runs talk to Valhalla directly, so any costing option works without a redeploy. The
runner starts a container per distinct engine (data image + policy file), named
`bench-<hash>`, on `127.0.0.1:18002` (`--port`), capped at 2 CPUs and 2 GB, and removes
it afterwards (`--keep-engine` leaves it running for the next run).

The production entrypoint (`serve.mjs`) verifies data hashes, which an experimental
policy file would fail. The bench starts `valhalla_service` directly instead, exactly
as `serve.mjs` does (`BIKESY_POLICY_DATA`, `BIKESY_STAIRS_DATA`, `/data` from the image),
with two differences: `BIKESY_POLICY_DATA` may point at a mounted override file, and it
uses a copy of the image's `/data/valhalla.json` that listens on all interfaces inside
the container and also enables `locate`, `trace_attributes` and `trace_route`. Routing
settings are untouched. Engine binary and data hashes are not re-verified; the run
records the image ID, the policy file hash and the image's `engine-policy.json`.

```sh
npm run bench:engine -- start --image IMAGE [--policy FILE] [--port 18002]   # by hand, e.g. for sample-pairs
npm run bench:engine -- status
npm run bench:engine -- stop --image IMAGE [--policy FILE]
```

To use an engine you started some other way, pass `--valhalla http://127.0.0.1:PORT/`;
the runner then manages no containers, and tunings that need their own engine fail.

## How requests match production

Local routes go through the production adapter itself (`createAdapter` in
`src/adapter.js`), configured with the mode's options as the only scenario and a
capturing `fetch`. Request building, `bicycle_type: Hybrid`, `use_ferry: 0`, the
land-disconnection ferry retry, error mapping and the `/height` elevation profile are
therefore production's, byte for byte. The run stores a hash of each user-visible
response (directions, path, distance, elevation, warnings).

`bench/crosscheck.mjs` compares those hashes between two tunings of a run. With the
`deployed` tuning (the public API) it proves the bench reproduces production:

```sh
npm run bench -- --region tahoe --tuning config --tuning deployed --sets curated --limit 3 --name crosscheck
node bench/crosscheck.mjs "$BIKESY_BENCH_DIR"/runs/2026-10-18-crosscheck
```

## Pair catalogs

`bench/pairs/REGION.json` is the curated set; `REGION-NAME.json` is another set (the
runner uses `curated` plus `sampled` by default; `--sets` picks). Sets stay separate in
all output so curated pairs cannot hide behaviour on the sampled ones.

```json
{ "region": "tahoe", "notes": "...", "pairs": [
  { "id": "es-carson-spooner", "name": "Carson City to Spooner Summit",
    "from": {"lat": 39.1638, "lon": -119.7674}, "to": {"lat": 39.10454, "lon": -119.89692},
    "via": {"lat": 39.1066828, "lon": -119.8840499},
    "tags": ["known-bug", "hills"], "why": "What this pair tests.",
    "references": [{"modes": {"traffic": "quiet"}, "gpx": "refs/carson-spooner.gpx"}],
    "expect": [
      {"modes": "*", "max_detour": 1.25},
      {"modes": {"traffic": "busy"}, "direction": "forward", "max_via_ratio": 1.25, "note": "..."}
    ] } ] }
```

- Pairs run in both directions unless `"one_way": true`. Ids must be unique.
- `via` (optional) also routes from→via and via→to for each mode, for the `via_ratio`
  metric (route additivity: a direct route much longer than one forced through a known
  good point means some edge cost is wrong).
- `references` (optional) are GPX tracks, relative to the catalog file, for the
  `reference_overlap` metric. `modes` selects which modes they apply to.
- `expect` entries select modes by **facets**, never by scenario number: `"*"` is every
  mode, `{"traffic": "quiet"}` every mode with that facet, `{"surface": ["dirt", "mixed"]}`
  any of, and `{"mode": "1"}` one mode by name. `direction` limits an entry to
  `forward` or `reverse`. Every other key is `max_<metric>` or `min_<metric>`, or
  `"route": false` to expect no route. A missing route fails every limit; a metric that
  does not apply (e.g. no reference) is skipped. Expectations whose facets match no mode
  of a tuning (say `surface: dirt` against production) are simply not evaluated.

### Sampled pairs

`bench/sample-pairs.mjs` draws seeded origin/destination pairs weighted toward where
people live, to avoid tuning to the curated pairs. OSM buildings and address nodes in
the extract are counted on a 500 m grid; a cell is chosen with probability proportional
to count^0.5 (`--alpha`), then a feature in it. Destinations must lie 3–13 km away in a
straight line, and both ends must snap to a routable bicycle edge within 150 m
(Valhalla `/locate`); the snapped points are stored. Sampled pairs are one-way.

```sh
npm run bench:engine -- start --image "$BIKESY_BENCH_IMAGE"
node bench/sample-pairs.mjs --region tahoe --pbf ~/ws/ltbc/bikesy-data/tahoe-2026-10-12/data/region.osm.pbf
```

The same extract, seed and engine give the same file. The Tahoe set (200 pairs, seed 1)
is about 60% Carson City and Carson Valley, which is where most of the extract's
buildings are; use `--alpha 0` (area-weighted) or a smaller `--max-km` to shift that.

### Wilderness areas

`bench/areas/REGION-wilderness.geojson` holds designated wilderness polygons
(`boundary=protected_area` titled "Wilderness Area" or `protected_area=wilderness_preserve`),
where bicycles are prohibited. Regenerate with
`node bench/build-areas.mjs --region tahoe --pbf .../region.osm.pbf`. Areas only partly
inside the extract (Mokelumne, for Tahoe) are incomplete and skipped.

## Tunings

`bench/tunings/REGION/NAME.json`. A tuning is a set of **modes**; each has **facets**
(free-form labels such as `traffic: quiet|balanced|busy`, `hills: flat|balanced|tolerant`,
`surface: paved|mixed|dirt`) and Valhalla bicycle costing **options**. Unknown option
keys pass through to Valhalla untouched (e.g. the upcoming `unpaved_penalty` and
`paved_penalty`; stock 3.5.1 ignores them).

```json
{
  "description": "Shown in the report.",
  "base": "config",
  "modes_from_config": false,
  "facets": { "1": { "surface": "mixed" } },
  "modes": {
    "quiet-paved": { "facets": { "traffic": "quiet", "surface": "paved" },
                     "options": { "use_hills": 0.5, "use_roads": 0, "maneuver_penalty": 2, "unpaved_penalty": 1 } },
    "2": null
  },
  "options": { "use_hills": 0.25 },
  "engine": { "image": "IMAGE", "policy": "~/path/to/bikesy-policy.bin" },
  "source": { "type": "valhalla" }
}
```

All keys are optional:

| Key | Meaning |
| --- | --- |
| `base` | Start from another tuning's modes, engine and source (by name, or `config`). |
| `modes_from_config` | Add one mode per `config/REGION.json` scenario, named by its id. |
| `facets` | Facet overrides for existing modes, by mode name. |
| `modes` | Add or merge modes by name (`facets`, `options`); `null` removes one. |
| `options` | Applied to **every** mode, overriding their options (what sweeps set). |
| `engine.image` | Data image (default `--image` / `$BIKESY_BENCH_IMAGE`). |
| `engine.policy` | Override `bikesy-policy.bin`, relative to the tuning file or `~/`. |
| `source` | `{"type": "valhalla"}` (default) or `{"type": "api", "url": ".../route", "rate_ms": 1000}`. |

Every mode also gets the facet `mode: <name>`. The file name is the tuning name.

The built-in **`config`** tuning (no file needed) derives modes from the region's
scenarios. Facets come from `configFacets` in `lib/tunings.mjs`: `traffic` from
`use_roads` (≤0.25 quiet, ≥0.75 busy, else balanced), `hills` from `use_hills` (≤0.25
flat, ≥0.9 tolerant, else balanced), and `surface: mixed`. Tahoe: `1` = quiet/mixed,
`2` = busy/mixed. To change them, add `bench/tunings/REGION/config.json` with `"modes_from_config": true` and a `facets` map.

**API sources** (`"type": "api"`) call a deployed `/route?scenario=` endpoint instead:
modes need `scenario` (or use `modes_from_config`). Requests are serialized at `rate_ms`
and the source is skipped after three network failures. Polylines are densified and map
matched (`trace_attributes`, `map_snap`) on the local engine so the same metrics apply.
Examples: `deployed` (bikesy-backend.tahoebike.org) and `legacy` (the pre-Valhalla
server, whose API answers on `/` with scenarios 1 and 2).

### Sweeps

`NAME.sweep.json` is a tuning plus a `grid` of dotted paths to value lists. Each
combination becomes a tuning named `NAME/key=label,...`; `--tuning NAME` runs them all.

```json
{ "base": "config",
  "grid": {
    "options.use_hills": [0.25, 0.5, 0.75],
    "engine.policy": { "base": "~/ws/ltbc/bikesy-data/experiments/hill-noise/variants/base.bin",
                       "hy50": "~/ws/ltbc/bikesy-data/experiments/hill-noise/variants/hy50.bin" } } }
```

Lists are labelled by value; objects map labels to values. Any path works, e.g.
`modes.1.options.use_roads` for one mode. Tunings run grouped by engine, one
container at a time.

## Runs

```
node bench/run.mjs --region REGION [--tuning NAME ...] [--sets curated,sampled]
    [--pairs ID,...] [--tags TAG,...] [--limit N] [--name NAME] [--out DIR]
    [--image IMAGE] [--port 18002] [--valhalla URL] [--concurrency 2] [--keep-engine]
```

Output: `$BIKESY_BENCH_DIR/runs/<date>-<name>/` with `results.json` (tunings, trips,
per-route metrics and expectation outcomes, aggregates), `geometry.json` (simplified
shapes with surface/stress runs and elevation, for the report) and `routes.csv`.

Every engine call is cached in `$BIKESY_BENCH_DIR/cache/` by a hash of the engine
identity and the exact request, so an interrupted run resumes, and re-running after a
metric change re-routes nothing. Timeouts and engine failures are not cached. Change
`VERSION` in `lib/cache.mjs` to discard the cache.

Each trip has two detour baselines on the same engine, through the same adapter path:
the **shortest rideable** route (Valhalla's `shortest: true`, Hybrid bicycle, every
surface up to untagged paths) and the **shortest firm** route (also `bicycle_type: Road`,
`avoid_bad_surfaces: 1`: compacted or better). The first is what the spec calls the
detour; the second exposes cases where the shortest rideable route is only short because
it takes farm tracks, driveways or forest trails.

## Metrics

Defined as a list of small functions in [`metrics.mjs`](metrics.mjs); edge attributes
come from Valhalla 3.5.1 `trace_attributes` on the route's own shape, elevation from
`/height` at 30 m.

| Metric | Definition |
| --- | --- |
| `distance_km` | Length of the route shape. |
| `detour` | Distance / the shortest rideable route's distance. |
| `firm_detour` | Distance / the shortest firm-surface route's distance. |
| `climb_m` | Total ascent, ignoring rises under 3 m between reversals (DEM noise). |
| `unpaved_km`, `unpaved_share` | Surfaces other than paved_smooth/paved/paved_rough: compacted and worse, which includes untagged paths. |
| `high_stress_km`, `high_stress_share` | Ridden on a motorway, or on a trunk/primary/secondary road (incl. its ramps and turn channels) with a tagged limit ≥ 45 mph (72 km/h) or with neither a bike lane (`cycle_lane` dedicated/separated) nor a shoulder. Sharrows are not a lane; untagged speed limits count as low. |
| `class_i_share` | Paved, car-free path (cycleway, path, footway, pedestrian; not sidewalks) ridden on the bike. |
| `wilderness_km` | Length inside the region's wilderness polygons (segment midpoints). |
| `walk_km` | Walking sections (stairs, dismount). |
| `maneuvers` | Valhalla maneuvers on the route. |
| `reference_overlap` | min(share of route within 30 m of the reference, share of reference within 30 m of route), best reference. |
| `via_ratio` | Direct distance / (from→via + via→to). |
| `ferry_retry` | 1 when the land-only request was refused and the ferry retry ran. |

To add one, append `{ name, label, unit, better, compute }` to `METRICS`; `compute`
receives `{ route, shortest, via, references, areas, trip, mode }` and returns a number
or null. It becomes available to expectations (`max_<name>`), `routes.csv` and the report.

## Aggregates

Per pair set × tuning × mode, in [`aggregates.mjs`](aggregates.mjs): trips, no-route
count, median and p90 detour, pathological count (no route or detour > 1.5×) and how
many of those are also over 1.5× the shortest firm route (`pathological_firm`), total
distance, high-stress km and share, unpaved share (by length), mean Class I share,
median climb, wilderness km, expectations checked and pass rate, and **mode separation**
(`same_route_share`: how often a mode's route is the same as another mode's, i.e. ≥ 95%
overlap within 20 m both ways). Add one by appending to `AGGREGATES`.

## Report

```sh
node bench/report.mjs RUN_DIR [RUN_DIR ...] [--baseline TUNING] [--out FILE]
```

Writes `report.html` (in the first run directory by default): a scorecard per pair set
with deltas against the baseline (modes are matched by name, else by most shared
facets), a detour vs stress/unpaved scatter per tuning × mode, changed routes sorted
by divergence, problems (no route, detour > 1.5×, failed expectations), and a pair
view: map with every tuning's route (the focused one coloured by stress or surface,
the shortest rideable route dotted), elevation profile and the metrics table. It loads
Leaflet 1.9.4 from cdnjs and OSM tiles; open it locally.

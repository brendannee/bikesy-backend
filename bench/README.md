# Route benchmark

Evaluate routing changes over a fixed set of origin/destination pairs and compare
tunings (costing options, hill-policy files, data images, or deployed APIs). It works
for any region with a `config/REGION.json` (see [Another region](#another-region)), and
[Example: Tahoe, October 2026](#example-tahoe-october-2026) shows what it is for.

A **run** routes every trip (a pair in one direction) for every **mode** of every
**tuning**, computes per-route **metrics** and per-mode **aggregates**, and writes a
run directory. A **report** compares one or more runs against a baseline tuning in a
single static HTML file.

```sh
export BIKESY_BENCH_DIR=~/bikesy-bench                     # runs/ and cache/ go here (default bench/out, git-ignored)
export BIKESY_BENCH_IMAGE=routing-data:v1-20261012          # the region's data image, pulled or built locally
npm run bench -- --region tahoe                            # the production scenarios, curated + sampled + realistic pairs
npm run bench -- --region tahoe --tuning config --tuning hy50 --name hill-policy
npm run bench:report -- "$BIKESY_BENCH_DIR"/runs/2026-10-18-hill-policy
```

Requirements: Node 22.9+, Docker with the region's data image pulled locally, and
`osmium-tool` only for regenerating sampled pairs or wilderness areas. No npm packages.

## The engine

Runs talk to Valhalla directly, so any costing option works without a redeploy. The
runner starts a container per distinct engine (data image + policy file), named
`bench-<hash>` (`bench-<hash>-p<port>` off the default port, so benchmarks on different ports
never replace each other's containers), on `127.0.0.1:18002` (`--port`), capped at 2 CPUs and 2 GB, and removes
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

`bench/pairs/REGION.json` is the curated set; `REGION-NAME.json` is another set. The
runner uses `curated`, `sampled`, `realistic` and `user` by default, those that exist;
`--sets` picks. Sets stay separate in all output so curated pairs cannot hide behaviour
on the sampled ones.

| Set | File | What it is |
| --- | --- | --- |
| `curated` | `tahoe.json` | Hand-picked pairs with `expect` rules, known bugs and reference tracks. |
| `sampled` | `tahoe-sampled.json` | 200 one-way pairs drawn from building and address density (seed 1). The baseline for comparisons; do not regenerate it. |
| `realistic` | `tahoe-realistic.json` | 68 pairs built from commute flows and places people go (LODES, OSM), each with a `purpose` and a relative `weight`. See [Realistic pairs](#realistic-pairs). |
| `sampled-weighted` | `tahoe-sampled-weighted.json` | 200 one-way pairs sampled from weighted points and trip purposes. Opt in with `--sets sampled-weighted`. |
| `user` | `tahoe-user.json` | Trips you add with `add-trips.mjs`. Git-ignored (it can hold places that identify people). |

Pairs from outside the repository join a run with `--pairs-file [NAME=]FILE` (repeatable,
or `$BIKESY_BENCH_PAIRS` with `:`-separated entries). A file whose NAME is a set already
loaded adds to it (ids must stay unique); otherwise it is a set of its own. Files named
this way always run, whatever `--sets` says.

```sh
# the committed realistic pairs plus the ones kept outside git (see Realistic pairs)
npm run bench -- --region tahoe --sets realistic --pairs-file realistic=path/to/pairs-realistic-restricted.json
```

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
node bench/sample-pairs.mjs --region tahoe --pbf path/to/region.osm.pbf
```

The same extract, seed and engine give the same file. The Tahoe set (200 pairs, seed 1)
has 64% of its origins east of the Carson Range crest (Carson City and Carson Valley,
longitude -119.86 and beyond), which is where most of the extract's buildings are;
`--alpha 0` (area-weighted) or a smaller `--max-km` shift that. Because the set is the
comparison baseline of earlier runs it stays as it is; use the weighted sampler below
for a Tahoe-wide mix.

### Weighted sampling

`bench/sample-pairs.mjs --points FILE` draws pairs from a point file instead of building
density: `bench/points/tahoe.geojson` has about 7,000 weighted points in 14 categories (LODES
homes and jobs, OSM schools, shops, food, lodging, beaches, parks, ...) and a `purposes`
mix (recreation 0.34, commute 0.22, errands 0.18, dining and social 0.10, school 0.07,
transit access 0.06, bike shop 0.03; the shares are assumptions, not measurements). No
OpenStreetMap extract is needed, only the engine.

```sh
npm run bench:engine -- start --image "$BIKESY_BENCH_IMAGE" --port 18072
node bench/sample-pairs.mjs --region tahoe --points bench/points/tahoe.geojson --valhalla http://127.0.0.1:18072/
```

Each pair: a purpose (by share), an origin and a destination category (uniformly among
the purpose's categories), an origin zone with probability ∝ (zone mass)^`--zone-alpha`
(default 0.5), a point in it ∝ weight^`--weight-power` (0.5), then a destination in the
other category within `--min-km`..`--max-km` (1–15) of the origin, ∝ weight^0.5 ×
exp(-distance / `--decay-km`) (4 km), so trips are mostly short. Winter-only points are
skipped (`--season`). Both ends must snap within 150 m. The file records the parameters,
the purpose mix, origin zone shares and the Carson-side share.

Zones are the 30 town centres in `bench/points/tahoe-zones.json` (nearest centre within
6 km, else `other`). Share of origins east of the Carson Range crest, by `--zone-alpha`:
0 (every zone alike) 12%, **0.5 (default) 24%**, 1 (plain weighting by demand) 37%;
the density-weighted `sampled` set has 64%. `purposes` whose categories are missing from
the file (transit access, because the transit stops are not committed) are dropped and the
shares renormalised. A fuller file, including those categories, is described under
[Data and licenses](#data-and-licenses).

`tahoe-sampled-weighted.json` is a new set rather than a regeneration of `sampled` because
earlier runs, reports and the hill-policy comparisons are keyed to the 200 pairs of
`sampled`; changing them would make every old baseline incomparable. Run both when a change
should be judged on a Tahoe-wide mix as well as on the old one.

### Realistic pairs

`tahoe-realistic.json` is built from public data: LODES 2023 commute flows (the largest
home-to-job flows at bikeable distance), OSM schools, supermarkets, lodging, beaches,
parks, trailheads and bike shops, joined to residential LODES points. Every pair has a
`purpose`, a `source`, a `straight_km` and a relative `weight` (purpose share × demand;
weights sum to 1 over the full 92-pair file, so the committed subset sums to less).
Aggregates add pair-weighted columns (`weighted_median_detour`, `weighted_pathological_share`)
for sets that have weights.

`bench/check-pairs.mjs` verifies every endpoint snaps to a bicycle edge within 150 m with
`/locate` and, with `--fix`, stores the snapped points and drops pairs that do not snap
(listed as `dropped_unsnappable`). Six of the 74 open pairs were dropped that way.

```sh
node bench/check-pairs.mjs --region tahoe --sets realistic,sampled-weighted --valhalla http://127.0.0.1:18072/
```

### Data and licenses

Only data from sources that allow it is committed. `lib/open-data.mjs` holds the rule and
`bench/split-open.mjs` applies it to the research output:

| Source | Used for | Committed? |
| --- | --- | --- |
| US Census LEHD LODES 2023 | home and job points, commute flows | Yes; public domain. |
| OpenStreetMap | places (schools, shops, food, lodging, beaches, parks) | Yes; ODbL, attribution "© OpenStreetMap contributors" is in the files. |
| TRPA layers (travel-model trip ends, mobility hubs) | town-centre and hub points | No. "Copyright TRPA", public download, no licence grant. |
| GTFS feeds (TART, TTD, Jump Around Carson) | transit stops weighted by service | No. The feeds state no licence. |

**Licence of the committed data.** The data files under `bench/points/`, `bench/areas/` and
`bench/pairs/` contain OpenStreetMap data, © OpenStreetMap contributors, available under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/), and LODES data
(public domain). Each file carries an `attribution` field, which the generators
(`sample-pairs.mjs`, `build-areas.mjs`, `split-open.mjs`) write. The ODbL covers that data
only, not the bench code. Reports and run results built from it are produced works:
credit OpenStreetMap when you publish them. Committed sizes: `points/tahoe.geojson`
1.2 MB (94 KB gzipped), `areas/tahoe-wilderness.geojson` 99 KB, Tahoe pair files 135 KB in all.

So `bench/points/tahoe.geojson` has no `transit` or `trpa-taz` category, and the 18 realistic
pairs that use transit stops or TRPA zones (17 after the snap check) are not in
`tahoe-realistic.json`. They live in a research workspace outside the repository
(LTBC keeps it; `$O` below), regenerated by its `build_trips.py` and split with

```sh
O=path/to/od-research
node bench/split-open.mjs pairs  $O/pairs-realistic.json --open bench/pairs/tahoe-realistic.json --restricted $O/pairs-realistic-restricted.json
node bench/split-open.mjs points $O/points.geojson --open bench/points/tahoe.geojson --restricted $O/points-restricted.geojson
node bench/check-pairs.mjs --region tahoe --sets realistic --pairs-file realistic=$O/pairs-realistic-restricted.json --fix
```

Use `--pairs-file realistic=$O/pairs-realistic-restricted.json` to run the full set, and
`--points $O/points.geojson` with the sampler for the fuller weighted file (write it with
`--out` outside the repo). Do not commit anything derived from the restricted files. No
usage data is used anywhere.

### Adding trips

`bench/add-trips.mjs` turns trips people can paste or export into pairs in a local catalog,
`bench/pairs/tahoe-user.json` (the `user` set, git-ignored). Two minutes:

1. Open newmap.tahoebike.org and route the trip you care about.
2. Copy the URL from the address bar. It looks like
   `https://newmap.tahoebike.org/#Start/-120.14,39.17/End/-120.19,39.18/1`.
3. Paste it as a line in any text file, optionally followed by ` # name; tags; why`:

   ```
   https://newmap.tahoebike.org/#.../1 # Tahoe City to River Ranch; class-i,recreation; Trail should beat SR 89
   ```
4. `node bench/add-trips.mjs mytrips.txt` (or `pbpaste | node bench/add-trips.mjs links -`).
5. Re-run the bench on it: `npm run bench -- --region tahoe --sets user --tuning config --name my-trips`.

Re-running an input adds nothing twice. Other inputs:

| Command | Input |
| --- | --- |
| `links FILE` | Share links, one per line (`//` comments allowed). Old map.tahoebike.org links have no coordinates: re-open them on newmap, or add `--geocode`. |
| `table FILE.csv` | Columns `name,from,to,tags,why,max_detour,one_way,added_by`, e.g. a Google Sheet downloaded as CSV. `from` and `to` take `lat,lon`, a local place name (`Safeway @ kings-beach`; the zone after `@` picks between several) or a share link. `max_detour` becomes an `expect` rule. Misspelled places list suggestions. |
| `gpx FILE.gpx ...` | A ride as a reference route: the pair is the track's ends (200 m trimmed, rounded to ~110 m) and a simplified copy of the track, without time or elevation, goes to `refs/` beside the catalog for the `reference_overlap` metric. |

Samples are in `bench/samples/add-trips/`. Options: `--snap` rounds endpoints to ~110 m,
`--check` reports endpoints more than 150 m from a bicycle edge (needs a bench engine),
`--out FILE` writes elsewhere (`-` prints), `--fresh` starts the catalog empty, `--tag`,
`--places FILE` adds named points, `--geocode` looks up unknown addresses on OSM Nominatim
(opt-in: it sends them to that service). Skipped lines are listed with the reason and the
command exits 1.

Privacy: a share link or GPX track can be someone's home. Address text from links is dropped
unless `--keep-addresses`; unnamed pairs are named after town zones; the user catalog and its
references are git-ignored; keep raw link lists out of repositories. To share trips,
review the catalog, round them (`--snap`) and add the file with `git add -f`.

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
| `engine.policy` | Override `bikesy-policy.bin`, relative to the tuning file; `~/` and `$VAR` / `${VAR}` expand (an unset variable is an error). |
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
    "engine.policy": { "base": "${BIKESY_POLICY_VARIANTS}/base.bin",
                       "hy50": "${BIKESY_POLICY_VARIANTS}/hy50.bin" } } }
```

The Tahoe sweeps and `hy50` name experimental policy files this way. Those files are not in
the repository yet; the hill-policy change that produces them is a separate change.

Lists are labelled by value; objects map labels to values. Any path works, e.g.
`modes.1.options.use_roads` for one mode. Tunings run grouped by engine, one
container at a time.

## Runs

```
node bench/run.mjs --region REGION [--tuning NAME ...] [--sets curated,sampled,realistic]
    [--pairs-file [NAME=]FILE ...] [--pairs ID,...] [--tags TAG,...] [--limit N] [--name NAME] [--out DIR]
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
median climb, wilderness km, expectations checked and pass rate, pair-weighted median detour
and pathological share (for pairs with a `weight`), and **mode separation**
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

`node bench/set-summary.mjs RUN_DIR [--combine NAME=SET+SET]` writes `summary.md`: one table
per tuning and mode with a row per pair set (trips, median route length and climb, median
and p90 detour, pathological routes, stress, unpaved and Class I shares, pair-weighted
columns), for judging a new set against the old ones.

## Another region

Nothing in the runner, engine, tunings, metrics or report is Tahoe-specific; they read
`config/REGION.json` and the files named after the region. To start on a region:

1. Build or pull its data image (`scripts/build-region.sh`, see `docs/REGIONS.md`) and set
   `BIKESY_BENCH_IMAGE`.
2. Write a curated catalog, `bench/pairs/REGION.json` ([Pair catalogs](#pair-catalogs)).
   `bench/pairs/sf.json` is a one-pair starting point. Or collect trips with
   `add-trips.mjs --region REGION`, which reads share links from any Bikesy frontend.
3. Optionally draw a density-weighted set from the region's extract with
   `sample-pairs.mjs --region REGION --pbf ...`, and wilderness areas with `build-areas.mjs`.
4. Optionally add `bench/tunings/REGION/deployed.json` (an API source) and check that the bench
   reproduces production with `crosscheck.mjs`, as `bench/tunings/sf/deployed.json` does.
5. `npm run bench -- --region REGION`, then `npm run bench:report -- RUN_DIR`.

The parts that are Tahoe data only:
- The weighted point file (`bench/points/tahoe.geojson`) and the realistic pairs were built
  by a research script outside the repository. `sample-pairs.mjs --points` works on any
  region's file in the same format (see `lib/points.mjs`), but there is no generator for it here.
- Town zones (`bench/points/REGION-zones.json`) are optional. Without them, `add-trips.mjs`
  names unnamed pairs after the region.
- `add-trips.mjs` defaults to `--region tahoe`.

## Example: Tahoe, October 2026

The harness was built to find out why Tahoe routes took long detours, and which parameters
fix them, before anything was shipped. Data image `routing-data:v1-20261012`, curated and
sampled sets (280 trips per mode).

**It reproduces production.** `crosscheck.mjs` against the deployed API: 16 of 16 routes
byte-identical.

**Hill cost.** Sweeping `use_hills` × hill-policy file (`hills-x-policy.sweep.json`) showed that
most pathological detours came from DEM noise counted as climbing. A 50 m dead-band in the hill
policy (`hy50`) plus new parameters (`packages.sweep.json`, package `rec`: quiet `use_hills` 0.85,
`use_roads` 0.1; busy 0.95 and 0.75) compared with production:

| | Quiet today | Quiet rec. | Busy today | Busy rec. |
| --- | --- | --- | --- | --- |
| Detour > 1.5× (also > 1.5× firm) | 11 (4) | 3 (2) | 15 (6) | 1 (0) |
| Median / p90 detour | 1.075 / 1.353 | 1.060 / 1.260 | 1.048 / 1.313 | 1.016 / 1.147 |
| High-stress km | 844 | 599 | 1988 | 1378 |
| Unpaved share | 19.3% | 26.1% | 8.3% | 9.3% |
| Median climb per trip | 67 m | 74 m | 63 m | 74 m |
| Expectations passed | 16/18 | 15/18 | 9/15 | 15/15 |

Fixed routes include busy-mode Carson City → Spooner Summit (a 109 km detour via Luther Pass,
now 19 km on US 50), Carson City junction → Glenbrook and Brockway Summit on SR 267. Parameters alone on the shipped policy were not enough. The cost shows up in the
same table: with false climbs gone, dirt gets cheaper (quiet unpaved 19% → 26%). One detour
survived every setting: quiet mode's Forest Road 039 on the Spooner grade (1.6×). It is a
trade-off, not a bug: the alternative is the four-lane US 50 grade, so the pair now expects
US 50 only in busy and paved-preference modes.

To reproduce, with the policy variants in `$BIKESY_POLICY_VARIANTS`:

```sh
npm run bench -- --region tahoe --tuning config --tuning packages --sets curated,sampled --name packages
npm run bench:report -- "$BIKESY_BENCH_DIR"/runs/<date>-packages --baseline config
```


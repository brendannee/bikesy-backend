#!/usr/bin/env node
// Route benchmark runner. Routes every trip (pair x direction) for every mode of every
// tuning, computes metrics and aggregates, and writes a run directory:
//   results.json   tunings, trips, per-route metrics/expectations, aggregates
//   geometry.json  simplified route shapes with surface/stress runs and elevation (report input)
//   routes.csv     per-route metrics for spreadsheets
// Routing results are cached by request hash (see lib/cache.mjs), so an interrupted run
// resumes where it stopped and metric changes re-run without re-routing.
// Usage: see bench/README.md or `node bench/run.mjs --help`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { decode, encode } from '../src/polyline.js';
import { BENCH_DIR, expandTrips, loadPairSet, matchesModes, pairSetPath } from './lib/catalog.mjs';
import { createCache, hashKey } from './lib/cache.mjs';
import { engineIdentity, imagePolicy, startEngine, stopEngine, waitForEngine } from './lib/engine.mjs';
import { lineLength, parseGpx, preparePolygons, similarity, simplify } from './lib/geo.mjs';
import { createApiSource, createValhallaSource, fetchAttributes, valhallaRequest } from './lib/sources.mjs';
import { loadTunings } from './lib/tunings.mjs';
import { computeMetrics, stressClass, surfaceClass } from './metrics.mjs';
import { evaluateExpectations } from './expectations.mjs';
import { computeAggregates } from './aggregates.mjs';

// Detour baselines, routed through the same adapter path (same access rules, no ferries):
// the shortest rideable route (Valhalla's distance-only costing, Hybrid bicycle, which
// allows every surface up to untagged paths), and the shortest on firm surfaces
// (compacted or better: bicycle_type Road with avoid_bad_surfaces 1), which skips the
// farm tracks and forest trails that make the first one unrealistically short.
export const SHORTEST_OPTIONS = { shortest: true };
export const SHORTEST_FIRM_OPTIONS = { shortest: true, bicycle_type: 'Road', avoid_bad_surfaces: 1 };
export const SAME_ROUTE_SIMILARITY = 0.95;

const HELP = `Usage: node bench/run.mjs --region REGION [options]
  --tuning NAME       tuning or sweep name in bench/tunings/REGION/ (repeatable; default: config)
  --sets LIST         pair sets, comma separated (default: curated plus sampled if present)
  --pairs LIST        only these pair ids;  --tags LIST  only pairs with any of these tags
  --limit N           only the first N pairs of each set
  --name NAME         run name (default: the tuning names); output goes to
                      $BIKESY_BENCH_DIR/runs/<date>-<name> unless --out is given
  --out DIR           run directory;  --cache DIR  cache directory ($BIKESY_BENCH_DIR/cache)
  --image IMAGE       default data image ($BIKESY_BENCH_IMAGE); tunings may override it
  --port N            host port for bench engine containers (default 18002)
  --valhalla URL      use an already running engine instead of managing containers
  --concurrency N     parallel local routes (default 2)
  --keep-engine       leave engine containers running afterwards`;

function parse() {
  const { values } = parseArgs({ options: {
    region: { type: 'string' }, tuning: { type: 'string', multiple: true }, sets: { type: 'string' },
    pairs: { type: 'string' }, tags: { type: 'string' }, limit: { type: 'string' }, name: { type: 'string' },
    out: { type: 'string' }, cache: { type: 'string' }, image: { type: 'string' }, port: { type: 'string' },
    valhalla: { type: 'string' }, concurrency: { type: 'string' }, 'keep-engine': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !values.region) { console.log(HELP); process.exit(values.help ? 0 : 2); }
  return values;
}

// Run `worker` over items with at most `limit` in flight.
export async function pool(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await worker(items[i], i); }
  }));
}

// Build the metric-facing route object from a cached route record and its attributes.
export function buildRoute(record, attributes) {
  const points = decode(attributes.shape);
  const edges = attributes.edges.map(e => ({ ...e, length_m: e.length * 1000,
    points: points.slice(e.begin_shape_index, e.end_shape_index + 1) }));
  return { distance_m: lineLength(points), points, edges, heights: attributes.heights,
    directions: record.directions, maneuvers: record.maneuvers, ferry_retry: record.ferry_retry ?? false,
    route_warnings: record.route_warnings, elevation_profile: record.elevation_profile };
}

// Compact report geometry: simplified shape plus runs of [start index, surface, stress].
export function compactGeometry(route) {
  const keep = simplify(route.points, 4);
  const classAt = new Array(route.points.length).fill(null);
  for (const e of route.edges) for (let i = e.begin_shape_index; i < e.end_shape_index; i++) classAt[i] = `${surfaceClass(e)}|${stressClass(e)}`;
  const runs = [];
  keep.forEach((pointIndex, i) => {
    if (i === keep.length - 1) return;
    const c = classAt[pointIndex] ?? 'paved|road';
    if (!runs.length || runs.at(-1)[3] !== c) runs.push([i, ...c.split('|'), c]);
  });
  return { p: encode(keep.map(i => route.points[i]), 5), s: runs.map(r => r.slice(0, 3)),
    e: route.elevation_profile ?? route.heights };
}

async function main() {
  const args = parse();
  const region = args.region;
  const regionConfig = loadConfig({ BIKESY_CONFIG: resolve(BENCH_DIR, '..', 'config', `${region}.json`) });
  const root = resolve(process.env.BIKESY_BENCH_DIR ?? resolve(BENCH_DIR, 'out'));
  const cache = createCache(resolve(args.cache ?? resolve(root, 'cache')));
  const concurrency = Number(args.concurrency ?? 2), port = Number(args.port ?? 18002);
  const defaultImage = args.image ?? process.env.BIKESY_BENCH_IMAGE;

  const tunings = (args.tuning ?? ['config']).flatMap(name => loadTunings(region, regionConfig, name));
  if (new Set(tunings.map(t => t.name)).size !== tunings.length) throw new Error('Duplicate tuning names');
  const setNames = args.sets ? args.sets.split(',') : ['curated', ...(existsSync(pairSetPath(region, 'sampled')) ? ['sampled'] : [])];
  const pairFilter = args.pairs ? new Set(args.pairs.split(',')) : null;
  const tagFilter = args.tags ? args.tags.split(',') : null;
  const catalogs = setNames.map(set => {
    const catalog = loadPairSet(region, set);
    let pairs = catalog.pairs.filter(p => (!pairFilter || pairFilter.has(p.id)) && (!tagFilter || p.tags?.some(t => tagFilter.includes(t))));
    if (args.limit) pairs = pairs.slice(0, Number(args.limit));
    return { ...catalog, pairs };
  });
  const trips = catalogs.flatMap(expandTrips);
  if (!trips.length) throw new Error('No trips selected');
  const areasPath = resolve(BENCH_DIR, 'areas', `${region}-wilderness.geojson`);
  const areas = existsSync(areasPath) ? { wilderness: preparePolygons(JSON.parse(readFileSync(areasPath, 'utf8')).features) } : {};
  const references = new Map();
  for (const trip of trips) for (const ref of trip.pair.references ?? []) {
    if (!references.has(ref.path)) references.set(ref.path, { points: parseGpx(readFileSync(ref.path, 'utf8')) });
  }

  // Group tunings by the engine they need. API tunings map-match on the default engine.
  const engines = new Map();
  let external = null;
  if (args.valhalla) {
    const status = await waitForEngine(args.valhalla.replace(/\/?$/, '/'), 10000);
    external = { external: true, url: args.valhalla.replace(/\/?$/, '/'), key: `external:${status.version}:${status.tileset_last_modified}`, image: null, policy: null };
    console.warn(`Using running engine ${external.url}; cache entries are keyed by its tileset time only.`);
  }
  for (const tuning of tunings) {
    const wanted = tuning.source.type === 'api' ? {} : tuning.engine;
    if (external && (wanted.image || wanted.policy)) throw new Error(`Tuning ${tuning.name} needs its own engine; drop --valhalla`);
    const identity = external ?? engineIdentity({ image: wanted.image ?? defaultImage, policy: wanted.policy });
    if (!engines.has(identity.key)) engines.set(identity.key, { identity, tunings: [] });
    engines.get(identity.key).tunings.push(tuning);
    tuning.engineKey = identity.key;
  }

  const results = [], geometry = { routes: {}, shortest: {} };
  const engineMeta = [];
  for (const { identity, tunings: group } of engines.values()) {
    const engine = identity.external ? { url: identity.url, name: null }
      : await startEngine(identity, { port, cacheDir: cache.dir });
    console.log(`Engine ${engine.name ?? engine.url} (${identity.image ?? 'external'}${identity.policy ? ', policy ' + identity.policy : ''}): ${group.map(t => t.name).join(', ')}`);
    engineMeta.push({ key: identity.key, image: identity.image, image_id: identity.imageId, policy: identity.policy,
      policy_sha256: identity.policySha256, data_policy: identity.image ? imagePolicy(identity.image) : null, tunings: group.map(t => t.name) });
    try {
      await runEngineGroup({ engine, identity, group, trips, regionConfig, cache, concurrency, areas, references, results, geometry });
    } finally {
      if (engine.name && !engine.reused && !args['keep-engine']) stopEngine(engine.name);
    }
  }

  // Mode separation within each tuning, then aggregates per set x tuning x mode.
  const byTuningTrip = new Map();
  for (const r of results) {
    const key = `${r.tuning}|${r.trip}`;
    if (!byTuningTrip.has(key)) byTuningTrip.set(key, []);
    byTuningTrip.get(key).push(r);
  }
  for (const group of byTuningTrip.values()) {
    for (const r of group) {
      r.same_as = r.ok ? group.filter(o => o !== r && o.ok && similarity(r._points, o._points) >= SAME_ROUTE_SIMILARITY).map(o => o.mode) : [];
    }
  }
  const aggregates = [];
  for (const catalog of catalogs) for (const tuning of tunings) for (const mode of tuning.modes) {
    const routes = results.filter(r => r.set === catalog.set && r.tuning === tuning.name && r.mode === mode.name);
    aggregates.push({ set: catalog.set, tuning: tuning.name, mode: mode.name, facets: mode.facets, ...computeAggregates(routes) });
  }

  const name = args.name ?? tunings.map(t => t.sweep ?? t.name).filter((n, i, a) => a.indexOf(n) === i).join('+');
  const out = resolve(args.out ?? resolve(root, 'runs', `${new Date().toLocaleDateString('en-CA')}-${name.replace(/[^\w.+-]+/g, '_')}`));
  mkdirSync(out, { recursive: true });
  let commit = null;
  try { commit = execFileSync('git', ['-C', BENCH_DIR, 'describe', '--always', '--dirty'], { encoding: 'utf8' }).trim(); } catch {}
  const meta = { name, region, created: new Date().toISOString(), commit, engines: engineMeta,
    sets: catalogs.map(c => ({ set: c.set, path: c.path, pairs: c.pairs.length, trips: trips.filter(t => t.set === c.set).length })) };
  const tripRows = trips.map(t => ({ key: t.key, set: t.set, pair: t.pair.id, name: t.pair.name, direction: t.direction,
    tags: t.pair.tags ?? [], why: t.pair.why, from: t.from, to: t.to, via: t.via }));
  const routeRows = results.map(({ _points, ...r }) => r);
  writeFileSync(resolve(out, 'results.json'), JSON.stringify({ meta, tunings, trips: tripRows, routes: routeRows, aggregates }, null, 1));
  writeFileSync(resolve(out, 'geometry.json'), JSON.stringify(geometry));
  writeCsv(resolve(out, 'routes.csv'), routeRows);
  printSummary(aggregates);
  console.log(`\nWrote ${out}`);
}

async function runEngineGroup({ engine, identity, group, trips, regionConfig, cache, concurrency, areas, references, results, geometry }) {
  const local = createValhallaSource({ regionConfig, valhallaUrl: engine.url });
  const attributeCache = (shape, costing, matched) => cache.memo(hashKey({ kind: 'attributes', engine: identity.key, shape, costing, matched }),
    () => fetchAttributes(engine.url, shape, costing, { matched }));

  // A local route record with attributes, from cache when possible.
  async function localRoute(from, to, options) {
    let request;
    try { request = valhallaRequest(regionConfig, from, to, options); } catch (error) { return { record: { ok: false, error: error.message } }; }
    const key = hashKey({ kind: 'route', engine: identity.key, request });
    let record = cache.get(key);
    if (!record) {
      record = await local(from, to, options);
      // Engine timeouts and 5xx-style failures are retried on the next run, not cached.
      if (record.ok || /No route found|outside routing bounds/i.test(record.error)) cache.set(key, record);
    }
    if (!record.ok) return { record };
    const attributes = await attributeCache(record.shape, request.costing_options, false);
    return { record, route: buildRoute(record, attributes) };
  }

  const tasks = [];
  const shortest = new Map(), shortestFirm = new Map();
  for (const trip of trips) tasks.push({ kind: 'shortest', trip });
  for (const tuning of group) for (const mode of tuning.modes) for (const trip of trips) {
    tasks.push({ kind: 'route', tuning, mode, trip });
  }
  const apiSources = new Map(group.filter(t => t.source.type === 'api').map(t => [t.name, createApiSource(t.source)]));
  let done = 0;
  const progress = () => { if (++done % 50 === 0 || done === tasks.length) console.log(`  ${done}/${tasks.length} routes`); };

  // Shortest routes first: every mode's detour depends on them.
  await pool(tasks.filter(t => t.kind === 'shortest'), concurrency, async ({ trip }) => {
    const { record, route } = await localRoute(trip.from, trip.to, SHORTEST_OPTIONS);
    shortest.set(trip.key, route ?? null);
    if (route) geometry.shortest[`${identity.key}|${trip.key}`] = compactGeometry(route);
    else console.warn(`  shortest ${trip.key}: ${record.error}`);
    shortestFirm.set(trip.key, (await localRoute(trip.from, trip.to, SHORTEST_FIRM_OPTIONS)).route ?? null);
    progress();
  });

  const routeTasks = tasks.filter(t => t.kind === 'route');
  const runTask = async ({ tuning, mode, trip }) => {
    let record, route, via = null;
    if (tuning.source.type === 'api') {
      const key = hashKey({ kind: 'api', url: tuning.source.url, scenario: mode.scenario, from: trip.from, to: trip.to });
      record = cache.get(key);
      if (!record) {
        record = await apiSources.get(tuning.name)(trip.from, trip.to, mode.scenario);
        if (!record.transient) cache.set(key, record);
      }
      if (record.ok) {
        try { route = buildRoute(record, await attributeCache(record.shape, { bicycle: { bicycle_type: 'Hybrid' } }, true)); }
        catch (error) { record = { ok: false, error: `map matching failed: ${error.message}` }; }
      }
    } else {
      ({ record, route } = await localRoute(trip.from, trip.to, mode.options));
      if (route && trip.via) {
        via = [(await localRoute(trip.from, trip.via, mode.options)).route ?? null, (await localRoute(trip.via, trip.to, mode.options)).route ?? null];
      }
    }
    const tripReferences = (trip.pair.references ?? []).filter(r => matchesModes(r.modes, mode.facets)).map(r => references.get(r.path));
    const result = { tuning: tuning.name, mode: mode.name, trip: trip.key, set: trip.set, pair: trip.pair.id, direction: trip.direction,
      ok: Boolean(route), error: route ? null : record.error, engine_error: record.engine_error,
      response_sha256: record.response_sha256 ?? null, reported_distance_m: record.total_distance ?? null, metrics: route ? computeMetrics({ route, shortest: shortest.get(trip.key), shortestFirm: shortestFirm.get(trip.key), via,
        references: tripReferences, areas, trip, mode }) : {} };
    result.expectations = evaluateExpectations(trip, mode, result);
    result._points = route?.points;
    results.push(result);
    if (route) geometry.routes[`${tuning.name}|${mode.name}|${trip.key}`] = compactGeometry(route);
    progress();
  };
  // API sources serialize themselves (rate limit); local routes share the pool.
  await Promise.all([
    pool(routeTasks.filter(t => t.tuning.source.type !== 'api'), concurrency, runTask),
    pool(routeTasks.filter(t => t.tuning.source.type === 'api'), Math.max(1, apiSources.size), runTask),
  ]);
  for (const [name, source] of apiSources) if (source.state.down) console.warn(`  ${name}: source unavailable; its routes are marked failed`);
}

function writeCsv(path, rows) {
  const metricNames = [...new Set(rows.flatMap(r => Object.keys(r.metrics)))];
  const header = ['tuning', 'mode', 'set', 'pair', 'direction', 'ok', 'error', ...metricNames, 'expectations_failed'];
  const cell = v => v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const lines = rows.map(r => [r.tuning, r.mode, r.set, r.pair, r.direction, r.ok, r.error, ...metricNames.map(m => r.metrics[m]),
    r.expectations.filter(e => e.pass === false).map(e => e.key).join(' ')].map(cell).join(','));
  writeFileSync(path, [header.join(','), ...lines].join('\n') + '\n');
}

function printSummary(aggregates) {
  const columns = ['trips', 'no_route', 'median_detour', 'p90_detour', 'pathological', 'pathological_firm', 'high_stress_km', 'unpaved_share', 'class_i_share', 'expectation_pass_rate', 'same_route_share'];
  console.log('\n' + ['set', 'tuning', 'mode', ...columns].join('\t'));
  for (const a of aggregates) console.log([a.set, a.tuning, a.mode, ...columns.map(c => a[c] ?? '-')].join('\t'));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.stack ?? error.message); process.exit(1); });
}

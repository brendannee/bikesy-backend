// Route benchmark (bench/) logic: geometry, metrics, expectations, aggregates, tunings
// and catalogs, plus the local source's reuse of the production adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync } from 'node:fs';
import { loadConfig, listRegionConfigs } from '../src/config.js';
import { encode } from '../src/polyline.js';
import { coverage, densify, haversine, insideAny, lineLength, parseGpx, preparePolygons, similarity, simplify } from '../bench/lib/geo.mjs';
import { METRICS, climb, computeMetrics, isClassI, isHighStress, isUnpaved, kmInside, stressClass } from '../bench/metrics.mjs';
import { evaluateExpectations } from '../bench/expectations.mjs';
import { computeAggregates, quantile } from '../bench/aggregates.mjs';
import { configFacets, expandPath, expandSweep, listTunings, loadTunings, resolveSpec } from '../bench/lib/tunings.mjs';
import { expandTrips, loadPairSet, matchesModes } from '../bench/lib/catalog.mjs';
import { hashKey, stableJson } from '../bench/lib/cache.mjs';
import { createValhallaSource, responseHash } from '../bench/lib/sources.mjs';
import { containerName } from '../bench/lib/engine.mjs';
import { buildRoute, compactGeometry } from '../bench/run.mjs';
import { matchMode } from '../bench/report.mjs';
import { cellSampler, random } from '../bench/sample-pairs.mjs';

const tahoe = loadConfig({ BIKESY_CONFIG: 'config/tahoe.json' });
// A straight 1 km line north from Tahoe City, and one 100 m to the east of it.
const line = [[39.17, -120.14], [39.17449, -120.14], [39.17898, -120.14]];
const east = line.map(([lat, lon]) => [lat, lon + 100 / (111320 * Math.cos(39.17 * Math.PI / 180))]);
const edge = (props) => ({ length_m: 1000, surface: 'paved_smooth', road_class: 'residential', use: 'road', travel_mode: 'bicycle', ...props });

test('geometry: lengths, coverage, similarity, densify and simplify', () => {
  assert.ok(Math.abs(lineLength(line) - 998.5) < 2);
  assert.equal(coverage(line, line), 1);
  assert.equal(coverage(line, east), 0);
  assert.equal(coverage(line, east, 150), 1);
  assert.equal(similarity(line, line.slice(0, 2)), coverage(line, line.slice(0, 2)));
  assert.ok(Math.abs(coverage(line, line.slice(0, 2)) - 0.52) < 0.02, 'half the line plus the 20 m tolerance');
  const dense = densify([line[0], line[2]], 50);
  assert.equal(dense.length, 21);
  assert.ok(dense.slice(1).every((p, i) => haversine(dense[i], p) <= 50));
  assert.deepEqual(simplify(dense, 1), [0, 20]);
});

test('geometry: point in polygon honours holes; GPX track points parse', () => {
  const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const polygons = preparePolygons([{ type: 'Feature', properties: { name: 'W' },
    geometry: { type: 'Polygon', coordinates: [square(-120.2, 39.1, -120.1, 39.2), square(-120.16, 39.14, -120.14, 39.16)] } }]);
  assert.equal(insideAny(polygons, [39.12, -120.12]), true);
  assert.equal(insideAny(polygons, [39.15, -120.15]), false);
  assert.equal(insideAny(polygons, [39.3, -120.15]), false);
  assert.ok(Math.abs(kmInside([[39.12, -120.12], [39.13, -120.12], [39.35, -120.12]], polygons) - 1.112) < 0.01);
  assert.deepEqual(parseGpx('<gpx><trk><trkseg><trkpt lat="39.1" lon="-120.1"><ele>1</ele></trkpt><trkpt lon="-120.2" lat="39.2"/></trkseg></trk></gpx>'),
    [[39.1, -120.1], [39.2, -120.2]]);
});

test('edge classes: high stress, Class I, unpaved', () => {
  assert.equal(isHighStress(edge({ road_class: 'motorway' })), true);
  assert.equal(isHighStress(edge({ road_class: 'primary', speed_limit: 80, cycle_lane: 'dedicated' })), true, '45 mph or more');
  assert.equal(isHighStress(edge({ road_class: 'primary', speed_limit: 56, cycle_lane: 'dedicated' })), false, 'bike lane');
  assert.equal(isHighStress(edge({ road_class: 'trunk', speed_limit: 56, shoulder: true })), false, 'shoulder');
  assert.equal(isHighStress(edge({ road_class: 'secondary', cycle_lane: 'shared' })), true, 'sharrows are not a lane');
  assert.equal(isHighStress(edge({ road_class: 'tertiary', speed_limit: 90 })), false);
  assert.equal(isHighStress(edge({ road_class: 'primary', travel_mode: 'pedestrian' })), false);
  assert.equal(isHighStress(edge({ road_class: 'primary', use: 'cycleway' })), false);
  assert.equal(isClassI(edge({ use: 'cycleway' })), true);
  assert.equal(isClassI(edge({ use: 'path', surface: 'dirt' })), false);
  assert.equal(isClassI(edge({ use: 'sidewalk' })), false);
  for (const surface of ['compacted', 'dirt', 'gravel', 'path', 'impassable']) assert.equal(isUnpaved(edge({ surface })), true, surface);
  for (const surface of ['paved_smooth', 'paved', 'paved_rough']) assert.equal(isUnpaved(edge({ surface })), false, surface);
  assert.deepEqual(['high', 'path', 'road', 'walk'], [edge({ road_class: 'motorway' }), edge({ use: 'path', surface: 'dirt' }), edge({}), edge({ travel_mode: 'pedestrian' })].map(stressClass));
});

test('climb ignores dead-band noise', () => {
  assert.equal(climb([[0, 100], [30, 102], [60, 100], [90, 102], [120, 100]]), 0);
  assert.equal(climb([[0, 100], [30, 104], [60, 108], [90, 104], [120, 110]]), 14);
  assert.equal(climb([[0, null], [30, 100], [60, 120]]), 20);
});

test('computeMetrics on a synthetic route', () => {
  const route = { distance_m: 3000, points: line, heights: [[0, 1900], [30, 1910]], maneuvers: 4, ferry_retry: false,
    edges: [edge({ road_class: 'primary' }), edge({ use: 'cycleway' }), edge({ use: 'path', surface: 'gravel' })] };
  const m = computeMetrics({ route, shortest: { distance_m: 2500 }, via: [{ distance_m: 1000 }, { distance_m: 1500 }],
    references: [{ points: line }], areas: { wilderness: [] } });
  assert.equal(m.distance_km, 3);
  assert.equal(m.detour, 1.2);
  assert.equal(m.via_ratio, 1.2);
  assert.equal(m.high_stress_km, 1);
  assert.equal(m.unpaved_share, 0.3333);
  assert.equal(m.class_i_share, 0.3333);
  assert.equal(m.climb_m, 10);
  assert.equal(m.reference_overlap, 1);
  assert.equal(m.wilderness_km, 0);
  assert.equal(computeMetrics({ route, shortest: null }).detour, null);
  assert.equal(computeMetrics({ route, shortestFirm: { distance_m: 3000 } }).firm_detour, 1);
  assert.equal(computeMetrics({ route }).reference_overlap, null);
});

test('expectations select modes by facets and direction', () => {
  const pair = { id: 'p', expect: [
    { modes: { traffic: 'quiet' }, min_class_i_share: 0.5 },
    { modes: '*', direction: 'forward', max_detour: 1.25 },
    { modes: { surface: ['dirt', 'mixed'] }, max_reference_overlap: 0.5 },
  ] };
  const quiet = { facets: configFacets('1', tahoe.scenarios['1']) };
  const busy = { facets: configFacets('2', tahoe.scenarios['2']) };
  const result = { metrics: { class_i_share: 0.6, detour: 1.3, reference_overlap: null } };
  const fwd = evaluateExpectations({ pair, direction: 'forward' }, quiet, result);
  assert.deepEqual(fwd.map(o => [o.key, o.pass]), [['min_class_i_share', true], ['max_detour', false], ['max_reference_overlap', null]]);
  assert.deepEqual(evaluateExpectations({ pair, direction: 'reverse' }, busy, result).map(o => o.key), ['max_reference_overlap']);
  const failed = evaluateExpectations({ pair, direction: 'forward' }, quiet, { error: 'No route found', metrics: {} });
  assert.ok(failed.every(o => o.pass === false));
  assert.throws(() => evaluateExpectations({ pair: { id: 'x', expect: [{ modes: '*', most_detour: 1 }] }, direction: 'forward' }, quiet, result), /unknown expectation/);
  assert.equal(matchesModes('1', { ...quiet.facets, mode: '1' }), true);
  assert.equal(matchesModes({ colour: 'red' }, quiet.facets), false);
});

test('aggregates: quantiles, pathological routes, pass rate, mode separation', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([], 0.5), null);
  const r = (detour, extra = {}) => ({ ok: true, metrics: { detour, distance_km: 10, high_stress_km: 1, unpaved_km: 2, class_i_share: 0.5, climb_m: 100, wilderness_km: 0 },
    expectations: [], same_as: [], ...extra });
  const a = computeAggregates([r(1.0), r(1.2, { same_as: ['2'] }), r(1.6, { expectations: [{ pass: false }, { pass: null }] }),
    { ok: false, error: 'No route found', metrics: {}, expectations: [{ pass: false }] }]);
  assert.equal(a.trips, 4);
  assert.equal(a.no_route, 1);
  assert.equal(a.pathological, 2);
  assert.equal(a.pathological_firm, 2, 'no firm baseline: still pathological');
  assert.equal(computeAggregates([r(1.6, { metrics: { detour: 1.6, firm_detour: 1.1 } })]).pathological_firm, 0);
  assert.equal(a.median_detour, 1.2);
  assert.equal(a.high_stress_km, 3);
  assert.equal(a.unpaved_share, 0.2);
  assert.equal(a.expectations, 2);
  assert.equal(a.expectation_pass_rate, 0);
  assert.equal(a.same_route_share, 0.3333);
});

test('tunings: config facets, base merge, tuning-wide options and sweeps', () => {
  assert.deepEqual(configFacets('1', tahoe.scenarios['1']), { scenario: '1', traffic: 'quiet', hills: 'balanced', surface: 'mixed' });
  assert.equal(configFacets('2', tahoe.scenarios['2']).traffic, 'busy');
  // SF's nine scenarios are a 3 x 3 grid of use_roads (1, 0.5, 0) and use_hills (0, 0.75, 1): every facet pair once.
  const sf = loadConfig({ BIKESY_CONFIG: 'config/sf.json' });
  const sfFacets = Object.entries(sf.scenarios).map(([id, o]) => configFacets(id, o));
  assert.equal(new Set(sfFacets.map(f => `${f.traffic}/${f.hills}`)).size, 9);
  assert.deepEqual([sfFacets[0].traffic, sfFacets[0].hills, sfFacets[8].traffic, sfFacets[8].hills], ['busy', 'flat', 'quiet', 'tolerant']);
  const [config] = loadTunings('tahoe', tahoe, 'config');
  assert.deepEqual(config.modes.map(m => [m.name, m.facets.traffic, m.facets.surface, m.options.use_roads]),
    [['1', 'quiet', 'mixed', 0], ['2', 'busy', 'mixed', 1], ['3', 'quiet', 'paved', 0], ['4', 'busy', 'paved', 1], ['5', 'quiet', 'dirt', 0], ['6', 'busy', 'dirt', 1]]);
  const spec = { name: 't', base: 'config', options: { use_hills: 0.9, unpaved_penalty: 2 },
    modes: { '2': null, dirt: { facets: { surface: 'dirt' }, options: { use_roads: 0, paved_penalty: 0.5 } } } };
  const t = resolveSpec('tahoe', tahoe, spec);
  assert.deepEqual(t.modes.map(m => m.name), ['1', '3', '4', '5', '6', 'dirt']);
  assert.deepEqual(t.modes[0].options, { use_hills: 0.9, use_roads: 0, maneuver_penalty: 2, unpaved_penalty: 2 });
  const dirt = t.modes.at(-1);
  assert.equal(dirt.facets.mode, 'dirt');
  assert.equal(dirt.options.paved_penalty, 0.5, 'unknown engine keys pass through');
  const api = resolveSpec('tahoe', tahoe, { name: 'api', source: { type: 'api', url: 'http://x/route' }, modes_from_config: true });
  assert.deepEqual(api.modes.map(m => [m.name, m.scenario, m.options]), ['1', '2', '3', '4', '5', '6'].map(id => [id, id, undefined]));
  const sweep = expandSweep({ base: 'config', grid: { 'options.use_hills': [0.25, 0.5], 'engine.policy': { a: '/a.bin', b: '/b.bin' } } }, 's');
  assert.deepEqual(sweep.map(s => s.name), ['s/use_hills=0.25,policy=a', 's/use_hills=0.25,policy=b', 's/use_hills=0.5,policy=a', 's/use_hills=0.5,policy=b']);
  const resolved = resolveSpec('tahoe', tahoe, sweep[3]);
  assert.equal(resolved.engine.policy, '/b.bin');
  assert.ok(resolved.modes.every(m => m.options.use_hills === 0.5));
});

test('tunings: engine paths expand ~/ and environment variables', () => {
  const env = { DIR: '/x/variants' };
  assert.equal(expandPath('${DIR}/hy50.bin', env), '/x/variants/hy50.bin');
  assert.equal(expandPath('$DIR/hy50.bin', env), '/x/variants/hy50.bin');
  assert.ok(expandPath('~/a.bin', env).endsWith('/a.bin') && !expandPath('~/a.bin', env).startsWith('~'));
  assert.equal(expandPath('rel/a.bin', env), 'rel/a.bin');
  assert.throws(() => expandPath('${MISSING}/a.bin', env), /MISSING is not set/);
});

test('checked-in pair catalogs and tunings load for every region', () => {
  // Policy variants live outside the repository; loading only resolves their paths.
  process.env.BIKESY_POLICY_VARIANTS ??= '/policy-variants';
  for (const { region, config } of listRegionConfigs()) {
    const runtime = loadConfig({ BIKESY_CONFIG: `config/${region}.json` });
    for (const name of listTunings(region)) assert.ok(loadTunings(region, runtime, name).length, `${region}/${name}`);
    const b = runtime.bounds;
    for (const file of readdirSync('bench/pairs').filter(f => f === `${region}.json` || f.startsWith(`${region}-`))) {
      const set = file === `${region}.json` ? 'curated' : file.slice(region.length + 1, -5);
      const catalog = loadPairSet(region, set);
      for (const p of catalog.pairs) for (const point of [p.from, p.to, p.via].filter(Boolean)) {
        assert.ok(point.lat > b.bottom && point.lat < b.top && point.lon > b.left && point.lon < b.right, `${file} ${p.id} outside service bounds`);
      }
      // Every metric name is known (a misspelled one throws); "*" entries are the ones evaluated here.
      const metrics = Object.fromEntries(METRICS.map(m => [m.name, 1]));
      for (const trip of expandTrips(catalog)) for (const e of trip.pair.expect ?? []) {
        evaluateExpectations({ ...trip, pair: { ...trip.pair, expect: [e] } }, { facets: { mode: 'x' } }, { metrics });
      }
    }
    assert.ok(config.region === region);
  }
  const trips = expandTrips({ set: 'curated', pairs: [{ id: 'a', from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 } }, { id: 'b', one_way: true, from: { lat: 1, lon: 2 }, to: { lat: 3, lon: 4 } }] });
  assert.deepEqual(trips.map(t => t.key), ['curated/a/forward', 'curated/a/reverse', 'curated/b/forward']);
  assert.deepEqual(trips[1].from, { lat: 3, lon: 4 });
});

test('cache keys ignore key order; report matches modes by name then facets', () => {
  assert.equal(stableJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  assert.equal(hashKey({ x: 1, y: 2 }), hashKey({ y: 2, x: 1 }));
  const base = [{ name: '1', facets: { traffic: 'quiet', surface: 'mixed' } }, { name: '2', facets: { traffic: 'busy', surface: 'mixed' } }];
  assert.equal(matchMode({ name: '2', facets: {} }, base).name, '2');
  assert.equal(matchMode({ name: 'quiet-paved', facets: { traffic: 'quiet', surface: 'paved' } }, base).name, '1');
  assert.equal(matchMode({ name: 'x', facets: { colour: 'red' } }, base), null);
});

test('engine containers are named per identity and port', () => {
  const identity = { key: 'image-id:policy' };
  assert.match(containerName(identity), /^bench-[0-9a-f]{10}$/);
  assert.equal(containerName(identity, 18002), containerName(identity));
  assert.equal(containerName(identity, 18072), `${containerName(identity)}-p18072`);
});

test('seeded sampling is deterministic and weighted by cell', () => {
  const a = random(7), b = random(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const cells = new Map([['dense', Array.from({ length: 99 }, (_, i) => ['d', i])], ['sparse', [['s', 0]]]]);
  const pick = cellSampler(cells, 1, random(1));
  const share = Array.from({ length: 2000 }, pick).filter(p => p[0] === 'd').length / 2000;
  assert.ok(share > 0.97, `dense share ${share}`);
  const flat = cellSampler(cells, 0, random(1));
  const flatShare = Array.from({ length: 2000 }, flat).filter(p => p[0] === 'd').length / 2000;
  assert.ok(flatShare > 0.4 && flatShare < 0.6, `alpha 0 share ${flatShare}`);
});

test('local source runs the production adapter: request, ferry retry and response hash', async () => {
  const shape = encode([[39.17, -120.14], [39.171, -120.14]], 6);
  const trip = { trip: { status: 0, units: 'kilometers', summary: { length: 0.111, has_ferry: true },
    legs: [{ shape, maneuvers: [{ type: 1, begin_shape_index: 0, street_names: ['Road'] }, { type: 4, begin_shape_index: 1 }] }] } };
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; }).on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(body) });
      const routes = requests.filter(r => r.path === '/route').length;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/height' ? { range_height: [[0, 1900], [111.195, 1901]], encoded_polyline: shape }
        : routes === 1 ? { error_code: 470, error: 'Bikesy certified land disconnection' } : trip));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const route = createValhallaSource({ regionConfig: tahoe, valhallaUrl: `http://127.0.0.1:${server.address().port}/` });
    const record = await route({ lat: 39.17, lon: -120.14 }, { lat: 39.171, lon: -120.14 }, { use_hills: 0.3, unpaved_penalty: 1 });
    assert.equal(record.ok, true);
    assert.equal(record.ferry_retry, true);
    assert.equal(record.total_distance, 111);
    assert.equal(record.maneuvers, 2);
    assert.match(record.response_sha256, /^[0-9a-f]{64}$/);
    const first = requests[0].body.costing_options.bicycle;
    assert.deepEqual(first, { bicycle_type: 'Hybrid', use_hills: 0.3, unpaved_penalty: 1, use_ferry: 0 });
    assert.equal(requests[1].body.costing_options.bicycle.use_ferry, 0.5);
    const outside = await route({ lat: 30, lon: -120.14 }, { lat: 39.171, lon: -120.14 }, {});
    assert.deepEqual(outside, { ok: false, error: 'Location outside routing bounds' });
  } finally {
    server.close();
  }
  assert.equal(responseHash({ directions: [], path: [], total_distance: 1, elevation_profile: [] }),
    responseHash({ elevation_profile: [], total_distance: 1, path: [], directions: [] }));
});

test('route records become metric routes and compact report geometry', () => {
  const points = [[39.17, -120.14], [39.171, -120.14], [39.172, -120.141], [39.173, -120.141]];
  const attributes = { shape: encode(points, 6), heights: [[0, 1], [30, 2]], edges: [
    { length: 0.111, surface: 'paved', road_class: 'primary', use: 'road', begin_shape_index: 0, end_shape_index: 1 },
    { length: 0.25, surface: 'dirt', road_class: 'service_other', use: 'path', begin_shape_index: 1, end_shape_index: 3 }] };
  const route = buildRoute({ directions: 3, maneuvers: 4 }, attributes);
  assert.equal(route.edges[1].points.length, 3);
  assert.equal(route.edges[0].length_m, 111);
  const g = compactGeometry(route);
  assert.deepEqual(g.s, [[0, 'paved', 'high'], [1, 'unpaved', 'path']]);
});

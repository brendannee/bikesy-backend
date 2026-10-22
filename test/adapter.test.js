import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { parseQuery, convertTrip, createAdapter, validateElevation } from '../src/adapter.js';
import { createHandler } from '../src/server.js';
import { decode, encode, legacyPath } from '../src/polyline.js';
const config = loadConfig({});
const query = (extra = '') => new URLSearchParams('lat1=37.789281229572&lng1=-122.46094205322234&lat2=37.78012650217339&lng2=-122.44433400393197' + extra);
const points = [[37.789281, -122.460942], [37.785, -122.46], [37.780126, -122.444334]];
const trip = () => ({ trip: { status: 0, units: 'kilometers', summary: { length: 2.34 }, legs: [{ shape: encode(points, 6), maneuvers: [
  { type: 1, begin_shape_index: 0, begin_heading: 180, street_names: ['First Street'] },
  { type: 10, begin_shape_index: 1, street_names: ['Second Street'] },
  { type: 4, begin_shape_index: 2 },
] }] } });
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const profile = [[0, 82.86], [483.17, 45], [1962.76, 60]];
function stub() {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body), signal: options.signal });
    return json(String(url).endsWith('/route') ? trip() : { range_height: profile, encoded_polyline: trip().trip.legs[0].shape });
  } };
}
test('all SF scenarios preserve hills and facilities axes', () => {
  for (let i = 1; i <= 9; i++) {
    const r = parseQuery(query(`&scenario=${i}`), config);
    assert.equal(r.costing_options.bicycle.use_hills, [0, .75, 1][(i - 1) % 3]);
    assert.equal(r.costing_options.bicycle.use_roads, [1, .5, 0][Math.floor((i - 1) / 3)]);
    assert.equal(r.costing_options.bicycle.maneuver_penalty, i === 9 ? undefined : 2);
    assert.equal(r.units, 'kilometers');
  }
  assert.deepEqual(parseQuery(query(), config), parseQuery(query('&scenario=1'), config));
  assert.deepEqual(parseQuery(query('&scenario='), config), parseQuery(query(), config));
});
test('Tahoe has a traffic x trail surface grid of six scenarios', () => {
  const c = loadConfig({ BIKESY_CONFIG: 'config/tahoe.json' });
  const q = new URLSearchParams('lat1=39&lat2=39.1&lng1=-120&lng2=-120.1');
  const bicycle = scenario => { q.set('scenario', scenario); return parseQuery(q, c).costing_options.bicycle; };
  assert.deepEqual(Object.keys(c.scenarios), ['1', '2', '3', '4', '5', '6']);
  assert.equal(parseQuery(new URLSearchParams(q), c).costing_options.bicycle.use_roads, 0.1, 'scenario 1 is the default');
  // Avoid Busy Roads keeps a little road tolerance (0.1) and Fastest Route a little
  // bike-facility preference (0.8); both stay on their side of the bench's quiet/busy facets.
  for (const [id, roads] of [['1', 0.1], ['2', 0.8], ['3', 0.1], ['4', 0.8], ['5', 0.1], ['6', 0.8]]) {
    assert.equal(bicycle(id).use_roads, roads, `scenario ${id}`);
    assert.equal(bicycle(id).use_hills, 0.5, `scenario ${id}`);
  }
  assert.equal(bicycle('3').unpaved_penalty, 8, 'Prefer Paved avoids dirt at nearly any cost');
  assert.equal(bicycle('4').unpaved_penalty, 8);
  assert.equal(bicycle('1').paved_penalty, undefined);
  assert.equal(bicycle('1').unpaved_penalty, 1, 'the default scenario treats all unpaved surfaces alike');
  assert.equal(bicycle('2').unpaved_penalty, 0.25, 'Fastest Route costs dirt like the Hybrid speed loss');
  assert.equal(bicycle('5').paved_penalty, 2);
  assert.equal(bicycle('6').paved_penalty, 2);
  assert.equal(bicycle('5').bicycle_type, 'Mountain');
  assert.equal(bicycle('4').bicycle_type, 'Hybrid');
  q.set('scenario', '7');
  assert.throws(() => parseQuery(q, c), /Invalid `scenario` 7/);
});
test('validation preserves missing errors, rejects invalid numeric and scenario inputs', () => {
  assert.throws(() => parseQuery(new URLSearchParams(), config), /No `lat1` specified/);
  for (const value of ['NaN', 'Infinity', ' ', '37oops', '91', '0x25']) {
    const q = query(); q.set('lat1', value);
    assert.throws(() => parseQuery(q, config), /Invalid `lat1`/);
  }
  for (const s of ['0', '10', '__proto__', 'constructor', '1.0']) assert.throws(() => parseQuery(query(`&scenario=${s}`), config), /Invalid `scenario`/);
  const q = query(); q.set('lat1', '0');
  assert.throws(() => parseQuery(q, config), /outside routing bounds/);
});
test('legacy polyline golden vectors and levels', () => {
  assert.deepEqual(legacyPath([[38.5, -120.2]]), ['_p~iF~ps|U', 'B']);
  assert.deepEqual(legacyPath([[37.4419, -122.1419], [37.4519, -122.1519], [37.4619, -122.1819]]), ['yzocFzynhVq}@n}@o}@nzD', 'B@B']);
  assert.deepEqual(legacyPath([[0, 0], [0, .001], [0, .002]]), [encode([[0, 0], [0, .002]]), 'BB']);
  assert.deepEqual(decode(encode(points, 6)), points);
  assert.throws(() => decode('_'), /Invalid route shape/);
  assert.throws(() => decode('\u0000'), /Invalid route shape/);
});
test('conversion uses lon/lat directions, polyline5, meters, and omits arrival', () => {
  const r = convertTrip(trip());
  assert.equal(r.total_distance, 2340);
  assert.deepEqual(r.directions, [['start south', 'First Street', [-122.460942, 37.789281]], ['right', 'Second Street', [-122.46, 37.785]]]);
  assert.ok(Math.abs(decode(r.path[0], 5)[0][0] - points[0][0]) < .00001);
  assert.equal(decode(r.path[0], 5).length, r.path[1].length);
  const t = trip(); t.trip.legs[0].maneuvers[0].street_names = [];
  assert.equal(convertTrip(t).directions[0][1], 'nameless');
});
test('adapter requests elevation with original polyline6 and bounded resampling', async () => {
  const upstream = stub();
  const r = await createAdapter(config, upstream.fetch)(query('&scenario=5'));
  assert.deepEqual(r.elevation_profile, profile);
  assert.equal(upstream.calls.length, 2);
  assert.equal(upstream.calls[1].body.encoded_polyline, trip().trip.legs[0].shape);
  assert.equal(upstream.calls[1].body.resample_distance, 10);
  assert.equal(upstream.calls[0].signal, upstream.calls[1].signal);
  assert.equal(r.stats.endpoint_find_time, 0);
  assert.ok(Object.values(r.stats).every(x => Number.isFinite(x) && x >= 0));
});
test('errors never silently substitute missing DEM or malformed trips', async () => {
  for (const bad of [[[0, null]], [[1, 20]], [[0, -32768]], [[0, 1], [-1, 2]], []]) assert.throws(() => validateElevation(bad));
  for (const mutate of [t => t.trip.units = 'miles', t => t.trip.summary.length = -1, t => t.trip.legs[0].shape = '_', t => t.trip.legs[0].maneuvers[0].begin_shape_index = 1000]) {
    const t = trip(); mutate(t); assert.throws(() => convertTrip(t));
  }
  await assert.rejects(createAdapter(config, async () => { throw new Error('private detail'); })(query()), e => e.status === 502 && !e.message.includes('private'));
  await assert.rejects(createAdapter(config, async () => json({ error_code: 442 }))(query()), /No route found/);
  await assert.rejects(createAdapter(config, async url => json(String(url).endsWith('/route') ? trip() : { range_height: [[0, null]] }))(query()), e => e.status === 502);
});
test('upstream timeout becomes 504', async () => {
  await assert.rejects(createAdapter({ ...config, timeoutMs: 1 }, async (_url, { signal }) => {
    await new Promise(resolve => setTimeout(resolve, 10));
    signal.throwIfAborted();
  })(query()), e => e.status === 504);
});
async function request(path, method = 'GET', fetchImpl = stub().fetch) {
  const headers = {};
  const res = { setHeader: (k, v) => headers[k] = v, end: body => res.body = body };
  await createHandler(config, fetchImpl)({ url: path, method }, res);
  return { status: res.statusCode, body: res.body && JSON.parse(res.body), headers };
}
test('HTTP contract through handler, without starting any server', async () => {
  for (const path of ['/route', '/api/route', '/', '/api.php', '/api.php/', 'https://api.bikesy.com/route']) {
    assert.equal((await request(path + '?' + query())).body.total_distance, 2340);
    const missing = await request(path);
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body, { error: 'No `lat1` specified' });
  }
  for (const path of ['/bounds', '/api/bounds']) assert.deepEqual((await request(path)).body, config.bounds);
  assert.deepEqual((await request('/route')).body, { error: 'No `lat1` specified' });
  assert.equal((await request('/route')).status, 200);
  assert.equal((await request('/bad')).status, 404);
  assert.equal((await request('/', 'POST')).status, 405);
  assert.equal((await request('/', 'OPTIONS')).status, 204);
  assert.equal((await request('/bounds', 'HEAD')).body, undefined);
  assert.equal((await request('/bounds')).headers['Access-Control-Allow-Origin'], '*');
  assert.equal((await request('/route?' + query(), 'GET', async () => { throw Error(); })).status, 502);
});
test('live legacy capture and adapter have the same successful response structure', async () => {
  const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-sf-scenario5.json', import.meta.url)));
  const r = await createAdapter(config, stub().fetch)(query());
  assert.deepEqual(Object.keys(r).sort(), Object.keys(legacy).sort());
  assert.deepEqual(Object.keys(r.stats).sort(), Object.keys(legacy.stats).sort());
  for (const response of [legacy, r]) {
    assert.ok(response.directions.every(d => typeof d[0] === 'string' && typeof d[1] === 'string' && d[2].length === 2));
    assert.equal(decode(response.path[0], 5).length, response.path[1].length);
    validateElevation(response.elevation_profile);
  }
});
test('invalid configuration fails at startup', () => {
  for (const env of [{ BIKESY_CONFIG: 'config/unknown.json' }, { VALHALLA_TIMEOUT_MS: 'NaN' }, { VALHALLA_URL: 'file:///tmp/data' }]) assert.throws(() => loadConfig(env));
});
test('real pinned Valhalla offline OSM response converts to the legacy contract', () => {
  const response = JSON.parse(readFileSync(new URL('./fixtures/valhalla-offline-sf-scenario5.json', import.meta.url)));
  const result = convertTrip(response);
  assert.equal(result.total_distance, 2579);
  assert.ok(result.directions[0][0].startsWith('start '));
  assert.ok(result.directions.length > 1);
  assert.equal(decode(result.path[0], 5).length, result.path[1].length);
  assert.ok(result.directions.every(d => d[2][0] < -122 && d[2][1] > 37));
});
test('merge directions match pinned Valhalla enum values', () => {
  for (const [type, turn] of [[37, 'slight right'], [38, 'slight left']]) {
    const response = trip(); response.trip.legs[0].maneuvers[1].type = type;
    assert.equal(convertTrip(response).directions[1][0], turn);
  }
});
test('maneuver coordinates use original indices even when simplification removes the point', () => {
  const t = trip();
  t.trip.legs[0].shape = encode([[37.78, -122.46], [37.78, -122.45], [37.78, -122.44]], 6);
  const r = convertTrip(t);
  assert.equal(decode(r.path[0], 5).length, 2);
  assert.deepEqual(r.directions[1][2], [-122.45, 37.78]);
});
test('truncated, shifted and inconsistent elevation responses fail closed', async () => {
  for (const height of [
    { range_height: [[0, 12]], encoded_polyline: encode([points[0]], 6) },
    { range_height: profile, encoded_polyline: encode(points.slice(1), 6) },
    { range_height: [[0, 12], [100, 15], [200, 17]], encoded_polyline: encode(points, 6) },
    { range_height: profile, encoded_polyline: encode(points.map(p => [p[0] + .01, p[1]]), 6) },
  ]) {
    await assert.rejects(createAdapter(config, async url => json(String(url).endsWith('/route') ? trip() : height))(query()), e => e.status === 502);
  }
});
test('oversized or malformed upstream bodies are rejected and streams cancelled', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { if (!declared) controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { headers: declared ? { 'content-length': String(8 * 1024 * 1024 + 1) } : {} });
    await assert.rejects(createAdapter(config, async () => response)(query()), e => e.status === 502);
    assert.equal(cancelled, true);
  }
  await assert.rejects(createAdapter(config, async () => new Response('not json'))(query()), e => e.status === 502);
});
test('deadline also cancels an unfinished upstream response body', async () => {
  let cancelled = false;
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(createAdapter({ ...config, timeoutMs: 5 }, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })))(query()), e => e.status === 504);
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});
test('concurrency limit rejects excess work and releases capacity after a failure', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const route = createAdapter({ ...config, maxConcurrent: 1, maxQueued: 0 }, async () => { await pending; throw Error('upstream unavailable'); });
  const first = route(query());
  await assert.rejects(route(query()), e => e.status === 503);
  release();
  await assert.rejects(first, e => e.status === 502);
  await assert.rejects(route(query()), e => e.status === 502);
  assert.throws(() => loadConfig({ MAX_CONCURRENT_ROUTES: '0' }));
});
test('client disconnect aborts upstream work and releases capacity', async () => {
  const client = new AbortController();
  let cancelled = false;
  const route = createAdapter({ ...config, maxConcurrent: 1 }, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const pending = route(query(), client.signal);
  await new Promise(resolve => setImmediate(resolve));
  client.abort();
  await assert.rejects(pending, e => e.status === 499);
  assert.equal(cancelled, true);
});
test('geometry budgets bound decoded size and pathological simplification work', () => {
  assert.throws(() => decode('??'.repeat(50_001)), /point limit/);
  const zigzag = Array.from({ length: 4000 }, (_, i) => [i % 2 ? .01 : 0, i / 1e6]);
  assert.throws(() => legacyPath(zigzag), /work limit/);
});
test('handler disconnect wiring cancels upstream and removes event listeners', async () => {
  const { EventEmitter } = await import('node:events');
  for (const event of ['aborted', 'close']) {
    const req = Object.assign(new EventEmitter(), { url: '/route?' + query(), method: 'GET' });
    const res = Object.assign(new EventEmitter(), { setHeader() {}, end() { throw Error('must not write to destroyed response'); } });
    let cancelled = false;
    const pending = createHandler(config, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })))(req, res);
    await new Promise(resolve => setImmediate(resolve));
    res.destroyed = true;
    (event === 'close' ? res : req).emit(event);
    await pending;
    assert.equal(cancelled, true);
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
});
test('elapsed deadline catches synchronous work before timers get a turn', async () => {
  const route = createAdapter({ ...config, timeoutMs: 1 }, async () => {
    const end = performance.now() + 3;
    while (performance.now() < end) { /* Simulate synchronous upstream parsing. */ }
    return json(trip());
  });
  await assert.rejects(route(query()), e => e.status === 504);
});
test('real offline Valhalla elevation resampling matches coverage checks but missing DEM fails', () => {
  const response = JSON.parse(readFileSync(new URL('./fixtures/valhalla-offline-sf-scenario5.json', import.meta.url)));
  const height = JSON.parse(readFileSync(new URL('./fixtures/valhalla-offline-sf-missing-dem.json', import.meta.url)));
  const routePoints = decode(response.trip.legs[0].shape);
  const samples = decode(height.encoded_polyline);
  assert.throws(() => validateElevation(height.range_height, samples, routePoints), /Missing or invalid/);
  // Real geometry/ranges, synthetic heights: plumbing verification only, not terrain validation.
  validateElevation(height.range_height.map(([d]) => [d, 0]), samples, routePoints);
});
test('missing-parameter errors take precedence over malformed coordinates, as in legacy', () => {
  assert.throws(() => parseQuery(new URLSearchParams('lat1=bad'), config), /No `lat2` specified/);
});

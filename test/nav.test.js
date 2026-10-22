import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createAdapter, parseNav, validateNavRoute, convertTrip } from '../src/adapter.js';
import { createHandler } from '../src/server.js';
import { decode, encode } from '../src/polyline.js';

// Real Tahoe capture: South Lake Tahoe via the El Dorado/Harrison bike path, scenario 1.
const capture = JSON.parse(readFileSync(new URL('./fixtures/valhalla-tahoe-slt-nav.json', import.meta.url)));
const config = loadConfig({ BIKESY_CONFIG: 'config/tahoe.json' });
const query = (extra = '') => new URLSearchParams(capture.query + extra);
const legacyKeys = ['directions', 'path', 'total_distance', 'elevation_profile', 'stats'];
const withoutStats = ({ stats, ...rest }) => rest;
const tick = () => new Promise(resolve => setImmediate(resolve));
const aborted = signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));

// Each call is classed as the native route, the OSRM navigation route or elevation.
// Handlers may return data, a Response or a pending promise; the default is the capture.
function engine(handlers = {}) {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    const kind = url.pathname === '/height' ? 'height' : body.format === 'osrm' ? 'nav' : 'route';
    calls.push({ kind, body, signal: options.signal });
    const data = await (handlers[kind] ?? (() => capture[kind]))(body, options.signal);
    return data instanceof Response ? data : Response.json(data);
  } };
}

test('nav off keeps the legacy upstream calls and response', async () => {
  const results = [];
  for (const extra of ['', '&nav=', '&nav=0']) {
    const upstream = engine();
    const r = await createAdapter(config, upstream.fetch)(query(extra));
    assert.deepEqual(upstream.calls.map(c => c.kind), ['route', 'height']);
    assert.deepEqual(upstream.calls[0].body, capture.request);
    assert.deepEqual(upstream.calls[1].body, capture.height_request);
    assert.deepEqual(Object.keys(r), legacyKeys);
    results.push(JSON.stringify(withoutStats(r)));
  }
  assert.equal(new Set(results).size, 1);
});
test('nav=1 appends the OSRM route and full-resolution points after the legacy keys', async () => {
  const off = await createAdapter(config, engine().fetch)(query());
  const upstream = engine();
  const r = await createAdapter(config, upstream.fetch)(query('&nav=1'));
  assert.deepEqual(upstream.calls.map(c => c.kind), ['route', 'height', 'nav']);
  assert.deepEqual(upstream.calls[2].body, capture.nav_request);
  assert.deepEqual(upstream.calls[2].body, { ...upstream.calls[0].body, units: 'miles', format: 'osrm', banner_instructions: true, voice_instructions: true });
  assert.ok(upstream.calls.every(c => c.signal === upstream.calls[0].signal));
  assert.deepEqual(Object.keys(r), [...legacyKeys, 'nav_route', 'points']);
  assert.equal(JSON.stringify(withoutStats(r)), JSON.stringify({ ...withoutStats(off), nav_route: capture.nav, points: decode(capture.route.trip.legs[0].shape) }));
  assert.equal(r.points.length, 177);
  assert.deepEqual(r.points[0], [38.9399, -119.977228]);
});
test('unnamed Tahoe paths keep banner and spoken instructions', async () => {
  const r = await createAdapter(config, engine().fetch)(query('&nav=1'));
  const steps = r.nav_route.routes[0].legs[0].steps;
  assert.equal(r.directions.filter(d => d[1] === 'nameless').length, 3);
  assert.equal(steps.filter(s => !s.name).length, 3);
  for (const [i, step] of steps.entries()) {
    if (step.maneuver.type === 'arrive') continue;
    assert.ok(step.bannerInstructions.length && step.voiceInstructions.length, `step ${i}`);
    assert.ok(step.bannerInstructions.every(b => b.primary.text), `step ${i}`);
    if (!steps[i + 1]?.name && steps[i + 1]?.maneuver.type !== 'arrive') assert.match(step.bannerInstructions.at(-1).primary.text, /cycleway|Bear left/);
  }
  assert.match(steps[2].voiceInstructions[1].announcement, /^In \d+ feet, Continue on the cycleway\.$/);
  assert.equal(r.nav_route.routes[0].geometry, capture.route.trip.legs[0].shape);
});
test('both Tahoe scenarios send the same costing to the native and navigation routes', async () => {
  for (const scenario of ['1', '2']) {
    const upstream = engine();
    const q = query('&nav=1'); q.set('scenario', scenario);
    await createAdapter(config, upstream.fetch)(q);
    const [native, nav] = ['route', 'nav'].map(kind => upstream.calls.find(c => c.kind === kind).body);
    assert.deepEqual(nav.costing_options, native.costing_options);
    assert.equal(native.costing_options.bicycle.use_roads, config.scenarios[scenario].use_roads);
    assert.equal(native.units, 'kilometers');
  }
});
test('after a certified ferry retry, navigation repeats the retry request', async () => {
  let first = true;
  const upstream = engine({ route: () => {
    if (!first) return capture.route;
    first = false;
    return { error_code: 470, error: 'Bikesy certified land disconnection' };
  } });
  const r = await createAdapter(config, upstream.fetch)(query('&nav=1'));
  assert.deepEqual(upstream.calls.map(c => c.kind), ['route', 'route', 'height', 'nav']);
  const [land, ferry, , nav] = upstream.calls.map(c => c.body);
  assert.equal(land.costing_options.bicycle.use_ferry, 0);
  assert.equal(ferry.costing_options.bicycle.use_ferry, 0.5);
  assert.deepEqual(nav, { ...ferry, units: 'miles', format: 'osrm', banner_instructions: true, voice_instructions: true });
  assert.deepEqual(r.nav_route, capture.nav);
});
test('a navigation route that differs from the native route fails closed', async () => {
  const converted = convertTrip(capture.route);
  assert.equal(validateNavRoute(capture.nav, converted), capture.nav);
  validateNavRoute({ ...capture.nav, routes: [{ ...capture.nav.routes[0], distance: converted.total_distance + 4 }] }, converted);
  const route = capture.nav.routes[0], shape = decode(route.geometry);
  const moved = shape.map((p, i) => i === shape.length - 1 ? [p[0] + 0.0002, p[1]] : p);
  for (const nav of [
    { ...capture.nav, routes: [{ ...route, distance: route.distance + 50 }] },
    { ...capture.nav, routes: [{ ...route, geometry: encode(moved, 6) }] },
    { ...capture.nav, routes: [route, route] },
    { ...capture.nav, routes: [{ ...route, legs: [] }] },
    { ...capture.nav, code: 'NoRoute' },
    { code: 'Ok' },
  ]) {
    assert.throws(() => validateNavRoute(nav, converted), /navigation route/i);
    await assert.rejects(createAdapter(config, engine({ nav: () => nav }).fetch)(query('&nav=1')), e => e.status === 502);
  }
  const osrmError = () => Response.json({ code: 'NoSegment', message: 'One of the supplied input coordinates could not snap to street segment.' }, { status: 400 });
  await assert.rejects(createAdapter(config, engine({ nav: osrmError }).fetch)(query('&nav=1')), e => e.status === 502);
});
test('invalid nav values are rejected before contacting the engine', async () => {
  for (const value of ['2', 'true', 'on', ' 1', '1.0', '01', '-1']) {
    assert.throws(() => parseNav(new URLSearchParams(`nav=${encodeURIComponent(value)}`)), /Invalid `nav`/);
    const upstream = engine();
    await assert.rejects(createAdapter(config, upstream.fetch)(query(`&nav=${encodeURIComponent(value)}`)), e => e.status === 200 && e.message === 'Invalid `nav`');
    assert.equal(upstream.calls.length, 0);
  }
  assert.equal(parseNav(new URLSearchParams('nav=1')), true);
  assert.equal(parseNav(new URLSearchParams('nav=0')), false);
  assert.equal(parseNav(new URLSearchParams()), false);
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = JSON.parse(body); } };
  await createHandler(config, engine().fetch)({ method: 'GET', url: '/route?' + query('&nav=yes') }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { error: 'Invalid `nav`' });
  await assert.rejects(createAdapter(config, engine().fetch)(new URLSearchParams('nav=2')), /No `lat1` specified/);
});
test('timeout while the navigation call is in flight becomes 504 and cancels it', async () => {
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const upstream = engine({ nav: (_body, signal) => aborted(signal) });
    await assert.rejects(createAdapter({ ...config, timeoutMs: 50 }, upstream.fetch)(query('&nav=1')), e => e.status === 504);
    assert.deepEqual(upstream.calls.map(c => c.kind), ['route', 'height', 'nav']);
    assert.equal(upstream.calls[2].signal.aborted, true);
  } finally { clearTimeout(keepAlive); }
});
test('client disconnect during the navigation call becomes 499 and cancels elevation too', async () => {
  const client = new AbortController();
  const upstream = engine({ nav: (_body, signal) => aborted(signal), height: (_body, signal) => aborted(signal) });
  const pending = createAdapter(config, upstream.fetch)(query('&nav=1'), client.signal);
  while (upstream.calls.length < 3) await tick();
  client.abort();
  await assert.rejects(pending, e => e.status === 499);
  assert.ok(upstream.calls.every(c => c.signal.aborted));
});
test('one failure cancels the concurrent call and the slot is held until both finish', async () => {
  for (const failing of ['height', 'nav']) {
    const other = failing === 'height' ? 'nav' : 'height', events = [];
    let release, first = true;
    const gate = new Promise(resolve => { release = resolve; });
    const upstream = engine({
      route: () => { if (!first) events.push('queued request started'); return capture.route; },
      [failing]: async () => { if (!first) return capture[failing]; await gate; return new Response('not json'); },
      // A slow cancellation: the slot must stay held until this call has finished.
      [other]: async (_body, signal) => {
        if (!first) return capture[other];
        await aborted(signal).catch(() => new Promise(resolve => setTimeout(resolve, 20)));
        events.push(`${other} cancelled`);
        throw signal.reason;
      },
    });
    const route = createAdapter({ ...config, maxConcurrent: 1, maxQueued: 1 }, upstream.fetch);
    const pending = route(query('&nav=1'));
    while (upstream.calls.length < 3) await tick();
    const queued = route(query());
    await tick();
    assert.equal(upstream.calls.length, 3);
    first = false;
    release();
    await assert.rejects(pending, e => e.status === 502);
    assert.deepEqual(Object.keys(await queued), legacyKeys);
    assert.deepEqual(events, [`${other} cancelled`, 'queued request started']);
  }
});

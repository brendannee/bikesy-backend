// Routing sources. Each returns a "route record": the production-visible response
// summary plus the route shape, or { ok: false, error }.
//
// - valhalla: runs the production adapter (src/adapter.js createAdapter) against a local
//   engine, with the trip's options as the only scenario. Request building, use_ferry: 0,
//   the land-disconnection ferry retry and the /height profile are therefore exactly
//   production's; a capturing fetch records the raw Valhalla responses.
// - api: calls a deployed /route?scenario= endpoint (bikesy-backend or the legacy server),
//   decodes its polyline5 path, and relies on local map matching for attributes.
import { createHash } from 'node:crypto';
import { createAdapter, parseQuery } from '../../src/adapter.js';
import { decode, encode } from '../../src/polyline.js';
import { densify } from './geo.mjs';

const ATTRIBUTES = ['edge.length', 'edge.surface', 'edge.road_class', 'edge.use', 'edge.cycle_lane',
  'edge.shoulder', 'edge.speed_limit', 'edge.travel_mode', 'edge.names', 'edge.way_id',
  'edge.begin_shape_index', 'edge.end_shape_index', 'edge.bicycle_network', 'edge.lane_count',
  'edge.sac_scale', 'edge.max_upward_grade', 'edge.weighted_grade', 'edge.density', 'shape'];

const query = (from, to, scenario) => new URLSearchParams({ lat1: from.lat, lng1: from.lon, lat2: to.lat, lng2: to.lon, scenario });

// Hash of the user-visible response, to compare local runs with deployed APIs exactly.
export function responseHash(body) {
  const { directions, path, total_distance, elevation_profile, route_warnings } = body;
  return createHash('sha256').update(JSON.stringify({ directions, path, total_distance, elevation_profile, route_warnings })).digest('hex');
}

function summarize(body, shape, extra = {}) {
  return { ok: true, shape, total_distance: body.total_distance, directions: body.directions.length,
    route_warnings: body.route_warnings ?? [], elevation_profile: body.elevation_profile, response_sha256: responseHash(body), ...extra };
}

export function valhallaRequest(regionConfig, from, to, options) {
  return parseQuery(query(from, to, '1'), { ...regionConfig, scenarios: { 1: options } });
}

export function createValhallaSource({ regionConfig, valhallaUrl, timeoutMs = 120000 }) {
  return async function route(from, to, options) {
    const calls = [];
    const capture = async (url, init) => {
      const response = await fetch(url, init);
      const text = await response.text();
      let json; try { json = JSON.parse(text); } catch {}
      calls.push({ action: new URL(url).pathname.replace(/^\//, ''), request: JSON.parse(init.body), status: response.status, json });
      return new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } });
    };
    const config = { ...regionConfig, scenarios: { 1: options }, valhallaUrl, timeoutMs, maxConcurrent: 1, maxQueued: 0 };
    const adapter = createAdapter(config, capture);
    try {
      const body = await adapter(query(from, to, '1'));
      const routes = calls.filter(c => c.action === 'route');
      const trip = routes.at(-1).json.trip;
      return summarize(body, trip.legs[0].shape, { ferry_retry: routes.length > 1, maneuvers: trip.legs[0].maneuvers.length,
        valhalla_length_km: trip.summary.length });
    } catch (error) {
      const engineError = calls.findLast(c => c.json?.error)?.json;
      return { ok: false, error: error.message, ...(engineError ? { engine_error: `${engineError.error_code}: ${engineError.error}` } : {}) };
    }
  };
}

// Deployed /route APIs. Requests are serialized with a minimum interval; after
// `maxFailures` consecutive network failures the source is marked down and skipped.
export function createApiSource({ url, rate_ms: rateMs = 1000, timeout_ms: timeoutMs = 60000, maxFailures = 3 }) {
  let chain = Promise.resolve(), last = 0, failures = 0;
  const state = { down: false };
  async function call(from, to, scenario) {
    if (state.down) return { ok: false, error: 'source unavailable', transient: true };
    await new Promise(r => setTimeout(r, Math.max(0, last + rateMs - Date.now())));
    last = Date.now();
    let response, body;
    try {
      response = await fetch(`${url}${url.includes('?') ? '&' : '?'}${query(from, to, scenario)}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      // Only network failures and timeouts count towards marking the source down.
      if (++failures >= maxFailures) state.down = true;
      return { ok: false, error: `source request failed: ${error.message}`, transient: true };
    }
    failures = 0;
    try { body = await response.json(); } catch { body = null; }
    // An HTML error page (e.g. the legacy server's 502 for a trip it cannot route) is
    // retried on the next run rather than cached.
    if (!body) return { ok: false, error: `HTTP ${response.status} without JSON`, transient: true };
    if (response.status >= 500 && !body.error) return { ok: false, error: `HTTP ${response.status}`, transient: true };
    if (body.error) return { ok: false, error: body.error, ...(response.status >= 500 ? { transient: true } : {}) };
    if (!Array.isArray(body.path) || typeof body.path[0] !== 'string') return { ok: false, error: 'response has no path' };
    const points = decode(body.path[0], 5);
    return summarize(body, encode(points, 6), { maneuvers: body.directions.length + 1 });
  }
  const route = (from, to, scenario) => (chain = chain.then(() => call(from, to, scenario)));
  route.state = state;
  return route;
}

async function post(valhallaUrl, action, body) {
  const response = await fetch(new URL(action, valhallaUrl), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const json = await response.json();
  if (json.error) throw new Error(`${action}: ${json.error_code} ${json.error}`);
  return json;
}

// Edge attributes (trace_attributes) and a fixed-resolution elevation profile for a shape.
// Local routes walk their own edges; API shapes are densified and map matched.
export async function fetchAttributes(valhallaUrl, shape, costingOptions, { matched = false } = {}) {
  let encoded = shape;
  if (matched) encoded = encode(densify(decode(shape), 50), 6);
  const trace = await post(valhallaUrl, 'trace_attributes', {
    encoded_polyline: encoded, shape_format: 'polyline6', costing: 'bicycle', costing_options: costingOptions,
    shape_match: matched ? 'map_snap' : 'walk_or_snap', filters: { attributes: ATTRIBUTES, action: 'include' },
  });
  const heights = await post(valhallaUrl, 'height', { encoded_polyline: trace.shape, shape_format: 'polyline6',
    range: true, resample_distance: 30, height_precision: 1 });
  return { shape: trace.shape, edges: trace.edges ?? [], heights: heights.range_height };
}

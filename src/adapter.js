import { performance } from 'node:perf_hooks';
import { decode, legacyPath } from './polyline.js';

class LandDisconnected extends Error {}

export class ApiError extends Error {
  constructor(message, status = 200) { super(message); this.status = status; }
}
export function parseQuery(query, config) {
  const values = {};
  // Preserve the legacy missing-parameter precedence and error envelope/status.
  for (const key of ['lat1', 'lat2', 'lng1', 'lng2']) {
    const raw = query.get(key);
    if (!raw) throw new ApiError(`No \`${key}\` specified`);
  }
  for (const key of ['lat1', 'lat2', 'lng1', 'lng2']) {
    const raw = query.get(key);
    if (!raw.trim() || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())) throw new ApiError(`Invalid \`${key}\``);
    values[key] = Number(raw);
    if (!Number.isFinite(values[key]) || Math.abs(values[key]) > (key.startsWith('lat') ? 90 : 180)) throw new ApiError(`Invalid \`${key}\``);
  }
  const scenario = query.get('scenario') || '1';
  if (!Object.hasOwn(config.scenarios, scenario)) throw new ApiError(`Invalid \`scenario\` ${scenario}`);
  const locations = [1, 2].map(i => ({ lat: values[`lat${i}`], lon: values[`lng${i}`], type: 'break' }));
  for (const p of locations) {
    const b = config.bounds;
    if (p.lon < b.left || p.lon > b.right || p.lat < b.bottom || p.lat > b.top) throw new ApiError('Location outside routing bounds');
  }
  return {
    locations, costing: 'bicycle',
    costing_options: { bicycle: { bicycle_type: 'Hybrid', ...config.scenarios[scenario], ...(config.engine_policy === 'bikesy-distance-v1' ? { use_ferry: 0 } : {}) } },
    units: 'kilometers', language: 'en-US', shape_format: 'polyline6',
  };
}
// `nav=1` adds turn-by-turn data; missing, empty or `0` keeps the legacy response.
export function parseNav(query) {
  const nav = query.get('nav') || '0';
  if (!['0', '1'].includes(nav)) throw new ApiError('Invalid `nav`');
  return nav === '1';
}
const turns = {
  7: 'continue', 8: 'continue', 9: 'slight right', 10: 'right', 11: 'sharp right',
  12: 'sharp right', 13: 'sharp left', 14: 'sharp left', 15: 'left', 16: 'slight left',
  17: 'continue', 18: 'slight right', 19: 'slight left', 20: 'right', 21: 'left',
  22: 'continue', 23: 'slight right', 24: 'slight left', 25: 'continue',
  26: 'continue', 27: 'continue', 28: 'continue', 29: 'continue', 37: 'slight right', 38: 'slight left',
  39: 'continue', 40: 'continue', 41: 'continue', 42: 'continue', 43: 'continue',
};
function initialHeading(points, index) {
  const start = points[index];
  const end = points.slice(index + 1).find(p => p[0] !== start[0] || p[1] !== start[1]);
  if (!end) return 0; // A zero-length route has no meaningful bearing.
  const radians = Math.PI / 180;
  const lat1 = start[0] * radians, lat2 = end[0] * radians;
  const longitude = (end[1] - start[1]) * radians;
  return (Math.atan2(Math.sin(longitude) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(longitude)) / radians + 360) % 360;
}
export function convertTrip(response) {
  const trip = response?.trip;
  if (!trip || trip.status !== 0 || trip.units !== 'kilometers' || !Array.isArray(trip.legs) || trip.legs.length !== 1 ||
      !Number.isFinite(trip.summary?.length) || trip.summary.length < 0) throw new Error('Invalid Valhalla trip');
  const leg = trip.legs[0], points = decode(leg.shape);
  if (!points.length || !Array.isArray(leg.maneuvers)) throw new Error('Invalid Valhalla leg');
  const directions = [];
  for (const m of leg.maneuvers) {
    if ([4, 5, 6].includes(m.type)) continue; // Legacy has no arrival row.
    if (!Number.isInteger(m.begin_shape_index) || !points[m.begin_shape_index]) throw new Error('Invalid maneuver index');
    let turn;
    if ([1, 2, 3].includes(m.type)) {
      // Native JSON in 3.5.1 omits heading; derive it from unsimplified geometry.
      const heading = m.begin_heading ?? initialHeading(points, m.begin_shape_index);
      if (!Number.isFinite(heading) || heading < 0 || heading >= 360) throw new Error('Invalid maneuver heading');
      turn = 'start ' + ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(heading / 45) % 8];
    } else {
      turn = turns[m.type];
      if (!turn) throw new Error('Unsupported bicycle maneuver');
    }
    const name = m.street_names?.[0] || m.begin_street_names?.[0] || 'nameless';
    if (typeof name !== 'string') throw new Error('Invalid street name');
    const [lat, lon] = points[m.begin_shape_index];
    directions.push([turn, name, [lon, lat]]);
  }
  const walking = leg.maneuvers.some(m => m.travel_mode === 'pedestrian' && m.length > 0);
  return { directions, path: legacyPath(points), total_distance: trip.summary.length * 1000, points,
    ...(walking ? { route_warnings: [{ code: 'walk_bicycle', message: 'Walking sections may include stairs; dismount or carry your bicycle where required.' }] } : {}) };
}
function shapeDistance(points) {
  const rad = Math.PI / 180;
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const h = Math.sin((b[0] - a[0]) * rad / 2) ** 2 +
      Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin((b[1] - a[1]) * rad / 2) ** 2;
    distance += 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  return distance;
}
export function validateElevation(profile, sampledPoints, routePoints) {
  if (!Array.isArray(profile) || !profile.length || profile[0]?.[0] !== 0) throw new Error('Invalid elevation profile');
  let previous = -1;
  for (const pair of profile) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite) || pair[0] < previous || pair[1] <= -32768) throw new Error('Missing or invalid elevation data');
    previous = pair[0];
  }
  if (sampledPoints) {
    if (sampledPoints.length !== profile.length || !sampledPoints.length) throw new Error('Incomplete elevation profile');
    for (const index of [0, -1]) {
      if (!sampledPoints.at(index).every((n, axis) => Math.abs(n - routePoints.at(index)[axis]) <= 0.00001)) throw new Error('Elevation endpoints do not match route');
    }
    const distance = shapeDistance(sampledPoints);
    if ((shapeDistance(routePoints) > 1 && (sampledPoints.length < 2 || previous <= 0)) ||
        Math.abs(previous - distance) > Math.max(2, distance * 0.01)) throw new Error('Incomplete elevation range');
  }
  return profile;
}
// The navigation route repeats the native request, so any difference is an engine fault.
// Native length has meter resolution; allow 5 m, or 0.1% on long routes.
export function validateNavRoute(navRoute, { points, total_distance }) {
  const route = navRoute?.routes?.[0];
  if (navRoute?.code !== 'Ok' || !Array.isArray(navRoute.routes) || navRoute.routes.length !== 1 ||
      !Array.isArray(route?.legs) || route.legs.length !== 1 || !Number.isFinite(route.distance)) throw new Error('Invalid navigation route');
  const shape = decode(route.geometry);
  if (!shape.length || Math.abs(route.distance - total_distance) > Math.max(5, total_distance * 0.001) ||
      [0, -1].some(index => !shape.at(index).every((n, axis) => Math.abs(n - points.at(index)[axis]) <= 0.00001))) throw new Error('Navigation route does not match');
  return navRoute;
}
async function boundedJson(response, signal) {
  const limit = 8 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing upstream body');
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Upstream response too large');
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Upstream response too large');
      chunks.push(Buffer.from(value));
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
export function createAdapter(config, fetchImpl = fetch) {
  let active = 0;
  const waiting = [];
  const maxQueued = config.maxQueued ?? 16;
  function release() {
    active--;
    // Reserve each slot before waking its waiter so new arrivals cannot jump the queue.
    while (active < config.maxConcurrent && waiting.length) {
      const next = waiting.shift();
      next.signal.removeEventListener('abort', next.cancel);
      if (next.signal.aborted) { next.reject(next.signal.reason); continue; }
      active++;
      next.resolve(release);
    }
  }
  function acquire(signal) {
    signal.throwIfAborted();
    if (active < config.maxConcurrent) { active++; return Promise.resolve(release); }
    if (waiting.length >= maxQueued) throw new ApiError('Routing service busy', 503);
    return new Promise((resolve, reject) => {
      const next = { signal, resolve, reject, cancel: () => {
        const index = waiting.indexOf(next);
        if (index !== -1) waiting.splice(index, 1);
        reject(signal.reason);
      } };
      waiting.push(next);
      signal.addEventListener('abort', next.cancel, { once: true });
    });
  }
  async function upstream(action, body, signal) {
    signal.throwIfAborted();
    const result = await fetchImpl(new URL(action, config.valhallaUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const data = await boundedJson(result, signal);
    if (action === 'route' && data.error_code === 470 && data.error === 'Bikesy certified land disconnection' && config.engine_policy === 'bikesy-distance-v1') throw new LandDisconnected();
    if (action === 'route' && [442, 443, 171].includes(data.error_code)) throw new ApiError('No route found');
    if (!result.ok || data.error_code || data.error) throw new Error('Valhalla request failed');
    return data;
  }
  return async function route(query, clientSignal) {
    const request = parseQuery(query, config), nav = parseNav(query);
    const timeout = new AbortController(), failed = new AbortController();
    const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
    timer.unref();
    const signal = AbortSignal.any([timeout.signal, failed.signal, ...(clientSignal ? [clientSignal] : [])]);
    const deadline = performance.now() + config.timeoutMs;
    const checkDeadline = () => {
      if (performance.now() >= deadline) timeout.abort();
      signal.throwIfAborted();
    };
    let releaseSlot;
    try {
      // The existing deadline covers both queue wait and route/elevation work.
      releaseSlot = await acquire(signal);
      checkDeadline();
      const start = performance.now();
      let response, routeRequest = request;
      try {
        response = await upstream('route', request, signal);
        if (config.engine_policy === 'bikesy-distance-v1' && response.trip?.summary?.has_ferry) throw new Error('Land-only policy violated');
      } catch (error) {
        if (!(error instanceof LandDisconnected)) throw error;
        checkDeadline();
        // Retry only on the patched engine's conservative connectivity proof.
        // Generic no-path, snapping, timeout, limits and cancellation never reach this branch.
        routeRequest = { ...request, costing_options: { bicycle: {
          ...request.costing_options.bicycle, use_ferry: 0.5,
        } } };
        response = await upstream('route', routeRequest, signal);
      }
      const routed = performance.now();
      checkDeadline();
      const converted = convertTrip(response);
      checkDeadline();
      // Navigation repeats the request that produced this route, alongside elevation in the
      // same slot. The first failure cancels the other call, so neither outlives the slot.
      let failure;
      const settle = work => work.catch(error => { failure ??= error; failed.abort(); });
      const [heights, navRoute] = await Promise.all([
        settle(upstream('height', {
          encoded_polyline: response.trip.legs[0].shape, shape_format: 'polyline6',
          range: true, height_precision: 2,
          resample_distance: Math.max(10, Math.ceil(converted.total_distance / 299)),
        }, signal)),
        // Both regions are in the US, so prompts are spoken in miles and feet; OSRM
        // distances stay in meters.
        nav && settle(upstream('route', { ...routeRequest, units: 'miles', format: 'osrm',
          banner_instructions: true, voice_instructions: true }, signal)),
      ]);
      if (failure) throw failure;
      const elevation_profile = validateElevation(heights.range_height, decode(heights.encoded_polyline), converted.points);
      if (nav) validateNavRoute(navRoute, converted);
      checkDeadline();
      const { points, ...payload } = converted;
      return { ...payload, elevation_profile, stats: {
        route_find_time: (routed - start) / 1000,
        route_desc_time: (performance.now() - routed) / 1000,
        endpoint_find_time: 0, // Valhalla includes snapping in the route call.
      }, ...(nav ? { nav_route: navRoute, points } : {}) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (clientSignal?.aborted) throw new ApiError('Request cancelled', 499);
      throw new ApiError(timeout.signal.aborted ? 'Routing service timed out' : 'Routing service unavailable or incomplete elevation data', timeout.signal.aborted ? 504 : 502);
    } finally {
      clearTimeout(timer);
      releaseSlot?.();
    }
  };
}

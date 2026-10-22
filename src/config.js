import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REGION_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
export const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
// Every key a region config may contain; see docs/REGIONS.md#region-config-reference.
const CONFIG_KEYS = ['region', 'bounds', 'bounds_inset', 'admin_states', 'scenarios', 'engine_policy', 'readiness', 'hill_cost', 'paved_surface_defaults'];
const SIDES = ['left', 'bottom', 'right', 'top'];

// Region configs are config/*.json files with a `region` key matching the file name.
// Engine settings (valhalla-*.json) have no `region` and are not listed.
export function listRegionConfigs(directory = new URL('../config/', import.meta.url)) {
  const root = (directory instanceof URL ? fileURLToPath(directory) : String(directory)).replace(/\/?$/, '/');
  const regions = [];
  for (const name of readdirSync(root).filter(name => name.endsWith('.json')).sort()) {
    const path = root + name;
    const config = JSON.parse(readFileSync(path));
    if (!Object.hasOwn(config, 'region')) continue;
    if (config.region !== name.slice(0, -'.json'.length)) {
      throw new Error(`${path}: region "${config.region}" must match the file name`);
    }
    regions.push({ region: config.region, path, config });
  }
  return regions;
}

export function resolveConfigPath(env = process.env) {
  if (env.BIKESY_CONFIG) {
    return env.BIKESY_CONFIG;
  }
  return new URL('../config/sf.json', import.meta.url);
}
// Configured bounds describe the data extraction; the API uses the inset area.
export function deriveBounds(config) {
  const outer = config.bounds;
  const inset = config.bounds_inset ?? 0;
  const result = {};
  for (const key of ['left', 'bottom', 'right', 'top']) {
    const margin = typeof inset === 'number' ? inset : inset?.[key];
    if (!Number.isFinite(outer?.[key]) || !Number.isFinite(margin) || margin < 0) {
      throw new Error('Bounds and nonnegative bounds_inset must be finite degrees');
    }
    const direction = ['left', 'bottom'].includes(key) ? 1 : -1;
    result[key] = Number((outer[key] + direction * margin).toFixed(6));
  }
  if (result.left >= result.right || result.bottom >= result.top) {
    throw new Error('bounds_inset leaves no service area');
  }
  return result;
}

export const BICYCLE_TYPES = ['Road', 'Cross', 'Hybrid', 'Mountain'];
export const SURFACE_PENALTY_KEYS = ['unpaved_penalty', 'paved_penalty'];
export const MAX_SURFACE_PENALTY = 10;

// Surface-related passthrough keys. Valhalla silently replaces out-of-range values with
// defaults, so reject them here. See docs/REGIONS.md#surface-preference.
function validateSurfaceOptions(id, options) {
  if (Object.hasOwn(options, 'bicycle_type') && !BICYCLE_TYPES.includes(options.bicycle_type)) {
    throw new Error(`Invalid bicycle_type in scenario ${id}; use one of ${BICYCLE_TYPES.join(', ')}`);
  }
  const ranged = { avoid_bad_surfaces: 1, ...Object.fromEntries(SURFACE_PENALTY_KEYS.map(key => [key, MAX_SURFACE_PENALTY])) };
  for (const [key, max] of Object.entries(ranged)) {
    if (Object.hasOwn(options, key) && (!Number.isFinite(options[key]) || options[key] < 0 || options[key] > max)) {
      throw new Error(`Invalid ${key} in scenario ${id}; use a number from 0 to ${max}`);
    }
  }
  if (!SURFACE_PENALTY_KEYS.some(key => Object.hasOwn(options, key))) return;
  // With either penalty the engine drops the stock avoid_bad_surfaces cost term; only its
  // value 1 still matters (it excludes surfaces worse than the bicycle type allows).
  if (options.avoid_bad_surfaces > 0 && options.avoid_bad_surfaces < 1) {
    throw new Error(`Invalid avoid_bad_surfaces in scenario ${id}; it has no cost effect with unpaved_penalty/paved_penalty, so omit it or use 0 or 1`);
  }
  // Valhalla's explicit shortest means distance only; Bikesy's implicit shortest mode
  // (use_roads 1 and use_hills 1) keeps surface penalties.
  if (Object.hasOwn(options, 'shortest') && options.shortest !== false) {
    throw new Error(`Invalid shortest in scenario ${id}; it cannot be combined with unpaved_penalty/paved_penalty`);
  }
}

// Busy-road preference (docs/REGIONS.md#busy-roads): busy_penalty adds to the edge factor of
// fast trunk, primary and secondary roads, busy_town_penalty does so weighted by how built-up
// the road's surroundings are, and busy_lane_relief is the share of the bike lane or shoulder
// relief those roads keep. They need the engine patch; without them costs are stock.
export const BUSY_ROAD_KEYS = ['busy_penalty', 'busy_town_penalty', 'busy_lane_relief'];
function validateBusyRoadOptions(id, options) {
  for (const [key, max] of [['busy_penalty', 10], ['busy_town_penalty', 10], ['busy_lane_relief', 1]]) {
    if (Object.hasOwn(options, key) && (!Number.isFinite(options[key]) || options[key] < 0 || options[key] > max)) {
      throw new Error(`Invalid ${key} in scenario ${id}; use a number from 0 to ${max}`);
    }
  }
}

// Validate a parsed region config and return its runtime settings. Errors name the
// offending key so a new region can be corrected without reading this code.
export function validateRegionConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Region config must be a JSON object');
  }
  const unknown = Object.keys(config).filter(key => !CONFIG_KEYS.includes(key));
  if (unknown.length) {
    throw new Error(`Unknown config key(s) ${unknown.join(', ')}; allowed: ${CONFIG_KEYS.join(', ')}`);
  }
  if (Object.hasOwn(config, 'hill_cost')) {
    // Build-time only: shapes the region's bikesy-policy.bin (docs/HILL-COST.md); routing never reads it.
    const hill = config.hill_cost;
    if (!hill || typeof hill !== 'object' || Array.isArray(hill) ||
        Object.keys(hill).some(key => key !== 'exponent') ||
        !(Number.isFinite(hill.exponent) && hill.exponent >= 1 && hill.exponent <= 3)) {
      throw new Error('Invalid hill_cost; use {"exponent": N} with N from 1 to 3 (3 is the default)');
    }
  }
  if (Object.hasOwn(config, 'paved_surface_defaults') && typeof config.paved_surface_defaults !== 'boolean') {
    // Build-time only: import profile option (scripts/bicycle-surface-defaults.lua); routing never reads it.
    throw new Error('Invalid paved_surface_defaults; use true or false');
  }
  if (config.engine_policy !== 'bikesy-distance-v1') {
    throw new Error('Invalid engine policy; engine_policy must be "bikesy-distance-v1"');
  }
  const region = config.region;
  if (typeof region !== 'string' || !REGION_PATTERN.test(region)) {
    throw new Error('Invalid configured region; use a lowercase slug of at most 48 characters');
  }
  const build = config.bounds;
  if (!build || !SIDES.every(key => Number.isFinite(build[key])) ||
      build.left < -180 || build.right > 180 || build.bottom < -90 || build.top > 90 ||
      build.left >= build.right || build.bottom >= build.top) {
    throw new Error('Invalid configured bounds; set finite left < right longitudes and bottom < top latitudes');
  }
  const b = deriveBounds(config);
  if (build.left > b.left || build.right < b.right || build.bottom > b.bottom || build.top < b.top) {
    throw new Error('Build bounds must contain the service bounds');
  }
  if (!Array.isArray(config.admin_states) || !config.admin_states.length ||
      new Set(config.admin_states).size !== config.admin_states.length ||
      config.admin_states.some(state => !US_STATES.includes(state))) {
    throw new Error('Invalid admin_states; list each covered US state once by postal code, e.g. ["CA", "NV"]');
  }
  if (!config.scenarios || typeof config.scenarios !== 'object' || !Object.hasOwn(config.scenarios, '1')) {
    throw new Error('Missing default scenario "1"');
  }
  for (const [id, options] of Object.entries(config.scenarios)) {
    if (!/^[1-9][0-9]*$/.test(id) || !options || typeof options !== 'object') {
      throw new Error(`Invalid scenario ${id}; use positive integer keys with option objects`);
    }
    for (const key of ['use_hills', 'use_roads']) {
      if (!Number.isFinite(options[key]) || options[key] < 0 || options[key] > 1) {
        throw new Error(`Invalid ${key} in scenario ${id}; use a number from 0 to 1`);
      }
    }
    if (Object.hasOwn(options, 'maneuver_penalty') && (!Number.isFinite(options.maneuver_penalty) || options.maneuver_penalty < 0)) {
      throw new Error(`Invalid maneuver_penalty in scenario ${id}; use a nonnegative number`);
    }
    validateSurfaceOptions(id, options);
    validateBusyRoadOptions(id, options);
  }
  const runtimeConfig = { ...config, bounds: b, dataBounds: config.bounds, region };
  readinessRequest(runtimeConfig);
  return runtimeConfig;
}

export function loadConfig(env = process.env) {
  const path = resolveConfigPath(env);
  let runtimeConfig;
  try {
    runtimeConfig = validateRegionConfig(JSON.parse(readFileSync(path)));
  } catch (error) {
    throw new Error(`${path instanceof URL ? fileURLToPath(path) : path}: ${error.message}`, { cause: error });
  }
  const valhallaUrl = env.VALHALLA_URL || 'http://127.0.0.1:8002/';
  const url = new URL(valhallaUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid VALHALLA_URL');
  }
  const timeoutMs = Number(env.VALHALLA_TIMEOUT_MS || 15000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new Error('Invalid VALHALLA_TIMEOUT_MS');
  }
  const maxConcurrent = Number(env.MAX_CONCURRENT_ROUTES || 16);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 256) {
    throw new Error('Invalid MAX_CONCURRENT_ROUTES');
  }
  const maxQueued = Number(env.MAX_QUEUED_ROUTES ?? 16);
  if (!Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 256) {
    throw new Error('Invalid MAX_QUEUED_ROUTES');
  }
  return { ...runtimeConfig, maxConcurrent, maxQueued, valhallaUrl: valhallaUrl.replace(/\/?$/, '/'), timeoutMs };
}

export function readinessRequest(config) {
  const { locations, scenario } = config.readiness || {};
  if (!Array.isArray(locations) || locations.length !== 2) {
    throw new Error('Readiness requires two locations');
  }
  if (!Object.hasOwn(config.scenarios, scenario)) {
    throw new Error('Readiness scenario is not configured');
  }
  for (const { lat, lon } of locations) {
    const b = config.bounds;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < b.bottom || lat > b.top || lon < b.left || lon > b.right) {
      throw new Error('Readiness location outside routing bounds');
    }
  }
  return {
    locations, costing: 'bicycle', shape_format: 'polyline6',
    costing_options: { bicycle: { bicycle_type: 'Hybrid', ...config.scenarios[scenario], use_ferry: 0 } },
  };
}

export function verifyRegionData(config, lock) {
  if ((lock.region || 'sf') !== config.region) {
    throw new Error('Routing data region differs from application region');
  }
  if (lock.region && !lock.build_config) {
    throw new Error('Data release is missing build settings');
  }
  if (lock.build_config) {
    const expected = lock.build_config;
    if (JSON.stringify(expected.admin_states) !== JSON.stringify(config.admin_states) ||
        ['left', 'bottom', 'right', 'top'].some(key => expected.bounds?.[key] !== config.bounds?.[key])) {
      throw new Error('Build settings differ from data release');
    }
  }
}

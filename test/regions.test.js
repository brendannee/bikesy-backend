import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, resolveConfigPath, readinessRequest, deriveBounds, listRegionConfigs, validateRegionConfig } from '../src/config.js';
import { checkRegion, demTiles } from '../scripts/check-region.mjs';
import { parseQuery } from '../src/adapter.js';
import { verifyStartupData } from '../src/verify-startup.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('explicit US region config supports a new slug while rejecting unsafe identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'bikesy-custom-region-'));
  try {
    const config = JSON.parse(readFileSync(new URL('../config/sf.json', import.meta.url)));
    config.region = 'custom-us'; config.admin_states = ['OR', 'WA'];
    const file = join(root, 'region.json');
    writeFileSync(file, JSON.stringify(config));
    assert.equal(loadConfig({ BIKESY_CONFIG: file }).region, 'custom-us');
    for (const region of ['../sf', 'SF', '', 'x'.repeat(49)]) {
      writeFileSync(file, JSON.stringify({ ...config, region }));
      assert.throws(() => loadConfig({ BIKESY_CONFIG: file }), /region/);
    }
    writeFileSync(file, JSON.stringify({ ...config, admin_states: ['ZZ'] }));
    assert.throws(() => loadConfig({ BIKESY_CONFIG: file }), /admin_states/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SF remains default; explicit config takes precedence; every region config probes a valid scenario', () => {
  assert.equal(loadConfig({}).region, 'sf');
  assert.match(String(resolveConfigPath({ BIKESY_CONFIG: 'config/tahoe.json' })), /tahoe.json$/);
  assert.match(String(resolveConfigPath({ BIKESY_CONFIG: 'custom.json' })), /custom.json$/);
  for (const { region } of listRegionConfigs()) {
    const config = loadConfig({ BIKESY_CONFIG: `config/${region}.json` });
    const probe = readinessRequest(config);
    const [a, b] = probe.locations;
    const query = new URLSearchParams({ lat1: a.lat, lng1: a.lon, lat2: b.lat, lng2: b.lon, scenario: config.readiness.scenario });
    assert.doesNotThrow(() => parseQuery(query, config));
    assert.equal(probe.costing_options.bicycle.use_roads, config.scenarios[config.readiness.scenario].use_roads);
    assert.equal(probe.costing_options.bicycle.use_ferry, 0);
    assert.ok(config.dataBounds.left <= config.bounds.left);
    assert.ok(config.dataBounds.right >= config.bounds.right);
    assert.ok(config.dataBounds.bottom <= config.bounds.bottom);
    assert.ok(config.dataBounds.top >= config.bounds.top);
  }
  assert.throws(() => readinessRequest({ ...loadConfig({}), readiness: { locations: loadConfig({}).readiness.locations, scenario: '10' } }), /scenario/);
  const tahoe = loadConfig({ BIKESY_CONFIG: 'config/tahoe.json' });
  assert.throws(() => readinessRequest({ ...tahoe, readiness: loadConfig({}).readiness }), /scenario/);
  const query = new URLSearchParams('lat1=39.1&lng1=-120.39&lat2=39.11&lng2=-120.38&scenario=1');
  assert.doesNotThrow(() => parseQuery(query, tahoe));
});

test('startup binds region and build settings to data, rejecting SF data for Tahoe in both modes', () => {
  const root = mkdtempSync(join(tmpdir(), 'bikesy-region-'));
  try {
    mkdirSync(join(root, 'data'));
    mkdirSync(join(root, 'graph'));
    mkdirSync(join(root, 'config'));
    const config = readFileSync(new URL('../config/tahoe.json', import.meta.url));
    const parsed = JSON.parse(config);
    writeFileSync(join(root, 'config/tahoe.json'), config);
    const files = {};
    for (const name of ['valhalla.json', 'admin.sqlite', 'bikesy-policy.bin', 'bikesy-stairs.txt']) {
      writeFileSync(join(root, 'data', name), 'fixture');
      files[name] = hash('fixture');
    }
    const lock = {
      region: 'tahoe', build_config: { bounds: parsed.bounds, admin_states: parsed.admin_states }, policy: 'bikesy-distance-v1',
      graph_access_policy: 'bikesy-access-v1', graph_import_policy: 'bikesy-import-v2',
      stair_policy: 'counted-stairs-v1', engine_sha256: 'fixture-engine', files,
    };
    function save(region) {
      lock.region = region;
      const manifest = JSON.stringify(lock);
      writeFileSync(join(root, 'data/engine-policy.json'), manifest);
      writeFileSync(join(root, 'graph/deployed-runtime.lock.json'), manifest);
      writeFileSync(join(root, 'release.json'), JSON.stringify({
        region: 'tahoe', data_lock_sha256: hash(manifest), engine_sha256: lock.engine_sha256,
        runtime_files: { 'config/tahoe.json': hash(config) },
      }));
    }
    const options = { appRoot: root, dataRoot: join(root, 'data'), configPath: join(root, 'config/tahoe.json'), region: 'tahoe', policy: lock.policy };
    save('tahoe');
    for (const mode of ['light', 'full']) {
      assert.equal(verifyStartupData({ ...options, mode }).checkedDataFiles, 4);
    }
    save('sf');
    for (const mode of ['light', 'full']) {
      assert.throws(() => verifyStartupData({ ...options, mode }), /region differs/);
    }
    save('tahoe');
    parsed.admin_states = ['CA'];
    writeFileSync(join(root, 'config/tahoe.json'), JSON.stringify(parsed));
    assert.throws(() => verifyStartupData(options), /Build settings differ/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('one configured area derives unchanged service bounds and supports uniform insets', () => {
  assert.deepEqual(loadConfig({ BIKESY_CONFIG: 'config/sf.json' }).bounds,
    { left: -123.029, bottom: 37.3064, right: -121.637, top: 38.317 });
  assert.deepEqual(loadConfig({ BIKESY_CONFIG: 'config/tahoe.json' }).bounds,
    { left: -120.399814, bottom: 38.750276, right: -119.659482, top: 39.368232 });
  const bounds = { left: -121, bottom: 38, right: -119, top: 40 };
  assert.deepEqual(deriveBounds({ bounds, bounds_inset: 0.1 }),
    { left: -120.9, bottom: 38.1, right: -119.1, top: 39.9 });
  assert.deepEqual(deriveBounds({ bounds }), bounds);
  assert.throws(() => deriveBounds({ bounds, bounds_inset: -1 }), /nonnegative/);
  assert.throws(() => deriveBounds({ bounds, bounds_inset: 1 }), /no service area/);
});

test('local env file selects Tahoe and an existing environment config takes precedence', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const directory = mkdtempSync(join(tmpdir(), 'bikesy-env-'));
  try {
    const envFile = join(directory, '.env');
    writeFileSync(envFile, `BIKESY_CONFIG=${fileURLToPath(new URL('../config/tahoe.json', import.meta.url))}\n`);
    const env = { ...process.env };
    delete env.BIKESY_CONFIG;
    const script = `import { loadConfig } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}; console.log(loadConfig().region);`;
    const args = [`--env-file-if-exists=${envFile}`, '--input-type=module', '-e', script];
    assert.equal(execFileSync(process.execPath, args, { env, encoding: 'utf8' }).trim(), 'tahoe');
    env.BIKESY_CONFIG = fileURLToPath(new URL('../config/sf.json', import.meta.url));
    assert.equal(execFileSync(process.execPath, args, { env, encoding: 'utf8' }).trim(), 'sf');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('region discovery lists config/REGION.json files and skips engine settings', () => {
  const regions = listRegionConfigs().map(({ region }) => region);
  assert.ok(regions.includes('sf') && regions.includes('tahoe'));
  assert.ok(!regions.some(region => region.startsWith('valhalla')));
  const root = mkdtempSync(join(tmpdir(), 'bikesy-discovery-'));
  try {
    writeFileSync(join(root, 'valhalla-build.json'), '{}');
    writeFileSync(join(root, 'reno.json'), JSON.stringify({ region: 'reno' }));
    assert.deepEqual(listRegionConfigs(root).map(({ region }) => region), ['reno']);
    writeFileSync(join(root, 'carson.json'), JSON.stringify({ region: 'reno' }));
    assert.throws(() => listRegionConfigs(root), /carson\.json: region "reno" must match the file name/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every region config passes the region checker and is locked in release.json', () => {
  for (const entry of listRegionConfigs()) {
    const report = checkRegion(entry);
    assert.deepEqual(report.errors, [], entry.region);
    assert.ok(!report.warnings.some(warning => /lock-source/.test(warning)), `${entry.region}: run node scripts/lock-source.mjs`);
    assert.ok(report.dem_tiles.length > 0);
  }
});

test('region checker rejects smoke trips outside the service area', () => {
  const [sf] = listRegionConfigs().filter(({ region }) => region === 'sf');
  const root = mkdtempSync(join(tmpdir(), 'bikesy-check-'));
  try {
    mkdirSync(join(root, 'test/fixtures'), { recursive: true });
    writeFileSync(join(root, 'release.json'), '{}');
    writeFileSync(join(root, 'test/fixtures/smoke-regions.json'), JSON.stringify({
      sf: [{ name: 'Tahoe', locations: [{ lat: 39.1667, lon: -120.1439 }, { lat: 39.1725, lon: -120.1385 }] }],
    }));
    const report = checkRegion(sf, root);
    assert.match(report.errors.join(), /Smoke trip "Tahoe"/);
    assert.match(report.warnings.join(), /--review/);
    assert.match(report.warnings.join(), /lock-source/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('config validation names the offending key and file', () => {
  const base = JSON.parse(readFileSync(new URL('../config/tahoe.json', import.meta.url)));
  assert.equal(validateRegionConfig(base).region, 'tahoe');
  const cases = [
    [{ ...base, bound_inset: 0.1 }, /Unknown config key\(s\) bound_inset/],
    [{ ...base, engine_policy: undefined }, /engine_policy/],
    [{ ...base, bounds: { ...base.bounds, left: base.bounds.right } }, /Invalid configured bounds/],
    [{ ...base, scenarios: { ...base.scenarios, flat: base.scenarios['1'] } }, /Invalid scenario flat/],
    [{ ...base, scenarios: { ...base.scenarios, 2: { use_hills: 2, use_roads: 0 } } }, /Invalid use_hills in scenario 2/],
    [{ ...base, scenarios: { ...base.scenarios, 2: { use_hills: 0, use_roads: 0, maneuver_penalty: -1 } } }, /maneuver_penalty in scenario 2/],
    [{ ...base, readiness: { ...base.readiness, scenario: '7' } }, /Readiness scenario/],
  ];
  for (const [config, message] of cases) assert.throws(() => validateRegionConfig(JSON.parse(JSON.stringify(config))), message);
  const root = mkdtempSync(join(tmpdir(), 'bikesy-invalid-'));
  try {
    const file = join(root, 'broken.json');
    writeFileSync(file, JSON.stringify({ ...base, admin_states: ['ON'] }));
    assert.throws(() => loadConfig({ BIKESY_CONFIG: file }), error => error.message.startsWith(file) && /admin_states/.test(error.message));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('surface passthrough keys are validated and reach Valhalla unchanged', () => {
  const base = JSON.parse(readFileSync(new URL('../config/tahoe.json', import.meta.url)));
  const withScenario = options => ({ ...base, scenarios: { ...base.scenarios, 9: { use_hills: 0.5, use_roads: 0, ...options } } });
  const valid = [
    { bicycle_type: 'Road' }, { bicycle_type: 'Mountain', avoid_bad_surfaces: 1 }, { avoid_bad_surfaces: 0.5 },
    { unpaved_penalty: 2.5 }, { paved_penalty: 1 }, { unpaved_penalty: 0, paved_penalty: 10 },
    { unpaved_penalty: 3, avoid_bad_surfaces: 1 }, { unpaved_penalty: 3, avoid_bad_surfaces: 0 },
    { unpaved_penalty: 3, use_roads: 1, use_hills: 1 }, { paved_penalty: 1, shortest: false },
  ];
  for (const options of valid) assert.doesNotThrow(() => validateRegionConfig(withScenario(options)), JSON.stringify(options));
  const invalid = [
    [{ bicycle_type: 'hybrid' }, /Invalid bicycle_type in scenario 9; use one of Road, Cross, Hybrid, Mountain/],
    [{ bicycle_type: 1 }, /bicycle_type in scenario 9/],
    [{ avoid_bad_surfaces: 1.5 }, /Invalid avoid_bad_surfaces in scenario 9; use a number from 0 to 1/],
    [{ avoid_bad_surfaces: '0.5' }, /avoid_bad_surfaces in scenario 9/],
    [{ unpaved_penalty: -1 }, /Invalid unpaved_penalty in scenario 9; use a number from 0 to 10/],
    [{ paved_penalty: 11 }, /Invalid paved_penalty in scenario 9/],
    [{ paved_penalty: null }, /paved_penalty in scenario 9/],
    [{ unpaved_penalty: 2, avoid_bad_surfaces: 0.25 }, /avoid_bad_surfaces in scenario 9; it has no cost effect/],
    [{ unpaved_penalty: 2, shortest: true }, /Invalid shortest in scenario 9/],
  ];
  for (const [options, message] of invalid) assert.throws(() => validateRegionConfig(withScenario(options)), message);
  // The adapter forwards scenario keys as-is; a scenario bicycle_type overrides the Hybrid default.
  const surface = withScenario({ bicycle_type: 'Cross', unpaved_penalty: 2.5, paved_penalty: 0 });
  const config = validateRegionConfig({ ...surface, scenarios: { ...surface.scenarios, 8: { use_hills: 0.5, use_roads: 0 } } });
  const query = new URLSearchParams('lat1=39.1&lng1=-120.39&lat2=39.11&lng2=-120.38&scenario=9');
  assert.deepEqual(parseQuery(query, config).costing_options.bicycle, {
    bicycle_type: 'Cross', use_hills: 0.5, use_roads: 0, unpaved_penalty: 2.5, paved_penalty: 0, use_ferry: 0,
  });
  assert.equal(parseQuery(new URLSearchParams('lat1=39.1&lng1=-120.39&lat2=39.11&lng2=-120.38&scenario=8'), config)
    .costing_options.bicycle.unpaved_penalty, undefined);
});

test('build-time options are validated and optional', () => {
  const tahoe = JSON.parse(readFileSync(new URL('../config/tahoe.json', import.meta.url)));
  assert.doesNotThrow(() => validateRegionConfig(tahoe));
  const { hill_cost, paved_surface_defaults, ...plain } = tahoe;
  assert.doesNotThrow(() => validateRegionConfig(plain));
  for (const bad of [{ exponent: 0.5 }, { exponent: 4 }, { exponent: '2' }, {}, { exponent: 2, band: 35 }, 2, null]) {
    assert.throws(() => validateRegionConfig({ ...plain, hill_cost: bad }), /Invalid hill_cost/, JSON.stringify(bad));
  }
  assert.throws(() => validateRegionConfig({ ...plain, paved_surface_defaults: 'yes' }), /Invalid paved_surface_defaults/);
  assert.doesNotThrow(() => validateRegionConfig({ ...plain, hill_cost: { exponent: 3 }, paved_surface_defaults: false }));
});

test('Tahoe sets the build-time options and SF omits them', () => {
  const tahoe = JSON.parse(readFileSync(new URL('../config/tahoe.json', import.meta.url)));
  const sf = JSON.parse(readFileSync(new URL('../config/sf.json', import.meta.url)));
  assert.deepEqual(tahoe.hill_cost, { exponent: 2 });
  assert.equal(tahoe.paved_surface_defaults, true);
  assert.equal(Object.hasOwn(sf, 'hill_cost'), false, 'SF keeps the original cubic hill cost');
  assert.equal(Object.hasOwn(sf, 'paved_surface_defaults'), false, 'SF keeps the stock surface defaults');
});

test('DEM tile names cover the build bounds in every hemisphere', () => {
  assert.deepEqual(demTiles({ left: -120.5, bottom: 38.65, right: -119.55, top: 39.5 }),
    ['elevation/N38/N38W121.hgt', 'elevation/N38/N38W120.hgt', 'elevation/N39/N39W121.hgt', 'elevation/N39/N39W120.hgt']);
  assert.deepEqual(demTiles({ left: 7.2, bottom: -0.5, right: 7.4, top: 0.2 }),
    ['elevation/S01/S01E007.hgt', 'elevation/N00/N00E007.hgt']);
});

// Tunings name a set of modes (facets + Valhalla bicycle costing options), an optional
// engine override and a routing source. See bench/README.md#tunings for the format.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { BENCH_DIR } from './catalog.mjs';

export function tuningDir(region) { return resolve(BENCH_DIR, 'tunings', region); }

// Facets for a config/<region>.json scenario. Production has no surface preference,
// so config scenarios are all "mixed". A tuning's `facets` map overrides these.
export function configFacets(id, options) {
  const level = (value, low, high, names) => value <= low ? names[0] : value >= high ? names[2] : names[1];
  return {
    scenario: id,
    traffic: level(options.use_roads ?? 0.5, 0.25, 0.75, ['quiet', 'balanced', 'busy']),
    hills: level(options.use_hills ?? 0.5, 0.25, 0.9, ['flat', 'balanced', 'tolerant']),
    surface: 'mixed',
  };
}

const clone = value => structuredClone(value);
const expandHome = path => path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;

// Set a dotted path such as "options.use_hills" or "engine.policy" on a tuning spec.
export function setPath(target, path, value) {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) node = node[key] ??= {};
  node[keys.at(-1)] = value;
  return target;
}

// Expand a sweep's grid into one tuning spec per combination. Grid values are arrays
// (labelled by value) or objects (label -> value), e.g. policy files by short name.
export function expandSweep(sweep, sweepName) {
  const { grid = {}, ...spec } = sweep;
  let combos = [{ spec: clone(spec), labels: [] }];
  for (const [path, values] of Object.entries(grid)) {
    const entries = Array.isArray(values) ? values.map(v => [typeof v === 'object' ? JSON.stringify(v) : String(v), v]) : Object.entries(values);
    if (!entries.length) throw new Error(`Sweep ${sweepName}: grid ${path} is empty`);
    combos = combos.flatMap(({ spec: s, labels }) => entries.map(([label, value]) => ({
      spec: setPath(clone(s), path, clone(value)), labels: [...labels, `${path.split('.').at(-1)}=${label}`],
    })));
  }
  return combos.map(({ spec: s, labels }) => ({ ...s, name: `${sweepName}/${labels.join(',')}`, sweep: sweepName }));
}

function readSpec(path) {
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  spec.file = path;
  // Engine files are relative to the tuning file; "~/" means the home directory.
  for (const key of ['policy']) {
    if (typeof spec.engine?.[key] === 'string') spec.engine[key] = resolve(dirname(path), expandHome(spec.engine[key]));
  }
  if (spec.grid?.['engine.policy']) {
    const g = spec.grid['engine.policy'];
    const fix = p => typeof p === 'string' ? resolve(dirname(path), expandHome(p)) : p;
    spec.grid['engine.policy'] = Array.isArray(g) ? g.map(fix) : Object.fromEntries(Object.entries(g).map(([k, v]) => [k, fix(v)]));
  }
  return spec;
}

export function listTunings(region) {
  const dir = tuningDir(region);
  const names = existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')).map(n => n.replace(/(\.sweep)?\.json$/, '')) : [];
  return [...new Set(['config', ...names])].sort();
}

// Resolve a tuning (or sweep) by name, or by path to a .json file. Returns an array
// because a sweep expands to many tunings.
export function loadTunings(region, regionConfig, name) {
  const dir = tuningDir(region);
  const file = name.endsWith('.json') ? resolve(name) : resolve(dir, `${name}.json`);
  const sweepFile = name.endsWith('.json') ? null : resolve(dir, `${name}.sweep.json`);
  if (sweepFile && existsSync(sweepFile)) {
    return expandSweep(readSpec(sweepFile), name).map(spec => resolveSpec(region, regionConfig, spec));
  }
  if (existsSync(file)) {
    const spec = readSpec(file);
    if (spec.grid) return expandSweep(spec, spec.name ?? name.replace(/^.*\//, '').replace(/(\.sweep)?\.json$/, '')).map(s => resolveSpec(region, regionConfig, s));
    return [resolveSpec(region, regionConfig, { name: name.replace(/^.*\//, '').replace(/\.json$/, ''), ...spec })];
  }
  if (name === 'config') return [resolveSpec(region, regionConfig, { name: 'config', modes_from_config: true,
    description: `Production scenarios from config/${region}.json` })];
  throw new Error(`Unknown tuning ${name} for ${region}; available: ${listTunings(region).join(', ')}`);
}

// Turn a spec (possibly with `base`) into { name, description, source, engine, modes }.
export function resolveSpec(region, regionConfig, spec, depth = 0) {
  if (depth > 8) throw new Error(`Tuning ${spec.name}: base chain too deep`);
  let modes = {};
  let engine = {}, source = { type: 'valhalla' };
  if (spec.base) {
    const [base] = loadTunings(region, regionConfig, spec.base);
    for (const mode of base.modes) modes[mode.name] = clone({ facets: mode.facets, options: mode.options, scenario: mode.scenario });
    engine = clone(base.engine);
    source = clone(base.source);
  }
  if (spec.source) source = clone(spec.source);
  if (spec.engine) engine = { ...engine, ...clone(spec.engine) };
  if (spec.modes_from_config) {
    for (const [id, options] of Object.entries(regionConfig.scenarios)) {
      modes[id] = source.type === 'api' ? { facets: configFacets(id, options), scenario: id } : { facets: configFacets(id, options), options: clone(options) };
    }
  }
  for (const [id, facets] of Object.entries(spec.facets ?? {})) {
    if (modes[id]) modes[id].facets = { ...modes[id].facets, ...facets };
  }
  for (const [id, mode] of Object.entries(spec.modes ?? {})) {
    if (mode === null) { delete modes[id]; continue; }
    const previous = modes[id] ?? {};
    modes[id] = { ...previous, ...clone(mode),
      facets: { ...previous.facets, ...mode.facets },
      ...(mode.options || previous.options ? { options: { ...previous.options, ...mode.options } } : {}) };
  }
  const list = Object.entries(modes).map(([id, mode]) => {
    const result = { name: id, facets: { ...mode.facets, mode: id } };
    if (source.type === 'api') {
      if (!mode.scenario) throw new Error(`Tuning ${spec.name}: API mode ${id} needs a scenario`);
      result.scenario = String(mode.scenario);
    } else {
      // Tuning-level options override every mode's options (this is what sweeps set).
      result.options = { ...mode.options, ...spec.options };
    }
    return result;
  });
  if (!list.length) throw new Error(`Tuning ${spec.name} has no modes`);
  if (!['valhalla', 'api'].includes(source.type)) throw new Error(`Tuning ${spec.name}: unknown source type ${source.type}`);
  return { name: spec.name, description: spec.description ?? '', sweep: spec.sweep, file: spec.file,
    source, engine, modes: list };
}

// Pair catalogs: bench/pairs/<region>.json (curated) and <region>-sampled.json.
// See bench/README.md#pair-catalogs for the format.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH_DIR = fileURLToPath(new URL('../', import.meta.url));

// Pair sets for a region: `curated` is <region>.json, any other name is <region>-<name>.json.
export function pairSetPath(region, set) {
  return resolve(BENCH_DIR, 'pairs', set === 'curated' ? `${region}.json` : `${region}-${set}.json`);
}

export function loadPairSet(region, set, path = pairSetPath(region, set)) {
  if (!existsSync(path)) throw new Error(`No ${set} pairs for ${region}: ${path}`);
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  if (catalog.region && catalog.region !== region) throw new Error(`${path}: region ${catalog.region} is not ${region}`);
  const ids = new Set();
  for (const pair of catalog.pairs ?? []) {
    if (!pair.id || ids.has(pair.id)) throw new Error(`${path}: missing or duplicate pair id ${pair.id}`);
    ids.add(pair.id);
    for (const key of ['from', 'to', ...(pair.via ? ['via'] : [])]) {
      const p = pair[key];
      if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) throw new Error(`${path}: pair ${pair.id} needs numeric ${key}.lat/lon`);
    }
    // Reference GPX paths are relative to the catalog file.
    for (const ref of pair.references ?? []) ref.path = resolve(dirname(path), ref.gpx);
  }
  return { set, path, ...catalog, pairs: catalog.pairs ?? [] };
}

// Sets that run by default when their file exists: the curated pairs, the sampled
// sets and the realistic set. `user` is the local catalog bench/add-trips.mjs writes.
export const DEFAULT_SETS = ['curated', 'slt', 'sampled', 'realistic', 'user'];

// External pair files: "[NAME=]PATH". NAME defaults to the file name without .json. Used by
// --pairs-file and $BIKESY_BENCH_PAIRS (a ':'-separated list of the same).
export function parsePairsFileSpec(spec) {
  const match = /^([A-Za-z][\w-]*)=(.+)$/.exec(spec);
  const path = resolve((match ? match[2] : spec).replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  return { name: match ? match[1] : basename(path).replace(/\.json$/, ''), path };
}

export function pairsFileSpecs(cliSpecs = [], env = process.env) {
  return [...(env.BIKESY_BENCH_PAIRS ? env.BIKESY_BENCH_PAIRS.split(':').filter(Boolean) : []), ...cliSpecs].map(parsePairsFileSpec);
}

// Catalogs to run. `sets` names catalogs in bench/pairs (default: DEFAULT_SETS that exist).
// Each external file joins the set of its name (appending to a committed set of that name,
// so restricted pairs can extend `realistic`), or is a set of its own; files are always
// included. Pair ids must be unique within a set.
export function loadCatalogs(region, { sets, files = [] } = {}) {
  const names = sets ?? DEFAULT_SETS.filter(set => existsSync(pairSetPath(region, set)));
  const catalogs = new Map();
  for (const set of names) catalogs.set(set, loadPairSet(region, set));
  for (const { name, path } of files) {
    const external = loadPairSet(region, name, path);
    const existing = catalogs.get(name);
    if (!existing) { catalogs.set(name, { ...external, paths: [path] }); continue; }
    const ids = new Set(existing.pairs.map(p => p.id));
    for (const pair of external.pairs) if (ids.has(pair.id)) throw new Error(`${path}: pair id ${pair.id} is already in set ${name}`);
    catalogs.set(name, { ...existing, paths: [...(existing.paths ?? [existing.path]), path], pairs: [...existing.pairs, ...external.pairs] });
  }
  return [...catalogs.values()];
}

// A trip is one direction of a pair. Reverse trips swap from/to and keep the via point.
export function expandTrips(catalog) {
  const trips = [];
  for (const pair of catalog.pairs) {
    trips.push({ set: catalog.set, pair, direction: 'forward', from: pair.from, to: pair.to, via: pair.via });
    if (!pair.one_way) trips.push({ set: catalog.set, pair, direction: 'reverse', from: pair.to, to: pair.from, via: pair.via });
  }
  for (const trip of trips) trip.key = `${trip.set}/${trip.pair.id}/${trip.direction}`;
  return trips;
}

// Mode selectors: "*" matches every mode; an object matches when every listed facet
// equals the mode's facet (an array value means any of). Unknown facets never match.
export function matchesModes(selector, facets) {
  if (selector === undefined || selector === '*') return true;
  if (typeof selector === 'string') return facets.mode === selector;
  return Object.entries(selector).every(([facet, wanted]) =>
    Array.isArray(wanted) ? wanted.includes(facets[facet]) : facets[facet] === wanted);
}

// Catalog JSON with one pair per line, so diffs and file sizes stay small.
export function stringifyCatalog(catalog) {
  const { pairs = [], ...rest } = catalog;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
  return `${head}${Object.keys(rest).length ? ',' : ''}\n  "pairs": [\n${pairs.map(p => '    ' + JSON.stringify(p)).join(',\n')}\n  ]\n}\n`;
}

// Pair catalogs: bench/pairs/<region>.json (curated) and <region>-sampled.json.
// See bench/README.md#pair-catalogs for the format.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

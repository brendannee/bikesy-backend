#!/usr/bin/env node
// Split O/D research output into the part that may be committed and the part that must
// stay outside git (see lib/open-data.mjs for the rule). Deterministic; run it again after
// regenerating the research data.
//   node bench/split-open.mjs pairs  pairs-realistic.json --open bench/pairs/tahoe-realistic.json --restricted RESTRICTED.json
//   node bench/split-open.mjs points points.geojson --open bench/points/tahoe.geojson [--restricted RESTRICTED.geojson]
// Pair sets are written as catalogs (bench/pairs format); the restricted pairs can be
// loaded with `bench/run.mjs --pairs-file realistic=RESTRICTED.json` (it joins the committed set).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { stringifyCatalog } from './lib/catalog.mjs';
import { OPEN_ATTRIBUTION, splitBySource } from './lib/open-data.mjs';

const sum = (items, key) => items.reduce((total, item) => total + (item[key] ?? 0), 0);

export function splitPairs(doc) {
  const { open, restricted } = splitBySource(doc.pairs);
  const header = (pairs, kind) => ({ region: doc.region, set: undefined,
    notes: `${kind} subset of the realistic O/D pairs (${pairs.length} of ${doc.pairs.length}). ${doc.notes ?? ''}`.trim(),
    purposes: doc.purposes, weight_note: 'weight is relative: weights sum to 1 over the full pair set, so this subset sums to ' + sum(pairs, 'weight').toFixed(4) + '.',
    ...(kind === 'Open' ? { attribution: OPEN_ATTRIBUTION } : {}) });
  return { open: { ...header(open, 'Open'), pairs: open }, restricted: { ...header(restricted, 'Restricted'), pairs: restricted } };
}

export function splitPoints(doc) {
  const { open, restricted } = splitBySource(doc.features, f => f.properties?.source);
  const openCategories = new Set(open.map(f => f.properties.category));
  const only = (features, keep) => Object.fromEntries(Object.entries(doc.categories).filter(([name]) => keep.has(name)));
  // Committed points drop the long per-feature source string: OSM features keep their
  // element ("osm": "node/123"), LODES features are described by their category.
  const compact = f => {
    const { source, id, ...props } = f.properties;
    const osm = /^OpenStreetMap \(ODbL\) (\w+\/\d+)$/.exec(source ?? '')?.[1];
    return { type: 'Feature', geometry: f.geometry, properties: { ...props, ...(osm ? { osm } : {}) } };
  };
  const make = (features, kind) => {
    const names = new Set(features.map(f => f.properties.category));
    return { type: 'FeatureCollection', notes: `${kind} subset: ${doc.notes}`, ...(kind === 'Open' ? { attribution: OPEN_ATTRIBUTION } : {}),
      bbox: doc.bbox, categories: only(features, names), purposes: doc.purposes, features: kind === 'Open' ? features.map(compact) : features };
  };
  return { open: make(open, 'Open'), restricted: make(restricted, 'Restricted'), openCategories: [...openCategories] };
}

// One pair or feature per line keeps diffs and file size small.
export function stringifyCompact(doc, listKey) {
  if (listKey === 'pairs') return stringifyCatalog(doc);
  const { [listKey]: list, ...rest } = doc;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
  return `${head},\n  "${listKey}": [\n${list.map(item => '    ' + JSON.stringify(item)).join(',\n')}\n  ]\n}\n`;
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { open: { type: 'string' }, restricted: { type: 'string' } } });
  const [kind, input] = positionals;
  if (!['pairs', 'points'].includes(kind) || !input || !values.open) {
    console.error('Usage: node bench/split-open.mjs pairs|points INPUT --open FILE [--restricted FILE]');
    process.exit(2);
  }
  const doc = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const result = kind === 'pairs' ? splitPairs(doc) : splitPoints(doc);
  const key = kind === 'pairs' ? 'pairs' : 'features';
  writeFileSync(resolve(values.open), stringifyCompact(result.open, key));
  console.log(`open: ${result.open[key].length} ${key} -> ${values.open}`);
  if (values.restricted) {
    writeFileSync(resolve(values.restricted), stringifyCompact(result.restricted, key));
    console.log(`restricted: ${result.restricted[key].length} ${key} -> ${values.restricted} (keep outside git)`);
  } else {
    console.log(`restricted: ${result.restricted[key].length} ${key} dropped`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

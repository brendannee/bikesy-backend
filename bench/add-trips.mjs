#!/usr/bin/env node
// Turn trips people can paste or export into benchmark pairs, in a local catalog
// (bench/pairs/REGION-user.json by default, the `user` pair set, which runs by default).
//
//   node bench/add-trips.mjs links  links.txt   pasted newmap.tahoebike.org share links, one per line,
//                                               optional note after " # ":  name; tag1,tag2; why
//   node bench/add-trips.mjs table  trips.csv   columns name,from,to,tags,why,max_detour,one_way,added_by;
//                                               from/to: lat,lon, a place name ("Safeway @ kings-beach") or a share link
//   node bench/add-trips.mjs gpx    ride.gpx    a ride as a reference route (ends trimmed and rounded)
//
// The command may be left out: .csv is a table, .gpx a ride, anything else a links file.
// "-" reads standard input:  pbpaste | node bench/add-trips.mjs links -
//
// Re-running an input adds nothing twice (same name and endpoints replace). Address text in
// links is not kept unless --keep-addresses; --snap rounds endpoints to ~110 m. Unresolved
// lines are listed and skipped. See bench/README.md#adding-trips.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { BENCH_DIR, pairSetPath, stringifyCatalog } from './lib/catalog.mjs';
import { checkCatalog } from './check-pairs.mjs';
import { loadPoints, loadZones } from './lib/points.mjs';
import { PairCollector, Places, addGpx, addLinks, addTable } from './lib/trips-input.mjs';

const COMMANDS = ['links', 'table', 'gpx'];
const USAGE = `Usage: node bench/add-trips.mjs [links|table|gpx] FILE... [options]
  --region NAME       region (default tahoe)
  --out FILE          catalog to add to (default bench/pairs/REGION-user.json); "-" prints instead of writing
  --fresh             start the catalog empty instead of adding to it
  --snap              round endpoints to a ~110 m grid
  --keep-addresses    keep the address text of share links (private use only)
  --tag TAG           extra tag for every added pair (repeatable)
  --places FILE       more named points for place names (repeatable; $BIKESY_BENCH_PLACES, ':'-separated)
  --geocode           look up unknown addresses with OSM Nominatim (sends them to that service; 1 request/s)
  --check [--valhalla URL]   report endpoints more than 150 m from a bicycle edge (needs a bench engine)
  --trim-m N          GPX: metres trimmed from each end (default 200)`;

function geocoder(region, bounds) {
  const cachePath = resolve(process.env.BIKESY_BENCH_DIR ?? resolve(BENCH_DIR, 'out'), 'geocode-cache.json');
  let cache = {};
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch {}
  return async text => {
    if (text in cache) return cache[text];
    await new Promise(r => setTimeout(r, 1100));
    const query = new URLSearchParams({ q: text, format: 'jsonv2', limit: '1', bounded: '1', viewbox: `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}` });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${query}`, { headers: { 'user-agent': 'bikesy-bench-add-trips/1 (+https://tahoebike.org)' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`geocoder: HTTP ${response.status}`);
    const [hit] = await response.json();
    cache[text] = hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
    return cache[text];
  };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    region: { type: 'string' }, out: { type: 'string' }, fresh: { type: 'boolean' }, snap: { type: 'boolean' }, 'keep-addresses': { type: 'boolean' },
    tag: { type: 'string', multiple: true }, places: { type: 'string', multiple: true }, geocode: { type: 'boolean' }, check: { type: 'boolean' },
    valhalla: { type: 'string' }, 'trim-m': { type: 'string' }, help: { type: 'boolean' } } });
  const command = COMMANDS.includes(positionals[0]) ? positionals[0] : null;
  const files = command ? positionals.slice(1) : positionals;
  if (values.help || !files.length) { console.log(USAGE); process.exit(values.help ? 0 : 2); }

  const region = values.region ?? 'tahoe';
  const config = loadConfig({ BIKESY_CONFIG: resolve(BENCH_DIR, '..', 'config', `${region}.json`) });
  const out = values.out === '-' ? null : resolve(values.out ?? pairSetPath(region, 'user'));
  const zonePath = resolve(BENCH_DIR, 'points', `${region}-zones.json`);
  const zoneInfo = existsSync(zonePath) ? loadZones(zonePath) : null;
  const placeFiles = [resolve(BENCH_DIR, 'points', `${region}.geojson`), ...(values.places ?? []),
    ...(process.env.BIKESY_BENCH_PLACES?.split(':').filter(Boolean) ?? [])].map(p => resolve(p)).filter(existsSync);
  const places = new Places(placeFiles.flatMap(path => loadPoints(path).points), zoneInfo);
  const geocode = values.geocode ? geocoder(region, config.bounds) : undefined;

  let catalog = { region, notes: 'Trips added with bench/add-trips.mjs. Kept out of git by default: they can contain places that identify people.', pairs: [] };
  if (out && !values.fresh && existsSync(out)) catalog = JSON.parse(readFileSync(out, 'utf8'));
  if (catalog.region && catalog.region !== region) throw new Error(`${out}: region ${catalog.region} is not ${region}`);
  const before = catalog.pairs.length;
  const collector = new PairCollector({ bounds: config.bounds, zoneInfo, snap: values.snap, existing: catalog.pairs });
  const references = [];
  let added = 0;

  for (const file of files) {
    const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(file), 'utf8');
    const name = file === '-' ? 'stdin' : basename(file);
    const kind = command ?? (/\.csv$/i.test(file) ? 'table' : /\.gpx$/i.test(file) ? 'gpx' : 'links');
    if (kind === 'links') added += (await addLinks(text, collector, { keepAddresses: values['keep-addresses'], geocode })).length;
    else if (kind === 'table') added += (await addTable(text, collector, { places, geocode, source: `table:${name}` })).length;
    else {
      try {
        const result = addGpx(text, name, collector, { trimM: Number(values['trim-m'] ?? 200), tags: values.tag ?? [] });
        references.push(result);
        added++;
      } catch (error) { collector.errors.push({ line: name, input: name, error: error.message }); }
    }
  }
  if (values.tag?.length) for (const pair of collector.pairs.slice(before)) pair.tags = [...new Set([...pair.tags, ...values.tag])];

  catalog.pairs = collector.pairs;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    for (const { file, gpx } of references) {
      const path = resolve(dirname(out), file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, gpx);
    }
    writeFileSync(out, stringifyCatalog(catalog));
  } else console.log(stringifyCatalog(catalog));
  console.error(`${added} trip${added === 1 ? '' : 's'} added or updated, ${collector.pairs.length} in the catalog${out ? ` (${out})` : ''}, ${collector.errors.length} skipped`);
  for (const e of collector.errors) console.error(`  skipped line ${e.line} (${e.input}): ${e.error}`);

  if (values.check) {
    const valhalla = (values.valhalla ?? 'http://127.0.0.1:18002/').replace(/\/?$/, '/');
    const { bad } = await checkCatalog(valhalla, { pairs: collector.pairs.slice(before) });
    for (const { pair, failures } of bad) console.error(`  ${pair.id}: ${failures.map(f => `${f.key} ${f.snap ? Math.round(f.snap.distance) + ' m from a bicycle edge' : 'no bicycle edge nearby'}`).join(', ')}`);
    if (!bad.length) console.error('  all endpoints are within 150 m of a bicycle edge');
  }
  if (out && added) {
    const selector = out === pairSetPath(region, 'user') ? '--sets user' : `--pairs-file ${out}`;
    console.error(`Next: node bench/run.mjs --region ${region} --tuning config ${selector}   (add --sets curated,... to keep other sets)`);
  }
  process.exit(collector.errors.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.stack ?? error.message); process.exit(1); });
}

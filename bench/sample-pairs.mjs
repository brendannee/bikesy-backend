#!/usr/bin/env node
// Seeded random origin/destination pairs weighted toward where people live, so the
// benchmark is not tuned only to the curated pairs. Writes bench/pairs/<region>-sampled.json.
//
// Weighting: OSM buildings and address nodes from the region extract are counted on a
// grid (--cell-m); a cell is chosen with probability proportional to count^alpha
// (--alpha 0.5 by default, so dense towns lead without crowding out small ones), then
// a feature in it. Destinations are drawn the same way until one lies --min-km..--max-km
// away (straight line). Both ends must snap (Valhalla /locate, bicycle) to a routable edge
// within --snap-m metres; the snapped points are stored. Sampled pairs are one_way: a
// random direction is as good as both. Needs osmium-tool and a running bench engine.
//   node bench/sample-pairs.mjs --region tahoe --pbf .../data/region.osm.pbf [--count 200] [--seed 1]
//
// Weighted mode (--points): instead of building density, sample trip purposes, origin and
// destination categories and weighted points from a point file (bench/points/REGION.geojson,
// see lib/points.mjs for the method). Zones are flattened with --zone-alpha so the largest
// towns do not dominate. Writes bench/pairs/<region>-sampled-weighted.json. Needs only the
// engine, not osmium.
//   node bench/sample-pairs.mjs --region tahoe --points bench/points/tahoe.geojson [--count 200] [--seed 1]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { BENCH_DIR, pairSetPath } from './lib/catalog.mjs';
import { haversine } from './lib/geo.mjs';
import { snapToBicycleEdge } from './lib/locate.mjs';
import { createPointSampler, loadPoints as loadWeightedPoints, loadZones, seasonFilter, zoneShares } from './lib/points.mjs';

// Small, fast, seedable PRNG (mulberry32).
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Weighted cell picker over a Map(cellKey -> [points]).
export function cellSampler(cells, alpha, rand) {
  const entries = [...cells.values()];
  const cumulative = [];
  let total = 0;
  for (const points of entries) { total += points.length ** alpha; cumulative.push(total); }
  return () => {
    const x = rand() * total;
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < x) lo = mid + 1; else hi = mid; }
    const points = entries[lo];
    return points[Math.floor(rand() * points.length)];
  };
}

async function loadPoints(pbf, bounds) {
  const work = mkdtempSync(resolve(tmpdir(), 'bench-sample-'));
  try {
    const filtered = resolve(work, 'homes.osm.pbf'), exported = resolve(work, 'homes.geojsonseq');
    execFileSync('osmium', ['tags-filter', '--overwrite', pbf, 'nwr/building', 'n/addr:housenumber', '-o', filtered], { stdio: 'inherit' });
    execFileSync('osmium', ['export', '--overwrite', filtered, '-f', 'geojsonseq', '--geometry-types=point,polygon', '-o', exported], { stdio: 'inherit' });
    const points = [];
    for await (const line of createInterface({ input: createReadStream(exported) })) {
      if (!line.trim()) continue;
      const { geometry: g } = JSON.parse(line.replace(/^\x1e/, ''));
      const ring = g.type === 'Point' ? [g.coordinates] : g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
      const lon = ring.reduce((s, c) => s + c[0], 0) / ring.length, lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
      if (lon > bounds.left && lon < bounds.right && lat > bounds.bottom && lat < bounds.top) points.push([lat, lon]);
    }
    return points;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function writeCatalog(out, header, pairs) {
  writeFileSync(out, `{\n  "region": ${JSON.stringify(header.region)},\n  "notes": ${JSON.stringify(header.notes)},\n  "generator": ${JSON.stringify(header.generator)},\n  "pairs": [\n${pairs.map(p => '    ' + JSON.stringify(p)).join(',\n')}\n  ]\n}\n`);
}

// Weighted mode: purposes, categories and weighted points instead of building density.
async function sampleWeighted(values) {
  const region = values.region;
  const params = { count: Number(values.count ?? 200), seed: Number(values.seed ?? 1), min_km: Number(values['min-km'] ?? 1),
    max_km: Number(values['max-km'] ?? 15), zone_alpha: Number(values['zone-alpha'] ?? 0.5), weight_power: Number(values['weight-power'] ?? 0.5),
    decay_km: Number(values['decay-km'] ?? 4), snap_m: Number(values['snap-m'] ?? 150), season: values.season ?? 'summer' };
  const valhalla = (values.valhalla ?? 'http://127.0.0.1:18002/').replace(/\/?$/, '/');
  const pointsPath = resolve(values.points);
  const loaded = loadWeightedPoints(pointsPath);
  const points = loaded.points.filter(seasonFilter(params.season));
  const zoneInfo = loadZones(resolve(dirname(pointsPath), `${region}-zones.json`));
  const rand = random(params.seed);
  const sampler = createPointSampler(points, loaded.purposes, rand, { zoneAlpha: params.zone_alpha, weightPower: params.weight_power,
    decayKm: params.decay_km, minKm: params.min_km, maxKm: params.max_km });
  const missing = Object.keys(loaded.purposes).filter(name => !sampler.purposes.some(p => p.name === name));
  if (missing.length) console.warn(`Purposes without usable categories in ${values.points} (dropped, shares renormalised): ${missing.join(', ')}`);

  const label = p => p.name ?? `${p.category} in ${zoneInfo.names[p.zone] ?? 'the basin area'}`;
  const placeLabel = p => ({ home: `${zoneInfo.names[p.zone] ?? 'outlying'} homes`, work: `${zoneInfo.names[p.zone] ?? 'outlying'} jobs` })[p.category] ?? label(p);
  const pairs = [], purposeCount = {};
  let attempts = 0, rejected = 0;
  while (pairs.length < params.count) {
    if (++attempts > params.count * 200) throw new Error('Could not find enough pairs; relax --min-km/--max-km or --snap-m');
    const draw = sampler.next();
    if (!draw) continue;
    const [a, b] = await snapToBicycleEdge(valhalla, [[draw.from.lat, draw.from.lon], [draw.to.lat, draw.to.lon]]);
    if (!a || !b || a.distance > params.snap_m || b.distance > params.snap_m) { rejected++; continue; }
    const km = haversine(a.point, b.point) / 1000;
    if (km < params.min_km || km > params.max_km) { rejected++; continue; }
    const n = String(pairs.length + 1).padStart(3, '0');
    purposeCount[draw.purpose] = (purposeCount[draw.purpose] ?? 0) + 1;
    pairs.push({ id: `w${n}`, name: `${draw.purpose}: ${placeLabel(draw.from)} to ${placeLabel(draw.to)}`,
      from: { lat: a.point[0], lon: a.point[1] }, to: { lat: b.point[0], lon: b.point[1] }, one_way: true,
      tags: ['sampled', 'weighted', draw.purpose], purpose: draw.purpose, km: Number(km.toFixed(2)) });
  }
  const origins = zoneShares(pairs, zoneInfo, 'from'), destinations = zoneShares(pairs, zoneInfo, 'to');
  const sha = createHash('sha256').update(readFileSync(pointsPath)).digest('hex');
  const out = resolve(values.out ?? pairSetPath(region, values.set ?? 'sampled-weighted'));
  const header = { region, notes: 'Generated by bench/sample-pairs.mjs --points; do not edit by hand. km = straight-line distance. '
    + 'Purposes, categories and weights come from the point file (bench/points); zones are flattened by zone_alpha.',
  generator: { ...params, points_file: pointsPath.replace(/^.*\//, ''), points_sha256: sha, points: points.length, rejected_snaps: rejected,
    purposes: Object.fromEntries(sampler.purposes.map(p => [p.name, Number((p.share / sampler.purposes.reduce((t, q) => t + q.share, 0)).toFixed(3))])),
    purpose_pairs: purposeCount, origin_zone_share: origins.share, carson_origin_share: origins.carson, carson_destination_share: destinations.carson } };
  writeCatalog(out, header, pairs);
  console.log(`Wrote ${pairs.length} pairs to ${out}; origins east of the Carson Range crest (Carson City / Valley): ${(origins.carson * 100).toFixed(0)}%`);
}

async function main() {
  const { values } = parseArgs({ options: {
    region: { type: 'string' }, pbf: { type: 'string' }, count: { type: 'string' }, seed: { type: 'string' },
    'min-km': { type: 'string' }, 'max-km': { type: 'string' }, alpha: { type: 'string' }, 'cell-m': { type: 'string' },
    'snap-m': { type: 'string' }, valhalla: { type: 'string' }, out: { type: 'string' },
    points: { type: 'string' }, 'zone-alpha': { type: 'string' }, 'weight-power': { type: 'string' }, 'decay-km': { type: 'string' },
    season: { type: 'string' }, set: { type: 'string' },
  } });
  if (values.region && values.points) return sampleWeighted(values);
  if (!values.region || !values.pbf) {
    console.error('Usage: node bench/sample-pairs.mjs --region REGION --pbf REGION.osm.pbf [--count 200] [--seed 1] [--valhalla URL]\n'
      + '       node bench/sample-pairs.mjs --region REGION --points POINTS.geojson [--count 200] [--seed 1] [--zone-alpha 0.5]\n'
      + '         [--weight-power 0.5] [--decay-km 4] [--min-km 1] [--max-km 15] [--season summer|winter|all] [--set sampled-weighted] [--out FILE]');
    process.exit(2);
  }
  const params = { count: Number(values.count ?? 200), seed: Number(values.seed ?? 1), min_km: Number(values['min-km'] ?? 3),
    max_km: Number(values['max-km'] ?? 13), alpha: Number(values.alpha ?? 0.5), cell_m: Number(values['cell-m'] ?? 500),
    snap_m: Number(values['snap-m'] ?? 150) };
  const valhalla = (values.valhalla ?? 'http://127.0.0.1:18002/').replace(/\/?$/, '/');
  const config = loadConfig({ BIKESY_CONFIG: resolve(BENCH_DIR, '..', 'config', `${values.region}.json`) });
  const pbf = resolve(values.pbf);
  const points = await loadPoints(pbf, config.bounds);
  console.log(`${points.length} building/address points inside the service area`);

  const cellDeg = params.cell_m / 111320, cells = new Map();
  for (const p of points) {
    const key = `${Math.floor(p[0] / cellDeg)}:${Math.floor(p[1] / (cellDeg / Math.cos(p[0] * Math.PI / 180)))}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }
  const rand = random(params.seed), pick = cellSampler(cells, params.alpha, rand);
  const pairs = [];
  let attempts = 0;
  while (pairs.length < params.count) {
    if (++attempts > params.count * 200) throw new Error('Could not find enough pairs; relax --min-km/--max-km or --snap-m');
    const from = pick();
    let to = null;
    for (let i = 0; i < 200 && !to; i++) {
      const candidate = pick(), d = haversine(from, candidate) / 1000;
      if (d >= params.min_km && d <= params.max_km) to = candidate;
    }
    if (!to) continue;
    const [a, b] = await snapToBicycleEdge(valhalla, [from, to]);
    if (!a || !b || a.distance > params.snap_m || b.distance > params.snap_m) continue;
    const d = haversine(a.point, b.point) / 1000;
    if (d < params.min_km || d > params.max_km) continue;
    const n = String(pairs.length + 1).padStart(3, '0');
    pairs.push({ id: `s${n}`, name: `Sampled pair ${n}`, from: { lat: a.point[0], lon: a.point[1] }, to: { lat: b.point[0], lon: b.point[1] },
      one_way: true, tags: ['sampled'], km: Number(d.toFixed(2)) });
  }
  const sha = createHash('sha256').update(readFileSync(pbf)).digest('hex');
  const out = resolve(values.out ?? pairSetPath(values.region, 'sampled'));
  const header = { region: values.region, notes: 'Generated by bench/sample-pairs.mjs; do not edit by hand. km = straight-line distance.',
    generator: { ...params, extract: pbf.replace(/^.*\//, ''), extract_sha256: sha, points: points.length, cells: cells.size } };
  writeCatalog(out, header, pairs);
  console.log(`Wrote ${pairs.length} pairs to ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.stack ?? error.message); process.exit(1); });
}

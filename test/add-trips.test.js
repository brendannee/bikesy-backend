// bench/add-trips.mjs input parsers and pair builders, the open-data rule, the weighted
// point sampler and the realistic pair sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { DEFAULT_SETS, loadCatalogs, loadPairSet, parsePairsFileSpec, pairsFileSpecs, stringifyCatalog } from '../bench/lib/catalog.mjs';
import { isOpenSource, splitBySource } from '../bench/lib/open-data.mjs';
import { CARSON_MIN_LON, createPointSampler, loadPoints, loadZones, seasonFilter, zoneOf, zoneShares } from '../bench/lib/points.mjs';
import { PairCollector, Places, addGpx, addLinks, addTable, parseCsv, parseShareLink, resolveEndpoint, roundToGrid, splitNote, trimTrack } from '../bench/lib/trips-input.mjs';
import { haversine } from '../bench/lib/geo.mjs';
import { random } from '../bench/sample-pairs.mjs';
import { splitPairs, splitPoints } from '../bench/split-open.mjs';
import { render, summarize } from '../bench/set-summary.mjs';
import { computeAggregates, weightedQuantile } from '../bench/aggregates.mjs';

const tahoe = loadConfig({ BIKESY_CONFIG: 'config/tahoe.json' });
const zoneInfo = loadZones('bench/points/tahoe-zones.json');
const open = loadPoints('bench/points/tahoe.geojson');
const places = new Places(open.points, zoneInfo);
const collector = (extra = {}) => new PairCollector({ bounds: tahoe.bounds, zoneInfo, ...extra });
const NEWMAP = 'https://newmap.tahoebike.org/#Tahoe+City+Transit+Center/-120.14348,39.16894/River+Ranch/-120.19795,39.18636/1';

test('share links: newmap format, encoded characters, legacy format, junk', () => {
  const link = parseShareLink(NEWMAP);
  assert.deepEqual([link.format, link.start, link.end, link.scenario, link.startAddr, link.host],
    ['newmap', { lat: 39.16894, lon: -120.14348 }, { lat: 39.18636, lon: -120.19795 }, '1', 'Tahoe City Transit Center', 'newmap.tahoebike.org']);
  const encoded = parseShareLink('https://newmap.tahoebike.org/#A%20%26+B%2FC/-120.1%2C39.2/D/-120.0%2C39.3/2/');
  assert.deepEqual([encoded.startAddr, encoded.start, encoded.end, encoded.scenario], ['A & B/C', { lat: 39.2, lon: -120.1 }, { lat: 39.3, lon: -120 }, '2']);
  assert.equal(parseShareLink('https://newmap.tahoebike.org/#/X/-120.1,39.2/Y/-120.0,39.3').scenario, null);
  const legacy = parseShareLink('https://map.tahoebike.org/#Wildwood+%26+Lake+Tahoe+Blvd/Dunlap+Dr%2C+S.+Lake+Tahoe/1');
  assert.deepEqual([legacy.format, legacy.start, legacy.end, legacy.endAddr, legacy.scenario], ['legacy', null, null, 'Dunlap Dr, S. Lake Tahoe', '1']);
  assert.throws(() => parseShareLink('https://newmap.tahoebike.org/'), /no trip/);
  assert.throws(() => parseShareLink('not a url'), /not a URL/);
  // Latitude out of range falls back to the address-only reading.
  assert.equal(parseShareLink('https://newmap.tahoebike.org/#A/-120.1,95/B/-120,39/1').format, 'legacy');
});

test('link notes: "# name; tags; why"', () => {
  assert.deepEqual(splitNote(`${NEWMAP} # Tahoe City to River Ranch; class-i, recreation; Trail should win; really`),
    { url: NEWMAP, name: 'Tahoe City to River Ranch', tags: ['class-i', 'recreation'], why: 'Trail should win; really' });
  assert.deepEqual(splitNote(`${NEWMAP} # ; commute`), { url: NEWMAP, name: null, tags: ['commute'], why: '' });
  assert.deepEqual(splitNote(NEWMAP), { url: NEWMAP, name: null, tags: [], why: '' }, 'the # in the fragment is not a note');
});

test('CSV: quotes, embedded commas and newlines, CRLF, BOM and blank rows', () => {
  const rows = parseCsv('﻿Name, From ,to,tags\r\n"Pope, ""the"" beach","39.1,-120.1",B,"a,b"\r\n\r\n"two\nlines",C,D,\r\nlast,E,F,t');
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].name, rows[0].from, rows[0].to, rows[0].tags, rows[0].line], ['Pope, "the" beach', '39.1,-120.1', 'B', 'a,b', 2]);
  assert.equal(rows[1].name, 'two\nlines');
  assert.deepEqual([rows[2].from, rows[2].tags], ['E', 't']);
  assert.deepEqual(parseCsv('a,b\n1'), [{ line: 2, a: '1', b: '' }]);
  assert.deepEqual(parseCsv(''), []);
});

test('places: exact and partial names, zone qualifiers, ambiguity and suggestions', () => {
  const pope = places.lookup('pope beach');
  assert.equal(pope.name, 'Pope Beach');
  assert.ok(haversine([pope.lat, pope.lon], [38.93, -120.04]) < 3000);
  assert.equal(places.lookup('Safeway @ kings-beach').name, 'Safeway');
  assert.throws(() => places.lookup('Safeway'), /ambiguous.*Safeway @ /);
  assert.throws(() => places.lookup('Safewy'), /did you mean Safeway/);
  assert.throws(() => places.lookup('Qwertyuiop'), /not found locally.*share link/);
});

test('endpoints: coordinates in either order, links by role, names, geocoder fallback', async () => {
  const ctx = { places };
  assert.deepEqual(await resolveEndpoint(' 39.32871 , -120.18479 ', 'from', ctx), { lat: 39.32871, lon: -120.18479 });
  assert.deepEqual(await resolveEndpoint('-120.18479,39.32871', 'to', ctx), { lat: 39.32871, lon: -120.18479 });
  assert.deepEqual(await resolveEndpoint(NEWMAP, 'from', ctx), { lat: 39.16894, lon: -120.14348 });
  assert.deepEqual(await resolveEndpoint(NEWMAP, 'to', ctx), { lat: 39.18636, lon: -120.19795 });
  await assert.rejects(resolveEndpoint('https://map.tahoebike.org/#A/B/1', 'from', ctx), /legacy/);
  await assert.rejects(resolveEndpoint('1 Main St', 'from', ctx), /not found locally/);
  assert.deepEqual(await resolveEndpoint('1 Main St', 'from', { ...ctx, geocode: async () => ({ lat: 39.1, lon: -120.1 }) }), { lat: 39.1, lon: -120.1 });
});

test('link files become pairs: no address text, scenario tag, bounds, idempotent re-adds', async () => {
  const text = `// comment\n\n${NEWMAP} # Tahoe City to River Ranch; class-i; Trail beats SR 89\n`
    + 'https://newmap.tahoebike.org/#12+Elm+St/-120.1,39.2/Kings+Beach/-120.02,39.24/2\n'
    + 'https://newmap.tahoebike.org/#Far/-121.5,38.5/Away/-120.0,39.0/1\n'
    + 'https://map.tahoebike.org/#Wildwood/Dunlap/1\n';
  const c = collector();
  const added = await addLinks(text, c);
  assert.equal(added.length, 2);
  assert.deepEqual(c.errors.map(e => e.line), [5, 6]);
  assert.match(c.errors[0].error, /outside the routing service area/);
  assert.match(c.errors[1].error, /legacy/);
  const [named, unnamed] = c.pairs;
  assert.deepEqual([named.id, named.tags, named.why, named.scenario], ['tahoe-city-to-river-ranch', ['class-i', 'scenario-1'], 'Trail beats SR 89', '1']);
  assert.equal(unnamed.name, 'Dollar Point / Lake Forest to Kings Beach', 'named from zones, not from the address');
  assert.ok(!JSON.stringify(c.pairs).includes('Elm'), 'address text is not kept');
  const kept = collector();
  await addLinks('https://newmap.tahoebike.org/#12+Elm+St/-120.1,39.2/Kings+Beach/-120.02,39.24/2', kept, { keepAddresses: true });
  assert.equal(kept.pairs[0].from_label, '12 Elm St');
  // Adding the same text to the catalog it produced changes nothing; the same name elsewhere gets a suffix.
  const again = collector({ existing: c.pairs });
  await addLinks(text, again);
  assert.equal(again.pairs.length, 2);
  await addLinks(`${NEWMAP.replace('-120.19795,39.18636', '-120.2,39.19')} # Tahoe City to River Ranch`, again);
  assert.deepEqual(again.pairs.map(p => p.id), ['tahoe-city-to-river-ranch', 'dollar-point-lake-forest-to-kings-beach', 'tahoe-city-to-river-ranch-2']);
  // --snap rounds to a ~110 m grid.
  const snapped = collector({ snap: true });
  await addLinks(NEWMAP, snapped);
  assert.deepEqual(snapped.pairs[0].from, roundToGrid({ lat: 39.16894, lon: -120.14348 }));
  assert.ok(haversine([39.16894, -120.14348], [snapped.pairs[0].from.lat, snapped.pairs[0].from.lon]) < 80);
});

test('table rows become pairs: expectations, one_way, added_by, errors by line', async () => {
  const csv = 'name,from,to,tags,why,max_detour,one_way,added_by\n'
    + 'Errand,Kings Beach Elementary School,Safeway @ kings-beach,"errands, short",nearby,1.3,,sam\n'
    + `,"39.32871,-120.18479","${NEWMAP}",school,,,yes,\n`
    + 'Typo,Safewy,Pope Beach,,,,,\n'
    + 'Bad detour,Pope Beach,Kings Beach,,,0.5,,\n'
    + 'Half,Pope Beach,,,,,,\n';
  const c = collector();
  const added = await addTable(csv, c, { places, source: 'table:trips.csv' });
  assert.equal(added.length, 2);
  assert.deepEqual(c.errors.map(e => e.line), [4, 5, 6]);
  assert.match(c.errors[0].error, /did you mean Safeway/);
  assert.match(c.errors[1].error, /max_detour/);
  assert.match(c.errors[2].error, /both from and to/);
  const [errand, commute] = c.pairs;
  assert.deepEqual([errand.tags, errand.expect, errand.added_by, errand.one_way, errand.source], [['errands', 'short'], [{ modes: '*', max_detour: 1.3 }], 'sam', undefined, 'table:trips.csv']);
  assert.equal(commute.one_way, true);
  assert.deepEqual(commute.to, { lat: 39.18636, lon: -120.19795 }, 'a share link in a cell supplies its end for "to"');
  assert.match(commute.name, /to/);
});

test('GPX rides: ends trimmed and rounded, reference simplified and written without time', () => {
  const gpx = readFileSync('bench/samples/add-trips/ride.gpx', 'utf8');
  const track = [];
  for (const m of gpx.matchAll(/lat="([\d.-]+)" lon="([\d.-]+)"/g)) track.push([Number(m[1]), Number(m[2])]);
  const trimmed = trimTrack(track, 200);
  assert.ok(haversine(track[0], trimmed[0]) >= 200 && haversine(track[0], trimmed[0]) < 600);
  assert.equal(trimTrack(track, 0), track);
  const c = collector();
  const { pair, gpx: reference, file } = addGpx(gpx, 'ride.gpx', c);
  assert.equal(pair.name, 'Tahoe City to River Ranch via Truckee River Trail');
  assert.deepEqual(pair.tags, ['reference-route']);
  assert.equal(file, `refs/${pair.id}.gpx`);
  assert.deepEqual(pair.references, [{ gpx: file }]);
  assert.deepEqual(pair.from, roundToGrid(pair.from), 'endpoints are rounded even without --snap');
  assert.ok(haversine([track[0][0], track[0][1]], [pair.from.lat, pair.from.lon]) > 150);
  assert.match(reference, /<trkpt lat="39\.\d{5}" lon="-120\.\d{5}"\/>/);
  assert.ok(!/<time|<ele/.test(reference));
  assert.throws(() => addGpx('<gpx/>', 'x.gpx', collector()), /no track/);
  assert.throws(() => addGpx(gpx, 'ride.gpx', collector(), { trimM: 5000 }), /shorter/);
});

test('catalog helpers: pair-file specs, merging external files into a set, one pair per line', () => {
  assert.deepEqual(parsePairsFileSpec('realistic=/tmp/a.json'), { name: 'realistic', path: '/tmp/a.json' });
  assert.deepEqual(parsePairsFileSpec('/tmp/extra-pairs.json'), { name: 'extra-pairs', path: '/tmp/extra-pairs.json' });
  assert.deepEqual(pairsFileSpecs(['x=/c.json'], { BIKESY_BENCH_PAIRS: 'a=/a.json:/b.json' }).map(s => s.name), ['a', 'b', 'x']);
  assert.ok(DEFAULT_SETS.includes('realistic'));
  const dir = mkdtempSync(join(tmpdir(), 'bench-pairs-'));
  const pair = id => ({ id, from: { lat: 39.1, lon: -120.1 }, to: { lat: 39.2, lon: -120.1 }, weight: 0.1 });
  const write = (name, pairs) => { const path = join(dir, name); writeFileSync(path, stringifyCatalog({ region: 'tahoe', pairs })); return path; };
  const extension = write('ext.json', [pair('restricted-1')]), clash = write('clash.json', [pair(loadPairSet('tahoe', 'realistic').pairs[0].id)]), own = write('own.json', [pair('mine')]);
  const [realistic, user] = loadCatalogs('tahoe', { sets: ['realistic'], files: [{ name: 'realistic', path: extension }, { name: 'own', path: own }] });
  assert.equal(realistic.pairs.length, loadPairSet('tahoe', 'realistic').pairs.length + 1);
  assert.deepEqual(realistic.paths.length, 2);
  assert.deepEqual([user.set, user.pairs.map(p => p.id)], ['own', ['mine']]);
  assert.throws(() => loadCatalogs('tahoe', { sets: ['realistic'], files: [{ name: 'realistic', path: clash }] }), /already in set realistic/);
  assert.throws(() => loadCatalogs('tahoe', { sets: ['nope'] }), /No nope pairs/);
  assert.equal(JSON.parse(readFileSync(own, 'utf8')).pairs[0].id, 'mine');
  assert.equal(readFileSync(own, 'utf8').split('\n').length, 7, 'a pair is one line');
});

test('open-data rule: only OSM and LODES sources may be committed', () => {
  for (const source of ['US Census LEHD LODES 8, 2023 (public domain) OD main+aux', 'OSM lodging + OSM recreation', 'OSM supermarkets + LODES RAC',
    'OpenStreetMap (ODbL) node/1', 'US Census LEHD LODES 8, 2023 (public domain) WAC',
    'US Census LEHD LODES 8, 2023 (public domain) OD main+aux + US Census ACS 2019-2023 B08301 + OpenStreetMap places']) assert.equal(isOpenSource(source), true, source);
  for (const source of ['GTFS / TRPA mobility hubs + LODES RAC', 'TRPA TAZ trip ends + LODES RAC', 'GTFS gtfs-ttd', 'TRPA Data Downloader (maps.trpa.org)',
    'GTFS / TRPA mobility hubs + OSM beaches', 'OSM schools + TRPA TAZ', '', undefined]) assert.equal(isOpenSource(source), false, String(source));
  const { open, restricted } = splitBySource([{ source: 'OSM x' }, { source: 'TRPA y' }, {}]);
  assert.deepEqual([open.length, restricted.length], [1, 2]);
  const split = splitPairs({ region: 'tahoe', notes: 'n', pairs: [{ id: 'a', source: 'OSM x', weight: 0.25 }, { id: 'b', source: 'GTFS y + OSM z', weight: 0.75 }] });
  assert.deepEqual([split.open.pairs.map(p => p.id), split.restricted.pairs.map(p => p.id)], [['a'], ['b']]);
  assert.match(split.open.weight_note, /0\.2500/);
  const kept = splitPairs({ region: 'sf', notes: 'n', attribution: 'own', distance_mix: { a: 1 }, pairs: [{ id: 'a', source: 'OSM x', weight: 1 }] });
  assert.deepEqual([kept.open.attribution, kept.open.distance_mix], ['own', { a: 1 }], 'the input attribution and set-level keys are kept');
  const feature = (category, source) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-120, 39] }, properties: { category, weight: 1, source, id: `${category}-1` } });
  const points = splitPoints({ notes: 'n', categories: { home: {}, transit: {}, food: {} }, features: [feature('home', 'US Census LEHD LODES 8, 2023 (public domain) RAC'),
    feature('transit', 'GTFS gtfs-tart'), feature('food', 'OpenStreetMap (ODbL) node/42')] });
  assert.deepEqual(Object.keys(points.open.categories), ['home', 'food']);
  assert.deepEqual(points.open.features.map(f => f.properties), [{ category: 'home', weight: 1 }, { category: 'food', weight: 1, osm: 'node/42' }]);
  assert.equal(points.restricted.features.length, 1);
});

test('committed pair sets and points carry only open sources and no personal fields', () => {
  const pairFiles = readdirSync('bench/pairs').filter(f => f.endsWith('.json') && !f.endsWith('-user.json'));
  assert.ok(pairFiles.includes('tahoe-realistic.json') && pairFiles.includes('tahoe-sampled-weighted.json'));
  for (const file of pairFiles) {
    const text = readFileSync(`bench/pairs/${file}`, 'utf8');
    assert.ok(!/TRPA|GTFS/i.test(text.replace(/"notes":"[^"]*"/g, '')) || file === 'tahoe-realistic.json', file);
    for (const pair of JSON.parse(text).pairs) {
      for (const key of ['added_by', 'from_label', 'to_label']) assert.ok(!(key in pair), `${file} ${pair.id} has ${key}`);
      if ('source' in pair) assert.equal(isOpenSource(pair.source), true, `${file} ${pair.id}: ${pair.source}`);
    }
  }
  const realistic = JSON.parse(readFileSync('bench/pairs/tahoe-realistic.json', 'utf8'));
  assert.ok(realistic.pairs.length >= 60 && realistic.attribution.includes('OpenStreetMap'));
  assert.ok(!/TRPA|GTFS/.test(JSON.stringify(realistic.pairs)), 'no restricted source or text in the pairs');
  const categories = new Set(open.points.map(p => p.category));
  for (const restricted of ['transit', 'trpa-taz']) assert.ok(!categories.has(restricted), restricted);
  assert.ok(open.doc.attribution.includes('OpenStreetMap') && !('source' in open.doc.features[0].properties));
});

test('weighted sampler: purposes, season, distance bounds, determinism and zone flattening', () => {
  const grid = (zone, lat, count, weight, category) => Array.from({ length: count }, (_, i) => ({ category, weight, zone, season: 'all', lat: lat + i * 0.0005, lon: -120.1 + (i % 7) * 0.001 }));
  const points = [...grid('big', 39.1, 400, 50, 'home'), ...grid('small', 39.16, 20, 50, 'home'), ...grid('big', 39.12, 40, 5, 'food'), ...grid('small', 39.17, 40, 5, 'food')];
  const purposes = { eat: { share: 3, from: ['home'], to: ['food'] }, ghost: { share: 1, from: ['home'], to: ['missing'] } };
  const draw = (options, seed = 1) => {
    const sampler = createPointSampler(points, purposes, random(seed), options);
    return Array.from({ length: 400 }, () => sampler.next()).filter(Boolean);
  };
  const plain = draw({ zoneAlpha: 1, decayKm: 1000, minKm: 0, maxKm: 100 }), flat = draw({ zoneAlpha: 0.2, decayKm: 1000, minKm: 0, maxKm: 100 });
  assert.deepEqual(createPointSampler(points, purposes, random(1), {}).purposes.map(p => p.name), ['eat'], 'purposes without categories are dropped');
  assert.ok(plain.every(d => d.purpose === 'eat'));
  assert.deepEqual(draw({ zoneAlpha: 1 }, 5), draw({ zoneAlpha: 1 }, 5));
  const share = list => list.filter(d => d.from.zone === 'small').length / list.length;
  assert.ok(share(plain) < 0.25, `plain small-zone share ${share(plain)}`);
  assert.ok(share(flat) > 0.3, `flattened small-zone share ${share(flat)}`);
  const bounded = draw({ minKm: 3, maxKm: 8 });
  assert.ok(bounded.length > 100 && bounded.every(d => { const km = haversine([d.from.lat, d.from.lon], [d.to.lat, d.to.lon]) / 1000; return km >= 3 && km <= 8; }));
  assert.equal(createPointSampler(points, purposes, random(1), { minKm: 500, maxKm: 600 }).next(), null, 'no destination in range');
  assert.throws(() => createPointSampler(points, { x: { share: 1, from: ['nope'], to: ['food'] } }, random(1)), /No purpose/);
  const winter = [{ ...points[0], season: 'winter' }, { ...points[1], season: 'summer' }, { ...points[2], season: 'all' }];
  assert.deepEqual([winter.filter(seasonFilter('summer')).length, winter.filter(seasonFilter('winter')).length, winter.filter(seasonFilter('all')).length], [2, 2, 3]);
});

test('zones: nearest centre within range; the weighted set is not Carson-heavy', () => {
  assert.equal(zoneOf(39.1638, -119.7674, zoneInfo), 'carson-city');
  assert.equal(zoneOf(39.1675, -120.1424, zoneInfo), 'tahoe-city');
  assert.equal(zoneOf(38.4, -121.5, zoneInfo), 'other');
  const weighted = JSON.parse(readFileSync('bench/pairs/tahoe-sampled-weighted.json', 'utf8'));
  const old = JSON.parse(readFileSync('bench/pairs/tahoe-sampled.json', 'utf8'));
  assert.equal(weighted.pairs.length, 200);
  assert.ok(zoneShares(weighted.pairs, zoneInfo).carson < 0.3, 'weighted set origins');
  assert.ok(zoneShares(old.pairs, zoneInfo).carson > 0.55, 'the density-weighted set is Carson-heavy, which is why it stays as it is');
  assert.equal(weighted.generator.carson_origin_share, zoneShares(weighted.pairs, zoneInfo).carson);
  assert.equal(CARSON_MIN_LON, -119.86);
});

test('pair-weighted aggregates', () => {
  assert.equal(weightedQuantile([{ value: 1, weight: 1 }, { value: 2, weight: 1 }, { value: 9, weight: 8 }], 0.5), 9);
  assert.equal(weightedQuantile([{ value: 1, weight: 1 }, { value: 2, weight: 1 }], 0.5), 1);
  assert.equal(weightedQuantile([], 0.5), null);
  const r = (detour, weight) => ({ ok: true, weight, metrics: { detour, distance_km: 1, high_stress_km: 0, unpaved_km: 0, class_i_share: 0, climb_m: 0, wilderness_km: 0 }, expectations: [], same_as: [] });
  const a = computeAggregates([r(1.1, 3), r(1.8, 1), r(1.2, 0.0001), { ok: false, error: 'No route found', weight: 1, metrics: {}, expectations: [] }]);
  assert.equal(a.weighted_pathological_share, 0.4);
  assert.equal(a.weighted_median_detour, 1.1);
  const none = computeAggregates([r(1.1, null)]);
  assert.deepEqual([none.weighted_median_detour, none.weighted_pathological_share], [null, null]);
});

test('set summary: per-set rows, combined sets and a markdown table', () => {
  const route = (set, detour, extra = {}) => ({ tuning: 't', mode: '1', set, ok: true, weight: null, metrics: { detour, distance_km: 4, high_stress_km: 1, unpaved_km: 0, class_i_share: 0.5, climb_m: 20 }, expectations: [], same_as: [], ...extra });
  const routes = [route('a', 1.1), route('a', 1.7), route('b', 1.0), route('b', 1.0, { weight: 1 })];
  const s = summarize(routes.slice(0, 2));
  assert.deepEqual([s.trips, s.median_km, s.pathological, s.pathological_share, s.high_stress_share], [2, 4, 1, 0.5, 0.25]);
  const text = render({ meta: { name: 'x', created: '2026-10-19T10:00:00Z', commit: 'abc' }, tunings: [{ name: 't', modes: [{ name: '1', facets: { mode: '1', traffic: 'quiet' } }] }], routes },
    { ab: ['a', 'b'] });
  assert.match(text, /## t, mode 1 \(traffic: quiet\)/);
  assert.match(text, /\| a \| 2 \| 4\.0 /);
  assert.match(text, /\| ab \| 4 \|/);
});

// Weighted O/D points (bench/points/REGION.geojson) and a purpose-driven pair sampler.
//
// A point file is GeoJSON; every feature has properties { category, weight, zone, season?, name? }.
// The top-level `purposes` maps a trip purpose to { share, from: [categories], to: [categories] }.
// Weights compare only within a category.
//
// One pair is drawn like this:
//   1. a purpose, with probability proportional to its share (purposes whose categories are
//      missing from the file are dropped and the rest renormalised);
//   2. an origin category and a destination category, uniformly among the purpose's categories
//      that exist (category totals are not comparable, so there is no principled weight);
//   3. an origin point: a zone with probability proportional to (zone mass)^zoneAlpha, then a
//      point in it proportional to weight^weightPower. zoneAlpha < 1 is what flattens the
//      skew toward the largest towns (Carson City), 1 reproduces plain weighted sampling;
//   4. a destination point in the destination category within minKm..maxKm (straight line)
//      of the origin, proportional to weight^weightPower * exp(-distance / decayKm): a
//      gravity model, so most trips are short and the destination follows the origin.
import { readFileSync } from 'node:fs';
import { haversine } from './geo.mjs';

export function loadPoints(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (doc.type !== 'FeatureCollection') throw new Error(`${path}: not a GeoJSON FeatureCollection`);
  const points = doc.features.map((f, i) => {
    const { category, weight, zone, season, name } = f.properties ?? {};
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (!category || !Number.isFinite(weight) || !Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`${path}: feature ${i} needs a category, weight and point geometry`);
    return { index: i, category, weight, zone: zone ?? 'other', season: season ?? 'all', name, lat, lon };
  });
  return { doc, points, purposes: doc.purposes ?? {} };
}

// Seasons: 'summer' (default) keeps year-round and summer points, 'winter' year-round and
// winter points, 'all' everything.
export function seasonFilter(season) {
  if (season === 'all') return () => true;
  return p => p.season === 'all' || p.season === season;
}

function cumulative(weights) {
  let total = 0;
  const sums = weights.map(w => (total += w));
  return { sums, total };
}

function pickIndex({ sums, total }, rand) {
  const x = rand() * total;
  let lo = 0, hi = sums.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sums[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

export function createPointSampler(points, purposes, rand, { zoneAlpha = 0.5, weightPower = 0.5, decayKm = 4, minKm = 1, maxKm = 15 } = {}) {
  const categories = new Map();
  for (const p of points) {
    if (!categories.has(p.category)) categories.set(p.category, []);
    categories.get(p.category).push(p);
  }
  // Per category: zones with their points and cumulative weights, and the zone picker.
  const index = new Map();
  for (const [category, list] of categories) {
    const zones = new Map();
    for (const p of list) {
      if (!zones.has(p.zone)) zones.set(p.zone, []);
      zones.get(p.zone).push(p);
    }
    const entries = [...zones.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([zone, members]) => {
      const scores = members.map(p => Math.max(p.weight, 0) ** weightPower);
      return { zone, members, cum: cumulative(scores), mass: scores.reduce((a, b) => a + b, 0) };
    });
    index.set(category, { list, entries, zonePick: cumulative(entries.map(e => e.mass ** zoneAlpha)) });
  }

  const usable = Object.entries(purposes).map(([name, spec]) => ({ name, share: spec.share,
    from: spec.from.filter(c => index.has(c)), to: spec.to.filter(c => index.has(c)) }))
    .filter(p => p.share > 0 && p.from.length && p.to.length);
  if (!usable.length) throw new Error('No purpose has both origin and destination categories in the point file');
  const purposePick = cumulative(usable.map(p => p.share));
  const uniform = list => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

  const pickOrigin = category => {
    const entry = index.get(category);
    const zone = entry.entries[pickIndex(entry.zonePick, rand)];
    return zone.members[pickIndex(zone.cum, rand)];
  };
  const pickDestination = (category, origin) => {
    const candidates = [], scores = [];
    for (const p of index.get(category).list) {
      const km = haversine([origin.lat, origin.lon], [p.lat, p.lon]) / 1000;
      if (km < minKm || km > maxKm) continue;
      candidates.push(p);
      scores.push(Math.max(p.weight, 0) ** weightPower * Math.exp(-km / decayKm));
    }
    return candidates.length ? candidates[pickIndex(cumulative(scores), rand)] : null;
  };

  return {
    purposes: usable,
    // One draw: { purpose, from, to } or null when no destination fits (draw again).
    next() {
      const purpose = usable[pickIndex(purposePick, rand)];
      const from = pickOrigin(uniform(purpose.from));
      const to = pickDestination(uniform(purpose.to), from);
      return to ? { purpose: purpose.name, from, to } : null;
    },
  };
}

// Town zones (bench/points/REGION-zones.json): approximate centres. A location belongs to
// the nearest centre within max_km, else to 'other'.
export function loadZones(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  return { zones: doc.zones, maxKm: doc.max_km, names: Object.fromEntries(doc.zones.map(z => [z.id, z.name])) };
}

export function zoneOf(lat, lon, { zones, maxKm }) {
  let best = 'other', bestKm = maxKm;
  for (const z of zones) {
    const km = haversine([lat, lon], [z.lat, z.lon]) / 1000;
    if (km < bestKm) { best = z.id; bestKm = km; }
  }
  return best;
}

// Carson City and Carson Valley lie east of the Carson Range crest, longitude -119.86 and
// beyond (Genoa is at -119.84, Kingsbury Grade summit at -119.89, the lake's east shore at
// about -119.93). That is where most of the extract's buildings are.
export const CARSON_MIN_LON = -119.86;
export const inCarsonSide = point => point.lon >= CARSON_MIN_LON;

// Share of pairs by zone of one end ('from' or 'to'), and the share with that end on the Carson side.
export function zoneShares(pairs, zoneInfo, which = 'from') {
  const counts = {};
  for (const p of pairs) {
    const zone = zoneOf(p[which].lat, p[which].lon, zoneInfo);
    counts[zone] = (counts[zone] ?? 0) + 1;
  }
  const share = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([zone, n]) => [zone, Number((n / pairs.length).toFixed(3))]));
  return { share, carson: Number((pairs.filter(p => inCarsonSide(p[which])).length / pairs.length).toFixed(3)) };
}

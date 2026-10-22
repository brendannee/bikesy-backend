// Per-route metrics. Each metric is a small function of a context:
//
//   route     { distance_m, points: [[lat, lon]], edges: [Edge], heights: [[d, h]],
//               directions, maneuvers, ferry_retry, route_warnings }
//   shortest  the shortest rideable route for the same trip and engine (or null)
//   shortestFirm  the shortest route on compacted-or-better surfaces (or null)
//   via       [from->via, via->to] routes when the pair has a `via` point (or null)
//   references [{ points }] reference tracks (GPX) that apply to this mode
//   areas     { wilderness: polygons } from bench/areas/<region>-wilderness.geojson
//
// An Edge is a Valhalla 3.5.1 trace_attributes edge (length_m, surface, road_class, use,
// cycle_lane, shoulder, speed_limit [km/h, absent when untagged], travel_mode, names,
// way_id) plus `points`, its slice of the matched shape.
//
// To add a metric, append { name, label, unit, better, compute } to METRICS. `better`
// ('lower' | 'higher' | null) only steers delta colouring in the report. Return null when
// the metric does not apply. Expectations refer to metrics by name: max_<name>, min_<name>.
import { coverage, insideAny, haversine } from './lib/geo.mjs';

// Surface classes. Valhalla surfaces, best to worst: paved_smooth, paved, paved_rough,
// compacted, dirt, gravel, path, impassable. Untagged paths/tracks come out as "path"
// or worse, so they count as unpaved.
const PAVED = new Set(['paved_smooth', 'paved', 'paved_rough']);
export const isPaved = edge => PAVED.has(edge.surface);
export const isUnpaved = edge => !isPaved(edge);

// High-stress riding (documented in bench/README.md#metrics):
//   - any motorway, or
//   - a trunk, primary or secondary road (including its ramps and turn channels)
//     with a tagged speed limit of 45 mph (72 km/h) or more, or with neither a bike lane
//     (cycle_lane dedicated/separated) nor a shoulder.
// Walking sections and car-free paths are never high stress.
export const HIGH_STRESS_SPEED_KPH = 72;
const ARTERIALS = new Set(['trunk', 'primary', 'secondary']);
export function isHighStress(edge) {
  if (edge.travel_mode && edge.travel_mode !== 'bicycle') return false;
  if (!['road', 'ramp', 'turn_channel'].includes(edge.use ?? 'road')) return false;
  if (edge.road_class === 'motorway') return true;
  if (!ARTERIALS.has(edge.road_class)) return false;
  const lane = ['dedicated', 'separated'].includes(edge.cycle_lane);
  return (edge.speed_limit ?? 0) >= HIGH_STRESS_SPEED_KPH || (!lane && !edge.shoulder);
}

// Arterial riding: any trunk, primary or secondary road (including ramps and turn
// channels) ridden on the bike, whatever its speed limit, bike lane or shoulder. The
// complement of high stress for "avoid busy roads" questions: a 40 mph five-lane trunk
// with a bike lane is not high stress by the rule above but is still a busy road.
export function isArterial(edge) {
  if (edge.travel_mode && edge.travel_mode !== 'bicycle') return false;
  if (!['road', 'ramp', 'turn_channel'].includes(edge.use ?? 'road')) return false;
  return edge.road_class === 'motorway' || ARTERIALS.has(edge.road_class);
}

// Class I: a paved, car-free path ridden on the bike (cycleway, shared-use path or
// bike-legal footway; not sidewalks).
const CAR_FREE = new Set(['cycleway', 'path', 'footway', 'pedestrian', 'bridleway', 'mountain_bike']);
export const isClassI = edge => isPaved(edge) && CAR_FREE.has(edge.use) && (edge.travel_mode ?? 'bicycle') === 'bicycle';
export const isWalked = edge => edge.travel_mode === 'pedestrian';

// One category per edge, for map colouring.
export function stressClass(edge) {
  if (isWalked(edge)) return 'walk';
  if (isHighStress(edge)) return 'high';
  if (isClassI(edge) || CAR_FREE.has(edge.use)) return 'path';
  return 'road';
}
export const surfaceClass = edge => isPaved(edge) ? 'paved' : 'unpaved';

// Climb with a dead-band: rises shorter than `threshold` metres between reversals are
// DEM noise and ignored. Heights are a 30 m resample of the route.
export function climb(heights, threshold = 3) {
  let total = 0, anchor = null;
  for (const [, h] of heights ?? []) {
    if (!Number.isFinite(h)) continue;
    if (anchor === null) { anchor = h; continue; }
    if (h - anchor >= threshold) { total += h - anchor; anchor = h; }
    else if (anchor - h >= threshold) anchor = h;
  }
  return total;
}

const km = (edges, test) => edges.filter(test).reduce((sum, e) => sum + e.length_m, 0) / 1000;
const totalKm = edges => edges.reduce((sum, e) => sum + e.length_m, 0) / 1000;
const share = (edges, test) => totalKm(edges) ? km(edges, test) / totalKm(edges) : null;

// Length (km) of the route inside any polygon, judged at each segment's midpoint.
export function kmInside(points, polygons) {
  if (!polygons?.length) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (insideAny(polygons, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) total += haversine(a, b);
  }
  return total / 1000;
}

export const METRICS = [
  { name: 'distance_km', label: 'Distance', unit: 'km', better: 'lower',
    compute: ({ route }) => route.distance_m / 1000 },
  { name: 'detour', label: 'Detour vs shortest', unit: '×', better: 'lower',
    compute: ({ route, shortest }) => shortest?.distance_m ? route.distance_m / shortest.distance_m : null },
  { name: 'firm_detour', label: 'Detour vs shortest firm', unit: '×', better: 'lower',
    compute: ({ route, shortestFirm }) => shortestFirm?.distance_m ? route.distance_m / shortestFirm.distance_m : null },
  { name: 'climb_m', label: 'Climb', unit: 'm', better: 'lower',
    compute: ({ route }) => climb(route.heights) },
  { name: 'unpaved_km', label: 'Unpaved', unit: 'km', better: null,
    compute: ({ route }) => km(route.edges, isUnpaved) },
  { name: 'unpaved_share', label: 'Unpaved share', unit: '', better: null,
    compute: ({ route }) => share(route.edges, isUnpaved) },
  { name: 'high_stress_km', label: 'High stress', unit: 'km', better: 'lower',
    compute: ({ route }) => km(route.edges, isHighStress) },
  { name: 'high_stress_share', label: 'High-stress share', unit: '', better: 'lower',
    compute: ({ route }) => share(route.edges, isHighStress) },
  { name: 'arterial_km', label: 'Arterial', unit: 'km', better: null,
    compute: ({ route }) => km(route.edges, isArterial) },
  { name: 'arterial_share', label: 'Arterial share', unit: '', better: null,
    compute: ({ route }) => share(route.edges, isArterial) },
  { name: 'class_i_share', label: 'Class I share', unit: '', better: 'higher',
    compute: ({ route }) => share(route.edges, isClassI) },
  { name: 'wilderness_km', label: 'In wilderness', unit: 'km', better: 'lower',
    compute: ({ route, areas }) => areas?.wilderness ? kmInside(route.points, areas.wilderness) : null },
  { name: 'walk_km', label: 'Walking', unit: 'km', better: 'lower',
    compute: ({ route }) => km(route.edges, isWalked) },
  { name: 'maneuvers', label: 'Maneuvers', unit: '', better: 'lower',
    compute: ({ route }) => route.maneuvers },
  // Share of the route within 30 m of the reference track and vice versa (the smaller).
  { name: 'reference_overlap', label: 'Reference overlap', unit: '', better: 'higher',
    compute: ({ route, references }) => references?.length
      ? Math.max(...references.map(r => Math.min(coverage(route.points, r.points, 30), coverage(r.points, route.points, 30)))) : null },
  // Direct route vs the route forced through the pair's `via` point (route additivity).
  { name: 'via_ratio', label: 'Direct / via', unit: '×', better: 'lower',
    compute: ({ route, via }) => via?.every(Boolean) ? route.distance_m / (via[0].distance_m + via[1].distance_m) : null },
  { name: 'ferry_retry', label: 'Ferry retry', unit: '', better: null,
    compute: ({ route }) => route.ferry_retry ? 1 : 0 },
];

export function computeMetrics(context) {
  return Object.fromEntries(METRICS.map(m => {
    const value = m.compute(context);
    return [m.name, Number.isFinite(value) ? Number(value.toFixed(4)) : null];
  }));
}

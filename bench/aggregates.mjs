// Aggregates over the routes of one (pair set, tuning, mode). Each is a small function
// of the route results; append to AGGREGATES to add one. `better` steers delta colouring
// in the report scorecard; `format` is 'ratio', 'share', 'km', 'm', or 'count'.
//
// A route result is { trip, ok, error, metrics: {...}, expectations: [...], same_as: [...] }
// where same_as lists the other modes of the same tuning that returned the same route.
export const PATHOLOGICAL_DETOUR = 1.5;

export function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q, low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

const ok = routes => routes.filter(r => r.ok);
const metric = (routes, name) => ok(routes).map(r => r.metrics[name]).filter(Number.isFinite);
const sum = values => values.reduce((a, b) => a + b, 0);
const expectations = routes => routes.flatMap(r => r.expectations ?? []).filter(e => e.pass !== null);
export const isPathological = r => !r.ok || r.metrics.detour > PATHOLOGICAL_DETOUR;
// Also longer than 1.5x the shortest firm-surface route (or it has none): excludes cases
// where the shortest rideable route is only short because it takes tracks or trails.
export const isPathologicalFirm = r => isPathological(r) && !(r.metrics.firm_detour <= PATHOLOGICAL_DETOUR);

export const AGGREGATES = [
  { name: 'trips', label: 'Trips', format: 'count', compute: routes => routes.length },
  { name: 'no_route', label: 'No route', format: 'count', better: 'lower', compute: routes => routes.filter(r => !r.ok).length },
  { name: 'median_detour', label: 'Median detour', format: 'ratio', better: 'lower', compute: routes => quantile(metric(routes, 'detour'), 0.5) },
  { name: 'p90_detour', label: 'p90 detour', format: 'ratio', better: 'lower', compute: routes => quantile(metric(routes, 'detour'), 0.9) },
  { name: 'pathological', label: `No route or detour > ${PATHOLOGICAL_DETOUR}×`, format: 'count', better: 'lower', compute: routes => routes.filter(isPathological).length },
  { name: 'pathological_firm', label: 'Of those, also > 1.5× shortest firm', format: 'count', better: 'lower', compute: routes => routes.filter(isPathologicalFirm).length },
  { name: 'distance_km', label: 'Total distance', format: 'km', better: null, compute: routes => sum(metric(routes, 'distance_km')) },
  { name: 'high_stress_km', label: 'High-stress km', format: 'km', better: 'lower', compute: routes => sum(metric(routes, 'high_stress_km')) },
  { name: 'high_stress_share', label: 'High-stress share', format: 'share', better: 'lower',
    compute: routes => sum(metric(routes, 'distance_km')) ? sum(metric(routes, 'high_stress_km')) / sum(metric(routes, 'distance_km')) : null },
  { name: 'unpaved_share', label: 'Unpaved share', format: 'share', better: null,
    compute: routes => sum(metric(routes, 'distance_km')) ? sum(metric(routes, 'unpaved_km')) / sum(metric(routes, 'distance_km')) : null },
  { name: 'class_i_share', label: 'Class I share (mean)', format: 'share', better: 'higher',
    compute: routes => metric(routes, 'class_i_share').length ? sum(metric(routes, 'class_i_share')) / metric(routes, 'class_i_share').length : null },
  { name: 'median_climb_m', label: 'Median climb', format: 'm', better: 'lower', compute: routes => quantile(metric(routes, 'climb_m'), 0.5) },
  { name: 'wilderness_km', label: 'Wilderness km', format: 'km', better: 'lower', compute: routes => sum(metric(routes, 'wilderness_km')) },
  { name: 'expectations', label: 'Expectations checked', format: 'count', compute: routes => expectations(routes).length },
  { name: 'expectation_pass_rate', label: 'Expectation pass rate', format: 'share', better: 'higher',
    compute: routes => expectations(routes).length ? expectations(routes).filter(e => e.pass).length / expectations(routes).length : null },
  // Mode separation: how often this mode's route equals another mode's route.
  { name: 'same_route_share', label: 'Same route as another mode', format: 'share', better: null,
    compute: routes => ok(routes).length ? ok(routes).filter(r => r.same_as?.length).length / ok(routes).length : null },
];

export function computeAggregates(routes) {
  return Object.fromEntries(AGGREGATES.map(a => {
    const value = a.compute(routes);
    return [a.name, Number.isFinite(value) ? Number(value.toFixed(4)) : null];
  }));
}

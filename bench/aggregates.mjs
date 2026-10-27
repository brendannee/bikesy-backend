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

// Weighted statistics for pair sets whose pairs carry a `weight` (the realistic set): a route
// result's weight is its pair's. Null when no route has a weight.
export function weightedQuantile(items, q) {
  const sorted = items.filter(i => Number.isFinite(i.value) && i.weight > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  if (!total) return null;
  let seen = 0;
  for (const item of sorted) { seen += item.weight; if (seen >= q * total - 1e-12) return item.value; }
  return sorted.at(-1).value;
}
const weighted = routes => routes.filter(r => r.weight > 0);

const ok = routes => routes.filter(r => r.ok);
const metric = (routes, name) => ok(routes).map(r => r.metrics[name]).filter(Number.isFinite);
const sum = values => values.reduce((a, b) => a + b, 0);
const expectations = routes => routes.flatMap(r => r.expectations ?? []).filter(e => e.pass !== null);
export const isPathological = r => !r.ok || r.metrics.detour > PATHOLOGICAL_DETOUR;
// Also longer than 1.5x the shortest firm-surface route (or it has none): excludes cases
// where the shortest rideable route is only short because it takes tracks or trails.
export const isPathologicalFirm = r => isPathological(r) && !(r.metrics.firm_detour <= PATHOLOGICAL_DETOUR);

// Cross-scenario metrics: each Avoid Busy (traffic 'quiet') route is compared with its Fastest
// ('busy') twin: the route of the same tuning and trip in the mode with the same hills and
// surface facets. Stored on the quiet route result as `vs_fastest` (null without a twin).
export const MIN_BUSY_KM = 0.3, DETOUR_BOUGHT_NOTHING = 1.3, DID_NOT_AVOID = 0.5, DID_NOT_AVOID_MIN_FASTEST_KM = 1;
export function fastestTwinMetrics(quiet, fastest) {
  if (!quiet.ok || !fastest?.ok) return null;
  const q = quiet.metrics, f = fastest.metrics;
  if (!Number.isFinite(q.distance_km) || !f.distance_km || !Number.isFinite(q.busy_km) || !Number.isFinite(f.busy_km)) return null;
  const avoided = f.busy_km - q.busy_km;
  return { twin: fastest.mode, fastest_busy_km: f.busy_km, detour_vs_fastest: q.distance_km / f.distance_km,
    busy_avoided_km: avoided,
    residual_busy_share: f.busy_km >= MIN_BUSY_KM ? q.busy_km / f.busy_km : null,
    avoidance_efficiency: avoided >= MIN_BUSY_KM ? (q.distance_km - f.distance_km) / avoided : null };
}

// Problems of an Avoid Busy route judged against its Fastest twin (`vs` = its vs_fastest;
// `fastestBusyKm` falls back to the twin's busy km for results saved before it was stored):
// "did not avoid" = still over half of Fastest's busy km, where Fastest has at least 1 km;
// "detour bought nothing" = over 1.3x Fastest's distance for under 0.3 busy km avoided.
export function avoidBusyProblems(vs, fastestBusyKm = vs?.fastest_busy_km) {
  if (!vs) return [];
  const flags = [];
  if (vs.residual_busy_share > DID_NOT_AVOID && fastestBusyKm >= DID_NOT_AVOID_MIN_FASTEST_KM)
    flags.push(`did not avoid: ${(vs.residual_busy_share * 100).toFixed(0)}% of Fastest's ${fastestBusyKm.toFixed(1)} busy km left`);
  if (vs.busy_avoided_km < MIN_BUSY_KM && vs.detour_vs_fastest > DETOUR_BOUGHT_NOTHING)
    flags.push(`detour bought nothing: ${vs.detour_vs_fastest.toFixed(2)}x Fastest, ${vs.busy_avoided_km.toFixed(2)} busy km avoided`);
  return flags;
}

export function attachFastestTwins(results, tunings) {
  const modes = new Map(tunings.flatMap(t => t.modes.map(m => [`${t.name}|${m.name}`, m.facets])));
  const byKey = new Map();
  for (const r of results) byKey.set(`${r.tuning}|${r.trip}|${r.mode}`, r);
  for (const r of results) {
    const facets = modes.get(`${r.tuning}|${r.mode}`);
    if (facets?.traffic !== 'quiet') continue;
    const twin = tunings.find(t => t.name === r.tuning).modes.find(m => m.facets.traffic === 'busy' && m.facets.hills === facets.hills && m.facets.surface === facets.surface);
    r.vs_fastest = twin ? fastestTwinMetrics(r, byKey.get(`${r.tuning}|${r.trip}|${twin.name}`)) : null;
  }
}
const twin = (routes, key) => routes.filter(r => r.ok && r.vs_fastest).map(r => r.vs_fastest[key]).filter(Number.isFinite);
const mean = values => values.length ? sum(values) / values.length : null;
const twinShare = (routes, test) => { const t = routes.filter(r => r.ok && r.vs_fastest); return t.length ? t.filter(r => test(r.vs_fastest)).length / t.length : null; };

export const AGGREGATES = [
  { name: 'trips', label: 'Trips', format: 'count', compute: routes => routes.length },
  { name: 'no_route', label: 'No route', format: 'count', better: 'lower', compute: routes => routes.filter(r => !r.ok).length },
  { name: 'median_detour', label: 'Median detour', format: 'ratio', better: 'lower', compute: routes => quantile(metric(routes, 'detour'), 0.5) },
  { name: 'p90_detour', label: 'p90 detour', format: 'ratio', better: 'lower', compute: routes => quantile(metric(routes, 'detour'), 0.9) },
  { name: 'pathological', label: `No route or detour > ${PATHOLOGICAL_DETOUR}× (informational for Avoid Busy)`, format: 'count', better: 'lower', compute: routes => routes.filter(isPathological).length },
  { name: 'pathological_firm', label: 'Of those, also > 1.5× shortest firm', format: 'count', better: 'lower', compute: routes => routes.filter(isPathologicalFirm).length },
  { name: 'weighted_median_detour', label: 'Median detour (pair-weighted)', format: 'ratio', better: 'lower',
    compute: routes => weightedQuantile(ok(weighted(routes)).map(r => ({ value: r.metrics.detour, weight: r.weight })), 0.5) },
  { name: 'weighted_pathological_share', label: 'Pathological (pair-weighted)', format: 'share', better: 'lower',
    compute: routes => weighted(routes).length ? sum(weighted(routes).filter(isPathological).map(r => r.weight)) / sum(weighted(routes).map(r => r.weight)) : null },
  { name: 'distance_km', label: 'Total distance', format: 'km', better: null, compute: routes => sum(metric(routes, 'distance_km')) },
  { name: 'high_stress_km', label: 'High-stress km', format: 'km', better: 'lower', compute: routes => sum(metric(routes, 'high_stress_km')) },
  { name: 'high_stress_share', label: 'High-stress share', format: 'share', better: 'lower',
    compute: routes => sum(metric(routes, 'distance_km')) ? sum(metric(routes, 'high_stress_km')) / sum(metric(routes, 'distance_km')) : null },
  { name: 'arterial_share', label: 'Arterial share', format: 'share', better: null,
    compute: routes => sum(metric(routes, 'distance_km')) ? sum(metric(routes, 'arterial_km')) / sum(metric(routes, 'distance_km')) : null },
  { name: 'busy_km', label: 'Busy-road km', format: 'km', better: 'lower', compute: routes => sum(metric(routes, 'busy_km')) },
  { name: 'busy_share', label: 'Busy-road share', format: 'share', better: 'lower',
    compute: routes => sum(metric(routes, 'distance_km')) ? sum(metric(routes, 'busy_km')) / sum(metric(routes, 'distance_km')) : null },
  { name: 'busy_lowdensity_share', label: 'Busy km at density < 5', format: 'share', better: 'lower',
    compute: routes => sum(metric(routes, 'busy_km')) ? sum(metric(routes, 'busy_lowdensity_km')) / sum(metric(routes, 'busy_km')) : null },
  // Avoid Busy routes against their Fastest twin (see fastestTwinMetrics); null for other modes.
  { name: 'median_detour_vs_fastest', label: 'Median detour vs Fastest', format: 'ratio', better: 'lower', compute: routes => quantile(twin(routes, 'detour_vs_fastest'), 0.5) },
  { name: 'p90_detour_vs_fastest', label: 'p90 detour vs Fastest', format: 'ratio', better: 'lower', compute: routes => quantile(twin(routes, 'detour_vs_fastest'), 0.9) },
  { name: 'mean_residual_busy_share', label: 'Mean residual busy share', format: 'share', better: 'lower', compute: routes => mean(twin(routes, 'residual_busy_share')) },
  { name: 'did_not_avoid_share', label: `Still > ${DID_NOT_AVOID * 100}% of Fastest busy km`, format: 'share', better: 'lower',
    compute: routes => { const t = routes.filter(r => r.ok && r.vs_fastest && Number.isFinite(r.vs_fastest.residual_busy_share)); return t.length ? t.filter(r => r.vs_fastest.residual_busy_share > DID_NOT_AVOID).length / t.length : null; } },
  { name: 'detour_bought_nothing_share', label: 'Detour > 1.3x, < 0.3 busy km avoided', format: 'share', better: 'lower',
    compute: routes => twinShare(routes, v => v.busy_avoided_km < MIN_BUSY_KM && v.detour_vs_fastest > DETOUR_BOUGHT_NOTHING) },
  { name: 'median_avoidance_efficiency', label: 'Median extra km per busy km avoided', format: 'ratio', better: 'lower', compute: routes => quantile(twin(routes, 'avoidance_efficiency'), 0.5) },
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

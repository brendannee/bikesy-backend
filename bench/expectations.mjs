// Expectations on curated pairs. Each entry in a pair's `expect` list selects modes by
// facets and states limits on metrics by name:
//
//   { "modes": {"traffic": "quiet"}, "min_class_i_share": 0.5 }
//   { "modes": "*", "direction": "forward", "max_detour": 1.25, "note": "..." }
//
// Keys are max_<metric> or min_<metric> (see bench/metrics.mjs), plus "route": false to
// expect no route. A missing route fails every limit; a metric that does not apply (null,
// e.g. no reference track) is reported as skipped (pass: null).
import { matchesModes } from './lib/catalog.mjs';

const RESERVED = new Set(['modes', 'direction', 'note']);

export function evaluateExpectations(trip, mode, result) {
  const outcomes = [];
  for (const [index, entry] of (trip.pair.expect ?? []).entries()) {
    if (!matchesModes(entry.modes, mode.facets)) continue;
    if (entry.direction && entry.direction !== trip.direction) continue;
    for (const [key, limit] of Object.entries(entry)) {
      if (RESERVED.has(key)) continue;
      if (key === 'route') {
        outcomes.push({ index, key, limit, value: !result.error, pass: !result.error === limit, note: entry.note });
        continue;
      }
      const match = /^(min|max)_(.+)$/.exec(key);
      if (!match) throw new Error(`Pair ${trip.pair.id}: unknown expectation key ${key}`);
      const [, op, metric] = match;
      const value = result.error ? null : result.metrics[metric];
      if (!result.error && !(metric in result.metrics)) throw new Error(`Pair ${trip.pair.id}: unknown metric ${metric}`);
      const pass = result.error ? false : value === null ? null : op === 'min' ? value >= limit : value <= limit;
      outcomes.push({ index, key, limit, value, pass, note: entry.note });
    }
  }
  return outcomes;
}

#!/usr/bin/env node
// Markdown tables comparing pair sets in a run, per tuning and mode, so a new set can be
// judged against the old ones. Sets can be combined: --combine NAME=SET+SET (e.g.
// realistic-all=realistic+realistic-restricted). Writes summary.md in the run directory.
//   node bench/set-summary.mjs RUN_DIR [--combine NAME=SET+SET ...] [--out FILE]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { computeAggregates, isPathological, quantile } from './aggregates.mjs';

const FORMATS = { ratio: v => v.toFixed(3), share: v => `${(v * 100).toFixed(1)}%`, km: v => v.toFixed(1), count: v => String(v) };
const cell = (v, format = 'ratio') => (v === null || v === undefined ? '-' : FORMATS[format](v));

export function summarize(routes) {
  const ok = routes.filter(r => r.ok);
  const a = computeAggregates(routes);
  return { trips: routes.length, no_route: a.no_route, median_km: quantile(ok.map(r => r.metrics.distance_km), 0.5),
    median_climb_m: a.median_climb_m, median_detour: a.median_detour, p90_detour: a.p90_detour,
    pathological: a.pathological, pathological_share: routes.length ? routes.filter(isPathological).length / routes.length : null,
    pathological_firm: a.pathological_firm, high_stress_share: a.high_stress_share, unpaved_share: a.unpaved_share,
    class_i_share: a.class_i_share, same_route_share: a.same_route_share,
    weighted_median_detour: a.weighted_median_detour, weighted_pathological_share: a.weighted_pathological_share };
}

const COLUMNS = [['trips', 'Trips', 'count'], ['median_km', 'Median km', 'km'], ['median_climb_m', 'Median climb m', 'km'], ['median_detour', 'Median detour', 'ratio'],
  ['p90_detour', 'p90 detour', 'ratio'], ['pathological', 'Detour > 1.5x', 'count'], ['pathological_share', 'Share', 'share'], ['pathological_firm', 'And > 1.5x firm', 'count'],
  ['high_stress_share', 'High-stress km', 'share'], ['unpaved_share', 'Unpaved km', 'share'], ['class_i_share', 'Class I', 'share'], ['same_route_share', 'Same as other mode', 'share'],
  ['weighted_median_detour', 'Weighted median detour', 'ratio'], ['weighted_pathological_share', 'Weighted > 1.5x', 'share']];

export function render(results, combines = {}) {
  const sets = [...new Set(results.routes.map(r => r.set))];
  const groups = [...sets.map(s => [s, [s]]), ...Object.entries(combines)];
  const lines = [`# ${results.meta.name}: pair sets compared`, '',
    `Run ${results.meta.created.slice(0, 16).replace('T', ' ')} UTC at ${results.meta.commit}. Pathological = no route or detour over 1.5x the shortest rideable route; "and > 1.5x firm" also exceeds 1.5x the shortest firm-surface route. Trips are pair x direction. Shares of km are by route length.`, ''];
  for (const tuning of results.tunings) {
    for (const mode of tuning.modes) {
      lines.push(`## ${tuning.name}, mode ${mode.name} (${Object.entries(mode.facets).filter(([k]) => k !== 'mode').map(([k, v]) => `${k}: ${v}`).join(', ')})`, '',
        `| Set | ${COLUMNS.map(c => c[1]).join(' | ')} |`, `|---|${COLUMNS.map(() => '---:').join('|')}|`);
      for (const [name, members] of groups) {
        const routes = results.routes.filter(r => r.tuning === tuning.name && r.mode === mode.name && members.includes(r.set));
        if (!routes.length) continue;
        const s = summarize(routes);
        lines.push(`| ${name} | ${COLUMNS.map(([key, , format]) => cell(s[key], format)).join(' | ')} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { combine: { type: 'string', multiple: true }, out: { type: 'string' } } });
  if (!positionals[0]) { console.error('Usage: node bench/set-summary.mjs RUN_DIR [--combine NAME=SET+SET ...] [--out FILE]'); process.exit(2); }
  const dir = resolve(positionals[0]);
  const results = JSON.parse(readFileSync(resolve(dir, 'results.json'), 'utf8'));
  const combines = Object.fromEntries((values.combine ?? []).map(spec => { const [name, sets] = spec.split('='); return [name, sets.split('+')]; }));
  const out = resolve(values.out ?? resolve(dir, 'summary.md'));
  writeFileSync(out, render(results, combines) + '\n');
  console.log(`Wrote ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

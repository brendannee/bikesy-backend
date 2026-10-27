#!/usr/bin/env node
// Re-evaluate a saved run against the current pair expectations and the Avoid Busy flags,
// without rerouting: reads RUN_DIR/results.json, takes expectations from the current pairs
// files, and prints failures per tuning. Writes nothing.
//   node bench/reeval.mjs RUN_DIR [--region REGION] [--verbose]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { attachFastestTwins, avoidBusyProblems } from './aggregates.mjs';
import { evaluateExpectations } from './expectations.mjs';
import { loadCatalogs } from './lib/catalog.mjs';

export function reevaluate(results, catalogs) {
  const pairs = new Map(catalogs.flatMap(c => c.pairs.map(p => [`${c.set}/${p.id}`, p])));
  const modes = new Map(results.tunings.flatMap(t => t.modes.map(m => [`${t.name}|${m.name}`, m])));
  const byKey = new Map(results.routes.map(r => [`${r.tuning}|${r.trip}|${r.mode}`, r]));
  attachFastestTwins(results.routes, results.tunings);
  const failures = [];
  for (const r of results.routes) {
    const pair = pairs.get(`${r.set}/${r.pair}`);
    r.expectations = pair ? evaluateExpectations({ pair, direction: r.direction }, modes.get(`${r.tuning}|${r.mode}`), r) : [];
    for (const e of r.expectations) if (e.pass === false) failures.push({ tuning: r.tuning, mode: r.mode, trip: r.trip, text: `${e.key} ${e.limit} (got ${e.value ?? 'no route'})` });
    const fastest = r.vs_fastest ? byKey.get(`${r.tuning}|${r.trip}|${r.vs_fastest.twin}`) : null;
    for (const flag of avoidBusyProblems(r.vs_fastest, fastest?.metrics.busy_km)) failures.push({ tuning: r.tuning, mode: r.mode, trip: r.trip, text: flag, flag: true });
  }
  return failures;
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { region: { type: 'string' }, verbose: { type: 'boolean' } } });
  if (!positionals[0]) { console.error('Usage: node bench/reeval.mjs RUN_DIR [--region REGION] [--verbose]'); process.exit(2); }
  const results = JSON.parse(readFileSync(resolve(positionals[0], 'results.json'), 'utf8'));
  const sets = results.meta.sets.map(s => s.set).filter(s => !s.includes('/'));
  const catalogs = loadCatalogs(values.region ?? results.meta.region, { sets: [...new Set(sets)] });
  const failures = reevaluate(results, catalogs);
  for (const t of results.tunings) {
    const mine = failures.filter(f => f.tuning === t.name);
    const checked = results.routes.filter(r => r.tuning === t.name).flatMap(r => r.expectations).filter(e => e.pass !== null).length;
    console.log(`\n${t.name}: ${checked - mine.filter(f => !f.flag).length}/${checked} expectations pass, ${mine.filter(f => f.flag).length} Avoid Busy flags`);
    for (const f of mine) console.log(`  ${f.flag ? 'FLAG' : 'FAIL'} ${f.trip} mode ${f.mode}: ${f.text}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

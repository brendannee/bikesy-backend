#!/usr/bin/env node
// Compare two tunings of one run route by route, using the hash of the user-visible
// response (directions, path, total_distance, elevation_profile, route_warnings).
// With a local tuning and an API tuning over the same scenarios, identical hashes prove
// the bench reproduces production exactly.
//   node bench/run.mjs --region tahoe --tuning config --tuning deployed --sets curated --limit 3 --name crosscheck
//   node bench/crosscheck.mjs RUN_DIR [--a config] [--b deployed]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { a: { type: 'string' }, b: { type: 'string' } } });
if (!positionals[0]) { console.error('Usage: node bench/crosscheck.mjs RUN_DIR [--a TUNING] [--b TUNING]'); process.exit(2); }
const { routes } = JSON.parse(readFileSync(resolve(positionals[0], 'results.json'), 'utf8'));
const a = values.a ?? 'config', b = values.b ?? 'deployed';
const index = new Map(routes.filter(r => r.tuning === b).map(r => [`${r.mode}|${r.trip}`, r]));
let same = 0, different = 0;
for (const r of routes.filter(r => r.tuning === a)) {
  const o = index.get(`${r.mode}|${r.trip}`);
  if (!o) continue;
  const match = r.ok && o.ok ? r.response_sha256 === o.response_sha256 : r.error === o.error;
  match ? same++ : different++;
  console.log(`${match ? 'same     ' : 'DIFFERENT'} mode ${r.mode} ${r.trip}: ${r.ok ? r.reported_distance_m?.toFixed(1) + ' m' : r.error} vs ${o.ok ? o.reported_distance_m?.toFixed(1) + ' m' : o.error}`);
}
console.log(`${same} identical, ${different} different (${a} vs ${b})`);
process.exit(different ? 1 : 0);

#!/usr/bin/env node
// Check that every pair endpoint snaps to a routable bicycle edge within --snap-m metres
// (Valhalla /locate on a running bench engine), the same rule the samplers apply.
//   node bench/check-pairs.mjs --region tahoe [--sets realistic,sampled-weighted] [--pairs-file [NAME=]FILE ...]
//       [--valhalla URL] [--snap-m 150] [--fix]
// Without --fix it only reports. With --fix it rewrites each catalog: endpoints that snap are
// replaced by the snapped point (as the samplers store them) and pairs with an endpoint that
// does not snap are dropped, listed under "dropped_unsnappable" in the file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { pairSetPath, stringifyCatalog } from './lib/catalog.mjs';
import { SNAP_METERS, snapToBicycleEdge } from './lib/locate.mjs';

export async function checkCatalog(valhalla, catalog, snapM = SNAP_METERS) {
  const keys = ['from', 'to', 'via'];
  const jobs = catalog.pairs.flatMap(pair => keys.filter(k => pair[k]).map(k => ({ pair, key: k })));
  for (let i = 0; i < jobs.length; i += 100) {
    const chunk = jobs.slice(i, i + 100);
    const snapped = await snapToBicycleEdge(valhalla, chunk.map(({ pair, key }) => [pair[key].lat, pair[key].lon]));
    chunk.forEach((job, j) => { job.snap = snapped[j]; });
  }
  const bad = [], fine = [];
  for (const pair of catalog.pairs) {
    const mine = jobs.filter(j => j.pair === pair);
    const failures = mine.filter(j => !j.snap || j.snap.distance > snapM);
    (failures.length ? bad : fine).push({ pair, jobs: mine, failures });
  }
  return { fine, bad, maxSnap: Math.max(0, ...jobs.map(j => j.snap?.distance ?? 0)) };
}

async function main() {
  const { values } = parseArgs({ options: { region: { type: 'string' }, sets: { type: 'string' }, 'pairs-file': { type: 'string', multiple: true },
    valhalla: { type: 'string' }, 'snap-m': { type: 'string' }, fix: { type: 'boolean' } } });
  if (!values.region) { console.error('Usage: node bench/check-pairs.mjs --region REGION [--sets A,B] [--pairs-file [NAME=]FILE] [--valhalla URL] [--snap-m 150] [--fix]'); process.exit(2); }
  const valhalla = (values.valhalla ?? 'http://127.0.0.1:18002/').replace(/\/?$/, '/');
  const snapM = Number(values['snap-m'] ?? SNAP_METERS);
  const files = [...(values.sets ?? 'realistic').split(',').filter(Boolean).map(set => ({ label: set, path: pairSetPath(values.region, set) })),
    ...(values['pairs-file'] ?? []).map(spec => { const [, name, path] = /^(?:([\w-]+)=)?(.+)$/.exec(spec); return { label: name ?? path, path }; })];
  let failed = false;
  for (const { label, path } of files) {
    if (!existsSync(path)) { console.error(`${label}: ${path} not found`); failed = true; continue; }
    const catalog = JSON.parse(readFileSync(path, 'utf8'));
    const { fine, bad, maxSnap } = await checkCatalog(valhalla, catalog, snapM);
    console.log(`${label}: ${fine.length}/${catalog.pairs.length} pairs snap within ${snapM} m (largest snap ${maxSnap.toFixed(0)} m)`);
    for (const { pair, failures } of bad) {
      console.log(`  ${pair.id}: ${failures.map(f => `${f.key} ${f.snap ? f.snap.distance.toFixed(0) + ' m' : 'no edge'}`).join(', ')}`);
    }
    if (bad.length) failed = true;
    if (values.fix) {
      for (const { pair, jobs } of fine) for (const { key, snap } of jobs) pair[key] = { lat: snap.point[0], lon: snap.point[1] };
      catalog.pairs = fine.map(f => f.pair);
      if (bad.length) {
        catalog.dropped_unsnappable = [...(catalog.dropped_unsnappable ?? []), ...bad.map(b => ({ id: b.pair.id, name: b.pair.name }))];
        catalog.notes = `${catalog.notes ?? ''} ${bad.length} pair${bad.length === 1 ? '' : 's'} dropped by check-pairs (an endpoint had no bicycle edge within ${snapM} m); remaining endpoints are stored snapped.`.trim();
      }
      writeFileSync(path, stringifyCatalog(catalog));
      console.log(`  rewrote ${path}: snapped points stored, ${bad.length} dropped`);
    }
  }
  process.exit(failed && !values.fix ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.stack ?? error.message); process.exit(1); });
}

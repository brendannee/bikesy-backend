#!/usr/bin/env node
// Manage bench engine containers by hand (bench/run.mjs starts and stops them itself).
//   node bench/engine.mjs start --image IMAGE [--policy FILE] [--port 18002]
//   node bench/engine.mjs stop [--image IMAGE --policy FILE | --name bench-...]
//   node bench/engine.mjs status
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BENCH_DIR } from './lib/catalog.mjs';
import { containerName, engineIdentity, listEngines, startEngine, stopEngine } from './lib/engine.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  image: { type: 'string' }, policy: { type: 'string' }, port: { type: 'string' }, name: { type: 'string' },
  threads: { type: 'string' }, cache: { type: 'string' },
} });
const command = positionals[0] ?? 'status';
const image = values.image ?? process.env.BIKESY_BENCH_IMAGE;
const cacheDir = resolve(values.cache ?? resolve(process.env.BIKESY_BENCH_DIR ?? resolve(BENCH_DIR, 'out'), 'cache'));

if (command === 'start') {
  const identity = engineIdentity({ image, policy: values.policy && resolve(values.policy) });
  const engine = await startEngine(identity, { port: Number(values.port ?? 18002), cacheDir, name: values.name,
    threads: Number(values.threads ?? 2) });
  console.log(`${engine.reused ? 'Reusing' : 'Started'} ${engine.name} at ${engine.url} (Valhalla ${engine.status.version})`);
} else if (command === 'stop') {
  const name = values.name ?? containerName(engineIdentity({ image, policy: values.policy && resolve(values.policy) }));
  stopEngine(name);
  console.log(`Removed ${name}`);
} else if (command === 'status') {
  const rows = listEngines();
  console.log(rows.length ? rows.join('\n') : 'No bench engine containers');
} else {
  console.error('Usage: node bench/engine.mjs start|stop|status [--image IMAGE] [--policy FILE] [--port N] [--name NAME]');
  process.exit(2);
}

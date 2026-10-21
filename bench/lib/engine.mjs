// Local engine containers for the bench. The production entrypoint (serve.mjs) verifies
// data hashes, so the bench starts valhalla_service directly instead, with:
//   - a copy of the image's /data/valhalla.json that listens on all interfaces and also
//     enables locate/trace_attributes/trace_route (routing settings are untouched);
//   - BIKESY_POLICY_DATA / BIKESY_STAIRS_DATA set as serve.mjs sets them, optionally
//     pointing the policy at a mounted override file (hill-cost experiments).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 << 20, ...options }).trim();
const PLATFORM = 'linux/amd64';

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Stable identity for cache keys: the local image ID plus the policy actually loaded.
export function engineIdentity({ image, policy }) {
  if (!image) throw new Error('No data image: pass --image, set BIKESY_BENCH_IMAGE or set engine.image in the tuning');
  let imageId;
  try { imageId = docker(['image', 'inspect', '--format', '{{.Id}}', image]); } catch {
    throw new Error(`Docker image ${image} is not available locally; pull it first`);
  }
  return { image, imageId, policy: policy ?? null, policySha256: policy ? sha256File(policy) : 'image',
    key: `${imageId}:${policy ? sha256File(policy) : 'image'}` };
}

// One container per engine identity and port, so runs on different ports (other people's
// benchmarks on the same machine) never replace each other's containers.
export const DEFAULT_PORT = 18002;
export function containerName(identity, port = DEFAULT_PORT) {
  return 'bench-' + createHash('sha256').update(identity.key).digest('hex').slice(0, 10) + (port === DEFAULT_PORT ? '' : `-p${port}`);
}

// Write the bench copy of the image's Valhalla config into the cache directory.
function benchConfig(image, cacheDir) {
  const config = JSON.parse(docker(['run', '--rm', '--platform', PLATFORM, '--entrypoint', 'cat', image, '/data/valhalla.json']));
  config.httpd.service.listen = 'tcp://*:8002';
  config.loki.actions = [...new Set([...config.loki.actions, 'locate', 'trace_attributes', 'trace_route'])];
  const dir = resolve(cacheDir, 'engine');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, createHash('sha256').update(image).digest('hex').slice(0, 12) + '-valhalla.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

// Data release details from the image, recorded in run metadata.
export function imagePolicy(image) {
  try { return JSON.parse(docker(['run', '--rm', '--platform', PLATFORM, '--entrypoint', 'cat', image, '/data/engine-policy.json'])); } catch { return null; }
}

export async function waitForEngine(url, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('status', url), { signal: AbortSignal.timeout(2000) });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Engine at ${url} did not become ready`);
}

export function isRunning(name) {
  try { return docker(['inspect', '--format', '{{.State.Running}}', name], { stdio: ['ignore', 'pipe', 'ignore'] }) === 'true'; } catch { return false; }
}

// Start (or reuse) a container for this engine identity on 127.0.0.1:<port>.
export async function startEngine(identity, { port = DEFAULT_PORT, cacheDir, name = containerName(identity, port), threads = 2, memory = '2g', cpus = '2' } = {}) {
  if (!name.startsWith('bench-')) throw new Error('Bench container names must start with bench-');
  const url = `http://127.0.0.1:${port}/`;
  if (isRunning(name)) {
    const status = await waitForEngine(url, 10000).catch(() => null);
    if (status) return { name, url, status, reused: true };
  }
  // Free the port from any other bench engine (a different image or policy).
  const others = docker(['ps', '-aq', '--filter', 'name=^bench-', '--filter', `publish=${port}`]);
  for (const id of [name, ...others.split('\n').filter(Boolean)]) {
    try { docker(['rm', '-f', id], { stdio: 'ignore' }); } catch {}
  }
  const config = benchConfig(identity.image, cacheDir);
  const policy = identity.policy ? ['-v', `${identity.policy}:/bench/bikesy-policy.bin:ro`] : [];
  docker(['run', '-d', '--name', name, '--platform', PLATFORM, '--memory', memory, '--cpus', String(cpus),
    '-p', `127.0.0.1:${port}:8002`, '-v', `${config}:/bench/valhalla.json:ro`, ...policy,
    '-e', `BIKESY_POLICY_DATA=${identity.policy ? '/bench/bikesy-policy.bin' : '/data/bikesy-policy.bin'}`,
    '-e', 'BIKESY_STAIRS_DATA=/data/bikesy-stairs.txt',
    '--label', `bikesy-bench-engine=${identity.key}`,
    '--entrypoint', 'valhalla_service', identity.image, '/bench/valhalla.json', String(threads)]);
  try {
    return { name, url, status: await waitForEngine(url), reused: false };
  } catch (error) {
    const logs = (() => { try { return docker(['logs', '--tail', '20', name], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return ''; } })();
    throw new Error(`${error.message}\n${logs}`);
  }
}

export function stopEngine(name) {
  if (!name.startsWith('bench-')) throw new Error('Refusing to stop a non-bench container');
  try { docker(['rm', '-f', name], { stdio: 'ignore' }); } catch {}
}

export function listEngines() {
  const out = docker(['ps', '-a', '--filter', 'name=^bench-', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Label "bikesy-bench-engine"}}']);
  return out ? out.split('\n') : [];
}

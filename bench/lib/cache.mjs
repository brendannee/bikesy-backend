// Content-addressed JSON cache: one file per request hash, so runs are resumable and
// re-running with changed metrics does not re-route. Bump VERSION to invalidate.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const VERSION = 1;

// JSON with sorted object keys, so equal requests hash equally.
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashKey(value) {
  return createHash('sha256').update(stableJson({ v: VERSION, ...value })).digest('hex');
}

export function createCache(dir) {
  const pathFor = key => resolve(dir, key.slice(0, 2), `${key}.json`);
  return {
    dir,
    get(key) {
      const path = pathFor(key);
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    },
    set(key, value) {
      const path = pathFor(key);
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(path + '.tmp', JSON.stringify(value));
      renameSync(path + '.tmp', path);
      return value;
    },
    // Compute once per key; failures that are worth retrying should throw instead of returning.
    async memo(key, compute) {
      const hit = this.get(key);
      if (hit !== undefined) return { ...hit, cached: true };
      return this.set(key, await compute());
    },
  };
}

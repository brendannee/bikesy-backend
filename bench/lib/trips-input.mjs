// Parsers and pair builders behind bench/add-trips.mjs: pasted newmap share links, CSV
// rows and GPX tracks become pairs in the catalog schema (see bench/README.md#pair-catalogs).
// Pure functions where possible so they can be tested without files or network.
import { haversine, lineLength, parseGpx, simplify } from './geo.mjs';
import { zoneOf } from './points.mjs';

// ---------------------------------------------------------------- share links
const COORDINATE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

function decode(text) {
  try { return decodeURIComponent(text.replace(/\+/g, '%20')); } catch { return text; }
}

// Share links carry the trip in the URL fragment:
//   newmap.tahoebike.org:  #<startAddr>/<lng,lat>/<endAddr>/<lng,lat>/<scenario>
//   map.tahoebike.org (legacy): #<startAddr>/<endAddr>/<scenario>   (addresses only, no coordinates)
// Returns { start: {lat, lon} | null, end, startAddr, endAddr, scenario, format, host }.
export function parseShareLink(url) {
  let parsed;
  try { parsed = new URL(url.trim()); } catch { throw new Error('not a URL'); }
  const fragment = parsed.hash.replace(/^#\/?/, '').replace(/\/$/, '');
  const parts = fragment ? fragment.split('/').map(decode) : [];
  const point = text => {
    const m = COORDINATE.exec(text);
    if (!m) return null;
    const lon = Number(m[1]), lat = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  };
  if (parts.length >= 4 && point(parts[1]) && point(parts[3])) {
    return { startAddr: parts[0], start: point(parts[1]), endAddr: parts[2], end: point(parts[3]), scenario: parts[4] || null, format: 'newmap', host: parsed.host };
  }
  if (parts.length >= 2) return { startAddr: parts[0], start: null, endAddr: parts[1], end: null, scenario: parts[2] || null, format: 'legacy', host: parsed.host };
  throw new Error('no trip in the URL (expected #start/lng,lat/end/lng,lat/scenario)');
}

// "URL  # name; tag1,tag2; why" -> { url, name, tags, why }. Share-link fragments contain
// "#" but no spaces, so " # " only ever starts the note.
export function splitNote(line) {
  const at = line.indexOf(' # ');
  const url = (at < 0 ? line : line.slice(0, at)).trim();
  const [name = '', tags = '', ...why] = at < 0 ? [] : line.slice(at + 3).split(';').map(s => s.trim());
  return { url, name: name || null, tags: tags.split(',').map(t => t.trim()).filter(Boolean), why: why.join('; ') };
}

// ---------------------------------------------------------------- CSV
// RFC 4180: quoted cells, doubled quotes, commas and newlines inside quotes, CRLF, a BOM.
// The first row is the header (names are lowercased and trimmed); blank rows are skipped.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [header = [], ...body] = rows.filter(r => r.some(v => v.trim() !== ''));
  const names = header.map(h => h.trim().toLowerCase());
  return body.map((values, i) => ({ line: i + 2, ...Object.fromEntries(names.map((n, j) => [n, (values[j] ?? '').trim()])) }));
}

// ---------------------------------------------------------------- places
const words = text => text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
const bigrams = text => { const s = text.replace(/\s/g, ''); return Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)); };
export function similarity(a, b) {
  const x = bigrams(a), y = bigrams(b);
  if (!x.length || !y.length) return 0;
  const counts = new Map();
  for (const g of x) counts.set(g, (counts.get(g) ?? 0) + 1);
  let shared = 0;
  for (const g of y) if (counts.get(g) > 0) { shared++; counts.set(g, counts.get(g) - 1); }
  return (2 * shared) / (x.length + y.length);
}

// Local place names from named points (OSM POIs in bench/points/REGION.geojson, or any
// point file given with --places). "Name" or "Name @ zone-id" (to disambiguate).
export class Places {
  constructor(points, zoneInfo = null) {
    this.zoneInfo = zoneInfo;
    this.items = points.filter(p => p.name).map(p => ({ name: p.name, key: words(p.name).join(' '), lat: p.lat, lon: p.lon, category: p.category,
      zone: p.zone ?? (zoneInfo ? zoneOf(p.lat, p.lon, zoneInfo) : 'other') }));
  }

  lookup(text) {
    const [rawName, rawZone = ''] = text.split('@');
    const query = words(rawName).join(' '), zone = rawZone.trim();
    const pool = this.items.filter(i => !zone || i.zone === zone);
    const exact = pool.filter(i => i.key === query);
    const matches = exact.length ? exact : pool.filter(i => query && i.key.includes(query));
    // Several entries within 500 m are one place (an OSM node and the building around it).
    if (matches.length && matches.every(i => haversine([matches[0].lat, matches[0].lon], [i.lat, i.lon]) < 500)) {
      return { lat: matches[0].lat, lon: matches[0].lon, name: matches[0].name };
    }
    if (matches.length) throw new Error(`"${text.trim()}" is ambiguous; add "@ zone": ${[...new Set(matches.map(i => `${i.name} @ ${i.zone}`))].slice(0, 6).join('; ')}`);
    const close = [...new Set(pool.map(i => i.name))].map(name => [name, similarity(query, words(name).join(' '))])
      .filter(([, score]) => score >= 0.6).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name]) => name);
    throw new Error(`"${text.trim()}" not found locally${close.length ? `; did you mean ${close.join(', ')}?` : ' (use lat,lon, a share link, or --geocode)'}`);
  }
}

// An endpoint cell: "lat,lon" (lon,lat is accepted too), a share link (role picks its start
// or end), a local place name, or with `geocode` an address looked up elsewhere.
export async function resolveEndpoint(text, role, { places, geocode } = {}) {
  const trimmed = text.trim();
  const m = /^(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/.exec(trimmed);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return Math.abs(a) < 60 ? { lat: a, lon: b } : { lat: b, lon: a };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const link = parseShareLink(trimmed);
    const endpoint = role === 'from' ? link.start : link.end;
    if (!endpoint) throw new Error('legacy map.tahoebike.org link has no coordinates; open it on newmap.tahoebike.org and copy that link');
    return endpoint;
  }
  try { return places.lookup(trimmed); } catch (error) {
    const hit = geocode && await geocode(trimmed);
    if (hit) return { lat: hit.lat, lon: hit.lon };
    throw error;
  }
}

// ---------------------------------------------------------------- pairs
export const slug = (text, max = 48) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '');

// ~110 m grid, so a stored endpoint cannot identify a doorstep.
export const SNAP_LAT = 0.001, SNAP_LON = 0.0013;
export const roundToGrid = ({ lat, lon }) => ({ lat: Number((Math.round(lat / SNAP_LAT) * SNAP_LAT).toFixed(6)), lon: Number((Math.round(lon / SNAP_LON) * SNAP_LON).toFixed(6)) });

// Collects pairs into a catalog. Pairs already in `existing` stay, except one with the same
// id and endpoints, which is replaced, so re-running an input file is idempotent.
export class PairCollector {
  constructor({ bounds, zoneInfo = null, snap = false, existing = [], regionName = 'Region' } = {}) {
    this.bounds = bounds; this.zoneInfo = zoneInfo; this.snap = snap; this.regionName = regionName;
    this.pairs = [...existing];
    this.errors = [];
  }

  label(point) {
    if (!this.zoneInfo) return this.regionName;
    const zone = zoneOf(point.lat, point.lon, this.zoneInfo);
    return zone === 'other' ? 'Outside town' : this.zoneInfo.names[zone];
  }

  add({ from, to, name, tags = [], why = '', source = '', fromName, toName, ...extra }) {
    for (const [key, p] of [['from', from], ['to', to]]) {
      if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) throw new Error(`${key} is not a point`);
      const b = this.bounds;
      if (b && !(p.lat > b.bottom && p.lat < b.top && p.lon > b.left && p.lon < b.right)) throw new Error(`${key} (${p.lat}, ${p.lon}) is outside the routing service area`);
    }
    if (this.snap) { from = roundToGrid(from); to = roundToGrid(to); }
    const title = name || `${fromName ?? this.label(from)} to ${toName ?? this.label(to)}`;
    const base = slug(title) || 'trip';
    const same = p => haversine([p.from.lat, p.from.lon], [from.lat, from.lon]) < 1 && haversine([p.to.lat, p.to.lon], [to.lat, to.lon]) < 1;
    let id = base, n = 2;
    while (this.pairs.some(p => p.id === id && !same(p))) id = `${base}-${n++}`;
    const pair = { id, name: title, from: { lat: Number(from.lat.toFixed(6)), lon: Number(from.lon.toFixed(6)) },
      to: { lat: Number(to.lat.toFixed(6)), lon: Number(to.lon.toFixed(6)) }, tags: [...new Set(tags)], why: why || undefined,
      source: source || undefined, km: Number((haversine([from.lat, from.lon], [to.lat, to.lon]) / 1000).toFixed(2)) };
    for (const [key, value] of Object.entries(extra)) if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length)) pair[key] = value;
    const at = this.pairs.findIndex(p => p.id === id);
    if (at >= 0) this.pairs[at] = pair; else this.pairs.push(pair);
    return pair;
  }
}

// ---------------------------------------------------------------- link files
// One share link per line; blank lines and lines starting with // or # are ignored.
export async function addLinks(text, collector, { keepAddresses = false, geocode, source = 'share link' } = {}) {
  const added = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    try {
      const { url, name, tags, why } = splitNote(line);
      const link = parseShareLink(url);
      let from = link.start, to = link.end;
      if (link.format === 'legacy') {
        if (!geocode) throw new Error('legacy map.tahoebike.org link has no coordinates; open it on newmap.tahoebike.org and copy that link, or pass --geocode');
        from = await geocode(link.startAddr); to = await geocode(link.endAddr);
        if (!from || !to) throw new Error('could not geocode the legacy link addresses');
      }
      added.push(collector.add({ from, to, name, tags: [...tags, ...(link.scenario ? [`scenario-${link.scenario}`] : [])], why,
        source: `${source} (${link.host})`, scenario: link.scenario,
        // Address text can be a home address, so it is dropped unless asked for.
        from_label: keepAddresses ? link.startAddr : undefined, to_label: keepAddresses ? link.endAddr : undefined }));
    } catch (error) { collector.errors.push({ line: i + 1, input: line.slice(0, 60), error: error.message }); }
  }
  return added;
}

// ---------------------------------------------------------------- CSV rows
const YES = /^(y|yes|true|1)$/i;
export async function addTable(text, collector, { places, geocode, source = 'table' } = {}) {
  const added = [];
  for (const row of parseCsv(text)) {
    if (!row.from && !row.to) continue;
    try {
      if (!row.from || !row.to) throw new Error('needs both from and to');
      const from = await resolveEndpoint(row.from, 'from', { places, geocode }), to = await resolveEndpoint(row.to, 'to', { places, geocode });
      const maxDetour = row.max_detour ? Number(row.max_detour) : null;
      if (maxDetour !== null && !(maxDetour >= 1)) throw new Error(`max_detour "${row.max_detour}" must be a number of at least 1`);
      added.push(collector.add({ from, to, name: row.name || null, tags: row.tags.split(/[,;]/).map(t => t.trim()).filter(Boolean),
        why: row.why || row.notes || '', source, fromName: from.name, toName: to.name,
        expect: maxDetour ? [{ modes: '*', max_detour: maxDetour }] : undefined,
        one_way: YES.test(row.one_way ?? '') || undefined, added_by: row.added_by || undefined }));
    } catch (error) { collector.errors.push({ line: row.line, input: `${row.from} -> ${row.to}`.slice(0, 60), error: error.message }); }
  }
  return added;
}

// ---------------------------------------------------------------- GPX
// Drop the first and last `trimM` metres of a track so a ride from home does not reveal it.
export function trimTrack(points, trimM) {
  if (trimM <= 0) return points;
  let start = 0, acc = 0;
  while (start < points.length - 1 && acc < trimM) acc += haversine(points[start], points[++start]);
  let end = points.length - 1;
  acc = 0;
  while (end > start && acc < trimM) acc += haversine(points[end], points[--end]);
  return points.slice(start, end + 1);
}

export function gpxName(text) {
  const name = /<name>\s*([^<]+?)\s*<\/name>/.exec(text)?.[1];
  return name ? name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
}

// A simplified reference track with no time or elevation, as GPX.
export function referenceGpx(name, points) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="bikesy-bench add-trips" xmlns="http://www.topografix.com/GPX/1/1">\n`
    + `  <trk><name>${esc(name)}</name><trkseg>\n${points.map(([lat, lon]) => `    <trkpt lat="${lat.toFixed(5)}" lon="${lon.toFixed(5)}"/>`).join('\n')}\n  </trkseg></trk>\n</gpx>\n`;
}

// Turns a GPX ride into a pair plus a reference track to write beside the catalog. The
// pair's endpoints are the trimmed ends, rounded to the ~110 m grid.
export function addGpx(text, fileName, collector, { trimM = 200, tags = [], simplifyM = 15 } = {}) {
  const raw = parseGpx(text);
  if (raw.length < 2) throw new Error('no track or route points');
  const points = trimTrack(raw, trimM);
  if (points.length < 2) throw new Error(`track is shorter than ${2 * trimM} m`);
  const kept = simplify(points, simplifyM).map(i => points[i]);
  const name = gpxName(text) ?? fileName.replace(/\.gpx$/i, '');
  const wasSnapping = collector.snap;
  collector.snap = true;
  let pair;
  try {
    pair = collector.add({ from: { lat: points[0][0], lon: points[0][1] }, to: { lat: points.at(-1)[0], lon: points.at(-1)[1] }, name,
      tags: ['reference-route', ...tags], why: "A rider's own route from a GPX export; the report shows how much of it the engine's routes cover.",
      source: `gpx:${fileName}`, reference_km: Number((lineLength(points) / 1000).toFixed(2)) });
  } finally { collector.snap = wasSnapping; }
  pair.references = [{ gpx: `refs/${pair.id}.gpx` }];
  return { pair, gpx: referenceGpx(name, kept), file: pair.references[0].gpx };
}

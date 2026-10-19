#!/usr/bin/env node
// Static HTML report comparing one or more bench runs against a baseline tuning.
//   node bench/report.mjs RUN_DIR [RUN_DIR ...] [--baseline TUNING] [--out FILE]
// The baseline defaults to the first tuning of the first run. Tunings from different runs
// that share a name are shown as "<run>:<tuning>". The page loads Leaflet from cdnjs and
// OSM raster tiles (fine for local use); everything else is inline.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decode } from '../src/polyline.js';
import { AGGREGATES, isPathological } from './aggregates.mjs';
import { similarity } from './lib/geo.mjs';
import { METRICS } from './metrics.mjs';

export const CHANGED_THRESHOLD = 0.05; // divergence (1 - similarity) that counts as a changed route
const MAX_CHANGED_PER_TUNING = 80;

export function loadRun(dir) {
  const results = JSON.parse(readFileSync(resolve(dir, 'results.json'), 'utf8'));
  const geometry = JSON.parse(readFileSync(resolve(dir, 'geometry.json'), 'utf8'));
  return { dir, ...results, geometry };
}

// Pick the baseline mode a compared mode is judged against: the same name, else the
// mode sharing the most facet values (ignoring mode/scenario).
export function matchMode(mode, baseModes) {
  const same = baseModes.find(m => m.name === mode.name);
  if (same) return same;
  let best = null, score = 0;
  for (const m of baseModes) {
    const s = Object.entries(mode.facets).filter(([k, v]) => !['mode', 'scenario'].includes(k) && m.facets[k] === v).length;
    if (s > score) { best = m; score = s; }
  }
  return best;
}

export function buildReport(runs, baselineName) {
  const counts = new Map();
  for (const run of runs) for (const t of run.tunings) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const tunings = [], routes = {}, geometry = {}, shortest = {}, trips = {}, aggregates = [];
  for (const run of runs) {
    const idOf = name => counts.get(name) > 1 ? `${run.meta.name}:${name}` : name;
    for (const t of run.tunings) tunings.push({ id: idOf(t.name), name: t.name, run: run.meta.name, description: t.description,
      sweep: t.sweep, source: t.source, engine: t.engine, modes: t.modes, engineKey: t.engineKey });
    for (const trip of run.trips) trips[trip.key] ??= trip;
    for (const r of run.routes) routes[`${idOf(r.tuning)}|${r.mode}|${r.trip}`] = r;
    for (const [key, g] of Object.entries(run.geometry.routes)) {
      const [tuning, ...rest] = key.split('|');
      geometry[`${idOf(tuning)}|${rest.join('|')}`] = g;
    }
    for (const t of run.tunings) for (const trip of run.trips) {
      const g = run.geometry.shortest[`${t.engineKey}|${trip.key}`];
      if (g) shortest[`${idOf(t.name)}|${trip.key}`] = g;
    }
    for (const a of run.aggregates) aggregates.push({ ...a, tuning: idOf(a.tuning) });
  }
  const baseline = tunings.find(t => t.id === baselineName || t.name === baselineName) ?? tunings[0];
  if (baselineName && baseline.id !== baselineName && baseline.name !== baselineName) throw new Error(`No tuning ${baselineName}`);

  // Changed routes vs the baseline, sorted by divergence.
  const points = new Map();
  const shape = key => { if (!points.has(key)) points.set(key, geometry[key] ? decode(geometry[key].p, 5) : null); return points.get(key); };
  const changed = [];
  const modeMatch = {};
  for (const t of tunings) {
    if (t.id === baseline.id) continue;
    const list = [];
    for (const mode of t.modes) {
      const base = matchMode(mode, baseline.modes);
      modeMatch[`${t.id}|${mode.name}`] = base?.name ?? null;
      if (!base) continue;
      for (const tripKey of Object.keys(trips)) {
        const a = routes[`${baseline.id}|${base.name}|${tripKey}`], b = routes[`${t.id}|${mode.name}|${tripKey}`];
        if (!a || !b) continue;
        let divergence;
        if (!a.ok || !b.ok) divergence = a.ok === b.ok ? 0 : 1;
        else divergence = 1 - similarity(shape(`${baseline.id}|${base.name}|${tripKey}`), shape(`${t.id}|${mode.name}|${tripKey}`));
        if (divergence < CHANGED_THRESHOLD) continue;
        const delta = Object.fromEntries(['distance_km', 'detour', 'high_stress_km', 'unpaved_km', 'climb_m', 'class_i_share']
          .map(m => [m, a.ok && b.ok && b.metrics[m] !== null && a.metrics[m] !== null ? Number((b.metrics[m] - a.metrics[m]).toFixed(4)) : null]));
        list.push({ tuning: t.id, mode: mode.name, baseMode: base.name, trip: tripKey, divergence: Number(divergence.toFixed(3)), delta,
          okChange: a.ok === b.ok ? null : b.ok ? 'fixed' : 'broken' });
      }
    }
    list.sort((x, y) => y.divergence - x.divergence);
    changed.push(...list);
  }

  // Problems: pathological routes and failed expectations, worst first.
  const problems = Object.entries(routes).filter(([, r]) => isPathological(r) || r.expectations.some(e => e.pass === false))
    .map(([key, r]) => ({ key, tuning: key.split('|')[0], mode: r.mode, trip: r.trip, error: r.error, detour: r.metrics.detour ?? null, firm: r.metrics.firm_detour ?? null,
      failed: r.expectations.filter(e => e.pass === false).map(e => `${e.key} ${e.limit} (got ${e.value ?? 'no route'})`) }))
    .sort((a, b) => (b.error ? 99 : b.detour ?? 0) - (a.error ? 99 : a.detour ?? 0));

  // Only ship geometry the page can show: curated trips, changed routes and problems.
  const wanted = new Set();
  for (const [key, trip] of Object.entries(trips)) if (trip.set === 'curated') for (const t of tunings) wanted.add(t.id + '|' + key);
  const perTuning = {};
  for (const c of changed) {
    perTuning[c.tuning] = (perTuning[c.tuning] ?? 0) + 1;
    if (perTuning[c.tuning] <= MAX_CHANGED_PER_TUNING) { wanted.add(`${c.tuning}|${c.trip}`); wanted.add(`${baseline.id}|${c.trip}`); }
  }
  for (const p of problems) wanted.add(`${p.tuning}|${p.trip}`), wanted.add(`${baseline.id}|${p.trip}`);
  const keepGeometry = Object.fromEntries(Object.entries(geometry).filter(([k]) => { const [t, , ...trip] = k.split('|'); return wanted.has(`${t}|${trip.join('|')}`); }));
  const keepShortest = Object.fromEntries(Object.entries(shortest).filter(([k]) => wanted.has(k)));

  return { generated: new Date().toISOString(), region: runs[0].meta.region,
    runs: runs.map(r => ({ name: r.meta.name, dir: r.dir, created: r.meta.created, commit: r.meta.commit, sets: r.meta.sets,
      engines: r.meta.engines.map(e => ({ image: e.image, policy: e.policy, policy_sha256: e.policy_sha256, tunings: e.tunings })) })),
    baseline: baseline.id, tunings, modeMatch,
    metrics: METRICS.map(({ name, label, unit, better }) => ({ name, label, unit, better })),
    aggregateDefs: AGGREGATES.map(({ name, label, format, better }) => ({ name, label, format, better })),
    aggregates, trips, routes, geometry: keepGeometry, shortest: keepShortest,
    changed: changed.filter((c, i, all) => all.slice(0, i).filter(o => o.tuning === c.tuning).length < MAX_CHANGED_PER_TUNING * 4),
    changedThreshold: CHANGED_THRESHOLD, problems };
}

export function renderHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const title = `${data.region} routing bench`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>${CSS}</style></head>
<body><main>
<header><h1>${title}</h1><p id="subtitle" class="muted"></p></header>
<section><h2>Scorecard</h2><p class="muted">Per pair set, tuning and mode. Deltas compare each mode with its matching baseline mode; ▲/▼ coloured by whether the change is better or worse.</p><div id="scorecard"></div></section>
<section><h2>Detour vs stress</h2><div class="controls" id="scatter-controls"></div><div id="scatter"></div></section>
<section><h2>Changed routes</h2><p class="muted">Routes that differ from the baseline by more than ${Math.round(CHANGED_THRESHOLD * 100)}% (divergence = 1 − length-weighted overlap within 20 m). Click a row to view it.</p><div class="controls" id="changed-controls"></div><div id="changed" class="scroll"></div></section>
<section><h2>Problems</h2><p class="muted">No route, detour above 1.5× the shortest rideable route, or a failed expectation. “vs firm” compares with the shortest route on compacted-or-better surfaces; when it is small, the shortest rideable route was only short because it used tracks or trails.</p><div class="controls" id="problem-controls"></div><div id="problems" class="scroll"></div></section>
<section id="pair-section"><h2>Pair</h2><div class="controls" id="pair-controls"></div>
<div class="pair-grid"><div><div id="map"></div><div id="legend" class="legend"></div></div><div><div id="route-list"></div><div id="profile"></div></div></div>
<div id="pair-metrics" class="scroll"></div></section>
<footer class="muted">Map data © OpenStreetMap contributors. Generated by bench/report.mjs.</footer>
</main>
<div id="tooltip" role="tooltip"></div>
<script id="data" type="application/json">${json}</script>
<script>${CLIENT}</script>
</body></html>
`;
}

const CSS = `
:root { color-scheme: light; --surface: #fcfcfb; --surface-2: #f2f1ee; --border: #dddcd7; --text: #0b0b0b; --text-2: #52514e; --muted: #77766f;
  --good: #008300; --bad: #d03b3b; --accent: #2a78d6;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948;
  --paved: #2a78d6; --unpaved: #a5612a; --high: #e34948; --road: #eda100; --path: #1baf7a; --walk: #8a8984; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --surface: #1a1a19; --surface-2: #252523; --border: #3a3a37;
  --text: #f0efec; --text-2: #c3c2b7; --muted: #9a998f; --good: #3fb950; --bad: #ff7b72; --accent: #3987e5;
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
  --paved: #3987e5; --unpaved: #c27a3e; --high: #e66767; --road: #c98500; --path: #199e70; --walk: #8a8984; } }
:root[data-theme="dark"] { color-scheme: dark; --surface: #1a1a19; --surface-2: #252523; --border: #3a3a37; --text: #f0efec; --text-2: #c3c2b7; --muted: #9a998f;
  --good: #3fb950; --bad: #ff7b72; --accent: #3987e5; --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
  --paved: #3987e5; --unpaved: #c27a3e; --high: #e66767; --road: #c98500; --path: #199e70; --walk: #8a8984; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1400px; margin: 0 auto; padding: 16px; }
h1 { font-size: 22px; margin: 8px 0 4px; } h2 { font-size: 17px; margin: 28px 0 6px; } h3 { font-size: 14px; margin: 16px 0 4px; }
.muted { color: var(--muted); margin: 4px 0 8px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 4px 8px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
th { color: var(--text-2); font-weight: 600; position: sticky; top: 0; background: var(--surface); }
td.l, th.l { text-align: left; } tr.base td { background: var(--surface-2); }
tr.click { cursor: pointer; } tr.click:hover td { background: var(--surface-2); }
.scroll { max-height: 440px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.delta { font-size: 12px; margin-left: 4px; } .good { color: var(--good); } .bad { color: var(--bad); } .neutral { color: var(--muted); }
.controls { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin: 6px 0 10px; }
select, input, button { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; }
.pair-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 16px; }
@media (max-width: 900px) { .pair-grid { grid-template-columns: 1fr; } }
#map { height: 520px; border-radius: 6px; border: 1px solid var(--border); }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 6px 0; color: var(--text-2); font-size: 12px; }
.swatch { display: inline-block; width: 14px; height: 4px; border-radius: 2px; vertical-align: middle; margin-right: 4px; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: middle; margin-right: 4px; }
#route-list label { display: flex; gap: 6px; align-items: center; padding: 3px 0; cursor: pointer; }
#route-list label.focus { font-weight: 600; }
#tooltip { position: fixed; pointer-events: none; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px;
  padding: 6px 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.18); display: none; z-index: 2000; max-width: 320px; }
svg text { fill: var(--text-2); font-size: 11px; } svg .grid { stroke: var(--border); stroke-width: 1; } svg .axis { stroke: var(--muted); }
.tag { display: inline-block; padding: 0 6px; border-radius: 8px; background: var(--surface-2); color: var(--text-2); font-size: 12px; margin-right: 4px; }
.leaflet-container { background: var(--surface-2); }
footer { margin: 32px 0 8px; font-size: 12px; }
`;

const CLIENT = String.raw`
const D = JSON.parse(document.getElementById('data').textContent);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const tip = $('tooltip');
function showTip(html, e) { tip.innerHTML = html; tip.style.display = 'block'; tip.style.left = Math.min(e.clientX + 12, innerWidth - 330) + 'px'; tip.style.top = (e.clientY + 12) + 'px'; }
function hideTip() { tip.style.display = 'none'; }
function decode(str) { const pts = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) { for (const axis of [0, 1]) { let r = 0, s = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
    const d = r & 1 ? ~(r >> 1) : r >> 1; if (axis) lon += d; else lat += d; } pts.push([lat / 1e5, lon / 1e5]); } return pts; }
const fmt = (v, f) => v === null || v === undefined ? '–' : f === 'ratio' ? v.toFixed(3) + '×' : f === 'share' ? (v * 100).toFixed(1) + '%' :
  f === 'km' ? v.toFixed(1) : f === 'm' ? Math.round(v) : f === 'count' || Number.isInteger(v) ? String(v) : typeof v === 'number' ? (Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(1)) : String(v);
const metricFmt = m => m.unit === '×' ? 'ratio' : m.unit === '' && /share|overlap/.test(m.name) ? 'share' : m.unit === 'km' ? 'km' : m.unit === 'm' ? 'm' : 'num';
const tuning = id => D.tunings.find(t => t.id === id);
const base = tuning(D.baseline);
const sets = [...new Set(D.aggregates.map(a => a.set))];
const modeNames = [...new Set(D.tunings.flatMap(t => t.modes.map(m => m.name)))];
const modeColor = name => 'var(--s' + ((modeNames.indexOf(name) % 8) + 1) + ')';
const routeColors = ['--s1', '--s2', '--s3', '--s7', '--s5', '--s4', '--s6', '--s8'];
const tripLabel = key => { const t = D.trips[key]; return t ? esc(t.name) + ' <span class="muted">(' + t.direction + ')</span>' : esc(key); };

$('subtitle').innerHTML = D.runs.map(r => esc(r.name) + ' · ' + esc(r.created.slice(0, 16).replace('T', ' ')) + ' · ' + esc(r.commit ?? '') + ' · ' +
  r.sets.map(s => s.set + ' ' + s.pairs + ' pairs / ' + s.trips + ' trips').join(', ') + ' · ' +
  r.engines.map(e => esc((e.image ?? 'external').replace(/^.*\//, '')) + (e.policy ? ' + policy ' + esc(e.policy.replace(/^.*\//, '')) : '')).join('; ')).join('<br>') +
  '<br>Baseline: <b>' + esc(D.baseline) + '</b>. Generated ' + esc(D.generated.slice(0, 16).replace('T', ' ')) + ' UTC.';

// Scorecard
const COLS = ['trips', 'no_route', 'pathological', 'pathological_firm', 'median_detour', 'p90_detour', 'high_stress_km', 'high_stress_share', 'unpaved_share', 'class_i_share', 'median_climb_m', 'wilderness_km', 'expectation_pass_rate', 'same_route_share'];
function deltaHtml(v, b, def) {
  if (v === null || b === null || v === undefined || b === undefined) return '';
  const d = v - b; if (Math.abs(d) < 1e-9) return '';
  const better = def.better === 'lower' ? d < 0 : def.better === 'higher' ? d > 0 : null;
  const cls = better === null ? 'neutral' : better ? 'good' : 'bad';
  const text = def.format === 'share' ? (d * 100).toFixed(1) + ' pt' : def.format === 'ratio' ? d.toFixed(3) : def.format === 'count' ? String(d) : d.toFixed(1);
  return '<span class="delta ' + cls + '">' + (d > 0 ? '▲' : '▼') + (d > 0 ? '+' : '') + text + '</span>';
}
let html = '';
for (const set of sets) {
  html += '<h3>' + esc(set) + '</h3><div class="scroll"><table><tr><th class="l">tuning</th><th class="l">mode</th>' +
    COLS.map(c => '<th>' + esc(D.aggregateDefs.find(a => a.name === c)?.label ?? c) + '</th>').join('') + '</tr>';
  for (const a of D.aggregates.filter(a => a.set === set)) {
    const bm = a.tuning === D.baseline ? null : D.modeMatch[a.tuning + '|' + a.mode];
    const b = bm ? D.aggregates.find(x => x.set === set && x.tuning === D.baseline && x.mode === bm) : null;
    html += '<tr class="' + (a.tuning === D.baseline ? 'base' : '') + '"><td class="l">' + esc(a.tuning) + '</td><td class="l"><span class="dot" style="background:' + modeColor(a.mode) + '"></span>' + esc(a.mode) +
      ' <span class="muted">' + esc(Object.entries(a.facets).filter(([k]) => !['mode', 'scenario'].includes(k)).map(([, v]) => v).join('/')) + '</span></td>' +
      COLS.map(c => { const def = D.aggregateDefs.find(x => x.name === c) ?? {}; return '<td>' + fmt(a[c], def.format) + (b ? deltaHtml(a[c], b[c], def) : '') + '</td>'; }).join('') + '</tr>';
  }
  html += '</table></div>';
}
$('scorecard').innerHTML = html;

// Scatter: one dot per tuning x mode
const sc = { set: sets[0], x: 'median_detour', y: 'high_stress_share' };
$('scatter-controls').innerHTML = 'Set <select id="sc-set">' + sets.map(s => '<option>' + esc(s) + '</option>').join('') + '</select>' +
  'x <select id="sc-x"><option value="median_detour">median detour</option><option value="p90_detour">p90 detour</option><option value="pathological">pathological</option></select>' +
  'y <select id="sc-y"><option value="high_stress_share">high-stress share</option><option value="unpaved_share">unpaved share</option><option value="class_i_share">Class I share</option><option value="median_climb_m">median climb</option></select>' +
  '<span class="legend">' + modeNames.map(m => '<span><span class="dot" style="background:' + modeColor(m) + '"></span>mode ' + esc(m) + '</span>').join('') + '<span>ringed = baseline</span></span>';
for (const id of ['sc-set', 'sc-x', 'sc-y']) $(id).onchange = e => { sc[id.slice(3)] = e.target.value; drawScatter(); };
function drawScatter() {
  const rows = D.aggregates.filter(a => a.set === sc.set && a[sc.x] !== null && a[sc.y] !== null);
  const W = Math.min(900, $('scatter').clientWidth || 900), H = 320, m = { l: 56, r: 16, t: 10, b: 36 };
  const xs = rows.map(r => r[sc.x]), ys = rows.map(r => r[sc.y]);
  const pad = (lo, hi) => { const p = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 0.01; return [lo - p, hi + p]; };
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs)), y0 = Math.min(0, ...ys), y1 = pad(y0, Math.max(...ys))[1];
  const X = v => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r), Y = v => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
  const fx = D.aggregateDefs.find(a => a.name === sc.x).format, fy = D.aggregateDefs.find(a => a.name === sc.y).format;
  let s = '<svg width="' + W + '" height="' + H + '" role="img" aria-label="scatter">';
  for (let i = 0; i <= 4; i++) { const yv = y0 + (y1 - y0) * i / 4, xv = x0 + (x1 - x0) * i / 4;
    s += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(yv) + '" y2="' + Y(yv) + '"/><text x="' + (m.l - 6) + '" y="' + (Y(yv) + 4) + '" text-anchor="end">' + fmt(yv, fy) + '</text>' +
      '<text x="' + X(xv) + '" y="' + (H - m.b + 16) + '" text-anchor="middle">' + fmt(xv, fx) + '</text>'; }
  s += '<text x="' + ((W + m.l) / 2) + '" y="' + (H - 4) + '" text-anchor="middle">' + esc($('sc-x').selectedOptions[0].text) + '</text>';
  rows.forEach((r, i) => { s += '<circle data-i="' + i + '" cx="' + X(r[sc.x]) + '" cy="' + Y(r[sc.y]) + '" r="6" fill="' + modeColor(r.mode) + '" stroke="' +
    (r.tuning === D.baseline ? 'var(--text)' : 'var(--surface)') + '" stroke-width="2"/>' +
    (rows.length <= 12 ? '<text x="' + (X(r[sc.x]) + 9) + '" y="' + (Y(r[sc.y]) + 4) + '">' + esc(r.tuning) + ' / ' + esc(r.mode) + '</text>' : ''); });
  s += '</svg>';
  $('scatter').innerHTML = s;
  $('scatter').querySelectorAll('circle').forEach(c => {
    c.onmousemove = e => { const r = rows[c.dataset.i]; showTip('<b>' + esc(r.tuning) + '</b> mode ' + esc(r.mode) + '<br>' + esc(sc.x) + ' ' + fmt(r[sc.x], fx) + '<br>' + esc(sc.y) + ' ' + fmt(r[sc.y], fy), e); };
    c.onmouseleave = hideTip; });
}
drawScatter(); addEventListener('resize', drawScatter);

// Changed routes and problems tables
function filterSelect(id, values, onChange) {
  $(id).innerHTML = (values.length > 1 ? 'Tuning <select>' + ['all', ...values].map(v => '<option>' + esc(v) + '</option>').join('') + '</select>' : '') +
    ' Set <select>' + ['all', ...sets].map(v => '<option>' + esc(v) + '</option>').join('') + '</select>';
  $(id).querySelectorAll('select').forEach(s => s.onchange = onChange);
}
function selected(id) { const s = [...$(id).querySelectorAll('select')]; return s.length === 2 ? [s[0].value, s[1].value] : ['all', s[0].value]; }
const changedTunings = [...new Set(D.changed.map(c => c.tuning))];
function drawChanged() {
  const [t, set] = selected('changed-controls');
  const rows = D.changed.filter(c => (t === 'all' || c.tuning === t) && (set === 'all' || D.trips[c.trip]?.set === set));
  if (!D.changed.length) { $('changed').innerHTML = '<p class="muted" style="padding:8px">' + (D.tunings.length > 1 ? 'No route differs from the baseline.' : 'Only one tuning: add runs or tunings to compare.') + '</p>'; return; }
  $('changed').innerHTML = '<table><tr><th class="l">trip</th><th class="l">tuning / mode</th><th>divergence</th><th>Δ km</th><th>Δ detour</th><th>Δ high-stress km</th><th>Δ unpaved km</th><th>Δ climb m</th></tr>' +
    rows.map(c => '<tr class="click" data-trip="' + esc(c.trip) + '" data-route="' + esc(c.tuning + '|' + c.mode) + '"><td class="l">' + tripLabel(c.trip) + '</td><td class="l">' + esc(c.tuning) + ' / ' + esc(c.mode) +
      (c.mode !== c.baseMode ? ' <span class="muted">vs ' + esc(c.baseMode) + '</span>' : '') + (c.okChange ? ' <b>' + c.okChange + '</b>' : '') + '</td><td>' + (c.divergence * 100).toFixed(0) + '%</td>' +
      ['distance_km', 'detour', 'high_stress_km', 'unpaved_km', 'climb_m'].map(k => '<td>' + (c.delta[k] === null ? '–' : (c.delta[k] > 0 ? '+' : '') + (k === 'detour' ? c.delta[k].toFixed(3) : c.delta[k].toFixed(1))) + '</td>').join('') + '</tr>').join('') + '</table>';
  bindRows('changed');
}
function drawProblems() {
  const [t, set] = selected('problem-controls');
  const rows = D.problems.filter(p => (t === 'all' || p.tuning === t) && (set === 'all' || D.trips[p.trip]?.set === set));
  $('problems').innerHTML = rows.length ? '<table><tr><th class="l">trip</th><th class="l">tuning / mode</th><th>detour</th><th>vs firm</th><th class="l">issue</th></tr>' +
    rows.map(p => '<tr class="click" data-trip="' + esc(p.trip) + '" data-route="' + esc(p.tuning + '|' + p.mode) + '"><td class="l">' + tripLabel(p.trip) + '</td><td class="l">' + esc(p.tuning) + ' / ' + esc(p.mode) + '</td><td>' +
      fmt(p.detour, 'ratio') + '</td><td>' + fmt(p.firm, 'ratio') + '</td><td class="l">' + esc(p.error ?? '') + esc(p.failed.join('; ')) + '</td></tr>').join('') + '</table>' : '<p class="muted" style="padding:8px">None.</p>';
  bindRows('problems');
}
function bindRows(id) { $(id).querySelectorAll('tr.click').forEach(tr => tr.onclick = () => { showPair(tr.dataset.trip, tr.dataset.route); $('pair-section').scrollIntoView({ behavior: 'smooth' }); }); }
filterSelect('changed-controls', changedTunings, drawChanged); drawChanged();
filterSelect('problem-controls', [...new Set(D.problems.map(p => p.tuning))], drawProblems); drawProblems();

// Pair view
const tripKeys = Object.keys(D.trips).filter(k => D.tunings.some(t => t.modes.some(m => D.geometry[t.id + '|' + m.name + '|' + k])) || D.trips[k].set === 'curated');
$('pair-controls').innerHTML = 'Trip <select id="pair-select">' + sets.map(set => '<optgroup label="' + esc(set) + '">' +
  tripKeys.filter(k => D.trips[k].set === set).map(k => '<option value="' + esc(k) + '">' + esc(D.trips[k].name) + ' (' + D.trips[k].direction + ')</option>').join('') + '</optgroup>').join('') + '</select>' +
  ' Colour by <select id="colour-by"><option value="stress">stress</option><option value="surface">surface</option></select>';
$('pair-select').onchange = e => showPair(e.target.value);
$('colour-by').onchange = () => showPair(state.trip, state.focus);
const map = L.map('map', { preferCanvas: true }).setView([39, -120], 10);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
let layers = L.layerGroup().addTo(map);
const state = { trip: null, focus: null, hidden: new Set() };
const CLASS_COLORS = { stress: { high: '--high', road: '--road', path: '--path', walk: '--walk' }, surface: { paved: '--paved', unpaved: '--unpaved' } };
const CLASS_LABELS = { high: 'high stress', road: 'other road', path: 'car-free path', walk: 'walking', paved: 'paved', unpaved: 'unpaved' };
function showPair(tripKey, focus) {
  state.trip = tripKey; $('pair-select').value = tripKey;
  const trip = D.trips[tripKey];
  const entries = D.tunings.flatMap(t => t.modes.map(m => ({ key: t.id + '|' + m.name, tuning: t.id, mode: m.name, g: D.geometry[t.id + '|' + m.name + '|' + tripKey], r: D.routes[t.id + '|' + m.name + '|' + tripKey] }))).filter(e => e.r);
  state.focus = focus && entries.some(e => e.key === focus && e.g) ? focus : (entries.find(e => e.g)?.key ?? null);
  const by = $('colour-by').value;
  layers.clearLayers();
  const bounds = [];
  const sh = D.shortest[D.baseline + '|' + tripKey];
  if (sh) L.polyline(decode(sh.p), { color: css('--muted'), weight: 2, dashArray: '2 6', opacity: 0.9 }).bindTooltip('shortest rideable').addTo(layers);
  entries.forEach((e, i) => {
    if (!e.g || state.hidden.has(e.key)) return;
    const pts = decode(e.g.p); bounds.push(...pts);
    if (e.key === state.focus) return;
    L.polyline(pts, { color: css(routeColors[i % 8]), weight: 3, opacity: 0.75 }).bindTooltip(e.tuning + ' / ' + e.mode).on('click', () => showPair(tripKey, e.key)).addTo(layers);
  });
  const f = entries.find(e => e.key === state.focus);
  if (f && !state.hidden.has(f.key)) {
    const pts = decode(f.g.p);
    L.polyline(pts, { color: css('--surface'), weight: 9, opacity: 0.9 }).addTo(layers);
    f.g.s.forEach((run, j) => { const end = j + 1 < f.g.s.length ? f.g.s[j + 1][0] : pts.length - 1;
      L.polyline(pts.slice(run[0], end + 1), { color: css(CLASS_COLORS[by][by === 'stress' ? run[2] : run[1]]), weight: 5 }).bindTooltip(f.tuning + ' / ' + f.mode + ': ' + CLASS_LABELS[by === 'stress' ? run[2] : run[1]]).addTo(layers); });
  }
  for (const [p, label] of [[trip.from, 'start'], [trip.to, 'end'], ...(trip.via ? [[trip.via, 'via']] : [])]) {
    L.circleMarker([p.lat, p.lon], { radius: 6, color: css('--surface'), weight: 2, fillColor: css(label === 'start' ? '--good' : label === 'end' ? '--bad' : '--s7'), fillOpacity: 1 }).bindTooltip(label).addTo(layers);
    bounds.push([p.lat, p.lon]);
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [20, 20] });
  $('legend').innerHTML = Object.entries(CLASS_COLORS[by]).map(([k, v]) => '<span><span class="swatch" style="background:var(' + v + ')"></span>' + CLASS_LABELS[k] + '</span>').join('') +
    '<span><span class="swatch" style="background:var(--muted)"></span>dotted = shortest rideable</span>';
  $('route-list').innerHTML = '<h3 style="margin-top:0">' + esc(trip.name) + ' <span class="muted">(' + trip.direction + ')</span></h3>' +
    '<p class="muted">' + (trip.tags ?? []).map(t => '<span class="tag">' + esc(t) + '</span>').join('') + esc(trip.why ?? '') + '</p>' +
    entries.map((e, i) => '<label class="' + (e.key === state.focus ? 'focus' : '') + '"><input type="checkbox" data-k="' + esc(e.key) + '"' + (state.hidden.has(e.key) ? '' : ' checked') + '>' +
      '<span class="swatch" style="background:var(' + routeColors[i % 8] + ')"></span><span data-f="' + esc(e.key) + '">' + esc(e.tuning) + ' / ' + esc(e.mode) + ' · ' +
      (e.r.ok ? fmt(e.r.metrics.distance_km, 'km') + ' km, ' + fmt(e.r.metrics.detour, 'ratio') : '<b>' + esc(e.r.error) + '</b>') + (e.g ? '' : ' <span class="muted">(no geometry)</span>') + '</span></label>').join('');
  $('route-list').querySelectorAll('input').forEach(c => c.onchange = () => { c.checked ? state.hidden.delete(c.dataset.k) : state.hidden.add(c.dataset.k); showPair(tripKey, state.focus); });
  $('route-list').querySelectorAll('[data-f]').forEach(s => s.onclick = ev => { ev.preventDefault(); showPair(tripKey, s.dataset.f); });
  drawProfile(entries, f);
  const metrics = D.metrics;
  $('pair-metrics').innerHTML = '<table><tr><th class="l">tuning / mode</th>' + metrics.map(m => '<th>' + esc(m.label) + (m.unit && m.unit !== '×' ? ' (' + esc(m.unit) + ')' : '') + '</th>').join('') + '<th class="l">expectations</th></tr>' +
    entries.map(e => '<tr' + (e.tuning === D.baseline ? ' class="base"' : '') + '><td class="l">' + esc(e.tuning) + ' / ' + esc(e.mode) + '</td>' +
      (e.r.ok ? metrics.map(m => '<td>' + fmt(e.r.metrics[m.name], metricFmt(m)) + '</td>').join('') : '<td colspan="' + metrics.length + '" class="l">' + esc(e.r.error) + '</td>') +
      '<td class="l">' + e.r.expectations.map(x => '<span class="' + (x.pass === false ? 'bad' : x.pass ? 'good' : 'neutral') + '">' + (x.pass === false ? '✗ ' : x.pass ? '✓ ' : '– ') + esc(x.key) + ' ' + x.limit + '</span>').join(' ') + '</td></tr>').join('') + '</table>';
}
function drawProfile(entries, focus) {
  const el = $('profile');
  const baseEntry = focus && focus.tuning !== D.baseline ? entries.find(e => e.tuning === D.baseline && e.mode === D.modeMatch[focus.key] && e.g) : null;
  const series = [focus, baseEntry].filter(e => e?.g?.e?.length);
  if (!series.length) { el.innerHTML = ''; return; }
  const W = el.clientWidth || 480, H = 200, m = { l: 48, r: 10, t: 22, b: 28 };
  const all = series.flatMap(s => s.g.e);
  const maxD = Math.max(...all.map(p => p[0])), hs = all.map(p => p[1]), lo = Math.min(...hs), hi = Math.max(...hs);
  const X = d => m.l + d / (maxD || 1) * (W - m.l - m.r), Y = h => H - m.b - (h - lo) / ((hi - lo) || 1) * (H - m.t - m.b);
  let s = '<svg width="' + W + '" height="' + H + '" role="img" aria-label="elevation profile"><text x="' + m.l + '" y="14">Elevation (m) · ' + series.map((e, i) => (i ? 'dashed: ' : '') + esc(e.tuning + ' / ' + e.mode)).join(' · ') + '</text>';
  for (let i = 0; i <= 3; i++) { const h = lo + (hi - lo) * i / 3; s += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(h) + '" y2="' + Y(h) + '"/><text x="' + (m.l - 4) + '" y="' + (Y(h) + 4) + '" text-anchor="end">' + Math.round(h) + '</text>'; }
  for (let i = 0; i <= 4; i++) { const d = maxD * i / 4; s += '<text x="' + X(d) + '" y="' + (H - 8) + '" text-anchor="middle">' + (d / 1000).toFixed(1) + ' km</text>'; }
  series.forEach((e, i) => { s += '<polyline fill="none" stroke="' + (i ? 'var(--muted)' : 'var(--accent)') + '" stroke-width="2"' + (i ? ' stroke-dasharray="5 4"' : '') + ' points="' + e.g.e.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ') + '"/>'; });
  s += '<line id="xhair" class="axis" y1="' + m.t + '" y2="' + (H - m.b) + '" visibility="hidden"/><rect x="' + m.l + '" y="' + m.t + '" width="' + (W - m.l - m.r) + '" height="' + (H - m.t - m.b) + '" fill="transparent"/></svg>';
  el.innerHTML = s;
  const rect = el.querySelector('rect'), xh = el.querySelector('#xhair');
  rect.onmousemove = ev => { const box = rect.getBoundingClientRect(); const d = (ev.clientX - box.left) / box.width * maxD;
    xh.setAttribute('x1', X(d)); xh.setAttribute('x2', X(d)); xh.setAttribute('visibility', 'visible');
    showTip((d / 1000).toFixed(2) + ' km<br>' + series.map(e => { const p = e.g.e.reduce((a, b) => Math.abs(b[0] - d) < Math.abs(a[0] - d) ? b : a); return esc(e.tuning + '/' + e.mode) + ': ' + Math.round(p[1]) + ' m'; }).join('<br>'), ev); };
  rect.onmouseleave = () => { xh.setAttribute('visibility', 'hidden'); hideTip(); };
}
const first = D.problems.find(p => D.geometry[p.tuning + '|' + p.mode + '|' + p.trip]);
showPair(first?.trip ?? tripKeys[0], first ? first.tuning + '|' + first.mode : undefined);
`;

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { baseline: { type: 'string' }, out: { type: 'string' } } });
  if (!positionals.length) { console.error('Usage: node bench/report.mjs RUN_DIR [RUN_DIR ...] [--baseline TUNING] [--out FILE]'); process.exit(2); }
  const runs = positionals.map(loadRun);
  const data = buildReport(runs, values.baseline);
  const out = resolve(values.out ?? resolve(positionals[0], 'report.html'));
  writeFileSync(out, renderHtml(data));
  console.log(`Wrote ${out} (${(Buffer.byteLength(renderHtml(data)) / 1e6).toFixed(1)} MB, ${data.changed.length} changed routes, ${data.problems.length} problems)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

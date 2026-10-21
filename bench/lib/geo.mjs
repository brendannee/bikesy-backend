// Small geometry helpers. Points are [lat, lon] like src/polyline.js; GeoJSON is [lon, lat].
const R = 6371008.8, RAD = Math.PI / 180;

export function haversine(a, b) {
  const h = Math.sin((b[0] - a[0]) * RAD / 2) ** 2 +
    Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin((b[1] - a[1]) * RAD / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function lineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversine(points[i - 1], points[i]);
  return total;
}

// Local equirectangular projection to metres around a reference latitude; accurate
// to well under 1% over a region the size of Tahoe or the Bay Area.
export function projector(lat0) {
  const kx = Math.cos(lat0 * RAD) * R * RAD, ky = R * RAD;
  return p => [p[1] * kx, p[0] * ky];
}

// Points every `step` metres along a line (always including both ends).
export function resample(points, step) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], d = haversine(a, b);
    let t = step - carry;
    while (t < d) {
      out.push([a[0] + (b[0] - a[0]) * t / d, a[1] + (b[1] - a[1]) * t / d]);
      t += step;
    }
    carry = (carry + d) % step;
  }
  const last = points.at(-1);
  if (out.at(-1) !== last) out.push(last);
  return out;
}

// Keep every vertex but split segments longer than `maxStep` metres (for map matching
// simplified polylines, whose long straight segments exceed the matcher's breakage distance).
export function densify(points, maxStep) {
  const out = points.length ? [points[0]] : [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], n = Math.ceil(haversine(a, b) / maxStep);
    for (let k = 1; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    out.push(b);
  }
  return out;
}

// Fraction of line `a` (by length) lying within `tolerance` metres of line `b`.
// Uses a uniform grid over b's projected segments, so long routes stay fast.
export function coverage(a, b, tolerance = 20, step = 10) {
  if (a.length < 2 || b.length < 2) return 0;
  const project = projector(a[0][0]);
  const cell = Math.max(tolerance * 2, 50), grid = new Map();
  const pb = b.map(project);
  for (let i = 1; i < pb.length; i++) {
    const [x1, y1] = pb[i - 1], [x2, y2] = pb[i];
    for (let gx = Math.floor((Math.min(x1, x2) - tolerance) / cell); gx <= Math.floor((Math.max(x1, x2) + tolerance) / cell); gx++) {
      for (let gy = Math.floor((Math.min(y1, y2) - tolerance) / cell); gy <= Math.floor((Math.max(y1, y2) + tolerance) / cell); gy++) {
        const key = gx * 1e6 + gy;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      }
    }
  }
  const near = ([x, y]) => {
    for (const i of grid.get(Math.floor(x / cell) * 1e6 + Math.floor(y / cell)) ?? []) {
      if (segmentDistance(x, y, pb[i - 1], pb[i]) <= tolerance) return true;
    }
    return false;
  };
  const samples = resample(a, step).map(project);
  let inside = 0;
  for (let i = 1; i < samples.length; i++) {
    const mid = [(samples[i - 1][0] + samples[i][0]) / 2, (samples[i - 1][1] + samples[i][1]) / 2];
    if (near(mid)) inside += Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]);
  }
  const total = samples.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - samples[i][0], p[1] - samples[i][1]), 0);
  return total ? inside / total : 1;
}

function segmentDistance(x, y, [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1, n = dx * dx + dy * dy;
  const t = n ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / n)) : 0;
  return Math.hypot(x - x1 - t * dx, y - y1 - t * dy);
}

// Symmetric route similarity: 1 means the same corridor both ways.
export function similarity(a, b, tolerance = 20) {
  return Math.min(coverage(a, b, tolerance), coverage(b, a, tolerance));
}

// Polygons for point-in-polygon tests, from GeoJSON Polygon/MultiPolygon features.
export function preparePolygons(features) {
  const polygons = [];
  for (const feature of features) {
    const g = feature.geometry;
    const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of list) {
      const xs = rings[0].map(p => p[0]), ys = rings[0].map(p => p[1]);
      polygons.push({ name: feature.properties?.name, rings,
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
  }
  return polygons;
}

// Even-odd rule over all rings handles holes; `point` is [lat, lon].
export function insideAny(polygons, [lat, lon]) {
  for (const { rings, bbox } of polygons) {
    if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

// Track points from a GPX file (trkpt, rtept or wpt order), as [lat, lon].
export function parseGpx(text) {
  const points = [];
  for (const m of text.matchAll(/<(?:trkpt|rtept)\b([^>]*)>/g)) {
    const lat = /lat="([^"]+)"/.exec(m[1]), lon = /lon="([^"]+)"/.exec(m[1]);
    if (lat && lon) points.push([Number(lat[1]), Number(lon[1])]);
  }
  return points;
}

// Douglas-Peucker simplification in metres, for compact report geometry.
export function simplify(points, tolerance = 5) {
  if (points.length < 3) return points.map((_, i) => i);
  const project = projector(points[0][0]), p = points.map(project);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, index = 0;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(p[i][0], p[i][1], p[a], p[b]);
      if (d > max) { max = d; index = i; }
    }
    if (max > tolerance) { keep[index] = 1; stack.push([a, index], [index, b]); }
  }
  return [...keep.keys()].filter(i => keep[i]);
}

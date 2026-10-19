// Snap points to the bicycle network with Valhalla /locate (Hybrid bicycle, as the
// benchmark routes). Shared by the pair samplers, the pair checker and add-trips.
import { haversine } from './geo.mjs';

export const SNAP_METERS = 150;

// points: [[lat, lon], ...]. Returns one entry per point: { point: [lat, lon] (snapped,
// 6 decimals), distance } in metres, or null when no routable edge is near.
export async function snapToBicycleEdge(valhalla, points) {
  const response = await fetch(new URL('locate', valhalla), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locations: points.map(([lat, lon]) => ({ lat, lon })), costing: 'bicycle',
      costing_options: { bicycle: { bicycle_type: 'Hybrid' } } }) });
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error(`locate: ${body.error ?? response.status}`);
  return body.map((result, i) => {
    const edge = result?.edges?.[0];
    if (!edge) return null;
    const snapped = [Number(edge.correlated_lat.toFixed(6)), Number(edge.correlated_lon.toFixed(6))];
    return { point: snapped, distance: haversine(points[i], snapped) };
  });
}

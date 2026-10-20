The canonical current backend is `https://api.bikesy.com/route`. URLs below record the original capture sources and must remain unchanged for provenance.

`legacy-sf-scenario5.json` is an unmodified successful response fetched 2026-10-01 UTC from:

https://bikesy.com/api/route?lat1=37.789281229572&lng1=-122.46094205322234&lat2=37.78012650217339&lng2=-122.44433400393197&scenario=5

HTTP 200, application/json. It verifies the published envelope and encoding, not route equivalence. Timings are observations, not deterministic expectations. The legacy source's distance accumulator omits same-way intermediate edges. The adapter deliberately returns the full Valhalla route distance in meters.

Other trip responses in tests are synthetic contracts unless explicitly named `valhalla-offline-*`.

`valhalla-offline-sf-scenario5.json` was produced on 2026-10-01 by Valhalla 3.5.1's Python Actor, without an HTTP server, from the repository's historical `pygs/test/sf.osm`. The fixture was converted using pyosmium 4.3.1 after normalizing its OSM 0.5 header, removing obsolete timestamp metadata, deduplicating and sorting objects. No DEM was available: this is a real OSM routing/conversion test, **not** a hill or elevation test. Inputs and results:

- Source OSM SHA256: `0e50952aebd19e466e814fa1561dd766c8933246818cf52e204480d942e47697`
- Converted PBF SHA256: `03efe320e1587b6f9cd2cc9d17858ce1a0d7f39eb46efaea76f9308d9fa98705`
- Engine source: `d377c8ace9ea88dfa989466258bf738b1080f22a`
- Engine image: `ghcr.io/valhalla/valhalla@sha256:f58558b2164ec7fa6f6ee9199cea06e18ac8217da24e7faa7718ea526a88ac1a`
- Scenarios 1–9 routed successfully; the adapter converted all nine. Distances: 2579, 2579, 2579, 2567, 2579, 2579, 2567, 2567, 2567 meters.

The real response exposed that native Valhalla 3.5.1 JSON does not include `begin_heading`; the adapter derives the initial compass direction from the shape when absent.

`valhalla-offline-sf-missing-dem.json` is the same pinned engine's offline height response for scenario 5, resampled at 10 m. It has 259 samples ending at 2562 m, all with null height because no DEM is installed. Tests reject those nulls. A separate check substitutes zero heights solely to verify actual encoded resampling, coordinate order and range coverage; it does not validate real terrain or hill behavior.

`valhalla-current-sf-wiggle.json` is a real pinned-engine route and DEM height capture for scenario 7 on the bounded current SF graph, obtained 2026-10-01. It supports the mobile URL/default-polyline5/elevation regression. Full source/input hashes, exact endpoints and all raw scenario comparisons are in `validation/evidence/wiggle/`. It is not proof the shipped iOS binary has been run.

`valhalla-tahoe-slt-nav.json` is a real Tahoe capture for `nav=1`, obtained 2026-10-20 from a local engine running the Tahoe production routing data of 2026-10-12 (`vcr.vercel.com/tahoebike/bikesy-backend/routing-data:v1-20261012`, Valhalla 3.5.1; `engine` records its `/status`). The route runs through South Lake Tahoe on the El Dorado/Harrison bike path with scenario 1 and has three unnamed path segments. It holds the adapter's native `request`, `route` response, the OSRM-format `nav_request` and `nav` response, and the `height_request` and `height` response, each sent exactly as the adapter sends them.

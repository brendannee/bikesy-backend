# Third-party code and data

- Valhalla 3.5.1: MIT, copyright the Valhalla contributors. Full notice: `LICENSES/Valhalla-MIT.txt`. Vendored upstream files and the graph transformer are pinned to commit `d377c8ace9ea88dfa989466258bf738b1080f22a`.
- The Mapbox polyline test reference retains its license in `test/vendor/`.
- Map data, OSM-derived fixtures and the route-benchmark data under `bench/points/`, `bench/areas/` and `bench/pairs/`: © OpenStreetMap contributors, [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). See [OSM attribution and licensing](https://www.openstreetmap.org/copyright). Keep attribution visible in clients; preserve the ODbL notice when distributing a derived database.
- Route-benchmark home and job points and commute flows: US Census Bureau LEHD Origin-Destination Employment Statistics (LODES 8, 2023), public domain. SF commute weights: US Census Bureau American Community Survey 2019–2023 5-year estimates (table B08301), public domain.
- Elevation: the pinned HGT inputs were obtained from the public Skadi elevation-tile collection at `https://elevation-tiles-prod.s3.us-east-1.amazonaws.com/skadi/`. Input hashes are in `graph/inputs.lock.json`. The archive contains no elevation raster; do not assume all upstream elevation sources share one license. Preserve source/provider attribution when republishing data.
- The staging page loads Leaflet and public OSM map tiles over the network. Their respective licensing and service-use terms apply; this package does not bundle or grant rights to those services.
- Node.js and the operating-system libraries are inherited from the pinned container images. Their notices remain in those images.

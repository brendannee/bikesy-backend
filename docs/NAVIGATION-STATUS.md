# Turn-by-turn navigation (`nav=1`): status

Working notes for branch `turn-by-turn-nav`, current as of 2026-10-20. Drop or condense
this file before opening the upstream PR. The frontend half, with the overall status and
open questions, is in bikesy's `docs/NAVIGATION-STATUS.md` on its own `turn-by-turn-nav`
branch.

## What's on this branch

The branch is local and unpushed, based on `origin/main` (0bb6477).

- `/route?nav=1` returns two extra fields after `stats`:
  - `nav_route`: Valhalla's OSRM-format response for the same route, with banner and voice
    instructions, polyline6 geometry and spoken units in miles. Ferrostar's OSRM parser
    reads it directly.
  - `points`: the full route shape as `[lat, lon]` pairs.
- The navigation request repeats the exact request that produced the route, including the
  ferry retry. It runs alongside the elevation request, in the same queue slot and under the
  same deadline.
- If the two routes don't match, the request fails with 502.
- `nav`: missing, empty or `0` returns the legacy response. Any other value returns
  `Invalid \`nav\``.
- Responses without `nav=1` are byte-identical to `main`: 83 requests compared locally, plus
  the preview below compared against production.
- Response size with `nav=1`: 37 kB for a 4 km route, and 178 kB (45 kB gzipped) for 39 km.
  `intersections` are most of it and could be stripped if size matters.
- Production `serve.mjs` runs one engine worker, so `nav=1` costs about one extra route
  computation.
- Tests: `test/nav.test.js` plus a real Tahoe fixture. `npm test` gives 59 pass.
  `npm run check` and `npm run verify:release` pass.

## Test deployment (Vercel preview, project `bikesy-backend`, team `tahoebike`)

- Preview: https://bikesy-backend-386v830hz-tahoebike.vercel.app. **Not promoted.**
  Production (`bikesy-backend.tahoebike.org`) is still the 2026-10-20 data release without
  `nav=1`.
- It was built from this branch's code with the current production data image
  `routing-data:v2-20261019` (sha256:0982d581…). The deploy directory is
  `~/ws/ltbc/bikesy-data/tahoe-2026-10-19/deploy-nav-preview-1`.
- Checked:
  - `/health` is OK;
  - `nav=1` returns a 17-step `nav_route`;
  - the legacy response is identical to production for the same trip.
- Public test address: https://navtest-api.tahoebike.org (a Hover CNAME to
  `cname.vercel-dns.com`, aliased to this preview). The frontend test site
  https://navtest.tahoebike.org calls it. Deployment Protection is off for this project,
  because Standard Protection also covers custom domains on preview deployments.

### Redeploying after changes

This follows the release-backend skill, but deploys to Preview and is never promoted:

```sh
WORK=~/ws/ltbc/bikesy-data/tahoe-2026-10-19
.venv/bin/python scripts/prepare-release.py --region tahoe --runtime "$WORK/runtime" \
  --image vcr.vercel.com/tahoebike/bikesy-backend/routing-data@sha256:0982d5819c85bf87af4893b45dcba0cf75d63bfb3fe667396662e4be6196d4f0 \
  --vercel-region sfo1 --output "$WORK/deploy-nav-preview-<N>"
vercel link --yes --cwd "$WORK/deploy-nav-preview-<N>" --scope tahoebike --project bikesy-backend
vercel deploy --cwd "$WORK/deploy-nav-preview-<N>" --scope tahoebike --target preview
vercel alias set <new deployment URL> navtest-api.tahoebike.org --scope tahoebike
```

If production moves to a newer data image, use its digest and `$WORK` from
`~/ws/ltbc/bikesy-data/RUNS.md`.

## Next steps

1. Field-test with https://navtest.tahoebike.org/?nav=1.
2. Open the PR on `brendannee/bikesy-backend`. The README's API section already documents
   `nav=1`.
3. Release to Tahoe production with the release-backend skill, and add a `nav=1` check to its
   smoke step.

# Bikesy Valhalla backend

Git-ready source for the corrected regional import and counted-stairs engine deployed on October 4, 2026. It includes the legacy-compatible routing API, nine SF scenarios, queue/cancellation controls, and native route elevation profiles. The configured hill weights are unchanged; there is no experimental detour selector.

**Routing data stays in Vercel Container Registry, outside Git.** Each application image inherits a regional data image by SHA-256 digest, overlays the application, and verifies the engine and data files at image build. The checked-in Dockerfile references the original owner's private SF image; deployers using their own Vercel account must publish their own data package and generate a matching application directory as described below. Normal startup checks release identity, configuration, data-file readability and the engine hash; full startup data hashing is available explicitly. Routes and cold starts do not download or rebuild OSM/DEM data.

For an independent account or self-contained Docker image, start with
[External deployment](docs/EXTERNAL-DEPLOYMENT.md). It does not require BlinkTag image access.

## Start here

1. The canonical routing endpoint is `/route`. [api.bikesy.com](https://api.bikesy.com) is a public SF example; your deployment will have its own URL.
2. Use the [API examples below](#api-examples) for requests, responses and compatibility details.
3. Run source checks with Node 22.9+ and Python 3.12; there are no npm dependencies.
   `npm run test:data` and the commands below call `python3`; on macOS the system
   `python3` may be 3.9, so first activate a 3.12+ virtualenv (stdlib only), e.g.
   `python3.12 -m venv .venv && . .venv/bin/activate`:

```sh
npm test
npm run test:data
npm run check
npm run verify:release
python3 engine/apply_patch.py --check
```

Regional build steps and verification limits are in [REGIONS.md](docs/REGIONS.md). Source hashes in `release.json` identify the current local runtime source; source changes still require deployment. The checked-in release describes the original SF artifact; your generated release manifest binds your own engine and data image.

## Run locally

After publishing your data image and generating an application directory using
[Deploy to Vercel](#deploy-to-vercel), build that directory locally. Keep the
`BIKESY_DEPLOY_DIR` value from those steps and authenticate Docker to your registry:

```sh
docker build --platform linux/amd64 -f "$BIKESY_DEPLOY_DIR/Dockerfile.vercel" \
  -t bikesy:local "$BIKESY_DEPLOY_DIR"
docker run --rm --name bikesy-local --platform linux/amd64 --cpus 2 --memory 2g \
  -p 127.0.0.1:8080:80 bikesy:local
```

Health is available at `/health`; use `/route` and `/bounds` to test the API. The Docker command above binds only to the local loopback interface. Apple Silicon uses amd64 emulation. Stop the container with Ctrl-C. For JS-only development against an already running Valhalla engine, use `npm run start:adapter` and the variables in `.env.example`.

## Route benchmark

[bench/](bench/README.md) compares routing tunings (costing options, hill-policy files,
data images or deployed APIs) over curated and sampled origin/destination pairs, with
per-route metrics (detour, climb, surface, traffic stress, wilderness), expectations and
an HTML report. It runs the production adapter against a local engine container.

## Regional builds

SF remains the default. Tahoe, and any further region, uses the same backend with separate routing data, a `config/REGION.json` file and its own release manifests. See [Regional builds](docs/REGIONS.md) for the config reference, [adding a region](docs/REGIONS.md#adding-a-region), input preparation, reviewed build gates, application image generation and frontend configuration. `BIKESY_CONFIG=./config/tahoe.json` in `.env` selects Tahoe for adapter development; production startup requires matching Tahoe data.

## Deploy to Vercel

This is a container deployment. `vercel.json` selects the `container` framework and
`sfo1`; Vercel builds `Dockerfile.vercel` from the deployment directory. See
[Vercel's container deployment guide](https://vercel.com/kb/guide/does-vercel-support-docker-deployments).
Use a separate Vercel project for each region so SF and Tahoe keep independent data,
configuration and domains.

### 1. Validate the source

Install the Vercel CLI (`npm install --global vercel`) and use Node 22.9+ and Python
3.12+. Run these from this repository's root after making application changes:

```sh
node scripts/lock-source.mjs
npm test
npm run test:data
npm run check
npm run verify:release
python3 engine/apply_patch.py --check
```

The source-lock command updates `release.json`; include it with the corresponding
source changes. Both regions require a built and route-validated data package for
your account, as described in the next step. Application deployment does not build OSM/DEM data.

### 2. Build and publish data to your own Vercel project

Create a project in your own Vercel account, using a separate project for each
region. Set these values in your shell from the repository root; use your actual
Vercel team/workspace slug and project slug. Change `tahoe` to `sf` for an SF release:

```sh
BIKESY_VERCEL_SCOPE='your-team-slug'
BIKESY_PROJECT='your-bikesy-tahoe-project'
BIKESY_RELEASE_REGION=tahoe
BIKESY_RUNTIME_DIR='/absolute/path/to/tahoe-runtime'
BIKESY_DEPLOY_DIR="build/${BIKESY_RELEASE_REGION}-app-v1"
BIKESY_DATA_IMAGE="vcr.vercel.com/${BIKESY_VERCEL_SCOPE}/${BIKESY_PROJECT}/routing-data"
```

These are shell variables for the deployment commands, not application runtime
settings. The generated image selects its runtime config with `BIKESY_CONFIG`.

**Both SF and Tahoe need your own validated data package.** Follow
[REGIONS.md](docs/REGIONS.md) to prepare inputs, build the engine/graph and run
`scripts/package-data.py`. Set `BIKESY_RUNTIME_DIR` to that package directory,
which must contain `Dockerfile`, `data/engine-policy.json`, routing data and
`engine/valhalla_service`. Alternatively, obtain a compatible validated package
from someone authorized to share it.

The private image pinned in the repository is an original-owner artifact, not a
public bootstrap image. Your account is not assumed to have access to it. The
original SF input hashes and cached toolchain are also historical: if those inputs
are unavailable, build and validate a fresh toolchain/data release with your own
reviewed inputs rather than bypassing the checks. See [DATA.md](docs/DATA.md).

Authenticate and publish your data package to your project's registry:

```sh
vercel login
vercel vcr login docker --scope "$BIKESY_VERCEL_SCOPE" --project "$BIKESY_PROJECT"
docker build --platform linux/amd64 \
  -t "${BIKESY_DATA_IMAGE}:v1" "$BIKESY_RUNTIME_DIR"
docker push "${BIKESY_DATA_IMAGE}:v1"
```

Copy the registry manifest digest printed by `docker push`. Generate a fresh
application deployment directory using that digest, not the tag or local image ID:

```sh
BIKESY_DATA_DIGEST='sha256:REPLACE_WITH_ACTUAL_MANIFEST_DIGEST'
python3 scripts/prepare-release.py \
  --region "$BIKESY_RELEASE_REGION" \
  --runtime "$BIKESY_RUNTIME_DIR" \
  --image "${BIKESY_DATA_IMAGE}@${BIKESY_DATA_DIGEST}" \
  --output "$BIKESY_DEPLOY_DIR"
```

The output directory must be new; use a new name for each regenerated release.
Regenerate it after application/config edits because it contains a source snapshot.
This workflow creates a Dockerfile and release locks referencing **your** data image
for either region. Deploy the generated directory, not the repository root, whose
Dockerfile still points to the original owner's private SF image.

VCR authentication is project-scoped. Publish the data image to the same project
that will deploy the application. Local registry login uses a short-lived credential;
rerun it when expired. See the [VCR CLI documentation](https://vercel.com/docs/cli/vcr).

### 3. Link the deployment folder and check runtime settings

```sh
vercel login
vercel link --cwd "$BIKESY_DEPLOY_DIR" --scope "$BIKESY_VERCEL_SCOPE" --project "$BIKESY_PROJECT"
```

Keep `Dockerfile.vercel` and `vercel.json` at the deployment root. In Vercel Project
Settings, avoid overriding the container framework with a Node framework or npm
build command. The Dockerfile already sets:

| Setting | Generated image for `--region REGION` |
| --- | --- |
| `BIKESY_CONFIG` | `/app/config/REGION.json` (for example `/app/config/tahoe.json`) |
| `PORT` | `80` |
| `MAX_CONCURRENT_ROUTES` | `2` |

No `.env` upload is needed. If the project has environment-variable overrides,
ensure they agree with these values. Leave `VALHALLA_URL` unset to use the engine
started inside the container. Changing only `BIKESY_CONFIG` cannot turn SF data into
Tahoe data; startup rejects that mismatch. Keep `.vercel` and credentials out of Git.

### 4. Deploy and verify before assigning production domains

Build a candidate using Production environment settings without moving the
project's production domains yet:

```sh
vercel deploy --cwd "$BIKESY_DEPLOY_DIR" --scope "$BIKESY_VERCEL_SCOPE" --prod --skip-domain
```

Set `BIKESY_DEPLOY_URL` to the URL returned by that command. Check the deployment
with the linked CLI, which can access protected deployments:

```sh
BIKESY_DEPLOY_URL='https://YOUR-DEPLOYMENT.vercel.app'
vercel curl /health --cwd "$BIKESY_DEPLOY_DIR" --deployment "$BIKESY_DEPLOY_URL"
vercel curl /bounds --cwd "$BIKESY_DEPLOY_DIR" --deployment "$BIKESY_DEPLOY_URL"
```

Expect `{"status":"ok"}` and the selected region's **inset service bounds**. Then
check an in-region route; use the command for the region being deployed:

```sh
# SF
vercel curl '/route?lat1=37.77201&lng1=-122.45189&lat2=37.76131&lng2=-122.42157&scenario=5' \
  --cwd "$BIKESY_DEPLOY_DIR" --deployment "$BIKESY_DEPLOY_URL"

# Tahoe: repeat with scenario=2 to check both routing preferences.
vercel curl '/route?lat1=39.1667&lng1=-120.1439&lat2=39.1725&lng2=-120.1385&scenario=1' \
  --cwd "$BIKESY_DEPLOY_DIR" --deployment "$BIKESY_DEPLOY_URL"
```

For another region, use its readiness trip and each configured scenario.
Check for `path`, `directions`, positive `total_distance` and an `elevation_profile`.
An HTTP 200 containing `error` is a failed route. Inspect build logs for release/hash
verification and runtime logs for `engine_policy_verified` and `ready`:

```sh
vercel logs "$BIKESY_DEPLOY_URL" --cwd "$BIKESY_DEPLOY_DIR" --follow
```

If private image pulls or region/hash checks fail, correct the image access or
source/data pairing before proceeding. The deployment flags are documented in
[`vercel deploy`](https://vercel.com/docs/cli/deploy).

### 5. Promote and connect the frontend

After the candidate passes the checks above:

```sh
vercel promote "$BIKESY_DEPLOY_URL" --cwd "$BIKESY_DEPLOY_DIR" --scope "$BIKESY_VERCEL_SCOPE"
```

This promotes the tested production candidate; see
[`vercel promote`](https://vercel.com/docs/cli/promote). Add the intended API domain
in the project's Domains settings if it is not already configured, then repeat
health, bounds and route checks through that domain. Set the frontend's
`BIKESY_API_URL` to the corresponding `/route` URL and deploy the frontend separately.
Retain the previous deployment and its data image for rollback.

For later application-only updates in either region, reuse your published data
image digest, regenerate the application directory, and repeat validation and
deployment from that directory. Git-based deployments must point to your generated
source context; ignored `build/` directories are not automatically deployed by a Git push.

## API examples

Request the **Wiggle · Fell to Valencia** trip from the production backend. Full API URL:

https://api.bikesy.com/route?lat1=37.77201&lng1=-122.45189&lat2=37.76131&lng2=-122.42157&scenario=5

Copy-paste request:

```sh
BASE_URL='https://api.bikesy.com'
curl --get "$BASE_URL/route" \
  --data-urlencode 'lat1=37.77201' \
  --data-urlencode 'lng1=-122.45189' \
  --data-urlencode 'lat2=37.76131' \
  --data-urlencode 'lng2=-122.42157' \
  --data-urlencode 'scenario=5'
```

`BASE_URL` defaults to the production backend. Override it only when deliberately testing a local instance or a protected Preview deployment.

`lat1`/`lng1` are the start and `lat2`/`lng2` are the destination, in decimal degrees. All four are required and must lie within the configured bounds. `scenario` is optional and defaults to `1` when missing or empty. `nav=1` adds turn-by-turn data; see [Navigation data](#navigation-data-nav1). The canonical route is `/route`. Compatibility aliases `/api/route`, `/`, `/api.php` and `/api.php/` accept the same query and remain supported. `HEAD` and CORS `OPTIONS` are supported. `GET /bounds` (also `/api/bounds`) returns the service area, and `GET /health` returns `{"status":"ok"}`.

The active Bay Area configuration maps all nine scenarios as follows:

| Facility preference             | Flatter (`use_hills=0`) | Balanced hills (`0.75`) | More hill-tolerant (`1`) |
| ------------------------------- | ----------------------- | ----------------------- | ------------------------ |
| Direct (`use_roads=1`)          | 1                       | 2                       | 3                        |
| Balanced (`use_roads=0.5`)      | 4                       | 5                       | 6                        |
| Bike facilities (`use_roads=0`) | 7                       | 8                       | 9                        |

These are preferences, not guarantees about distance or elevation. Scenario 9 retains the engine's default maneuver penalty; the others use 2.

### Success response

HTTP **200** returned this response for the exact production URL above on October 5, 2026. **Shortened sample:** only the first two directions and first three elevation samples are shown; `path`, `total_distance` and observed `stats` are complete. Direction coordinates are rounded to five decimal places for this display only; the API retains its original coordinate precision. Routes can change with routing-data updates, and timings vary per request.

```json
{
  "directions": [
    [
      "start east",
      "nameless",
      [
        -122.45190,
        37.77206
      ]
    ],
    [
      "left",
      "nameless",
      [
        -122.44103,
        37.77352
      ]
    ]
  ],
  "path": [
    "kjpeFhkkjVEoBSiAEcA@iCFwA@i@Sy@]m@Ka@Ga@Ca@CmBC_@UyA@UNqA?QO]]a@E[SiE?yAOq@E{AIaAAaAFk@?q@c@mDKg@GQS]KmAWQrDc@yBc^tJkAsAoSdOiBAi@fJa@nCOpMg@tI_@kBiw@lKg@",
    "B?????????????????????????????????@@@@@?@???@@B"
  ],
  "total_distance": 4121,
  "elevation_profile": [
    [
      0,
      76.47
    ],
    [
      14,
      76.14
    ],
    [
      28,
      75.84
    ]
  ],
  "stats": {
    "route_find_time": 0.19999127399999997,
    "route_desc_time": 0.017236383999999817,
    "endpoint_find_time": 0
  }
}
```

| Field                      | Meaning                                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directions`               | Rows of `[turn, street_name, [longitude, latitude]]`. There is no separate arrival row.                                                                                                                                                                                    |
| `path`                     | `[encoded_polyline, encoded_levels]`. Decode the first string with precision **5** (`1e-5` degrees); decoded points are `[latitude, longitude]`. The second string contains legacy simplification levels. The full-resolution shape is only in `nav=1` responses.           |
| `total_distance`           | Route length in **meters**.                                                                                                                                                                                                                                                |
| `elevation_profile`        | `[distance_along_route_meters, elevation_meters]` samples. Heights are DEM estimates, and sampled shape length may differ slightly from `total_distance`.                                                                                                                  |
| `stats.route_find_time`    | Seconds spent in the upstream route phase, including a permitted ferry retry.                                                                                                                                                                                              |
| `stats.route_desc_time`    | Seconds spent converting the route and obtaining/validating elevation, plus the navigation route with `nav=1`.                                                                                                                                                              |
| `stats.endpoint_find_time` | Always `0`; endpoint snapping is included in the route phase.                                                                                                                                                                                                              |

The `stats` values measure API processing, **not estimated cycling duration**. Queue wait is excluded from these timings but counts toward the request deadline. Optional `route_warnings` appears for walking sections, for example `[{"code":"walk_bicycle","message":"Walking sections may include stairs; dismount or carry your bicycle where required."}]`; it does not supply a stair count.

### Navigation data (`nav=1`)

Add `nav=1` to also receive turn-by-turn data for the same route, ready for an OSRM-format route parser such as Ferrostar's. Missing, empty or `nav=0` returns the response above unchanged; any other value returns HTTP **200** with `` {"error":"Invalid `nav`"} ``.

```sh
curl "$BASE_URL/route?lat1=38.9399&lng1=-119.9772&lat2=38.9180&lng2=-120.0050&scenario=1&nav=1"
```

Two fields follow the usual ones:

| Field       | Meaning                                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav_route` | Valhalla's OSRM-format response, `{"code":"Ok","routes":[…],"waypoints":[…]}`, with `bannerInstructions` and `voiceInstructions` on each step. Geometry is an encoded polyline with precision **6**. Distances are in meters; spoken prompts use miles and feet. |
| `points`    | The full-resolution route shape as `[latitude, longitude]` pairs, the same shape as the `nav_route` geometry.                                                                                                                                                    |

The navigation route repeats the exact engine request that produced the route, including a permitted ferry retry, and runs alongside the elevation request in the same queue slot and deadline. The adapter checks that its distance and endpoints match the route; a mismatch or a failed navigation request returns HTTP **502**, and timeouts and cancellation behave as for any route. Responses are larger: about 37 kB (8 kB gzipped) instead of 6 kB for a 4 km Tahoe route, and 178 kB (45 kB gzipped) instead of 10 kB for 39 km.

### Error responses

Clients must check for an `error` field even on **HTTP 200**. Legacy validation and no-route errors deliberately retain that status.

Missing coordinates:

```sh
curl -i "$BASE_URL/route"
```

HTTP **200**:

```json
{ "error": "No `lat1` specified" }
```

Passing `scenario=10` with all four valid coordinates also returns HTTP **200**:

```json
{ "error": "Invalid `scenario` 10" }
```

A backend/upstream failure can return HTTP **502**:

```json
{ "error": "Routing service unavailable or incomplete elevation data" }
```

Other errors use the same envelope: HTTP 200 for `No route found` or `Location outside routing bounds`, 404 for an unknown endpoint, 405 for an unsupported method, 503 when the routing queue is full, and 504 when the deadline expires. An HTTP-200 error contains no success-route fields. See [`src/adapter.js`](src/adapter.js) and [`src/server.js`](src/server.js) for the authoritative status behavior.

## Change code or data

- Application change: edit `src/`, `serve.mjs` or `config/`; test; run `node scripts/lock-source.mjs` to update source hashes; commit both code and `release.json`. The data image remains pinned.
- Engine/data change: follow [DATA.md](docs/DATA.md), validate a separate rebuilt release, publish a new immutable image after approval, and update the digest plus data/engine locks in one commit. Never mix old graph IDs with new indexes.
- API contract and scenario mapping: [API examples](#api-examples).

Existing limitations remain: bridge hours/closures are static, timezone data is absent, route-distance ordering and some regional detours/duplicates remain, unknown stair counts use a length fallback, and DEM heights are estimates. The checked-in data image serves the Bay Area only; Tahoe requires a separate regional data release using [REGIONS.md](docs/REGIONS.md).

## Where the data comes from

Routing data is not included in Git. Build a regional runtime package using
[REGIONS.md](docs/REGIONS.md) and [DATA.md](docs/DATA.md), or obtain a compatible
validated package you are authorized to use. Publish it to your own project's VCR
repository, then run `scripts/prepare-release.py` with its immutable digest.

The image referenced by the checked-in `Dockerfile.vercel` and `release.json` is the
original owner's private SF artifact. It contains the patched amd64 engine, 46 graph
tiles, six HGT rasters, admin DB and policy/stair indexes. Its digest records provenance;
it does not grant registry access. The own-account deployment workflow above does
not require access to that image or membership in the original owner's team.

Your generated `release.json` and `graph/deployed-runtime.lock.json` bind the new
image, engine and individual data files. Retain your published data image while
application releases depend on it; deleting it breaks future builds. Never commit
`.vercel`, `.env`, Docker credentials, raw routing data or signed transfer URLs.

## Startup timing

Normal startup uses `BIKESY_DATA_VERIFICATION=light` (the default). It verifies:

- Both `/data/engine-policy.json` and the application's data lock against the
  expected manifest digest in `release.json`, including policy and engine identity.
- The active application configuration against a configuration hash in the release,
  using the same path resolution as `loadConfig`, and `/data/valhalla.json` against
  its locked hash. Config overrides must contain a release-approved configuration;
  changing settings requires updating the source release hashes.
- Every listed data path is safe, stays within `/data`, and resolves to a nonempty,
  readable regular file. Required configuration/policy/admin entries must exist.
- The engine binary's complete SHA-256 hash.

The final application image build still checks **every data-file hash**, the engine,
application sources and release/configuration bindings after copying the application
into the image. `scripts/verify-release.mjs --image` is always exhaustive; startup
mode cannot weaken it. A stale base manifest or mismatched data/configuration fails
that build.

Light startup relies on those immutable, build-verified image contents. It does
**not detect same-path runtime corruption or replacement of bulk data contents**
that remains readable and nonempty. For mutable/local data validation, add
`-e BIKESY_DATA_VERIFICATION=full` to the local `docker run` command. Full mode
rehashes every data file in addition to the same identity, path and configuration
checks; it does not permit arbitrary unbound configuration. Invalid mode values
fail startup. Neither mode downloads or rebuilds graph/DEM data.

The engine, route and elevation readiness probes are unchanged. The HTTP server,
including `/health`, listens only after all checks and probes pass.

Successful startup emits one timing summary, `ready`. Timing events share an
`instance` UUID:

- `ready`: total `startup_ms`, summed `startup_phases_ms`,
  `startup_phase_attempts`, and `startup_phase_failures`, plus the existing fields.
  Existing `milliseconds` keeps its old meaning: elapsed since just before engine
  spawn, excluding verification. Use `startup_ms` for complete Node startup,
  including initialization and module loading.
- `startup_phase`: emitted only for a failed phase attempt, with `phase`,
  `attempt`, `status: "failed"`, `duration_ms`, and elapsed `startup_ms`.
  Successful phases and instrumentation initialization do not emit separate logs;
  all attempts and their durations still contribute to the `ready` summary.

The phases are `data_verification` (manifest/config hashes and file checks in light
mode, plus all data hashes in full mode),
`engine_verification` (binary hash), `engine_readiness` (spawn through first valid
status response, including status polling), `route_probe`, `elevation_probe`, and
`http_ready` (HTTP setup through the listen callback). Phase totals can be lower
than overall startup: module loading, gaps and retry sleeps are not assigned to a
phase. Verification failures still stop startup; failed probe attempts still use
the existing retry/deadline behavior. A failed startup has no `ready` event.

All timing events carry `timing_scope: "node_process"` and
`platform_provisioning_included: false`. Time starts at Node's performance time
origin, not when Vercel received a request. Platform scheduling, image provisioning,
ingress, and client network time remain outside these metrics. Route response
`stats` also exclude container startup and queue wait.

After deploying this backend revision, filter runtime logs by `instance` and
compare `ready.startup_ms` with `startup_phases_ms.data_verification`,
`engine_verification`, `engine_readiness`, `route_probe`, and `elevation_probe`.
Correlate with request latency in Vercel to identify time outside the process.
Repeated container logs may be attached to multiple requests; group by instance
and phase/attempt before counting starts or retries. `engine_policy_verified`,
`resource_sample`, and `engine_exit` use the same instance identifier.

`ready.data_verification_mode` identifies `light` or `full`.
`engine_policy_verified` reports `verificationMode`, `dataManifestSha256`,
`checkedDataFiles` and `hashedDataFiles` instead of the ambiguous `verifiedDataFiles`.
For the current 56-file release, light mode checks all 56 data files but hashes
only the data configuration (`hashedDataFiles: 1`); manifest, application config
and engine hashes are additional checks outside that count.

Compare overall startup and the first real route, not just the verification phase.
Removing eager data reads also removes their page-cache warming, so some I/O may
move into readiness or the first route. The observed production verification time
is an upper bound on removable work, not a guaranteed net saving. Tests use small
local fixtures; they are not cold-cloud performance measurements.

The frontend's one-time page-open health warmup is a separate deployment. Both
repositories must be deployed for both changes to take effect. No keepalive
schedule or allocation change is part of this change. The startup integrity
boundary is described above; exhaustive final-image verification is retained.

`npm test` includes deterministic timing tests and an offline harness that executes
the actual supervisor with fake files, engine responses and HTTP listener. It
checks the single success summary, retained phase failure logs, failed verification,
probe retries, and that HTTP readiness still follows
verification and both probes, without starting Valhalla or contacting production.

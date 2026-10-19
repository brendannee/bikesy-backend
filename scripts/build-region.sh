#!/usr/bin/env bash
# Reproduce a regional routing-data build end to end on a Docker host.
#
# Runs the documented steps in order (docs/REGIONS.md, docs/DATA.md,
# docs/EXTERNAL-DEPLOYMENT.md) and records per-step timings. Each step is
# skipped when its output already exists, so the script can be re-run after a
# failure or to resume. It never pushes images or deploys.
#
# Example (Tahoe, Geofabrik snapshot 2026-10-12):
#   scripts/build-region.sh --region tahoe \
#     --workdir ~/bikesy-data/tahoe-2026-10-12 \
#     --routing-pbf ~/osm/norcal-261012.osm.pbf --routing-pbf ~/osm/nevada-261012.osm.pbf \
#     --admin-pbf ~/osm/california-261012.osm.pbf --admin-pbf ~/osm/nevada-261012.osm.pbf \
#     --osm-source 'Geofabrik norcal/california/nevada 2026-10-12 (replication 2026-10-12T20:21:00Z)'
#
# Steps: preflight toolchain admin osm dem lock review build package app smoke
# Use --from STEP / --to STEP to run a subset. See --help.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REGION=sf WORK= REVIEW= CARRY= OSM_SOURCE= DEM_SOURCE= REUSE_DEM=
CPUS=4 MEMORY=8g PORT=8080 FROM=preflight TO=smoke
ROUTING=() ADMIN=()
PY=${PYTHON:-}
[ -z "$PY" ] && { [ -x "$ROOT/.venv/bin/python" ] && PY="$ROOT/.venv/bin/python" || PY=python3; }
STEPS="preflight toolchain admin osm dem lock review build package app smoke"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; cat <<EOF

Options:
  --region SLUG          config/SLUG.json (default sf; pass --region tahoe for Tahoe)
  --workdir DIR          all inputs/outputs for this build (outside Git)
  --routing-pbf FILE     state/regional extract for routing (repeat; same snapshot)
  --admin-pbf FILE       extract containing COMPLETE state relations (repeat; same snapshot).
                         Geofabrik sub-state extracts such as norcal do not contain the
                         complete California relation; use the full state file.
  --osm-source TEXT      provenance recorded in inputs.lock.json
  --dem-source TEXT      default: AWS Terrain Tiles skadi + today's date
  --reuse-dem DIR        copy (APFS clone) HGT tiles from a previous data/elevation dir
  --review DIR           use this human-reviewed review directory instead of WORK/review
  --carry-forward DIR    seed WORK/review from a previously reviewed directory
  --cpus N --memory SIZE Docker limits for toolchain steps (default 4 / 8g)
  --port N               local port for the app smoke test (default 8080)
  --python PATH          Python >=3.12 for host steps (default .venv/bin/python)
  --from STEP --to STEP  run a subset of: $STEPS
EOF
}

while [ $# -gt 0 ]; do
  case $1 in
    --region) REGION=$2; shift 2;;
    --workdir) WORK=$2; shift 2;;
    --routing-pbf) ROUTING+=("$2"); shift 2;;
    --admin-pbf) ADMIN+=("$2"); shift 2;;
    --osm-source) OSM_SOURCE=$2; shift 2;;
    --dem-source) DEM_SOURCE=$2; shift 2;;
    --reuse-dem) REUSE_DEM=$2; shift 2;;
    --review) REVIEW=$2; shift 2;;
    --carry-forward) CARRY=$2; shift 2;;
    --cpus) CPUS=$2; shift 2;;
    --memory) MEMORY=$2; shift 2;;
    --port) PORT=$2; shift 2;;
    --python) PY=$2; shift 2;;
    --from) FROM=$2; shift 2;;
    --to) TO=$2; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option $1" >&2; usage >&2; exit 2;;
  esac
done
[ -n "$WORK" ] || { echo '--workdir is required' >&2; exit 2; }
CONFIG="$ROOT/config/$REGION.json"
[ -f "$CONFIG" ] || { echo "Missing $CONFIG" >&2; exit 2; }
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
DATA="$WORK/data" SRC="$WORK/source" LOGS="$WORK/logs"
REVIEW=${REVIEW:-$WORK/review}
mkdir -p "$LOGS"
TIMINGS="$WORK/timings.tsv"
[ -f "$TIMINGS" ] || printf 'step\tstatus\tseconds\tfinished\n' > "$TIMINGS"

# Mount every input read-only at /inputs/N-basename inside the toolchain.
MOUNTS=() R_IN=() A_IN=() i=0
for f in ${ROUTING[@]+"${ROUTING[@]}"}; do
  f=$(cd "$(dirname "$f")" && pwd)/$(basename "$f"); i=$((i+1))
  MOUNTS+=(-v "$f:/inputs/$i-$(basename "$f"):ro"); R_IN+=("/inputs/$i-$(basename "$f")")
done
for f in ${ADMIN[@]+"${ADMIN[@]}"}; do
  f=$(cd "$(dirname "$f")" && pwd)/$(basename "$f"); i=$((i+1))
  MOUNTS+=(-v "$f:/inputs/$i-$(basename "$f"):ro"); A_IN+=("/inputs/$i-$(basename "$f")")
done

TOOLCHAIN_TAG="bikesy-toolchain:$(shasum -a 256 "$ROOT/engine/Dockerfile.toolchain" | cut -c1-12)"
tc() { # run a command in the pinned toolchain, offline, with the build mounts
  [ -f "$SRC/scripts/rebuild-variant.py" ] || refresh_source
  mkdir -p "$DATA" "$REVIEW"
  docker run --rm --platform linux/amd64 --network none --cpus "$CPUS" --memory "$MEMORY" --memory-swap "$MEMORY" \
    -v "$WORK:/w" -v "$DATA:/data" -v "$SRC:/work" -v "$REVIEW:/review" \
    ${MOUNTS[@]+"${MOUNTS[@]}"} -w /w "$TOOLCHAIN_TAG" "$@"
}
index_of() { local n=0 x; for x in $STEPS; do [ "$x" = "$1" ] && { echo $n; return; }; n=$((n+1)); done; echo "Unknown step $1" >&2; exit 2; }
FROM_I=$(index_of "$FROM") TO_I=$(index_of "$TO")
step() { # step NAME FUNCTION: run with errexit, timing and a log file
  local name=$1 start rc; start=$(date +%s)
  echo "==> [$name] $(date '+%F %T')"
  set +e
  ( set -e; "$2" ) 2>&1 | tee "$LOGS/$name.log"
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" = 0 ]; then status=ok; else status=FAILED; fi
  printf '%s\t%s\t%s\t%s\n' "$name" "$status" $(( $(date +%s) - start )) "$(date '+%F %T')" >> "$TIMINGS"
  [ "$rc" = 0 ] || { echo "Step $name failed (exit $rc); see $LOGS/$name.log" >&2; exit 1; }
}

s_preflight() {
  "$PY" "$ROOT/scripts/preflight.py" --build --workdir "$WORK"
  ( cd "$ROOT" && npm test >/dev/null && "$PY" -m unittest discover -s test -p '*_test.py' 2>&1 | tail -1 \
    && npm run -s check && npm run -s verify:release && "$PY" engine/apply_patch.py --check )
}
s_toolchain() {
  if docker image inspect "$TOOLCHAIN_TAG" >/dev/null 2>&1; then echo "Reusing $TOOLCHAIN_TAG"; else
    docker build --platform linux/amd64 -f "$ROOT/engine/Dockerfile.toolchain" -t "$TOOLCHAIN_TAG" "$ROOT"; fi
  docker image inspect --format '{{.Id}}' "$TOOLCHAIN_TAG" | tee "$WORK/toolchain-image-id.txt"
  tc python3 /work/scripts/preflight.py --toolchain --workdir /w
}
refresh_source() { # fresh copy of the build sources (rebuild-variant writes engine/out and build/)
  rm -rf "$SRC"; mkdir -p "$SRC"
  ( cd "$ROOT" && tar --exclude __pycache__ -cf - package.json scripts config graph engine test ) | tar -xf - -C "$SRC"
  { echo "commit $(git -C "$ROOT" rev-parse HEAD)"; git -C "$ROOT" status --porcelain -- scripts config graph engine test; } > "$WORK/source-provenance.txt"
}
s_admin() {
  [ ${#A_IN[@]} -gt 0 ] || { echo '--admin-pbf required' >&2; return 1; }
  if [ -f "$WORK/admin/admin-input.osm.pbf" ]; then echo 'Reusing admin input'; return; fi
  mkdir -p "$WORK/admin"
  tc python3 /work/scripts/prepare-admin.py --config "/work/config/$REGION.json" \
    --output /w/admin/admin-input.osm.pbf "${A_IN[@]}"
}
s_osm() {
  [ ${#R_IN[@]} -gt 0 ] || { echo '--routing-pbf required' >&2; return 1; }
  if [ -f "$DATA/region.osm.pbf" ]; then echo 'Reusing prepared region extract'; return; fi
  mkdir -p "$DATA"
  tc python3 /work/scripts/prepare-osm.py --config "/work/config/$REGION.json" --data /data \
    --admin-input /w/admin/admin-input.osm.pbf "${R_IN[@]}"
}
s_dem() {
  if [ -n "$REUSE_DEM" ] && [ ! -d "$DATA/elevation" ]; then cp -Rc "$REUSE_DEM" "$DATA/elevation" 2>/dev/null || cp -R "$REUSE_DEM" "$DATA/elevation"; fi
  "$PY" "$ROOT/scripts/fetch-dem.py" "$CONFIG" "$DATA" --resume
}
s_lock() {
  if [ -f "$DATA/inputs.lock.json" ]; then
    "$PY" "$ROOT/scripts/lock-inputs.py" "$DATA" "$CONFIG" --verify; return; fi
  [ -n "$OSM_SOURCE" ] || { echo '--osm-source required to create the input lock' >&2; return 1; }
  "$PY" "$ROOT/scripts/lock-inputs.py" "$DATA" "$CONFIG" --osm-source "$OSM_SOURCE" \
    --dem-source "${DEM_SOURCE:-AWS Terrain Tiles skadi HGT (elevation-tiles-prod), fetched $(date +%F)}" \
    --build-lock "$WORK/inputs.build-lock.json"
}
s_review() {
  if [ -f "$REVIEW/quality.json" ]; then
    echo "Using existing review directory $REVIEW"
    cmp -s "$REVIEW/inputs.lock.json" "$WORK/inputs.build-lock.json" || { echo "review inputs.lock.json does not match this build's inputs; regenerate it (inputs changed)" >&2; return 1; }
    return; fi
  local extra=()
  rm -f "$WORK/review-candidates.json"
  if [ -n "$CARRY" ]; then mkdir -p "$WORK/carry-forward"; cp "$CARRY"/*.json* "$WORK/carry-forward/"; extra=(--carry-forward /w/carry-forward); fi
  # $REVIEW is mounted at /review; write to a temporary name under /w then move.
  tc python3 /work/scripts/propose-review.py --config "/work/config/$REGION.json" --data /data \
    --input-lock /w/inputs.build-lock.json --output /w/review.candidate --candidates /w/review-candidates.json ${extra[@]+"${extra[@]}"}
  rm -rf "$REVIEW"; mv "$WORK/review.candidate" "$REVIEW"
  echo "CANDIDATE review written to $REVIEW. A human must review it (docs/REGIONS.md) before publishing."
}
s_build() {
  if [ -f "$SRC/build/$REGION/evidence/gated-build.json" ]; then echo 'Gated build receipt exists; reusing'; return; fi
  # Reset generated outputs from a previous failed attempt; locked inputs are re-verified by the builder.
  ( cd "$DATA" && rm -rf tiles tiles-before-access admin.sqlite admin.regional-manifest.json bikesy-policy.bin \
      bikesy-stairs.txt bikesy-stairs.json bikesy-graph.lua graph-profile.lock.json valhalla.json )
  rm -rf "$SRC/build" "$SRC/engine/out"
  tc python3 /work/scripts/rebuild-variant.py --project /work --data /data --region "$REGION" --review /review
}
s_package() {
  if [ -f "$WORK/runtime/data/engine-policy.json" ]; then echo 'Runtime package exists; reusing'; return; fi
  tc python3 /work/scripts/package-data.py /data /w/runtime --region "$REGION" --build "/work/build/$REGION"
  rm -rf "$WORK/evidence"; cp -R "$SRC/build/$REGION/evidence" "$WORK/evidence"
  ( cd "$WORK/runtime" && shasum -a 256 data/engine-policy.json engine/valhalla_service && du -sh . )
}
s_app() {
  local app="$WORK/app-$(date +%Y%m%d-%H%M%S)"
  "$PY" "$ROOT/scripts/prepare-release.py" --region "$REGION" --runtime "$WORK/runtime" --bundle-data --output "$app"
  ln -sfn "$app" "$WORK/app-latest"
  docker build --platform linux/amd64 -f "$app/Dockerfile.vercel" -t "bikesy-$REGION:candidate" "$app"
}
s_smoke() {
  docker rm -f "bikesy-$REGION-smoke" >/dev/null 2>&1 || true
  docker run -d --name "bikesy-$REGION-smoke" --platform linux/amd64 --cpus 2 --memory 2g \
    -e BIKESY_DATA_VERIFICATION=full -p "127.0.0.1:$PORT:80" "bikesy-$REGION:candidate"
  local t=0
  until curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; do
    sleep 5; t=$((t+5))
    if [ $t -ge 600 ] || ! docker ps -q -f name="bikesy-$REGION-smoke" | grep -q .; then
      docker logs "bikesy-$REGION-smoke" 2>&1 | tail -40; return 1; fi
  done
  echo "healthy after ~${t}s"
  docker logs "bikesy-$REGION-smoke" 2>&1 | grep -E '"(ready|engine_policy_verified)"' || true
  ( cd "$ROOT" && BIKESY_CONFIG="$CONFIG" BIKESY_API_URL="http://127.0.0.1:$PORT" \
      BIKESY_SMOKE_OUTPUT="$WORK/smoke-region.json" node scripts/smoke-region.mjs )
  docker rm -f "bikesy-$REGION-smoke" >/dev/null
}

# Snapshot the current sources once per invocation for any step up to the graph build;
# package/app/smoke keep the snapshot (engine/out, build/) that produced the receipt.
[ "$FROM_I" -le "$(index_of build)" ] && refresh_source
n=0
for s in $STEPS; do
  if [ $n -ge "$FROM_I" ] && [ $n -le "$TO_I" ]; then step "$s" "s_$s"; fi
  n=$((n+1))
done
echo "Done. Timings: $TIMINGS"

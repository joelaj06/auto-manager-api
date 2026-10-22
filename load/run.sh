#!/usr/bin/env sh
# Runs a k6 script from load/k6 with a local k6 if installed, otherwise with the k6 Docker image.
#   load/run.sh health                 smoke profile against http://localhost:3000
#   PROFILE=load load/run.sh health    ramp to 20 virtual users for ~3 minutes
#   BASE_URL=https://staging.example.com load/run.sh health
#   TENANT=… EMAIL=… PASSWORD=… load/run.sh tenant-api   (seed a tenant with `yarn load:seed`)
set -eu

SCRIPT="${1:?usage: load/run.sh <script name in load/k6, e.g. health>}"
DIR="$(cd "$(dirname "$0")/k6" && pwd)"
K6_IMAGE="grafana/k6:2.3.0"
PROFILE="${PROFILE:-smoke}"

if [ ! -f "$DIR/$SCRIPT.js" ]; then
  echo "No such script: $DIR/$SCRIPT.js" >&2
  exit 2
fi

if command -v k6 >/dev/null 2>&1; then
  exec k6 run -e BASE_URL="${BASE_URL:-http://localhost:3000}" -e PROFILE="$PROFILE" \
    -e TENANT="${TENANT:-}" -e EMAIL="${EMAIL:-}" -e PASSWORD="${PASSWORD:-}" "$DIR/$SCRIPT.js"
fi

# Inside the container, the host's localhost is host.docker.internal.
exec docker run --rm -i \
  --add-host=host.docker.internal:host-gateway \
  -v "$DIR:/scripts:ro" \
  -e BASE_URL="${BASE_URL:-http://host.docker.internal:3000}" \
  -e PROFILE="$PROFILE" \
  -e TENANT="${TENANT:-}" -e EMAIL="${EMAIL:-}" -e PASSWORD="${PASSWORD:-}" \
  "$K6_IMAGE" run "/scripts/$SCRIPT.js"

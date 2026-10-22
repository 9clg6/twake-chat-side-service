#!/usr/bin/env bash
# Boots the image as in production (uid 1000, read-only root filesystem, no capability),
# then checks it serves and stops cleanly.
#
#   docker/smoke-test.sh twake-chat-visio-side-service:dev
set -euo pipefail

IMAGE="${1:?usage: $0 <image>}"
RUN="visio-side-service-smoke-$$"
cleanup() {
  docker rm -f "$RUN-service" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$RUN-service" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1::8080 \
  "$IMAGE" >/dev/null
API="http://$(docker port "$RUN-service" 8080/tcp | head -1)"

failures=0
expect() {
  if [[ "$2" == "$3" ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1: got '$2'"
    failures=$((failures + 1))
  fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }

for _ in $(seq 1 60); do
  [[ "$(status "$API/health/ready")" == 200 ]] && break
  sleep 1
done

expect 'ready once started' "$(status "$API/health/ready")" '200'
expect 'alive' "$(status "$API/health/live")" '200'
expect 'runs as uid 1000' "$(docker exec "$RUN-service" stat -c %u /proc/1)" '1000'

docker kill -s TERM "$RUN-service" >/dev/null
code="$(timeout 40 docker wait "$RUN-service" || echo timeout)"
expect 'stops on SIGTERM with code 0' "$code" '0'

if ((failures > 0)); then
  echo "$failures check(s) failed; service logs:"
  docker logs "$RUN-service" 2>&1 | tail -40
  exit 1
fi
echo "all checks passed"

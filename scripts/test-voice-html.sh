#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
unset DISPLAY WAYLAND_DISPLAY SWAYSOCK PULSE_SERVER
name="fizzer-media-test-$$"
network="$name"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
# Dedicated internal network: no SFU egress or host-wide media listeners.
docker network create --internal "$network" >/dev/null
subnet=$(docker network inspect "$network" --format '{{(index .IPAM.Config 0).Subnet}}')
ip=$(python3 -c 'import ipaddress,sys; print(ipaddress.ip_network(sys.argv[1])[2])' "$subnet")
docker run -d --name "$name" --network "$network" --ip "$ip" \
  -v "$PWD/scripts/voice-test-livekit.yaml:/etc/livekit.yaml:ro" \
  livekit/livekit-server:v1.9.11@sha256:289262ffae8b827f45186331aa315d08ed275eb30f9b0add337ec57948e44ca1 \
  --config /etc/livekit.yaml --node-ip "$ip" >/dev/null
if ! curl --silent --show-error --fail --retry 15 --retry-all-errors --retry-delay 1 --max-time 2 "http://$ip:17880"; then
  docker logs "$name"
  exit 1
fi
export FIZZER_TEST_LIVEKIT_API="http://$ip:17880" FIZZER_TEST_LIVEKIT_WS="ws://$ip:17880"
cd backend_elixir
FIZZER_MEDIA_INTEGRATION=1 MIX_ENV=test timeout --kill-after=10 240 mix test test/cascade_web/voice_html_test.exs

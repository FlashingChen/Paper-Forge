#!/usr/bin/env bash
set -uo pipefail

if [[ "${PAPERFORGE_EXECUTOR:-local}" != "cloud-run" && "${PAPERFORGE_EXECUTOR:-local}" != "node" ]]; then
  echo 'Control image requires PAPERFORGE_EXECUTOR=node or cloud-run; use npm run dev for local agents.' >&2
  exit 1
fi

if [[ "${PAPERFORGE_DISPATCH_ENABLED:-1}" == "0" ]]; then
  echo 'Cloud dispatch is disabled; control plane is available for configuration.' >&2
  exec node server.js
fi

node .execution/dispatcher.cjs &
dispatcher_pid=$!
node server.js &
server_pid=$!
shutdown() {
  kill -TERM "$server_pid" "$dispatcher_pid" 2>/dev/null || true
  wait "$server_pid" "$dispatcher_pid" 2>/dev/null || true
}
trap 'shutdown; exit 0' TERM INT
wait -n "$dispatcher_pid" "$server_pid"
status=$?
shutdown
# An unexpected child exit should make the container unhealthy/restartable.
if [[ "$status" == 0 ]]; then status=1; fi
exit "$status"

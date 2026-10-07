#!/bin/sh
set -eu
# The trusted delivery wrapper runs as root; pi and all its tools always drop UID.
if [ "$(id -u)" = 0 ]; then
  case "${PI_CODING_AGENT_DIR:-}" in /work/*) chown -R 10001:1001 "$PI_CODING_AGENT_DIR" ;; "") ;; *) exit 1 ;; esac
  exec su-exec 10001:1001 pi "$@"
fi
exec pi "$@"

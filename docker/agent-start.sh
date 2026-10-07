#!/bin/sh
set -eu
# Bound each trusted-wrapper file too. Untrusted tools have bounded tmpfs only.
ulimit -f 262144
exec node .execution/worker.cjs

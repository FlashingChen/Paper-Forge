#!/bin/sh
#
# PaperForge container entrypoint.
#
# WHY THIS EXISTS
# --------------------------------------------------------------------------
# The app runs as an unprivileged user (paperforge, UID 10001) — see the
# SANDBOX MODEL note in the Dockerfile: the pi agent runs *inside this
# container*, so the container user is the security boundary and must not be
# root.
#
# That collides with how persistent storage actually works. The image does
# `chown -R paperforge:nodejs /data` at BUILD time, but a bind mount of a host
# directory onto /data **shadows** whatever the image put there. The host
# directory's ownership wins, and a freshly created host directory is normally
# owned by root:root. UID 10001 then cannot create /data/paperforge.db, and the
# app dies on startup with EACCES.
#
# Named Docker volumes do not have this problem (Docker seeds them from the
# image, preserving ownership), but bind mounts — which is what "mount my data
# disk at /data" means — always do.
#
# So: start as root, fix ownership of the writable paths, then irreversibly
# drop to paperforge before the server starts. The root phase is only
# `mkdir` + `chown`; no application code and no agent ever runs as root.
#
# If the container is already started as a non-root user (e.g. `docker run
# --user 10001`), we skip the chown and just verify the paths are writable.
#
set -eu

APP_USER="paperforge"
APP_GROUP="nodejs"

# Everything mutable lives under /data so a single mount covers it all.
JOBS_DIR="${PAPERFORGE_JOBS_DIR:-/data/jobs}"
DB_PATH="${PAPERFORGE_DB_PATH:-/data/paperforge.db}"
DB_DIR="$(dirname "$DB_PATH")"

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# Fail early with an actionable message instead of a stack trace from
# node:sqlite deep inside the app.
require_writable() {
  dir="$1"
  if ! mkdir -p "$dir" 2>/dev/null; then
    log "FATAL: cannot create $dir"
    log "If /data is mounted read-only, drop the ':ro' flag on the mount."
    log "Otherwise the mount is owned by another user; fix on the host with:"
    log "    sudo chown -R 10001:1001 <your-host-data-dir>"
    exit 1
  fi
  probe="$dir/.write-probe.$$"
  if ! ( : > "$probe" ) 2>/dev/null; then
    log "FATAL: $dir exists but is not writable by UID $(id -u)"
    log "If /data is mounted read-only, drop the ':ro' flag on the mount."
    log "Otherwise fix on the host with:"
    log "    sudo chown -R 10001:1001 <your-host-data-dir>"
    exit 1
  fi
  rm -f "$probe"
}

if [ "$(id -u)" = "0" ]; then
  log "running as root: preparing $DB_DIR and $JOBS_DIR for $APP_USER"

  # Do NOT let `set -e` abort on a bare mkdir: a read-only mount would then
  # print a raw "mkdir: can't create directory" and exit, hiding the actual
  # fix. require_writable() below reports it properly.
  mkdir -p "$DB_DIR" "$JOBS_DIR" 2>/dev/null || true
  require_writable "$JOBS_DIR"
  require_writable "$DB_DIR"

  # Only touch the tree when it is not already ours — a recursive chown on a
  # large jobs directory would add seconds to every boot.
  if [ "$(stat -c '%u:%g' "$DB_DIR")" != "10001:1001" ] \
     || [ "$(stat -c '%u:%g' "$JOBS_DIR")" != "10001:1001" ]; then
    chown -R "$APP_USER:$APP_GROUP" "$DB_DIR" "$JOBS_DIR" 2>/dev/null || true
  fi
  chmod 0775 "$JOBS_DIR" 2>/dev/null || true

  log "dropping privileges to $APP_USER and starting: $*"
  exec su-exec "$APP_USER:$APP_GROUP" "$@"
fi

# Already unprivileged: we cannot chown, so just prove we can write.
log "running as uid $(id -u); verifying writable paths"
require_writable "$JOBS_DIR"
require_writable "$DB_DIR"
exec "$@"

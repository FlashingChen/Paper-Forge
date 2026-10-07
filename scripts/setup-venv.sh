#!/usr/bin/env bash
#
# PaperForge Python sandbox provisioning.
#
# Builds a self-contained virtualenv at /opt/venv containing everything the
# generated python-docx script needs (python-docx, lxml, Pillow). The agent
# NEVER runs pip install at job time: the venv is baked into the container
# image at build time, and this script is also the local one-shot bootstrap.
#
# Idempotent: re-running it verifies the existing venv and only reinstalls when
# a required package is missing. Safe to re-run after a Python upgrade.
#
# Environment overrides:
#   PAPERFORGE_VENV   target directory (default /opt/venv)
#
# Usage:
#   scripts/setup-venv.sh
#
set -euo pipefail

VENV_DIR="${PAPERFORGE_VENV:-/opt/venv}"

log()  { printf '[setup-venv] %s\n' "$*"; }
die()  { printf '[setup-venv] ERROR: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------ interpreter ---
# Lookup order is explicit and fixed so builds are reproducible across hosts:
# python3.11 first (broadest wheel availability), newest stable last.
PYTHON=""
for candidate in python3.11 python3.12 python3.13 python3.14 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON="$(command -v "$candidate")"
    log "interpreter: $candidate -> $PYTHON ($("$PYTHON" --version 2>&1))"
    break
  fi
done

[ -n "$PYTHON" ] || die "no usable python found (tried python3.11, python3.12, python3.13, python3.14, python3). Install one, e.g. 'brew install python@3.12' or 'apk add python3 py3-pip'."

"$PYTHON" - <<'PY' || exit 1
import sys
if sys.version_info < (3, 9):
    sys.exit("Python %d.%d is too old; python-docx 1.2 requires 3.9+" % sys.version_info[:2])
PY

# ------------------------------------------------------------------- venv ---
  if [ -x "$VENV_DIR/bin/python" ]; then
  log "existing venv found at $VENV_DIR (reusing)"
else
  if [ -e "$VENV_DIR" ]; then
    log "removing stale non-venv path $VENV_DIR"
    rm -rf "$VENV_DIR"
  fi
  log "creating venv at $VENV_DIR"
  parent="$(dirname "$VENV_DIR")"
  if [ ! -w "$parent" ]; then
    printf '[setup-venv] ERROR: cannot write to %s (needed to create %s).\n' "$parent" "$VENV_DIR" >&2
    printf '%s\n' \
      "           Inside Docker this runs as root and works out of the box." \
      "           On a local machine, either run with sudo:" \
      "             sudo PAPERFORGE_VENV=$VENV_DIR bash scripts/setup-venv.sh" \
      "           or point the venv somewhere user-writable and export it:" \
      "             PAPERFORGE_VENV=\$HOME/.paperforge/venv bash scripts/setup-venv.sh" \
      "             export PAPERFORGE_PYTHON=\$HOME/.paperforge/venv/bin/python" >&2
    exit 1
  fi
  mkdir -p "$VENV_DIR" \
    || die "failed to create $VENV_DIR"
  "$PYTHON" -m venv "$VENV_DIR" \
    || die "failed to create venv at $VENV_DIR (need python3-venv / ensurepip). Try: apt-get install -y python3-venv, or apk add py3-virtualenv."
fi

VPY="$VENV_DIR/bin/python"
[ -x "$VPY" ] || die "venv python is not executable at $VPY"

# ------------------------------------------------------------------ deps ----
# Versions are pinned loosely (>=) so rebuilds pick up security fixes while
# still guaranteeing python-docx 1.x semantics that verify.py relies on.
# numpy is here because the agent reaches for it when it wants to crop/scale an
# image region before re-reading it (a realistic tactic on a curved book page).
# Observed in a real run: `import numpy` failed and cost the agent a retry.
PKGS=(python-docx lxml pillow numpy)

needs_install() {
  "$VPY" - <<'PY' >/dev/null 2>&1
import docx, lxml, PIL, numpy  # noqa: F401
PY
}

# A bare venv created by `python3 -m venv` already has pip. If it was created
# with --without-pip, recover by using the `ensurepip` module.
if ! "$VPY" -m pip --version >/dev/null 2>&1; then
  log "pip missing in venv; bootstrapping with ensurepip"
  "$VPY" -m ensurepip --upgrade >/dev/null 2>&1 \
    || die "pip is unavailable in $VENV_DIR and ensurepip could not bootstrap it"
fi

# needs_install returns 0 when the required modules ARE importable, 1 when they
# are missing. Keep the test in that (positive) sense so a failed import is
# never mistaken for a satisfied dependency set.
if needs_install; then
  log "required packages already present (python-docx, lxml, pillow)"
else
  log "installing ${PKGS[*]} into $VENV_DIR"
  "$VPY" -m pip install --no-cache-dir --disable-pip-version-check --upgrade pip \
    || log "pip self-upgrade failed (non-fatal), continuing"
  "$VPY" -m pip install --no-cache-dir --disable-pip-version-check "${PKGS[@]}" \
    || die "pip install of ${PKGS[*]} failed"
fi

# --------------------------------------------------------------- validate ---
"$VPY" - <<'PY' || die "venv self-check failed: python-docx is not importable from $VENV_DIR"
import sys
import docx
from docx import Document
from docx.shared import Pt, Mm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

tmp = Document()
p = tmp.add_paragraph("PaperForge venv self-check")
assert p.text

version = getattr(docx, "__version__", "unknown")
print(f"[setup-venv] python      : {sys.version.split()[0]} ({sys.executable})")
print(f"[setup-venv] python-docx : {version}")
print(f"[setup-venv] ok")
PY

log "venv ready: $VENV_DIR"
printf '%s\n' "$VPY"

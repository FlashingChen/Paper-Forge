#!/usr/bin/env bash
#
# PaperForge end-to-end smoke test.
#
# Runs the real pi agent against the two case photos with NO HTTP server in the
# loop: it builds a job directory by hand, invokes lib/pi-runner.ts directly via
# a tiny Node loader, and prints the full log plus the resulting .docx path.
#
# Usage:
#   scripts/e2e.sh                 # default venv: /tmp/pfvenv
#   PAPERFORGE_PYTHON=/opt/venv/bin/python scripts/e2e.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PYTHON_BIN="${PAPERFORGE_PYTHON:-/opt/venv/bin/python}"
if [ ! -x "$PYTHON_BIN" ]; then
  if [ -x /tmp/pfvenv/bin/python ]; then
    PYTHON_BIN=/tmp/pfvenv/bin/python
  else
    PYTHON_BIN="$(command -v python3)"
  fi
fi
export PAPERFORGE_PYTHON="$PYTHON_BIN"

echo "== PaperForge e2e =="
echo "project root : $ROOT"
echo "python       : $PAPERFORGE_PYTHON"
"$PAPERFORGE_PYTHON" -c 'import docx, sys; print("python-docx  :", sys.version.split()[0], "| docx", getattr(docx, "__version__", "1.2.0"))'

if [ ! -x "$ROOT/node_modules/.bin/tsx" ]; then
  echo "tsx is missing; installing it as a dev dependency (one-time) ..."
  npm install --no-audit --no-fund --save-dev tsx
fi

# ---------------------------------------------------------------- job dir ---
JOBS_DIR="${PAPERFORGE_JOBS_DIR:-$ROOT/.jobs}"
mkdir -p "$JOBS_DIR"
JOB_ID="e2e-$(date +%Y%m%d-%H%M%S)"
JOB_DIR="$JOBS_DIR/$JOB_ID"
mkdir -p "$JOB_DIR/in" "$JOB_DIR/out" "$JOB_DIR/reference" "$JOB_DIR/snippets"

echo "job dir      : $JOB_DIR"

# ---------------------------------------------------------------- inputs ----
shopt -s nullglob
CASES=("$ROOT"/cases/*.jpg "$ROOT"/cases/*.jpeg "$ROOT"/cases/*.png)
shopt -u nullglob

if [ "${#CASES[@]}" -eq 0 ]; then
  echo "ERROR: no case images found in $ROOT/cases (expected .jpg/.png)" >&2
  exit 1
fi

i=1
for src in "${CASES[@]}"; do
  ext="${src##*.}"
  cp "$src" "$JOB_DIR/in/$i.$ext"
  echo "copied       : $(basename "$src") -> in/$i.$ext"
  i=$((i + 1))
done

# Reference docx + task brief, exactly like lib/jobs.ts prepareJobDir() does.
for ref in "$ROOT"/reference/*.docx; do
  [ -e "$ref" ] || continue
  cp "$ref" "$JOB_DIR/reference/"
done
# Snippets live at the job ROOT: the task brief does `sys.path.insert(0, "snippets")`.
if [ -d "$ROOT/agent/snippets" ]; then
  cp -R "$ROOT"/agent/snippets/. "$JOB_DIR/snippets/"
fi

# ---------------------------------------------------------------- driver ----
DRIVER="$JOB_DIR/run-e2e.mts"
cat <<'EOF' > "$DRIVER"
import fs from "node:fs";
import path from "node:path";
import { createJob, prepareJobDir } from "@/lib/jobs";
import { runAgent } from "@/lib/pi-runner";

// Passed via PF_E2E_JOB_DIR: under tsx, process.argv does not reliably carry
// the script path, so argv-based parameter passing is not safe here.
const jobDir = path.resolve(
  process.env.PF_E2E_JOB_DIR ?? process.cwd(),
);
const jobId = path.basename(jobDir);

// Register the job in the in-memory registry, exactly like POST /api/jobs does
// before it calls runAgent. runAgent rejects unknown job ids by design.
createJob({ id: jobId });
prepareJobDir(jobId);

const inDir = path.join(jobDir, "in");
const images = fs
  .readdirSync(inDir)
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
  .map((filename, index) => ({
    index,
    filename,
    buffer: fs.readFileSync(path.join(inDir, filename)),
  }));

console.log(`[e2e] job dir   : ${jobDir}`);
console.log(
  `[e2e] ${images.length} image(s): ${images.map((i) => i.filename).join(", ")}`,
);

const started = Date.now();
const job = await runAgent({
  jobId,
  jobDir,
  images,
  onLog: (level, text) => {
    console.log(`[${level}] ${text}`);
  },
});

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log("");
console.log(`[e2e] status     : ${job.status}`);
if (job.error) console.log(`[e2e] error      : ${job.error}`);
if (job.resultPath) {
  const size = fs.statSync(job.resultPath).size;
  console.log(`[e2e] docx path  : ${job.resultPath}`);
  console.log(`[e2e] docx size  : ${size} bytes`);
}
console.log(`[e2e] elapsed    : ${seconds}s`);
console.log(`[e2e] node heap  : ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);

process.exit(job.status === "done" ? 0 : 1);
EOF

echo "running agent ..."
echo "----------------------------------------------------------------"
set +e
PF_E2E_JOB_DIR="$JOB_DIR" \
  "$ROOT/node_modules/.bin/tsx" \
  --tsconfig "$ROOT/tsconfig.json" \
  "$DRIVER"
STATUS=$?
set -e
echo "----------------------------------------------------------------"

RESULT="$JOB_DIR/out/result.docx"
echo ""
echo "job dir : $JOB_DIR"
if [ -f "$RESULT" ]; then
  echo "docx    : $RESULT"
  echo "size    : $(wc -c < "$RESULT" | tr -d ' ') bytes"
else
  echo "docx    : MISSING ($RESULT)"
fi
echo "logs    : GET /api/jobs/$JOB_ID (via the Next.js server)"

exit $STATUS

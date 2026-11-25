#!/usr/bin/env bash
# Write the desktop diagnostics client key into a RUNNER_TEMP file.
# Never prints the secret. Do not write GITHUB_ENV: that would expose
# the key to rustup, setup-*, and later steps in this job.
# The value is the blowhorn-site repository secret BLOWHORN_DIAGNOSTICS_KEY,
# passed only to this staging step of the signed build-dmg job.
set +x
set -euo pipefail

: "${RUNNER_TEMP:?}"
if [[ -z "${BLOWHORN_DIAGNOSTICS_KEY-}" ]]; then
  echo "BLOWHORN_DIAGNOSTICS_KEY is not configured. Expected a blowhorn-site repository secret of that name, passed only to this staging step of the signed build-dmg job."
  exit 2
fi

dir="$RUNNER_TEMP/blowhorn-diagnostics"
mkdir -p -m 700 "$dir"
python3 - <<'PY'
import os, sys
value = os.environ["BLOWHORN_DIAGNOSTICS_KEY"].strip()
if not value or "." not in value or value.startswith(".") or value.endswith("."):
    sys.stderr.write("BLOWHORN_DIAGNOSTICS_KEY is missing or not a key_id.secret value.\n")
    sys.exit(1)
path = os.path.join(os.environ["RUNNER_TEMP"], "blowhorn-diagnostics", "key")
with open(path, "w", encoding="utf-8") as handle:
    handle.write(value)
os.chmod(path, 0o600)
PY
echo "diagnostics key: written to a temporary directory"

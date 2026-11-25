#!/usr/bin/env bash
# Write signing secrets into RUNNER_TEMP files. Never prints a secret.
# The values are blowhorn-ai org secrets (selected for blowhorn and
# blowhorn-site) that resolve in the macos-dmg-signing environment job.
# Exits 2 when a required secret is missing. This job does not load keys
# from the private product repository.
set +x
set -euo pipefail
die_unconfigured() {
  echo "macos-dmg-signing secrets are not configured. Expected blowhorn-ai org secrets DEVELOPER_ID_P12, DEVELOPER_ID_P12_PASSPHRASE, APPLE_API_KEY, APPLE_TEAM_ID, APPLE_API_KEY_ID and APPLE_API_ISSUER, selected for blowhorn and blowhorn-site. This job does not load keys from the private product repository."
  exit 2
}

: "${RUNNER_TEMP:?}"
for name in DEVELOPER_ID_P12 DEVELOPER_ID_P12_PASSPHRASE APPLE_API_KEY APPLE_TEAM_ID APPLE_API_KEY_ID APPLE_API_ISSUER; do
  eval "value=\${$name-}"
  if [[ -z "$value" ]]; then
    die_unconfigured
  fi
done

dir="$RUNNER_TEMP/blowhorn-signing"
mkdir -p -m 700 "$dir"
# p12 is stored base64-encoded. Decode without printing.
python3 - <<'PY'
import base64, os, sys
raw = os.environ["DEVELOPER_ID_P12"].encode("ascii")
try:
    data = base64.b64decode(raw, validate=True)
except Exception:
    sys.stderr.write("macos-dmg-signing: DEVELOPER_ID_P12 is not valid base64\n")
    sys.exit(1)
if not data:
    sys.stderr.write("macos-dmg-signing secrets are not configured.\n")
    sys.exit(2)
path = os.path.join(os.environ["RUNNER_TEMP"], "blowhorn-signing", "developer-id.p12")
with open(path, "wb") as handle:
    handle.write(data)
os.chmod(path, 0o600)
PY

printf '%s' "$DEVELOPER_ID_P12_PASSPHRASE" >"$dir/p12-passphrase"
chmod 600 "$dir/p12-passphrase"
printf '%s' "$APPLE_API_KEY" >"$dir/api-key.p8"
chmod 600 "$dir/api-key.p8"

env_sh="$dir/env.sh"
github_vars="$dir/github.env"
cat >"$github_vars" <<ENV
SIGNING_DIR=$dir
SIGNING_P12=$dir/developer-id.p12
SIGNING_PASSPHRASE_FILE=$dir/p12-passphrase
SIGNING_P8=$dir/api-key.p8
SIGNING_KEYCHAIN=$dir/ci-signing.keychain-db
SIGNING_KEYCHAIN_PASSWORD_FILE=$dir/keychain.pass
APPLE_API_KEY=$dir/api-key.p8
APPLE_TEAM_ID=$APPLE_TEAM_ID
APPLE_API_KEY_ID=$APPLE_API_KEY_ID
APPLE_API_ISSUER=$APPLE_API_ISSUER
ENV
chmod 600 "$github_vars"
sed 's/^/export /' "$github_vars" >"$env_sh"
chmod 600 "$env_sh"
# Later signing steps source env.sh. Do not write GITHUB_ENV: that would
# expose Apple identifiers and signing paths to rustup, setup-*, and the
# artifact upload step.
echo "signing material: written to a temporary directory"

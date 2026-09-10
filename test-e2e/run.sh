#!/usr/bin/env bash
# One command from nothing to a proven end-to-end run:
# bring up an isolated simple-directory, seed an org admin, run the test.
set -euo pipefail
cd "$(dirname "$0")/.."

SITE="${E2E_SITE:-http://localhost:5690}"
SD_PATH="${E2E_SD_PATH:-/simple-directory}"

echo "==> bringing up the isolated stack"
docker compose up -d --wait

# compose reports healthy before simple-directory has finished its first-run
# key generation and upgrade scripts, so wait for the endpoint under test to
# answer. A 401 (or 400) means it is mounted and live; 404 would mean
# MANAGE_NHIS never took effect.
echo -n "==> waiting for the NHI exchange endpoint"
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
    -X POST "$SITE$SD_PATH/api/auth/nhi-token" \
    -H 'content-type: application/json' \
    -d '{"client_id":"nhi-probe","assertion":"probe"}' || echo 000)
  case "$code" in
    401|400) echo " ok ($code)"; break ;;
    404) echo; echo "FATAL: endpoint returns 404 — MANAGE_NHIS is not in effect" >&2; exit 1 ;;
    *) echo -n "."; sleep 1 ;;
  esac
  if [ "$i" = 60 ]; then echo; echo "FATAL: endpoint never became ready (last $code)" >&2; exit 1; fi
done

echo "==> seeding an organization and an admin of it"
# a separate file, not `eval "$(...)"`: command substitution hides the exit
# status, so a failed seed would surface later as a confusing missing-env error
node test-e2e/seed.ts > .e2e-env
# shellcheck disable=SC1091
source .e2e-env

echo "==> running the end-to-end test"
node --test --test-force-exit 'test-e2e/**/*.test.ts'

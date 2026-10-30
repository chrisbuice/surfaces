#!/bin/bash
# Nightly catch-up: fetch new lyrics, credits, seed analysis-pending
# Runs at 3am ET (8am UTC) via crontab
#
# Uses || true on lyrics/credits so failures don't block seed-pending.
# seed-pending runs without || true so its failure is visible in logs.

set -uo pipefail
cd ~/stack

echo "=== $(date -u '+%Y-%m-%d %H:%M UTC') nightly-catchup start ==="

echo "--- lyrics fetch ---"
docker compose -f lyrics-backfill/docker-compose.yml run --rm lyrics-backfill lyrics --limit 50 || true

echo "--- credits fetch ---"
docker compose -f lyrics-backfill/docker-compose.yml run --rm lyrics-backfill credits --limit 50 || true

echo "--- seed-pending ---"
docker compose -f lyrics-backfill/docker-compose.yml run --rm lyrics-backfill seed-pending

echo "=== $(date -u '+%Y-%m-%d %H:%M UTC') nightly-catchup done ==="

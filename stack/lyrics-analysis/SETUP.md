# Lyrics Analysis Container — Setup on grimmauldplace

## Prerequisites

- `stack/lyrics-backfill/` already working (proves D1 HTTP API access)
- Anthropic API key with access to Claude Sonnet 4.6

## Step 1: Copy to grimmauldplace

```bash
# From your laptop
scp -r stack/lyrics-analysis/ grimmauldplace:~/stack/lyrics-analysis/
```

## Step 2: Create the `.env`

```bash
ssh grimmauldplace
cd ~/stack/lyrics-analysis

# Copy CF_API_TOKEN and CF_ACCOUNT_ID from your lyrics-backfill .env
cp ../lyrics-backfill/.env .env

# Add your Anthropic API key
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
```

## Step 3: Build

```bash
docker compose build
```

## Step 4: Smoke test (dry run, 5 tracks)

```bash
docker compose run --rm lyrics-analysis analyze --dry-run --limit 5
```

This queries D1 for tracks needing analysis and prints what it would process. No API calls made.

## Step 5: Run the validation batch (91 blind-rated tracks)

```bash
docker compose run --rm lyrics-analysis analyze \
  --uris-file /app/blind-ratings.csv \
  --limit 5
```

Wait — the blind-ratings CSV needs to be inside the container. Easiest way: copy it in before building.

```bash
cp ~/spotifygenie/scripts/experiment/blind-ratings.csv .
# Rebuild to include it
docker compose build
docker compose run --rm lyrics-analysis analyze \
  --uris-file /app/blind-ratings.csv
```

This runs ~91 tracks synchronously through Sonnet (~2 req/sec). Takes ~3 minutes, costs ~$0.56.

## Step 6: Verify results

```bash
docker compose run --rm lyrics-analysis analyze --dry-run --limit 5
```

If it says "Nothing to do" or shows a much smaller count, the previous run succeeded.

You can also check D1 directly:
```bash
# From laptop
npx wrangler d1 execute spotify-agent-db --remote --json \
  --command "SELECT COUNT(*) as total, status FROM track_lyric_analysis_status GROUP BY status"
```

## Step 7: Seed the obsession tier + set up the chained cron

> **Post-experiment pivot (2026-05-04):** The full 47K-track batch is not justified — see `docs/PLAN_LYRICS_TRANSPARENCY_PIVOT.md`. Instead: eager-batch the ~800 most-queried tracks, then let a chained cron handle on-demand analysis.

### 7a: Eager batch (~800 tracks)

Run a one-time batch on the obsession tier (top tracks by affinity) plus any tracks with ≥10 lifetime plays. These are the tracks most likely to appear in "Why this song?" and "vibe twins" queries.

```bash
docker compose run --rm lyrics-analysis analyze \
  --uris-file /app/obsession-tier.csv --batch
```

Follow with embeddings:

```bash
docker compose run --rm lyrics-analysis embed --limit 1000
```

### 7b: Chained cron (every 10 minutes)

Set up a single crontab entry on grimmauldplace that chains lyrics fetch → analysis → embedding. This handles on-demand requests triggered by the Worker writing `pending` rows to `track_lyric_analysis_status`.

```bash
# grimmauldplace crontab
*/10 * * * * cd ~/stack && \
  docker compose -f lyrics-backfill/docker-compose.yml run --rm lyrics-backfill lyrics --limit 20 && \
  docker compose -f lyrics-analysis/docker-compose.yml run --rm lyrics-analysis analyze --limit 50 && \
  docker compose -f lyrics-analysis/docker-compose.yml run --rm lyrics-analysis embed --limit 50
```

This is a no-op when there are no pending tracks. At ~2 req/sec synchronous for analysis, a batch of 50 takes ~25 seconds. Worst-case panel latency for a never-before-seen track (with available lyrics) is 10 minutes.

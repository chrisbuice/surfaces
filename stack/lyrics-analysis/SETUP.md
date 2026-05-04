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

## Step 7: Full catalog run (later)

For the full 47K-track run, use the batch API:

```bash
docker compose run --rm lyrics-analysis analyze --batch
```

This submits to Anthropic's Message Batches API (50% cheaper, up to 24h turnaround per 10K-track batch).

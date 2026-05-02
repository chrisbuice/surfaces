# Lyrics-Backfill Container Setup on grimmauldplace

## Prerequisites

- Step 0 (`stack/hello/`) working — proves D1 HTTP API access
- Cloudflare Access service token created for the broker endpoint
- Cloudflare Access Application protecting `/admin/*` on the Worker hostname
- Broker verified via curl (see below)

---

## Step 1: Verify the Token Broker

Before setting up the container, confirm the broker works from your laptop:

```bash
curl -X POST https://surfaces.chrisbuice.com/admin/spotify-token \
  -H "CF-Access-Client-Id: <your-client-id>" \
  -H "CF-Access-Client-Secret: <your-client-secret>"
```

Expected: `{"access_token":"BQD...","expires_at":...}`

If this returns a 403, the Access Application isn't configured correctly.
If this returns a 500, the Worker has no Spotify tokens — run `/auth/login` first.

## Step 2: Create the `.env` on grimmauldplace

```bash
ssh grimmauldplace
nano ~/stack/lyrics-backfill/.env
```

Contents (same D1 vars as `stack/hello/.env`, plus broker vars):

```
CF_API_TOKEN=cfat_your_token_here
CF_ACCOUNT_ID=your_32_char_account_id_here
CF_D1_DATABASE_ID=a639e396-3fb1-4db6-b5a5-ce61c60d5779
BROKER_URL=https://surfaces.chrisbuice.com/admin/spotify-token
CF_ACCESS_CLIENT_ID=your_access_client_id
CF_ACCESS_CLIENT_SECRET=your_access_client_secret
```

## Step 3: Copy Files to grimmauldplace

From the repo root on your laptop:

```bash
# Copy the entire repo (the Dockerfile uses repo root as build context)
rsync -av --exclude node_modules --exclude .wrangler --exclude data \
  . grimmauldplace:~/stack/lyrics-backfill-repo/
```

Or if rsync isn't available, scp the needed files:

```bash
scp -r stack/lyrics-backfill/ grimmauldplace:~/stack/lyrics-backfill-repo/stack/lyrics-backfill/
scp -r src/lyrics/ grimmauldplace:~/stack/lyrics-backfill-repo/src/lyrics/
scp -r src/credits/ grimmauldplace:~/stack/lyrics-backfill-repo/src/credits/
```

## Step 4: Build the Container

```bash
ssh grimmauldplace
cd ~/stack/lyrics-backfill-repo
docker compose -f stack/lyrics-backfill/docker-compose.yml build
```

## Step 5: Smoke Test (5 items each)

```bash
# Test ISRC phase (needs Spotify — pause the Worker poll first if running full)
docker compose -f stack/lyrics-backfill/docker-compose.yml run --rm lyrics-backfill isrc --limit 5

# Test lyrics phase (no Spotify needed)
docker compose -f stack/lyrics-backfill/docker-compose.yml run --rm lyrics-backfill lyrics --limit 5

# Test credits phase (no Spotify needed)
docker compose -f stack/lyrics-backfill/docker-compose.yml run --rm lyrics-backfill credits --limit 5
```

## Step 6: Run the Full Backfill

Run each phase in order. Each is restart-safe — if interrupted, re-running picks up where it left off.

### Phase 1: ISRC (~30 min)

**Pause the per-minute poll first** to avoid Spotify rate-limit contention:

On the laptop, comment out these crons in `wrangler.toml`:
```toml
# schedule: * * * * *
# schedule: */2 * * * *
```
Deploy: `wrangler deploy`

Then on grimmauldplace:
```bash
docker compose -f stack/lyrics-backfill/docker-compose.yml run --rm lyrics-backfill isrc
```

After ISRC completes, **re-enable the crons** in `wrangler.toml` and `wrangler deploy`.

### Phase 2: Lyrics (~3 hours)

No poll conflict — run with crons enabled:
```bash
docker compose -f stack/lyrics-backfill/docker-compose.yml run --rm lyrics-backfill lyrics
```

### Phase 3: Credits (~28 hours)

No poll conflict — run with crons enabled. Survives disconnection if run under `tmux`/`screen`:
```bash
tmux new -s credits
docker compose -f stack/lyrics-backfill/docker-compose.yml run --rm lyrics-backfill credits
# Ctrl+B, D to detach; tmux attach -t credits to reconnect
```

## Step 7: Verify

From the laptop:
```bash
npx tsx scripts/verify-lyrics-credits.ts
```

Check that coverage meets targets from `PLAN_LYRICS_CREDITS_1.md` §8:
- Lyrics: ≥75% ok + instrumental
- Credits: ≥60% ok

# Step 0: Hello-World Container Setup on grimmauldplace

## Prerequisites

- SSH access to grimmauldplace via Tailscale
- Docker and Docker Compose installed on grimmauldplace
- Access to the Cloudflare dashboard

---

## Step 1: Create the Cloudflare API Token

1. Go to the Cloudflare dashboard
2. Navigate to **Manage Account → Account API Tokens**
   - This is the *account-owned* tokens page, not your personal user tokens
3. Click **Create Token**
4. Choose **Custom Token**
5. Fill in:
   - **Token name:** `grimmauldplace-d1-readwrite`
   - **Permissions:** Account · D1 · Edit
   - **Account Resources:** Include → your account
   - **Zone Resources:** leave empty
   - **TTL:** no expiration (rotate manually every 6 months)
6. Click **Continue to summary → Create Token**
7. **Copy the token immediately** — you won't see it again. It starts with `cfat_`.

## Step 2: Grab Your Account ID

1. Go to any page in the Cloudflare dashboard
2. Look at the right sidebar for **Account ID** (32-character hex string)
3. Copy it — you'll need it for the `.env` file

## Step 3: Create the Directory on grimmauldplace

```bash
ssh grimmauldplace
mkdir -p ~/stack/hello
```

## Step 4: Create the `.env` File

Use `nano` (not a heredoc) to keep the token out of shell history:

```bash
nano ~/stack/hello/.env
```

Paste this, replacing the placeholder values:

```
CF_API_TOKEN=cfat_your_token_here
CF_ACCOUNT_ID=your_32_char_account_id_here
CF_D1_DATABASE_ID=a639e396-3fb1-4db6-b5a5-ce61c60d5779
```

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

## Step 5: Copy the Container Files

From your laptop, in the `spotifygenie` repo directory:

```bash
scp stack/hello/Dockerfile stack/hello/hello.ts stack/hello/docker-compose.yml grimmauldplace:~/stack/hello/
```

If `scp` isn't working, you can paste each file manually via `nano` on grimmauldplace. The three files are:

- `Dockerfile` (6 lines)
- `hello.ts` (68 lines)
- `docker-compose.yml` (3 lines)

## Step 6: Run the Smoke Test

On grimmauldplace:

```bash
cd ~/stack/hello
docker compose run --rm hello
```

### Expected output (success):

```
Step 1: SELECT 1 ...
  ✓ [ { ok: 1 } ]
Step 2: INSERT (ran_at=1746200100, message="hello from grimmauldplace at 2026-05-02T15:35:00.000Z") ...
  ✓ row inserted
Step 3: SELECT back ...
  ✓ { id: 1, ran_at: 1746200100, message: 'hello from grimmauldplace at 2026-05-02T15:35:00.000Z' }

All three steps passed. D1 HTTP API round-trip works from grimmauldplace.
```

### If it fails:

The script prints the HTTP status code, rate-limit headers, and response body. Paste the full output and we'll diagnose.

Common failure modes:
- **401/403:** Token wrong scope, or you used a user-owned token instead of account-owned
- **404:** Account ID or Database ID is wrong
- **Network error:** DNS or tunnel issue on grimmauldplace

## Step 7: Verify from Your Laptop

After the container succeeds, confirm the row actually landed in D1:

```bash
npx wrangler d1 execute spotify-agent-db --remote --command="SELECT * FROM hello_heartbeat ORDER BY id DESC LIMIT 5"
```

You should see at least one row with a recent `ran_at` timestamp and the `hello from grimmauldplace` message.

---

## What's in each file

| File | Purpose |
|------|---------|
| `.env` | Cloudflare credentials (never committed) |
| `Dockerfile` | Node 22 Alpine + tsx@4, copies and runs `hello.ts` |
| `hello.ts` | SELECT 1, INSERT a row, SELECT it back — three D1 HTTP API calls |
| `docker-compose.yml` | Single service, no ports, reads `.env` |

## After success

Don't delete the container. It becomes a known-good reference for the next offload container (`stack/lyrics/`, `stack/constellation/`, etc.) and can double as a heartbeat check.

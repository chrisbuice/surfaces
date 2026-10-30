# Decision: MusicBrainz API connectivity block (2026-05-05)

## Diagnosis

MusicBrainz API (`musicbrainz.org`) is unreachable from this machine as of 2026-05-05. The failure is server-side, not client-side.

### Evidence

**Three independent TLS stacks all fail identically:**
- `curl` (LibreSSL): `SSL_connect: SSL_ERROR_SYSCALL in connection to musicbrainz.org:443`
- Python `urllib.request` (OpenSSL): `SSL: UNEXPECTED_EOF_WHILE_READING`
- Node.js `fetch` (undici): `fetch failed`

**TCP connects, TLS handshake does not:**
- `nc -z musicbrainz.org 443` succeeds — port is open, TCP handshake completes
- `openssl s_client` shows: Client Hello sent (1553 bytes written), server reads 0 bytes, drops connection before sending its certificate
- "no peer certificate available" — the server never responds to the TLS handshake

**Not a network-wide issue:**
- LRCLIB, ReccoBeats, Spotify, hetzner.com (same hosting provider as MB) all work fine
- Only `musicbrainz.org` is affected, on both IPv4 (`142.132.241.153`) and IPv6 (`2a01:4f8:c011:f68::1`)

**Not HTTPS-specific:**
- Plain HTTP to `musicbrainz.org` also fails (HTTP 000 = connection reset)
- This suggests an IP-level block, not a TLS configuration issue

### Cause

**Not a rate-limit block.** The initial hypothesis was that the credits backfill scripts triggered a per-IP rate limit. This was disconfirmed: the credits backfill ran from grimmauldplace, not the laptop, and grimmauldplace can reach MB cleanly today (full TLS handshake, valid certificate, HTTP/2 connection, requests succeed).

**Residential IP block.** Chris's laptop connects from a Costa Rican residential ISP. The most parsimonious explanation is that this IP or IP range is on an abuse-detection list shared across ISP customers — not because of anything Chris did, but because other customers on the same ISP have tripped MusicBrainz's abuse filters. This is a known pattern with residential IPs in regions with smaller ISPs where many customers share a narrow IP range.

The MusicBrainz API was never directly called from this laptop; all prior MB interactions (credits backfill) ran from grimmauldplace. The block was always present from this IP — it was simply never tested until Step 2.

## Impact on cover detection

The cover detection pipeline has two candidate generation paths:

**Path A (MB work expansion):** Queries MB for all recordings linked to a composition's work ID. This is the high-precision path — it surfaces alternate recordings that share verified composition metadata, even if they have completely different titles or artists. **Currently blocked.**

**Path B (Spotify title search):** Searches Spotify for tracks with similar titles. This is the high-recall path for popular titles but has a critical weakness: very short or very common titles (e.g., "Words") return dozens of unrelated tracks that must be filtered by the lyric gate.

**What Path A is needed for:** The canonical test case is Birdy "Words" → EDX Remix. The title "Words" is so common that Path B's top ~25 search results are all unrelated songs by other artists. The EDX Remix never appears. Path A would find it through the MB work relation (`3ec51142-5b15-4faf-9c6e-afdf19b2dd33`).

**What works without Path A:** All three audio-eligible spike anchors reproduced correctly via Path B alone:
- Milky Chance "Levitating" → `different_sonic_world` (1.310)
- Leonard Cohen "Hallelujah" → `alternate_version` (0.452)
- Dolly Parton "I Will Always Love You" → `alternate_version` (0.329)

## Followup plan

1. **Path A must run from grimmauldplace.** This is not an offload optimization — it is a correctness requirement. The laptop IP block may not clear and may recur on other Costa Rican networks. All MusicBrainz API calls (credits backfill and cover discovery Path A) should be grimmauldplace-only going forward.
2. **Step 2 validation runs from grimmauldplace** with all four canonical seeds. Birdy "Words" → EDX Remix is the gating test case for Path A.
3. **Step 3 batch backfill** (`--top 200`) will also run from grimmauldplace, since Path A is needed for recall on short/common titles.

## Step 2 gate status

Step 2 is **code-complete and feature-correct for Path B**. Path A is unvalidated from the laptop but must be validated from grimmauldplace. The Step 2 gate (all canonical cover pairs surface in correct buckets) requires a grimmauldplace run. Step 3 batch backfill should not proceed until Path A is validated.

---

*Documented: 2026-05-05.*

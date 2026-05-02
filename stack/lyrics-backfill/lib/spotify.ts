/**
 * spotify.ts — Fetch Spotify access tokens via the Worker's broker endpoint.
 *
 * The broker (POST /admin/spotify-token) is protected by Cloudflare Access.
 * This client authenticates with a service token and caches the access token
 * in memory for its lifetime.
 *
 * Env vars: BROKER_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
 */

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const EXPIRY_BUFFER_S = 300; // re-fetch 5 min before expiry

let cachedToken: string | null = null;
let cachedExpiresAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getConfig() {
  const brokerUrl = process.env.BROKER_URL;
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!brokerUrl || !clientId || !clientSecret) {
    throw new Error("Missing env: BROKER_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET");
  }
  return { brokerUrl, clientId, clientSecret };
}

/** Get a valid Spotify access token, fetching from broker if needed. */
export async function getSpotifyToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedExpiresAt - EXPIRY_BUFFER_S) {
    return cachedToken;
  }

  const { brokerUrl, clientId, clientSecret } = getConfig();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(brokerUrl, {
      method: "POST",
      headers: {
        "CF-Access-Client-Id": clientId,
        "CF-Access-Client-Secret": clientSecret,
      },
    });

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Broker rate limited after ${MAX_RETRIES} retries`);
      }
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : BASE_DELAY_MS * Math.pow(2, attempt);
      console.log(`  Broker 429 — waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Broker error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { access_token: string; expires_at: number };
    cachedToken = data.access_token;
    cachedExpiresAt = data.expires_at;
    return cachedToken;
  }

  throw new Error("Unreachable");
}

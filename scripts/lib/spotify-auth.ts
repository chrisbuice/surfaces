/**
 * spotify-auth.ts — Spotify client_credentials auth for ingest scripts.
 *
 * Only needs public catalog reads (search, tracks endpoints).
 * Uses SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET from env.
 */

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const EXPIRY_BUFFER_S = 60;
const FETCH_TIMEOUT_MS = 30_000;

let cachedToken: string | null = null;
let cachedExpiresAt = 0;

export function getSpotifyCredentials() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing env: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET");
  }
  return { clientId, clientSecret };
}

/**
 * Get a valid Spotify access token via client_credentials grant.
 * Caches in memory; re-fetches when expired.
 */
export async function getSpotifyToken(
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedExpiresAt - EXPIRY_BUFFER_S) {
    return cachedToken;
  }

  const { clientId, clientSecret } = getSpotifyCredentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(TOKEN_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: "grant_type=client_credentials",
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Spotify token request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  cachedExpiresAt = now + data.expires_in;
  return cachedToken;
}

/** Reset cached token (for testing). */
export function resetTokenCache(): void {
  cachedToken = null;
  cachedExpiresAt = 0;
}

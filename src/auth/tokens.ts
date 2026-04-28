/**
 * tokens.ts — KV-backed storage for Spotify OAuth tokens.
 *
 * We store three things in KV:
 *   "spotify:access_token"  — short-lived (~1 hour) token for API calls
 *   "spotify:refresh_token" — long-lived token used to get new access tokens
 *   "spotify:token_expires"  — unix-seconds when the access token expires
 */

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
}

const KEY_ACCESS = "spotify:access_token";
const KEY_REFRESH = "spotify:refresh_token";
const KEY_EXPIRES = "spotify:token_expires";

export async function getTokens(kv: KVNamespace): Promise<TokenData | null> {
  const [accessToken, refreshToken, expiresStr] = await Promise.all([
    kv.get(KEY_ACCESS),
    kv.get(KEY_REFRESH),
    kv.get(KEY_EXPIRES),
  ]);
  if (!refreshToken) return null;
  return {
    accessToken: accessToken ?? "",
    refreshToken,
    expiresAt: expiresStr ? parseInt(expiresStr, 10) : 0,
  };
}

export async function saveTokens(kv: KVNamespace, data: TokenData): Promise<void> {
  await Promise.all([
    kv.put(KEY_ACCESS, data.accessToken),
    kv.put(KEY_REFRESH, data.refreshToken),
    kv.put(KEY_EXPIRES, data.expiresAt.toString()),
  ]);
}

export async function isTokenExpired(kv: KVNamespace): Promise<boolean> {
  const tokens = await getTokens(kv);
  if (!tokens) return true;
  // Consider expired 60 seconds early to avoid race conditions
  return Math.floor(Date.now() / 1000) >= tokens.expiresAt - 60;
}

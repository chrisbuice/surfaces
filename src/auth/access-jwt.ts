/**
 * access-jwt.ts — Verify Cloudflare Access JWTs using the JWKS endpoint.
 *
 * Uses Web Crypto API only (no third-party JWT library).
 * Caches the JWKS in KV for 1 hour to avoid fetching on every request.
 */

interface Env {
  KV: KVNamespace;
  ACCESS_TEAM_NAME: string;
  ACCESS_AUD: string;
}

interface VerifyResult {
  ok: boolean;
  email?: string;
  common_name?: string;
  reason?: string;
  _debug_payload?: Record<string, unknown>; // TEMPORARY — remove after debugging
}

interface JwksKey {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
  use?: string;
}

interface JwtHeader {
  alg: string;
  kid: string;
  typ?: string;
}

interface JwtPayload {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  iss: string;
  sub: string;
  [key: string]: unknown;
}

const JWKS_CACHE_KEY = "access_jwks";
const JWKS_TTL = 3600; // 1 hour

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtPart<T>(part: string): T {
  const bytes = base64UrlDecode(part);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

async function getJwks(env: Env): Promise<JwksKey[]> {
  // Try cache first
  const cached = await env.KV.get(JWKS_CACHE_KEY);
  if (cached) {
    return JSON.parse(cached) as JwksKey[];
  }

  // Fetch from Cloudflare Access
  const url = `https://${env.ACCESS_TEAM_NAME}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch JWKS: ${resp.status}`);
  }
  const data = (await resp.json()) as { keys: JwksKey[] };

  // Cache in KV
  await env.KV.put(JWKS_CACHE_KEY, JSON.stringify(data.keys), { expirationTtl: JWKS_TTL });

  return data.keys;
}

async function importKey(jwk: JwksKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export async function verifyAccessJwt(request: Request, env: Env): Promise<VerifyResult> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return { ok: false, reason: "missing_jwt" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed_jwt" };
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode header to find kid
  let header: JwtHeader;
  try {
    header = decodeJwtPart<JwtHeader>(headerB64);
  } catch {
    return { ok: false, reason: "invalid_header" };
  }

  if (header.alg !== "RS256") {
    return { ok: false, reason: "invalid_algorithm" };
  }

  // Decode payload
  let payload: JwtPayload;
  try {
    payload = decodeJwtPart<JwtPayload>(payloadB64);
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    return { ok: false, reason: "expired" };
  }

  // Check audience
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(env.ACCESS_AUD)) {
    return { ok: false, reason: "invalid_audience" };
  }

  // Check issuer
  const expectedIssuer = `https://${env.ACCESS_TEAM_NAME}.cloudflareaccess.com`;
  if (payload.iss !== expectedIssuer) {
    return { ok: false, reason: "invalid_issuer" };
  }

  // Get JWKS and find matching key
  let keys: JwksKey[];
  try {
    keys = await getJwks(env);
  } catch {
    return { ok: false, reason: "jwks_fetch_failed" };
  }

  let matchingKey = keys.find(k => k.kid === header.kid);
  if (!matchingKey) {
    // Cache may be stale — Cloudflare rotated keys. Bust the cache and retry once.
    await env.KV.delete(JWKS_CACHE_KEY);
    try {
      keys = await getJwks(env);
    } catch {
      return { ok: false, reason: "jwks_refetch_failed" };
    }
    matchingKey = keys.find(k => k.kid === header.kid);
    if (!matchingKey) {
      return { ok: false, reason: "unknown_kid" };
    }
  }

  // Verify signature
  try {
    const cryptoKey = await importKey(matchingKey);
    const signatureBytes = base64UrlDecode(signatureB64);
    const dataBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signatureBytes,
      dataBytes,
    );

    if (!valid) {
      return { ok: false, reason: "invalid_signature" };
    }
  } catch {
    return { ok: false, reason: "verification_error" };
  }

  return { ok: true, email: payload.email, common_name: payload.common_name as string | undefined, _debug_payload: payload as unknown as Record<string, unknown> };
}

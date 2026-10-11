/**
 * auth-health.ts — knows when Spotify authorization will die, and says so loudly.
 *
 * Spotify refresh tokens expire 6 months after the *first* authorization and
 * refreshing does NOT extend that. So we track `authorized_at` (written only by a
 * real /auth/login → /auth/callback, never by a token refresh) and email before
 * the cliff. If a refresh is rejected outright (invalid_grant / invalid_client)
 * we set `spotify:auth_broken`, which short-circuits every Spotify call.
 */

import { AUTH_BROKEN_KEY } from "../spotify/rate-guard";
import { sendEmail } from "../email/send";

export const AUTHORIZED_AT_KEY = "spotify:authorized_at";
const ALERT_KEY_PREFIX = "spotify:auth_alert:";

export const AUTH_LIFETIME_DAYS = 180;
/** Days since authorization at which a warning email fires (highest crossed wins). */
export const WARN_THRESHOLDS = [150, 165, 175] as const;

const LOGIN_URL = "https://spotify-agent.chrisbuice.workers.dev/auth/login";
const DAY_MS = 86_400_000;

export type AuthStatus = "ok" | "expiring" | "broken" | "unknown";
export type AuthAlertKind = "warn-150" | "warn-165" | "warn-175" | "broken";

export interface AuthBrokenFlag {
  reason: string;
  at: number; // epoch ms
}

export interface AuthHealth {
  status: AuthStatus;
  daysSinceAuth: number | null;
  daysUntilExpiry: number | null;
  alert: AuthAlertKind | null;
}

/** Pure: no I/O, so boundaries are trivially testable. */
export function evaluateAuthHealth(input: {
  authorizedAt: number | null; // epoch ms
  authBroken: AuthBrokenFlag | null;
  now: number; // epoch ms
}): AuthHealth {
  const { authorizedAt, authBroken, now } = input;
  const daysSinceAuth =
    authorizedAt === null ? null : Math.floor((now - authorizedAt) / DAY_MS);
  const daysUntilExpiry =
    daysSinceAuth === null ? null : AUTH_LIFETIME_DAYS - daysSinceAuth;

  if (authBroken) {
    return { status: "broken", daysSinceAuth, daysUntilExpiry, alert: "broken" };
  }
  if (daysSinceAuth === null) {
    // Never authorized via the callback since this feature shipped. Not an alarm —
    // the first re-login seeds it.
    return { status: "unknown", daysSinceAuth, daysUntilExpiry, alert: null };
  }

  let alert: AuthAlertKind | null = null;
  for (const t of WARN_THRESHOLDS) {
    if (daysSinceAuth >= t) alert = `warn-${t}` as AuthAlertKind;
  }
  const status: AuthStatus = daysSinceAuth >= WARN_THRESHOLDS[0] ? "expiring" : "ok";
  return { status, daysSinceAuth, daysUntilExpiry, alert };
}

// ── KV writers ──

/** Call ONLY from a successful /auth/callback. Also clears any broken flag. */
export async function markAuthorized(kv: KVNamespace, now = Date.now()): Promise<void> {
  await kv.put(AUTHORIZED_AT_KEY, String(now));
  await kv.delete(AUTH_BROKEN_KEY);
}

export async function markAuthBroken(
  kv: KVNamespace,
  reason: string,
  now = Date.now(),
): Promise<void> {
  const flag: AuthBrokenFlag = { reason, at: now };
  await kv.put(AUTH_BROKEN_KEY, JSON.stringify(flag));
  console.error(`SPOTIFY_AUTH_BROKEN reason=${reason}`);
}

// ── KV reader ──

export async function getAuthHealth(kv: KVNamespace, now = Date.now()): Promise<AuthHealth> {
  const [rawAt, rawBroken] = await Promise.all([
    kv.get(AUTHORIZED_AT_KEY),
    kv.get(AUTH_BROKEN_KEY),
  ]);
  const parsedAt = rawAt ? parseInt(rawAt, 10) : NaN;
  let authBroken: AuthBrokenFlag | null = null;
  if (rawBroken) {
    try {
      authBroken = JSON.parse(rawBroken) as AuthBrokenFlag;
    } catch {
      authBroken = { reason: "unknown", at: now };
    }
  }
  return evaluateAuthHealth({
    authorizedAt: Number.isFinite(parsedAt) ? parsedAt : null,
    authBroken,
    now,
  });
}

// ── Alerting ──

interface AlertEnv {
  KV: KVNamespace;
  RESEND_API_KEY: string;
  NOTIFICATION_EMAIL: string;
}

function renderAlert(kind: AuthAlertKind, health: AuthHealth): { subject: string; html: string } {
  const link = `<p><a href="${LOGIN_URL}">Re-authorize Spotify</a> (takes 10 seconds).</p>`;
  if (kind === "broken") {
    return {
      subject: "Action needed: Surfaces lost its Spotify authorization",
      html: `<p>Spotify rejected the stored refresh token, so Surfaces has stopped polling. Nothing is being recorded until you log in again.</p>${link}`,
    };
  }
  const left = health.daysUntilExpiry ?? 0;
  const when = left > 0 ? `in about ${left} day${left === 1 ? "" : "s"}` : "now";
  return {
    subject: `Action needed: Surfaces' Spotify authorization expires ${when}`,
    html: `<p>Spotify refresh tokens die 6 months after login, no matter how often they're refreshed. Yours was issued ${health.daysSinceAuth} days ago.</p>${link}`,
  };
}

/**
 * Evaluate health and email if a threshold is newly crossed. Idempotent per
 * authorization cycle: the dedupe key embeds authorized_at, so a re-login resets it.
 * The key is only written after a successful send, so a failed send retries tomorrow.
 */
export async function runAuthHealthCheck(
  env: AlertEnv,
  now = Date.now(),
): Promise<AuthHealth & { emailed: boolean }> {
  const health = await getAuthHealth(env.KV, now);
  if (!health.alert) return { ...health, emailed: false };

  const authorizedAt = (await env.KV.get(AUTHORIZED_AT_KEY)) ?? "none";
  const dedupeKey = `${ALERT_KEY_PREFIX}${health.alert}:${authorizedAt}`;
  if (await env.KV.get(dedupeKey)) return { ...health, emailed: false };

  const { subject, html } = renderAlert(health.alert, health);
  const result = await sendEmail(env.RESEND_API_KEY, env.NOTIFICATION_EMAIL, subject, html);
  if (!result.sent) {
    console.error(`AUTH_ALERT_SEND_FAILED kind=${health.alert} error=${result.error}`);
    return { ...health, emailed: false };
  }

  // Broken alerts repeat daily until fixed; threshold alerts fire once per cycle.
  const ttl = health.alert === "broken" ? 86_400 : 200 * 86_400;
  await env.KV.put(dedupeKey, "1", { expirationTtl: ttl });
  return { ...health, emailed: true };
}

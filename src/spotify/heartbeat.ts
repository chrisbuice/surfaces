/**
 * heartbeat.ts — "when did Spotify last actually work?"
 *
 * Catches failure modes auth-health can't name (quota, revoked app, API changes):
 * if no Spotify call has succeeded for 24h, the daily cron emails. Writes are
 * throttled to one per 10 minutes per isolate to stay far inside KV write limits.
 */

import { sendEmail } from "../email/send";
import { AUTH_BROKEN_KEY } from "./rate-guard";

export const LAST_OK_KEY = "spotify:last_ok_at";
export const HEARTBEAT_WRITE_INTERVAL_MS = 10 * 60 * 1000;
export const STALE_AFTER_MS = 24 * 3600 * 1000;
const STALE_ALERT_KEY = "spotify:auth_alert:stale";

let lastWriteAt = 0;

/** Test helper: forget the in-isolate throttle. */
export function resetHeartbeatThrottle(): void {
  lastWriteAt = 0;
}

export async function recordSpotifySuccess(kv: KVNamespace, now = Date.now()): Promise<void> {
  if (now - lastWriteAt < HEARTBEAT_WRITE_INTERVAL_MS) return;
  lastWriteAt = now;
  try {
    await kv.put(LAST_OK_KEY, String(now));
  } catch (err) {
    // Never let bookkeeping break a real Spotify call.
    console.error(`HEARTBEAT_WRITE_ERROR ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface HeartbeatEnv {
  KV: KVNamespace;
  RESEND_API_KEY: string;
  NOTIFICATION_EMAIL: string;
}

export async function runHeartbeatCheck(
  env: HeartbeatEnv,
  now = Date.now(),
): Promise<{ stale: boolean; emailed: boolean; hoursSinceOk: number | null }> {
  const raw = await env.KV.get(LAST_OK_KEY);
  const last = raw ? parseInt(raw, 10) : NaN;
  // No heartbeat yet (fresh deploy): not an alarm, the first success seeds it.
  if (!Number.isFinite(last)) return { stale: false, emailed: false, hoursSinceOk: null };

  const age = now - last;
  const hoursSinceOk = Math.floor(age / 3_600_000);
  if (age <= STALE_AFTER_MS) return { stale: false, emailed: false, hoursSinceOk };

  // A broken-auth email already covers this; don't double up.
  if (await env.KV.get(AUTH_BROKEN_KEY)) return { stale: true, emailed: false, hoursSinceOk };
  if (await env.KV.get(STALE_ALERT_KEY)) return { stale: true, emailed: false, hoursSinceOk };

  const result = await sendEmail(
    env.RESEND_API_KEY,
    env.NOTIFICATION_EMAIL,
    `Action needed: Surfaces hasn't reached Spotify in ${hoursSinceOk}h`,
    `<p>No Spotify API call has succeeded for ${hoursSinceOk} hours, but auth isn't flagged as broken. Possible causes: quota, revoked app, API change, or Spotify outage.</p><p>Check <code>/debug/auth-health</code> and the worker logs.</p>`,
  );
  if (!result.sent) {
    console.error(`HEARTBEAT_ALERT_SEND_FAILED error=${result.error}`);
    return { stale: true, emailed: false, hoursSinceOk };
  }
  await env.KV.put(STALE_ALERT_KEY, "1", { expirationTtl: 86_400 });
  return { stale: true, emailed: true, hoursSinceOk };
}

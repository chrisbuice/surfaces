/**
 * d1.ts — Cloudflare D1 HTTP API client with retry/backoff.
 *
 * Reusable across grimmauldplace containers. Reads config from env:
 *   CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID
 */

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

function getConfig() {
  const token = process.env.CF_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  const databaseId = process.env.CF_D1_DATABASE_ID;
  if (!token || !accountId || !databaseId) {
    throw new Error("Missing env: CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID");
  }
  return { token, accountId, databaseId };
}

function getUrl(): string {
  const { accountId, databaseId } = getConfig();
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface D1Response {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: Array<{
    success: boolean;
    results: Record<string, unknown>[];
    meta: Record<string, unknown>;
  }>;
}

async function d1Fetch(body: unknown): Promise<D1Response> {
  const { token } = getConfig();
  const url = getUrl();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        const text = await res.text();
        throw new Error(`D1 rate limited after ${MAX_RETRIES} retries: ${text}`);
      }
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : BASE_DELAY_MS * Math.pow(2, attempt);
      console.log(`  D1 429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      const headers: string[] = [];
      for (const [k, v] of res.headers.entries()) {
        if (k.startsWith("cf-") || k.startsWith("x-ratelimit") || k === "retry-after") {
          headers.push(`${k}: ${v}`);
        }
      }
      throw new Error(
        `D1 HTTP API ${res.status}: ${text}${headers.length ? "\n  Headers: " + headers.join(", ") : ""}`,
      );
    }

    return res.json() as Promise<D1Response>;
  }

  throw new Error("Unreachable");
}

/** Run a single SQL query, return the result rows. */
export async function queryD1<T = Record<string, unknown>>(
  sql: string,
  params: (string | number | null)[] = [],
): Promise<T[]> {
  const resp = await d1Fetch({ sql, params });
  if (!resp.success || !resp.result?.[0]?.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(resp.errors)}`);
  }
  return resp.result[0].results as T[];
}

/** Run a single SQL write (INSERT/UPDATE/DELETE). */
export async function writeD1(
  sql: string,
  params: (string | number | null)[] = [],
): Promise<void> {
  const resp = await d1Fetch({ sql, params });
  if (!resp.success || !resp.result?.[0]?.success) {
    throw new Error(`D1 write failed: ${JSON.stringify(resp.errors)}`);
  }
}

/** Run multiple SQL statements in a single HTTP call. */
export async function batchWriteD1(
  statements: Array<{ sql: string; params?: (string | number | null)[] }>,
): Promise<void> {
  // D1 HTTP API accepts an array of statements as the body
  const body = statements.map((s) => ({
    sql: s.sql,
    params: s.params ?? [],
  }));
  const { token } = getConfig();
  const url = getUrl();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        const text = await res.text();
        throw new Error(`D1 batch rate limited after ${MAX_RETRIES} retries: ${text}`);
      }
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : BASE_DELAY_MS * Math.pow(2, attempt);
      console.log(`  D1 batch 429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`D1 batch HTTP API ${res.status}: ${text}`);
    }

    const resp = (await res.json()) as D1Response;
    if (!resp.success) {
      throw new Error(`D1 batch failed: ${JSON.stringify(resp.errors)}`);
    }
    return;
  }
}

/**
 * hello.ts — Prove D1 HTTP API round-trip from grimmauldplace.
 *
 * Does exactly three things:
 *   1. SELECT 1               — proves the connection works
 *   2. INSERT into hello_heartbeat — writes a timestamped row
 *   3. SELECT it back          — confirms the write landed
 *
 * Reads CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID from env.
 * Exits 0 on success, 1 on any failure with full error details.
 */

const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_D1_DATABASE_ID = process.env.CF_D1_DATABASE_ID;

if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_D1_DATABASE_ID) {
  console.error("Missing required env vars. Need: CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID");
  process.exit(1);
}

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/query`;

interface D1Result {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: Array<{
    success: boolean;
    results: Record<string, unknown>[];
    meta: Record<string, unknown>;
  }>;
}

async function queryD1(sql: string, params: (string | number)[] = []): Promise<D1Result> {
  const res = await fetch(D1_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });

  if (!res.ok) {
    console.error(`\nD1 HTTP API error:`);
    console.error(`  Status: ${res.status} ${res.statusText}`);
    console.error(`  Headers:`);
    for (const [k, v] of res.headers.entries()) {
      if (k.startsWith("cf-") || k.startsWith("x-ratelimit") || k === "retry-after") {
        console.error(`    ${k}: ${v}`);
      }
    }
    const body = await res.text();
    console.error(`  Body: ${body}`);
    process.exit(1);
  }

  return res.json() as Promise<D1Result>;
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const message = `hello from grimmauldplace at ${new Date().toISOString()}`;

  // Step 1: SELECT 1
  console.log("Step 1: SELECT 1 ...");
  const step1 = await queryD1("SELECT 1 AS ok");
  if (!step1.success || !step1.result?.[0]?.success) {
    console.error("Step 1 failed:", JSON.stringify(step1, null, 2));
    process.exit(1);
  }
  console.log("  ✓", step1.result[0].results);

  // Step 2: INSERT
  console.log(`Step 2: INSERT (ran_at=${now}, message="${message}") ...`);
  const step2 = await queryD1(
    "INSERT INTO hello_heartbeat (ran_at, message) VALUES (?, ?)",
    [now, message],
  );
  if (!step2.success || !step2.result?.[0]?.success) {
    console.error("Step 2 failed:", JSON.stringify(step2, null, 2));
    process.exit(1);
  }
  console.log("  ✓ row inserted");

  // Step 3: SELECT it back
  console.log("Step 3: SELECT back ...");
  const step3 = await queryD1("SELECT * FROM hello_heartbeat ORDER BY id DESC LIMIT 1");
  if (!step3.success || !step3.result?.[0]?.success) {
    console.error("Step 3 failed:", JSON.stringify(step3, null, 2));
    process.exit(1);
  }
  const row = step3.result[0].results[0];
  console.log("  ✓", row);

  console.log("\nAll three steps passed. D1 HTTP API round-trip works from grimmauldplace.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});

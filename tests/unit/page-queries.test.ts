import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { buildListeningByMonth } from "../../src/listening/page-queries";

// Minimal plays table: only the columns buildListeningByMonth reads,
// plus `source` with the same default as migration 015.
const PLAYS_DDL =
  "CREATE TABLE IF NOT EXISTS plays (" +
  "id INTEGER PRIMARY KEY, year INTEGER NOT NULL, month INTEGER NOT NULL, " +
  "source TEXT NOT NULL DEFAULT 'spotify');";

async function insert(db: D1Database, year: number, month: number, source: string | null, n: number) {
  for (let i = 0; i < n; i++) {
    if (source === null) {
      await db.prepare("INSERT INTO plays (year, month) VALUES (?, ?)").bind(year, month).run();
    } else {
      await db.prepare("INSERT INTO plays (year, month, source) VALUES (?, ?, ?)")
        .bind(year, month, source).run();
    }
  }
}

describe("buildListeningByMonth", () => {
  beforeEach(async () => {
    await env.DB.exec("DROP TABLE IF EXISTS plays;");
    await env.DB.exec(PLAYS_DDL);
  });

  it("splits plays into spotify and other, keeping the total", async () => {
    await insert(env.DB, 2021, 11, "spotify", 2);
    await insert(env.DB, 2021, 11, "apple", 5);
    await insert(env.DB, 2022, 1, null, 3); // default source → spotify

    const result = await buildListeningByMonth(env.DB);

    expect(result.months).toEqual([
      { month: "2021-11", plays: 7, plays_spotify: 2, plays_other: 5 },
      { month: "2022-01", plays: 3, plays_spotify: 3, plays_other: 0 },
    ]);
  });

  it("returns an Apple-only month with zero spotify plays", async () => {
    await insert(env.DB, 2022, 3, "apple", 4);

    const result = await buildListeningByMonth(env.DB);

    expect(result.months).toEqual([
      { month: "2022-03", plays: 4, plays_spotify: 0, plays_other: 4 },
    ]);
  });
});

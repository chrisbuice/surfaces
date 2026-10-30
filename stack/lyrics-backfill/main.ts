#!/usr/bin/env tsx
/**
 * main.ts — Entrypoint for the lyrics-backfill container.
 *
 * Usage:
 *   tsx main.ts isrc         [--limit N]
 *   tsx main.ts lyrics       [--limit N]
 *   tsx main.ts credits      [--limit N]
 *   tsx main.ts seed-pending [--limit N] [--dry-run]
 */

const phase = process.argv[2];

switch (phase) {
  case "isrc":
    await import("./phase-isrc.js");
    break;
  case "lyrics":
    await import("./phase-lyrics.js");
    break;
  case "credits":
    await import("./phase-credits.js");
    break;
  case "seed-pending":
    await import("./phase-seed-pending.js");
    break;
  default:
    console.error(`Usage: tsx main.ts <isrc|lyrics|credits|seed-pending> [--limit N]`);
    process.exit(1);
}

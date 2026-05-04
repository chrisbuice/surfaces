#!/usr/bin/env tsx
/**
 * main.ts — Entrypoint for the lyrics-analysis container.
 *
 * Usage:
 *   tsx main.ts analyze  [--limit N] [--uris-file path] [--batch] [--dry-run]
 *   tsx main.ts embed    [--limit N] [--dry-run]
 *   tsx main.ts validate [--ratings-file path]
 */

const phase = process.argv[2];

switch (phase) {
  case "analyze":
    await import("./phase-analyze.js");
    break;
  case "embed":
    await import("./phase-embed.js");
    break;
  case "validate":
    // Future: compare analysis output to blind-ratings.csv
    console.error("validate phase not yet implemented");
    process.exit(1);
  default:
    console.error(`Usage: tsx main.ts <analyze|embed|validate> [--limit N] [--uris-file path]`);
    process.exit(1);
}

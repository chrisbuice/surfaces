import { defineConfig } from "vitest/config";

/**
 * Separate vitest config for ingest pipeline modules.
 * These tests use Node fs and fetch — cannot run in the cloudflare pool.
 * Run via: npm run test:scripts
 */
export default defineConfig({
  test: {
    include: [
      "tests/unit/apple-*.test.ts",
      "tests/unit/itunes-*.test.ts",
      "tests/unit/musicbrainz-isrc.test.ts",
      "tests/unit/spotify-matcher.test.ts",
    ],
    globals: true,
  },
});

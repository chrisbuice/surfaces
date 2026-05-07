/**
 * rate-limiter.ts — Simple token-bucket rate limiter for API clients.
 *
 * Shared across iTunes Lookup, MusicBrainz, and Spotify matchers.
 */

const MAX_WAIT_MS = 10_000; // Safety cap: never sleep more than 10s

export class RateLimiter {
  private minIntervalMs: number;
  private lastRequestAt = 0;

  constructor(requestsPerSecond: number) {
    this.minIntervalMs = Math.ceil(1000 / requestsPerSecond);
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      const waitMs = Math.min(this.minIntervalMs - elapsed, MAX_WAIT_MS);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    this.lastRequestAt = Date.now();
  }
}

/**
 * rate-limiter.ts — Simple token-bucket rate limiter for API clients.
 *
 * Shared across iTunes Lookup, MusicBrainz, and Spotify matchers.
 */

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
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }
}

import { describe, it, expect } from "vitest";
import { pickHardcodedFact, validateLLMFact, getArtistRelationship, buildFactPrompt, type FactInput } from "./facts";

function makeFactInput(overrides: Partial<FactInput> = {}): FactInput {
  const DAY = 86400;
  const now = 1_715_000_000;
  return {
    track_name: "Vampire Empire",
    artist_name: "Big Thief",
    lifetime_plays: 15,
    plays_in_window: 8,
    weighted_recent_plays: 16,
    first_play_ts: now - DAY * 200,
    last_play_before_window_ts: now - DAY * 30,
    artist_lifetime_plays: 50,
    artist_percentile: 75,
    is_new_arrival: false,
    window_end: now,
    artist_plays_before_window: 42,
    track_plays_before_window: 7,
    avg_weekly_rate: 0.5,
    ...overrides,
  };
}

describe("pickHardcodedFact", () => {
  it("priority 1: new artist", () => {
    const fact = pickHardcodedFact(makeFactInput({ artist_plays_before_window: 0 }));
    expect(fact).toBe("first time hearing Big Thief");
  });

  it("priority 2: new track from known artist", () => {
    const fact = pickHardcodedFact(makeFactInput({ track_plays_before_window: 1 }));
    expect(fact).toBe("new from Big Thief");
  });

  it("priority 3: returning after >1 year", () => {
    const DAY = 86400;
    const now = 1_715_000_000;
    const fact = pickHardcodedFact(
      makeFactInput({
        track_plays_before_window: 10,
        last_play_before_window_ts: now - DAY * 800, // ~2.2 years ago
      }),
    );
    expect(fact).toBe("returning after 2 years");
  });

  it("priority 3: singular year", () => {
    const DAY = 86400;
    const now = 1_715_000_000;
    const fact = pickHardcodedFact(
      makeFactInput({
        track_plays_before_window: 10,
        last_play_before_window_ts: now - DAY * 400, // ~1.1 years ago
      }),
    );
    expect(fact).toBe("returning after 1 year");
  });

  it("priority 4: sudden spike (5x average)", () => {
    const fact = pickHardcodedFact(
      makeFactInput({
        track_plays_before_window: 20,
        plays_in_window: 10,
        avg_weekly_rate: 1.0, // 10 >= 5*1.0
        last_play_before_window_ts: 1_715_000_000 - 86400 * 20, // recent enough to skip #3
      }),
    );
    expect(fact).toBe("10 plays this week, 20 before");
  });

  it("priority 5: fallback", () => {
    const fact = pickHardcodedFact(
      makeFactInput({
        track_plays_before_window: 20,
        plays_in_window: 4,
        avg_weekly_rate: 2.0, // 4 < 5*2.0, no spike
        last_play_before_window_ts: 1_715_000_000 - 86400 * 20, // 20 days, not >365
      }),
    );
    expect(fact).toBe("4 plays in the last two weeks");
  });

  it("priority order: new artist wins over new track", () => {
    const fact = pickHardcodedFact(
      makeFactInput({
        artist_plays_before_window: 0,
        track_plays_before_window: 0,
      }),
    );
    expect(fact).toBe("first time hearing Big Thief");
  });
});

describe("validateLLMFact", () => {
  it("accepts a valid short fact", () => {
    expect(validateLLMFact("first Big Thief track to stick.")).toEqual({ valid: true });
  });

  it("accepts fact without trailing period", () => {
    expect(validateLLMFact("back after a two-year gap")).toEqual({ valid: true });
  });

  it("rejects too many words", () => {
    const long = "this is a fact that has way too many words in it for sure";
    const result = validateLLMFact(long);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("too many words");
  });

  it("rejects strings over 80 chars", () => {
    const long = "a".repeat(81);
    const result = validateLLMFact(long);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("too long");
  });

  it("rejects quotation marks", () => {
    expect(validateLLMFact('a "great" track')).toEqual({
      valid: false,
      reason: "contains quotation marks",
    });
  });

  it("rejects trailing exclamation mark", () => {
    expect(validateLLMFact("wow this is great!")).toEqual({
      valid: false,
      reason: "bad trailing punctuation: !",
    });
  });

  it("rejects blocked phrases", () => {
    const result = validateLLMFact("you're really into this one");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("blocked phrase");
  });

  it("rejects 'great pick'", () => {
    expect(validateLLMFact("great pick for the morning")).toEqual({
      valid: false,
      reason: expect.stringContaining("blocked phrase"),
    });
  });

  it("accepts exactly 12 words", () => {
    const fact = "one two three four five six seven eight nine ten eleven twelve";
    expect(validateLLMFact(fact)).toEqual({ valid: true });
  });

  it("rejects 13 words", () => {
    const fact = "one two three four five six seven eight nine ten eleven twelve thirteen";
    expect(validateLLMFact(fact).valid).toBe(false);
  });
});

describe("getArtistRelationship", () => {
  it("returns 'brand new' for 0 pre-window plays", () => {
    expect(getArtistRelationship(0)).toBe("brand new");
  });

  it("returns 'trace history' for 1–49 pre-window plays", () => {
    expect(getArtistRelationship(1)).toBe("trace history");
    expect(getArtistRelationship(25)).toBe("trace history");
    expect(getArtistRelationship(49)).toBe("trace history");
  });

  it("returns 'established' for 50+ pre-window plays", () => {
    expect(getArtistRelationship(50)).toBe("established");
    expect(getArtistRelationship(500)).toBe("established");
    expect(getArtistRelationship(5000)).toBe("established");
  });
});

describe("buildFactPrompt", () => {
  it("includes artist_plays_before_window in user JSON", () => {
    const input = makeFactInput({ artist_plays_before_window: 775 });
    const { user } = buildFactPrompt(input);
    const parsed = JSON.parse(user);
    expect(parsed.artist_plays_before_window).toBe(775);
  });

  it("includes track_plays_before_window in user JSON", () => {
    const input = makeFactInput({ track_plays_before_window: 2 });
    const { user } = buildFactPrompt(input);
    const parsed = JSON.parse(user);
    expect(parsed.track_plays_before_window).toBe(2);
  });

  it("includes artist_relationship derived from pre-window plays", () => {
    const input = makeFactInput({ artist_plays_before_window: 800 });
    const { user } = buildFactPrompt(input);
    const parsed = JSON.parse(user);
    expect(parsed.artist_relationship).toBe("established");
  });

  it("labels brand new artist correctly", () => {
    const input = makeFactInput({ artist_plays_before_window: 0 });
    const { user } = buildFactPrompt(input);
    const parsed = JSON.parse(user);
    expect(parsed.artist_relationship).toBe("brand new");
  });

  it("system prompt includes artist relationship guidance", () => {
    const input = makeFactInput();
    const { system } = buildFactPrompt(input);
    expect(system).toContain("artist_relationship");
    expect(system).toContain("brand new");
    expect(system).toContain("established");
  });
});

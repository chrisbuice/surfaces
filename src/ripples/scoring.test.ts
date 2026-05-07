import { describe, it, expect } from "vitest";
import {
  computeRippleScore,
  computeFamiliarityScore,
  percentileRank,
  splitArrivalsAndWaves,
  type RippleWithFamiliarity,
} from "./scoring";

describe("computeRippleScore", () => {
  const DAY = 86400;
  const now = 1_715_000_000; // reference window_end

  it("weights plays in last 3 days at 3.0", () => {
    const plays = [now - DAY * 1, now - DAY * 2]; // 2 plays, both within 3 days
    const result = computeRippleScore(plays, 10, now);
    // weighted = 2 * 3.0 = 6.0, score = 6.0 / (10 + 3) = 0.46
    expect(result.weighted_recent_plays).toBe(6.0);
    expect(result.ripple_score).toBe(0.46);
    expect(result.plays_in_window).toBe(2);
  });

  it("weights plays in days 4-7 at 2.0", () => {
    const plays = [now - DAY * 5]; // 1 play at day 5
    const result = computeRippleScore(plays, 10, now);
    expect(result.weighted_recent_plays).toBe(2.0);
    expect(result.ripple_score).toBe(0.15); // 2 / 13
  });

  it("weights plays in days 8-14 at 1.0", () => {
    const plays = [now - DAY * 10, now - DAY * 12]; // 2 plays in tier 3
    const result = computeRippleScore(plays, 10, now);
    expect(result.weighted_recent_plays).toBe(2.0);
    expect(result.ripple_score).toBe(0.15); // 2 / 13
  });

  it("combines all three tiers", () => {
    const plays = [
      now - DAY * 1,  // tier 1: weight 3
      now - DAY * 5,  // tier 2: weight 2
      now - DAY * 10, // tier 3: weight 1
    ];
    const result = computeRippleScore(plays, 0, now);
    // weighted = 3 + 2 + 1 = 6, lifetime = 0, score = 6 / (0+3) = 2.0
    expect(result.weighted_recent_plays).toBe(6.0);
    expect(result.ripple_score).toBe(2.0);
  });

  it("smoothing constant prevents domination by low-lifetime tracks", () => {
    // Track played twice ever, both in last 3 days
    const plays = [now - DAY * 1, now - DAY * 2];
    const result = computeRippleScore(plays, 2, now);
    // weighted = 6, score = 6 / (2+3) = 1.2
    expect(result.ripple_score).toBe(1.2);
  });

  it("returns zero for empty plays", () => {
    const result = computeRippleScore([], 50, now);
    expect(result.ripple_score).toBe(0);
    expect(result.plays_in_window).toBe(0);
  });

  it("treats exact boundary at 3 days as tier 1", () => {
    const plays = [now - DAY * 3]; // exactly 3 days ago
    const result = computeRippleScore(plays, 0, now);
    expect(result.weighted_recent_plays).toBe(3.0);
  });
});

describe("computeFamiliarityScore", () => {
  it("returns 100 for top artist and top track", () => {
    const score = computeFamiliarityScore({
      artist_lifetime_plays: 1000,
      all_artists_plays: [1, 5, 10, 50, 100, 500, 1000],
      track_lifetime_plays: 200,
      all_tracks_plays: [1, 2, 5, 10, 50, 100, 200],
    });
    // artist: 100% * 0.625 + track: 100% * 0.375 = 62.5 + 37.5 = 100
    expect(score).toBe(100);
  });

  it("returns low score for bottom artist and bottom track", () => {
    const score = computeFamiliarityScore({
      artist_lifetime_plays: 1,
      all_artists_plays: [1, 5, 10, 50, 100, 500, 1000],
      track_lifetime_plays: 1,
      all_tracks_plays: [1, 2, 5, 10, 50, 100, 200],
    });
    // artist: 1/7*100=14.3 * 0.625 = 8.93
    // track: 1/7*100=14.3 * 0.375 = 5.36
    // total = 14.29 → 14
    expect(score).toBe(14);
  });

  it("weights artist at 62.5% and track at 37.5%", () => {
    // High artist, low track
    const score = computeFamiliarityScore({
      artist_lifetime_plays: 100,
      all_artists_plays: [10, 50, 100],
      track_lifetime_plays: 10,
      all_tracks_plays: [10, 50, 100],
    });
    // artist: 100% * 0.625 = 62.5
    // track: 1/3*100=33.3 * 0.375 = 12.5
    // total = 75
    expect(score).toBe(75);
  });

  it("returns 0 for artist/track with zero pre-window plays", () => {
    const score = computeFamiliarityScore({
      artist_lifetime_plays: 0,
      all_artists_plays: [1, 5, 10, 50, 100],
      track_lifetime_plays: 0,
      all_tracks_plays: [1, 2, 5, 10, 50],
    });
    // artist: 0/5 = 0%, track: 0/5 = 0%
    // 0 * 0.625 + 0 * 0.375 = 0
    expect(score).toBe(0);
  });
});

describe("percentileRank", () => {
  it("returns 100 for the max value", () => {
    expect(percentileRank([1, 2, 3, 4, 5], 5)).toBe(100);
  });

  it("returns 20 for the min value in a 5-element array", () => {
    expect(percentileRank([1, 2, 3, 4, 5], 1)).toBe(20);
  });

  it("returns 50 for empty array", () => {
    expect(percentileRank([], 42)).toBe(50);
  });

  it("handles duplicates correctly", () => {
    expect(percentileRank([1, 1, 1, 5, 5], 1)).toBe(60);
  });
});

describe("splitArrivalsAndWaves", () => {
  const DAY = 86400;
  const now = 1_715_000_000;

  function makeRipple(overrides: Partial<RippleWithFamiliarity>): RippleWithFamiliarity {
    return {
      spotify_track_uri: "spotify:track:test",
      track_name: "Test",
      artist_name: "Artist",
      album_name: "Album",
      ripple_score: 1.0,
      lifetime_plays: 10,
      plays_in_window: 5,
      weighted_recent_plays: 10,
      first_play_ts: now - DAY * 100,
      last_play_before_window_ts: now - DAY * 30,
      familiarity_score: 50,
      album_art_url: null,
      ...overrides,
    };
  }

  it("classifies recent-first-play as new arrival regardless of lifetime plays", () => {
    const ripple = makeRipple({
      lifetime_plays: 30,
      first_play_ts: now - DAY * 7, // 7 days ago (within 21)
    });
    const { new_arrivals, returning_waves } = splitArrivalsAndWaves([ripple], now);
    expect(new_arrivals).toHaveLength(1);
    expect(returning_waves).toHaveLength(0);
  });

  it("classifies high-lifetime binge-discovery as new arrival when first heard within 21 days", () => {
    // The exact bug case: 30 plays in a week, brand new artist
    const ripple = makeRipple({
      lifetime_plays: 30,
      first_play_ts: now - DAY * 8,
    });
    const { new_arrivals, returning_waves } = splitArrivalsAndWaves([ripple], now);
    expect(new_arrivals).toHaveLength(1);
    expect(returning_waves).toHaveLength(0);
  });

  it("classifies old first-play as returning wave regardless of play count", () => {
    const ripple = makeRipple({
      lifetime_plays: 4,
      first_play_ts: now - DAY * 60, // 60 days ago (outside 21)
    });
    const { new_arrivals, returning_waves } = splitArrivalsAndWaves([ripple], now);
    expect(new_arrivals).toHaveLength(0);
    expect(returning_waves).toHaveLength(1);
  });

  it("boundary: first_play exactly 21 days ago is new arrival", () => {
    const ripple = makeRipple({
      first_play_ts: now - DAY * 21, // exactly 21 days
    });
    const { new_arrivals, returning_waves } = splitArrivalsAndWaves([ripple], now);
    expect(new_arrivals).toHaveLength(1);
    expect(returning_waves).toHaveLength(0);
  });

  it("boundary: first_play 21 days + 1 second ago is returning wave", () => {
    const ripple = makeRipple({
      first_play_ts: now - DAY * 21 - 1, // 21 days + 1 second
    });
    const { new_arrivals, returning_waves } = splitArrivalsAndWaves([ripple], now);
    expect(new_arrivals).toHaveLength(0);
    expect(returning_waves).toHaveLength(1);
  });

  it("sorts each group by ripple_score descending", () => {
    const ripples = [
      makeRipple({ spotify_track_uri: "a", ripple_score: 1.0, first_play_ts: now - DAY * 50 }),
      makeRipple({ spotify_track_uri: "b", ripple_score: 3.0, first_play_ts: now - DAY * 50 }),
      makeRipple({ spotify_track_uri: "c", ripple_score: 2.0, first_play_ts: now - DAY * 50 }),
    ];
    const { returning_waves } = splitArrivalsAndWaves(ripples, now);
    expect(returning_waves.map((r) => r.ripple_score)).toEqual([3.0, 2.0, 1.0]);
  });

  it("requires first_play_ts to be non-null for new arrival", () => {
    const ripple = makeRipple({
      first_play_ts: null,
    });
    const { new_arrivals, returning_waves } = splitArrivalsAndWaves([ripple], now);
    expect(new_arrivals).toHaveLength(0);
    expect(returning_waves).toHaveLength(1);
  });
});

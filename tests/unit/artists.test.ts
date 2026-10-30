import { describe, it, expect } from "vitest";
import { artistNamesFromPoll, parseArtistIds } from "../../src/tracker/artists";

describe("parseArtistIds", () => {
  it("parses a JSON array of IDs", () => {
    expect(parseArtistIds('["a1","a2"]')).toEqual(["a1", "a2"]);
  });

  it("returns [] for null, empty, malformed, or non-array input", () => {
    expect(parseArtistIds(null)).toEqual([]);
    expect(parseArtistIds(undefined)).toEqual([]);
    expect(parseArtistIds("")).toEqual([]);
    expect(parseArtistIds("not json")).toEqual([]);
    expect(parseArtistIds('{"id":"a1"}')).toEqual([]);
  });

  it("drops empty and non-string entries", () => {
    expect(parseArtistIds('["a1","",null,7,"a2"]')).toEqual(["a1", "a2"]);
  });
});

describe("artistNamesFromPoll", () => {
  it("maps a single artist to the whole name, even if it contains a comma", () => {
    const names = artistNamesFromPoll('["tyler"]', "Tyler, The Creator");
    expect([...names]).toEqual([["tyler", "Tyler, The Creator"]]);
  });

  it("splits joined names when the piece count matches the ID count", () => {
    const names = artistNamesFromPoll('["a1","a2"]', "Aretha Franklin, King Curtis");
    expect(names.get("a1")).toBe("Aretha Franklin");
    expect(names.get("a2")).toBe("King Curtis");
  });

  it("returns nothing when a name contains the separator and counts disagree", () => {
    const names = artistNamesFromPoll('["tyler","kali"]', "Tyler, The Creator, Kali Uchis");
    expect(names.size).toBe(0);
  });

  it("returns nothing when IDs or names are missing", () => {
    expect(artistNamesFromPoll(null, "Someone").size).toBe(0);
    expect(artistNamesFromPoll('["a1"]', null).size).toBe(0);
    expect(artistNamesFromPoll('["a1"]', "   ").size).toBe(0);
  });
});

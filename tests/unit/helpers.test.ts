import { describe, it, expect } from "vitest";
import { isSkip, normalizePlatform, musicOnly, geolocate } from "../../src/listening/helpers";
import type { IpGeoCache } from "../../src/listening/types";

describe("isSkip", () => {
  it("returns true for fwdbtn", () => {
    expect(isSkip("fwdbtn")).toBe(true);
  });

  it("returns false for trackdone", () => {
    expect(isSkip("trackdone")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isSkip("")).toBe(false);
  });

  it("returns false for endplay", () => {
    expect(isSkip("endplay")).toBe(false);
  });

  it("returns false for backbtn", () => {
    expect(isSkip("backbtn")).toBe(false);
  });

  it("returns false for logout", () => {
    expect(isSkip("logout")).toBe(false);
  });
});

describe("normalizePlatform", () => {
  it("maps iOS variants to iOS", () => {
    expect(normalizePlatform("ios")).toBe("iOS");
    expect(normalizePlatform("iOS 15.0 (iPhone13,4)")).toBe("iOS");
    expect(normalizePlatform("iOS 6.1.3 (iPhone4,1)")).toBe("iOS");
    expect(normalizePlatform("iPad")).toBe("iOS");
  });

  it("maps macOS variants to macOS", () => {
    expect(normalizePlatform("OS X 10.12.6 [x86 8]")).toBe("macOS");
    expect(normalizePlatform("OS X 10.7.2 [x86 4]")).toBe("macOS");
    expect(normalizePlatform("osx")).toBe("macOS");
    expect(normalizePlatform("Mac")).toBe("macOS");
  });

  it("maps Android to Android", () => {
    expect(normalizePlatform("Android")).toBe("Android");
    expect(normalizePlatform("android 12")).toBe("Android");
  });

  it("maps Windows to Windows", () => {
    expect(normalizePlatform("Windows")).toBe("Windows");
    expect(normalizePlatform("windows 10")).toBe("Windows");
  });

  it("maps Cast devices to Cast", () => {
    expect(normalizePlatform("Partner")).toBe("Cast");
    expect(normalizePlatform("cast")).toBe("Cast");
    expect(normalizePlatform("Sonos")).toBe("Cast");
    expect(normalizePlatform("Echo")).toBe("Cast");
    expect(normalizePlatform("partner")).toBe("Cast");
  });

  it("returns Other for unknown platforms", () => {
    expect(normalizePlatform("unknown_device")).toBe("Other");
    expect(normalizePlatform("")).toBe("Other");
  });
});

describe("musicOnly", () => {
  it("returns input unchanged (no-op)", () => {
    const input = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = musicOnly(input);
    expect(result).toBe(input);
    expect(result).toHaveLength(3);
  });

  it("returns empty array unchanged", () => {
    const result = musicOnly([]);
    expect(result).toEqual([]);
  });
});

describe("geolocate", () => {
  const cache: IpGeoCache = {
    "1.2.3.4": { city: "Atlanta", region: "Georgia", country: "US", lat: 33.749, lon: -84.388 },
  };

  it("returns geo result for known IP", () => {
    const result = geolocate("1.2.3.4", cache);
    expect(result).toEqual({ city: "Atlanta", region: "Georgia", country: "US", lat: 33.749, lon: -84.388 });
  });

  it("returns null for unknown IP", () => {
    const result = geolocate("9.9.9.9", cache);
    expect(result).toBeNull();
  });
});

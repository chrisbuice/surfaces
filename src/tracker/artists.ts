/**
 * artists.ts — recover artist IDs and display names from poll_observations.
 *
 * The poller stores `artist_ids` as a JSON array of Spotify artist IDs and
 * `artist_name` as every credited artist's name joined with ", ". Track URIs
 * and artist IDs stay the source of truth; these helpers only attach a
 * display name to an ID.
 *
 * Splitting the joined string is only safe when the number of pieces matches
 * the number of IDs, because some names contain the separator themselves
 * ("Tyler, The Creator", "Earth, Wind & Fire"). When the counts disagree we
 * return no names rather than guess.
 */

/** Parse the JSON `artist_ids` column. Returns [] for null or malformed input. */
export function parseArtistIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id !== "");
  } catch {
    return [];
  }
}

/**
 * Map each artist ID to its display name, using the poller's joined
 * `artist_name` string. IDs whose name can't be recovered safely are absent.
 */
export function artistNamesFromPoll(
  artistIdsJson: string | null | undefined,
  joinedNames: string | null | undefined,
): Map<string, string> {
  const names = new Map<string, string>();
  const ids = parseArtistIds(artistIdsJson);
  const joined = joinedNames?.trim() ?? "";
  if (ids.length === 0 || joined === "") return names;

  if (ids.length === 1) {
    names.set(ids[0], joined);
    return names;
  }

  const parts = joined.split(", ").map(p => p.trim());
  if (parts.length !== ids.length || parts.some(p => p === "")) return names;
  ids.forEach((id, i) => names.set(id, parts[i]));
  return names;
}

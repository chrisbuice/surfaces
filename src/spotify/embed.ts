/**
 * embed.ts — fetch playlist track data via Spotify's public embed page.
 *
 * Dev Mode blocks all playlist-track API endpoints (both /tracks and /items,
 * with both user and client-credentials tokens). The embed page at
 * open.spotify.com/embed/playlist/{id} includes full track listings in its
 * server-rendered __NEXT_DATA__ payload, no auth required.
 *
 * Limitations vs the API:
 *   - No added_at timestamps
 *   - No album data
 *   - No structured artist IDs (only display names)
 *   - Artist names come as a comma-separated subtitle string
 */

export interface EmbedTrack {
  trackId: string;
  trackName: string;
  artistNames: string[];
  durationMs: number;
}

export interface EmbedPlaylistResult {
  playlistName: string;
  tracks: EmbedTrack[];
}

/**
 * Fetch playlist tracks by scraping the Spotify embed page.
 * Returns track IDs, names, artist names, and durations.
 */
export async function getPlaylistTracksViaEmbed(
  playlistId: string,
  limit = 200
): Promise<EmbedPlaylistResult> {
  const resp = await fetch(
    `https://open.spotify.com/embed/playlist/${playlistId}`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; SpotifyAgent/1.0)" } }
  );
  if (!resp.ok) {
    throw new Error(`Embed fetch failed (${resp.status})`);
  }

  const html = await resp.text();
  const match = html.match(/__NEXT_DATA__.*?type="application\/json">(.*?)<\/script>/);
  if (!match) {
    throw new Error("Could not parse embed __NEXT_DATA__");
  }

  const nextData = JSON.parse(match[1]) as {
    props: { pageProps: { state: { data: { entity: {
      name: string;
      trackList: Array<{
        uri: string;
        title: string;
        subtitle: string;
        duration: number;
      }>;
    } } } } };
  };

  const entity = nextData.props.pageProps.state.data.entity;
  const tracks = entity.trackList.slice(0, limit).map(t => ({
    trackId: t.uri.replace("spotify:track:", ""),
    trackName: t.title,
    artistNames: t.subtitle.split(/,\s*/).map(s => s.replace(/\u00a0/g, " ").trim()),
    durationMs: t.duration,
  }));

  return { playlistName: entity.name, tracks };
}

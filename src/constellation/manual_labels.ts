/**
 * manual_labels.ts — hand-picked artists for the labeled-8.
 *
 * Two of the eight labels in the constellation come from this list; the
 * other six are chosen by composite score (plays × longevity) at cron time.
 * Override list lives in git, no admin UI — some artists matter for reasons
 * the data can't see (spec §5.8).
 *
 * Entries are Spotify artist URIs in the form "spotify:artist:<id>".
 * Only artists also present in the constellation (≥10 plays since 2011 and
 * resolvable to a Spotify artist ID) will be labeled — entries that don't
 * resolve are silently skipped at cron time and logged.
 *
 * Chris will populate this list once the rest of the pipeline is verified.
 */

export const MANUAL_LABEL_ARTIST_IDS: string[] = [
  // Empty by intent — the labeled-8 is currently algorithmic on all eight
  // slots. Add a Spotify artist URI here (e.g. "spotify:artist:<22 chars>")
  // when you want to guarantee a label that the composite-score ranking
  // wouldn't otherwise surface — see comment block at the top of this file.
];

# Apple Tab Smoke Test Checklist

Verify in browser at `spotify-agent.chrisbuice.workers.dev/app` after deploying.

## Prerequisites
- [ ] At least 1 row in `apple_track_matches` with `match_status = 'review'`
- [ ] Worker deployed with the apple-match-queries and dashboard changes

## Tab visibility
- [ ] Apple tab button appears in tab nav when review count > 0
- [ ] Apple tab button is hidden when review count is 0
- [ ] Clicking Apple tab switches to the Apple tab content

## Card rendering
- [ ] Each card shows Apple metadata: song name, artist, album, duration, genre
- [ ] iTunes Lookup data preferred over raw original_* fields when available
- [ ] Spotify embed iframe loads and plays preview audio
- [ ] Match confidence percentage and method shown for the best candidate

## Actions
- [ ] "Match this" sends POST with action=match, card slides up and disappears
- [ ] "Skip" sends POST with action=skip, card slides up
- [ ] "Unmatchable" sends POST with action=unmatchable, card slides up
- [ ] "Search" toggles inline search input with pre-filled query
- [ ] Search input submits, Spotify results appear with embeds
- [ ] Selecting a search result matches and removes the card

## Pagination
- [ ] "Load more" button appears when hasMore is true
- [ ] Clicking "Load more" appends next page of cards
- [ ] "Load more" disappears when all cards are loaded

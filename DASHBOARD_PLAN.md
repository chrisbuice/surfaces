# Dashboard Overhaul Plan

## Overview

Transform the dashboard from a single-scroll status page into a tabbed, searchable interface for exploring 15 years of listening history. Vanilla HTML/CSS/JS only. No framework, no build step, no localStorage, no chart libraries — sparklines and bars are inline SVG or CSS.

All existing sections are preserved in behavior. Live-agent features (Now Playing, Start Session, Context, etc.) move into the Pulse tab alongside the new history-powered panels.

### Design Reference: Sonic_Life_Dashboard.html

The Sonic Life dashboard is an earlier static visualization of this same dataset. We borrow its visual language — not its code or its Chart.js dependency. Specific patterns adopted:

**CSS variables for accent palette.** Add supplementary accent colors alongside the existing `#1db954` primary:
```css
--accent: #1db954;    /* existing Spotify green — primary */
--accent2: #ff6b9d;   /* pink — falling/negative deltas, reflection 4 */
--accent3: #ffb84d;   /* gold — lost favorites, reflection 3 */
--accent4: #5dd4ff;   /* blue — reflection 2, neutral indicators */
--accent5: #b794f6;   /* purple — discovery, reflection 5 */
```

**Section header pattern.** Sonic Life uses a three-tier header: small green uppercase eyebrow label → large bold h2 → softer lede paragraph. Adopt for Trends charts and Detail panel headers:
```css
.eyebrow { font-size: 11px; letter-spacing: 0.18em; color: var(--accent); text-transform: uppercase; font-weight: 700; margin-bottom: 8px; }
```

**Key-metric pattern.** Replace the current `.stat-box` (centered, boxed) with the Sonic Life `.km` style for the hero strip: big number on top, tiny uppercase label below, green top-border accent. More impactful for lifetime totals.

**Row list pattern.** Sonic Life's `.row` (grid: rank | title+artist | value) is cleaner than `<table>` for track lists. Adopt for Pulse track lists, Detail top-10, queue results, lost favorites. Keeps hover state and consistent alignment.

**Artist card pattern.** Grid of cards with name, compact stats row, and year-indicator dots (green = was in top-50 that year, pink = current). Adopt for the artist detail view's "years in top-50" visualization.

**Reflection border colors.** Sonic Life assigns a distinct accent color to each reflection's left border. Adopt for the Reflections tab filmstrip cards: reflection 1 green, reflection 2 blue, reflection 3 gold, reflection 4 pink, reflection 5 purple.

**Tooltip.** Sonic Life uses a fixed-position `#tip` div that follows the mouse on hover — lightweight, no library. Adopt for chart hover values instead of SVG `<title>` elements (which don't style well).

**What we DON'T adopt:**
- Chart.js dependency (we use inline SVG)
- The `--bg: #0a0a0c` / `--panel: #14141a` darker palette (keep our existing `#121212` / `#1e1e1e`)
- The 1180px max-width (keep our 900px)
- The hero gradient text effect (keep our simpler `h1` style)
- Any embedded data patterns (Sonic Life is static; ours fetches from APIs)

---

## 1. Top-Level Layout

### Hero Strip (persistent, always visible)

A compact strip above the tab nav. Uses the Sonic Life key-metric pattern (`.km`): big number with green top-border, tiny uppercase label below.

**Row 1 — Key metrics grid** (auto-fit, 5–6 items wrapping):
```
┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│ 260,331      │ 14,382       │ 26,847       │  342 (+12%)  │ 1,408 (-3%) │
│ PLAYS        │ HOURS        │ TRACKS       │ LAST 7 DAYS  │ LAST 30 DAYS│
└──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
```
First three are lifetime totals (static after page load). Last two are rolling windows with delta indicators vs the prior equivalent window. Delta color: green (`--accent`) for positive, pink (`--accent2`) for negative, `--ink3` gray if flat (< 2% change).

Each metric rendered as:
```html
<div class="km"><div class="v">260,331</div><div class="l">PLAYS</div></div>
```

**Row 2 — Global search bar:**
Full-width input with placeholder "Search tracks or artists...". Always visible, every tab.

### Tab Navigation

Five tabs, rendered as pill buttons below the hero strip. Active tab has the existing `.mode-btn.active` styling (green fill). Default tab on page load is **Pulse**.

```
[ Pulse ]  [ Detail ]  [ Reflections ]  [ Calendar ]  [ Trends ]
```

The Detail tab is hidden in the nav until a search result is selected — then it appears and auto-activates. When nothing is selected, the tab is absent and clicking a search result inserts it.

### Tab Content Area

Each tab's content lives in a `<div class="tab-content" id="tab-{name}">` container. Only the active tab is visible (`display: block`). Tab switching is pure JS — set `display: none` on all, `display: block` on the selected.

---

## 2. Pulse Panel (default landing view)

The "open it in the morning" view. Single fetch to `GET /api/listening/pulse` returns the entire payload. Renders in a 2-column grid on wide screens, single column on mobile.

### Sections:

**Now Playing** — existing card, moved here unchanged. Polls every 5s.

**This Week (last 7 days):**
- Top 5 tracks using the row-list pattern (`.row` grid: rank | title+artist | play count)
- Skip indicator: pink (`--accent2`) dot after the play count if track skip rate > 50%
- Each track name clickable → opens track detail

**This Month (last 30 days):**
- Top 5 artists, row-list pattern: rank | artist name | hours + delta
- Delta rendered inline: `12.4h ▲ +2.1` in green or `8.1h ▼ -0.8` in pink
- Each artist name clickable → opens artist detail

**Rising Artists (positive Δ):**
- Top 5 artists with the largest increase in plays vs the prior 30-day window
- Row-list: rank | artist | current plays + Δ count in green
- Eyebrow label: "RISING" in `--accent`

**Falling Artists:**
- Top 5 artists with the largest decrease
- Row-list: rank | artist | current plays + Δ count in pink (`--accent2`)
- Eyebrow label: "FALLING" in `--accent2`

**New Entries:**
- Tracks first played this calendar month (never appeared in `plays` before this month)
- Up to 10, row-list: rank | title+artist | play count
- Eyebrow label: "NEW THIS MONTH" in `--accent5`

**Skip Rate Trend:**
- This week's skip rate vs last week's
- Small inline SVG bar: two bars side by side (last week `#282828` gray, this week green or pink)
- Caption: "29.1% this week vs 31.4% last week"

**Lost Favorites (top 5):**
- Row-list with gold (`--accent3`) value color (matching Sonic Life's `.row.lost` pattern)
- Each row: rank | title+artist | lifetime plays + "last heard YYYY-MM"
- Each has a "Queue from this" button (pill style) that calls the queue builder with that track as seed

**Queue Builder:**
- Mode dropdown: rediscover / reflection / morning / default
- Length slider: 30–120 min, default 60
- "Generate" button (green pill)
- Results render inline as a numbered row-list with reason tags (`.reason-tag` pills)
- Calls `POST /api/listening/queue`

**Existing live sections preserved in Pulse:**
- Start Session (mode buttons + output select)
- Latest Context (weather/location grid)
- Stats (today's listening, agent performance, discovery)
- Last 24 Hours (recent play events)
- Fresh Pool
- Why These Tracks / Session Biases (shown when session is active)
- Learned Affinities

These move into Pulse unchanged. The new history-powered sections (This Week, Rising/Falling, etc.) are inserted above the existing live sections, creating a natural flow: history overview at top → live status below.

---

## 3. Global Search

### Input
- Full-width text input in the hero strip
- Placeholder: "Search tracks or artists..."
- Debounced 200ms, 2-character minimum
- Calls `GET /api/listening/search?q={query}`

### Autocomplete Dropdown
- Absolutely positioned below the input, overlays content
- Max 10 results
- Each result shows:
  - Type badge: `[track]` or `[artist]` in a small pill
  - Name (track name or artist name)
  - For tracks: "by {artist}" suffix
  - Lifetime play count right-aligned
- Results ranked by lifetime plays, case-insensitive substring match
- Keyboard: arrow keys to navigate, Enter to select, Escape to close

### Selection Behavior
- Selecting a result:
  1. Closes the dropdown
  2. Populates the search input with the selected name
  3. Activates the Detail tab (inserts it into nav if hidden)
  4. Loads the appropriate detail view (track or artist)

---

## 4. Detail Panel — Track View

Activated by selecting a track from search, or clicking a track name anywhere in the dashboard.

### Data Source
`GET /api/listening/track?name={name}&artist={artist}` — song-level aggregation per LISTENING_HISTORY.md (COLLATE NOCASE, collapse URIs). Response includes canonical URI for queue insertion.

### Layout

**Header** (eyebrow pattern from Sonic Life):
```html
<div class="eyebrow">TRACK DETAIL</div>
<h2>Track Name</h2>
<p class="lede"><a onclick="showArtistDetail('...')">Artist Name</a></p>
<span class="source-tag">From local history</span>
```

**Stats Row** — key-metric grid (`.km` pattern), 4 items:
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ 203          │ 2018-07      │ 2014-06-02   │ 2024-07-07   │
│ TOTAL PLAYS  │ PEAK (215)   │ FIRST PLAYED │ LAST PLAYED  │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

**Second Stats Row** — 4 items, skip/completion rates with dataset-wide average as reference:
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ 682.4        │ 31%          │ 39%          │ Pop          │
│ MINUTES      │ SKIP RATE    │ COMPLETION   │ REFLECTION   │
│              │ (avg 29.8%)  │ (avg 39.2%)  │ maximalism   │
└──────────────┴──────────────┴──────────────┴──────────────┘
```
Skip rate value colored pink (`--accent2`) if above average, green if below. Completion rate inverse.

**Plays-Over-Time Sparkline:**
- Monthly play counts rendered as an inline SVG bar chart
- X-axis: months from first play to last play
- Y-axis: play count (scaled to height)
- Bars colored Spotify green, peak month highlighted brighter (`#84e9a8`)
- Hover triggers the Sonic Life tooltip (`#tip` div) showing "Mar 2018: 215 plays"
- Horizontally scrollable if > 36 months
- Width: full card width, height: 80px

**Actions:**
- "Add to queue" button (green pill) — calls `POST /api/listening/queue` with `seed={canonical_uri}`, `mode=default`, `length_min=60`

---

## 5. Detail Panel — Artist View

Activated by selecting an artist from search, or clicking an artist name in track detail.

### Data Source
`GET /api/listening/artist?name={name}` — aggregated across all tracks by this artist (COLLATE NOCASE).

### Layout

**Header** (eyebrow pattern):
```html
<div class="eyebrow">ARTIST DETAIL</div>
<h2>Artist Name</h2>
<span class="source-tag">From local history</span>
```
If on the 14-artist never-stale-core list, show a badge after the name:
```html
<span class="badge" style="background: var(--accent3); color: #000;">Never-stale core · 9 yrs</span>
```

**Stats Row** — key-metric grid (`.km` pattern), 6 items wrapping on mobile:
```
┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│ 380.2    │ 2,479    │ 187      │ 42       │ 2022-03  │ 2026-04  │
│ HOURS    │ PLAYS    │ TRACKS   │ ALBUMS   │ FIRST    │ LAST     │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
```

**Years in Top-50** — Sonic Life year-indicator dot pattern:
A row of year pills (2011–2026). Each pill is a small rounded rectangle:
- Green (`--accent`) background = artist was in your top-50 that year
- Pink (`--accent2`) background = most recent year (current)
- Dark (`#282828`) background = not in top-50 that year
```html
<div class="yrs">
  <span class="y">2011</span>
  <span class="y on">2018</span>
  <span class="y on">2019</span>
  <span class="y now">2026</span>
</div>
```

**Plays-Per-Year Bar Chart:**
- Inline SVG, one bar per year (2011–2026)
- Bars colored Spotify green, tallest bar highlighted brighter (`#84e9a8`)
- Labels below each bar (2-digit year), value above (play count)
- Hover triggers tooltip with full year + play count + hours
- Width: full card width, height: 120px

**Top 10 Tracks:**
- Row-list pattern: rank | title | play count
- Each track name is clickable → loads track detail
- Compact variant (no artist sub-line since we're already in an artist view)

**Companion Artists** (Sonic Life companion-card pattern):
- Rendered as a mini companion card: artist name in green as anchor, then 5 rows below
- Each row: companion artist name, co-occurrence count right-aligned
- Each companion name clickable → loads that artist's detail
- Only shown if this artist is in the `companions.json` graph (top-25 lifetime artists)

**Actions:**
- "Build artist queue" button (green pill) — calls `POST /api/listening/queue` with `seed={artist_name}`, `mode=default`, `length_min=60`

---

## 6. Reflections Tab

Existing reflections filmstrip and time-machine, combined into one tab.

**Top section — Reflections filmstrip** with Sonic Life reflection-color treatment:
Each reflection card gets a distinct left-border color (matching Sonic Life's `.reflection:nth-child` pattern):
- Reflection 1 (Indie folk + chart pop, 2012–14): `--accent` green
- Reflection 2 (Pop maximalism, 2015–17): `--accent4` blue
- Reflection 3 (Country/Americana, 2018–21): `--accent3` gold
- Reflection 4 (Texas country + emotional indie, 2022–24): `--accent2` pink
- Reflection 5 (Pop returns + female-fronted edge, 2025–26): `--accent5` purple

Artist names within each reflection card rendered as pills (Sonic Life `.pill` pattern): small rounded-full chips in `#282828` background.

Section header uses the eyebrow pattern:
```html
<div class="eyebrow">THE FIVE REFLECTIONS</div>
<h2>How your taste moved.</h2>
```

**Bottom section:** Calendar heatmap with year navigation + time-machine month picker. Clicking a reflection card sets the heatmap and time-machine year to the reflection's first year. Clicking a month in the heatmap opens the time-machine for that month.

The time-machine becomes a sub-view of Calendar: the month grid is overlaid on the heatmap card. When a month cell in the heatmap is clicked, the time-machine panel expands below with the top tracks for that month (row-list pattern).

---

## 7. Calendar Tab

The heatmap gets its own dedicated tab for when you want to browse by date.

**Calendar heatmap** (unchanged rendering, moved here).

**Month detail** (time-machine): clicking any heatmap cell opens the month detail below. Shows the same data as the current time-machine: stats grid + top tracks list. This replaces the separate Time Machine card.

Year navigation arrows at the top right of the card.

---

## 8. Trends Tab

Four charts in a 2×2 grid (Sonic Life `.grid2` / `.chart-card` pattern), collapsing to single-column on mobile. Each chart is an inline SVG in a `.card` with the eyebrow + h3 + `.sub` header pattern. Hover triggers the shared `#tip` tooltip div.

```html
<div class="eyebrow">LISTENING RHYTHM</div>
<h2>The shape of your history.</h2>
<div class="grid2">
  <div class="card chart-card">
    <h3>Skip rate over time</h3>
    <p class="sub">Share of plays ending with the forward button.</p>
    <svg ...></svg>
  </div>
  ...
</div>
```

### 8a. Skip Rate by Quarter
- Line chart, one data point per quarter (2012-Q1 through 2026-Q2)
- SVG: polyline + circle dots, Spotify green stroke
- Hover: tooltip shows "Q3 2018: 31.2%"
- Caption (`.sub`): "Higher = more selective. The 2022 dip is the lull."

### 8b. Discovery Rate by Year
- Bar chart, one bar per year, colored `--accent5` purple
- Hover: tooltip shows "2017: 7,002 new tracks"
- Caption: "First-ever plays. 2017 was your peak."

### 8c. Top-100 Concentration by Year
- Line chart, `--accent4` blue stroke
- Hover: tooltip shows "2019: 42% of plays in top 100"
- Caption: "Higher = you settled into favorites. Lower = more diverse."

### 8d. Hour-of-Day Distribution
- Polar/radial bar chart (24 bars in a circle, one per hour)
- Bar length proportional to play count for that hour (using `local_hour`)
- Bar colors by time band: hours 0–5 dim (`#282828`), 6–10 gold (`--accent3`), 11–17 green (`--accent`), 18–23 blue (`--accent4`)
- Hover: tooltip shows "2 PM ET: 14,832 plays"
- Caption: "When you listen. Hours in US Eastern. The 7am–6pm band holds 70%."

Each chart: 100% width of the card, height 200px (polar is 280px square).

---

## 9. New API Endpoints

All under `/api/listening/`. Every endpoint returns `{ source: "local_history", ... }`.

### GET /api/listening/search?q={query}
- Substring match against `track_name` and `artist_name`, case-insensitive
- Returns up to 10 results, ranked by lifetime plays
- Song-level grouping (COLLATE NOCASE) for tracks
- Response: `{ results: [{ type: "track"|"artist", name, artist?, plays }] }`
- Must be < 200ms. Uses `LIKE '%query%'` with existing indexes. If slow, add a trigram index or limit to prefix match.

### GET /api/listening/track?name={name}&artist={artist}
- Song-level aggregation (COLLATE NOCASE, collapse URIs)
- Returns: stats, monthly play counts (for sparkline), skip/completion rates, reflection, canonical URI
- Response: `{ track, artist, canonicalUri, totalPlays, totalMinutes, firstPlayed, lastPlayed, peakMonth, peakPlays, skipRate, completionRate, reflection, monthlyPlays: [{month: "2018-07", plays: 215}, ...] }`

### GET /api/listening/artist?name={name}
- Aggregated across all tracks by this artist (COLLATE NOCASE)
- Returns: stats, yearly play counts (for bar chart), top 10 tracks, companion artists, never-stale-core status
- Response: `{ artist, totalPlays, totalHours, distinctTracks, distinctAlbums, firstPlayed, lastPlayed, yearsInTop50, isNeverStaleCore, yearlyPlays: [{year: 2022, plays: 120}, ...], topTracks: [...], companions: [...] }`

### GET /api/listening/pulse
- Single endpoint returning the entire Pulse panel payload
- Sub-objects: `week` (top 5 tracks), `month` (top 5 artists with deltas), `rising` (top 5), `falling` (top 5), `newEntries` (up to 10), `skipRate` (this week, last week), `lostFavorites` (top 5)
- All queries use the `plays` table with appropriate time windows
- Must be < 500ms total. Runs ~8 queries in parallel via `Promise.all` or sequentially if D1 doesn't parallelize well.

### GET /api/listening/trends
- Returns four series for the Trends charts
- `skipRateByQuarter`: `[{quarter: "2012-Q1", rate: 0.29}, ...]`
- `discoveryByYear`: `[{year: 2012, newTracks: 3400}, ...]`
- `concentrationByYear`: `[{year: 2012, top100Share: 0.45}, ...]`
- `hourlyDistribution`: `[{hour: 0, plays: 1200}, ...]` (24 entries, using `local_hour`)
- Can be slow (up to 2s acceptable) since it's a dedicated tab loaded on demand.

### POST /api/listening/queue
- Wraps `generateQueue()` from `src/listening/queue.ts`
- Body: `{ mode, length_min, seed? }`
- Returns the same `QueueResult` shape as the MCP tool

---

## 10. File Changes

### New files

| Path | Purpose |
|------|---------|
| `src/listening/dashboard-queries.ts` | Query helpers for pulse, search, track detail, artist detail, trends |
| `tests/unit/dashboard-queries.test.ts` | Unit tests for all new query helpers |

### Modified files

| Path | Change |
|------|--------|
| `src/index.ts` | Add 6 new API routes: search, track, artist, pulse, trends, queue |
| `dashboard/index.html` | Complete overhaul: hero strip, tab nav, Pulse panel, Detail panels, Reflections tab, Calendar tab, Trends tab |

### NOT touched

- Existing 8 + 4 MCP tools and handlers
- Spotify OAuth and SpotifyClient
- `plays` table schema (no schema changes)
- `src/listening/queries.ts` — Pulse and Detail call existing helpers, don't reimplement
- `src/listening/queue.ts` — queue endpoint wraps it, doesn't rewrite
- Existing dashboard color scheme and typography — extended, not replaced
- The live-agent dashboard functions (loadNowPlaying, loadContext, loadStats, etc.) — moved into Pulse tab, not rewritten

---

## 11. Implementation Order

1. **New API endpoints** — dashboard-queries.ts + routes in index.ts + unit tests
   - search, track, artist first (these power the Detail panel)
   - pulse second (aggregates multiple queries)
   - trends third (most complex queries, loaded on demand)
   - queue last (thin wrapper)

2. **Hero strip + global search** — visible on every tab, must look right first
   - Lifetime totals (single query on page load)
   - Search input with debounced autocomplete
   - Tab navigation skeleton (5 tabs, only Pulse active initially)

3. **Pulse panel** — merge existing live sections + new history panels
   - Move existing cards into Pulse tab container
   - Add: This Week, This Month, Rising/Falling, New Entries, Skip Rate, Lost Favorites, Queue Builder
   - Verify existing functionality still works after the move

4. **Detail panels** — track and artist views
   - Track detail with sparkline
   - Artist detail with bar chart and companions
   - Wire up clickable names throughout the dashboard

5. **Trends panel** — four SVG charts
   - Skip rate line chart
   - Discovery bar chart
   - Concentration line chart
   - Hour-of-day polar chart

6. **Reflections + Calendar tabs** — relocate existing sections
   - Move reflections filmstrip into Reflections tab
   - Move heatmap + time-machine into Calendar tab
   - Wire heatmap month-click to time-machine expansion
   - Verify year navigation still works

Each step runs the full test suite before proceeding.

---

## 12. Performance Budget

| Endpoint | Target | Strategy |
|----------|--------|----------|
| /search | < 200ms | `LIKE` with `LIMIT 10`, no joins |
| /track | < 300ms | 3 queries (stats, monthly, rates) via sequential D1 calls |
| /artist | < 300ms | 4 queries (stats, yearly, top tracks, companions from embedded JSON) |
| /pulse | < 500ms | 8 queries, sequential (D1 doesn't truly parallelize in a single request) |
| /trends | < 2000ms | 4 heavy aggregation queries, loaded on demand, cached in KV for 1 hour |
| /queue | < 1000ms | Wraps generateQueue(), inherits its performance |

If any endpoint exceeds its budget in testing, options in order of preference:
1. Add a covering index
2. Pre-compute into a KV cache refreshed by the daily cron
3. Simplify the query (reduce GROUP BY cardinality)

---

## 13. Interaction Patterns

### Click-through Navigation

Every track name in the dashboard is clickable → opens track detail. Every artist name is clickable → opens artist detail. This applies to:
- Pulse: This Week tracks, This Month artists, Rising/Falling, New Entries, Lost Favorites, Queue results
- Calendar: Time-machine track list
- Reflections: reflection card top artists
- Trends: no clickable items (charts only)

Implementation: wrap names in `<a href="#" onclick="showTrackDetail('name', 'artist')">` or `showArtistDetail('name')`. These functions activate the Detail tab and fetch the appropriate data.

### Shared Tooltip (from Sonic Life)

A single `<div id="tip">` at the end of `<body>`, fixed-position, follows the mouse. Styled:
```css
#tip { position: fixed; padding: 8px 10px; background: #282828; border: 1px solid #333;
       border-radius: 6px; font-size: 12px; color: #e0e0e0; pointer-events: none;
       opacity: 0; transition: opacity 0.1s; z-index: 100; max-width: 240px; }
#tip.on { opacity: 1; }
#tip b { color: var(--accent); }
```
Used by: sparklines, bar charts, polar chart, heatmap cells. Activated via `onmouseover` on SVG elements, positioned via `mousemove` event.

### Mobile Responsiveness

- Hero strip: stack totals and search vertically below 600px
- Tab nav: horizontal scroll if tabs overflow
- Stats grids: 2-column below 600px, 1-column below 400px
- Sparklines/charts: full width, fixed height
- Reflections filmstrip: already horizontal-scrollable, works on mobile

---

## Phase 3 Candidates (Future Dashboard Work)

Not in scope for this plan:

- **Playlist detail view** — show a seasonal playlist's tracks with affinity scores
- **Compare mode** — side-by-side two months or two years
- **Export** — download a month's top tracks as a Spotify playlist (calls the API)
- **Live-sync status indicator** — show when the last sync ran and how many rows were added
- **Geographic heatmap** — map view of cities from `ip_geo.json`
- **Obsession alerts** — flag when a single track crosses 30 plays in a week

# `/surfaces` page — design and build spec

**Owner:** Chris Buice
**Created:** May 2026
**Purpose:** Hand-off document for the cowork session that will implement the `chrisbuice.com/surfaces` showcase page and the supporting Surfaces backend work.

This document captures the full decision trail behind the page so the implementing agent has the *reasoning*, not just the spec. The prose is locked; do not rewrite it. The visual decisions are locked; tune within them, don't redesign.

---

## 1. Project context

Two existing repos:

- **`chrisbuice.com`** — Astro 5 personal site, hand-written CSS with custom properties, Fraunces + Inter self-hosted, deployed to Cloudflare Pages. Currently has `Hero`, `About`, and `/contact`. No project cards yet, no `/surfaces` route.
- **Surfaces** — Cloudflare Workers app on the paid tier. ~10K lines of TypeScript, all milestones M0–M20 complete. Has its own dashboard at `/app` behind Cloudflare Access, an MCP server at `/mcp`, and `/api/now-playing` already public with permissive CORS.

The two repos stay separate. `/surfaces` on the personal site is a public showcase that calls into Surfaces as a backend; it is **not** a port of the dashboard. The dashboard stays behind Cloudflare Access.

---

## 2. What the page is for

Two audiences, both served by the same page:

1. **Potential employers.** Need evidence of capability — the build, the architecture, the fact that it works.
2. **Friends and anyone else.** Need a glimpse of taste, an interactive way to peruse listening history, and a safe way to interact with Surfaces.

The page leads with the *taste* glimpse, lets the *capability* signals ride along as texture, and ends with a low-friction call to action (the submit-a-song tool).

### Stance on the personal layer

Chris is honest about the project being personally meaningful without disclosing specifics. The decision was: do not obfuscate the data, do not hide years, but also do not narrate the personal layer in prose. Let the data show what it shows; let one quiet sentence acknowledge that meaning exists.

---

## 3. The page, top to bottom

1. **Eyebrow + title.** Tracked uppercase "A project · 2026" then "Surfaces" in hunter green.
2. **The lede.** Two paragraphs of Fraunces. What Surfaces is. The seasonal-playlist ritual is hinted at (not on this page — covered on homepage). The personal layer surfaces as the closing sentence of the second paragraph.
3. **The constellation.** Full-width on desktop (~880px frame), simplified on mobile. The page's gravitational center.
4. **Three numbers, Felton-style.** Total plays, total unique artists, total seasonal playlists since 2016. Big serif numerals, tracked-uppercase captions.
5. **The build paragraph.** One paragraph. What the system does. The "built solo in three days using Claude Code" sentence as the last line.
6. **Send me a song.** Submission tool. Spotify search picker, optional "from" field, optional note.
7. **Footer.** GitHub link to Surfaces repo, link back home.

Total page: ~280 words of locked prose, one big visual, three small statistics, one interactive form.

---

## 4. The locked prose

**Do not rewrite these.** The voice took multiple iterations to land and is doing specific work — short sentences, em-dashes, parallelism, "mostly" as softener, plain-flat verbs. An agent optimizing for fluency will smooth out exactly the moves that make it Chris's.

### Lede

> Surfaces is a music tool I built for myself. It watches what I'm listening to, learns what I've loved before, and surfaces tracks for the surfaces of my day — working music in the morning, something quieter at night, something else entirely on a long drive. It talks to Spotify, talks to Claude, and talks back to me through Siri when I ask it to.
>
> I listen. Spotify keeps a record. Surfaces reads it like a book — fifteen years, around 260,000 plays, every one of them logged in passing and never really looked at until now. There are patterns in there I'd never have spotted on my own. Some are about music. Some are about me. The surface, it turns out, is also a mirror.

### Constellation caption (italic, Fraunces, immediately under the visual)

> Every artist I've played more than ten times since 2011, positioned by what I've listened to alongside what.

### Mobile-only hint (italic, smaller, hidden ≥768px)

> On a wider screen this becomes something you can touch — every dot a story.

### The meaning sentence (Fraunces, left-aligned, after caption + metadata)

> Some artists glow steady — the ones I've returned to year after year, the company I keep. Others fade to ghost — loved hard for a season and then never quite again, the way some music is meant to belong to a particular stretch of months and nothing after.

### Build paragraph

> The system watches what I play and learns from it. Every night, while I sleep, it rebuilds a profile of my taste — what I'm leaning into, what I'm cooling on, what time of day I tend to want what. A second program reads music blogs and indie radio feeds, looking for new tracks that might fit, and adds the strongest candidates to a pool of fresh discoveries. When I want to listen, it draws from both sides — the familiar and the new — and tunes the mix to where I am, what the weather is doing, and what kind of attention I have to spare. The whole thing runs on Cloudflare's edge, the same network that powers a large fraction of the web, in small bursts that wake up when I need them and disappear when I don't. About ten thousand lines of TypeScript. Built solo in three days using Claude Code.

### Page meta

- **Title:** `Surfaces — Chris Buice`
- **Description:** `A music tool I built for myself, and what it noticed.`

---

## 5. The constellation — full spec

This is the centerpiece. Every decision below was made deliberately; the reasoning is captured so you can tune within the spec, not against it.

### 5.1 Concept

Every artist Chris has played more than ten times since 2011, rendered as a node on a dark canvas, positioned by **what was listened to alongside what** (co-occurrence in listening sessions and shared playlists). Color encodes when the artist mattered most. Size and opacity together encode total play count and longevity.

The shape that emerges *is* Chris's taste — clusters where there's density, voids where there isn't, drift over time visible as a color gradient across the canvas.

### 5.2 Inclusion criteria

- Artists with **≥10 plays** in Chris's history
- Expected node count: **1,000–2,000**

### 5.3 Layout — co-occurrence definition

Two artists "co-occur" when they're played in the same listening window. Definition:

- **Window: 30 minutes.** Two plays count as in the same session if they're within 30 minutes of each other.
- **Minimum threshold: 3 sessions.** A pair must have shown up in the same session at least 3 distinct times across the 15 years to register as an edge. This is the noise filter — one-offs (Spotify autoplay accidents, party plays from someone else's hand) get excluded. Tunable: bump to 5 if the graph still looks noisy, drop to 2 if it's too sparse. **Start at 3.**
- **Edge weight formula:** `log(session_co_occurrences) + 2 × log(playlist_co_occurrences + 1)`
  - The `log` keeps obsessive pairs from dominating the layout (an 800x co-occurrence pair becomes ~3x stronger than a 10x pair, not 80x stronger — visually more honest).
  - The `2×` on the playlist side weights curatorial choices over passive listening.
  - The `+1` inside the playlist log handles the "no shared playlist" case gracefully.
- **Seasonal playlist bonus: 1.5×** on top of the playlist co-occurrence weight. Decade-long ritual, brand asset, pulls harder.

### 5.4 Color — peak-play reflection

Each artist is colored by **peak play year** — the calendar year in which Chris played them most. Not first-played; not most-recent; *peak*. This captures "when this artist mattered to me" rather than "when I first heard them."

- **5 buckets**, **data-driven boundaries**: cut points are chosen so each bucket holds roughly 20% of artists, not by fixed calendar years. Prevents the graph from being mostly one color in the reflection when listening volume was highest.
- **Bichromatic palette: warm amber → cream → hunter green.**
  - Earliest reflection: warm amber (e.g. `#c8956d`)
  - Latest reflection: deep hunter green (matches `--accent: #2D5F3F`)
  - Three intermediate stops interpolated between
  - Direction is deliberate: warm = past, cool = present. Eyes track from warm to cool naturally, which feels right for "past to present."

### 5.5 Size — total plays

`radius = sqrt(total_plays)` mapped to a visual range of **3px to 24px** on desktop, **4px to 28px** on mobile. Square-root keeps top-played artists from being absurdly larger than the median.

### 5.6 Opacity — longevity (the second channel)

`opacity = years_active / total_years_in_data`, mapped to a range of **0.4 to 1.0**, where "years active" is the count of distinct calendar years with ≥5 plays for that artist.

A solid Radiohead-since-2012 node looks meaningfully different from a ghosted three-month-obsession node. This is the channel the meaning-sentence describes ("glow steady" vs. "fade to ghost").

### 5.7 Edges (rendered)

- Base opacity: **0.08–0.15**. Suggest the gravitational structure without competing with the nodes.
- On hover of a node: connected edges fade up to **0.6**, all others fade down to **0.03**.
- Top **3 edges per node** rendered visible at base opacity. Remaining edges affect the layout but are not drawn.

### 5.8 Default labels (the labeled-8)

Eight artists labeled by name in tracked-caps Inter at small size, with a thin 0.5px hunter-green connector line from label to node.

- **6 chosen by algorithm:** rank by `total_plays × (years_active / total_years_in_data)`. This composite surfaces artists who are *both* high-play and long-loyalty. Two-week binges get demoted; long companions get promoted.
- **2 chosen manually:** Chris hand-picks two artists from a `manual_labels.ts` config file in the Surfaces repo. Override list lives in git, no admin UI needed. Reasoning: some artists matter for reasons the data can't see.

The JSON output flags 8 nodes with `is_labeled: true`.

### 5.9 Hover interaction (desktop)

When a node is hovered:

- The node grows by **15%** with a 150ms ease-out transition.
- Its edges fade up to 0.6 opacity; all other edges fade to 0.03.
- A **fixed-position tooltip panel** (not floating with cursor) appears in a consistent location, large enough to be typographic. Contents:
  - Artist name in tracked uppercase
  - Total plays, peak year, years active in a tight stat grid
  - Top 3 most-co-occurring artists as a small list
- The **3 named neighbors also light up** in the constellation, with thin connecting lines drawn from the hovered node to each. Constellation responds to attention.

### 5.10 Click interaction

- Click a node → opens artist's Spotify page in new tab. No modal, no confirmation.
- Click empty space → resets state. Tooltip clears, all edges return to base opacity.

### 5.11 Mobile rendering

The mobile constellation is a **different artifact**, not a degraded desktop version. Job: be beautiful on its own, signal that there's more on a wider screen.

- **200-node subset** (top 200 by composite score from §5.8)
- **No edges rendered** — sparse, breathing, intentional
- Larger dots (4–28px range)
- Same color/opacity encoding as desktop
- **One default label** — the single top artist by composite score
- **Tap-to-reveal tooltip** appears as a card *below* the SVG, not floating over it
- The italic mobile-hint sentence (§4) below the caption

The breakpoint for switching modes: **768px**.

### 5.12 Frame and supporting elements

- **No border, no background fill, no axis lines, no gridlines.** The constellation floats on the same background as the rest of the page. This is the single biggest move that separates "data art" from "dashboard chart."
- **1px halo** in the page background color around each node (not white, not black — actually `var(--bg)`). Prevents nodes from visually merging in dense clusters. Felton-style.
- **Reflection color legend** in the **bottom-left of the frame**, small. Five colored dots in a row with year ranges underneath. Inside the composition, not separate.
- **Loading state**: tracked-uppercase "Generating constellation…" centered in the frame while the JSON fetches. **No spinner.** Spinners on a Felton-register page look wrong.

### 5.13 Captions and metadata (below the SVG)

In order:

1. The italic Fraunces caption (§4)
2. Tracked-caps metadata line: `Generated nightly · 1,623 artists · 4,847 connections` (numbers populated from the JSON's `stats` object)
3. Mobile-only hint sentence (§4), hidden ≥768px
4. The meaning sentence (§4), Fraunces, left-aligned (intentional asymmetry inside a centered stack)

---
### 5.14 Motion

The constellation is animate. Three layers of ambient motion always run, plus three deepening effects on hover. The motion budget is deliberate — three timescales, three roles, layered so they don't compete.

**Engine.** SVG, with motion handled via `requestAnimationFrame` updating `transform` attributes on node groups. CSS handles the periodic effects (shimmer, twinkle) via `@keyframes` so they don't cost JS cycles. **No Canvas, no WebGL.** SVG keeps hover hit-testing free, accessibility intact, and complexity bounded.

**Ambient motion (always on, no interaction needed):**

1. **Drift.** Every node gets a per-frame offset of ±0.5px from its layout position, generated as a small two-axis sine wave with a random phase per node. Each node has its own slightly-different period (between 4 and 7 seconds) so the field never pulses in sync. Reads as the field being alive, not jittery. Implemented in JS via RAF; offset stored in `transform="translate(...)"` on the node group.

2. **Cluster orbit.** Nodes belonging to a cluster rotate slowly around their cluster centroid at ~0.3°/second. Different clusters rotate at slightly different rates (vary ±20%) so the whole field doesn't look like a turntable. Cluster membership and centroid are precomputed by the Surfaces cron — see the JSON contract update in §6 (new `cluster_id` field per node, new `clusters` array at the top level with centroid coordinates and rotation rate). The drift and the orbit *compose* — drift is applied as offset, orbit is applied as rotation around centroid, the node's painted position is `centroid + rotate(offset_from_centroid, theta) + drift`.

3. **Shimmer on labeled-8.** Opacity oscillates between 0.85 and 1.0 over a 4-second cycle, with a subtle SVG `<filter>` blur-glow that peaks at the brightest moment. CSS-only via `@keyframes` on a class applied to labeled nodes. Slow heartbeat. Each labeled node has a randomized animation-delay so they don't pulse in unison.

4. **Twinkle.** A random non-labeled node briefly flickers brighter (opacity 1.0, 200ms) and returns to its base opacity. One twinkle every 2–3 seconds somewhere in the field. Sells the "star field" reading. Implemented via JS picking a random node from a weighted pool (weight by base opacity, so brighter nodes twinkle more often) and adding a CSS class for one cycle.

**Hover-deepening (layered on top of existing hover behavior):**

5. **Magnetic hover.** When a node is hovered, its top-3 neighbors physically lean toward it by 6px over 200ms (eased), and return to position over 250ms when hover ends. The lean is added to the drift offset — drift continues underneath. Makes the gravitational structure visceral.

6. **Edge tracing.** When a node is hovered, a bright pulse travels along the edges from hovered node to top-3 neighbors over ~600ms. Implemented as an SVG `<animate>` on `stroke-dashoffset` along each edge path. Visualizes the connection as something flowing between artists.

7. **Existing hover behavior** (from §5.9) all remains: 15% size growth on the hovered node, fixed-position tooltip, edges fade up to 0.6 / others to 0.03, neighbor nodes light up.

**Reduced motion.** All ambient motion (drift, orbit, shimmer, twinkle) respects `prefers-reduced-motion: reduce`. When set, the constellation falls back to fully static — same render as the mobile version structurally (still interactive, still hover-able, just no ambient motion). Hover-deepening (magnetic, edge tracing) also disabled under reduced motion. The page never *forces* motion on a reader who's asked it not to.

**Mobile.** No ambient motion on mobile (per §5.11 the mobile version is a 200-node still). Tap-to-reveal still works; that's interaction, not animation.

### 5.15 Performance budget

Motion adds real cost. Honest target:

- **60fps on a 2020 MacBook Air with Chrome DevTools' 4× CPU throttle.**
- If 60fps can't hold, drop in this order: (1) twinkle, (2) cluster orbit, (3) drift. Shimmer is CSS-only and effectively free. Hover-deepening is interaction-bounded and only runs while a node is hovered.
- **First paint matters.** Render the static layout immediately; layer motion on after first paint via `requestIdleCallback` (or a small `setTimeout(0)` fallback).
- **Tab visibility.** Pause RAF when the tab is backgrounded (`document.visibilityState !== 'visible'`). Resume on focus. Saves the reader's battery.

**Implementation notes for the renderer:**
- Group each node in its own `<g>` so transforms compose cleanly: outer `<g>` for centroid translation + orbit rotation, inner `<g>` for drift offset, then the `<circle>` itself with shimmer/twinkle classes.
- Don't update transforms via React/Astro reactivity — direct DOM writes inside the RAF loop. Hydration is for setup; the loop is imperative.
- Edge paths are static SVG `<line>` elements; they don't need per-frame updates except during hover-pulse.
- Cluster centroids are computed once by the Surfaces cron and shipped in the JSON; the renderer never recomputes them.

## 6. The JSON contract

The Surfaces backend produces this blob nightly. The chrisbuice.com page fetches it and renders. The blob is roughly 200KB for ~1,500 nodes — fine.

```json
{
  "generated_at": "2026-05-01T04:00:00Z",
  "stats": {
    "total_plays": 261847,
    "total_artists": 1623,
    "total_seasons": 39,
    "data_starts": "2011-03-14"
  },
  "reflection_buckets": [
    { "label": "2011–2014", "color": "#c8956d" },
    { "label": "2015–2017", "color": "#b8a07a" },
    { "label": "2018–2020", "color": "#9ba588" },
    { "label": "2021–2023", "color": "#6a8b6a" },
    { "label": "2024–now",  "color": "#3e5e3a" }
  ],
  "viewbox": { "width": 1000, "height": 1000 },
  "clusters": [
    {
      "id": 0,
      "centroid_x": 412.4,
      "centroid_y": 588.7,
      "rotation_rate_deg_per_sec": 0.31,
      "node_count": 87
    }
  ],
  "nodes": [
    {
      "id": "spotify:artist:4Z8W4fKeB5YxbusRsdQVPb",
      "name": "Radiohead",
      "x": 412.7,
      "y": 588.3,
      "r": 18.4,
      "opacity": 0.92,
      "reflection": 3,
      "plays": 4127,
      "peak_year": 2019,
      "years_active": 12,
      "cluster_id": 0,
      "top_neighbors": ["Thom Yorke", "Atoms for Peace", "Aphex Twin"],
      "is_labeled": true
    }
  ],
  "edges": [
    { "from": 0, "to": 47, "weight": 0.83 }
  ]
}
```

Notes on the shape:

- **Positions are precomputed and absolute.** The renderer does no layout math; it just paints dots where the JSON says. Force-directed layouts are non-deterministic — running d3-force in the browser would produce a subtly different shape every page load.
- **Edges reference nodes by index, not by id.** Saves substantial bytes when edge count climbs into the thousands. The renderer builds the index map once on load.
- **Reflection is an integer index** into `reflection_buckets`, not the color directly. Means the palette can be changed by editing one place.
- **Viewbox is 1000×1000.** SVG handles all scaling. No DPI math anywhere.
- **`generated_at`** powers the "Generated nightly · last updated 4 hours ago" line if desired.
- **Clusters drive the orbit motion** (§5.14). Every node has a `cluster_id` referencing into the `clusters` array. Each cluster has a centroid, a node count, and its own rotation rate so orbits don't sync. Centroids are computed once by the cron; the renderer never recomputes them.

---

## 7. The Surfaces backend work

### 7.1 Nightly cron job

Schedule: **4 AM ET daily** (after the existing nightly jobs in the project status doc). Runs in a Cloudflare Worker, output to KV.

Three SQL phases:

1. **Build node list.** All artists with ≥10 plays. Compute total plays, peak year (year with most plays for that artist), years active (count of distinct years with ≥5 plays).
2. **Build edges.** Self-join `plays` to find artist pairs within 30-minute windows; count distinct sessions. Join against playlist tracks to count playlist co-occurrences. Apply the threshold (3+ co-occurrences) and the weight formula. Apply the seasonal-playlist 1.5× bonus.
3. **Determine reflection bucket boundaries.** Sort all peak years; find the four cut points that split into five equal-population buckets. Output human-readable labels.

Then:

4. **Compute layout.** `d3-force` server-side (importable into a Worker via npm). Edges as links, small repulsion force between nodes, run for ~300 ticks until settled. Normalize coordinates into a 1000×1000 box with a small inset margin so nothing touches the edge.
5. **Detect clusters.** Run a community-detection pass on the node-edge graph after layout settles. Louvain modularity is the right algorithm — fast, deterministic enough for our purposes, produces 5–15 clusters for graphs of this density. For each cluster: compute the centroid (mean of member node positions), count members, and assign a rotation rate sampled from a uniform distribution of `0.25–0.36 deg/sec` (small variance so cluster orbits don't sync but stay in the "slow" range). Singleton nodes get `cluster_id: -1` and don't orbit. Output to the `clusters` array in the JSON.
6. **Compute labeled-8.** Algorithmic 6 by composite score; merge in 2 from `manual_labels.ts`; flag those nodes with `is_labeled: true`.
7. **Write to KV** with a 26-hour TTL.

The expensive step is the edges query. D1 has a 30-second wall clock per query — chain multiple if necessary. Budget ~30 seconds of CPU on the full history. Cluster detection is fast (sub-second) once the graph is in memory.

### 7.2 New public endpoint

```
GET /api/constellation
```

Reads the cached JSON from KV. Returns with:

- `Cache-Control: public, max-age=3600` (so chrisbuice.com can cache locally too)
- CORS already permissive on the Surfaces worker

### 7.3 Submit-track endpoint

```
POST /api/submit-track
```

Body shape:

```json
{
  "track_id": "spotify:track:...",
  "from": "Maya",
  "note": "Reminded me of your seasonal playlists"
}
```

- **Authentication:** shared secret in header (`X-Surfaces-Secret`). Env var on both sides.
- **Rate limit:** Cloudflare native per-IP. Add Turnstile invisible CAPTCHA if abuse becomes an issue.
- **Persistence:** new `submissions` table in D1 — `track_id`, `submitter_name` (nullable), `note` (nullable), `submitted_at`, `status`. Insert only.
- **Behavior:** insert into `submissions`. Optionally also score the track against the existing taste model and add to `fresh_pool` for next-session use.
- **Email notification:** batched daily (existing cron pattern in the codebase) — list of submissions sent to Chris.
- **Failure mode:** returns 200 with a friendly "queued, try again later" body if the underlying write fails. The chrisbuice.com page should never show an error to a submitter.

### 7.4 Manual labels config

```
src/constellation/manual_labels.ts
```

Simple TypeScript file exporting an array of Spotify artist IDs. Edited by hand in the repo, redeployed on change. Used by the nightly cron when computing the labeled-8.

---

## 8. The chrisbuice.com work

### 8.1 The page file

`src/pages/surfaces.astro` — already drafted. Contains:

- `<Base>` wrapper with the page meta
- The locked prose, in semantic sections
- Two `mount` divs as placeholders: `#constellation-mount` and `#submit-mount`
- Scoped CSS implementing the body-class font swap, the container width override, the drop cap, the numbers grid, and the captions stack
- All structural decisions match the spec above

### 8.2 The constellation island

Astro island that hydrates `#constellation-mount`. Vanilla SVG, no d3 needed (layout is precomputed). Implements:

- Fetch from the endpoint declared in `data-endpoint` on the mount
- Loading state replaces the placeholder text
- Renders the 1000×1000 SVG with the node and edge specs from §5
- Hover, click, and reset interactions per §5.9–5.10
- Mobile-mode logic per §5.11 — could be either a separate render path or a CSS-driven simplification, agent's call based on what reads cleanly
- Updates the metadata spans (`[data-meta-artists]`, `[data-meta-edges]`) in the caption from `stats`
- Updates the three numbers in the `.numbers` section from `stats`

### 8.3 The submit-track island

Astro island that hydrates `#submit-mount`. Three pieces:

1. **Spotify search picker.** Debounced text input, hits a chrisbuice.com Pages Function (`/api/spotify-search`) that proxies Spotify's search API using Client Credentials flow. Browser never sees the credentials.
2. **Optional fields.** "From" (label: `From — optional, but nice to know.`) and "Note" (label: `One line, if you want.`).
3. **Submit handler.** Posts to a chrisbuice.com Pages Function (`/api/submit-track`) which proxies through to the Surfaces worker with the shared-secret header. Honest feedback on submit: *"Added to the discovery pool — I'll see it next time I run a session."*

### 8.4 Pages Functions

Two new functions in the chrisbuice.com repo:

- `/functions/api/spotify-search.ts` — proxies Spotify search using Client Credentials. Env vars: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`.
- `/functions/api/submit-track.ts` — proxies submission to Surfaces with shared secret. Env vars: `SURFACES_ENDPOINT`, `SURFACES_SECRET`.

### 8.5 Day-one launch flexibility

If the submit-track backend isn't ready by launch:

- Keep the email-fallback placeholder shown in the drafted `surfaces.astro`
- Page ships fully composed-looking
- Wire the form in a follow-up

The constellation can also degrade gracefully — if `/api/constellation` 404s or returns malformed JSON, the renderer should hide the constellation section entirely (or show only the captions if the captions are content-bearing prose). Don't show a broken visual.

---

## 9. Implementation order

Suggested order, working from highest-dependency to lowest:

1. **Surfaces backend.** Cron job, layout computation, `/api/constellation` endpoint, `submissions` table migration, `/api/submit-track` endpoint, `manual_labels.ts`. Verify the JSON shape matches §6 by hitting the endpoint in a browser.
2. **chrisbuice.com page shell.** Drop the drafted `surfaces.astro` into `src/pages/`. Verify it builds and renders with placeholders.
3. **Constellation renderer island.** Hydrate `#constellation-mount`. Tune visual details against real data (spacing, label placement, hover-tooltip shape) — these are the things that *can* be rewritten freely; the file structure and prose cannot.
4. **Submit-track tool.** Spotify search picker, two Pages Functions, the form island, the success/failure states.
5. **Wire shared secrets.** `SURFACES_SECRET` on both sides, `SPOTIFY_CLIENT_ID/SECRET` on chrisbuice.com.
6. **Homepage Surfaces card.** A small card on the index page linking to `/surfaces`. (Outside the scope of this doc but worth building in the same session — already covered in `decisions_1.md`.)

---

## 10. Things to **not** rewrite

- The locked prose in §4. Voice took multiple iterations.
- The page structure in §3. Sequence is deliberate.
- The constellation spec in §5. Every parameter has reasoning behind it. Tune within (e.g., the noise threshold could move from 3 to 5 if real data demands it), but don't redesign (e.g., don't replace co-occurrence with audio similarity).
- The motion spec in §5.14. The three ambient layers (drift, cluster orbit, shimmer) plus twinkle plus the two hover-deepening effects (magnetic, edge tracing) are the agreed budget. Don't add more (no breathe, no edge pulse beyond hover, no parallax). Don't drop any without flagging — each has a specific job. Tuning the *parameters* (drift amplitude, orbit rate, shimmer period, twinkle frequency) is the right kind of iteration.
- The JSON contract in §6. Both halves of the system depend on it.
- The choice of SVG over Canvas/WebGL. Decided deliberately for accessibility, hover hit-testing, and dev complexity — not as a default.

## 11. Things to feel free to tune

- Visual details inside the renderer once real data is rendering — exact stroke widths, exact tooltip layout, exact label positions, hover transition timings.
- Motion *parameters*: drift amplitude (target ±0.5px but can range 0.3–0.8), orbit rate (target 0.3°/sec but can range 0.2–0.4), shimmer period (target 4s), twinkle frequency (target 2–3s between events). Iterate until the field "feels alive but not nervous."
- Cluster detection algorithm choice. Louvain is the recommendation but other community-detection algorithms are fine if Louvain produces awkward results on real data.
- SQL query optimization. The cron job needs to fit in the Worker time budget.
- Mobile rendering approach (separate render path vs. CSS-driven simplification).
- The exact look of the loading state — as long as it isn't a spinner.
- The exact look of the reflection legend — five dots with year ranges, but the geometry is open.

---

## 12. Files to be produced

In the **Surfaces** repo:
- `src/constellation/cron.ts` — the nightly job
- `src/constellation/queries.ts` — the three SQL queries
- `src/constellation/layout.ts` — the d3-force run
- `src/constellation/clusters.ts` — the Louvain community-detection pass and centroid/rotation-rate computation
- `src/constellation/manual_labels.ts` — the override list
- `src/db/migrations/00X_submissions.sql` — the new table
- New routes added to `src/index.ts` for `/api/constellation` and `/api/submit-track`
- A `wrangler.toml` cron trigger entry

In the **chrisbuice.com** repo:
- `src/pages/surfaces.astro` — drafted, drop in
- `src/components/Constellation.astro` (or `.tsx`/`.svelte` depending on framework choice for the island) — the renderer, including the RAF animation loop
- `src/components/ConstellationMotion.ts` — the animation logic separated out (drift, orbit, twinkle), tested independently of the SVG rendering
- `src/components/SubmitTrack.astro` — the submission form
- `functions/api/spotify-search.ts` — the search proxy
- `functions/api/submit-track.ts` — the submission proxy
- Possibly extending `src/layouts/Base.astro` if the body-class font swap should live there instead of scoped to the page (current draft scopes it to the page; valid both ways)

---

## 13. Voice and register reminders for the agent

- Tone is *understated*, not corporate or clever
- Em-dashes welcome — Chris "lives for the dash"
- Short sentences > long sentences
- Self-deprecation only when the underlying claim is competent
- The page voice deliberately uses Fraunces for body type instead of Inter, marking `/surfaces` as a more editorial register than the homepage. This is intentional and the body-class font swap lives in the drafted file.
- The visual register everywhere *except* the constellation is "data as art, in the Felton/Mandy Brown tradition." Refined-minimalist. Restraint and precision.
- The constellation itself is the one place on the page where the register tilts toward awe rather than restraint. Motion budget is deliberate — three ambient layers, three hover-deepening effects. The rest of the page's quiet earns the constellation's permission to be alive.
- No emoji, no AI imagery, no decorative icons, no stock illustrations. Every visual element on the page must be either prose, a real chart of real data, or a typographic mark.

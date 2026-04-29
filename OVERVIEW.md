# Spotify Curation Agent

A personal music curation system that learns from my listening habits and serves up the right music for the moment. Built entirely through conversations with Claude.

## What it does

The agent watches what I listen to, builds a taste profile, discovers new music from editorial sources, and curates sessions that blend familiar favorites with fresh finds -- all tuned to the time of day, weather, and what I'm doing.

**Three ways to use it:**

- **"Hey Siri, Working Music"** -- Six iOS Shortcuts (one per mode) that start a curated session with one voice command. GPS location is passed along so the agent knows the weather and time of day.
- **Dashboard** -- A web app showing what's playing, why it was picked, session controls, fresh discovery pool, listening stats, and like/block buttons.
- **Claude chat** -- Ask Claude to start a session, check stats, or manage tracks conversationally through an MCP server connection.

## How it works

### The listening loop

Every minute, a background job polls Spotify for what's currently playing. Over time, this builds a complete picture of listening behavior -- what gets completed, skipped, replayed, and when.

### Taste model

A daily rebuild scores every track and artist based on:
- Library presence (liked songs, top tracks across three time ranges)
- Seasonal playlist membership (auto-detected from playlist names like "Summer 2025")
- Play/skip/complete ratios from actual listening history
- Artist follow status and how many of their tracks I've played

### Discovery

The agent finds new music from two types of sources:

- **Artist-based:** Searches Spotify for recent releases from artists I follow or listen to most
- **Editorial RSS feeds:** Parses music blogs (Stereogum, The Line of Best Fit, EARMILK) daily for new track announcements, matches them to Spotify, and adds them to the discovery pool

Candidates are scored against the taste model -- tracks from artists I already love score high, tracks from unknown artists score lower but still make it in. This is how genuinely new music enters the system.

### Curation

When I start a session (via Siri, the dashboard, or Claude), the agent:

1. **Captures context** -- weather and temperature from Open-Meteo, daylight phase from sunrise/sunset times, location from GPS, device type, motion/Bluetooth signals
2. **Picks a mode** -- waking up, working, driving, brainstorming, unwinding, or sleeping (inferred from time of day if not specified)
3. **Builds a tracklist** using a freshness arc -- starts with familiar tracks, peaks with discoveries around the 75% mark, then cools down with known favorites at the end
4. **Applies context biases** -- rainy weather nudges toward comfort picks, nighttime favors low-skip tracks, driving context boosts sing-along anchors. These are soft multipliers, never hard filters.
5. **Learns over time** -- after enough data accumulates, learned affinities from actual listening patterns replace the initial rules. If I consistently play certain tracks on rainy nights, those tracks get boosted on future rainy nights.

### Feedback loop

While a session plays, a background job checks every two minutes for skips and replays. Three consecutive skips shift the remaining queue toward more familiar tracks. Mass-skipping early in a session resets context biases entirely (the agent assumes its context guess was wrong).

### Nightly summary

A daily email summarizes listening activity -- top tracks, total plays, skip rate, and fresh discovery adoption.

## Architecture

Everything runs on Cloudflare's free tier:

| Component | Service | Purpose |
|-----------|---------|---------|
| API + cron jobs | Cloudflare Worker | All application logic, Spotify API calls, RSS feed parsing |
| Database | Cloudflare D1 (SQLite) | 14 tables: listening history, taste scores, discovery pool, sessions, context snapshots |
| Token storage | Cloudflare KV | OAuth tokens, settings, playlist IDs |
| Dashboard | Cloudflare Pages | Static HTML served behind Cloudflare Access (email-gated login) |
| Weather | Open-Meteo API | Free, no API key, called on each session start |
| Email | Resend | Nightly listening summary |
| MCP Server | JSON-RPC 2.0 on the Worker | 8 tools for conversational control from Claude |

**Cost: $0/month.** Cloudflare's free tier handles everything for a single-user app. Spotify's developer API is free. Open-Meteo is free. Resend's free tier covers the daily email.

### Cron schedule

| Schedule | What runs |
|----------|-----------|
| Every minute | Poll Spotify for current playback, derive play events |
| Every 2 minutes | In-session feedback (skip/replay detection), context snapshots |
| 1:00 AM ET | Derive play events, rebuild taste model, rebuild learned affinities, prune old data |
| 6:00 AM ET | Discovery agent (artist search + editorial RSS feed) |
| 8:00 PM ET | Nightly listening summary email |

## The codebase

~4,000 lines of TypeScript across 27 files. No frontend framework -- the dashboard is a single HTML file with inline JavaScript. No npm runtime dependencies -- the only packages are Cloudflare's wrangler CLI and TypeScript types for development.

The MCP server implements the JSON-RPC 2.0 protocol in ~80 lines rather than using an SDK, because the SDK's Node.js dependencies don't run on Cloudflare Workers.

RSS feed parsing uses string splitting and regex instead of an XML parser. The feeds have predictable title formats ("Artist shares new song, 'Track Name'"), so a few regex patterns extract what's needed.

## How it was built

This entire application was built through two conversations with Claude using Claude Code. I'm not a developer -- I described what I wanted, and Claude wrote the code, configured the infrastructure, and walked me through setup steps like creating Spotify developer credentials and building iOS Shortcuts.

**Session 1** (April 28, 2026): Built milestones 0-9 from a plan document. Infrastructure, OAuth, listening tracker, taste model, curation engine, discovery agent, context capture, feedback loop, iOS Shortcuts, and the dashboard.

**Session 2** (April 28, 2026): Completed milestones 10-15. Learned context affinities, MCP server for Claude chat integration, editorial RSS feed discovery sources, and dashboard refinements (track explanations, like/block buttons on now playing).

The plan document (`SPOTIFY_AGENT_PLAN.md`) was written collaboratively before coding started. It defined the data model, algorithms, API design, and milestone breakdown. Claude followed it closely, asking when something was ambiguous rather than guessing.

## Tools used

- **Claude Code** -- Anthropic's CLI for Claude. Used for all code generation, debugging, deployment, and infrastructure setup.
- **Cloudflare Workers / D1 / KV / Pages** -- Serverless compute, database, key-value store, and static hosting.
- **Spotify Web API** -- Playback control, library access, search, playlist management.
- **iOS Shortcuts** -- Six voice-activated shortcuts that send GPS context to the agent.
- **Open-Meteo** -- Free weather API for context-aware curation.
- **Resend** -- Transactional email for daily listening summaries.
- **MCP (Model Context Protocol)** -- Connects the agent to Claude.ai for conversational control.

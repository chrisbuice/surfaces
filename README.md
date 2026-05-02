# Surfaces

Surfacing tracks for the surfaces of your day. Surfaces is a personal, single-user Spotify companion that watches listening behavior, builds a taste profile, discovers new music from editorial and algorithmic sources, and curates sessions blending familiar favorites with fresh finds — tuned to time of day, weather, location, and context.

## Stack

- **Cloudflare Workers** — runtime, cron triggers, API
- **Cloudflare D1** — SQLite database for listening history, taste model, discovery pool, sessions
- **Cloudflare KV** — OAuth tokens, config, caches
- **Spotify Web API** — playback control, library access, recently-played polling
- **MCP server** — Claude integration for conversational session control

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in your Spotify credentials
wrangler dev
```

## Deploy

```bash
wrangler deploy
```

## Note

This is a personal single-user project. The auth flow, taste model, and curation logic are all tuned for one person's listening history. There's no multi-user support and no plans to add it.

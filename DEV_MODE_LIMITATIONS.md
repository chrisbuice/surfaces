# Spotify Web API — Development Mode Limitations

Summary of endpoints blocked (403 Forbidden) for a personal, single-user app in Development Mode. Prepared for a request to the Spotify Developer Community forum.

---

## Context

I'm building a personal music curation tool — a single-user app that only I use. It tracks my listening history, builds a taste model from my own library, discovers new music from artists I follow, and creates curated sessions. It runs on Cloudflare Workers (serverless) and interacts solely with my own Spotify account.

My account is Premium. My Spotify email is listed in the app's User Management. The app has both "Web API" and "Web Playback SDK" checked in the dashboard.

## What works

These endpoints function correctly in Development Mode:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/me` | GET | User profile |
| `/v1/me/tracks` | GET | Read saved/liked songs |
| `/v1/me/top/tracks` | GET | Top tracks (all time ranges) |
| `/v1/me/top/artists` | GET | Top artists (all time ranges) |
| `/v1/me/playlists` | GET | List user's playlists |
| `/v1/me/following` | GET | Followed artists |
| `/v1/me/player/currently-playing` | GET | Currently playing track |
| `/v1/me/player/queue` | POST | Add track to queue |
| `/v1/search` | GET | Search for tracks/artists/playlists |
| `/v1/artists/{id}/albums` | GET | Artist discography |

## What is blocked (403 Forbidden)

### Playlist track access (READ)

| Endpoint | Method | Purpose | Impact |
|----------|--------|---------|--------|
| `/v1/playlists/{id}/tracks` | GET | Read tracks from any playlist | **Cannot read tracks from my own playlists.** This is the single biggest limitation. My app builds a taste model partly from seasonal playlists I've manually curated — I need to read the tracks in my own playlists to know what songs I've associated with each season. This is read-only access to my own data. |

This also blocks reading Spotify editorial playlists (New Music Friday, Fresh Finds, etc.) for music discovery.

### Browse endpoints (READ)

| Endpoint | Method | Purpose | Impact |
|----------|--------|---------|--------|
| `/v1/browse/new-releases` | GET | New album/single releases | Cannot discover new releases. Workaround: using `/v1/search` with `year:2026` filter, but this is less comprehensive. |
| `/v1/browse/featured-playlists` | GET | Spotify's featured playlists | Cannot browse editorial playlist selections. |

### Library write operations

| Endpoint | Method | Purpose | Impact |
|----------|--------|---------|--------|
| `/v1/me/tracks` | PUT | Save a track to Liked Songs | Cannot like/save tracks programmatically. My dashboard has a "like" button that can't function. |
| `/v1/me/tracks` | DELETE | Remove from Liked Songs | Cannot unlike tracks. |
| `/v1/playlists/{id}/tracks` | POST | Add tracks to a playlist | **Cannot populate playlists.** I can create empty playlists but cannot add tracks to them. This means my curated sessions can only output via direct playback or queue — I can't save a session as a playlist for later. |

### Playback (intermittent)

| Endpoint | Method | Purpose | Impact |
|----------|--------|---------|--------|
| `/v1/me/player/play` | PUT | Start playback | Sometimes returns 403. May be device-dependent rather than a blanket restriction. Playback via queue (`POST /me/player/queue`) works reliably. |

## Summary of impact on my app

1. **Taste model is degraded.** I can't read my own playlist tracks, so my seasonal playlist analysis (a core feature) depends on tokens that intermittently gain/lose this permission.

2. **Music discovery is limited.** I can't scan new releases or editorial playlists. I work around this with search, but miss breadth.

3. **No playlist output.** Curated sessions can play immediately or queue, but I can't save them as playlists for later listening.

4. **No library management.** Can't like or unlike tracks from my app's interface.

5. **No editorial playlist scanning.** Can't read tracks from Spotify-owned playlists like New Music Friday, which would significantly improve discovery quality.

## My request

I'm a single user building a personal tool. I'm not building a commercial product. I understand Extended Quota Mode requires 250K+ MAU and a registered business — that's clearly not applicable here.

Is there a path for personal/developer use that unlocks read access to playlist tracks and basic library write operations? These are operations on my own data, for my own account, running on my own infrastructure.

Specific asks, in priority order:
1. `GET /v1/playlists/{id}/tracks` — read my own playlists
2. `PUT /v1/me/tracks` — save tracks to my own library
3. `POST /v1/playlists/{id}/tracks` — add tracks to my own playlists
4. `GET /v1/browse/new-releases` — browse new releases

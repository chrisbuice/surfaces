# iOS Shortcuts Setup

Build 6 shortcuts — one per mode — that start a music session with physical context.

## What you need

- iPhone with iOS 16+ and the **Shortcuts** app (pre-installed)
- Your shortcut token: `<redacted — rotated 2026-05-03>`
- Your Worker URL: `https://spotify-agent.chrisbuice.workers.dev`

## Build the "Working Music" shortcut (template for all 6)

Open the **Shortcuts** app and tap **+** to create a new shortcut.

### Step 1: Get Location
1. Tap **Add Action**
2. Search for **"Get Current Location"** and add it
3. This gives us GPS coordinates for weather lookup

### Step 2: Get network info (for Bluetooth detection)
1. Tap **+** below the location action
2. Search for **"Get Network Details"** → select **"Get Details of Network"**
3. Set it to get **"Network Name"** of **"Wi-Fi"**
   *(We'll use this to infer home/work — optional, can skip)*

### Step 3: Build the request body
1. Tap **+**, search for **"Dictionary"**, add it
2. Add these keys (tap "Add new item" for each):

| Key | Type | Value |
|-----|------|-------|
| `mode` | Text | `working` |
| `minutes` | Number | `90` |

3. Now add a `context` key with type **Dictionary**, containing:

| Key | Type | Value |
|-----|------|-------|
| `location_lat` | Number | Tap the field → select **"Current Location"** → **"Latitude"** |
| `location_lon` | Number | Tap the field → select **"Current Location"** → **"Longitude"** |
| `location_label` | Text | `home` (or leave blank to auto-detect) |
| `is_in_motion` | Number | `0` |
| `bluetooth_context` | Text | *(leave empty, or type `car`/`headphones` if you want to hardcode)* |

### Step 4: Make the API call
1. Tap **+**, search for **"Get Contents of URL"**, add it
2. Set the URL to: `https://spotify-agent.chrisbuice.workers.dev/shortcut/start`
3. Tap **"Show More"**:
   - **Method:** POST
   - **Headers:** Add one header:
     - Key: `Authorization`
     - Value: `Bearer <redacted — rotated 2026-05-03>`
   - **Request Body:** JSON
   - Tap the body field and select the **Dictionary** from Step 3

### Step 5: Speak the result
1. Tap **+**, search for **"Get Dictionary Value"**, add it
2. Get **"Value"** for key **"summary"** in **"Contents of URL"**
3. Tap **+**, search for **"Speak Text"** (or **"Show Result"**), add it
4. Set it to speak/show the **"Dictionary Value"** from the previous step

### Step 6: Name it
1. Tap the shortcut name at the top
2. Name it **"Working Music"**
3. Optionally add an icon (🎵) and color

### Step 7: Test it
1. Make sure Spotify is open on a device
2. Tap the shortcut
3. It should start playing and say something like: *"Started working session, 26 tracks. Partly cloudy 59°F."*

You can now say **"Hey Siri, Working Music"** to trigger it.

---

## Create the other 5 shortcuts

Duplicate the "Working Music" shortcut and change the **mode** and **minutes** for each:

| Shortcut Name | Mode | Default Minutes | Notes |
|---------------|------|-----------------|-------|
| **Waking Up Music** | `waking_up` | `30` | |
| **Working Music** | `working` | `90` | (already built above) |
| **Driving Music** | `driving` | `45` | Set `is_in_motion` to `1` and `bluetooth_context` to `car` |
| **Brainstorming Music** | `brainstorming` | `60` | |
| **Unwinding Music** | `unwinding` | `60` | |
| **Sleeping Music** | `sleeping` | `45` | |

### Driving shortcut special setup

For the **Driving Music** shortcut, change the context dictionary:
- `is_in_motion`: `1`
- `bluetooth_context`: `car`

This triggers the driving-context biases (high-energy familiar tracks, car Bluetooth detection).

### Sleeping shortcut note

The sleeping mode uses `output: play_now` via the shortcut endpoint. The plan originally wanted `output: playlist` for sleeping (so it doesn't autoplay something jarring after the session ends), but playlist writes are currently blocked in Dev Mode. When that's resolved, we can update the endpoint.

---

## Optional: Shortcut Automations

You can set shortcuts to run automatically:

1. Open Shortcuts → **Automation** tab → **+**
2. **"Time of Day"** → e.g., 6:30 AM → Run **"Waking Up Music"**
3. **"CarPlay"** / **"Bluetooth"** → When connected to car → Run **"Driving Music"**
4. **"Arrive"** → When arriving at gym → Run a workout playlist mode

---

## Endpoints reference

| Endpoint | What it does |
|----------|-------------|
| `POST /shortcut/start` | Start playing a session (replaces current playback) |
| `POST /shortcut/queue` | Queue tracks without disrupting current playback |
| `POST /shortcut/save_to_seasonal` | Add currently-playing track to current season's playlist |

All require `Authorization: Bearer <SHORTCUT_TOKEN>` header.

### Request body for start/queue

```json
{
  "mode": "working",
  "minutes": 90,
  "context": {
    "location_label": "home",
    "location_lat": 33.78,
    "location_lon": -84.39,
    "is_in_motion": 0,
    "bluetooth_context": null,
    "user_note": "about to cook dinner"
  }
}
```

All context fields are optional. The Worker fills in weather and daylight from the coordinates.

### Response

```json
{
  "ok": true,
  "summary": "Started working session, 26 tracks (22 familiar, 4 fresh). partly_cloudy 59°F"
}
```

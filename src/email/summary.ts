/**
 * summary.ts — nightly listening summary, emailed at 8pm ET.
 *
 * Generates a summary of today's listening activity and sends it
 * via Resend (free transactional email API).
 */

const RESEND_API = "https://api.resend.com/emails";
const TO_EMAIL = "chrisbuice@gmail.com";
const FROM_EMAIL = "Surfaces <spotify-agent@amberglow.ai>";

interface DailySummary {
  totalTracks: number;
  totalMinutes: number;
  completed: number;
  skipped: number;
  abandoned: number;
  skipRate: number;
  topTracks: Array<{ name: string; count: number }>;
  topArtists: Array<{ name: string; count: number }>;
  freshTracksPlayed: number;
  freshTracksSkipped: number;
  freshTracksCompleted: number;
  contextBreakdown: {
    weather: Record<string, number>;
    daylight: Record<string, number>;
    device: Record<string, number>;
    location: Record<string, number>;
  };
  modesSessions: Array<{ mode: string; count: number }>;
  newInPool: number;
}

export async function generateAndSendSummary(
  db: D1Database,
  resendApiKey: string
): Promise<{ sent: boolean; error?: string }> {
  const summary = await buildSummary(db);

  if (summary.totalTracks === 0) {
    // Don't send if nothing was played today
    return { sent: false, error: "No listening activity today" };
  }

  const html = renderEmail(summary);
  const subject = `🎵 ${summary.totalTracks} tracks, ${summary.totalMinutes} min — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" })}`;

  try {
    const resp = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [TO_EMAIL],
        subject,
        html,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { sent: false, error: `Resend API error: ${resp.status} ${text}` };
    }

    return { sent: true };
  } catch (err) {
    return { sent: false, error: String(err) };
  }
}

async function buildSummary(db: D1Database): Promise<DailySummary> {
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;

  // Play events from last 24 hours
  const events = await db.prepare(`
    SELECT pe.track_id, pe.classification, pe.duration_listened_ms, pe.device_type,
           COALESCE(tt.track_name, po.track_name) as track_name,
           tt.primary_artist_id
    FROM play_events pe
    LEFT JOIN track_taste tt ON tt.track_id = pe.track_id
    LEFT JOIN poll_observations po ON po.track_id = pe.track_id
    WHERE pe.started_at >= ?
    GROUP BY pe.id
    ORDER BY pe.started_at DESC
  `).bind(since).all<{
    track_id: string; classification: string; duration_listened_ms: number;
    device_type: string | null; track_name: string | null; primary_artist_id: string | null;
  }>();

  const rows = events.results;
  const totalTracks = rows.length;
  const totalMinutes = Math.round(rows.reduce((s, r) => s + r.duration_listened_ms, 0) / 60000);
  const completed = rows.filter(r => r.classification === "completed").length;
  const skipped = rows.filter(r => r.classification === "skipped").length;
  const abandoned = rows.filter(r => r.classification === "abandoned").length;
  // Skip rate excludes abandoned from both numerator and denominator
  const ratedTracks = totalTracks - abandoned;
  const skipRate = ratedTracks > 0 ? Math.round(skipped / ratedTracks * 100) : 0;

  // Top tracks by play count
  const trackCounts = new Map<string, { name: string; count: number }>();
  for (const r of rows) {
    const name = r.track_name || r.track_id;
    const entry = trackCounts.get(name) ?? { name, count: 0 };
    entry.count++;
    trackCounts.set(name, entry);
  }
  const topTracks = [...trackCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  // Top artists
  const artistIds = [...new Set(rows.map(r => r.primary_artist_id).filter(Boolean))];
  const artistCounts = new Map<string, { name: string; count: number }>();
  for (const r of rows) {
    if (!r.primary_artist_id) continue;
    const entry = artistCounts.get(r.primary_artist_id) ?? { name: r.primary_artist_id, count: 0 };
    entry.count++;
    artistCounts.set(r.primary_artist_id, entry);
  }
  // Resolve artist names
  if (artistIds.length > 0) {
    const artistNames = await db.prepare(
      "SELECT artist_id, artist_name FROM artist_taste"
    ).all<{ artist_id: string; artist_name: string }>();
    for (const an of artistNames.results) {
      const entry = artistCounts.get(an.artist_id);
      if (entry) entry.name = an.artist_name;
    }
  }
  const topArtists = [...artistCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  // Fresh tracks stats
  const freshEvents = await db.prepare(`
    SELECT st.source, pe.classification
    FROM session_tracks st
    JOIN play_events pe ON pe.track_id = st.track_id
    JOIN sessions s ON s.session_id = st.session_id
    WHERE pe.started_at >= ? AND st.source LIKE 'fresh:%'
    GROUP BY pe.id
  `).bind(since).all<{ source: string; classification: string }>();
  const freshTracksPlayed = freshEvents.results.length;
  const freshTracksCompleted = freshEvents.results.filter(r => r.classification === "completed").length;
  const freshTracksSkipped = freshEvents.results.filter(r => r.classification === "skipped").length;

  // Context breakdown from snapshots linked to play events
  const contextRows = await db.prepare(`
    SELECT cs.weather_condition, cs.daylight_phase, cs.device_type, cs.location_label
    FROM play_event_context pec
    JOIN context_snapshots cs ON cs.id = pec.context_snapshot_id
    JOIN play_events pe ON pe.id = pec.play_event_id
    WHERE pe.started_at >= ?
  `).bind(since).all<{
    weather_condition: string | null; daylight_phase: string;
    device_type: string | null; location_label: string | null;
  }>();

  const contextBreakdown = { weather: {} as Record<string, number>, daylight: {} as Record<string, number>, device: {} as Record<string, number>, location: {} as Record<string, number> };
  for (const r of contextRows.results) {
    if (r.weather_condition) contextBreakdown.weather[r.weather_condition] = (contextBreakdown.weather[r.weather_condition] ?? 0) + 1;
    contextBreakdown.daylight[r.daylight_phase] = (contextBreakdown.daylight[r.daylight_phase] ?? 0) + 1;
    if (r.device_type) contextBreakdown.device[r.device_type] = (contextBreakdown.device[r.device_type] ?? 0) + 1;
    if (r.location_label) contextBreakdown.location[r.location_label] = (contextBreakdown.location[r.location_label] ?? 0) + 1;
  }

  // Sessions today
  const sessions = await db.prepare(
    "SELECT mode, COUNT(*) as count FROM sessions WHERE invoked_at >= ? GROUP BY mode"
  ).bind(since).all<{ mode: string; count: number }>();

  // New in fresh pool today
  const newPool = await db.prepare(
    "SELECT COUNT(*) as count FROM fresh_pool WHERE found_at >= ?"
  ).bind(since).first<{ count: number }>();

  return {
    totalTracks, totalMinutes, completed, skipped, abandoned, skipRate,
    topTracks, topArtists,
    freshTracksPlayed, freshTracksSkipped, freshTracksCompleted,
    contextBreakdown,
    modesSessions: sessions.results,
    newInPool: newPool?.count ?? 0,
  };
}

function renderEmail(s: DailySummary): string {
  const contextLine = (label: string, data: Record<string, number>) => {
    const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return "";
    return `<tr><td style="color:#666;padding:6px 0;font-size:14px;">${label}</td><td style="padding:6px 0;font-size:14px;color:#333;">${entries.map(([k, v]) => `${k} (${v})`).join(", ")}</td></tr>`;
  };

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto;background:#ffffff;color:#333;padding:28px;border-radius:12px;">
  <div style="margin-bottom:24px;">
    <span style="font-size:22px;font-weight:700;color:#191414;">Daily Listening Summary</span>
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
    <tr>
      <td width="33%" style="background:#f5f5f5;padding:16px 8px;border-radius:8px;text-align:center;">
        <div style="font-size:32px;font-weight:700;color:#1db954;">${s.totalTracks}</div>
        <div style="font-size:13px;color:#666;margin-top:4px;">tracks</div>
      </td>
      <td width="4"></td>
      <td width="33%" style="background:#f5f5f5;padding:16px 8px;border-radius:8px;text-align:center;">
        <div style="font-size:32px;font-weight:700;color:#1db954;">${s.totalMinutes}</div>
        <div style="font-size:13px;color:#666;margin-top:4px;">minutes</div>
      </td>
      <td width="4"></td>
      <td width="33%" style="background:#f5f5f5;padding:16px 8px;border-radius:8px;text-align:center;">
        <div style="font-size:32px;font-weight:700;color:${s.skipRate > 30 ? "#e74c3c" : "#1db954"};">${s.skipRate}%</div>
        <div style="font-size:13px;color:#666;margin-top:4px;">skip rate</div>
      </td>
    </tr>
  </table>

  ${s.completed + s.skipped + s.abandoned > 0 ? `
  <div style="margin-bottom:24px;font-size:14px;color:#666;">
    ${s.completed} completed &middot; ${s.skipped} skipped &middot; ${s.abandoned} abandoned
  </div>` : ""}

  ${s.topTracks.length > 0 ? `
  <div style="font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 10px;border-bottom:2px solid #f0f0f0;padding-bottom:6px;">Most Played</div>
  <table style="width:100%;margin-bottom:24px;">
    ${s.topTracks.map(t => `<tr><td style="padding:6px 0;font-size:15px;color:#333;">${t.name}</td><td style="padding:6px 0;font-size:15px;color:#1db954;text-align:right;font-weight:600;">${t.count}x</td></tr>`).join("")}
  </table>` : ""}

  ${s.topArtists.length > 0 ? `
  <div style="font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 10px;border-bottom:2px solid #f0f0f0;padding-bottom:6px;">Top Artists</div>
  <table style="width:100%;margin-bottom:24px;">
    ${s.topArtists.map(a => `<tr><td style="padding:6px 0;font-size:15px;color:#333;">${a.name}</td><td style="padding:6px 0;font-size:15px;color:#1db954;text-align:right;font-weight:600;">${a.count} plays</td></tr>`).join("")}
  </table>` : ""}

  ${s.freshTracksPlayed > 0 ? `
  <div style="font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 10px;border-bottom:2px solid #f0f0f0;padding-bottom:6px;">Discovery</div>
  <div style="margin-bottom:24px;font-size:14px;color:#333;">
    ${s.freshTracksPlayed} fresh tracks played &middot; ${s.freshTracksCompleted} completed &middot; ${s.freshTracksSkipped} skipped
    ${s.newInPool > 0 ? `<br style="margin-top:4px;">${s.newInPool} new candidates added to pool` : ""}
  </div>` : s.newInPool > 0 ? `
  <div style="margin-bottom:24px;font-size:14px;color:#666;">
    ${s.newInPool} new discovery candidates added to pool
  </div>` : ""}

  ${s.modesSessions.length > 0 ? `
  <div style="font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 10px;border-bottom:2px solid #f0f0f0;padding-bottom:6px;">Sessions</div>
  <div style="margin-bottom:24px;font-size:14px;color:#333;">
    ${s.modesSessions.map(m => `${m.mode} (${m.count})`).join(" &middot; ")}
  </div>` : ""}

  ${Object.values(s.contextBreakdown).some(d => Object.keys(d).length > 0) ? `
  <div style="font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:1.5px;margin:0 0 10px;border-bottom:2px solid #f0f0f0;padding-bottom:6px;">Context</div>
  <table style="width:100%;margin-bottom:24px;">
    ${contextLine("Weather", s.contextBreakdown.weather)}
    ${contextLine("Daylight", s.contextBreakdown.daylight)}
    ${contextLine("Device", s.contextBreakdown.device)}
    ${contextLine("Location", s.contextBreakdown.location)}
  </table>` : ""}

  <div style="font-size:12px;color:#999;margin-top:20px;border-top:1px solid #eee;padding-top:16px;">
    Surfaces &middot; <a href="https://spotify-agent-dashboard.pages.dev" style="color:#1db954;text-decoration:none;font-weight:500;">Open Dashboard</a>
  </div>
</div>`;
}

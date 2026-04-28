/**
 * capture.ts — build a context_snapshot from inputs + APIs.
 *
 * Called at session start. Assembles context from:
 * - Current time + timezone → local hour, day of week
 * - Open-Meteo → weather, sunrise/sunset → daylight phase
 * - Most recent poll observation → device type
 * - Optional shortcut payload → location, motion, Bluetooth, user note
 */

import { getWeatherAndSun, getDaylightPhase } from "./weather";
import { getLastObservation } from "../db/queries";

const USER_TZ = "America/New_York";

export interface ContextInput {
  locationLabel?: string | null;
  locationLat?: number | null;
  locationLon?: number | null;
  isInMotion?: number | null;
  bluetoothContext?: string | null;
  userNote?: string | null;
}

export interface ContextSnapshot {
  capturedAt: number;
  trigger: string;
  localHour: number;
  localMinute: number;
  dayOfWeek: number;
  daylightPhase: string;
  sunriseAt: number | null;
  sunsetAt: number | null;
  weatherTempF: number | null;
  weatherCondition: string | null;
  weatherPrecipitationMm: number | null;
  weatherWindMph: number | null;
  weatherCloudPct: number | null;
  locationLabel: string | null;
  locationLat: number | null;
  locationLon: number | null;
  locationSource: string;
  deviceType: string | null;
  isInMotion: number | null;
  bluetoothContext: string | null;
  calendarEventTitle: string | null;
  calendarEventCategory: string | null;
  calendarEventEndsAt: number | null;
  userNote: string | null;
}

/** Capture a full context snapshot and persist it to D1. Returns the snapshot ID. */
export async function captureContext(
  db: D1Database,
  trigger: string,
  input: ContextInput
): Promise<{ snapshotId: number; snapshot: ContextSnapshot }> {
  const now = Math.floor(Date.now() / 1000);

  // ── Time ──
  const localTime = new Date(new Date().toLocaleString("en-US", { timeZone: USER_TZ }));
  const localHour = localTime.getHours();
  const localMinute = localTime.getMinutes();
  const dayOfWeek = localTime.getDay();

  // ── Location: use input if provided, otherwise fall back to settings ──
  let lat: number | null = input.locationLat ?? null;
  let lon: number | null = input.locationLon ?? null;
  let locationLabel = input.locationLabel ?? null;
  let locationSource = "unknown";

  if (lat !== null && lon !== null) {
    locationSource = "shortcut";
  } else {
    // Fall back to home location from settings
    const settings = await db.prepare(
      "SELECT home_lat, home_lon, home_label FROM settings WHERE id = 1"
    ).first<{ home_lat: number | null; home_lon: number | null; home_label: string | null }>();
    if (settings?.home_lat && settings?.home_lon) {
      lat = settings.home_lat;
      lon = settings.home_lon;
      locationLabel = settings.home_label ?? "home";
      locationSource = "default_home";
    }
  }

  // ── Weather + Sunrise/Sunset ──
  let weatherTempF: number | null = null;
  let weatherCondition: string | null = null;
  let weatherPrecipitationMm: number | null = null;
  let weatherWindMph: number | null = null;
  let weatherCloudPct: number | null = null;
  let sunriseAt: number | null = null;
  let sunsetAt: number | null = null;
  let daylightPhase = "unknown";

  if (lat !== null && lon !== null) {
    const weatherData = await getWeatherAndSun(lat, lon);
    if (weatherData) {
      weatherTempF = weatherData.weather.tempF;
      weatherCondition = weatherData.weather.condition;
      weatherPrecipitationMm = weatherData.weather.precipitationMm;
      weatherWindMph = weatherData.weather.windMph;
      weatherCloudPct = weatherData.weather.cloudPct;
      sunriseAt = weatherData.sun.sunriseUnix;
      sunsetAt = weatherData.sun.sunsetUnix;
      daylightPhase = getDaylightPhase(now, sunriseAt, sunsetAt);
    }
  }

  // If no weather data, infer daylight phase from hour alone
  if (daylightPhase === "unknown") {
    if (localHour < 6) daylightPhase = "night";
    else if (localHour < 8) daylightPhase = "pre_dawn";
    else if (localHour < 11) daylightPhase = "morning";
    else if (localHour < 17) daylightPhase = "midday";
    else if (localHour < 19) daylightPhase = "golden_hour";
    else if (localHour < 20) daylightPhase = "dusk";
    else daylightPhase = "night";
  }

  // ── Device type from most recent poll observation ──
  const lastObs = await getLastObservation(db);
  const deviceType = lastObs?.device_type ?? null;

  // ── Build snapshot ──
  const snapshot: ContextSnapshot = {
    capturedAt: now,
    trigger,
    localHour,
    localMinute,
    dayOfWeek,
    daylightPhase,
    sunriseAt,
    sunsetAt,
    weatherTempF,
    weatherCondition,
    weatherPrecipitationMm,
    weatherWindMph,
    weatherCloudPct,
    locationLabel,
    locationLat: lat,
    locationLon: lon,
    locationSource,
    deviceType,
    isInMotion: input.isInMotion ?? null,
    bluetoothContext: input.bluetoothContext ?? null,
    calendarEventTitle: null,   // M12
    calendarEventCategory: null, // M12
    calendarEventEndsAt: null,   // M12
    userNote: input.userNote ?? null,
  };

  // ── Persist ──
  const result = await db.prepare(`
    INSERT INTO context_snapshots
      (captured_at, trigger, local_hour, local_minute, day_of_week, daylight_phase,
       sunrise_at, sunset_at, weather_temp_f, weather_condition, weather_precipitation_mm,
       weather_wind_mph, weather_cloud_pct, location_label, location_lat, location_lon,
       location_source, device_type, is_in_motion, bluetooth_context,
       calendar_event_title, calendar_event_category, calendar_event_ends_at, user_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    snapshot.capturedAt, snapshot.trigger, snapshot.localHour, snapshot.localMinute,
    snapshot.dayOfWeek, snapshot.daylightPhase, snapshot.sunriseAt, snapshot.sunsetAt,
    snapshot.weatherTempF, snapshot.weatherCondition, snapshot.weatherPrecipitationMm,
    snapshot.weatherWindMph, snapshot.weatherCloudPct, snapshot.locationLabel,
    snapshot.locationLat, snapshot.locationLon, snapshot.locationSource,
    snapshot.deviceType, snapshot.isInMotion, snapshot.bluetoothContext,
    snapshot.calendarEventTitle, snapshot.calendarEventCategory,
    snapshot.calendarEventEndsAt, snapshot.userNote
  ).run();

  const snapshotId = result.meta.last_row_id as number;

  return { snapshotId, snapshot };
}

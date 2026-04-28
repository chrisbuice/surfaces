/**
 * weather.ts — Open-Meteo client for weather + sunrise/sunset.
 *
 * Open-Meteo is free, no API key required. We fetch current weather
 * and today's sunrise/sunset in a single call.
 */

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1";

export interface WeatherData {
  tempF: number;
  condition: string;
  precipitationMm: number;
  windMph: number;
  cloudPct: number;
}

export interface SunData {
  sunriseUnix: number;
  sunsetUnix: number;
}

interface OpenMeteoCurrentResponse {
  current: {
    temperature_2m: number;
    weather_code: number;
    precipitation: number;
    wind_speed_10m: number;
    cloud_cover: number;
  };
  daily: {
    sunrise: string[];
    sunset: string[];
  };
}

/** Fetch current weather and sunrise/sunset for a location */
export async function getWeatherAndSun(
  lat: number,
  lon: number
): Promise<{ weather: WeatherData; sun: SunData } | null> {
  try {
    const params = new URLSearchParams({
      latitude: lat.toString(),
      longitude: lon.toString(),
      current: "temperature_2m,weather_code,precipitation,wind_speed_10m,cloud_cover",
      daily: "sunrise,sunset",
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
      precipitation_unit: "mm",
      timezone: "auto",
      forecast_days: "1",
    });

    const resp = await fetch(`${OPEN_METEO_BASE}/forecast?${params}`);
    if (!resp.ok) return null;

    const data = (await resp.json()) as OpenMeteoCurrentResponse;

    const weather: WeatherData = {
      tempF: data.current.temperature_2m,
      condition: weatherCodeToCondition(data.current.weather_code),
      precipitationMm: data.current.precipitation,
      windMph: data.current.wind_speed_10m,
      cloudPct: data.current.cloud_cover,
    };

    const sun: SunData = {
      sunriseUnix: Math.floor(new Date(data.daily.sunrise[0]).getTime() / 1000),
      sunsetUnix: Math.floor(new Date(data.daily.sunset[0]).getTime() / 1000),
    };

    return { weather, sun };
  } catch (err) {
    console.error("Weather fetch failed:", err);
    return null;
  }
}

/** Compute daylight phase from current time + sunrise/sunset */
export function getDaylightPhase(
  nowUnix: number,
  sunriseUnix: number,
  sunsetUnix: number
): string {
  const preDawn = sunriseUnix - 3600; // 1 hour before sunrise
  const morning = sunriseUnix + 3 * 3600; // 3 hours after sunrise
  const goldenHour = sunsetUnix - 3600; // 1 hour before sunset
  const dusk = sunsetUnix + 1800; // 30 min after sunset

  if (nowUnix < preDawn) return "night";
  if (nowUnix < sunriseUnix) return "pre_dawn";
  if (nowUnix < morning) return "morning";
  if (nowUnix < goldenHour) return "midday";
  if (nowUnix < sunsetUnix) return "golden_hour";
  if (nowUnix < dusk) return "dusk";
  return "night";
}

/** Map WMO weather codes to our simplified conditions */
function weatherCodeToCondition(code: number): string {
  if (code === 0) return "clear";
  if (code <= 3) return "partly_cloudy";
  if (code <= 48) return "fog";
  if (code <= 57) return "overcast"; // drizzle
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "rain"; // showers
  if (code <= 86) return "snow"; // snow showers
  if (code >= 95) return "thunderstorm";
  return "overcast";
}

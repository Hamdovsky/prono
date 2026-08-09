const axios = require('axios')
const logger = require('../core/logger')

const WMO_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Drizzle',
  53: 'Drizzle',
  55: 'Drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Violent rain showers',
  85: 'Snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
}

class OpenMeteoService {
  constructor() {
    this.baseUrl = 'https://api.open-meteo.com/v1/forecast'
    this.enabled = process.env.OPEN_METEO_ENABLED !== 'false'
    if (this.enabled) {
      logger.info('✅ [OPEN-METEO] Free weather service ready (no API key required)')
    }
  }

  isAvailable() {
    return this.enabled
  }

  /**
   * Resolves a city name to coordinates using open-meteo's free geocoding API.
   * @returns {Promise<{lat: number, lon: number}|null>}
   */
  async geocode(city) {
    if (!city) return null
    try {
      const { data } = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
        params: { name: city, count: 1, language: 'fr', format: 'json' },
        timeout: 8000,
      })
      const first = data?.results?.[0]
      if (!first) return null
      return { lat: first.latitude, lon: first.longitude }
    } catch (e) {
      logger.warn(`⚠️ [OPEN-METEO] geocode(${city}) failed: ${e.message}`)
      return null
    }
  }

  async fetchByCoords(lat, lon) {
    if (!this.isAvailable()) return null
    try {
      const { data } = await axios.get(this.baseUrl, {
        params: {
          latitude: lat,
          longitude: lon,
          current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation',
          timezone: 'auto',
        },
        timeout: 10000,
      })
      return data
    } catch (e) {
      logger.warn(`⚠️ [OPEN-METEO] fetchByCoords(${lat},${lon}) failed: ${e.message}`)
      return null
    }
  }

  async fetchByCity(city) {
    if (!this.isAvailable()) return null
    const coords = await this.geocode(city)
    if (!coords) return null
    return this.fetchByCoords(coords.lat, coords.lon)
  }

  /**
   * Normalizes open-meteo response to the same shape WeatherService.extractWeatherInfo uses,
   * so downstream code (enriched_predictions, StatisticalEngine, dashboard) works unchanged.
   */
  extractWeatherInfo(weatherData) {
    if (!weatherData?.current) return null
    const c = weatherData.current
    const code = c.weather_code
    return {
      temp: c.temperature_2m ?? null,
      feels_like: c.temperature_2m ?? null,
      humidity: c.relative_humidity_2m ?? null,
      pressure: null,
      wind_speed: c.wind_speed_10m ?? null,
      wind_deg: null,
      clouds: null,
      rain_1h: c.precipitation ?? 0,
      snow_1h: 0,
      condition: WMO_CODES[code] || 'Unknown',
      description: WMO_CODES[code] || 'Unknown',
      icon: null,
      city: null,
      country: null,
      timestamp: c.time ? Date.parse(c.time) / 1000 : null,
      last_updated: Date.now(),
      source: 'open-meteo',
    }
  }
}

module.exports = new OpenMeteoService()

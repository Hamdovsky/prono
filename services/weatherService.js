const axios = require('axios')
const logger = require('../core/logger')

class WeatherService {
  constructor() {
    this.apiKey = process.env.OPENWEATHER_KEY || ''
    this.baseUrl = 'https://api.openweathermap.org/data/2.5'
    this.enabled = process.env.OPENWEATHER_ENABLED !== 'false'

    if (!this.apiKey || this.apiKey.startsWith('CHANGER_MOI')) {
      logger.warn('⚠️ [WEATHER] No API key configured — service disabled')
      this.enabled = false
    } else {
      logger.info(`✅ [WEATHER] Service ready (key: ${this.apiKey.slice(0, 8)}...)`)
    }
  }

  isAvailable() {
    return this.enabled && !!this.apiKey
  }

  async fetchByCoords(lat, lon) {
    if (!this.isAvailable()) return null
    try {
      const { data } = await axios.get(`${this.baseUrl}/weather`, {
        params: { lat, lon, appid: this.apiKey, units: 'metric' },
        timeout: 10000,
      })
      return data
    } catch (e) {
      logger.warn(`⚠️ [WEATHER] fetchByCoords(${lat},${lon}) failed: ${e.message}`)
      return null
    }
  }

  async fetchByCity(city) {
    if (!this.isAvailable()) return null
    try {
      const { data } = await axios.get(`${this.baseUrl}/weather`, {
        params: { q: city, appid: this.apiKey, units: 'metric' },
        timeout: 10000,
      })
      return data
    } catch (e) {
      logger.warn(`⚠️ [WEATHER] fetchByCity(${city}) failed: ${e.message}`)
      return null
    }
  }

  async fetchForecast(lat, lon) {
    if (!this.isAvailable()) return null
    try {
      const { data } = await axios.get(`${this.baseUrl}/forecast`, {
        params: { lat, lon, appid: this.apiKey, units: 'metric', cnt: 8 },
        timeout: 10000,
      })
      return data
    } catch (e) {
      logger.warn(`⚠️ [WEATHER] fetchForecast(${lat},${lon}) failed: ${e.message}`)
      return null
    }
  }

  extractWeatherInfo(weatherData) {
    if (!weatherData) return null
    return {
      temp: weatherData.main?.temp,
      feels_like: weatherData.main?.feels_like,
      humidity: weatherData.main?.humidity,
      pressure: weatherData.main?.pressure,
      wind_speed: weatherData.wind?.speed,
      wind_deg: weatherData.wind?.deg,
      clouds: weatherData.clouds?.all,
      rain_1h: weatherData.rain?.['1h'] || 0,
      snow_1h: weatherData.snow?.['1h'] || 0,
      condition: weatherData.weather?.[0]?.main,
      description: weatherData.weather?.[0]?.description,
      icon: weatherData.weather?.[0]?.icon,
      city: weatherData.name,
      country: weatherData.sys?.country,
      timestamp: weatherData.dt,
      last_updated: Date.now(),
    }
  }
}

module.exports = new WeatherService()

const openMeteoService = require('../services/openMeteoService')
const axios = require('axios')

describe('openMeteoService', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  describe('extractWeatherInfo', () => {
    it('normalizes open-meteo response into WeatherService-compatible shape', () => {
      const info = openMeteoService.extractWeatherInfo({
        current: {
          time: '2026-08-09T17:15',
          temperature_2m: 31.6,
          relative_humidity_2m: 26,
          weather_code: 0,
          wind_speed_10m: 11.9,
          precipitation: 0.0,
        },
      })

      expect(info).toEqual({
        temp: 31.6,
        feels_like: 31.6,
        humidity: 26,
        pressure: null,
        wind_speed: 11.9,
        wind_deg: null,
        clouds: null,
        rain_1h: 0,
        snow_1h: 0,
        condition: 'Clear sky',
        description: 'Clear sky',
        icon: null,
        city: null,
        country: null,
        timestamp: Date.parse('2026-08-09T17:15') / 1000,
        last_updated: expect.any(Number),
        source: 'open-meteo',
      })
    })

    it('maps rain WMO code to a rain description (feeds goalMod in EnvironmentalIntelligence)', () => {
      const info = openMeteoService.extractWeatherInfo({
        current: { weather_code: 63, temperature_2m: 12, relative_humidity_2m: 80 },
      })
      expect(info.description.toLowerCase()).toContain('rain')
    })

    it('maps snow WMO code to a snow description', () => {
      const info = openMeteoService.extractWeatherInfo({
        current: { weather_code: 73, temperature_2m: -2, relative_humidity_2m: 85 },
      })
      expect(info.description.toLowerCase()).toContain('snow')
    })

    it('returns null when response has no current block', () => {
      expect(openMeteoService.extractWeatherInfo({})).toBeNull()
      expect(openMeteoService.extractWeatherInfo(null)).toBeNull()
    })
  })

  describe('fetchByCity', () => {
    it('resolves city via geocoding then fetches forecast', async () => {
      const geocodeSpy = jest
        .spyOn(axios, 'get')
        .mockResolvedValueOnce({
          data: { results: [{ latitude: 52.52, longitude: 13.41 }] },
        })
        .mockResolvedValueOnce({
          data: {
            current: {
              time: '2026-08-09T17:15',
              temperature_2m: 20,
              relative_humidity_2m: 50,
              weather_code: 1,
              wind_speed_10m: 5,
              precipitation: 0,
            },
          },
        })

      const result = await openMeteoService.fetchByCity('Berlin')

      expect(geocodeSpy).toHaveBeenNthCalledWith(
        1,
        'https://geocoding-api.open-meteo.com/v1/search',
        expect.objectContaining({ params: expect.objectContaining({ name: 'Berlin' }) })
      )
      expect(geocodeSpy).toHaveBeenNthCalledWith(
        2,
        'https://api.open-meteo.com/v1/forecast',
        expect.objectContaining({
          params: expect.objectContaining({ latitude: 52.52, longitude: 13.41 }),
        })
      )
      expect(result.current.temperature_2m).toBe(20)
    })

    it('returns null gracefully when geocoding finds nothing', async () => {
      jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: { results: [] } })
      const result = await openMeteoService.fetchByCity('NowhereVille')
      expect(result).toBeNull()
    })

    it('returns null gracefully when the API fails', async () => {
      jest.spyOn(axios, 'get').mockRejectedValueOnce(new Error('network down'))
      const result = await openMeteoService.fetchByCity('Berlin')
      expect(result).toBeNull()
    })
  })
})

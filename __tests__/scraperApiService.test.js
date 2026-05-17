/**
 * Scraper API Service Unit Tests
 * Tests for services/scraperApiService.js - External API fetch and normalization
 */

const scraperApiService = require('../services/scraperApiService');
const axios = require('axios');

describe('ScraperApiService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchMatches()', () => {
    it('should fetch and normalize matches from API URL', async () => {
      const mockResponse = {
        data: [
          {
            id: 'ext-1',
            home_team: 'Barcelona',
            away_team: 'Real Madrid',
            league_name: 'La Liga',
            score_home: 2,
            score_away: 1,
            minute: '75',
            status: 'live',
            odds_home: 1.85,
            odds_draw: 3.50,
            odds_away: 4.20
          }
        ]
      };

      jest.spyOn(axios, 'get').mockResolvedValue(mockResponse);

      const matches = await scraperApiService.fetchMatches('http://test-api.com/matches');

      expect(axios.get).toHaveBeenCalledWith(
        'http://test-api.com/matches',
        expect.objectContaining({
          timeout: 10000
        })
      );
      expect(Array.isArray(matches)).toBe(true);
      expect(matches.length).toBe(1);
      expect(matches[0]).toHaveProperty('id', 'ext-1');
      expect(matches[0]).toHaveProperty('homeTeam', 'Barcelona');
      expect(matches[0]).toHaveProperty('awayTeam', 'Real Madrid');
      expect(matches[0]).toHaveProperty('league', 'La Liga');
      expect(matches[0]).toHaveProperty('score.home', 2);
      expect(matches[0]).toHaveProperty('odds_home', 1.85);
    });

    it('should return empty array for missing URL', async () => {
      const matches = await scraperApiService.fetchMatches('');
      expect(matches).toEqual([]);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('should return empty array for null URL', async () => {
      const matches = await scraperApiService.fetchMatches(null);
      expect(matches).toEqual([]);
    });

    it('should return empty array if response is not an array', async () => {
      jest.spyOn(axios, 'get').mockResolvedValue({ data: {} });

      const matches = await scraperApiService.fetchMatches('http://test-api.com/matches');
      expect(matches).toEqual([]);
    });

    it('should handle axios errors gracefully', async () => {
      jest.spyOn(axios, 'get').mockRejectedValue(new Error('Network error'));

      const matches = await scraperApiService.fetchMatches('http://test-api.com/matches');
      expect(matches).toEqual([]);
    });
  });

  describe('normalize()', () => {
    it('should map external API fields to internal schema', () => {
      const external = {
        id: 'match-123',
        home_team: 'Liverpool',
        away_team: 'Man United',
        league_name: 'Premier League',
        score_home: 3,
        score_away: 1,
        minute: '65',
        status: 'live',
        stats: {
          pressure: { home: 65, away: 35 },
          dangerousAttacks: { home: 12, away: 8 },
          corners: { home: 5, away: 3 },
          possession: { home: 58, away: 42 }
        },
        odds_home: 1.65,
        odds_draw: 3.80,
        odds_away: 5.50
      };

      const normalized = scraperApiService.normalize(external);

      expect(normalized.id).toBe('match-123');
      expect(normalized.homeTeam).toBe('Liverpool');
      expect(normalized.awayTeam).toBe('Man United');
      expect(normalized.league).toBe('Premier League');
      expect(normalized.score).toEqual({ home: 3, away: 1 });
      expect(normalized.minute).toBe('65');
      expect(normalized.status).toBe('live');
      expect(normalized.stats.pressure.home).toBe(65);
      expect(normalized.odds_home).toBe(1.65);
      expect(normalized.source).toBe('api_external');
    });

    it('should generate fallback ID if none provided', () => {
      const external = {
        home_team: 'Team A',
        away_team: 'Team B'
      };

      const normalized = scraperApiService.normalize(external);
      expect(normalized.id).toMatch(/^api_/);
      expect(normalized.homeTeam).toBe('Team A');
    });

    it('should handle default values for missing fields', () => {
      const external = {};

      const normalized = scraperApiService.normalize(external);

      expect(normalized.id).toMatch(/^api_/);
      expect(normalized.homeTeam).toBe('Unknown');
      expect(normalized.awayTeam).toBe('Unknown');
      expect(normalized.league).toBe('Unknown');
      expect(normalized.score).toEqual({ home: 0, away: 0 });
      expect(normalized.minute).toBe('0');
      expect(normalized.status).toBe('live');
    });

    it('should handle nested stats safely', () => {
      const external = {
        id: 'test',
        home_team: 'A',
        away_team: 'B',
        stats: null
      };

      const normalized = scraperApiService.normalize(external);
      expect(normalized.stats.pressure.home).toBe(0);
      expect(normalized.stats.possession.home).toBe(50);
    });

    it('should handle null odds as null', () => {
      const external = {
        id: 'test',
        home_team: 'A',
        away_team: 'B',
        odds_home: null,
        odds_away: null
      };

      const normalized = scraperApiService.normalize(external);
      expect(normalized.odds_home).toBeNull();
      expect(normalized.odds_draw).toBeNull();
      expect(normalized.odds_away).toBeNull();
    });
  });
});

/**
 * API Routes Unit Tests - Matches
 * Tests for routes/matches.js - Upcoming matches, market edge, refresh endpoints
 */

const request = require('supertest');
const express = require('express');
const matchesRouter = require('../routes/matches');
const database = require('../core/database');
const speedCache = require('../core/speedCache');

describe('Matches API Routes', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/matches', matchesRouter);
  });

  describe('GET /api/matches/upcoming', () => {
    it('should return upcoming matches array', async () => {
      // Mock database response
      const mockMatches = [
        {
          id: 'match-1',
          homeTeam: 'Barcelona',
          awayTeam: 'Real Madrid',
          league: 'La Liga',
          startTimestamp: Date.now() / 1000 + 86400,
          odds_home: 1.95,
          odds_draw: 3.40,
          odds_away: 3.80
        }
      ];

      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue(mockMatches);

      const response = await request(app).get('/api/matches/upcoming');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });

    it('should filter out reserve/youth teams', async () => {
      const mockMatches = [
        { id: '1', homeTeam: 'Barcelona II', awayTeam: 'Real Madrid', league: 'Test' },
        { id: '2', homeTeam: 'Bayern Munich', awayTeam: 'Dortmund II', league: 'Test' },
        { id: '3', homeTeam: 'Liverpool', awayTeam: 'Chelsea', league: 'Test' }
      ];

      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue(mockMatches);

      const response = await request(app).get('/api/matches/upcoming');

      expect(response.status).toBe(200);
      // Reserve teams should be filtered out
      expect(response.body.some(m => m.homeTeam.includes('II') || m.awayTeam.includes('II'))).toBe(false);
      expect(response.body.some(m => m.homeTeam === 'Liverpool')).toBe(true);
    });

    it('should filter out matches with very low odds (< 1.15)', async () => {
      const mockMatches = [
        { id: '1', homeTeam: 'Team A', awayTeam: 'Team B', odds_home: 1.05, odds_away: 10.0 },
        { id: '2', homeTeam: 'Team C', awayTeam: 'Team D', odds_home: 1.85, odds_away: 3.60 }
      ];

      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue(mockMatches);

      const response = await request(app).get('/api/matches/upcoming');

      expect(response.status).toBe(200);
      expect(response.body.length).toBe(1);
      expect(response.body[0].id).toBe('2');
    });

    it('should deduplicate matches by team pair', async () => {
      const mockMatches = [
        { id: 'dup-1', homeTeam: 'Team A', awayTeam: 'Team B', league: 'Test' },
        { id: 'dup-2', homeTeam: 'Team A', awayTeam: 'Team B', league: 'Test' } // Duplicate
      ];

      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue(mockMatches);

      const response = await request(app).get('/api/matches/upcoming');

      expect(response.status).toBe(200);
      expect(response.body.length).toBe(1);
    });

    it('should apply date window filter (30 days past, 60 days future)', async () => {
      const now = Date.now();
      const oldDate = (now - 31 * 24 * 60 * 60 * 1000) / 1000; // 31 days ago
      const futureDate = (now + 61 * 24 * 60 * 60 * 1000) / 1000; // 61 days future
      const validDate = (now + 7 * 24 * 60 * 60 * 1000) / 1000; // 7 days future

      const mockMatches = [
        { id: 'old', startTimestamp: oldDate, homeTeam: 'Old', awayTeam: 'Match', league: 'Test' },
        { id: 'future', startTimestamp: futureDate, homeTeam: 'Far Future', awayTeam: 'Match', league: 'Test' },
        { id: 'valid', startTimestamp: validDate, homeTeam: 'Current', awayTeam: 'Match', league: 'Test' }
      ];

      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue(mockMatches);

      const response = await request(app).get('/api/matches/upcoming');

      expect(response.status).toBe(200);
      expect(response.body.length).toBe(1);
      expect(response.body[0].id).toBe('valid');
    });

    it('should enrich matches without predictions via fastEnrichMatch', async () => {
      const mockMatches = [
        {
          id: 'unenriched',
          homeTeam: 'Team X',
          awayTeam: 'Team Y',
          league: 'Test',
          odds_home: 1.85,
          odds_draw: 3.40,
          odds_away: 4.20
          // Missing home_win_probability
        }
      ];

      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue(mockMatches);
      
      // Mock enrichedPredictions
      const enrichedPredictions = require('../core/enriched_predictions');
      const fastEnrichMock = jest.spyOn(enrichedPredictions, 'fastEnrichMatch')
        .mockResolvedValue({
          ...mockMatches[0],
          home_win_probability: 55.5,
          draw_probability: 24.0,
          away_win_probability: 20.5,
          expected_score: '2 - 1'
        });

      const response = await request(app).get('/api/matches/upcoming');

      expect(response.status).toBe(200);
      expect(fastEnrichMock).toHaveBeenCalled();
      expect(response.body[0].home_win_probability).toBeDefined();
    });
  });

  describe('POST /api/matches/refresh-upcoming', () => {
    it('should invalidate cache and return success', async () => {
      const invalidateSpy = jest.spyOn(speedCache, 'invalidateCache').mockImplementation(() => {});
      
      const response = await request(app).post('/api/matches/refresh-upcoming');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(invalidateSpy).toHaveBeenCalledWith('upcoming');
    });
  });

  describe('GET /api/matches/odds/steam/:matchId', () => {
    it('should return steam odds for a match', async () => {
      const mockSteam = {
        homeOdds: 1.90,
        drawOdds: 3.50,
        awayOdds: 3.90,
        timestamp: Date.now()
      };

      const { getSteamForMatch } = require('../services/oddsMovementService');
      jest.spyOn(require('../services/oddsMovementService'), 'getSteamForMatch')
        .mockReturnValue(mockSteam);

      const response = await request(app).get('/api/matches/odds/steam/test-match-123');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockSteam);
    });
  });

  describe('GET /api/matches/market/edge', () => {
    it('should return value bets with edge opportunities', async () => {
      const mockMatches = [
        {
          id: 'value-1',
          homeTeam: 'Team A',
          awayTeam: 'Team B',
          league: 'Test League',
          home_win_probability: 60,
          draw_probability: 22,
          away_win_probability: 18,
          odds_home: 2.00,
          odds_draw: 3.20,
          odds_away: 3.50
        }
      ];

      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue(mockMatches);

      const ValueBetEngine = require('../src/services/ValueBetEngine');
      jest.spyOn(ValueBetEngine, 'analyzeValue').mockReturnValue({
        hasValue: true,
        best: { edge: 5.5, kelly: 0.02, selection: 'home' }
      });

      const IntegrityService = require('../services/integrity_service');
      jest.spyOn(IntegrityService, 'analyzeMatch').mockResolvedValue({
        score: 85,
        trafficLight: 'GREEN',
        recommendation: 'Clear',
        strategicTags: ['high-value']
      });

      const response = await request(app).get('/api/matches/market/edge');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body[0]).toHaveProperty('analysis');
      expect(response.body[0]).toHaveProperty('integrity');
    });

    it('should return empty array when no value bets found', async () => {
      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue([
        {
          id: 'no-value',
          homeTeam: 'Team A',
          awayTeam: 'Team B',
          league: 'Test',
          home_win_probability: 50,
          odds_home: 2.00 // No value
        }
      ]);

      const ValueBetEngine = require('../src/services/ValueBetEngine');
      jest.spyOn(ValueBetEngine, 'analyzeValue').mockReturnValue({ hasValue: false });

      const response = await request(app).get('/api/matches/market/edge');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });

  describe('POST /api/matches/refresh-lineups/:id', () => {
    it('should refresh lineups for a match', async () => {
      const matchId = 'test-match-lineup';
      const mockMatch = {
        id: matchId,
        id_sofa: '12345',
        homeTeam: 'Team A',
        awayTeam: 'Team B',
        startTimestamp: Date.now()
      };

      jest.spyOn(database, 'getMatchById').mockResolvedValue(mockMatch);

      const newsService = require('../src/services/newsService');
      jest.spyOn(newsService, 'getMatchIntelligence').mockResolvedValue({
        confirmed: true,
        lineups: { home: [1,2,3], away: [4,5,6] }
      });

      const enrichedPredictions = require('../core/enriched_predictions');
      const enrichedMock = { ...mockMatch, enriched: { lineupConfirmed: true } };
      jest.spyOn(enrichedPredictions, 'enrichMatch').mockResolvedValue(enrichedMock);

      const response = await request(app).post(`/api/matches/refresh-lineups/${matchId}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 404 for non-existent match', async () => {
      jest.spyOn(database, 'getMatchById').mockResolvedValue(null);

      const response = await request(app).post('/api/matches/refresh-lineups/nonexistent');
      expect(response.status).toBe(404);
    });
  });
});

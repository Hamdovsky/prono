/**
 * Enriched Predictions Unit Tests
 * Tests for core/enriched_predictions.js - Match enrichment logic
 */

const enrichedPredictions = require('../core/enriched_predictions');

describe('EnrichedPredictions', () => {
  describe('fastEnrichMatch()', () => {
    it('should enrich a match with AI predictions', () => {
      const match = {
        id: 'match-1',
        homeTeam: 'Barcelona',
        awayTeam: 'Real Madrid',
        league: 'La Liga',
        odds_home: 1.95,
        odds_draw: 3.40,
        odds_away: 3.90,
        ou_25_prob: null,
        btts_prob: null
      };

      const enriched = enrichedPredictions.fastEnrichMatch(match);

      expect(enriched).toBeDefined();
      expect(enriched).toHaveProperty('home_win_probability');
      expect(enriched).toHaveProperty('draw_probability');
      expect(enriched).toHaveProperty('away_win_probability');
      expect(enriched).toHaveProperty('expected_score');
      expect(enriched).toHaveProperty('enriched');
    });

    it('should preserve original match data', () => {
      const original = {
        id: 'match-2',
        homeTeam: 'PSG',
        awayTeam: 'Marseille',
        league: 'Ligue 1',
        customField: 'custom-value'
      };

      const enriched = enrichedPredictions.fastEnrichMatch(original);

      // Original properties should exist on enriched object
      expect(enriched.customField).toBe('custom-value');
      // But enriched data should be added
      expect(enriched.home_win_probability).toBeDefined();
    });

    it('should not override existing probabilities if they exist', () => {
      const match = {
        id: 'match-3',
        homeTeam: 'Bayern',
        awayTeam: 'Dortmund',
        home_win_probability: 80.0,
        draw_probability: 12.0,
        away_win_probability: 8.0
      };

      const enriched = enrichedPredictions.fastEnrichMatch(match);

      // Existing probabilities should be preserved
      expect(enriched.home_win_probability).toBe(80.0);
      expect(enriched.draw_probability).toBe(12.0);
      expect(enriched.away_win_probability).toBe(8.0);
    });

    it('should generate expected score', () => {
      const match = {
        id: 'match-4',
        homeTeam: 'Liverpool',
        awayTeam: 'Chelsea'
      };

      const enriched = enrichedPredictions.fastEnrichMatch(match);
      
      expect(enriched.expected_score).toBeDefined();
      expect(typeof enriched.expected_score).toBe('string');
      // Format should be "X - Y"
      expect(enriched.expected_score).toMatch(/\d+\s*-\s*\d+/);
    });
  });

  describe('enrichMatch()', () => {
    it('should produce full enriched object', async () => {
      const match = {
        id: 'match-5',
        homeTeam: 'Arsenal',
        awayTeam: 'Man City',
        league: 'Premier League',
        startTimestamp: Math.floor(Date.now() / 1000) + 86400,
        odds_home: 2.50,
        odds_draw: 3.20,
        odds_away: 2.80
      };

      const enriched = await enrichedPredictions.enrichMatch(match);

      expect(enriched).toHaveProperty('enriched');
      expect(enriched.enriched).toHaveProperty('winner');
      expect(enriched.enriched).toHaveProperty('winnerProbability');
      expect(enriched.enriched).toHaveProperty('predictedGoals');
      expect(enriched.enriched).toHaveProperty('predictedCorners');
      expect(enriched.enriched).toHaveProperty('confidence');
    });

    it('should include tactical analysis', async () => {
      const match = {
        id: 'match-6',
        homeTeam: 'Atletico',
        awayTeam: 'Sevilla',
        league: 'La Liga'
      };

      const enriched = await enrichedPredictions.enrichMatch(match);
      
      expect(enriched.enriched).toHaveProperty('tactical');
      expect(enriched.enriched.tactical).toHaveProperty('homeStyle');
      expect(enriched.enriched.tactical).toHaveProperty('awayStyle');
    });

    it('should handle matches without odds', async () => {
      const match = {
        id: 'match-7',
        homeTeam: 'Team X',
        awayTeam: 'Team Y'
      };

      const enriched = await enrichedPredictions.enrichMatch(match);
      
      expect(enriched).toBeDefined();
      // Should still generate predictions without odds
      expect(enriched.enriched.winner).toBeDefined();
    });

    it('should produce consistent winner selection', async () => {
      const match = {
        id: 'match-8',
        homeTeam: 'Strong Team',
        awayTeam: 'Weak Team',
        home_win_probability: 70,
        away_win_probability: 15
      };

      const enriched = await enrichedPredictions.enrichMatch(match);
      
      // Winner should be home team given high probability
      expect(enriched.enriched.winner).toBe('HOME');
      expect(enriched.enriched.winnerProbability).toBeGreaterThan(0.5);
    });
  });
});

# -*- coding: utf-8 -*-
"""Votes Tunisie (crowdsourcing Promosport) -> features (extrait de ml_features.py).
Autonome : json/os/math uniquement."""
import json
import os
import math

# Tunisia Crowdsourcing Features
_TUNISIAN_VOTES_CACHE = None

def _load_tunisian_votes():
    """Load Tunisian vote history from disk (cached)."""
    global _TUNISIAN_VOTES_CACHE
    if _TUNISIAN_VOTES_CACHE is None:
        try:
            vote_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'tunisian_vote_history.json')
            if os.path.exists(vote_path):
                with open(vote_path, 'r', encoding='utf-8') as f:
                    _TUNISIAN_VOTES_CACHE = json.load(f)
            else:
                _TUNISIAN_VOTES_CACHE = []
        except Exception:
            _TUNISIAN_VOTES_CACHE = []
    return _TUNISIAN_VOTES_CACHE

def _find_tunisian_votes_for_match(home_team, away_team):
    """Find Tunisian crowd votes for a specific match."""
    votes = _load_tunisian_votes()
    for entry in votes:
        if entry.get('home') == home_team and entry.get('away') == away_team:
            return entry
    return None

def _calculate_vote_consent(vote1, voteX, vote2):
    """
    Calculate vote consensus ratio.
    Returns: ratio of dominant vote (0.5 = neutral, 1.0 = full consensus)
    """
    if vote1 is None or voteX is None or vote2 is None:
        return 0.5
    total = vote1 + voteX + vote2
    if total == 0:
        return 0.5
    max_vote = max(vote1, voteX, vote2)
    return max_vote / total

def _calculate_vote_sentiment(vote1, voteX, vote2):
    """
    Calculate vote sentiment (0 = away bias, 0.5 = neutral, 1 = home bias)
    """
    if vote1 is None or voteX is None or vote2 is None:
        return 0.5
    total = vote1 + voteX + vote2
    if total == 0:
        return 0.5
    # Weighted: 1 > X > 2 for sentiment toward home
    return (vote1 + 0.5 * voteX) / total

def _calculate_vote_divergence(vote1, voteX, vote2):
    """
    Calculate vote divergence (entropy-based).
    Returns: 0 = full consensus, 1 = maximum divergence
    """
    if vote1 is None or voteX is None or vote2 is None:
        return 0.5
    total = vote1 + voteX + vote2
    if total == 0:
        return 0.5
    p1, px, p2 = vote1/total, voteX/total, vote2/total
    # Shannon entropy normalized to [0, 1]
    entropy = 0
    for p in [p1, px, p2]:
        if p > 0:
            entropy -= p * math.log2(p)
    max_entropy = math.log2(3)  # Maximum entropy for 3 outcomes
    return entropy / max_entropy if max_entropy > 0 else 0.5

def _calculate_jackpot_pressure(cagnotte):
    """
    Calculate jackpot pressure (inverse of normalized cagnotte).
    Higher cagnotte = lower pressure (people play it safe).
    Returns: 0 to 1 scale (1 = maximum pressure, low jackpot)
    """
    if cagnotte is None:
        return 0.5
    # Normalize: assume 10000 TND is "normal", above is low pressure, below is high pressure
    # Pressure = 1 - min(cagnotte/10000, 1)
    return max(0, 1 - min(cagnotte / 10000, 1))

def _calculate_crowd_conviction(vote1, voteX, vote2):
    """
    Calculate crowd conviction (how confident the crowd is).
    Returns: 0 to 1 scale (higher = more confident consensus)
    """
    consent = _calculate_vote_consent(vote1, voteX, vote2)
    divergence = _calculate_vote_divergence(vote1, voteX, vote2)
    # Conviction = consensus * (1 - divergence)
    return consent * (1 - divergence)

def extract_tunisian_features(home_team, away_team):
    """
    Extract Tunisia-specific crowd features for a match.
    Returns dict with all Tunisia features or zeros if no data.
    """
    entry = _find_tunisian_votes_for_match(home_team, away_team)
    
    if not entry:
        return {
            'h_tn_vote_consent': 0.5, 'a_tn_vote_consent': 0.5, 'tn_vote_consent_diff': 0.0,
            'h_tn_vote_sentiment': 0.5, 'a_tn_vote_sentiment': 0.5, 'tn_vote_sentiment_diff': 0.0,
            'h_tn_vote_divergence': 0.5, 'a_tn_vote_divergence': 0.5, 'tn_vote_divergence_diff': 0.0,
            'h_tn_vote_volatility': 0.0, 'a_tn_vote_volatility': 0.0, 'tn_vote_volatility_diff': 0.0,
            'h_tn_jackpot_pressure': 0.5, 'a_tn_jackpot_pressure': 0.5, 'tn_jackpot_pressure_diff': 0.0,
            'h_tn_crowd_conviction': 0.5, 'a_tn_crowd_conviction': 0.5, 'tn_crowd_conviction_diff': 0.0
        }
    
    # Extract vote data
    public_vote = entry.get('publicVote') or entry.get('vote_data') or {}
    vote1 = public_vote.get('p1') if isinstance(public_vote, dict) else entry.get('vote1')
    voteX = public_vote.get('px') if isinstance(public_vote, dict) else entry.get('voteX')
    vote2 = public_vote.get('p2') if isinstance(public_vote, dict) else entry.get('vote2')
    cagnotte = entry.get('cagnotte')
    
    # Home team features (assuming home team is the focus)
    h_consent = _calculate_vote_consent(vote1, voteX, vote2)
    a_consent = 1 - h_consent  # Away consent is complementary
    h_sentiment = _calculate_vote_sentiment(vote1, voteX, vote2)
    a_sentiment = 1 - h_sentiment
    h_divergence = _calculate_vote_divergence(vote1, voteX, vote2)
    a_divergence = h_divergence  # Divergence is symmetric
    h_volatility = 0.1  # Base volatility (would need historical data for real calculation)
    a_volatility = h_volatility
    h_jackpot = _calculate_jackpot_pressure(cagnotte)
    a_jackpot = h_jackpot  # Same pressure for both teams
    h_conviction = _calculate_crowd_conviction(vote1, voteX, vote2)
    a_conviction = h_conviction
    
    return {
        'h_tn_vote_consent': h_consent,
        'a_tn_vote_consent': a_consent,
        'tn_vote_consent_diff': h_consent - a_consent,
        'h_tn_vote_sentiment': h_sentiment,
        'a_tn_vote_sentiment': a_sentiment,
        'tn_vote_sentiment_diff': h_sentiment - a_sentiment,
        'h_tn_vote_divergence': h_divergence,
        'a_tn_vote_divergence': a_divergence,
        'tn_vote_divergence_diff': h_divergence - a_divergence,
        'h_tn_vote_volatility': h_volatility,
        'a_tn_vote_volatility': a_volatility,
        'tn_vote_volatility_diff': h_volatility - a_volatility,
        'h_tn_jackpot_pressure': h_jackpot,
        'a_tn_jackpot_pressure': a_jackpot,
        'tn_jackpot_pressure_diff': h_jackpot - a_jackpot,
        'h_tn_crowd_conviction': h_conviction,
        'a_tn_crowd_conviction': a_conviction,
        'tn_crowd_conviction_diff': h_conviction - a_conviction
    }

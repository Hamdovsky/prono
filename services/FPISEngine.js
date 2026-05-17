/**
 * FPISEngine.js — Football Prediction Intelligence System (FPIS)
 * ─────────────────────────────────────────────────────────────────────────
 * An 8-step meta-intelligence layer that wraps all existing prediction
 * signals and produces SMART, NON-REPETITIVE, CONTEXT-AWARE decisions.
 *
 * STEP 1: Match Identity Engine          → Classify the match into 1 of 6 types
 * STEP 2: Feature Interpretation         → tempo / risk / motivation / volatility
 * STEP 3: Model Trust Check              → Is XGBoost output valid & aligned?
 * STEP 4: Anti-Repetition Engine         → Enforce variety across the batch
 * STEP 5: Trap Detection                 → Flag odds manipulation / public traps
 * STEP 6: Decision Engine                → Synthesize all signals → final call
 * STEP 7: FPIS Output Builder            → Canonical 7-field structured JSON
 * STEP 8: Self-Learning Logger           → Record patterns for future improvement
 * STEP 9: Neural Oracle V4 (Alpha)       → Monte Carlo via DNA-Aware Weights
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const adaptiveLearning = require('./adaptiveLearningEngine');
const marketCorrelation = require('./MarketCorrelationEngine');
const logger = require('../core/logger');
const lineup = require('./LineupService');
const squadRotation = require('./SquadRotationAnalyst');
const oracle = require('./expertEngine');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const LEARNING_LOG = path.join(__dirname, '..', 'data', 'fpis_learning_log.json');
const MAX_SAME_PREDICTIONS = 2;        // Anti-repetition threshold
const TRAP_CONSENSUS_THRESHOLD = 0.82; // "Too obvious" if top prob > 82% with no sharp money
const SHARP_MIN_SCORE = 20;            // Minimum sharp_score to corroborate a public consensus bet
const VOLATILITY_HIGH = 65;
const VOLATILITY_LOW  = 30;

// Global in-memory cache to detect immediate live score changes (V4 Live Data Integrity)
const liveScoreCache = {};

// ─── IN-MEMORY RING BUFFER (session-level) ───────────────────────────────────
// Holds the last 10 prediction types for anti-repetition enforcement.
const _predHistory = [];
const HISTORY_SIZE = 10;

function _recordPrediction(type) {
    _predHistory.push(type);
    if (_predHistory.length > HISTORY_SIZE) _predHistory.shift();
}

function _countRecent(type, n = 5) {
    const slice = _predHistory.slice(-n);
    return slice.filter(t => t === type).length;
}

// ─── LIVE ENHANCEMENT 1: EARLY-MATCH HEURISTICS (0'–15') ─────────────────────
/**
 * When the match is extremely young (≤15 min), cumulative xG is near-zero
 * and unreliable. This function detects early-deficit situations and returns
 * a heuristic override object instead of raw probabilities.
 *
 * Returns null if no early heuristic applies (normal flow continues).
 * Returns { override: true, adjusted_prediction, adjustment_note, alternative_angles }
 */
function earlyMatchHeuristics(m) {
    const minute  = parseInt(m._minute || 0);
    if (minute > 15) return null;                  // Only active in first 15 min

    const scoreH = parseFloat(m.scoreHome || m._scoreH || 0);
    const scoreA = parseFloat(m.scoreAway || m._scoreA || 0);
    const pHome  = parseFloat(m.home_win_probability || 0);
    const pAway  = parseFloat(m.away_win_probability || 0);
    const motH   = parseFloat(m.home_motivation || 0.5);
    const xgH    = parseFloat(m.home_xg || 0);
    const xgA    = parseFloat(m.away_xg || 0);
    const homeName = m.homeTeam || 'Home';
    const awayName = m.awayTeam || 'Away';

    // Scenario A: Home team conceded early (0-1 deficit in first 15 min)
    if (scoreA > scoreH && scoreA - scoreH === 1) {
        const motivationBoost = motH > 0.6;
        const prediction = motivationBoost
            ? `${homeName} +1 Asian Handicap`
            : `Next Goal: ${homeName}`;
        const note = `Early Deficit Recovery [min=${minute}]: ${homeName} is 0-1 down. ` +
            (motivationBoost ? 'High motivation → AH +1 pivot.' : 'Reaction expected → Next Goal pivot.');
        return {
            override: true,
            adjusted_prediction: prediction,
            adjustment_note:     note,
            alternative_angles: [
                { tier: 'Aggressive', angle: `Next Goal: ${homeName}`,       rationale: 'Comeback pressure — first reactor advantage' },
                { tier: 'Moderate',   angle: `${homeName} +1 Asian Handicap`, rationale: 'Absorbs early deficit — safer recovery play' },
                { tier: 'Conservative', angle: 'Over 1.5 Goals',              rationale: 'Both teams incentivised to score early' }
            ]
        };
    }

    // Scenario B: Away team conceded early (1-0, first 15 min)
    if (scoreH > scoreA && scoreH - scoreA === 1) {
        return {
            override: true,
            adjusted_prediction: `${awayName} +1 Asian Handicap`,
            adjustment_note:     `Early Deficit Recovery [min=${minute}]: ${awayName} is 1-0 down. AH +1 pivot applied.`,
            alternative_angles: [
                { tier: 'Aggressive',   angle: `Next Goal: ${awayName}`,        rationale: 'Away pressure after early concession' },
                { tier: 'Moderate',     angle: `${awayName} +1 Asian Handicap`, rationale: 'Safe buffer for away recovery' },
                { tier: 'Conservative', angle: 'Draw No Bet',                   rationale: 'Level scoreline still very probable at min ' + minute }
            ]
        };
    }

    // Scenario C: 0-0 first 15 min — still goalless but live xG building
    if (scoreH === 0 && scoreA === 0 && minute >= 5) {
        const dom = xgH > xgA + 0.1 ? homeName : xgA > xgH + 0.1 ? awayName : null;
        const prediction = dom ? `${dom} to Open Scoring` : 'Either Team to Score Next';
        return {
            override: true,
            adjusted_prediction: prediction,
            adjustment_note: `Early Phase [min=${minute}]: no goals yet, xG ratio H${xgH.toFixed(2)}/A${xgA.toFixed(2)}`,
            alternative_angles: [
                { tier: 'Aggressive',   angle: 'Over 0.5 Goals (1st Half)',     rationale: `Both teams active — xG total ${(xgH+xgA).toFixed(2)}` },
                { tier: 'Moderate',     angle: dom ? `${dom} Win` : 'Draw No Bet', rationale: 'Early-stage momentum signal' },
                { tier: 'Conservative', angle: 'Under 3.5 Goals',               rationale: 'Match still opening up' }
            ]
        };
    }

    return null; // No early heuristic triggered
}

// ─── LIVE ENHANCEMENT 2: BAYESIAN ANTI-FLAT-LINE REDISTRIBUTION ───────────────
/**
 * Replaces the 33/33/33 default distribution when odds drift is detectable.
 * Uses a lightweight Bayesian update: if Away odds are dropping faster than
 * expected (Price Action), shift pAway to ≥45% regardless of low sample size.
 *
 * Returns { pHome, pDraw, pAway } (normalised to 100)
 */
function bayesianRedistribution(pHome, pDraw, pAway, driftH, driftA, minute, livePressure = 0) {
    // Only apply if probs look flat (within 5% of each other — the deadlock scenario)
    const maxP = Math.max(pHome, pDraw, pAway);
    const minP = Math.min(pHome, pDraw, pAway);
    const isFlat = (maxP - minP) < 8;  // Flat if spread < 8%

    // Also force update when drift is strong regardless of flatness
    const strongDrift = Math.abs(driftH) > 0.15 || Math.abs(driftA) > 0.15;

    if (!isFlat && !strongDrift && livePressure < 70) return { pHome, pDraw, pAway }; // Normal flow

    let h = pHome || 33.3;
    let d = pDraw  || 33.3;
    let a = pAway  || 33.4;

    // --- V21 PRESSURE TILT (Deadlock Breaker) ---
    // If market is silent (no drift) but one team is dominating (Pressure > 70)
    if (isFlat && !strongDrift && livePressure > 70) {
        const tiltBoost = (livePressure - 70) * 0.5; // Up to 15% boost
        if (pHome >= pAway) {
            h += tiltBoost; a -= tiltBoost * 0.7; d -= tiltBoost * 0.3;
        } else {
            a += tiltBoost; h -= tiltBoost * 0.7; d -= tiltBoost * 0.3;
        }
    }

    // Price Action: driftX > 0 means odds shortening (weight increasing)
    const driftScale = 80;
    if (driftH > 0.05) {
        const boost = Math.min(20, driftH * driftScale);
        h += boost;
        d -= boost * 0.4;
        a -= boost * 0.6;
    } else if (driftH < -0.05) { // home odds lengthening — shift away
        const shift = Math.min(18, Math.abs(driftH) * driftScale);
        h -= shift;
        a += shift * 0.7;
        d += shift * 0.3;
    }

    if (driftA > 0.05) {
        const boost = Math.min(20, driftA * driftScale);
        a += boost;
        d -= boost * 0.4;
        h -= boost * 0.6;
    } else if (driftA < -0.05) {
        const shift = Math.min(18, Math.abs(driftA) * driftScale);
        a -= shift;
        h += shift * 0.7;
        d += shift * 0.3;
    }

    // Time-decay: later in match, draw probability shrinks if score is level
    if (minute > 70) d *= 0.85;
    if (minute > 85) d *= 0.75;

    // Clamp to [5, 85] and normalise
    h = Math.max(5, Math.min(85, h));
    d = Math.max(5, Math.min(55, d));
    a = Math.max(5, Math.min(85, a));
    const sum = h + d + a;
    return {
        pHome: Math.round((h / sum) * 100 * 10) / 10,
        pDraw: Math.round((d / sum) * 100 * 10) / 10,
        pAway: Math.round((a / sum) * 100 * 10) / 10
    };
}

// ─── LIVE ENHANCEMENT 2B: SCORE-BASED PROBABILITY SHIFT & TREND ALIGNMENT ─────
/**
 * Modifies probabilities based on the actual score to break 33% deadlocks.
 * Applies P_new = P_base + (Goals * 25) - ((Time/90) * 10).
 * Also handles Trend Alignment: For heavy deficits (e.g. 0-2), avoids
 * blindly predicting the losing team just because pre-match stats liked them.
 * 
 * Returns { pHome, pDraw, pAway, forceAlternative }
 */
function liveMatchScoreLogic(m) {
    let h = parseFloat(m.home_win_probability || 33.3);
    let d = parseFloat(m.draw_probability     || 33.3);
    let a = parseFloat(m.away_win_probability || 33.4);
    
    const scoreH = parseFloat(m.scoreHome || 0);
    const scoreA = parseFloat(m.scoreAway || 0);
    const minute = parseInt(m._minute || 0);
    
    let forceAlternative = null;
    let forceMatchType = null;

    if (scoreH !== scoreA) {
        // Find who is leading and the goal gap
        const leadIsHome = scoreH > scoreA;
        const goalDiff = Math.abs(scoreH - scoreA);
        
        // P_new = P_base + (Goals * 0.25) - (Time/90 * 0.10) (in percentages, *100)
        // Note: Equation shifted to percentage points for matching h,d,a bounds
        const goalBoost = goalDiff * 25;
        const timePenalty = (minute / 90) * 10;
        const totalBoost = Math.max(0, goalBoost - timePenalty);

        if (leadIsHome) {
            h += totalBoost;
            // Trend Alignment: Model strongly favours away but away is 0-2 down
            if (goalDiff >= 2) {
                h = Math.max(h, a + 10); // Force home to be favourite
                const htName = m.homeTeam || 'Home';
                forceAlternative = `${htName} Win / Over 2.5 Goals`;
                forceMatchType = 'One-sided Domination';
            }
            d -= totalBoost * 0.5;
            a -= totalBoost * 0.5;
            if (h < 68) h = 68; // Mandatory: Minimum 68% for the winning team
        } else {
            a += totalBoost;
            // Trend Alignment
            if (goalDiff >= 2) {
                a = Math.max(a, h + 10); // Force away to be favourite
                const atName = m.awayTeam || 'Away';
                forceAlternative = `${atName} Win / Over 2.5 Goals`;
                forceMatchType = 'One-sided Domination';
            }
            d -= totalBoost * 0.5;
            h -= totalBoost * 0.5;
            if (a < 68) a = 68; // Mandatory: Minimum 68% for the winning team
        }
    }

    // Normalise
    h = Math.max(5, Math.min(95, h));
    d = Math.max(5, Math.min(85, d));
    a = Math.max(5, Math.min(95, a));
    const sum = h + d + a;
    let pHome = (h / sum) * 100;
    let pDraw = (d / sum) * 100;
    let pAway = (a / sum) * 100;

    if (scoreH !== scoreA) {
        if (scoreH > scoreA && pHome < 68) {
            const diff = 68 - pHome;
            pHome = 68;
            pDraw = Math.max(5, pDraw - diff/2);
            pAway = Math.max(5, pAway - diff/2);
        } else if (scoreA > scoreH && pAway < 68) {
            const diff = 68 - pAway;
            pAway = 68;
            pDraw = Math.max(5, pDraw - diff/2);
            pHome = Math.max(5, pHome - diff/2);
        }
    }

    return {
        pHome: Math.round(pHome * 10) / 10,
        pDraw: Math.round(pDraw * 10) / 10,
        pAway: Math.round(pAway * 10) / 10,
        forceAlternative,
        forceMatchType
    };
}

// ─── LIVE ENHANCEMENT 3: MULTI-ANGLE OUTPUT BUILDER ──────────────────────────
/**
 * Generates exactly 3 strategic tiers for every live match.
 * Aggressive / Moderate / Conservative — never empty, never null.
 */
function buildMultiAngleOutput(m, identity, scores, trap, decision) {
    const xgH     = parseFloat(m.home_xg || 0);
    const xgA     = parseFloat(m.away_xg || 0);
    const xgSum   = xgH + xgA;
    const pHome   = parseFloat(m.home_win_probability || 33);
    const pAway   = parseFloat(m.away_win_probability || 33);
    const minute  = parseInt(m._minute || 45);
    const homeName = m.homeTeam || 'Home';
    const awayName = m.awayTeam || 'Away';
    const domSide  = pHome >= pAway ? homeName : awayName;
    const domP     = Math.max(pHome, pAway);

    // ── AGGRESSIVE: high-yield, highest risk ──────────────────────────────────
    let aggressive;
    const scoreH = parseFloat(m.scoreHome || 0);
    const scoreA = parseFloat(m.scoreAway || 0);
    // LAYER 6 EXPANSION: Pressure Layer for 0-0 matches
    if (scoreH === 0 && scoreA === 0 && scores.tempo_score > 70) {
        // High pressure >= 1.2 DA/min maps to tempo_score roughly > 70
        aggressive = { angle: 'Over 0.5 Goals', rationale: 'High Pressure (0-0) — Goal expected' };
    } else if (xgSum >= 2.5 || scores.tempo_score > 65) {
        aggressive = { angle: 'Over 2.5 Goals', rationale: `High xG total (${xgSum.toFixed(2)}) — both teams creating` };
    } else if (xgH > 0.8 && xgA > 0.6) {
        aggressive = { angle: 'BTTS Yes', rationale: `Both teams active xG: H${xgH.toFixed(2)}/A${xgA.toFixed(2)}` };
    } else if (minute < 30) {
        aggressive = { angle: 'Over 1.5 Goals', rationale: 'Early phase — goals still expected' };
    } else {
        aggressive = { angle: `${domSide} to Score Next`, rationale: `Live xG dominance (${domP.toFixed(0)}% win prob)` };
    }

    // ── MODERATE: balanced risk/reward ───────────────────────────────────────
    let moderate;
    if (trap.flagged) {
        moderate = { angle: trap.safe_angle || 'Draw No Bet', rationale: `Trap detected — ${trap.reason.slice(0, 60)}` };
    } else if (domP >= 55) {
        const handicap = domP >= 65 ? '-1' : '+0 (Draw No Bet)';
        moderate = { angle: `${domSide} ${handicap} Asian Handicap`, rationale: `${domP.toFixed(0)}% win probability — buffer bet` };
    } else {
        moderate = { angle: 'Double Chance (1X or X2)', rationale: 'Tight match — protected outcome' };
    }

    // ── CONSERVATIVE: safety net ──────────────────────────────────────────────
    let conservative;
    if (xgSum < 2.0 && minute > 30) {
        conservative = { angle: 'Under 2.5 Goals', rationale: `Low xG (${xgSum.toFixed(2)}) — match pacing under budget` };
    } else {
        conservative = { angle: 'Under 4.5 Goals', rationale: 'Wide safety net — high-probability outcome' };
    }

    return [
        { tier: 'Aggressive',   ...aggressive },
        { tier: 'Moderate',     ...moderate   },
        { tier: 'Conservative', ...conservative }
    ];
}

// ─── LIVE ENHANCEMENT 4: LIVE VALUE / TRAP DETECTOR ──────────────────────────
/**
 * Compares Live Odds vs Model Fair Value to detect:
 * - "Value Opportunity": home is under-valued by the market (odds > fair value)
 * - "Live Trap": home is over-valued / over-consensus
 *
 * Returns { signal: 'VALUE_OPPORTUNITY'|'LIVE_TRAP'|'NEUTRAL', detail: string, edge: number }
 */
function detectLiveValueOrTrap(m) {
    const pHome   = parseFloat(m.home_win_probability || 0);
    const pAway   = parseFloat(m.away_win_probability || 0);
    const pDraw   = parseFloat(m.draw_probability     || 0);
    const oddsH   = parseFloat(m.odds_drop_home !== undefined ? null : m.home_xg); // will be over-ridden
    // We have the drift values from _mapLiveData (positive = shortening = sharpening)
    const driftH  = parseFloat(m.odds_drop_home || 0); // positive means odds dropped (good for home)
    const driftA  = parseFloat(m.odds_drop_away || 0);

    // Reconstruct approximate current odds from drift
    // In _mapLiveData: driftH = openingOdds - currentOdds (positive = shortening)
    // Fair value from model = 1 / (pHome/100)
    const fairValueH = pHome > 1 ? (100 / pHome) : 0;
    const fairValueA = pAway > 1 ? (100 / pAway) : 0;

    // We can only compute edge if we have the raw current odds
    const rawOddsH = parseFloat(m._raw_odds_home || 0);
    const rawOddsA = parseFloat(m._raw_odds_away || 0);

    let signal = 'NEUTRAL';
    let detail = 'No significant value edge detected';
    let edge   = 0;

    if (rawOddsH > 0 && fairValueH > 0) {
        edge = rawOddsH - fairValueH;
        if (edge > 0.3) {
            signal = 'VALUE_OPPORTUNITY';
            detail = `Home odds ${rawOddsH.toFixed(2)} > Fair Value ${fairValueH.toFixed(2)} — market under-pricing ${m.homeTeam || 'Home'}`;
        } else if (edge < -0.4) {
            signal = 'LIVE_TRAP';
            detail = `Home odds ${rawOddsH.toFixed(2)} < Fair Value ${fairValueH.toFixed(2)} — over-consensus on ${m.homeTeam || 'Home'}`;
        }
    } else {
        // Fallback: use drift direction as proxy for value
        if (driftH > 0.1 && pHome < 50) {
            signal = 'VALUE_OPPORTUNITY';
            detail = `Odds shortening for under-priced ${m.homeTeam || 'Home'} (market catching up)`;
            edge = driftH;
        } else if (driftH < -0.1 && pHome > 60) {
            signal = 'LIVE_TRAP';
            detail = `Odds lengthening for model-favoured ${m.homeTeam || 'Home'} — sharp money opposing`;
            edge = driftH;
        } else if (driftA > 0.15) {
            signal = 'VALUE_OPPORTUNITY';
            detail = `Away odds shortening fast — market repricing ${m.awayTeam || 'Away'}`;
            edge = driftA;
        }
    }

    return { signal, detail, edge: Math.round(edge * 100) / 100 };
}

// ─── LIVE ENHANCEMENT 5: MARKET LIQUIDITY TRUST (Step 3 Fallback) ────────────
/**
 * When sharp_score is null (common in live), derives a trust proxy from:
 * - Magnitude of odds drift (high drift = market confident = trust higher)
 * - Consistency of drift direction vs model direction
 *
 * Returns the same shape as checkModelTrust().
 */
function marketLiquidityTrust(m) {
    const pHome  = parseFloat(m.home_win_probability || 33);
    const pAway  = parseFloat(m.away_win_probability || 33);
    const pDraw  = parseFloat(m.draw_probability     || 33);
    const driftH = parseFloat(m.odds_drop_home || 0);
    const driftA = parseFloat(m.odds_drop_away || 0);

    const modelFavoursHome = pHome >= pAway && pHome >= pDraw;
    const modelFavoursAway = pAway > pHome && pAway >= pDraw;

    // Drift magnitude = market confidence (liquidity proxy)
    const driftMag = Math.max(Math.abs(driftH), Math.abs(driftA));
    // High drift = high liquidity = market has a clear view
    const highLiquidity = driftMag > 0.12;

    // Check alignment: model direction vs market direction
    const marketFavoursHome = driftH > 0.03;   // odds shortening for home
    const marketFavoursAway = driftA > 0.03;

    const aligned = (modelFavoursHome && marketFavoursHome) ||
                    (modelFavoursAway && marketFavoursAway) ||
                    (!marketFavoursHome && !marketFavoursAway); // neither moving = neutral

    const is_misaligned = !aligned && highLiquidity;
    const liquidity_level = m.liquidity_index > 0.7 ? 'Elite' : (driftMag > 0.2 ? 'High' : (driftMag > 0.08 ? 'Medium' : 'Low'));

    const reason = is_misaligned
        ? `⚠️ [V25-LIQUIDITY] Market reprice (${liquidity_level}) contradicts model direction`
        : `✅ [V25-LIQUIDITY] Market volume (${liquidity_level}) validates model approach`;

    return {
        trust:        !is_misaligned,
        reason,
        is_obvious:   false,
        is_misaligned,
        liquidity_level
    };
}

// ─── LIVE DATA MAPPER ────────────────────────────────────────────────────────
/**
 * Normalises a raw live match object from liveLabService into the shape
 * expected by all FPIS steps, replacing missing pre-match fields with
 * live equivalents.
 *
 * Live xG  = derived from shots-on-target + dangerous attacks + corners
 * Pressure = dangerous-attack rate per minute (Live Pressure Index)
 * Chaos    = red cards * 20 + score gap risk
 */
function _mapLiveData(raw) {
    // Accept either the liveLabService output shape or the raw DB row
    const stats = raw.stats || {};
    const sotH  = parseFloat(stats.shotsOnTarget?.home   || raw.shots_on_target_home   || 0);
    const sotA  = parseFloat(stats.shotsOnTarget?.away   || raw.shots_on_target_away   || 0);
    const daH   = parseFloat(stats.dangerousAttacks?.home|| raw.dangerous_attacks_home  || 0);
    const daA   = parseFloat(stats.dangerousAttacks?.away|| raw.dangerous_attacks_away  || 0);
    const corH  = parseFloat(stats.corners?.home         || raw.corners_home            || 0);
    const corA  = parseFloat(stats.corners?.away         || raw.corners_away            || 0);
    const posH  = parseFloat(stats.possession?.home      || raw.possession_home         || 50);
    const minute= parseInt(String(raw.minute || '0').replace(/\D/g, '')) || 1;

    // Live synthetic xG (same formula as liveLabService)
    const liveXgH = (sotH * 0.3) + (daH * 0.05) + (corH * 0.08);
    const liveXgA = (sotA * 0.3) + (daA * 0.05) + (corA * 0.08);

    // Live Pressure Index — dangerous attacks per minute (0-100 scale, capped)
    const pressureH = Math.min(100, Math.round((daH / minute) * 60));
    const pressureA = Math.min(100, Math.round((daA / minute) * 60));
    const livePressure = Math.max(pressureH, pressureA);

    // Chaos from red cards
    const redH  = parseFloat(raw.homeRedCards || raw.redCardsH || 0);
    const redA  = parseFloat(raw.awayRedCards || raw.redCardsA || 0);
    const liveChaos = (redH + redA) * 20;

    // Live odds drift: current minus opening (positive = dropping = sharp)
    const oddsH      = parseFloat(raw.odds_home || raw.market_odds || 0);
    const oddsHOpen  = parseFloat(raw.odds_home_open || oddsH);
    const oddsA      = parseFloat(raw.odds_away || 0);
    const oddsAOpen  = parseFloat(raw.odds_away_open || oddsA);
    const liveDriftH = oddsH && oddsHOpen ? oddsHOpen - oddsH : 0; // positive = shortening
    const liveDriftA = oddsA && oddsAOpen ? oddsAOpen - oddsA : 0;

    // Probabilities — prefer live-adjusted if provided
    const pHome = parseFloat(raw.homeWinP  || raw.home_win_probability || 0);
    const pDraw = parseFloat(raw.drawP     || raw.draw_probability     || 0);
    const pAway = parseFloat(raw.awayWinP  || raw.away_win_probability || 0);

    return {
        // Pass-through identity fields
        id:       raw.id,
        homeTeam: raw.homeTeam,
        awayTeam: raw.awayTeam,
        league:   raw.league,
        scoreHome: parseFloat(raw.scoreHome || raw.score_home || raw._scoreH || 0),
        scoreAway: parseFloat(raw.scoreAway || raw.score_away || raw._scoreA || 0),
        // Mapped live xG (replaces historical xG)
        home_xg:  liveXgH,
        away_xg:  liveXgA,
        // Mapped probabilities
        home_win_probability: pHome,
        draw_probability:     pDraw,
        away_win_probability: pAway,
        // Live chaos replaces pre-match chaos_level
        chaos_level:    liveChaos,
        live_pressure:  livePressure,
        // Odds drift (replaces odds_drop_*)
        odds_drop_home: liveDriftH,
        odds_drop_away: liveDriftA,
        // No pre-match sharp_score in live mode — set sentinel
        sharp_score:    null,           // Triggers live-only trap fallback
        _is_live:       true,
        _minute:        minute,
        _possession_home: posH
    };
}

// ─── STEP 1: MATCH IDENTITY ENGINE ───────────────────────────────────────────
/**
 * Classify the match into one of 6 identity types.
 * Returns { type, justification }
 */
function classifyMatchIdentity(m, forceType=null) {
    if (forceType) {
        return { type: forceType, justification: 'Trend Alignment forced match typography due to major score deficit' };
    }

    const xgH   = parseFloat(m.home_xg || m.xg_home || 0) || 0;
    const xgA   = parseFloat(m.away_xg || m.xg_away || 0) || 0;
    const xgSum = xgH + xgA;
    const xgDiff = Math.abs(xgH - xgA);

    const pHome = parseFloat(m.home_win_probability || 0);
    const pAway = parseFloat(m.away_win_probability || 0);
    const pDraw = parseFloat(m.draw_probability     || 0);
    const pSpread = Math.max(pHome, pAway) - Math.min(pHome, pAway);

    const chaos       = parseFloat(m.chaos_level || m.ref_chaos_boost || 0);
    const sharpScore  = parseFloat(m.sharp_score || 0);
    const oddsDropH   = parseFloat(m.odds_drop_home || 0);
    const oddsDropA   = parseFloat(m.odds_drop_away || 0);
    const newsScore   = (m.news_data?.impact?.home || 0) + (m.news_data?.impact?.away || 0);

    // — Trap Match: odds contradiction OR suspiciously obvious public consensus
    // In live mode, sharpScore is often null. We shouldn't flag as trap if the market is actively supporting the model (drift > 0.1)
    const isTrapSuspect =
        (pHome > 75 && oddsDropH < 0) ||          // Favourite odds rising
        (pAway > 75 && oddsDropA < 0) ||
        (sharpScore < SHARP_MIN_SCORE && Math.max(pHome, pAway) > TRAP_CONSENSUS_THRESHOLD * 100 && Math.max(oddsDropH, oddsDropA) < 0.1);

    if (isTrapSuspect) {
        return { type: 'Trap Match', justification: `Odds contradiction or over-consensus (H:${pHome}%/A:${pAway}%, sharp_score=${sharpScore})` };
    }

    // — High Volatility: big news impact + high chaos + late fitness tests
    if (chaos > 15 || Math.abs(newsScore) > 20 || _scoreFromCritical(m) >= 3) {
        return { type: 'High Volatility Match', justification: `News chaos=${chaos}, news_score=${newsScore}, critical=${_scoreFromCritical(m)}` };
    }

    // — One-sided Domination: extreme xG advantage AND probability spread
    if (xgDiff >= 0.9 && pSpread >= 30) {
        const dom = xgH > xgA ? (m.homeTeam || 'Home') : (m.awayTeam || 'Away');
        return { type: 'One-sided Domination', justification: `${dom} dominates xG (Δ${xgDiff.toFixed(2)}) with ${pSpread.toFixed(0)}% probability spread` };
    }

    // — High Tempo Attacking: high xG sum with BTTS likely
    if (xgSum >= 2.8 && xgH >= 1.1 && xgA >= 1.0) {
        return { type: 'High Tempo Attacking Match', justification: `xG sum=${xgSum.toFixed(2)}, both teams threatening` };
    }

    // — Low Tempo Defensive: very low xG sum
    if (xgSum <= 1.6) {
        return { type: 'Low Tempo Defensive Match', justification: `xG sum=${xgSum.toFixed(2)}, defensive structure expected` };
    }

    // — Balanced Tactical (default)
    return { type: 'Balanced Tactical Match', justification: `No dominant signal — xG=${xgSum.toFixed(2)}, spread=${pSpread.toFixed(0)}%` };
}

function _scoreFromCritical(m) {
    const c = m.news_data?.impact?.critical;
    return Array.isArray(c) ? c.length : 0;
}

// ─── STEP 2: FEATURE INTERPRETATION ──────────────────────────────────────────
/**
 * Build 4 composite intelligence scores from raw data.
 */
function buildIntelligenceScores(m) {
    const xgH  = parseFloat(m.home_xg || 0);
    const xgA  = parseFloat(m.away_xg || 0);

    // Tempo Score: driven by xG, big chances, shots on target
    const bcH  = parseFloat(m.big_chances_home || 0);
    const bcA  = parseFloat(m.big_chances_away || 0);
    const posH = parseFloat(m.possession_home  || m.teamStats?.home?.avgPossession || 50);
    const tempoScore = Math.min(100, Math.round(
        (xgH + xgA) * 20 + (bcH + bcA) * 5 + Math.abs(posH - 50) * 0.5
    ));

    // Risk Score: news chaos + injuries + gap learning
    const chaos      = parseFloat(m.chaos_level || m.ref_chaos_boost || 0);
    const hAttImpact = parseFloat(m.home_attack_impact || 1.0);
    const aAttImpact = parseFloat(m.away_attack_impact || 1.0);
    const injuryRisk = Math.round(Math.abs(1.0 - hAttImpact) * 100 + Math.abs(1.0 - aAttImpact) * 100);
    const riskScore  = Math.min(100, Math.round(chaos * 2 + injuryRisk + _scoreFromCritical(m) * 5));

    // Motivation Score: from features stored on the match
    const motH = parseFloat(m.home_motivation || 0.5);
    const motA = parseFloat(m.away_motivation || 0.5);
    const motivationScore = Math.round(((motH + motA) / 2) * 100);

    // Volatility Index: odds movement speed + chaos + critical news
    const oddsSpeedH  = Math.abs(parseFloat(m.odds_speed?.home || m.odds_drop_home || 0));
    const oddsSpeedA  = Math.abs(parseFloat(m.odds_speed?.away || m.odds_drop_away || 0));
    const volatilityIndex = Math.min(100, Math.round(
        oddsSpeedH * 3 + oddsSpeedA * 3 + chaos * 2 + _scoreFromCritical(m) * 6
    ));

    return { tempo_score: tempoScore, risk_score: riskScore, motivation_score: motivationScore, volatility_index: volatilityIndex };
}

// ─── STEP 3: MODEL TRUST CHECK ────────────────────────────────────────────────
/**
 * Returns { trust: true|false, reason, is_obvious, is_misaligned }
 * Live mode (_is_live=true): sharp_score is absent, so only odds-drift
 * misalignment is checked — "too obvious" rule is relaxed.
 */
function checkModelTrust(m, identityType) {
    const pHome = parseFloat(m.home_win_probability || 0);
    const pAway = parseFloat(m.away_win_probability || 0);
    const pDraw = parseFloat(m.draw_probability     || 0);
    const topProb = Math.max(pHome, pAway, pDraw);

    const oddsDropH  = parseFloat(m.odds_drop_home || 0);
    const oddsDropA  = parseFloat(m.odds_drop_away || 0);

    // LIVE MODE: skip sharp_score check — use only odds drift
    if (m._is_live) {
        const modelFavoursHome = pHome > pAway && pHome > pDraw;
        const is_misaligned = (modelFavoursHome && oddsDropH < -0.1) ||
                              (!modelFavoursHome && oddsDropH > 0.1);
        const reason = is_misaligned
            ? '⚠️ [LIVE] Live odds drifting against model direction'
            : '✅ [LIVE] Odds drift consistent with live model output';
        return { trust: !is_misaligned, reason, is_obvious: false, is_misaligned };
    }

    const sharpScore = parseFloat(m.sharp_score || 0);
    const is_obvious    = topProb >= 70;
    const hasSharpMoney = sharpScore >= SHARP_MIN_SCORE || oddsDropH > 5 || oddsDropA > 5;

    const modelFavoursHome = pHome > pAway && pHome > pDraw;
    const oddsMovingAgainstHome = oddsDropH < 0 && Math.abs(oddsDropH) > 3;
    const is_misaligned = (modelFavoursHome && oddsMovingAgainstHome) ||
                          (!modelFavoursHome && oddsDropH > 5);

    const trust = !(is_obvious && !hasSharpMoney) && !is_misaligned;
    const reasons = [];
    if (is_obvious && !hasSharpMoney) reasons.push(`⚠️ Prediction is too obvious (${topProb.toFixed(1)}%) with no sharp money corroboration`);
    if (is_misaligned)                reasons.push(`⚠️ Model vs odds misalignment detected`);
    if (!reasons.length)              reasons.push('✅ Model output aligns with market and identity signals');

    return { trust, reason: reasons.join(' | '), is_obvious, is_misaligned };
}

// ─── STEP 4: ANTI-REPETITION ENGINE ──────────────────────────────────────────
/**
 * Returns { forced_alternative: bool, alternative_type: string }
 * isLive=true → bypass ring buffer entirely (live predictions change fast
 * and a repeated 'Home Win' at min 20 vs min 75 are contextually different).
 */
function antiRepetitionCheck(mainPredictionType, isLive = false) {
    if (isLive) return { forced_alternative: false, alternative_type: null };
    const count = _countRecent(mainPredictionType, 5);
    if (count >= MAX_SAME_PREDICTIONS) {
        // Choose an alternative angle different from the current repeated type
        const alternatives = ['BTTS Yes', 'Over 2.5', 'Under 2.5', 'Double Chance', 'Asian Handicap', 'Corners Over 9.5'];
        const alt = alternatives.find(a => a !== mainPredictionType) || 'Double Chance';
        return { forced_alternative: true, alternative_type: alt };
    }
    return { forced_alternative: false, alternative_type: null };
}

// ─── STEP 5: TRAP DETECTION ───────────────────────────────────────────────────
/**
 * Returns { flagged: bool, reason: string, safe_angle: string }
 * Live mode: sharp_score is unavailable — trap detection uses ONLY
 * live odds drift direction (Step 5 Live Fallback).
 */
function detectTrap(m, scores, trust) {
    const pHome      = parseFloat(m.home_win_probability || 0);
    const pAway      = parseFloat(m.away_win_probability || 0);
    const topProb    = Math.max(pHome, pAway);
    const oddsDropH  = parseFloat(m.odds_drop_home || 0);
    const oddsDropA  = parseFloat(m.odds_drop_away || 0);
    const { volatility_index, risk_score } = scores;
    const reasons    = [];

    // ── LIVE MODE: odds-drift-only trap fallback ──────────────────────────────
    if (m._is_live) {
        // If live odds are lengthening (rising) for the model-favoured side → trap
        if (pHome > 60 && oddsDropH < -0.05) {
            reasons.push('[LIVE] Live odds drifting out for home favourite — sharp opposition suspected');
        }
        if (pAway > 60 && oddsDropA < -0.05) {
            reasons.push('[LIVE] Live odds drifting out for away favourite — sharp opposition suspected');
        }
        // If model not trusted (live misalignment)
        if (!trust.trust) reasons.push(trust.reason);

        const flagged = reasons.length > 0;
        const xgH = parseFloat(m.home_xg || 0);
        const xgA = parseFloat(m.away_xg || 0);
        const safe_angle = flagged
            ? (xgH + xgA > 1.5 ? 'Over 1.5 Goals [LIVE]' : 'Draw No Bet [LIVE]')
            : null;
        return { flagged, reason: reasons.join(' | ') || 'No live trap signals', safe_angle };
    }

    // ── PRE-MATCH MODE ────────────────────────────────────────────────────────
    const sharpScore = parseFloat(m.sharp_score || 0);

    // Rule 1: Odds drop contradicts stats
    if (pHome > 60 && oddsDropH < -3) {
        reasons.push('Odds rising for home favourite — suggests sharp money opposing public');
    }
    if (pAway > 60 && oddsDropA < -3) {
        reasons.push('Odds rising for away favourite — sharp money moving against model');
    }
    // Rule 2: Public consensus too obvious with no sharp corroboration
    if (topProb > TRAP_CONSENSUS_THRESHOLD * 100 && sharpScore < SHARP_MIN_SCORE) {
        reasons.push(`Over-consensus (${topProb.toFixed(1)}%) without sharp money signal (score=${sharpScore})`);
    }
    // Rule 3: Volatility/Risk mismatch
    if (volatility_index > VOLATILITY_HIGH && risk_score < VOLATILITY_LOW) {
        reasons.push(`High volatility index (${volatility_index}) with low risk score (${risk_score}) — possible manipulation`);
    }
    // Rule 4: Model not trusted
    if (!trust.trust) reasons.push(trust.reason);

    const flagged = reasons.length > 0;
    let safe_angle = null;
    if (flagged) {
        const xgH = parseFloat(m.home_xg || 0);
        const xgA = parseFloat(m.away_xg || 0);
        safe_angle = xgH + xgA > 2.4 ? 'Over 2.5 Goals'
                   : xgH > 1.0 && xgA > 0.8 ? 'BTTS Yes'
                   : 'Under 2.5 Goals';
    }
    return { flagged, reason: reasons.join(' | ') || 'No trap signals', safe_angle };
}

// ─── STEP 6: DECISION ENGINE ──────────────────────────────────────────────────
/**
 * Synthesises all signals into a final adjusted prediction.
 */
function buildDecision(m, identity, scores, trust, trap, antiRep) {
    const pHome = parseFloat(m.home_win_probability || 0);
    const pAway = parseFloat(m.away_win_probability || 0);
    const pDraw = parseFloat(m.draw_probability     || 0);

    let selection = pHome >= pAway && pHome >= pDraw
        ? `${m.homeTeam || 'Home'} Win`
        : pAway > pHome && pAway >= pDraw
            ? `${m.awayTeam || 'Away'} Win`
            : 'Draw';

    let finalPrediction = selection;
    let adjustmentNote  = 'Standard model output applied';

    // Override 1: Trap detected → use safe angle
    if (trap.flagged && trap.safe_angle) {
        finalPrediction = trap.safe_angle;
        adjustmentNote  = `TRAP ACTIVE → shifted to safe angle: ${trap.safe_angle}`;
    }

    // Override 2: Anti-repetition triggered
    if (antiRep.forced_alternative) {
        finalPrediction = antiRep.alternative_type;
        adjustmentNote  = `Anti-repetition triggered → forced alternative: ${antiRep.alternative_type}`;
    }

    // Override 3: High volatility → widen to Double Chance
    if (!trap.flagged && !antiRep.forced_alternative && identity.type === 'High Volatility Match') {
        const homeOrDraw = `${m.homeTeam || 'Home'} or Draw`;
        const awayOrDraw = `${m.awayTeam || 'Away'} or Draw`;
        finalPrediction = pHome >= pAway ? homeOrDraw : awayOrDraw;
        adjustmentNote  = 'High volatility detected → expanded to Double Chance for safety';
    }

    return { finalPrediction, adjustmentNote };
}

// ─── STEP 7: FPIS OUTPUT BUILDER ─────────────────────────────────────────────
/**
 * Builds the canonical FPIS output block.
 * alternative_angle is always a string (pre-match) or array of 3 tiers (live).
 * Confidence is clamped to a minimum of 15 — never returns 0%.
 */
function buildFPISOutput(m, identity, scores, trust, trap, antiRep, decision, liveExtras = null) {
    const pHome = parseFloat(m.home_win_probability || 0).toFixed(1);
    const pDraw = parseFloat(m.draw_probability     || 0).toFixed(1);
    const pAway = parseFloat(m.away_win_probability || 0).toFixed(1);

    // Risk Level
    let riskLevel = 'Medium';
    if (scores.risk_score >= 60 || trap.flagged) riskLevel = 'High';
    else if (scores.risk_score <= 20 && !trap.flagged && trust.trust) riskLevel = 'Low';

    const hidden = _buildHiddenInsight(m, identity, scores, trust, trap);

    // Alternative angle: array of 3 tiers in live mode, string in pre-match
    const altAngle = liveExtras?.multi_angle
        ? liveExtras.multi_angle
        : antiRep.forced_alternative
            ? antiRep.alternative_type
            : _buildAlternativeAngle(m, identity, decision.finalPrediction);

    const modelWarning = trust.is_obvious
        ? ' ⚠️ Prediction may be too obvious — verify with sharp signal'
        : '';

    // Confidence: top model probability, boosted by trust/liquidity, clamped [15, 98]
    const topP = Math.max(
        parseFloat(m.home_win_probability || 0),
        parseFloat(m.draw_probability     || 0),
        parseFloat(m.away_win_probability || 0)
    );
    const rawConf = topP > 0 ? topP : 33.3;
    const trustBoost  = trust.trust ? 5 : -5;
    
    // CONFIDENCE INJECTION: Elite Signal (e.g. One-sided Domination)
    const eliteBoost = identity.type === 'One-sided Domination' || liveExtras?.value_signal?.signal !== 'NEUTRAL' ? 15 : 0;
    
    // XGBoost Reliance Boost: if the source is XGBoost, we give an extra 10% weight to the top probability
    const xgbBoost = (m.ai_source?.includes('XGB') || m.ai_source?.includes('TITANIUM')) ? 12 : 0;

    // Market Stability boost
    const liquidBoost = liveExtras?.liquidity_level === 'High' ? 10
                      : liveExtras?.liquidity_level === 'Medium' ? 5 : 0;
                      
    const totalBoost = trustBoost + liquidBoost + eliteBoost + xgbBoost;
    let confidence  = Math.round(rawConf + totalBoost);
    
    // Force confidence >= 70 if an elite signal is present and base is somewhat solid
    if (eliteBoost > 0 && confidence < 70 && rawConf >= 40) {
        confidence = 72;
    }
    
    // Hard cap 98
    confidence = Math.min(98, confidence);
    // Dynamic Confidence Floor (Min 25% if >10 min played and clear scoreline, else Min 15%)
    const mktStabilityFloor = (parseInt(m._minute || 0) > 10) ? 25 : 15;
    confidence = Math.max(mktStabilityFloor, confidence);

    return {
        match_type:           identity.type,
        match_type_reason:    identity.justification,
        model_prediction: {
            home:    `${pHome}%`,
            draw:    `${pDraw}%`,
            away:    `${pAway}%`,
            warning: trust.reason + modelWarning
        },
        adjusted_prediction:  decision.finalPrediction,
        adjustment_note:      decision.adjustmentNote,
        alternative_angle:    altAngle,
        hidden_insight:       hidden,
        risk_level:           riskLevel,
        confidence:           confidence,
        reliability_score:    m.reliability_index || 50.0,
        v25_indicators: {
            motivation: m.motivation_context || 1.0,
            liquidity: m.liquidity_index || 0.5,
            data_completeness: m.data_completeness || 0
        },
        trap_alert: {
            flagged: trap.flagged,
            reason:  trap.reason,
            safe_angle: trap.safe_angle
        },
        // Live extras (null for pre-match)
        value_signal:  liveExtras?.value_signal  || null,
        live_trap_detail: liveExtras?.live_trap_detail || null,
        scores: {
            tempo:      scores.tempo_score,
            risk:       scores.risk_score,
            motivation: scores.motivation_score,
            volatility: scores.volatility_index
        }
    };
}

function _buildHiddenInsight(m, identity, scores, trust, trap) {
    const insights = [];

    // xG-based insight
    const xgH = parseFloat(m.home_xg || 0);
    const xgA = parseFloat(m.away_xg || 0);
    if (xgH > 0.3 && xgA > 0.3) {
        const xgDiff = xgH - xgA;
        if (Math.abs(xgDiff) > 0.6) {
            insights.push(`xG gap of ${Math.abs(xgDiff).toFixed(2)} favours ${xgDiff > 0 ? (m.homeTeam || 'Home') : (m.awayTeam || 'Away')} more than odds suggest`);
        }
    }

    // Sharp money hidden signal
    const sharpScore = parseFloat(m.sharp_score || 0);
    if (sharpScore >= 40) {
        insights.push(`Strong institutional money signal (sharp_score=${sharpScore}) — professionals disagree with public`);
    }

    // V20 pattern
    if (m.master_v20?.is_pattern) {
        insights.push(`V20 Master Pattern matched (${m.master_v20.master_verdict}) — historical profile aligned`);
    }

    // News-based
    const critical = m.news_data?.impact?.critical || [];
    if (critical.length > 0) {
        insights.push(`Critical team news: ${critical.slice(0, 2).join(', ')}`);
    }

    // Momentum
    if (scores.motivation_score > 70) {
        insights.push(`High motivation index (${scores.motivation_score}) — expect high-intensity pressing`);
    }

    return insights.length > 0 ? insights[0] : 'No non-obvious insight detected — standard model output is reliable';
}

function _buildAlternativeAngle(m, identity, mainPrediction) {
    const xgH = parseFloat(m.home_xg || 0);
    const xgA = parseFloat(m.away_xg || 0);
    const xgSum = xgH + xgA;

    // Never repeat the main prediction as alternative
    if (identity.type === 'Low Tempo Defensive Match' && mainPrediction !== 'Under 2.5 Goals') {
        return 'Under 2.5 Goals';
    }
    if (identity.type === 'High Tempo Attacking Match' && mainPrediction !== 'BTTS Yes') {
        return 'BTTS Yes';
    }
    if (identity.type === 'One-sided Domination') {
        const dom = xgH > xgA ? (m.homeTeam || 'Home') : (m.awayTeam || 'Away');
        if (mainPrediction !== `${dom} -1 (Asian Handicap)`) return `${dom} -1 (Asian Handicap)`;
    }
    if (xgSum > 2.3 && mainPrediction !== 'Over 2.5 Goals') return 'Over 2.5 Goals';
    if (xgSum < 2.0 && mainPrediction !== 'Under 2.5 Goals') return 'Under 2.5 Goals';
    if (xgH > 1.0 && xgA > 0.8 && mainPrediction !== 'BTTS Yes') return 'BTTS Yes';
    return 'Double Chance';
}

// ─── STEP 8: SELF-LEARNING LOGGER ────────────────────────────────────────────
function logPrediction(matchId, fpis, homeTeam, awayTeam) {
    try {
        let log = [];
        if (fs.existsSync(LEARNING_LOG)) {
            const raw = fs.readFileSync(LEARNING_LOG, 'utf-8');
            log = JSON.parse(raw);
            // Keep last 500 entries
            if (log.length > 500) log = log.slice(-500);
        }

        log.push({
            ts:               new Date().toISOString(),
            match_id:         matchId || null,
            home_team:        homeTeam || null,
            away_team:        awayTeam || null,
            match_type:       fpis.match_type,
            adjusted_prediction: fpis.adjusted_prediction,
            risk_level:       fpis.risk_level,
            trap_flagged:     fpis.trap_alert.flagged,
            volatility:       fpis.scores.volatility,
            risk_score:       fpis.scores.risk,
            result:           null,          // filled later by audit script
            failure_reason:   null           // filled later by audit script
        });

        fs.mkdirSync(path.dirname(LEARNING_LOG), { recursive: true });
        fs.writeFileSync(LEARNING_LOG, JSON.stringify(log, null, 2), 'utf-8');
    } catch (e) {
        // Non-fatal — logging should never break prediction flow
        console.error(`[FPIS] Logger error: ${e.message}`);
    }
}

// ─── SAFE JSON FALLBACK ───────────────────────────────────────────────────────
/**
 * Always returns a valid fpis object — ensures UI never crashes.
 * Used by both process() and processLive() error paths.
 */
function _safeFallback(isLive = false, errMsg = '') {
    return {
        match_type:          isLive ? 'Live Match — Data Pending' : 'Unknown',
        match_type_reason:   errMsg || 'Fallback applied',
        model_prediction:    { home: '33%', draw: '33%', away: '34%', warning: 'FPIS fallback' },
        adjusted_prediction: isLive ? 'No Live Prediction [LIVE_ADJUSTED]' : 'Draw',
        adjustment_note:     'Safe fallback — no data to process',
        alternative_angle:   isLive
            ? [
                { tier: 'Aggressive',   angle: 'Over 1.5 Goals',  rationale: 'Fallback — data pending' },
                { tier: 'Moderate',     angle: 'Draw No Bet',      rationale: 'Fallback — data pending' },
                { tier: 'Conservative', angle: 'Under 4.5 Goals',  rationale: 'Fallback — data pending' }
              ]
            : 'Under 1.5 Goals',
        hidden_insight:      isLive ? 'Live data not yet available — predictions pending' : 'Engine error — fallback applied',
        risk_level:          'High',
        confidence:          15,                          // floor — never 0%
        is_elite_candidate:  false,
        trap_alert:          { flagged: false, reason: 'Fallback applied', safe_angle: null },
        value_signal:        { signal: 'NEUTRAL', detail: 'Fallback — no data', edge: 0 },
        live_trap_detail:    null,
        scores:              { tempo: 0, risk: 50, motivation: 50, volatility: 0 },
        is_live:             isLive
    };
}

// ─── MAIN ENTRY POINT (Pre-match) ────────────────────────────────────────────
/**
 * process(match) — for enriched pre-match objects
 * @param {Object} m - Fully enriched match object
 * @returns {Object} FPIS output block
 */
async function process(m) {
    try {
        if (!m || typeof m !== 'object') return _safeFallback(false, 'Null match object');

        // ── STEP 10: LINEUP SHOCK RADAR (V6) & B-TEAM DETECTION ──────────────────
        let lineupImpact = { home: 0, away: 0, missing: [], rotationH: null, rotationA: null };
        if (m.id) {
            const deficit = await lineup.calculateLineupDeficit(m.id, m.homeTeamId, m.awayTeamId);
            
            // Fetch Rotation Analysis (B-Team detection)
            const rotH = await squadRotation.analyzeRotation(m.homeTeamId, m._raw_lineup_home || []);
            const rotA = await squadRotation.analyzeRotation(m.awayTeamId, m._raw_lineup_away || []);
            lineupImpact.rotationH = rotH;
            lineupImpact.rotationA = rotA;

            if (deficit && deficit.isFetched) {
                lineupImpact.home = deficit.home.xgPenalty;
                lineupImpact.away = deficit.away.xgPenalty;
                lineupImpact.missing = [...deficit.home.missingKeys, ...deficit.away.missingKeys];
                
                // Adjust Probabilities (Bayesian shift)
                const shift = (lineupImpact.home - lineupImpact.away) * 15;
                m.home_win_probability = Math.max(5, (m.home_win_probability || 33.3) - shift);
                m.away_win_probability = Math.max(5, (m.away_win_probability || 33.4) + shift);

                // Apply B-Team penalty if detected
                const adjustedProbs = squadRotation.adjustProbability(
                    { pHome: m.home_win_probability, pDraw: m.draw_probability, pAway: m.away_win_probability },
                    rotH, rotA
                );
                m.home_win_probability = adjustedProbs.pHome;
                m.draw_probability = adjustedProbs.pDraw;
                m.away_win_probability = adjustedProbs.pAway;
            }
        }

        const identity   = classifyMatchIdentity(m);
        const scores     = buildIntelligenceScores(m);
        const trust      = checkModelTrust(m, identity.type);

        const pHome = parseFloat(m.home_win_probability || 0);
        const pAway = parseFloat(m.away_win_probability || 0);
        const pDraw = parseFloat(m.draw_probability     || 0);
        const primaryType = pHome >= pAway && pHome >= pDraw ? 'Home Win'
            : pAway > pHome && pAway >= pDraw ? 'Away Win' : 'Draw';

        const antiRep  = antiRepetitionCheck(primaryType, false);
        const trap     = detectTrap(m, scores, trust);
        const decision = buildDecision(m, identity, scores, trust, trap, antiRep);
        const fpis     = buildFPISOutput(m, identity, scores, trust, trap, antiRep, decision, lineupImpact);

        // Inject Lineup Context into Hidden Insight
        if (lineupImpact.missing.length > 0) {
            fpis.hidden_insight = `[V6 LINEUP] Missing keys: ${lineupImpact.missing.join(', ')}. Outcome adjusted. | ${fpis.hidden_insight}`;
        }
        if (lineupImpact.rotationH?.isBTeam) {
            fpis.hidden_insight = `⚠️ [B-TEAM] ${m.homeTeam} playing with rotation squad (${(lineupImpact.rotationH.rotationRate*100).toFixed(0)}%). | ${fpis.hidden_insight}`;
        }
        if (lineupImpact.rotationA?.isBTeam) {
            fpis.hidden_insight = `⚠️ [B-TEAM] ${m.awayTeam} playing with rotation squad (${(lineupImpact.rotationA.rotationRate*100).toFixed(0)}%). | ${fpis.hidden_insight}`;
        }

        _recordPrediction(decision.finalPrediction);
        logPrediction(m.id, fpis, m.homeTeam, m.awayTeam);
        return fpis;
    } catch (err) {
        console.error(`[FPIS] Fatal error: ${err.message}`);
        return _safeFallback(false, err.message);
    }
}

// ─── LIVE ENTRY POINT ────────────────────────────────────────────────────────
/**
 * processLive(rawLiveMatch)
 * Called by liveLabService._enrichMatch() with the raw live match row.
 * Applies all 5 live-mode adaptations:
 *   1. Live Data Mapping  (live xG + pressure replace historical)
 *   2. Step 3 relaxed     (no sharp_score — odds-drift only)
 *   3. Step 4 bypassed    (ring buffer disabled)
 *   4. Step 5 live trap   (odds-drift-only fallback)
 *   5. Guaranteed JSON    (_safeFallback on any error)
 * Tags adjusted_prediction with [LIVE_ADJUSTED].
 * @param {Object} rawLiveMatch - Raw match row from liveLabService
 * @returns {Object} FPIS output block
 */
async function processLive(rawLiveMatch) {
    try {
        if (!rawLiveMatch || typeof rawLiveMatch !== 'object') {
            return _safeFallback(true, 'Null live match object');
        }

        // ── Map raw DB/liveLabService row → normalised live match object
        const m = _mapLiveData(rawLiveMatch);

        // Validation Check (Live Data Integrity): Immediate Recalc trigger if score changed
        const currentScore = `${m.scoreHome}-${m.scoreAway}`;
        const matchIdStr = String(m.id);
        if (liveScoreCache[matchIdStr] && liveScoreCache[matchIdStr] !== currentScore) {
            m._recalc_triggered = true;
        }
        liveScoreCache[matchIdStr] = currentScore;

        // ── EARLY-MATCH HEURISTICS (Enhancement 1) ───────────────────────────────
        // In the first 15 minutes cumulative xG is unreliable — pattern override
        const earlyHeuristic = earlyMatchHeuristics(m);
        if (earlyHeuristic?.override) {
            // Build a minimal identity/scores for logging
            const earlyIdentity = { type: 'Early-Phase Match', justification: earlyHeuristic.adjustment_note };
            const earlyScores   = buildIntelligenceScores(m);
            const earlyTrust    = marketLiquidityTrust(m);
            const earlyTrap     = { flagged: false, reason: 'Early phase — trap detection bypassed', safe_angle: null };
            const earlyAntiRep  = { forced_alternative: false, alternative_type: null };
            const earlyDecision = { finalPrediction: earlyHeuristic.adjusted_prediction, adjustmentNote: earlyHeuristic.adjustment_note };
            const liveExtras    = {
                multi_angle:      earlyHeuristic.alternative_angles,
                value_signal:     { signal: 'NEUTRAL', detail: 'Early phase — insufficient data', edge: 0 },
                live_trap_detail: null,
                liquidity_level:  earlyTrust.liquidity_level
            };
            const fpis = buildFPISOutput(m, earlyIdentity, earlyScores, earlyTrust, earlyTrap, earlyAntiRep, earlyDecision, liveExtras);
            fpis.adjusted_prediction = `${fpis.adjusted_prediction} [LIVE_ADJUSTED]`;
            let note = `[LIVE] ${fpis.adjustment_note}`;
            if (m._recalc_triggered) {
                note = "[IMMEDIATE RECALC] Live score change trigged bypass. " + note;
            }
            fpis.adjustment_note     = note;
            fpis.is_live             = true;
            fpis.live_minute         = m._minute;
            logPrediction(m.id, fpis, m.homeTeam, m.awayTeam);
            return fpis;
        }

        // ── BAYESIAN REDISTRIBUTION (Enhancement 2) ──────────────────────────────
        // Eliminate 33/33/33 flat-line using live odds drift as Bayesian prior
        const bayesian = bayesianRedistribution(
            parseFloat(m.home_win_probability || 33.3),
            parseFloat(m.draw_probability     || 33.3),
            parseFloat(m.away_win_probability || 33.4),
            parseFloat(m.odds_drop_home || 0),
            parseFloat(m.odds_drop_away || 0),
            m._minute,
            m.live_pressure || 0 // Pass live pressure for V21 tilt
        );
        m.home_win_probability = bayesian.pHome;
        m.draw_probability     = bayesian.pDraw;
        m.away_win_probability = bayesian.pAway;

        // ── V21 DNA SYNERGY OVERLAY ─────────────────────────────────────────────
        // If StatsBomb profile is available, check for Current squad vs Historical
        const dnaH = rawLiveMatch._dnaH; 
        const dnaA = rawLiveMatch._dnaA;
        if (dnaH || dnaA) {
            const squadHealth = parseFloat(rawLiveMatch.squad_health_impact || 1.0);
            if (squadHealth < 0.85) {
                // Penalize DNA synergy if major players are missing (History doesn't match reality)
                m.home_win_probability *= 0.92;
                m.away_win_probability *= 0.92;
            }
        }

        // ── LIVE MATCH SCORE LOGIC (Enhancement 2B) ──────────────────────────────
        // Score-based live prob shift and Trend Alignment for deficits > 1 goal
        let forcedPrediction = null;
        let forcedMatchType = null;

        const scoreLogic = liveMatchScoreLogic(m);
        m.home_win_probability = scoreLogic.pHome;
        m.draw_probability     = scoreLogic.pDraw;
        m.away_win_probability = scoreLogic.pAway;
        forcedPrediction       = scoreLogic.forceAlternative;
        forcedMatchType        = scoreLogic.forceMatchType;

        let recalcTriggeredMsg = null;
        if (m._recalc_triggered) {
             recalcTriggeredMsg = "[IMMEDIATE RECALC] Live score change trigged bypass.";
        }

        // ── STEP 1 + 2 ─────────────────────────────────────────────────────────────
        const identity = classifyMatchIdentity(m, forcedMatchType);
        const scores   = buildIntelligenceScores(m);
        scores.tempo_score = Math.max(scores.tempo_score, m.live_pressure || 0);

        // ── STEP 3: Market Liquidity Trust fallback (Enhancement 5) ────────────
        // sharp_score is null in live — derive trust from market movement
        const trust = marketLiquidityTrust(m);

        // ── STEP 10: LINEUP SHOCK RADAR (V6) & B-TEAM DETECTION ──────────────────
        let lineupImpact = { home: 0, away: 0, missing: [], rotationH: null, rotationA: null };
        if (m.id) {
            const deficit = await lineup.calculateLineupDeficit(m.id, m.homeTeamId, m.awayTeamId);
            
            // Fetch Rotation Analysis (B-Team detection)
            const rotH = await squadRotation.analyzeRotation(m.homeTeamId, m._raw_lineup_home || []);
            const rotA = await squadRotation.analyzeRotation(m.awayTeamId, m._raw_lineup_away || []);
            lineupImpact.rotationH = rotH;
            lineupImpact.rotationA = rotA;

            if (deficit && deficit.isFetched) {
                lineupImpact.home = deficit.home.xgPenalty;
                lineupImpact.away = deficit.away.xgPenalty;
                lineupImpact.missing = [...deficit.home.missingKeys, ...deficit.away.missingKeys];
                
                // Live Adjustment: heavier tilt for missing key players in-play
                const liveShift = (lineupImpact.home - lineupImpact.away) * 20;
                m.home_win_probability = Math.max(2, (m.home_win_probability || 33) - liveShift);
                m.away_win_probability = Math.max(2, (m.away_win_probability || 33) + liveShift);

                // Apply B-Team penalty
                const adjustedProbs = squadRotation.adjustProbability(
                    { pHome: m.home_win_probability, pDraw: m.draw_probability, pAway: m.away_win_probability },
                    rotH, rotA
                );
                m.home_win_probability = adjustedProbs.pHome;
                m.draw_probability = adjustedProbs.pDraw;
                m.away_win_probability = adjustedProbs.pAway;
            }
        }

        // ── STEP 9: ORACLE FINAL SIMULATION (V4) ──────────────────────────
        const oracleResult = await oracle.simulate(m, lineupImpact);

        // ── STEP 4: Ring buffer bypassed for live ──────────────────────────────
        const pHome = parseFloat(m.home_win_probability || 0);
        const pAway = parseFloat(m.away_win_probability || 0);
        const pDraw = parseFloat(m.draw_probability     || 0);
        const primaryType = pHome >= pAway && pHome >= pDraw ? 'Home Win'
            : pAway > pHome && pAway >= pDraw ? 'Away Win' : 'Draw';
        const antiRep = antiRepetitionCheck(primaryType, true); // bypassed

        // ── STEP 5: Live odds-drift trap + Value/Trap signal (Enhancements 4+5) ──
        const trap        = detectTrap(m, scores, trust);
        const valueSignal = detectLiveValueOrTrap(m);

        // ── STEP 6: Decision ──────────────────────────────────────────────────────────
        const decision = buildDecision(m, identity, scores, trust, trap, antiRep);
        
        // Apply Trend Alignment if the score logic dictated it (e.g. 0-2 deficit)
        if (forcedPrediction) {
            decision.finalPrediction = forcedPrediction;
            decision.adjustmentNote = `Trend Alignment: Corrected prediction to reflect multi-goal deficit.`;
        }
        
        if (recalcTriggeredMsg) {
             decision.adjustmentNote = recalcTriggeredMsg + " " + decision.adjustmentNote;
        }

        // ── STEP 7: Multi-angle output (Enhancement 3) + build FPIS ─────────────
        const multiAngle = buildMultiAngleOutput(m, identity, scores, trap, decision);
        const liveExtras = {
            multi_angle:       multiAngle,
            value_signal:      valueSignal,
            live_trap_detail:  trap.flagged ? trap.reason : null,
            liquidity_level:   trust.liquidity_level
        };
        const fpis = buildFPISOutput(m, identity, scores, trust, trap, antiRep, decision, liveExtras);

        // Tag as live
        fpis.adjusted_prediction = `${fpis.adjusted_prediction} [LIVE_ADJUSTED]`;
        fpis.adjustment_note     = `[LIVE] ${fpis.adjustment_note}`;
        fpis.is_live             = true;
        fpis.live_minute         = m._minute;

        // ── STEP 8: Log ─────────────────────────────────────────────────────────────
        logPrediction(m.id, fpis, m.homeTeam, m.awayTeam);
        return fpis;
    } catch (err) {
        console.error(`[FPIS-LIVE] Error: ${err.message}`);
        return _safeFallback(true, err.message);
    }
}

// ─── AUDIT UTILITY ───────────────────────────────────────────────────────────
/**
 * Called externally (e.g. fpis_audit.js) to record a match result
 * and tag the prediction with a failure reason for self-learning.
 */
function recordResult(matchId, actualResult) {
    try {
        if (!fs.existsSync(LEARNING_LOG)) return;
        const log = JSON.parse(fs.readFileSync(LEARNING_LOG, 'utf-8'));
        const entry = log.find(e => e.match_id == matchId && !e.result);
        if (!entry) return;

        entry.result = actualResult;

        const predicted = (entry.adjusted_prediction || '').toLowerCase();
        const actual    = (actualResult || '').toLowerCase();
        const matched   = actual.includes('home') && predicted.includes('home') ||
                          actual.includes('away') && predicted.includes('away') ||
                          actual.includes('draw') && predicted.includes('draw') ||
                          actual.includes('over') && predicted.includes('over') ||
                          actual.includes('under') && predicted.includes('under') ||
                          actual.includes('btts') && predicted.includes('btts');

        if (!matched) {
            const trapMissed = !entry.trap_flagged && entry.match_type === 'Trap Match';
            entry.failure_reason = trapMissed
                ? 'Trap not flagged — odds misread'
                : entry.volatility > VOLATILITY_HIGH
                    ? 'High volatility match — news impact underestimated'
                    : 'xG model misleading or incorrect outcome';
        }

        fs.writeFileSync(LEARNING_LOG, JSON.stringify(log, null, 2), 'utf-8');
    } catch (e) {
        console.error(`[FPIS] Audit error: ${e.message}`);
    }
}

module.exports = { process, processLive, recordResult };

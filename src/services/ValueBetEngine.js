/**
 * ValueBetEngine.js
 * ─────────────────────────────────────────────────────────────
 * Core mathematical engine for detecting Value Bets.
 *
 * Pipeline:
 *   1.  Raw odds   →  de-vig  →  fair (true) implied probability
 *   2.  Model prob (from xG Poisson) vs. fair implied prob
 *   3.  Edge %  =  model_prob – fair_implied_prob
 *   4.  EV      =  (model_prob * odds) – 1
 *   5.  Kelly   =  (Edge / (Odds – 1)) × 0.25  [fractional]
 *   6.  Tier    :  💎 Diamond, 🔥 Fire, ✅ Value, ⚖️ Neutral, ⚠️ Trap
 * ─────────────────────────────────────────────────────────────
 */

// ── Constants ───────────────────────────────────────────────────
const KELLY_FRACTION  = 0.25;   // fractional Kelly multiplier (1/4)
const MIN_EDGE_VALUE  = 5.0;    // min edge % to flag as value (User threshold)
const MIN_ODDS_VALUE  = 1.10;   // allow shorter odds
const MAX_KELLY_PCT   = 10.0;   // cap recommended stake at 10%

// ── Helpers ─────────────────────────────────────────────────────

/**
 * rawImplied(odds) — basic raw implied probability without margin removal.
 * @param {number} odds - decimal odds (e.g. 1.85)
 * @returns {number} probability 0–100
 */
function rawImplied(odds) {
    if (!odds || odds <= 1) return 0;
    return (1 / odds) * 100;
}

/**
 * deVig(home, draw, away) — remove bookmaker margin.
 * Returns fair implied probabilities that sum to 100.
 * @returns {{ home, draw, away, margin }} all in %
 */
function deVig(homeOdds, drawOdds, awayOdds) {
    const rawH = rawImplied(homeOdds);
    const rawD = rawImplied(drawOdds) || 0;
    const rawA = rawImplied(awayOdds);

    const overround = rawH + rawD + rawA; // typically 105–108%
    const margin    = overround - 100;

    if (overround <= 0) return { home: 33.3, draw: 33.3, away: 33.3, margin: 0 };

    const fairH = (rawH / overround) * 100;
    const fairD = drawOdds ? (rawD / overround) * 100 : 0;
    const fairA = (rawA / overround) * 100;

    return {
        home: parseFloat(fairH.toFixed(2)),
        draw: parseFloat(fairD.toFixed(2)),
        away: parseFloat(fairA.toFixed(2)),
        margin: parseFloat(margin.toFixed(2))
    };
}

/**
 * kellyStake(modelProb, odds) — fractional Kelly Criterion.
 * @param {number} modelProb - our model's probability 0–100
 * @param {number} odds      - decimal odds
 * @returns {number} recommended stake as % of bankroll (0–MAX_KELLY_PCT)
 */
function kellyStake(modelProb, odds) {
    if (!odds || odds <= 1 || !modelProb) return 0;
    const p = modelProb / 100;
    const q = 1 - p;
    const b = odds - 1;

    const fullKelly = (p * b - q) / b;
    if (fullKelly <= 0) return 0;  // negative Kelly = no bet

    const fractional = fullKelly * KELLY_FRACTION * 100;
    return parseFloat(Math.min(fractional, MAX_KELLY_PCT).toFixed(1));
}

/**
 * valueTier(edgePct, ev) — classify the bet signal strength.
 */
function valueTier(edgePct, ev) {
    if (edgePct >= 15)            return { label: '💎 Diamond',  css: 'tier-diamond', color: '#f1c40f' };
    if (edgePct >= 9)             return { label: '🔥 Fire',      css: 'tier-fire',    color: '#e67e22' };
    if (edgePct >= MIN_EDGE_VALUE) return { label: '✅ Value',    css: 'tier-value',   color: '#27ae60' };
    if (edgePct <= -5)            return { label: '⚠️ Trap',      css: 'tier-trap',    color: '#e74c3c' };
    return                               { label: '⚖️ Neutral',   css: 'tier-neutral', color: '#7f8c8d' };
}

/**
 * analyzeValue({ modelHome, modelDraw, modelAway, homeOdds, drawOdds, awayOdds })
 *
 * All model probabilities in 0–100 range.
 * All odds in decimal format (e.g. 1.85).
 *
 * Returns full 3-way value analysis + best bet recommendation.
 */
function analyzeValue({ modelHome, modelDraw, modelAway, homeOdds, drawOdds, awayOdds }) {
    // If no odds at all, return null (no analysis possible)
    if (!homeOdds && !awayOdds) return null;

    // Fill missing odds gracefully
    const h = parseFloat(homeOdds) || null;
    const d = parseFloat(drawOdds) || null;
    const a = parseFloat(awayOdds) || null;

    // De-vig the market
    const fair = deVig(h || 2.0, d || 3.40, a || 3.50);

    const buildOutcome = (label, modelProb, odds, fairProb, outcomeKey) => {
        if (!odds || odds < MIN_ODDS_VALUE || !modelProb) return null;
        const edge   = parseFloat((modelProb - fairProb).toFixed(2));
        const ev     = parseFloat(((modelProb / 100) * odds - 1).toFixed(3));
        const kelly  = kellyStake(modelProb, odds);
        const tier   = valueTier(edge, ev);
        return { label, selection: outcomeKey, modelProb, odds, fairProb, edge, ev, kelly, tier };
    };

    const homeResult = buildOutcome('Home', modelHome || 33, h, fair.home, 'home');
    const drawResult = buildOutcome('Draw', modelDraw || 33, d, fair.draw, 'draw');
    const awayResult = buildOutcome('Away', modelAway || 33, a, fair.away, 'away');

    const all = [homeResult, drawResult, awayResult].filter(Boolean);
    if (!all.length) return null;

    // Find the best value bet (highest edge)
    all.sort((a, b) => b.edge - a.edge);
    const best = all[0];

    return {
        home:   homeResult,
        draw:   drawResult,
        away:   awayResult,
        best,
        margin: fair.margin,
        hasValue: best.edge >= MIN_EDGE_VALUE
    };
}

/**
 * Legacy-compatible wrapper: calculateValue(winProb, odds)
 */
function calculateValue(winProb, odds) {
    if (!odds || odds <= 1 || !winProb) return { ev: 0, kelly: 0, verdict: '⚖️ Neutral', color: '#7f8c8d' };
    const p = winProb / 100;
    const ev = parseFloat(((p * odds) - 1).toFixed(3));
    const kelly = kellyStake(winProb, odds);
    const tier  = valueTier((winProb - rawImplied(odds)), ev);
    return { ev, kelly, verdict: tier.label, color: tier.color };
}

/**
 * Static method: calculateEV(probability, odds)
 */
function calculateEV(probability, odds) {
    if (!odds || probability == null) return 0;
    return parseFloat((((probability / 100) * odds) - 1).toFixed(3));
}

module.exports = { analyzeValue, calculateValue, calculateEV, deVig, kellyStake, valueTier, rawImplied };

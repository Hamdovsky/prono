/**
 * InsightEngine.js (upgraded)
 * ─────────────────────────────────────────────────────────────
 * Frontend-safe (no Node.js require) version of ValueBetEngine.
 * All functions exported as ES modules.
 * ─────────────────────────────────────────────────────────────
 */

const KELLY_FRACTION = 0.25;
const MAX_KELLY_PCT  = 10.0;

// ── De-Vig ──────────────────────────────────────────────────────
export function rawImplied(odds) {
    if (!odds || odds <= 1) return 0;
    return (1 / odds) * 100;
}

export function deVig(homeOdds, drawOdds, awayOdds) {
    const rH = rawImplied(homeOdds);
    const rD = rawImplied(drawOdds) || 0;
    const rA = rawImplied(awayOdds);
    const over = rH + rD + rA;
    if (over <= 0) return { home: 33.3, draw: 33.3, away: 33.3, margin: 0 };
    return {
        home:   parseFloat((rH / over * 100).toFixed(2)),
        draw:   parseFloat((rD / over * 100).toFixed(2)),
        away:   parseFloat((rA / over * 100).toFixed(2)),
        margin: parseFloat((over - 100).toFixed(2))
    };
}

// ── Kelly Criterion ─────────────────────────────────────────────
export function kellyStake(modelProb, odds) {
    if (!odds || odds <= 1 || !modelProb) return 0;
    const p = modelProb / 100;
    const b = odds - 1;
    const full = (p * b - (1 - p)) / b;
    if (full <= 0) return 0;
    return parseFloat(Math.min(full * KELLY_FRACTION * 100, MAX_KELLY_PCT).toFixed(1));
}

// ── Value Tier ─────────────────────────────────────────────────
export function valueTier(edgePct) {
    if (edgePct >= 15) return { label: '💎 Diamond',  css: 'tier-diamond', color: '#f1c40f' };
    if (edgePct >= 9)  return { label: '🔥 Fire',     css: 'tier-fire',    color: '#e67e22' };
    if (edgePct >= 2)  return { label: '✅ Value',    css: 'tier-value',   color: '#27ae60' };
    if (edgePct <= -5) return { label: '⚠️ Trap',     css: 'tier-trap',    color: '#e74c3c' };
    return                    { label: '⚖️ Neutral',  css: 'tier-neutral', color: '#7f8c8d' };
}

// ── Main 3-way Analysis ─────────────────────────────────────────
/**
 * analyzeValue({ modelHome, modelDraw, modelAway, homeOdds, drawOdds, awayOdds })
 * All model probs: 0–100. Odds: decimal.
 */
export function analyzeValue({ modelHome, modelDraw, modelAway, homeOdds, drawOdds, awayOdds }) {
    if (!homeOdds && !awayOdds) return null;

    const h = parseFloat(homeOdds) || null;
    const d = parseFloat(drawOdds) || null;
    const a = parseFloat(awayOdds) || null;

    const fair = deVig(h || 2.0, d || 3.40, a || 3.50);

    const build = (label, mProb, odds, fairP) => {
        if (!odds || odds < 1.30 || !mProb) return null;
        const edge  = parseFloat((mProb - fairP).toFixed(2));
        const ev    = parseFloat(((mProb / 100) * odds - 1).toFixed(3));
        const kelly = kellyStake(mProb, odds);
        const tier  = valueTier(edge);
        return { label, modelProb: mProb, odds, fairProb: fairP, edge, ev, kelly, tier };
    };

    const home = build('Home', modelHome, h, fair.home);
    const draw = build('Draw', modelDraw, d, fair.draw);
    const away = build('Away', modelAway, a, fair.away);
    const all  = [home, draw, away].filter(Boolean);
    if (!all.length) return null;

    all.sort((x, y) => y.edge - x.edge);
    const best = all[0];

    return { home, draw, away, best, margin: fair.margin, hasValue: best.edge >= 2 };
}

// ── Legacy-compatible wrappers ──────────────────────────────────

/** Replaces the old calculateEV stub */
export const calculateEV = (winProb, marketOdds) => {
    if (!winProb || !marketOdds || marketOdds <= 1) return 0;
    return parseFloat(((winProb / 100) * marketOdds - 1).toFixed(2));
};

export const getSquadHealth = (newsImpact) => {
    return Math.max(0, Math.min(100, 100 + (newsImpact || 0)));
};

export const getVerdict = (ev) => {
    if (ev > 0.15) return '🔥 HIGH VALUE';
    if (ev > 0.05) return '✅ VALUE';
    if (ev < -0.10) return '⚠️ OVERVALUED';
    return '⚖️ NEUTRAL';
};

export const analyzeOpenMatch = (homeXG, awayXG, homeSquadH, awaySquadH) => {
    const combined    = (homeXG || 0) + (awayXG || 0);
    const isVulnerable = homeSquadH < 90 || awaySquadH < 90;
    const isOpen      = combined > 2.60 || (combined > 2.10 && isVulnerable);
    let prob = Math.min(95, Math.max(10, (combined / 4.5) * 100 + (isVulnerable ? 15 : 0)));
    return { status: isOpen ? '🟢 OPEN' : '🔴 TIGHT', prob: Math.round(prob), isOpen };
};

export const determineIdealPick = (openMatch, homeSquadH, awaySquadH, winProb, homeXG, awayXG) => {
    const picks = [];

    // 1. Primary Pick (Main Strategy)
    if (openMatch.isOpen && homeXG > 1.1 && awayXG > 1.1) {
        picks.push({ pick: 'Over 2.5 + BTTS', logic: 'High combined xG and defensive gaps detected on both sides.' });
    } else if (!openMatch.isOpen && (homeXG + awayXG) < 1.9) {
        picks.push({ pick: 'Under 2.5 Goals', logic: 'Low xG totals and tight defensive structures expected.' });
    } else if (winProb > 55) {
        picks.push({ pick: 'Home Draw No Bet', logic: 'Defensive safety while backing the favorable home trend.' });
    } else if (winProb < 45) {
        picks.push({ pick: 'Away Draw No Bet', logic: 'Securing the away advantage with draw protection.' });
    } else {
        picks.push({ pick: 'Under 3.5 Goals', logic: 'Strategic coverage for a tight tactical stalemate.' });
    }

    // 2. Secondary Pick (Handicap / Market Edge)
    if (homeSquadH === 100 && awaySquadH < 85 && winProb > 60) {
        picks.push({ pick: 'Handicap (-1) Home', logic: 'Elite fitness gap favoring the 100% fit home side.' });
    } else if (awaySquadH === 100 && homeSquadH < 85 && winProb < 40) {
        picks.push({ pick: 'Handicap (-1) Away', logic: 'Away side at full strength against a depleted home rotation.' });
    } else if (winProb > 55) {
        picks.push({ pick: 'Home win', logic: 'Statistical win probability favors a direct home victory.' });
    } else if (winProb < 45) {
        picks.push({ pick: 'Away win', logic: 'Model signals high confidence in away performance quality.' });
    } else {
        picks.push({ pick: 'Double Chance 12', logic: 'High volatility suggests a decisive outcome for either side.' });
    }

    // 3. Tertiary Pick (Chaos / Volatility Hedging)
    if (homeXG > 1.5 || awayXG > 1.5) {
        picks.push({ pick: 'Over 1.5 Team Goals', logic: 'High individual team xG suggests consistent scoring potential.' });
    } else if (homeSquadH < 90 && awaySquadH < 90) {
        picks.push({ pick: 'Both Teams to Score', logic: 'Mutual defensive vulnerabilities from squad rotation.' });
    } else {
        picks.push({ pick: 'Under 2.5 Goals', logic: 'Conservative start expected due to mutual tactical respect.' });
    }

    return picks.slice(0, 3);
};

import React from 'react';
import './MatchCard.css';

const normalizePct = (v) => {
    const n = Number(v || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1 ? Math.round(n) : Math.round(n * 100);
};

const MatchCard = ({ match, isElite, onClick, style, now }) => {
    const enriched = match.enriched || {};
    const hPct = parseFloat(match.home_win_probability || enriched.home_win_probability || 0);
    const aPct = parseFloat(match.away_win_probability || enriched.away_win_probability || 0);
    const dPct = parseFloat(match.draw_probability || enriched.draw_probability || 0);
    const quantObj = match.quant || enriched?.quant || {};
    const mainPick = (quantObj.main_pick || '').toString().trim().toUpperCase();
    const bttsPct = normalizePct(quantObj.probs?.btts || match.btts_prob || enriched?.btts_prob || 0);
    const over25Pct = normalizePct(quantObj.probs?.over25 || match.ou_25_prob || enriched?.ou_25_prob || 0);
    const htGoalPct = Math.min(89, Math.round((over25Pct + bttsPct) / 2 + 5));
    const evScore = quantObj.ev_score || '0.00';
    const riskLabel = quantObj.risk_label || match.risk_label || 'BALANCE';
    const marketStrength = quantObj.market_strength || 'NORMAL';
    const rawAcc = match.v22_success_rate || match.enriched?.v22_success_rate || match.confidence;
    let acc;
    if (rawAcc && rawAcc > 0) {
        let base = rawAcc > 1 ? rawAcc : Math.round(rawAcc * 100);
        if (match.insufficient_data === 1) base = Math.min(base, 64);
        acc = Math.round(base);
    } else {
        const best = Math.max(hPct, aPct, dPct);
        acc = best > 1 ? Math.round(best) : Math.round(best * 100);
        if (match.insufficient_data === 1) acc = Math.min(acc, 64);
        if (acc === 0) acc = 50;
    }
    acc = Math.max(1, Math.min(99, acc));

    const displayOddsH = match.display_odds_home || match.best_odds_home || match.odds_home;
    const displayOddsA = match.display_odds_away || match.best_odds_away || match.odds_away;
    const mainOdds = (() => {
        const p = mainPick;
        if (p === '1' || p === 'HOME') return displayOddsH;
        if (p === '2' || p === 'AWAY') return displayOddsA;
        if (p === 'X' || p === 'DRAW') return match.odds_draw;
        return null;
    })();

    const mainPickProb = (() => {
        if (mainPick === '1' || mainPick === 'HOME') return hPct / 100;
        if (mainPick === '2' || mainPick === 'AWAY') return aPct / 100;
        if (mainPick === 'X' || mainPick === 'DRAW') return dPct / 100;
        if (mainPick === '12') return (hPct + aPct) / 100;
        if (mainPick === '1X') return (hPct + dPct) / 100;
        if (mainPick === 'X2') return (aPct + dPct) / 100;
        return acc / 100;
    })();
    const edge = mainOdds ? (mainPickProb - (1 / mainOdds)) : 0;
    const edgePct = (edge * 100).toFixed(1);

    const getRiskClass = (risk) => {
        const r = (risk || '').toUpperCase();
        if (r.includes('SPÉCULATIF') || r.includes('SPECULATIF') || r.includes('RISQUÉ')) return 'risk-speculative';
        if (r.includes('MODÉRÉ') || r.includes('MODERE') || r.includes('MOYEN')) return 'risk-moderate';
        if (r.includes('FAIBLE') || r.includes('LOW')) return 'risk-low';
        return 'risk-balance';
    };

    const cs = (() => {
        const qs = quantObj.expected_score;
        if (qs && qs.includes('-')) return qs;
        const es = match.expected_score || enriched.expected_score;
        if (es && es.includes('-')) return es;
        return '? - ?';
    })();

    let formattedTime = '';
    if (match.startTimestamp) {
        const d = new Date(match.startTimestamp > 1e11 ? match.startTimestamp : match.startTimestamp * 1000);
        formattedTime = d.toLocaleTimeString('fr-TN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Tunis' });
    }

    return (
        <div
            className={`titanium-clean-card ${isElite ? 'elite' : ''}`}
            style={style}
            onClick={() => onClick(match)}
        >
            <div className="card-top-bar">
                <span className="status-indicator">
                    <span className="pulse-dot"></span> {match.status || 'SCHEDULED'} {formattedTime}
                </span>
                <span className="league-title">⚽ {match.league || match.tournament_name || 'N/A'}</span>
            </div>

            <div className="versus-display">
                <div className="team-name text-left">{(match.homeTeam || 'N/A').toUpperCase()}</div>
                <div className="vs-badge">VS</div>
                <div className="team-name text-right">{(match.awayTeam || 'N/A').toUpperCase()}</div>
            </div>

            <div className="independent-grids">
                <div className="grid-cell main-market">
                    <div className="cell-label">PRONOSTIC (1X2)</div>
                    <div className="cell-value">{mainPick}</div>
                    <div className="cell-sub">
                        {acc}% CONFIRMATION
                        {mainOdds && <span style={{color:'#fbbf24', marginLeft:'4px'}}>@{mainOdds.toFixed(2)}</span>}
                    </div>
                    {edge > 0 && <div className="cell-edge">🎯 +{edgePct}%</div>}
                    {edge <= 0 && <div className="cell-edge warn">⚠️ {edgePct}%</div>}
                </div>

                <div className="grid-cell">
                    <div className="cell-label">VALEUR INDEX (EV)</div>
                    <div className="cell-value color-green">{evScore}</div>
                    <div className="cell-sub">MOTEUR: NEURAL-X</div>
                </div>

                <div className="grid-cell">
                    <div className="cell-label">BTTS (OUI/NON)</div>
                    <div className="cell-value">{bttsPct}%</div>
                    <div className="cell-sub">MARKET SENSOR</div>
                </div>

                <div className="grid-cell">
                    <div className="cell-label">OVER / UNDER 2.5</div>
                    <div className="cell-value">{over25Pct}%</div>
                    <div className="cell-sub">PRECISION RATE</div>
                </div>

                <div className="grid-cell">
                    <div className="cell-label">MI-TEMPS (HT +0.5)</div>
                    <div className="cell-value">{htGoalPct}%</div>
                    <div className="cell-sub">PROBABILITÉ</div>
                </div>

                <div className={`grid-cell ${getRiskClass(riskLabel)}`}>
                    <div className="cell-label">GESTION DES RISQUES</div>
                    <div className="cell-value-small">{riskLabel.toUpperCase()}</div>
                    <div className="cell-sub">FORCE: {marketStrength}</div>
                </div>
            </div>
        </div>
    );
};

export default React.memo(MatchCard);

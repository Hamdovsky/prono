import React, { useMemo } from 'react';

const PerformanceHub = ({ matches }) => {
    const stats = useMemo(() => {
        const finished = matches.filter(m => 
            m.status === 'finished' || m.status === 'ft' || 
            (m.scoreHome !== null && m.scoreAway !== null)
        );

        if (finished.length === 0) return null;

        let wins = 0;
        let totalProfit = 0;
        const leagueStats = {};

        let verifiableCount = 0;

        finished.forEach(m => {
            const hRaw = m.scoreHome !== undefined ? m.scoreHome : m.score?.home;
            const aRaw = m.scoreAway !== undefined ? m.scoreAway : m.score?.away;
            
            if (hRaw === null || hRaw === undefined || aRaw === null || aRaw === undefined) return;
            
            const h = Number(hRaw);
            const a = Number(aRaw);
            if (isNaN(h) || isNaN(a)) return;
            
            const total = h + a;
            
            let pick = String(m.prediction || "").toLowerCase();
            let isVerifiable = true;
            let isWin = false;

            // 1. Filter out known non-actionable or unverifiable predictions
            if (
                pick.includes('risky bet') || 
                pick.includes('skip') || 
                pick.includes('no bet') || 
                pick.includes('البطاقات') || 
                pick.includes('cards') || 
                pick.includes('corner') ||
                pick === 'null' ||
                pick === 'undefined' ||
                pick === ''
            ) {
                // If text prediction is missing or garbage, try to fall back to probabilities
                const extractProb = (val) => {
                    if (!val) return 0;
                    if (typeof val === 'number') return val;
                    const parsed = parseFloat(String(val).replace('%', ''));
                    return isNaN(parsed) ? 0 : parsed;
                };

                let enriched = m.enriched;
                if (typeof enriched === 'string') {
                    try { enriched = JSON.parse(enriched); } catch (e) { enriched = {}; }
                }

                const hPct = extractProb(m.home_win_probability || enriched?.winnerProbability || 0);
                const aPct = extractProb(m.away_win_probability || 0);
                const pBTTS = extractProb(m.btts_prob || enriched?.btts_prob || 0);
                const pOU25 = extractProb(m.ou_25_prob || enriched?.ou_25_prob || 0);

                if (pOU25 > 65) { pick = 'over25'; }
                else if (pBTTS > 65) { pick = 'btts'; }
                else if (hPct > aPct && hPct > 50) { pick = 'home'; }
                else if (aPct > hPct && aPct > 50) { pick = 'away'; }
                else if (pOU25 <= 40 && pBTTS <= 40) { pick = 'under25'; }
                else {
                    isVerifiable = false; // Cannot derive a reliable pick
                }
            }

            if (isVerifiable) {
                if (pick.includes('home') || pick.includes('dom') || pick === '1' || pick.includes(' 1 ')) isWin = h > a;
                else if (pick.includes('away') || pick.includes('ext') || pick === '2' || pick.includes(' 2 ')) isWin = a > h;
                else if (pick.includes('draw') || pick.includes('nul') || pick === 'x' || pick.includes(' x ')) isWin = h === a;
                else if (pick.includes('+1.5') || pick.includes('over 1.5')) isWin = total > 1.5;
                else if (pick.includes('-1.5') || pick.includes('under 1.5')) isWin = total < 1.5;
                else if (pick.includes('+2.5') || pick.includes('over 2.5') || pick === 'over25') isWin = total > 2.5;
                else if (pick.includes('-2.5') || pick.includes('under 2.5') || pick === 'under25') isWin = total < 2.5;
                else if (pick.includes('+3.5') || pick.includes('over 3.5')) isWin = total > 3.5;
                else if (pick.includes('-3.5') || pick.includes('under 3.5')) isWin = total < 3.5;
                else if (pick.includes('btts') || pick.includes('marquent') || pick.includes('oui')) isWin = h > 0 && a > 0;
                else isVerifiable = false;
            }

            if (isVerifiable) {
                verifiableCount++;
                if (isWin) {
                    wins++;
                    totalProfit += 0.85; // Assume average odds of 1.85 for ROI
                } else {
                    totalProfit -= 1;
                }

                // Track league performance
                const league = m.league || 'Unknown';
                if (!leagueStats[league]) leagueStats[league] = { total: 0, wins: 0 };
                leagueStats[league].total++;
                if (isWin) leagueStats[league].wins++;
            }
        });

        const winRate = verifiableCount > 0 ? Math.round((wins / verifiableCount) * 100) : 0;
        const roi = verifiableCount > 0 ? Math.round((totalProfit / verifiableCount) * 100) : 0;
        
        const bestLeague = Object.entries(leagueStats)
            .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))[0];

        return {
            total: verifiableCount,
            wins,
            winRate,
            roi,
            bestLeague: bestLeague ? bestLeague[0] : 'N/A',
            profitUnits: totalProfit.toFixed(2)
        };
    }, [matches]);

    if (!stats) return (
        <div style={{
            padding: '20px',
            background: 'rgba(30, 41, 59, 0.4)',
            borderRadius: '12px',
            border: '1px dashed rgba(255,255,255,0.1)',
            textAlign: 'center',
            marginBottom: '20px'
        }}>
            <span style={{color: '#64748b', fontSize: '13px'}}>📊 HUB DE PERFORMANCE : Analyse des résultats en attente...</span>
        </div>
    );

    const isPositive = stats.roi >= 0;

    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '15px',
            marginBottom: '25px'
        }}>
            {/* ROI CARD */}
            <div className="onyx-stat-card" style={{
                background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.9) 0%, rgba(30, 41, 59, 0.8) 100%)',
                padding: '20px',
                borderRadius: '12px',
                border: `1px solid ${isPositive ? 'rgba(0, 255, 170, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                boxShadow: '0 4px 15px rgba(0,0,0,0.3)'
            }}>
                <span style={{color: '#64748b', fontSize: '10px', fontWeight: '900', letterSpacing: '1px'}}>PROFIT NET / ROI</span>
                <div style={{fontSize: '28px', fontWeight: '900', color: isPositive ? '#00ffaa' : '#ef4444', marginTop: '5px'}}>
                    {isPositive ? '+' : ''}{stats.roi}%
                </div>
                <div style={{fontSize: '11px', color: '#94a3b8', marginTop: '4px'}}>
                    {stats.profitUnits} Unités gagnées
                </div>
            </div>

            {/* WINRATE CARD */}
            <div className="onyx-stat-card" style={{
                background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.9) 0%, rgba(30, 41, 59, 0.8) 100%)',
                padding: '20px',
                borderRadius: '12px',
                border: '1px solid rgba(251, 191, 36, 0.2)',
                boxShadow: '0 4px 15px rgba(0,0,0,0.3)'
            }}>
                <span style={{color: '#64748b', fontSize: '10px', fontWeight: '900', letterSpacing: '1px'}}>TAUX DE RÉUSSITE</span>
                <div style={{fontSize: '28px', fontWeight: '900', color: '#fbbf24', marginTop: '5px'}}>
                    {stats.winRate}%
                </div>
                <div style={{fontSize: '11px', color: '#94a3b8', marginTop: '4px'}}>
                    {stats.wins} GAGNÉS / {stats.total} MATCHS
                </div>
            </div>

            {/* BEST LEAGUE CARD */}
            <div className="onyx-stat-card" style={{
                background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.9) 0%, rgba(30, 41, 59, 0.8) 100%)',
                padding: '20px',
                borderRadius: '12px',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                boxShadow: '0 4px 15px rgba(0,0,0,0.3)'
            }}>
                <span style={{color: '#64748b', fontSize: '10px', fontWeight: '900', letterSpacing: '1px'}}>MEILLEUR CHAMPIONNAT</span>
                <div style={{fontSize: '16px', fontWeight: '900', color: '#38bdf8', marginTop: '10px', textTransform: 'uppercase'}}>
                    🏆 {stats.bestLeague}
                </div>
                <div style={{fontSize: '11px', color: '#94a3b8', marginTop: '8px'}}>
                    Performance maximale détectée
                </div>
            </div>

            {/* AI CONFIDENCE AVG */}
            <div className="onyx-stat-card" style={{
                background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.9) 0%, rgba(30, 41, 59, 0.8) 100%)',
                padding: '20px',
                borderRadius: '12px',
                border: '1px solid rgba(168, 85, 247, 0.2)',
                boxShadow: '0 4px 15px rgba(0,0,0,0.3)'
            }}>
                <span style={{color: '#64748b', fontSize: '10px', fontWeight: '900', letterSpacing: '1px'}}>CONFIANCE IA MOYENNE</span>
                <div style={{fontSize: '28px', fontWeight: '900', color: '#a855f7', marginTop: '5px'}}>
                    {Math.round(matches.reduce((acc, m) => acc + (m.v22_success_rate || m.confidence || 0), 0) / (matches.length || 1))}%
                </div>
                <div style={{fontSize: '11px', color: '#94a3b8', marginTop: '4px'}}>
                    Force du moteur neural
                </div>
            </div>
        </div>
    );
};

export default PerformanceHub;

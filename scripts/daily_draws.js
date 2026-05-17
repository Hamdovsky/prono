/**
 * كاشف التعادلات الذكي — مبني على أنماط قاعدة التعلم
 * يستخرج أفضل 6 تعادلات من المباريات القادمة
 */
const database = require('../core/database');

function scoreMatchForDraw(m, leagueDrawRates) {
    let score = 0;
    const reasons = [];

    const dp = parseFloat(m.draw_probability || 0);
    const dpNorm = dp > 1 ? dp / 100 : dp;
    const oddsX = parseFloat(m.odds_draw || 0);
    const hp = parseFloat(m.home_win_probability || 0);
    const ap = parseFloat(m.away_win_probability || 0);
    const league = m.league || '';

    // 1️⃣ Model Draw Probability
    if (dpNorm >= 0.35) { score += 30; reasons.push(`Probabilité de Nul élevée (${(dpNorm*100).toFixed(0)}%)`); }
    else if (dpNorm >= 0.28) { score += 18; reasons.push(`Probabilité de Nul modérée (${(dpNorm*100).toFixed(0)}%)`); }
    else if (dpNorm >= 0.22) { score += 8; reasons.push(`Probabilité de Nul viable (${(dpNorm*100).toFixed(0)}%)`); }

    // 2️⃣ Power Balance
    const hpNorm = hp > 1 ? hp / 100 : hp;
    const apNorm = ap > 1 ? ap / 100 : ap;
    const balance = Math.abs(hpNorm - apNorm);
    if (balance < 0.08) { score += 25; reasons.push('Équilibre de force parfait'); }
    else if (balance < 0.15) { score += 15; reasons.push('Très bon équilibre des forces'); }
    else if (balance < 0.25) { score += 5; }

    // 3️⃣ High Draw League
    for (const [leagueName, data] of Object.entries(leagueDrawRates)) {
        if (league.toLowerCase().includes(leagueName.toLowerCase().substring(0, 15))) {
            if (data.rate >= 0.35) { score += 20; reasons.push(`Ligue très propice aux nuls (${(data.rate*100).toFixed(0)}%)`); }
            else if (data.rate >= 0.28) { score += 12; reasons.push(`Ligue propice aux nuls (${(data.rate*100).toFixed(0)}%)`); }
            break;
        }
    }

    // 4️⃣ Missing Stars
    if (m.is_missing_star == 1 || m.is_missing_scorer == 1) {
        score += 12;
        reasons.push('Absence(s) majeure(s) favorisant un match fermé');
    }

    // 5️⃣ Smart Odds vs League Average
    let leagueData = null;
    for (const [leagueName, data] of Object.entries(leagueDrawRates)) {
        if (league.toLowerCase().includes(leagueName.toLowerCase().substring(0, 15))) {
            leagueData = data;
            break;
        }
    }

    const avgLeagueOdds = leagueData?.avgOdds || 3.10;
    const oddsDiff = oddsX - avgLeagueOdds;

    if (oddsDiff >= -0.2 && oddsDiff <= 0.4) {
        score += 18;
        reasons.push(`Cote alignée avec la moyenne ligue (${avgLeagueOdds.toFixed(2)})`);
    } else if (oddsDiff > 0.4 && oddsDiff <= 1.0) {
        score += 8;
        reasons.push(`Cote X attractive (Valeur perçue: ${oddsX.toFixed(2)})`);
    } else if (oddsDiff < -0.2) {
        score -= 5;
        reasons.push('Cote X basse (Méfiance des bookmakers)');
    }

    // 6️⃣ Under 2.5 bias
    const ou = parseFloat(m.ou_25_prob || 0.5);
    if (ou < 0.40) { score += 12; reasons.push(`Forte tendance Under 2.5 (${((1-ou)*100).toFixed(0)}%)`); }
    else if (ou < 0.50) { score += 6; }

    // 7️⃣ Derby/Cup Pressure
    if (m.is_high_pressure == 1) {
        score += 8;
        reasons.push('Contexte Haute Pression (Derby/Coupe)');
    }

    // 8️⃣ Chaos Score
    const chaos = parseFloat(m.chaos_score || 50);
    if (chaos < 25) { score += 15; reasons.push('Indice de Chaos très faible (Match verrouillé)'); }
    else if (chaos < 35) { score += 8; reasons.push('Indice de Chaos modéré (Match stable)'); }
    else if (chaos > 60) { score -= 10; reasons.push('Indice de Chaos élevé (Risque de buts tardifs)'); }

    // 9️⃣ Expected Score
    const es = (m.expected_score || '');
    if (/^1\s*[-–]\s*1|^0\s*[-–]\s*0|^1\s*[-–]\s*0$|^0\s*[-–]\s*1$/.test(es)) {
        score += 10;
        reasons.push(`Score projeté par l'IA: ${es}`);
    }

    // 🔟 Expected Value (EV)
    if (oddsX > 0 && dpNorm > 0) {
        const ev = (dpNorm * oddsX) - 1;
        if (ev > 0.15) { score += 15; reasons.push(`Value Bet détecté (EV: +${(ev*100).toFixed(0)}%)`); }
        else if (ev > 0.05) { score += 8; reasons.push(`Léger Value Bet (EV: +${(ev*100).toFixed(0)}%)`); }
    }

    // Normalize score to max ~100
    score = Math.min(score, 100);

    return { score, reasons };
}

/**
 * الدالة الرئيسية — تُستدعى من route أو CLI
 */
function getDailyDraws() {
    const db = database.db;

    // جلب معدلات التعادل لكل دوري
    const leagueDrawRates = {};
    try {
        const rows = db.prepare(`
            SELECT league,
                   COUNT(*) as total,
                   SUM(CASE WHEN actual = 'D' THEN 1 ELSE 0 END) as draws,
                   ROUND(SUM(CASE WHEN actual = 'D' THEN 1.0 ELSE 0 END) / COUNT(*), 3) as draw_rate,
                   AVG(CAST(odds_draw AS FLOAT)) as avg_draw_odds
            FROM learning_memory
            WHERE actual IS NOT NULL AND odds_draw IS NOT NULL AND odds_draw > 2
            GROUP BY league
            HAVING total >= 15
        `).all();
        rows.forEach(r => leagueDrawRates[r.league] = { 
            rate: r.draw_rate, 
            total: r.total, 
            draws: r.draws,
            avgOdds: r.avg_draw_odds 
        });
    } catch(e) {}

    // جلب المباريات القادمة
    const upcoming = db.prepare(`
        SELECT id, homeTeam, awayTeam, league, timestamp,
               home_win_probability, draw_probability, away_win_probability,
               odds_home, odds_draw, odds_away,
               expected_score, ou_25_prob, btts_prob,
               chaos_score,
               is_missing_star, is_missing_scorer, is_high_pressure
        FROM matches
        WHERE status IN ('scheduled', 'NOT_STARTED', 'NS')
        AND source = 'sofascore'
        ORDER BY timestamp ASC
        LIMIT 300
    `).all();

    // تسجيل النقاط وترتيب
    const candidates = upcoming
        .map(m => {
            const { score, reasons } = scoreMatchForDraw(m, leagueDrawRates);
            return { ...m, drawScore: score, drawReasons: reasons };
        })
        .filter(m => m.drawScore >= 25)
        .sort((a, b) => b.drawScore - a.drawScore)
        .slice(0, 6);

    return candidates;
}

// ── CLI mode (node scripts/daily_draws.js) ─────────────────────────────────
if (require.main === module) {
    const candidates = getDailyDraws();
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║     🎯 TITANIUM — أفضل 6 تعادلات                        ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    if (candidates.length === 0) {
        console.log('⚠️ لا توجد مباريات. شغّل السكرابر أولاً.');
    } else {
        candidates.forEach((m, i) => {
            const dpN = parseFloat(m.draw_probability || 0);
            const dpDisp = dpN > 1 ? dpN.toFixed(1) : (dpN * 100).toFixed(1);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`${i+1}. ⚽ ${m.homeTeam} vs ${m.awayTeam}`);
            console.log(`   🏆 ${m.league} | 🎯 ${m.drawScore}/100 | 📊 ${dpDisp}% | X=${m.odds_draw || 'N/A'}`);
            m.drawReasons.forEach(r => console.log(`      ✅ ${r}`));
        });
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    }
}

module.exports = { getDailyDraws };

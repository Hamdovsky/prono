const Database = require('better-sqlite3');
const path = require('path');
const axios = require('axios');

// 🛡️ CONFIGURATION TITANIUM
const BOT_TOKEN = '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';
const CHAT_ID = '5637790630'; // Default Chat ID
const dbPath = path.join(__dirname, '..', 'data', 'tactical.db');

// ── Poisson Engine ──────────────────────────────────────────────────────────
function poissonProb(lambda, k) {
    if (k < 0) return 0;
    if (lambda <= 0) return k === 0 ? 1.0 : 0.0;
    let logP = -lambda + k * Math.log(lambda);
    for (let i = 2; i <= k; i++) logP -= Math.log(i);
    return Math.exp(logP);
}

/**
 * احتمال أكثر من 1.5 هدف في الشوط الأول باستخدام Poisson ومعدل التأثير التكتيكي
 * htLambda = 45% من إجمالي xG (الشوط الأول ينتج متوسط 45% من الأهداف)
 * ✅ Over 1.5 HT — الحد الأدنى المتاح عند جميع الـ bookmakers (ليس 0.5)
 */
// 🧠 TACTICAL IMPACT UPGRADE: Integre la force d'attaque vs vulnérabilité défensive
function computeHT15Prob(hXG, aXG, hAtt = 1.0, aDef = 1.0, aAtt = 1.0, hDef = 1.0) {
    const adjH = Math.max(0.3, hXG * (hAtt * aDef) * 1.08); // Home advantage + Tactical matchup
    const adjA = Math.max(0.3, aXG * (aAtt * hDef));
    const htLambda = (adjH + adjA) * 0.45;
    const p0 = poissonProb(htLambda, 0);
    const p1 = poissonProb(htLambda, 1);
    return Math.round(Math.max(0, (1 - p0 - p1)) * 100); // P(HT goals >= 2)
}

// ── Motivation Filter ────────────────────────────────────────────────────────
function analyzeMotivation(m) {
    const result = {
        homeRisk: 'UNKNOWN',
        awayRisk: 'UNKNOWN',
        globalRisk: 'SAFE',
        riskScore: 0,
        signatures: [],
        verdict: 'SAFE',
        reason: ''
    };

    let sig = m.motivation_signature || '';
    try {
        if (!sig && m.fullData) {
            const fd = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData;
            sig = fd.motivation_signature || '';
        }
    } catch (_) {}

    let homeStanding = null, awayStanding = null;
    let totalTeams = 20;
    try {
        const hc = m.historical_context
            ? (typeof m.historical_context === 'string' ? JSON.parse(m.historical_context) : m.historical_context)
            : null;
        if (hc) {
            homeStanding = hc.standing || null;
            awayStanding = hc.standing_away || null;
            totalTeams = Math.max(totalTeams, homeStanding?.position || 0, awayStanding?.position || 0);
        }
    } catch (_) {}

    function assessTeamMotivation(standing, teamName) {
        if (!standing) return { risk: 'UNKNOWN', reasons: [] };

        const pos = standing.position || 0;
        const pts = standing.points || 0;
        const played = standing.matches || standing.played || 30;
        const reasons = [];

        const relegZone = totalTeams - 2;
        const titleZone = 4;
        const safeBottom = relegZone - 3;

        if (pos === 1 && played >= 32) return { risk: 'HIGH_RISK', reasons: ['CHAMPION_ASSURE'] };
        if (pos >= relegZone && played >= 32) return { risk: 'HIGH_RISK', reasons: ['RELEGUE_ASSURE'] };

        if (pos > titleZone && pos < safeBottom && played >= 25) {
            const ptsFromRelegation = pts - (standing.relegationPoints || 0);
            const ptsFromTitle = (standing.leaderPoints || pts + 20) - pts;
            if (ptsFromRelegation > 12 && ptsFromTitle > 15) {
                return { risk: 'CAUTION', reasons: ['ZONE_MORTE'] };
            }
        }

        if (pos <= titleZone || pos >= safeBottom) return { risk: 'SAFE', reasons: ['ENJEU_CRITIQUE'] };

        return { risk: 'SAFE', reasons: [] };
    }

    const homeAssess = assessTeamMotivation(homeStanding, m.homeTeam);
    const awayAssess = assessTeamMotivation(awayStanding, m.awayTeam);
    result.homeRisk = homeAssess.risk;
    result.awayRisk = awayAssess.risk;
    result.signatures.push(...homeAssess.reasons, ...awayAssess.reasons);

    const sigUpper = sig.toUpperCase();
    if (sigUpper.includes('COMPLAISANCE')) { result.signatures.push('COMPLAISANCE'); result.riskScore = Math.max(result.riskScore, 80); }
    if (sigUpper.includes('ZONE MORTE')) { result.signatures.push('ZONE_MORTE_DB'); result.riskScore = Math.max(result.riskScore, 55); }
    if (sigUpper.includes('CHAMPION')) { result.signatures.push('CHAMPION_DB'); result.riskScore = Math.max(result.riskScore, 70); }
    if (sigUpper.includes('RELEGUE')) { result.signatures.push('RELEGUE_DB'); result.riskScore = Math.max(result.riskScore, 70); }
    if (sigUpper.includes('ENJEU CRITIQUE')) { result.riskScore = Math.min(result.riskScore, 10); result.signatures.push('ENJEU_CRITIQUE_DB'); }

    const riskMap = { 'HIGH_RISK': 70, 'CAUTION': 40, 'SAFE': 0, 'UNKNOWN': 15 };
    const baseScore = Math.max(riskMap[homeAssess.risk] || 0, riskMap[awayAssess.risk] || 0);
    result.riskScore = Math.max(result.riskScore, baseScore);

    if (homeAssess.risk === 'HIGH_RISK' && awayAssess.risk === 'HIGH_RISK') result.riskScore = 95;
    if (homeAssess.risk !== 'SAFE' && awayAssess.risk !== 'SAFE' && homeAssess.risk !== 'UNKNOWN' && awayAssess.risk !== 'UNKNOWN') result.riskScore = Math.max(result.riskScore, 75);

    if (result.riskScore >= 80) result.verdict = 'SKIP';
    else if (result.riskScore >= 55) result.verdict = 'HIGH_RISK';
    else if (result.riskScore >= 30) result.verdict = 'CAUTION';
    else result.verdict = 'SAFE';

    // ── Traduction et Formatage "نوع الدافع" ───────────────────────────────
    const dict = {
        'ZONE_MORTE': 'منطقة ميتة (غياب الطموح)',
        'ZONE_MORTE_DB': 'منطقة ميتة (غياب الطموح)',
        'CHAMPION_ASSURE': 'بطل الدوري (تراخي محتمل)',
        'CHAMPION_DB': 'بطل الدوري (تراخي محتمل)',
        'RELEGUE_ASSURE': 'هبوط مؤكد (فقدان الأمل)',
        'RELEGUE_DB': 'هبوط مؤكد (فقدان الأمل)',
        'COMPLAISANCE': 'تراخي أو تهاون محتمل (مخاطرة)',
        'ENJEU_CRITIQUE': 'دافع قوي (صراع صدارة/بقاء)',
        'ENJEU_CRITIQUE_DB': 'دافع قوي (صراع صدارة/بقاء)'
    };

    const uniqueSigs = [...new Set(result.signatures)];
    if (uniqueSigs.length > 0) {
        const labels = uniqueSigs.map(s => dict[s] || s);
        result.reason = `نوع الدافع: ${labels.join(' + ')}`;
    } else {
        result.reason = 'نوع الدافع: تنافس طبيعي (قياسي)';
    }

    return result;
}

async function runSurgicalAnalysis() {
    const db = new Database(dbPath, { readonly: true });
    
    console.log("\n" + "=".repeat(60));
    console.log("🩺  TITANIUM SURGICAL ENGINE - DAILY DEEP DIVE  🩺");
    console.log("=".repeat(60) + "\n");

    try {
        // 1. Fetch all upcoming matches for today
        // We use a simplified check for today's matches
        const matches = db.prepare(`
            SELECT * FROM matches 
            WHERE (date(datetime(startTimestamp, 'unixepoch')) >= date('now')
               AND date(datetime(startTimestamp, 'unixepoch')) <= date('now', '+1 day'))
            AND status IN ('scheduled', 'NOT_STARTED', 'NS')
            ORDER BY home_win_probability DESC
        `).all();

        if (matches.length === 0) {
            console.log("⚠️ Aucun match trouvé pour aujourd'hui dans la base de données.");
            return;
        }

        console.log(`🔍 Analyse chirurgicale de ${matches.length} matchs...`);

        const reports = matches.map(m => {
            const pH = m.home_win_probability || 33;
            const pD = m.draw_probability || 33;
            const pA = m.away_win_probability || 33;
            const pOU25 = m.ou_25_prob || 50;
            const pBTTS = m.btts_prob || 50;
            
            // Extraction des métriques d'impact tactique (défaut à 1.0 si absentes)
            const hAtt = parseFloat(m.home_attack_impact)  || 1.0;
            const aDef = parseFloat(m.away_defense_impact) || 1.0;
            const aAtt = parseFloat(m.away_attack_impact)  || 1.0;
            const hDef = parseFloat(m.home_defense_impact) || 1.0;

            const hXG = parseFloat(m.home_xg) || (pOU25 / 100) * 1.4;
            const aXG = parseFloat(m.away_xg) || (pOU25 / 100) * 1.1;
            const pHT15 = computeHT15Prob(hXG, aXG, hAtt, aDef, aAtt, hDef);
            
            // 🛑 ZERO-FAILURE VETO: Only elite surgical picks are allowed
            const confidence = m.confidence || (m.xgboost_confidence ? m.xgboost_confidence * 100 : 0);
            const verdict = (m.verdict || '').toUpperCase();
            
            if (confidence < 70 || verdict.includes('NO BET') || verdict.includes('SHIELDED')) {
                return null; 
            }
            
            const dnbH = m.dnb_h || (pH / (pH + pA)) * 100;
            const dnbA = m.dnb_a || (pA / (pH + pA)) * 100;

            const markets = [
                { type: '1X2',     prob: Math.max(pH, pA), label: pH > pA ? (pH > 65 ? `🔥 هيمنة ${m.homeTeam}` : `فوز ${m.homeTeam}`) : (pA > 65 ? `🔥 هيمنة ${m.awayTeam}` : `فوز ${m.awayTeam}`) },
                { type: 'AH',      prob: Math.max(pH, pA) * 0.9, label: pH > pA ? `AH -0.5 ${m.homeTeam}` : `AH -0.5 ${m.awayTeam}` },
                { type: 'DNB',     prob: Math.max(dnbH, dnbA), label: dnbH > dnbA ? `DNB ${m.homeTeam}` : `DNB ${m.awayTeam}` },
                { type: 'BTTS',    prob: pBTTS,            label: 'كلا الفريقين يسجل (BTTS)' },
                { type: 'Over2.5', prob: pOU25,            label: 'أكثر من 2.5 هدف' },
                { type: 'HT_O15', prob: pHT15,            label: `⚡ أكثر من 1.5 هدف في الشوط الأول (HT Over 1.5)` }
            ];

            // Filter out low probability markets
            const validMarkets = markets.filter(mk => mk.prob > 45);
            validMarkets.sort((a, b) => b.prob - a.prob);

            const strongest = validMarkets[0] || markets[0];
            const fallback = validMarkets[1] || markets[1];

            const motiv = analyzeMotivation(m);

            return {
                id: m.id,
                match: `${m.homeTeam} vs ${m.awayTeam}`,
                league: m.tournament_name || m.league,
                strongest: strongest,
                fallback: fallback,
                confidence: Math.round(strongest.prob),
                isPromosport: (m.tournament_name === 'Promosport' || m.league === 'Promosport'),
                motiv: motiv,
                timestamp: m.startTimestamp || m.timestamp,
                twin_match_verdict: m.twin_match_verdict,
                v22_success_rate: m.v22_success_rate,
                verdict: m.verdict
            };
        });

        // Filtrer les null (Veto) et les matchs "SKIP" (sans ambition pour le championnat)
        const filteredReports = reports.filter(r => r !== null && (r.motiv.verdict !== 'SKIP' || r.isPromosport));
        console.log(`🧠 Motivation Filter: Supprimé ${reports.length - filteredReports.length} matchs sans enjeu (Promosport préservé).`);
        
        // 3. Separate Millionaire Selection (Surgical Strikes)
        const millionairePicks = filteredReports.filter(r => 
            (r.verdict && r.verdict.includes('SURGICAL')) || 
            r.confidence >= 88
        ).slice(0, 3);

        // 4. Format and Dispatch to Telegram
        const chunkSize = 15;
        for (let i = 0; i < filteredReports.length; i += chunkSize) {
            const chunk = filteredReports.slice(i, i + chunkSize);
            let message = `🩺 *TITANIUM SURGICAL REPORT - DAILY DEEP DIVE*\n`;
            message += `📅 Date: ${new Date().toLocaleDateString()}\n`;
            
            if (i === 0 && millionairePicks.length > 0) {
                message += `\n💎 *💎 MILLIONAIRE SELECTION (ULTRA SAFE) 💎*\n`;
                message += `_أقوى التوقعات المختارة بعناية للمحترفين_\n`;
                millionairePicks.forEach(p => {
                    message += `🔥 *${p.match}* → *${p.strongest.label}* (${p.confidence}%)\n`;
                });
                message += `───────────────────────\n\n`;
            }

            message += `📊 Bloc: ${Math.floor(i/chunkSize) + 1}\n\n`;

            chunk.forEach(r => {
                if (r.isPromosport) {
                    message += `🏛️ *${r.match}* (Promosport)\n`;
                    message += `🎯 التوقع: *${r.strongest.label}* | 🔒 الثقة: ${r.confidence}%\n\n`;
                } else {
                    const motivIcons = { 'SAFE': '🟢', 'CAUTION': '🟡', 'HIGH_RISK': '🔴', 'SKIP': '⛔' };
                    const twinDNA = r.twin_match_verdict || "N/A";
                    const dnaIcon = twinDNA.includes('favors') ? '🧬' : '⚪';

                    const matchDate = new Date(r.timestamp * 1000);
                    const tunisiaTime = matchDate.toLocaleTimeString('fr-TN', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Tunis' });

                    message += `⚽ *${r.match}*\n`;
                    message += `🏆 ${r.league}\n`;
                    message += `⏰ ${tunisiaTime}\n`;
                    message += `🎯 *📍 الاختيار الجراحي:* ${r.strongest.label} (${r.strongest.prob}%)\n`;
                    message += `🔄 *الخيار البديل:* ${r.fallback.label} (${r.fallback.prob}%)\n`;
                    message += `${dnaIcon} *Historical DNA:* _${twinDNA}_\n`;
                    message += `🔥 *Success Rate:* ${r.v22_success_rate || r.confidence}%\n`;
                    message += `📝 *Signature:* _${r.motiv.reason}_\n\n`;
                }
            });

            message += `🤖 _Titanium Surgical AI v2.4_`;

            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: message,
                parse_mode: 'Markdown'
            }).catch(e => console.error("Telegram Error:", e.response?.data?.description || e.message));

            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        console.log(`✅ Rapport chirurgical envoyé (${reports.length} matchs).`);

    } catch (err) {
        console.error("❌ Erreur critique:", err.message);
    } finally {
        db.close();
    }
}

runSurgicalAnalysis();

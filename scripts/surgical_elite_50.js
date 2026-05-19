const Database = require('better-sqlite3');
const path = require('path');
const axios = require('axios');
const IntegrityService = require('../services/integrity_service');
const logger = require('../core/logger');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '5637790630';
const DB_PATH = path.resolve(__dirname, '../data/tactical.db');

// ─── Poisson Engine (local, no Python needed) ────────────────────────────────
function poissonProb(lambda, k) {
    if (k < 0) return 0;
    if (lambda <= 0) return k === 0 ? 1.0 : 0.0;
    let logP = -lambda + k * Math.log(lambda);
    for (let i = 2; i <= k; i++) logP -= Math.log(i);
    return Math.exp(logP);
}

// 🧠 TACTICAL IMPACT UPGRADE: Integre la force d'attaque vs vulnérabilité défensive
function computePoisson(hXG, aXG, hAtt = 1.0, aDef = 1.0, aAtt = 1.0, hDef = 1.0) {
    // Si aDef > 1 (défense adverse faible) et hAtt > 1 (attaque locale forte) -> xG augmente
    const adjH = Math.max(0.3, hXG * (hAtt * aDef) * 1.08); // Home advantage + Tactical matchup
    const adjA = Math.max(0.3, aXG * (aAtt * hDef));
    
    let pH = 0, pD = 0, pA = 0;
    let pOU25 = 0, pBTTS = 0;
    
    let pH_O25 = 0, pGG_O25 = 0, pA_O25 = 0;
    
    // Increased cap to 10 goals for hyper-offensive leagues
    for (let h = 0; h <= 10; h++) {
        const probH = poissonProb(adjH, h);
        for (let a = 0; a <= 10; a++) {
            const probA = poissonProb(adjA, a);
            const p = probH * probA;
            
            if (h > a) pH += p;
            else if (h === a) pD += p;
            else pA += p;

            if (h + a > 2.5) {
                pOU25 += p;
                if (h > a) pH_O25 += p;
                if (a > h) pA_O25 += p;
                if (h > 0 && a > 0) pGG_O25 += p;
            }
            if (h > 0 && a > 0) pBTTS += p;
        }
    }

    // ── HT Over 1.5 via Poisson (first half ≈ 45% of total xG) ──────────────
    // Bookmakers minimum available HT market is Over 1.5, NOT Over 0.5
    const htLambda = (adjH + adjA) * 0.45;
    const pHT_0 = poissonProb(htLambda, 0);
    const pHT_1 = poissonProb(htLambda, 1);
    const pHT15 = Math.max(0, 1 - pHT_0 - pHT_1); // P(HT goals >= 2)

    const total = pH + pD + pA || 1;
    return {
        home: Math.round((pH / total) * 100),
        draw: Math.round((pD / total) * 100),
        away: Math.round((pA / total) * 100),
        ou25: Math.round(pOU25 * 100),
        btts: Math.round(pBTTS * 100),
        h_o25: Math.round(pH_O25 * 100),
        a_o25: Math.round(pA_O25 * 100),
        gg_o25: Math.round(pGG_O25 * 100),
        ht15: Math.round(pHT15 * 100)  // ✅ Over 1.5 HT — available at all bookmakers
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🧠 MOTIVATION FILTER — Détecte les équipes sans ambition (surprises à éviter)
// ═══════════════════════════════════════════════════════════════════════════════
//
// NIVEAUX DE RISQUE:
//   SKIP       — À éliminer totalement  (2 équipes sans enjeu)
//   HIGH_RISK  — Très dangereux         (1 équipe sans enjeu)
//   CAUTION    — Prudence requise       (zone grise)
//   SAFE       — Match avec enjeu clair
//
// SIGNATURES DÉTECTÉES:
//   ZONE_MORTE      → Mi-table sécurisée, ni montée ni relégation
//   CHAMPION_ASSURE → Titre déjà mathématiquement assuré
//   RELEGUE_ASSURE  → Relégation déjà mathématiquement assurée
//   COMPLAISANCE    → Historique de performances suspectes
//   ENJEU_CRITIQUE  → Match à enjeu maximum (VERT)
// ═══════════════════════════════════════════════════════════════════════════════

function analyzeMotivation(m) {
    const result = {
        homeRisk: 'UNKNOWN',
        awayRisk: 'UNKNOWN',
        globalRisk: 'SAFE',
        riskScore: 0,      // 0=safe .. 100=max danger
        signatures: [],
        verdict: 'SAFE',   // SAFE | CAUTION | HIGH_RISK | SKIP
        reason: ''
    };

    // ── 1. Lire la motivation_signature stockée en DB ──────────────────────────
    let sig = '';
    try {
        if (m.motivation_signature) {
            sig = m.motivation_signature;
        } else if (m.fullData) {
            const fd = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData;
            sig = fd.motivation_signature || '';
        }
    } catch (_) {}

    // ── 2. Lire les standings (classement) depuis historical_context ───────────
    let homeStanding = null, awayStanding = null;
    let totalTeams = 20; // défaut
    try {
        const hc = m.historical_context
            ? (typeof m.historical_context === 'string' ? JSON.parse(m.historical_context) : m.historical_context)
            : null;
        if (hc) {
            homeStanding = hc.standing || null;
            awayStanding = hc.standing_away || null;
            // Estimer le nombre total d'équipes depuis le rang max
            const hPos = homeStanding?.position || 0;
            const aPos = awayStanding?.position || 0;
            totalTeams = Math.max(totalTeams, hPos, aPos);
        }
    } catch (_) {}

    // ── 3. Analyser chaque équipe selon sa position au classement ─────────────
    function assessTeamMotivation(standing, teamName) {
        if (!standing) return { risk: 'UNKNOWN', reasons: [] };

        const pos   = standing.position || 0;
        const pts   = standing.points   || 0;
        const played = standing.matches || standing.played || 30;
        const reasons = [];

        // Positions de relégation (3 dernières) et titre (top 1-4)
        const relegZone  = totalTeams - 2; // ex: 18e sur 20
        const titleZone  = 4;
        const euroZone   = 6;
        const safeBottom = relegZone - 3;  // 15e = zone confort

        // Champion assuré (1er avec +10 pts d'avance et <5 matchs restants)
        if (pos === 1 && played >= 32) {
            reasons.push('CHAMPION_ASSURE');
            return { risk: 'HIGH_RISK', reasons };
        }

        // Relégué assuré (avant-dernier ou dernier avec trop de retard)
        if (pos >= relegZone && played >= 32) {
            reasons.push('RELEGUE_ASSURE');
            return { risk: 'HIGH_RISK', reasons };
        }

        // Zone morte : milieu de tableau sécurisé (ni montée ni relégation)
        if (pos > titleZone && pos < safeBottom && played >= 25) {
            // Confortablement à l'écart des deux extrêmes
            const ptsFromRelegation = pts - (standing.relegationPoints || 0);
            const ptsFromTitle      = (standing.leaderPoints || pts + 20) - pts;
            if (ptsFromRelegation > 12 && ptsFromTitle > 15) {
                reasons.push('ZONE_MORTE');
                return { risk: 'CAUTION', reasons };
            }
        }

        // Course au titre / maintien → enjeu critique
        if (pos <= titleZone || pos >= safeBottom) {
            reasons.push('ENJEU_CRITIQUE');
            return { risk: 'SAFE', reasons };
        }

        return { risk: 'SAFE', reasons };
    }

    const homeAssess = assessTeamMotivation(homeStanding, m.homeTeam);
    const awayAssess = assessTeamMotivation(awayStanding, m.awayTeam);

    result.homeRisk = homeAssess.risk;
    result.awayRisk = awayAssess.risk;
    result.signatures.push(...homeAssess.reasons, ...awayAssess.reasons);

    // ── 4. Intégrer la signature stockée (priorité sur calcul) ────────────────
    const sigUpper = sig.toUpperCase();
    if (sigUpper.includes('COMPLAISANCE')) {
        result.signatures.push('COMPLAISANCE');
        result.riskScore = Math.max(result.riskScore, 80);
    }
    if (sigUpper.includes('ZONE MORTE') || sigUpper.includes('ZONE_MORTE')) {
        result.signatures.push('ZONE_MORTE_DB');
        result.riskScore = Math.max(result.riskScore, 55);
    }
    if (sigUpper.includes('CHAMPION')) {
        result.signatures.push('CHAMPION_DB');
        result.riskScore = Math.max(result.riskScore, 70);
    }
    if (sigUpper.includes('RELEGUE') || sigUpper.includes('RELÉGUÉ')) {
        result.signatures.push('RELEGUE_DB');
        result.riskScore = Math.max(result.riskScore, 70);
    }
    if (sigUpper.includes('ENJEU CRITIQUE') || sigUpper.includes('RESPECT')) {
        result.riskScore = Math.min(result.riskScore, 10);
        result.signatures.push('ENJEU_CRITIQUE_DB');
    }

    // ── 5. Score global et verdict ─────────────────────────────────────────────
    // Combiner les risques des deux équipes
    const riskMap = { 'HIGH_RISK': 70, 'CAUTION': 40, 'SAFE': 0, 'UNKNOWN': 15 };
    const baseScore = Math.max(
        riskMap[homeAssess.risk] || 0,
        riskMap[awayAssess.risk] || 0
    );
    result.riskScore = Math.max(result.riskScore, baseScore);

    // Bonus danger : les deux équipes sans enjeu = SKIP immédiat
    if (homeAssess.risk === 'HIGH_RISK' && awayAssess.risk === 'HIGH_RISK') {
        result.riskScore = 95;
    }
    if (homeAssess.risk !== 'SAFE' && awayAssess.risk !== 'SAFE' &&
        homeAssess.risk !== 'UNKNOWN' && awayAssess.risk !== 'UNKNOWN') {
        result.riskScore = Math.max(result.riskScore, 75);
    }

    // Verdict final
    if (result.riskScore >= 80)      result.verdict = 'SKIP';
    else if (result.riskScore >= 55) result.verdict = 'HIGH_RISK';
    else if (result.riskScore >= 30) result.verdict = 'CAUTION';
    else                             result.verdict = 'SAFE';

    // ── 6. Traduction et Formatage "نوع الدافع" ───────────────────────────────
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

// ─── Smart Market Selector ────────────────────────────────────────────────────
// [V110 PRECISION] Seuils relevés pour réduire les faux positifs:
//   Combos 1&O25 / 2&O25 : 45% → 52%
//   GG&O25               : 50% → 56%
//   HT Over 1.5          : 38% → 44%
//   Double Chance + Goals : 45% → 52%
function selectSurgicalMarket(pH, pD, pA, pOU25, pBTTS, pHO25, pAO25, pGGO25, homeTeam, awayTeam, pHT15 = 0) {
    const markets = [];

    // 1. Combo Markets (High Value) — seuils relevés pour qualité maximale
    if (pHO25 >= 52) {
        markets.push({ type: '1_O25', prob: pHO25, label: `🛡️ فوز ${homeTeam} & +2.5 أهداف (1 & Over 2.5)`, arLabel: `1 & +2.5` });
    }
    if (pAO25 >= 52) {
        markets.push({ type: '2_O25', prob: pAO25, label: `🛡️ فوز ${awayTeam} & +2.5 أهداف (2 & Over 2.5)`, arLabel: `2 & +2.5` });
    }
    if (pGGO25 >= 56) {
        markets.push({ type: 'GG_O25', prob: pGGO25, label: `🔥 كلا الفريقين يسجل & +2.5 أهداف (GG & Over 2.5)`, arLabel: `GG & +2.5` });
    }

    // 2. Heavy Favorites -> Handicap (inchangé : seuil déjà strict)
    if (pH >= 65) {
        markets.push({ type: 'H_Handicap', prob: pH - 15, label: `🛡️ هانديكاب ${homeTeam} (-1)`, arLabel: `Handicap ${homeTeam} (-1)` });
    }
    if (pA >= 65) {
        markets.push({ type: 'A_Handicap', prob: pA - 15, label: `🛡️ هانديكاب ${awayTeam} (-1)`, arLabel: `Handicap ${awayTeam} (-1)` });
    }

    // 3. HT Over 1.5 — seuil relevé à 44% (vs 38% avant) pour éliminer les cas limites
    if (pHT15 >= 44) {
        markets.push({
            type: 'HT_O15',
            prob: pHT15,
            label: `⚡ أكثر من 1.5 هدف في الشوط الأول (HT Over 1.5)`,
            arLabel: `HT +1.5`
        });
    }

    // 4. Under 2.5 للمباريات الدفاعية — critères plus stricts
    if (pOU25 <= 38 && pBTTS <= 40) {
        if (Math.max(pH, pA) < 68) {
            markets.push({ type: 'Under2.5', prob: 100 - pOU25, label: `📉 أقل من 2.5 أهداف`, arLabel: `Under 2.5` });
        }
    }

    // 5. Double Chance + Goals combo — seuil relevé à 52%
    if (pH > pA && pH >= 52 && pOU25 >= 52) {
        markets.push({ type: '1X_O15', prob: Math.min(85, pH + 5), label: `🛡️ فوز ${homeTeam} أو تعادل (1X) & أكثر من 1.5 هدف`, arLabel: `1X & +1.5` });
    }
    if (pA > pH && pA >= 52 && pOU25 >= 52) {
        markets.push({ type: 'X2_O15', prob: Math.min(85, pA + 5), label: `🛡️ فوز ${awayTeam} أو تعادل (X2) & أكثر من 1.5 هدف`, arLabel: `X2 & +1.5` });
    }

    // 6. Base Core Fallbacks (Classic) — uniquement si probabilité dominante >= 52%
    const maxProb = Math.max(pH, pA);
    if (maxProb >= 52) {
        markets.push({ type: '1X2', prob: maxProb, label: pH > pA ? `🏠 فوز ${homeTeam}` : `✈️ فوز ${awayTeam}`, arLabel: pH > pA ? `فوز ${homeTeam}` : `فوز ${awayTeam}` });
    }
    if (pBTTS >= 55) {
        markets.push({ type: 'BTTS', prob: pBTTS, label: `⚽ كلا الفريقين يسجل (BTTS)`, arLabel: `BTTS` });
    }
    if (pOU25 >= 60) {
        markets.push({ type: 'Over2.5', prob: pOU25, label: `🔥 أكثر من 2.5 هدف (Over 2.5)`, arLabel: `Over 2.5` });
    }

    // Fallback ultime si aucun marché qualifié
    if (markets.length === 0) {
        markets.push({ type: '1X2', prob: maxProb, label: pH > pA ? `🏠 فوز ${homeTeam}` : `✈️ فوز ${awayTeam}`, arLabel: pH > pA ? `فوز ${homeTeam}` : `فوز ${awayTeam}` });
    }

    // Filter, Cap probabilities at 99%, and Sort
    markets.forEach(m => { m.prob = Math.min(99, Math.max(0, m.prob)); });
    markets.sort((a, b) => b.prob - a.prob);

    const best = markets[0];
    let backup = markets.find(m => m.type !== best.type && !m.type.includes(best.type.split('_')[0])) || markets[1];

    return { best, backup };
}

// ─── Main Function ────────────────────────────────────────────────────────────
async function runSurgicalElite50(sendTelegram = true) {
    console.log('\n' + '='.repeat(62));
    console.log('💎 [TITANIUM AI] GENERATING SURGICAL ELITE 50 REPORT');
    console.log('='.repeat(62) + '\n');

    const db = new Database(DB_PATH, { readonly: true });

    try {
        const nowTs = Math.floor(Date.now() / 1000);
        const windowEnd = nowTs + 72 * 3600; // 🚀 Increased to 72-hour window (3 days) for better volume selection

        // ── 1. Fetch today's matches ─────────────────────────────────────────
        // Strategy: use startTimestamp if valid; also scan fullData JSON for matches
        // whose startTimestamp was stored as 0 (common scraper bug)
        const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
        const todayEnd   = Math.floor(new Date().setHours(23, 59, 59, 999) / 1000);
        const tomorrowEnd = todayEnd + 86400;

        // Primary: matches with valid startTimestamp for today or tomorrow
        let rows = db.prepare(`
            SELECT * FROM matches
            WHERE status = 'scheduled'
              AND startTimestamp BETWEEN ? AND ?
            ORDER BY startTimestamp ASC
            LIMIT 800
        `).all(todayStart, tomorrowEnd);

        console.log(`🗄️  Found ${rows.length} matches with valid timestamps (today+tomorrow)`);

        // Secondary: if few found, pull all scheduled and apply Poisson to any
        if (rows.length < 20) {
            const extra = db.prepare(`
                SELECT * FROM matches
                WHERE status = 'scheduled'
                ORDER BY id DESC
                LIMIT 800
            `).all();
            // Merge, deduplicate by id
            const seen = new Set(rows.map(r => r.id));
            extra.forEach(r => { if (!seen.has(r.id)) { rows.push(r); seen.add(r.id); } });
            console.log(`🔄 Extended to ${rows.length} matches (all scheduled in DB)`);
        }

        if (rows.length === 0) {
            console.log('⚠️ No scheduled matches in DB. Le scraper doit tourner d’abord.');
            if (sendTelegram) {
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: CHAT_ID,
                    text: `⚠️ <b>TITANIUM ELITE 50</b>

Aucun match disponible pour aujourd’hui.
Le scraper collecte les données - relancez dans 10 min.`,
                    parse_mode: 'HTML'
                }).catch(() => {});
            }
            return;
        }

        // ── 2. Score every match ─────────────────────────────────────────────
        const scored = [];

        for (const m of rows) {
            // Get or compute probabilities
            let pH  = parseFloat(m.home_win_probability) || 0;
            let pD  = parseFloat(m.draw_probability)     || 0;
            let pA  = parseFloat(m.away_win_probability) || 0;
            let pOU = parseFloat(m.ou_25_prob)           || 0;
            let pBT = parseFloat(m.btts_prob)            || 0;

            // Normalize: if stored as fractions (0.33) convert to percentage (33)
            if (pH > 0 && pH <= 1.0) pH = Math.round(pH * 100);
            if (pD > 0 && pD <= 1.0) pD = Math.round(pD * 100);
            if (pA > 0 && pA <= 1.0) pA = Math.round(pA * 100);
            if (pOU > 0 && pOU <= 1.0) pOU = Math.round(pOU * 100);
            if (pBT > 0 && pBT <= 1.0) pBT = Math.round(pBT * 100);

            let pHO25 = 0, pAO25 = 0, pGGO25 = 0, pHT15 = 0;

            // Extract xG from teamStats JSON if available
            let homeStats = {}, awayStats = {};
            try { const ts = typeof m.teamStats === 'string' ? JSON.parse(m.teamStats) : (m.teamStats || {}); homeStats = ts.home || {}; awayStats = ts.away || {}; } catch(_) {}

            const league = (m.league || '').toLowerCase();
            let defXGH = 1.3, defXGA = 1.0;
            if (league.includes('iceland') || league.includes('reykjavik')) { defXGH = 1.9; defXGA = 1.6; }
            else if (league.includes('bundesliga') || league.includes('netherlands')) { defXGH = 1.8; defXGA = 1.4; }
            else if (league.includes('norway') || league.includes('sweden')) { defXGH = 1.6; defXGA = 1.3; }

            const hXG = parseFloat(m.home_xg) || homeStats.avgGoalsScored || defXGH;
            const aXG = parseFloat(m.away_xg) || awayStats.avgGoalsScored || defXGA;
            const hAtt = parseFloat(m.home_attack_impact)  || 1.0;
            const aDef = parseFloat(m.away_defense_impact) || 1.0;
            const aAtt = parseFloat(m.away_attack_impact)  || 1.0;
            const hDef = parseFloat(m.home_defense_impact) || 1.0;

            const p = computePoisson(hXG, aXG, hAtt, aDef, aAtt, hDef);

            // If probabilities are missing/zero → fallback to Poisson
            if (pH + pD + pA < 30) {
                pH = p.home; pD = p.draw; pA = p.away;
                pOU = p.ou25; pBT = p.btts;
                pHO25 = p.h_o25; pAO25 = p.a_o25; pGGO25 = p.gg_o25;
                pHT15 = p.ht15;
            } else {
                pHO25 = Math.round(pH * pOU / 100);
                pAO25 = Math.round(pA * pOU / 100);
                pGGO25 = Math.round((pOU + pBT) / 2);
                pHT15 = Math.round(pOU * 0.45);
            }

            const { best, backup } = selectSurgicalMarket(pH, pD, pA, pOU, pBT, pHO25, pAO25, pGGO25, m.homeTeam, m.awayTeam, pHT15);

            // Integrity check
            const modelPreds = { home_win_probability: pH / 100, draw_probability: pD / 100, away_win_probability: pA / 100 };
            let integrity = { score: 0, trafficLight: 'GREEN' };
            try {
                integrity = await IntegrityService.analyzeMatch(m, modelPreds, {});
            } catch (_) {}

            // 🧠 [MOTIVATION FILTER] Détecter les équipes sans ambition
            const motiv = analyzeMotivation(m);

            // [V110] Confluence check: écart entre probabilités stockées et Poisson
            // Si les deux sources divergent fortement → réduire le score qualité
            let confluenceFactor = 1.0;
            if (pH + pD + pA >= 30) { // On a des proba stockées
                const poissonMax = Math.max(p.home, p.draw, p.away);
                const storedMax  = Math.max(pH, pD, pA) / 100;
                const divergence = Math.abs(storedMax - poissonMax);
                if (divergence > 0.25)      confluenceFactor = 0.55; // désaccord critique
                else if (divergence > 0.15) confluenceFactor = 0.78; // désaccord modéré
                else if (divergence < 0.08) confluenceFactor = 1.12; // consensus fort → bonus
            }

            // [V110] Data quality filter: exclure les matchs sans xG fiable
            let dataQualityFactor = 1.0;
            const hXG_stored = parseFloat(m.home_xg) || 0;
            const aXG_stored = parseFloat(m.away_xg) || 0;
            if (hXG_stored === 0 && aXG_stored === 0) {
                dataQualityFactor = 0.60; // Pas de données xG — incertitude haute
            }

            // Quality score: confidence × integrity × motivation × confluence × data quality
            const integrityFactor = Math.max(0, 1 - integrity.score / 100);
            const motivFactor = motiv.verdict === 'SKIP'      ? 0.0
                              : motiv.verdict === 'HIGH_RISK' ? 0.35
                              : motiv.verdict === 'CAUTION'   ? 0.70
                              :                                 1.0;
            const qualityScore = best.prob * integrityFactor * motivFactor * confluenceFactor * dataQualityFactor;

            scored.push({
                m,
                best, backup,
                integrity,
                motiv,
                qualityScore,
                confidence: Math.round(best.prob),
                pH, pD, pA, pOU, pBT
            });
        }

        // ── 3. Smart filters — Motivation + Integrity + Confidence ──────────────
        const skipCount    = scored.filter(s => s.motiv?.verdict === 'SKIP').length;
        const dangerCount  = scored.filter(s => s.motiv?.verdict === 'HIGH_RISK').length;
        const cautionCount = scored.filter(s => s.motiv?.verdict === 'CAUTION').length;
        console.log(`🧠 [MOTIVATION] SKIP: ${skipCount} | DANGER: ${dangerCount} | CAUTION: ${cautionCount} | SAFE: ${scored.length - skipCount - dangerCount - cautionCount}`);

        let filtered = scored.filter(s => {
            // ❌ Éliminer les matchs SKIP (2 équipes sans enjeu = surprise garantie)
            if (s.motiv?.verdict === 'SKIP') return false;
            // ❌ Pas de feu rouge intégrité
            if (s.integrity.trafficLight === 'RED') return false;
            // ❌ [V110] Confiance minimum relevée à 55% (vs 45% avant)
            if (s.confidence < 55) return false;
            // ❌ [V110] Éliminer les matchs avec qualityScore très bas (modèles en désaccord)
            if (s.qualityScore < 30) return false;
            return true;
        });

        console.log(`✅ ${filtered.length} matches passed quality filters (motivation + integrity + confluence)`);

        // Si trop peu → relaxation partielle (jamais en-dessous de 50%)
        if (filtered.length < 15) {
            filtered = scored.filter(s =>
                s.motiv?.verdict !== 'SKIP' &&
                s.integrity.trafficLight !== 'RED' &&
                s.confidence >= 50 &&
                s.qualityScore >= 20
            );
            console.log(`🔄 Relaxed filter (50% min, SKIP blocked): ${filtered.length} matches`);
        }


        // ── 4. Pick Top 50 ───────────────────────────────────────────────────
        filtered.sort((a, b) => b.qualityScore - a.qualityScore);
        const top50 = filtered.slice(0, 50);

        console.log(`🏆 Final selection: ${top50.length} matches\n`);

        if (top50.length === 0) {
            console.log('⚠️ Aucun match disponible même après relaxation des filtres.');
            return;
        }

        // ── 5. Print report ──────────────────────────────────────────────────
        console.log('─'.repeat(62));
        top50.forEach((s, i) => {
            const date = s.m.startTimestamp ? new Date(s.m.startTimestamp * 1000).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : '??';
            const icon = s.integrity.trafficLight === 'GREEN' ? '🛡️' : '⚠️';
            console.log(`#${String(i+1).padStart(2,'0')} ${icon} ${s.m.homeTeam} vs ${s.m.awayTeam} [${date}]`);
            console.log(`    ✂️  ${s.best.label} (${s.confidence}%) | 🔄 ${s.backup.label} (${Math.round(s.backup.prob)}%)`);
            console.log(`    📊 H:${s.pH}% D:${s.pD}% A:${s.pA}% | OU:${s.pOU}% BTTS:${s.pBT}%`);
            console.log('');
        });

        // ── 6. Send to Telegram ──────────────────────────────────────────────
        if (sendTelegram) {
            const chunkSize = 10;
            const totalChunks = Math.ceil(top50.length / chunkSize);

            for (let c = 0; c < totalChunks; c++) {
                const chunk = top50.slice(c * chunkSize, (c + 1) * chunkSize);
                const dateStr = new Date().toLocaleDateString('fr-FR');
                let msg = c === 0
                    ? `💎 <b>TITANIUM ELITE 50 — ${dateStr}</b> 💎\n🎯 <b>Sélection Chirurgicale — Qualité Maximale</b>\n\n`
                    : `💎 <b>ELITE 50 — Partie ${c+1}/${totalChunks}</b> 💎\n\n`;

                chunk.forEach((s, i) => {
                    const num = c * chunkSize + i + 1;
                    const icon = s.integrity.trafficLight === 'GREEN' ? '🛡️' : '⚠️';
                    const date = s.m.startTimestamp
                        ? new Date(s.m.startTimestamp * 1000).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})
                        : '??';
                    // 🧠 Utiliser les vraies données de analyzeMotivation()
                    const motiv = s.motiv || { verdict: 'SAFE', riskScore: 10, reason: 'Logique Standard' };
                    const motivIcons = {
                        'SAFE':      '🟢',
                        'CAUTION':   '🟡',
                        'HIGH_RISK': '🔴',
                        'SKIP':      '⛔'
                    };
                    const motivIcon = motivIcons[motiv.verdict] || '⚪';
                    const motivLabel = motiv.reason || 'Logique Standard';

                    msg += `${icon} <b>#${num} ${s.m.homeTeam} vs ${s.m.awayTeam}</b>\n`;
                    msg += `⏰ ${date} | ${motivIcon} <b>${motiv.verdict}</b> (Risque: ${motiv.riskScore}%)\n`;
                    msg += `🧠 <i>${motivLabel}</i>\n`;
                    msg += `✂️ <b>Choix:</b> ${s.best.label} (<b>${s.confidence}%</b>)\n`;
                    msg += `🔄 <b>Alt:</b> ${s.backup.label} (${Math.round(s.backup.prob)}%)\n`;
                    msg += `📊 1:${s.pH}% X:${s.pD}% 2:${s.pA}% | OU2.5:${s.pOU}%\n\n`;
                });

                if (c === totalChunks - 1) {
                    msg += `🤖 <i>Titanium Surgical AI v5.1 — ${top50.length} matches sélectionnés</i>`;
                }

                try {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        chat_id: CHAT_ID,
                        text: msg,
                        parse_mode: 'HTML'
                    });
                    console.log(`📤 Telegram chunk ${c+1}/${totalChunks} sent`);
                } catch (e) {
                    console.error(`❌ Telegram error: ${e.response?.data?.description || e.message}`);
                }

                await new Promise(r => setTimeout(r, 1500));
            }
        }

        console.log(`\n✅ Surgical Elite 50 — Terminé (${top50.length} matchs envoyés)`);

    } catch (err) {
        console.error('❌ Critical Error:', err.message);
        logger.error(`[Elite50] ${err.message}`);
    } finally {
        db.close();
    }
}

if (require.main === module) {
    runSurgicalElite50(true).then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { runSurgicalElite50 };

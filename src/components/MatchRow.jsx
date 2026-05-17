import React from 'react';
import SuspiciousIcon from '../assets/suspicious_match.png';
import SafeBetIcon from '../assets/safe_bet.png';

const MatchRow = ({ match, isElite, onClick, style }) => {
    // Shared reference to enriched sub-object
    const enriched = match.enriched || {};

    // Determine CS (AI Correct Score) — Poisson xG model
    const getCS = () => {
        // Priority 1: explicit CS prediction from v22 engine
        if (match.v22_cs_prediction) {
            const part = match.v22_cs_prediction.split(' - ')[0];
            if (part && part.includes('-')) return part;
        }
        // Priority 2: cs_predictions array
        if (match.cs_predictions && match.cs_predictions.length > 0) {
            return match.cs_predictions[0].score;
        }
        // Priority 3: expected_score from enrichment
        const es = match.expected_score || enriched.expected_score;
        if (es && es.includes('-')) {
            const [esH, esA] = es.split('-').map(s => parseInt(s.trim()));
            const isValidES = !isNaN(esH) && !isNaN(esA) && (esH + esA) > 0;
            if (isValidES) return es;
        }

        // Priority 4: Poisson-style xG
        const hAvgFor    = parseFloat(enriched.home_avg_scored   || match.home_avg_scored   || 0);
        const aAvgFor    = parseFloat(enriched.away_avg_scored   || match.away_avg_scored   || 0);
        const hAvgAgainst = parseFloat(enriched.home_avg_conceded || match.home_avg_conceded || 0);
        const aAvgAgainst = parseFloat(enriched.away_avg_conceded || match.away_avg_conceded || 0);
        if (hAvgFor > 0 && aAvgFor > 0) {
            const xG_h = Math.max(0, (hAvgFor + aAvgAgainst) / 2);
            const xG_a = Math.max(0, (aAvgFor + hAvgAgainst) / 2);
            return `${Math.round(xG_h)} - ${Math.round(xG_a)}`;
        }

        const h     = parseFloat(match.home_win_probability || enriched.home_win_probability || 0);
        const a     = parseFloat(match.away_win_probability || enriched.away_win_probability || 0);
        const btts  = Number(match.btts_prob || enriched?.btts_prob || 0);
        const ou25raw = Number(match.ou_25_prob || enriched?.ou_25_prob || 0);
        const ou25  = ou25raw > 1 ? ou25raw / 100 : ou25raw;
        const highScoring = ou25 > 0.60 || btts > 62;
        if (h > 0 || a > 0) {
            if (h > a + 25) return highScoring ? '2 - 1' : '1 - 0';
            if (a > h + 25) return highScoring ? '1 - 2' : '0 - 1';
            if (h > a + 12) return highScoring ? '2 - 1' : '1 - 0';
            if (a > h + 12) return highScoring ? '1 - 2' : '0 - 1';
            return btts > 58 ? '1 - 1' : (h >= a ? '1 - 0' : '0 - 1');
        }
        return '1 - 1';
    };
    const cs = getCS();

    const hPct = parseFloat(match.home_win_probability || enriched.home_win_probability || 0);
    const aPct = parseFloat(match.away_win_probability || enriched.away_win_probability || 0);
    const dPct = parseFloat(match.draw_probability || enriched.draw_probability || 0);
    const pOU25 = Number(match.ou_25_prob || enriched?.ou_25_prob || 0);
    const pBTTS = Number(match.btts_prob || enriched?.btts_prob || 0);

    const pHT05 = Math.min(89, Math.round((pOU25 * 0.5) + (pBTTS * 0.5) + 5));
    const markets = [];
    
    const hNameLabel = match.homeTeam;
    const aNameLabel = match.awayTeam;

    if (hPct >= 65) {
        markets.push({ prob: hPct - 12, label: `🛡️ Handicap ${hNameLabel} (-1)` });
        markets.push({ prob: hPct - 5, label: `⚽ ${hNameLabel} +1.5 buts` });
    }
    if (aPct >= 65) {
        markets.push({ prob: aPct - 12, label: `🛡️ Handicap ${aNameLabel} (-1)` });
        markets.push({ prob: aPct - 5, label: `⚽ ${aNameLabel} +1.5 buts` });
    }

    if (pBTTS >= 58 && pOU25 >= 58) {
        markets.push({ prob: pHT05, label: `⚡ But Mi-temps (+0.5 HT)` });
        markets.push({ prob: (pBTTS + pOU25) / 2, label: `🔥 BTTS & +2.5 buts` });
    } else if (pOU25 <= 40 && pBTTS <= 40) {
        markets.push({ prob: 100 - pOU25, label: `📉 -2.5 buts (Under)` });
        markets.push({ prob: 100 - pBTTS, label: `🚫 Pas de BTTS` });
    }

    markets.push({ prob: Math.max(hPct, aPct), label: hPct > aPct ? `🏠 1 (DOM)` : `✈️ 2 (EXT)` });
    markets.push({ prob: pBTTS, label: `⚽ Les 2 Marquent (BTTS)` });
    
    markets.forEach(m => { m.prob = Math.min(99, m.prob); });
    const validMarkets = markets.filter(m => m.prob > 0 && !isNaN(m.prob));
    validMarkets.sort((a, b) => b.prob - a.prob);
    const smartPickLabel = (() => {
        if (validMarkets.length === 0) return '⏳ EN ANALYSE';
        
        // 🛡️ [SMART LOGIC] If top market is BTTS but confidence is low (<= 55), 
        // try to find a more specific signal like Double Chance or 1X2 if they are close.
        const top = validMarkets[0];
        if (top.label.includes('BTTS') && top.prob <= 55) {
            const runnerUp = validMarkets.find(m => !m.label.includes('BTTS') && m.prob > 40);
            if (runnerUp) return runnerUp.label;
        }
        
        return top.label;
    })();

    const rawAcc = match.v22_success_rate || match.enriched?.v22_success_rate || match.confidence;
    const bestMktProb = validMarkets[0] ? validMarkets[0].prob : 0;
    const marketConf  = bestMktProb > 1 ? bestMktProb : Math.round(bestMktProb * 100);
    const pOU25_pct = pOU25 > 1 ? pOU25 : pOU25 * 100;
    let acc;
    if (rawAcc && rawAcc > 0) {
        let base = rawAcc > 1 ? rawAcc : Math.round(rawAcc * 100);
        if (base === 50 && bestMktProb > 55) base = Math.round(bestMktProb);
        if (bestMktProb > base + 15 && bestMktProb > 60) base = Math.round(bestMktProb);
        if (Math.abs(base - marketConf) < 10 && base > 60) base = Math.min(97, base + 4);
        if (pBTTS > 70 && pOU25_pct > 70) base = Math.min(97, base + 3);
        if (match.insufficient_data === 1) base = Math.min(base, 64);
        acc = Math.round(base);
    } else {
        const bestProb = validMarkets[0] ? validMarkets[0].prob : Math.max(hPct, aPct, dPct);
        acc = bestProb > 1 ? Math.round(bestProb) : Math.round(bestProb * 100);
        if (pBTTS > 65 && pOU25_pct > 65) acc = Math.min(97, acc + 4);
        if (match.insufficient_data === 1) acc = Math.min(acc, 64);
        if (acc === 0) acc = 50;
    }
    acc = Math.max(1, Math.min(99, acc));

    let tg = "-2.5";
    let tgClass = "";
    {
        const ouRaw  = Number(match.ou_25_prob || enriched?.ou_25_prob || 0);
        const ou35Raw = Number(match.ou_35_prob || enriched?.ou_35_prob || 0);
        const ou15Raw = Number(match.ou_15_prob || enriched?.ou_15_prob || 0);
        const bttsRaw = Number(match.btts_prob  || enriched?.btts_prob  || 0);
        const ouProb = ouRaw  > 1 ? ouRaw  / 100 : ouRaw;
        const ou35   = ou35Raw > 1 ? ou35Raw / 100 : ou35Raw;
        const ou15   = ou15Raw > 1 ? ou15Raw / 100 : ou15Raw;
        const bttsP  = bttsRaw > 1 ? bttsRaw        : bttsRaw * 100;
        const rawTg   = match.total_goals_label || enriched?.total_goals_label || "";

        if (rawTg) {
            tg = rawTg.replace(/buts/i, "").trim();
        } else if (ou35 > 0.62) {
            tg = "+3.5";
        } else if (ouProb > 0.70 || (ouProb > 0.58 && bttsP > 63)) {
            tg = "+2.5";
        } else if (ouProb > 0.52 || ou15 > 0.68 || bttsP > 58) {
            tg = "+1.5";
        } else if (ouProb < 0.28) {
            tg = "-1.5";
        } else if (ouProb < 0.42) {
            tg = "-2.5";
        } else {
            if (cs !== "N/A" && cs.includes("-")) {
                const [_h, _a] = cs.split('-').map(s => parseInt(s.trim()));
                if (!isNaN(_h) && !isNaN(_a)) {
                    const tot = _h + _a;
                    if (tot >= 5) tg = "+4.5";
                    else if (tot >= 4) tg = "+3.5";
                    else if (tot >= 3) tg = "+2.5";
                    else if (tot >= 2) tg = "+1.5";
                    else tg = "-1.5";
                }
            } else {
                tg = "+1.5";
            }
        }
    }

    if (tg.includes("+")) tgClass = "onyx-win"; 
    else if (tg.includes("-")) tgClass = "onyx-draw"; 

    let accClass = "onyx-acc-low";
    let isVetoed = false;
    
    if (acc >= 70) accClass = "onyx-acc-high";
    else if (acc >= 55) accClass = "onyx-acc-med";
    else {
        accClass = "onyx-acc-low";
        isVetoed = true; // Alpha Zero-Failure Veto (Now at 55%)
    }

    const domProb  = Math.max(hPct, aPct);
    const hasOdds  = !!(match.odds_home && match.odds_away);
    const hasForm  = !!(match.home_form_pts || match.away_form_pts);
    const hasStats = !!(match.ou_25_prob  || match.btts_prob);
    const dataBonus = (hasOdds ? 2 : 0) + (hasForm ? 2 : 0) + (hasStats ? 2 : 0);
    const hasRealProbs = (hPct + aPct) > 5;
    const isNoData     = !hasRealProbs && !hasOdds && !hasStats;
    const isBalanced   = hasRealProbs && domProb >= 33 && domProb < 52;

    let ms, msLabel, msColor, msDesc;
    if (isNoData) {
        ms = null; msLabel = '⏳'; msColor = '#475569'; msDesc = 'Attente';
    } else if (match.insufficient_data === 1) {
        ms = Math.max(1, 2 + Math.floor(dataBonus / 3)); msLabel = `⚠️${ms}`; msColor = '#f59e0b'; msDesc = 'Données Faibles';
    } else if (isBalanced) {
        ms = Math.min(8, 4 + Math.floor(dataBonus / 2)); msLabel = `🔵${ms}`; msColor = '#38bdf8'; msDesc = 'Équilibré';
    } else if (domProb >= 70) {
        ms = Math.min(10, 7 + Math.floor(dataBonus / 2)); msLabel = `🟢${ms}`; msColor = '#00ffaa'; msDesc = 'Solidité Haute';
    } else if (domProb >= 55) {
        ms = Math.min(9, 5 + Math.floor(dataBonus / 2)); msLabel = `🟡${ms}`; msColor = '#fbbf24'; msDesc = 'Modéré';
    } else {
        ms = Math.min(7, 3 + Math.floor(dataBonus / 2)); msLabel = `🟠${ms}`; msColor = '#f97316'; msDesc = 'Spéculatif';
    }

    let statusIcon = null;
    if (acc >= 80) {
        statusIcon = <img src={SafeBetIcon} alt="Safe" style={{width: 18, height: 18, marginLeft: 6, verticalAlign: 'middle', filter: 'drop-shadow(0px 1px 2px rgba(0,255,0,0.3))'}} title="Safe Bet" />;
    } else if (acc < 65 || ms >= 8 || match.prediction === "RISKY") {
        statusIcon = <img src={SuspiciousIcon} alt="Risky" style={{width: 18, height: 18, marginLeft: 6, verticalAlign: 'middle', filter: 'drop-shadow(0px 1px 2px rgba(255,0,0,0.3))'}} title="Risky" />;
    }

    const fixedMatchScore = [];
    const oddsH = parseFloat(match.odds_home || 0);
    const oddsA = parseFloat(match.odds_away || 0);
    if (hPct > 65 && oddsH > 2.8) fixedMatchScore.push(30);
    if (aPct > 65 && oddsA > 2.8) fixedMatchScore.push(30);
    if (match.market_signals?.some(s => s.type === 'reverse_steam')) fixedMatchScore.push(25);
    const fixedScore = fixedMatchScore.reduce((a,b) => a + b, 0);
    
    const dynamics = [];
    if (fixedScore >= 50) dynamics.push("🎭 MATCH VENDU");
    else if (fixedScore >= 35) dynamics.push("⚠️ SUSPICION HAUTE");
    else if (fixedScore >= 20) dynamics.push("❓ SUSPICION");
    if (enriched.bankroll_advice?.recommendedPercentage > 0) dynamics.push(`💵 ${enriched.bankroll_advice.recommendedPercentage}%`);
    if (match.ev_best && match.ev_best !== 'NONE') {
        const evVal = match[`ev_${match.ev_best.toLowerCase()}`];
        if (evVal > 0) dynamics.push(`📈 EV+ ${evVal.toFixed(1)}%`);
    }
    if (match.kelly_stake > 0) {
        dynamics.push(`🎯 KELLY ${match.kelly_stake.toFixed(1)}%`);
    }
    if (match.smart_money_active || enriched.smart_money_active) dynamics.push("💰");
    const analysisObj = match.detailed_analysis || enriched.detailed_analysis || {};
    if (analysisObj["Weather"]?.Impact < 0.95) dynamics.push("🌧️");
    if (match.insufficient_data === 1) dynamics.push("⚠️ DATA");
    
    // Boosted Sensors (Simulated tactical intelligence)
    const domStrength = Math.max(hPct, aPct);
    if (domStrength > 75) dynamics.push("⚡ PRESSURE");
    if (match.isLive && (match.minute || "").includes("'")) dynamics.push("🛰️ MOMENTUM");

    const probStr = validMarkets[0] ? `(${Math.round(validMarkets[0].prob > 1 ? validMarkets[0].prob : validMarkets[0].prob * 100)}%)` : "";
    if (isVetoed) dynamics.unshift("🛡️ VETO (ALPHA)");
    const dynString = (dynamics.join(" ") + " " + probStr).trim() || "-";

    const rowStyle = { 
        ...(isElite ? { background: `rgba(0, 255, 170, ${acc >= 95 ? 0.05 : 0.02})` } : {})
    };
    const homeName = (match.homeTeam || "N/A").toUpperCase();
    const awayName = (match.awayTeam || "N/A").toUpperCase();

    let statusClass = "scheduled";
    const status = (match.status || "").toLowerCase();

    // [UTC FIX] Force Africa/Tunis Timezone
    let formattedTime = "";
    if (match.startTimestamp) {
        const date = new Date(match.startTimestamp > 1e11 ? match.startTimestamp : match.startTimestamp * 1000);
        formattedTime = date.toLocaleTimeString('fr-TN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Tunis' });
    }

    let resultIcon = null;
    if (status === "finished" || status === "ft" || status === "ended") {
        statusClass = "finished";
        if (match.scoreHome !== null && match.scoreAway !== null) {
            const h = match.scoreHome; const a = match.scoreAway; const total = h + a;
            let smartCorrect = false;
            const pick = (match.prediction || "").toLowerCase();
            if (pick.includes('home') || pick === '1') smartCorrect = h > a;
            else if (pick.includes('away') || pick === '2') smartCorrect = a > h;
            else if (pick.includes('draw') || pick === 'x') smartCorrect = h === a;
            const csCorrect = (cs === `${h} - ${a}`);
            let tgCorrect = false;
            if (tg.includes('+')) tgCorrect = total > parseFloat(tg.replace('+', ''));
            else if (tg.includes('-')) tgCorrect = total < parseFloat(tg.replace('-', ''));
            resultIcon = (
                <div style={{display: 'inline-flex', gap: '4px', marginLeft: '8px'}}>
                    <span title="SMART PICK" style={{color: smartCorrect ? '#00ff66' : '#ff3333'}}>●</span>
                    <span title="CS (AI)" style={{color: csCorrect ? '#00ff66' : '#ff3333'}}>●</span>
                    <span title="TG (O/U)" style={{color: tgCorrect ? '#00ff66' : '#ff3333'}}>●</span>
                </div>
            );
        }
    } else if (status === "live" || match.isLive) {
        statusClass = "live";
    }

    const quant = match.quant || (enriched && enriched.quant) || { 
        main_pick: smartPickLabel || 'ANALYZING', 
        secondary_pick: '-', 
        ev_score: '0.00', 
        risk_label: 'WAITING',
        market_strength: 'NORMAL',
        probs: { btts: 0, over25: 0, ht_goal: 0 }
    };

    return (
        <div style={{ ...style, ...rowStyle, display: 'flex', alignItems: 'center', minWidth: 'fit-content' }} className="onyx-virtual-row" onClick={() => onClick(match)}>
            {/* COLUMN 1: MATCH & LEAGUE (20%) */}
            <div style={{width: "20%", minWidth: "180px"}} className="onyx-virtual-cell">
                <div style={{display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px'}}>
                    <span className={`status-dot ${statusClass}`}></span>
                    {formattedTime && (
                        <span style={{fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#fbbf24', fontWeight: '800', background: 'rgba(251, 191, 36, 0.1)', padding: '1px 3px', borderRadius: '4px'}}>
                            {formattedTime}
                        </span>
                    )}
                    <b style={{ fontSize: '12px', color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {homeName} vs {awayName}
                    </b>
                </div>
                <div style={{ fontSize: '10px', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{opacity: 0.7}}>🏆</span>
                    <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                        {(() => {
                            const lower = (match.league || match.tournament_name || '').toLowerCase();
                            
                            // International / Club Cups
                            if (lower.includes('champions league') || lower.includes('ucl') || lower.includes('uefa')) return '🌍 EUROPE : ';
                            if (lower.includes('europa league') || lower.includes('uel')) return '🌍 EUROPE : ';
                            if (lower.includes('conference league')) return '🌍 EUROPE : ';
                            if (lower.includes('copa libertadores') || lower.includes('sudamericana')) return '🌎 AMÉRIQUE DU SUD : ';
                            if (lower.includes('afcon') || lower.includes('caf champions') || lower.includes('caf confederation')) return '🌍 AFRIQUE : ';
                            if (lower.includes('afrique') || lower.includes('african')) return '🌍 AFRIQUE : ';
                            if (lower.includes('asian cup') || lower.includes('afc champions') || lower.includes('afc cup')) return '🌏 ASIE : ';
                            
                            // Specific Leagues & Countries
                            if (lower.includes('algerian') || lower.includes('algeria')) return '🇩🇿 ALGÉRIE : ';
                            if (lower.includes('tunisian') || lower.includes('tunisia')) return '🇹🇳 TUNISIE : ';
                            if (lower.includes('egyptian') || lower.includes('egypt')) return '🇪🇬 ÉGYPTE : ';
                            if (lower.includes('moroccan') || lower.includes('morocco') || lower.includes('botola')) return '🇲🇦 MAROC : ';
                            if (lower.includes('premier league') || lower.includes('championship') || lower.includes('league one') || lower.includes('league two') || lower.includes('efl') || lower.includes('fa cup')) return '🏴󠁧󠁢󠁥󠁮󠁧󠁿 ANGLETERRE : ';
                            if (lower.includes('laliga') || lower.includes('segunda') || lower.includes('espagne') || lower.includes('copa del rey') || lower.includes('spain')) return '🇪🇸 ESPAGNE : ';
                            if (lower.includes('serie a') || lower.includes('serie b') || lower.includes('italie') || lower.includes('coppa italia') || lower.includes('italy')) return '🇮🇹 ITALIE : ';
                            if (lower.includes('bundesliga') || lower.includes('allemagne') || lower.includes('dfb pokal') || lower.includes('germany')) return '🇩🇪 ALLEMAGNE : ';
                            if (lower.includes('brazil') || lower.includes('brésil') || lower.includes('paulista') || lower.includes('carioca')) return '🇧🇷 BRÉSIL : ';
                            if (lower.includes('mls') || lower.includes('major league soccer') || lower.includes('usa') || lower.includes('us open cup')) return '🇺🇸 USA : ';
                            if (lower.includes('portugal') || lower.includes('primeira liga') || lower.includes('taca de portugal')) return '🇵🇹 PORTUGAL : ';
                            if (lower.includes('ligue 1') || lower.includes('ligue 2') || lower.includes('france') || lower.includes('coupe de france') || lower.includes('national')) return '🇫🇷 FRANCE : ';
                            if (lower.includes('eredivisie') || lower.includes('eerste divisie') || lower.includes('netherlands') || lower.includes('pays-bas')) return '🇳🇱 PAYS-BAS : ';
                            if (lower.includes('premiership') && lower.includes('scot') || lower.includes('scottish')) return '🏴󠁧󠁢󠁳󠁣󠁴󠁿 ÉCOSSE : ';
                            if (lower.includes('super lig') || lower.includes('turkey') || lower.includes('turquie') || lower.includes('1. lig')) return '🇹🇷 TURQUIE : ';
                            if (lower.includes('saudi') || lower.includes('kings cup')) return '🇸🇦 ARABIE SAOUDITE : ';
                            if (lower.includes('qatar') || lower.includes('stars league')) return '🇶🇦 QATAR : ';
                            if (lower.includes('uae') || lower.includes('emirates') || lower.includes('gulf league')) return '🇦🇪 ÉMIRATS ARABES UNIS : ';
                            if (lower.includes('swiss') || lower.includes('suisse') || lower.includes('super league')) return '🇨🇭 SUISSE : ';
                            if (lower.includes('austria') || lower.includes('autriche')) return '🇦🇹 AUTRICHE : ';
                            if (lower.includes('denmark') || lower.includes('danemark') || lower.includes('superliga')) return '🇩🇰 DANEMARK : ';
                            if (lower.includes('norway') || lower.includes('norvège') || lower.includes('eliteserien')) return '🇳🇴 NORVÈGE : ';
                            if (lower.includes('sweden') || lower.includes('suède') || lower.includes('allsvenskan')) return '🇸🇪 SUÈDE : ';
                            if (lower.includes('finland') || lower.includes('finlande') || lower.includes('veikkausliiga')) return '🇫🇮 FINLANDE : ';
                            if (lower.includes('poland') || lower.includes('pologne') || lower.includes('ekstraklasa')) return '🇵🇱 POLOGNE : ';
                            if (lower.includes('greece') || lower.includes('grèce') || lower.includes('super league')) return '🇬🇷 GRÈCE : ';
                            if (lower.includes('croatia') || lower.includes('croatie') || lower.includes('hnl')) return '🇭🇷 CROATIE : ';
                            if (lower.includes('czech') || lower.includes('tchèque') || lower.includes('1. liga')) return '🇨🇿 RÉPUBLIQUE TCHÈQUE : ';
                            if (lower.includes('romania') || lower.includes('roumanie') || lower.includes('liga i') || lower.includes('liga 1')) return '🇷🇴 ROUMANIE : ';
                            if (lower.includes('ukraine')) return '🇺🇦 UKRAINE : ';
                            if (lower.includes('russia') || lower.includes('russie')) return '🇷🇺 RUSSIE : ';
                            if (lower.includes('argentina') || lower.includes('argentine') || lower.includes('primera division')) return '🇦🇷 ARGENTINE : ';
                            if (lower.includes('colombia') || lower.includes('colombie')) return '🇨🇴 COLOMBIE : ';
                            if (lower.includes('mexico') || lower.includes('mexique') || lower.includes('liga mx')) return '🇲🇽 MEXIQUE : ';
                            if (lower.includes('japan') || lower.includes('japon') || lower.includes('j1 league') || lower.includes('j2 league')) return '🇯🇵 JAPON : ';
                            if (lower.includes('korea') || lower.includes('corée') || lower.includes('k league')) return '🇰🇷 CORÉE DU SUD : ';
                            if (lower.includes('australia') || lower.includes('australie') || lower.includes('a-league')) return '🇦🇺 AUSTRALIE : ';
                            if (lower.includes('south africa') || lower.includes('afrique du sud') || lower.includes('psl')) return '🇿🇦 AFRIQUE DU SUD : ';
                            if (lower.includes('india') || lower.includes('inde')) return '🇮🇳 INDE : ';
                            if (lower.includes('belgium') || lower.includes('belgique') || lower.includes('jupiler')) return '🇧🇪 BELGIQUE : ';
                            if (lower.includes('chile') || lower.includes('chili')) return '🇨🇱 CHILI : ';
                            if (lower.includes('uruguay')) return '🇺🇾 URUGUAY : ';
                            if (lower.includes('paraguay')) return '🇵🇾 PARAGUAY : ';
                            if (lower.includes('ecuador') || lower.includes('équateur')) return '🇪🇨 ÉQUATEUR : ';
                            if (lower.includes('china') || lower.includes('chine')) return '🇨🇳 CHINE : ';
                            
                            return '⚽ ';
                        })()}
                        {match.league || match.tournament_name || "Unknown"}
                    </span>
                </div>
            </div>
            
            {/* COLUMN 2: PRONOSTICS (MAIN & SECONDARY) (25%) - WIDENED */}
            <div style={{width: "25%", minWidth: "200px"}} className="onyx-virtual-cell">
                <div style={{display: 'flex', flexDirection: 'column', gap: '2px'}}>
                    <div style={{display: 'flex', alignItems: 'center', gap: '5px'}}>
                        <span style={{fontSize: '9px', color: 'var(--neon)', fontWeight: '900', minWidth: '30px'}}>MAIN</span>
                        <span style={{fontSize: '12.5px', color: '#f1f5f9', fontWeight: '800', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                            {(quant.main_pick || '').replace(/🛡️|⚽|⚡|🔥|🏠|✈️|AH_|EH_|COMBOS: |SMART VALUE: /g, '').trim()}
                        </span>
                    </div>
                    <div style={{display: 'flex', alignItems: 'center', gap: '5px'}}>
                        <span style={{fontSize: '9px', color: '#94a3b8', fontWeight: '900', minWidth: '30px'}}>2ND</span>
                        <span style={{fontSize: '11px', color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                            {(quant.secondary_pick || '-').replace(/🛡️|⚽|⚡|🔥|🏠|✈️|AH_|EH_|COMBOS: |SMART VALUE: /g, '').trim()}
                        </span>
                    </div>
                </div>
            </div>

            {/* COLUMN 3: AI SCORE & HT GOAL (8%) - NARROWED */}
            <div style={{width: "8%", minWidth: "70px"}} className="onyx-virtual-cell centered">
                <span className="onyx-cs" style={{fontSize: '14px', fontWeight: '900', color: '#00ffaa'}}>{cs}</span>
                <div style={{fontSize: '9px', color: '#fbbf24', fontWeight: 'bold'}}>
                    HT: {quant.probs?.ht_goal || match.ht_goal_prob || 0}%
                </div>
            </div>

            {/* COLUMN 4: MARKET PROBS (BTTS / O2.5) (12%) */}
            <div style={{width: "12%", minWidth: "100px"}} className="onyx-virtual-cell centered">
                <div style={{display: 'flex', flexDirection: 'column', gap: '4px', width: '100%', padding: '0 5px'}}>
                    <div style={{display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#cbd5e1'}}>
                        <span>BTTS</span>
                        <span style={{fontWeight: '900', color: (quant.probs?.btts || pBTTS) > 60 ? '#10b981' : '#f8fafc'}}>{quant.probs?.btts || pBTTS}%</span>
                    </div>
                    <div style={{display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#cbd5e1'}}>
                        <span>O2.5</span>
                        <span style={{fontWeight: '900', color: (quant.probs?.over25 || pOU25_pct) > 60 ? '#10b981' : '#f8fafc'}}>{quant.probs?.over25 || pOU25_pct}%</span>
                    </div>
                </div>
            </div>

            {/* COLUMN 5: PRECISION & RISK (12%) */}
            <div style={{width: "12%", minWidth: "110px"}} className="onyx-virtual-cell centered">
                <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                    <span className={`${accClass}`} style={{fontSize: '15px', fontWeight: '900', color: acc >= 70 ? 'var(--neon)' : '#f59e0b'}}>{acc}%</span>
                    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start'}}>
                        <span style={{fontSize: '8.5px', fontWeight: '900', color: '#94a3b8'}}>{quant.risk_label || (acc >= 70 ? 'SAFE' : 'MODERATE')}</span>
                        <div style={{display: 'flex', gap: '2px'}}>{statusIcon}{resultIcon}</div>
                    </div>
                </div>
            </div>

            {/* COLUMN 6: SIGNAL & EV SCORE (12%) */}
            <div style={{width: "12%", minWidth: "110px"}} className="onyx-virtual-cell centered">
                <div style={{display: 'flex', flexDirection: 'column', gap: '4px'}}>
                    <div className={quant.massive_edge || match.massive_edge ? "onyx-massive-edge-pulse" : ""} style={{
                        background: parseFloat(quant.ev_score) > 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                        border: `1px solid ${parseFloat(quant.ev_score) > 0 ? '#10b98155' : '#ef444455'}`,
                        padding: '2px 6px',
                        borderRadius: '4px',
                        textAlign: 'center',
                        fontSize: (quant.massive_edge || match.massive_edge) ? '9px' : '10.5px'
                    }}>
                        <span style={{fontWeight: '900'}}>
                            {(quant.massive_edge || match.massive_edge) ? '🔥 MASSIVE' : `EV ${quant.ev_score}`}
                        </span>
                    </div>
                    {(match.kelly_stake > 0 || quant.signal_strength > 0) && (
                        <div style={{fontSize: '8.5px', color: '#38bdf8', fontWeight: '900', textAlign: 'center'}}>
                            {quant.massive_edge ? `STR: ${quant.signal_strength || 0}%` : `K: ${match.kelly_stake.toFixed(1)}%`}
                        </div>
                    )}
                </div>
            </div>

            {/* COLUMN 7: STRENGTH (11%) */}
            <div style={{width: "11%", minWidth: "90px"}} className="onyx-virtual-cell centered">
                <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
                    <div style={{fontSize: '13px', fontWeight: '900', color: msColor, letterSpacing: '1px'}}>
                        {quant.market_strength || msDesc}
                    </div>
                    <div className="onyx-progress-container" style={{height: '3px', width: '60px', marginTop: '4px'}}>
                        <div className="onyx-progress-bar" style={{width: `${(ms || 0) * 10}%`, background: msColor}}></div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default React.memo(MatchRow);

import React from 'react';
import SuspiciousIcon from '../assets/suspicious_match.webp';
import SafeBetIcon from '../assets/safe_bet.webp';

const MatchRow = ({ match, isElite, onClick, style, now }) => {
    // Shared reference to enriched sub-object
    const enriched = match.enriched || {};

    const normalizePct = (value) => {
        const n = Number(value || 0);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return n > 1 ? n : n * 100;
    };

    const toScore = (score) => {
        if (!score || !String(score).includes('-')) return null;
        const [home, away] = String(score).split('-').map(s => parseInt(s.trim()));
        if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
        return { home, away, total: home + away };
    };

    const hPct = parseFloat(match.home_win_probability || enriched.home_win_probability || 0);
    const aPct = parseFloat(match.away_win_probability || enriched.away_win_probability || 0);
    const dPct = parseFloat(match.draw_probability || enriched.draw_probability || 0);
    const pOU25 = Number(match.ou_25_prob || enriched?.ou_25_prob || 0);
    const pBTTS = Number(match.btts_prob || enriched?.btts_prob || 0);
    const quantObj = match.quant || (enriched && enriched.quant);
    const mainPick = (quantObj?.main_pick || '').toString().trim().toUpperCase();
    const marketAnalysis = match.marketAnalysis || {}
    const dcOdds = marketAnalysis.doubleChance || null

    const bttsPct = Math.round(normalizePct(quantObj?.probs?.btts || pBTTS));
    const over25Pct = Math.round(normalizePct(quantObj?.probs?.over25 || pOU25));

    // derivePreciseFTScore removed – backend score is authoritative

    // Determine CS (AI Correct Score) — backend score is authoritative
    const getCS = () => {
        const quantScore = match.quant?.expected_score || enriched?.quant?.expected_score;
        if (quantScore && quantScore.includes('-')) return quantScore;

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

        const highScoring = over25Pct > 60 || bttsPct > 62;
        if (hPct > 0 || aPct > 0) {
            const baseScore = (() => {
                if (hPct > aPct + 25) return highScoring ? '2 - 1' : '1 - 0';
                if (aPct > hPct + 25) return highScoring ? '1 - 2' : '0 - 1';
                if (hPct > aPct + 12) return highScoring ? '2 - 1' : '1 - 0';
                if (aPct > hPct + 12) return highScoring ? '1 - 2' : '0 - 1';
                return bttsPct > 58 ? '1 - 1' : (hPct >= aPct ? '1 - 0' : '0 - 1');
            })();
            return derivePreciseFTScore(baseScore);
        }
        return '1 - 1';
    };
    const rawCS = getCS();

    // ─── COHERENCE FIX: Align CS with MAIN pick ─────────────────────
    const alignCSWithPick = (rawScore, pick) => {
        if (!rawScore || !rawScore.includes('-')) return rawScore;
        const parts = rawScore.split('-').map(s => parseInt(s.trim()));
        if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return rawScore;
        const [h, a] = parts;

        // Determine direction required by MAIN pick
        const wantHome  = pick === '1'  || pick.includes('HOME');
        const wantAway  = pick === '2'  || pick.includes('AWAY');
        const wantDraw  = pick === 'X'  || pick.includes('DRAW') || pick === 'NUL';

        const highScoring = over25Pct > 60 || bttsPct > 62;

        if (wantHome && h <= a) {
            // CS contradicts pick → flip to a home win
            if (highScoring) return `${a + 1} - ${a}`;          // e.g. 2-1
            return `${Math.max(1, a)} - ${Math.max(0, a - 1)}`; // e.g. 1-0
        }
        if (wantAway && a <= h) {
            // CS contradicts pick → flip to an away win
            if (highScoring) return `${h} - ${h + 1}`;          // e.g. 1-2
            return `${Math.max(0, h - 1)} - ${Math.max(1, h)}`; // e.g. 0-1
        }
        if (wantDraw && h !== a) {
            // CS contradicts pick → make it a draw
            const drawGoals = Math.round((h + a) / 2);
            return `${drawGoals} - ${drawGoals}`;
        }
        // Already coherent
        return rawScore;
    };

    const cs = alignCSWithPick(rawCS, mainPick);
    // ─────────────────────────────────────────────────────────────────

    const ftSignal = (() => {
        const parsed = toScore(cs);
        const bttsPct = normalizePct(quantObj?.probs?.btts || pBTTS);
        const overPct = normalizePct(quantObj?.probs?.over25 || pOU25);
        const h = normalizePct(match.home_win_probability || enriched.home_win_probability);
        const d = normalizePct(match.draw_probability || enriched.draw_probability);
        const a = normalizePct(match.away_win_probability || enriched.away_win_probability);
        const resultProb = parsed
            ? (parsed.home > parsed.away ? h : parsed.away > parsed.home ? a : d)
            : Math.max(h, d, a);
        let coherence = resultProb || 45;

        if (parsed) {
            const scoreBtts = parsed.home > 0 && parsed.away > 0;
            const scoreOver = parsed.total >= 3;
            coherence += scoreBtts ? (bttsPct - 50) * 0.25 : ((100 - bttsPct) - 50) * 0.2;
            coherence += scoreOver ? (overPct - 50) * 0.25 : ((100 - overPct) - 50) * 0.2;
            if (parsed.total > 4) coherence -= 6;
        }

        if (match.insufficient_data === 1) coherence = Math.min(coherence, 75);
        return Math.max(8, Math.min(95, Math.round(coherence)));
    })();
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

    const parsedCS = toScore(cs);
    const scoreBtts = parsedCS ? (parsedCS.home > 0 && parsedCS.away > 0) : false;
    const scoreTotal = parsedCS ? parsedCS.total : 0;

    // Coherent BTTS recommendation
    const bttsLabel = scoreBtts ? 'OUI' : 'NON';
    const bttsDisplayPct = scoreBtts ? bttsPct : (100 - bttsPct);
    const bttsBadgeBg = scoreBtts ? 'rgba(0, 255, 170, 0.12)' : 'rgba(239, 68, 68, 0.12)';
    const bttsBadgeColor = scoreBtts ? '#00ffaa' : '#f87171';
    const bttsBadgeBorder = scoreBtts ? 'rgba(0, 255, 170, 0.3)' : 'rgba(239, 68, 68, 0.3)';

    // Coherent Total Goals (TG) recommendation based on scoreTotal
    let tg = "-2.5";
    let tgClass = "onyx-draw";
    let tgBadgeBg = 'rgba(148, 163, 184, 0.12)'; // Slate/Gray
    let tgBadgeColor = '#94a3b8';
    let tgBadgeBorder = 'rgba(148, 163, 184, 0.3)';

    if (scoreTotal >= 4) {
        tg = "+3.5";
        tgClass = "onyx-win";
        tgBadgeBg = 'rgba(16, 185, 129, 0.12)';
        tgBadgeColor = '#10b981';
        tgBadgeBorder = 'rgba(16, 185, 129, 0.3)';
    } else if (scoreTotal === 3) {
        tg = "+2.5";
        tgClass = "onyx-win";
        tgBadgeBg = 'rgba(16, 185, 129, 0.12)';
        tgBadgeColor = '#10b981';
        tgBadgeBorder = 'rgba(16, 185, 129, 0.3)';
    } else if (scoreTotal === 2) {
        tg = "+1.5";
        tgClass = "onyx-win";
        tgBadgeBg = 'rgba(16, 185, 129, 0.12)';
        tgBadgeColor = '#10b981';
        tgBadgeBorder = 'rgba(16, 185, 129, 0.3)';
    } else if (scoreTotal === 1) {
        tg = "-2.5";
        tgClass = "onyx-draw";
        tgBadgeBg = 'rgba(148, 163, 184, 0.12)';
        tgBadgeColor = '#94a3b8';
        tgBadgeBorder = 'rgba(148, 163, 184, 0.3)';
    } else if (scoreTotal === 0) {
        tg = "-1.5";
        tgClass = "onyx-draw";
        tgBadgeBg = 'rgba(148, 163, 184, 0.12)';
        tgBadgeColor = '#94a3b8';
        tgBadgeBorder = 'rgba(148, 163, 184, 0.3)';
    }

    // Coherent Over/Under label
    const ouLabel = scoreTotal >= 3 ? 'O2.5' : 'U2.5';
    const ouDisplayPct = scoreTotal >= 3 ? over25Pct : (100 - over25Pct); 

    let accClass = "onyx-acc-low";
    let isVetoed = false;
    
    if (acc >= 70) accClass = "onyx-acc-high";
    else if (acc >= 55) accClass = "onyx-acc-med";
    else {
        accClass = "onyx-acc-low";
        isVetoed = true; // Alpha Zero-Failure Veto (Now at 55%)
    }

    const domProb  = Math.max(hPct, aPct);
    const displayOddsH = match.display_odds_home || match.best_odds_home || match.odds_home;
    const displayOddsA = match.display_odds_away || match.best_odds_away || match.odds_away;
    const hasOdds  = !!(displayOddsH && displayOddsA);
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
    const oddsH = parseFloat(displayOddsH || 0);
    const oddsA = parseFloat(displayOddsA || 0);
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

    // ⏰ Countdown timer
    let countdownStr = ""
    const matchTime = match.startTimestamp ? (match.startTimestamp > 1e11 ? match.startTimestamp : match.startTimestamp * 1000) : 0
    if (now && matchTime > 0) {
        const diff = matchTime - now
        if (diff > 0) {
            const hours = Math.floor(diff / 3600000)
            const minutes = Math.floor((diff % 3600000) / 60000)
            const secs = Math.floor((diff % 60000) / 1000)
            if (hours > 24) {
                countdownStr = `${Math.floor(hours / 24)}j ${hours % 24}h`
            } else if (hours > 0) {
                countdownStr = `${hours}h ${minutes}m`
            } else if (minutes > 0) {
                countdownStr = `${minutes}m ${secs}s`
            } else {
                countdownStr = `${secs}s`
            }
        } else if (diff > -7200000) {
            countdownStr = "🔴 EN COURS"
        }
    }

    // 📊 Mini form badges
    const hForm = match.home_form_rating || match.enriched?.home_form_rating || 0
    const aForm = match.away_form_rating || match.enriched?.away_form_rating || 0
    const renderFormBadge = (rating) => {
        if (!rating || rating <= 0) return <span style={{fontSize: '8px', color: '#475569'}}>—</span>
        const color = rating >= 70 ? '#00ffaa' : rating >= 50 ? '#fbbf24' : '#f87171'
        const label = rating >= 70 ? 'H' : rating >= 50 ? 'M' : 'B'
        return (
            <span style={{fontSize: '8px', fontWeight: '900', color, background: `${color}15`, border: `1px solid ${color}30`, borderRadius: '3px', padding: '0 3px'}}>
                {label}{Math.round(rating)}
            </span>
        )
    }

    // 🏆 Value Score (computed after evNum declaration below)

    let resultIcon = null;
    let resultBulb = null;
    let actualScoreDisplay = null;
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
            resultBulb = (
                <span style={{fontSize: '20px', lineHeight: 1, marginLeft: '4px', cursor: 'help'}} title={smartCorrect ? 'PRONOSTIC CORRECT ✓' : 'PRONOSTIC FAUX ✗'}>
                    {smartCorrect ? '🟢' : '🔴'}
                </span>
            );
            actualScoreDisplay = `${h} - ${a}`;
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

    const getOddsForPick = (pick) => {
        if (!pick) return null;
        const p = pick.trim();
        if (p === '1' || p === 'HOME') return displayOddsH;
        if (p === '2' || p === 'AWAY') return displayOddsA;
        if (p === 'X' || p === 'N' || p === 'DRAW') return match.odds_draw;
        return null;
    };
    const mainOdds = getOddsForPick(quant.main_pick);
    const mainPickClean = (quant.main_pick || '').replace(/🛡️|⚽|⚡|🔥|🏠|✈️|AH_|EH_|COMBOS: |SMART VALUE: /g, '').trim();
    const secondPickClean = (quant.secondary_pick || '-').replace(/🛡️|⚽|⚡|🔥|🏠|✈️|AH_|EH_|COMBOS: |SMART VALUE: /g, '').trim();

    const totalPct = hPct + dPct + aPct;
    const hBar = totalPct > 0 ? (hPct / totalPct) * 100 : 33.3;
    const dBar = totalPct > 0 ? (dPct / totalPct) * 100 : 33.3;
    const aBar = totalPct > 0 ? (aPct / totalPct) * 100 : 33.3;

    const evNum = parseFloat(quant.ev_score) || 0;
    const valueScore = (evNum * acc / 100).toFixed(1)
    const evArrow = evNum > 0.15 ? '📈' : evNum > 0 ? '↗️' : evNum === 0 ? '➖' : '📉';
    const evColor = evNum > 0.15 ? '#10b981' : evNum > 0 ? '#34d399' : evNum === 0 ? '#94a3b8' : '#ef4444';

    const [isMobile, setIsMobile] = React.useState(typeof window !== 'undefined' && window.innerWidth < 768)

    React.useEffect(() => {
        const handleResize = () => {
            setIsMobile(window.innerWidth < 768)
        }
        window.addEventListener('resize', handleResize)
        return () => window.removeEventListener('resize', handleResize)
    }, [])

    const dataQuality = match.insufficient_data === 1 ? '⚠️' : '✅'
    const dataQualityLabel = match.insufficient_data === 1 ? 'LOW DATA' : ''

    const formatOdds = (odds) => {
        if (!odds || isNaN(odds)) return null
        return odds.toFixed(2)
    }

    if (isMobile) {
        return (
            <div style={{ ...style, padding: '4px 6px', boxSizing: 'border-box' }}>
                <div 
                    className={`onyx-mobile-card ${statusClass}`}
                    onClick={() => onClick(match)}
                    style={{
                        background: isElite ? 'linear-gradient(135deg, rgba(0, 255, 170, 0.08) 0%, #030712 100%)' : 'linear-gradient(135deg, #090f1a 0%, #020408 100%)',
                        border: `1px solid ${isElite ? 'rgba(0, 255, 170, 0.25)' : 'rgba(255,255,255,0.06)'}`,
                        borderRadius: '10px',
                        padding: '10px',
                        height: '100%',
                        boxSizing: 'border-box',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                        boxShadow: isElite ? '0 4px 15px rgba(0, 255, 170, 0.08)' : 'none',
                        position: 'relative'
                    }}
                >
                    {/* Top line: Time, League, and status */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '9px', color: '#64748b' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
                            <span className={`status-dot ${statusClass}`} style={{ width: '5px', height: '5px', flexShrink: 0 }}></span>
                            {formattedTime && (
                                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#fbbf24', fontWeight: '800', background: 'rgba(251, 191, 36, 0.1)', padding: '1px 3px', borderRadius: '3px', flexShrink: 0 }}>
                                    {formattedTime}
                                </span>
                            )}
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '140px' }}>
                                {match.league || 'Ligue'}
                            </span>
                        </div>
                        
                        {/* Confidence Accuracy */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                            <span style={{ color: acc >= 70 ? 'var(--neon)' : acc >= 55 ? '#fbbf24' : '#f87171', fontWeight: '800' }}>
                                {acc}%
                            </span>
                            <span style={{ fontSize: '8px', color: '#475569' }}>CONF.</span>
                        </div>
                    </div>

                    {/* Middle line: Teams and AI Correct Score */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 0' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '13px', fontWeight: '800', color: '#f8fafc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {homeName}
                            </div>
                            <div style={{ fontSize: '13px', fontWeight: '800', color: '#f8fafc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                                {awayName}
                            </div>
                        </div>

                        {/* AI Correct Score Badge */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(0, 255, 170, 0.08)', border: '1px solid rgba(0, 255, 170, 0.25)', borderRadius: '6px', padding: '4px 10px', minWidth: '60px', position: 'relative' }}>
                            <span style={{ fontSize: '8px', color: '#64748b', fontWeight: '900', letterSpacing: '0.5px' }}>SCORE IA</span>
                            <span style={{ fontSize: '15px', fontWeight: '900', color: 'var(--neon)', fontFamily: "'JetBrains Mono', monospace" }}>{cs}</span>
                            {actualScoreDisplay && (
                                <span style={{ fontSize: '12px', fontWeight: '900', color: '#f8fafc', fontFamily: "'JetBrains Mono', monospace", marginTop: '2px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '2px' }}>
                                    {actualScoreDisplay}
                                </span>
                            )}
                            {resultBulb && (
                                <span style={{ position: 'absolute', top: '-6px', right: '-6px', filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.5))' }}>
                                    {resultBulb}
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Bottom line: Pick, odds, and secondary markets */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '6px', fontSize: '10px' }}>
                        {/* Main Pick */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
                            <span style={{ background: 'rgba(0, 255, 170, 0.1)', color: 'var(--neon)', fontWeight: '900', padding: '1px 4px', borderRadius: '3px', fontSize: '8px' }}>PICK</span>
                            <span style={{ fontWeight: '800', color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '90px' }}>
                                {mainPickClean}
                            </span>
                            {mainOdds && (
                                <span style={{ color: '#fbbf24', fontWeight: '700', fontFamily: "'JetBrains Mono', monospace" }}>
                                    @{formatOdds(mainOdds)}
                                </span>
                            )}
                        </div>

                        {/* Markets and Tags */}
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                            {/* BTTS */}
                            <span style={{ fontSize: '8px', fontWeight: '800', padding: '1px 4px', borderRadius: '3px', background: bttsBadgeBg, color: bttsBadgeColor, border: `1px solid ${bttsBadgeBorder}` }}>
                                BTTS: {bttsLabel}
                            </span>
                            {/* TG */}
                            <span style={{ fontSize: '8px', fontWeight: '800', padding: '1px 4px', borderRadius: '3px', background: tgBadgeBg, color: tgBadgeColor, border: `1px solid ${tgBadgeBorder}` }}>
                                {tg}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div style={{ ...style, ...rowStyle, display: 'flex', alignItems: 'center', minWidth: 'fit-content' }} className="onyx-virtual-row" onClick={() => onClick(match)}>
            {/* COLUMN 1: MATCH & LEAGUE (22%) */}
            <div style={{width: "22%", minWidth: "160px"}} className="onyx-virtual-cell">
                <div style={{display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '1px', minWidth: 0}}>
                    <span className={`status-dot ${statusClass}`} style={{flexShrink: 0}}></span>
                    {formattedTime && (
                        <span style={{fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', color: '#fbbf24', fontWeight: '800', background: 'rgba(251, 191, 36, 0.1)', padding: '1px 3px', borderRadius: '4px', flexShrink: 0}}>
                            {formattedTime}
                        </span>
                    )}
                    {countdownStr && !countdownStr.includes("EN COURS") && (
                        <span style={{fontFamily: "'JetBrains Mono', monospace", fontSize: '8px', color: '#38bdf8', fontWeight: '700', background: 'rgba(56,189,248,0.08)', padding: '1px 2px', borderRadius: '3px', flexShrink: 0}}>
                            -{countdownStr}
                        </span>
                    )}
                    <b style={{ fontSize: '12px', color: '#f8fafc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 0', minWidth: 0 }}>
                        {homeName} vs {awayName}
                    </b>
                </div>
                <div style={{ fontSize: '9px', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '3px', minWidth: 0 }}>
                    <span style={{opacity: 0.6, flexShrink: 0}}>🏆</span>
                    <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 0', minWidth: 0}}>
                        {(() => {
                            const lower = (match.league || match.tournament_name || '').toLowerCase();
                            if (lower.includes('champions league') || lower.includes('ucl') || lower.includes('uefa')) return '🌍 EUROPE : ';
                            if (lower.includes('europa league') || lower.includes('uel')) return '🌍 EUROPE : ';
                            if (lower.includes('conference league')) return '🌍 EUROPE : ';
                            if (lower.includes('copa libertadores') || lower.includes('sudamericana')) return '🌎 AMÉRIQUE DU SUD : ';
                            if (lower.includes('afcon') || lower.includes('caf champions') || lower.includes('caf confederation')) return '🌍 AFRIQUE : ';
                            if (lower.includes('afrique') || lower.includes('african')) return '🌍 AFRIQUE : ';
                            if (lower.includes('asian cup') || lower.includes('afc champions') || lower.includes('afc cup')) return '🌏 ASIE : ';
                            if (lower.includes('algerian') || lower.includes('algeria')) return '🇩🇿 ALGÉRIE : ';
                            if (lower.includes('tunisian') || lower.includes('tunisia')) return '🇹🇳 TUNISIE : ';
                            if (lower.includes('egyptian') || lower.includes('egypt')) return '🇪🇬 ÉGYPTE : ';
                            if (lower.includes('moroccan') || lower.includes('morocco') || lower.includes('botola')) return '🇲🇦 MAROC : ';
                            if (lower.includes('premier league') || lower.includes('championship') || lower.includes('league one') || lower.includes('league two') || lower.includes('efl') || lower.includes('fa cup')) return '🏴󠁧󠁢󠁥󠁮󠁧󠁿 ANGLETERRE : ';
                            if (lower.includes('brazil') || lower.includes('brésil') || lower.includes('brasileirão') || lower.includes('paulista') || lower.includes('carioca')) return '🇧🇷 BRÉSIL : ';
                            if (lower.includes('laliga') || lower.includes('segunda') || lower.includes('espagne') || lower.includes('copa del rey') || lower.includes('spain')) return '🇪🇸 ESPAGNE : ';
                            if (lower.includes('serie a') || lower.includes('italie') || lower.includes('coppa italia') || lower.includes('italy')) return '🇮🇹 ITALIE : ';
                            if (lower.includes('bundesliga') || lower.includes('allemagne') || lower.includes('dfb pokal') || lower.includes('germany')) return '🇩🇪 ALLEMAGNE : ';
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
                    <span style={{fontSize: '7px', color: '#475569', flexShrink: 0}}>|</span>
                    {hForm > 0 && <span style={{fontSize:'8px',fontWeight:'900',color:hForm>=70?'#00ffaa':'#fbbf24',flexShrink:0}}>{Math.round(hForm)}</span>}
                    <span style={{fontSize:'6px',color:'#475569',flexShrink:0}}>v</span>
                    {aForm > 0 && <span style={{fontSize:'8px',fontWeight:'900',color:aForm>=70?'#00ffaa':'#fbbf24',flexShrink:0}}>{Math.round(aForm)}</span>}
                </div>
            </div>

            {/* COLUMN 2: PRONOSTICS (MAIN & SECONDARY) (17%) */}
            <div style={{width: "17%", minWidth: "120px"}} className="onyx-virtual-cell">
                <div style={{display: 'flex', flexDirection: 'column', gap: '3px'}}>
                    <div style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                        <span style={{fontSize: '10px', color: 'var(--neon)', fontWeight: '900', minWidth: '32px'}}>MAIN</span>
                        <span style={{fontSize: '12px', color: '#f1f5f9', fontWeight: '800', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                            {mainPickClean}
                        </span>
                        {mainOdds && (
                            <span style={{fontSize: '10px', color: '#fbbf24', fontWeight: '700', fontFamily: "'JetBrains Mono', monospace", background: 'rgba(251,191,36,0.08)', padding: '0 4px', borderRadius: '3px'}}>
                                @{formatOdds(mainOdds)}
                            </span>
                        )}
                    </div>
                    <div style={{width: '100%', height: '2px', background: 'rgba(148,163,184,0.15)', borderRadius: '2px', overflow: 'hidden'}}>
                        <div style={{width: `${Math.min(100, Math.max(5, acc))}%`, height: '100%', background: acc >= 70 ? 'var(--neon)' : acc >= 55 ? '#fbbf24' : '#f87171', borderRadius: '2px'}}></div>
                    </div>
                    <div style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                        {(() => {
                            const raw = quant.secondary_pick || '';
                            const isHT = raw.startsWith('HT:');
                            const isBTTS = raw.startsWith('BTTS:');
                            const isOU = raw.startsWith('O/U');
                            const isDC = raw.startsWith('DC:');
                            const badgeColor = isHT ? '#38bdf8' : isBTTS ? '#a78bfa' : isOU ? '#f59e0b' : '#64748b';
                            const badgeLabel = isHT ? 'HT' : isBTTS ? 'BTTS' : isOU ? 'O/U' : isDC ? 'DC' : '';
                            return (
                                <>
                                    {badgeLabel && (
                                        <span style={{fontSize: '8px', fontWeight: '900', color: badgeColor, border: `1px solid ${badgeColor}33`, borderRadius: '3px', padding: '0 4px', background: `${badgeColor}11`, letterSpacing: '0.5px'}}>
                                            {badgeLabel}
                                        </span>
                                    )}
                                    <span style={{fontSize: '11px', color: badgeColor || '#94a3b8', fontWeight: '700', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                                        {secondPickClean}
                                    </span>
                                </>
                            );
                        })()}
                    </div>
                </div>
            </div>

            {/* COLUMN 3: AI SCORE & FT confidence (12%) */}
            <div style={{width: "12%", minWidth: "90px"}} className="onyx-virtual-cell centered">
                <div style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                    <span className="onyx-cs" style={{fontSize: '16px', fontWeight: '900', color: '#00ffaa'}}>{cs}</span>
                    {resultBulb}
                </div>
                {actualScoreDisplay && (
                    <span style={{fontSize: '13px', fontWeight: '900', color: '#f8fafc', fontFamily: "'JetBrains Mono', monospace", marginTop: '1px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '1px', display: 'block'}}>
                        {actualScoreDisplay}
                    </span>
                )}
                <div style={{fontSize: '11px', color: '#fbbf24', fontWeight: 'bold'}}>
                    FT: {ftSignal}%
                </div>
                <div style={{display: 'flex', gap: '2px', width: '100%', height: '4px', marginTop: '2px', borderRadius: '2px', overflow: 'hidden'}}>
                    <div style={{flex: `${Math.round(hBar)}`, height: '100%', background: '#22c55e', minWidth: hBar > 0 ? '2px' : '0'}}></div>
                    <div style={{flex: `${Math.round(dBar)}`, height: '100%', background: '#94a3b8', minWidth: dBar > 0 ? '2px' : '0'}}></div>
                    <div style={{flex: `${Math.round(aBar)}`, height: '100%', background: '#3b82f6', minWidth: aBar > 0 ? '2px' : '0'}}></div>
                </div>
            </div>

            {/* COLUMN 4: MARCHÉS (BTTS + O/U + DC) (16%) */}
            <div style={{width: "16%", minWidth: "120px"}} className="onyx-virtual-cell centered">
                <div style={{display: 'flex', flexDirection: 'row', gap: '6px', alignItems: 'center', justifyContent: 'center', width: '100%'}}>
                    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px'}}>
                        <span style={{
                            fontSize: '10px', fontWeight: '900', padding: '1px 4px', borderRadius: '3px',
                            background: bttsBadgeBg, color: bttsBadgeColor,
                            border: `1px solid ${bttsBadgeBorder}`,
                            textTransform: 'uppercase', letterSpacing: '0.2px', whiteSpace: 'nowrap'
                        }}>
                            {bttsLabel}
                        </span>
                        <span style={{fontSize: '10px', color: '#cbd5e1', fontFamily: "'JetBrains Mono', monospace", fontWeight: '700'}}>
                            {bttsDisplayPct}%
                        </span>
                    </div>
                    <div style={{width:'1px', height:'24px', background:'rgba(148,163,184,0.2)'}}></div>
                    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px'}}>
                        <span style={{
                            fontSize: '10px', fontWeight: '900', padding: '1px 4px', borderRadius: '3px',
                            background: tgBadgeBg, color: tgBadgeColor,
                            border: `1px solid ${tgBadgeBorder}`, whiteSpace: 'nowrap'
                        }}>
                            {tg}
                        </span>
                        <span style={{fontSize: '10px', color: '#cbd5e1', fontFamily: "'JetBrains Mono', monospace", fontWeight: '700'}}>
                            {ouLabel}: {ouDisplayPct}%
                        </span>
                    </div>
                </div>
                {dcOdds && (
                    <div style={{display: 'flex', gap: '3px', marginTop: '2px', justifyContent: 'center'}}>
                        <span style={{fontSize: '8px', padding: '1px 3px', borderRadius: '2px', background: 'rgba(168,85,247,0.15)', color: '#a855f7', fontWeight: '700'}}>1X {dcOdds['1X']}</span>
                        <span style={{fontSize: '8px', padding: '1px 3px', borderRadius: '2px', background: 'rgba(59,130,246,0.15)', color: '#3b82f6', fontWeight: '700'}}>12 {dcOdds['12']}</span>
                        <span style={{fontSize: '8px', padding: '1px 3px', borderRadius: '2px', background: 'rgba(245,158,11,0.15)', color: '#f59e0b', fontWeight: '700'}}>X2 {dcOdds['X2']}</span>
                    </div>
                )}
            </div>

            {/* COLUMN 5: PRECISION & RISK (11%) */}
            <div style={{width: "11%", minWidth: "80px"}} className="onyx-virtual-cell centered">
                <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                    <span style={{fontSize: '18px', fontWeight: '900', color: acc >= 70 ? 'var(--neon)' : acc >= 55 ? '#fbbf24' : '#f87171'}}>{acc}%</span>
                    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start'}}>
                        <span style={{fontSize: '10px', fontWeight: '900', color: acc >= 70 ? '#00ffaa' : acc >= 55 ? '#fbbf24' : '#f87171'}}>
                            {acc >= 70 ? 'SOLIDE' : acc >= 55 ? 'MOYEN' : 'RISQUÉ'}
                        </span>
                        <div style={{display: 'flex', gap: '2px', alignItems: 'center'}}>
                            <span style={{fontSize: '10px'}}>{dataQuality}</span>
                            {statusIcon}{resultIcon}
                        </div>
                    </div>
                </div>
            </div>

            {/* COLUMN 6: SIGNAL & EV + VALUE SCORE (14%) */}
            <div style={{width: "14%", minWidth: "100px"}} className="onyx-virtual-cell centered">
                <div style={{display: 'flex', flexDirection: 'column', gap: '2px', width: '100%', alignItems: 'center'}}>
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                        background: evNum > 0 ? 'rgba(16, 185, 129, 0.1)' : evNum < 0 ? 'rgba(239, 68, 68, 0.1)' : 'rgba(148,163,184,0.1)',
                        border: `1px solid ${evNum > 0 ? '#10b98155' : evNum < 0 ? '#ef444455' : '#94a3b855'}`,
                        padding: '1px 6px', borderRadius: '4px', fontSize: '11px', fontWeight: '900'
                    }}>
                        <span>{evArrow}</span>
                        <span style={{color: evColor}}>
                            {quant.massive_edge || match.massive_edge ? 'MASSIVE' : `EV ${quant.ev_score}`}
                        </span>
                    </div>
                    <div style={{display:'flex', gap:'6px', alignItems:'center', justifyContent:'center'}}>
                        {(match.kelly_stake > 0 || quant.signal_strength > 0) && (
                            <span style={{fontSize:'9px', color:'#38bdf8', fontWeight:'900'}}>
                                K:{match.kelly_stake.toFixed(1)}%
                            </span>
                        )}
                        <span style={{fontSize:'10px', fontWeight:'900', color: parseFloat(valueScore) >= 5 ? '#00ffaa' : parseFloat(valueScore) >= 2 ? '#fbbf24' : '#64748b'}}>
                            🏆{valueScore}
                        </span>
                    </div>
                </div>
            </div>

            {/* COLUMN 7: FORCE (10%) */}
            <div style={{width: "10%", minWidth: "60px"}} className="onyx-virtual-cell centered">
                <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px'}}>
                    <div style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                        <span style={{fontSize: '16px', fontWeight: '900', color: msColor}}>{ms || '-'}</span>
                        <span style={{fontSize: '10px', color: msColor, fontWeight: '700'}}>
                            {quant.market_strength || msDesc}
                        </span>
                    </div>
                    <div className="onyx-progress-container" style={{height: '3px', width: '60px', borderRadius: '3px'}}>
                        <div className="onyx-progress-bar" style={{width: `${(ms || 0) * 10}%`, background: msColor, borderRadius: '3px'}}></div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default React.memo(MatchRow);

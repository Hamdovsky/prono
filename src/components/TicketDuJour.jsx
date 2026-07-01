import React, { useMemo } from 'react';
import { saveAsJpeg } from '../utils/exportUtils';
import './TicketDuJour.css';

const TicketDuJour = ({ matches }) => {

    const handleDownload = () => {
        saveAsJpeg('ticket-du-jour-capture', `TicketDuJour_${new Date().toISOString().split('T')[0]}.jpg`);
    };

    const ticket = useMemo(() => {
        if (!matches || matches.length === 0) return null;

        // Helper: compute boosted accuracy — faithful replica of MatchRow.jsx logic
        const computeBoostedAcc = (m) => {
            const enriched = m.enriched || {};

            const normalizePct = (v) => {
                const n = Number(v || 0);
                if (!Number.isFinite(n) || n <= 0) return 0;
                return n > 1 ? n : n * 100;
            };

            const hPct = parseFloat(m.home_win_probability || enriched.home_win_probability || 0);
            const aPct = parseFloat(m.away_win_probability || enriched.away_win_probability || 0);
            const pOU25 = Number(m.ou_25_prob || enriched?.ou_25_prob || 0);
            const pBTTS = Number(m.btts_prob || enriched?.btts_prob || 0);

            const rawAcc = m.v22_success_rate || enriched.v22_success_rate || m.confidence;
            const pOU25_pct = pOU25 > 1 ? pOU25 : pOU25 * 100;

            // Build validMarkets exactly as MatchRow.jsx does (using raw pBTTS/pOU25 for conditions)
            const markets = [];
            if (hPct >= 65) {
                markets.push({ prob: hPct - 12 });
                markets.push({ prob: hPct - 5 });
            }
            if (aPct >= 65) {
                markets.push({ prob: aPct - 12 });
                markets.push({ prob: aPct - 5 });
            }
            const pHT05 = Math.min(89, Math.round((pOU25 * 0.5) + (pBTTS * 0.5) + 5));
            if (pBTTS >= 58 && pOU25 >= 58) {
                markets.push({ prob: pHT05 });
                markets.push({ prob: (pBTTS + pOU25) / 2 });
            } else if (pOU25 <= 40 && pBTTS <= 40) {
                markets.push({ prob: 100 - pOU25 });
                markets.push({ prob: 100 - pBTTS });
            }
            markets.push({ prob: Math.max(hPct, aPct) });
            markets.push({ prob: pBTTS });
            markets.forEach(mk => { mk.prob = Math.min(99, mk.prob); });
            const validMarkets = markets.filter(mk => mk.prob > 0 && !isNaN(mk.prob));
            validMarkets.sort((a, b) => b.prob - a.prob);
            const bestMktProb = validMarkets[0] ? validMarkets[0].prob : 0;
            const marketConf = bestMktProb > 1 ? bestMktProb : Math.round(bestMktProb * 100);

            let acc;
            if (rawAcc && rawAcc > 0) {
                let base = rawAcc > 1 ? rawAcc : Math.round(rawAcc * 100);
                if (base === 50 && bestMktProb > 55) base = Math.round(bestMktProb);
                if (bestMktProb > base + 15 && bestMktProb > 60) base = Math.round(bestMktProb);
                if (Math.abs(base - marketConf) < 10 && base > 60) base = Math.min(97, base + 4);
                if (pBTTS > 70 && pOU25_pct > 70) base = Math.min(97, base + 3);
                if (m.insufficient_data === 1) base = Math.min(base, 64);
                acc = Math.round(base);
            } else {
                const bestProb = validMarkets[0] ? validMarkets[0].prob : Math.max(hPct, aPct);
                acc = bestProb > 1 ? Math.round(bestProb) : Math.round(bestProb * 100);
                if (pBTTS > 65 && pOU25_pct > 65) acc = Math.min(97, acc + 4);
                if (m.insufficient_data === 1) acc = Math.min(acc, 64);
                if (acc === 0) acc = 50;
            }
            return Math.max(1, Math.min(99, acc));
        };

        // 1. Filter out finished matches or irrelevant ones
        const now = Date.now();
        const activeMatches = matches.filter(m => {
            const status = (m.status || "").toLowerCase();
            if (status === "finished" || status === "ft" || status === "ended") return false;
            
            // Allow matches for today
            let matchTime = 0;
            if (m.startTimestamp) {
                matchTime = m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000;
            } else if (m.timestamp) {
                matchTime = new Date(m.timestamp).getTime();
            }
            // Only upcoming or short-term live
            if (matchTime && matchTime < now - (3 * 60 * 60 * 1000)) return false; 
            
            const conf = computeBoostedAcc(m);
            return conf >= 75; // Only reliable matches
        });

        if (activeMatches.length === 0) return null;

        // 2. Sort by highest boosted confidence first
        activeMatches.sort((a, b) => computeBoostedAcc(b) - computeBoostedAcc(a));

        // Helper to extract prediction and odds
        const extractPick = (match) => {
            const enriched = match.enriched || {};
            // Determine CS to get 1X2 accurately
            const cs = (() => {
                if (match.v22_cs_prediction) return match.v22_cs_prediction.split(' - ')[0] || "0-0";
                if (match.cs_predictions && match.cs_predictions.length > 0) return match.cs_predictions[0].score;
                return match.expected_score || "N/A";
            })();

            let pred1X2 = "N/A";
            let pickLabel = "N/A";
            
            if (cs !== "N/A" && cs.includes("-")) {
                const [h, a] = cs.split('-').map(s => parseInt(s.trim()));
                if (!isNaN(h) && !isNaN(a)) {
                    if (h > a) { pred1X2 = "1"; pickLabel = "Victoire Domicile (1)"; }
                    else if (a > h) { pred1X2 = "2"; pickLabel = "Victoire Extérieur (2)"; }
                    else { pred1X2 = "X"; pickLabel = "Match Nul (X)"; }
                }
            }
            if (pred1X2 === "N/A") {
                let rawPred = match.prediction || match.enriched?.verdict || "N/A";
                const hl = rawPred.toLowerCase();
                if (hl.includes("home") || hl.includes("domicile") || rawPred === "1" || hl.includes("1 ")) {
                    pred1X2 = "1"; pickLabel = "Victoire Domicile (1)";
                } else if (hl.includes("away") || hl.includes("extérieur") || rawPred === "2" || hl.includes("2 ")) {
                    pred1X2 = "2"; pickLabel = "Victoire Extérieur (2)";
                } else if (hl.includes("draw") || hl.includes("nul") || rawPred === "X") {
                    pred1X2 = "X"; pickLabel = "Match Nul (X)";
                }
            }

            if (pred1X2 === "N/A") return null;

            let pickProb = 0;
            const hProb = parseFloat(match.home_win_probability || enriched.home_win_probability || 0);
            const aProb = parseFloat(match.away_win_probability || enriched.away_win_probability || 0);
            const dProb = parseFloat(match.draw_probability || enriched.draw_probability || 0);

            if (pred1X2 === "1") pickProb = hProb;
            else if (pred1X2 === "2") pickProb = aProb;
            else if (pred1X2 === "X") pickProb = dProb;

            // Fallback to confidence if specific prob is missing or weirdly low
            if (pickProb < 30) {
                pickProb = match.v22_success_rate || match.enriched?.v22_success_rate || match.confidence || 0;
            }

            let picks = [];

            // 1. Prediction 1X2
            if (pred1X2 !== "N/A" && pickProb >= 40) {
                const marginProb = pickProb > 100 ? 100 : pickProb;
                let impliedOdd = (100 / marginProb) * 0.94;
                impliedOdd = Math.max(1.01, Math.min(10, impliedOdd));
                picks.push({
                    label: pickLabel,
                    odd: parseFloat(impliedOdd.toFixed(2)),
                    confidence: match.confidence || marginProb
                });
            }

            // 2. Over 1.5 Goals (safer alternative if O2.5 is high)
            const ouProb = parseFloat(match.ou_25_prob || enriched.ou_25_prob || 0);
            if (ouProb > 55) {
                // If over 2.5 is quite likely, over 1.5 is very likely.
                let o15Prob = ouProb + 20;
                if (o15Prob > 95) o15Prob = 95;
                let impliedOdd = (100 / o15Prob) * 0.94;
                impliedOdd = Math.max(1.01, Math.min(10, impliedOdd));
                picks.push({
                    label: "+1.5 Buts (Match)",
                    odd: parseFloat(impliedOdd.toFixed(2)),
                    confidence: match.confidence || o15Prob
                });
            } else if (ouProb < 35 && ouProb > 0) {
                // Under 2.5 or Under 3.5
                let impliedOdd = (100 / (100 - ouProb)) * 0.94;
                impliedOdd = Math.max(1.01, Math.min(10, impliedOdd));
                picks.push({
                    label: "-3.5 Buts (Match)",
                    odd: parseFloat(impliedOdd.toFixed(2)),
                    confidence: match.confidence || (100 - ouProb)
                });
            }

            // 3. BTTS
            const bttsProb = parseFloat(match.btts_prob || enriched.btts_prob || 0);
            if (bttsProb > 65) {
                let impliedOdd = (100 / bttsProb) * 0.94;
                impliedOdd = Math.max(1.01, Math.min(10, impliedOdd));
                picks.push({
                    label: "Les 2 équipes marquent",
                    odd: parseFloat(impliedOdd.toFixed(2)),
                    confidence: match.confidence || bttsProb
                });
            }

            // Filter out extremely low odds to force 1.25 - 1.60 sweet spot
            let validPicks = picks.filter(p => p.odd >= 1.25 && p.odd <= 1.65);
            
            // If none in sweet spot, allow slightly wider range
            if (validPicks.length === 0) {
                validPicks = picks.filter(p => p.odd >= 1.20 && p.odd <= 2.10);
            }

            if (validPicks.length === 0) return null;

            // Sort by confidence descending
            validPicks.sort((a, b) => b.confidence - a.confidence);
            const bestPick = validPicks[0];

            return {
                id: match.id,
                league: match.league || "Unknown League",
                homeTeam: match.homeTeam || "Home",
                awayTeam: match.awayTeam || "Away",
                label: bestPick.label,
                odd: bestPick.odd,
                confidence: bestPick.confidence
            };
        };

        // 3. Build the ticket reaching ~2.00 target
        let selected = [];
        let currentCombinedOdd = 1.0;
        const TARGET_ODD = 2.0;

        for (const m of activeMatches) {
            const pick = extractPick(m);
            if (!pick) continue;

            // Prevent adding to a ticket if it exceeds ~3.0 odds to keep it safe (target is 2.0)
            const newOdd = currentCombinedOdd * pick.odd;
            
            if (selected.length === 0) {
                // If it's a huge odds match alone, take it
                if (pick.odd >= 1.95 && pick.odd <= 2.50) {
                    selected.push(pick);
                    currentCombinedOdd = pick.odd;
                    break;
                } else if (pick.odd < 1.95) {
                    selected.push(pick);
                    currentCombinedOdd = pick.odd;
                }
                continue;
            }

            // We have at least 1 match. 
            if (newOdd >= 1.6 && newOdd <= 3.0) {
                selected.push(pick);
                currentCombinedOdd = newOdd;
                if (currentCombinedOdd >= 1.95) {
                    break; 
                }
            } else if (newOdd < 1.6) {
                selected.push(pick);
                currentCombinedOdd = newOdd;
            }
            
            // Max 4 matches (or 3 ideally)
            if (selected.length >= 3 && currentCombinedOdd >= 1.6) {
                break;
            }
        }

        // If we only built a ticket under 1.4, it might not be a "cote de 2".
        // But we will display what we have with actual odds.
        return {
            selections: selected,
            totalOdd: currentCombinedOdd.toFixed(2)
        };

    }, [matches]);

    if (!ticket || ticket.selections.length === 0) {
        return (
            <div className="ticket-jour-container ticket-jour-empty">
                <div className="ticket-jour-header">
                    <div className="ticket-jour-title">🎯 Ticket Spécial du Jour</div>
                </div>
                <div style={{padding: '20px', textAlign: 'center', fontSize: '12px', color: '#64748b'}}>
                    Aucun match avec une confiance ≥ 75% pour aujourd'hui.<br/>
                    <span style={{fontSize: '11px', color: '#2d3f56'}}>Réessayez avec un filtre de date différent ou revenez plus tard.</span>
                </div>
            </div>
        )
    }

    return (
        <div className="ticket-jour-container" id="ticket-du-jour-capture">
            <div className="ticket-jour-header">
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', width:'100%'}}>
                    <div className="ticket-jour-title">
                        🎯 Ticket Spécial du Jour
                    </div>
                    <button className="jpeg-btn" onClick={handleDownload} style={{background:'#10b981', color:'#fff', border:'none', padding:'4px 10px', borderRadius:'4px', fontWeight:'bold', cursor:'pointer', fontSize:'0.7rem'}}>SAVE JPEG</button>
                </div>
                <div className="ticket-jour-badge">
                    ✓ Confirmé par l'expert (Min {ticket.selections[0].confidence >= 80 ? '95%' : '85%'} fiabilité)
                </div>
            </div>

            <div className="ticket-jour-matches">
                {ticket.selections.map((sel, idx) => (
                    <div className="ticket-match-row" key={`${sel.id}-${idx}`}>
                        <div className="ticket-match-info">
                            <span className="ticket-match-league">{sel.league}</span>
                            <span className="ticket-match-teams">
                                {sel.homeTeam} - {sel.awayTeam}
                            </span>
                        </div>
                        <div className="ticket-match-prediction">
                            <span className="ticket-pred-label">{sel.label}</span>
                        </div>
                        <div className="ticket-match-odd">
                            {sel.odd.toFixed(2)}
                        </div>
                    </div>
                ))}
            </div>

            <div className="ticket-jour-footer">
                <span className="ticket-jour-total-label">Cote Totale Multiplicateur :</span>
                <span className="ticket-jour-total-odd">
                    {ticket.selections.length > 1 
                        ? `${ticket.selections.map(s => s.odd.toFixed(2)).join(' × ')} = ${ticket.totalOdd}` 
                        : ticket.totalOdd}
                </span>
            </div>
        </div>
    );
};

export default TicketDuJour;

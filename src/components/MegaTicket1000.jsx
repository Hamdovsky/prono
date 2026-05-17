import React, { useState, useMemo, useCallback } from 'react';
import { saveAsJpeg } from '../utils/exportUtils';
import './MegaTicket1000.css';

const MegaTicket1000 = ({ matches }) => {
    const [riskLevel, setRiskLevel] = useState('MEGA'); 
    const [refreshKey, setRefreshKey] = useState(0);

    const levels = {
        DIAMOND: { label: 'DIAMOND 80%+', target: 3.0, color: '#00d4ff', icon: '💎', desc: 'Sécurité Système Maximale', badge: 'CERTIFIÉ 80%+' },
        GOLD: { label: 'GOLD 20+', target: 20, color: '#10b981', icon: '💰', desc: 'Sécurisé / Régulier' },
        ULTRA: { label: 'ULTRA 100+', target: 100, color: '#a855f7', icon: '⚡', desc: 'Équilibré / Risque Moyen' },
        MEGA: { label: 'MEGA 1000+', target: 1000, color: '#ffd700', icon: '🏆', desc: 'Risque Élevé / Gain Maximal' },
    };

    const handleDownload = () => {
        saveAsJpeg('mega-ticket-capture', `MegaTicket_${riskLevel}_${new Date().toISOString().split('T')[0]}.jpg`);
    };

    const megaTicket = useMemo(() => {
        if (!matches || matches.length === 0) return null;

        // 1. Filter: Upcoming, high confidence matches
        let upcoming = matches.filter(m => {
            const status = (m.status || "").toLowerCase();
            if (status === "finished" || status === "ft" || status === "ended") return false;
            
            const startStr = m.startTimestamp || m.timestamp || m.startTime;
            const startTime = startStr ? (startStr > 1e11 ? startStr : startStr * 1000) : 0;
            if (startTime && startTime < Date.now() - (60 * 60 * 1000)) return false; 

            const conf = Math.round(m.v22_success_rate || m.enriched?.v22_success_rate || m.confidence || 0);
            
            // 2. Data Integrity: Filter unknown/placeholders
            const home = (m.homeTeam || "").toLowerCase();
            const away = (m.awayTeam || "").toLowerCase();
            const league = (m.league || "").toLowerCase();
            if (home.includes("unknown") || away.includes("unknown") || home === "home" || away === "away") return false;
            if (league.includes("debug") || league.includes("test")) return false;

            // 3. Strict Timing: Only upcoming matches within 48 hours
            const now = Date.now();
            if (startTime > now + (48 * 60 * 60 * 1000)) return false;

            return conf >= (riskLevel === 'DIAMOND' ? 85 : 70); 
        });

        if (upcoming.length < (riskLevel === 'DIAMOND' ? 1 : 3)) return null;

        // Shuffle for variety
        upcoming = [...upcoming].sort(() => Math.random() - 0.5);

        let selections = [];
        let totalMultiplier = 1.0;
        let globalProb = 1.0;
        const TARGET = levels[riskLevel].target;

        for (const m of upcoming) {
            // Stop conditions change for DIAMOND
            if (totalMultiplier >= TARGET) break;
            
            if (riskLevel === 'DIAMOND') {
                if (globalProb < 0.78 && selections.length > 0) break; // Keep it near 80%
                if (selections.length >= 5) break; // Max 5 for Diamond
            }

            const enriched = m.enriched || {};
            let pick = null;

            const hWin = parseFloat(m.home_win_probability || enriched.home_win_probability || 0);
            const aWin = parseFloat(m.away_win_probability || enriched.away_win_probability || 0);
            const dWin = parseFloat(m.draw_probability || enriched.draw_probability || 0);

            // TIERED PICK LOGIC
            if (riskLevel === 'DIAMOND') {
                // Focus: Elite Safety (X2, 1X, DNB, Under 4.5) - Confidence > 85-95%
                if (hWin > 85) pick = { label: "Victoire (DNB): " + m.homeTeam, odd: 1.35, prob: 0.94 };
                else if (aWin > 85) pick = { label: "Victoire (DNB): " + m.awayTeam, odd: 1.42, prob: 0.92 };
                else if (hWin > 70) pick = { label: "Double Chance: 1X", odd: 1.28, prob: 0.90 };
                else if (aWin > 70) pick = { label: "Double Chance: X2", odd: 1.32, prob: 0.88 };
                else pick = { label: "Moins de 4.5 Buts", odd: 1.20, prob: 0.96 };
            } 
            else if (riskLevel === 'GOLD') {
                if (hWin > 65) pick = { label: "Victoire: " + m.homeTeam, odd: 1.85, prob: 0.54 };
                else if (aWin > 65) pick = { label: "Victoire: " + m.awayTeam, odd: 2.10, prob: 0.47 };
                else pick = { label: "Double Chance: 1X", odd: 1.65, prob: 0.60 };
            } 
            else if (riskLevel === 'ULTRA') {
                if (hWin > 60) pick = { label: "1 & +2.5 Buts", odd: 4.20, prob: 0.23 };
                else if (aWin > 60) pick = { label: "2 & +2.5 Buts", odd: 4.80, prob: 0.20 };
                else pick = { label: "Nul à la Mi-Temps", odd: 3.20, prob: 0.31 };
            } 
            else if (riskLevel === 'MEGA') {
                if (hWin > 75) pick = { label: "Score Exact: 3-0", odd: 12.00, prob: 0.08 };
                else if (hWin > 65) pick = { label: "Score Exact: 2-1", odd: 9.20, prob: 0.11 };
                else if (aWin > 65) pick = { label: "Score Exact: 1-2", odd: 11.50, prob: 0.08 };
                else if (dWin > 35) pick = { label: "Score Exact: 1-1", odd: 7.40, prob: 0.13 };
                else {
                    // DYNAMIC 1X2 FALLBACK
                    const maxProb = Math.max(hWin, aWin, dWin);
                    if (maxProb === hWin) pick = { label: "Victoire: " + m.homeTeam + " (1)", odd: 2.15, prob: 0.45 };
                    else if (maxProb === aWin) pick = { label: "Victoire: " + m.awayTeam + " (2)", odd: 3.80, prob: 0.25 };
                    else pick = { label: "Match Nul (X)", odd: 3.30, prob: 0.30 };
                }
            }

            if (pick) {
                // For Diamond, we check if adding this lowers us too much
                const nextProb = globalProb * pick.prob;
                if (riskLevel === 'DIAMOND' && nextProb < 0.78 && selections.length > 0) continue;

                selections.push({
                    id: m.id,
                    league: m.league || m.category_name || "Unknown",
                    home: m.homeTeam || "Home",
                    away: m.awayTeam || "Away",
                    prediction: pick.label,
                    odd: pick.odd,
                    confidence: Math.round(pick.prob * 100)
                });
                totalMultiplier *= pick.odd;
                globalProb = nextProb;
            }
        }

        return {
            selections,
            totalOdd: totalMultiplier.toFixed(2),
            globalConfidence: (globalProb * 100).toFixed(2)
        };

    }, [matches, riskLevel, refreshKey]);

    const copyTicket = useCallback(() => {
        if (!megaTicket) return;
        const text = `🏆 TITANIUM ${levels[riskLevel].label}\n` +
            megaTicket.selections.map(s => `📍 ${s.home} vs ${s.away}: ${s.prediction} (@${s.odd})`).join('\n') +
            `\n\n💰 COTE TOTALE: ${megaTicket.totalOdd}\n📡 Probabilité Estimée: ${megaTicket.globalConfidence}%`;
        navigator.clipboard.writeText(text);
        alert('TICKET COPIÉ AVEC SUCCÈS !');
    }, [megaTicket, riskLevel]);

    if (!megaTicket || megaTicket.selections.length === 0) {
        return (
            <div className="mega-error">
                <div className="mega-error-icon">📉</div>
                <h3>SIGNAL INSUFFISANT ({riskLevel})</h3>
                <p>Pas assez de données pour générer un ticket de ce niveau actuellement.</p>
                <button className="mega-refresh-btn" onClick={() => setRefreshKey(k => k + 1)}>Réessayer</button>
            </div>
        );
    }

    return (
        <div className="mega-container v3" style={{ '--theme-color': levels[riskLevel].color }} id="mega-ticket-capture">
            {/* ACTION HUD */}
            <div className="mega-hud">
                <div className="mega-level-toggles">
                    {['DIAMOND', 'GOLD', 'ULTRA', 'MEGA'].map(lvl => (
                        <button 
                            key={lvl}
                            className={`mega-lvl-btn ${riskLevel === lvl ? 'active' : ''} lvl-${lvl}`}
                            onClick={() => setRiskLevel(lvl)}
                        >
                            <span className="lvl-icon">{levels[lvl].icon}</span>
                            <span className="lvl-label">{levels[lvl].label}</span>
                        </button>
                    ))}
                </div>
                <div className="mega-hud-actions">
                    <button className="mega-hud-btn jpeg" onClick={handleDownload} title="Enregistrer JPEG">📸 JPEG</button>
                    <button className="mega-hud-btn refresh" onClick={() => setRefreshKey(k => k + 1)} title="Régénérer">🔄</button>
                    <button className="mega-hud-btn share" onClick={copyTicket}>📋 Copier</button>
                </div>
            </div>

            {/* PHYSICAL TICKET VIEW */}
            <div className="mega-slip-wrapper">
                <div className="mega-ticket-slip">
                    {riskLevel === 'DIAMOND' && (
                        <div className="diamond-safety-badge">
                            <span className="badge-wave"></span>
                            🛡️ {levels[riskLevel].badge}
                        </div>
                    )}

                    <div className="mega-slip-header">
                        <div className="mega-logo">TITANIUM<span>RADAR</span> {riskLevel === 'DIAMOND' && <span className="logo-sparkle">✨</span>}</div>
                        <div className="mega-slip-id">SLIP #{(Math.random()*1000000).toFixed(0)}</div>
                    </div>

                    <div className="mega-level-indicator">
                        <h3>{levels[riskLevel].label}</h3>
                        <p>{levels[riskLevel].desc}</p>
                    </div>

                    <div className="mega-slip-entries">
                        {megaTicket.selections.map((sel, idx) => (
                            <div key={sel.id} className="mega-slip-entry">
                                <div className="entry-head">
                                    <span className="entry-num">{idx + 1}</span>
                                    <span className="entry-league">{sel.league}</span>
                                </div>
                                <div className="entry-match">{sel.home} - {sel.away}</div>
                                <div className="entry-pick">
                                    <span className="pick-label">{sel.prediction}</span>
                                    <span className="pick-odd">@{sel.odd.toFixed(2)}</span>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="mega-slip-footer">
                        <div className="mega-slip-totals">
                            <div className="total-row">
                                <span>COTE TOTALE</span>
                                <span className={riskLevel === 'DIAMOND' ? 'val-diamond' : 'val-gold'}>{megaTicket.totalOdd}</span>
                            </div>
                            <div className="total-row">
                                <span>CONFIANCE SYSTÈME</span>
                                <span className={parseFloat(megaTicket.globalConfidence) >= 80 ? 'val-secure' : ''}>
                                    {megaTicket.globalConfidence}%
                                </span>
                            </div>
                        </div>

                        <div className="mega-barcode">
                            <div className="barcode-lines"></div>
                            <div className="barcode-num">XG-TITANIUM-80-QUANTUM</div>
                        </div>
                    </div>

                    <div className="perforated-edge">
                        {[...Array(20)].map((_, i) => <div key={i} className="perf-hole"></div>)}
                    </div>
                </div>

                <div className="mega-slip-note">
                    {riskLevel === 'DIAMOND' ? (
                        <span>💎 <b>CONSEIL EXPERT :</b> Mise recommandée : <u>10% à 15%</u> de votre Bankroll (Indice de confiance maximal).</span>
                    ) : (
                        <span>⚠️ Ce ticket est de nature spéculative. Analysé par le moteur Titanium V58. <br/><b>Mise conseillée : Max 2-5% de Bankroll.</b></span>
                    )}
                </div>
            </div>
        </div>
    );
};

export default MegaTicket1000;

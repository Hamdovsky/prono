import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Activity } from 'lucide-react';
import './MegaCorrelation.css';

const MegaCorrelation = ({ matches }) => {
    const [expandedRows, setExpandedRows] = useState(new Set());
    
    const toggleRow = (id) => {
        setExpandedRows(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const parseProb = (val) => {
        if (!val) return 0;
        const num = parseFloat(String(val).replace('%', ''));
        if (isNaN(num)) return 0;
        return num <= 1 ? Math.round(num * 100) : Math.round(num);
    };

    // Arabic text generation based on match data
    const generateTechReport = (m) => {
        let report = [];

        // 1. 1X2 Context & Overall Match Setup
        const hw = parseProb(m.enriched?.home_win_probability || m.home_win_probability || 0);
        const aw = parseProb(m.enriched?.away_win_probability || m.away_win_probability || 0);
        let stance = "المباراة تميل إلى التوازن التشغيلي.";
        if (hw >= 55) {
            stance = `تشخيص (XGBoost) يرجح فوز ${m.homeTeam} بنسبة ${hw}% بفضل الاستقرار التكتيكي والعامل الجماهيري.`;
        } else if (aw >= 55) {
            stance = `نظام التحليل يرجح كفة ${m.awayTeam} للفوز خارج ميدانه بنسبة ${aw}%.`;
        }
        report.push(`📊 **الموقف التكتيكي العام:** ${stance}`);

        // 2. xG & Offensive Flow
        const hXg = parseFloat(m.home_xg || m.enriched?.home_xg || 0);
        const aXg = parseFloat(m.away_xg || m.enriched?.away_xg || 0);
        const totalXg = hXg + aXg;
        let xgAnalysis = "المؤشرات الهجومية تبدو متحفظة.";
        if (totalXg > 2.8) {
            xgAnalysis = `الأهداف المتوقعة (${totalXg.toFixed(2)} xG) تعكس نوايا هجومية شرسة وتوقعاً لنمط لعب مفتوح. هجوم ${hXg > aXg ? m.homeTeam : m.awayTeam} يبدو الأفضلية الأوضح.`;
        } else if (totalXg > 0 && totalXg < 2.3) {
            xgAnalysis = `تدني معدل xG المتوقع (${totalXg.toFixed(2)}) يشير إلى مباراة معقدة، تُدار بحذر، وتركيز على معارك خط الوسط.`;
        }
        report.push(`\n⚔️ **القوة الهجومية والدفاعية:** ${xgAnalysis}`);

        // 3. Environment & Travel (Logistics)
        let logistics = [];
        if (m.weather_temp || m.enriched?.weather?.temp) {
            const temp = Math.round(m.weather_temp || m.enriched?.weather?.temp);
            if (temp > 28) logistics.push(`حرارة مرتفعة (${temp}°C) قد تسبب هبوطاً بدنياً "Energy Drain" في الشوط الثاني مما يبطئ رتم اللعب أو يخلق أخطاء دفاعية متأخرة.`);
            else if (temp < 5) logistics.push(`درجات حرارة منخفضة (${temp}°C) تفرض تحديات على العضلات. قد نرى بداية بطيئة للمباراة.`);
        }
        if (m.travelFatigue) {
            logistics.push(`الضيف عانى من رحلة شاقة (${m.travelFatigue.distance} كم بدرجة تأثير ${m.travelFatigue.impact})، مما يزيد من احتمالية تراجع مخزونه اللياقي.`);
        }
        if (logistics.length > 0) {
            report.push(`\n✈️ **العوامل اللوجستية والبيئية:** ${logistics.join(' ')}`);
        }

        // 4. Referee & Discipline
        const redCards = m.referee_red_avg || m.enriched?.analysis_data?.referee?.red_card_avg || 0;
        const yellowCards = m.referee_yellow_avg || m.enriched?.analysis_data?.referee?.strictness_index || 0;
        if (yellowCards > 4.5 || yellowCards > 70) {
            report.push(`\n⚖️ **الجانب الانضباطي والحكم:** تعيين حكم معروف بصرامته المرتفعة (متوسط البطاقات عالٍ). احتمال كبير لرؤية عقوبات قد تكسر رتم المباراة أو تغير مجراها نحو فوضى تكتيكية.`);
        }

        // 5. Market Pulse & News
        let market = [];
        if (m.enriched?.smartMoney?.label?.includes('SHARP')) {
            market.push("رُصدت تدفقات سيولة ذكية (Sharp Money) مباغتة في الأسواق الآسيوية، ما يؤكد وجود تسريبات قوية أو تحولات غير معلنة في الجاهزية.");
        }
        if (m.enriched?.news_data?.impact?.critical?.length > 0) {
            market.push(`تحذير: ${m.enriched?.news_data?.impact?.critical.join(', ')}.`);
        }
        if (market.length > 0) {
            report.push(`\n💰 **حركة السوق والسيولة الذكية:** ${market.join(' ')}`);
        }

        // 6. Final Correlation
        const pOu = parseProb(m.enriched?.ou_25_prob || m.ou_25_prob || 0);
        let corr = "";
        if (m.master_v20?.is_pattern) {
            corr = `تم رصد ترابط ذهبي مطابق للقواعد العظمى (Master Protocol Rule)، حيث تتناغم قراءات הـ 1X2 مع أهداف المباراة بشكل مثالي، ليصدر النظام التوصية الحاسمة: ${m.master_v20?.master_verdict}.`;
        } else {
            corr = (pOu > 55) ? "محرك الترابط يرصد تقاطعاً إيجابياً يدعم غزراة تهديفية (Over 2.5)، مدعوماً بضعف المنظومة الدفاعية تحت الضغط." : "يدعم محرك الترابط الديناميكي فرضية الانضباط الدفاعي وتدني معدل التسجيل، مقلصاً التوجه التصاعدي للرهان الهجومي.";
        }
        report.push(`\n⚙️ **الخلاصة المترابطة (Correlation Engine):** ${corr}`);

        return report.join('\n');
    };
    // Sort and filter top 40 matches based on AI Confidence and Power Score, ensuring they are for TODAY.
    const topMatches = useMemo(() => {
        const todayStr = new Date().toLocaleDateString();
        const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toLocaleDateString();

        return [...matches]
            .filter(m => {
                // If match has been enriched or has basic win probs, it's a candidate
                if (!m.enriched && !m.home_win_probability) return false;
                
                let dateMs = null;
                if (m.startTimestamp) {
                    dateMs = m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000;
                } else if (m.timestamp) {
                    dateMs = new Date(m.timestamp).getTime();
                } else if (m.startTime) {
                    dateMs = new Date(m.startTime).getTime();
                } else if (m.date) {
                    dateMs = new Date(m.date).getTime();
                }

                if (!dateMs) return false;
                const d = new Date(dateMs);
                return d.toLocaleDateString() === todayStr;
            })
            .sort((a, b) => {
                const confA = a.confidence || a.enriched?.confidence || a.enriched?.main_predictions?.[0]?.probability || 0;
                const confB = b.confidence || b.enriched?.confidence || b.enriched?.main_predictions?.[0]?.probability || 0;
                
                if (confB !== confA) return confB - confA;
                
                const powerA = a.power_score || a.enriched?.power_score || 0;
                const powerB = b.power_score || b.enriched?.power_score || 0;
                return powerB - powerA;
            })
            .slice(0, 40); // Taking 40 high-quality matches as requested
    }, [matches]);

    return (
        <div className="mega-container">
            <div className="mega-header">
                <div className="cyber-glitch-text">MEGA-CORRELATION MASTER V20</div>
                <div className="active-signals-count">{topMatches.length} NODES LINKED</div>
            </div>

            <div className="mega-list">
                {topMatches.map((match, idx) => {
                    const confidence = match.confidence || match.enriched?.confidence || match.enriched?.main_predictions?.[0]?.probability || 50;
                    const verdict = match.enriched?.verdict || "NEUTRAL";
                    const isExpanded = expandedRows.has(match.id);
                    const v20 = match.master_v20 || match.enriched?.master_v20 || {};
                    const isElite = v20.is_pattern;
                    
                    return (
                        <div key={match.id} className={`mega-row ${isExpanded ? 'expanded' : ''} ${isElite ? 'elite-border' : ''}`} onClick={() => toggleRow(match.id)}>
                            <div className="row-main-content">
                                <div className="row-index">{(idx + 1).toString().padStart(2, '0')}</div>
                                
                                {/* Elite Flash Badge */}
                                {isElite && (
                                    <div className="elite-mega-flash">⚡ ELITE</div>
                                )}
                                
                                {/* [V25/V26] Advanced Indicators */}
                                <div className="advanced-badges">
                                    {match.enriched?.smartMoney?.label === '⚡ SHARP FLOW DETECTED' && (
                                        <div className="sharp-pulse-alert">🔥 SHARP FLOW</div>
                                    )}
                                    {match.enriched?.news_data?.impact?.critical?.includes("⚠️ SQUAD ROTATION DETECTED") && (
                                        <div className="sharp-pulse-alert" style={{background: '#f59e0b'}}>⚠️ ROTATION</div>
                                    )}
                                    {match.enriched?.news_data?.impact?.critical?.includes("⚠️ TOP SCORER IMPACT") && (
                                        <div className="sharp-pulse-alert" style={{background: '#ef4444'}}>⚽ SCORER OUT</div>
                                    )}
                                    {(match.weather_temp || (match.enriched?.weather?.temp)) && (
                                        <div className="weather-badge">
                                            <span>{Math.round(match.weather_temp || match.enriched.weather.temp)}°C</span>
                                            <span title={match.weather_desc || match.enriched?.weather?.desc}>☁️</span>
                                        </div>
                                    )}
                                    {match.enriched?.confirmed && (
                                        <div className="lineup-confirmed-badge" title="Official Lineups Confirmed">✅ LINEUPS</div>
                                    )}
                                </div>

                                <div className="row-meta">
                                    <span className="league-code">{(match.league || '???').substring(0, 3).toUpperCase()}</span>
                                    <span className="country-code" style={{marginLeft: '6px', marginRight: '6px', color: '#0ea5e9', fontSize: '0.8rem', fontWeight: 'bold'}}>{(match.country || 'INT').toUpperCase()}</span>
                                    <span className="timestamp">{new Date(match.startTimestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                                </div>

                                <div className="row-teams">
                                    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-end'}}>
                                        <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                                            {match.tacticalLabels?.includes('🛡️ DEFENSIVE PROTOCOL') && <span className="tactical-scenario-badge defensive">DEF</span>}
                                            {match.tacticalLabels?.includes('🔥 REMONTADA MODE') && <span className="tactical-scenario-badge remontada">REMONTADA</span>}
                                            <span className="team h">{match.homeTeam}</span>
                                        </div>
                                        {match.ta_ratings?.home && (
                                            <div className="star-ratings">
                                                {'★'.repeat(Math.floor(match.ta_ratings.home - 5))}{'☆'.repeat(5 - Math.floor(match.ta_ratings.home - 5))}
                                            </div>
                                        )}
                                    </div>

                                    {match.status?.toLowerCase() === 'finished' || match.status?.toUpperCase() === 'FT' ? (
                                        <span className="vs score">{match.scoreHome} - {match.scoreAway}</span>
                                    ) : (
                                        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
                                            <span className="vs">VS</span>
                                            {match.odds_speed?.is_fast && <span className="odds-speed-fire">🔥</span>}
                                        </div>
                                    )}

                                    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start'}}>
                                        <span className="team a">{match.awayTeam}</span>
                                        {match.travelFatigue && (
                                            <div className={`travel-log ${match.travelFatigue.impact.toLowerCase()}-impact`}>
                                                ✈️ {match.travelFatigue.distance}km ({match.travelFatigue.impact})
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="row-prediction">
                                    <span className="label">PRED</span>
                                    <span className="val">{match.enriched?.main_predictions?.[0]?.val || '-'}</span>
                                    {/* [V20 MASTER] Correlation Nodes */}
                                    <div className="prediction-extras">
                                        {match.master_v20?.correlations?.map(c => (
                                            <span key={c.type} className={`node-tag ${c.type.toLowerCase()}`} title={c.type}>
                                                {c.type === 'ELITE_RESULT' ? '🎯' : c.type === 'GOAL_RUSH' ? '⚽' : c.type === 'BTTS_SYNC' ? '🤝' : c.type === 'SHARP_MONEY' ? '💰' : '⚡'}
                                            </span>
                                        ))}
                                        {(match.asian_handicap || match.enriched?.asian_handicap) && (
                                            <span className="ah-line">
                                                AH {(match.asian_handicap?.ah_suggested_line || match.enriched?.asian_handicap?.ah_suggested_line)} 
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <div className="row-confidence">
                                    <div className="conf-bar-bg">
                                        <div className="conf-bar-fill" style={{width: `${match.master_v20?.master_confidence || confidence}%`}}></div>
                                    </div>
                                    <span className="conf-val">{match.master_v20?.master_confidence || confidence}%</span>
                                    {(match.referee_yellow_avg > 4.5 || match.enriched?.analysis_data?.referee?.strictness_index > 70) && (
                                        <span className="ref-warning" title={`Strict Referee: ${match.referee_yellow_avg || ''} Yellows`}>⚠️ REF</span>
                                    )}
                                </div>

                                <div className={`row-verdict ${ (match.master_v20?.master_verdict || verdict || '').toLowerCase().replace(/ /g, '-') }`}>
                                    {match.master_v20?.master_verdict || verdict}
                                </div>

                                <div className="row-stake">
                                    <span className="val">{Math.min(10, Math.floor(confidence/10))}</span>
                                    <span className="label">U</span>
                                </div>
                            </div>

                            {/* [V28] Strategic Insight - Arabic Report */}
                            {(match.enriched?.strategic_reasoning || match.strategic_reasoning) && (
                                <div className="strategic-insight">
                                    🔍 {match.enriched?.strategic_reasoning || match.strategic_reasoning}
                                </div>
                            )}

                            {/* [V49] AI CS-PREDICTION: Poisson Matrix outcomes */}
                            {match.enriched?.ai_cs_prediction && match.enriched.ai_cs_prediction.length > 0 && (
                                <div className="ai-cs-prediction-v19 mini">
                                    <span className="cs-label">[AI CS-PRED]</span>
                                    {match.enriched.ai_cs_prediction.slice(0, 3).map((p, idx) => (
                                        <span key={idx} className="cs-item">
                                            {p.score} ({p.prob}%) {idx === 0 && '🔥'}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {/* [V32] REAL TECHNICAL ANALYSIS (Expandable) */}
                            {isExpanded && (
                                <div className="mega-tech-analysis">
                                    <div className="tech-header">
                                        <Activity size={16} color="#38bdf8" />
                                        <span>تحليل فني عميق (TITANIUM DEEP SCAN)</span>
                                    </div>
                                    
                                    <div className="tech-grid">
                                        {/* Win Probabilities */}
                                        <div className="tech-box">
                                            <div className="tb-title">احتمالات فوز (1X2)</div>
                                            <div className="tb-prob-row">
                                                <div className="tb-lbl">🏠 {match.homeTeam.substring(0,12)}</div>
                                                <div className="tb-bar-bg"><div className="tb-bar-fill home" style={{width: `${parseProb(match.enriched?.home_win_probability || match.home_win_probability || 0)}%`}}></div></div>
                                                <div className="tb-val">{parseProb(match.enriched?.home_win_probability || match.home_win_probability || 0)}%</div>
                                            </div>
                                            <div className="tb-prob-row">
                                                <div className="tb-lbl">🤝 تعادل</div>
                                                <div className="tb-bar-bg"><div className="tb-bar-fill draw" style={{width: `${parseProb(match.enriched?.draw_probability || match.draw_probability || 0)}%`}}></div></div>
                                                <div className="tb-val">{parseProb(match.enriched?.draw_probability || match.draw_probability || 0)}%</div>
                                            </div>
                                            <div className="tb-prob-row">
                                                <div className="tb-lbl">✈️ {match.awayTeam.substring(0,12)}</div>
                                                <div className="tb-bar-bg"><div className="tb-bar-fill away" style={{width: `${parseProb(match.enriched?.away_win_probability || match.away_win_probability || 0)}%`}}></div></div>
                                                <div className="tb-val">{parseProb(match.enriched?.away_win_probability || match.away_win_probability || 0)}%</div>
                                            </div>
                                        </div>

                                        {/* Expected Goals & Scoring Edge */}
                                        <div className="tech-box">
                                            <div className="tb-title">الأهداف المتوقعة (xG)</div>
                                            <div className="tb-xg-display">
                                                <div className="xg-col">
                                                    <span className="xg-val">{parseFloat(match.home_xg || match.enriched?.home_xg || 0).toFixed(2)}</span>
                                                    <span className="xg-lbl">Home xG</span>
                                                </div>
                                                <div className="xg-vs">vs</div>
                                                <div className="xg-col">
                                                    <span className="xg-val">{parseFloat(match.away_xg || match.enriched?.away_xg || 0).toFixed(2)}</span>
                                                    <span className="xg-lbl">Away xG</span>
                                                </div>
                                            </div>
                                            <div className="tb-insight">
                                                {parseFloat(match.home_xg || 0) > parseFloat(match.away_xg || 0) + 0.5 ? '🔥 تفوق هجومي ملحوظ للمضيف' : 
                                                 parseFloat(match.away_xg || 0) > parseFloat(match.home_xg || 0) + 0.5 ? '🔥 تفوق هجومي ملحوظ للضيف' : 
                                                 '⚖️ توازن متقارب جداً في الفرص'}
                                            </div>
                                        </div>

                                        {/* Market Nodes */}
                                        <div className="tech-box">
                                            <div className="tb-title">مؤشرات السوق والترابط</div>
                                            <div className="tb-market-row">
                                                <span>Over 2.5 (أكثر من 2.5):</span>
                                                <strong style={{color: parseProb(match.enriched?.ou_25_prob || match.ou_25_prob || 0) > 60 ? '#38bdf8' : '#94a3b8'}}>{parseProb(match.enriched?.ou_25_prob || match.ou_25_prob || 0)}%</strong>
                                            </div>
                                            <div className="tb-market-row">
                                                <span>BTTS (يسجلان معاً):</span>
                                                <strong style={{color: parseProb(match.enriched?.btts_prob || match.btts_prob || 0) > 60 ? '#10b981' : '#ef4444'}}>{parseProb(match.enriched?.btts_prob || match.btts_prob || 0)}%</strong>
                                            </div>
                                            <div className="tb-market-row">
                                                <span>مؤشر القوة (Power Score):</span>
                                                <strong style={{color: '#f59e0b'}}>{Math.round(match.power_score || match.enriched?.power_score || 0)} / 100</strong>
                                            </div>
                                            <div className="tb-market-row" style={{marginTop: '8px', borderTop:'1px dashed #334155', paddingTop:'8px'}}>
                                                <span>العصب الأساسي للترابط:</span>
                                                <strong style={{color: '#c084fc', fontSize: '0.8rem'}}>{v20.is_pattern ? `✓ ELITE MEGA-CORRELATION` : '⚡ DYNAMIC AI LOGIC'}</strong>
                                            </div>
                                        </div>

                                        {/* [V20 PLUS] Correlation Radar */}
                                        {v20.v20_plus?.radar_factors && (
                                            <div className="tech-box radar-box">
                                                <div className="tb-title">رادار الارتباط (Tactical Radar)</div>
                                                {v20.v20_plus.radar_factors.map((f, i) => (
                                                    <div key={i} className="radar-item">
                                                        <div className="radar-label">{f.name}</div>
                                                        <div className="radar-track">
                                                            <div className="radar-fill" style={{width: `${f.weight}%`}}></div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    
                                    {/* [V20 PLUS] Expected Match Scenario */}
                                    {v20.v20_plus?.expected_match_scenario && (
                                        <div className="scenario-box">
                                            <div className="scenario-header">🛡️ سيناريو المباراة المتوقع (Monte Carlo 10k):</div>
                                            <div className="scenario-body">
                                                {v20.v20_plus.expected_match_scenario} 
                                                <span className="mode-score"> (النتيجة الأكثر تكراراً: {v20.v20_plus.monte_carlo_mode_score})</span>
                                            </div>
                                        </div>
                                    )}

                                    {/* Written Tech Report */}
                                    <div className="tech-written-report">
                                        <div className="report-title">📝 التقرير الفني الشامل:</div>
                                        <div className="report-body">
                                            {generateTechReport(match).split('\n').map((paragraph, index) => (
                                                <p key={index} style={{ marginBottom: '8px' }}>
                                                    {/* Provide basic markdown-like bolding for **text** */}
                                                    {paragraph.split('**').map((part, i) => i % 2 !== 0 ? <strong key={i} style={{ color: '#0ea5e9' }}>{part}</strong> : part)}
                                                </p>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="expand-hint">
                                {isExpanded ? <ChevronUp size={16} color="#475569" /> : <ChevronDown size={16} color="#475569" />}
                            </div>
                        </div>
                    );
                })}
            </div>
            
            <div className="mega-footer">
                <div className="scanline-overlay"></div>
                <div className="footer-info">TITANIUM V29 // CYBERDECK ULTIMATE // STRATEGIC REASONING ACTIVE</div>
            </div>
        </div>
    );
};

export default MegaCorrelation;

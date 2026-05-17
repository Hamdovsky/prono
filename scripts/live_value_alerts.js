const Database = require('better-sqlite3');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { SofaAPI } = require('../SofascoreScraping/src/apiClient');

// 🛡️ CONFIGURATION TITANIUM
const BOT_TOKEN = '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';
const CHAT_ID = '5637790630';
const dbPath = path.resolve('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/tactical.db');
const LOG_FILE = path.resolve('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/live_value_alerts.log');

function log(msg) {
    const time = new Date().toISOString();
    const line = `[${time}] ${msg}`;
    console.log(line);
    try {
        fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    } catch(e) {}
}

function fractionToDecimal(fractionalString) {
    if (!fractionalString) return 1.0;
    const parts = fractionalString.split('/');
    if (parts.length === 2) {
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        if (den > 0) {
            return (num / den) + 1.0;
        }
    }
    return parseFloat(fractionalString) || 1.0;
}

async function sendTelegram(text) {
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: text,
            parse_mode: 'Markdown'
        });
        log(`📡 Telegram alert sent successfully.`);
    } catch (err) {
        log(`❌ Telegram send error: ${err.message}`);
        if (err.response) log(`   Détail : ${err.response.data?.description}`);
    }
}

// In-Memory state
const matchStates = {};      // eventId -> { homeScore, awayScore, minute, status }
const alertedValueBets = new Set(); // eventId:market

async function updateRollingTicket(db, liveEvents) {
    log('⚡ [Rolling Ticket] Auditing the 4-match Live Over 1.5 Goals rolling ticket queue...');
    
    // 1. Create table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS rolling_live_ticket (
            id TEXT PRIMARY KEY,
            homeTeam TEXT,
            awayTeam TEXT,
            tournament_name TEXT,
            status TEXT,
            homeScore INTEGER,
            awayScore INTEGER,
            minute INTEGER,
            prediction TEXT,
            confidence REAL,
            added_at INTEGER
        )
    `).run();

    // 2. Fetch current saved
    const saved = db.prepare("SELECT * FROM rolling_live_ticket").all();
    log(`ℹ️ [Rolling Ticket] Active saved live matches: ${saved.length}/4`);

    const liveMap = new Map();
    for (const e of liveEvents) {
        liveMap.set(String(e.id), e);
    }

    let changed = false;
    const activeIds = new Set();

    for (const m of saved) {
        const liveEvent = liveMap.get(String(m.id));
        let isResolved = false;
        let resolutionReason = '';

        if (liveEvent) {
            const statusType = liveEvent.status?.type || '';
            const desc = liveEvent.status?.description || '';
            const currentHome = liveEvent.homeScore?.display ?? liveEvent.homeScore?.current ?? 0;
            const currentAway = liveEvent.awayScore?.display ?? liveEvent.awayScore?.current ?? 0;
            const totalGoals = currentHome + currentAway;
            
            let minute = m.minute;
            if (desc.includes('Halftime') || desc.includes('HT')) {
                minute = 45;
            } else {
                const minMatch = desc.match(/(\d+)/);
                if (minMatch) minute = parseInt(minMatch[1]);
            }

            // Check if won (Over 1.5 goals -> at least 2 goals scored in total)
            if (totalGoals >= 2) {
                isResolved = true;
                resolutionReason = `✅ *PRONO GAGNÉ (PLUS DE 1.5 BUTS) !* Deux buts ont été marqués à la ${minute}' de *${m.homeTeam} vs ${m.awayTeam}* (Score: ${currentHome}-${currentAway}) ! Le système sélectionne une nouvelle partie ouverte en direct ! 🚀`;
            } else if (statusType === 'finished' || desc.includes('Ended') || desc.includes('FT') || minute > 82) {
                // Match finished or late minute without reaching 2 goals -> LOST
                isResolved = true;
                resolutionReason = `❌ *PRONO PERDU (PAS DE 1.5 BUTS)* : Match terminé ou trop tardif pour *${m.homeTeam} vs ${m.awayTeam}* (Score final : ${currentHome}-${currentAway}). Remplacement par une partie active...`;
            } else {
                // Keep active, update scores & minute
                db.prepare(`
                    UPDATE rolling_live_ticket 
                    SET homeScore = ?, awayScore = ?, minute = ?, status = 'live'
                    WHERE id = ?
                `).run(currentHome, currentAway, minute, m.id);
                activeIds.add(m.id);
            }
        } else {
            // Not found in live events list. Check if it was added more than 2 hours ago.
            const ageHours = (Date.now() / 1000 - m.added_at) / 3600;
            if (ageHours > 2.0) {
                isResolved = true;
                resolutionReason = `🏁 *MATCH ROULANT EXPIRÉ* : *${m.homeTeam} vs ${m.awayTeam}*. Remplacement en cours...`;
            } else {
                activeIds.add(m.id);
            }
        }

        if (isResolved) {
            log(`🧹 [Rolling Ticket] Removing resolved match: ${m.homeTeam} vs ${m.awayTeam}. Reason: ${resolutionReason}`);
            db.prepare("DELETE FROM rolling_live_ticket WHERE id = ?").run(m.id);
            changed = true;
            await sendTelegram(resolutionReason);
        }
    }

    // 3. Fill up to 4 matches specifically with ALREADY STARTED live matches that are offensively open
    const currentActiveCount = db.prepare("SELECT COUNT(*) as cnt FROM rolling_live_ticket").get().cnt;
    if (currentActiveCount < 4) {
        const needed = 4 - currentActiveCount;
        log(`🔍 [Rolling Ticket] Ticket needs ${needed} more matches. Selecting live candidates...`);

        const nowSec = Math.floor(Date.now() / 1000);
        // Load matches that started in the last 2 hours
        const candidates = db.prepare(`
            SELECT id, homeTeam, awayTeam, tournament_name, 
                   ou_25_prob, xgboost_confidence, startTimestamp
            FROM matches 
            WHERE startTimestamp >= ? AND startTimestamp <= ?
            ORDER BY ou_25_prob DESC
        `).all(nowSec - 7200, nowSec + 3600);

        let addedCount = 0;
        for (const cand of candidates) {
            if (addedCount >= needed) break;
            
            const candId = String(cand.id);
            if (activeIds.has(candId)) continue;

            const liveEvent = liveMap.get(candId);
            // CRITICAL: The match MUST be currently active/live (already started)
            if (!liveEvent) continue;

            const statusType = liveEvent.status?.type || '';
            if (statusType !== 'inprogress') continue;

            const currentHome = liveEvent.homeScore?.display ?? liveEvent.homeScore?.current ?? 0;
            const currentAway = liveEvent.awayScore?.display ?? liveEvent.awayScore?.current ?? 0;
            const totalGoals = currentHome + currentAway;

            const desc = liveEvent.status?.description || '';
            let minute = 0;
            const minMatch = desc.match(/(\d+)/);
            if (minMatch) minute = parseInt(minMatch[1]);

            // Filter: Must have <= 1 goal, be in early-mid stages (minute <= 65), and high pre-match Over 2.5 probability (>= 60%)
            if (totalGoals > 1 || minute > 65 || (cand.ou_25_prob || 0) < 60) continue;

            const prediction = "🔥 Plus de 1.5 Buts (Match)";
            const confidence = Math.round(cand.ou_25_prob || 75);

            log(`📥 [Rolling Ticket] Adding active match: ${cand.homeTeam} vs ${cand.awayTeam} to ticket.`);
            db.prepare(`
                INSERT INTO rolling_live_ticket 
                (id, homeTeam, awayTeam, tournament_name, status, homeScore, awayScore, minute, prediction, confidence, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(candId, cand.homeTeam, cand.awayTeam, cand.tournament_name, 'live', currentHome, currentAway, minute, prediction, confidence, nowSec);

            activeIds.add(candId);
            addedCount++;
            changed = true;
        }
    }

    // 4. Send updated ticket to Telegram if changed
    if (changed) {
        const finalSaved = db.prepare("SELECT * FROM rolling_live_ticket").all();
        if (finalSaved.length > 0) {
            let ticketMsg = `⚡ *MISE À JOUR : TICKET LIVE ROULANT (4 MATCHS)* ⚡\n`;
            ticketMsg += `_Le système maintient 4 parties EN DIRECT ouvertes offensivement. Dès qu'il y a au moins 2 buts dans le match (Over 1.5), le pari est validé comme gagné (WIN) et remplacé immédiatement !_\n\n`;

            finalSaved.forEach((m, idx) => {
                ticketMsg += `${idx + 1}. ⚽ *${m.homeTeam} vs ${m.awayTeam}*\n`;
                ticketMsg += `   🏆 _${m.tournament_name || 'Championnat'}_\n`;
                ticketMsg += `   📊 *Prono :* \`${m.prediction}\` (Confiance : \`${m.confidence}%\`)\n`;
                ticketMsg += `   ⏰ *État :* 🟢 Live (${m.minute}') [${m.homeScore}-${m.awayScore}]\n\n`;
            });

            ticketMsg += `💰 _Mise conseillée par match : 2.5% Flat Bankroll_`;
            await sendTelegram(ticketMsg);
        }
    }
}

async function runAudit() {
    log('🔄 Starting Live Value Bets & Goal Alerts Audit Cycle...');
    
    let db;
    try {
        db = new Database(dbPath, { readonly: true });
    } catch (dbErr) {
        log(`❌ Database connection failed: ${dbErr.message}`);
        return;
    }

    try {
        // 1. Fetch live events from Sofascore API
        const liveData = await SofaAPI.getLiveEvents();
        const liveEvents = liveData?.events || [];
        log(`ℹ️ Detected ${liveEvents.length} live matches currently playing in the world.`);

        // ─── PART C: ROLLING LIVE TICKET UPDATE ───
        const dbRW = new Database(dbPath);
        try {
            await updateRollingTicket(dbRW, liveEvents);
        } catch(rollingErr) {
            log(`❌ Error in rolling live ticket: ${rollingErr.message}`);
        } finally {
            dbRW.close();
        }

        if (liveEvents.length === 0) {
            db.close();
            return;
        }

        // 2. Fetch our pre-match analyzed matches starting today
        const nowSec = Math.floor(Date.now() / 1000);
        const startWindow = nowSec - 43200; // last 12h
        const endWindow = nowSec + 43200;   // next 12h

        const dbMatches = db.prepare(`
            SELECT id, homeTeam, awayTeam, tournament_name, 
                   home_win_probability, draw_probability, away_win_probability, 
                   ou_25_prob, btts_prob, xgboost_confidence, expected_score
            FROM matches 
            WHERE startTimestamp >= ? AND startTimestamp <= ?
        `).all(startWindow, endWindow);

        log(`ℹ️ Loaded ${dbMatches.length} pre-match predictions from tactical.db matches table.`);

        const dbMatchMap = new Map();
        for (const m of dbMatches) {
            dbMatchMap.set(String(m.id), m);
        }

        // 3. Process Live Matches for Value Bets and Goal Alerts
        for (const event of liveEvents) {
            const eventId = String(event.id);
            const dbM = dbMatchMap.get(eventId);

            if (!dbM) continue;

            const homeTeam = event.homeTeam?.name || 'Home';
            const awayTeam = event.awayTeam?.name || 'Away';
            const tournament = event.tournament?.name || 'League';
            const currentHome = event.homeScore?.display ?? event.homeScore?.current ?? 0;
            const currentAway = event.awayScore?.display ?? event.awayScore?.current ?? 0;
            
            let minute = 0;
            const desc = event.status?.description || '';
            if (desc.includes('Halftime') || desc.includes('HT')) {
                minute = 45;
            } else {
                const minMatch = desc.match(/(\d+)/);
                minute = minMatch ? parseInt(minMatch[1]) : 45;
            }

            log(`⚽ Live Match active: ${homeTeam} ${currentHome} - ${currentAway} ${awayTeam} (${minute}') [ID: ${eventId}]`);

            // ─── PART A: GOAL ALERTS ENGINE (DEACTIVATED BY USER REQUEST) ───
            /*
            const prevState = matchStates[eventId];
            if (!prevState) {
                matchStates[eventId] = {
                    homeScore: currentHome,
                    awayScore: currentAway,
                    minute: minute,
                    status: event.status?.type || 'live'
                };
            } else {
                const prevHome = prevState.homeScore;
                const prevAway = prevState.awayScore;

                if (currentHome > prevHome || currentAway > prevAway) {
                    const scorer = currentHome > prevHome ? homeTeam : awayTeam;
                    log(`⚽ GOAL! ${scorer} scored! New score: ${homeTeam} ${currentHome} - ${currentAway} ${awayTeam}`);

                    let goalMsg = `⚽ *BUT !!!* ⚽\n\n`;
                    goalMsg += `🏆 *${tournament}*\n`;
                    goalMsg += `🔥 *${homeTeam} ${currentHome} - ${currentAway} ${awayTeam}*\n`;
                    goalMsg += `⏰ *Minute :* ${minute}'\n\n`;
                    
                    if (currentHome > prevHome) {
                        goalMsg += `🎯 *Buteur :* ${homeTeam} 🏠\n`;
                    } else {
                        goalMsg += `🎯 *Buteur :* ${awayTeam} ✈️\n`;
                    }
                    
                    goalMsg += `\n🤖 _Titanium Live Goal Alert_`;
                    await sendTelegram(goalMsg);

                    matchStates[eventId].homeScore = currentHome;
                    matchStates[eventId].awayScore = currentAway;
                    matchStates[eventId].minute = minute;
                }
            }
            */

            // ─── PART B: LIVE VALUE BETS ENGINE ───
            if (minute < 10 || minute > 75) continue;
            if (event.status?.type !== 'inprogress') continue;

            const alertedKeyHome = `${eventId}:1`;
            const alertedKeyAway = `${eventId}:2`;

            const pH = parseFloat(dbM.home_win_probability || 0);
            const pA = parseFloat(dbM.away_win_probability || 0);
            
            let isCandidateHome = pH >= 60 && currentHome <= currentAway;
            let isCandidateAway = pA >= 60 && currentAway <= currentHome;

            if (isCandidateHome && !alertedValueBets.has(alertedKeyHome)) {
                log(`🔍 Home favorite candidate drawing/losing: ${homeTeam} vs ${awayTeam}. Querying live odds...`);
                const oddsData = await SofaAPI.getOddsFeatured(eventId);
                const fullTimeOdds = oddsData?.featured?.fullTime;
                
                if (fullTimeOdds && fullTimeOdds.choices) {
                    const homeChoice = fullTimeOdds.choices.find(c => c.name === '1');
                    if (homeChoice && !fullTimeOdds.suspended) {
                        const liveOddsHome = fractionToDecimal(homeChoice.fractionalValue);
                        if (liveOddsHome > 1.30) {
                            const ev = (pH / 100) * liveOddsHome - 1;
                            log(`📊 ${homeTeam} win live odds: @${liveOddsHome.toFixed(2)} | Calculated EV: +${(ev*100).toFixed(1)}%`);
                            
                            if (ev >= 0.12) {
                                const kelly = ev / (liveOddsHome - 1);
                                const stake = Math.round(Math.max(1.0, Math.min(8.0, kelly * 0.25 * 100)));
                                const confidence = dbM.xgboost_confidence ? (dbM.xgboost_confidence * 100).toFixed(0) : '85';

                                let valueMsg = `🚨 *TITANIUM LIVE VALUE BET DETECTED* 🚨\n\n`;
                                valueMsg += `🏆 *${tournament}*\n`;
                                valueMsg += `⚽ *${homeTeam} ${currentHome} - ${currentAway} ${awayTeam}*\n`;
                                valueMsg += `⏰ *Minute :* ${minute}' | *Score Actuel :* ${currentHome}-${currentAway}\n\n`;
                                valueMsg += `🔥 *PRONOSTIC LIVE : Victoire de ${homeTeam}* 🏠\n`;
                                valueMsg += `📈 *Côte Actuelle :* \`@${liveOddsHome.toFixed(2)}\` 🚀\n`;
                                valueMsg += `🧠 *Avantage Mathématique (EV) :* \`+${(ev * 100).toFixed(1)}%\`\n`;
                                valueMsg += `📊 *Confiance Pré-Match IA V17 :* \`${confidence}%\`\n`;
                                valueMsg += `💰 *Mise Conseillée :* \`${stake}% de la Bankroll\` (Kelly 1/4)\n\n`;

                                valueMsg += `🤖 _Généré automatiquement par Titanium V17 Live Engine_`;

                                await sendTelegram(valueMsg);
                                alertedValueBets.add(alertedKeyHome);
                            }
                        }
                    }
                }
            }

            if (isCandidateAway && !alertedValueBets.has(alertedKeyAway)) {
                log(`🔍 Away favorite candidate drawing/losing: ${homeTeam} vs ${awayTeam}. Querying live odds...`);
                const oddsData = await SofaAPI.getOddsFeatured(eventId);
                const fullTimeOdds = oddsData?.featured?.fullTime;
                
                if (fullTimeOdds && fullTimeOdds.choices) {
                    const awayChoice = fullTimeOdds.choices.find(c => c.name === '2');
                    if (awayChoice && !fullTimeOdds.suspended) {
                        const liveOddsAway = fractionToDecimal(awayChoice.fractionalValue);
                        if (liveOddsAway > 1.30) {
                            const ev = (pA / 100) * liveOddsAway - 1;
                            log(`📊 ${awayTeam} win live odds: @${liveOddsAway.toFixed(2)} | Calculated EV: +${(ev*100).toFixed(1)}%`);
                            
                            if (ev >= 0.12) {
                                const kelly = ev / (liveOddsAway - 1);
                                const stake = Math.round(Math.max(1.0, Math.min(8.0, kelly * 0.25 * 100)));
                                const confidence = dbM.xgboost_confidence ? (dbM.xgboost_confidence * 100).toFixed(0) : '85';

                                let valueMsg = `🚨 *TITANIUM LIVE VALUE BET DETECTED* 🚨\n\n`;
                                valueMsg += `🏆 *${tournament}*\n`;
                                valueMsg += `⚽ *${homeTeam} ${currentHome} - ${currentAway} ${awayTeam}*\n`;
                                valueMsg += `⏰ *Minute :* ${minute}' | *Score Actuel :* ${currentHome}-${currentAway}\n\n`;
                                valueMsg += `🔥 *PRONOSTIC LIVE : Victoire de ${awayTeam}* ✈️\n`;
                                valueMsg += `📈 *Côte Actuelle :* \`@${liveOddsAway.toFixed(2)}\` 🚀\n`;
                                valueMsg += `🧠 *Avantage Mathématique (EV) :* \`+${(ev * 100).toFixed(1)}%\`\n`;
                                valueMsg += `📊 *Confiance Pré-Match IA V17 :* \`${confidence}%\`\n`;
                                valueMsg += `💰 *Mise Conseillée :* \`${stake}% de la Bankroll\` (Kelly 1/4)\n\n`;

                                valueMsg += `🤖 _Généré automatiquement par Titanium V17 Live Engine_`;

                                await sendTelegram(valueMsg);
                                alertedValueBets.add(alertedKeyAway);
                            }
                        }
                    }
                }
            }
        }

    } catch (globalErr) {
        log(`❌ Error in Audit cycle: ${globalErr.message}`);
        console.error(globalErr);
    } finally {
        db.close();
        log('🏁 Live Audit cycle completed.');
    }
}

// Staggered loop function
async function loop() {
    log('🚀 Launching Titanium Live Value & Goal Alerts Engine...');
    await new Promise(r => setTimeout(r, 5000));
    
    while (true) {
        try {
            await runAudit();
        } catch(e) {
            log(`❌ Global loop error: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 45000));
    }
}

loop();

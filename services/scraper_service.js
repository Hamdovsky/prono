const { Pool } = require('pg');
const { SofaAPI } = require('../SofascoreScraping/src/apiClient'); // Reuse existing scraper logic

const LIVE_POLL_INTERVAL_MS = 10000;

class ScraperMicroservice {
    constructor() {
        this.pool = new Pool({
            user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres',
            max: 5, idleTimeoutMillis: 30000
        });
        this.isRunning = false;
    }

    async start() {
        console.log(`🚀 [SCRAPER MICROSERVICE] Started independently. Polling every ${LIVE_POLL_INTERVAL_MS/1000}s`);
        setInterval(() => this.pollLiveMatches(), LIVE_POLL_INTERVAL_MS);
        this.pollLiveMatches();
    }

    async pollLiveMatches() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            const data = await SofaAPI.getLiveEvents();
            if (!data || !data.events || data.events.length === 0) {
                this.isRunning = false; return;
            }

            // Fetch live/active match IDs from Postgres
            const res = await this.pool.query(
                "SELECT id FROM matches WHERE status IN ('live','LIVE','IN_PROGRESS','1H','2H','HT','inprogress','ongoing') OR (status NOT IN ('FT','FINISHED','Finished') AND scoreHome IS NOT NULL)"
            );
            const dbIds = new Set(res.rows.map(r => String(r.id)));

            let updatedCount = 0;
            for (const ev of data.events) {
                const matchId = String(ev.id);
                if (dbIds.has(matchId)) {
                    await this.updateMatchLiveStats(matchId, ev);
                    updatedCount++;
                }
            }

            if (updatedCount > 0) {
                console.log(`⚡ [SCRAPER MICROSERVICE] Updated stats for ${updatedCount} live matches.`);
                // Notify the API Gateway (server.js) that live matches were updated
                await this.pool.query(`NOTIFY live_updates, '{"count": ${updatedCount}}'`);
            }
        } catch (e) {
            console.error(`❌ [SCRAPER MICROSERVICE] Error: ${e.message}`);
        } finally {
            this.isRunning = false;
        }
    }

    async updateMatchLiveStats(matchId, eventData) {
        try {
            // Récupérer statistiques et cotes en parallèle
            const [matchStats, oddsData] = await Promise.all([
                SofaAPI.getMatchStats(matchId),
                SofaAPI.getOddsFeatured(matchId).catch(() => null)
            ]);
            
            const stats = matchStats?.statistics || [];
            
            const allPeriod = stats.find(p => p.period === 'ALL');
            let dangerousHome = 0, dangerousAway = 0, sotHome = 0, sotAway = 0, posHome = 50, posAway = 50, corHome = 0, corAway = 0;

            if (allPeriod && allPeriod.groups) {
                allPeriod.groups.forEach(g => {
                    g.statisticsItems.forEach(item => {
                        const name = item.name.toLowerCase();
                        if (name === 'dangerous attacks') { dangerousHome = parseInt(item.home)||0; dangerousAway = parseInt(item.away)||0; }
                        else if (name === 'shots on target') { sotHome = parseInt(item.home)||0; sotAway = parseInt(item.away)||0; }
                        else if (name === 'ball possession') { posHome = parseInt(item.home)||50; posAway = parseInt(item.away)||50; }
                        else if (name === 'corner kicks') { corHome = parseInt(item.home)||0; corAway = parseInt(item.away)||0; }
                    });
                });
            }

            const scoreHome = eventData.homeScore?.current ?? eventData.homeScore?.normaltime ?? 0;
            const scoreAway = eventData.awayScore?.current ?? eventData.awayScore?.normaltime ?? 0;
            const status = eventData.status?.type || 'live';
            const minute = eventData.time?.addedTime ? `${eventData.time.current}'+${eventData.time.addedTime}` : `${eventData.time?.current || ''}'`;
            
            // Parser les cotes
            let odds_home = null, odds_draw = null, odds_away = null;
            if (oddsData?.featured) {
                const featured = oddsData.featured;
                const market = featured.default || featured.fullTime || Object.values(featured)[0];
                
                if (market?.choices) {
                    const parseSofaOdds = (choice) => {
                        if (!choice) return null;
                        const raw = choice.fractionalValue || choice.decimalValue;
                        if (!raw) return null;
                        if (typeof raw === 'string' && raw.includes('/')) {
                            const [num, den] = raw.split('/');
                            return parseFloat(num) / parseFloat(den) + 1;
                        }
                        return parseFloat(raw);
                    };

                    market.choices.forEach(choice => {
                        const name = choice.name?.toLowerCase();
                        const val = parseSofaOdds(choice);
                        if (val && val > 1) {
                            if (name === '1' || name === 'home') odds_home = val;
                            else if (name === 'x' || name === 'draw') odds_draw = val;
                            else if (name === '2' || name === 'away') odds_away = val;
                        }
                    });
                }
            }

            // Mettre à jour le match principal
            await this.pool.query(`
                UPDATE matches SET 
                    scoreHome = $1, scoreAway = $2, status = $3, minute = $4, 
                    dangerous_attacks_home = $5, dangerous_attacks_away = $6,
                    shots_on_target_home = $7, shots_on_target_away = $8,
                    possession_home = $9, possession_away = $10,
                    corners_home = $11, corners_away = $12,
                    odds_home = $13, odds_draw = $14, odds_away = $15,
                    last_updated = $16
                WHERE id = $17
            `, [
                scoreHome, scoreAway, status, minute, dangerousHome, dangerousAway,
                sotHome, sotAway, posHome, posAway, corHome, corAway,
                odds_home, odds_draw, odds_away, Date.now(), String(matchId)
            ]);
            
            // Enregistrer dans l'historique des mouvements de cotes
            if (odds_home && odds_away) {
                await this.pool.query(`
                    INSERT INTO odds_history (match_id, minute, odds_home, odds_draw, odds_away, timestamp)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [matchId, eventData.time?.current || 0, odds_home, odds_draw, odds_away, Date.now()]);
                
                console.log(`💰 [ODDS LIVE] ${matchId}: H=${odds_home?.toFixed(2)} D=${odds_draw?.toFixed(2)} A=${odds_away?.toFixed(2)} @ ${minute}`);
            }

        } catch (e) {
            console.error(`[SCRAPER MICROSERVICE] Failed to update ${matchId}: ${e.message}`);
        }
    }
}

const service = new ScraperMicroservice();
if (require.main === module) {
    service.start();
}
module.exports = service;

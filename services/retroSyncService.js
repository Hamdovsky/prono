const db = require('../core/database');
const { SofaAPI } = require('../SofascoreScraping/src/apiClient');
const logger = require('../core/logger');

class RetroSyncService {
    /**
     * Finds and synchronizes matches that started in the past but remain in 'scheduled' status.
     * This ensures the Autopsy Engine has data to analyze even after server downtime.
     */
    async syncPastMatches() {
        logger.info('🔄 [RETRO-SYNC] Starting sync for past pending matches...');
        
        try {
            const now = Date.now();
            const twoHoursAgo = now - (2.5 * 60 * 60 * 1000); // 2.5 hours threshold
            
            // Query matches that should have finished but are still 'scheduled'
            const pendingMatches = await db.prepare(`
                SELECT id, homeTeam, awayTeam, timestamp, fullData
                FROM matches
                WHERE (status = 'scheduled' OR status IS NULL)
                AND timestamp < ?
                AND (json_extract(fullData, '$.predictions') IS NOT NULL 
                     OR json_extract(fullData, '$.enriched.main_predictions') IS NOT NULL)
                LIMIT 50
            `).all(twoHoursAgo);

            if (pendingMatches.length === 0) {
                logger.info('✅ [RETRO-SYNC] No past pending matches found.');
                return { processed: 0 };
            }

            logger.info(`📡 [RETRO-SYNC] Found ${pendingMatches.length} matches to synchronize.`);
            
            let syncCount = 0;
            for (const match of pendingMatches) {
                try {
                    const matchId = match.id;
                    logger.info(`🔍 [RETRO-SYNC] Fetching final data for: ${match.homeTeam} vs ${match.awayTeam} (${matchId})`);
                    
                    const [details, stats] = await Promise.all([
                        SofaAPI.getMatchDetails(matchId),
                        SofaAPI.getMatchStats(matchId)
                    ]);

                    if (!details || !details.event) {
                        logger.warn(`⚠️ [RETRO-SYNC] Match details not found for ${matchId}`);
                        continue;
                    }

                    const event = details.event;
                    const status = event.status?.type || 'finished';
                    
                    // Proceed only if match is truly finished
                    if (status !== 'finished' && event.status?.code !== 100) {
                        logger.info(`⏳ [RETRO-SYNC] Match ${matchId} still in progress or postponed (${status})`);
                        continue;
                    }

                    // Update fullData with stats and final results
                    const currentFullData = JSON.parse(match.fullData || '{}');
                    
                    // Basic normalization
                    const homeScore = event.homeScore?.current ?? event.homeScore?.normaltime ?? 0;
                    const awayScore = event.awayScore?.current ?? event.awayScore?.normaltime ?? 0;
                    
                    const updatedFullData = {
                        ...currentFullData,
                        stats: stats?.statistics || [],
                        status: 'finished',
                        score: { home: homeScore, away: awayScore },
                        incidents: event.incidents || []
                    };

                    // Update database
                    db.prepare(`
                        UPDATE matches 
                        SET status = 'FT', 
                            scoreHome = ?, 
                            scoreAway = ?, 
                            fullData = ?
                        WHERE id = ?
                    `).run(homeScore, awayScore, JSON.stringify(updatedFullData), matchId);

                    logger.info(`✅ [RETRO-SYNC] Successfully synchronized: ${match.homeTeam} ${homeScore}-${awayScore} ${match.awayTeam}`);
                    syncCount++;
                    
                } catch (err) {
                    logger.error(`❌ [RETRO-SYNC] Failed to sync match ${match.id}: ${err.message}`);
                }
                
                // Small sleep to be nice to API
                await new Promise(r => setTimeout(r, 1000));
            }

            logger.info(`🏁 [RETRO-SYNC] Sync complete. Processed ${syncCount} matches.`);
            return { processed: syncCount };
            
        } catch (error) {
            logger.error(`❌ [RETRO-SYNC] Global error: ${error.message}`);
            return { error: error.message };
        }
    }
}

module.exports = new RetroSyncService();

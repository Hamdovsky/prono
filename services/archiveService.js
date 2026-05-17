const database = require('../core/database');
const logger = require('../core/logger');

class ArchiveService {
    async runAutoArchiving() {
        try {
            const finishedMatches = await database.getMatchesByStatuses(['finished', 'FT', 'Finished']);
            if (finishedMatches.length === 0) return;

            logger.info(`🧹 [ARCHIVE] Processing ${finishedMatches.length} finished matches for historical feedback...`);
            
            let archivedCount = 0;
            for (const match of finishedMatches) {
                try {
                    // Archiving to historical_archive.sqlite
                    const archiveResult = database.archiveFinishedMatches?.(match.id);
                    if (archiveResult && archiveResult.success) {
                        archivedCount++;
                    } else {
                        // Fallback manual archiving if core DB method is generic
                        const stmt = database.prepare(`
                            INSERT INTO matches (
                                id, timestamp, homeTeam, awayTeam, scoreHome, scoreAway, league, fullData
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT (id) DO NOTHING
                        `);
                        await stmt.run(
                            match.id,
                            match.timestamp || new Date().toISOString(),
                            match.homeTeam,
                            match.awayTeam,
                            match.scoreHome || 0,
                            match.scoreAway || 0,
                            match.league,
                            match.fullData
                        );
                        archivedCount++;
                    }
                    // Delete from active matches
                    await database.prepare("DELETE FROM matches WHERE id = ?").run(match.id);
                } catch (err) {
                    logger.error(`Failed to archive match ${match.id}: ${err.message}`);
                }
            }
            
            if (archivedCount > 0) {
                logger.info(`✅ [ARCHIVE] Successfully archived ${archivedCount} matches.`);
            }
        } catch (e) {
            logger.error('❌ [ARCHIVE] Automation error:', e.message);
        }
    }
}

module.exports = new ArchiveService();

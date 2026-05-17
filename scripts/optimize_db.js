const Database = require('better-sqlite3');
const path = require('path');

const dbPath = 'c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/historical_archive.sqlite';
const db = new Database(dbPath);

console.log('🚀 Ajout d\'index pour booster les performances stratégiques...');

try {
    // Index pour la recherche d'équipes (le plus critique pour ml_features.py)
    db.exec('CREATE INDEX IF NOT EXISTS idx_archive_homeTeam ON archive_matches(homeTeam)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_archive_awayTeam ON archive_matches(awayTeam)');
    
    // Index pour les filtres de date
    db.exec('CREATE INDEX IF NOT EXISTS idx_archive_date ON archive_matches(startTimestamp)');
    
    // Index pour la recherche par ligue
    db.exec('CREATE INDEX IF NOT EXISTS idx_archive_league ON archive_matches(tournament_name)');

    console.log('✅ Indexation terminée.');
} catch (e) {
    console.error('❌ Erreur lors de l\'indexation :', e.message);
} finally {
    db.close();
}

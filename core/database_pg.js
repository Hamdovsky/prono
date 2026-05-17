/**
 * PostgreSQL to SQLite Compatibility Wrapper
 * Redirige toutes les requêtes PostgreSQL vers l'implémentation SQLite (better-sqlite3)
 * pour unifier le système et éviter les erreurs de connexion.
 */

const sqliteDB = require('./database');
const logger = require('./logger');

const database = {
    ...sqliteDB,
    // Compatibilité avec l'API pg (Promise based)
    query: async (sql, params = []) => {
        try {
            // Conversion basique de $1, $2 en ?
            const sqliteSql = sql.replace(/\$\d+/g, '?');
            const res = await sqliteDB.query(sqliteSql, params);
            return { rows: res.rows || [] };
        } catch (e) {
            logger.error(`[PG-WRAPPER] Query error: ${e.message}`);
            return { rows: [] };
        }
    },
    
    // Stub pour le pool PG si nécessaire
    db: {
        query: async (sql, params = []) => {
            const sqliteSql = sql.replace(/\$\d+/g, '?');
            const res = await sqliteDB.query(sqliteSql, params);
            return { rows: res.rows || [] };
        }
    }
};

module.exports = database;

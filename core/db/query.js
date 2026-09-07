// query.js — helpers d'exécution SQL (statement cache + prepare/query/get/exec/transaction).
// Extrait de core/database.js (split 2026-09-07). NOTE: le query async (ex-ligne 773)
// était MORT (écrasé par le query sync dans le même littéral) — supprimé, comportement final identique.
const logger = require('../logger')

function createQueryHelpers(db) {
  // 🚀 [PERFORMANCE] Statement Cache to avoid constant regex/parsing
  const statementCache = new Map()
  const MAX_CACHE_SIZE = 100

  function getPreparedStatement(sql) {
    if (statementCache.has(sql)) return statementCache.get(sql)

    // 🧹 [RAM] Cache Eviction if too large
    if (statementCache.size >= MAX_CACHE_SIZE) {
      const firstKey = statementCache.keys().next().value
      statementCache.delete(firstKey)
    }

    const processedSql = sql
      .replace(/\$\d+/g, '?')
      .replace(/::text/gi, '')
      .replace(/::varchar\(\d+\)/gi, '')
      .replace(/::jsonb/gi, '')
      .replace(/ILIKE/gi, 'LIKE')

    try {
      const stmt = db.prepare(processedSql)
      statementCache.set(sql, stmt)
      return stmt
    } catch (e) {
      logger.error(`[DB CACHE] Failed to prepare: ${processedSql} | Error: ${e.message}`)
      throw e
    }
  }

  return {
    exec: async (sql) => {
      db.exec(sql)
    },
    prepare: (sql) => {
      try {
        const stmt = getPreparedStatement(sql)
        return {
          run: (...args) => {
            const params = Array.isArray(args[0]) ? args[0] : args
            const res = stmt.run(params)
            return { lastInsertRowid: res.lastInsertRowid, changes: res.changes }
          },
          get: (...args) => {
            const params = Array.isArray(args[0]) ? args[0] : args
            return stmt.get(params)
          },
          all: (...args) => {
            const params = Array.isArray(args[0]) ? args[0] : args
            return stmt.all(params)
          },
        }
      } catch (e) {
        logger.error(`[DB PREPARE] Failed: ${sql}`)
        return { run: () => ({ changes: 0 }), get: () => null, all: () => [] }
      }
    },
    get: async (sql, params = []) => {
      const sqliteSql = sql.replace(/\$\d+/g, '?')
      return db.prepare(sqliteSql).get(params)
    },
    transaction: (fn) => (items) => {
      const CHUNK_SIZE = 100
      const insertChunk = db.transaction((dataChunk) => {
        for (const item of dataChunk) fn(item)
      })

      // Split items into smaller chunks
      for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        const chunk = items.slice(i, i + CHUNK_SIZE)
        insertChunk(chunk)
        // In synchronous land, this is all we can do to minimally segment the transaction object itself
      }
    },

    // -- NATIVE POSTGRES IMPLEMENTATIONS --
    query: (sql, params = []) => {
      try {
        const stmt = getPreparedStatement(sql)
        const res = stmt.all(params)
        return { rows: res || [] }
      } catch (e) {
        logger.error(`[DB QUERY ERROR] ${sql} | ${e.message}`)
        return { rows: [] }
      }
    },
  }
}

module.exports = { createQueryHelpers }

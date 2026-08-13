// matchKey.js — canonical cross-source match identity for dedup
//
// Different sources give a match different IDs (livescore_<Eid>, oldb_<id>,
// sofascore_<id>...), so dedup uses a canonical key built from teams + date.
// getOrComputeMatchKey() is LAZY: if a stored match_key already exists it is
// returned; otherwise it is computed on the fly. This makes the feature
// retro-compatible with pre-existing rows (match_key NULL) and tolerant of an
// environment where the migration hasn't run yet.

function normalizeTeamName(name) {
  if (!name) return ''
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ') // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim()
}

function toMs(n) {
  const v = Number(n)
  if (!v) return Date.now()
  // Values < 100e9 are Unix seconds (Livescore/OpenLigaDB use seconds); >= are ms.
  return v < 100000000000 ? v * 1000 : v
}

function formatDateUTC(ms) {
  const d = new Date(toMs(ms))
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

// Builds the canonical key. disambiguator is optional (e.g. kickoff HHMM) and
// only appended when two matches between the same teams fall on the same day.
function buildMatchKey({ homeTeam, awayTeam, startTimestamp, disambiguator }) {
  const h = normalizeTeamName(homeTeam)
  const a = normalizeTeamName(awayTeam)
  if (!h || !a) return null
  let key = `${h}|${a}|${formatDateUTC(startTimestamp)}`
  if (disambiguator) key = `${key}|${disambiguator}`
  return key
}

// row may be a DB row ({ homeTeam, awayTeam, startTimestamp, match_key }) or a
// plain object. Returns the stored key if present, else computes it.
function getOrComputeMatchKey(row) {
  if (row && row.match_key) return row.match_key
  if (!row) return null
  return buildMatchKey({
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    startTimestamp: row.startTimestamp,
  })
}

module.exports = { normalizeTeamName, formatDateUTC, buildMatchKey, getOrComputeMatchKey }

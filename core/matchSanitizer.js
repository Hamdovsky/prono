'use strict'

const logger = require('./logger')

// ─── KNOWN FROZEN/ZOMBIE PATTERNS ────────────────────────────────────────────
// Matches that slip through with identical fake data from broken scrapers/models

const FROZEN_CONFIDENCE_VALUES = [33, 33.3, 33.33, 35, 50]
const FROZEN_PROB_SUM_THRESHOLD = 5   // if |h+d+a - 100| > 5, probs are broken
const MIN_VALID_PROB = 1              // any 1X2 prob below 1% is garbage
// Adaptive freshness: Render free tier sleeps after 15min → crons stop → matches get stale
const MAX_MATCH_AGE_MS = process.env.RENDER
    ? 168 * 3600 * 1000   // 7 days on Render (service sleeps frequently)
    : 48 * 3600 * 1000    // 48h on Replit/local (always-on)

// ─── FLAG / COUNTRY MISMATCH MAP ─────────────────────────────────────────────
// league keywords → expected country_iso patterns
const LEAGUE_COUNTRY_MAP = {
    'botola':        ['ma', 'mar', 'morocco'],
    'championship':  ['gb', 'eng', 'en', 'united kingdom'],
    'premier league':['gb', 'eng', 'en'],
    'serie a':       ['it', 'ita', 'italy'],
    'serie b':       ['it', 'ita'],
    'la liga':       ['es', 'esp', 'spain'],
    'bundesliga':    ['de', 'deu', 'germany'],
    'ligue 1':       ['fr', 'fra', 'france'],
    'eredivisie':    ['nl', 'nld', 'netherlands'],
    'brasileirao':   ['br', 'bra', 'brazil'],
    'brasileirão':   ['br', 'bra', 'brazil'],
    'mls':           ['us', 'usa', 'united states'],
    'champions league': ['eu', 'uefa'],
    'europa league':    ['eu', 'uefa'],
    'k league':      ['kr', 'kor', 'south korea'],
    'chinese super': ['cn', 'chn', 'china'],
    'allsvenskan':   ['se', 'swe', 'sweden'],
    'veikkausliiga': ['fi', 'fin', 'finland'],
    'suomen cup':    ['fi', 'fin', 'finland'],
    'npl queensland':['au', 'aus', 'australia'],
    'world cup':     null, // international — no flag check
    'fifa':          null,
}

// ─── TEAM NAME SANITY ────────────────────────────────────────────────────────
const PLACEHOLDER_TEAMS = /^(home|away|tbd|tba|equipo a|equipo b|team 1|team 2|local|visitante)$/i
const GARBLED_NAME_RE = /^[^\w\s]{3,}|[\x00-\x08\x0e-\x1f]{2,}/  // control chars or emoji-only
const SHORT_NAME_RE = /^.{1,2}$/  // 1-2 char team names are almost always garbage

// ─── CORE SANITIZER ──────────────────────────────────────────────────────────

function isFrozenConfidence(conf) {
    if (conf == null) return true
    const c = parseFloat(conf)
    return FROZEN_CONFIDENCE_VALUES.some(frozen => Math.abs(c - frozen) < 0.5)
}

function validateProbabilities(match) {
    const h = parseFloat(match.home_win_probability || 0)
    const d = parseFloat(match.draw_probability || 0)
    const a = parseFloat(match.away_win_probability || 0)
    const sum = h + d + a

    // All zero = no prediction at all
    if (h === 0 && d === 0 && a === 0) return { valid: false, reason: 'ALL_PROBS_ZERO' }

    // Any single prob is suspiciously low
    if (h > 0 && h < MIN_VALID_PROB) return { valid: false, reason: 'PROB_TOO_LOW', field: 'home', value: h }
    if (d > 0 && d < MIN_VALID_PROB) return { valid: false, reason: 'PROB_TOO_LOW', field: 'draw', value: d }
    if (a > 0 && a < MIN_VALID_PROB) return { valid: false, reason: 'PROB_TOO_LOW', field: 'away', value: a }

    // Sum should be ~100 (within 5% tolerance for rounding)
    if (sum > 0 && Math.abs(sum - 100) > FROZEN_PROB_SUM_THRESHOLD) {
        return { valid: false, reason: 'PROB_SUM_BROKEN', sum }
    }

    // Perfectly uniform = fake default (33.3 / 33.3 / 33.3)
    if (h > 30 && d > 30 && a > 30 && Math.abs(h - d) < 2 && Math.abs(d - a) < 2) {
        return { valid: false, reason: 'UNIFORM_DEFAULT_PROBS' }
    }

    return { valid: true }
}

function validateTeamNames(match) {
    const home = (match.homeTeam || '').trim()
    const away = (match.awayTeam || '').trim()

    if (!home || !away) return { valid: false, reason: 'MISSING_TEAM_NAME' }
    if (PLACEHOLDER_TEAMS.test(home) || PLACEHOLDER_TEAMS.test(away)) {
        return { valid: false, reason: 'PLACEHOLDER_TEAM' }
    }
    if (GARBLED_NAME_RE.test(home) || GARBLED_NAME_RE.test(away)) {
        return { valid: false, reason: 'GARBLED_TEAM_NAME' }
    }
    if (SHORT_NAME_RE.test(home) || SHORT_NAME_RE.test(away)) {
        return { valid: false, reason: 'TEAM_NAME_TOO_SHORT' }
    }

    return { valid: true }
}

function validateCountryLeague(match) {
    const league = (match.league || '').toLowerCase()
    const countryIso = (match.country_iso || match.country || '').toLowerCase().trim()

    // Find matching league pattern
    for (const [pattern, expectedCountries] of Object.entries(LEAGUE_COUNTRY_MAP)) {
        if (league.includes(pattern)) {
            // null means international — skip check
            if (expectedCountries === null) return { valid: true }
            // If no country set but league implies one — flag it
            if (!countryIso) return { valid: true, warning: 'MISSING_COUNTRY_ISO' }
            // Check if country matches
            if (!expectedCountries.some(c => countryIso.includes(c))) {
                return { valid: false, reason: 'COUNTRY_LEAGUE_MISMATCH', league, countryIso }
            }
            return { valid: true }
        }
    }

    return { valid: true }
}

function validateMatchFreshness(match) {
    const now = Date.now()
    let ts = match.startTimestamp
    if (!ts) return { valid: true, warning: 'NO_TIMESTAMP' }

    let tsMs
    if (typeof ts === 'string' && ts.includes('T')) {
        tsMs = new Date(ts).getTime()
    } else {
        tsMs = parseInt(ts) > 1e11 ? parseInt(ts) : parseInt(ts) * 1000
    }

    if (isNaN(tsMs)) return { valid: false, reason: 'INVALID_TIMESTAMP' }

    const age = now - tsMs
    if (age > MAX_MATCH_AGE_MS) return { valid: false, reason: 'MATCH_TOO_STALE', ageHours: Math.round(age / 3600000) }

    return { valid: true }
}

function validateScore(match) {
    const cs = match.v22_cs_prediction || match.expected_score || ''
    if (!cs || !cs.includes('-')) return { valid: true }  // no score = not yet predicted

    const parts = cs.split('-').map(s => parseInt(s.trim()))
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
        return { valid: false, reason: 'MALFORMED_SCORE', score: cs }
    }

    // Suspicious frozen scores: exactly 1-1 with low confidence = likely default
    const isDefaultScore = (parts[0] === 1 && parts[1] === 1)
    const conf = parseFloat(match.confidence || match.v22_success_rate || 0)
    if (isDefaultScore && isFrozenConfidence(conf)) {
        return { valid: false, reason: 'FROZEN_DEFAULT_SCORE' }
    }

    // Unrealistic score (e.g., 12-0)
    if (parts[0] > 8 || parts[1] > 8) {
        return { valid: false, reason: 'UNREALISTIC_SCORE', score: cs }
    }

    return { valid: true }
}

// ─── MAIN SANITIZER FUNCTION ─────────────────────────────────────────────────

/**
 * Sanitize an array of matches — removes garbage, zombie, and corrupted data.
 * @param {Array} matches - Raw match objects from database
 * @param {Object} opts - Options
 * @param {boolean} opts.strict - If true, also reject matches with warnings (default: false)
 * @param {boolean} opts.logRejections - If true, log each rejection (default: true)
 * @returns {{ sanitized: Array, rejected: Array, stats: Object }}
 */
function sanitizeMatches(matches, opts = {}) {
    const { strict = false, logRejections = true } = opts
    const sanitized = []
    const rejected = []
    const stats = { total: matches.length, kept: 0, rejected: 0, reasons: {} }

    for (const m of matches) {
        let rejectReason = null

        // 1. Team name validation
        const names = validateTeamNames(m)
        if (!names.valid) { rejectReason = names.reason; }

        // 2. Probability validation (only if enrichment was attempted)
        if (!rejectReason && (m.home_win_probability || m.draw_probability || m.away_win_probability)) {
            const probs = validateProbabilities(m)
            if (!probs.valid) { rejectReason = probs.reason; }
        }

        // 3. Score validation
        if (!rejectReason) {
            const score = validateScore(m)
            if (!score.valid) { rejectReason = score.reason; }
        }

        // 4. Match freshness
        if (!rejectReason) {
            const fresh = validateMatchFreshness(m)
            if (!fresh.valid) { rejectReason = fresh.reason; }
        }

        // 5. Country/league mismatch (warning only in non-strict)
        if (!rejectReason) {
            const geo = validateCountryLeague(m)
            if (!geo.valid) {
                if (strict) {
                    rejectReason = geo.reason
                } else if (geo.warning) {
                    m._sanitizerWarning = geo.warning
                }
            }
        }

        if (rejectReason) {
            stats.rejected++
            stats.reasons[rejectReason] = (stats.reasons[rejectReason] || 0) + 1
            rejected.push({ id: m.id, homeTeam: m.homeTeam, awayTeam: m.awayTeam, reason: rejectReason })
            if (logRejections) {
                logger.warn(`🚫 [SANITIZER] Rejected: ${(m.homeTeam || '?')} vs ${(m.awayTeam || '?')} → ${rejectReason}`)
            }
        } else {
            stats.kept++
            sanitized.push(m)
        }
    }

    if (logRejections && stats.rejected > 0) {
        logger.info(`🧹 [SANITIZER] ${stats.rejected}/${stats.total} matches rejected. Reasons:`, stats.reasons)
    }

    return { sanitized, rejected, stats }
}

// ─── SINGLE MATCH VALIDATOR (for /api/predict endpoint) ──────────────────────

/**
 * Validate a single match before prediction — returns { valid, errors[] }
 */
function validateMatchInput(match) {
    const errors = []

    if (!match) return { valid: false, errors: ['NULL_MATCH'] }

    const names = validateTeamNames(match)
    if (!names.valid) errors.push(names.reason)

    if (!match.league && !match.tournament_id) errors.push('MISSING_LEAGUE')

    const fresh = validateMatchFreshness(match)
    if (!fresh.valid) errors.push(fresh.reason)

    return { valid: errors.length === 0, errors }
}

module.exports = {
    sanitizeMatches,
    validateMatchInput,
    validateProbabilities,
    validateTeamNames,
    validateCountryLeague,
    validateMatchFreshness,
    validateScore,
    isFrozenConfidence
}

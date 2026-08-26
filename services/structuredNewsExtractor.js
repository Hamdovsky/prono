// structuredNewsExtractor.js — Extraction structurée (absences / retours /
// compositions) depuis les headlines RSS déjà collectées par newsService.
//
// Opt-in : STRUCTURED_NEWS_ENABLED=true. Désactivé par défaut, zéro overhead.
//
// Sortie conforme au format "moteur d'extraction" :
// {
//   team_name, opponent, news_sentiment, news_summary,
//   lineup: { status, formation, confirmed_players },
//   absences: [{ player_name, position, reason, detail, importance_level }],
//   returns:  [{ player_name, status }],
//   impact_score
// }
//
// Limites documentées (voir CHANGELOG_AUDIT.md) :
// - les XI officiels passent rarement dans les RSS -> lineup souvent Unknown/null
// - heuristiques multilingues EN/FR/AR/PT uniquement
// - extraction de noms fiable pour titres latins ; l'arabe contribue surtout
//   via les absences officielles (Sofascore/Transfermarkt) déjà en DB.

const logger = require('../core/logger')

const ABSENCE_PATTERNS = {
  Injury:
    /\b(injur(?:ed|y|ies)|out for|ruled out|sidelined|hamstring|groin|calf|thigh|knee (?:injury|surgery)|ankle|muscle|fracture|broken|knock|unfit|doubtful|bless(?:é|ure|ures)|forfait|indisponible|ischio|adducteurs|إصابة|مصاب|تمزق|كسر|عطاء)\b/i,
  Suspension:
    /\b(suspended|suspension|\bban(?:ned)?\b|red card|suspendu|suspension|exclu|إيقاف|موقوف)\b/i,
  Personal: /\b(personal reasons|family reasons|compassionate|raison personnelle|أسباب شخصية)\b/i,
  International_Duty:
    /\b(international duty|national team|on duty with|s(?:é|e)lectionn(?:é|e)|مع منتخب|منتخب بلاده)\b/i,
}

const RETURN_PATTERN =
  /\b(returns?|back in training|fit again|recovered|available again|in contention|in line to return|set to return|in squad|r(?:é|e)tabli|de retour|revenu|op(?:é|e)rationnel|disponible à nouveau|عودة|عاد|تعافى|جاهز للمباراة|انضم للقائمة)\b/i

const POSITION_PATTERNS = {
  GK: /\b(goalkeeper|keeper|\bgk\b|gardien|حارس)\b/i,
  DEF: /\b(defender|centre-?back|center-?back|full-?back|left-?back|right-?back|d(?:é|e)fenseur|lat(?:é|e)ral|مدافع)\b/i,
  MID: /\b(midfielder|midfield(?:er)?|\bmid\b|milieu|وسط)\b/i,
  FWD: /\b(forward|striker|winger|attacker|attacker|attaquant|ailier|buteur|مهاجم|جناح)\b/i,
}

const CRUCIAL_MARKERS =
  /\b(captain|skipper|top scorer|top scorer|leading scorer|star(?: player)?|key player|best player|talisman|playmaker|record signing|قائد|نجم|أفضل لاعب)\b/i
const IMPORTANT_MARKERS =
  /\b(starter|regular|first-choice|first team|ever-present|titulaire|أساسي)\b/i
const ROTATION_MARKERS = /\b(rotation|squad player|youngster|reserve|جديد|احتياطي)\b/i
const MINOR_MARKERS =
  /\b(minor knock|light injury|small issue|back soon|days? away|petite blessure|légère|إصابة طفيفة)\b/i

// Mots génériques à ne JAMAIS traiter comme des noms de joueurs
const NON_PLAYER_TOKENS = new Set(
  [
    'match', 'league', 'cup', 'champions', 'premier', 'derby', 'coach', 'manager',
    'boss', 'fans', 'club', 'season', 'injury', 'injuries', 'report', 'news',
    'update', 'transfer', 'team', 'side', 'game', 'fixture', 'win', 'wins',
    'loss', 'draw', 'goal', 'goals', 'deal', 'signing', 'contract', 'return',
    'returns', 'captain', 'star', 'the', 'and', 'with', 'after', 'against',
    'over', 'from', 'into', 'ahead', 'before', 'during', 'amid', 'despite',
    'face', 'faces', 'vs', 'clash', 'battle', 'race', 'time', 'next', 'week',
    'weeks', 'month', 'months', 'day', 'days', 'out', 'doubt', 'doubtful',
    'confirmed', 'official', 'probable', 'expected', 'predicted', 'lineup',
    'line-up', 'xi', 'starting', 'squad', 'training', 'fitness', 'fit',
    'injury boost', 'crisis', 'blow', 'hit', 'boost', 'scare', 'concern',
  ].map((w) => w.toLowerCase())
)

const FORMATION_PATTERN = /\b([3-5]-[1-5]-\d(?:-\d)?)\b/
const OFFICIAL_LINEUP_PATTERN =
  /\b(official lineup|confirmed lineup|starting xi|line-?up confirmed|here is how .+ will line up|تشكيلة رسمية|التشكيلة الرسمية)\b/i
const PROBABLE_LINEUP_PATTERN =
  /\b(expected lineup|probable lineup|likely xi|predicted lineup|possible xi|expected xi|تشكيلة متوقعة|التشكيلة المرجحة)\b/i

// Candidat joueur : 2 tokens capitalisés (Prenom Nom), ou hyphenated
const PLAYER_NAME_PATTERN =
  /\b([A-ZÉÈÀÇÔÛ][a-zéèêàçôûüöäïîë'-]+(?:\s+(?:van|de|der|da|di|dos|el|al|bin|ben)\s+|\s+)(?:[A-ZÉÈÀÇÔÛ][a-zéèêàçôûüöäïîë'-]+|[A-ZÉÈÀÇÔÛ]{2,})(?:-[A-ZÉÈÀÇÔÛ][a-zéèêàçôûüöäïîë'-]+)?)\b/g

// Nom simple (nom de famille célèbre) collé à un mot-clé absence/retour :
// "Neymar returns", "Mbappe injured", "Courtois ruled out"
const SINGLE_NAME_PATTERN =
  /\b([A-ZÉÈÀÇÔÛ][a-zéèêàçôûüöäïîë'-]{2,})\s+(?=injur|ruled\s|out\b|doubtful|suspend|hamstring|groin|calf|thigh|knee|muscle|broken|fracture|sidelined|returns?\b|back\s+in\s+training|fit\s+again|recovered|set\s+to\s+return|on\s+the\s+bench)/g

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\((.*?)\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isEnabled() {
  return process.env.STRUCTURED_NEWS_ENABLED === 'true'
}

function emptyResult(teamName) {
  return {
    team_name: teamName || null,
    opponent: null,
    news_sentiment: 'Neutral',
    news_summary: 'No structured news detected.',
    lineup: { status: 'Unknown', formation: null, confirmed_players: [] },
    absences: [],
    returns: [],
    impact_score: 0.0,
  }
}

function detectPosition(text) {
  for (const [pos, re] of Object.entries(POSITION_PATTERNS)) {
    if (re.test(text)) return pos
  }
  return null
}

function detectReason(text) {
  for (const [reason, re] of Object.entries(ABSENCE_PATTERNS)) {
    if (re.test(text)) return reason
  }
  return null
}

function detectImportance(text, mentionsCount, position) {
  if (CRUCIAL_MARKERS.test(text) || position === 'GK') return 'Crucial'
  if (mentionsCount >= 2) return 'Important'
  if (IMPORTANT_MARKERS.test(text)) return 'Important'
  if (ROTATION_MARKERS.test(text)) return 'Rotation'
  if (MINOR_MARKERS.test(text)) return 'Minor'
  return 'Minor'
}

function extractPlayerCandidates(text) {
  const found = []
  const push = (name) => {
    if (!found.includes(name)) found.push(name)
  }

  let m
  const multiRe = new RegExp(PLAYER_NAME_PATTERN)
  while ((m = multiRe.exec(text)) !== null) push(m[1])

  const singleRe = new RegExp(SINGLE_NAME_PATTERN)
  while ((m = singleRe.exec(text)) !== null) {
    // Évite le doublon si déjà capturé comme partie d'un nom composé
    if (!found.some((f) => f.includes(m[1]))) push(m[1])
  }

  return found.filter((name) => {
    const lower = name.toLowerCase()
    const tokens = lower.split(/[\s-]+/)
    // Rejette si un token est un mot générique connu
    if (tokens.every((t) => NON_PLAYER_TOKENS.has(t))) return false
    // Rejette les candidats trop courts (initiales seules)
    if (tokens.some((t) => t.length < 2)) return false
    return true
  })
}

function detectOpponent(items, teamName) {
  try {
    for (const item of items || []) {
      const text = `${item.title || ''} ${item.contentSnippet || ''}`
      if (!normalizeName(text).includes(normalizeName(teamName))) continue
      let m = text.match(/\bvs\.?\s+([A-ZÉÈ][\w'’\- ]{2,35})/)
      if (!m) m = text.match(/\bagainst\s+([A-ZÉÈ][\w'’\- ]{2,35})/)
      if (!m) m = text.match(/\bface\s+([A-ZÉÈ][\w'’\- ]{2,35})/)
      if (m && normalizeName(m[1]) !== normalizeName(teamName)) {
        return m[1]
          .trim()
          .replace(/\s+(?:in|on|at|before|after|with|during|of)\b.*$/i, '')
          .replace(/[.,;:!]+$/, '')
          .trim()
      }
    }
  } catch (e) {
    logger.warn(`[STRUCTURED_NEWS] opponent detection: ${e.message}`)
  }
  return null
}

function extractAbsencesFromHeadlines(teamName, items) {
  const byPlayer = new Map()
  for (const item of items || []) {
    const text = `${item.title || ''} ${item.contentSnippet || ''}`
    if (!ABSENCE_PATTERNS.Injury.test(text) && !ABSENCE_PATTERNS.Suspension.test(text)) continue

    const players = extractPlayerCandidates(text)
    const position = detectPosition(text)
    const reason = detectReason(text)

    for (const playerName of players.slice(0, 3)) {
      const key = normalizeName(playerName)
      if (!key || key === normalizeName(teamName)) continue
      const prev = byPlayer.get(key) || {
        player_name: playerName,
        position: null,
        reason: null,
        detail: (item.title || '').slice(0, 120),
        importance_level: 'Minor',
        _mentions: 0,
        _context: [],
      }
      prev._mentions += 1
      prev._context.push(text)
      if (!prev.position && position) prev.position = position
      if (!prev.reason && reason) prev.reason = reason
      byPlayer.set(key, prev)
    }
  }

  // Fusion floue : "mbappe" fusionne dans "kylian mbappe" (tokens inclus)
  const keysSnapshot = Array.from(byPlayer.keys())
  for (const k of keysSnapshot) {
    if (!byPlayer.has(k)) continue
    const kt = k.split(' ')
    for (const other of keysSnapshot) {
      if (other === k || !byPlayer.has(other)) continue
      const ot = other.split(' ')
      if (kt.length < ot.length && kt.every((t) => ot.includes(t))) {
        const small = byPlayer.get(k)
        const big = byPlayer.get(other)
        big._mentions += small._mentions
        big._context.push(...small._context)
        if (!big.position && small.position) big.position = small.position
        if (!big.reason && small.reason) big.reason = small.reason
        byPlayer.delete(k)
      }
    }
  }

  const absences = []
  for (const entry of byPlayer.values()) {
    const joinedContext = entry._context.join(' ')
    entry.importance_level = detectImportance(joinedContext, entry._mentions, entry.position)
    absences.push({
      player_name: entry.player_name,
      position: entry.position,
      reason: entry.reason || 'Injury',
      detail: entry.detail,
      importance_level: entry.importance_level,
    })
  }
  return absences
}

function mapOfficialInjuries(injuries) {
  const mapped = []
  for (const inj of injuries || []) {
    if (!inj || !inj.name) continue
    const context = `${inj.name} ${inj.reason || ''} ${inj.position || ''}`
    const position = inj.position || null
    mapped.push({
      player_name: inj.name,
      position: ['GK', 'DEF', 'MID', 'FWD'].includes(position) ? position : null,
      reason: detectReason(context) || 'Injury',
      detail: `Source officielle: ${inj.source || 'unknown'} (${inj.reason || 'raison non précisée'})`,
      importance_level: detectImportance(context, 2, ['GK'].includes(position) ? 'GK' : null),
    })
  }
  return mapped
}

function extractReturns(teamName, items) {
  const returns = []
  const seen = new Set()
  for (const item of items || []) {
    const text = `${item.title || ''} ${item.contentSnippet || ''}`
    if (!RETURN_PATTERN.test(text)) continue
    for (const playerName of extractPlayerCandidates(text).slice(0, 3)) {
      const key = normalizeName(playerName)
      if (!key || seen.has(key) || key === normalizeName(teamName)) continue
      seen.add(key)
      let status = 'Fit'
      if (/starts?|in the xi|named in starting/i.test(text)) status = 'Starting'
      else if (/bench|substitute/i.test(text)) status = 'On_Bench'
      returns.push({ player_name: playerName, status })
    }
  }
  return returns
}

function extractLineup(items) {
  let formation = null
  let status = 'Unknown'
  let confirmedPlayers = []
  for (const item of items || []) {
    const text = `${item.title || ''} ${item.contentSnippet || ''}`
    if (!formation) {
      const fm = text.match(FORMATION_PATTERN)
      if (fm) formation = fm[1]
    }
    if (status !== 'Official' && OFFICIAL_LINEUP_PATTERN.test(text)) status = 'Official'
    else if (status === 'Unknown' && PROBABLE_LINEUP_PATTERN.test(text)) status = 'Probable'

    if (status !== 'Unknown' && confirmedPlayers.length === 0) {
      const listMatch = text.match(/(?:xi|line-?up)\s*[:\-]\s*(.{10,200})/i)
      if (listMatch) {
        confirmedPlayers = extractPlayerCandidates(listMatch[1]).slice(0, 11)
      }
    }
  }
  return { status, formation, confirmed_players: confirmedPlayers }
}

function computeImpactScore(absences, returns) {
  const weights = { Crucial: -1.5, Important: -0.8, Rotation: -0.3, Minor: -0.15 }
  const returnBonus = { Starting: 1.0, Fit: 0.8, On_Bench: 0.6 }
  let score = 0
  for (const a of absences) score += weights[a.importance_level] ?? -0.15
  for (const r of returns) score += returnBonus[r.status] ?? 0.5
  return Math.max(-5.0, Math.min(5.0, Math.round(score * 10) / 10))
}

function buildSentiment(absences, returns) {
  const hasCrucial = absences.some((a) => a.importance_level === 'Crucial')
  if (hasCrucial && absences.length > returns.length + 1) return 'Critical'
  if (absences.length > returns.length) return 'Negative'
  if (returns.length > absences.length) return 'Positive'
  return 'Neutral'
}

/**
 * Point d'entrée principal : construit le JSON structuré d'une équipe.
 * @param {Object} params
 * @param {string} params.teamName - nom de l'équipe
 * @param {Array}  params.items     - news brutes [{title, contentSnippet?, source?, pubDate?}]
 * @param {Array}  [params.injuries]- absences officielles (Sofascore/Transfermarkt)
 * @param {string} [params.opponent] - adversaire si déjà connu
 * @returns {Object} JSON structuré (format moteur d'extraction)
 */
function extract({ teamName, items, injuries, opponent }) {
  try {
    if (!teamName) return emptyResult(null)
    const result = emptyResult(teamName)

    const officialAbsences = mapOfficialInjuries(injuries)
    const headlineAbsences = extractAbsencesFromHeadlines(teamName, items)

    // Fusion : officielles prioritaire, dédoublonnage par nom normalisé
    const mergedByName = new Map()
    for (const a of [...headlineAbsences, ...officialAbsences]) {
      mergedByName.set(normalizeName(a.player_name), a)
    }
    result.absences = Array.from(mergedByName.values())

    result.returns = extractReturns(teamName, items)
    result.lineup = extractLineup(items)
    result.opponent = opponent || detectOpponent(items, teamName)
    result.news_sentiment = buildSentiment(result.absences, result.returns)
    result.impact_score = computeImpactScore(result.absences, result.returns)

    if (result.absences.length > 0) {
      const top = result.absences.reduce((worst, a) =>
        rank(a.importance_level) > rank(worst.importance_level) ? a : worst
      )
      result.news_summary = `${top.player_name} absent (${top.reason}, ${top.importance_level}).`
    } else if ((items || []).length > 0) {
      result.news_summary = (items[0].title || '').slice(0, 140)
    }

    return result
  } catch (e) {
    logger.warn(`[STRUCTURED_NEWS] extract failed for ${teamName}: ${e.message}`)
    return emptyResult(teamName)
  }
}

function rank(level) {
  return { Crucial: 3, Important: 2, Rotation: 1, Minor: 0 }[level] ?? 0
}

module.exports = {
  isEnabled,
  extract,
  // exposés pour tests unitaires
  _internals: {
    normalizeName,
    detectPosition,
    detectReason,
    detectImportance,
    extractPlayerCandidates,
    extractAbsencesFromHeadlines,
    extractReturns,
    extractLineup,
    computeImpactScore,
    buildSentiment,
    mapOfficialInjuries,
    detectOpponent,
  },
}

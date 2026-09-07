/**
 * visualSignals — parse tolérant + injection comblante (fonctions pures).
 */
const { parseSignals, applyGapFill, VISUAL_FIELD_MAP } = require('../services/visualSignals')

describe('parseSignals', () => {
  test('JSON propre -> objet normalisé', () => {
    const raw = JSON.stringify({
      briefing: '- forme\n- effectif\n- h2h',
      missing_star_home: 1,
      missing_star_away: 0,
      missing_gk_home: '1',
      missing_gk_away: 0,
      form_home: 'W-W-D',
      form_away: 'L-L-D',
      h2h_note: 'domination domicile',
      confidence: 0.8,
    })
    const s = parseSignals(raw)
    expect(s).toBeTruthy()
    expect(s.missing_star_home).toBe(1)
    expect(s.missing_gk_home).toBe(1) // '1' -> 1
    expect(s.missing_star_away).toBe(0)
    expect(s.confidence).toBe(0.8)
    expect(s.briefing).toContain('forme')
  })

  test('JSON entouré de texte (verbes LLM) -> extraction tolérante', () => {
    const raw = 'Voici mon analyse :\n```json\n{"briefing":"ok","missing_star_home":1,"confidence":0.7}\n```\nfin'
    const s = parseSignals(raw)
    expect(s).toBeTruthy()
    expect(s.missing_star_home).toBe(1)
    expect(s.missing_star_away).toBe(0) // absent -> 0
  })

  test('confidence hors bornes -> clamp [0,1]', () => {
    expect(parseSignals('{"briefing":"x","confidence":1.9}').confidence).toBe(1)
    expect(parseSignals('{"briefing":"x","confidence":-3}').confidence).toBe(0)
    expect(parseSignals('{"briefing":"x","confidence":"abc"}').confidence).toBe(0)
  })

  test('pas de JSON / JSON cassé -> null', () => {
    expect(parseSignals('aucun objet ici')).toBeNull()
    expect(parseSignals('{"incomplet": ')).toBeNull()
    expect(parseSignals(null)).toBeNull()
    expect(parseSignals('')).toBeNull()
  })
})

describe('applyGapFill (injection comblante)', () => {
  const signals = (over = {}) => ({
    briefing: 'x',
    missing_star_home: 1,
    missing_star_away: 1,
    missing_gk_home: 0,
    missing_gk_away: 0,
    confidence: 0.9,
    ...over,
  })

  test('news muettes (champs absents) -> flags posés', () => {
    const matchData = {}
    const filled = applyGapFill(matchData, { homeTeam: 'A' }, signals())
    expect(filled).toEqual(['is_missing_star', 'is_missing_star_away'])
    expect(matchData.is_missing_star).toBe(1)
    expect(matchData.is_missing_star_away).toBe(1)
    expect(matchData.is_missing_gk).toBeUndefined() // signal à 0 -> rien
  })

  test('news déjà à 1 -> JAMAIS écrasé ni doublonné', () => {
    const matchData = {}
    const filled = applyGapFill(matchData, { is_missing_star: 1 }, signals())
    expect(filled).toEqual(['is_missing_star_away']) // away seul (news muettes)
    expect(matchData.is_missing_star).toBeUndefined()
  })

  test('news à 0 = muet -> le visuel peut combler', () => {
    const matchData = {}
    const filled = applyGapFill(matchData, { is_missing_star: 0 }, signals())
    expect(filled).toContain('is_missing_star')
    expect(matchData.is_missing_star).toBe(1)
  })

  test('confiance sous le seuil -> aucun impact', () => {
    const matchData = {}
    const filled = applyGapFill(matchData, {}, signals({ confidence: 0.3 }))
    expect(filled).toEqual([])
    expect(Object.keys(matchData)).toHaveLength(0)
  })

  test('signaux null / matchData absent -> no-op', () => {
    expect(applyGapFill({}, {}, null)).toEqual([])
    expect(applyGapFill(null, {}, signals())).toEqual([])
  })

  test('tous les mapping ciblent des champs match_obj de l"engine', () => {
    expect(Object.values(VISUAL_FIELD_MAP)).toEqual(
      expect.arrayContaining(['is_missing_star', 'is_missing_star_away', 'is_missing_gk', 'is_missing_gk_away'])
    )
  })
})

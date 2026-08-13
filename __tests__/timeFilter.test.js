/**
 * Unit tests pour le filtre temporel (AUJOURD'HUI / DEMAIN / 3 JOURS / 7 JOURS).
 * Déterministe : `nowMs` fixe (UTC) + `tzOffsetMinutes` figé (-60 = UTC+1, comme
 * le fuseau cible). Les bornes sont donc identiques sur toute machine.
 */

const {
  getDateWindow,
  getLocalDayStart,
  getLocalDayEnd,
  extractMatchMs,
  filterMatchesInWindow,
} = require('../src/utils/timeFilter.js')

const TZ = -60 // UTC+1
const NOW = Date.parse('2026-08-13T08:00:00Z') // local 09:00 (jeudi 13/08)

const match = (id, startTimestamp) => ({
  id,
  homeTeam: 'A',
  awayTeam: 'B',
  league: 'Test',
  startTimestamp,
})

const ids = (ms) => ms.map((m) => m.id).sort()

describe('getDateWindow (bornes jours locaux, UTC+1)', () => {
  it('AUJOURD_HUI = jour J+0 uniquement', () => {
    const w = getDateWindow('Today', NOW, TZ)
    expect(w.start).toBe(getLocalDayStart(0, NOW, TZ))
    expect(w.end).toBe(getLocalDayEnd(0, NOW, TZ))
    expect(w.start).toBe(Date.parse('2026-08-12T23:00:00Z'))
    expect(w.end).toBe(Date.parse('2026-08-13T22:59:59.999Z'))
  })

  it('DEMAIN = jour J+1 uniquement', () => {
    const w = getDateWindow('Tomorrow', NOW, TZ)
    expect(w.start).toBe(Date.parse('2026-08-13T23:00:00Z'))
    expect(w.end).toBe(Date.parse('2026-08-14T22:59:59.999Z'))
  })

  it('3 JOURS = 3 jours calendaires incluant aujourd_hui (J+0..J+2)', () => {
    const w = getDateWindow('Next 3 Days', NOW, TZ)
    expect(w.start).toBe(Date.parse('2026-08-12T23:00:00Z'))
    expect(w.end).toBe(Date.parse('2026-08-15T22:59:59.999Z'))
  })

  it('7 JOURS = 7 jours calendaires incluant aujourd_hui (J+0..J+6)', () => {
    const w = getDateWindow('Next 7 Days', NOW, TZ)
    expect(w.start).toBe(Date.parse('2026-08-12T23:00:00Z'))
    expect(w.end).toBe(Date.parse('2026-08-19T22:59:59.999Z'))
  })

  it('filtre inconnu => pas de fenêtre (pas de filtrage)', () => {
    expect(getDateWindow('Nope', NOW, TZ)).toBeNull()
  })
})

describe('extractMatchMs (secondes / ms / ISO / absent)', () => {
  it('convertit les secondes UNIX en ms', () => {
    const sec = Math.floor(Date.parse('2026-08-14T20:00:00Z') / 1000)
    expect(extractMatchMs(match('m', sec))).toBe(Date.parse('2026-08-14T20:00:00Z'))
  })

  it('garde les ms telles quelles', () => {
    const ms = Date.parse('2026-08-14T20:00:00Z')
    expect(extractMatchMs(match('m', ms))).toBe(ms)
  })

  it('parse les ISO strings (avec T)', () => {
    expect(extractMatchMs(match('m', '2026-08-14T20:00:00Z'))).toBe(
      Date.parse('2026-08-14T20:00:00Z')
    )
  })

  it('retourne null sans timestamp exploitable', () => {
    expect(extractMatchMs({ id: 'x', homeTeam: 'A', awayTeam: 'B' })).toBeNull()
    expect(extractMatchMs({ id: 'x', startTimestamp: 0 })).toBeNull()
  })
})

describe('filterMatchesInWindow — 4 cas avec dates figées', () => {
  const ALL = [
    match('today-noon', Date.parse('2026-08-13T12:00:00Z')), // jeudi 13/08 13:00 local
    match('today-edge-end', Date.parse('2026-08-13T22:59:00Z')), // 23:59 local jeudi
    match('today-plus1h', Date.parse('2026-08-13T23:01:00Z')), // vendredi 00:01 local
    match('prev-evening', Date.parse('2026-08-12T22:00:00Z')), // mercredi 23:00 local
    match('tomorrow-eve', Date.parse('2026-08-14T20:00:00Z')), // vendredi 21:00 local
    match('tomorrow-plus1h', Date.parse('2026-08-14T23:01:00Z')), // samedi 00:01 local
    match('d3-noon', Date.parse('2026-08-15T12:00:00Z')), // samedi 13:00 local (J+2)
    match('d3-next-midnight', Date.parse('2026-08-15T23:30:00Z')), // dimanche 00:30 local (J+3)
    match('d7-noon', Date.parse('2026-08-19T10:00:00Z')), // mercredi 19/08 11:00 local (J+6)
    match('d7-next-midnight', Date.parse('2026-08-19T23:30:00Z')), // jeudi 20/08 00:30 local
    match('no-timestamp', null),
  ]

  it('AUJOURD_HUI : uniquement le jour 13/08 (local)', () => {
    const res = filterMatchesInWindow(ALL, 'Today', NOW, TZ)
    expect(ids(res)).toEqual(['no-timestamp', 'today-edge-end', 'today-noon'])
  })

  it('DEMAIN : uniquement le jour 14/08 (local), y compris le 13/08 à 23:01Z (00:01 local)', () => {
    const res = filterMatchesInWindow(ALL, 'Tomorrow', NOW, TZ)
    expect(ids(res)).toEqual(['today-plus1h', 'tomorrow-eve'])
  })

  it('3 JOURS : 13/08 → 15/08 inclus (3 jours), pas le 16', () => {
    const res = filterMatchesInWindow(ALL, 'Next 3 Days', NOW, TZ)
    expect(ids(res)).toEqual([
      'd3-noon',
      'no-timestamp',
      'today-edge-end',
      'today-noon',
      'today-plus1h',
      'tomorrow-eve',
      'tomorrow-plus1h',
    ])
  })

  it('7 JOURS : 13/08 → 19/08 inclus (7 jours), pas le 20', () => {
    const res = filterMatchesInWindow(ALL, 'Next 7 Days', NOW, TZ)
    expect(ids(res)).toEqual([
      'd3-next-midnight',
      'd3-noon',
      'd7-noon',
      'no-timestamp',
      'today-edge-end',
      'today-noon',
      'today-plus1h',
      'tomorrow-eve',
      'tomorrow-plus1h',
    ])
  })

  it('le match sans timestamp est traité comme "maintenant" (visible en Today, pas en Demain)', () => {
    const res = filterMatchesInWindow(ALL, 'Tomorrow', NOW, TZ)
    expect(ids(res)).not.toContain('no-timestamp')
  })

  it('filtre inconnu ou absent => aucun filtrage', () => {
    expect(filterMatchesInWindow(ALL, null, NOW, TZ).length).toBe(ALL.length)
    expect(filterMatchesInWindow(ALL, 'unknown', NOW, TZ).length).toBe(ALL.length)
  })
})
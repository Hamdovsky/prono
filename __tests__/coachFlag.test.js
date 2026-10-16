/**
 * E119 phase 2 — flag "nouveau coach" (informatif, pas un boost : le bounce
 * n'est pas mesurable sur la fenetre actuelle, cf. journal).
 */
const { getCoachInfo, isNewCoach, daysSince, slugForTeamName, coachNewForMatch } = require('../core/coachFlag')

describe('coachFlag (E119 phase 2)', () => {
  const NOW = Date.parse('2026-10-16T00:00:00Z')

  it('isNewCoach dans la fenetre, pas au-dela', () => {
    expect(isNewCoach('2026-09-01', NOW, 90)).toBe(true)
    expect(isNewCoach('2026-07-01', NOW, 90)).toBe(false)
    expect(isNewCoach('2026-07-18', NOW, 90)).toBe(true)
    expect(isNewCoach(null, NOW)).toBe(false)
    expect(isNewCoach('nonsense', NOW)).toBe(false)
    expect(isNewCoach('2026-12-01', NOW)).toBe(false) // futur
  })

  it('daysSince compte en jours', () => {
    expect(daysSince('2026-10-16', NOW)).toBe(0)
    expect(daysSince('2026-10-01', NOW)).toBe(15)
    expect(daysSince(null, NOW)).toBeNull()
  })

  it('getCoachInfo lit le coach actuel (db memoire)', () => {
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.exec(
      'CREATE TABLE coach_history (team_slug TEXT, manager TEXT, appointed TEXT, ended TEXT, checked_at BIGINT)'
    )
    db.prepare(
      'INSERT INTO coach_history VALUES (?, ?, ?, ?, ?)'
    ).run('raja-casablanca', 'Fadlu Davids', '2026-08-05', null, 1)
    const info = getCoachInfo(db, 'raja-casablanca', NOW)
    expect(info).toMatchObject({ manager: 'Fadlu Davids', appointed: '2026-08-05' })
    expect(info.daysSince).toBe(72)
    expect(info.isNew).toBe(true)
    const missing = getCoachInfo(db, 'inconnu', NOW)
    expect(missing).toMatchObject({ manager: null, isNew: false })
  })

  it('slugForTeamName mappe les variantes', () => {
    expect(slugForTeamName('Raja Casablanca')).toBe('raja-casablanca')
    expect(slugForTeamName('Mamelodi Sundowns FC')).toBe('mamelodi-sundowns-fc')
    expect(slugForTeamName('El Zamalek')).toBe('zamalek-sc')
    expect(slugForTeamName('MC Alger')).toBe('mc-algier')
    expect(slugForTeamName('Paris SG')).toBe('paris-saint-germain')
    expect(slugForTeamName('Equipe Inconnue XYZ')).toBeNull()
    expect(slugForTeamName('')).toBeNull()
  })

  it('coachNewForMatch detecte un cote nouveau coach', () => {
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.exec(
      'CREATE TABLE coach_history (team_slug TEXT, manager TEXT, appointed TEXT, ended TEXT, checked_at BIGINT)'
    )
    db.prepare('INSERT INTO coach_history VALUES (?, ?, ?, ?, ?)').run(
      'raja-casablanca', 'Fadlu Davids', '2026-08-05', null, 1
    )
    const hit = coachNewForMatch(db, 'Raja Casablanca', 'Wydad Casablanca', NOW)
    expect(hit.isNew).toBe(true)
    expect(hit.side).toBe('home')
    const miss = coachNewForMatch(db, 'Wydad Casablanca', 'FAR Rabat', NOW)
    expect(miss.isNew).toBe(false)
  })
})

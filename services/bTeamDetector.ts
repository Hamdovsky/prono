// @ts-nocheck
import logger from '../core/logger'

class BTeamDetector {
  constructor() {
    this.KNOWN_B_TEAM_RISKS = {
      france: { risk: 'high', reason: 'France qualifiée (6pts), B team probable' },
      allemagne: { risk: 'high', reason: 'Allemagne qualifiée (6pts, +7), B team probable' },
      germany: { risk: 'high', reason: 'Germany qualified (6pts, +7), B team likely' },
      'pays-bas': { risk: 'medium', reason: 'Pays-Bas qualifiés, turn-over possible' },
      netherlands: { risk: 'medium', reason: 'Netherlands qualified, rest possible' },
      usa: { risk: 'medium', reason: 'USA qualifié (6pts), turn-over possible' },
      'etats-unis': { risk: 'medium', reason: 'USA qualifié (6pts), turn-over possible' },
      espagne: { risk: 'medium', reason: 'Espagne qualifiée avec nul, peut gérer' },
      spain: { risk: 'medium', reason: 'Spain qualified, can rotate' },
      japon: { risk: 'medium', reason: 'Japon qualifié, enjeu 1ère place discutable' },
      japan: { risk: 'medium', reason: 'Japan qualified, may rotate' },
    }
    this.KNOWN_A_TEAM_LOCKS = {
      belgique: { risk: 'none', reason: 'Belgique DOIT gagner (2pts)' },
      belgium: { risk: 'none', reason: 'Belgium MUST win (2pts)' },
      iran: { risk: 'none', reason: 'Iran DOIT gagner (2pts)' },
      uruguay: { risk: 'none', reason: 'Uruguay DOIT gagner (2pts)' },
      equateur: { risk: 'none', reason: 'Équateur DOIT gagner pour espérer' },
      ecuador: { risk: 'none', reason: 'Ecuador MUST win to hope' },
      paraguay: { risk: 'none', reason: 'Paraguay gagnant qualifié (3pts)' },
      suede: { risk: 'none', reason: 'Suède DOIT gagner (3pts)' },
      sweden: { risk: 'none', reason: 'Sweden MUST win (3pts)' },
      'cap vert': { risk: 'low', reason: 'Cap Vert en course, équipe A probable' },
      'nouvelle-zelande': { risk: 'none', reason: 'NZ peut encore se qualifier' },
      'new zealand': { risk: 'none', reason: 'NZ can still qualify' },
    }
    this.SERIE_B_BRAZIL = [
      'cuiaba',
      'londrina',
      'novorizontino',
      'vila nova',
      'america mg',
      'botafogo sp',
      'chapecoense',
      'coritiba',
      'crb',
      'criciuma',
      'figueirense',
      'goias',
      'guarani',
      'ituano',
      'mirassol',
      'operario',
      'pontc preta',
      'sampaio correa',
      'sport recife',
      'tombense',
      'abc',
      'avai',
      'ceara',
      'juventude',
    ]
  }

  normalizeName(name) {
    return (name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .join(' ')
  }

  detect(name, context = {}) {
    const norm = this.normalizeName(name)
    if (!norm) return { risk: 'unknown', isBTeam: false, reason: '', confidence: 0 }

    if (context.isDeadRubber && !context.isHighPressure) {
      return {
        risk: 'medium',
        isBTeam: false,
        reason: 'Dead rubber: motivation zero',
        confidence: 60,
      }
    }

    for (const [key, val] of Object.entries(this.KNOWN_A_TEAM_LOCKS)) {
      if (norm.includes(key) || key.includes(norm)) {
        return { risk: 'none', isBTeam: false, reason: val.reason, confidence: 90 }
      }
    }

    for (const [key, val] of Object.entries(this.KNOWN_B_TEAM_RISKS)) {
      if (norm.includes(key) || key.includes(norm)) {
        return {
          risk: val.risk,
          isBTeam: val.risk === 'high',
          reason: val.reason,
          confidence: val.risk === 'high' ? 85 : 60,
        }
      }
    }

    const isSerieB = this.SERIE_B_BRAZIL.some((s) => norm.includes(s) || s.includes(norm))
    if (isSerieB && context.side === 'home') {
      return { risk: 'low', isBTeam: false, reason: 'Série B turn-over possible', confidence: 40 }
    }

    if (context.isHighPressure) {
      return {
        risk: 'none',
        isBTeam: false,
        reason: 'Match survie, équipe A attendue',
        confidence: 75,
      }
    }

    return { risk: 'unknown', isBTeam: false, reason: '', confidence: 0 }
  }

  detectMatch(home, away, context = {}) {
    return {
      home: this.detect(home, { ...context, side: 'home' }),
      away: this.detect(away, { ...context, side: 'away' }),
    }
  }

  getCrowdPick(p1, p2) {
    if (!p1 || !p2) return 'X'
    if (p1 > p2) return '1'
    if (p2 > p1) return '2'
    return 'X'
  }

  isContrarian(p1, px, p2, crowdFav) {
    const best = p1 > 0.45 ? '1' : p2 > 0.4 ? '2' : px > 0.35 ? 'X' : p1 > p2 ? '1' : '2'
    return { isContrarian: crowdFav !== best, realFav: best }
  }
}

export = new BTeamDetector()

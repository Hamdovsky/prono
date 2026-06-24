const logger = require('../core/logger')

class BTeamDetector {
  constructor() {
    this.KNOWN_B_TEAM_RISKS = {
      'france': { risk: 'high', reason: 'Qualifiée (6pts), B team probable' },
      'allemagne': { risk: 'high', reason: 'Qualifiée (6pts), B team probable' },
      'germany': { risk: 'high', reason: 'Qualified (6pts), B team likely' },
      'usa': { risk: 'medium', reason: 'Qualifié (6pts), turn-over possible' },
      'espagne': { risk: 'medium', reason: 'Qualifiée avec nul, peut gérer' },
      'spain': { risk: 'medium', reason: 'Qualified, can rotate' },
      'pays-bas': { risk: 'medium', reason: 'Qualifié avec nul, turn-over possible' },
      'netherlands': { risk: 'medium', reason: 'Qualified with draw, rest possible' },
      'japon': { risk: 'low', reason: 'Qualifié mais enjeu 1ère place' },
      'japan': { risk: 'low', reason: 'Qualified but can top group' },
    }
    this.KNOWN_A_TEAM_LOCKS = {
      'belgique': { reason: 'DOIT gagner (2pts), équipe A assurée' },
      'belgium': { reason: 'MUST win (2pts), full strength' },
      'iran': { reason: 'DOIT gagner (2pts), équipe A assurée' },
      'uruguay': { reason: 'DOIT gagner (2pts), équipe A assurée' },
      'equateur': { reason: 'DOIT gagner pour espérer, équipe A' },
      'ecuador': { reason: 'MUST win, full strength' },
      'paraguay': { reason: 'Gagnant qualifié (3pts), équipe A' },
      'paraguay': { reason: 'Winner qualifies (3pts), full strength' },
    }
  }

  normalizeName(name) {
    return (name || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 1)
      .join(' ')
  }

  detect(name, context = {}) {
    const norm = this.normalizeName(name)
    if (!norm) return { risk: 'unknown', isBTeam: false, reason: '' }

    for (const [key, val] of Object.entries(this.KNOWN_A_TEAM_LOCKS)) {
      if (norm.includes(key) || key.includes(norm)) {
        return { risk: 'none', isBTeam: false, reason: val.reason, confidence: 90 }
      }
    }

    for (const [key, val] of Object.entries(this.KNOWN_B_TEAM_RISKS)) {
      if (norm.includes(key) || key.includes(norm)) {
        const isBTeam = val.risk === 'high'
        return {
          risk: val.risk,
          isBTeam,
          reason: val.reason,
          confidence: val.risk === 'high' ? 80 : 60
        }
      }
    }

    if (context.isDeadRubber) {
      return { risk: 'medium', isBTeam: false, reason: 'Dead rubber, motivation incertaine', confidence: 40 }
    }
    if (context.isHighPressure) {
      return { risk: 'none', isBTeam: false, reason: 'Match sous pression, équipe A probable', confidence: 70 }
    }

    return { risk: 'unknown', isBTeam: false, reason: '', confidence: 0 }
  }

  detectMatch(home, away, context = {}) {
    return {
      home: this.detect(home, { ...context, side: 'home' }),
      away: this.detect(away, { ...context, side: 'away' }),
    }
  }
}

module.exports = new BTeamDetector()

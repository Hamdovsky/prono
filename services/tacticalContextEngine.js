const logger = require('../core/logger')

class TacticalContextEngine {
  constructor() {
    this.WORLD_CUP_GROUPS = {
      d: [
        { name: 'usa', pts: 6, gd: 4, status: 'Qualifié (1er)' },
        { name: 'paraguay', pts: 3, gd: 1, status: 'Gagnant qualifié' },
        { name: 'australie', pts: 3, gd: 0, status: 'Gagnant qualifié' },
        { name: 'turquie', pts: 0, gd: -5, status: 'Eliminé' },
      ],
      e: [
        { name: 'allemagne', pts: 6, gd: 7, status: 'Qualifié (1er)' },
        { name: 'equateur', pts: 1, gd: -2, status: 'Doit gagner + espérer' },
      ],
      f: [
        { name: 'japon', pts: 4, gd: 2, status: 'Qualifié avec nul' },
        { name: 'pays bas', pts: 4, gd: 1, status: 'Qualifié avec nul' },
        { name: 'suede', pts: 3, gd: -1, status: 'Doit gagner' },
        { name: 'tunisie', pts: 0, gd: -4, status: 'Eliminé' },
      ],
      g: [
        { name: 'egypte', pts: 4, gd: 1, status: 'Qualifié avec nul' },
        { name: 'belgique', pts: 2, gd: 0, status: 'Doit gagner (2pts)' },
        { name: 'iran', pts: 2, gd: -1, status: 'Doit gagner (2pts)' },
        { name: 'nouvelle zelande', pts: 1, gd: -2, status: 'Peut encore croire' },
      ],
      h: [
        { name: 'espagne', pts: 4, gd: 3, status: 'Qualifié avec nul' },
        { name: 'cap vert', pts: 3, gd: 0, status: 'Peut se qualifier' },
        { name: 'arabie', pts: 3, gd: -1, status: 'Peut se qualifier' },
        { name: 'uruguay', pts: 2, gd: -1, status: 'Doit gagner (2pts)' },
      ],
      i: [
        { name: 'france', pts: 6, gd: 4, status: 'Qualifié' },
        { name: 'norvege', pts: 6, gd: 3, status: 'Qualifié' },
        { name: 'senegal', pts: 0, gd: -4, status: 'Eliminé' },
        { name: 'irak', pts: 0, gd: -5, status: 'Eliminé' },
      ],
    }
    this.SERIE_B_2026 = {
      cuiaba: { homeDrawRate: 44, note: '44% de nuls à domicile en Série B' },
      londrina: { awayWinRate: 22, note: "Faible à l'extérieur" },
      novorizontino: { homeWinRate: 40, note: 'Irégulier à domicile' },
      'vila nova': { awayDrawRate: 100, note: "100% de nuls à l'extérieur (3/3)" },
    }
    this.SPECIAL_PATTERNS = [
      {
        home: 'cuiaba',
        away: 'londrina',
        pattern: 'Cuiabá favori mais 44% nuls home',
        tip: '1X plus sûr que 1',
      },
      {
        home: 'novorizontino',
        away: 'vila nova',
        pattern: 'Vila Nova 100% nuls ext',
        tip: 'X2 parfait',
      },
      {
        home: 'norvege',
        away: 'france',
        pattern: 'Dead rubber, équipes B',
        tip: 'Nul probable, 1X',
      },
      {
        home: 'senegal',
        away: 'irak',
        pattern: 'Dead rubber total',
        tip: 'Méfiance, motivation 0',
      },
      {
        home: 'equateur',
        away: 'allemagne',
        pattern: 'Allemagne B team vs Équateur survie',
        tip: 'Surprise possible, 1X',
      },
      {
        home: 'uruguay',
        away: 'espagne',
        pattern: 'Uruguay survie vs Espagne safe',
        tip: 'Uruguay à domicile, 1X',
      },
      {
        home: 'egypte',
        away: 'iran',
        pattern: 'Iran doit gagner, Égypte safe',
        tip: 'Iran désespéré, X2',
      },
      {
        home: 'tunisie',
        away: 'pays bas',
        pattern: 'Tunisie éliminée, PB safe',
        tip: 'PB gagne mais B team possible',
      },
    ]
  }

  normalize(name) {
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

  findTeam(name) {
    const norm = this.normalize(name)
    for (const [group, teams] of Object.entries(this.WORLD_CUP_GROUPS)) {
      for (const t of teams) {
        const tNorm = this.normalize(t.name)
        if (norm.includes(tNorm) || tNorm.includes(norm)) {
          return { ...t, group: group.toUpperCase() }
        }
      }
    }
    return null
  }

  getOpponentContext(home, away) {
    const hInfo = this.findTeam(home)
    const aInfo = this.findTeam(away)
    if (!hInfo && !aInfo) return null

    const group = hInfo?.group || aInfo?.group
    return { home: hInfo, away: aInfo, group, isWorldCup: !!group }
  }

  getSpecialPattern(home, away) {
    const hNorm = this.normalize(home)
    const aNorm = this.normalize(away)
    return (
      this.SPECIAL_PATTERNS.find(
        (p) => (p.home === hNorm && p.away === aNorm) || (p.home === aNorm && p.away === hNorm)
      ) || null
    )
  }

  getSerieBInfo(name) {
    const norm = this.normalize(name)
    for (const [key, val] of Object.entries(this.SERIE_B_2026)) {
      if (norm.includes(key) || key.includes(norm)) return val
    }
    return null
  }

  assessBoldness(crowdFav, realFav, crowdProb, bTeamDetected, deadRubber) {
    let score = 0
    const reasons = []

    if (crowdFav !== realFav) {
      score += 2
      reasons.push(`Pick diffère du public (${crowdFav}→${realFav})`)
    }
    if (bTeamDetected) {
      score += 2
      reasons.push('B Team détectée')
    }
    if (deadRubber) {
      score += 1
      reasons.push('Dead rubber imprévisible')
    }
    const maxProb = Math.max(...Object.values(crowdProb))
    if (maxProb > 60 && crowdFav !== realFav) {
      score += 1
      reasons.push(`Favori >60% mais pick différent`)
    }

    const label = score >= 3 ? '🔥 BOLD' : score >= 2 ? '⚡ VALUE' : '✅ SAFE'
    return { score, label, reasons }
  }

  generateMatchIntel(home, away, p1, p2) {
    const ctx = this.getOpponentContext(home, away)
    const pattern = this.getSpecialPattern(home, away)
    const serieBHome = this.getSerieBInfo(home)
    const serieBAway = this.getSerieBInfo(away)

    const narrative = []

    if (ctx?.home && ctx?.away) {
      narrative.push(
        `📊 Groupe ${ctx.group} : ${ctx.home.name}=${ctx.home.pts}pts, ${ctx.away.name}=${ctx.away.pts}pts`
      )
      if (ctx.home.status.includes('Doit') && ctx.away.status.includes('Doit')) {
        narrative.push('⚔️ MORT SUBITE : Les deux équipes doivent gagner')
      } else if (ctx.home.status.includes('Doit')) {
        narrative.push(`💪 ${home} joue sa survie — motivation max`)
      } else if (ctx.away.status.includes('Doit')) {
        narrative.push(`💪 ${away} joue sa survie — motivation max`)
      }
      if (ctx.home.status.includes('Qualifié') && !ctx.home.status.includes('Doit')) {
        narrative.push(`🔄 ${home} peut gérer / faire tourner`)
      }
      if (ctx.away.status.includes('Qualifié') && !ctx.away.status.includes('Doit')) {
        narrative.push(`🔄 ${away} peut gérer / faire tourner`)
      }
      if (ctx.home.status.includes('Eliminé'))
        narrative.push(`❌ ${home} déjà éliminé, motivation ?`)
      if (ctx.away.status.includes('Eliminé'))
        narrative.push(`❌ ${away} déjà éliminé, motivation ?`)
      if (ctx.home.status === ctx.away.status && ctx.home.status.includes('Qualifié')) {
        narrative.push(`🤝 Dead rubber — match amical déguisé`)
      }
    }

    if (pattern) {
      narrative.push(`🔍 Pattern: ${pattern.pattern}`)
      narrative.push(`💡 Conseil: ${pattern.tip}`)
    }

    if (serieBHome) narrative.push(`🇧🇷 ${home}: ${serieBHome.note}`)
    if (serieBAway) narrative.push(`🇧🇷 ${away}: ${serieBAway.note}`)

    return {
      opponentContext: ctx,
      pattern: pattern?.pattern || null,
      tip: pattern?.tip || null,
      narrative: narrative.length > 0 ? narrative : ['Aucun contexte spécifique'],
      serieB: !!(serieBHome || serieBAway),
    }
  }

  generateSecretWeaponsEnriched(matches) {
    return matches.map((m, idx) => {
      const p1 = m.p1 || 0.33
      const px = m.px || 0.33
      const p2 = m.p2 || 0.34
      const crowdFav = p1 > p2 ? '1' : p2 > p1 ? '2' : 'X'
      const realFav = p1 > 0.45 ? '1' : p2 > 0.4 ? '2' : 'X'
      const isContrarian = crowdFav !== realFav
      const isDeadRubber = m.isDeadRubber || false
      const bTeamDetected = m.bTeamHome?.isBTeam || m.bTeamAway?.isBTeam || false

      const boldness = this.assessBoldness(
        crowdFav,
        realFav,
        { p1, px, p2 },
        bTeamDetected,
        isDeadRubber
      )
      const intel = this.generateMatchIntel(m.home, m.away, p1, p2)

      return { boldness, intel, isContrarian, realFav }
    })
  }
}

module.exports = new TacticalContextEngine()

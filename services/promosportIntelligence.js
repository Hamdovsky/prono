const expertEngine = require('./expertEngine');
const DeepFormService = require('./DeepFormService');
const LogisticsService = require('./LogisticsService');
const MotivationEnrichService = require('./MotivationEnrichService');
const SharpIntelligenceService = require('./SharpIntelligenceService');
const bTeamDetector = require('./bTeamDetector');
const promosportSurpriseService = require('./promosportSurpriseService');
const tacticalContextEngine = require('./tacticalContextEngine');
const probabilityCalibrator = require('./probabilityCalibrator');
const competitionAnalyzer = require('./competitionAnalyzer');
const crowdHackerService = require('./crowdHackerService');
const logger = require('../core/logger');

class PromosportIntelligence {
    constructor() {
        this.iterations = 50000
    }

    async optimizeGrid(matches, strategy = 'balanced') {
        logger.info(`[PROMOSPORT AI] Optimizing grid with strategy: ${strategy}`)
        const enrichedMatches = await Promise.all(matches.map(async (m) => {
            const intelligence = expertEngine.getMatchIntelligence(m)
            const form = await DeepFormService.getDeepForm(m.homeTeam, m.awayTeam)
            const logistics = LogisticsService.calculateFatigue(m.awayCity, m.homeCity, m.daysRestA || 4)
            const motivation = MotivationEnrichService.getMotivation(m)
            const sharp = SharpIntelligenceService.getSharpActivity(m.id)

            const p1 = intelligence.winProb / 100
            const px = intelligence.draw_probability / 100 || 0.3
            const p2 = (100 - intelligence.winProb - (px * 100)) / 100

            const H = - (p1 * Math.log2(p1 || 0.01) + px * Math.log2(px || 0.01) + p2 * Math.log2(p2 || 0.01))

            return { ...m, intelligence, form, logistics, motivation, sharp, entropy: H, p1, px, p2 }
        }))

        const sortedByEntropy = [...enrichedMatches].sort((a, b) => b.entropy - a.entropy)
        const doubleIndices = sortedByEntropy.slice(0, 5).map(m => m.id)

        return enrichedMatches.map(m => {
            const isDouble = doubleIndices.includes(m.id)
            let pred = ''
            if (strategy === 'value') {
                const edge = m.p1 > 0.4 ? '1' : (m.p2 > 0.4 ? '2' : 'X')
                pred = isDouble ? (m.p1 > m.p2 ? '1X' : 'X2') : edge
            } else if (strategy === 'secure') {
                const best = m.p1 > m.p2 ? (m.p1 > m.px ? '1' : 'X') : (m.p2 > m.px ? '2' : 'X')
                pred = isDouble ? (m.p1 > m.p2 ? '1X' : 'X2') : best
            } else {
                const best = m.p1 > 0.5 ? '1' : (m.p2 > 0.5 ? '2' : 'X')
                pred = isDouble ? (m.p1 > m.p2 ? '1X' : 'X2') : best
            }
            return { ...m, pred, isDouble, confidence: (Math.max(m.p1, m.px, m.p2) * 100).toFixed(1) }
        })
    }

    getConcoursCount() {
        return promosportSurpriseService.getConcoursCount()
    }

    async generateSecretWeapons(matches) {
        promosportSurpriseService.computeSurpriseRates()
        return matches.map((m, idx) => {
            const isDeadRubber = m.isHighPressure === false && (m.entropy || 1.5) < 1.3
            const isSurvival = m.isHighPressure === true
            const homeName = m.homeTeam || m.home || m.team1 || ''
            const awayName = m.awayTeam || m.away || m.team2 || ''

            const rotation = bTeamDetector.detectMatch(homeName, awayName, { isDeadRubber, isHighPressure: isSurvival })

            const p1 = m.p1 || m.homeWinProbability || 0.33
            const px = m.px || m.drawProbability || 0.33
            const p2 = m.p2 || m.awayWinProbability || 0.34
            
            const calibrated = probabilityCalibrator.calibrate(p1, px, p2)
            const p1Cal = calibrated.p1
            const pxCal = calibrated.px
            const p2Cal = calibrated.p2
            
            const crowdFav = p1 > p2 ? '1' : (p2 > p1 ? '2' : 'X')
            const realFav = p1Cal > 0.45 ? '1' : (p2Cal > 0.40 ? '2' : 'X')
            
            const competitionIntel = competitionAnalyzer.getMatchIntel(homeName, awayName, idx + 1, m.leagueName)
            const crowdSignal = crowdHackerService.getContrarianSignal(m)
            
            let crowdAnalysis = []
            if (crowdSignal) {
                crowdAnalysis.push(`Promosport: ${crowdSignal.promosportPick} (${crowdSignal.promosportAccuracy}%)`)
                if (crowdSignal.modelAdvantage > 0) {
                    crowdAnalysis.push(`🔥 Avantage modèle: +${crowdSignal.modelAdvantage}pts`)
                }
                if (crowdSignal.historicalEdge) {
                    crowdAnalysis.push(`📊 Contrariant: ${crowdSignal.modelVersusPromosport.disagreeAccuracy}% de réussite`)
                }
                if (crowdSignal.tunisianCrowd) {
                    const tc = crowdSignal.tunisianCrowd
                    if (tc.contrarianSignal) {
                        crowdAnalysis.push(tc.contrarianSignal.reason)
                    } else {
                        crowdAnalysis.push(`Foule: ${tc.crowdFav}@${tc.favPct}% (${tc.crowdAccuracy}% fiable)`)
                    }
                }
            }
            
            if (competitionIntel.analysis.length > 0) {
                crowdAnalysis.push(...competitionIntel.analysis)
            }

            const homeSurprise = promosportSurpriseService.getSurpriseStats(homeName)
            const awaySurprise = promosportSurpriseService.getSurpriseStats(awayName)

            const contextIntel = tacticalContextEngine.generateMatchIntel(homeName, awayName, p1, p2)
            const boldness = tacticalContextEngine.assessBoldness(
                crowdFav, realFav, { p1, px, p2 },
                rotation.home.isBTeam || rotation.away.isBTeam,
                isDeadRubber
            )

            const weaponParts = []
            if (crowdAnalysis.length > 0) {
                weaponParts.push(`👥 CROWD: ${crowdAnalysis.join(' | ')}`)
            }
            if (rotation.home.isBTeam || rotation.away.isBTeam) {
                weaponParts.push(`🔴 B TEAM`)
                if (rotation.home.isBTeam) weaponParts.push(`${homeName}: ${rotation.home.reason}`)
                if (rotation.away.isBTeam) weaponParts.push(`${awayName}: ${rotation.away.reason}`)
            }

            const ocCtx = contextIntel.opponentContext
            if (ocCtx && ocCtx.home && ocCtx.away) {
                if (ocCtx.home.status === ocCtx.away.status) {
                    const s = ocCtx.home.status
                    if (s.includes('Qualifié')) weaponParts.push('🤝 Dead rubber, match amical')
                    else if (s.includes('Doit')) weaponParts.push('⚔️ MORT SUBITE : les deux doivent gagner')
                    else weaponParts.push(`⚠️ ${s}`)
                } else if (ocCtx.home.status?.includes('Doit')) {
                    weaponParts.push(`💪 SURVIE: ${homeName} doit gagner`)
                } else if (ocCtx.away.status?.includes('Doit')) {
                    weaponParts.push(`💪 SURVIE: ${awayName} doit gagner`)
                } else if (ocCtx.home.status?.includes('Eliminé')) {
                    weaponParts.push(`❌ ${homeName} éliminé, motivation?`)
                } else if (ocCtx.away.status?.includes('Eliminé')) {
                    weaponParts.push(`❌ ${awayName} éliminé, motivation?`)
                }
            }

            if (crowdFav !== realFav) {
                weaponParts.push(`🎯 Contrarian: foule→${crowdFav}, nous→${realFav}`)
            }

            if (contextIntel.pattern) {
                weaponParts.push(`📊 ${contextIntel.pattern}`)
            }
            if (contextIntel.tip) {
                weaponParts.push(`💡 ${contextIntel.tip}`)
            }

            return {
                id: idx + 1,
                home: homeName,
                away: awayName,
                p1: +(p1 * 100).toFixed(0),
                px: +(px * 100).toFixed(0),
                p2: +(p2 * 100).toFixed(0),
                p1Cal: +(p1Cal * 100).toFixed(0),
                pxCal: +(pxCal * 100).toFixed(0),
                p2Cal: +(p2Cal * 100).toFixed(0),
                crowdFav,
                realFav,
                isContrarian: crowdFav !== realFav,
                isDeadRubber,
                isSurvival,
                bTeamHome: rotation.home,
                bTeamAway: rotation.away,
                homeSurprise,
                awaySurprise,
                secretWeapon: weaponParts.join(' | ') || 'PICK CONFORME',
                boldness,
                narrative: contextIntel.narrative,
                tip: contextIntel.tip,
                crowdAnalysis,
                competitionIntel: competitionIntel.indexIntel,
                tunisianCrowd: crowdSignal?.tunisianCrowd || null,
            }
        })
    }
}

module.exports = new PromosportIntelligence()

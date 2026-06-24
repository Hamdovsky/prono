const expertEngine = require('./expertEngine');
const DeepFormService = require('./DeepFormService');
const LogisticsService = require('./LogisticsService');
const MotivationEnrichService = require('./MotivationEnrichService');
const SharpIntelligenceService = require('./SharpIntelligenceService');
const bTeamDetector = require('./bTeamDetector');
const promosportSurpriseService = require('./promosportSurpriseService');
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

    async generateSecretWeapons(matches) {
        promosportSurpriseService.computeSurpriseRates()
        return matches.map((m, idx) => {
            const isDeadRubber = m.isHighPressure === false && (m.entropy || 1.5) < 1.3
            const isSurvival = m.isHighPressure === true
            const rotation = bTeamDetector.detectMatch(m.homeTeam, m.awayTeam, { isDeadRubber, isHighPressure: isSurvival })

            const p1 = m.p1 || m.homeWinProbability || 0.33
            const px = m.px || m.drawProbability || 0.33
            const p2 = m.p2 || m.awayWinProbability || 0.34
            const crowdFav = p1 > p2 ? '1' : (p2 > p1 ? '2' : 'X')
            const realFav = p1 > 0.45 ? '1' : (p2 > 0.40 ? '2' : 'X')
            const isContrarian = crowdFav !== realFav

            const homeSurprise = promosportSurpriseService.getSurpriseStats(m.homeTeam)
            const awaySurprise = promosportSurpriseService.getSurpriseStats(m.awayTeam)

            let weaponReason = ''
            if (rotation.home.isBTeam || rotation.away.isBTeam) {
                weaponReason = `B TEAM : ${rotation.home.isBTeam ? m.homeTeam + ' ' + rotation.home.reason : ''}${rotation.home.isBTeam && rotation.away.isBTeam ? ' | ' : ''}${rotation.away.isBTeam ? m.awayTeam + ' ' + rotation.away.reason : ''}`
            } else if (isContrarian) {
                weaponReason = `CONTRARIAN : La foule voit ${crowdFav === '1' ? m.homeTeam : (crowdFav === '2' ? m.awayTeam : 'Nul')} mais le modèle Titanium voit ${realFav === '1' ? m.homeTeam : (realFav === '2' ? m.awayTeam : 'Nul')}`
            } else if (isDeadRubber) {
                weaponReason = 'DEAD RUBBER : Match sans enjeu, méfiance'
            } else if (isSurvival) {
                weaponReason = 'SURVIE : Équipe sous pression, motivation max'
            } else if (rotation.home.risk !== 'unknown' || rotation.away.risk !== 'unknown') {
                weaponReason = `${rotation.home.reason}${rotation.home.reason && rotation.away.reason ? ' | ' : ''}${rotation.away.reason}`
            } else {
                weaponReason = 'PICK CONFORME'
            }

            return {
                id: idx + 1,
                home: m.homeTeam,
                away: m.awayTeam,
                p1: +(p1 * 100).toFixed(0),
                px: +(px * 100).toFixed(0),
                p2: +(p2 * 100).toFixed(0),
                crowdFav,
                realFav,
                isContrarian,
                isDeadRubber,
                isSurvival,
                bTeamHome: rotation.home,
                bTeamAway: rotation.away,
                homeSurprise,
                awaySurprise,
                secretWeapon: weaponReason,
            }
        })
    }
}

module.exports = new PromosportIntelligence()

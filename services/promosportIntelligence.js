const fs = require('fs')
const path = require('path')
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
const deepSeekService = require('./DeepSeekService');
const logger = require('../core/logger');

class PromosportIntelligence {
    constructor() {
        this.iterations = 50000
    }

    calculateModelEdge(p1Cal, pxCal, p2Cal, p1, px, p2) {
        const edge1 = +(p1Cal - p1).toFixed(3)
        const edgeX = +(pxCal - px).toFixed(3)
        const edge2 = +(p2Cal - p2).toFixed(3)

        const calPicks = [
            { v: '1', p: p1Cal, edge: edge1 },
            { v: 'X', p: pxCal, edge: edgeX },
            { v: '2', p: p2Cal, edge: edge2 },
        ]
        calPicks.sort((a, b) => b.p - a.p)
        const best = calPicks[0]

        const crowdPicks = [
            { v: '1', p: p1 },
            { v: 'X', p: px },
            { v: '2', p: p2 },
        ]
        crowdPicks.sort((a, b) => b.p - a.p)
        const crowdBest = crowdPicks[0]

        return {
            edge1,
            edgeX,
            edge2,
            maxEdge: best.edge,
            bestPick: best.v,
            bestProb: best.p,
            crowdFavProb: crowdBest.p,
            edgeOverCrowd: +(best.p - crowdBest.p).toFixed(3),
        }
    }

    calculateContrarianStrength(p1, px, p2, p1Cal, pxCal, p2Cal) {
        const crowdFavIdx = p1 > p2 ? (p1 > px ? 0 : 1) : (p2 > px ? 2 : 1)
        const calFavIdx = p1Cal > p2Cal ? (p1Cal > pxCal ? 0 : 1) : (p2Cal > pxCal ? 2 : 1)

        const crowdProbs = [p1, px, p2]
        const calProbs = [p1Cal, pxCal, p2Cal]

        if (crowdFavIdx === calFavIdx) {
            const agreement = crowdProbs[crowdFavIdx]
            return {
                score: +(1 - agreement).toFixed(3),
                label: agreement > 0.55 ? '⚠️ Conforme mais Risqué' : (agreement > 0.45 ? '✅ Conforme' : '🟡 Leger désaccord'),
                isContrarian: false,
                divergence: 0,
            }
        }

        const divergence = Math.abs(crowdProbs[crowdFavIdx] - calProbs[calFavIdx])
        return {
            score: +Math.min(1, divergence * 1.5).toFixed(3),
            label: divergence > 0.20 ? '🔥 CONTRARIAN FORT' : (divergence > 0.10 ? '⚡ Contrarian Modéré' : '🔵 Léger Contrarian'),
            isContrarian: true,
            divergence: +divergence.toFixed(3),
        }
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
        const weapons = matches.map((m, idx) => {
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

            const edge = this.calculateModelEdge(p1Cal, pxCal, p2Cal, p1, px, p2)
            const contrarianStrength = this.calculateContrarianStrength(p1, px, p2, p1Cal, pxCal, p2Cal)
            
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

            if (contrarianStrength.isContrarian) {
                weaponParts.push(`🎯 Contrarian: foule→${crowdFav}, nous→${realFav} (${contrarianStrength.label})`)
            }

            if (edge.maxEdge > 0.02) {
                const pct = (edge.maxEdge * 100).toFixed(1)
                weaponParts.push(`📊 Edge: ${edge.bestPick} (modèle ${pct}pts > foule)`)
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
                isContrarian: contrarianStrength.isContrarian,
                contrarianStrength,
                edge,
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

        const gridHints = this.getGridOptimizationHints(matches, weapons)

        return { weapons, gridHints }
    }

    getGridOptimizationHints(matches, weapons) {
        const sortedByEdge = [...weapons].sort((a, b) => b.edge.maxEdge - a.edge.maxEdge)
        const bestEdge = sortedByEdge.slice(0, 5).map(w => w.id)

        const sortedByContrarian = [...weapons].sort((a, b) => b.contrarianStrength.score - a.contrarianStrength.score)
        const bestContrarian = sortedByContrarian.filter(w => w.contrarianStrength.isContrarian).slice(0, 5).map(w => w.id)

        const sortedByEntropy = [...weapons].sort((a, b) => {
            const eA = matches.find(m => (m.homeTeam || m.home) === a.home)?.entropy || 0
            const eB = matches.find(m => (m.homeTeam || m.home) === b.home)?.entropy || 0
            return eB - eA
        })
        const doubleCandidates = sortedByEntropy.slice(0, 5).map(w => ({
            id: w.id,
            match: `${w.home} vs ${w.away}`,
            reason: w.bTeamHome?.isBTeam || w.bTeamAway?.isBTeam ? 'B-Team incertaine' : (w.isDeadRubber ? 'Dead rubber' : 'Entropie élevée (incertain)'),
        }))

        const safePicks = weapons.filter(w => !w.isContrarian && !w.bTeamHome?.isBTeam && !w.bTeamAway?.isBTeam && !w.isDeadRubber)
            .sort((a, b) => Math.max(a.p1Cal, a.pxCal, a.p2Cal) - Math.max(b.p1Cal, b.pxCal, b.p2Cal))
            .reverse()
            .slice(0, 5)
            .map(w => ({ id: w.id, match: `${w.home} vs ${w.away}` }))

        return {
            doubleCandidates,
            bestContrarian: bestContrarian.map(id => ({ id, match: weapons.find(w => w.id === id) ? `${weapons.find(w => w.id === id).home} vs ${weapons.find(w => w.id === id).away}` : '' })),
            bestEdge: bestEdge.map(id => ({ id, match: weapons.find(w => w.id === id) ? `${weapons.find(w => w.id === id).home} vs ${weapons.find(w => w.id === id).away}` : '' })),
            safePicks,
            totalContrarian: weapons.filter(w => w.contrarianStrength.isContrarian).length,
            avgEdge: +(weapons.reduce((s, w) => s + w.edge.maxEdge, 0) / weapons.length).toFixed(3),
        }
    }

    _getLLMCacheKey(matches) {
        const concours = matches[0]?.concoursNumber || matches[0]?.grid || 'unknown'
        const date = matches[0]?.concoursDate || new Date().toISOString().slice(0, 10)
        const hash = require('crypto').createHash('md5').update(`${concours}-${date}`).digest('hex').slice(0, 8)
        return { key: `llm_weapons_${concours}_${hash}`, concours, date }
    }

    _readLLMCache(key) {
        try {
            const cachePath = path.join(__dirname, '..', 'data', `${key}.json`)
            if (!fs.existsSync(cachePath)) return null
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
            if (cached.ttl && Date.now() > cached.ttl) {
                fs.unlinkSync(cachePath)
                return null
            }
            logger.info(`[PROMOSPORT LLM] Cache HIT: ${key}`)
            return cached.data
        } catch (e) {
            return null
        }
    }

    _writeLLMCache(key, data) {
        try {
            const cachePath = path.join(__dirname, '..', 'data', `${key}.json`)
            fs.writeFileSync(cachePath, JSON.stringify({
                data,
                ttl: Date.now() + 86400000,
                created: new Date().toISOString(),
            }, null, 2))
            logger.info(`[PROMOSPORT LLM] Cache WRITE: ${key}`)
        } catch (e) {
            logger.warn(`[PROMOSPORT LLM] Cache write failed: ${e.message}`)
        }
    }

    async generateLLMSecretWeapons(matches) {
        const { key, concours } = this._getLLMCacheKey(matches)

        const cached = this._readLLMCache(key)
        if (cached) return cached

        if (!deepSeekService.isQuotaAvailable()) {
            logger.info('[PROMOSPORT LLM] Quota épuisé, skip LLM enhancement')
            return null
        }

        const matchData = matches.map((m, idx) => {
            const homeName = m.homeTeam || m.home || m.team1 || ''
            const awayName = m.awayTeam || m.away || m.team2 || ''
            const p1 = m.p1 || m.homeWinProbability || 0.33
            const p2 = m.p2 || m.awayWinProbability || 0.34
            const crowdFav = p1 > p2 ? '1' : (p2 > p1 ? '2' : 'X')
            const rotation = bTeamDetector.detectMatch(homeName, awayName, {})
            const homeStats = promosportSurpriseService.getSurpriseStats(homeName)
            const awayStats = promosportSurpriseService.getSurpriseStats(awayName)

            return {
                id: idx + 1,
                home: homeName,
                away: awayName,
                probs: `${+(p1*100).toFixed(0)}/${+(m.px || m.drawProbability || 0.33)*100}${+(p2*100).toFixed(0)}`,
                league: m.leagueName || m.tournament_name || 'Inconnu',
                crowdFav,
                bTeam: rotation.home.isBTeam || rotation.away.isBTeam ? `B-Team: ${rotation.home.reason || ''} ${rotation.away.reason || ''}`.trim() : null,
                homeHisto: homeStats.team ? `${homeStats.team.homeWinRate}%V ${homeStats.team.homeDrawRate}%N ${homeStats.team.homeLossRate}%D` : null,
                awayHisto: awayStats.team ? `${awayStats.team.awayWinRate}%V ${awayStats.team.awayDrawRate}%N ${awayStats.team.awayLossRate}%D` : null,
            }
        })

        const crowdProfile = crowdHackerService.promosportBiasProfile || {}
        const contrarianHitRate = crowdProfile.contrarianHitRate || 0
        const crowdAccuracy = crowdProfile.promosportOverallAccuracy || 0

        const systemPrompt = `Tu es l'analyste tactique en chef de Titanium AI, expert en pronostics Promosport. Tu analyses des grilles de 13 matchs et tu identifies LE facteur clé de chaque match. Sois concis, percutant, direct.`

        const userPrompt = `CONCOURS PROMOSPORT N°${concours}
CONTEXTE GLOBAL:
- Précision historique de la foule Promosport: ${crowdAccuracy}%
- Taux de réussite des picks contrarian: ${contrarianHitRate}%
- La foule a tort dans ${(100-crowdAccuracy).toFixed(0)}% des cas quand elle est confiante >50%

Matchs à analyser:
${JSON.stringify(matchData, null, 2)}

Pour CHACUN des ${matchData.length} matchs, retourne:
1. "secretWeapon": UNE phrase clé (max 120 caractères) qui révèle le facteur décisif
2. "confidence": 0-100 (ta confiance dans ce facteur)
3. "risk": "high" | "medium" | "low" (risque que ce soit un piège)

Format JSON obligatoire:
{
  "analyses": [
    { "id": 1, "secretWeapon": "...", "confidence": 85, "risk": "low" },
    ...
  ]
}

RÈGLES STRICTES:
- 120 caractères MAX par secretWeapon
- Facteur DIFFÉRENT pour chaque match (ne te répète pas)
- Explique POURQUOI ce facteur est décisif
- Utilise les données fournies (B-Team, historique, etc.)
- En français uniquement
- EXEMPLE: "Milan sans 3 titulaires en défense, Leao incertain → avantage Inter"
- EXEMPLE: "Foule à 68% sur 1 mais l'équipe a déjà validé son billet → B-team probable"
- EXEMPLE: "Paris doit gagner à tout prix (2ème, 1pt du leader) → pression maximale"`

        const result = await deepSeekService._queryDeepSeek(systemPrompt, userPrompt)
        if (!result || !result.analyses) {
            logger.warn('[PROMOSPORT LLM] LLM returned invalid data')
            return null
        }

        this._writeLLMCache(key, result.analyses)

        try {
            const socketService = require('./socketService')
            socketService.broadcast('promosport_llm_ready', {
                concours,
                count: result.analyses.length,
                timestamp: new Date().toISOString(),
            })
        } catch (e) {}

        return result.analyses
    }
}

module.exports = new PromosportIntelligence()

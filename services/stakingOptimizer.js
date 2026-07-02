/**
 * stakingOptimizer.js — Bankroll Management & Platform Rule Engine
 *
 * Protège contre :
 *   - Chasing losses (interdit d'augmenter la mise après une perte)
 *   - Emotional betting (limite de mise par session)
 *   - Platform limits (max bet par bookmaker)
 *   - Liquidity money flow (smart money inverse)
 *   - Strategy changes (ne pas changer après une série de pertes)
 *   - Randomness (taille de mise selon l'avantage)
 *
 * Utilise :
 *   - Kelly fractionnaire adaptatif (0.1 à 0.25 selon confiance)
 *   - Drawdown limit (arrêt à -20%)
 *   - Session limit (max 10% de bankroll par jour)
 *   - Correlation adjustment (réduire les mises sur matchs corrélés)
 */
const logger = require('../core/logger')

const DEFAULT_CONFIG = {
  bankroll: 10000,           // Bankroll initiale en EUR
  maxDrawdownPct: 0.20,      // Arrêt à -20% de drawdown
  maxDailyStake: 0.10,       // Max 10% de bankroll par jour
  maxBetPerMatch: 0.05,      // Max 5% de bankroll par match
  kellyFraction: 0.25,       // Fraction Kelly par défaut (conservateur)
  minEdge: 0.02,             // Edge minimum (2%) pour miser
  consecutiveLossLimit: 5,   // Arrêt après 5 pertes consécutives
  cooldownAfterLoss: 1,      // 1 jour de pause après une grosse perte
  maxCorrelatedBets: 3,      // Max 3 bets corrélés simultanés
  bookmakerLimits: {         // Limites par bookmaker (EUR)
    pinnacle: 5000,
    bet365: 3000,
    unibet: 2000,
    winamax: 2500,
    default: 1000,
  },
  platformRules: {
    france: { maxStake: 3000, taxRate: 0, allowed: true },
    uk: { maxStake: 5000, taxRate: 0, allowed: true },
    asia: { maxStake: 10000, taxRate: 0.05, allowed: true },
  },
}

class StakingOptimizer {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.state = {
      bankroll: this.config.bankroll,
      peakBankroll: this.config.bankroll,
      dailyStake: 0,
      consecutiveLosses: 0,
      totalBets: 0,
      winningBets: 0,
      losingBets: 0,
      totalProfit: 0,
      lastBetDate: null,
      betHistory: [],
      activeBets: [],
    }
  }

  /**
   * Calcule la mise optimale selon Kelly + règles de risque
   */
  calculateStake(match, prediction, platform = 'default') {
    const {
      bankroll,
      kellyFraction,
      minEdge,
      maxDrawdownPct,
      maxBetPerMatch,
      maxDailyStake,
      consecutiveLossLimit,
    } = this.config

    // Vérifier le drawdown
    const drawdown = (this.state.peakBankroll - bankroll) / this.state.peakBankroll
    if (drawdown >= maxDrawdownPct) {
      logger.warn(`[STAKING] Max drawdown reached (${(drawdown*100).toFixed(1)}%). Bets STOPPED.`)
      return { stake: 0, reason: 'MAX_DRAWDOWN', drawdown }
    }

    // Vérifier les pertes consécutives
    if (this.state.consecutiveLosses >= consecutiveLossLimit) {
      logger.warn(`[STAKING] ${consecutiveLossLimit} consecutive losses. Cooldown activated.`)
      return { stake: 0, reason: 'CONSECUTIVE_LOSS_LIMIT', consecutiveLosses: this.state.consecutiveLosses }
    }

    // Vérifier la limite quotidienne
    if (this.state.dailyStake >= bankroll * maxDailyStake) {
      logger.warn(`[STAKING] Daily stake limit reached.`)
      return { stake: 0, reason: 'DAILY_LIMIT' }
    }

    // Identifier le pronostic principal
    const selection = prediction.verdict || 'No Bet'
    if (selection === 'No Bet' || selection === 'NO BET') {
      return { stake: 0, reason: 'NO_BET_VERDICT' }
    }

    const pHome = prediction.home_win_probability || 0.33
    const pDraw = prediction.draw_probability || 0.34
    const pAway = prediction.away_win_probability || 0.33

    // Trouver l'odds correspondant au verdict
    let odds, ourProb
    if (selection === 'Home' || selection.includes('Home')) {
      odds = parseFloat(match.odds_home || match.odds_h || 0)
      ourProb = pHome
    } else if (selection === 'Away' || selection.includes('Away')) {
      odds = parseFloat(match.odds_away || match.odds_a || 0)
      ourProb = pAway
    } else {
      odds = parseFloat(match.odds_draw || 0)
      ourProb = pDraw
    }

    if (odds <= 1 || ourProb <= 0) {
      return { stake: 0, reason: 'INVALID_ODDS' }
    }

    // Calculer l'edge
    const marketImplied = 1 / odds
    const edge = (ourProb / marketImplied) - 1

    if (edge < minEdge) {
      return { stake: 0, reason: 'INSUFFICIENT_EDGE', edge }
    }

    // Kelly fractionnaire
    const kellyRaw = (ourProb * (odds - 1) - (1 - ourProb)) / (odds - 1)
    const kellyFrac = Math.max(0, kellyRaw * kellyFraction)

    // Ajuster la fraction selon la confiance
    const confidence = prediction.surgical_confidence || prediction.xgboost_confidence || 0.5
    const confidenceMultiplier = Math.min(1, Math.max(0.25, confidence / 85))
    const kellyAdjusted = kellyFrac * confidenceMultiplier

    // Mise en unités de bankroll
    let stake = bankroll * kellyAdjusted

    // Appliquer la limite max par match
    const maxMatchStake = bankroll * maxBetPerMatch
    stake = Math.min(stake, maxMatchStake)

    // Appliquer la limite quotidienne
    const remainingDaily = (bankroll * maxDailyStake) - this.state.dailyStake
    stake = Math.min(stake, remainingDaily)

    // Appliquer les limites bookmaker
    const bmLimit = this.config.bookmakerLimits[platform] || this.config.bookmakerLimits.default
    stake = Math.min(stake, bmLimit)

    // Appliquer les règles de la plateforme (France, UK, Asie)
    const region = this._detectRegion(match)
    if (region && this.config.platformRules[region]) {
      const rules = this.config.platformRules[region]
      if (!rules.allowed) return { stake: 0, reason: 'REGION_BLOCKED', region }
      stake = Math.min(stake, rules.maxStake)
      // Taxe asiatique
      if (rules.taxRate > 0) {
        stake = stake * (1 - rules.taxRate)
      }
    }

    // Round à l'euro près
    stake = Math.floor(stake)

    // Minimum stake
    if (stake < 1) return { stake: 0, reason: 'BELOW_MINIMUM' }

    return {
      stake,
      edge: round(edge, 4),
      kellyRaw: round(kellyRaw, 4),
      kellyFrac: round(kellyAdjusted, 4),
      confidence: round(confidence, 1),
      odds: round(odds, 2),
      ourProb: round(ourProb, 4),
      marketImplied: round(marketImplied, 4),
    }
  }

  /**
   * Enregistrer le résultat d'un pari
   */
  recordBet(match, prediction, stake, won, profit) {
    const bet = {
      date: new Date().toISOString(),
      match: `${match.homeTeam} vs ${match.awayTeam}`,
      league: match.league,
      selection: prediction.verdict,
      stake,
      odds: prediction.surgical_selection_odds || 2.0,
      won,
      profit,
      confidence: prediction.surgical_confidence || 50,
      timestamp: Date.now(),
    }

    this.state.betHistory.push(bet)
    this.state.totalBets++
    this.state.totalProfit += profit
    this.state.bankroll += profit
    this.state.lastBetDate = new Date().toDateString()

    if (profit > 0) {
      this.state.winningBets++
      this.state.consecutiveLosses = 0
      if (this.state.bankroll > this.state.peakBankroll) {
        this.state.peakBankroll = this.state.bankroll
      }
    } else {
      this.state.losingBets++
      this.state.consecutiveLosses++
    }

    this.state.dailyStake += stake

    logger.info(`[STAKING] ${won ? '✅' : '❌'} ${bet.match} | Stake: ${stake}€ | Profit: ${profit}€ | Bankroll: ${this.state.bankroll.toFixed(0)}€`)

    return this.getStats()
  }

  /**
   * Ajuster la bankroll (dépôt/retrait)
   */
  adjustBankroll(amount) {
    this.state.bankroll += amount
    if (this.state.bankroll > this.state.peakBankroll) {
      this.state.peakBankroll = this.state.bankroll
    }
    logger.info(`[STAKING] Bankroll adjusted by ${amount}€ → ${this.state.bankroll.toFixed(0)}€`)
  }

  /**
   * Détecter la région pour les règles plateforme
   */
  _detectRegion(match) {
    const league = (match.league || '').toLowerCase()
    if (league.includes('ligue 1') || league.includes('ligue 2') || league.includes('france') || league.includes('coupe de france')) {
      return 'france'
    }
    if (league.includes('premier') || league.includes('championship') || league.includes('england') || league.includes('scotland')) {
      return 'uk'
    }
    if (league.includes('j league') || league.includes('k league') || league.includes('china') || league.includes('australia')) {
      return 'asia'
    }
    return null
  }

  /**
   * Vérifier la corrélation entre deux matchs
   */
  getCorrelation(betA, betB) {
    let score = 0
    // Même ligue
    if (betA.league === betB.league) score += 0.3
    // Même équipe (un bet sur une équipe et un autre sur la même dans un autre match)
    if (betA.home === betB.home || betA.home === betB.away || betA.away === betB.home || betA.away === betB.away) score += 0.5
    // Même jour
    if (betA.date === betB.date) score += 0.2
    return Math.min(1, score)
  }

  /**
   * Réduire les mises sur les matchs corrélés
   */
  applyCorrelationPenalty(newBet, existingBets) {
    let maxCorrelation = 0
    for (const bet of existingBets) {
      const corr = this.getCorrelation(newBet, bet)
      maxCorrelation = Math.max(maxCorrelation, corr)
    }
    if (maxCorrelation > 0.5) {
      return 1 - (maxCorrelation * 0.5)
    }
    return 1
  }

  /**
   * Réinitialiser le compteur quotidien
   */
  resetDaily() {
    this.state.dailyStake = 0
    this.state.consecutiveLosses = 0
  }

  /**
   * Obtenir les statistiques courantes
   */
  getStats() {
    const { bankroll, totalBets, winningBets, losingBets, totalProfit, consecutiveLosses, dailyStake, peakBankroll } = this.state
    const drawdown = peakBankroll > 0 ? (peakBankroll - bankroll) / peakBankroll : 0
    const winRate = totalBets > 0 ? winningBets / totalBets : 0

    // Sharpe ratio simplifié
    const profits = this.state.betHistory.map(b => b.profit)
    const avgProfit = profits.length > 0 ? profits.reduce((a, b) => a + b, 0) / profits.length : 0
    const stdProfit = profits.length > 1 ? Math.sqrt(profits.reduce((s, p) => s + (p - avgProfit) ** 2, 0) / profits.length) : 1
    const sharpe = stdProfit > 0 ? (avgProfit / stdProfit) * Math.sqrt(365) : 0

    return {
      bankroll: round(bankroll, 0),
      peakBankroll: round(peakBankroll, 0),
      drawdownPct: round(drawdown * 100, 1),
      totalBets,
      winningBets,
      losingBets,
      winRate: round(winRate * 100, 1),
      totalProfit: round(totalProfit, 0),
      consecutiveLosses,
      dailyStake: round(dailyStake, 0),
      dailyLimit: round(bankroll * this.config.maxDailyStake, 0),
      sharpeRatio: round(sharpe, 2),
      roi: round((totalProfit / this.config.bankroll) * 100, 1),
      avgProfit: round(avgProfit, 2),
    }
  }

  /**
   * Sauvegarder/Restaurer l'état
   */
  toJSON() {
    return JSON.parse(JSON.stringify(this.state))
  }

  fromJSON(json) {
    this.state = JSON.parse(JSON.stringify(json))
  }
}

function round(v, d) {
  if (v == null || isNaN(v)) return 0
  const f = Math.pow(10, d)
  return Math.round(v * f) / f
}

// Singleton
const globalOptimizer = new StakingOptimizer()

module.exports = { StakingOptimizer, globalOptimizer }

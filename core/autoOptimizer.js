const fs = require('fs')
const path = require('path')
const db = require('./database')
const logger = require('./logger')

// draw_bias = multiplicateur de tendance nulle : 1.0 = neutre. confidenceScorer
// sature dès ~1.6 (plafonds -10/+5 pts) ; au-delà, += 0.15 sans plafond (bug
// historique : 65.65 en production) ne change rien sauf à rendre toute
// auto-optimisation mono-directionnelle. Bornes + retour neutre imposés ici.
const DRAW_BIAS_MIN = 1.0
const DRAW_BIAS_MAX = 1.6

// ── Garde-fous AUTO-OPT (E103) ────────────────────────────────────────────────
// Symptôme observé : bsm_threshold plaqué à 40 (plafond) et draw_bias à 1.60
// (plafond) en permanence. Trois causes structurelles :
//  (1) ZONES MORTES — bsm ne descend qu'au-dessus de 85 % de winrate, donc
//      entre 70 et 85 % aucune action : avec un winrate à 0 % la ramoie monte
//      de +5 a chaque cycle jusqu'au plafond.
//  (2) draw_bias ne redescend qu'a missedDraws <= 2. Sur 50 matchs de foot,
//      5 nuls manqués est quasi systematique -> le plafond 1.6 est atteignable
//      et jamais quittable. Seuils compares au total, donc non invariants
//      d'echelle.
//  (3) AUCUN TEST D'ACCEPTATION — l'evaluation porte sur des predictions
//      produites par les poids que l'on est en train de muter. La metrique
//      est un artefact de la boucle (reward hacking), pas un signal.
// On ajoute : taille minimale d'echantillon, seuils relatifs, une seule
// mutation par cycle, et un test d'acceptation qui REVERT si la mutation n'a
// pas ameliore la metrique (anti-oscillation, sans dependance a l'horloge).
const BSM_MIN = 20
const BSM_MAX = 40
const MIN_SOLID_SAMPLE = 30 // en dessous, la metrique "solid" n'a pas de sens
const MIN_SAMPLE = 20 // minimum de matchs filtres avant toute action
const DRAW_BIAS_LOCKOUT_CYCLES = 3 // cycles de blocage apres un revert
const BSM_LOCKOUT_CYCLES = 3
const IMPROVEMENT_MARGIN = 2 // points de % ; evite le bruit sur du bruit
const BSM_UP_TRIGGER = 70
const BSM_DOWN_TRIGGER = 85
const MISSED_DRAW_RATE_UP = 0.15 // > 15 % de nuls manqués -> on pousse
const MISSED_DRAW_RATE_DOWN = 0.07 // <  7 % -> on relâche

// E127 — soupape anti-saturation : au plafond, AUCUN trial ne démarre
// (jamais de revert possible) et le signal ne peut pas se résorber par ce
// levier (draw_bias ne change que l'AFFICHAGE de confiance, pas le pick ;
// les nuls manqués viennent du recall 33 % du XGB). Sans soupape : 30 cycles
// plaqués au plafond qui corrompent l'affichage (-6 pts sur les picks H/A,
// bonus BSM mort) + alertes en boucle. Au bout de SAT_LIMIT cycles saturés
// d'affilée : retour aux valeurs neutres (planchers), compteur remis à zéro.
const SAT_LIMIT = 3

class AutoOptimizationEngine {
  constructor() {
    this.configPath = path.join(__dirname, '../config/model_weights.json')
    this.statePath = path.join(__dirname, '../config/auto_opt_state.json')
    this.weights = this._loadWeights()
    this.state = this._loadState()
    this._sanitizeWeights()
  }

  // ── Etat d'acceptation (E103) ──
  // Mémorise la dernière mutation et la métrique d'avant, pour pouvoir
  // vérifier AU CYCLE SUIVANT si elle a réellement aidé.
  _loadState() {
    const fallback = { cycles: 0, pending: null, locked: {}, sat: {} }
    try {
      if (!fs.existsSync(this.statePath)) return fallback
      const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      return { cycles: s.cycles || 0, pending: s.pending || null, locked: s.locked || {}, sat: s.sat || {} }
    } catch (e) {
      logger.warn(`[AUTO-OPT] Failed to load state: ${e.message}`)
      return fallback
    }
  }

  /**
   * E127 — soupape : appelée quand le signal pousse mais que le paramètre
   * est déjà au plafond (aucun trial possible). Retourne true si la soupape
   * a reset (l'appelant ne doit alors rien muter d'autre ce cycle).
   * Purement comptable + reset aux planchers neutres, persisté.
   */
  _saturated(param, floor) {
    const n = (this.state.sat[param] || 0) + 1
    this.state.sat[param] = n
    if (n < SAT_LIMIT) {
      this._saveState()
      return false
    }
    this.state.sat[param] = 0
    this.weights[param] = floor
    this._saveWeights()
    this._saveState()
    logger.error(
      `🚨 [AUTO-OPT] ${param} saturé ${SAT_LIMIT} cycles d'affilée sans effet — ` +
        `SOUPAPE : retour neutre (${floor}). Le levier ne corrige pas le signal : à traiter hors AUTO-OPT.`
    )
    return true
  }

  _clearSaturation(param) {
    if (this.state.sat[param]) {
      this.state.sat[param] = 0
      this._saveState()
    }
  }

  _saveState() {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2))
    } catch (e) {
      logger.warn(`[AUTO-OPT] Failed to persist state: ${e.message}`)
    }
  }

  _saveWeights() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.weights, null, 2))
  }

  _isLocked(param) {
    const until = this.state.locked[param] || 0
    return this.state.cycles < until
  }

  // Un parametre verrouille ne doit PLUS muter, meme en l'absence de trial
  // en cours : verifier le lock dans _resolveTrial() seul ne suffisait pas
  // (le trial appartient au dernier parametre muté, pas a tous).
  _canAct(param) {
    if (!this._isLocked(param)) return true
    logger.warn(
      `⛔ [AUTO-OPT] ${param} verrouillé (${(this.state.locked[param] - this.state.cycles)} cycle(s) restants) — mutation ignorée.`
    )
    return false
  }

  _lock(param, cycles) {
    this.state.locked[param] = this.state.cycles + cycles
  }

  // Enregistre une mutation en cours de validation.
  // IMPORTANT : appele AVANT de muter this.weights, sinon weightsBefore
  // capture l'etat deja modifie et le revert restaure la mauvaise valeur.
  _beginTrial(param, direction, metricBefore, lockout) {
    this.state.pending = {
      param,
      direction,
      metricBefore,
      lockout,
      weightsBefore: JSON.parse(JSON.stringify(this.weights)),
    }
    this._saveState()
  }

  // Arrondi a 2 decimales : sans ca 1.0 + 0.15 + 0.15 = 1.2999999999999998
  // s'accumule dans le JSON et casse les comparaisons ulterieures.
  _roundBias(value) {
    return Math.round(Number(value) * 100) / 100
  }

  /**
   * Test d'acceptation. Appele en DEBUT de cycle, avant toute nouvelle decision.
   * - lockout encore actif  -> on ignore ce parametre (le precedent revert
   *                            n'a pas ete corrige par de nouvelles donnees)
   * - metrique amelioree    -> on accepte, on oublie
   * - metrique non amelioree-> on REVERT les poids et on verrouille
   * @returns {boolean} true si le parametre a ete re-evalue (et donc libere)
   */
  _resolveTrial(param, metricNow) {
    const p = this.state.pending
    if (!p || p.param !== param) return true

    // "Ameliore" = la metrique va dans le sens de la mutation.
    // draw_bias monte -> on veut moins de nuls manques (metrique qui baisse = mieux)
    // bsm monte      -> on veut un winrate plus haut (metrique qui monte = mieux)
    const improved =
      p.direction === 'up'
        ? param === 'draw_bias'
          ? metricNow <= p.metricBefore - IMPROVEMENT_MARGIN
          : metricNow >= p.metricBefore + IMPROVEMENT_MARGIN
        : param === 'draw_bias'
          ? metricNow >= p.metricBefore + IMPROVEMENT_MARGIN
          : metricNow <= p.metricBefore - IMPROVEMENT_MARGIN

    if (improved) {
      logger.info(
        `✅ [AUTO-OPT] Mutation ${param} ${p.direction} validée (${p.metricBefore.toFixed(1)} -> ${metricNow.toFixed(1)}).`
      )
      this.state.pending = null
      this._saveState()
      return true
    }

    // Non amelioree : on revient en arriere et on bloque le parametre.
    const before = p.weightsBefore
    logger.error(
      `🚨 [AUTO-OPT] Mutation ${param} ${p.direction} sans effet (${p.metricBefore.toFixed(1)} -> ${metricNow.toFixed(1)}). ` +
        `REVERT ${before[param]} -> ${this.weights[param]} puis blocage ${p.lockout} cycles.`
    )
    this.weights[param] = before[param]
    this._saveWeights()
    this._lock(param, p.lockout)
    this.state.pending = null
    this._saveState()
    return false
  }

  _clampDrawBias(value = this.weights.draw_bias) {
    const raw = Number(value)
    const safe = Number.isFinite(raw) ? raw : DRAW_BIAS_MIN
    return Math.min(DRAW_BIAS_MAX, Math.max(DRAW_BIAS_MIN, safe))
  }

  // Valeurs héritées hors plage (ex. draw_bias 65.65) corrigées et repersistées
  // au chargement — sinon confidenceScorer resterait saturé malgré le clamp.
  _sanitizeWeights() {
    const clamped = this._clampDrawBias()
    if (clamped !== this.weights.draw_bias) {
      logger.warn(
        `🧹 [AUTO-OPT] draw_bias=${this.weights.draw_bias} hors plage [${DRAW_BIAS_MIN}, ${DRAW_BIAS_MAX}] -> clampé à ${clamped}.`
      )
      this.weights.draw_bias = clamped
      fs.writeFileSync(this.configPath, JSON.stringify(this.weights, null, 2))
    }
  }

  _loadWeights() {
    try {
      if (!fs.existsSync(this.configPath)) {
        const defaults = { poisson_xg_weight: 1.0, bsm_threshold: 25, draw_bias: 1.0 }
        fs.writeFileSync(this.configPath, JSON.stringify(defaults, null, 2))
        return defaults
      }
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
    } catch (e) {
      logger.warn(`[AUTO-OPT] Failed to load weights: ${e.message}`)
      return { poisson_xg_weight: 1.0, bsm_threshold: 25, draw_bias: 1.0 }
    }
  }

  _isFallback(m) {
    const q = m.quant || {}
    const hp = parseFloat(q.home_win_probability ?? m.home_win_probability ?? -1)
    const dp = parseFloat(q.draw_probability ?? m.draw_probability ?? -1)
    const ap = parseFloat(q.away_win_probability ?? m.away_win_probability ?? -1)
    if (hp < 0 || dp < 0 || ap < 0) return false
    // distribution aveugle 33% → fallback
    const eps = 0.02
    return Math.abs(hp - 1 / 3) < eps && Math.abs(dp - 1 / 3) < eps && Math.abs(ap - 1 / 3) < eps
  }

  async optimizeModelBasedOnROI() {
    logger.info('🤖 [AUTO-OPT] Analysing past results to self-heal...')

    let pastMatches = await db.getRecentArchivedMatches(50)
    const totalRaw = pastMatches.length
    pastMatches = pastMatches.filter((m) => !this._isFallback(m))
    const filteredOut = totalRaw - pastMatches.length
    if (filteredOut > 0)
      logger.info(
        `🧹 [AUTO-OPT] Filtered out ${filteredOut} fallback matches (blind 33% distribution).`
      )

    if (pastMatches.length < MIN_SAMPLE) {
      logger.info(
        `📉 [AUTO-OPT] Not enough valid matches (${pastMatches.length}/${totalRaw}) to optimize.`
      )
      return
    }

    let totalSolidWins = 0
    let totalSolidMatches = 0
    let missedDraws = 0

    for (const m of pastMatches) {
      const q = m.quant || {}
      const baseSolidMargin = q.base_solid_margin || m.base_solid_margin || 0
      const mainPick = q.main_pick || m.main_pick || ''
      const drawProb = parseFloat(q.draw_probability ?? m.draw_probability ?? 0)
      const scoreHome = parseInt(m.scoreHome ?? 0)
      const scoreAway = parseInt(m.scoreAway ?? 0)
      const actualResult = scoreHome > scoreAway ? '1' : scoreHome === scoreAway ? 'X' : '2'

      const isSolid = parseFloat(baseSolidMargin) > 0
      if (isSolid) {
        totalSolidMatches++
        if (mainPick === actualResult) totalSolidWins++
      }

      if (actualResult === 'X' && mainPick !== 'X' && drawProb < 30) {
        missedDraws++
      }
    }

    // Zéro match "solid" ne vaut PAS 100 % de winrate : c'est l'absence de
    // données, pas une performance. On neutralise le signal.
    const solidSuccessRate =
      totalSolidMatches > 0 ? (totalSolidWins / totalSolidMatches) * 100 : null
    const missedDrawRate = pastMatches.length > 0 ? (missedDraws / pastMatches.length) * 100 : 0

    this.state.cycles = (this.state.cycles || 0) + 1

    // ── Phase 1 : solder les mutations en cours de validation AVANT toute
    // nouvelle décision. C'est ce qui tue l'oscillation 25->40->25.
    this._resolveTrial('draw_bias', missedDrawRate)
    if (solidSuccessRate !== null) this._resolveTrial('bsm_threshold', solidSuccessRate)

    // ── Phase 2 : au plus UNE mutation par cycle ──────────────────────────
    // Avant, bsm ET draw_bias pouvaient bouger dans le meme cycle : deux
    // mutations simultanees rendent l'analyse du resultat ambigue.
    let updated = false

    // draw_bias : seuils RELATIFS au nombre de matchs (invariants d'echelle)
    if (!updated && this._canAct('draw_bias')) {
      const prevBias = this.weights.draw_bias
      const ratePct = missedDrawRate
      if (ratePct > MISSED_DRAW_RATE_UP * 100) {
        if (prevBias >= DRAW_BIAS_MAX) {
          logger.error(
            `🚨 [AUTO-OPT] draw_bias SATURÉ à ${DRAW_BIAS_MAX} alors que ${missedDraws}/${pastMatches.length} nuls sont manqués (${ratePct.toFixed(1)} %). ` +
              `Le signal ne peut plus agir : le modèle est biaisé vers le nul. À traiter hors AUTO-OPT.`
          )
          if (this._saturated('draw_bias', DRAW_BIAS_MIN)) updated = true
        } else {
          this._clearSaturation('draw_bias')
          this._beginTrial('draw_bias', 'up', ratePct, DRAW_BIAS_LOCKOUT_CYCLES)
          this.weights.draw_bias = this._clampDrawBias(this._roundBias(prevBias + 0.15))
          logger.warn(
            `💣 [AUTO-OPT] ${missedDraws}/${pastMatches.length} nuls manqués (${ratePct.toFixed(1)} %). draw_bias ${prevBias} -> ${this.weights.draw_bias.toFixed(2)}.`
          )
          updated = true
        }
      } else if (ratePct < MISSED_DRAW_RATE_DOWN * 100) {
        if (prevBias > DRAW_BIAS_MIN) {
          this._beginTrial('draw_bias', 'down', ratePct, DRAW_BIAS_LOCKOUT_CYCLES)
          this.weights.draw_bias = Math.max(DRAW_BIAS_MIN, this._roundBias(prevBias - 0.05))
          logger.info(
            `🧊 [AUTO-OPT]Peu de nuls manqués (${ratePct.toFixed(1)} %). draw_bias ${prevBias} -> ${this.weights.draw_bias.toFixed(2)}.`
          )
          updated = true
        } else {
          this._clearSaturation('draw_bias')
        }
      } else {
        this._clearSaturation('draw_bias')
      }
    }

    // bsm_threshold : refuse d'agir sans échantillon "solid" suffisant
    if (!updated && this._canAct('bsm_threshold')) {
      if (solidSuccessRate === null) {
        logger.warn(
          `⛔ [AUTO-OPT] Aucun match "solid" dans les ${pastMatches.length} filtrés — métrique undefined, bsm_threshold laissé à ${this.weights.bsm_threshold}.`
        )
      } else if (totalSolidMatches < MIN_SOLID_SAMPLE) {
        logger.warn(
          `⛔ [AUTO-OPT] bsm_threshold inchangé : ${totalSolidMatches} matchs "solid" < ${MIN_SOLID_SAMPLE} requis. Un winrate calculé sur ${totalSolidMatches} matchs n'est pas exploitable.`
        )
      } else if (solidSuccessRate < BSM_UP_TRIGGER) {
        if (this.weights.bsm_threshold >= BSM_MAX) {
          logger.error(
            `🚨 [AUTO-OPT] bsm_threshold SATURÉ à ${BSM_MAX} alors que le winrate est à ${solidSuccessRate.toFixed(1)} %. Aucun gain possible : le seuil ne filtre plus rien. À traiter hors AUTO-OPT.`
          )
          if (this._saturated('bsm_threshold', BSM_MIN)) updated = true
        } else {
          this._clearSaturation('bsm_threshold')
          this._beginTrial('bsm_threshold', 'up', solidSuccessRate, BSM_LOCKOUT_CYCLES)
          this.weights.bsm_threshold = Math.min(BSM_MAX, this.weights.bsm_threshold + 5)
          logger.warn(
            `⚠️ [AUTO-OPT] Winrate ${solidSuccessRate.toFixed(1)} % (${totalSolidWins}/${totalSolidMatches}). bsm_threshold ${this.weights.bsm_threshold - 5} -> ${this.weights.bsm_threshold}.`
          )
          updated = true
        }
      } else if (solidSuccessRate > BSM_DOWN_TRIGGER && this.weights.bsm_threshold > BSM_MIN) {
        this._beginTrial('bsm_threshold', 'down', solidSuccessRate, BSM_LOCKOUT_CYCLES)
        this.weights.bsm_threshold = Math.max(BSM_MIN, this.weights.bsm_threshold - 2)
        logger.info(
          `📈 [AUTO-OPT] Winrate ${solidSuccessRate.toFixed(1)} % (${totalSolidWins}/${totalSolidMatches}). bsm_threshold -> ${this.weights.bsm_threshold}.`
        )
        updated = true
      } else {
        this._clearSaturation('bsm_threshold')
      }
    }

    if (updated) {
      this._saveWeights()
      logger.info('✅ [AUTO-OPT] Model weights self-healed and updated successfully.')
    } else {
      logger.info(
        `✅ [AUTO-OPT] No adjustments needed. Win rate: ${solidSuccessRate === null ? 'n/a (0 solid)' : solidSuccessRate.toFixed(1) + ' %'} (${totalSolidWins}/${totalSolidMatches}), missed draws: ${missedDraws}/${pastMatches.length} (${missedDrawRate.toFixed(1)} %)`
      )
    }
    this._saveState()
  }

  safeGuardPrediction(match, rawPrediction) {
    if (!match.home_win_probability || isNaN(parseFloat(match.home_win_probability))) {
      logger.error(
        `🚨 [AUTO-OPT] Bug detected on match ${match.homeTeam}. Auto-fixing with equal distribution fallback.`
      )
      return {
        main_pick: '1X',
        home_win_probability: 33.3,
        draw_probability: 33.3,
        away_win_probability: 33.3,
        base_solid_margin: 0,
      }
    }
    return rawPrediction
  }
}

module.exports = new AutoOptimizationEngine()

const axios = require('axios')
const logger = require('../core/logger')

class BluesmindsService {
  constructor() {
    this.apiKey = process.env.BLUESMINDS_API_KEY || ''
    this.baseUrl = 'https://api.bluesminds.com/v1'
    this.model = process.env.BLUESMINDS_MODEL || 'deepseek-chat'
  }

  isAvailable() {
    return !!this.apiKey
  }

  async _chat(systemPrompt, userPrompt) {
    if (!this.isAvailable()) {
      logger.warn('[BLUESMINDS] API key missing, skipping')
      return null
    }

    try {
      const { data } = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: 1000,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      )

      const content = data.choices?.[0]?.message?.content
      if (!content) return null
      return JSON.parse(content)
    } catch (err) {
      logger.error(`[BLUESMINDS] API call failed: ${err.message}`)
      if (err.response) {
        logger.error(`  Response: ${JSON.stringify(err.response.data)}`)
      }
      return null
    }
  }

  async analyzeLiveValueBet(match, market, ev, liveOdds) {
    const systemPrompt =
      "Tu es l'Expert Stratégique en Chef de Titanium AI, un algorithme d'investissement quantitatif de niveau hedge-fund spécialisé dans les pronostics de football en direct."
    const userPrompt = `
Effectue une évaluation tactique critique de la Value Bet en direct détectée :

[DÉTAILS MATCH]
- Équipe Domicile : ${match.homeTeam}
- Équipe Extérieur : ${match.awayTeam}
- Tournoi : ${match.tournament_name || 'Championnat'}
- Score Actuel : Domicile ${match.currentHome} - ${match.currentAway} Extérieur
- Minute de jeu : ${match.minute}'

[DONNÉES QUANTITATIVES]
- Option sélectionnée : ${market}
- Avantage Mathématique (EV) calculé : +${(ev * 100).toFixed(1)}%
- Côte Actuelle en Direct : @${liveOdds.toFixed(2)}
- Confiance IA Pré-Match : ${match.confidence}%

Rédige une analyse tactique rapide de 3 à 4 phrases en français. Reste pragmatique, axé sur les faits de jeu, les dynamiques d'attaques et la motivation de classement.

Retourne ce format JSON :
{
  "tactical_analysis": "Analyse rédigée en français",
  "confidence_score": 0-100,
  "tactical_verdict": "Validé / Risque Élevé / À Surveiller",
  "telegram_bullet_points": "• points clés en français"
}`
    return await this._chat(systemPrompt, userPrompt)
  }

  async analyzePreMatchVIP(match, realTimeNews = '') {
    const systemPrompt =
      "Tu es le Directeur Quantitatif Principal de Titanium AI. Tu prépares des fiches tactiques ultra-pointues destinées à un club d'investisseurs professionnels."
    const userPrompt = `
Rédige une fiche d'évaluation stratégique pré-match pour la sélection VIP suivante :

[DÉTAILS FIXTURE]
- Affiche : ${match.homeTeam} vs ${match.awayTeam}
- Championnat : ${match.tournament_name || 'Ligue'}

[PROBABILITÉS BRUTES IA]
- Victoire Domicile : ${(match.home_win_probability || 0).toFixed(1)}%
- Match Nul : ${(match.draw_probability || 0).toFixed(1)}%
- Victoire Extérieur : ${(match.away_win_probability || 0).toFixed(1)}%
- Plus de 2.5 Buts : ${(match.ou_25_prob || 0).toFixed(1)}%
- BTTS : ${(match.btts_prob || 0).toFixed(1)}%
- Confiance : ${(match.xgboost_confidence ? match.xgboost_confidence * 100 : 85).toFixed(0)}%

[ACTUALITÉS]
${realTimeNews || 'Aucune actualité de dernière minute.'}

Rédige un briefing stratégique rigoureux en français. Explique le match-up tactique clé, intègre les actualités de dernière minute.

Retourne ce format JSON :
{
  "match_overview": "Présentation tactique globale en français",
  "tactical_keyup": "Duel ou configuration tactique clé",
  "motivation_verdict": "Comment les objectifs influencent l'engagement",
  "ai_prediction_validation": "Pourquoi la probabilité de l'IA fait sens",
  "exact_score_prediction": "Score exact estimé",
  "risk_mitigation": "Conseil de sécurité sur le pari"
}`
    return await this._chat(systemPrompt, userPrompt)
  }

  async analyzeFailedMatchAutopsy(failed) {
    const systemPrompt =
      "Tu es le Médecin Légiste Tactique Principal de Titanium AI, spécialisé dans l'autopsie post-match."
    const userPrompt = `
Effectue une autopsie tactique de la prédiction échouée suivante :

[MATCH]
- Affiche : ${failed.homeTeam} vs ${failed.awayTeam}
- Score Final : ${failed.score}
- Pari Suggéré : ${failed.prediction}
- Confiance IA Initiale : ${failed.confidence}%

Retourne ce format JSON :
{
  "arabic_autopsy": "Raison de l'échec en arabe",
  "french_tactical_summary": "Résumé tactique en français",
  "complacency_rating": 0,
  "tactical_error_type": "POSSESSION_TRAP|XG_WASTE|GK_WALL|SYSTEMIC_DEFENSIVE_FAILURE|COMPLACENCY_TRAP|RED_CARD_DISRUPTION|NORMAL_VARIANCE"
}`
    return await this._chat(systemPrompt, userPrompt)
  }
}

module.exports = new BluesmindsService()

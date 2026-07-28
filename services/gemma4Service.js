const axios = require('axios')
const logger = require('../core/logger')

class Gemma4Service {
  constructor() {
    this.baseUrl = process.env.GEMMA4_URL || 'http://127.0.0.1:11434/v1'
    this.model = process.env.GEMMA4_MODEL || 'gemma3:1b'
    this.apiKey = process.env.GEMMA4_API_KEY || ''
  }

  isAvailable() {
    const url = this.baseUrl
    // En production (Render), Ollama local n'est pas disponible
    if (process.env.RENDER || process.env.NODE_ENV === 'production') {
      if (url.includes('127.0.0.1') || url.includes('localhost')) {
        return false
      }
    }
    // si serveur local (Ollama), apiKey optionnel
    if (url.includes('127.0.0.1') || url.includes('localhost')) {
      return !!url
    }
    // serveur distant → clé obligatoire
    return !!url && !!this.apiKey
  }

  async _chat(systemPrompt, userPrompt) {
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`
      }
      const payload = {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 1000,
        stream: false,
      }

      // Ajout du format JSON pour Ollama (si local) ou Groq/Together
      if (this.baseUrl.includes('11434')) {
        payload.format = 'json'
      } else {
        payload.response_format = { type: 'json_object' }
      }

      const { data } = await axios.post(`${this.baseUrl}/chat/completions`, payload, {
        headers,
        timeout: 60000,
      })

      const content = data.choices?.[0]?.message?.content
      if (!content) return null
      try {
        return JSON.parse(content)
      } catch (_) {
        const jsonMatch = content.match(/\{[\s\S]*\}/)
        if (jsonMatch) return JSON.parse(jsonMatch[0])
        return null
      }
    } catch (err) {
      logger.error(`[GEMMA4] API call failed: ${err.message}`)
      return null
    }
  }

  async analyzePreMatchVIP(match, realTimeNews = '') {
    const systemPrompt =
      "Tu es le Directeur Quantitatif Principal de Titanium AI. Tu prépares des fiches tactiques ultra-pointues destinées à un club d'investisseurs professionnels. Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ou après."
    const userPrompt = `
Rédige une fiche d'évaluation stratégique pré-match pour la sélection VIP suivante :

[DÉTAILS FIXTURE]
- Affiche : ${match.homeTeam} vs ${match.awayTeam}
- Championnat : ${match.tournament_name || 'Ligue'}
- Score Prédit IA : ${match.expected_score || 'N/A'}

[PROBABILITÉS BRUTES IA]
- Victoire Domicile : ${(match.home_win_probability || 0).toFixed(1)}%
- Match Nul : ${(match.draw_probability || 0).toFixed(1)}%
- Victoire Extérieur : ${(match.away_win_probability || 0).toFixed(1)}%
- Plus de 2.5 Buts : ${(match.ou_25_prob || 0).toFixed(1)}%
- BTTS : ${(match.btts_prob || 0).toFixed(1)}%

[ACTUALITÉS]
${realTimeNews || 'Aucune actualité de dernière minute.'}

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

  async analyzeLiveValueBet(match, market, ev, liveOdds) {
    const systemPrompt =
      "Tu es l'Expert Stratégique en Chef de Titanium AI, un algorithme d'investissement quantitatif de niveau hedge-fund spécialisé dans les pronostics de football en direct. Réponds UNIQUEMENT avec un objet JSON valide."
    const userPrompt = `
Effectue une évaluation tactique critique de la Value Bet en direct détectée :

[DÉTAILS MATCH]
- Équipe Domicile : ${match.homeTeam}
- Équipe Extérieur : ${match.awayTeam}
- Tournoi : ${match.tournament_name || 'Championnat'}
- Score Actuel : Domicile ${match.currentHome || 0} - ${match.currentAway || 0} Extérieur

[DONNÉES QUANTITATIVES]
- Option sélectionnée : ${market}
- Avantage Mathématique (EV) calculé : +${(ev * 100).toFixed(1)}%
- Côte Actuelle en Direct : @${(liveOdds || 0).toFixed(2)}

Retourne ce format JSON :
{
  "tactical_analysis": "Analyse rédigée en français",
  "confidence_score": 0-100,
  "tactical_verdict": "Validé / Risque Élevé / À Surveiller",
  "telegram_bullet_points": "• points clés en français"
}`
    return await this._chat(systemPrompt, userPrompt)
  }

  async analyzeFailedMatchAutopsy(failed) {
    const systemPrompt =
      "Tu es le Médecin Légiste Tactique Principal de Titanium AI, spécialisé dans l'autopsie post-match. Réponds UNIQUEMENT avec un objet JSON valide."
    const userPrompt = `
Effectue une autopsie tactique de la prédiction échouée suivante :

[MATCH]
- Affiche : ${failed.homeTeam} vs ${failed.awayTeam}
- Score Final : ${failed.score || 'N/A'}
- Pari Suggéré : ${failed.prediction}
- Confiance IA Initiale : ${failed.confidence || 0}%

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

module.exports = new Gemma4Service()

/**
 * 🧠 TITANIUM AI - DEEPSEEK QUANT & TACTICAL INTEGRATION V50
 * -------------------------------------------------------------
 * Hardened integration service for DeepSeek-V3 / DeepSeek-R1 API.
 * Features an automatic persistent quota budget protector to prevent exceeding 250 calls/month.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const logger = require('../core/logger');

// Load environment variables if not loaded
dotenv.config();

const USAGE_FILE = path.resolve('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/deepseek_usage.json');
const MAX_MONTHLY_LIMIT = parseInt(process.env.DEEPSEEK_MAX_MONTHLY_CALLS || '220');

class DeepSeekService {
    constructor() {
        // Automatically check if Groq is available for free execution to avoid payment/balance errors
        if (process.env.GROQ_API_KEY) {
            this.apiKey = process.env.GROQ_API_KEY;
            this.apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
            this.model = 'llama-3.3-70b-versatile';
            this.isGroq = true;
        } else {
            this.apiKey = process.env.DEEPSEEK_API_KEY || '';
            this.apiUrl = 'https://api.deepseek.com/v1/chat/completions';
            this.model = 'deepseek-chat';
            this.isGroq = false;
        }
    }

    /**
     * Reads the current API usage from the persistent JSON file.
     * Automatically handles monthly rollover resets.
     */
    _getUsage() {
        const currentMonth = new Date().toISOString().substring(0, 7); // e.g. "2026-05"
        const defaultUsage = { current_month: currentMonth, count: 0 };

        try {
            if (!fs.existsSync(USAGE_FILE)) {
                // Ensure parent directory exists
                const parentDir = path.dirname(USAGE_FILE);
                if (!fs.existsSync(parentDir)) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }
                fs.writeFileSync(USAGE_FILE, JSON.stringify(defaultUsage, null, 2), 'utf8');
                return defaultUsage;
            }

            const raw = fs.readFileSync(USAGE_FILE, 'utf8');
            const data = JSON.parse(raw);

            // Monthly rollover check
            if (data.current_month !== currentMonth) {
                logger.info(`📅 [DEEPSEEK] New month detected (${currentMonth}). Resetting API quota usage from ${data.count} to 0.`);
                const resetData = { current_month: currentMonth, count: 0 };
                fs.writeFileSync(USAGE_FILE, JSON.stringify(resetData, null, 2), 'utf8');
                return resetData;
            }

            return data;
        } catch (e) {
            logger.error(`❌ [DEEPSEEK] Failed to load usage file: ${e.message}`);
            return defaultUsage;
        }
    }

    /**
     * Increments the API usage counter and persists it to disk.
     */
    _incrementUsage() {
        try {
            const usage = this._getUsage();
            usage.count++;
            fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), 'utf8');
            logger.info(`📈 [DEEPSEEK] Usage incremented: ${usage.count}/${MAX_MONTHLY_LIMIT} requests used this month.`);
            return usage.count;
        } catch (e) {
            logger.error(`❌ [DEEPSEEK] Failed to increment usage file: ${e.message}`);
            return 0;
        }
    }

    /**
     * Checks if the system is still within the monthly safe budget.
     */
    isQuotaAvailable() {
        if (!this.apiKey) {
            logger.warn('⚠️ [DEEPSEEK] API Key is missing in .env file.');
            return false;
        }
        const usage = this._getUsage();
        if (usage.count >= MAX_MONTHLY_LIMIT) {
            logger.warn(`🛑 [DEEPSEEK] API Call Blocked! Monthly soft-cap of ${MAX_MONTHLY_LIMIT} reached (${usage.count} used). Saving your API credits.`);
            return false;
        }
        return true;
    }

    /**
     * Returns a structured summary of remaining API budget.
     */
    getQuotaStatus() {
        const usage = this._getUsage();
        return {
            month: usage.current_month,
            used: usage.count,
            limit: MAX_MONTHLY_LIMIT,
            remaining: Math.max(0, MAX_MONTHLY_LIMIT - usage.count),
            isActive: usage.count < MAX_MONTHLY_LIMIT && !!this.apiKey
        };
    }

    /**
     * Queries DeepSeek API with system and user prompts.
     * Enforces JSON response mode and strict budget validation.
     */
    async _queryDeepSeek(systemPrompt, userPrompt) {
        if (!this.isQuotaAvailable()) {
            return null;
        }

        try {
            const response = await axios.post(this.apiUrl, {
                model: this.model, // Swaps to Llama 3.3 70B if using Groq
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                response_format: { type: 'json_object' },
                temperature: 0.2, // Consistent quantitative output
                max_tokens: 1000
            }, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000 // 30s timeout
            });

            const content = response.data.choices[0].message.content;
            const parsed = JSON.parse(content);
            
            // Successfully queried -> Increment counter
            this._incrementUsage();
            return parsed;
        } catch (error) {
            logger.error(`❌ [DEEPSEEK] API Call Failed: ${error.message}`);
            if (error.response) {
                logger.error(`   Détails API: ${JSON.stringify(error.response.data)}`);
            }
            return null;
        }
    }

    /**
     * Analyzes an active Live Value Bet candidate to build a professional, tactical alert breakdown.
     */
    async analyzeLiveValueBet(match, market, ev, liveOdds) {
        const systemPrompt = "Tu es l'Expert Stratégique en Chef de Titanium AI, un algorithme d'investissement quantitatif de niveau hedge-fund spécialisé dans les pronostics de football en direct.";
        
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
        - Zones Dynamiques de Motivation (Standings) :
          * Domicile : Zone: ${match.home_zone || 'Unknown'}, Distance cible: ${match.home_distance_target || 0} pts, Matches restants: ${match.home_matches_remaining || 10}
          * Extérieur : Zone: ${match.away_zone || 'Unknown'}, Distance cible: ${match.away_distance_target || 0} pts, Matches restants: ${match.away_matches_remaining || 10}

        Rédige une analyse tactique rapide de 3 à 4 phrases en français expliquant pourquoi cette Value Bet est valide. Reste très pragmatique, axé sur les faits de jeu, les dynamiques d'attaques et la motivation de classement (DMF).
        
        Tu dois obligatoirement retourner ce format JSON :
        {
          "tactical_analysis": "Ton analyse rédigée en français avec un ton d'analyste de football professionnel rigoureux.",
          "confidence_score": 0 to 100, // Ajustement de la confiance en direct basé sur la motivation
          "tactical_verdict": "Validé / Risque Élevé / À Surveiller",
          "telegram_bullet_points": "• 1-2 points clés synthétisés en français"
        }
        `;

        return await this._queryDeepSeek(systemPrompt, userPrompt);
    }

    /**
     * Performs a deep pre-match tactical preview for high-confidence VIP Millionaire selections.
     * Incorporates real-time news retrieved from Google Search via SerpApi.
     */
    async analyzePreMatchVIP(match, realTimeNews = '') {
        const systemPrompt = "Tu es le Directeur Quantitatif Principal de Titanium AI. Tu prépares des fiches tactiques ultra-pointues destinées à un club d'investisseurs professionnels.";

        const userPrompt = `
        Rédige une fiche d'évaluation stratégique pré-match pour la sélection VIP suivante :
        
        [DÉTAILS FIXTURE]
        - Affiche : ${match.homeTeam} vs ${match.awayTeam}
        - Championnat : ${match.tournament_name || 'Ligue'}
        
        [PROBABILITÉS BRUTES IA]
        - Victoire Domicile : ${(match.home_win_probability || 0).toFixed(1)}%
        - Match Nul : ${(match.draw_probability || 0).toFixed(1)}%
        - Victoire Extérieur : ${(match.away_win_probability || 0).toFixed(1)}%
        - Plus de 2.5 Buts (prob) : ${(match.ou_25_prob || 0).toFixed(1)}%
        - BTTS (Les deux marquent) : ${(match.btts_prob || 0).toFixed(1)}%
        - Confiance XGBoost Calibrée : ${(match.xgboost_confidence ? match.xgboost_confidence * 100 : 85).toFixed(0)}%
        
        [MOTIVATION & DYNAMIQUES DMF]
        - Domicile : Classement Pos #${match.home_position || 'N/A'}, DMF Zone: ${match.home_zone || 'Mid-Table'}, DMF Poids: ${match.home_target_weight || 0.0}
        - Extérieur : Classement Pos #${match.away_position || 'N/A'}, DMF Zone: ${match.away_zone || 'Mid-Table'}, DMF Poids: ${match.away_target_weight || 0.0}

        [ACTUALITÉS & INFOS DE DERNIÈRE MINUTE EN DIRECT (SERPAPI)]
        ${realTimeNews || 'Aucune actualité de dernière minute détectée sur Google.'}

        Rédige un briefing stratégique de match rigoureux en français. Explique le match-up tactique clé, l'impact des motivations DMF (course au titre, relégation, maintien), intègre impérativement les actualités de dernière minute (blessés, suspendus, retours clés de blessure cités ci-dessus) et l'alignement des cotes statistiques.

        Retourne obligatoirement ce format JSON :
        {
          "match_overview": "Présentation tactique globale de la fixture en français intégrant les infos de dernière minute importantes.",
          "tactical_keyup": "Quel est le duel ou la configuration tactique clé du match (ex: transition offensive vs bloc bas)?",
          "motivation_verdict": "Comment les objectifs DMF influencent l'engagement des deux équipes ?",
          "ai_prediction_validation": "Pourquoi la probabilité de l'IA (ex: Victoire Domicile ou Plus de 2.5 Buts) fait mathématiquement sens ici ?",
          "exact_score_prediction": "Score exact estimé (ex: 2-1, 1-0)",
          "risk_mitigation": "Un conseil de sécurité sur le pari (ex: Remboursé si Nul, Double chance, etc.)"
        }
        `;

        return await this._queryDeepSeek(systemPrompt, userPrompt);
    }

    /**
     * Performs a deep forensic AI autopsy on failed high-confidence predictions.
     */
    async analyzeFailedMatchAutopsy(failed) {
        const systemPrompt = "Tu es le Médecin Légiste Tactique Principal de Titanium AI, spécialisé dans l'autopsie post-match et la modélisation des biais de modélisation quantitative.";

        const userPrompt = `
        Effectue une autopsie tactique et psychologique rigoureuse de la prédiction échouée suivante :
        
        [MATCH CONTEXT]
        - Affiche : ${failed.homeTeam} vs ${failed.awayTeam}
        - Score Final : ${failed.score}
        - Pari Suggéré : ${failed.prediction}
        - Confiance IA Initiale : ${failed.confidence}%
        
        [SURGICAL STATISTICS]
        ${JSON.stringify(failed.stats || {})}
        
        [CRITICAL INCIDENTS (RED CARDS / GOALS / PENALTIES)]
        ${JSON.stringify(failed.incidents || [])}

        Rédige :
        1. Une analyse en arabe détaillée (arabic_autopsy) expliquant précisément l'échec (ex: arbitrage, indiscipline, manque de réalisme, tactique inadaptée, complaisance). Reste très professionnel, analytique et clair.
        2. Une courte synthèse tactique et mentale en français (french_tactical_summary) d'environ 3 phrases.
        3. Un indice de complaisance (complacency_rating) de 0 à 10 (ex: 8/10 si l'équipe favorite s'est relâchée ou n'avait aucun enjeu, 1/10 si c'est purement un incident de jeu comme un carton rouge inattendu).
        4. Le type d'erreur diagnostiqué (tactical_error_type) parmi : "POSSESSION_TRAP", "XG_WASTE", "GK_WALL", "SYSTEMIC_DEFENSIVE_FAILURE", "COMPLACENCY_TRAP", "RED_CARD_DISRUPTION", "NORMAL_VARIANCE".

        Retourne obligatoirement ce format JSON :
        {
          "arabic_autopsy": "Raison de l'échec rédigée en arabe littéraire fluide et expert.",
          "french_tactical_summary": "Résumé tactique et mental de l'échec rédigé en français.",
          "complacency_rating": 0, // number from 0 to 10
          "tactical_error_type": "La catégorie d'erreur la plus appropriée."
        }
        `;

        return await this._queryDeepSeek(systemPrompt, userPrompt);
    }
}

module.exports = new DeepSeekService();

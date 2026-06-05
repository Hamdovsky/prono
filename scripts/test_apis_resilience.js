require('dotenv').config();
const axios = require('axios');
const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');
const rapidApiQuotaManager = require('../services/rapidApiQuotaManager');
const footballDataService = require('../services/footballDataService');

async function runDiagnostics() {
    console.log('🧪 ============================================================');
    console.log('🧪      TITANIUM AI — RESILIENCE DIAGNOSTIC TEST PIPELINE      ');
    console.log('🧪 ============================================================');
    console.log(`⏰ Heure Serveur : ${new Date().toISOString()}`);
    console.log('');

    // 1. Quota Manager check
    console.log('📦 [1/5] VÉRIFICATION DU GESTIONNAIRE DE QUOTA RAPIDAPI...');
    const status = rapidApiQuotaManager.getQuotaStatus();
    console.log(`   - Statut Actif : ${status.isActive}`);
    console.log(`   - Date Courante : ${status.date}`);
    console.log(`   - Matchs Utilisés : ${status.used}/${status.limit}`);
    console.log(`   - Quota Restant : ${status.remaining} matches`);
    console.log('✅ Quota check OK.');
    console.log('');

    // 2. Probing RapidAPI
    console.log('📡 [2/5] DIAGNOSTIC SPORTAPI (RAPIDAPI)...');
    if (process.env.RAPIDAPI_ENABLED !== 'true') {
        console.log('   ⚠️ RapidAPI est désactivé dans .env');
    } else {
        const host = process.env.RAPIDAPI_HOST || 'sportapi7.p.rapidapi.com';
        const key = process.env.RAPIDAPI_KEY;
        const testUrl = `https://${host}/api/v1/sport/football/daily-event-count`;
        
        try {
            console.log(`   - Requête vers : ${testUrl}`);
            const response = await axios.get(testUrl, {
                headers: {
                    'x-rapidapi-host': host,
                    'x-rapidapi-key': key
                },
                timeout: 10000
            });
            console.log(`   ✅ Connexion SportAPI réussie (HTTP ${response.status})!`);
            console.log(`   - Données reçues (Daily counts) : ${JSON.stringify(response.data).substring(0, 150)}...`);
        } catch (e) {
            console.log(`   ❌ Connexion SportAPI Échouée : ${e.message}`);
            if (e.response) {
                console.log(`      Code HTTP : ${e.response.status}`);
            }
        }
    }
    console.log('');

    // 3. Probing FootballData.io fallback
    console.log('📡 [3/5] DIAGNOSTIC FOOTBALLDATA.IO (FALLBACK)...');
    if (process.env.FOOTBALLDATA_ENABLED !== 'true') {
        console.log('   ⚠️ FootballData est désactivé dans .env');
    } else {
        const host = process.env.FOOTBALLDATA_HOST || 'footballdata.io';
        const key = process.env.FOOTBALLDATA_KEY;
        const testUrl = `https://${host}/api/v1/fixtures/today`;
        
        try {
            console.log(`   - Requête vers : ${testUrl}`);
            const fixtures = await footballDataService.fetchTodayFixtures();
            console.log(`   ✅ Connexion FootballData réussie! Trouvé ${fixtures.length} matches.`);
            if (fixtures.length > 0) {
                console.log(`   - Exemple de match : ${fixtures[0].home_team.team_name} vs ${fixtures[0].away_team.team_name}`);
            }
        } catch (e) {
            console.log(`   ❌ Connexion FootballData Échouée : ${e.message}`);
        }
    }
    console.log('');

    // 4. Checking ELO and database resolution
    console.log('🗄️ [4/5] VÉRIFICATION DE LA RÉSOLUTION DE NOMS DE L\'ÉQUIPE...');
    try {
        const rawName = 'Real Madrid CF';
        const resolvedName = await database.resolveTeamName(rawName);
        console.log(`   - Entrée brute : "${rawName}" -> Résolu/Normalisé : "${resolvedName}"`);
        console.log('   ✅ Résolution Database OK.');
    } catch (e) {
        console.log(`   ❌ Échec Résolution Database : ${e.message}`);
    }
    console.log('');

    // 5. Test of Fast Quant Prediction Enrichment
    console.log('🧠 [5/5] TEST DE L\'ENRICHISSEMENT ET PRONOSTIC QUANT POISSON...');
    try {
        const mockMatch = {
            id: 'test_diag_99999',
            homeTeam: 'Arsenal',
            awayTeam: 'Chelsea',
            league: 'Premier League',
            status: 'scheduled',
            startTimestamp: Math.floor(Date.now() / 1000),
            timestamp: new Date().toISOString(),
            odds_home: 1.85,
            odds_draw: 3.60,
            odds_away: 3.80,
            home_xg: 1.82,
            away_xg: 1.15,
            source: 'test_diagnostic',
            insufficient_data: 0
        };

        // Insert
        await database.insertMatch(mockMatch);
        console.log('   - Match fictif inséré avec succès.');

        // Prediction
        const enriched = await enrichedPredictions.fastEnrichMatch(mockMatch);
        console.log(`   ✅ Prédictions quantitatives générées avec succès!`);
        console.log(`   - Verdict : ${enriched.verdict}`);
        console.log(`   - Expected Score : ${enriched.expected_score}`);
        console.log(`   - Probabilités Poisson : Domicile=${enriched.home_win_probability.toFixed(1)}% | Nul=${enriched.draw_probability.toFixed(1)}% | Extérieur=${enriched.away_win_probability.toFixed(1)}%`);
        console.log(`   - Plus de 2.5 Buts : ${enriched.ou_25_prob.toFixed(1)}% | BTTS : ${enriched.btts_prob.toFixed(1)}%`);

        // Save
        await database.updatePredictions(enriched.id, enriched);
        console.log('   - Prédictions enregistrées avec succès dans SQLite.');
        
        // Retrieve and delete test record to keep clean
        const check = await database.getMatchById(mockMatch.id);
        if (check) {
            console.log('   - Validation en lecture réussie.');
            database.db.prepare('DELETE FROM matches WHERE id = ?').run(mockMatch.id);
            console.log('   - Match de test supprimé proprement.');
        }

    } catch (e) {
        console.log(`   ❌ Échec Diagnostic Quant : ${e.message}`);
        console.error(e);
    }
    
    console.log('');
    console.log('🧪 ============================================================');
    console.log('🧪              DIAGNOSTIC DE RÉSILIENCE TERMINÉ               ');
    console.log('🧪 ============================================================');
}

runDiagnostics().catch(e => console.error('💥 Crash inattendu dans les diagnostics:', e));

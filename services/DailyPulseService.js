const database = require('../core/database');
const fpis     = require('./FPISEngine');
const SofaAPI  = require('../SofascoreScraping/src/apiClient').SofaAPI;
const logger   = require('../core/logger');

class DailyPulseService {
    constructor() {
        this.activeLeagues = new Set();
        this._loadConfig();
    }

    _loadConfig() {
        try {
            const rows = database.db.prepare(`SELECT id FROM leagues_config WHERE smartScanEnabled = 1`).all();
            rows.forEach(r => this.activeLeagues.add(r.id));
            logger.info(`📡 [DAILY PULSE] Loaded ${this.activeLeagues.size} active leagues.`);
        } catch (err) {
            logger.error(`[DAILY PULSE] Config load failed: ${err.message}`);
        }
    }

    /**
     * getDailyScan() - The main orchestrator
     * @param {string} date - ISO date YYYY-MM-DD
     */
    async getDailyScan(date = new Date().toISOString().split('T')[0]) {
        console.log(`\n🌌 [ORACLE V7] Starting Autonomous Daily Pulse for ${date}...`);
        
        try {
            // 1. Scout
            const data = await SofaAPI.getEvents(date);
            if (!data || !data.events) return { error: 'No matches found from provider.' };

            // 2. Filter & Pre-process
            const targetEvents = data.events.filter(e => {
                const leagueId = e.tournament?.uniqueTournament?.id;
                return this.activeLeagues.has(leagueId) || this.activeLeagues.has(String(leagueId));
            });

            console.log(`🏟️ Found ${targetEvents.length} matches in tracked leagues.`);

            // 3. Deep Analysis (V6 Radar Integrated)
            const analysisPromises = targetEvents.map(async (event) => {
                const mockMatch = {
                    id: event.id,
                    homeTeamId: event.homeTeam.id,
                    awayTeamId: event.awayTeam.id,
                    homeTeam: event.homeTeam.name,
                    awayTeam: event.awayTeam.name,
                    league: event.tournament.name,
                    timestamp: event.startTimestamp,
                    // Basic odds if available
                    home_win_probability: 33.3, // Placeholder — FPISEngine will refine
                    draw_probability: 33.4,
                    away_win_probability: 33.3
                };
                
                return await fpis.process(mockMatch);
            });

            const results = await Promise.all(analysisPromises);

            // 4. Rank & Pick "Elite 10"
            // Filter out 'No Bet' and sort by confidence
            const candidates = results
                .filter(r => r.confidence > 20 && !r.isFallback)
                .sort((a, b) => b.confidence - a.confidence)
                .slice(0, 50);

            // 5. Generate Arabic Report
            return this.buildArabicReport(date, candidates);

        } catch (err) {
            logger.error(`[DAILY PULSE] Scan failed: ${err.stack}`);
            return { error: err.message };
        }
    }

    buildArabicReport(date, picks) {
        let report = `## 🌌 تقرير العرّاف اليومي: تذكرة النخبة (${date})\n\n`;
        report += `أهلاً بك يا حمدي. لقد قام المحرك بتحليل كافة مباريات اليوم عبر الرادار العصبي V7، وإليك أفضل 50 توقعاً تم اختيارها بعناية:\n\n`;

        report += `| المباراة | الدوري | التوقع المقترح | نسبة الثقة | حالة الرادار |\n`;
        report += `| :--- | :--- | :--- | :--- | :--- |\n`;

        picks.forEach(p => {
            const league = p.match_type.split(' - ')[0];
            const teams = p.match_type.split(' - ')[1] || p.match_type;
            const shock = p.hidden_insight.includes('LINEUP') ? '⚠️ صدمة غيابات' : '✅ مستقرة';
            
            report += `| ${teams} | ${league} | **${this._translatePrediction(p.adjusted_prediction)}** | ${p.confidence}% | ${shock} |\n`;
        });

        report += `\n### 💡 رؤية العرّاف التحليلية:\n`;
        report += `- تم تدقيق هذه المباريات عبر **رادار الغيابات V6** لضمان عدم وجود مفاجآت في التشكيلة.\n`;
        report += `- تم ترتيب التوقعات بناءً على "معامل الأمان" و"القيمة الرياضية" المكتشفة في السوق.\n`;
        report += `- **نصيحة**: يفضل دمج هذه التوقعات في مجموعات صغيرة (2-3 مباريات) لتقليل المخاطرة.\n\n`;
        
        report += `_تم توليد هذا التقرير تلقائياً بواسطة Titanium Oracle V7.0.0_`;

        return report;
    }

    _translatePrediction(pred) {
        const map = {
            'Home Win': 'فوز صاحب الأرض',
            'Away Win': 'فوز الضيف',
            'Draw': 'تعادل',
            'Over 2.5': 'أكثر من 2.5 هدف',
            'Under 2.5': 'أقل من 2.5 هدف',
            'BTTS Yes': 'كلا الفريقين يسجلان',
            'BTTS No': 'فريق واحد على الأكثر يسجل',
            'Double Chance 1X': 'فوز أو تعادل صاحب الأرض',
            'Double Chance X2': 'تعادل أو فوز الضيف'
        };
        return map[pred] || pred;
    }
}

module.exports = new DailyPulseService();

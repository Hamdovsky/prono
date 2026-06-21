const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const enrichedService = require('./enriched_predictions.js');
const axios = require('axios');

const SOFA_API = 'https://www.sofascore.com/api/v1';
const SOFA_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
};

async function getMarketOdds(eventId) {
    try {
        const url = `${SOFA_API}/event/${eventId}/odds/1/all`;
        const res = await axios.get(url, { headers: SOFA_HEADERS, timeout: 5000 });
        const odds = res.data?.odds;
        if (!odds) return { home: 2.0, draw: 3.4, away: 3.8 }; // Default if hidden
        
        const main = odds.find(o => o.marketName === 'Full time');
        if (main && main.choices) {
            return {
                home: parseFloat(main.choices.find(c => c.name === '1')?.fractionalValue) || 2.0,
                draw: parseFloat(main.choices.find(c => c.name === 'X')?.fractionalValue) || 3.4,
                away: parseFloat(main.choices.find(c => c.name === '2')?.fractionalValue) || 3.8
            };
        }
        return { home: 2.0, draw: 3.4, away: 3.8 };
    } catch (e) {
        return { home: 2.0, draw: 3.4, away: 3.8 };
    }
}

function runTacticalEngine(matchData) {
    return new Promise((resolve) => {
        const py = spawn('python', ['tactical_lab_engine.py'], {
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });

        let output = '';
        py.stdout.on('data', (d) => output += d.toString());
        py.stderr.on('data', (d) => console.error(`[Engine Error]`, d.toString()));
        py.on('close', () => {
            try {
                resolve(JSON.parse(output));
            } catch (e) {
                resolve({ success: false, error: 'Parse Error', raw: output });
            }
        });

        py.stdin.write(JSON.stringify(matchData));
        py.stdin.end();
    });
}

async function main() {
    console.log("🚀 جاري تفعيل Tactical Lab Deep Engine لليوم...");

    if (!fs.existsSync('sofa_events.json')) {
        console.error("❌ ملف sofa_events.json غير موجود. يرجى تشغيل dump_sofa_scheduled.js أولاً.");
        return;
    }

    const data = JSON.parse(fs.readFileSync('sofa_events.json'));
    const candidates = data.events; // Process all events discovered in the dump
    
    console.log(`📊 تم العثور على ${candidates.length} مباراة للتحليل التكتيكي الشامل.`);

    const reports = [];

    for (const m of candidates) {
        console.log(`🔍 جاري تحليل: ${m.homeTeam.name} vs ${m.awayTeam.name}...`);
        
        try {
            // Robust check for IDs
            const utId = m.tournament?.uniqueTournament?.id;
            const sId = m.tournament?.uniqueTournament?.activeSeason?.id;
            
            let homeStats = null;
            let awayStats = null;

            if (utId && sId) {
                homeStats = await enrichedService.fetchSofaTeamStats(m.homeTeam.id, utId, sId);
                awayStats = await enrichedService.fetchSofaTeamStats(m.awayTeam.id, utId, sId);
            } else {
                console.warn(`⚠️ Missing IDs for ${m.homeTeam.name} vs ${m.awayTeam.name}. Using defaults.`);
            }

            const odds = await getMarketOdds(m.id);

            const matchInput = {
                id: m.id,
                homeTeam: m.homeTeam.name,
                awayTeam: m.awayTeam.name,
                league: m.tournament.name,
                teamStats: { home: homeStats, away: awayStats },
                odds: odds
            };

            const result = await runTacticalEngine(matchInput);
            if (result.success) {
                reports.push(result);
            } else {
                console.error(`❌ Engine failed for ${m.homeTeam.name}: ${result.error}`);
                if (result.trace) console.error(result.trace);
            }
        } catch (e) {
            console.error(`⚠️ فشل تحليل ${m.homeTeam.name}: ${e.message}`);
        }
    }

    if (reports.length === 0) {
        fs.writeFileSync('tactical_lab_final_report.txt', "No reports generated. Check terminal for errors.", 'utf8');
        return;
    }

    // Rank by Confidence
    reports.sort((a, b) => b.verdict.confidence - a.verdict.confidence);

    let finalOutput = "\n" + "=".repeat(60) + "\n";
    finalOutput += "🏆 تقرير Tactical Lab Deep Engine النهائي (مرتب حسب الثقة)\n";
    finalOutput += "=".repeat(60) + "\n\n";

    reports.forEach((r, i) => {
        finalOutput += `${i + 1}. [${r.home} vs ${r.away}]\n`;
        finalOutput += `   🧬 Tactical DNA: ${r.tactical_dna.description}\n`;
        finalOutput += `   💥 Pressure Impact: احتمالية خطأ كارثي ${r.pressure_impact.catastrophic_prob}% | ${r.pressure_impact.description}\n`;
        finalOutput += `   💎 Market Value Gap: True Value = ${r.true_value}% (بناءً على 10,000 محاكاة)\n`;
        finalOutput += `   🎯 التوصيات:\n`;
        r.recommendations.forEach(rec => {
            finalOutput += `      - ${rec.market}: ${rec.bet} (ثقة: ${rec.confidence}/10)\n`;
        });
        finalOutput += `   ✅ Verdict: ${r.verdict.type} + [ثقة: ${r.verdict.confidence}] + ${r.verdict.reason}\n`;
        finalOutput += "-".repeat(40) + "\n";
    });

    console.log(finalOutput);
    fs.writeFileSync('tactical_lab_final_report.txt', finalOutput, 'utf8');
    console.log("✅ تم حفظ التقرير في tactical_lab_final_report.txt");
}

main();

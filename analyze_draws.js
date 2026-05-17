const db = require('./core/database').db;

// 1. نسبة التعادلات الفعلية لكل دوري
const drawsByLeague = db.prepare(`
    SELECT league, 
           COUNT(*) as total,
           SUM(CASE WHEN actual = 'D' THEN 1 ELSE 0 END) as draws,
           ROUND(SUM(CASE WHEN actual = 'D' THEN 1.0 ELSE 0 END) / COUNT(*), 3) as draw_rate
    FROM learning_memory
    WHERE actual IS NOT NULL
    GROUP BY league
    HAVING total >= 20
    ORDER BY draw_rate DESC
    LIMIT 15
`).all();

console.log('\n=== نسبة التعادلات لكل دوري ===');
drawsByLeague.forEach(r => console.log(`${r.league} | نسبة: ${(r.draw_rate*100).toFixed(1)}% | عدد: ${r.draws}/${r.total}`));

// 2. الأسباب الجذرية للأخطاء عند التنبؤ بالتعادلات الصحيحة
const drawPatterns = db.prepare(`
    SELECT root_cause, error_type,
           COUNT(*) as count,
           ROUND(AVG(confidence), 1) as avg_conf
    FROM learning_memory
    WHERE actual = 'D'
    GROUP BY root_cause, error_type
    ORDER BY count DESC
    LIMIT 15
`).all();

console.log('\n=== أنماط الأسباب عند التعادل ===');
drawPatterns.forEach(r => console.log(`${r.root_cause} | ${r.error_type} | عدد: ${r.count} | ثقة متوسط: ${r.avg_conf}%`));

// 3. الأنماط التي أشارت بشكل خاطئ لفوز بينما كانت النتيجة تعادلاً (الفرصة الذهبية)
const missedDraws = db.prepare(`
    SELECT league, root_cause, prediction,
           COUNT(*) as missed,
           ROUND(AVG(confidence), 1) as avg_conf
    FROM learning_memory
    WHERE actual = 'D' AND prediction NOT LIKE '%draw%' AND prediction NOT LIKE '%nul%' AND prediction NOT LIKE '%X%'
    GROUP BY league, root_cause
    HAVING missed >= 5
    ORDER BY missed DESC
    LIMIT 15
`).all();

console.log('\n=== حالات فات فيها التعادل (خسائر يمكن استخلاص أنماط) ===');
missedDraws.forEach(r => console.log(`${r.league} | ${r.root_cause} | فاتت: ${r.missed} مرة | ثقة: ${r.avg_conf}%`));

// 4. ظروف الملعب: التعادلات حسب عامل المفاجأة
const drawsBySurprise = db.prepare(`
    SELECT 
        CASE 
            WHEN context LIKE '%fatigue%' THEN 'إجهاد'
            WHEN context LIKE '%Derby%' THEN 'ديربي/كأس'
            WHEN context LIKE '%high-scoring%' THEN 'مباراة هجومية'
            WHEN context LIKE '%favourite%' THEN 'المفضل يخسر'
            ELSE 'عادية'
        END as situation,
        COUNT(*) as draws,
        ROUND(AVG(confidence), 1) as avg_conf
    FROM learning_memory
    WHERE actual = 'D'
    GROUP BY situation
    ORDER BY draws DESC
`).all();

console.log('\n=== التعادلات حسب السياق ===');
drawsBySurprise.forEach(r => console.log(`${r.situation} | عدد: ${r.draws} | ثقة: ${r.avg_conf}%`));

// 5. قواعد مستنتجة مرتبطة بالتعادلات
const drawRules = db.prepare(`
    SELECT rule_type, condition, action, confidence, SUM(hit_count) as total_hits
    FROM learning_rules
    WHERE condition LIKE '%tied%' OR action LIKE '%draw%' OR rule_type LIKE '%LATE%' OR rule_type LIKE '%POSSESSION%'
    GROUP BY rule_type, condition, action
    ORDER BY total_hits DESC
    LIMIT 10
`).all();

console.log('\n=== القواعد المستنتجة المرتبطة بالتعادل ===');
drawRules.forEach(r => console.log(`${r.rule_type} | ${r.condition} | ثقة: ${(r.confidence*100).toFixed(0)}% | تكرار: ${r.total_hits}`));

// 6. المباريات القادمة المجدولة
const upcoming = db.prepare(`
    SELECT id, homeTeam, awayTeam, league, startTimestamp,
           home_win_probability, draw_probability, away_win_probability,
           odds_home, odds_draw, odds_away, confidence, prediction,
           expected_score, league_tier
    FROM matches
    WHERE status IN ('scheduled', 'NOT_STARTED', 'NS')
      AND startTimestamp > strftime('%s', 'now')
      AND startTimestamp < strftime('%s', 'now', '+2 days')
    ORDER BY startTimestamp ASC
    LIMIT 100
`).all();

console.log(`\n=== المباريات القادمة: ${upcoming.length} مباراة ===`);
upcoming.slice(0, 5).forEach(m => {
    const dp = parseFloat(m.draw_probability || 0);
    console.log(`${m.homeTeam} vs ${m.awayTeam} | ${m.league} | draw_prob: ${(dp*100).toFixed(1)}% | cote_X: ${m.odds_draw || 'N/A'}`);
});

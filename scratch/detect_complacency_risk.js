const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');

console.log("🕵️ ANALYSIS: TEAMS NOT RESPECTING THE 'FIFA LAW' (COMPLACENCY RISK) 🕵️");
console.log("====================================================================\n");

try {
    // 1. Identify teams that failed in "Dead Zone" scenarios or had "XG_WASTE" in suspicious contexts
    const riskyTeams = db.prepare(`
        SELECT 
            team,
            COUNT(*) as total_failures,
            SUM(CASE WHEN root_cause IN ('POSSESSION_TRAP', 'XG_ANOMALY', 'NORMAL_VARIANCE', 'STRUCTURAL_TEAM_WEAKNESS') THEN 1 ELSE 0 END) as suspicious_points,
            GROUP_CONCAT(DISTINCT league) as leagues
        FROM (
            SELECT home_team as team, root_cause, league FROM learning_memory WHERE error_type = 'OVERESTIMATED_FACTOR'
            UNION ALL
            SELECT away_team as team, root_cause, league FROM learning_memory WHERE error_type = 'OVERESTIMATED_FACTOR'
        )
        GROUP BY team
        HAVING total_failures >= 2
        ORDER BY suspicious_points DESC
        LIMIT 30
    `).all();

    if (riskyTeams.length === 0) {
        console.log("No clear patterns of non-respect found yet in learning memory.");
    } else {
        console.table(riskyTeams.map(t => ({
            "Equipe": t.team,
            "Ligue": t.leagues.split(',')[0],
            "Défaillances": t.total_failures,
            "Indice Complaisance": ((t.suspicious_points / t.total_failures) * 10).toFixed(1) + "/10"
        })));
    }

    console.log("\n⚠️ NOTE: Un indice élevé signifie que l'équipe perd souvent malgré des stats correctes ou dans des zones de faible enjeu.");

} catch (e) {
    console.error("Error:", e.message);
} finally {
    db.close();
}

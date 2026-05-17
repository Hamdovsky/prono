const Database = require('better-sqlite3');
const { spawn } = require('child_process');
const path = require('path');

const db = new Database('./data/tactical.db');
const matchId = '16138826';
const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);

if (!match) {
    console.log('Match not found');
    process.exit(1);
}

// Prepare payload (minimal for testing)
const payload = {
    id: match.id,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    league: match.league,
    teamStats: JSON.parse(match.teamStats || '{}'),
    form_context: JSON.parse(match.form_context || '{}'),
    historical_context: JSON.parse(match.historical_context || '{}'),
    odds: { home: match.odds_home, draw: match.odds_draw, away: match.odds_away },
    home_xg: match.home_xg,
    away_xg: match.away_xg,
    status: match.status
};

console.log(`--- ANALYZING: ${match.homeTeam} vs ${match.awayTeam} ---`);

const pythonProcess = spawn('python', ['core/python_worker.py'], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONPATH: process.cwd() }
});

pythonProcess.stdout.on('data', (data) => {
    const output = data.toString().trim();
    if (output === 'READY') {
        pythonProcess.stdin.write(JSON.stringify(payload) + '\n');
    } else {
        try {
            const result = JSON.parse(output);
            console.log('\n--- AI RESULT ---');
            console.log('Success:', result.success);
            if (result.success) {
                console.log('Verdict:', result.verdict);
                console.log('H:', (result.home_win_probability * 100).toFixed(1) + '%');
                console.log('D:', (result.draw_probability * 100).toFixed(1) + '%');
                console.log('A:', (result.away_win_probability * 100).toFixed(1) + '%');
                console.log('Score:', result.expected_score);
                console.log('Confidence:', result.xgboost_confidence.toFixed(2));
            } else {
                console.log('Error:', result.error);
            }
            pythonProcess.kill();
        } catch (e) {
            console.log('Raw output:', output);
        }
    }
});

pythonProcess.stderr.on('data', (data) => {
    console.error('Python Stderr:', data.toString());
});

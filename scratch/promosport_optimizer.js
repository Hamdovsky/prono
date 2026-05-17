
// const math = require('mathjs');

const matches = [
    { index: 1, home: "Atletico Madrid", away: "Arsenal", comp: "Champions League SF", p1: 0.38, px: 0.30, p2: 0.32, market_p1: 0.45, market_px: 0.28, market_p2: 0.27 },
    { index: 2, home: "Braga", away: "Freiburg", comp: "Europa League", p1: 0.45, px: 0.28, p2: 0.27, market_p1: 0.50, market_px: 0.25, market_p2: 0.25 },
    { index: 3, home: "Nottingham Forest", away: "Aston Villa", comp: "Premier League", p1: 0.25, px: 0.27, p2: 0.48, market_p1: 0.20, market_px: 0.25, market_p2: 0.55 },
    { index: 4, home: "Rayo Vallecano", away: "Strasbourg", comp: "Friendly/Int", p1: 0.40, px: 0.30, p2: 0.30, market_p1: 0.42, market_px: 0.30, market_p2: 0.28 },
    { index: 5, home: "Shakhtar", away: "Crystal Palace", comp: "International", p1: 0.33, px: 0.30, p2: 0.37, market_p1: 0.30, market_px: 0.30, market_p2: 0.40 },
    { index: 6, home: "Al Nassr FC", away: "Al Ahli", comp: "Saudi Pro League", p1: 0.55, px: 0.22, p2: 0.23, market_p1: 0.70, market_px: 0.15, market_p2: 0.15 },
    { index: 7, home: "FAR Rabat", away: "Raja Casablanca", comp: "Botola Pro", p1: 0.35, px: 0.35, p2: 0.30, market_p1: 0.40, market_px: 0.30, market_p2: 0.30 },
    { index: 8, home: "Esperance", away: "CS. Sfaxien", comp: "Tunisian Ligue 1", p1: 0.45, px: 0.35, p2: 0.20, market_p1: 0.60, market_px: 0.30, market_p2: 0.10 },
    { index: 9, home: "JS. Kairouanaise", away: "Ben Guerdane", comp: "Tunisian Ligue 1", p1: 0.30, px: 0.40, p2: 0.30, market_p1: 0.35, market_px: 0.40, market_p2: 0.25 },
    { index: 10, home: "O. Beja", away: "C.A. Bizertin", comp: "Tunisian Ligue 1", p1: 0.40, px: 0.35, p2: 0.25, market_p1: 0.45, market_px: 0.30, market_p2: 0.25 },
    { index: 11, home: "Universitario", away: "Nacional", comp: "Copa Libertadores", p1: 0.42, px: 0.30, p2: 0.28, market_p1: 0.40, market_px: 0.30, market_p2: 0.30 },
    { index: 12, home: "Cerro Porteno", away: "Palmeiras", comp: "Copa Libertadores", p1: 0.25, px: 0.30, p2: 0.45, market_p1: 0.20, market_px: 0.25, market_p2: 0.55 },
    { index: 13, home: "Estudiantes", away: "Flamengo", comp: "Copa Libertadores", p1: 0.30, px: 0.30, p2: 0.40, market_p1: 0.25, market_px: 0.30, market_p2: 0.45 }
];

function calculateEntropy(p1, px, p2) {
    const log = (p) => p > 0 ? Math.log2(p) : 0;
    return -(p1 * log(p1) + px * log(px) + p2 * log(p2));
}

// 1. Process matches
matches.forEach(m => {
    m.entropy = calculateEntropy(m.p1, m.px, m.p2);
    
    // DC analysis
    const dcOptions = [
        { label: '1X', p: m.p1 + m.px, simple: Math.max(m.p1, m.px) },
        { label: 'X2', p: m.px + m.p2, simple: Math.max(m.px, m.p2) },
        { label: '12', p: m.p1 + m.p2, simple: Math.max(m.p1, m.p2) }
    ];
    
    m.best_dc = dcOptions.reduce((prev, curr) => (curr.p > prev.p ? curr : prev));
    m.score_dc = (m.best_dc.p / m.best_dc.simple) * m.entropy;
    
    // Value analysis
    m.value1 = m.p1 / m.market_p1;
    m.valueX = m.px / m.market_px;
    m.value2 = m.p2 / m.market_p2;
});

// 2. Select 5 DC candidates
const sortedByDC = [...matches].sort((a, b) => b.score_dc - a.score_dc);
const dcIndices = sortedByDC.slice(0, 5).map(m => m.index);

// 3. Simulation & EV Logic
function runSimulation(grid, iterations = 10000) {
    let wins13 = 0;
    let wins12 = 0;
    let totalEV = 0;
    const baseMise = 1; // 1 unit

    for (let i = 0; i < iterations; i++) {
        let correct = 0;
        let gridProb = 1;
        let marketGridProb = 1;

        grid.forEach(m => {
            // Choice can be a single (1, X, 2) or DC (1X, X2, 12)
            const matchData = matches.find(md => md.index === m.index);
            let p_covered = 0;
            let p_market_covered = 0;
            
            if (m.choice === '1') { p_covered = matchData.p1; p_market_covered = matchData.market_p1; }
            else if (m.choice === 'X') { p_covered = matchData.px; p_market_covered = matchData.market_px; }
            else if (m.choice === '2') { p_covered = matchData.p2; p_market_covered = matchData.market_p2; }
            else if (m.choice === '1X') { p_covered = matchData.p1 + matchData.px; p_market_covered = matchData.market_p1 + matchData.market_px; }
            else if (m.choice === 'X2') { p_covered = matchData.px + matchData.p2; p_market_covered = matchData.market_px + matchData.market_p2; }
            else if (m.choice === '12') { p_covered = matchData.p1 + matchData.p2; p_market_covered = matchData.market_p1 + matchData.market_p2; }

            gridProb *= p_covered;
            marketGridProb *= p_market_covered;

            // Monte Carlo check for this iteration
            const r = Math.random();
            if (r < matchData.p1) { if (m.choice.includes('1')) correct++; }
            else if (r < matchData.p1 + matchData.px) { if (m.choice.includes('X')) correct++; }
            else { if (m.choice.includes('2')) correct++; }
        });

        if (correct === 13) wins13++;
        if (correct === 12) wins12++;

        // EV estimation logic
        // Gain depends on how many other winners there are (marketGridProb)
        // Expected gain for 13/13 = Jackpot / (1 + (iterations * marketGridProb))
        // For simplicity in this script, we'll use a relative Value factor
        const valueFactor = gridProb / (marketGridProb || 0.000001);
        totalEV += (correct === 13 ? 100000 * valueFactor : (correct === 12 ? 1000 * valueFactor : 0));
    }

    return {
        prob13: wins13 / iterations,
        prob12: wins12 / iterations,
        avgEV: (totalEV / iterations) - baseMise,
        roi: (totalEV / iterations) / baseMise
    };
}

// 4. Generate Grids
function getGrid(type) {
    return matches.map(m => {
        const isDC = dcIndices.includes(m.index);
        let choice = '';
        
        if (type === 'balanced') {
            if (isDC) choice = m.best_dc.label;
            else {
                const choices = ['1', 'X', '2'];
                const probs = [m.p1, m.px, m.p2];
                choice = choices[probs.indexOf(Math.max(...probs))];
            }
        } else if (type === 'high_value') {
            const values = [m.value1, m.valueX, m.value2];
            const choices = ['1', 'X', '2'];
            if (isDC) {
                // For DC in high value, pick the one with best combined value
                const dcOptions = [
                    { label: '1X', v: m.value1 + m.valueX },
                    { label: 'X2', v: m.valueX + m.value2 },
                    { label: '12', v: m.value1 + m.value2 }
                ];
                choice = dcOptions.reduce((prev, curr) => (curr.v > prev.v ? curr : prev)).label;
            } else {
                choice = choices[values.indexOf(Math.max(...values))];
            }
        } else if (type === 'secure') {
            if (isDC) choice = m.best_dc.label;
            else {
                const choices = ['1', 'X', '2'];
                const probs = [m.p1, m.px, m.p2];
                choice = choices[probs.indexOf(Math.max(...probs))];
            }
        } else if (type === 'anti_crowd') {
            const crowdBias = [m.market_p1, m.market_px, m.market_p2];
            const choices = ['1', 'X', '2'];
            if (isDC) {
                const dcOptions = [
                    { label: '1X', crowd: m.market_p1 + m.market_px },
                    { label: 'X2', crowd: m.market_px + m.market_p2 },
                    { label: '12', crowd: m.market_p1 + m.market_p2 }
                ];
                // Pick DC with LEAST crowd probability
                choice = dcOptions.reduce((prev, curr) => (curr.crowd < prev.crowd ? curr : prev)).label;
            } else {
                // Pick outcome with LEAST crowd probability
                choice = choices[crowdBias.indexOf(Math.min(...crowdBias))];
            }
        }
        
        return { index: m.index, home: m.home, away: m.away, choice, p: m.p1, px: m.px, p2: m.p2, entropy: m.entropy };
    });
}

const gridTypes = ['balanced', 'high_value', 'secure', 'anti_crowd'];
const results = {};

gridTypes.forEach(type => {
    const grid = getGrid(type);
    results[type] = {
        grid,
        stats: runSimulation(grid)
    };
});

console.log(JSON.stringify({ matches, dcIndices, results }, null, 2));



const matches = [
    { id: 1, home: "Atletico Madrid", away: "Arsenal", h_stats: [98, 29, 23, 150], a_stats: [88, 39, 51, 178] },
    { id: 2, home: "Braga", away: "Freiburg", h_stats: [14, 5, 9, 28], a_stats: [12, 10, 18, 40] },
    { id: 3, home: "Nottingham Forest", away: "Aston Villa", h_stats: [21, 15, 30, 66], a_stats: [38, 24, 47, 109] },
    { id: 4, home: "Rayo Vallecano", away: "Strasbourg", h_stats: [25, 14, 25, 64], a_stats: [11, 5, 9, 25] },
    { id: 5, home: "Shakhtar", away: "Crystal Palace", h_stats: [10, 6, 10, 26], a_stats: [37, 25, 35, 97] },
    { id: 6, home: "Al Nassr FC", away: "Al Ahli", h_stats: [1, 0, 1, 2], a_stats: [0, 0, 0, 0] },
    { id: 7, home: "FAR Rabat", away: "Raja Casablanca", h_stats: [2, 0, 0, 2], a_stats: [2, 1, 0, 3] },
    { id: 8, home: "Esperance", away: "CS. Sfaxien", h_stats: [7, 4, 6, 17], a_stats: [3, 3, 3, 9] },
    { id: 9, home: "JS. Kairouanaise", away: "Ben Guerdane", h_stats: [1, 2, 0, 3], a_stats: [2, 1, 3, 6] },
    { id: 10, home: "O. Beja", away: "C.A. Bizertin", h_stats: [0, 1, 1, 2], a_stats: [1, 2, 2, 5] },
    { id: 11, home: "Universitario", away: "Nacional", h_stats: [0, 0, 0, 0], a_stats: [2, 1, 0, 3] },
    { id: 12, home: "Cerro Porteno", away: "Palmeiras", h_stats: [0, 1, 2, 3], a_stats: [15, 5, 7, 27] },
    { id: 13, home: "Estudiantes", away: "Flamengo", h_stats: [1, 1, 1, 3], a_stats: [13, 7, 6, 26] }
];

function calculateProbs(m) {
    const h_total = m.h_stats[3] || 1;
    const a_total = m.a_stats[3] || 1;
    
    // P1 approx = (HomeWinRate + AwayLossRate) / 2
    let p1 = ((m.h_stats[0]/h_total) + (m.a_stats[2]/a_total)) / 2;
    // P2 approx = (HomeLossRate + AwayWinRate) / 2
    let p2 = ((m.h_stats[2]/h_total) + (m.a_stats[0]/a_total)) / 2;
    // PX approx = (HomeDrawRate + AwayDrawRate) / 2
    let px = ((m.h_stats[1]/h_total) + (m.a_stats[1]/a_total)) / 2;
    
    // Normalize
    const sum = p1 + p2 + px;
    p1 /= sum;
    p2 /= sum;
    px /= sum;
    
    return { p1, px, p2 };
}

function shannonEntropy(p1, px, p2) {
    const log2 = (x) => x > 0 ? Math.log2(x) : 0;
    return -(p1 * log2(p1) + px * log2(px) + p2 * log2(p2));
}

const results = matches.map(m => {
    const { p1, px, p2 } = calculateProbs(m);
    const entropy = shannonEntropy(p1, px, p2);
    
    // Coverage of DCs
    const dc1X = p1 + px;
    const dcX2 = px + p2;
    const dc12 = p1 + p2;
    
    return {
        id: m.id,
        teams: `${m.home} vs ${m.away}`,
        p1, px, p2,
        entropy,
        dc1X, dcX2, dc12
    };
});

console.log(JSON.stringify(results, null, 2));

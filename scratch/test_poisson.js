function poissonProb(lambda, k) {
    const factorials = [1, 1, 2, 6, 24, 120, 720];
    return (Math.pow(lambda, k) * Math.exp(-lambda)) / (factorials[k] || 720);
}

function computePoisson(hXG, aXG) {
    const adjH = Math.max(0.3, hXG * 1.12); // home advantage
    const adjA = Math.max(0.3, aXG);
    let pH = 0, pD = 0, pA = 0;
    for (let h = 0; h <= 6; h++) {
        for (let a = 0; a <= 6; a++) {
            const p = poissonProb(adjH, h) * poissonProb(adjA, a);
            if (h > a) pH += p;
            else if (h === a) pD += p;
            else pA += p;
        }
    }
    const total = pH + pD + pA;
    const expectedGoals = adjH + adjA;
    const ou25 = Math.min(92, Math.round((1 - poissonProb(adjH, 0) * poissonProb(adjA, 0)
        - poissonProb(adjH, 0) * poissonProb(adjA, 1)
        - poissonProb(adjH, 1) * poissonProb(adjA, 0)
        - poissonProb(adjH, 0) * poissonProb(adjA, 2)
        - poissonProb(adjH, 2) * poissonProb(adjA, 0)
        - poissonProb(adjH, 1) * poissonProb(adjA, 1)) * 100));
    const btts = Math.min(88, Math.round((1 - poissonProb(adjH, 0)) * (1 - poissonProb(adjA, 0)) * 100));
    return {
        home: Math.round((pH / total) * 100),
        draw: Math.round((pD / total) * 100),
        away: Math.round((pA / total) * 100),
        ou25: ou25,
        btts: btts
    };
}

const p = computePoisson(1.5, 2.25);
console.log(JSON.stringify(p, null, 2));

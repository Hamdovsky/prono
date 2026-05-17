/**
 * TITANIUM PROMOSPORT UTILS v1.0
 * Algorithms for Reduced Systems (Systèmes Réduits)
 */

/**
 * Generates an N-1 Reduced System for 7 Double Chances
 * Full system = 128 cols, N-1 = 16 cols.
 * Guarantee: If 13/13 in base, at least 12/13 in one column.
 */
export const generateReduced7Doubles = (basePicks) => {
    // Standard Covering Design Matrix for 7 variables (Double Choices)
    // 0 = Pick 1, 1 = Pick 2
    const matrix = [
        [0,0,0,0,0,0,0],
        [0,0,0,1,1,1,1],
        [0,1,1,0,0,1,1],
        [0,1,1,1,1,0,0],
        [1,0,1,0,1,0,1],
        [1,0,1,1,0,1,0],
        [1,1,0,0,1,1,0],
        [1,1,0,1,0,0,1],
        // Extending to 16 for better coverage
        [0,0,1,0,1,1,0],
        [0,0,1,1,0,0,1],
        [0,1,0,0,1,0,1],
        [0,1,0,1,0,1,0],
        [1,0,0,0,0,1,1],
        [1,0,0,1,1,0,0],
        [1,1,1,0,0,0,0],
        [1,1,1,1,1,1,1]
    ];

    const columns = matrix.map(row => {
        let doubleIdx = 0;
        return basePicks.map(p => {
            if (p.includes('X') || p.length > 1) {
                // It's a double. Map matrix 0/1 to the two choices
                const choices = p.split(''); // e.g. "1X" -> ["1", "X"]
                const pick = choices[row[doubleIdx]] || choices[0];
                doubleIdx++;
                return pick;
            }
            return p; // Single pick
        });
    });

    return columns;
};

/**
 * Entropy-based Double Selection
 * Selects the 5 or 7 most uncertain matches
 */
export const selectBestDoubles = (matches, count = 5) => {
    return [...matches]
        .sort((a, b) => {
            const hA = calculateEntropy(a.probs.h, a.probs.x, a.probs.a);
            const hB = calculateEntropy(b.probs.h, b.probs.x, b.probs.a);
            return hB - hA;
        })
        .slice(0, count)
        .map(m => m.id);
};

const calculateEntropy = (h, x, a) => {
    const ph = h / 100 || 0.01;
    const px = x / 100 || 0.01;
    const pa = a / 100 || 0.01;
    return -(ph * Math.log2(ph) + px * Math.log2(px) + pa * Math.log2(pa));
};

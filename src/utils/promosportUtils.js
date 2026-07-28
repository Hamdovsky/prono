/**
 * TITANIUM PROMOSPORT UTILS v1.0
 * Algorithms for Reduced Systems (Systèmes Réduits)
 */

/**
 * Generates an N-1 Reduced System for 7 Double Chances
 * Full system = 128 cols, N-1 = 16 cols.
 * Guarantee: If 13/13 in base, at least 12/13 in one column.
 */
const COLUMN_PRICE = 0.85

/**
 * Auto-adapted reduced system generator
 * Picks the best reduction level (full / N-1 / N-2) to fit maxBudget TND
 * Returns { columns, numCols, cost, systemType, description }
 */
export const generateAutoSystem = (basePicks, maxBudget = 100) => {
  const doubleCount = basePicks.filter((p) => p.length > 1).length
  const fullCols = Math.pow(2, doubleCount)

  // Find best reduction level
  const levels = [
    { type: 'INTÉGRAL', divisor: 1, min: 2 },
    { type: 'N-1', divisor: 8, min: 2 },
    { type: 'N-2', divisor: 16, min: 2 },
  ]

  let chosen = levels[0]
  for (const level of levels) {
    const cols = Math.max(level.min, Math.round(fullCols / level.divisor))
    const cost = cols * COLUMN_PRICE * 1.06 // +6% tax
    if (cost <= maxBudget) {
      chosen = level
      break
    }
  }

  let numCols = Math.max(chosen.min, Math.round(fullCols / chosen.divisor))
  const cost = numCols * COLUMN_PRICE * 1.06
  const columns = generateColumns(basePicks, doubleCount, numCols)

  return {
    columns,
    numCols,
    cost: Math.round(cost * 100) / 100,
    systemType: chosen.type,
    doubleCount,
    fullCols,
    description: `${numCols} colonnes × ${COLUMN_PRICE} DT = ${(numCols * COLUMN_PRICE).toFixed(3)} DT + taxes = ${Math.round(cost * 100) / 100} DT`,
  }
}

function generateColumns(basePicks, doubleCount, numCols) {
  if (doubleCount === 0) return [basePicks]

  const matrix = buildReducedMatrix(doubleCount, numCols)
  const columns = matrix.map((row) => {
    let doubleIdx = 0
    return basePicks.map((p) => {
      if (p.length > 1) {
        const choices = p.split('')
        const pick = choices[row[doubleIdx]] || choices[0]
        doubleIdx++
        return pick
      }
      return p
    })
  })
  return columns
}

function buildReducedMatrix(doubleCount, numCols) {
  const fullCols = Math.pow(2, doubleCount)
  const matrix = []

  // Generate all binary combinations
  const fullMatrix = []
  for (let i = 0; i < fullCols; i++) {
    const row = []
    for (let j = 0; j < doubleCount; j++) {
      row.push((i >> j) & 1)
    }
    fullMatrix.push(row)
  }

  // Pick evenly distributed rows
  if (numCols >= fullCols) return fullMatrix

  const step = fullCols / numCols
  for (let i = 0; i < numCols; i++) {
    const idx = Math.min(Math.round(i * step), fullCols - 1)
    matrix.push(fullMatrix[idx])
  }

  return matrix
}

export const generateReduced7Doubles = (basePicks) => {
  // Standard Covering Design Matrix for 7 variables (Double Choices)
  // 0 = Pick 1, 1 = Pick 2
  const matrix = [
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 1, 1, 1],
    [0, 1, 1, 0, 0, 1, 1],
    [0, 1, 1, 1, 1, 0, 0],
    [1, 0, 1, 0, 1, 0, 1],
    [1, 0, 1, 1, 0, 1, 0],
    [1, 1, 0, 0, 1, 1, 0],
    [1, 1, 0, 1, 0, 0, 1],
    // Extending to 16 for better coverage
    [0, 0, 1, 0, 1, 1, 0],
    [0, 0, 1, 1, 0, 0, 1],
    [0, 1, 0, 0, 1, 0, 1],
    [0, 1, 0, 1, 0, 1, 0],
    [1, 0, 0, 0, 0, 1, 1],
    [1, 0, 0, 1, 1, 0, 0],
    [1, 1, 1, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 1, 1],
  ]

  const columns = matrix.map((row) => {
    let doubleIdx = 0
    return basePicks.map((p) => {
      if (p.includes('X') || p.length > 1) {
        // It's a double. Map matrix 0/1 to the two choices
        const choices = p.split('') // e.g. "1X" -> ["1", "X"]
        const pick = choices[row[doubleIdx]] || choices[0]
        doubleIdx++
        return pick
      }
      return p // Single pick
    })
  })

  return columns
}

/**
 * Entropy-based Double Selection
 * Selects the 5 or 7 most uncertain matches
 */
export const selectBestDoubles = (matches, count = 5) => {
  return [...matches]
    .sort((a, b) => {
      const hA = calculateEntropy(a.probs.h, a.probs.x, a.probs.a)
      const hB = calculateEntropy(b.probs.h, b.probs.x, b.probs.a)
      return hB - hA
    })
    .slice(0, count)
    .map((m) => m.id)
}

const calculateEntropy = (h, x, a) => {
  const ph = h / 100 || 0.01
  const px = x / 100 || 0.01
  const pa = a / 100 || 0.01
  return -(ph * Math.log2(ph) + px * Math.log2(px) + pa * Math.log2(pa))
}

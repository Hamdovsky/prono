const API_BASE = process.env.REACT_APP_API_URL || ''

export async function fetchHotGrids(params = {}) {
  const { days = 7, minScore = 50 } = params
  const queryParams = new URLSearchParams({
    days: days.toString(),
    minScore: minScore.toString(),
  })

  try {
    const response = await fetch(`${API_BASE}/api/grids/hot?${queryParams}`)
    if (!response.ok) {
      throw new Error(`Erreur API: ${response.status}`)
    }
    const data = await response.json()
    return {
      success: true,
      data: data.grids || data.data || [],
    }
  } catch (error) {
    console.error('Erreur fetchHotGrids:', error)
    return {
      success: false,
      error: error.message,
      data: getFallbackGrids(),
    }
  }
}

function getFallbackGrids() {
  return [
    {
      grid: 874,
      score: 82.3,
      rating: 'TRÈS CHAUD',
      cagnotte: 12500,
      matchCount: 13,
      winRate: 76.9,
      factors: [
        { name: 'Tendance', value: '+8.2%' },
        { name: 'Cagnotte', value: '12,500 TND' },
      ],
    },
    {
      grid: 876,
      score: 74.1,
      rating: 'CHAUD',
      cagnotte: 8200,
      matchCount: 13,
      winRate: 69.2,
      factors: [
        { name: 'Tendance', value: '+5.1%' },
        { name: 'Consensus', value: '67% foule' },
      ],
    },
    {
      grid: 871,
      score: 61.5,
      rating: 'TIÈDE',
      cagnotte: 3400,
      matchCount: 13,
      winRate: 53.8,
      factors: [{ name: 'Volatilité', value: '0.31' }],
    },
    {
      grid: 870,
      score: 45.2,
      rating: 'FRAIS',
      cagnotte: 1800,
      matchCount: 13,
      winRate: 38.5,
      factors: [{ name: 'Méfiance', value: 'baisse confiance' }],
    },
  ]
}

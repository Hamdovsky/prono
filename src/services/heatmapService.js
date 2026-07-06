const API_BASE = process.env.REACT_APP_API_URL || ''

export async function fetchEvolutionData(params = {}) {
  const { days = 30, league = 'all' } = params
  
  const queryParams = new URLSearchParams({
    days: days.toString(),
    league
  })

  try {
    const response = await fetch(`${API_BASE}/api/evolution/heatmap?${queryParams}`)
    
    if (!response.ok) {
      throw new Error(`Erreur API: ${response.status}`)
    }
    
    const data = await response.json()
    
    return {
      success: true,
      data: data.heatmap || data.data || []
    }
  } catch (error) {
    console.error('Erreur fetchEvolutionData:', error)
    
    // Fallback: données factices pour le demo
    return {
      success: false,
      error: error.message,
      data: getFallbackData()
    }
  }
}

function getFallbackData() {
  const now = new Date()
  const concours = [
    { name: 'Grid 870', score: 7.2, success: 65, volatility: 0.23 },
    { name: 'Grid 871', score: 6.8, success: 58, volatility: 0.31 },
    { name: 'Grid 872', score: 7.5, success: 72, volatility: 0.18 },
    { name: 'Grid 873', score: 6.9, success: 61, volatility: 0.27 },
    { name: 'Grid 874', score: 7.8, success: 78, volatility: 0.15 },
    { name: 'Grid 875', score: 6.5, success: 52, volatility: 0.35 },
    { name: 'Grid 876', score: 7.1, success: 67, volatility: 0.21 },
    { name: 'Grid 877', score: 6.7, success: 59, volatility: 0.29 },
  ]
  
  return concours.map((c, idx) => ({
    concours: c.name,
    avg_score: c.score,
    success_rate: c.success,
    volatility: c.volatility,
    last_score: c.score + (Math.random() - 0.5) * 2,
    date: new Date(now.getTime() - idx * 86400000).toISOString().split('T')[0]
  }))
}
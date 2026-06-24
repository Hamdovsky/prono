export const ROUTES = {
  matches: '/',
  'all-matches': '/all-matches',
  millionaire: '/millionaire',
  promosport: '/promosport',
}

export const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(ROUTES).map(([k, v]) => [v, k])
)

export const NAV_ITEMS = [
  {
    section: 'Navigation',
    items: [
      { view: 'all-matches', label: 'TOUS LES MATCHS', icon: '📊', color: '#94a3b8' },
      { view: 'millionaire', label: 'TOP PICKS DU JOUR', icon: '🎯', color: '#fbbf24' },
      { view: 'promosport', label: 'PROMOSPORT', icon: '💰', color: '#10b981' },
    ]
  },
]

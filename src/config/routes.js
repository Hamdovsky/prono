export const ROUTES = {
  matches: '/',
  'all-matches': '/all-matches',
  millionaire: '/millionaire',
  accuracy: '/accuracy',
  learning: '/learning',
  combos: '/combos',
  props: '/props',
  mega: '/mega',
  precision: '/precision',
  market: '/market',
  datascience: '/datascience',
  integrity: '/integrity',
  livelab: '/livelab',
  livegoal: '/livegoal',
  audit: '/audit',
  backtest: '/backtest',
  mega1000: '/mega1000',
  intel: '/intel',
  promosport: '/promosport',
  evolution: '/evolution',
  'top-picks': '/top-picks',
  'accuracy-tracker': '/accuracy-tracker',
}

export const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(ROUTES).map(([k, v]) => [v, k])
)

export const NAV_ITEMS = [
  {
    section: 'Navigation',
    items: [
      { view: 'all-matches', label: 'TOUS LES MATCHS', icon: '📊', color: '#94a3b8' },
      { view: 'top-picks', label: 'TOP PICKS DU JOUR', icon: '🎯', color: '#fbbf24' },
      { view: 'millionaire', label: 'Millionaire Selection', icon: '💰', color: '#fbbf24' },
    ]
  },
  {
    section: 'Analyse & Performance',
    items: [
      { view: 'accuracy', label: 'Accuracy Dashboard', icon: '📈', color: '#818cf8' },
      { view: 'learning', label: 'Adaptive Learning AI', icon: '🧠', color: '#818cf8' },
      { view: 'datascience', label: 'Data Science Lab', icon: '🔬', color: '#22d3ee' },
      { view: 'audit', label: 'Performance Audit', icon: '📋', color: '#a78bfa' },
      { view: 'backtest', label: 'Backtest', icon: '⏮️', color: '#fb923c' },
    ]
  },
  {
    section: 'Paris & Value',
    items: [
      { view: 'combos', label: 'Combo Tracker', icon: '🎰', color: '#f472b6' },
      { view: 'market', label: 'Market Lab', icon: '📉', color: '#34d399' },
      { view: 'mega', label: 'Mega Corrélation', icon: '🔗', color: '#f59e0b' },
      { view: 'props', label: 'Player Props', icon: '🎯', color: '#e879f9' },
      { view: 'mega1000', label: 'Mega Ticket 1000', icon: '💎', color: '#fbbf24' },
      { view: 'precision', label: 'Précision Tracker', icon: '🎛️', color: '#2dd4bf' },
    ]
  },
  {
    section: 'Live & Temps Réel',
    items: [
      { view: 'livelab', label: 'Live Match', icon: '🔴', color: '#ef4444' },
      { view: 'livegoal', label: 'Live Goal Prédictions', icon: '⚡', color: '#ef4444' },
    ]
  },
  {
    section: 'Système',
    items: [
      { view: 'intel', label: 'System Intelligence', icon: '🛡️', color: '#38bdf8' },
      { view: 'promosport', label: 'TeleMatch / Promosport IA', icon: '💰', color: '#10b981' },
      { view: 'evolution', label: 'Titanium Evolution', icon: '🧬', color: '#ec4899' },
      { view: 'accuracy-tracker', label: 'Précision', icon: '📊', color: '#00ffaa' },
    ]
  },
]

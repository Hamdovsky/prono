// Ligues épinglées / MENA : source de vérité UNIQUE, partagée entre la
// Sidebar (affichage) et dashboardFilters.js (filtrage de la liste).
// (Déplacé verbatim depuis Sidebar.jsx, session dashboard-improvements.)

export const PINNED_LEAGUES = [
  {
    id: 'en_pr',
    name: 'Angleterre : Premier League',
    flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    keywords: ['premier league', 'epl'],
  },
  { id: 'en_ch', name: 'Angleterre : Championship', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', keywords: ['championship'] },
  { id: 'en_l1', name: 'Angleterre : League One', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', keywords: ['league one'] },
  { id: 'en_l2', name: 'Angleterre : League Two', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', keywords: ['league two'] },
  { id: 'en_nl', name: 'Angleterre : National League', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', keywords: ['national league'] },
  { id: 'fr_l1', name: 'France : Ligue 1', flag: '🇫🇷', keywords: ['ligue 1', 'france'] },
  {
    id: 'es_ll',
    name: 'Espagne : LaLiga',
    flag: '🇪🇸',
    keywords: ['LaLiga', 'la liga', 'laliga', 'spain', 'es liga'],
  },
  { id: 'it_sa', name: 'Italie : Serie A', flag: '🇮🇹', keywords: ['serie a', 'italy'] },
  { id: 'de_bl', name: 'Allemagne : Bundesliga', flag: '🇩🇪', keywords: ['bundesliga', 'germany'] },
  {
    id: 'pt_lp',
    name: 'Portugal : Liga Portugal',
    flag: '🇵🇹',
    keywords: ['liga portugal', 'primeira', 'portugal'],
  },
  {
    id: 'eu_cl',
    name: 'UEFA : Champions League',
    flag: '🇪🇺',
    keywords: ['champions league', 'uefa'],
  },
  { id: 'eu_el', name: 'UEFA : Europa League', flag: '🇪🇺', keywords: ['europa league'] },
  { id: 'br_sa', name: 'Brésil : Brasileirão', flag: '🇧🇷', keywords: ['brasileiro', 'brazil'] },
]

export const MENA_LEAGUES = [
  { id: 'ma_bp', name: 'Maroc : Botola Pro', flag: '🇲🇦', keywords: ['botola', 'morocco'] },
  { id: 'tn_l1', name: 'Tunisie : Ligue 1', flag: '🇹🇳', keywords: ['tunisian', 'tunisia'] },
  {
    id: 'sa_pl',
    name: 'Arabie S. : Saudi Pro',
    flag: '🇸🇦',
    keywords: ['saudi', 'al-nassr', 'al-hilal', 'al-ittihad', 'al-ahli'],
  },
  { id: 'eg_pl', name: 'Égypte : Egyptian Premier', flag: '🇪🇬', keywords: ['egyptian', 'egypt'] },
  { id: 'dz_l1', name: 'Algérie : Ligue 1', flag: '🇩🇿', keywords: ['algerian', 'algeria'] },
  {
    id: 'ae_pl',
    name: 'Émirats : UAE Pro League',
    flag: '🇦🇪',
    keywords: ['uae pro', 'united arab emirates'],
  },
  { id: 'qa_sl', name: 'Qatar : Stars League', flag: '🇶🇦', keywords: ['stars league', 'qatar'] },
  { id: 'kw_pl', name: 'Koweït : Kuwait League', flag: '🇰🇼', keywords: ['kuwait'] },
  { id: 'iq_sl', name: 'Irak : Iraq Stars League', flag: '🇮🇶', keywords: ['iraq stars', 'iraq'] },
  {
    id: 'jo_pl',
    name: 'Jordanie : Jordan Pro League',
    flag: '🇯🇴',
    keywords: ['jordan pro', 'jordan'],
  },
  {
    id: 'om_pl',
    name: 'Oman : Oman Pro League',
    flag: '🇴🇲',
    keywords: ['oman professional', 'oman'],
  },
  {
    id: 'ly_pl',
    name: 'Libye : Libyan Premier',
    flag: '🇱🇾',
    keywords: ['libyan premier', 'libya'],
  },
  {
    id: 'lb_pl',
    name: 'Liban : Lebanese Premier',
    flag: '🇱🇧',
    keywords: ['lebanese premier', 'lebanon'],
  },
  {
    id: 'sy_pl',
    name: 'Syrie : Syrian Premier',
    flag: '🇸🇾',
    keywords: ['syrian premier', 'syria'],
  },
  {
    id: 'bh_pl',
    name: 'Bahreïn : Bahraini Premier',
    flag: '🇧🇭',
    keywords: ['bahraini premier', 'bahrain'],
  },
]

export const ALL_LEAGUE_DEFS = [...PINNED_LEAGUES, ...MENA_LEAGUES]

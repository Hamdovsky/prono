const LEAGUE_COUNTRY_MAP = {
    "Premier League": "🏴󠁧󠁢󠁥󠁮󠁧󠁿 Angleterre",
    "Championship": "🏴󠁧󠁢󠁥󠁮󠁧󠁿 Angleterre",
    "League One": "🏴󠁧󠁢󠁥󠁮󠁧󠁿 Angleterre",
    "League Two": "🏴󠁧󠁢󠁥󠁮󠁧󠁿 Angleterre",
    "Ligue 1": "🇫🇷 France",
    "Ligue 2": "🇫🇷 France",
    "LaLiga": "🇪🇸 Espagne",
    "LaLiga 2": "🇪🇸 Espagne",
    "Serie A": "🇮🇹 Italie",
    "Serie B": "🇮🇹 Italie",
    "Bundesliga": "🇩🇪 Allemagne",
    "2. Bundesliga": "🇩🇪 Allemagne",
    "Liga Portugal": "🇵🇹 Portugal",
    "Eredivisie": "🇳🇱 Pays-Bas",
    "Algerian Ligue 1": "🇩🇿 Algérie",
    "Tunisian Ligue 1": "🇹🇳 Tunisie",
    "Botola Pro": "🇲🇦 Maroc",
    "Egyptian Premier League": "🇪🇬 Égypte",
    "MLS": "🇺🇸 USA",
    "Brasileirão": "🇧🇷 Brésil",
    "Super League": "🇨🇭 Suisse",
    "Premiership": "🏴󠁧󠁢󠁳󠁣󠁴󠁿 Écosse",
    "HNL": "🇭🇷 Croatie",
    "Ekstraklasa": "🇵🇱 Pologne",
    "Superliga": "🇩🇰 Danemark",
    "Allsvenskan": "🇸🇪 Suède",
    "Eliteserien": "🇳🇴 Norvège",
    "Veikkausliiga": "🇫🇮 Finlande",
    "A-League": "🇦🇺 Australie",
    "J1 League": "🇯🇵 Japon",
    "K League 1": "🇰🇷 Corée du Sud",
    "Super Lig": "🇹🇷 Turquie",
    "Russian Premier League": "🇷🇺 Russie"
};

const getCountryForLeague = (leagueName) => {
    if (!leagueName) return "⚽ International";
    for (const key in LEAGUE_COUNTRY_MAP) {
        if (leagueName.includes(key)) return LEAGUE_COUNTRY_MAP[key];
    }
    return "⚽ Football";
};

module.exports = { LEAGUE_COUNTRY_MAP, getCountryForLeague };

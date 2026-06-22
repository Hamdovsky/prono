# core/leagues_master.py

TIER_1_ELITE = [
    'premier league', 'la liga', 'laliga', 'bundesliga', 'serie a', 'ligue 1',
    'champions league', 'world cup', 'euro', 'africa cup of nations', 'afcon',
    'copa america', 'uefa'
]

TIER_2_PRO = [
    'algerian', 'tunisian', 'moroccan', 'saudi', 'mls', 'brasileirao', 'liga mx',
    'championship', 'eredivisie', 'primeira liga', 'super lig', 'pro league',
    '1st division', 'serie b', 'segunda', 'egyptian', 'botola', 'stars league',
    'libyan', 'lebanese', 'syrian', 'bahrain', 'jordan', 'oman', 'kuwait', 'emarates', 'uae',
    'international friendly', 'national teams'
]

TIER_3_VOLATILE = [
    'division 2', 'division 3', 'league 1', 'league 2', 'youth league',
    'npl', 'state', 'premier league 2', 'reserves', 'amateur', 'ncaa', 'university'
]

BLACKLIST_KEYWORDS = [
    'u17', 'u18', 'u19', 'u20', 'u22', 'club matches', 'youth', 'amateur'
]

WHITELIST_HIGH = [
    'premier league', 'premier-league', 'la liga', 'laliga', 'laliga-ea-sports',
    'bundesliga', 'serie a', 'serie-a', 'ligue 1', 'ligue-1',
    'champions league', 'champions-league', 'europa league', 'europa-league',
    'world cup', 'euro', 'africa cup of nations', 'afcon',
    'copa america', 'uefa nations league',
    'eredivisie', 'primeira liga', 'liga mx', 'super lig',
    'championship', 'serie b', 'serie-b', 'segunda division', '2 bundesliga',
    'saudi pro league', 'roshen league', 'mls',
    'brasileirao', 'brazilian serie a',
    'a league', 'jupiler pro league', 'scottish premiership',
    'austrian bundesliga', 'swiss super league', 'super lig greece',
    'argentine league', 'primera division',
    'egyptian premier league', 'botola pro',
    'tunisian ligue 1', 'algerian ligue 1', 'moroccan botola',
    'chinese super league', 'j1 league', 'k league 1',
]

WHITELIST_MEDIUM = [
    'chilean league', 'colombian primera a', 'peruvian league',
    'belgian pro league', 'danish superliga',
    'swedish allsvenskan', 'norwegian eliteserien',
    'polish ekstraklasa', 'czech first league',
    'croatian hnl', 'serbian superliga',
    'ukrainian premier league', 'russian premier league',
    'greek super league', 'qatar stars league', 'uae pro league',
]

def classify_league(league_name, tournament_name=""):
    """
    Returns (tier, confidence_tag) where:
      tier: T1 | T2 | T3 | BLACKLIST | UNKNOWN
      confidence_tag: HIGH | MEDIUM | LOW | EXCLUDED
    """
    combined = (str(league_name) + " " + str(tournament_name)).lower()
    combined_clean = combined.replace('_', ' ').replace('-', ' ')

    # 0. Blacklist → pas de prédiction
    if any(b in combined for b in BLACKLIST_KEYWORDS):
        return ('BLACKLIST', 'EXCLUDED')

    # 1. WHITELIST_HIGH → tag HIGH
    if any(w in combined_clean for w in WHITELIST_HIGH):
        if any(t1 in combined for t1 in TIER_1_ELITE):
            return ('T1', 'HIGH')
        return ('T2', 'HIGH')

    # 2. WHITELIST_MEDIUM → tag MEDIUM
    if any(w in combined_clean for w in WHITELIST_MEDIUM):
        return ('T2', 'MEDIUM')

    # 3. TIER_1_ELITE (non whitelisté, ex: nouveau tournoi UEFA)
    if any(t1 in combined for t1 in TIER_1_ELITE):
        return ('T1', 'MEDIUM')

    # 4. TIER_2_PRO restant
    if any(t2 in combined for t2 in TIER_2_PRO):
        return ('T2', 'LOW')

    # 5. TIER_3_VOLATILE
    if any(t3 in combined for t3 in TIER_3_VOLATILE):
        return ('T3', 'LOW')

    # 6. UNKNOWN
    return ('UNKNOWN', 'LOW')

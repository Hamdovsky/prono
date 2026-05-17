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

def classify_league(league_name, tournament_name=""):
    """
    Classifies a league into T1, T2, T3, BLACKLIST, or UNKNOWN.
    """
    combined = (str(league_name) + " " + str(tournament_name)).lower()
    
    # 1. Check Blacklist first (Pre-Match Filter)
    if any(b in combined for b in BLACKLIST_KEYWORDS):
        return 'BLACKLIST'
        
    # 2. Check Elite
    if any(t1 in combined for t1 in TIER_1_ELITE):
        return 'T1'
        
    # 3. Check Regional/Pro
    if any(t2 in combined for t2 in TIER_2_PRO):
        return 'T2'
        
    # 4. Check Volatile / Lower divisions
    if any(t3 in combined for t3 in TIER_3_VOLATILE):
        return 'T3'
        
    # 5. Unrecognized / Experimental (e.g. Evolution_League_Test)
    return 'UNKNOWN'

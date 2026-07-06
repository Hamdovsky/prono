import soccerdata as sd
from datetime import datetime
import os
import logging
from pathlib import Path

logger = logging.getLogger('fbref_service')

_schedule_cache = {}
_stats_cache = {}
_xg_cache = {}

_fbref_data_dir = Path(os.path.join(os.path.dirname(__file__), '..', 'data', 'soccerdata_cache'))
_fbref_data_dir.mkdir(parents=True, exist_ok=True)

CACHE_TTL_SCHEDULE = 6 * 3600
CACHE_TTL_STATS = 24 * 3600

LEAGUE_MAP = {
    'premier league': 'ENG-Premier League',
    'la liga': 'ESP-La Liga',
    'liga': 'ESP-La Liga',
    'serie a': 'ITA-Serie A',
    'ligue 1': 'FRA-Ligue 1',
    'ligue one': 'FRA-Ligue 1',
    'bundesliga': 'GER-Bundesliga',
    'eredivisie': 'NED-Eredivisie',
    'primeira liga': 'POR-Primeira Liga',
    'ligue portugal': 'POR-Primeira Liga',
    'championship': 'ENG-Championship',
    'serie b': 'ITA-Serie B',
    'mls': 'USA-MLS',
    'brazilian serie a': 'BRA-Serie A',
    'brasileirão serie a': 'BRA-Serie A',
    'world cup': 'INT-World Cup',
    'world cup 2026': 'INT-World Cup',
    'champions league': 'UEFA-Champions League',
    'ucl': 'UEFA-Champions League',
    'europa league': 'UEFA-Europa League',
    'europa conference league': 'UEFA-Europa Conference League',
}

TEAM_MAP = {
    'man city': 'Manchester City',
    'manchester city': 'Manchester City',
    'man united': 'Manchester United',
    'manchester united': 'Manchester United',
    'man utd': 'Manchester United',
    'spurs': 'Tottenham Hotspur',
    'tottenham': 'Tottenham Hotspur',
    'leicester': 'Leicester City',
    'leicester city': 'Leicester City',
    'newcastle': 'Newcastle United',
    'newcastle united': 'Newcastle United',
    'wolves': 'Wolverhampton Wanderers',
    'wolverhampton': 'Wolverhampton Wanderers',
    'west ham': 'West Ham United',
    'west ham united': 'West Ham United',
    'brighton': 'Brighton & Hove Albion',
    'brighton & hove albion': 'Brighton & Hove Albion',
    'aston villa': 'Aston Villa',
    'southampton': 'Southampton',
    'everton': 'Everton',
    'palace': 'Crystal Palace',
    'crystal palace': 'Crystal Palace',
    'leeds': 'Leeds United',
    'leeds united': 'Leeds United',
    'nottingham': "Nott'ham Forest",
    'nottingham forest': "Nott'ham Forest",
    'nott\'ham forest': "Nott'ham Forest",
    'brentford': 'Brentford',
    'fulham': 'Fulham',
    'bournemouth': 'Bournemouth',
    'afc bournemouth': 'Bournemouth',
    'ipswich': 'Ipswich Town',
    'ipswich town': 'Ipswich Town',
    'barcelona': 'Barcelona',
    'fc barcelona': 'Barcelona',
    'real madrid': 'Real Madrid',
    'atletico madrid': 'Atlético Madrid',
    'atletico': 'Atlético Madrid',
    'atlético madrid': 'Atlético Madrid',
    'sevilla': 'Sevilla',
    'sevilla fc': 'Sevilla',
    'betis': 'Real Betis',
    'real betis': 'Real Betis',
    'athletic bilbao': 'Athletic Club',
    'bilbao': 'Athletic Club',
    'athletic club': 'Athletic Club',
    'sociedad': 'Real Sociedad',
    'real sociedad': 'Real Sociedad',
    'valencia': 'Valencia',
    'villareal': 'Villarreal',
    'villarreal': 'Villarreal',
    'psg': 'Paris Saint-Germain',
    'paris saint-germain': 'Paris Saint-Germain',
    'paris sg': 'Paris Saint-Germain',
    'monaco': 'Monaco',
    'lyon': 'Lyon',
    'olympique lyonnais': 'Lyon',
    'marseille': 'Marseille',
    'olympique de marseille': 'Marseille',
    'lille': 'Lille',
    'nice': 'Nice',
    'rennes': 'Rennes',
    'bayern': 'Bayern Munich',
    'bayern munich': 'Bayern Munich',
    'fc bayern': 'Bayern Munich',
    'borussia dortmund': "Borussia Dortmund",
    'dortmund': "Borussia Dortmund",
    'rb leipzig': "RB Leipzig",
    'leipzig': "RB Leipzig",
    'bayer leverkusen': "Bayer Leverkusen",
    'leverkusen': "Bayer Leverkusen",
    'wolfsburg': "Wolfsburg",
    'eintracht frankfurt': "Eintracht Frankfurt",
    'frankfurt': "Eintracht Frankfurt",
    'mönchengladbach': "Borussia M'gladbach",
    'borussia mönchengladbach': "Borussia M'gladbach",
    'inter': 'Inter Milan',
    'inter milan': 'Inter Milan',
    'milan': 'AC Milan',
    'ac milan': 'AC Milan',
    'juventus': 'Juventus',
    'juve': 'Juventus',
    'napoli': 'Napoli',
    'roma': 'Roma',
    'as roma': 'Roma',
    'lazio': 'Lazio',
    'atalanta': 'Atalanta',
    'fiorentina': 'Fiorentina',
    'ajax': 'Ajax',
    'feyenoord': 'Feyenoord',
    'psv': 'PSV Eindhoven',
    'psv eindhoven': 'PSV Eindhoven',
    'sporting': 'Sporting CP',
    'sporting cp': 'Sporting CP',
    'sporting lisbon': 'Sporting CP',
    'benfica': 'Benfica',
    'sl benfica': 'Benfica',
    'porto': 'Porto',
    'fc porto': 'Porto',
}


def _get_season_code():
    now = datetime.now()
    year = now.year
    if now.month >= 7:
        return f"{year % 100}{(year + 1) % 100:02d}"
    else:
        return f"{(year - 1) % 100}{year % 100:02d}"


def _get_fbref_league(league_name):
    ln = league_name.lower().strip()
    for key, val in LEAGUE_MAP.items():
        if key in ln:
            return val
    return None


def _normalize_team(name):
    n = name.lower().strip()
    n = n.replace('fc ', '').replace(' f c', '').replace('  ', ' ')
    for key, val in TEAM_MAP.items():
        if n == key or n in key or key in n:
            return val
    return name.strip()


def _to_float(val):
    if val is None:
        return None
    try:
        v = float(val)
        return v if v > 1.0 else None
    except (ValueError, TypeError):
        return None


def _load_schedule(league, force_refresh=False):
    fbref_league = _get_fbref_league(league)
    if not fbref_league:
        logger.warning(f"[FBREF] No mapping for league: {league}")
        return None

    now = datetime.now()
    cached = _schedule_cache.get(fbref_league)
    if cached and not force_refresh:
        df, ts = cached
        if (now - ts).total_seconds() < CACHE_TTL_SCHEDULE:
            return df

    try:
        season = _get_season_code()
        data_dir = Path(os.environ.get('SOCCERDATA_DIR', str(_fbref_data_dir)))
        fb = sd.FBref(leagues=[fbref_league], seasons=[season],
                       data_dir=data_dir)
        df = fb.read_schedule()
        if df is not None and not df.empty:
            _schedule_cache[fbref_league] = (df, now)
            logger.info(f"[FBREF] Cached schedule for {fbref_league} ({len(df)} matches)")
            return df
        logger.warning(f"[FBREF] Empty schedule for {fbref_league}")
        return cached[0] if cached else None
    except Exception as e:
        logger.error(f"[FBREF] Failed to load {fbref_league}: {e}")
        return cached[0] if cached else None


def _load_team_stats(league, force_refresh=False):
    fbref_league = _get_fbref_league(league)
    if not fbref_league:
        return None

    now = datetime.now()
    cached = _stats_cache.get(fbref_league)
    if cached and not force_refresh:
        df, ts = cached
        if (now - ts).total_seconds() < CACHE_TTL_STATS:
            return df

    try:
        season = _get_season_code()
        data_dir = Path(os.environ.get('SOCCERDATA_DIR', str(_fbref_data_dir)))
        fb = sd.FBref(leagues=[fbref_league], seasons=[season],
                       data_dir=data_dir)
        df = fb.read_team_season_stats(stat_type='standard')
        if df is not None and not df.empty:
            _stats_cache[fbref_league] = (df, now)
            logger.info(f"[FBREF] Cached team stats for {fbref_league}")
            return df
        return cached[0] if cached else None
    except Exception as e:
        logger.error(f"[FBREF] Team stats failed for {fbref_league}: {e}")
        return cached[0] if cached else None


def get_schedule(league, force_refresh=False):
    return _load_schedule(league, force_refresh)


def get_team_stats(league, force_refresh=False):
    return _load_team_stats(league, force_refresh)


def search_match_xg(home_team, away_team):
    """Search ALL mapped leagues for a match between home_team and away_team.
    Returns first xG match found, or None."""
    for league_name in LEAGUE_MAP.keys():
        result = get_match_xg(home_team, away_team, league_name)
        if result:
            logger.info(f"[FBREF] Found xG for {home_team} vs {away_team} in '{league_name}': {result}")
            return result
    logger.info(f"[FBREF] No xG found for {home_team} vs {away_team} in any league")
    return None


def get_odds(home_team, away_team, league):
    logger.info(f"[FBREF] Odds not available from FBref (scores/fixtures page has no odds columns). Use other data sources.")
    return None


def get_match_xg(home_team, away_team, league):
    df = _load_schedule(league)
    if df is None or df.empty:
        return None

    home_norm = _normalize_team(home_team)
    away_norm = _normalize_team(away_team)

    for idx, row in df.iterrows():
        h = _normalize_team(str(row.get('home_team', '')))
        a = _normalize_team(str(row.get('away_team', '')))
        if (h == home_norm and a == away_norm) or (a == home_norm and h == away_norm):
            home_xg = _to_float(row.get('home_xg'))
            away_xg = _to_float(row.get('away_xg'))
            if home_xg and away_xg:
                return {'home_xg': home_xg, 'away_xg': away_xg}
            return None
    return None


def get_team_season_stats(team, league):
    df = _load_team_stats(league)
    if df is None or df.empty:
        return None

    team_norm = _normalize_team(team)

    for idx, row in df.iterrows():
        t = _normalize_team(str(row.get('team', '')) or str(idx[0] if isinstance(idx, tuple) else ''))
        if t == team_norm:
            stats = {}
            for col in ['GF', 'GA', 'xG', 'xGA', 'Sh', 'SoT', 'Gls', 'PK', 'PKatt']:
                val = _to_float(row.get(col))
                if val is not None:
                    stats[col] = val
            MP = _to_float(row.get('MP')) or _to_float(row.get('Matches')) or 1
            stats['MP'] = int(MP)
            return stats

    return None


def clear_cache():
    _schedule_cache.clear()
    _stats_cache.clear()
    _xg_cache.clear()
    logger.info("[FBREF] Cache cleared")


def cache_status():
    return {
        'leagues_cached': list(_schedule_cache.keys()),
        'schedule_entries': {k: len(v[0]) for k, v in _schedule_cache.items()},
        'stats_cached': list(_stats_cache.keys()),
    }

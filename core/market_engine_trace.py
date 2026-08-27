"""Journal d'audit du Market Engine (cotes reelles multi-marches).

Chaque pari de valeur (ou lecture seule) issu de real_markets est enregistre en
append-only JSONL pour permettre un backtest A/B reel : real_markets_value vs
paris Poisson, une fois le resultat du match connu (capture cote + probabilite
implicite + probabilite modele + edge + issue).

Format ligne (JSON) :
  { ts, match_id, home, away, league, market, real_odds, implied_p,
    model_p, edge_pct, value, source }
"""
import os
import json
import time

_TRACES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'traces')
_LOG_PATH = os.path.join(_TRACES_DIR, 'market_engine_real_markets.jsonl')


def log_real_market_bets(match_obj, real_bets):
    """Enregistre les entrees real_markets pour un match donne.

    real_bets : liste de dict renvoyee par real_markets_to_precision_bets
                (avec value/edge_pct/implied_probability/model_probability).
    """
    try:
        if not real_bets:
            return
        os.makedirs(_TRACES_DIR, exist_ok=True)
        mid = (
            match_obj.get('id') or match_obj.get('match_id')
            or f"{match_obj.get('homeTeam')}-{match_obj.get('awayTeam')}"
        )
        rec = {
            'ts': int(time.time()),
            'match_id': mid,
            'home': match_obj.get('homeTeam'),
            'away': match_obj.get('awayTeam'),
            'league': match_obj.get('league'),
            'startTimestamp': match_obj.get('startTimestamp') or match_obj.get('date') or None,
        }
        with open(_LOG_PATH, 'a', encoding='utf-8') as f:
            for b in real_bets:
                line = dict(rec)
                line.update({
                    'market': b.get('market'),
                    'real_odds': b.get('real_odds'),
                    'implied_p': b.get('implied_probability'),
                    'model_p': b.get('model_probability'),
                    'edge_pct': b.get('edge_pct') if b.get('value') else None,
                    'value': bool(b.get('value')),
                    'source': b.get('source', 'real_markets'),
                })
                f.write(json.dumps(line, default=str) + '\n')
    except Exception:
        # journalisation best-effort : ne doit jamais casser une prediction
        pass


def read_log(path=None):
    p = path or _LOG_PATH
    if not os.path.exists(p):
        return []
    out = []
    with open(p, 'r', encoding='utf-8') as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                out.append(json.loads(ln))
            except Exception:
                continue
    return out

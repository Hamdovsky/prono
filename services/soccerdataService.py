"""
soccerdataService.py — Génération des fixtures du jour (et 7 prochains jours)
via soccerdata (100% gratuit, sans proxy, fingerprint TLS intégré).

Sources:
  - ESPN        : calendrier des matchs (fixtures)
  - Understat   : xG (attendu buts) pour comparaison avec les cotes
  - ClubElo     : probabilités par date (optionnel, lourd au 1er run)

Sortie: data/today_matches.json  (consommé par scripts/betexplorerLive.js)
  [{ id, home, away, league, country, date, xg_home?, xg_away?, elo_prob? }]
"""

import os
import sys
import json
import datetime
import logging
import warnings

logging.disable(logging.CRITICAL)
warnings.filterwarnings("ignore")

import pandas as pd

try:
    from soccerdata import ESPN, Understat, ClubElo
except Exception as e:
    print("soccerdata import error:", e)
    ESPN = Understat = ClubElo = None

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUT_PATH = os.path.join(DATA_DIR, "today_matches.json")

# Ligues couvertes (noms soccerdata valides). MENA + secondaires européens ajoutés.
LEAGUES = [
    # Top-5 européens
    "ENG-Premier League",
    "ESP-La Liga",
    "GER-Bundesliga",
    "ITA-Serie A",
    "FRA-Ligue 1",
    # Secondaires européens
    "ENG- Championship",
    "ESP- Segunda División",
    "FRA- Ligue 2",
    "GER- 2. Bundesliga",
    "ITA- Serie B",
    "NED- Eredivisie",
    "POR- Primeira Liga",
    "BEL- Belgian Pro League",
    "TUR- Süper Lig",
    "SUI- Swiss Super League",
    "AUT- Austrian Bundesliga",
    "DEN- Superliga",
    "SWE- Allsvenskan",
    "NOR- Eliteserien",
    "SCO- Scottish Premiership",
    # Americas
    "USA- MLS",
    "MEX- Liga MX",
    "BRA- Série A",
    "ARG- Liga Profesional",
    # Asia
    "JPN- J1 League",
    "KOR- K League 1",
    # MENA (soccerdata peut avoir des données)
    "EGY- Egyptian Premier League",
    "SAU- Saudi Pro League",
    "MAR- Botola",
]

WINDOW_DAYS = 7


def get_today():
    import os

    forced = os.environ.get("SD_DATE")
    if forced:
        try:
            return datetime.date.fromisoformat(forced)
        except Exception:
            pass
    return datetime.date.today()


SEASON = os.environ.get("SD_SEASON", "2526")


def slugify(name):
    return (
        str(name)
        .lower()
        .replace(" ", "-")
        .replace("'", "")
    )


def load_from_csv_fallback():
    """Fallback 100% gratuit: lit football_data_fixtures.csv (football-data.co.uk, CSV public)
    pour garantir que today_matches.json n'est JAMAIS vide si soccerdata/SofaScore
    renvoient 0 matchs (date fictive sandbox, hors-saison, 404 du listing par date...).
    Même rôle que scripts/genFixturesFromCSV.py, intégré ici pour rester autonome."""
    csv_path = os.path.join(
        BASE_DIR, "data_pipeline", "data", "raw", "football_data_fixtures.csv"
    )
    if not os.path.exists(csv_path):
        return []
    rows = []
    try:
        import csv

        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                home = (row.get("home_team") or "").strip()
                away = (row.get("away_team") or "").strip()
                if not home or not away:
                    continue
                date = (row.get("date") or "").strip()
                league = (row.get("league") or "").strip()
                rows.append(
                    {
                        "id": slugify(f"{home}-{away}-{date}"),
                        "home": home,
                        "away": away,
                        "league": slugify(league),
                        "country": league.split("-")[0].strip(),
                        "date": date,
                        "kickoff_time": (row.get("kickoff_time") or "").strip(),
                    }
                )
        print(f"[SD] Fallback CSV: {len(rows)} matchs charges depuis {csv_path}")
    except Exception as e:
        print("[SD] Fallback CSV err:", e)
        return []
    return rows


def build_matches():
    today = get_today()
    end = today + datetime.timedelta(days=WINDOW_DAYS)
    rows = []

    # --- ESPN fixtures (saison dynamique + fenetre elargie si vide) ---
    def _espn_fetch(season, win_end):
        out = []
        try:
            espn = ESPN(leagues=LEAGUES, seasons=season)
            sched = espn.read_schedule()
            sched["_date"] = sched["date"].dt.date
            mask = (sched["_date"] >= today) & (sched["_date"] <= win_end)
            sub = sched[mask]
            for idx, r in sub.iterrows():
                # idx est un MultiIndex (league, season, game)
                league_name = idx[0] if isinstance(idx, tuple) else r.get("league", "")
                out.append(
                    {
                        "id": slugify(f"{r['home_team']}-{r['away_team']}-{r['_date']}"),
                        "home": str(r["home_team"]),
                        "away": str(r["away_team"]),
                        "league": slugify(str(league_name)),
                        "country": str(league_name).split("-")[0].strip(),
                        "date": str(r["_date"]),
                    }
                )
            print(f"[SD] ESPN({season}): {len(out)} matchs (fenetre {today}..{win_end})")
        except Exception as e:
            print(f"[SD] ESPN({season}) err:", e)
        return out

    rows = _espn_fetch(SEASON, end)
    # Repli: fenetre elargie a 30j si aucun match dans la fenetre initiale
    if not rows:
        rows = _espn_fetch(SEASON, today + datetime.timedelta(days=30))

    # --- Understat xG (optionnel) ---
    if os.environ.get("SD_SKIP_XG"):
        print("[SD] Understat skip (SD_SKIP_XG)")
    else:
        try:
            ust = Understat(leagues=LEAGUES, seasons=SEASON)
            ust_sched = ust.read_schedule()
            ust_sched["_date"] = ust_sched["date"].dt.date
            for m in rows:
                d = datetime.date.fromisoformat(m["date"])
                hit = ust_sched[ust_sched["_date"] == d]
                for _, r in hit.iterrows():
                    if str(r["home_team"]).lower() in m["home"].lower() and str(r["away_team"]).lower() in m["away"].lower():
                        m["xg_home"] = round(float(r.get("home_xg", 0) or 0), 3)
                        m["xg_away"] = round(float(r.get("away_xg", 0) or 0), 3)
                        break
            print("[SD] Understat xG attaches")
        except Exception as e:
            print("[SD] Understat err (ignore):", e)

    # --- ClubElo probas par date (optionnel, lourd) ---
    if os.environ.get("SD_SKIP_ELO"):
        print("[SD] ClubElo skip (SD_SKIP_ELO)")
    else:
        try:
            celo = ClubElo()
            for m in rows:
                d = m["date"]
                try:
                    er = celo.read_by_date(d)
                    # Trouve la ligne correspondant aux equipes si possible
                    for _, r in er.iterrows():
                        if str(r.get("team1", "")).lower() in m["home"].lower():
                            m["elo_prob"] = {
                                "home": round(float(r.get("prob1", 0) or 0), 3),
                                "draw": round(float(r.get("probX", 0) or 0), 3),
                                "away": round(float(r.get("prob2", 0) or 0), 3),
                            }
                            break
                except Exception:
                    continue
            print("[SD] ClubElo probas attachées")
        except Exception as e:
            print("[SD] ClubElo err (ignore):", e)

    # --- SofaScore scheduled-events (TOUTES ligues, source primaire gratuite) ---
    # Utilise curl_cffi (TLS fingerprint) pour contourner Cloudflare. Activé par
    # défaut ; désactivable via SD_SKIP_SOFASCORE=1. Les matchs portent sofascore_id
    # pour résolution directe des cotes dans cacheSofascoreOdds.py.
    if os.environ.get("SD_SKIP_SOFASCORE"):
        print("[SD] SofaScore skip (SD_SKIP_SOFASCORE)")
    else:
        try:
            sys.path.insert(0, os.path.join(BASE_DIR, "services"))
            from sofascoreClient import SofascoreClient
            sc = SofascoreClient()
            if sc.enabled:
                for d_offset in range(WINDOW_DAYS + 1):
                    d = (today + datetime.timedelta(days=d_offset)).isoformat()
                    evs = sc.get_scheduled_events(d)
                    for ev in evs:
                        rows.append({
                            "id": slugify(f"{ev['home']}-{ev['away']}-{ev['date']}"),
                            "home": ev["home"],
                            "away": ev["away"],
                            "league": slugify(str(ev.get("league") or "")),
                            "country": ev.get("country") or "",
                            "date": str(ev.get("date") or d),
                            "sofascore_id": ev.get("sofascore_id"),
                        })
                print(f"[SD] SofaScore: {len(rows)} matchs (toutes ligues)")
        except Exception as e:
            print("[SD] SofaScore err (ignore):", e)

    # --- Résolution SofaScore par ID (contourne le 404 du listing par date) ---
    # Le endpoint scheduled-events est 404 côté SofaScore ; on résout l'eventId
    # par nom d'équipe (search/all -> team -> events) afin que cacheSofascoreOdds
    # puisse récupérer les cotes/xG de chaque match gratuitement.
    if not os.environ.get("SD_SKIP_SOFASCORE"):
        try:
            sys.path.insert(0, os.path.join(BASE_DIR, "services"))
            from sofascoreClient import SofascoreClient
            sc = SofascoreClient()
            if sc.enabled:
                missing = [m for m in rows if not m.get("sofascore_id")]
                resolved = 0
                for m in missing:
                    try:
                        eid = sc.resolve_event_id(m.get("home"), m.get("away"), m.get("date"))
                        if eid:
                            m["sofascore_id"] = eid
                            resolved += 1
                    except Exception:
                        continue
                print(f"[SD] SofaScore IDs resolus: {resolved}/{len(missing)}")
        except Exception as e:
            print("[SD] resolve err (ignore):", e)

    # --- Fallback CSV (jamais vide) ---
    if not rows:
        fb = load_from_csv_fallback()
        if fb:
            rows = fb
            print(f"[SD] Fallback ACTIVE: {len(rows)} matchs depuis football_data_fixtures.csv")

    return rows


def main():
    matches = build_matches()
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(matches, f, ensure_ascii=False, indent=2)
    print(f"[SD] ecrit {len(matches)} matchs -> {OUT_PATH}")


if __name__ == "__main__":
    main()

"""extract_ht_corners.py

Lit les matchs terminés (status='finished') ou en cours avancés de la DB,
appelle Sofascore /incidents + /statistics, et écrit dans matches :
  - ht_score_home, ht_score_away   (mi-temps)
  - corners_home, corners_away     (FT, déjà existant, on le complète si manquant)
  - corners_ht_home, corners_ht_away (1ère MT, nouveau)

Idempotent : n'écrit que si nouvelle info ou valeur NULL actuelle.

Usage:
  python scripts/extract_ht_corners.py            # tous les matchs sans HT score
  python scripts/extract_ht_corners.py --event-id 16287064  # un seul match (test)
  python scripts/extract_ht_corners.py --limit 100
"""
import argparse
import json
import os
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
# Also add the main repo's scripts dir if running from a worktree
PARENT_SCRIPTS = os.path.normpath(os.path.join(HERE, "..", "..", "..", "scripts"))
if os.path.isdir(PARENT_SCRIPTS) and PARENT_SCRIPTS not in sys.path:
    sys.path.insert(0, PARENT_SCRIPTS)

from sofascore_bypass import api_get

DB_CANDIDATES = [
    os.path.join(ROOT, "data", "tactical.db"),
    os.path.join(ROOT, "data", "predictions.db"),
]


def _open_db():
    for p in DB_CANDIDATES:
        if os.path.exists(p):
            return sqlite3.connect(p)
    raise FileNotFoundError("no DB found in data/")


def _ht_score_from_incidents(incs):
    """Find the incident where text=='HT' and return (home, away) score at that point."""
    for it in incs:
        text = (it.get("text") or "").strip().upper()
        if text == "HT" and it.get("incidentType") == "period":
            h = it.get("homeScore")
            a = it.get("awayScore")
            if h is not None and a is not None:
                try:
                    return int(h), int(a)
                except (TypeError, ValueError):
                    pass
    return None, None


def _corners_from_statistics(stats_json, period="ALL"):
    """Find Corner kicks statistic for a given period ('ALL', '1ST', '2ND')."""
    if not isinstance(stats_json, dict):
        return None, None
    for period_block in stats_json.get("statistics", []):
        if period_block.get("period") != period:
            continue
        for grp in period_block.get("groups", []):
            for it in grp.get("statisticsItems", []):
                name = (it.get("name") or "").lower()
                if "corner kicks" == name or name == "corner kicks":
                    h, a = it.get("home"), it.get("away")
                    if h is not None and a is not None:
                        try:
                            return int(h), int(a)
                        except (TypeError, ValueError):
                            pass
    return None, None


def fetch_event_stats(event_id):
    """Return (ht_home, ht_away, corners_ft_home, corners_ft_away,
                corners_ht_home, corners_ht_away) or all None on failure."""
    try:
        incs_json = api_get(f"/event/{event_id}/incidents")
    except Exception as e:
        print(f"  [incidents] FAIL {event_id}: {e}")
        return (None,) * 6
    try:
        stats_json = api_get(f"/event/{event_id}/statistics")
    except Exception as e:
        print(f"  [statistics] FAIL {event_id}: {e}")
        stats_json = {}

    ht_h, ht_a = _ht_score_from_incidents(incs_json.get("incidents", []))
    c_ft_h, c_ft_a = _corners_from_statistics(stats_json, period="ALL")
    c_ht_h, c_ht_a = _corners_from_statistics(stats_json, period="1ST")
    return ht_h, ht_a, c_ft_h, c_ft_a, c_ht_h, c_ht_a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--event-id", help="Process a single Sofascore eventId (test mode)")
    ap.add_argument("--limit", type=int, default=200, help="Max matches to process")
    ap.add_argument("--status", default="finished", help="Match status filter")
    ap.add_argument("--dry-run", action="store_true", help="Print, don't write")
    args = ap.parse_args()

    if args.event_id:
        # Test mode
        print(f"[TEST] eventId={args.event_id}")
        r = fetch_event_stats(args.event_id)
        print(f"  ht_score={r[0]}-{r[1]}")
        print(f"  corners_ft={r[2]}-{r[3]}")
        print(f"  corners_ht={r[4]}-{r[5]}")
        return

    db = _open_db()
    cur = db.cursor()
    # Find candidates: finished matches with a Sofascore event id (home_team_id) and no ht_score yet
    rows = cur.execute(
        """
        SELECT id, home_team_id, homeTeam, awayTeam, status
          FROM matches
         WHERE status = ?
           AND home_team_id IS NOT NULL
           AND (ht_score_home IS NULL OR corners_home IS NULL)
         ORDER BY last_updated DESC
         LIMIT ?
        """,
        (args.status, args.limit),
    ).fetchall()

    if not rows:
        print("[OK] No matches to process.")
        return

    print(f"[INFO] Processing {len(rows)} matches…")
    n_ht = n_c_ft = n_c_ht = 0
    for row in rows:
        mid, sofascore_id, home, away, status = row
        sofascore_id_str = str(sofascore_id)
        if not sofascore_id_str.isdigit():
            continue
        ht_h, ht_a, c_ft_h, c_ft_a, c_ht_h, c_ht_a = fetch_event_stats(sofascore_id_str)
        updates = []
        params = []
        if ht_h is not None:
            updates.append("ht_score_home = ?")
            params.append(ht_h)
            updates.append("ht_score_away = ?")
            params.append(ht_a)
            n_ht += 1
        if c_ft_h is not None:
            updates.append("corners_home = COALESCE(corners_home, ?)")
            params.append(c_ft_h)
            updates.append("corners_away = COALESCE(corners_away, ?)")
            params.append(c_ft_a)
            n_c_ft += 1
        if c_ht_h is not None:
            updates.append("corners_ht_home = ?")
            params.append(c_ht_h)
            updates.append("corners_ht_away = ?")
            params.append(c_ht_a)
            n_c_ht += 1
        if updates:
            params.append(mid)
            sql = f"UPDATE matches SET {', '.join(updates)} WHERE id = ?"
            if args.dry_run:
                print(f"  [DRY] id={mid} {home!r} vs {away!r} -> {dict(zip(['ht_h','ht_a','c_ft_h','c_ft_a','c_ht_h','c_ht_a'], (ht_h, ht_a, c_ft_h, c_ft_a, c_ht_h, c_ht_a)))}")
            else:
                cur.execute(sql, params)
        # Respect rate limit
        time.sleep(0.4)

    if not args.dry_run:
        db.commit()
    db.close()
    print(f"[DONE] HT scores written: {n_ht}, Corners FT written: {n_c_ft}, Corners HT written: {n_c_ht}")


if __name__ == "__main__":
    main()

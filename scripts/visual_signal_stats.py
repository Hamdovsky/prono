# -*- coding: utf-8 -*-
"""
Boucle d'évaluation des signaux visuels PixelRAG.

Compare le taux de réussite des prédictions où le lecteur vision a posé un flag
(filled non vide) vs baseline (signaux présents mais aucun flag posé).
Source : data/visual_signal_audit.jsonl (écrit par mlPredictionService) joint
aux résultats réglés en SQLite (matches/historical_matches).

Usage : python scripts/visual_signal_stats.py [--db data/tactical.db]
"""
import argparse
import json
import os
import sqlite3
import sys
from collections import defaultdict

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIT = os.path.join(BASE, "data", "visual_signal_audit.jsonl")


def load_audit(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def fetch_results(db_path, match_ids):
    out = {}
    if not os.path.exists(db_path) or not match_ids:
        return out
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    qmarks = ",".join("?" * len(match_ids))
    for table in ("matches", "historical_matches"):
        try:
            cur = conn.execute(
                "SELECT id, result FROM %s WHERE id IN (%s) "
                "AND result IS NOT NULL AND result != ''" % (table, qmarks),
                list(match_ids),
            )
            for r in cur.fetchall():
                if r["result"]:
                    out[r["id"]] = str(r["result"]).strip().upper()
        except sqlite3.Error:
            continue
    conn.close()
    return out


def argmax_pick(probs):
    if not probs:
        return None
    vals = [
        (float(probs.get("home") or 0), "1"),
        (float(probs.get("draw") or 0), "X"),
        (float(probs.get("away") or 0), "2"),
    ]
    return max(vals)[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(BASE, "data", "tactical.db"))
    ap.add_argument("--audit", default=AUDIT)
    args = ap.parse_args()

    rows = load_audit(args.audit)
    if not rows:
        print("Aucune entrée dans %s — la boucle démarre dès que les prédictions tournent." % args.audit)
        return 0

    ids = sorted({r.get("match_id") for r in rows if r.get("match_id")})
    results = fetch_results(args.db, ids)

    stats = {"signal": [0, 0], "baseline": [0, 0]}
    per_flag = defaultdict(lambda: [0, 0])
    for r in rows:
        res = results.get(r.get("match_id"))
        if res not in ("1", "X", "2"):
            continue
        pick = argmax_pick(r.get("probs"))
        if not pick:
            continue
        bucket = "signal" if r.get("filled") else "baseline"
        stats[bucket][1] += 1
        if pick == res:
            stats[bucket][0] += 1
        for field in r.get("filled") or []:
            per_flag[field][1] += 1
            if pick == res:
                per_flag[field][0] += 1

    def pct(h, t):
        return "%.1f%%" % (100.0 * h / t) if t else "n/a"

    print("%-30s%10s%6s" % ("groupe", "réussite", "n"))
    print("%-30s%10s%6d" % ("signaux visuels posés", pct(*stats["signal"]), stats["signal"][1]))
    print("%-30s%10s%6d" % ("baseline (aucun flag)", pct(*stats["baseline"]), stats["baseline"][1]))
    if per_flag:
        print("\nPar champ posé :")
        for field, (h, t) in sorted(per_flag.items()):
            print("  %-28s%10s%6d" % (field, pct(h, t), t))
    print("\nMatchs réglés rejoués : %d / entrées audit : %d" % (
        stats["signal"][1] + stats["baseline"][1], len(rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

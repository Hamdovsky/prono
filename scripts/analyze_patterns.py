# -*- coding: utf-8 -*-
"""
Analyse de patterns pour ameliorer la precision (stitch).
Sources :
  - data/historical_archive.sqlite :: archive_football_data (144k matchs, cotes 1X2 42k, O/U 15.8k, xG 38.6k)
  - data_pipeline/data/processed/master.db :: master_matches (18.5k, Elo + xG + forme + cotes)
Sortie : sections texte (upsets, over/under, calibration).
"""
import sqlite3, os, math
from collections import defaultdict

BASE = r"C:\Users\HAMDI\Desktop\HamdiProno\stitch"
ARCHIVE = os.path.join(BASE, "data", "historical_archive.sqlite")
MASTER = os.path.join(BASE, "data_pipeline", "data", "processed", "master.db")

def devig(o1, o2, o3):
    try:
        inv = [1.0/o1, 1.0/o2, 1.0/o3]
    except ZeroDivisionError:
        return None
    s = sum(inv)
    if s <= 0 or any(x <= 0 for x in inv):
        return None
    return [x/s for x in inv]

def pct(x):
    return f"{100.0*x:5.1f}%" if x is not None else "  n/a "

def section(title):
    print("\n" + "="*84)
    print(title)
    print("="*84)

def bucketize(v, edges):
    for i in range(len(edges)-1):
        if edges[i] <= v < edges[i+1]:
            return f"[{edges[i]:g},{edges[i+1]:g})"
    return None

# ---------------------------------------------------------------------------
# 1) UPSETS via cotes 1X2 (archive, 42k)
# ---------------------------------------------------------------------------
def upsets_archive():
    con = sqlite3.connect(ARCHIVE); cur = con.cursor()
    rows = cur.execute("""
        SELECT odds_home, odds_draw, odds_away, result_full, league_code
        FROM archive_football_data
        WHERE odds_home>1 AND odds_draw>1 AND odds_away>1
          AND result_full IN ('H','D','A')
    """).fetchall()
    con.close()

    # par tranche de proba implicite du favori
    edges = [0.33, 0.40, 0.50, 0.60, 0.70, 0.80, 1.01]
    agg = {b: {"n":0,"win":0,"draw":0,"loss":0,"impl":0.0} for b in
           [f"[{edges[i]:g},{edges[i+1]:g})" for i in range(len(edges)-1)]}
    side = {"home_fav":{"n":0,"win":0,"loss":0}, "away_fav":{"n":0,"win":0,"loss":0}}
    league = defaultdict(lambda: {"n":0,"win":0,"loss":0})
    gap_pts = [(0.0,0.0,0)]  # sum impl, sum actual, n par favori

    for oh, od, oa, res, lg in rows:
        p = devig(oh, od, oa)
        if not p:
            continue
        fav_home = oh < oa
        fav_prob = p[0] if fav_home else p[2]
        b = bucketize(fav_prob, edges)
        # favori gagne ?
        fav_win = (res == 'H') if fav_home else (res == 'A')
        fav_loss = (res == 'A') if fav_home else (res == 'H')
        d = res == 'D'
        if b:
            agg[b]["n"] += 1
            agg[b]["impl"] += fav_prob
            if fav_win: agg[b]["win"] += 1
            elif d: agg[b]["draw"] += 1
            else: agg[b]["loss"] += 1
        s = side["home_fav" if fav_home else "away_fav"]
        s["n"] += 1
        if fav_win: s["win"] += 1
        if fav_loss: s["loss"] += 1
        L = league[lg.strip() or "?"]
        L["n"] += 1
        if fav_win: L["win"] += 1
        if fav_loss: L["loss"] += 1

    section("1) UPSETS - favori (cote la plus basse) - archive (n=%d)" % len(rows))
    print(f"{'Proba favori':14s} {'n':>7s} {'impl':>7s} {'gagne':>7s} {'nul':>7s} {'perd':>7s} {'ecart':>7s}")
    for b in agg:
        a = agg[b]
        if a["n"] == 0: continue
        iw = a["impl"]/a["n"]; ac = a["win"]/a["n"]
        print(f"{b:14s} {a['n']:7d} {pct(iw)} {pct(ac)} {pct(a['draw']/a['n'])} "
              f"{pct(a['loss']/a['n'])} {100*(ac-iw):+6.1f}")

    print("\n-- Favori a domicile vs exterieur --")
    for k, s in side.items():
        print(f"{k:10s} n={s['n']:6d}  gagne={pct(s['win']/s['n'])}  perd={pct(s['loss']/s['n'])}")

    print("\n-- Ligues les plus 'upset-prone' (>=300 matchs, tri par % favori perd) --")
    top = [(lg, d) for lg, d in league.items() if d["n"] >= 300]
    top.sort(key=lambda kv: kv[1]["loss"]/kv[1]["n"], reverse=True)
    print(f"{'ligue':8s} {'n':>6s} {'favori gagne':>13s} {'favori perd':>12s}")
    for lg, d in top[:12]:
        print(f"{lg:8s} {d['n']:6d} {pct(d['win']/d['n']):>13s} {pct(d['loss']/d['n']):>12s}")
    print("...")
    for lg, d in top[-6:]:
        print(f"{lg:8s} {d['n']:6d} {pct(d['win']/d['n']):>13s} {pct(d['loss']/d['n']):>12s}")

# ---------------------------------------------------------------------------
# 2) UPSETS via ELO (master, favori = Elo le plus haut)
# ---------------------------------------------------------------------------
def upsets_elo():
    con = sqlite3.connect(MASTER); cur = con.cursor()
    rows = cur.execute("""
        SELECT F_Elo_Diff, ftr, fthg, ftag FROM master_matches
        WHERE ftr IN ('H','D','A')
    """).fetchall()
    con.close()
    edges = [-10000,-250,-150,-75,-25,25,75,150,250,10000]
    agg = defaultdict(lambda: {"n":0,"fav_win":0,"draw":0,"fav_loss":0})
    for ed, ftr, hg, ag_ in rows:
        b = bucketize(ed, edges)
        if b is None: continue
        d = agg[b]; d["n"] += 1
        if ftr == 'D': d["draw"] += 1
        elif ed > 0:  # favori = domicile
            d["fav_win" if ftr=='H' else "fav_loss"] += 1
        else:         # favori = exterieur
            d["fav_win" if ftr=='A' else "fav_loss"] += 1
    section("2) UPSETS par ecart Elo (master, n=%d) - favori = Elo le plus haut" % len(rows))
    print(f"{'EloDiff':16s} {'n':>6s} {'favori gagne':>13s} {'nul':>7s} {'favori perd':>12s}")
    for b in sorted(agg, key=lambda k: edges.index(float(k.strip('[]()').split(',')[0]))):
        d = agg[b]
        if d["n"]==0: continue
        print(f"{b:16s} {d['n']:6d} {pct(d['fav_win']/d['n']):>13s} {pct(d['draw']/d['n']):>7s} {pct(d['fav_loss']/d['n']):>12s}")

# ---------------------------------------------------------------------------
# 3) OVER/UNDER 2.5 (master: cotes o25/u25 + total buts) et calibration
# ---------------------------------------------------------------------------
def over_under():
    con = sqlite3.connect(MASTER); cur = con.cursor()
    rows = cur.execute("""
        SELECT odds_o25_avg, odds_u25_avg, fthg, ftag, Total_xG_L5, F_Elo_Diff, league
        FROM master_matches
        WHERE fthg IS NOT NULL AND ftag IS NOT NULL
          AND odds_o25_avg>1 AND odds_u25_avg>1
    """).fetchall()
    con.close()
    section("3) OVER/UNDER 2.5 (master, n=%d)" % len(rows))
    n=0; over=0; impl_sum=0.0
    for o25,u25,hg,ag_,_,_,_ in rows:
        tot = hg+ag_
        io = (1.0/o25)/((1.0/o25)+(1.0/u25))
        impl_sum += io; n += 1
        if tot >= 3: over += 1
    print(f"Base: n={n}  Over2.5 reel={pct(over/n)}  Over2.5 implicite={pct(impl_sum/n)}  ecart={100*(over/n-impl_sum/n):+.1f}pts")

    # par proba implicite over
    edges=[0.0,0.30,0.40,0.50,0.60,0.70,1.0]
    agg=defaultdict(lambda:{"n":0,"over":0,"impl":0.0})
    for o25,u25,hg,ag_,_,_,_ in rows:
        io=(1.0/o25)/((1.0/o25)+(1.0/u25)); b=bucketize(io,edges)
        if b is None: continue
        d=agg[b]; d["n"]+=1; d["impl"]+=io
        if hg+ag_>=3: d["over"]+=1
    print(f"\n{'Impl Over':12s} {'n':>6s} {'impl':>7s} {'reel Over':>9s} {'ecart':>7s}")
    for b in [f"[{edges[i]:g},{edges[i+1]:g})" for i in range(len(edges)-1)]:
        d=agg[b]
        if d["n"]==0: continue
        print(f"{b:12s} {d['n']:6d} {pct(d['impl']/d['n'])} {pct(d['over']/d['n']):>9s} {100*(d['over']/d['n']-d['impl']/d['n']):+6.1f}")

    # par total xG L5
    sub=[r for r in rows if r[4] is not None]
    xe=[0,2.0,2.5,3.0,3.5,4.0,99]
    agx=defaultdict(lambda:{"n":0,"over":0})
    for o25,u25,hg,ag_,txg,_,_ in sub:
        b=bucketize(txg,xe)
        if b is None: continue
        d=agx[b]; d["n"]+=1
        if hg+ag_>=3: d["over"]+=1
    print(f"\n-- Par total xG L5 (n=%d) --" % len(sub))
    print(f"{'Total_xG_L5':14s} {'n':>6s} {'Over2.5':>8s}")
    for b in [f"[{xe[i]:g},{xe[i+1]:g})" for i in range(len(xe)-1)]:
        d=agx[b]
        if d["n"]==0: continue
        print(f"{b:14s} {d['n']:6d} {pct(d['over']/d['n']):>8s}")

# ---------------------------------------------------------------------------
# 4) xG favori vs cotes : divergence (archive, xG 38k) -> valeur/upset
# ---------------------------------------------------------------------------
def xg_vs_odds():
    con = sqlite3.connect(ARCHIVE); cur = con.cursor()
    rows = cur.execute("""
        SELECT odds_home, odds_away, result_full, xg_home, xg_away
        FROM archive_football_data
        WHERE odds_home>1 AND odds_away>1 AND xg_home IS NOT NULL AND xg_away IS NOT NULL
          AND result_full IN ('H','D','A')
    """).fetchall()
    con.close()
    # favori cotes vs favori xg : accord/desaccord
    both=0; agree=0; xg_fav_win_when_agree=0; xg_fav_win_when_disagree=0
    dis=0
    for oh,oa,res,xh,xa in rows:
        o_fav_home = oh < oa
        xg_fav_home = xh > xa
        if abs(xh-xa) < 0.05:
            continue
        both += 1
        if o_fav_home == xg_fav_home:
            agree += 1
            win = (res=='H') if xg_fav_home else (res=='A')
            if win: xg_fav_win_when_agree += 1
        else:
            dis += 1
            # on suit le favori xG
            win = (res=='H') if xg_fav_home else (res=='A')
            if win: xg_fav_win_when_disagree += 1
    section("4) xG vs cotes (archive, n=%d)" % both)
    print(f"accord cotes/xG : {pct(agree/both)}  desaccord : {pct(dis/both)}")
    print(f"favori xG gagne  quand accord    : {pct(xg_fav_win_when_agree/agree)}  (n={agree})")
    print(f"favori xG gagne  quand desaccord : {pct(xg_fav_win_when_disagree/dis)}  (n={dis})")
    print("  -> en desaccord, suivre le favori xG (plutot que cotes) est-il rentable ?")

# ---------------------------------------------------------------------------
def main():
    upsets_archive()
    upsets_elo()
    over_under()
    xg_vs_odds()

if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""Patterns sur les predictions de PRODUCTION du modele (1X2, O/U, BTTS)."""
import sqlite3, os
from collections import defaultdict
BASE=r"C:\Users\HAMDI\Desktop\HamdiProno\stitch"
DB=os.path.join(BASE,"data","tactical.db")

def num(x):
    if x is None: return None
    try: return float(x)
    except: return None

def scale(*vals):
    """retourne facteur si les valeurs sont en % (0-100)."""
    m=max([v for v in vals if v is not None]+[0])
    return 0.01 if m>1.5 else 1.0

def pct(x): return f"{100*x:5.1f}%"
def section(t): print("\n"+"="*84); print(t); print("="*84)

def actual_1x2(h,a):
    return "H" if h>a else ("A" if a>h else "D")

# ---------- 1X2 : historical_matches ----------
def onex2_historical():
    con=sqlite3.connect(DB); cur=con.cursor()
    rows=cur.execute("""SELECT home_win_probability, draw_probability, away_win_probability,
                        scoreHome, scoreAway, league FROM historical_matches
                        WHERE home_win_probability IS NOT NULL AND scoreHome IS NOT NULL""").fetchall()
    con.close()
    f=scale(*[rows[0][0],rows[0][1],rows[0][2]])
    data=[]
    for h,d,a,sh,sa,lg in rows:
        h,d,a=num(h),num(d),num(a)
        if None in (h,d,a): continue
        h,d,a=h*f,d*f,a*f
        s=h+d+a
        if s<=0: continue
        h,d,a=h/s,d/s,a/s
        act=actual_1x2(sh,sa); idx=max(range(3),key=lambda i:[h,d,a][i])
        data.append((h,d,a,idx,act,lg))
    section(f"1X2 PRODUCTION (historical_matches) - n={len(data)} (facteur={f})")
    corr=sum(1 for *_,idx,act,_ in [(r[0],r[1],r[2],r[3],r[4],r[5]) for r in data] if "HDA"[idx]==act)
    print(f"Accuracy 1X2 globale : {pct(corr/len(data))}")

    edges=[0.33,0.40,0.50,0.60,0.70,0.80,1.01]
    agg=defaultdict(lambda:{"n":0,"corr":0,"p":0.0,"loss":0})
    for h,d,a,idx,act,lg in data:
        p=[h,d,a]; mx=max(p); b=None
        for i in range(len(edges)-1):
            if edges[i]<=mx<edges[i+1]: b=f"[{edges[i]:.2f},{edges[i+1]:.2f})"; break
        if b is None: continue
        d2=agg[b]; d2["n"]+=1; d2["p"]+=mx
        if "HDA"[idx]==act: d2["corr"]+=1
        else: d2["loss"]+=1
    print(f"\n{'conf modele':14s} {'n':>6s} {'conf moy':>9s} {'justesse':>9s} {'favori perd':>11s} {'ecart':>7s}")
    for i in range(len(edges)-1):
        b=f"[{edges[i]:.2f},{edges[i+1]:.2f})"; d2=agg[b]
        if d2["n"]==0: continue
        conf=d2["p"]/d2["n"]; acc=d2["corr"]/d2["n"]
        print(f"{b:14s} {d2['n']:6d} {pct(conf):>9s} {pct(acc):>9s} {pct(d2['loss']/d2['n']):>11s} {100*(acc-conf):+6.1f}")

    lg=defaultdict(lambda:{"n":0,"corr":0})
    for h,d,a,idx,act,l in data:
        d2=lg[l]; d2["n"]+=1
        if "HDA"[idx]==act: d2["corr"]+=1
    ok=[(k,v) for k,v in lg.items() if v["n"]>=150]
    ok.sort(key=lambda kv: kv[1]["corr"]/kv[1]["n"])
    print(f"\nLigues (n>=150) - les 4 pires / 4 meilleures acc :")
    for k,v in ok[:4]: print(f"  pire   {k:6s} n={v['n']:5d} acc={pct(v['corr']/v['n'])}")
    for k,v in ok[-4:]: print(f"  mieux  {k:6s} n={v['n']:5d} acc={pct(v['corr']/v['n'])}")

# ---------- O/U + BTTS : matches ----------
def ou_btts():
    con=sqlite3.connect(DB); cur=con.cursor()
    rows=cur.execute("""SELECT ou_25_prob, btts_prob, scoreHome, scoreAway FROM matches
                        WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL""").fetchall()
    con.close()
    fo=scale(*[r[0] for r in rows[:50] if r[0] is not None]+[0])
    fb=scale(*[r[1] for r in rows[:50] if r[1] is not None]+[0])
    section(f"OVER/UNDER 2.5 + BTTS PRODUCTION (matches) - n={len(rows)} (f_o={fo}, f_btts={fb})")
    n=o=0; b=ob=0; sumo=0.0; sumb=0.0
    for po,pb,sh,sa in rows:
        po=num(po); pb=num(pb)
        if po is not None:
            po*=fo; tot=sh+sa; n+=1; sumo+=po
            if tot>=3: o+=1
        if pb is not None:
            pb*=fb; b+=1; sumb+=pb
            if sh>0 and sa>0: ob+=1
    if n: print(f"Over2.5 : pred moy={pct(sumo/n)}  reel={pct(o/n)}  ecart={100*(o/n-sumo/n):+.1f}pts (n={n})")
    if b: print(f"BTTS    : pred moy={pct(sumb/b)}  reel={pct(ob/b)}  ecart={100*(ob/b-sumb/b):+.1f}pts (n={b})")

    # calibration over par tranche
    edges=[0.0,0.35,0.45,0.55,0.65,1.0]
    agg=defaultdict(lambda:{"n":0,"over":0,"p":0.0})
    for po,pb,sh,sa in rows:
        po=num(po)
        if po is None: continue
        po*=fo; b2=None
        for i in range(len(edges)-1):
            if edges[i]<=po<edges[i+1]: b2=f"[{edges[i]:.2f},{edges[i+1]:.2f})"; break
        if b2 is None: continue
        d2=agg[b2]; d2["n"]+=1; d2["p"]+=po
        if sh+sa>=3: d2["over"]+=1
    print(f"\n{'pred Over':12s} {'n':>5s} {'pred':>7s} {'reel':>7s} {'ecart':>7s}")
    for i in range(len(edges)-1):
        b2=f"[{edges[i]:.2f},{edges[i+1]:.2f})"; d2=agg[b2]
        if d2["n"]==0: continue
        print(f"{b2:12s} {d2['n']:5d} {pct(d2['p']/d2['n']):>7s} {pct(d2['over']/d2['n']):>7s} {100*(d2['over']/d2['n']-d2['p']/d2['n']):+6.1f}")

# ---------- learning_memory : modele vs marche ----------
def learning():
    con=sqlite3.connect(DB); cur=con.cursor()
    rows=cur.execute("""SELECT p_home,p_draw,p_away,odds_home,odds_draw,odds_away,actual_1x2,league
                        FROM learning_memory WHERE p_home IS NOT NULL""").fetchall()
    con.close()
    f=scale(*[rows[0][0],rows[0][1],rows[0][2]])
    mact={"H","D","A"}
    data=[]
    for ph,pd,pa,oh,od,oa,act,lg in rows:
        ph,pd,pa=num(ph),num(pd),num(pa)
        if None in (ph,pd,pa): continue
        ph,pd,pa=ph*f,pd*f,pa*f; s=ph+pd+pa
        if s<=0: continue
        ph,pd,pa=ph/s,pd/s,pa/s
        act=str(act).strip().upper()
        if act in ("1",): act="H"
        elif act in ("2",): act="A"
        elif act in ("X",): act="D"
        if act not in mact: continue
        data.append((ph,pd,pa,oh,od,oa,act,lg))
    section(f"MODULE vs MARCHE (learning_memory) - n={len(data)} (facteur={f})")
    corr=0; mk=0; nm=0
    for ph,pd,pa,oh,od,oa,act,lg in data:
        idx=max(range(3),key=lambda i:[ph,pd,pa][i])
        if "HDA"[idx]==act: corr+=1
        if oh and od and oa:
            try:
                o=[num(oh),num(od),num(oa)]
                if all(x and x>1 for x in o):
                    mi=max(range(3),key=lambda i:1/o[i]); nm+=1
                    if "HDA"[mi]==act: mk+=1
            except: pass
    print(f"Modele  acc : {pct(corr/len(data))}")
    if nm: print(f"Marche  acc : {pct(mk/nm)}  (n={nm} avec cotes)")

def main():
    onex2_historical()
    ou_btts()
    learning()
if __name__=="__main__": main()

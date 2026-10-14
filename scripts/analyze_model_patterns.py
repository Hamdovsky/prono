# -*- coding: utf-8 -*-
"""Analyse des erreurs du modele (OOF) : calibration, overconfidence, ligues, ensemble, valeur."""
import csv, os, math
from collections import defaultdict

BASE = r"C:\Users\HAMDI\Desktop\HamdiProno\stitch"
OOF = os.path.join(BASE, "data_pipeline", "data", "processed", "oof_1x2.csv")

MODELS = ["lr","rf","xgb","promo","elo_xgb","xg_xgb","close_xgb","dc","poisson"]

def pf(s):
    try: return float(s)
    except: return None

def load():
    rows=[]
    with open(OOF, encoding="utf-8") as f:
        r=csv.DictReader(f)
        for d in r:
            try: y=int(d["y_true"])
            except: continue
            row={"y":y,"league":d.get("league","")}
            ok=True; tot=0.0
            for m in MODELS:
                h=pf(d[f"p_{m}_H"]); dr=pf(d[f"p_{m}_D"]); a=pf(d[f"p_{m}_A"])
                if h is None or dr is None or a is None:
                    ok=False; break
                row[m]=(h,dr,a); tot+=h+dr+a
            if ok and tot>1.5:  # au moins un modele non nul
                rows.append(row)
    return rows

def pct(x): return f"{100*x:5.1f}%" if x is not None else "  n/a"

def infer_map(rows):
    # moyenne des probs par y_true -> argmax = issue reelle
    acc=defaultdict(lambda:[0.0,0.0,0.0,0])
    for r in rows:
        h,d,a=r["xgb"]; v=acc[r["y"]]; v[0]+=h; v[1]+=d; v[2]+=a; v[3]+=1
    m={}
    for y,(h,d,a,n) in acc.items():
        idx=max(range(3), key=lambda i:[h,d,a][i])
        m[y]="HDA"[idx]
    return m

def metrics(rows, model, ymap):
    # classe predite = argmax ; accuracy + brier multi
    n=0; correct=0; brier=0.0; logloss=0.0; eps=1e-15
    for r in rows:
        p=r[model]; idx=max(range(3), key=lambda i:p[i])
        y=r["y"]; actual="HDA".index(ymap[y])
        if idx==actual: correct+=1
        oh=[1 if i==actual else 0 for i in range(3)]
        brier+=sum((p[i]-oh[i])**2 for i in range(3))
        logloss+=-math.log(max(p[actual],eps))
        n+=1
    return n, correct/n, brier/n, logloss/n

def section(t):
    print("\n"+"="*84); print(t); print("="*84)

def main():
    rows=load()
    section(f"MODELES OOF - {len(rows)} matchs valides")
    ymap=infer_map(rows)
    print("Mapping y_true -> issue :", ymap)
    print(f"\n{'modele':10s} {'acc':>7s} {'acc(baseline favori cotes)':>0s} Brier   LogLoss")
    res={}
    for m in MODELS:
        n,acc,br,ll=metrics(rows,m,ymap); res[m]=(acc,br,ll)
        print(f"{m:10s} {pct(acc)}   {'':24s} {br:.4f}  {ll:.4f}")
    # baseline: suivre le favori cotes (1/odds) ? pas dispo ici -> suivre max prob xgb = deja.
    best=max(res, key=lambda m:res[m][0])
    print(f"\nMeilleur modele simple : {best} acc={pct(res[best][0])}")
    # ensemble moyenne des 3 meilleurs
    top3=sorted(MODELS,key=lambda m:res[m][0],reverse=True)[:3]
    print("Top3 :",top3)
    n=0;corr=0;br=0.0;ll=0.0;eps=1e-15
    for r in rows:
        p=[sum(r[m][i] for m in top3)/3 for i in range(3)]
        idx=max(range(3),key=lambda i:p[i]); actual="HDA".index(ymap[r["y"]])
        if idx==actual: corr+=1
        oh=[1 if i==actual else 0 for i in range(3)]
        br+=sum((p[i]-oh[i])**2 for i in range(3)); ll+=-math.log(max(p[actual],eps)); n+=1
    print(f"ENSEMBLE top3 moyenne : acc={pct(corr/n)} Brier={br/n:.4f} LogLoss={ll/n:.4f}")

    # Calibration / overconfidence du XGB par tranche de proba max
    section("XGB - overconfidence par proba max predite (favori du modele)")
    edges=[1/3,0.40,0.50,0.60,0.70,0.80,1.01]
    agg=defaultdict(lambda:{"n":0,"corr":0,"p":0.0})
    for r in rows:
        p=r["xgb"]; mx=max(p); idx=max(range(3),key=lambda i:p[i])
        actual="HDA".index(ymap[r["y"]])
        b=None
        for i in range(len(edges)-1):
            if edges[i]<=mx<edges[i+1]: b=f"[{edges[i]:.2f},{edges[i+1]:.2f})"; break
        if b is None: continue
        d=agg[b]; d["n"]+=1; d["p"]+=mx
        if idx==actual: d["corr"]+=1
    print(f"{'max prob':14s} {'n':>6s} {'conf moy':>9s} {'justesse':>9s} {'ecart':>7s}")
    for i in range(len(edges)-1):
        b=f"[{edges[i]:.2f},{edges[i+1]:.2f})"; d=agg[b]
        if d["n"]==0: continue
        conf=d["p"]/d["n"]; acc=d["corr"]/d["n"]
        print(f"{b:14s} {d['n']:6d} {pct(conf):>9s} {pct(acc):>9s} {100*(acc-conf):+6.1f}")

    # par ligue : ou le XGB se trompe le plus (sur matchs ou il est confiant >= 50%)
    section("XGB - performance par ligue (matchs confiants max prob>=0.50)")
    lg=defaultdict(lambda:{"n":0,"corr":0})
    for r in rows:
        p=r["xgb"]; mx=max(p)
        if mx<0.50: continue
        idx=max(range(3),key=lambda i:p[i]); actual="HDA".index(ymap[r["y"]])
        d=lg[r["league"]]; d["n"]+=1
        if idx==actual: d["corr"]+=1
    ok=[(k,v) for k,v in lg.items() if v["n"]>=200]
    ok.sort(key=lambda kv: kv[1]["corr"]/kv[1]["n"])
    print("5 pires ligues :")
    for k,v in ok[:5]: print(f"  {k:6s} n={v['n']:5d} acc={pct(v['corr']/v['n'])}")
    print("5 meilleures ligues :")
    for k,v in ok[-5:]: print(f"  {k:6s} n={v['n']:5d} acc={pct(v['corr']/v['n'])}")

    # divergence modele vs marche (close_xgb) : qui a raison ?
    section("Divergence XGB vs marche (close_xgb) sur le favori")
    n=0;xgb_right=0;mkt_right=0
    for r in rows:
        px=r["xgb"]; pm=r["close_xgb"]
        ix=max(range(3),key=lambda i:px[i]); im=max(range(3),key=lambda i:pm[i])
        if ix==im: continue
        actual="HDA".index(ymap[r["y"]]); n+=1
        if ix==actual: xgb_right+=1
        if im==actual: mkt_right+=1
    if n:
        print(f"Desaccord sur le favori : n={n} ({pct(n/len(rows))} des matchs)")
        print(f"  XGB a raison    : {pct(xgb_right/n)}")
        print(f"  Marche a raison : {pct(mkt_right/n)}")

if __name__=="__main__":
    main()

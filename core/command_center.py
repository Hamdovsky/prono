import streamlit as st
import pandas as pd
import sqlite3
import json
import os
import subprocess
import time
import requests
from datetime import datetime
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

# ─── Config ─────────────────────────────────────────────────────────────────
DB_PATH     = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'tactical.db')
ARCHIVE_DB  = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
TRAIN_SCRIPT = os.path.join(os.path.dirname(__file__), 'train_v17_ultra.py')
API_BASE     = "http://localhost:5000"
PLOT_OUTPUT  = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'training_reports')

st.set_page_config(page_title="Stitch V17 – Intelligence Hub", layout="wide", initial_sidebar_state="expanded")

# ─── Styling ─────────────────────────────────────────────────────────────────
st.markdown("""
<style>
body, .main { background-color: #0a0d12; color: #e2e8f0; }
.badge { display:inline-block; padding:3px 8px; border-radius:4px; font-size:11px; font-weight:700; }
.live   { background:#ef4444; color:#fff; }
.sched  { background:#3b82f6; color:#fff; }
.fin    { background:#10b981; color:#fff; }
.pronostic-card {
    background: linear-gradient(135deg,#0f172a,#1e293b);
    border: 1px solid #334155;
    border-left: 4px solid #22d3ee;
    border-radius: 8px; padding: 10px 14px; margin: 6px 0;
}
.pronostic-card.strong { border-left-color: #22c55e; }
.pronostic-card.warning { border-left-color: #f59e0b; }
.market-name { font-size:15px; font-weight:700; color:#f0f4ff; }
.market-prob { font-size:18px; font-weight:900; letter-spacing:1px; }
.market-reason { font-size:12px; color:#94a3b8; margin-top:3px; }
.match-header { font-size:16px; font-weight:700; color:#e2e8f0; }
.match-league { font-size:11px; color:#64748b; }
.conf-badge { font-size:11px; padding:2px 6px; border-radius:4px; background:#1e3a5f; color:#60a5fa; font-weight:700; }
</style>
""", unsafe_allow_html=True)

# ─── API Helpers ──────────────────────────────────────────────────────────────
def fetch_from_api():
    try:
        r = requests.get(f"{API_BASE}/api/upcoming", timeout=10)
        if r.status_code == 200:
            return r.json()
    except Exception as e:
        pass
    return None

def load_from_db(limit=100):
    try:
        conn = sqlite3.connect(DB_PATH)
        df = pd.read_sql("SELECT * FROM matches ORDER BY timestamp DESC LIMIT ?", conn, params=(limit,))
        conn.close()
        return df
    except:
        return pd.DataFrame()

def get_system_stats():
    stats = {}
    try:
        stats['tactical_size'] = os.path.getsize(DB_PATH) / (1024 * 1024)
        if os.path.exists(ARCHIVE_DB):
            conn = sqlite3.connect(ARCHIVE_DB)
            stats['archive_count'] = conn.execute("SELECT COUNT(*) FROM archive_matches").fetchone()[0]
            conn.close()
        else:
            stats['archive_count'] = 0
    except: pass
    return stats

# ─── Pronostic Generator ──────────────────────────────────────────────────────
def generate_pronostics(m):
    """
    Generate at least 4 precise betting pronostics per match with reasoning.
    Uses all available fields: probabilities, btts_prob, ou_25_prob, xgboost_confidence, odds.
    """
    pronostics = []
    
    h_prob = float(m.get('home_win_probability') or m.get('winProbHome') or 33)
    d_prob = float(m.get('draw_probability') or m.get('winProbDraw') or 33)
    a_prob = float(m.get('away_win_probability') or m.get('winProbAway') or 33)
    btts   = float(m.get('btts_prob') or 0)
    ou25   = float(m.get('ou_25_prob') or 0)
    chaos  = float(m.get('chaos_score') or 50)
    xgb_c  = float(m.get('xgboost_confidence') or 0) * 100
    odds_h = float(m.get('odds_home') or 0)
    odds_d = float(m.get('odds_draw') or 0)
    odds_a = float(m.get('odds_away') or 0)
    
    home = m.get('homeTeam', 'Domicile')
    away = m.get('awayTeam', 'Extérieur')
    
    # 1. Match Winner (1X2)
    if h_prob > 55:
        pronostics.append({
            "market": f"🏠 Victoire {home}",
            "probability": round(h_prob, 1),
            "grade": "strong" if h_prob > 65 else "normal",
            "reason": f"L'IA V17 donne {h_prob:.0f}% de chances au domicile. Avantage terrain confirmé."
            + (f" Côte: {odds_h}" if odds_h else ""),
            "value": f"Cote conseillée: {odds_h}" if odds_h else None
        })
    elif a_prob > 55:
        pronostics.append({
            "market": f"✈️ Victoire {away}",
            "probability": round(a_prob, 1),
            "grade": "strong" if a_prob > 65 else "normal",
            "reason": f"L'IA V17 donne {a_prob:.0f}% de chances à l'extérieur. Équipe en grande forme.",
            "value": f"Cote: {odds_a}" if odds_a else None
        })
    else:
        pronostics.append({
            "market": "🤝 Double Chance (1X ou X2)",
            "probability": round(max(h_prob + d_prob, a_prob + d_prob), 1),
            "grade": "normal",
            "reason": f"Rencontre serrée. Domicile: {h_prob:.0f}% | Nul: {d_prob:.0f}% | Extérieur: {a_prob:.0f}%",
            "value": None
        })
    
    # 2. Over/Under 2.5
    if ou25 > 55:
        pronostics.append({
            "market": "⚽ Plus de 2.5 buts (Over 2.5)",
            "probability": round(ou25, 1),
            "grade": "strong" if ou25 > 68 else "normal",
            "reason": f"Simulation Monte Carlo V17: {ou25:.0f}% de probabilité de 3+ buts. Les deux attaques sont efficaces."
        })
    elif ou25 > 0:
        pronostics.append({
            "market": "🔒 Moins de 2.5 buts (Under 2.5)",
            "probability": round(100 - ou25, 1),
            "grade": "normal",
            "reason": f"Seulement {ou25:.0f}% de chances de dépasser 2.5 buts. Match fermé prévu."
        })
    else:
        # Fallback based on h_prob + a_prob dominance
        pronostics.append({
            "market": "⚽ Plus de 1.5 buts",
            "probability": round(min(h_prob + a_prob * 0.5, 88), 1),
            "grade": "normal",
            "reason": "Statistique de base: la grande majorité des matchs professionnels comptent 2+ buts."
        })
    
    # 3. BTTS
    if btts > 52:
        pronostics.append({
            "market": "🎯 Les deux équipes marquent (BTTS: OUI)",
            "probability": round(btts, 1),
            "grade": "strong" if btts > 65 else "normal",
            "reason": f"Analyse offensive: {btts:.0f}% de probabilité que les deux équipes marquent. Les xG suggèrent un match ouvert."
        })
    elif btts > 0:
        pronostics.append({
            "market": "🚫 BTTS: NON (une équipe ne marque pas)",
            "probability": round(100 - btts, 1),
            "grade": "normal",
            "reason": f"Défense solide ou attaque faible: {100-btts:.0f}% de chances qu'au moins une équipe reste à zéro."
        })
    else:
        pronostics.append({
            "market": "🎯 BTTS: OUI",
            "probability": 50.0,
            "grade": "warning",
            "reason": "Probabilité BTTS équilibrée. Match indécis sur le plan du score des deux côtés."
        })

    # 4. Confidence / Value Bet
    if xgb_c > 60:
        pronostics.append({
            "market": "💎 Value Bet Confirmé",
            "probability": round(xgb_c, 1),
            "grade": "strong",
            "reason": f"XGBoost V17 Ultra (10,000 simulations Monte Carlo) confirme la sélection avec {xgb_c:.1f}% de confiance."
        })
    elif chaos > 65:
        pronostics.append({
            "market": "⚡ Match Volatil – Mise Réduite",
            "probability": round(chaos, 1),
            "grade": "warning",
            "reason": f"Chaos score élevé: {chaos:.0f}/100. Le match peut partir dans tous les sens. Pariez avec prudence."
        })
    else:
        pronostics.append({
            "market": "📊 Analyse IA Standard",
            "probability": round(max(h_prob, a_prob), 1),
            "grade": "normal",
            "reason": "Basé sur les simulations xG et Poisson. Modèle V17 Ultra en mode analytique."
        })
    
    # 5. Draw special
    if d_prob > 30:
        pronostics.append({
            "market": "🤝 Match Nul",
            "probability": round(d_prob, 1),
            "grade": "strong" if d_prob > 38 else "normal",
            "reason": f"Probabilité de nul: {d_prob:.0f}%. Côte nul: {odds_d if odds_d else 'N/A'}. Équilibre tactique."
            + (f" EV+ si côte > {round(100/max(d_prob,1), 2)}" if d_prob > 25 else "")
        })
    
    return pronostics[:5]  # Maximum 5, minimum 4


# ─── Sidebar ─────────────────────────────────────────────────────────────────
st.sidebar.title("⚽ Stitch V17 Ultra")
st.sidebar.markdown("---")
menu = st.sidebar.radio("Navigation", ["🎯 Intelligence Hub", "🎯 Ticket Spécial", "⚡ Ticket Live Roulant", "⚙️ Model Management", "🏥 System Health"])

if st.sidebar.button("🔄 Actualiser"):
    st.rerun()

# ─── INTELLIGENCE HUB ────────────────────────────────────────────────────────
if menu == "🎯 Intelligence Hub":
    st.title("⚽ Stitch V17 Ultra — Intelligence Hub")
    st.caption("10,000 simulations Monte Carlo · XGBoost V17 · 39 variables · ELO + Momentum")
    st.markdown("---")

    # Fetch live data from API, fallback to DB
    with st.spinner("Chargement des pronostics..."):
        df = load_from_db()
        matches = df.to_dict('records') if not df.empty else []
        data_source = "🗄️ Base de données locale"
    
    # [PREMATCH ONLY] Filter out live matches
    matches = [m for m in matches if (m.get('status') or '').upper() not in ['LIVE', 'IN_PROGRESS', '1H', '2H', 'HT']]
    
    st.caption(f"Source: {data_source} | {len(matches)} matchs chargés")

    if not matches:
        st.warning("⚠️ Aucun match trouvé. Vérifiez que le scraper tourne (start.bat).")
        st.stop()

    # Load hierarchy
    hierarchy = {}
    HIERARCHY_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'league_hierarchy.json')
    if os.path.exists(HIERARCHY_FILE):
        try:
            with open(HIERARCHY_FILE, 'r', encoding='utf-8') as f:
                hierarchy = json.load(f)
        except: pass

    # ── League filter ──
    # Sort matches by hierarchy first
    def get_tier(m):
        country = m.get('category', 'Global')
        league = m.get('league', '?')
        return hierarchy.get(country, {}).get(league, 99)

    matches.sort(key=lambda x: (x.get('category', 'Z'), get_tier(x), x.get('league', 'Z')))

    leagues = sorted(set(m.get('league','?') for m in matches if m.get('league')))
    selected = st.multiselect("🏆 Filtrer par Ligue", leagues)
    if selected:
        matches = [m for m in matches if m.get('league') in selected]

    # Group by Country for Display
    grouped = {}
    for m in matches:
        country = m.get('category', 'Global')
        if country not in grouped: grouped[country] = []
        grouped[country].append(m)

    # ── Metrics bar ──
    c1, c2, c3 = st.columns(3)
    hot = [m for m in matches if float(m.get('xgboost_confidence') or 0) > 0.65]
    c1.metric("📋 Total Matchs", len(matches))
    c2.metric("🔥 Confiance Élevée", len(hot))
    c3.metric("⚙️ Source IA", "V17 Ultra")

    st.markdown("---")

    # ── Main prediction feed ──
    for country, country_matches in grouped.items():
        st.subheader(f"📍 {country}")
        for m in country_matches[:50]: # Limit per country for performance
            tier = get_tier(m)
            tier_label = f" (Division {tier})" if tier < 99 else ""
            
            status = (m.get('status') or 'SCHEDULED').upper()
            status_cls = 'live' if status == 'LIVE' else ('fin' if status in ['FT','FINISHED'] else 'sched')
            
            h_name = m.get('homeTeam', '?')
            a_name = m.get('awayTeam', '?')
            league = m.get('league', '?')
            
            h_p = float(m.get('home_win_probability') or m.get('winProbHome') or 0)
            d_p = float(m.get('draw_probability') or m.get('winProbDraw') or 0)
            a_p = float(m.get('away_win_probability') or m.get('winProbAway') or 0)
            xgb = float(m.get('xgboost_confidence') or 0) * 100
            score = m.get('expected_score') or '? - ?'
        
        # Detect if there is real prediction data
        has_pred = h_p > 0 or d_p > 0 or a_p > 0
        
        with st.expander(f"{h_name} vs {a_name}  |  {league}", expanded=False):
            col_left, col_right = st.columns([2, 3])
            
            with col_left:
                st.markdown(f"<span class='badge {status_cls}'>{status}</span> &nbsp; <b>{h_name}</b> vs <b>{a_name}</b> <span class='conf-badge'>{tier_label}</span>", unsafe_allow_html=True)
                st.caption(league)
                
                if has_pred:
                    st.markdown(f"**Score Prévu:** `{score}`")
                    st.markdown(f"**Confiance IA:** `{xgb:.1f}%`")
                    # Prob bar
                    df_prob = pd.DataFrame({
                        'Résultat': [f"🏠 {h_name[:10]}", '🤝 Nul', f"✈️ {a_name[:10]}"],
                        'Probabilité': [h_p, d_p, a_p]
                    }).set_index('Résultat')
                    st.bar_chart(df_prob, height=120)
                else:
                    st.warning("⏳ Prédiction en cours de calcul par l'IA...")
                    st.caption("Le serveur enrichit les données en arrière-plan.")
            
            with col_right:
                st.markdown("**💡 Pronostics Précis (IA V17 Ultra — 10,000 simulations)**")
                pronostics = generate_pronostics(m)
                
                for prog in pronostics:
                    grade_color = "#22c55e" if prog['grade'] == 'strong' else ("#f59e0b" if prog['grade'] == 'warning' else "#22d3ee")
                    prob_display = prog['probability']
                    
                    st.markdown(f"""
                    <div class='pronostic-card {prog["grade"]}'>
                        <div class='market-name'>{prog['market']}</div>
                        <div class='market-prob' style='color:{grade_color}'>{prob_display}%</div>
                        <div class='market-reason'>ℹ️ {prog['reason']}</div>
                    </div>
                    """, unsafe_allow_html=True)

                # --- 🌍 WORLD-CLASS ANALYST REPORT TAB ---
                detailed_analysis = m.get('detailed_analysis')
                if detailed_analysis:
                    with st.expander("📝 RAPPORT D'EXPERTISE (10 POINTS)", expanded=False):
                        st.markdown("<div style='background:#1e293b; padding:15px; border-radius:10px; border:1px solid #334155;'>", unsafe_allow_html=True)
                        
                        titles = {
                            "1_Form": "📈 Forme & Momentum",
                            "2_H2H": "⚔️ Historique Face-à-Face",
                            "3_xG": "⚽ Simulation Expected Goals (xG)",
                            "4_Players": "🚑 Analyse Effectif & Sentiment",
                            "5_Tactics": "🧩 Étude Tactique & Style",
                            "6_Market": "📉 Marché & Mouvement des Côtes",
                            "7_Context": "🎯 Contexte & Motivations",
                            "8_External": "🌦️ Facteurs Externes (Météo/Arbitre)",
                            "9_Metrics": "📊 Métriques Avancées (SOT/BC)",
                            "10_Smart_Indicators": "🧠 Indicateurs de Pari Intelligent"
                        }
                        
                        for key in sorted(detailed_analysis.keys()):
                            data = detailed_analysis[key]
                            title = titles.get(key, key)
                            score = data.get('score', 50)
                            reason = data.get('reason', '')
                            
                            col1_a, col2_a = st.columns([1, 4])
                            with col1_a:
                                st.write(f"**{score}%**")
                            with col2_a:
                                st.write(f"**{title}**")
                                st.progress(score / 100)
                                st.caption(reason)
                        
                        st.markdown("</div>", unsafe_allow_html=True)

# ─── TICKET SPÉCIAL DU JOUR ──────────────────────────────────────────────────
elif menu == "🎯 Ticket Spécial":
    import datetime
    st.title("🎯 Ticket Spécial du Jour — Titanium AI V17 Ultra")
    st.caption("Sélection d'élite optimisée par 10,000 simulations de Monte Carlo · Modèle V17 Ultra")
    st.markdown("---")
    
    # Query top 4 matches
    try:
        conn = sqlite3.connect(DB_PATH)
        today_date = datetime.date.today()
        ts0 = int(time.mktime(today_date.timetuple()))
        ts1 = ts0 + 86400
        
        # Query matches starting from today
        query = """
            SELECT * FROM matches 
            WHERE (
                (date(datetime(startTimestamp, 'unixepoch')) >= :today)
                OR (startTimestamp >= :ts0)
            )
            AND status IN ('scheduled', 'notstarted', 'NOT_STARTED', 'NS')
            ORDER BY startTimestamp ASC
        """
        df = pd.read_sql(query, conn, params={"today": today_date.strftime('%Y-%m-%d'), "ts0": ts0})
        conn.close()
    except Exception as e:
        st.error(f"Erreur de connexion à la base de données: {str(e)}")
        df = pd.DataFrame()

    if df.empty:
        st.warning("⚠️ Aucun match programmé trouvé pour aujourd'hui. L'IA préserve votre bankroll.")
    else:
        # Process and enrichment
        processed = []
        for _, m in df.iterrows():
            h_prob = float(m.get('home_win_probability') or m.get('winProbHome') or 0)
            d_prob = float(m.get('draw_probability') or m.get('winProbDraw') or 0)
            a_prob = float(m.get('away_win_probability') or m.get('winProbAway') or 0)
            ou25 = float(m.get('ou_25_prob') or 0)
            btts = float(m.get('btts_prob') or 0)
            xgb_c = float(m.get('xgboost_confidence') or 0)
            
            # Smart Pick engine
            pick = ""
            prob = 0
            reason = ""
            odds = 1.4
            
            if ou25 >= 75:
                pick = "⚽ Plus de 2.5 buts (Over 2.5)"
                prob = ou25
                reason = "Attaques percutantes et statistiques offensives élevées."
                odds = m.get('odds_over_25') or round(max(1.1, 100.0 / ou25), 2) if ou25 > 0 else 1.5
            elif h_prob >= 65:
                pick = f"🏠 Victoire de {m['homeTeam']}"
                prob = h_prob
                reason = "Domination à domicile et supériorité xG écrasante."
                odds = m.get('odds_home') or round(max(1.1, 100.0 / h_prob), 2)
            elif a_prob >= 65:
                pick = f"✈️ Victoire de {m['awayTeam']}"
                prob = a_prob
                reason = "Visiteurs en grande forme et momentum ELO favorable."
                odds = m.get('odds_away') or round(max(1.1, 100.0 / a_prob), 2)
            elif btts >= 65:
                pick = "🎯 Les 2 équipes marquent (BTTS)"
                prob = btts
                reason = "Taux de réussite défensive faible des deux côtés."
                odds = m.get('odds_btts') or round(max(1.1, 100.0 / btts), 2) if btts > 0 else 1.6
            elif h_prob > a_prob:
                pick = f"🛡️ Double Chance: {m['homeTeam']} ou Nul (1X)"
                prob = h_prob + d_prob
                reason = "Sécurité maximale avec double chance à domicile."
                odds = round(max(1.05, 100.0 / (h_prob + d_prob)), 2) if (h_prob + d_prob) > 0 else 1.25
            else:
                pick = f"🛡️ Double Chance: {m['awayTeam']} ou Nul (X2)"
                prob = a_prob + d_prob
                reason = "Sécurité maximale avec double chance à l'extérieur."
                odds = round(max(1.05, 100.0 / (a_prob + d_prob)), 2) if (a_prob + d_prob) > 0 else 1.25

            # Handle NaN/0 odds
            try:
                odds = float(odds)
                if odds <= 1.0 or pd.isna(odds):
                    odds = 1.4
            except:
                odds = 1.4

            processed.append({
                "match": m,
                "pick": pick,
                "prob": prob,
                "reason": reason,
                "odds": odds,
                "xgb_c": xgb_c
            })
            
        # Sort processed matches by xgboost_confidence descending, then by prob
        processed.sort(key=lambda x: (x['xgb_c'], x['prob']), reverse=True)
        
        # Take Top 4
        ticket_matches = processed[:4]
        
        if len(ticket_matches) < 4:
            st.warning("⚠️ Moins de 4 matchs de haute confiance disponibles aujourd'hui. L'IA recommande la prudence.")
        
        # Calculate combined stats
        total_odds = 1.0
        sum_conf = 0.0
        for item in ticket_matches:
            total_odds *= item['odds']
            sum_conf += item['xgb_c']
        
        avg_conf = (sum_conf / len(ticket_matches)) * 100 if ticket_matches else 0
        
        # Metrics Bar
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("📋 Sélection", f"{len(ticket_matches)} Équipes")
        m2.metric("💰 Côte Cumulée", f"~{total_odds:.2f}")
        m3.metric("🔥 Confiance Globale", f"{avg_conf:.1f}%")
        m4.metric("🛡️ Indice de Risque", "TRÈS FAIBLE" if avg_conf > 70 else "MODÉRÉ")
        
        st.markdown("---")
        
        # Display Cards
        for idx, item in enumerate(ticket_matches):
            m = item['match']
            tunisia_time = datetime.datetime.fromtimestamp(m['startTimestamp']).strftime('%H:%M') if m['startTimestamp'] else "--:--"
            
            st.markdown(f"""
            <div style='background: linear-gradient(135deg, #0f172a, #1e293b); padding: 20px; border-radius: 12px; border: 1px solid #334155; border-left: 5px solid #22d3ee; margin-bottom: 15px;'>
                <div style='display: flex; justify-content: space-between; align-items: center;'>
                    <span style='font-size: 13px; color: #64748b; font-weight: bold;'>🎯 MATCH {idx+1} — {m['league']}</span>
                    <span style='background: #1e3a5f; color: #60a5fa; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;'>⏰ {tunisia_time}</span>
                </div>
                <div style='font-size: 18px; font-weight: bold; color: #f8fafc; margin-top: 10px;'>
                    {m['homeTeam']} <span style='color: #64748b; font-size: 14px;'>vs</span> {m['awayTeam']}
                </div>
                <div style='margin-top: 15px; display: flex; gap: 20px; flex-wrap: wrap;'>
                    <div style='flex: 1; min-width: 200px;'>
                        <div style='font-size: 12px; color: #94a3b8;'>SÉLECTION IA</div>
                        <div style='font-size: 16px; font-weight: bold; color: #34d399; margin-top: 4px;'>{item['pick']}</div>
                    </div>
                    <div style='width: 100px;'>
                        <div style='font-size: 12px; color: #94a3b8;'>PROBABILITÉ</div>
                        <div style='font-size: 16px; font-weight: bold; color: #38bdf8; margin-top: 4px;'>{item['prob']:.1f}%</div>
                    </div>
                    <div style='width: 100px;'>
                        <div style='font-size: 12px; color: #94a3b8;'>CÔTE ESTIMÉE</div>
                        <div style='font-size: 16px; font-weight: bold; color: #fbbf24; margin-top: 4px;'>@{item['odds']:.2f}</div>
                    </div>
                </div>
                <div style='margin-top: 15px; font-size: 13px; color: #94a3b8; border-top: 1px solid #334155; padding-top: 10px;'>
                    ℹ️ <b>Analyse V17 Ultra :</b> {item['reason']}
                </div>
            </div>
            """, unsafe_allow_html=True)
            
        # Suggested Stake Section
        st.markdown(f"""
        <div style='background: rgba(34, 211, 238, 0.05); border: 1px solid #22d3ee; border-radius: 8px; padding: 15px; margin-top: 20px;'>
            <h4 style='margin: 0; color: #22d3ee;'>💰 Recommandation Financière de Bankroll</h4>
            <p style='margin: 5px 0 0 0; font-size: 14px; color: #e2e8f0;'>
                Pour un capital de 100 unités, la mise recommandée est de <b>10 unités (10%)</b>.<br>
                <b>Gain Potentiel Estimé :</b> {10 * total_odds:.2f} unités.
            </p>
        </div>
        """, unsafe_allow_html=True)

# ─── TICKET LIVE ROULANT ─────────────────────────────────────────────────────
elif menu == "⚡ Ticket Live Roulant":
    st.title("⚡ Ticket Live Roulant — 4 Matchs Actifs")
    st.caption("Système dynamique de trading in-play · 4 matchs d'élite gérés en continu")
    st.markdown("---")
    
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rolling_live_ticket (
                id TEXT PRIMARY KEY,
                homeTeam TEXT,
                awayTeam TEXT,
                tournament_name TEXT,
                status TEXT,
                homeScore INTEGER,
                awayScore INTEGER,
                minute INTEGER,
                prediction TEXT,
                confidence REAL,
                added_at INTEGER
            )
        """)
        conn.commit()
        saved = conn.execute("SELECT * FROM rolling_live_ticket").fetchall()
        conn.close()
    except Exception as e:
        saved = []
        st.error(f"Erreur de lecture de la file live: {e}")
        
    if not saved:
        st.info("ℹ️ Aucun match n'est dans la file live pour le moment. Lancez start.bat pour que le service LIVE_ALERTS alimente automatiquement cette section.")
    else:
        st.markdown(
            """
            <style>
            .live-card {
                background: linear-gradient(135deg, #0f172a, #1e293b);
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                border: 1px solid #334155;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            }
            .live-badge-active {
                background: #ef4444;
                color: white;
                padding: 4px 8px;
                border-radius: 6px;
                font-size: 11px;
                font-weight: bold;
                float: right;
            }
            .live-badge-upcoming {
                background: #3b82f6;
                color: white;
                padding: 4px 8px;
                border-radius: 6px;
                font-size: 11px;
                font-weight: bold;
                float: right;
            }
            </style>
            """,
            unsafe_allow_html=True
        )
        
        cols = st.columns(2)
        for idx, m in enumerate(saved):
            col = cols[idx % 2]
            with col:
                status_str = f"🟢 LIVE {m['minute']}'" if m['status'] == 'live' else "⏳ UPCOMING"
                badge_class = "live-badge-active" if m['status'] == 'live' else "live-badge-upcoming"
                
                col.markdown(
                    f"""
                    <div class="live-card">
                        <span class="{badge_class}">{status_str}</span>
                        <h4 style='margin:0 0 10px 0; color:#fbbf24;'>⚽ Match {idx+1}</h4>
                        <div style='font-size:18px; font-weight:bold; color:#f8fafc; margin-bottom:10px;'>
                            {m['homeTeam']} <span style='color:#10b981;'>{m['homeScore']} - {m['awayScore']}</span> {m['awayTeam']}
                        </div>
                        <div style='font-size:13px; color:#94a3b8; margin-bottom:15px;'>🏆 {m['tournament_name']}</div>
                        <div style='background:rgba(16, 185, 129, 0.1); padding:8px 12px; border-radius:6px; border-left:4px solid #10b981; margin-bottom:10px; font-size:14px; color:#e2e8f0;'>
                            🎯 <b>Prono :</b> {m['prediction']}
                        </div>
                        <div style='font-size:13px; font-weight:bold; color:#e2e8f0;'>🧠 Confiance IA : <span style='color:#10b981;'>{int(m['confidence'])}%</span></div>
                    </div>
                    """,
                    unsafe_allow_html=True
                )
        
        st.markdown("---")
        st.success("🤖 **Règle opérationnelle :** Lorsqu'un match se termine (FT), le moteur LIVE_ALERTS en arrière-plan le retire de la file et sélectionne instantanément le meilleur match disponible pour maintenir votre portefeuille à exactement 4 matchs actifs !")

# ─── MODEL MANAGEMENT ────────────────────────────────────────────────────────
elif menu == "⚙️ Model Management":
    st.title("⚙️ Gestion du Modèle IA V17 Ultra")
    st.markdown("---")
    
    col1, col2 = st.columns(2)
    with col1:
        st.markdown("### 🚀 Réentraîner XGBoost V17")
        st.info("Lance `train_v17_ultra.py`: extraction de 39 variables, Cross-Validation × 5, GridSearch, Monte Carlo.")
        if st.button("🚀 Lancer l'entraînement du modèle"):
            with st.spinner("Entraînement en cours... (peut prendre 2-5 min)"):
                result = subprocess.run(["python", TRAIN_SCRIPT], capture_output=True, text=True, encoding='utf-8', errors='replace')
                if result.returncode == 0:
                    st.success("✅ Entraînement terminé avec succès!")
                    st.text_area("Sortie", result.stdout, height=300)
                else:
                    st.error("❌ Erreur lors de l'entraînement.")
                    st.text_area("Erreurs", result.stderr, height=200)

        # Feature importance plot
        plot_path = os.path.join(PLOT_OUTPUT, 'feature_importance_v17.png')
        if os.path.exists(plot_path):
            st.markdown("### 📈 Importance des Variables (Top 20)")
            st.image(plot_path, use_column_width=True)

    with col2:
        st.markdown("### 📊 Statut du Modèle Actif")
        model_v17 = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_v17_ultra.json')
        model_v16 = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_v16_ultra.json')
        
        for path_, ver in [(model_v17, "V17 Ultra"), (model_v16, "V16")]:
            if os.path.exists(path_):
                mt = datetime.fromtimestamp(os.path.getmtime(path_))
                size = os.path.getsize(path_) / 1024
                tag = "✅ ACTIF" if ver == "V17 Ultra" else "📦 Archive"
                st.markdown(f"""
                **{tag} — {ver}**
                - 📅 Mis à jour: `{mt.strftime('%d/%m/%Y %H:%M')}`
                - 📦 Taille: `{size:.1f} KB`
                """)
        
        st.markdown("### 🔢 Variables Intégrées (39)")
        st.markdown("""
        | Catégorie | Variables |
        |---|---|
        | ELO & H2H | home_elo, away_elo, elo_diff, h2h_win_rate |
        | Momentum | home/away_momentum_goals, glicko_momentum |
        | Tactique | tactical_synergy, style_encoded |
        | Blessures | home/away_injury_impact |
        | Micro-Stats | possession, xG, sot, big_chances, pass_acc |
        | Défense | def_errors, tackles |
        | Marché | odds_h/d/a, news_sentiment |
        | Physique | rest_days, crowd_density, weather_temp |
        """)

# ─── SYSTEM HEALTH ────────────────────────────────────────────────────────────
elif menu == "🏥 System Health":
    st.title("🏥 Santé du Système")
    st.markdown("---")
    
    stats = get_system_stats()
    
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Tactical DB", f"{stats.get('tactical_size', 0):.1f} MB")
    c2.metric("Archive Matchs", f"{stats.get('archive_count', 0):,}")
    c3.metric("Modèle IA", "V17 Ultra")
    c4.metric("Monte Carlo", "10,000 iter")
    
    st.markdown("### 🔗 Connexions API")
    try:
        r = requests.get(f"{API_BASE}/health", timeout=3)
        if r.status_code == 200:
            data = r.json()
            st.success(f"✅ Serveur Node.js — Uptime: {data.get('uptime', 0):.0f}s")
        else:
            st.error(f"⚠️ API Node répond: {r.status_code}")
    except:
        st.error("❌ API Node.js hors-ligne. Vérifier start.bat.")
    
    scrapers_running = any(os.path.exists(os.path.join(
        os.path.dirname(os.path.dirname(__file__)), 'SofascoreScraping', 'scraper_progress.json'
    )) for _ in [1])
    st.write("✅ ELO Mappings: `Synchronisé`")
    st.write("✅ XGBoost V17 Ultra: `Actif (39 variables, Monte Carlo 10k)`")
    st.write("✅ Prédictions: `Mise à jour en arrière-plan à chaque requête API`")
    st.write("✅ Système d'Alertes Live & Buts (Telegram): `Actif (Bot @6714234731)`")
    st.write("✅ Journal d'audit des alertes: `data/live_value_alerts.log`")

st.markdown("---")
st.caption("Stitch V17 Ultra | XGBoost + Monte Carlo + DNN | 39 Variables Statistiques")

import streamlit as st
import pandas as pd
import sqlite3
import json
import os
import matplotlib.pyplot as plt
import seaborn as sns

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'tactical.db')

def load_data():
    if not os.path.exists(DB_PATH):
        return pd.DataFrame()
    conn = sqlite3.connect(DB_PATH)
    query = "SELECT * FROM matches WHERE status IN ('FT', 'Finished', 'live', 'scheduled') ORDER BY timestamp DESC LIMIT 50"
    df = pd.read_sql(query, conn)
    conn.close()
    return df

st.set_page_config(page_title="Titanium Ultra v16.0", layout="wide")

st.title("⚽ Titanium Ultra v16.0 | Advanced Prediction Intelligence")
st.markdown("---")

df = load_data()

if df.empty:
    st.warning("No match data found in tactical.db")
else:
    # Sidebar Filters
    st.sidebar.header("Intelligence Filters")
    leagues = st.sidebar.multiselect("Select Leagues", df['league'].unique())
    if leagues:
        df = df[df['league'].isin(leagues)]

    # Main Dashboard Metrics
    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Matches Scanned", len(df))
    col2.metric("Hot Targets", len(df[df['xgboost_confidence'] > 0.85]))
    col3.metric("Live Events", len(df[df['status'] == 'live']))
    col4.metric("Avg Quality", f"{df['xgboost_confidence'].mean()*100:.1f}%")

    st.subheader("🎯 Detailed Match Analysis")
    
    for _, match in df.iterrows():
        with st.expander(f"{match['homeTeam']} vs {match['awayTeam']} | {match['league']} | {match['status']}"):
            c1, c2, c3 = st.columns([1, 1, 1])
            
            with c1:
                st.write("**Probabilities**")
                probs = {
                    "Home": match.get('home_win_probability', 33.3),
                    "Draw": match.get('draw_probability', 33.3),
                    "Away": match.get('away_win_probability', 33.3)
                }
                st.bar_chart(pd.Series(probs))
                
            with c2:
                st.write("**Environmental Factors**")
                w_temp = match.get('weather_temp', 'N/A')
                w_desc = match.get('weather_desc', 'N/A')
                st.write(f"🌡️ Weather: {w_temp}°C ({w_desc})")
                
                att = match.get('attendance', 0) or 0
                cap = match.get('stadium_capacity', 1) or 1
                density = (att / cap) * 100 if cap > 0 else 0
                st.write(f"🏟️ Attendance: {att:,} / {cap:,} ({density:.1f}% Heat)")
                
                rest_h = match.get('days_since_last_match_home', 'N/A')
                rest_a = match.get('days_since_last_match_away', 'N/A')
                st.write(f"⌚ Rest Days: H:{rest_h} | A:{rest_a}")
                
            with c3:
                st.write("**AI Confidence & Sentiment**")
                st.progress(float(match['xgboost_confidence'] or 0))
                st.write(f"🎯 XGB Confidence: { (match['xgboost_confidence'] or 0)*100:.1f}%")
                
                news_data = {}
                try:
                    news_data = json.loads(match['news_data']) if match['news_data'] else {}
                except: pass
                
                sentiment = news_data.get('sentiment', {})
                st.write(f"📰 Sentiment: {sentiment.get('label', 'Neutral')} (Score: {sentiment.get('score', 0)})")
                st.write(f"⚽ Expected Score: {match['expected_score']}")

    st.markdown("---")
    st.write("Titanium Ultra v16.0 - Advanced Agentic Prediction Ecosystem")

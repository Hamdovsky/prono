import sqlite3
import pandas as pd
import json
import os
from datetime import datetime

# --- Paths ---
DB_ARCHIVE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
DB_TACTICAL_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'tactical.db')

def get_db_connection(path):
    if not os.path.exists(path):
        return None
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn

def init_patterns_table():
    conn = get_db_connection(DB_TACTICAL_PATH)
    if not conn: return
    conn.execute("""
        CREATE TABLE IF NOT EXISTS historical_patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_name TEXT,
            pattern_type TEXT,
            description TEXT,
            confidence_modifier REAL,
            xg_modifier REAL,
            evidence_matches INTEGER,
            is_active BOOLEAN DEFAULT 1,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(team_name, pattern_type)
        )
    """)
    conn.commit()
    conn.close()

def load_match_data():
    """Load matches from all available data sources and return a unified DataFrame."""
    dfs = []

    # 1. New historical_batch table (freshly scraped 2023-2025)
    conn_arch = get_db_connection(DB_ARCHIVE_PATH)
    if conn_arch:
        try:
            df1 = pd.read_sql_query(
                "SELECT homeTeam, awayTeam, scoreHome, scoreAway, startTimestamp FROM historical_batch",
                conn_arch
            )
            def parse_ts_batch(row):
                ts = row.get('startTimestamp')
                if ts and not pd.isna(ts):
                    try: return pd.to_datetime(int(ts), unit='s')
                    except: pass
                return None
            df1['date'] = df1.apply(parse_ts_batch, axis=1)
            df1 = df1.dropna(subset=['date'])
            dfs.append(df1[['homeTeam','awayTeam','scoreHome','scoreAway','date']])
            print(f"   [Source 1] historical_batch: {len(df1)} matches loaded.")
        except Exception as e:
            print(f"   [WARN] historical_batch error: {e}")
        
        # 2. Older archive_matches table
        try:
            df2 = pd.read_sql_query(
                "SELECT homeTeam, awayTeam, scoreHome, scoreAway, stats_blob FROM archive_matches",
                conn_arch
            )
            def parse_ts_arc(row):
                blobr = row.get('stats_blob')
                if blobr and isinstance(blobr, str):
                    try:
                        ts = json.loads(blobr).get('startTimestamp')
                        if ts: return pd.to_datetime(int(ts), unit='s')
                    except: pass
                return None
            df2['date'] = df2.apply(parse_ts_arc, axis=1)
            df2 = df2.dropna(subset=['date'])
            dfs.append(df2[['homeTeam','awayTeam','scoreHome','scoreAway','date']])
            print(f"   [Source 2] archive_matches: {len(df2)} matches loaded.")
        except Exception as e:
            print(f"   [WARN] archive_matches error: {e}")
        conn_arch.close()

    # 3. Tactical DB (live data)
    conn_tac = get_db_connection(DB_TACTICAL_PATH)
    if conn_tac:
        try:
            df3 = pd.read_sql_query(
                "SELECT homeTeam, awayTeam, scoreHome, scoreAway, timestamp, fullData FROM matches WHERE status IN ('FT','Finished','Ended')",
                conn_tac
            )
            def parse_ts_tac(row):
                ts = row.get('timestamp')
                if ts and not pd.isna(ts):
                    try: return pd.to_datetime(ts)
                    except:
                        try: return pd.to_datetime(int(ts), unit='s')
                        except: pass
                try:
                    fd = json.loads(row.get('fullData') or '{}')
                    s = fd.get('startTimestamp')
                    if s: return pd.to_datetime(int(s), unit='s')
                except: pass
                return None
            df3['date'] = df3.apply(parse_ts_tac, axis=1)
            df3 = df3.dropna(subset=['date'])
            dfs.append(df3[['homeTeam','awayTeam','scoreHome','scoreAway','date']])
            print(f"   [Source 3] tactical.db live: {len(df3)} matches loaded.")
        except Exception as e:
            print(f"   [WARN] tactical.db error: {e}")
        conn_tac.close()

    if not dfs:
        return pd.DataFrame()

    combined = pd.concat(dfs, ignore_index=True)
    combined = combined.dropna(subset=['date','scoreHome','scoreAway'])
    combined['month'] = combined['date'].dt.month
    return combined


def scan_month_curses(df):
    """Analyse per-team win rate by month to identify Month Curses and Peaks."""
    print(f"   [Engine] Analysing {len(df)} matches across {df['homeTeam'].nunique()} unique teams...")

    team_stats = {}

    for _, row in df.iterrows():
        try:
            h, a = str(row['homeTeam']), str(row['awayTeam'])
            sh, sa = int(row['scoreHome']), int(row['scoreAway'])
            m = int(row['month'])
            h_win = 1 if sh > sa else 0
            a_win = 1 if sa > sh else 0

            for t in (h, a):
                if t not in team_stats:
                    team_stats[t] = {'total_games': 0, 'total_wins': 0, 'months': {}}
                if m not in team_stats[t]['months']:
                    team_stats[t]['months'][m] = {'games': 0, 'wins': 0}

            team_stats[h]['total_games'] += 1
            team_stats[h]['total_wins'] += h_win
            team_stats[h]['months'][m]['games'] += 1
            team_stats[h]['months'][m]['wins'] += h_win

            team_stats[a]['total_games'] += 1
            team_stats[a]['total_wins'] += a_win
            team_stats[a]['months'][m]['games'] += 1
            team_stats[a]['months'][m]['wins'] += a_win
        except:
            continue

    patterns_found = []

    for team, stats in team_stats.items():
        if stats['total_games'] < 10: continue  # Need minimum 10 games across the full dataset
        base_wr = stats['total_wins'] / stats['total_games']

        for month, m_stats in stats['months'].items():
            if m_stats['games'] < 3: continue  # Need at least 3 games in that specific month
            month_wr = m_stats['wins'] / m_stats['games']

            # CURSE: Win rate is less than 45% of baseline AND baseline is decent (>30%)
            if month_wr < (base_wr * 0.50) and base_wr > 0.30:
                desc = f"Collapse in month {month}: normal WR={base_wr*100:.0f}%, this month WR={month_wr*100:.0f}% over {m_stats['games']} matches"
                patterns_found.append({
                    'team_name': team,
                    'pattern_type': f'MONTH_CURSE_{month}',
                    'description': desc,
                    'confidence_modifier': -7.0,
                    'xg_modifier': 0.85,
                    'evidence_matches': m_stats['games']
                })

            # PEAK: Win rate is 150%+ of baseline AND monthly WR actually high (>55%)
            elif month_wr > (base_wr * 1.50) and month_wr > 0.55:
                desc = f"Peak performance in month {month}: normal WR={base_wr*100:.0f}%, this month WR={month_wr*100:.0f}% over {m_stats['games']} matches"
                patterns_found.append({
                    'team_name': team,
                    'pattern_type': f'MONTH_PEAK_{month}',
                    'description': desc,
                    'confidence_modifier': 7.0,
                    'xg_modifier': 1.15,
                    'evidence_matches': m_stats['games']
                })

    return patterns_found


def save_patterns(patterns):
    conn = get_db_connection(DB_TACTICAL_PATH)
    if not conn: return

    count = 0
    for p in patterns:
        try:
            conn.execute("""
                INSERT OR REPLACE INTO historical_patterns
                (team_name, pattern_type, description, confidence_modifier, xg_modifier, evidence_matches, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """, (p['team_name'], p['pattern_type'], p['description'],
                  p['confidence_modifier'], p['xg_modifier'], p['evidence_matches']))
            count += 1
        except Exception as e:
            print(f"  Error saving {p['team_name']}: {e}")

    conn.commit()
    conn.close()
    print(f"   [DB] Saved {count} historical patterns to tactical.db")


def run_time_machine():
    print("==================================================")
    print("  Stitch Time Machine Engine (Historical Scan)")
    print("==================================================")
    init_patterns_table()

    df = load_match_data()
    if df.empty:
        print("[ERROR] No data loaded. Aborting.")
        return

    print(f"\n[Data] Total: {len(df)} matches | {df['homeTeam'].nunique()} teams | months: {sorted(df['month'].unique())}")
    patterns = scan_month_curses(df)
    print(f"\n[Result] Found {len(patterns)} significant patterns.")

    if patterns:
        # Show top 15 curses/peaks
        curses = [p for p in patterns if 'CURSE' in p['pattern_type']]
        peaks  = [p for p in patterns if 'PEAK' in p['pattern_type']]
        print(f"  Curses: {len(curses)} | Peaks: {len(peaks)}")
        print("\n  Top Curses (worst collapses):")
        for p in sorted(curses, key=lambda x: x['evidence_matches'], reverse=True)[:10]:
            print(f"    [{p['team_name']}] {p['pattern_type']} - {p['description']}")
        print("\n  Top Peaks (strongest months):")
        for p in sorted(peaks, key=lambda x: x['evidence_matches'], reverse=True)[:10]:
            print(f"    [{p['team_name']}] {p['pattern_type']} - {p['description']}")

    save_patterns(patterns)
    print("\n==================================================")
    print("  Time Machine scan complete!")
    print("==================================================")


if __name__ == "__main__":
    run_time_machine()

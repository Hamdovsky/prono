import requests
import json
import logging
import time
import os
from collections import defaultdict

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("StatsBombFactory")

class StatsBombFactory:
    BASE_URL = "https://raw.githubusercontent.com/statsbomb/open-data/master/data"

    def __init__(self):
        self.session = requests.Session()

    def competition_data(self):
        url = f"{self.BASE_URL}/competitions.json"
        res = self.session.get(url)
        return res.json() if res.status_code == 200 else []

    def get_matches(self, comp_id, season_id):
        url = f"{self.BASE_URL}/matches/{comp_id}/{season_id}.json"
        res = self.session.get(url)
        return res.json() if res.status_code == 200 else []

    def match_events(self, match_id):
        url = f"{self.BASE_URL}/events/{match_id}.json"
        res = self.session.get(url)
        return res.json() if res.status_code == 200 else []

    def _determine_xg_gap_status(self, goals, xg):
        diff = goals - xg
        if diff >= 1.5: return "Lucky (Overperforming)"
        if diff <= -1.5: return "Underperforming (Unlucky)"
        if goals > xg: return "Slightly Clinical"
        return "Slightly Wasteful"

    def analyze_match(self, match_id, match_meta=None):
        """
        Processes events to compute xG Gap, Formations, Passing Clusters
        and Tactical Dominance Index.
        """
        events = self.match_events(match_id)
        if not events:
            return None

        teams_data = {}

        for e in events:
            team_dict = e.get('team')
            if not team_dict: continue
            
            t_id = team_dict['id']
            t_name = team_dict['name']
            
            if t_id not in teams_data:
                teams_data[t_id] = {
                    'name': t_name,
                    'xg': 0.0,
                    'goals': 0,
                    'successful_pressures': 0,
                    'danger_passes_received_by_opponent': 0, # computed at the end
                    'danger_passes_received': 0,
                    'play_patterns_goals': {},
                    'shot_assists': 0,
                    'total_shots': 0
                }

            type_name = e.get('type', {}).get('name')
            loc = e.get('location', [0, 0])

            # Expected Goals & Play Pattern
            if type_name == 'Shot':
                teams_data[t_id]['total_shots'] += 1
                shot = e.get('shot', {})
                xg = shot.get('statsbomb_xg', 0.0)
                teams_data[t_id]['xg'] += xg
                
                if shot.get('outcome', {}).get('name') == 'Goal':
                    teams_data[t_id]['goals'] += 1
                    pp = e.get('play_pattern', {}).get('name', 'Regular Play')
                    teams_data[t_id]['play_patterns_goals'][pp] = teams_data[t_id]['play_patterns_goals'].get(pp, 0) + 1

            # Pressure Events (High block)
            elif type_name == 'Pressure':
                # Assuming X goes from 0 to 120, attacking opponent's third means X > 80
                if len(loc) == 2 and loc[0] > 80:
                    # In StatsBomb, pressure doesn't always have a boolean success. We count high-press instances.
                    teams_data[t_id]['successful_pressures'] += 1

            # Penetrating Passes (Key Passes + Shot Assists)
            elif type_name == 'Pass':
                ps = e.get('pass', {})
                if ps.get('shot_assist') or ps.get('goal_assist'):
                    teams_data[t_id]['shot_assists'] += 1
                
                end_loc = ps.get('end_location', [0, 0])
                # Completed pass into the danger zone (X > 100)
                if not ps.get('outcome') and len(end_loc) == 2:
                    if end_loc[0] > 100:
                        teams_data[t_id]['danger_passes_received'] += 1

        # Post-Processing: Cross-Assign defensive leaks
        results = []
        team_ids = list(teams_data.keys())
        if len(team_ids) == 2:
            t1, t2 = team_ids[0], team_ids[1]
            teams_data[t1]['danger_passes_received_by_opponent'] = teams_data[t2]['danger_passes_received']
            teams_data[t2]['danger_passes_received_by_opponent'] = teams_data[t1]['danger_passes_received']

        for t_id, d in teams_data.items():
            g = d['goals']
            xg = d['xg']
            gap = g - xg
            status = self._determine_xg_gap_status(g, xg)
            
            # Defensive Leak Logic
            leak_count = d['danger_passes_received_by_opponent']
            leak_lvl = "High (Vulnerable Block)" if leak_count > 15 else "Moderate" if leak_count > 8 else "Low (Solid Block)"

            # Tactical Dominance: (High Pressures / Danger Passes allowed) 
            denom = d['danger_passes_received'] if d['danger_passes_received'] > 0 else 1
            tac_dom = d['successful_pressures'] / denom

            # Best Goal Pattern
            patterns = d['play_patterns_goals']
            best_pattern = max(patterns.items(), key=lambda k: k[1])[0] if patterns else "None"

            # Value Prediction Output format:
            val_pred = f"Quality of chances generated implies ~{xg:.1f} xG. "
            if gap > 1.0:
                val_pred += f"Team is currently Clinical/Lucky (+{gap:.1f} goals above expected). "
            elif gap < -1.0:
                val_pred += f"Team is UNDERPERFORMING ({gap:.1f} deficit). Market may misprice them! Value on backing. "
            
            if leak_lvl.startswith("High"):
                val_pred += f"Defense is highly porous ({leak_count} danger passes conceded). Look for Over/Action on opponent. "
            
            if best_pattern != "None":
                val_pred += f"Highly lethal via {best_pattern}."

            results.append({
                "team_name": d['name'],
                "team_efficiency": {
                    "actual_goals": g,
                    "xG_value": round(xg, 2),
                    "xG_gap": round(gap, 2),
                    "classification": status
                },
                "defensive_leak": {
                    "danger_passes_penetrated": leak_count,
                    "vulnerability_level": leak_lvl
                },
                "tactics": {
                    "top_scoring_pattern": best_pattern,
                    "tactical_dominance_index": round(tac_dom, 2)
                },
                "value_prediction": val_pred.strip()
            })

        return {
            "match_id": match_id,
            "match_info": match_meta,
            "teams_analysis": results
        }

if __name__ == "__main__":
    import json
    factory = StatsBombFactory()
    
    logger.info("📡 Starting ULTIMATE GLOBAL SWEEP (V13)...")
    comps = factory.competition_data()
    
    all_insights = []
    out_file = "statsbomb_insights.json"
    
    # Load existing to avoid re-processing
    existing_data = []
    if os.path.exists(out_file):
        with open(out_file, 'r', encoding='utf-8') as f:
            existing_data = json.load(f)
    existing_infos = {m['match_info'] for m in existing_data}
    
    logger.info(f"📁 Registry has {len(comps)} entries. Current database: {len(existing_data)} matches.")
    
    for i, entry in enumerate(comps):
        comp_id = entry['competition_id']
        season_id = entry['season_id']
        comp_name = entry['competition_name']
        season_name = entry['season_name']
        
        logger.info(f"🔄 [{i+1}/{len(comps)}] Full Ingestion: {comp_name} ({season_name})")
        
        try:
            matches = factory.get_matches(comp_id, season_id)
            if not matches:
                continue
                
            # NO SAMPLING - WE TAKE EVERYTHING
            session = requests.Session()
            for m in matches:
                m_id = m['match_id']
                meta = f"[{comp_name}] {m['home_team']['home_team_name']} {m['home_score']}-{m['away_score']} {m['away_team']['away_team_name']}"
                
                if meta in existing_infos:
                    continue # Skip already processed
                    
                try:
                    # Direct session call for speed
                    insight = factory.analyze_match(m_id, meta)
                    if insight:
                        all_insights.append(insight)
                        existing_infos.add(meta)
                except:
                    continue
                # Removed time.sleep for ultra-fast execution

                
            # Incremental save every competition to prevent data loss
            if all_insights:
                combined = existing_data + all_insights
                with open(out_file, 'w', encoding='utf-8') as f:
                    json.dump(combined, f, ensure_ascii=False, indent=2)
                existing_data = combined
                all_insights = [] # Reset for next batch
                
        except Exception as e:
            logger.error(f"❌ Failed entry {comp_name}: {e}")
            
    logger.info(f"✅ ULTIMATE SWEEP COMPLETE. Master database now contains {len(existing_data)} tactical profiles.")

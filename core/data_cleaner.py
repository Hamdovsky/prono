import pandas as pd
import numpy as np
import json
import sqlite3
import os
import re
from datetime import datetime
from collections import defaultdict

# ==============================================
# ✅ منظف بيانات مباريات كرة القدم الكامل
# ✅ جاهز لنماذج تعلم آلي - HamdiProno Stitch
# ==============================================

class FootballDataCleaner:
    def __init__(self):
        self.project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
        self.DB_PATH = os.path.join(self.project_root, 'data', 'historical_archive.sqlite')
        self.MASTER_PATH = os.path.join(self.project_root, 'data', 'master_database.json')
        
        # قاموس توحيد أسماء الفرق
        self.TEAM_NORMALIZATION = {
            'man utd': 'manchester united', 'man united': 'manchester united',
            'man city': 'manchester city', 'spurs': 'tottenham hotspur',
            'tottenham': 'tottenham hotspur', 'arsenal fc': 'arsenal',
            'chelsea fc': 'chelsea', 'liverpool fc': 'liverpool',
            'psg': 'paris saint germain', 'om': 'marseille',
            'ol': 'lyon', 'bayern': 'bayern munich',
            'dortmund': 'borussia dortmund', 'bvb': 'borussia dortmund',
            'barca': 'barcelona', 'real': 'real madrid',
            'atletico': 'atletico madrid', 'inter': 'inter milan',
            'milan': 'ac milan', 'juve': 'juventus',
            'nottingham': 'nottingham forest', 'forest': 'nottingham forest'
        }
        
        # أعمدة ضرورية للاحتفاظ بها
        self.ESSENTIAL_COLUMNS = [
            'match_id', 'date', 'home_team', 'away_team', 'league', 'country',
            'score_home', 'score_away', 'status',
            'odds_home', 'odds_draw', 'odds_away',
            'home_elo', 'away_elo',
            'home_xg', 'away_xg',
            'home_possession', 'away_possession',
            'home_shots', 'away_shots', 'home_shots_on_target', 'away_shots_on_target',
            'home_corners', 'away_corners', 'home_fouls', 'away_fouls',
            'home_cards', 'away_cards',
            'days_rest_home', 'days_rest_away',
            'is_cup', 'match_importance',
            'home_form_points', 'away_form_points'
        ]

    def normalize_team_name(self, name):
        """توحيد اسم الفريق وإزالة الأحرف غير الضرورية"""
        if not name or pd.isna(name):
            return "Unknown"
            
        name = str(name).lower().strip()
        
        # إزالة كلمات زائدة
        name = re.sub(r'\b(fc|cf|sc|ac|as|rc|us|cd|ud)\b', '', name)
        name = re.sub(r'[^a-z0-9\s]', '', name)
        name = ' '.join(name.split())
        
        # تطابق مع قاموس التوحيد
        return self.TEAM_NORMALIZATION.get(name, name.title())

    def clean_dates(self, df):
        """تنظيف وتوحيد التواريخ والأوقات"""
        def parse_date(x):
            if pd.isna(x):
                return np.nan
            try:
                return pd.to_datetime(x, errors='coerce')
            except:
                return np.nan
                
        df['date'] = df['date'].apply(parse_date)
        df = df.dropna(subset=['date'])
        
        # فرز حسب التاريخ
        df = df.sort_values('date').reset_index(drop=True)
        return df

    def remove_duplicates(self, df):
        """إزالة التكرارات بذكاء"""
        # تحديد التكرارات بناءً على التاريخ والفرق
        df['match_key'] = df.apply(lambda x: f"{x['date'].date()}_{x['home_team']}_{x['away_team']}", axis=1)
        
        # الاحتفاظ بالسجل الأكمل بيانات
        df['data_quality'] = df.notna().sum(axis=1)
        df = df.sort_values('data_quality', ascending=False)
        df = df.drop_duplicates(subset=['match_key'], keep='first')
        
        df = df.drop(columns=['match_key', 'data_quality'])
        return df

    def handle_missing_values(self, df):
        """معالجة القيم المفقودة بشكل منطقي حسب السياق"""
        # 1. القيم الرقمية الإحصائية
        numeric_cols = df.select_dtypes(include=[np.number]).columns
        
        for col in numeric_cols:
            if col in ['score_home', 'score_away', 'home_elo', 'away_elo', 'odds_home', 'odds_draw', 'odds_away']:
                # القيم الحرجة: حذف الصفوف المفقودة
                df = df.dropna(subset=[col])
            else:
                # القيم الإحصائية: ملء بالمتوسط حسب الفريق
                df[col] = df.groupby(['home_team'])[col].transform(
                    lambda x: x.fillna(x.median())
                )
                df[col] = df[col].fillna(df[col].median())
        
        # 2. القيم النصية
        df['league'] = df['league'].fillna('Unknown')
        df['country'] = df['country'].fillna('Unknown')
        df['status'] = df['status'].fillna('NS')
        
        return df

    def validate_numeric_values(self, df):
        """التحقق من صحة القيم الرقمية وإزالة القيم غير المنطقية"""
        # لا يوجد أهداف سلبية
        if 'score_home' in df.columns:
            df.loc[df['score_home'] < 0, 'score_home'] = 0
        if 'score_away' in df.columns:
            df.loc[df['score_away'] < 0, 'score_away'] = 0
        
        # الاحتمالات لا تقل عن 1.01
        for col in ['odds_home', 'odds_draw', 'odds_away']:
            if col in df.columns:
                df.loc[df[col] < 1.01, col] = 1.01
        
        # النسب المئوية بين 0 و 100
        pct_cols = ['home_possession', 'away_possession']
        for col in pct_cols:
            if col in df.columns:
                df.loc[df[col] > 100, col] = 100
                df.loc[df[col] < 0, col] = 0
        
        # إزالة القيم الشاذة باستخدام IQR
        for col in ['home_xg', 'away_xg', 'home_shots', 'away_shots']:
            if col in df.columns:
                Q1 = df[col].quantile(0.01)
                Q3 = df[col].quantile(0.99)
                df = df[(df[col] >= Q1) & (df[col] <= Q3)]
        
        return df

    def process_sqlite_data(self):
        """جلب وتنظيف البيانات من قاعدة بيانات SQLite"""
        try:
            conn = sqlite3.connect(self.DB_PATH)
            
            # الحصول على أسماء الأعمدة الفعلية
            cursor = conn.cursor()
            cursor.execute("PRAGMA table_info(archive_matches)")
            columns = [row[1].lower() for row in cursor.fetchall()]
            
            select_cols = []
            col_map = {
                'id': 'match_id',
                'starttimestamp': 'date',
                'hometeam': 'homeTeam',
                'awayteam': 'awayTeam',
                'scorehome': 'scoreHome',
                'scoreaway': 'scoreAway',
                'stats_blob': 'stats_blob'
            }
            
            for db_col, alias in col_map.items():
                if db_col in columns:
                    select_cols.append(f"{db_col} as {alias}")
            
            if not select_cols:
                conn.close()
                return pd.DataFrame()
            
            query = f"SELECT {', '.join(select_cols)} FROM archive_matches LIMIT 10000"
            df = pd.read_sql(query, conn)
            conn.close()
            
            return df
        except Exception as e:
            print(f"SQLite warning: {e}")
            return pd.DataFrame()

    def process_master_json_data(self):
        """جلب وتنظيف البيانات من ملف master_database.json"""
        with open(self.MASTER_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        rows = []
        for match in data:
            rows.append({
                'match_id': match.get('id'),
                'date': match.get('date'),
                'home_team': match.get('homeTeam', {}).get('name'),
                'away_team': match.get('awayTeam', {}).get('name'),
                'league': match.get('league', {}).get('name'),
                'country': match.get('league', {}).get('country'),
                'score_home': match.get('score', {}).get('home'),
                'score_away': match.get('score', {}).get('away'),
                'status': match.get('status'),
                'odds_home': match.get('odds', {}).get('home'),
                'odds_draw': match.get('odds', {}).get('draw'),
                'odds_away': match.get('odds', {}).get('away')
            })
        
        return pd.DataFrame(rows)

    def run_full_cleanup(self):
        """تشغيل عملية التنظيف الكاملة"""
        print("-> Fetching data...")
        
        # دمج البيانات من جميع المصادر
        df_sql = self.process_sqlite_data()
        df_json = self.process_master_json_data()
        df = pd.concat([df_sql, df_json], ignore_index=True)
        
        print(f"-> Total matches loaded: {len(df)}")
        
        # الخطوة 1: توحيد أسماء الفرق
        print("-> Normalizing team names...")
        df['home_team'] = df['home_team'].apply(self.normalize_team_name)
        df['away_team'] = df['away_team'].apply(self.normalize_team_name)
        
        # الخطوة 2: تنظيف التواريخ
        print("-> Cleaning dates...")
        df = self.clean_dates(df)
        
        # الخطوة 3: إزالة التكرارات
        print("-> Removing duplicates...")
        df = self.remove_duplicates(df)
        
        # الخطوة 4: معالجة القيم المفقودة
        print("-> Handling missing values...")
        df = self.handle_missing_values(df)
        
        # الخطوة 5: التحقق من صحة القيم الرقمية
        print("-> Validating numeric values...")
        df = self.validate_numeric_values(df)
        
        # الخطوة 6: حذف الأعمدة غير الضرورية
        existing_cols = [c for c in self.ESSENTIAL_COLUMNS if c in df.columns]
        df = df[existing_cols]
        
        print("\nCleaning complete!")
        print(f"Final matches: {len(df)}")
        print(f"Missing data rate: {round(df.isna().sum().sum() / df.size * 100, 2)}%")
        
        return df

    def save_clean_dataset(self, output_path=None):
        """حفظ مجموعة البيانات المنظفة"""
        df = self.run_full_cleanup()
        
        if not output_path:
            project_root = os.path.dirname(os.path.dirname(__file__))
            output_path = os.path.join(project_root, 'data', 'cleaned_dataset.csv')
        
        df.to_csv(output_path, index=False, encoding='utf-8')
        print(f"💾 تم حفظ البيانات المنظفة في: {output_path}")
        
        # حفظ أيضاً بصيغة Parquet لتحسين الأداء
        parquet_path = output_path.replace('.csv', '.parquet')
        df.to_parquet(parquet_path, index=False)
        print(f"💾 تم حفظ النسخة المضغوطة في: {parquet_path}")
        
        return df


if __name__ == "__main__":
    cleaner = FootballDataCleaner()
    df_clean = cleaner.save_clean_dataset()
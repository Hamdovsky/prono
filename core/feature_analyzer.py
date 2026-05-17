import sqlite3
import pandas as pd
import numpy as np
import os
import sys

from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LassoCV
from sklearn.preprocessing import StandardScaler

# استدعاء دالة استخراج الـ 115 متغير من ملفات النظام الأساسية
# تأكد من أن المسار صحيح للوصول إلى ml_features.py
sys.path.append(os.path.dirname(__file__))
try:
    from ml_features import extract_ml_features, FEATURE_NAMES_V27
except ImportError:
    print("⚠️ لا يمكن العثور على ml_features، يرجى تشغيل السكربت من داخل مجلد core.")
    sys.exit(1)

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')

def load_data_and_features():
    print("📥 جاري تحميل المباريات التاريخية لاستخراج المتغيرات (Features)...")
    if not os.path.exists(DB_PATH):
        print(f"❌ قاعدة البيانات غير موجودة: {DB_PATH}")
        return None, None
        
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # جلب آخر 5000 مباراة للتدريب
    query = """
    SELECT * FROM archive_matches 
    WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL 
    ORDER BY date DESC LIMIT 5000
    """
    rows = conn.execute(query).fetchall()
    conn.close()
    
    X_list = []
    y_list = []
    
    for row in rows:
        match_dict = dict(row)
        
        # 🎯 تحديد الهدف (Target Y) وهو Over 2.5
        total_goals = float(match_dict['scoreHome']) + float(match_dict['scoreAway'])
        y = 1 if total_goals > 2.5 else 0
        
        # استخراج 115 متغير (X)
        features = extract_ml_features(match_dict, fetch_history=False)
        
        feature_vector = []
        for fname in FEATURE_NAMES_V27:
            val = features.get(fname, 0.0)
            if val is None or pd.isna(val):
                val = 0.0  # حماية إضافية من القيم المفقودة
            feature_vector.append(float(val))
            
        X_list.append(feature_vector)
        y_list.append(y)
            
    X = pd.DataFrame(X_list, columns=FEATURE_NAMES_V27)
    y = np.array(y_list)
    return X, y

def run_feature_selection():
    X, y = load_data_and_features()
    if X is None or len(X) < 100:
        print("❌ البيانات غير كافية للتحليل.")
        return
        
    print(f"✅ تم تحميل {len(X)} مباراة بـ {X.shape[1]} متغير معالج.")
    
    # -------------------------------------------------------------------
    # 1. Random Forest (تكتشف العلاقات غير الخطية مثل "الضغط العالي" مع "الدفاع الضعيف")
    # -------------------------------------------------------------------
    print("\n🌲 تدريب Random Forest لتحديد أهمية المتغيرات (Target: Over/Under 2.5)...")
    rf = RandomForestClassifier(n_estimators=200, max_depth=12, random_state=42, n_jobs=-1)
    rf.fit(X, y)
    
    importances = rf.feature_importances_
    rf_results = pd.DataFrame({'Feature': X.columns, 'Importance': importances})
    rf_results = rf_results.sort_values(by='Importance', ascending=False)
    
    print("\n🏆 أقوى 15 متغيراً تأثيراً على Over 2.5 (Random Forest):")
    for i, row in rf_results.head(15).iterrows():
        print(f"  {row['Feature']:<25} -> {row['Importance']:.4f}")
        
    # -------------------------------------------------------------------
    # 2. Lasso Classifier (L1 Penalty لحذف المتغيرات المزعجة Noise)
    # -------------------------------------------------------------------
    print("\n🎯 تدريب Lasso (L1) لتقليم المتغيرات الزائدة وعزل الضوضاء...")
    # خوارزمية Lasso حساسة جداً للأرقام لذا يجب توحيد القياس (Scaling) أولاً
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    
    lasso = LassoCV(cv=5, random_state=42, n_jobs=-1)
    lasso.fit(X_scaled, y)
    
    lasso_coefs = np.abs(lasso.coef_)
    lasso_results = pd.DataFrame({'Feature': X.columns, 'Importance': lasso_coefs})
    lasso_results = lasso_results[lasso_results['Importance'] > 0] # الإبقاء على ما لم يتم حذفه
    lasso_results = lasso_results.sort_values(by='Importance', ascending=False)
    
    eliminated = X.shape[1] - len(lasso_results)
    print(f"\n✂️ خوارزمية Lasso قامت بحذف {eliminated} متغير مزعج (Noise) بتعيين تأثيرهم إلى 0!")
    print("🏆 أقوى 15 متغيراً تأثيراً على Over 2.5 (Lasso L1):")
    for i, row in lasso_results.head(15).iterrows():
        print(f"  {row['Feature']:<25} -> {row['Importance']:.4f}")

if __name__ == '__main__':
    run_feature_selection()

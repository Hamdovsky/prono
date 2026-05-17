import pandas as pd
import numpy as np
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import brier_score_loss, log_loss
import xgboost as xgb

class WalkForwardValidator:
    def __init__(self, data_df):
        # Sort values strictly by time to ensure temporal integrity
        self.data = data_df.sort_values('match_timestamp').reset_index(drop=True)
    
    def run_validation(self, n_splits=5):
        tscv = TimeSeriesSplit(n_splits=n_splits)
        
        metrics = []
        for train_index, test_index in tscv.split(self.data):
            train_data = self.data.iloc[train_index]
            test_data = self.data.iloc[test_index]
            
            # Example feature matrices
            X_train = train_data.drop(['match_id', 'result', 'match_timestamp'], axis=1)
            y_train = train_data['result']
            
            X_test = test_data.drop(['match_id', 'result', 'match_timestamp'], axis=1)
            y_test = test_data['result']
            
            # Train model
            model = xgb.XGBClassifier(use_label_encoder=False, eval_metric='mlogloss')
            model.fit(X_train, y_train)
            
            # Predict out-of-sample
            y_pred_proba = model.predict_proba(X_test)
            
            # Calculate Brier Score (assuming binary classification for simplicity here)
            # You would adapt this for multiclass (1X2)
            try:
                brier = brier_score_loss(y_test, y_pred_proba[:, 1])
                metrics.append({"brier": brier, "train_size": len(train_data), "test_size": len(test_data)})
            except:
                pass
                
        return pd.DataFrame(metrics)
        
if __name__ == "__main__":
    print("🚀 Walk-Forward Validation Engine initialized.")

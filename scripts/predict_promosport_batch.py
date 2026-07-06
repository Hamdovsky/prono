import json, sys, xgboost as xgb
model_path = sys.argv[1]
booster = xgb.Booster()
booster.load_model(model_path)
input_data = json.loads(sys.stdin.read())
dmatrix = xgb.DMatrix(input_data, feature_names=booster.feature_names)
probs = booster.predict(dmatrix)
print(json.dumps(probs.tolist()))

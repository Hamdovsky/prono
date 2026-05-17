import numpy as np
import os
import joblib
from sklearn.neural_network import MLPClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, classification_report

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'neural_data')
MODEL_SAVE = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_deep_prime.pkl')

def train_dnn():
    print("🧠 [STITCH-DNN] Loading neural feature space...")
    X_path = os.path.join(OUTPUT_DIR, 'X_dnn.npy')
    y_path = os.path.join(OUTPUT_DIR, 'y_dnn.npy')

    if not os.path.exists(X_path):
        print("❌ Data not found! Run prepare_dnn_data.py first.")
        return

    X = np.load(X_path)
    y = np.load(y_path)

    print(f"📊 Dataset: {X.shape[0]} samples, {X.shape[1]} features.")
    
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    # Architecture MLP [64, 32, 16] - Deep enough for non-linear sport traits
    print("🔨 Building MLP [64, 32, 16] Architecture...")
    mlp = MLPClassifier(
        hidden_layer_sizes=(64, 32, 16),
        activation='relu',
        solver='adam',
        max_iter=500,
        alpha=0.001,
        batch_size=32,
        random_state=42,
        verbose=True,
        early_stopping=True,
        validation_fraction=0.1
    )

    print("🚀 Training Neural Network...")
    mlp.fit(X_train, y_train)

    # Eval
    y_pred = mlp.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    
    print("\n" + "="*40)
    print("      DNN TRAINING RESULTS")
    print("="*40)
    print(f"🎯 Accuracy: {acc*100:.2f}%")
    print(f"📉 Training Loss: {mlp.loss_:.4f}")
    print(f"🔄 Epochs: {mlp.n_iter_}")
    print("="*40)
    
    target_names = ['Away Win', 'Draw', 'Home Win']
    print(classification_report(y_test, y_pred, target_names=target_names))

    # Save
    os.makedirs(os.path.dirname(MODEL_SAVE), exist_ok=True)
    joblib.dump(mlp, MODEL_SAVE)
    print(f"✨ Deep Prime model saved: {MODEL_SAVE}")

if __name__ == "__main__":
    train_dnn()

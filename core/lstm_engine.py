import numpy as np
import json
import sys

_torch_stuff = None
def get_torch():
    global _torch_stuff
    if _torch_stuff is None:
        try:
            import torch
            import torch.nn as nn
            _torch_stuff = (torch, nn)
        except Exception as e:
            print(f"CRITICAL WARNING: Lazy torch import failed: {e}")
            _torch_stuff = "NOT_AVAILABLE"
    return _torch_stuff

def get_lstm_predictor_class():
    torch_stuff = get_torch()
    if torch_stuff == "NOT_AVAILABLE": return None
    torch, nn = torch_stuff

    class LSTMPredictor(nn.Module):
        def __init__(self, input_size=8, hidden_size=32, num_layers=1):
            super(LSTMPredictor, self).__init__()
            self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True)
            self.fc = nn.Linear(hidden_size, 1)
            self.sigmoid = nn.Sigmoid()

        def forward(self, x):
            # x shape: (batch, seq_len, input_size)
            out, _ = self.lstm(x)
            # Taking the last time step output
            out = self.fc(out[:, -1, :])
            return self.sigmoid(out)
    return LSTMPredictor

def analyze_sequence(sequences):
    """
    Analyzes a sequence of last 5-10 matches data.
    Input: List of dicts with keys: [xg, shots, points, possession, corners, saves, cards, importance]
    """
    try:
        torch_stuff = get_torch()
        if torch_stuff == "NOT_AVAILABLE":
            return {"trend_score": 50, "momentum": "Stable", "confidence": 0.3}
        torch, nn = torch_stuff
        
        LSTMPredictor = get_lstm_predictor_class()
        
        # Hyperparameters (Matching a pre-trained or initialized layout)
        input_size = 8
        model = LSTMPredictor(input_size=input_size)
        
        # Convert input to tensor
        # Expected shape (1, seq_len, 8)
        data = []
        for s in sequences[:10]: # Max 10 matches
            row = [
                float(s.get('xg', 1.2)),
                float(s.get('shots', 10)) / 20.0,
                float(s.get('points', 1)) / 3.0,
                float(s.get('possession', 50)) / 100.0,
                float(s.get('corners', 5)) / 15.0,
                float(s.get('saves', 2)) / 10.0,
                float(s.get('cards', 2)) / 8.0,
                float(s.get('importance', 1)) / 5.0
            ]
            data.append(row)
        
        if len(data) < 3:
            return {"trend_score": 50, "momentum": "Stable", "confidence": 0.3}

        input_tensor = torch.FloatTensor([data])
        
        with torch.no_grad():
            trend_prob = model(input_tensor).item()
        
        trend_score = round(trend_prob * 100, 1)
        momentum = "Rising" if trend_score > 65 else ("Falling" if trend_score < 35 else "Stable")
        
        return {
            "trend_score": trend_score,
            "momentum": momentum,
            "interpretation": f"Team is currently in a {momentum.lower()} trend based on sequence analysis."
        }
    except Exception as e:
        return {"error": str(e), "trend_score": 50}

if __name__ == "__main__":
    # Test stub for Node.js bridge
    if len(sys.argv) > 1:
        try:
            input_data = json.loads(sys.argv[1])
            result = analyze_sequence(input_data)
            print(json.dumps(result))
        except:
            print(json.dumps({"trend_score": 50, "momentum": "Stable"}))

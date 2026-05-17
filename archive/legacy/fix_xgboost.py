import json

path = 'xgboost_predict.py'
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Truncate at the end (keep all lines up to 256)
clean_lines = lines[:256]

main_block = """
if __name__ == "__main__":
    import sys
    try:
        input_data = sys.stdin.read()
        if not input_data.strip():
            print(json.dumps({"success": False, "error": "No input data"}))
            sys.exit(0)
        
        # Format: match_json [news_json_optional]
        # In Node: python xgboost_predict.py < match_json
        match_data = json.loads(input_data)
        
        # news_data is usually null if not passed
        result = predict_xgboost(match_data, {})
        print(json.dumps({"success": True, **result}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
"""

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(clean_lines)
    f.write(main_block)

print(f"✅ Fixed {path}. Total lines: {len(clean_lines) + len(main_block.splitlines())}")

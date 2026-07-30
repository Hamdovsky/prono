import os

# Check server.js for static serving configuration
server_path = r'C:\Users\HAMDI\prono\server.js'
with open(server_path, 'rb') as f:
    content = f.read().decode('utf-8', errors='replace')

# Find express static or serve-static references
lines = content.split('\n')
for i, line in enumerate(lines):
    lower = line.lower()
    if any(w in lower for w in ['express.static', 'serve.static', 'dist', 'build', 'public']):
        print(f'{i+1}: {line.strip()}')

print()
print("--- fly.toml ---")
fly_path = r'C:\Users\HAMDI\prono\fly.toml'
if os.path.exists(fly_path):
    with open(fly_path, 'rb') as f:
        print(f.read().decode('utf-8', errors='replace')[:1000])

print()
print("--- render.yaml ---")
render_path = r'C:\Users\HAMDI\prono\render.yaml'
if os.path.exists(render_path):
    with open(render_path, 'rb') as f:
        print(f.read().decode('utf-8', errors='replace')[:1000])

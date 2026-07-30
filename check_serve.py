import os
import re

server_path = r'C:\Users\HAMDI\prono\server.js'
with open(server_path, 'rb') as f:
    content = f.read().decode('utf-8', errors='replace')

# Find lines related to static serving
results = list(re.finditer(r'.{0,100}(express\.static|serve|dist|public|build).{0,100}', content, re.IGNORECASE))
for r in results[:15]:
    line = r.group().replace('\n', ' ').strip()
    with open(r'C:\Users\HAMDI\prono\check_results.txt', 'a', encoding='utf-8') as out:
        out.write(line + '\n')

print('Done')

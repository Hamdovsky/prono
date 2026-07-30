path = r'C:\Users\HAMDI\prono\src\components\UltimateMatchCenter\UltimateMatchCenter.jsx'
with open(path, 'rb') as f:
    content = f.read().decode('utf-8', errors='replace')

content = content.replace("import { calculateEV } from '../../services/InsightEngine'\n", '')

with open(path, 'wb') as f:
    f.write(content.encode('utf-8'))
print('Removed unused import')

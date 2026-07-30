import codecs

filepath = r'C:\Users\HAMDI\prono\src\components\Dashboard.jsx'

with codecs.open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Fix activeDate uppercase references - find and replace dynamically
content = content.replace('${activeDate.toUpperCase()}', 'TODAY')

# Fix the activeView matches / activeDate Today condition
old_cond = "{activeView === 'matches' && activeDate === 'Today' && ("
new_cond = "{activeView === 'matches' && ("
content = content.replace(old_cond, new_cond)

with codecs.open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print('Fixed activeDate references')

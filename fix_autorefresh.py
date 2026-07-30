path = r"C:\Users\HAMDI\prono\src\components\Dashboard.jsx"
with open(path, "rb") as f:
    content = f.read().decode("utf-8", errors="replace")

# Remove the auto-refresh useEffect block
import re
# Pattern: "// Auto-refresh every 60s" through the closing }, [autoRefresh])
content = re.sub(
    r"\s*// Auto-refresh every 60s\s*useEffect\(\(\) => \{\s*if \(!autoRefresh\) return\s*const interval = setInterval\(\(\) => dataService\.refreshAllData\(\), 60000\)\s*return \(\) => clearInterval\(interval\)\s*\}, \[autoRefresh\]\)",
    "",
    content
)

# Remove the AUTO toggle button block (multi-line)
content = re.sub(
    r"\s*<button\s+onClick=\{\(\) => setAutoRefresh\(\(s\) => !s\)\}[^<]*</button>",
    "",
    content,
    flags=re.DOTALL
)

with open(path, "wb") as f:
    f.write(content.encode("utf-8"))
print("Done fixing autoRefresh")

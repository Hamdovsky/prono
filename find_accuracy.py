path = r"C:\Users\HAMDI\prono\src\components\Dashboard.jsx"
with open(path, "rb") as f:
    content = f.read().decode("utf-8", errors="replace")
lines = content.split("\n")
for i, line in enumerate(lines, 1):
    l = line.strip()
    if "leagueAccuracy" in l or "Pr" in l and "cision" in l:
        print(f"{i}: {l[:150]}")

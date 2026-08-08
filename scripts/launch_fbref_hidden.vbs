Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\HAMDI\prono"
WshShell.Run """C:\Users\HAMDI\prono\scripts\run_fbref_scraper.bat"" --once", 0, False
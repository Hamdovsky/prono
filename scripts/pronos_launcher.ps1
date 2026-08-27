# pronos_launcher.ps1 - Panneau de controle Titanium V2 (WinForms, sans dependance)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web # pour HttpUtility (non utilise mais dispo)

$StitchDir = "C:\Users\HAMDI\Desktop\HamdiProno\stitch"
$ErrorActionPreference = 'SilentlyContinue'

# ----- Definition des services (Nom, Port, Url, Marker pour process/metrics) -----
$Services = @(
    [PSCustomObject]@{ Nom = 'API Core';       Port = 3001; Url = 'http://localhost:3001'; Marker = 'server.js';             Desc = 'Serveur Node principal' }
    [PSCustomObject]@{ Nom = 'ML Core';        Port = 8000; Url = 'http://localhost:8000'; Marker = 'fastapi_server';        Desc = 'FastAPI XGBoost' }
    [PSCustomObject]@{ Nom = 'Dashboard UI';   Port = 5173; Url = 'http://localhost:5173'; Marker = 'vite';                 Desc = 'Vite/React' }
    [PSCustomObject]@{ Nom = 'Command Center'; Port = 8501; Url = 'http://localhost:8501'; Marker = 'command_center.py';    Desc = 'Streamlit' }
    [PSCustomObject]@{ Nom = 'Redis';          Port = 6379; Url = '';                     Marker = 'redis.windows.conf';    Desc = 'Cache Redis' }
    [PSCustomObject]@{ Nom = 'Scraper';        Port = 0;    Url = '';                     Marker = 'SofascoreScraping';     Desc = 'Scraper cotes' }
    [PSCustomObject]@{ Nom = 'Learn';          Port = 0;    Url = '';                     Marker = 'adaptive_learning_sync'; Desc = 'Apprentissage' }
    [PSCustomObject]@{ Nom = 'Live Alerts';    Port = 0;    Url = '';                     Marker = 'live_value_alerts.js';  Desc = 'Alertes live' }
)

# Historique memoire par service (pour sparkline)
$memHist = @{}
foreach ($s in $Services) { $memHist[$s.Nom] = New-Object System.Collections.Queue }

# ----- Helpers metriques -----
function Get-ServiceMetrics {
    $wmi  = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue
    $map  = @{}
    foreach ($p in $wmi) {
        $perfRow = $perf | Where-Object { $_.IDProcess -eq $p.ProcessId }
        if ($map.ContainsKey($p.ProcessId)) { continue }
        $map[$p.ProcessId] = [PSCustomObject]@{
            Cmd = $p.CommandLine
            Mem = if ($p.WorkingSetSize) { [math]::Round($p.WorkingSetSize / 1MB, 1) } else { 0 }
            Cpu = if ($perfRow) { $perfRow.PercentProcessorTime } else { 0 }
        }
    }
    $result = @{}
    foreach ($s in $Services) {
        $mem = 0; $cpu = 0
        foreach ($id in $map.Keys) {
            $row = $map[$id]
            if ($row.Cmd -and $row.Cmd -like "*$($s.Marker)*") { $mem += $row.Mem; $cpu += $row.Cpu }
        }
        $result[$s.Nom] = [PSCustomObject]@{ Mem = $mem; Cpu = $cpu }
    }
    return $result
}

function Get-PortState($port) {
    if ($port -eq 0) { return 'Via stack' }
    $c = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    return if ($c -and $c.State -eq 'Listen') { 'EN MARCHE' } else { 'Arrete' }
}
function Get-ServiceState($s) {
    if ($s.Port -eq 0) { return if ((Get-PortState 3001) -eq 'EN MARCHE') { 'EN MARCHE' } else { 'Arrete' } }
    return Get-PortState $s.Port
}
function Test-Health($url) {
    if (-not $url) { return '-' }
    try { $r = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop; return "HTTP $($r.StatusCode)" }
    catch { return 'no resp' }
}

# ----- Log files disponibles -----
function Get-LogFiles {
    $list = @()
    $logDir = Join-Path $StitchDir 'logs'
    if (Test-Path $logDir) { $list += Get-ChildItem $logDir -Filter *.log | ForEach-Object { $_.FullName } }
    $rootLogs = @('server-console.log','server-console.err.log','fastapi-server.log','forecast-collateral.log','collateral.log')
    foreach ($f in $rootLogs) { $p = Join-Path $StitchDir $f; if (Test-Path $p) { $list += $p } }
    return $list
}

# ----- Styles -----
$Bg        = [System.Drawing.Color]::FromArgb(18, 20, 28)
$PanelBg   = [System.Drawing.Color]::FromArgb(26, 28, 38)
$Accent    = [System.Drawing.Color]::FromArgb(90, 130, 255)
$Green     = [System.Drawing.Color]::FromArgb(46, 204, 113)
$Red       = [System.Drawing.Color]::FromArgb(231, 76, 60)
$Orange    = [System.Drawing.Color]::FromArgb(241, 196, 15)
$TextLight = [System.Drawing.Color]::FromArgb(230, 235, 245)
$GridBg    = [System.Drawing.Color]::FromArgb(30, 32, 42)

function Style-Button($b, $bg, $fg) {
    $b.BackColor = $bg; $b.ForeColor = $fg
    $b.FlatStyle = 'Flat'
    $b.FlatAppearance.BorderSize = 0
    $b.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
}

# ----- UI -----
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Titanium Pronos - Panneau de Controle'
$form.Size = New-Object System.Drawing.Size(900, 620)
$form.StartPosition = 'CenterScreen'
$form.BackColor = $Bg
$form.ForeColor = $TextLight
$form.MinimumSize = New-Object System.Drawing.Size(820, 560)

# Header
$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Top'; $header.Height = 64; $header.BackColor = [System.Drawing.Color]::FromArgb(30, 33, 48)
$header.Paint.Add({ param($s,$e)
    $g = $e.Graphics
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($header.ClientRectangle, [System.Drawing.Color]::FromArgb(40,44,66), [System.Drawing.Color]::FromArgb(22,24,34), [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
    $g.FillRectangle($grad, $header.ClientRectangle)
})
$form.Controls.Add($header)
$title = New-Object System.Windows.Forms.Label
$title.Text = 'TITANIUM PRONOS'; $title.Font = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = $Accent; $title.Location = New-Object System.Drawing.Point(18, 8); $title.AutoSize = $true
$header.Controls.Add($title)
$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Panneau de controle de la stack - v2'; $subtitle.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(160,170,190); $subtitle.Location = New-Object System.Drawing.Point(20, 38); $subtitle.AutoSize = $true
$header.Controls.Add($subtitle)
$statusDot = New-Object System.Windows.Forms.Label
$statusDot.Size = New-Object System.Drawing.Size(14,14); $statusDot.Location = New-Object System.Drawing.Point(860, 10)
$statusDot.BackColor = $Red; $statusDot.BorderStyle = 'FixedSingle'
$header.Controls.Add($statusDot)

# Tab control
$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'; $tabs.BackColor = $Bg; $tabs.ForeColor = $TextLight
$tabs.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$tabServices = New-Object System.Windows.Forms.TabPage; $tabServices.Text = 'Services'; $tabServices.BackColor = $Bg
$tabLogs = New-Object System.Windows.Forms.TabPage; $tabLogs.Text = 'Logs live'; $tabLogs.BackColor = $Bg
$tabs.TabPages.Add($tabServices); $tabs.TabPages.Add($tabLogs)
$form.Controls.Add($tabs)

# ---------- Tab Services ----------
$grid = New-Object System.Windows.Forms.DataGridView
$grid.Location = New-Object System.Drawing.Point(12, 12)
$grid.Size = New-Object System.Drawing.Size(620, 360)
$grid.BackgroundColor = $GridBg; $grid.ForeColor = [System.Drawing.Color]::Black
$grid.ReadOnly = $true; $grid.AllowUserToAddRows = $false; $grid.AllowUserToResizeRows = $false
$grid.RowHeadersVisible = $false; $grid.SelectionMode = 'FullRowSelect'
$grid.GridColor = [System.Drawing.Color]::FromArgb(55,58,70)
$grid.DefaultCellStyle.SelectionBackColor = [System.Drawing.Color]::FromArgb(50,90,150)
$grid.AlternatingRowsDefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(26,28,38)
$grid.ColumnHeadersDefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(40,43,58)
$grid.ColumnHeadersDefaultCellStyle.ForeColor = [System.Drawing.Color]::White
$grid.ColumnHeadersDefaultCellStyle.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$grid.EnableHeadersVisualStyles = $false
$grid.CellFormatting.Add({
    param($s, $e)
    if ($e.ColumnIndex -eq 2 -and $e.Value) {
        if ($e.Value -eq 'EN MARCHE') { $e.CellStyle.ForeColor = $Green; $e.CellStyle.Font = New-Object System.Drawing.Font('Segoe UI',9,[System.Drawing.FontStyle]::Bold) }
        elseif ($e.Value -eq 'Arrete') { $e.CellStyle.ForeColor = $Red }
        else { $e.CellStyle.ForeColor = $Orange }
    }
    if (($e.ColumnIndex -eq 4 -or $e.ColumnIndex -eq 5) -and $e.Value) { $e.CellStyle.ForeColor = [System.Drawing.Color]::FromArgb(180,210,255) }
})
$tabServices.Controls.Add($grid)

# Sparkline picture box (memoire du service selectionne)
$sparkLabel = New-Object System.Windows.Forms.Label
$sparkLabel.Text = 'Memoire (RAM) - selection'; $sparkLabel.ForeColor = [System.Drawing.Color]::FromArgb(160,170,190)
$sparkLabel.Location = New-Object System.Drawing.Point(648, 12); $sparkLabel.AutoSize = $true
$tabServices.Controls.Add($sparkLabel)
$spark = New-Object System.Windows.Forms.PictureBox
$spark.Location = New-Object System.Drawing.Point(648, 34); $spark.Size = New-Object System.Drawing.Size(220, 120)
$spark.BackColor = [System.Drawing.Color]::FromArgb(12,14,20); $spark.BorderStyle = 'FixedSingle'
$tabServices.Controls.Add($spark)

# Boutons
$btnStart = New-Object System.Windows.Forms.Button; $btnStart.Text = 'Demarrer tout'; Style-Button $btnStart $Green $TextLight
$btnStart.Location = New-Object System.Drawing.Point(12, 384); $btnStart.Size = New-Object System.Drawing.Size(110, 34)
$btnStop  = New-Object System.Windows.Forms.Button; $btnStop.Text = 'Arreter tout'; Style-Button $btnStop $Red $TextLight
$btnStop.Location = New-Object System.Drawing.Point(130, 384); $btnStop.Size = New-Object System.Drawing.Size(110, 34)
$btnStartSel = New-Object System.Windows.Forms.Button; $btnStartSel.Text = 'Demarrer sel.'; Style-Button $btnStartSel $Accent $TextLight
$btnStartSel.Location = New-Object System.Drawing.Point(250, 384); $btnStartSel.Size = New-Object System.Drawing.Size(110, 34)
$btnStopSel  = New-Object System.Windows.Forms.Button; $btnStopSel.Text = 'Arreter sel.'; Style-Button $btnStopSel [System.Drawing.Color]::FromArgb(200,120,60) $TextLight
$btnStopSel.Location = New-Object System.Drawing.Point(370, 384); $btnStopSel.Size = New-Object System.Drawing.Size(110, 34)
$btnOpen  = New-Object System.Windows.Forms.Button; $btnOpen.Text = 'Ouvrir sel.'; Style-Button $btnOpen [System.Drawing.Color]::FromArgb(90,90,110) $TextLight
$btnOpen.Location = New-Object System.Drawing.Point(490, 384); $btnOpen.Size = New-Object System.Drawing.Size(110, 34)
$tabServices.Controls.AddRange(@($btnStart,$btnStop,$btnStartSel,$btnStopSel,$btnOpen))

# Log texte (actions)
$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true; $logBox.ScrollBars = 'Vertical'
$logBox.Location = New-Object System.Drawing.Point(12, 430); $logBox.Size = New-Object System.Drawing.Size(856, 130)
$logBox.ReadOnly = $true; $logBox.BackColor = [System.Drawing.Color]::FromArgb(10,12,18)
$logBox.ForeColor = [System.Drawing.Color]::FromArgb(120,255,160); $logBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$tabServices.Controls.Add($logBox)

# Status bar
$statusBar = New-Object System.Windows.Forms.StatusBar
$statusBar.BackColor = [System.Drawing.Color]::FromArgb(30,32,42)
$statusBar.ForeColor = [System.Drawing.Color]::FromArgb(180,200,230)
$form.Controls.Add($statusBar)

# ----- Icone barre des taches (systray) -----
$notify = New-Object System.Windows.Forms.NotifyIcon
# Icone generee a la volee (carre degrade bleu)
$iconBmp = New-Object System.Drawing.Bitmap(16, 16)
$ig = [System.Drawing.Graphics]::FromImage($iconBmp)
$ig.FillRectangle((New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.Rectangle]::new(0,0,16,16), [System.Drawing.Color]::FromArgb(90,130,255), [System.Drawing.Color]::FromArgb(40,44,66), 'Vertical')), 0, 0, 16, 16)
$ig.FillEllipse([System.Drawing.Brushes]::White, 4, 4, 8, 8)
$ig.Dispose()
$notify.Icon = [System.Drawing.Icon]::FromHandle($iconBmp.GetHicon())
$notify.Text = 'Titanium Pronos - Panneau de controle'
$notify.Visible = $false
$menuOuvrir = New-Object System.Windows.Forms.MenuItem('Ouvrir le panneau', { $form.Show(); $form.WindowState = 'Normal'; $form.ShowInTaskbar = $true; $notify.Visible = $false })
$menuQuitter = New-Object System.Windows.Forms.MenuItem('Quitter', {
    $global:ForceExit = $true
    $timer.Stop(); $notify.Visible = $false
    powershell -NoProfile -ExecutionPolicy Bypass -File "$StitchDir\scripts\stop_local_services.ps1" | Out-Null
    $form.Close()
})
$notify.ContextMenu = New-Object System.Windows.Forms.ContextMenu(@($menuOuvrir, $menuQuitter))
$notify.Add_DoubleClick({ $form.Show(); $form.WindowState = 'Normal'; $form.ShowInTaskbar = $true; $notify.Visible = $false })

# ---------- Tab Logs ----------
$logPicker = New-Object System.Windows.Forms.ComboBox
$logPicker.Location = New-Object System.Drawing.Point(12, 12); $logPicker.Size = New-Object System.Drawing.Size(500, 24)
$logPicker.DropDownStyle = 'DropDownList'; $logPicker.ForeColor = [System.Drawing.Color]::Black
$tabLogs.Controls.Add($logPicker)
$btnLogRefresh = New-Object System.Windows.Forms.Button; $btnLogRefresh.Text = 'Rafraichir liste'; Style-Button $btnLogRefresh [System.Drawing.Color]::FromArgb(90,90,110) $TextLight
$btnLogRefresh.Location = New-Object System.Drawing.Point(520, 10); $btnLogRefresh.Size = New-Object System.Drawing.Size(110, 24)
$tabLogs.Controls.Add($btnLogRefresh)
$logLive = New-Object System.Windows.Forms.TextBox
$logLive.Multiline = $true; $logLive.ScrollBars = 'Vertical'
$logLive.Location = New-Object System.Drawing.Point(12, 44); $logLive.Size = New-Object System.Drawing.Size(856, 520)
$logLive.ReadOnly = $true; $logLive.BackColor = [System.Drawing.Color]::FromArgb(8,10,14)
$logLive.ForeColor = [System.Drawing.Color]::FromArgb(160,230,180); $logLive.Font = New-Object System.Drawing.Font('Consolas', 9)
$tabLogs.Controls.Add($logLive)

# ----- Logique -----
$logPos = @{}
function Refresh-LogPicker {
    $cur = $logPicker.SelectedItem
    $logPicker.Items.Clear()
    Get-LogFiles | ForEach-Object { $logPicker.Items.Add($_) | Out-Null }
    if ($cur -and $logPicker.Items.Contains($cur)) { $logPicker.SelectedItem = $cur }
    elseif ($logPicker.Items.Count -gt 0) { $logPicker.SelectedIndex = 0 }
}
function Append-Log($msg) { $logBox.AppendText("$(Get-Date -Format 'HH:mm:ss')  $msg`r`n"); $logBox.ScrollToCaret() }

function Start-All { Append-Log "Demarrage de la stack (start.bat)..."; Start-Process -FilePath "cmd.exe" -ArgumentList "/c start.bat" -WorkingDirectory $StitchDir -WindowStyle Normal; Append-Log "Stack lancee. ~15s puis Actualiser." }
function Stop-All  { Append-Log "Arret de tous les services..."; & powershell -NoProfile -ExecutionPolicy Bypass -File "$StitchDir\scripts\stop_local_services.ps1" | Out-Null; Append-Log "Services arretes." }
function Call-Manage($action, $marker) {
    # map marker -> key dans manage_service
    $keyMap = @{ 'server.js'='api_core'; 'fastapi_server'='ml_core'; 'vite'='ui_dash'; 'command_center.py'='command'; 'redis.windows.conf'='redis'; 'SofascoreScraping'='scraper'; 'adaptive_learning_sync'='learn'; 'live_value_alerts.js'='live_alerts' }
    $key = $keyMap[$marker]
    if ($key) { Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$StitchDir\scripts\manage_service.ps1`" -Action $action -Key $key" -WindowStyle Hidden }
}
function Start-Sel {
    if ($grid.SelectedRows.Count -eq 0) { Append-Log "Selectionnez une ligne."; return }
    $m = $grid.SelectedRows[0].Cells['__Marker'].Value
    Call-Manage 'start' $m; Append-Log "Demarrage service : $($grid.SelectedRows[0].Cells['Nom'].Value)"
}
function Stop-Sel {
    if ($grid.SelectedRows.Count -eq 0) { Append-Log "Selectionnez une ligne."; return }
    $m = $grid.SelectedRows[0].Cells['__Marker'].Value
    Call-Manage 'stop' $m; Append-Log "Arret service : $($grid.SelectedRows[0].Cells['Nom'].Value)"
}

function Draw-Spark($name) {
    $bmp = New-Object System.Drawing.Bitmap($spark.Width, $spark.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromArgb(12,14,20))
    $q = $memHist[$name]
    if ($q -and $q.Count -gt 1) {
        $vals = @($q)
        $max = ($vals | Measure-Object -Maximum).Maximum
        $min = ($vals | Measure-Object -Minimum).Minimum
        $range = if ($max -eq $min) { 1 } else { $max - $min }
        $w = $spark.Width; $h = $spark.Height - 8; $step = $w / ($vals.Count - 1)
        $pts = @()
        for ($i=0; $i -lt $vals.Count; $i++) {
            $x = $i * $step
            $y = $h - (($vals[$i] - $min) / $range) * $h + 4
            $pts += New-Object System.Drawing.PointF($x, $y)
        }
        $pen = New-Object System.Drawing.Pen($Accent, 2)
        if ($pts.Count -gt 1) { $g.DrawLines($pen, $pts) }
        $g.FillEllipse([System.Drawing.Brushes]::FromArgb(255,120,160,255), $pts[-1].X-3, $pts[-1].Y-3, 6, 6)
        $last = $vals[-1]
        $txt = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
        $g.DrawString("$last MB", $txt, [System.Drawing.Brushes]::White, 6, 4)
    } else {
        $g.DrawString("En attente...", (New-Object System.Drawing.Font('Segoe UI',9)), [System.Drawing.Brushes]::Gray, 6, 50)
    }
    $g.Dispose()
    if ($spark.Image) { $spark.Image.Dispose() }
    $spark.Image = $bmp
}

function Refresh-Grid {
    $metrics = Get-ServiceMetrics
    $rows = New-Object System.Collections.ArrayList
    foreach ($s in $Services) {
        $etat = Get-ServiceState $s
        $m = $metrics[$s.Nom]
        # historique memoire
        if ($memHist[$s.Nom].Count -ge 60) { $memHist[$s.Nom].Dequeue() | Out-Null }
        $memHist[$s.Nom].Enqueue($m.Mem) | Out-Null
        $rows.Add([PSCustomObject]@{
            Nom     = $s.Nom
            Port    = if ($s.Port -eq 0) { '-' } else { $s.Port }
            Etat    = $etat
            Sante   = if ($etat -eq 'EN MARCHE') { Test-Health $s.Url } else { '-' }
            'CPU %' = if ($etat -eq 'EN MARCHE') { $m.Cpu } else { 0 }
            'RAM'   = if ($etat -eq 'EN MARCHE') { "$($m.Mem) MB" } else { '-' }
            __Marker= $s.Marker
            Url     = $s.Url
            Desc    = $s.Desc
        }) | Out-Null
    }
    $grid.DataSource = $rows
    $grid.Refresh()
    $grid.Columns['Nom'].Width=120; $grid.Columns['Port'].Width=50; $grid.Columns['Etat'].Width=95
    $grid.Columns['Sante'].Width=75; $grid.Columns['CPU %'].Width=55; $grid.Columns['RAM'].Width=70
    $grid.Columns['__Marker'].Visible=$false; $grid.Columns['Url'].Visible=$false; $grid.Columns['Desc'].Visible=$false
    # spark du service selectionne
    $sel = if ($grid.SelectedRows.Count -gt 0) { $grid.SelectedRows[0].Cells['Nom'].Value } else { $Services[0].Nom }
    Draw-Spark $sel
    $up = ($rows | Where-Object { $_.Etat -eq 'EN MARCHE' }).Count
    $statusBar.Text = "MAJ $(Get-Date -Format 'HH:mm:ss')   |   Actifs : $up/$($rows.Count)"
    $statusDot.BackColor = if ($up -gt 0) { $Green } else { $Red }
}

function Refresh-LiveLog {
    $f = $logPicker.SelectedItem
    if (-not $f -or -not (Test-Path $f)) { return }
    $len = (Get-Item $f).Length
    $prev = if ($logPos.ContainsKey($f)) { $logPos[$f] } else { $len }
    if ($len -lt $prev) { $prev = 0 } # fichier rogne/tourne
    $sr = [System.IO.StreamReader]::new($f)
    $sr.BaseStream.Seek($prev, [System.IO.SeekOrigin]::Begin) | Out-Null
    $new = $sr.ReadToEnd(); $sr.Close()
    if ($new.Trim().Length -gt 0) {
        $logLive.AppendText($new)
        $logLive.ScrollToCaret()
    }
    $logPos[$f] = $len
}

# ----- Events -----
$btnRefresh = New-Object System.Windows.Forms.Button; $btnRefresh.Text = 'Actualiser'; Style-Button $btnRefresh $Accent $TextLight
$btnRefresh.Location = New-Object System.Drawing.Point(610, 384); $btnRefresh.Size = New-Object System.Drawing.Size(110, 34)
$tabServices.Controls.Add($btnRefresh)
$btnHide = New-Object System.Windows.Forms.Button; $btnHide.Text = 'Masquer'; Style-Button $btnHide [System.Drawing.Color]::FromArgb(120,90,140) $TextLight
$btnHide.Location = New-Object System.Drawing.Point(728, 384); $btnHide.Size = New-Object System.Drawing.Size(110, 34)
$tabServices.Controls.Add($btnHide)
$btnRefresh.Add_Click({ Refresh-Grid })
$btnHide.Add_Click({ $form.Hide(); $form.ShowInTaskbar = $false; $notify.Visible = $true; Append-Log "Panneau masque. Double-clic l'icone en bas a droite pour rouvrir." })
$btnStart.Add_Click({ Start-All; Start-Sleep -Seconds 1; Refresh-Grid })
$btnStop.Add_Click({ Stop-All; Start-Sleep -Seconds 1; Refresh-Grid })
$btnStartSel.Add_Click({ Start-Sel; Start-Sleep -Seconds 1; Refresh-Grid })
$btnStopSel.Add_Click({ Stop-Sel; Start-Sleep -Seconds 1; Refresh-Grid })
$btnOpen.Add_Click({
    if ($grid.SelectedRows.Count -eq 0) { Append-Log "Selectionnez une ligne."; return }
    $url = $grid.SelectedRows[0].Cells['Url'].Value
    if ($url -and $url -ne '') { Start-Process $url; Append-Log "Ouverture: $url" } else { Append-Log "Pas d'URL web pour ce service." }
})
$grid.Add_CellDoubleClick({ if ($grid.SelectedRows.Count -gt 0) { $u=$grid.SelectedRows[0].Cells['Url'].Value; if ($u) { Start-Process $u } } })
$grid.Add_SelectionChanged({ if ($grid.SelectedRows.Count -gt 0) { Draw-Spark $grid.SelectedRows[0].Cells['Nom'].Value } })
$btnLogRefresh.Add_Click({ Refresh-LogPicker; $logPos.Clear() })
$tabs.Add_Selected({ if ($tabs.SelectedTab -eq $tabLogs) { Refresh-LogPicker } })

# Auto-refresh
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 4000
$timer.Add_Tick({ Refresh-Grid; if ($tabs.SelectedTab -eq $tabLogs) { Refresh-LiveLog } })
$timer.Start()
$form.Add_FormClosing({
    if (-not $global:ForceExit) {
        $_.Cancel = $true
        $form.Hide(); $form.ShowInTaskbar = $false; $notify.Visible = $true
    } else {
        $timer.Stop()
    }
})

Refresh-LogPicker
Refresh-Grid
Append-Log "Panneau pret (v2). Rafraichissement auto 4s. Cliquez 'Demarrer tout'."
[System.Windows.Forms.Application]::EnableVisualStyles() | Out-Null
[System.Windows.Forms.Application]::Run($form)

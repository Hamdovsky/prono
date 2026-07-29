import express, { Request, Response } from 'express'
const router = express.Router()

router.get('/', (_req: Request, res: Response) => {
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Accuracy Dashboard — Titanium AI</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
  h1 { color: #38bdf8; margin-bottom: 20px; font-size: 1.5rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #1e293b; border-radius: 8px; padding: 16px; border: 1px solid #334155; }
  .card .label { color: #94a3b8; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { color: #38bdf8; font-size: 1.8rem; font-weight: 700; margin-top: 4px; }
  .card .sub { color: #64748b; font-size: 0.75rem; margin-top: 2px; }
  canvas { background: #1e293b; border-radius: 8px; padding: 16px; border: 1px solid #334155; max-height: 400px; }
  .filters { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .filters input, .filters button { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 8px 16px; border-radius: 6px; font-size: 0.9rem; }
  .filters button { background: #2563eb; border: none; cursor: pointer; }
  .filters button:hover { background: #1d4ed8; }
  .loading { text-align: center; padding: 40px; color: #64748b; }
  .error { color: #ef4444; padding: 20px; text-align: center; }
</style>
</head>
<body>
<h1>📊 Accuracy Trend — Titanium AI</h1>
<div class="stats" id="stats"></div>
<div class="filters">
  <input type="text" id="leagueFilter" placeholder="Ligue (ex: Ligue 1)" />
  <button onclick="loadData()">Actualiser</button>
</div>
<div id="chartContainer">
  <div class="loading" id="loading">Chargement...</div>
  <canvas id="accuracyChart" style="display:none"></canvas>
</div>
<script>
const ctx = document.getElementById('accuracyChart').getContext('2d')
let chart = null

async function loadData() {
  const loading = document.getElementById('loading')
  const canvas = document.getElementById('accuracyChart')
  loading.style.display = 'block'
  canvas.style.display = 'none'

  const league = document.getElementById('leagueFilter').value
  const url = league ? '/api/backtest/trend?league=' + encodeURIComponent(league) : '/api/backtest/trend'

  try {
    const res = await fetch(url)
    const data = await res.json()
    if (!data.success || !data.trend.length) {
      loading.textContent = 'Aucune donnée disponible'
      return
    }

    const months = data.trend.map(d => d.month)
    const accuracies = data.trend.map(d => d.accuracy * 100)
    const totals = data.trend.map(d => d.total)

    const avg = (accuracies.reduce((a, b) => a + b, 0) / accuracies.length).toFixed(1)
    const best = Math.max(...accuracies).toFixed(1)
    const worst = Math.min(...accuracies).toFixed(1)
    const total = totals.reduce((a, b) => a + b, 0)

    document.getElementById('stats').innerHTML = \`
      <div class="card"><div class="label">Accuracy Moyenne</div><div class="value">\${avg}%</div><div class="sub">\${data.trend.length} mois</div></div>
      <div class="card"><div class="label">Meilleur Mois</div><div class="value">\${best}%</div></div>
      <div class="card"><div class="label">Pire Mois</div><div class="value">\${worst}%</div></div>
      <div class="card"><div class="label">Matchs Analysés</div><div class="value">\${total.toLocaleString()}</div></div>
    \`

    if (chart) chart.destroy()
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: months,
        datasets: [{
          label: 'Accuracy %',
          data: accuracies,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#94a3b8' } }
        },
        scales: {
          x: {
            ticks: { color: '#64748b', maxTicksLimit: 30, font: { size: 10 } },
            grid: { color: '#1e293b' }
          },
          y: {
            min: 30,
            max: 70,
            ticks: { color: '#64748b', callback: v => v + '%' },
            grid: { color: '#334155' }
          }
        }
      }
    })

    loading.style.display = 'none'
    canvas.style.display = 'block'
  } catch (e) {
    loading.textContent = 'Erreur: ' + e.message
  }
}

loadData()
</script>
</body>
</html>`)
})

export = router

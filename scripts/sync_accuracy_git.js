#!/usr/bin/env node
/**
 * sync_accuracy_git.js — Persiste la précision dans le repo git
 * ─────────────────────────────────────────────────────────
 * OBJECTIF : garder l'historique de précision à travers les redeploys Render
 * (le disque du container est éphémère). On récupère le trend depuis l'API
 * du service déployé et on la commit/push dans le repo (data/, pas .git).
 *
 * ⚠️ À exécuter LOCALEMENT (vos creds git existent ici). Ne tourne PAS dans
 *    le container Render (sinon chaque push redéclencherait un deploy).
 *
 * Usage :
 *   node scripts/sync_accuracy_git.js [baseUrl]
 *   Ex: node scripts/sync_accuracy_git.js https://pronostico.onrender.com
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TREND_PATH = path.join(ROOT, 'data', 'promosport_accuracy_trend.json')

const baseUrl =
  process.argv[2] || process.env.SITE_BASE_URL || 'https://pronostico.onrender.com'

const git = (...args) =>
  execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' })

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

async function main() {
  const ts = new Date().toISOString()
  const summary = []

  // 1) Trend promosport
  try {
    const data = await fetchJson(`${baseUrl}/api/evolution/accuracy/trend`)
    if (data && data.success && Array.isArray(data.trend)) {
      fs.mkdirSync(path.dirname(TREND_PATH), { recursive: true })
      fs.writeFileSync(TREND_PATH, JSON.stringify(data.trend, null, 2))
      summary.push(`trend: ${data.trend.length} points`)
    } else {
      summary.push('trend: vide (aucun snapshot)')
    }
  } catch (e) {
    summary.push(`trend: erreur -> ${e.message}`)
  }

  // 2) Accuracy log unifié (lecture seule — fichier ignoré par .gitignore)
  let byLeagueCount = 0
  try {
    const data = await fetchJson(`${baseUrl}/api/accuracy`)
    if (data && data.entries) {
      byLeagueCount = Object.values(data.byLeague || {}).reduce(
        (s, a) => s + (a ? a.length : 0),
        0
      )
      summary.push(
        `accuracy_log: ${data.entries.length} entries / ${byLeagueCount} byLeague (non commité, lecture seule)`
      )
    } else {
      summary.push('accuracy_log: none')
    }
  } catch (e) {
    summary.push(`accuracy_log: erreur -> ${e.message}`)
  }

  // 3) Commit + push si changements (seul le trend est commité dans data/)
  try {
    git('add', 'data/promosport_accuracy_trend.json')
    const status = git('status', '--porcelain')
    if (status.trim()) {
      git('commit', '-m', `data: accuracy snapshot [${ts}] (${summary.join(' | ')})`)
      git('push', 'origin', 'main')
      console.log('✅ Push git effectué.')
    } else {
      console.log('ℹ️  Aucun changement à committer. (état inchangé)')
    }
  } catch (e) {
    console.error('❌ git error:', e.message)
    process.exit(1)
  }

  console.log('Synthèse périodique :', summary.join(' | '))
}

main().catch((e) => {
  console.error('❌ Fatal:', e.message)
  process.exit(1)
})
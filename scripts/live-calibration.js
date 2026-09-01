#!/usr/bin/env node
/**
 * live-calibration.js — outil CLI pour le calibrage O/U 2.5 (point 3).
 *
 * À chaque fois qu'un de tes matchs live « prédit » se termine, note le score
 * final et résous la prédiction pour alimenter le registre de résultats. Le
 * taux de réussite réel par tranche de confiance finira par recalibrer les seuils.
 *
 * Usage :
 *   node scripts/live-calibration.js list                 # lister prédictions non résolues
 *   node scripts/live-calibration.js resolve <eventId> <butsHome> <butsAway>
 *   node scripts/live-calibration.js stats                # stats de calibrage
 *   node scripts/live-calibration.js dump                 # tout le journal (audit)
 */
const path = require('path')
const Journal = require(path.join(__dirname, '..', 'services', 'scrapers', 'LivePredictionJournal'))

const [, , sub, ...args] = process.argv

function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function listAll() {
  const journal = Journal.getJournal()
  const unresolved = journal.filter((r) => !r.resolved)
  console.log('=== Prédictions O/U live enregistrées (non résolues : ' + unresolved.length + ') ===')
  console.log(pad('EVENT ID', 12) + pad('MATCH', 44) + pad('PICK', 12) + pad('PROB OVER', 12) + 'minute | prédit')
  for (const r of journal) {
    if (!r.resolved) {
      console.log(
        pad(r.eventId, 12) +
          pad(r.homeTeam + ' ' + r.homeScore + '-' + r.awayScore + ' ' + r.awayTeam, 44) +
          pad(r.pick, 12) +
          pad((r.over25 * 100).toFixed(1) + '%', 12) +
          (r.minute != null ? r.minute : '?') + ' | ' + (r.predScore || '')
      )
    }
  }
  console.log('\nRésous avec : node scripts/live-calibration.js resolve <eventId> <butsHome> <butsAway>')
}

function runResolve() {
  const [eventId, hh, aa] = args
  if (!eventId || hh == null || aa == null) {
    console.error('Usage : node scripts/live-calibration.js resolve <eventId> <butsHome> <butsAway>')
    process.exit(1)
  }
  const changed = Journal.resolve(eventId, Number(hh), Number(aa))
  if (!changed.length) {
    console.log('Aucune prédiction non résolue pour eventId=' + eventId + ' (déjà résolue ou inconnue).')
    return
  }
  for (const r of changed) {
    console.log(
      'Résolu ' + r.eventId + ' : score final ' + r.finalHome + '-' + r.finalAway +
      ' (total ' + r.finalTotal + ') | prédit ' + r.pick + ' (' + (r.predictedOver * 100).toFixed(1) + '% OVER)' +
      ' => ' + (r.pickCorrect === true ? '✅ CORRECT' : r.pickCorrect === false ? '❌ INCORRECT' : 'push/NA')
    )
  }
}

function showStats() {
  const s = Journal.stats()
  console.log('=== Stats de calibrage O/U 2.5 ===')
  console.log('Prédictions résolues : ' + s.resolved + ' | réussites : ' + s.hits +
    ' | taux global : ' + (s.overallHitRate == null ? 'N/A' : s.overallHitRate + '%'))
  console.log('\nPar tranche de confiance :')
  for (const b of s.byBucket) console.log('  ' + b.bucket + ' : ' + b.n + ' préd. | réussite ' + (b.hitRate == null ? 'N/A' : b.hitRate + '%'))
  console.log('Par type de pari :')
  for (const b of s.byPick) console.log('  ' + b.pick + ' : ' + b.n + ' préd. | réussite ' + (b.hitRate == null ? 'N/A' : b.hitRate + '%'))
}

switch (sub) {
  case 'list':
    listAll()
    break
  case 'resolve':
    runResolve()
    break
  case 'stats':
    showStats()
    break
  case 'dump':
    console.log(JSON.stringify({ journal: Journal.getJournal(), results: Journal.getResults() }, null, 2))
    break
  default:
    console.error('Usage: node scripts/live-calibration.js {list|resolve|stats|dump}')
    process.exit(1)
}

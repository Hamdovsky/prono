// @ts-nocheck
import fs from 'fs'
import path from 'path'
import logger from '../core/logger'

class SecretWeaponsTracker {
  constructor() {
    this.dataPath = path.join(__dirname, '..', 'data', 'secret_weapons_history.json')
    this.history = []
    this._load()
  }

  _load() {
    try {
      if (fs.existsSync(this.dataPath)) {
        this.history = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'))
        logger.info(`[WEAPONS TRACKER] Loaded ${this.history.length} historical records`)
      }
    } catch (e) {
      logger.warn(`[WEAPONS TRACKER] Failed to load: ${e.message}`)
      this.history = []
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.dataPath, JSON.stringify(this.history, null, 2))
    } catch (e) {
      logger.warn(`[WEAPONS TRACKER] Failed to save: ${e.message}`)
    }
  }

  recordPrediction(concours, weapons) {
    const existing = this.history.find((h) => h.concours === concours)
    if (existing) {
      logger.info(`[WEAPONS TRACKER] Concours ${concours} already recorded, skipping`)
      return existing
    }

    const record = {
      concours,
      date: new Date().toISOString(),
      matches: weapons.map((w) => ({
        id: w.id,
        home: w.home,
        away: w.away,
        crowdFav: w.crowdFav,
        realFav: w.realFav,
        isContrarian: w.isContrarian,
        contrarianScore: w.contrarianStrength?.score || 0,
        ev: w.ev?.maxEV || 0,
        boldness: w.boldness?.label || 'SAFE',
        bTeam: w.bTeamHome?.isBTeam || w.bTeamAway?.isBTeam || false,
        predictedResult: null,
        actualResult: null,
        correct: null,
      })),
      stats: {
        totalContrarian: weapons.filter((w) => w.isContrarian).length,
        totalBTeam: weapons.filter((w) => w.bTeamHome?.isBTeam || w.bTeamAway?.isBTeam).length,
        totalBold: weapons.filter((w) => (w.boldness?.label || '').includes('BOLD')).length,
      },
    }

    this.history.push(record)
    if (this.history.length > 200) this.history = this.history.slice(-200)
    this._save()
    return record
  }

  recordResults(concours, results) {
    const record = this.history.find((h) => h.concours === concours)
    if (!record) {
      logger.warn(`[WEAPONS TRACKER] Concours ${concours} not found`)
      return null
    }

    for (const r of results) {
      const match = record.matches.find((m) => m.id === r.id)
      if (match) {
        match.actualResult = r.result
        match.correct = match.realFav === r.result
      }
    }

    const total = record.matches.length
    const correct = record.matches.filter((m) => m.correct === true).length
    const wrong = record.matches.filter((m) => m.correct === false).length
    const pending = record.matches.filter((m) => m.correct === null).length

    record.accuracy = total > 0 ? +((correct / total) * 100).toFixed(1) : 0
    record.updatedAt = new Date().toISOString()
    this._save()
    return { total, correct, wrong, pending, accuracy: record.accuracy }
  }

  getStats() {
    const completed = this.history.filter((h) => h.matches.every((m) => m.correct !== null))
    const totalCorrect = completed.reduce(
      (s, h) => s + h.matches.filter((m) => m.correct === true).length,
      0
    )
    const totalWrong = completed.reduce(
      (s, h) => s + h.matches.filter((m) => m.correct === false).length,
      0
    )
    const total = totalCorrect + totalWrong

    const contrarianCorrect = completed.reduce(
      (s, h) => s + h.matches.filter((m) => m.isContrarian && m.correct === true).length,
      0
    )
    const contrarianTotal = completed.reduce(
      (s, h) => s + h.matches.filter((m) => m.isContrarian).length,
      0
    )
    const bTeamCorrect = completed.reduce(
      (s, h) => s + h.matches.filter((m) => m.bTeam && m.correct === true).length,
      0
    )
    const bTeamTotal = completed.reduce((s, h) => s + h.matches.filter((m) => m.bTeam).length, 0)

    return {
      totalConcours: this.history.length,
      completedConcours: completed.length,
      pendingConcours: this.history.length - completed.length,
      totalPicks: total,
      accuracy: total > 0 ? +((totalCorrect / total) * 100).toFixed(1) : 0,
      correctPicks: totalCorrect,
      wrongPicks: totalWrong,
      contrarianAccuracy:
        contrarianTotal > 0 ? +((contrarianCorrect / contrarianTotal) * 100).toFixed(1) : 0,
      contrarianPicks: contrarianTotal,
      contrarianCorrect,
      bTeamAccuracy: bTeamTotal > 0 ? +((bTeamCorrect / bTeamTotal) * 100).toFixed(1) : 0,
      bTeamPicks: bTeamTotal,
      bTeamCorrect,
      lastUpdated: new Date().toISOString(),
    }
  }

  getHistory(limit = 10) {
    return this.history.slice(-limit).reverse()
  }
}

export = new SecretWeaponsTracker()

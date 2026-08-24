// @ts-nocheck
import fs from 'fs'
import path from 'path'
import logger from '../core/logger'

/**
 * ProbabilityCalibrator — P1 audit 2026-08
 * Source unique : data/accuracy_report.json (accuracyEngine.js — snapshot au
 * temps T, sans look-ahead). L'ancienne lecture de retro_accuracy_report.json
 * injectait la courbe biaisée « oracle du favori » (0.6-0.7 → 0.90,
 * 0.7-0.8 → 0.99, ≥0.8 → 1.0) et gonflait artificiellement les probabilités.
 * Sans données fiables → IDENTITÉ (aucune transformation), jamais de défauts
 * codés en dur gonflants. Miroir de probabilityCalibrator.js.
 */
class ProbabilityCalibrator {
  constructor() {
    this.calibrationCurve = null // null = identité
    this.lastLoaded = 0
    this.TTL = 86400000 // 24h — accuracy_report.json est régénéré quotidiennement
    this.MIN_SAMPLES_PER_BAND = 30 // bande trop peu peuplée → ignorée (identité)
  }

  loadCalibration() {
    if (this.calibrationCurve && Date.now() - this.lastLoaded < this.TTL) return
    try {
      const reportPath = path.join(__dirname, '..', 'data', 'accuracy_report.json')
      if (!fs.existsSync(reportPath)) {
        logger.warn('[CALIBRATOR] accuracy_report.json absent — calibration identité')
        this.calibrationCurve = null
        return
      }
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
      const curve = report?.rolling?.last30days?.calibrationCurve
      if (!Array.isArray(curve) || curve.length === 0) {
        logger.warn('[CALIBRATOR] calibrationCurve absente du rapport — calibration identité')
        this.calibrationCurve = null
        return
      }

      const bins = []
      for (const band of curve) {
        const m = /^(\d+)-(\d+)$/.exec(String(band.band))
        const acc = Number(band.accuracy)
        const n = Number(band.count) || 0
        if (!m || !Number.isFinite(acc)) continue
        if (n < this.MIN_SAMPLES_PER_BAND) continue
        bins.push({
          min: Number(m[1]) / 100,
          max: Number(m[2]) / 100,
          calibrated: acc / 100,
          count: n,
        })
      }
      if (bins.length === 0) {
        logger.warn('[CALIBRATOR] Aucune bande exploitable (n<30 partout) — identité')
        this.calibrationCurve = null
        return
      }
      bins.sort((a, b) => a.min - b.min)
      this.calibrationCurve = bins
      this.lastLoaded = Date.now()
      logger.info(
        `[CALIBRATOR] Courbe empirique accuracyEngine chargée (${bins.length} bandes, rolling 30j)`
      )
    } catch (err) {
      logger.error('[CALIBRATOR] Échec chargement:', err.message)
      this.calibrationCurve = null
    }
  }

  calibrateProb(prob) {
    this.loadCalibration()
    if (!this.calibrationCurve) return prob // identité
    for (const bin of this.calibrationCurve) {
      if (prob >= bin.min && prob < bin.max) return bin.calibrated
    }
    return prob // hors bandes connues : identité (fini le ×1.15)
  }

  calibrate(p1, px, p2) {
    const c1 = this.calibrateProb(p1)
    const cx = this.calibrateProb(px)
    const c2 = this.calibrateProb(p2)
    const total = c1 + cx + c2
    return {
      p1: total > 0 ? c1 / total : p1,
      px: total > 0 ? cx / total : px,
      p2: total > 0 ? c2 / total : p2,
    }
  }
}

export = new ProbabilityCalibrator()

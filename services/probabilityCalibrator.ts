// @ts-nocheck
import fs from 'fs'
import path from 'path'
import logger from '../core/logger'

class ProbabilityCalibrator {
  constructor() {
    this.calibrationCurve = null
    this.lastLoaded = 0
    this.TTL = 86400000
  }

  loadCalibration() {
    if (this.calibrationCurve && Date.now() - this.lastLoaded < this.TTL) return
    try {
      const reportPath = path.join(__dirname, '..', 'data', 'retro_accuracy_report.json')
      if (!fs.existsSync(reportPath)) {
        logger.warn('[CALIBRATOR] No retro report found, using defaults')
        this.calibrationCurve = this.getDefaultCurve()
        return
      }
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
      const cal = report.calibration?.EV_OPTIMIZED
      if (!cal) {
        this.calibrationCurve = this.getDefaultCurve()
        return
      }

      this.calibrationCurve = [
        { min: 0, max: 0.5, calibrated: 0.5 },
        { min: 0.5, max: 0.6, calibrated: (cal['50-60']?.actual || 53.6) / 100 },
        { min: 0.6, max: 0.7, calibrated: (cal['60-70']?.actual || 89.9) / 100 },
        { min: 0.7, max: 0.8, calibrated: (cal['70-80']?.actual || 98.9) / 100 },
        { min: 0.8, max: 0.9, calibrated: (cal['80-90']?.actual || 100) / 100 },
        { min: 0.9, max: 1.01, calibrated: (cal['90+']?.actual || 100) / 100 },
      ]
      this.lastLoaded = Date.now()
      logger.info(
        `[CALIBRATOR] Loaded empirical calibration curve (${this.calibrationCurve.length} bins)`
      )
    } catch (err) {
      logger.error('[CALIBRATOR] Failed to load:', err.message)
      this.calibrationCurve = this.getDefaultCurve()
    }
  }

  getDefaultCurve() {
    return [
      { min: 0, max: 0.5, calibrated: 0.5 },
      { min: 0.5, max: 0.6, calibrated: 0.536 },
      { min: 0.6, max: 0.7, calibrated: 0.899 },
      { min: 0.7, max: 0.8, calibrated: 0.989 },
      { min: 0.8, max: 0.9, calibrated: 1.0 },
      { min: 0.9, max: 1.01, calibrated: 1.0 },
    ]
  }

  calibrateProb(prob) {
    this.loadCalibration()
    for (const bin of this.calibrationCurve) {
      if (prob >= bin.min && prob < bin.max) return bin.calibrated
    }
    return Math.min(1, prob * 1.15)
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

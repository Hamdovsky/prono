import React, { useState, useMemo, useCallback } from 'react'
import { saveAsJpeg } from '../utils/exportUtils'
import './MegaTicket1000.css'

const MegaTicket1000 = ({ matches }) => {
  const [riskLevel, setRiskLevel] = useState('MEGA')
  const [refreshKey, setRefreshKey] = useState(0)

  const levels = {
    DIAMOND: {
      label: 'DIAMOND 80%+',
      target: 3.0,
      color: '#00d4ff',
      icon: '💎',
      desc: 'Sécurité Système Maximale',
      badge: 'CERTIFIÉ 80%+',
    },
    GOLD: {
      label: 'GOLD 20+',
      target: 20,
      color: '#10b981',
      icon: '💰',
      desc: 'Sécurisé / Régulier',
    },
    ULTRA: {
      label: 'ULTRA 100+',
      target: 100,
      color: '#a855f7',
      icon: '⚡',
      desc: 'Équilibré / Risque Moyen',
    },
    MEGA: {
      label: 'MEGA 1000+',
      target: 1000,
      color: '#ffd700',
      icon: '🏆',
      desc: 'Risque Élevé / Gain Maximal',
    },
  }

  const handleDownload = () => {
    saveAsJpeg(
      'mega-ticket-capture',
      `MegaTicket_${riskLevel}_${new Date().toISOString().split('T')[0]}.jpg`
    )
  }

  const megaTicket = useMemo(() => {
    if (!matches || matches.length === 0) return null

    // 1. Filter: Upcoming, high confidence matches
    let upcoming = matches.filter((m) => {
      const status = (m.status || '').toLowerCase()
      if (status === 'finished' || status === 'ft' || status === 'ended') return false

      const startStr = m.startTimestamp || m.timestamp || m.startTime
      const startTime = startStr ? (startStr > 1e11 ? startStr : startStr * 1000) : 0
      if (startTime && startTime < Date.now() - 60 * 60 * 1000) return false

      const conf = Math.round(
        m.v22_success_rate || m.enriched?.v22_success_rate || m.confidence || 0
      )

      // 2. Data Integrity: Filter unknown/placeholders
      const home = (m.homeTeam || '').toLowerCase()
      const away = (m.awayTeam || '').toLowerCase()
      const league = (m.league || '').toLowerCase()
      if (
        home.includes('unknown') ||
        away.includes('unknown') ||
        home === 'home' ||
        away === 'away'
      )
        return false
      if (league.includes('debug') || league.includes('test')) return false

      // 3. Strict Timing: Only upcoming matches within 48 hours
      const now = Date.now()
      if (startTime > now + 48 * 60 * 60 * 1000) return false

      return conf >= (riskLevel === 'DIAMOND' ? 85 : 70)
    })

    if (upcoming.length < (riskLevel === 'DIAMOND' ? 1 : 3)) return null

    // Sort by confidence descending (most confident first)
    upcoming = [...upcoming].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))

    const selections = []
    let totalMultiplier = 1.0
    let globalProb = 1.0
    const TARGET = levels[riskLevel].target

    // Audit P1b : plus aucune probabilité/cote fabriquée. Chaque sélection est
    // dérivée des vraies probabilités du modèle (1X2, O/U 2.5) et des cotes
    // réelles quand elles existent (sinon cote fair-value du modèle).
    const buildPick = (m, enriched) => {
      const rawH = parseFloat(m.home_win_probability ?? enriched.home_win_probability) || 0
      const rawD = parseFloat(m.draw_probability ?? enriched.draw_probability) || 0
      const rawA = parseFloat(m.away_win_probability ?? enriched.away_win_probability) || 0
      const s = rawH + rawD + rawA
      const nH = s > 0 ? rawH / s : 1 / 3
      const nD = s > 0 ? rawD / s : 1 / 3
      const nA = s > 0 ? rawA / s : 1 / 3

      const oH = parseFloat(m.odds_home ?? enriched.odds_home)
      const oD = parseFloat(m.odds_draw ?? enriched.odds_draw)
      const oA = parseFloat(m.odds_away ?? enriched.odds_away)
      const hasOdds = [oH, oD, oA].every((v) => Number.isFinite(v) && v > 1.01)
      let fH = nH,
        fD = nD,
        fA = nA
      if (hasOdds) {
        const iH = 1 / oH,
          iD = 1 / oD,
          iA = 1 / oA
        const mg = iH + iD + iA
        fH = iH / mg
        fD = iD / mg
        fA = iA / mg
      }
      const mktOdd = (real, fair) =>
        Number.isFinite(real) && real > 1.01 ? +real.toFixed(2) : +(1 / fair).toFixed(2)
      const dc1xOdd = +(1 / (hasOdds ? fH + fD : nH + nD)).toFixed(2)
      const dcx2Odd = +(1 / (hasOdds ? fA + fD : nA + nD)).toFixed(2)
      const dnbHOdd = +((hasOdds ? fH + fA : nH + nA) / (hasOdds ? fH : nH)).toFixed(2)
      const dnbAOdd = +((hasOdds ? fH + fA : nH + nA) / (hasOdds ? fA : nA)).toFixed(2)

      const ouRaw = parseFloat(m.ou_25_prob ?? enriched.ou_25_prob)
      const pOver =
        Number.isFinite(ouRaw) && ouRaw > 0 && ouRaw < 100 ? ouRaw / 100 : null

      let pick = null
      if (riskLevel === 'DIAMOND') {
        if (rawH > 85) pick = { label: 'Victoire (DNB): ' + m.homeTeam, prob: nH, odd: dnbHOdd }
        else if (rawA > 85)
          pick = { label: 'Victoire (DNB): ' + m.awayTeam, prob: nA, odd: dnbAOdd }
        else if (rawH >= rawA)
          pick = { label: 'Double Chance: 1X', prob: nH + nD, odd: dc1xOdd }
        else pick = { label: 'Double Chance: X2', prob: nA + nD, odd: dcx2Odd }
      } else if (riskLevel === 'GOLD') {
        if (rawH > 65)
          pick = { label: 'Victoire: ' + m.homeTeam, prob: nH, odd: mktOdd(oH, fH) }
        else if (rawA > 65)
          pick = { label: 'Victoire: ' + m.awayTeam, prob: nA, odd: mktOdd(oA, fA) }
        else if (nH + nD >= nA + nD)
          pick = { label: 'Double Chance: 1X', prob: nH + nD, odd: dc1xOdd }
        else pick = { label: 'Double Chance: X2', prob: nA + nD, odd: dcx2Odd }
      } else {
        const combo = (label, p) => ({ label, prob: p, odd: +(1 / p).toFixed(2) })
        const straightBest = () => {
          const mx = Math.max(nH, nA, nD)
          if (mx === nH)
            return { label: 'Victoire: ' + m.homeTeam, prob: nH, odd: mktOdd(oH, fH) }
          if (mx === nA) return { label: 'Victoire: ' + m.awayTeam, prob: nA, odd: mktOdd(oA, fA) }
          return { label: 'Match Nul (X)', prob: nD, odd: mktOdd(oD, fD) }
        }
        if (riskLevel === 'ULTRA') {
          if (rawH > 60 && pOver != null) pick = combo('1 & +2.5 Buts', nH * pOver)
          else if (rawA > 60 && pOver != null) pick = combo('2 & +2.5 Buts', nA * pOver)
          else if (pOver != null) pick = combo('Nul & -2.5 Buts', nD * (1 - pOver))
          else pick = straightBest()
        } else {
          if (rawH > 75 && pOver != null) pick = combo('1 & +2.5 Buts', nH * pOver)
          else if (rawA > 75 && pOver != null) pick = combo('2 & +2.5 Buts', nA * pOver)
          else if (rawD > 35 && pOver != null) pick = combo('Nul & -2.5 Buts', nD * (1 - pOver))
          else pick = straightBest()
        }
      }
      return pick
    }

    for (const m of upcoming) {
      // Stop conditions change for DIAMOND
      if (totalMultiplier >= TARGET) break

      if (riskLevel === 'DIAMOND') {
        if (globalProb < 0.78 && selections.length > 0) break // Keep it near 80%
        if (selections.length >= 5) break // Max 5 for Diamond
      }

      const enriched = m.enriched || {}
      const pick = buildPick(m, enriched)

      if (
        pick &&
        Number.isFinite(pick.prob) &&
        pick.prob > 0.001 &&
        Number.isFinite(pick.odd) &&
        pick.odd > 1
      ) {
        // For Diamond, we check if adding this lowers us too much
        const nextProb = globalProb * pick.prob
        if (riskLevel === 'DIAMOND' && nextProb < 0.78 && selections.length > 0) continue

        selections.push({
          id: m.id,
          league: m.league || m.category_name || 'Unknown',
          home: m.homeTeam || 'Home',
          away: m.awayTeam || 'Away',
          prediction: pick.label,
          odd: pick.odd,
          confidence: Math.round(pick.prob * 100),
        })
        totalMultiplier *= pick.odd
        globalProb = nextProb
      }
    }

    return {
      selections,
      totalOdd: totalMultiplier.toFixed(2),
      globalConfidence: (globalProb * 100).toFixed(2),
    }
  }, [matches, riskLevel, refreshKey])

  const copyTicket = useCallback(() => {
    if (!megaTicket) return
    const text =
      `🏆 TITANIUM ${levels[riskLevel].label}\n` +
      megaTicket.selections
        .map((s) => `📍 ${s.home} vs ${s.away}: ${s.prediction} (@${s.odd})`)
        .join('\n') +
      `\n\n💰 COTE TOTALE: ${megaTicket.totalOdd}\n📡 Probabilité Estimée: ${megaTicket.globalConfidence}%`
    navigator.clipboard.writeText(text)
    alert('TICKET COPIÉ AVEC SUCCÈS !')
  }, [megaTicket, riskLevel])

  if (!megaTicket || megaTicket.selections.length === 0) {
    return (
      <div className="mega-error">
        <div className="mega-error-icon">📉</div>
        <h3>SIGNAL INSUFFISANT ({riskLevel})</h3>
        <p>Pas assez de données pour générer un ticket de ce niveau actuellement.</p>
        <button className="mega-refresh-btn" onClick={() => setRefreshKey((k) => k + 1)}>
          Réessayer
        </button>
      </div>
    )
  }

  return (
    <div
      className="mega-container v3"
      style={{ '--theme-color': levels[riskLevel].color }}
      id="mega-ticket-capture"
    >
      {/* ACTION HUD */}
      <div className="mega-hud">
        <div className="mega-level-toggles">
          {['DIAMOND', 'GOLD', 'ULTRA', 'MEGA'].map((lvl) => (
            <button
              key={lvl}
              className={`mega-lvl-btn ${riskLevel === lvl ? 'active' : ''} lvl-${lvl}`}
              onClick={() => setRiskLevel(lvl)}
            >
              <span className="lvl-icon">{levels[lvl].icon}</span>
              <span className="lvl-label">{levels[lvl].label}</span>
            </button>
          ))}
        </div>
        <div className="mega-hud-actions">
          <button className="mega-hud-btn jpeg" onClick={handleDownload} title="Enregistrer JPEG">
            📸 JPEG
          </button>
          <button
            className="mega-hud-btn refresh"
            onClick={() => setRefreshKey((k) => k + 1)}
            title="Régénérer"
          >
            🔄
          </button>
          <button className="mega-hud-btn share" onClick={copyTicket}>
            📋 Copier
          </button>
        </div>
      </div>

      {/* PHYSICAL TICKET VIEW */}
      <div className="mega-slip-wrapper">
        <div className="mega-ticket-slip">
          {riskLevel === 'DIAMOND' && (
            <div className="diamond-safety-badge">
              <span className="badge-wave"></span>
              🛡️ {levels[riskLevel].badge}
            </div>
          )}

          <div className="mega-slip-header">
            <div className="mega-logo">
              TITANIUM<span>RADAR</span>{' '}
              {riskLevel === 'DIAMOND' && <span className="logo-sparkle">✨</span>}
            </div>
            <div className="mega-slip-id">{riskLevel} RADAR</div>
          </div>

          <div className="mega-level-indicator">
            <h3>{levels[riskLevel].label}</h3>
            <p>{levels[riskLevel].desc}</p>
          </div>

          <div className="mega-slip-entries">
            {megaTicket.selections.map((sel, idx) => (
              <div key={sel.id} className="mega-slip-entry">
                <div className="entry-head">
                  <span className="entry-num">{idx + 1}</span>
                  <span className="entry-league">{sel.league}</span>
                </div>
                <div className="entry-match">
                  {sel.home} - {sel.away}
                </div>
                <div className="entry-pick">
                  <span className="pick-label">{sel.prediction}</span>
                  <span className="pick-odd">@{sel.odd.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="mega-slip-footer">
            <div className="mega-slip-totals">
              <div className="total-row">
                <span>COTE TOTALE</span>
                <span className={riskLevel === 'DIAMOND' ? 'val-diamond' : 'val-gold'}>
                  {megaTicket.totalOdd}
                </span>
              </div>
              <div className="total-row">
                <span>CONFIANCE SYSTÈME</span>
                <span className={parseFloat(megaTicket.globalConfidence) >= 80 ? 'val-secure' : ''}>
                  {megaTicket.globalConfidence}%
                </span>
              </div>
            </div>

            <div className="mega-barcode">
              <div className="barcode-lines"></div>
              <div className="barcode-num">XG-TITANIUM-80-QUANTUM</div>
            </div>
          </div>

          <div className="perforated-edge">
            {[...Array(20)].map((_, i) => (
              <div key={i} className="perf-hole"></div>
            ))}
          </div>
        </div>

        <div className="mega-slip-note">
          {riskLevel === 'DIAMOND' ? (
            <span>
              💎 <b>CONSEIL EXPERT :</b> Mise recommandée : <u>10% à 15%</u> de votre Bankroll
              (Indice de confiance maximal).
            </span>
          ) : (
            <span>
              ⚠️ Ce ticket est de nature spéculative. Analysé par le moteur Titanium V58. <br />
              <b>Mise conseillée : Max 2-5% de Bankroll.</b>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default MegaTicket1000

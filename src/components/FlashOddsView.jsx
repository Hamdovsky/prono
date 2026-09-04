import React, { useState, useEffect, useCallback, useRef } from 'react'
import { getApiUrl } from '../config/apiConfig.js'

async function fetchFlashOdds() {
  try {
    const res = await fetch(getApiUrl('/api/flash-odds'))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data.success) throw new Error(data.error || 'Erreur serveur')
    return data.events || []
  } catch (e) {
    throw new Error(e.message)
  }
}

async function fetchCalibrationResolved() {
  const res = await fetch(getApiUrl('/api/flash-odds/results'))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (!data.success) throw new Error(data.error || 'Erreur serveur')
  return { journal: data.journal || [], results: data.results || [] }
}

async function fetchCalibrationStats() {
  const res = await fetch(getApiUrl('/api/flash-odds/calibration'))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (!data.success) throw new Error(data.error || 'Erreur serveur')
  return data
}

async function fetchLiveToggleState() {
  try {
    const res = await fetch(getApiUrl('/api/flash-odds/toggle'))
    if (!res.ok) return true
    const data = await res.json()
    return data.enabled !== false
  } catch {
    return true
  }
}

async function postLiveToggle(enabled) {
  const res = await fetch(getApiUrl('/api/flash-odds/toggle'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function CalibrationPanel() {
  const [stats, setStats] = useState(null)
  const [pending, setPending] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([fetchCalibrationStats(), fetchCalibrationResolved()])
      setStats(s)
      setPending(r.journal.filter((j) => !j.resolved))
      setErr(null)
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const int = setInterval(load, 45000)
    return () => clearInterval(int)
  }, [load])

  const barColor = (rate) => {
    if (rate == null) return '#64748b'
    if (rate >= 65) return '#22c55e'
    if (rate >= 50) return '#f59e0b'
    return '#ef4444'
  }

  return (
    <div style={{
      marginTop: '16px', padding: '12px 14px',
      background: 'rgba(30,41,59,0.35)', border: '1px solid #1e293b',
      borderRadius: '10px',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: '8px',
      }}>
        <div style={{ fontSize: '12px', fontWeight: '900', color: '#34d399', letterSpacing: '0.5px' }}>
          📊 CALIBRAGE LIVE — TAUX DE RÉUSSITE RÉEL
        </div>
        {stats && (
          <div style={{ fontSize: '10px', color: '#475569' }}>
            {stats.resolved} résolue{stats.resolved > 1 ? 's' : ''} · taux {stats.overallHitRate == null ? 'N/A' : stats.overallHitRate + '%'}
          </div>
        )}
      </div>

      {err && (
        <div style={{ fontSize: '10px', color: '#ef4444', marginBottom: '8px' }}>⚠️ {err}</div>
      )}
      {loading ? (
        <div style={{ fontSize: '10px', color: '#475569' }}>Chargement du calibrage...</div>
      ) : (
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}>
            <div style={{ fontSize: '9px', color: '#64748b', fontWeight: '700', marginBottom: '4px' }}>
              PAR TRANCHES DE CONFIANCE
            </div>
            {(stats?.byBucket || []).map((b) => (
              <div key={b.bucket} style={{ marginBottom: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', marginBottom: '2px' }}>
                  <span style={{ color: '#94a3b8', fontWeight: '700' }}>{b.bucket}</span>
                  <span style={{ color: '#cbd5e1' }}>
                    {b.n} préd. · <span style={{ color: barColor(b.hitRate), fontWeight: '800' }}>
                      {b.hitRate == null ? 'N/A' : b.hitRate + '%'}
                    </span>
                  </span>
                </div>
                <div style={{ height: '5px', background: '#1e293b', borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: (b.n ? Math.round((b.hit / b.n) * 100) : 0) + '%',
                    background: barColor(b.hitRate), borderRadius: '3px',
                  }} />
                </div>
              </div>
            ))}
            {!stats?.byBucket?.length && <div style={{ fontSize: '10px', color: '#334155' }}>—</div>}
          </div>

          <div style={{ flex: '1 1 200px' }}>
            <div style={{ fontSize: '9px', color: '#64748b', fontWeight: '700', marginBottom: '4px' }}>
              PAR TYPE DE PARI
            </div>
            {(stats?.byPick || []).map((b) => (
              <div key={b.pick} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', padding: '3px 0', borderBottom: '1px solid #1e293b' }}>
                <span style={{ color: b.pick.includes('OVER') ? '#22c55e' : '#0ea5e9', fontWeight: '800' }}>
                  {b.pick}
                </span>
                <span style={{ color: '#94a3b8' }}>{b.n} / <span style={{ color: '#cbd5e1', fontWeight: '700' }}>{b.hitRate == null ? '—' : b.hitRate + '%'}</span></span>
              </div>
            ))}
          </div>

          <div style={{ flex: '1 1 300px' }}>
            <div style={{ fontSize: '9px', color: '#f59e0b', fontWeight: '700', marginBottom: '4px' }}>
              🕒 PRÉDICTIONS EN ATTENTE ({pending.length})
            </div>
            {pending.slice(0, 6).map((p) => (
              <div key={p.recordId} style={{
                fontSize: '10px', padding: '4px 6px', marginBottom: '4px',
                background: 'rgba(0,0,0,0.2)', borderRadius: '5px',
              }}>
                <div style={{ color: '#f1f5f9', fontWeight: '700' }}>
                  {p.homeTeam} {p.homeScore}-{p.awayScore} {p.awayTeam} · {p.minute != null ? p.minute : '?'}'
                </div>
                <div style={{ color: '#94a3b8', marginTop: '1px' }}>
                  {p.pick} <span style={{ color: '#a5b4fc', fontWeight: '700' }}>{Math.round(p.over25 * 100)}%</span>
                  <span style={{ color: '#475569' }}> · id {p.eventId} · prédit {p.predScore}</span>
                </div>
              </div>
            ))}
            {pending.length === 0 && (
              <div style={{ fontSize: '10px', color: '#334155' }}>
                Aucune prédiction en attente. Elles apparaîtront automatiquement pendant les matchs en direct.
              </div>
            )}
            <div style={{ fontSize: '9px', color: '#475569', marginTop: '5px', lineHeight: '1.4' }}>
              💡 À chaque match terminé, saisis son score : <code style={{ color: '#34d399' }}>node scripts/live-calibration.js resolve &lt;id&gt; &lt;butsH&gt; &lt;butsA&gt;</code>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const MIN_ODDS_LIVE = 1.3

function ComboPicks({ events }) {
  const over = [], under = [], watch = [], value = []
  events.forEach((e) => {
    const odds = e.odds || {}
    const homeOdds = odds.home_win || odds.home
    const awayOdds = odds.away_win || odds.away
    const drawOdds = odds.draw
    const over25 = odds.over_25 || odds.over25
    const under25 = odds.under_25 || odds.under25
    if (!over25 && !under25) return
    const ouOdds = over25 ? over25 : under25
    if (ouOdds != null && ouOdds < MIN_ODDS_LIVE) return
    const prob = over25 ? (1 / over25) : (1 / under25)
    const ouPick = over25 && over25 < 2.0 ? 'OVER 2.5' : 'UNDER 2.5'
    const score = `${e.scoreHome ?? e.homeScore ?? 0}-${e.scoreAway ?? e.awayScore ?? 0}`
    const minute = e.minute || e.liveMinute || 0
    const label = `${e.homeTeam} vs ${e.awayTeam} · ${score} · ${Math.round(minute)}'`
    const item = { label, prob, xg: null, score: null, ou: ouPick, homeXg: null, awayXg: null, scorer: null, homeTeam: e.homeTeam, awayTeam: e.awayTeam }
    if (ouPick === 'OVER 2.5' && prob >= 0.50) { over.push({ ...item, conf: 'SUREST', prob }) }
    else if (ouPick === 'OVER 2.5' && prob >= 0.40) { over.push({ ...item, conf: 'LEAN', prob }) }
    else if (ouPick === 'UNDER 2.5' && prob >= 0.50) { under.push({ ...item, conf: 'SUREST', prob }) }
    else if (ouPick === 'UNDER 2.5' && prob >= 0.40) { under.push({ ...item, conf: 'LEAN', prob }) }
    else if (minute >= 55 && ouPick === 'OVER 2.5' && prob >= 0.30) { watch.push({ ...item, conf: 'À SURVEILLER', prob }) }
  })
  over.sort((a, b) => b.prob - a.prob)
  under.sort((a, b) => b.prob - a.prob)
  value.sort((a, b) => b.strength - a.strength)

  const tier = (title, color, list, minProb) => (
    <div style={{ flex: '1 1 240px', background: 'rgba(30,41,59,0.5)', border: `1px solid ${color}50`, borderRadius: '10px', padding: '10px 12px' }}>
      <div style={{ fontSize: '10px', fontWeight: '900', color, letterSpacing: '0.3px', marginBottom: '6px' }}>{title}</div>
      {list.length === 0 && <div style={{ fontSize: '10px', color: '#334155', padding: '4px 0' }}>—</div>}
      {list.slice(0, 5).map((it, i) => (
        <div key={i} style={{ marginBottom: '5px', paddingBottom: '5px', borderBottom: '1px solid #1e293b' }}>
          <div style={{ fontSize: '11px', fontWeight: '800', color: '#f1f5f9', lineHeight: '1.2' }}>{it.label}</div>
          <div style={{ display: 'flex', gap: '6px', marginTop: '2px', flexWrap: 'wrap' }}>
            <span style={{ color, fontWeight: '900', fontSize: '10px' }}>{it.conf} {Math.round(it.prob * 100)}%</span>
            <span style={{ color: '#64748b', fontSize: '10px' }}>xG {it.xg}</span>
            <span style={{ color: '#475569', fontSize: '10px' }}>→ {it.score}</span>
          </div>
          {it.scorer && <div style={{ fontSize: '9px', color: '#f59e0b', marginTop: '1px' }}>Marqueur : {it.scorer === 'HOME' ? it.homeTeam : it.awayTeam}</div>}
        </div>
      ))}
    </div>
  )

  const valueCol = value.length > 0 && (
    <div style={{ flex: '1 1 100%', background: 'rgba(168,85,247,0.07)', border: '1px solid rgba(168,85,247,0.25)', borderRadius: '10px', padding: '10px 14px' }}>
      <div style={{ fontSize: '11px', fontWeight: '900', color: '#c084fc', letterSpacing: '0.4px', marginBottom: '6px' }}>
        💎 VALEUR (modèle vs marché BTTS/1X2) — la cote ne reflète pas les occasions réelles
      </div>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {value.slice(0, 5).map((it, i) => (
          <div key={i} style={{
            flex: '1 1 260px', background: 'rgba(0,0,0,0.25)', border: `1px solid ${it.vtype === 'OVER_VALUE' ? '#22c55e' : '#0ea5e9'}55`,
            borderRadius: '8px', padding: '7px 10px',
          }}>
            <div style={{ fontSize: '11px', fontWeight: '800', color: '#f1f5f9', lineHeight: '1.2' }}>{it.label}</div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '3px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{
                fontWeight: '900', fontSize: '10px', padding: '1px 6px', borderRadius: '4px',
                color: it.vtype === 'OVER_VALUE' ? '#22c55e' : '#0ea5e9',
                background: it.vtype === 'OVER_VALUE' ? 'rgba(34,197,94,0.15)' : 'rgba(14,165,233,0.15)',
              }}>
                {it.ou}
              </span>
              <span style={{ color: '#c084fc', fontWeight: '800', fontSize: '10px' }}>
                EDGE +{it.edge} but
              </span>
              <span style={{ color: '#64748b', fontSize: '10px' }}>
                force {it.strength}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ fontSize: '12px', fontWeight: '900', color: '#818cf8', letterSpacing: '0.5px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        🎯 MODULE COMBO — OVER / UNDER EN DIRECT
        <span style={{ fontSize: '9px', color: '#475569', fontWeight: '400' }}>(SEUIL 40% — LEAN + SUREST)</span>
      </div>
      {valueCol}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '10px' }}>
        {tier('▲ OVER 2.5', '#22c55e', over, 0.40)}
        {tier('▼ UNDER 2.5', '#0ea5e9', under, 0.40)}
        {watch.length > 0 && tier('⚡ À SURVEILLER', '#f59e0b', watch, 0.30)}
      </div>
    </div>
  )
}

function LiveCard({ event, prevOdds }) {
  const isLive = event.status === 'live' || event.statusType === 'inprogress' || event.statusType === 'pause'
  const minute = event.minute || event.liveMinute || null
  const odds = event.odds || {}
  const pred = event.pred || {}
  const homeScore = event.scoreHome ?? event.homeScore ?? 0
  const awayScore = event.scoreAway ?? event.awayScore ?? 0

  const movement = prevOdds
    ? {
        home: (odds.home != null && prevOdds.home != null) ? (odds.home - prevOdds.home) : null,
        draw: (odds.draw != null && prevOdds.draw != null) ? (odds.draw - prevOdds.draw) : null,
        away: (odds.away != null && prevOdds.away != null) ? (odds.away - prevOdds.away) : null,
      }
    : null

  const Arrow = ({ delta }) => {
    if (delta == null || Math.abs(delta) < 0.01) return null
    if (delta < 0) return <span style={{ color: '#22c55e', fontSize: '9px', marginLeft: '2px' }}>▼</span>
    return <span style={{ color: '#ef4444', fontSize: '9px', marginLeft: '2px' }}>▲</span>
  }

  const oddsCell = (val, label) => {
    const hasOdds = val != null
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{
          fontSize: '15px', fontWeight: '800',
          color: hasOdds ? '#f1f5f9' : '#334155',
          letterSpacing: '-0.3px',
        }}>
          {hasOdds ? val.toFixed(2) : '--'}
        </div>
        <div style={{ fontSize: '9px', color: '#475569' }}>{label}</div>
      </div>
    )
  }

  const homeOdds = odds.home_win || odds.home
  const drawOdds = odds.draw
  const awayOdds = odds.away_win || odds.away
  const over25 = odds.over_25 || odds.over25
  const under25 = odds.under_25 || odds.under25
  const bttsYes = odds.btts_yes
  const bttsNo = odds.btts_no

  return (
    <div style={{
      background: isLive ? 'rgba(239,68,68,0.07)' : 'rgba(30,41,59,0.55)',
      border: `1px solid ${isLive ? 'rgba(239,68,68,0.28)' : '#1e293b'}`,
      borderRadius: '10px',
      padding: '14px 16px',
      marginBottom: '10px',
      position: 'relative',
    }}>
      {isLive && (
        <div style={{
          position: 'absolute', top: '8px', right: '10px',
          display: 'flex', alignItems: 'center', gap: '4px',
        }}>
          <div style={{
            width: '6px', height: '6px', borderRadius: '50%',
            background: '#ef4444', animation: 'onyx-pulse-dot 1.5s infinite',
          }} />
          <span style={{ fontSize: '9px', fontWeight: '800', color: '#ef4444' }}>
            LIVE {minute || ''}
          </span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '8px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '11px', fontWeight: '700', color: '#94a3b8', marginBottom: '2px' }}>
            {event.tournament || event.category || 'Unknown'}
          </div>
          <div style={{ fontSize: '13px', fontWeight: '800', color: '#f1f5f9', lineHeight: '1.3' }}>
            {event.homeTeam || 'Home'}
            <span style={{ color: '#334155', fontWeight: '400', margin: '0 6px' }}>vs</span>
            {event.awayTeam || 'Away'}
          </div>
        </div>

        <div style={{
          fontSize: '18px', fontWeight: '900', color: '#fbbf24',
          letterSpacing: '0.5px', lineHeight: '1',
        }}>
          {homeScore} - {awayScore}
        </div>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
        gap: '6px', padding: '10px 8px',
        background: 'rgba(0,0,0,0.2)', borderRadius: '8px',
      }}>
        {oddsCell(homeOdds, '1')}
        {oddsCell(drawOdds, 'X')}
        {oddsCell(awayOdds, '2')}
      </div>

      <div style={{
        display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap',
      }}>
        {bttsYes != null && (
          <div style={{
            flex: '1 1 100%', fontSize: '9px',
            background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.18)',
            padding: '5px 8px', borderRadius: '6px',
          }}>
            <div style={{ color: '#34d399', fontWeight: '800', marginBottom: '2px', letterSpacing: '0.3px' }}>
              BOTH TEAMS TO SCORE (BTTS)
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <span style={{ color: '#10b981', fontWeight: '700' }}>
                OUI {bttsYes.toFixed(2)}
              </span>
              <span style={{ color: '#64748b' }}>NON {bttsNo != null ? bttsNo.toFixed(2) : '--'}</span>
            </div>
          </div>
        )}
        {(over25 != null || under25 != null) && (
          <span style={{
            fontSize: '9px', color: '#818cf8', background: 'rgba(99,102,241,0.08)',
            padding: '2px 6px', borderRadius: '4px',
          }}>
            O/U 2.5: {over25 != null ? over25.toFixed(2) : '--'} / {under25 != null ? under25.toFixed(2) : '--'}
          </span>
        )}
        {pred.ou_pick && (
          <div style={{
            flex: '1 1 100%', fontSize: '9px',
            background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.18)',
            padding: '6px 8px', borderRadius: '6px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
              <span style={{ color: '#818cf8', fontWeight: '800', letterSpacing: '0.3px' }}>
                TOTAL BUTS 2.5 (LIVE)
                <span style={{
                  fontSize: '8px', fontWeight: '800', marginLeft: '5px', padding: '1px 5px', borderRadius: '4px',
                  color: pred.xgsrc === 'live' ? '#22c55e' : '#64748b',
                  background: pred.xgsrc === 'live' ? 'rgba(34,197,94,0.15)' : 'rgba(100,116,139,0.15)',
                  border: pred.xgsrc === 'live' ? '1px solid rgba(34,197,94,0.3)' : '1px solid rgba(100,116,139,0.3)',
                }}>
                  {pred.xgsrc === 'live' ? 'xG LIVE' : 'MODÈLE'}
                </span>
              </span>
              <span style={{ color: '#a5b4fc', fontWeight: '800' }}>
                {pred.ou_pick}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <span style={{ color: '#22c55e', fontWeight: '700' }}>
                OVER {pred.over25}%{pred.ou_fair_odds_over != null && pred.ou_fair_odds_over < 30 ? ` ⇢ @${pred.ou_fair_odds_over}` : ''}
              </span>
              <span style={{ color: '#64748b' }}>
                UNDER {pred.under25}%
              </span>
              <span style={{ color: '#94a3b8', marginLeft: 'auto' }}>
                xG total <span style={{ color: '#c4b5fd', fontWeight: '700' }}>{pred.total_xg_live}</span>
              </span>
            </div>
            {pred.xg_home_actual != null && (
              <div style={{ display: 'flex', gap: '10px', marginTop: '3px', flexWrap: 'wrap' }}>
                <span style={{ color: '#64748b' }}>
                  xG réel <span style={{ color: '#a5b4fc', fontWeight: '700' }}>{pred.xg_home_actual} — {pred.xg_away_actual}</span>
                </span>
                {pred.possession_home != null && (
                  <span style={{ color: '#64748b' }}>
                    Poss <span style={{ color: '#a5b4fc', fontWeight: '700' }}>{pred.possession_home}%</span>
                  </span>
                )}
                {pred.shots_home != null && (
                  <span style={{ color: '#64748b' }}>
                    Tirs <span style={{ color: '#a5b4fc', fontWeight: '700' }}>{pred.shots_home}-{pred.shots_away}</span>
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {pred.score_team && (
          <div style={{
            flex: '1 1 100%', fontSize: '9px',
            background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.18)',
            padding: '6px 8px', borderRadius: '6px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
              <span style={{ color: '#fbbf24', fontWeight: '800', letterSpacing: '0.3px' }}>
                ⚽ PROCHAIN BUTEUR — QUI VA MARQUER
              </span>
              <span style={{ color: '#f59e0b', fontWeight: '800' }}>
                Score prédit {pred.pred_score}
              </span>
            </div>
            {pred.next_scorer ? (
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <span style={{
                    padding: '2px 8px', borderRadius: '5px', fontWeight: '800', fontSize: '10px',
                    background: pred.next_scorer.team === 'HOME' ? 'rgba(34,197,94,0.2)' : 'rgba(59,130,246,0.2)',
                    color: pred.next_scorer.team === 'HOME' ? '#4ade80' : '#60a5fa',
                  }}>
                    {pred.next_scorer.team === 'HOME' ? event.homeTeam : event.awayTeam}
                  </span>
                  <span style={{ color: '#fbbf24', fontWeight: '800' }}>
                    {pred.next_scorer.confidence}%
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <span style={{ color: '#4ade80', fontWeight: '700' }}>
                    H {Math.round(pred.next_scorer.prob_home * 100)}%
                  </span>
                  <span style={{ color: '#64748b' }}>|</span>
                  <span style={{ color: '#60a5fa', fontWeight: '700' }}>
                    A {Math.round(pred.next_scorer.prob_away * 100)}%
                  </span>
                </div>
                <span style={{ color: '#94a3b8', fontSize: '8px', marginLeft: 'auto' }}>
                  {pred.next_scorer.description}
                </span>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <span style={{ color: '#fde68a', fontWeight: '700' }}>
                  {event.homeTeam} xG {pred.home_xg_live}
                </span>
                <span style={{ color: '#fde68a', fontWeight: '700' }}>
                  {event.awayTeam} xG {pred.away_xg_live}
                </span>
                <span style={{
                  color: '#0ea5e9', fontWeight: '800', marginLeft: 'auto',
                  background: 'rgba(14,165,233,0.12)', padding: '1px 6px', borderRadius: '4px',
                }}>
                  Marqueur: {pred.score_team[2] === 'HOME' ? event.homeTeam : event.awayTeam}
                </span>
              </div>
            )}
          </div>
        )}
        {pred.home_xg_live != null && pred.away_xg_live != null && (
          <div style={{
            flex: '1 1 100%', fontSize: '9px',
            background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)',
            padding: '6px 8px', borderRadius: '6px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
              <span style={{ color: '#34d399', fontWeight: '800', letterSpacing: '0.3px' }}>
                TOTAL BUTS PAR EQUIPE
              </span>
              <span style={{ color: '#10b981', fontWeight: '700' }}>
                Total predit: {pred.total_xg_live}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ color: '#4ade80', fontWeight: '900', fontSize: '14px' }}>
                  {pred.home_xg_live}
                </div>
                <div style={{ color: '#94a3b8', fontSize: '8px' }}>{event.homeTeam}</div>
              </div>
              <span style={{ color: '#475569', fontSize: '11px', fontWeight: '700' }}>-</span>
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ color: '#60a5fa', fontWeight: '900', fontSize: '14px' }}>
                  {pred.away_xg_live}
                </div>
                <div style={{ color: '#94a3b8', fontSize: '8px' }}>{event.awayTeam}</div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ color: '#fbbf24', fontWeight: '800', fontSize: '11px' }}>
                  {pred.pred_score}
                </div>
                <div style={{ color: '#475569', fontSize: '7px' }}>Score MT</div>
              </div>
            </div>
          </div>
        )}
        {odds.over25 != null && (
          <span style={{
            fontSize: '9px', color: '#818cf8', background: 'rgba(99,102,241,0.08)',
            padding: '2px 6px', borderRadius: '4px',
          }}>
            O/U 2.5: {odds.over25.toFixed(2)} / {odds.under25.toFixed(2)}
          </span>
        )}
        {odds.dc_12 != null && (
          <span style={{
            fontSize: '9px', color: '#f59e0b', background: 'rgba(245,158,11,0.08)',
            padding: '2px 6px', borderRadius: '4px',
          }}>
            DC 1X/12/X2: {odds.dc_12.toFixed(2)} / {odds.dc_1x?.toFixed ? `1X ${odds.dc_1x.toFixed(2)}` : ''} {odds.dc_x2?.toFixed ? `X2 ${odds.dc_x2.toFixed(2)}` : ''}
          </span>
        )}
      </div>
    </div>
  )
}

export default function FlashOddsView() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastFetch, setLastFetch] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [liveEnabled, setLiveEnabledState] = useState(true)
  const [toggling, setToggling] = useState(false)
  const prevOddsRef = useRef({})

  // Charger l'état persistant du toggle live au montage
  useEffect(() => {
    let cancelled = false
    fetchLiveToggleState().then((enabled) => {
      if (!cancelled) setLiveEnabledState(enabled)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggleLive = async () => {
    const next = !liveEnabled
    setToggling(true)
    try {
      const res = await postLiveToggle(next)
      if (res.success) {
        setLiveEnabledState(res.enabled)
        if (res.enabled) loadEvents()
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setToggling(false)
    }
  }

  const loadEvents = useCallback(async () => {
    setRefreshing(true)
    try {
      const live = await fetchFlashOdds()
      setEvents(live)
      setError(null)
      setLastFetch(new Date())
      prevOddsRef.current = {}
      setTimeout(() => {
        const snap = {}
        live.forEach((e) => {
          if (e.odds && (e.odds.home != null || e.odds.away != null)) snap[e.id] = e.odds
        })
        prevOddsRef.current = snap
      }, 2000)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])
  useEffect(() => {
    if (!liveEnabled) return
    loadEvents()
    const interval = setInterval(loadEvents, 15000)
    return () => clearInterval(interval)
  }, [loadEvents, liveEnabled])

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 20px', color: '#64748b' }}>
        <div style={{ fontSize: '40px', marginBottom: '16px', animation: 'onyx-pulse-dot 1.5s infinite' }}>⚡</div>
        <div style={{ fontSize: '13px', fontWeight: '700', color: '#818cf8' }}>
          Scan des matchs en direct...
        </div>
        <div style={{ fontSize: '11px', marginTop: '8px', color: '#475569' }}>
          Connexion à Sofascore API
        </div>
      </div>
    )
  }

  if (error && events.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px', color: '#64748b' }}>
        <div style={{ fontSize: '36px', marginBottom: '12px' }}>⚠️</div>
        <div style={{ fontSize: '13px', fontWeight: '700', color: '#ef4444', marginBottom: '8px' }}>
          Erreur de connexion Sofascore
        </div>
        <div style={{ fontSize: '11px', color: '#475569', marginBottom: '16px' }}>
          {error}
        </div>
        <button
          onClick={loadEvents}
          style={{
            padding: '8px 20px',
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: '8px', color: '#ef4444',
            fontSize: '11px', fontWeight: '700', cursor: 'pointer',
          }}
        >
          🔄 Réessayer
        </button>
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 18px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px',
        background: events.length > 0 ? 'rgba(99,102,241,0.08)' : 'rgba(30,41,59,0.4)',
        border: `1px solid ${events.length > 0 ? 'rgba(99,102,241,0.2)' : '#1e293b'}`,
        borderRadius: '10px',
        marginBottom: '14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {events.length > 0 ? (
            <div style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: '#ef4444', animation: 'onyx-pulse-dot 1.5s infinite',
            }} />
          ) : (
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#475569' }} />
          )}
          <span style={{
            fontSize: '12px', fontWeight: '900',
            color: events.length > 0 ? '#818cf8' : '#475569',
            letterSpacing: '0.5px',
          }}>
            {events.length > 0
              ? `FLASH ODDS — ${events.length} MATCH${events.length > 1 ? 'S' : ''} EN DIRECT`
              : 'FLASH ODDS — AUCUN MATCH EN DIRECT'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            onClick={handleToggleLive}
            disabled={toggling}
            title={liveEnabled ? 'Désactiver le scraping live' : 'Activer le scraping live'}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '4px 10px',
              background: liveEnabled ? 'rgba(34,197,94,0.12)' : 'rgba(100,116,139,0.12)',
              border: `1px solid ${liveEnabled ? 'rgba(34,197,94,0.35)' : 'rgba(100,116,139,0.3)'}`,
              borderRadius: '999px',
              color: liveEnabled ? '#22c55e' : '#94a3b8',
              fontSize: '10px', fontWeight: '800', cursor: 'pointer',
              letterSpacing: '0.4px', textTransform: 'uppercase',
              transition: 'all 0.2s',
            }}
          >
            <span style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: liveEnabled ? '#22c55e' : '#64748b',
              boxShadow: liveEnabled ? '0 0 6px rgba(34,197,94,0.8)' : 'none',
            }} />
            {toggling ? '...' : liveEnabled ? 'LIVE ON' : 'LIVE OFF'}
          </button>
          {lastFetch && (
            <span style={{ fontSize: '9px', color: '#475569' }}>
              {lastFetch.toLocaleTimeString()}
            </span>
          )}
          <span style={{ fontSize: '9px', color: '#475569' }}>Auto 15s</span>
          <button
            onClick={loadEvents}
            disabled={!liveEnabled}
            style={{
              padding: '4px 10px',
              background: refreshing ? 'rgba(99,102,241,0.2)' : 'rgba(99,102,241,0.1)',
              border: '1px solid rgba(99,102,241,0.3)',
              borderRadius: '6px', color: liveEnabled ? '#818cf8' : '#475569',
              fontSize: '10px', fontWeight: '700', cursor: liveEnabled ? 'pointer' : 'not-allowed',
            }}
          >
            {refreshing ? '⏳...' : '🔄 Refresh'}
          </button>
        </div>
      </div>

      {!liveEnabled && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '8px 14px', marginBottom: '12px',
          background: 'rgba(100,116,139,0.08)',
          border: '1px solid rgba(100,116,139,0.25)',
          borderRadius: '8px',
        }}>
          <span style={{ fontSize: '10px', color: '#94a3b8', fontWeight: '700' }}>💤</span>
          <span style={{ fontSize: '10px', color: '#94a3b8', fontWeight: '700' }}>
            SCRAPING LIVE DÉSACTIVÉ — les données affichées proviennent du cache (aucun appel réseau).
          </span>
          <span
            onClick={handleToggleLive}
            style={{
              marginLeft: 'auto', fontSize: '10px', fontWeight: '800', color: '#22c55e',
              cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.4px',
            }}
          >
            Activer
          </span>
        </div>
      )}

      {events.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '60px 20px',
          background: 'rgba(30,41,59,0.3)',
          border: '1px solid #1e293b', borderRadius: '12px',
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🌙</div>
          <div style={{ fontSize: '13px', fontWeight: '800', color: '#64748b', marginBottom: '8px' }}>
            Aucun match en direct
          </div>
          <div style={{ fontSize: '11px', color: '#334155' }}>
            Pas de matchs en cours sur Sofascore.<br />
            Essaie à nouveau dans quelques minutes.
          </div>
        </div>
      ) : (
        <>
          <div style={{
            display: 'flex', gap: '8px', alignItems: 'center', padding: '6px 0', marginBottom: '4px',
          }}>
            <span style={{ fontSize: '10px', color: '#ef4444', fontWeight: '700' }}>
              ⚽ LIVE SCORES + COTES
            </span>
            <span style={{ fontSize: '9px', color: '#475569' }}>
              ▲▼ indique le mouvement des cotes
            </span>
          </div>
          <ComboPicks events={events} />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '12px',
          }}>
            {events.map((e) => (
              <LiveCard
                key={e.id}
                event={e}
                prevOdds={prevOddsRef.current[e.id]}
              />
            ))}
          </div>
        </>
      )}

      <div style={{
        marginTop: '16px', padding: '8px 14px',
        background: 'rgba(30,41,59,0.3)',
        border: '1px solid #1e293b', borderRadius: '8px',
        fontSize: '10px', color: '#334155', textAlign: 'center',
      }}>
        ⚡ Sofascore via bypass Python (curl_cffi) — cotes temps réel — auto-refresh 15s
      </div>

      <CalibrationPanel />
    </div>
  )
}

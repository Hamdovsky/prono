/**
 * Time Filter Utility — bornes de dates locales pour le filtre temporel
 * (AUJOURD'HUI / DEMAIN / 3 JOURS / 7 JOURS).
 *
 * Module pur (pas de JSX, pas d'effet de bord) afin d'être testable en
 * unité avec des dates figées : `tzOffsetMinutes` permet de geler le
 * fuseau en test. En production il est omis et vaut le fuseau local du
 * navigateur (les matchs sont alors affichés en jours locaux du user).
 */

import { isFinishedMatch } from './matchAnalysis'

const DAY_MS = 24 * 60 * 60 * 1000

// Fenêtre calendar-days pour chaque bouton :
// AUJOURD'HUI → jour J+0 ; DEMAIN → jour J+1 ;
// 3 JOURS / 7 JOURS → N jours calendaires INCLUANT aujourd'hui (J+0..J+N-1).
const WINDOWS = {
  Today: { startOffset: 0, endOffset: 0 },
  Tomorrow: { startOffset: 1, endOffset: 1 },
  'Next 3 Days': { startOffset: 0, endOffset: 2 },
  'Next 7 Days': { startOffset: 0, endOffset: 6 },
}

// shift en ms à ajouter à un instant UTC pour obtenir l'heure locale.
// new Date().getTimezoneOffset() = minutes d'écart (UTC - local) ; ex.
// -60 pour UTC+1 (= local = UTC + 1h).
export function getTzShiftMs(nowMs, tzOffsetMinutes) {
  return tzOffsetMinutes === undefined
    ? -new Date(nowMs).getTimezoneOffset() * 60000
    : -tzOffsetMinutes * 60000
}

export function getLocalDayStart(offsetDays, nowMs, tzOffsetMinutes) {
  const shift = getTzShiftMs(nowMs, tzOffsetMinutes)
  const start = Math.floor((nowMs + shift) / DAY_MS) * DAY_MS - shift
  return start + offsetDays * DAY_MS
}

export function getLocalDayEnd(offsetDays, nowMs, tzOffsetMinutes) {
  return getLocalDayStart(offsetDays, nowMs, tzOffsetMinutes) + DAY_MS - 1
}

export function getDateWindow(activeDate, nowMs, tzOffsetMinutes) {
  const w = WINDOWS[activeDate]
  if (!w) return null
  return {
    start: getLocalDayStart(w.startOffset, nowMs, tzOffsetMinutes),
    end: getLocalDayEnd(w.endOffset, nowMs, tzOffsetMinutes),
  }
}

export function extractMatchMs(m) {
  if (!m) return null
  let dateMs = null
  if (
    m.startTimestamp !== undefined &&
    m.startTimestamp !== null &&
    m.startTimestamp !== 0
  ) {
    const raw = m.startTimestamp
    if (typeof raw === 'string' && raw.includes('T')) {
      dateMs = new Date(raw).getTime()
    } else {
      const n = Number(raw)
      dateMs = Number.isFinite(n) ? (n > 1e11 ? n : n * 1000) : null
    }
  } else if (m.timestamp) {
    dateMs = new Date(m.timestamp).getTime()
  } else if (m.startTime) {
    dateMs = new Date(m.startTime).getTime()
  } else if (m.date) {
    dateMs = new Date(m.date).getTime()
  }
  if (dateMs === null || Number.isNaN(dateMs)) return null
  return dateMs
}

export function filterMatchesInWindow(matches, activeDate, nowMs, tzOffsetMinutes) {
  const win = getDateWindow(activeDate, nowMs, tzOffsetMinutes)
  if (!win) return Array.isArray(matches) ? matches.slice() : []
  return (Array.isArray(matches) ? matches : []).filter((m) => {
    let ms = extractMatchMs(m)
    // Un match sans timestamp fiable est traité comme "maintenant"
    // (comportement historique du Sidebar conservé → visible en Today).
    if (ms === null) ms = nowMs
    return ms >= win.start && ms <= win.end
  })
}

// Éligibilité "liste" : un match est compté/listé s'il est dans le futur et
// encore jouable. Logique partagée entre le compteur du Sidebar/header et la
// liste du Dashboard afin qu'ils affichent TOUJOURS le même nombre
// (source de vérité unique).
export function isMatchEligible(m, nowMs = Date.now()) {
  if (!m) return false
  const s = String(m.status || '').toLowerCase()
  if (['postponed', 'canceled'].includes(s)) return false
  const ms = extractMatchMs(m)
  if (ms !== null && ms <= nowMs) return false
  return !isFinishedMatch(m)
}
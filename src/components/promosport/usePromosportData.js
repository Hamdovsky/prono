// Hook données du module Promosport (extrait de Promosport.jsx, split 2026-09-07).
// Porte tout l'état local, les fetchs et les handlers ; les vues sont des composants
// de rendu purs. Code déplacé verbatim (sauf renderBox/applyAlgo/totalDoubles,
// variables mortes sans référence).
import { useState, useEffect, useCallback } from 'react'
import dataService from '../../services/dataService'
import { generateAutoSystem, generateReduced7Doubles } from '../../utils/promosportUtils'

export default function usePromosportData() {
  const [loading, setLoading] = useState(true)
  const [loadingStep, setLoadingStep] = useState(0)
  const [viewMode, setViewMode] = useState('grid')
  const [tunisieData, setTunisieData] = useState(null)
  const [tunisieGrid, setTunisieGrid] = useState(876)
  const [tunisieLoading, setTunisieLoading] = useState(false)
  const [tunisieError, setTunisieError] = useState(null)
  const [algoPicks, setAlgoPicks] = useState(null)
  const [reducedSystem, setReducedSystem] = useState(null)
  const [accuracyStats, setAccuracyStats] = useState(null)
  const [meta, setMeta] = useState({
    concours: '---',
    date: '--/--/----',
    grid_names: ['EDGE OPTIMIZED', 'ANTI-CROWD', 'HIGH VALUE', 'SECURE BANKER'],
    gridStats: null,
  })

  const [antiCorr, setAntiCorr] = useState(null)

  const [matches, setMatches] = useState([])
  const [doubleCounts, setDoubleCounts] = useState([6, 6, 6, 6])
  const [showCoverage, setShowCoverage] = useState(false)

  const loadingMessages = [
    'Scraping des données Promosport',
    'Analyse des matchs par IA Titanium',
    'Calcul des probabilités historiques',
    'Détection des pièges foule tunisienne',
    'Génération des grilles T1-T4',
    'Optimisation des doubles stratégiques',
  ]

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      setLoadingStep(0)
      const stepInterval = setInterval(() => {
        setLoadingStep((s) => Math.min(s + 1, loadingMessages.length - 1))
      }, 4000)
      try {
        console.log('📡 [PROMOSPORT] Initializing data fetch...')
        const [data, accData] = await Promise.all([
          dataService.fetchPromosport(doubleCounts),
          dataService.fetchPromosportAccuracy(),
        ])
        if (data && data.matches && data.matches.length > 0) {
          setMatches(data.matches)
          setMeta((prev) => ({
            ...prev,
            concours: data.concours || '855',
            date: data.date || new Date().toLocaleDateString(),
            gridStats: data.gridStats || prev.gridStats,
          }))
          setAntiCorr(data.antiCorr || null)
          console.log('✅ [PROMOSPORT] Data loaded successfully:', data.matches.length, 'matches')
        }
        if (accData && accData.success && accData.stats) {
          setAccuracyStats(accData.stats)
        }
      } catch (err) {
        console.error('❌ [PROMOSPORT] Failed to load data:', err.message)
      } finally {
        clearInterval(stepInterval)
        setLoading(false)
      }
    }
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doubleCounts])

  const fetchTunisie = async (gridNo) => {
    setTunisieLoading(true)
    setTunisieError(null)
    setTunisieData(null)
    try {
      const data = await dataService.fetchPromosportTunisie(gridNo)
      if (data && data.success) {
        setTunisieData(data)
      } else {
        setTunisieError('Aucune donnée trouvée pour cette grille')
      }
    } catch (err) {
      setTunisieError(err.message || 'Erreur de chargement')
      console.error('❌ [PROMOSPORT] Tunisie fetch error:', err.message)
    } finally {
      setTunisieLoading(false)
    }
  }

  const calcEntropy = (h, x, a) => {
    const ph = (h || 1) / 100,
      px = (x || 1) / 100,
      pa = (a || 1) / 100
    return -(ph * Math.log2(ph + 0.001) + px * Math.log2(px + 0.001) + pa * Math.log2(pa + 0.001))
  }

  const computeAlgoPicks = (matches) => {
    const picks = matches.map((m) => {
      const hp = m.mlProbs?.h ?? m.probs?.h ?? 33
      const xp = m.mlProbs?.x ?? m.probs?.x ?? 33
      const ap = m.mlProbs?.a ?? m.probs?.a ?? 34

      const entries = [
        ['1', hp],
        ['X', xp],
        ['2', ap],
      ]
      const sorted = [...entries].sort((a, b) => b[1] - a[1])
      const [fav, favPct] = sorted[0]
      const [sec, secPct] = sorted[1] || ['X', 0]
      const margin = favPct - secPct
      const entropy = calcEntropy(hp, xp, ap)

      if (favPct >= 55 && margin >= 15) {
        return { ...m, algo: { pick: fav, type: 'simple', conf: Math.round(favPct), entropy } }
      }
      if (favPct >= 48 && margin >= 8) {
        return {
          ...m,
          algo: { pick: fav, type: 'simple', conf: Math.round(favPct * 0.9), entropy },
        }
      }
      // Uncertain → double (top 2 outcomes)
      const doublePick = [fav, sec]
        .sort((a, b) => ['1', 'X', '2'].indexOf(a) - ['1', 'X', '2'].indexOf(b))
        .join('')
      return {
        ...m,
        algo: {
          pick: doublePick,
          type: 'double',
          conf: Math.round((favPct + secPct) * 0.85),
          entropy,
        },
      }
    })

    const simples = picks.filter((p) => p.algo.type === 'simple').length
    const doubles = picks.filter((p) => p.algo.type === 'double').length
    const avgConf =
      picks.length > 0 ? Math.round(picks.reduce((s, p) => s + p.algo.conf, 0) / picks.length) : 0
    const expectedCorrect = picks.reduce((s, p) => s + p.algo.conf / 100, 0)
    return {
      picks,
      simples,
      doubles,
      skipped: 0,
      avgConf,
      expectedCorrect: Math.round(expectedCorrect * 100) / 100,
    }
  }

  const handleGenerateColonnes = () => {
    const src = algoPicks || (tunisieData?.matches ? computeAlgoPicks(tunisieData.matches) : null)
    let picksArray
    if (src) {
      picksArray = src.picks
    } else if (matches.length > 0) {
      picksArray = matches.map((m) => {
        const hp = m.mlProbs?.h ?? m.probs?.h ?? 33
        const xp = m.mlProbs?.x ?? m.probs?.x ?? 33
        const ap = m.mlProbs?.a ?? m.probs?.a ?? 34
        const entries = [
          ['1', hp],
          ['X', xp],
          ['2', ap],
        ].sort((a, b) => b[1] - a[1])
        const [fav, favPct] = entries[0]
        const [sec, secPct] = entries[1]
        const margin = favPct - secPct
        const entropy = calcEntropy(hp, xp, ap)
        if (favPct >= 55 && margin >= 15) {
          return { ...m, algo: { pick: fav, type: 'simple', conf: Math.round(favPct), entropy } }
        }
        const doublePick = [fav, sec]
          .sort((a, b) => ['1', 'X', '2'].indexOf(a) - ['1', 'X', '2'].indexOf(b))
          .join('')
        return {
          ...m,
          algo: {
            pick: doublePick,
            type: 'double',
            conf: Math.round((favPct + secPct) * 0.85),
            entropy,
          },
        }
      })
    } else return

    // Limit doubles: pick up to 7 most uncertain matches as doubles, rest as singles
    const doubleCandidates = picksArray
      .filter((p) => p.algo.type === 'double')
      .sort((a, b) => b.algo.entropy - a.algo.entropy)
    const maxDoubles = 7
    const doubleIds = new Set(
      doubleCandidates.slice(0, maxDoubles).map((p) => p.idx ?? p.id ?? p.matchId)
    )
    const basePicks = picksArray.map((m) => {
      const id = m.idx ?? m.id ?? m.matchId
      if (doubleIds.has(id)) return m.algo.pick
      return m.algo.pick.length > 1 ? m.algo.pick[0] : m.algo.pick
    })

    const system = generateAutoSystem(basePicks, 100)
    const confMap = {}
    let totalConf = 0
    picksArray.forEach((m) => {
      const id = m.idx ?? m.id ?? m.matchId
      confMap[id] = m.algo.conf / 100
      totalConf += m.algo.conf / 100
    })
    const avgColConf = picksArray.length > 0 ? (totalConf / picksArray.length) * 13 : 0

    // Calculate per-column score and sort by score descending
    const sortedColumns = system.columns
      .map((col, ci) => {
        let score = 0
        col.forEach((pick, mi) => {
          const m = picksArray[mi]
          const id = m.idx ?? m.id ?? m.matchId
          const baseConf = confMap[id] || 0.5
          score += baseConf
        })
        return { picks: col, score, index: ci }
      })
      .sort((a, b) => b.score - a.score)

    setReducedSystem({
      ...system,
      columns: system.columns,
      basePicks,
      sortedColumns,
      expectedCorrect: Math.round(avgColConf * 10) / 10,
      confMap,
      source: src ? 'TITANIUM ML HYBRID' : 'MODULE',
    })
    setViewMode('colonnes')
  }

  const handleGenerateReduced = (type = 'N-1') => {
    setTimeout(() => {
      const basePicks = matches.map((m) => {
        const hp = m.mlProbs?.h ?? m.probs?.h ?? 33
        const xp = m.mlProbs?.x ?? m.probs?.x ?? 33
        const ap = m.mlProbs?.a ?? m.probs?.a ?? 34
        if (hp > 55) return '1'
        if (ap > 55) return '2'
        if (xp > 40) return 'X'
        return '1X'
      })
      const reducedCols = generateReduced7Doubles(basePicks)
      setViewMode('module')
      alert(`Système ${type} généré avec succès (16 colonnes).`)
    }, 1500)
  }

  const [goldCoupon, setGoldCoupon] = useState(null)
  const handleGenerateGoldCoupon = async () => {
    try {
      const data = await dataService.fetchPromosportGoldCoupon()
      if (data && data.success && data.coupon) {
        setGoldCoupon(data.coupon)
        setViewMode('gold')
      } else {
        alert('Impossible de générer le Gold Coupon')
      }
    } catch (e) {
      alert('Erreur: ' + e.message)
    }
  }

  const avgConfidence =
    matches.length > 0
      ? (matches.reduce((sum, m) => sum + (m.intel?.sharp || 60), 0) / matches.length).toFixed(1)
      : '94.7'

  const totalColonnes = doubleCounts.reduce((s, d) => s + Math.pow(2, d), 0)
  const coutEstime = (totalColonnes * 0.5).toFixed(0)

  const [isExporting, setIsExporting] = useState(false)

  const exportAsImage = useCallback(async () => {
    setIsExporting(true)
    try {
      const html2canvas = (await import('html2canvas')).default
      const container = document.querySelector('.promosport-container')
      const canvas = await html2canvas(container, {
        scale: 2,
        backgroundColor: '#0f172a',
        useCORS: true,
        logging: false,
        windowWidth: container.scrollWidth,
        windowHeight: container.scrollHeight,
      })
      const link = document.createElement('a')
      link.download = `promosport_titanium_${meta.concours}.jpg`
      link.href = canvas.toDataURL('image/jpeg', 0.95)
      link.click()
    } catch (e) {
      console.error('Export failed:', e)
    } finally {
      setIsExporting(false)
    }
  }, [meta.concours])

  return {
    loading,
    loadingStep,
    loadingMessages,
    viewMode,
    setViewMode,
    tunisieData,
    tunisieGrid,
    setTunisieGrid,
    tunisieLoading,
    tunisieError,
    algoPicks,
    reducedSystem,
    accuracyStats,
    meta,
    antiCorr,
    matches,
    doubleCounts,
    setDoubleCounts,
    showCoverage,
    setShowCoverage,
    goldCoupon,
    isExporting,
    fetchTunisie,
    handleGenerateColonnes,
    handleGenerateReduced,
    handleGenerateGoldCoupon,
    exportAsImage,
    avgConfidence,
    totalColonnes,
    coutEstime,
  }
}

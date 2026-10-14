import React from 'react'
import './MatchCard.css'
import { DISABLE_BTTS_DISPLAY, DISABLE_CORNERS_DISPLAY } from '../utils/displayPolicy'
import { marketBannerFromLines, parseBetText, highlightText } from '../utils/matchAnalysis'
import { TABLE_COLUMNS, groupStarts } from '../utils/tableColumns'

const MARKET_TITLES = {
  ou: '🎯 OVER/UNDER',
  win: '🎯 GAGNANT 1X2',
  btts: '🎯 BTTS',
  ht: '🎯 1ER MT',
  corners: '🎯 CORNERS',
  combo: '🎯 COMBO GG+O2.5',
}

const isGolden = (chipKey, dominant) => dominant && dominant.chip === chipKey

  const domLabelToChip = (label) => {
  if (!label || label === '--') return null
  const m = label.match(/^(OVER|UNDER)\s+([\d.]+)\s+(\d+)%$/)
  if (!m) return null
  const dir = m[1] === 'OVER' ? 'O' : 'U'
  return `${dir}${m[2]} ${m[3]}%`
}

const domLineFromLabel = (label) => {
  if (!label || label === '--') return null
  const m = label.match(/^(OVER|UNDER)\s+([\d.]+)\s+(\d+)%$/)
  if (!m) return null
  return { dir: m[1].toLowerCase(), line: parseFloat(m[2]) }
}

const goldenChip = (chipKey, dominant) => isGolden(chipKey, dominant)
  ? {
      animation: 'goldenPulse 2s ease-in-out infinite',
      border: '1px solid #ffd700',
      boxShadow: '0 0 10px rgba(255,215,0,0.4)',
    }
  : { opacity: 0.35 }

const goldenCell = (cellKey, dominant) => isGolden(cellKey, dominant)
  ? {
      animation: 'goldenPulse 2s ease-in-out infinite',
      border: '1px solid #ffd700',
      boxShadow: '0 0 10px rgba(255,215,0,0.3)',
    }
  : { opacity: 0.35 }

const solidGoldenStyle = (isSolid) => isSolid
  ? {
      animation: 'goldenPulse 2s ease-in-out infinite',
      background: 'linear-gradient(135deg, rgba(255,215,0,0.12) 0%, rgba(10,15,30,0.9) 100%)',
      border: '1px solid #ffd700',
      boxShadow: 'inset 0 0 20px rgba(255,215,0,0.08)',
    }
  : {}

const MatchCard = ({ rawData, style, onClick, timeLabel, compact, reliability, isLive, liveMinute, liveScore, liveStats, goalPrediction, activeMarket, contextualInfo, divergenceInfo, active = false, favoriteOn = false, onToggleFavorite, cols = null, alt = false, match = null, searchQuery = '' }) => {
  // E62 : colonnes réellement visibles (responsive). `cols=null` => toutes
  // (rétro-compatible). Sert au rendu conditionnel + aux séparateurs de groupe.
  const show = (key) => !cols || cols.includes(key)
  const visibleColumns = cols
    ? TABLE_COLUMNS.filter((c) => cols.includes(c.key))
    : TABLE_COLUMNS
  const groupStart = groupStarts(visibleColumns)
  const gs = (key) => (groupStart.has(key) ? ' mc-group-start' : '')

  // E64 : hero/dim selon l'onglet marché actif + cotes bookmaker par marché.
  const heroKey = activeMarket && activeMarket !== 'ALL' ? activeMarket : null
  const isHero = (k) => heroKey === k
  const DIM_KEYS = ['btts', 'ou', 'win', 'ht', 'corners', 'combo', 'htft', 'ah', 'tts']
  const isDim = (k) => !!heroKey && heroKey !== k && DIM_KEYS.includes(k)
  const odds = match
    ? {
        home: parseFloat(match.odds_home) || 0,
        draw: parseFloat(match.odds_draw) || 0,
        away: parseFloat(match.odds_away) || 0,
        over25: parseFloat(match.odds_over25) || 0,
        under25: parseFloat(match.odds_under25) || 0,
        btts_yes: parseFloat(match.odds_btts_yes) || 0,
        btts_no: parseFloat(match.odds_btts_no) || 0,
      }
    : null
  const parseRow = (lines) => {
    if (!lines || lines.length < 8) return null
    const domChip = lines[13] || null
    const domPayloadRaw = lines[14] || ''
    let domLabel = '--', domPct = '--', domOdds = '--', domScore = '--'
    if (domPayloadRaw && domPayloadRaw !== '--') {
      const parts = domPayloadRaw.split('|')
      if (parts.length >= 4) {
        domLabel = parts[0]
        domPct = parts[1]
        domOdds = parts[2]
        domScore = parts[3]
      }
    }
    const parseInfoCell = (raw) => {
      if (!raw || raw === '--') return null
      const parts = String(raw).split('|')
      if (parts.length < 3) return null
      return { label: parts[0] || '--', pct: parts[1] || '--', odds: parts[2] || '--' }
    }
    return {
      league: lines[0],
      home: lines[1],
      away: lines[2],
      btts: lines[3],
      ou: lines[4],
      winner: lines[5],
      htGoal: lines[6],
      corners: lines[7],
      score: lines[8] && lines[8] !== '--' ? lines[8] : null,
      solid: lines[9] === '1',
      winnerDc: lines[10],
      ouLines: lines[11],
      cornersExact: lines[12],
      domChip,
      domLabel,
      domPct,
      domOdds,
      domScore,
      htft: parseInfoCell(lines[15]),
      ah: parseInfoCell(lines[16]),
      teamToScore: parseInfoCell(lines[17]),
      htFirstHalf: parseInfoCell(lines[18]),
      bttsAndWin: parseInfoCell(lines[19]),
      bttsAndOu: parseInfoCell(lines[20]),
      combo: lines[21] || null,
    }
  }

  const d = parseRow(rawData)
  if (!d) return null
  // Onglet marché actif : la bannière et la surbrillance suivent CE marché,
  // pas le dominant global (sinon "Over/Under" affiche un pick BTTS/HT).
  const activeBanner =
    activeMarket && activeMarket !== 'ALL' ? marketBannerFromLines(rawData, activeMarket) : null
  const dominant = activeBanner ? { chip: activeMarket } : d.domChip ? { chip: d.domChip } : null

  const shortTeam = (name) => {
    if (!name) return ''
    const parts = name.split(' ')
    if (parts.length <= 2) return name
    return parts.map((w, i) => (i === 0 ? w : w[0] + '.')).join(' ')
  }

  // ── O/U : priorité aux multi-lignes (OULINES "1.5:76|2.5:56|…") ──
  const ouLines = (d.ouLines || '')
    .split('|')
    .map((chunk) => {
      const [lineStr, pctStr] = chunk.split(':')
      const line = parseFloat(lineStr)
      const pct = parseFloat(pctStr)
      if (!Number.isFinite(line) || !Number.isFinite(pct)) return null
      return { line, pct, dir: pct > 50 ? 'over' : 'under' }
    })
    .filter(Boolean)

  const bestOu =
    ouLines.length > 0
      ? ouLines.reduce((best, l) => (!best || l.pct > best.pct ? l : best), null)
      : null

  const ouNumFromCell = parseFloat(d.ou)
  const hasOuCell = Number.isFinite(ouNumFromCell) && ouNumFromCell > 0
  const hasOu = ouLines.length > 0 || hasOuCell || !!bestOu
  const ouDir = hasOu
    ? bestOu
      ? bestOu.dir
      : ouNumFromCell > 50
        ? 'over'
        : 'under'
    : 'under'
  const ouPrec = hasOu
    ? Math.round(bestOu ? bestOu.pct : ouNumFromCell > 50 ? ouNumFromCell : 100 - ouNumFromCell)
    : 0

  // Verdict binaire (OUI/NON)
  const yesNo = (v) => {
    const s = (v || '').trim().toUpperCase()
    if (s.startsWith('OUI')) return 'yes'
    if (s.startsWith('NON')) return 'no'
    return ''
  }
  const bttsVerdict = DISABLE_BTTS_DISPLAY ? '' : yesNo(d.btts)
  const cornersExactLabel = DISABLE_CORNERS_DISPLAY ? null : d.cornersExact

  // Gagnant : extraire le pick (1/X/2 ou 1X/12/X2) avant la proba
  const winPick = (d.winner || '').split(' ')[0].trim().toUpperCase()
  const winProb = (d.winner || '').split(' ').slice(1).join(' ').trim()
  const winnerTeamName = winPick === '1' ? d.home : winPick === '2' ? d.away : winPick === 'X' ? 'Match nul' : null
  const winnerDisplay = winnerTeamName && winProb ? `${winnerTeamName} ${winProb}` : d.winner
  const pickClass =
    winPick === '1'
      ? 'mc-pick-home'
      : winPick === 'X'
        ? 'mc-pick-draw'
        : winPick === '2'
          ? 'mc-pick-away'
          : ['1X', '12', 'X2'].includes(winPick)
            ? 'mc-pick-dc'
            : ''

  const solidClass = d.solid ? ' mc-solid' : ''
  const solidBadge = d.solid ? ' 🎯' : ''

  // E64 : parsing des libellés de pari + cotes bookmaker par marché.
  // E68-ter : cornersLabel doit etre initialise ICI (avant cornersParsed,
  // ligne plus bas) sinon ReferenceError dead zone au rendu de MatchCard.
  const cornersLabel = DISABLE_CORNERS_DISPLAY
    ? '--'
    : cornersExactLabel
      ? `✚ ${cornersExactLabel}`
      : d.corners
  const bttsParsed = DISABLE_BTTS_DISPLAY ? null : parseBetText(d.btts)
  const bttsOddsVal =
    odds && !DISABLE_BTTS_DISPLAY
      ? bttsVerdict === 'yes'
        ? odds.btts_yes
        : bttsVerdict === 'no'
          ? odds.btts_no
          : 0
      : 0
  const winParsed = parseBetText(winnerDisplay)
  const winOddsVal =
    odds && winPick
      ? winPick === '1'
        ? odds.home
        : winPick === 'X'
          ? odds.draw
          : winPick === '2'
            ? odds.away
            : 0
      : 0
  const htParsed = parseBetText(d.htGoal)
  const cornersParsed = parseBetText(cornersLabel)
  const comboParsed = parseBetText(d.combo)
  const comboPct =
    d.combo && d.combo !== '--' ? parseFloat((d.combo.match(/(\d+(?:\.\d+)?)\s*%/) || [])[1]) || 0 : 0

  // E64 : tuile "pari" — pick + % au-dessus, cote en dessous. Surchargée en
  // hero quand l'onglet marché correspond, dimmée sinon. mc-bet déclenche le
  // layout flex-column (cf. MatchCard.css).
  const BetCell = ({ marketKey, baseClass, verdictClass, pick, pct, oddsValue, cellStyle, groupStartCls }) => {
    const hero = isHero(marketKey)
    const dim = isDim(marketKey)
    const cls = `mc-cell mc-bet ${baseClass}${verdictClass ? ` ${verdictClass}` : ''}${groupStartCls || ''}${hero ? ' mc-bet-hero' : ''}${dim ? ' mc-bet-dim' : ''}`
    return (
      <div className={cls} style={cellStyle}>
        {pick != null && (
          <span className="mc-bet-pick">{pct != null ? `${pick} ${pct}%` : pick}</span>
        )}
        {oddsValue > 0 && <span className="mc-bet-odds">@{Number(oddsValue).toFixed(2)}</span>}
      </div>
    )
  }

  // E66 : surlignage de la recherche. Les segments matchés sont enrobés dans
  // <mark className="mc-hl"> ; le reste reste du texte brut. L'ellipsis du
  // conteneur (mc-league-name / mc-team-name) continue de fonctionner car le
  // mark est un enfant inline.
  const Highlight = ({ text, query, className }) => {
    const segs = highlightText(text, query)
    return (
      <span className={className}>
        {segs.map((s, i) =>
          s.match ? (
            <mark key={i} className="mc-hl">
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          )
        )}
      </span>
    )
  }

  // Fiabilité honnête par bracket de confiance (précision réelle du backtest) :
  // n < 20 → insuffisant. Le libellé « réel » distingue la précision MESURÉE
  // de la confiance affichée du pick.
  const relBadge = (() => {
    if (!reliability || !reliability.n) return null
    if (reliability.n < 20)
      return (
        <span className="mc-rel mc-rel-insuf" title="Échantillon trop petit pour être fiable">
          éch. insuffisant
        </span>
      )
    const cls = reliability.pct >= 60 ? 'mc-rel-good' : 'mc-rel-low'
    return (
      <span
        className={`mc-rel ${cls}`}
        title={`Précision réelle du bracket de confiance · ${reliability.correct}/${reliability.n} bons`}
      >
        réel ≈{Math.round(reliability.pct)}% ({reliability.n})
      </span>
    )
  })()

  const cac = contextualInfo && contextualInfo.enabled ? contextualInfo : null
  const cacChip = cac ? (
    <span
      className="mc-rel"
      style={{ color: '#34d399', border: '1px solid rgba(52,211,153,0.4)', marginLeft: '6px' }}
      title={`CAC contextuel (Python) — dom. ×${cac.cac_home} · ext. ×${cac.cac_away}`}
    >
      ⚖️ {cac.cac_home}·{cac.cac_away}
    </span>
  ) : null

  const div = divergenceInfo && divergenceInfo.flagged ? divergenceInfo : null
  const divChip = div ? (
    <span
      className="mc-rel"
      style={{ color: '#f87171', border: '1px solid rgba(248,113,113,0.5)', marginLeft: '6px' }}
      title={`Divergence marché : ${div.side} modèle ${div.model_pct}% vs book déviggué ${div.book_pct}% (écart ${div.edge_pp}pp > ${div.max_pp}pp) -> NO BET (E17)`}
    >
      ⚠️ DIV {Math.abs(div.edge_pp).toFixed(0)}pp
    </span>
  ) : null

  const hasDc = d.winnerDc && d.winnerDc !== '--'

  if (compact) {
    return (
      <div className={`match-card mc-compact${solidClass}${active ? ' mc-active' : ''}`} style={{ ...style, ...solidGoldenStyle(d.solid) }} onClick={onClick}>
        <div className="mcc-top">
          <div className="mcc-league">
            <button
              type="button"
              className={`mc-fav${favoriteOn ? ' on' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                if (onToggleFavorite) onToggleFavorite(d.home, d.away)
              }}
              aria-label="Suivre ces équipes"
            >
              {favoriteOn ? '★' : '☆'}
            </button>
            <Highlight text={d.league} query={searchQuery} className="mcc-league-name" />
            {solidBadge}
            {relBadge}
            {cacChip}
            {divChip}
          </div>
          {timeLabel && <div className="mcc-time">{timeLabel}</div>}
        </div>
        <div className="mcc-teams">
          <Highlight text={shortTeam(d.home)} query={searchQuery} className="mcc-team" />
          <span className={`mcc-vs${d.score ? ' has-score' : ''}`}>{d.score ? d.score : 'vs'}</span>
          <Highlight text={shortTeam(d.away)} query={searchQuery} className="mcc-team" />
        </div>
        {d.opta && (
          <div className="mcc-opta" style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 700, whiteSpace: 'nowrap' }}>
            <span style={{ color: '#60a5fa' }}>Opta</span> {d.opta.home}% {d.opta.draw}% {d.opta.away}%
          </div>
        )}
        {activeBanner ? (
          <div className="mcc-dominant-banner">
            {MARKET_TITLES[activeMarket] || '⭐'} {activeBanner.label}
            {activeBanner.odds ? ` @${activeBanner.odds}` : ''}
          </div>
        ) : d.domLabel && d.domLabel !== '--' ? (
          <div className="mcc-dominant-banner">
            ⭐ {d.domLabel}{d.domOdds && d.domOdds !== '--' ? ` @${d.domOdds}` : ''}
          </div>
        ) : null}
        <div className="mcc-chips">
          <span className={`mcc-chip mcc-btts ${DISABLE_BTTS_DISPLAY ? '' : bttsVerdict}`} style={goldenChip('btts', dominant)}>
            BTTS {DISABLE_BTTS_DISPLAY ? '--' : d.btts}
          </span>
          <span className={`mcc-chip mcc-ou ${ouDir}`} style={goldenChip('ou', dominant)}>
            {dominant && dominant.chip === 'ou' && domLabelToChip(d.domLabel)
              ? domLabelToChip(d.domLabel)
              : bestOu
                ? `${bestOu.dir === 'over' ? 'O' : 'U'}${bestOu.line.toFixed(1)} ${bestOu.pct}%`
                : hasOuCell
                  ? `O/U ${ouDir.toUpperCase()} ${ouPrec}%`
                  : 'O/U --'}
          </span>
          <span className={`mcc-chip mcc-win ${pickClass}`} style={goldenChip('win', dominant)}>{winnerDisplay}</span>
          {hasDc && <span className="mcc-chip mcc-dc" style={goldenChip('dc', dominant)}>DC {d.winnerDc}</span>}
          <span className={`mcc-chip mcc-ht ${yesNo(d.htGoal)}`} style={goldenChip('ht', dominant)}>1er MT {d.htGoal}</span>
          <span className="mcc-chip mcc-corners" style={goldenChip('corners', dominant)}>{cornersLabel}</span>
          {comboPct > 0 && (
            <span
              className={`mcc-chip mcc-combo ${comboPct >= 50 ? 'yes' : 'no'}`}
              style={goldenChip('combo', dominant)}
            >
              {d.combo}
            </span>
          )}
          {d.htft && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>HT/FT {d.htft.label}</span>}
          {d.ah && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>AH {d.ah.label}</span>}
          {d.teamToScore && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>QM {d.teamToScore.label}</span>}
          {d.htFirstHalf && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>HT O/U {d.htFirstHalf.label}</span>}
          {d.bttsAndWin && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>BTTS+WIN {d.bttsAndWin.label}</span>}
          {d.bttsAndOu && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>BTTS+O/U {d.bttsAndOu.label}</span>}
        </div>
      </div>
    )
  }

  const relFactor = reliability && reliability.pct ? reliability.pct / 100 : 1
  const dominantLabel = d.domLabel && d.domLabel !== '--' ? d.domLabel : null
  const dominantPct = d.domPct && d.domPct !== '--' ? d.domPct : null
  const dominantOdds = d.domOdds && d.domOdds !== '--' ? d.domOdds : null
  const dominantScore = d.domScore && d.domScore !== '--' ? d.domScore : null
  const banner =
    activeBanner ||
    (dominantLabel
      ? {
          label: dominantLabel,
          pct: dominantPct && dominantPct !== '--' ? parseFloat(dominantPct) : null,
          odds: dominantOdds,
          score: dominantScore,
          dominant: true,
        }
      : null)
  const displayScore = banner && banner.score != null && banner.score !== '--' ? String(Math.round(parseFloat(banner.score) * relFactor * 100)) : null

  return (
    <div className={`match-card mc-grid${solidClass}${active ? ' mc-active' : ''}${alt ? ' mc-alt' : ''}`} style={{ ...style, ...solidGoldenStyle(d.solid) }} onClick={onClick}>
      <div className="mc-col-info">
        {isLive && (
          <div className="mc-live-banner">
          <span className="mc-live-minute">🔴 {liveMinute}'</span>
          {liveStats?.possession && (
            <>
              <span className="mc-live-sep">|</span>
              <span className="mc-live-stat">POS <span className="mc-live-stat-val">{liveStats.possession}</span></span>
            </>
          )}
          {liveStats?.corners && (
            <>
              <span className="mc-live-sep">|</span>
              <span className="mc-live-stat">CK <span className="mc-live-stat-val">{liveStats.corners}</span></span>
            </>
          )}
          {liveStats?.shotsOnTarget && (
            <>
              <span className="mc-live-sep">|</span>
              <span className="mc-live-stat">S/T <span className="mc-live-stat-val">{liveStats.shotsOnTarget}</span></span>
            </>
          )}
          {liveStats?.xg && (
            <>
              <span className="mc-live-sep">|</span>
              <span className="mc-live-stat">xG <span className="mc-live-stat-val">{liveStats.xg}</span></span>
            </>
          )}
          {goalPrediction?.next5min > 0 && (
            <>
              <span className="mc-live-sep">|</span>
              <span className="mc-live-stat">PROCH <span className="mc-live-stat-val">{goalPrediction.next5min}'</span></span>
            </>
          )}
        </div>
      )}
      <div className="mc-match-info">
        <div className="mc-league">
          <Highlight text={d.league} query={searchQuery} className="mc-league-name" />
          {solidBadge}
          {relBadge}
          {cacChip}
          {divChip}
        </div>
        <div className="mc-teams">
          <Highlight text={shortTeam(d.home)} query={searchQuery} className="mc-team-name" />
          <span className={`mc-vs${isLive ? ' mc-live-score' : ''}`}>
            {liveScore ? liveScore : d.score ? d.score : 'vs'}
          </span>
          <Highlight text={shortTeam(d.away)} query={searchQuery} className="mc-team-name" />
        </div>
        {isLive && liveMinute ? (
          <div className="mc-time" style={{ color: '#ef4444', fontWeight: 900 }}>🔴 {liveMinute}'</div>
        ) : timeLabel ? (
          <div className="mc-time">{timeLabel}</div>
        ) : null}
        {d.opta && (
          <div className="mc-opta" style={{ display: 'flex', gap: '4px', marginTop: '4px', fontSize: '10px', color: '#94a3b8', fontWeight: 700, letterSpacing: '0.3px', whiteSpace: 'nowrap' }}>
            <span style={{ color: '#60a5fa' }}>Opta</span>
            <span>{d.opta.home}%</span>
            <span style={{ color: '#94a3b8' }}>{d.opta.draw}%</span>
            <span>{d.opta.away}%</span>
          </div>
        )}
        </div>
      </div>

      {/* Colonne TOP ⭐ (E20) : largeur fixe, ellipsis — le détail (score,
          marché actif, cote) passe en tooltip pour ne plus casser l'alignement. */}
      <div className={`mc-cell mc-top${gs('top')}`}>
        <button
          type="button"
          className={`mc-fav${favoriteOn ? ' on' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            if (onToggleFavorite) onToggleFavorite(d.home, d.away)
          }}
          title={favoriteOn ? 'Ne plus suivre ces équipes' : 'Suivre ces équipes (Mes équipes)'}
          aria-label="Suivre ces équipes"
        >
          {favoriteOn ? '★' : '☆'}
        </button>
        {banner ? (
          <div
            className="mc-top-in"
            title={`${activeBanner ? MARKET_TITLES[activeMarket] || 'PICK DU MARCHÉ' : 'MEILLEUR PRONOSTIC'} — ${banner.label}${banner.odds && banner.odds !== '--' ? ` @${banner.odds}` : ''}${displayScore != null ? ` · Score ${displayScore}` : ''}`}
          >
            <span className="mc-top-star">⭐</span>
            <span className="mc-dominant-pick">{banner.label}</span>
            {banner.pct != null && banner.pct > 0 && (
              <span className="mc-dominant-pct">{Math.round(banner.pct)}%</span>
            )}
            {banner.odds && banner.odds !== '--' && (
              <span className="mc-dominant-odds">@{banner.odds}</span>
            )}
          </div>
        ) : null}
      </div>

      {show('btts') && (
        <BetCell
          marketKey="btts"
          baseClass="mc-btts"
          verdictClass={DISABLE_BTTS_DISPLAY ? '' : bttsVerdict}
          pick={DISABLE_BTTS_DISPLAY ? null : bttsParsed ? bttsParsed.pick : null}
          pct={DISABLE_BTTS_DISPLAY ? null : (bttsParsed ? bttsParsed.pct : null)}
          oddsValue={bttsOddsVal}
          cellStyle={goldenCell('btts', dominant)}
          groupStartCls={gs('btts')}
        />
      )}

      {show('ou') && (
      <div className={`mc-cell mc-ou-cell${gs('ou')}${isHero('ou') ? ' mc-bet-hero' : ''}${isDim('ou') ? ' mc-bet-dim' : ''}`} style={goldenCell('ou', dominant)}>
        {ouLines.length > 0 ? (
          <div className="mc-ou-lines">
            {ouLines.map((l) => {
              const dominantLine =
                dominant && dominant.chip === 'ou'
                  ? domLineFromLabel(activeBanner ? activeBanner.label : d.domLabel)
                  : null
              const isDom = dominantLine && dominantLine.dir === l.dir && dominantLine.line === l.line
              return (
                <span key={l.line} className={`mc-ou-line ${l.dir}${isDom ? ' dominant' : ''}`}>
                  {l.dir === 'over' ? 'O' : 'U'}
                  {l.line.toFixed(1)} {l.pct}%
                </span>
              )
            })}
          </div>
        ) : hasOuCell ? (
          <>
            <div className="mc-ou-bar">
              <div className={`mc-ou-fill ${ouDir}`} style={{ width: `${Math.min(100, ouPrec)}%` }} />
            </div>
            <span className={`mc-ou-label ${ouDir}`}>{ouDir.toUpperCase()}</span>
            <span className={`mc-ou-pct ${ouDir}`}>{ouPrec}%</span>
          </>
        ) : (
          <span className="mc-ou-na">--</span>
        )}
      </div>
      )}

      {show('win') && (
        <BetCell
          marketKey="win"
          baseClass="mc-winner"
          verdictClass={pickClass}
          pick={winParsed ? winParsed.pick : winnerDisplay}
          pct={winParsed ? winParsed.pct : null}
          oddsValue={winOddsVal}
          cellStyle={goldenCell('win', dominant)}
          groupStartCls={gs('win')}
        />
      )}

      {show('ht') && (
        <BetCell
          marketKey="ht"
          baseClass="mc-ht"
          verdictClass={yesNo(d.htGoal)}
          pick={htParsed ? htParsed.pick : d.htGoal}
          pct={htParsed ? htParsed.pct : null}
          oddsValue={0}
          cellStyle={goldenCell('ht', dominant)}
          groupStartCls={gs('ht')}
        />
      )}

      {show('corners') && (
        <BetCell
          marketKey="corners"
          baseClass="mc-corners"
          verdictClass=""
          pick={cornersParsed ? cornersParsed.pick : cornersLabel}
          pct={cornersParsed ? cornersParsed.pct : null}
          oddsValue={0}
          cellStyle={goldenCell('corners', dominant)}
          groupStartCls={gs('corners')}
        />
      )}

      {show('combo') && (
        <BetCell
          marketKey="combo"
          baseClass="mc-combo"
          verdictClass=""
          pick={comboParsed ? comboParsed.pick : '--'}
          pct={comboParsed ? comboParsed.pct : null}
          oddsValue={0}
          cellStyle={goldenCell('combo', dominant)}
          groupStartCls={gs('combo')}
        />
      )}

      {show('htft') && (
      <div className={`mc-cell mc-info-cell mc-info-htft${gs('htft')}`} style={{opacity:0.45}}>
        {d.htft ? `${d.htft.label} ${d.htft.pct}%` : '--'}
      </div>
      )}

      {show('ah') && (
      <div className={`mc-cell mc-info-cell mc-info-ah${gs('ah')}`} style={{opacity:0.45}}>
        {d.ah ? `${d.ah.label}${d.ah.odds !== '--' ? ` @${d.ah.odds}` : ''}` : '--'}
      </div>
      )}

      {show('tts') && (
      <div className={`mc-cell mc-info-cell mc-info-tts${gs('tts')}`} style={{opacity:0.45}}>
        {d.teamToScore ? `${d.teamToScore.label} ${d.teamToScore.pct}%` : '--'}
      </div>
      )}
    </div>
  )
}

// 🧠 [PERF] Mémoïsé : avec rawData (liste stable via WeakMap) et onClick (stable),
// une rangée ne se re-rend que si son contenu change réellement.
export default React.memo(MatchCard)

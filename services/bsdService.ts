import axios, { AxiosResponse } from 'axios'
import database from '../core/database'
import logger from '../core/logger'
import enrichedPredictions from '../core/enriched_predictions'
import { createQuotaManager } from './sourceQuotaManager'
interface QuotaManager {
  isEnabled(): boolean
  getQuotaStatus(): {
    date: string
    used: number
    limit: number
    remaining: number
    isActive: boolean
  }
  registerMatch(id: string | number): Promise<number>
}

interface LeagueCache {
  [id: number]: string
}

interface OddsResult {
  home: number | null
  draw: number | null
  away: number | null
}

interface BSDEvent {
  id?: string | number
  match_id?: string | number
  event_date?: string
  date?: string
  start_timestamp?: number
  date_unix?: number
  home_team?: { name?: string; id?: string | number } | string
  away_team?: { name?: string; id?: string | number } | string
  homeTeam?: string
  awayTeam?: string
  home_name?: string
  away_name?: string
  home_team_id?: string | number
  away_team_id?: string | number
  league?: { name?: string; country?: string; id?: number }
  league_id?: number
  league_name?: string
  tournament_name?: string
  tournament?: { name?: string }
  tournament_id?: string | number
  competition?: string
  competition_name?: string
  country?: string
  status?: string | { type: string; [key: string]: unknown }
  odds?: { home_win?: number; draw?: number; away_win?: number }
  odds_home?: number
  odds_draw?: number
  odds_away?: number
  xg?: { home?: number; away?: number }
  home_xg?: number
  away_xg?: number
  results?: BSDEvent[]
}

interface BSDLeagueResult {
  id: number
  name?: string
}

interface BSDResponse {
  results?: BSDEvent[]
  odds?: { home_win?: number; draw?: number; away_win?: number }
  name?: string
}

class BsdService {
  private apiKey: string
  private baseUrl: string
  private enabled: boolean
  private quota: QuotaManager
  private _quotaExhausted: boolean = false
  private _authFailed: boolean = false
  private _leagueCache: LeagueCache | null = null

  constructor() {
    this.apiKey = process.env.BSD_API_KEY || ''
    this.baseUrl = process.env.BSD_BASE_URL || 'https://sports.bzzoiro.com/api'
    this.enabled = process.env.BSD_ENABLED !== 'false'
    this.quota = createQuotaManager('bsd')

    if (!this.apiKey || this.apiKey === 'CHANGER_MOI_BSD_API_KEY') {
      logger.warn('🚨 [BSD] BSD_API_KEY manquant ou non configuré dans .env / Render Environment')
      logger.warn('   → Allez sur Render Dashboard → Environment → ajoutez BSD_API_KEY')
    } else if (!this.enabled) {
      logger.warn('[BSD] Service désactivé (BSD_ENABLED=false)')
    } else {
      logger.info(
        `✅ [BSD] Service prêt — clé: ${this.apiKey.substring(0, 6)}... | URL: ${this.baseUrl}`
      )
      if (!process.env.LOCAL_DATA_URL) this._loadLeagues()
    }
  }

  private async _loadLeagues(): Promise<void> {
    try {
      const data = (await this._fetch('/v2/leagues/?sport=football&limit=200')) as {
        results?: BSDLeagueResult[]
      } | null
      if (data?.results?.length) {
        this._leagueCache = {}
        for (const league of data.results) {
          if (league.id && league.name) {
            this._leagueCache[league.id] = league.name
          }
        }
        logger.info(
          `✅ [BSD] League cache loaded: ${Object.keys(this._leagueCache).length} leagues`
        )
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn(`⚠️ [BSD] Failed to load leagues: ${msg}`)
    }
  }

  private async _fetchLeagueName(leagueId: number): Promise<string | null> {
    if (!leagueId) return null
    if (this._leagueCache && this._leagueCache[leagueId]) return this._leagueCache[leagueId]
    try {
      const data = (await this._fetch(`/v2/leagues/${leagueId}/`)) as { name?: string } | null
      if (data?.name) {
        if (!this._leagueCache) this._leagueCache = {}
        this._leagueCache[leagueId] = data.name
        return data.name
      }
    } catch (_) {}
    return null
  }

  private _resolveLeagueName(leagueId: number | undefined | null): string | null {
    if (this._leagueCache && leagueId && this._leagueCache[leagueId]) {
      return this._leagueCache[leagueId]
    }
    return null
  }

  isAvailable(): boolean {
    if (!this.enabled) return false
    if (!this.apiKey || this.apiKey === 'CHANGER_MOI_BSD_API_KEY') return false
    if (this._authFailed) return false
    if (this._quotaExhausted) return false
    return true
  }

  private _headers(): Record<string, string> {
    return {
      Authorization: `Token ${this.apiKey}`,
      Accept: 'application/json',
    }
  }

  private async _fetch(endpoint: string): Promise<unknown> {
    if (!this.enabled || !this.apiKey || this.apiKey === 'CHANGER_MOI_BSD_API_KEY') {
      logger.warn('🚨 [BSD] Appel ignoré — BSD_API_KEY absent ou invalide')
      return null
    }
    if (this._authFailed) {
      logger.warn(
        '🔴 [BSD] Appel ignoré — Clé API invalide (401). Vérifiez BSD_API_KEY sur Render.'
      )
      return null
    }
    if (this._quotaExhausted) {
      logger.warn('🟡 [BSD] Quota épuisé — appel ignoré pour cette session')
      return null
    }

    try {
      logger.info(`[BSD] GET ${endpoint}`)
      const { data } = await axios.get(`${this.baseUrl}${endpoint}`, {
        headers: this._headers(),
        timeout: 15000,
      })
      return data
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string }
      const status = axiosErr.response?.status
      const body = JSON.stringify(axiosErr.response?.data || {}).substring(0, 200)

      if (status === 401) {
        this._authFailed = true
        logger.error(`🔴 [BSD] ERREUR 401 — Clé API invalide ou expirée !`)
        logger.error(`   → Vérifiez BSD_API_KEY dans Render Dashboard → Environment`)
        logger.error(`   → Réponse serveur: ${body}`)
      } else if (status === 403) {
        logger.error(`🔴 [BSD] ERREUR 403 — Accès refusé (clé sans permission ou compte suspendu)`)
        logger.error(`   → Vérifiez votre abonnement Bzzoiro Sports Data`)
      } else if (status === 429) {
        this._quotaExhausted = true
        logger.warn(
          `🟡 [BSD] ERREUR 429 — Quota API épuisé. Réessai reporté à la prochaine session.`
        )
      } else if (!axiosErr.response) {
        logger.error(`🔆 [BSD] ERREUR Réseau (${endpoint}): ${axiosErr.message}`)
        logger.error(`   → Vérifiez que BSD_BASE_URL est correct: ${this.baseUrl}`)
      } else {
        logger.error(`❌ [BSD] Erreur ${status} sur (${endpoint}): ${axiosErr.message}`)
        logger.error(`   Body: ${body}`)
      }
      return null
    }
  }

  async fetchEvents(dateStr: string): Promise<BSDEvent[]> {
    const data = (await this._fetch(
      `/v2/events/?date_from=${dateStr}&date_to=${dateStr}&limit=200`
    )) as { results?: BSDEvent[] } | null
    return data?.results || []
  }

  async fetchPredictions(matchId: string | number): Promise<unknown> {
    return await this._fetch(`/v2/events/${matchId}/prediction/`)
  }

  async fetchOdds(
    matchId: string | number
  ): Promise<{ odds?: { home_win?: number; draw?: number; away_win?: number } } | null> {
    return (await this._fetch(`/v2/events/${matchId}/odds/`)) as {
      odds?: { home_win?: number; draw?: number; away_win?: number }
    } | null
  }

  async fetchUpcomingEvents(): Promise<BSDEvent[]> {
    const data = (await this._fetch('/v2/events/?limit=200')) as { results?: BSDEvent[] } | null
    return data?.results || []
  }

  async fetchLiveEvents(): Promise<BSDEvent[]> {
    const data = (await this._fetch('/v2/events/?status=inprogress&limit=50')) as {
      results?: BSDEvent[]
    } | null
    return data?.results || []
  }

  private _parseTimestamp(event: BSDEvent): number {
    const raw = event.start_timestamp || event.date_unix || event.event_date || event.date
    if (raw == null) return Math.floor(Date.now() / 1000)
    if (typeof raw === 'number') {
      return raw > 1e11 ? Math.floor(raw / 1000) : raw
    }
    const ms = new Date(raw).getTime()
    if (Number.isNaN(ms)) return Math.floor(Date.now() / 1000)
    return Math.floor(ms / 1000)
  }

  private _mapEventToMatch(event: BSDEvent): Record<string, unknown> {
    const ts = this._parseTimestamp(event)

    const resolveName = (v: unknown): string | null =>
      (typeof v === 'string' ? v : (v as { name?: string })?.name) || null
    const homeTeam = resolveName(event.home_team) || event.homeTeam || event.home_name || 'Home'
    const awayTeam = resolveName(event.away_team) || event.awayTeam || event.away_name || 'Away'
    const leagueName =
      this._resolveLeagueName(event.league_id) ||
      resolveName(event.league) ||
      event.league_name ||
      event.tournament_name ||
      event.tournament?.name ||
      event.competition ||
      event.competition_name ||
      'Unknown'
    const category = (event.league && event.league.country) || event.country || ''
    const matchId =
      event.id || event.match_id || `bsd_${ts}_${Math.random().toString(36).substring(2, 8)}`

    let status = 'scheduled'
    const rawEventStatus = event.status
    if (typeof rawEventStatus === 'string') {
      status =
        {
          notstarted: 'NOT_STARTED',
          inprogress: 'live',
          finished: 'finished',
          canceled: 'canceled',
          postponed: 'POSTPONED',
          abandoned: 'abandoned',
        }[rawEventStatus.toLowerCase()] || 'scheduled'
    } else if (
      rawEventStatus &&
      typeof rawEventStatus === 'object' &&
      (rawEventStatus as { type?: string }).type
    ) {
      status =
        {
          notstarted: 'NOT_STARTED',
          inprogress: 'live',
          finished: 'finished',
          canceled: 'canceled',
          postponed: 'POSTPONED',
          abandoned: 'abandoned',
        }[(rawEventStatus as { type: string }).type.toLowerCase()] || 'scheduled'
    }

    return {
      id: `bsd_${matchId}`,
      homeTeam,
      awayTeam,
      league: leagueName,
      category_name: category,
      tournament_name: leagueName,
      tournament_id: event.league_id || event.tournament_id || null,
      home_team_id: (event.home_team as { id?: number })?.id || event.home_team_id || null,
      away_team_id: (event.away_team as { id?: number })?.id || event.away_team_id || null,
      startTimestamp: ts,
      timestamp: new Date(ts * 1000).toISOString(),
      status,
      confidence: 50,
      prediction: null,
      verdict: 'PENDING',
      odds_home: event.odds?.home_win || event.odds_home || null,
      odds_draw: event.odds?.draw || event.odds_draw || null,
      odds_away: event.odds?.away_win || event.odds_away || null,
      home_xg: event.xg?.home || event.home_xg || null,
      away_xg: event.xg?.away || event.away_xg || null,
      last_updated: Date.now(),
      insufficient_data: event.odds?.home_win || event.odds_home ? 0 : 1,
      source: 'bsd',
      fullData: JSON.stringify({
        id: matchId,
        homeTeam,
        awayTeam,
        league: leagueName,
        startTimestamp: ts,
        status,
        bsd_league_id: event.league_id || null,
      }),
    }
  }

  async syncFixtures(dateStr: string): Promise<number> {
    if (!this.isAvailable()) return 0
    const events = await this.fetchEvents(dateStr)
    if (!events || events.length === 0) {
      logger.info(`[BSD] No events for ${dateStr}`)
      return 0
    }
    logger.info(`[BSD] ${events.length} events found for ${dateStr}`)
    let count = 0
    for (const event of events) {
      try {
        const match = this._mapEventToMatch(event)
        match.bsd_match_id = String(event.id || event.match_id || '')
        try {
          match.homeTeam = await database.resolveTeamName(match.homeTeam as string)
          match.awayTeam = await database.resolveTeamName(match.awayTeam as string)
        } catch (_) {}
        await database.insertMatch(match)
        count++
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[BSD] Error processing event ${event.id}: ${msg}`)
      }
    }
    logger.info(`[BSD] Inserted ${count} matches for ${dateStr}`)
    return count
  }

  async enrichMatchOdds(matchId: string): Promise<OddsResult | null> {
    const oddsData = await this.fetchOdds(matchId.replace(/^bsd_/, ''))
    if (!oddsData) return null
    const bestHome = oddsData?.odds?.home_win || null
    const bestDraw = oddsData?.odds?.draw || null
    const bestAway = oddsData?.odds?.away_win || null
    if (bestHome || bestDraw || bestAway) {
      try {
        const db = (
          database as { db?: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
        ).db
        if (db) {
          db.prepare(
            'UPDATE matches SET odds_home = ?, odds_draw = ?, odds_away = ?, insufficient_data = 0 WHERE id = ?'
          ).run(bestHome, bestDraw, bestAway, matchId)
        }
      } catch (_) {}
    }
    return { home: bestHome, draw: bestDraw, away: bestAway }
  }

  private async _backfillLeagueNames(): Promise<void> {
    const db = (database as Record<string, unknown>).db as
      | {
          prepare: (sql: string) => {
            all: () => Record<string, unknown>[]
            run: (...args: unknown[]) => void
          }
        }
      | undefined
    if (!db) return
    try {
      const unknown = db
        .prepare(
          "SELECT id, fullData FROM matches WHERE source = 'bsd' AND (league = 'Unknown' OR league IS NULL)"
        )
        .all()
      let fixed = 0
      for (const row of unknown) {
        try {
          const fd = JSON.parse((row.fullData as string) || '{}') as { bsd_league_id?: number }
          let leagueName = this._resolveLeagueName(fd.bsd_league_id)
          if (!leagueName && fd.bsd_league_id) {
            leagueName = await this._fetchLeagueName(fd.bsd_league_id)
          }
          if (leagueName) {
            db.prepare('UPDATE matches SET league = ?, tournament_name = ? WHERE id = ?').run(
              leagueName,
              leagueName,
              row.id
            )
            fixed++
          }
        } catch (_) {}
      }
      if (unknown.length > 0)
        logger.info(`[BSD] Backfilled league names for ${fixed}/${unknown.length} matches`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn(`[BSD] Backfill error: ${msg}`)
    }
  }

  async fullSync(): Promise<number> {
    try {
      return await this._fullSyncImpl()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      const stack = e instanceof Error ? e.stack?.slice(0, 200) || '' : ''
      logger.error(`[BSD] fullSync crashed: ${msg} — ${stack}`)
      return 0
    }
  }

  private async _fullSyncImpl(): Promise<number> {
    if (!this.isAvailable()) {
      logger.warn('[BSD] Full sync skipped — service not available')
      return 0
    }
    try {
      const quickCheck = await this._fetch('/v2/events/?limit=1')
      if (!quickCheck) {
        logger.warn('[BSD] Health check failed — marking unavailable')
        return 0
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn(`[BSD] Health check error: ${msg} — marking unavailable`)
      this._authFailed = true
      return 0
    }

    const today = new Date().toISOString().split('T')[0]
    const dates: string[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() + i * 86400000)
      dates.push(d.toISOString().split('T')[0])
    }

    let total = 0
    for (const d of dates) {
      total += await this.syncFixtures(d)
    }

    if (total === 0) {
      logger.info('[BSD] No events found per-date, trying date-less /v2/events/ endpoint...')
      try {
        const allEvents = await this.fetchUpcomingEvents()
        if (allEvents?.length) {
          logger.info(`[BSD] date-less endpoint returned ${allEvents.length} events`)
          for (const event of allEvents) {
            try {
              const match = this._mapEventToMatch(event)
              match.bsd_match_id = String(event.id || event.match_id || '')
              await database.insertMatch(match)
              total++
            } catch (_) {}
          }
          logger.info(`[BSD] Inserted ${total} matches from date-less fallback`)
        } else {
          logger.info('[BSD] date-less endpoint also returned 0 events')
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        logger.warn(`[BSD] date-less fallback error: ${msg}`)
      }
    }

    if (total > 0) {
      const localDb = (database as Record<string, unknown>).db as
        { prepare: (sql: string) => { all: () => { id: string }[] } } | undefined
      if (localDb) {
        try {
          const matches = localDb
            .prepare(
              "SELECT id FROM matches WHERE source = 'bsd' AND (status = 'scheduled' OR status = 'NOT_STARTED')"
            )
            .all()
          if (matches && typeof matches[Symbol.iterator] === 'function') {
            for (const m of matches) {
              try {
                await this.enrichMatchOdds(m.id)
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e)
                logger.warn(`[BSD] Odds update failed for ${m.id}: ${msg}`)
              }
            }
          } else {
            logger.warn(`[BSD] matches is not iterable (type: ${typeof matches})`)
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          logger.error(`[BSD] Enrichment query failed: ${msg}`)
        }
      }
    }

    await this._backfillLeagueNames()

    logger.info(`[BSD] Full sync complete: ${total} matches`)
    return total
  }

  async enrichAllMatchesOdds(): Promise<number> {
    if (!this.isAvailable()) return 0
    const db = (database as Record<string, unknown>).db as
      | {
          prepare: (sql: string) => {
            all: () => { id: string; bsd_match_id: string }[]
            run: (...args: unknown[]) => void
          }
        }
      | undefined
    if (!db) return 0

    const matches = db
      .prepare(
        "SELECT id, bsd_match_id FROM matches WHERE bsd_match_id IS NOT NULL AND bsd_match_id != '' AND (status = 'scheduled' OR status = 'NOT_STARTED')"
      )
      .all()
    logger.info(`[BSD] Enriching ${matches.length} matches with odds...`)
    let count = 0

    for (const m of matches) {
      try {
        const oddsData = await this.fetchOdds(m.bsd_match_id)
        if (!oddsData) continue
        const bsdHome = oddsData?.odds?.home_win || null
        const bsdDraw = oddsData?.odds?.draw || null
        const bsdAway = oddsData?.odds?.away_win || null
        if (bsdHome || bsdDraw || bsdAway) {
          db.prepare(
            'UPDATE matches SET best_odds_home = MAX(COALESCE(best_odds_home, 0), COALESCE(?, 0)), best_odds_draw = MAX(COALESCE(best_odds_draw, 0), COALESCE(?, 0)), best_odds_away = MAX(COALESCE(best_odds_away, 0), COALESCE(?, 0)) WHERE id = ?'
          ).run(bsdHome || 0, bsdDraw || 0, bsdAway || 0, m.id)
          count++
        }
      } catch (_) {}
    }

    logger.info(`[BSD] Enriched ${count}/${matches.length} matches with better odds`)
    return count
  }
}

export = new BsdService()

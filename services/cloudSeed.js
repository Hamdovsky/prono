"use strict";

const _axios = _interopRequireDefault(require("axios"));
const _database = _interopRequireDefault(require("../core/database"));
const _logger = _interopRequireDefault(require("../core/logger"));
const _sourceQuotaManager = require("./sourceQuotaManager");
const _rapidApiQuotaManager = _interopRequireDefault(require("./rapidApiQuotaManager"));
const _therundownService = _interopRequireDefault(require("./therundownService"));
const _oddspapiService = _interopRequireDefault(require("./oddspapiService"));
const _sportmonksService = _interopRequireDefault(require("./sportmonksService"));
const _openligadbService = _interopRequireDefault(require("./openligadbService"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// @ts-nocheck

const bsdService = new Proxy({}, {
  get: (t, p) => p === 'isAvailable' ? () => false : p === 'then' ? undefined : async () => null
});
const apifootballService = new Proxy({}, {
  get: (t, p) => p === 'isAvailable' ? () => false : p === 'then' ? undefined : async () => null
});
const fsmod = require('fs');
const pathmod = require('path');
const fdQuotaManager = (0, _sourceQuotaManager.createQuotaManager)('footballdata');
const TIER1_TOURNAMENT_IDS = new Set([17, 8, 23, 35, 7, 37, 679, 329, 34, 44, 238, 45, 203, 574]);

// Binaire Python résilient : .venv local dev, /opt/venv Render/Docker, sinon PATH.
function pickPythonBin(baseDir) {
  const isWin = process.platform === 'win32';
  const candidates = [pathmod.join(baseDir, '.venv', isWin ? 'Scripts/python.exe' : 'bin/python3'), pathmod.join(baseDir, '.venv', 'bin', 'python'), '/opt/venv/bin/python3',
  // Dockerfile.production
  isWin ? 'python' : 'python3'];
  for (const p of candidates) {
    if (fsmod.existsSync(p)) return p;
  }
  return isWin ? 'python' : 'python3';
}
function getDateStr(offset) {
  const d = new Date();
  d.setDate(d.getDate() + (offset || 0));
  return d.toISOString().split('T')[0];
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
const LIVESCORE_BASE = 'https://prod-public-api.livescore.com/v1/api/app/date/soccer';
const LIVESCORE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.livescore.com',
  Referer: 'https://www.livescore.com/'
};
function randomDelay() {
  return sleep(500 + Math.floor(Math.random() * 1000));
}
function parseEsd(esd) {
  const s = String(esd);
  if (s.length < 14) return Math.floor(Date.now() / 1000);
  const year = s.slice(0, 4);
  const mon = s.slice(4, 6);
  const day = s.slice(6, 8);
  const hour = s.slice(8, 10);
  const min = s.slice(10, 12);
  const sec = s.slice(12, 14);
  return Math.floor(new Date(`${year}-${mon}-${day}T${hour}:${min}:${sec}Z`).getTime() / 1000);
}
function mapLiveScoreEps(eps) {
  if (!eps) return 'scheduled';
  const s = eps.toUpperCase();
  if (s === 'FT' || s === 'AET' || s === 'PEN') return 'finished';
  if (s === 'LIVE' || s === 'IH' || s === 'HT' || s === 'ET') return 'inprogress';
  if (s === 'RESC' || s === 'CANC') return 'canceled';
  if (s === 'POST') return 'postponed';
  if (s === 'ABAN') return 'postponed';
  return 'scheduled';
}
async function fetchLiveScoreEvents(dateStr) {
  const ymd = dateStr.replace(/-/g, '');
  const url = `${LIVESCORE_BASE}/${ymd}/0?MD=1&countryCode=US&locale=en`;
  try {
    const {
      data
    } = await _axios.default.get(url, {
      headers: LIVESCORE_HEADERS,
      timeout: 20000
    });
    return data?.Stages || [];
  } catch (e) {
    _logger.default.warn(`[LIVESCORE] Fetch failed for ${dateStr}: ${e.message}`);
    return [];
  }
}
function mapLiveScoreEventToMatch(event, stage) {
  if (!event?.Eid) return null;
  const homeName = event.T1?.[0]?.Nm || 'Home';
  const awayName = event.T2?.[0]?.Nm || 'Away';
  if (homeName === 'Home' || awayName === 'Away') return null;
  const ts = event.Esd ? parseEsd(event.Esd) : Math.floor(Date.now() / 1000);
  const status = mapLiveScoreEps(event.Eps);
  const league = stage?.Snm || 'Unknown';
  const country = stage?.Cnm || '';
  return {
    id: `livescore_${event.Eid}`,
    homeTeam: homeName,
    awayTeam: awayName,
    league,
    category_name: stage?.CompD || country,
    tournament_name: stage?.CompN || league,
    tournament_id: stage?.CompId ? Number(stage.CompId) : null,
    home_team_id: event.T1?.[0]?.ID ? Number(event.T1[0].ID) : null,
    away_team_id: event.T2?.[0]?.ID ? Number(event.T2[0].ID) : null,
    startTimestamp: ts,
    timestamp: new Date(ts * 1000).toISOString(),
    status,
    confidence: 50,
    prediction: null,
    verdict: 'PENDING',
    odds_home: null,
    odds_draw: null,
    odds_away: null,
    last_updated: Date.now(),
    insufficient_data: 1,
    source: 'livescore',
    fullData: JSON.stringify({
      id: event.Eid,
      homeTeam: homeName,
      awayTeam: awayName,
      league: stage?.CompN || league,
      country,
      startTimestamp: ts,
      status,
      stageName: stage?.Snm,
      round: event.ErnInf,
      homeTeamId: event.T1?.[0]?.ID,
      awayTeamId: event.T2?.[0]?.ID,
      compId: stage?.CompId,
      compName: stage?.CompN,
      homeScore: event.Tr1,
      awayScore: event.Tr2
    })
  };
}
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'sportapi7.p.rapidapi.com';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}/api/v1`;
async function fetchRapidApiEvents(date) {
  if (!RAPIDAPI_KEY || process.env.RAPIDAPI_ENABLED !== 'true') return [];
  try {
    const {
      data
    } = await _axios.default.get(`${RAPIDAPI_BASE}/sport/football/scheduled-events/${date}`, {
      headers: {
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key': RAPIDAPI_KEY,
        Accept: 'application/json'
      },
      timeout: 20000
    });
    return data.events || [];
  } catch (e) {
    return [];
  }
}
function isTier1(event) {
  const tid = event.tournament?.uniqueTournament?.id;
  return tid && TIER1_TOURNAMENT_IDS.has(Number(tid));
}
function mapRapidEventToMatch(event) {
  const ts = event.startTimestamp || Math.floor(Date.now() / 1000);
  const rawStatus = (event.status?.type || '').toLowerCase();
  const status = ['finished', 'canceled', 'postponed', 'inprogress'].includes(rawStatus) ? rawStatus : 'scheduled';
  return {
    id: String(event.id),
    homeTeam: event.homeTeam?.name || 'Home',
    awayTeam: event.awayTeam?.name || 'Away',
    league: event.tournament?.name || 'Unknown',
    category_name: event.tournament?.category?.name || '',
    tournament_name: event.tournament?.name || '',
    tournament_id: event.tournament?.uniqueTournament?.id || null,
    home_team_id: event.homeTeam?.id || null,
    away_team_id: event.awayTeam?.id || null,
    startTimestamp: ts,
    timestamp: new Date(ts * 1000).toISOString(),
    status,
    confidence: 50,
    prediction: null,
    verdict: 'PENDING',
    odds_home: null,
    odds_draw: null,
    odds_away: null,
    last_updated: Date.now(),
    insufficient_data: 1,
    source: 'rapidapi',
    fullData: JSON.stringify({
      id: event.id,
      homeTeam: event.homeTeam?.name,
      awayTeam: event.awayTeam?.name,
      league: event.tournament?.name,
      startTimestamp: ts,
      status
    })
  };
}
const FD_KEY = process.env.FOOTBALLDATA_KEY || '';
const FD_HOST = process.env.FOOTBALLDATA_HOST || 'api.football-data.org';
const FD_IS_FDORG = FD_HOST === 'api.football-data.org';
const FD_BASE = FD_IS_FDORG ? `https://${FD_HOST}/v4` : `https://${FD_HOST}/api/v1`;
async function fetchFDFixtures(endpoint, dateStr) {
  if (!FD_KEY || process.env.FOOTBALLDATA_ENABLED !== 'true') return [];
  try {
    const headers = {
      Accept: 'application/json'
    };
    if (FD_IS_FDORG) {
      headers['X-Auth-Token'] = FD_KEY;
    } else {
      headers['Authorization'] = `Bearer ${FD_KEY}`;
    }
    let url = `${FD_BASE}${endpoint}`;
    if (FD_IS_FDORG && dateStr) {
      url = `${FD_BASE}/matches?dateFrom=${dateStr}&dateTo=${dateStr}`;
    }
    const {
      data
    } = await _axios.default.get(url, {
      headers,
      timeout: 20000
    });
    const root = data?.data || data;
    return root?.matches || root?.fixtures || [];
  } catch (e) {
    return [];
  }
}
function parseTeam(team) {
  if (!team) return 'Home';
  if (typeof team === 'string') return team;
  return team.name || team.team_name || team.slug || 'Home';
}
function parseLeague(league) {
  if (!league) return null;
  if (typeof league === 'string') return league;
  return league.name || league.competition_name || null;
}
function mapFDFixtureToMatch(f) {
  const matchId = f.match_id || f.id || `fd_${Date.now()}_${Math.random()}`;
  const ts = f.date_unix || f.timestamp || (f.utcDate ? Math.floor(new Date(f.utcDate).getTime() / 1000) : Math.floor(Date.now() / 1000));
  const rawStatus = (f.status || '').toLowerCase();
  let status = 'scheduled';
  if (rawStatus === 'complete' || rawStatus === 'ft' || rawStatus === 'finished') status = 'finished';else if (rawStatus === 'live' || rawStatus === 'inprogress' || rawStatus === 'in_play') status = 'inprogress';
  const competition = f.competition || f.league || {};
  const leagueName = parseLeague(competition) || 'Unknown';
  return {
    id: `fd_${matchId}`,
    homeTeam: parseTeam(f.homeTeam || f.home_team),
    awayTeam: parseTeam(f.awayTeam || f.away_team),
    league: leagueName,
    category_name: competition.area?.name || competition.country || '',
    tournament_name: leagueName,
    tournament_id: competition.id || competition.competition_id || null,
    home_team_id: (f.homeTeam || f.home_team)?.id || null,
    away_team_id: (f.awayTeam || f.away_team)?.id || null,
    startTimestamp: ts,
    timestamp: new Date(ts * 1000).toISOString(),
    status,
    confidence: 50,
    prediction: null,
    verdict: 'PENDING',
    odds_home: f.odds?.home_win || null,
    odds_draw: f.odds?.draw || null,
    odds_away: f.odds?.away_win || null,
    last_updated: Date.now(),
    insufficient_data: 1,
    source: 'footballdata',
    fullData: JSON.stringify({
      home: parseTeam(f.homeTeam || f.home_team),
      away: parseTeam(f.awayTeam || f.away_team),
      league: leagueName,
      startTimestamp: ts,
      status
    })
  };
}
async function upsertMatch(match) {
  try {
    const db = _database.default.db;
    if (!db) return false;
    if (['finished', 'canceled', 'postponed'].includes(match.status)) return false;
    const isPG = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres');
    if (isPG) {
      const cols = ['id', '"homeTeam"', '"awayTeam"', 'league', 'category_name', 'tournament_name', 'tournament_id', 'home_team_id', 'away_team_id', '"startTimestamp"', 'timestamp', 'status', 'confidence', 'prediction', 'odds_home', 'odds_draw', 'odds_away', 'last_updated', 'insufficient_data', 'source', '"fullData"'];
      const vals = cols.map((_, i) => `$${i + 1}`).join(', ');
      const params = cols.map(c => match[c] !== undefined ? match[c] : null);
      await db.prepare(`INSERT INTO matches (${cols.join(', ')}) VALUES (${vals}) ON CONFLICT (id) DO NOTHING`).run(params);
      return true;
    }
    const safe = {
      ...match,
      category_name: match.category_name || 'Soccer',
      tournament_name: match.tournament_name || 'Unknown League',
      tournament_id: match.tournament_id || null,
      home_team_id: match.home_team_id || null,
      away_team_id: match.away_team_id || null
    };
    await db.prepare(`
      INSERT OR IGNORE INTO matches (
        id, homeTeam, awayTeam, league, category_name, tournament_name,
        tournament_id, home_team_id, away_team_id,
        startTimestamp, timestamp, status,
        confidence, prediction,
        odds_home, odds_draw, odds_away,
        last_updated, insufficient_data, source, fullData
      ) VALUES (
        @id, @homeTeam, @awayTeam, @league, @category_name, @tournament_name,
        @tournament_id, @home_team_id, @away_team_id,
        @startTimestamp, @timestamp, @status,
        @confidence, @prediction,
        @odds_home, @odds_draw, @odds_away,
        @last_updated, @insufficient_data, @source, @fullData
      )
    `).run(safe);
    return true;
  } catch (e) {
    _logger.default.warn(`[CLOUD-SEED] upsertMatch error (${match.id}):`, e.message);
    return false;
  }
}
async function countMatchesForPeriod(dayOffsetStart, dayOffsetEnd, opts = {}) {
  try {
    const db = _database.default.db;
    const excludeSeed = opts.excludeSeed !== false; // default: exclude seed/emergency from counts
    const startDate = getDateStr(dayOffsetStart);
    const endDate = getDateStr(dayOffsetEnd);
    const startTs = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000);
    const endTs = Math.floor(new Date(endDate + 'T23:59:59Z').getTime() / 1000);
    const sourceFilter = excludeSeed ? ` AND source NOT IN ('seed', 'emergency')` : '';
    const isPG = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres');
    if (isPG) {
      const {
        query: pgQuery
      } = require('../core/pg_connector');
      const result = await pgQuery(`SELECT COUNT(*) as cnt FROM matches WHERE COALESCE("startTimestamp", SUBSTRING("fullData" FROM '"startTimestamp":([0-9]+)')::bigint) >= $1 AND COALESCE("startTimestamp", SUBSTRING("fullData" FROM '"startTimestamp":([0-9]+)')::bigint) <= $2 AND status = 'scheduled'${excludeSeed ? ` AND source NOT IN ('seed', 'emergency')` : ''}`, [startTs, endTs]);
      return parseInt(result.rows?.[0]?.cnt || '0');
    }
    const row = await db.prepare(`SELECT COUNT(*) as cnt FROM matches WHERE startTimestamp >= ? AND startTimestamp <= ? AND status = 'scheduled'${sourceFilter}`).get(startTs, endTs);
    return row?.cnt || 0;
  } catch (e) {
    return 0;
  }
}
async function purgeFakeMatches() {
  const db = _database.default.db;
  if (!db) return 0;
  try {
    let result;
    if (db.pragma) {
      result = db.prepare(`DELETE FROM matches WHERE "homeTeam" IS NULL OR "homeTeam" = '' OR "homeTeam" = 'null' OR league = 'FIFA'`).run();
    } else {
      result = await db.prepare(`DELETE FROM matches WHERE "homeTeam" IS NULL OR "homeTeam" = '' OR "homeTeam" = 'null' OR league = 'FIFA'`).run();
    }
    const removed = result.changes || result.rowCount || 0;
    if (removed > 0) _logger.default.info(`[CLOUD-SEED/PURGE] Removed ${removed} fake/empty/FIFA matches`);
    return removed;
  } catch (e) {
    _logger.default.warn(`[CLOUD-SEED/PURGE] Error: ${e.message}`);
  }
  return 0;
}
async function runCloudSeed() {
  const localDataUrl = process.env.LOCAL_DATA_URL || '';
  const isPG = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres');
  await purgeFakeMatches();

  // Skip if DB already has enough REAL matches (local mode or already seeded)
  if (!isPG && !localDataUrl) {
    try {
      const db = _database.default.db;
      const count = db.prepare('SELECT COUNT(*) as cnt FROM matches WHERE "homeTeam" IS NOT NULL AND "homeTeam" != \'\'').get();
      if (count && count.cnt >= 100) {
        _logger.default.info(`[CLOUD-SEED] DB already has ${count.cnt} real matches — skipping seed`);
        return;
      }
    } catch (e) {
      _logger.default.warn(`[CLOUD-SEED] check existing matches failed: ${e.message}`);
    }
  }
  if (localDataUrl) {
    _logger.default.info('[CLOUD-SEED] LOCAL_DATA_URL detected — using ngrok tunnel as ONLY source. All external APIs SKIPPED.');
    try {
      const {
        data
      } = await _axios.default.get(`${localDataUrl}/api/local/matches`, {
        timeout: 20000
      });
      if (!data?.success || !Array.isArray(data.matches)) {
        _logger.default.warn('[CLOUD-SEED/LOCAL] Invalid response from local server');
        return;
      }
      const matches = data.matches;
      _logger.default.info(`[CLOUD-SEED/LOCAL] ${matches.length} matches fetched from localhost via ngrok`);
      let inserted = 0;
      for (const match of matches) {
        if (await upsertMatch(match)) inserted++;
      }
      _logger.default.info(`[CLOUD-SEED/LOCAL] Inserted ${inserted}/${matches.length} matches`);
    } catch (e) {
      _logger.default.warn(`[CLOUD-SEED/LOCAL] Error: ${e.message}`);
    }
    return;
  }
  _logger.default.info('[CLOUD-SEED] Starting multi-source seeding (LiveScore → FootballData → BSD → TheRundown → OddsPapi → Sportmonks → APIFootball → OpenLigaDB)...');
  const today = getDateStr(0);
  const existingToday = await countMatchesForPeriod(0, 0);
  const existingTomorrow = await countMatchesForPeriod(1, 1);
  _logger.default.info(`[CLOUD-SEED] Existing: ${existingToday} today / ${existingTomorrow} tomorrow`);
  let fdInserted = 0;
  let rapidApiInserted = 0;
  const liveScoreInserted = 0;
  {
    // DÉSACTIVÉ - API LiveScore retourne "error" depuis août 2026
    // Sofascore ne fournit pas d'endpoint pour les fixtures futures (seulement /events/live)
    // Les fixtures sont gérées par FootballData + chain de fallback
    _logger.default.info('[CLOUD-SEED/LIVESCORE] DÉSACTIVÉ - API LiveScore cassée depuis août 2026');
    _logger.default.info('[CLOUD-SEED] Utiliser FootballData + fallback sources pour les fixtures');
  }

  // Sofascore Live - capture les matchs en cours (via sofascore_bypass.py)
  {
    const {
      spawn
    } = require('child_process');
    const BASE_DIR = pathmod.resolve(__dirname, '..');
    const PYTHON = pickPythonBin(BASE_DIR);
    const SCRIPT = pathmod.join(BASE_DIR, 'scripts', 'sofascore_bypass.py');
    try {
      _logger.default.info('[CLOUD-SEED/SOFASCORE] Checking for live matches via Sofascore...');
      const proc = spawn(PYTHON, [SCRIPT, 'live'], {
        cwd: BASE_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', c => {
        stdout += c;
      });
      proc.stderr.on('data', c => {
        stderr += c;
      });
      const liveData = await new Promise(resolve => {
        proc.on('close', code => {
          try {
            const data = JSON.parse(stdout);
            resolve(data);
          } catch {
            resolve({
              found: false,
              events: []
            });
          }
        });
        proc.on('error', () => resolve({
          found: false,
          events: []
        }));
      });
      if (liveData?.found && liveData.events?.length > 0) {
        let sofaInserted = 0;
        for (const ev of liveData.events) {
          const ts = ev.startTimestamp || Math.floor(Date.now() / 1000);
          const match = {
            id: `sofascore_${ev.id}`,
            homeTeam: ev.homeTeam,
            awayTeam: ev.awayTeam,
            league: ev.tournament || 'Unknown',
            category_name: ev.category || '',
            tournament_name: ev.tournament || '',
            tournament_id: null,
            home_team_id: null,
            away_team_id: null,
            startTimestamp: ts,
            timestamp: new Date(ts * 1000).toISOString(),
            status: ev.statusType === 'inprogress' ? 'live' : 'scheduled',
            confidence: 50,
            prediction: null,
            verdict: 'PENDING',
            odds_home: null,
            odds_draw: null,
            odds_away: null,
            last_updated: Date.now(),
            insufficient_data: 1,
            source: 'sofascore',
            fullData: JSON.stringify(ev)
          };
          if (await upsertMatch(match)) {
            sofaInserted++;
          }
        }
        _logger.default.info(`[CLOUD-SEED/SOFASCORE] ${liveData.events.length} live matches found, ${sofaInserted} inserted`);
      }
    } catch (e) {
      _logger.default.warn(`[CLOUD-SEED/SOFASCORE] Live fetch failed: ${e.message}`);
    }
  }
  let fdQuotaStatus = fdQuotaManager.getQuotaStatus();
  if (existingToday < 20 && fdQuotaStatus.isActive && fdQuotaStatus.remaining > 0) {
    const fixtures = await fetchFDFixtures('/fixtures/upcoming', today);
    const filtered = (fixtures || []).filter(f => {
      const d = (f.match_date || f.date || f.utcDate || '').substring(0, 10);
      return d === today || d === getDateStr(1);
    });
    for (const f of filtered) {
      fdQuotaStatus = fdQuotaManager.getQuotaStatus();
      if (fdQuotaStatus.remaining <= 0) break;
      const fdId = f.match_id || f.id;
      if (!fdId || !fdQuotaManager.canProcessMatch(fdId)) continue;
      if (await upsertMatch(mapFDFixtureToMatch(f))) {
        fdQuotaManager.registerMatch(fdId);
        fdInserted++;
      }
    }
    _logger.default.info(`[CLOUD-SEED/FD] Inserted ${fdInserted} primary matches.`);
  }

  // API-Football fixtures - ligues avec stats (~3 req/jour grace au cache)
  {
    const {
      fetchFixtures
    } = require('./apiFootballService');
    const apiFbQuota = (0, _sourceQuotaManager.createQuotaManager)('apifootball');
    try {
      _logger.default.info('[CLOUD-SEED/APIFB] Seeding fixtures from API-Football...');
      const datesToFetch = [today, getDateStr(1), getDateStr(2)];
      let apiFbInserted = 0;
      const matches = await fetchFixtures(datesToFetch);
      for (const match of matches) {
        if (match.status !== 'scheduled') continue;
        if (!apiFbQuota.canProcessMatch(match.id)) continue;
        if (await upsertMatch(match)) {
          apiFbQuota.registerMatch(match.id);
          apiFbInserted++;
        }
      }
      _logger.default.info(`[CLOUD-SEED/APIFB] ${matches.length} matches fetched, ${apiFbInserted} inserted`);
    } catch (e) {
      _logger.default.warn(`[CLOUD-SEED/APIFB] Error: ${e.message}`);
    }
  }
  try {
    if (bsdService.isAvailable()) {
      try {
        const bsdCount = await bsdService.fullSync();
        const enriched = await bsdService.enrichAllMatchesOdds();
        _logger.default.info(`[CLOUD-SEED/BSD] Inserted ${bsdCount} matches, enriched ${enriched}`);
      } catch (bsdErr) {
        _logger.default.warn(`[CLOUD-SEED/BSD] Error: ${bsdErr.message}`);
      }
    }
  } catch (outerErr) {
    _logger.default.warn(`[CLOUD-SEED/BSD] Outer error: ${outerErr.message}`);
  }
  const fbFallbackSources = [{
    name: 'TheRundown',
    fetch: () => _therundownService.default.fetchSoccerEvents(today).then(events => events.map(e => _therundownService.default.mapEventToMatch(e))),
    available: () => _therundownService.default.isAvailable()
  }, {
    name: 'OddsPapi',
    fetch: () => _oddspapiService.default.fetchEvents(today),
    available: () => _oddspapiService.default.isAvailable()
  }, {
    name: 'Sportmonks',
    fetch: () => _sportmonksService.default.fetchEvents(today),
    available: () => _sportmonksService.default.isAvailable()
  }, {
    name: 'APIFootball',
    fetch: () => apifootballService.fetchEvents(today),
    available: () => apifootballService.isAvailable()
  }, {
    name: 'OpenLigaDB',
    fetch: () => _openligadbService.default.fetchEvents(today),
    available: () => _openligadbService.default.isAvailable()
  }];
  const currentCount = await countMatchesForPeriod(0, 0);
  if (currentCount < 20) {
    for (const src of fbFallbackSources) {
      if (!src.available()) continue;
      if ((await countMatchesForPeriod(0, 0)) >= 20) break;
      try {
        const matches = await src.fetch();
        if (!matches?.length) continue;
        let inserted = 0;
        for (const match of matches) {
          if (match.status !== 'scheduled') continue;
          if (await upsertMatch(match)) inserted++;
        }
        _logger.default.info(`[CLOUD-SEED/FALLBACK] ${src.name}: inserted ${inserted}/${matches.length} matches`);
        await sleep(500);
      } catch (e) {
        _logger.default.warn(`[CLOUD-SEED/FALLBACK] ${src.name}: error — ${e.message}`);
      }
    }
  }
  const finalAfterFD = await countMatchesForPeriod(0, 0);
  const fdFinished = fdQuotaManager.getQuotaStatus().remaining <= 0 || fdInserted === 0;
  const rapidQuotaStatus = _rapidApiQuotaManager.default.getQuotaStatus();
  const canUseRapid = finalAfterFD < 20 && fdFinished && rapidQuotaStatus.isActive && rapidQuotaStatus.remaining > 0;
  if (canUseRapid) {
    const events = await fetchRapidApiEvents(today);
    const tier1 = events.filter(isTier1);
    const others = events.filter(e => !isTier1(e));
    const sorted = [...tier1, ...others];
    let rapidUsed = 0;
    for (const event of sorted) {
      if (rapidUsed >= rapidQuotaStatus.remaining) break;
      if (!event.id || !event.homeTeam || !event.awayTeam) continue;
      if (!_rapidApiQuotaManager.default.canProcessMatch(event.id)) continue;
      if (await upsertMatch(mapRapidEventToMatch(event))) {
        _rapidApiQuotaManager.default.registerMatch(event.id);
        rapidUsed++;
        rapidApiInserted++;
      }
      await sleep(200);
    }
    _logger.default.info(`[CLOUD-SEED/RAPID] Inserted ${rapidApiInserted} fallback matches.`);
  }
  const finalToday = await countMatchesForPeriod(0, 0);
  const finalTomorrow = await countMatchesForPeriod(1, 1);
  _logger.default.info(`[CLOUD-SEED] Complete. LiveScore: ${liveScoreInserted}, FootballData: ${fdInserted}, RapidAPI: ${rapidApiInserted}, DB: ${finalToday} today / ${finalTomorrow} tomorrow.`);
  if (finalToday + finalTomorrow === 0) {
    _logger.default.warn('[CLOUD-SEED] WARNING: No scheduled matches found.');
  }

  // Auto-calibrate league params after seeding (non-blocking)
  try {
    const {
      calibrate
    } = require('./leagueCalibrator');
    calibrate().catch(e => _logger.default.warn(`[CALIBRATE] Auto-calibration error: ${e.message}`));
  } catch (e) {
    _logger.default.warn(`[CALIBRATE] Auto-calibration initializer failed: ${e.message}`);
  }

  // Backfill des cotes sur les matchs LiveScore (opt-in, non-bloquant)
  if (process.env.ODDS_BACKFILL_ENABLED === 'true') {
    try {
      const {
        backfillOdds
      } = require('../services/oddsBackfill');
      backfillOdds().catch(e => _logger.default.warn(`[ODDS-BACKFILL] Erreur: ${e.message}`));
    } catch (e) {
      _logger.default.warn(`[ODDS-BACKFILL] initializer failed: ${e.message}`);
    }
  }
}
module.exports = {
  runCloudSeed,
  purgeFakeMatches
};

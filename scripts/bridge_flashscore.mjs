import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Output to src/data/matches.json
const OUTPUT_FILE = path.join(__dirname, "../src/data/matches.json");
const ARCHIVE_DB_PATH = path.join(__dirname, "../data/historical_archive.sqlite");

const TARGETS = [
    { name: "Routine A: Today (Live)", url: "https://www.flashscore.com/live/", day: 0 },
    { name: "Routine B: Tomorrow (Anticipation)", url: "https://www.flashscore.com/?d=1", day: 1 }
];

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1'
];

// 🛡️ STEALTH CONFIG: Layer 3 Protection
const STEALTH_CONFIG_FILE = path.join(__dirname, "stealth_config.json");
const ACCURACY_LEARNING_FILE = path.join(__dirname, "../data/accuracy_learning.json");
const MASTER_DB_FILE = path.join(__dirname, "../data/master_database.json");

let stealthConfig = { enabled: false };
try {
    if (fs.existsSync(STEALTH_CONFIG_FILE)) {
        stealthConfig = JSON.parse(fs.readFileSync(STEALTH_CONFIG_FILE, 'utf8'));
    }
} catch (e) {
    console.warn("Stealth config not found, running standard.");
}

// 📂 DATABASE CONNECTION (PERPETUAL ARCHIVE)
const archiveDb = new Database(ARCHIVE_DB_PATH);

// Initialize Strike Tables
archiveDb.prepare(`
    CREATE TABLE IF NOT EXISTS failed_patterns (
        id TEXT PRIMARY KEY,
        pattern_hash TEXT,
        reason TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

archiveDb.prepare(`
    CREATE TABLE IF NOT EXISTS winning_patterns (
        id TEXT PRIMARY KEY,
        da_ratio REAL,
        possession REAL,
        intensity REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

archiveDb.exec(`
    CREATE TABLE IF NOT EXISTS archive_matches (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        league TEXT,
        country TEXT,
        homeTeam TEXT NOT NULL,
        awayTeam TEXT NOT NULL,
        scoreHome INTEGER,
        scoreAway INTEGER,
        status TEXT,
        stats_blob TEXT,
        prediction_blob TEXT,
        isVVIP INTEGER DEFAULT 0,
        analysis_confidence REAL,
        scrapedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_archive_teams ON archive_matches (homeTeam, awayTeam);
    CREATE INDEX IF NOT EXISTS idx_archive_date ON archive_matches (date);
`);

/**
 * MASTER DATABASE SYNC
 */
const syncToMasterDB = (match) => {
    try {
        let masterData = [];
        if (fs.existsSync(MASTER_DB_FILE)) {
            masterData = JSON.parse(fs.readFileSync(MASTER_DB_FILE, 'utf8'));
        }
        const index = masterData.findIndex(m => m.id === match.id);
        if (index !== -1) {
            masterData[index] = { ...masterData[index], ...match, updatedAt: new Date().toISOString() };
        } else {
            masterData.push({ ...match, createdAt: new Date().toISOString() });
        }
        // Limit master database size for performance (e.g., last 500 matches)
        if (masterData.length > 500) masterData = masterData.slice(-500);
        fs.writeFileSync(MASTER_DB_FILE, JSON.stringify(masterData, null, 2));
    } catch (e) {
        console.warn("Master DB sync failed:", e.message);
    }
};

/**
 * ARCHIVAL LOOKUP: Check SQLite for past performances delta
 */
const getArchivalH2H = (home, away) => {
    try {
        const row = archiveDb.prepare(`
            SELECT avg(analysis_confidence) as avg_conf, count(*) as total
            FROM archive_matches 
            WHERE (homeTeam = ? AND awayTeam = ?) OR (homeTeam = ? AND awayTeam = ?)
        `).get(home, away, away, home);
        return row || { avg_conf: 0, total: 0 };
    } catch (e) {
        return { avg_conf: 0, total: 0 };
    }
};

/**
 * SELF-CORRECTION: Log a failed prediction pattern
 */
const logFailure = (matchId, daRatio, possession, reason) => {
    const hash = `${Math.round(daRatio * 10)}_${Math.round(possession * 10)}`;
    try {
        archiveDb.prepare(`INSERT OR REPLACE INTO failed_patterns (id, pattern_hash, reason) VALUES (?, ?, ?)`).run(matchId, hash, reason);
    } catch (e) { }
};

const checkFailurePatterns = (daRatio, possession) => {
    const hash = `${Math.round(daRatio * 10)}_${Math.round(possession * 10)}`;
    try {
        const row = archiveDb.prepare(`SELECT count(*) as count FROM failed_patterns WHERE pattern_hash = ?`).get(hash);
        return row.count > 0;
    } catch (e) {
        return false;
    }
};

/**
 * WINNING PATTERN: Log high-pressure state before goals
 */
const logWinningPattern = (matchId, daRatio, possession, intensity) => {
    try {
        archiveDb.prepare(`INSERT OR REPLACE INTO winning_patterns (id, da_ratio, possession, intensity) VALUES (?, ?, ?, ?)`).run(matchId, daRatio, possession, intensity);
    } catch (e) { }
};
const getHistoricalSimilarity = (daRatio, possessionRatio) => {
    try {
        // Find matches where DA ratio is within 5% and possession within 5%
        const matches = archiveDb.prepare(`
            SELECT count(*) as count, avg(scoreHome + scoreAway > 0) as goalProb
            FROM archive_matches
            WHERE abs((CAST(json_extract(stats_blob, '$."Dangerous Attacks"[0]') AS FLOAT) / 
                  (json_extract(stats_blob, '$."Dangerous Attacks"[0]') + json_extract(stats_blob, '$."Dangerous Attacks"[1]'))) - ?) < 0.05
            AND abs((CAST(json_extract(stats_blob, '$."Ball Possession"[0]') AS FLOAT) / 100) - ?) < 0.05
        `).get(daRatio, possessionRatio);
        return matches || { count: 0, goalProb: 0 };
    } catch (e) {
        return { count: 0, goalProb: 0 };
    }
};

/**
 * XGBoost Inference Logic (Ported & GFB-Enhanced)
 */
const predictMatch = (statsArray, matchInfo) => {
    const parsePercent = (val) => {
        if (!val) return 0.5;
        const clean = val.replace('%', '');
        return parseFloat(clean) / 100;
    };

    const parseIntSafe = (val) => {
        if (!val) return 0;
        return parseInt(val, 10);
    };

    const stats = {};
    if (Array.isArray(statsArray)) {
        statsArray.forEach(s => {
            if (s.category && s.homeValue) stats[s.category] = [s.homeValue, s.awayValue];
        });
    }

    const homePossession = parsePercent(stats['Ball Possession']?.[0]);
    const awayPossession = parsePercent(stats['Ball Possession']?.[1]);

    let homeDARaw = parseIntSafe(stats['Dangerous Attacks']?.[0]);
    let awayDARaw = parseIntSafe(stats['Dangerous Attacks']?.[1]);
    let homeAttacks = parseIntSafe(stats['Attacks']?.[0]);
    let awayAttacks = parseIntSafe(stats['Attacks']?.[1]);

    const totalDA = homeDARaw + awayDARaw || 1;
    const daRatio = homeDARaw / totalDA;

    // 🎯 LETHAL LOGIC: Condition 1 - Intensity (>70% DA Pressure)
    const isHighIntensity = (homeDARaw / (homeAttacks || 1)) > 0.7 || (awayDARaw / (awayAttacks || 1)) > 0.7;

    const MAX_ATTACK = 80;
    const homeAttack = Math.min(1, homeDARaw / MAX_ATTACK);
    const awayAttack = Math.min(1, awayDARaw / MAX_ATTACK);

    const homeStrength = (homePossession * 0.4) + (homeAttack * 0.6);
    const awayStrength = (awayPossession * 0.4) + (awayAttack * 0.6);

    const features = {
        homeStrength,
        awayStrength,
        strengthDiff: homeStrength - awayStrength,
        homeAttack,
        awayDefense: 1 - awayAttack,
        leagueTier: matchInfo.tier || 1.0
    };

    // 🧠 GFB NEURAL BOOSTING (Similarity check)
    const similarity = getHistoricalSimilarity(daRatio, homePossession);
    const historicalGoalProb = similarity.count > 3 ? similarity.goalProb : 0.5;

    // 🎯 LETHAL LOGIC: Condition 2 - Historical Similarity Goal Prob > 75%
    const isHistoricallyVerified = historicalGoalProb > 0.75;

    const homeAdvantage = 0.15;
    let homeScore = features.homeStrength + homeAdvantage + (historicalGoalProb * 0.2);
    let awayScore = features.awayStrength;

    const archivalData = getArchivalH2H(matchInfo.home, matchInfo.away);
    if (archivalData.total > 0) {
        const boost = (archivalData.avg_conf - 50) / 100;
        homeScore += boost * 0.2;
    }

    const total = homeScore + awayScore + 0.5;
    const homeWinProb = Math.max(0.05, Math.min(0.95, homeScore / total));
    const awayWinProb = Math.max(0.05, Math.min(0.95, awayScore / total));

    let prediction = "Draw";
    if (homeWinProb > awayWinProb + 0.1) prediction = "Home Win";
    if (awayWinProb > homeWinProb + 0.1) prediction = "Away Win";

    const shotsHome = parseIntSafe(stats['Shots on Target']?.[0]) || 0;
    const shotsAway = parseIntSafe(stats['Shots on Target']?.[1]) || 0;

    const baseConfidence = matchInfo.day === 1 ? 62.0 : 55.4;
    const attackImpact = totalDA * 0.15;
    const shotImpact = (shotsHome + shotsAway) * 1.5;
    const skillGap = Math.abs(features.strengthDiff) * 15;

    let finalConfidence = Math.min(99.2, baseConfidence + attackImpact + shotImpact + skillGap);

    // 🎯 TRUTH FILTER: Offensive Liquidity
    const matchTime = parseInt((matchInfo.status || "").replace("'", "")) || 0;
    if (matchInfo.day === 0 && matchTime > 20) {
        const isBoring = totalDA < 20 && (shotsHome + shotsAway) < 2;
        if (isBoring) {
            finalConfidence *= 0.7; // Penalize boring matches heavily
        }
    }

    // 🎯 LETHAL LOGIC: Condition 3 - VVIP Strike Trigger
    let xgBoostStatus = "GFB Powered";
    let isStrike = false;

    if (isHighIntensity && isHistoricallyVerified && finalConfidence > 80) {
        finalConfidence = Math.max(finalConfidence, 88.5);
        xgBoostStatus = "🎯 LETHAL STRIKE: VVIP";
        isStrike = true;
    } else if (finalConfidence >= 85) {
        xgBoostStatus = "🎯 VVIP SIGNAL ACTIF";
    }

    // 💰 VALUE DETECTION: AI Prob vs Market Odds
    let isGoldenValue = false;
    const bookieOdds = (matchInfo.odds && matchInfo.odds[prediction === "Home Win" ? "home" : "away"]) || 0;
    if (bookieOdds > 1.2) {
        const aiProb = prediction === "Home Win" ? homeWinProb : awayWinProb;
        if (aiProb > (1 / bookieOdds) * 1.2) {
            isGoldenValue = true;
            xgBoostStatus += " | 💰 GOLDEN VALUE";
        }
    }

    return {
        overallConfidence: Math.round(finalConfidence * 10) / 10,
        primaryPrediction: prediction,
        isBoiling: finalConfidence > 85,
        dangerFactor: Math.max(features.homeAttack, features.awayAttack),
        isUltimateVVIP: finalConfidence >= 88,
        isStrike,
        isGoldenValue,
        teamAStrength: Math.round(features.homeStrength * 100),
        teamBStrength: Math.round(features.awayStrength * 100),
        liveMomentum: Math.min(100, Math.round((totalDA / 70) * 100)),
        xgBoostStatus,
        archivalImpact: similarity.count > 0 ? `SIMILARITY: ${Math.round(historicalGoalProb * 100)}%` : "New Profile",
        isPreMatch: matchInfo.day === 1,
        matchDay: matchInfo.day
    };
};

/**
 * GFB SPEED ENGINE: Resource Blocking & Fast Navigation
 */
const optimizePage = async (page) => {
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot,css,ico}', route => route.abort());
    await page.route('**/google-analytics.com/**', route => route.abort());
    await page.route('**/googletagmanager.com/**', route => route.abort());
    await page.route('**/doubleclick.net/**', route => route.abort());
};

const getMatchLinks = async (page, target) => {
    console.log(`📡 [GFB ENGINE] ${target.name} | URL: ${target.url}...`);
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".event__match", { timeout: 10000 }).catch(() => { });

    return await page.evaluate((dayOffset) => {
        const matches = [];
        let currentLeague = "Unknown";
        let currentCountry = "Unknown";
        const elements = document.querySelectorAll(".event__header, .event__match");
        elements.forEach(el => {
            if (el.classList.contains("event__header")) {
                const titleEl = el.querySelector(".wcl-category-link_... , .event__title--name");
                const fullTitle = titleEl?.innerText.trim() || "";
                if (fullTitle.includes(":")) {
                    [currentCountry, currentLeague] = fullTitle.split(":").map(s => s.trim());
                } else {
                    currentLeague = fullTitle;
                }
            } else if (el.classList.contains("event__match")) {
                matches.push({
                    id: el.id.replace("g_1_", ""),
                    league: currentLeague,
                    country: currentCountry,
                    dayOffset
                });
            }
        });
        return matches.slice(0, 100);
    }, target.day);
};

const getMatchData = async (page, matchId, target) => {
    let url = target.day === 0
        ? `https://www.flashscore.com/match/${matchId}/#/match-summary/stats/0`
        : `https://www.flashscore.com/match/${matchId}/#/odds-comparison/1x2-odds/full-time`;

    const start = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const latency = Date.now() - start;

    // 🛡️ SOVEREIGNTY SHIELD: Latency Monitor
    if (latency > 500) {
        console.warn(`⚠️ [Sovereignty Shield] Handshake Lag: ${latency}ms | Identity rotation recommended.`);
    }

    const data = await page.evaluate((mId) => {
        let homeName = document.querySelector(".duelParticipant__home .participant__participantName")?.innerText?.trim();
        let awayName = document.querySelector(".duelParticipant__away .participant__participantName")?.innerText?.trim();
        const homeScore = document.querySelector(".detailScore__wrapper span:first-child")?.innerText.trim();
        const awayScore = document.querySelector(".detailScore__wrapper span:last-child")?.innerText.trim();
        const status = document.querySelector(".fixedHeaderDuel__detailStatus")?.innerText.trim();

        const stats = [];
        const rows = document.querySelectorAll("div[data-testid='wcl-statistics']");
        rows.forEach(row => {
            const cat = row.querySelector("div[data-testid='wcl-statistics-category']")?.innerText.trim();
            const vals = row.querySelectorAll("div[data-testid='wcl-statistics-value']");
            if (cat && vals.length === 2) {
                stats.push({
                    category: cat,
                    homeValue: vals[0].innerText.trim(),
                    awayValue: vals[1].innerText.trim()
                });
            }
        });

        // Odds extraction
        const odds = {};
        const oddsRows = document.querySelectorAll('.oddsCell__odds');
        if (oddsRows.length >= 3) {
            odds.home = oddsRows[0].innerText.trim();
            odds.draw = oddsRows[1].innerText.trim();
            odds.away = oddsRows[2].innerText.trim();
        }

        return { matchId: mId, homeName, awayName, homeScore, awayScore, status, statistics: stats, odds };
    }, matchId);

    if (target.day === 1) {
        await page.goto(`https://www.flashscore.com/match/${matchId}/#/h2h/overall`, { waitUntil: "domcontentloaded", timeout: 10000 });
        const h2h = await page.evaluate(() => {
            const h2hRows = document.querySelectorAll('.h2h__row');
            return h2hRows.length;
        });
        data.h2hCount = h2h;
    }

    return data;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const processMatch = async (workerId, page, match, target, allMatches) => {
    try {
        const data = await getMatchData(page, match.id, target);
        if (!data.homeName) return;

        // 🔍 STRIKE OBSERVATION
        const stats = {};
        if (Array.isArray(data.statistics)) {
            data.statistics.forEach(s => {
                if (s.category) stats[s.category] = [s.homeValue, s.awayValue];
            });
        }
        const daH = stats['Dangerous Attacks']?.[0] || '0';
        const daA = stats['Dangerous Attacks']?.[1] || '0';
        const totalDA = parseInt(daH) + parseInt(daA) || 1;
        const score = `${data.homeScore || 0}-${data.awayScore || 0}`;

        console.log(`Node ${workerId} 🔥 [Collected] ${data.homeName} vs ${data.awayName} | ${score} | DA: ${daH}-${daA}`);

        const prediction = predictMatch(data.statistics, {
            home: data.homeName, away: data.awayName, tier: 1.0, day: target.day, status: data.status
        });

        // 🧠 SELF-CORRECTION & WINNING PATTERN
        const daRatio = parseInt(daH) / totalDA;
        const posH = parseFloat((stats['Ball Possession']?.[0] || '50').replace('%', '')) / 100;

        if (checkFailurePatterns(daRatio, posH)) {
            prediction.overallConfidence *= 0.9;
            prediction.xgBoostStatus += " | ⚠️ CAUTION PATTERN";
        }

        // Detect goal events for Winning Pattern extraction
        const lastMatchState = archiveDb.prepare('SELECT scoreHome, scoreAway, stats_blob FROM archive_matches WHERE id = ?').get(match.id);
        if (lastMatchState) {
            const oldScore = (parseInt(lastMatchState.scoreHome) || 0) + (parseInt(lastMatchState.scoreAway) || 0);
            const newScore = (parseInt(data.homeScore) || 0) + (parseInt(data.awayScore) || 0);
            if (newScore > oldScore && totalDA > 40) {
                console.log(`🎯 [Winning Pattern] Goal detected after high pressure (${totalDA} DA). Logging to SQLite.`);
                logWinningPattern(match.id, daRatio, posH, totalDA);
            }
        }

        if (target.day === 1 && prediction.overallConfidence >= 82) {
            prediction.xgBoostStatus = "💎 PRE-VVIP ANTICIPATION";
            prediction.isPreVVIP = true;
        }

        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + target.day);
        const dateStr = targetDate.toISOString().split('T')[0];

        const unifiedMatch = {
            id: data.matchId,
            date: dateStr,
            status: data.status || 'NS',
            homeTeam: { name: data.homeName, logo: `https://ui-avatars.com/api/?name=${data.homeName}&background=random` },
            awayTeam: { name: data.awayName, logo: `https://ui-avatars.com/api/?name=${data.awayName}&background=random` },
            league: { name: match.league, country: match.country },
            source: target.day === 0 ? 'SYSTEM LIVE: TN-INTEL' : 'SYSTEM ANTICIPATION: 48H',
            score: { home: parseInt(data.homeScore) || 0, away: parseInt(data.awayScore) || 0 },
            odds: data.odds,
            analysis: prediction
        };

        allMatches.push(unifiedMatch);
        syncToMasterDB(unifiedMatch);

        archiveDb.prepare(`
            INSERT OR REPLACE INTO archive_matches 
            (id, date, league, country, homeTeam, awayTeam, scoreHome, scoreAway, status, stats_blob, prediction_blob, analysis_confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            unifiedMatch.id, unifiedMatch.date, unifiedMatch.league.name, unifiedMatch.league.country,
            unifiedMatch.homeTeam.name, unifiedMatch.awayTeam.name, unifiedMatch.score.home, unifiedMatch.score.away,
            unifiedMatch.status, JSON.stringify(data.statistics), JSON.stringify(prediction), prediction.overallConfidence
        );

    } catch (e) {
        console.warn(`Node ${workerId} Error: ${e.message}`);
    }
};

(async () => {
    console.log("🔋 [TN-INTEL] Starting 4-NODE PARALLEL SOVEREIGN ENGINE...");
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    let lastResetDate = new Date().getUTCDate();

    while (true) {
        const now = new Date();
        if (now.getUTCDate() !== lastResetDate) {
            lastResetDate = now.getUTCDate();
            console.log("🕒 [Chronos] Daily Reset.");
        }

        const allMatches = [];
        const startTime = Date.now();
        const mainPage = await browser.newPage();

        // 1. Discovery
        const liveMatches = await getMatchLinks(mainPage, TARGETS[0]);
        const tomorrowMatches = await getMatchLinks(mainPage, TARGETS[1]);
        await mainPage.close();

        // 2. Worker Assignment (Reduced to 4 nodes for stability)
        const workers = [];
        for (let i = 1; i <= 4; i++) {
            workers.push({ id: i, matches: [] });
        }

        // Distribute Live to Nodes 1-2
        liveMatches.forEach((m, idx) => workers[idx % 2].matches.push(m));
        // Distribute Tomorrow to Nodes 3-4
        tomorrowMatches.forEach((m, idx) => workers[2 + (idx % 2)].matches.push(m));

        // 3. Execution
        await Promise.all(workers.map(async (worker) => {
            if (worker.matches.length === 0) return;
            const context = await browser.newContext({ userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] });
            const page = await context.newPage();
            await optimizePage(page);

            for (const match of worker.matches) {
                await processMatch(worker.id, page, match, worker.id <= 2 ? TARGETS[0] : TARGETS[1], allMatches);

                // 📂 Progressive Save
                if (allMatches.length % 5 === 0) {
                    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
                        metadata: { scrapedAt: new Date().toISOString(), source: 'SOVEREIGNTY SHIELD ACTIVE 🛡️', totalMatches: allMatches.length },
                        matches: allMatches
                    }, null, 2));
                }
            }
            await context.close();
        }));

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
            metadata: { scrapedAt: new Date().toISOString(), source: 'SYSTEM STATUS: SOVEREIGNTY SHIELD ACTIVE 🛡️', totalMatches: allMatches.length },
            matches: allMatches
        }, null, 2));

        const duration = (Date.now() - startTime) / 1000;
        console.log(`✨ [Sweep Complete] Nodes 1-4 finished. Total time: ${duration}s. Pulse 10s.`);
        await sleep(10000);
    }
})();

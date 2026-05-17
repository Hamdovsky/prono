/**
 * oddsMovementService.js — Odds Movement Detector
 * ─────────────────────────────────────────────────
 * Snapshots match odds every call, compares to previous snapshot.
 * Flags significant line movement as `steam_detected`.
 * Data persisted to data/odds_history.json
 */

const fs   = require('fs');
const path = require('path');

const ODDS_FILE = path.join(__dirname, '..', 'data', 'odds_history.json');
const STEAM_THRESHOLD = 0.12; // odds shift of 0.12+ = steam
const MAX_ENTRIES_PER_MATCH = 20; // 40 hours of 2h-snapshots


function loadOddsHistory() {
    if (fs.existsSync(ODDS_FILE)) {
        try { return JSON.parse(fs.readFileSync(ODDS_FILE, 'utf8')); }
        catch (_) {}
    }
    return {};
}

function saveOddsHistory(data) {
    fs.mkdirSync(path.dirname(ODDS_FILE), { recursive: true });
    fs.writeFileSync(ODDS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Snapshot odds for a batch of matches.
 * @param {Array} matches - array of match objects with matchId, odds_home, odds_draw, odds_away
 * @returns {Map<string, object>} matchId → { steamHome, steamAway, steamDraw, direction }
 */
function snapshotOdds(matches) {
    const history = loadOddsHistory();
    const results = new Map();

    for (const m of matches) {
        const id = String(m.matchId || m.id);
        if (!id || !m.odds_home) continue;

        const snapshot = {
            ts:   Date.now(),
            h:    parseFloat(m.odds_home)  || null,
            d:    parseFloat(m.odds_draw)  || null,
            a:    parseFloat(m.odds_away)  || null,
        };

        if (!history[id]) history[id] = [];
        history[id].push(snapshot);

        // Keep only last N snapshots per match
        if (history[id].length > MAX_ENTRIES_PER_MATCH) {
            history[id] = history[id].slice(-MAX_ENTRIES_PER_MATCH);
        }

        // Detect steam (compare first and last snapshot)
        const snaps = history[id];
        const steamResult = { steamHome: false, steamAway: false, steamDraw: false, direction: null };

        if (snaps.length >= 2) {
            const first = snaps[0];
            const last  = snaps[snaps.length - 1];

            // Odds DROP = money coming in (steam) — bookies shorten the price
            if (first.h && last.h && (first.h - last.h) >= STEAM_THRESHOLD) {
                steamResult.steamHome = true;
                steamResult.direction = 'HOME';
            }
            if (first.a && last.a && (first.a - last.a) >= STEAM_THRESHOLD) {
                steamResult.steamAway = true;
                steamResult.direction = steamResult.direction ? 'BOTH' : 'AWAY';
            }
            if (first.d && last.d && (first.d - last.d) >= STEAM_THRESHOLD) {
                steamResult.steamDraw = true;
            }

            steamResult.homeShift = first.h && last.h ? parseFloat((first.h - last.h).toFixed(2)) : 0;
            steamResult.awayShift = first.a && last.a ? parseFloat((first.a - last.a).toFixed(2)) : 0;
        }

        results.set(id, steamResult);
    }

    saveOddsHistory(history);
    return results;
}

/**
 * Get steam status for a single match.
 */
function getSteamForMatch(matchId) {
    const history = loadOddsHistory();
    const snaps = history[String(matchId)];
    if (!snaps || snaps.length < 2) return { steam_detected: false };

    const first = snaps[0];
    const last  = snaps[snaps.length - 1];

    const hShift = first.h && last.h ? first.h - last.h : 0;
    const aShift = first.a && last.a ? first.a - last.a : 0;

    return {
        steam_detected: hShift >= STEAM_THRESHOLD || aShift >= STEAM_THRESHOLD,
        home_shift:     parseFloat(hShift.toFixed(2)),
        away_shift:     parseFloat(aShift.toFixed(2)),
        direction:      hShift >= STEAM_THRESHOLD ? 'HOME' : aShift >= STEAM_THRESHOLD ? 'AWAY' : null,
        snapshots:      snaps.length,
    };
}

/**
 * V52: Get 24-hour line movement for a match.
 * Calculates delta between current odds and snapshot closest to 24h ago.
 */
function get24hMovement(matchId) {
    const history = loadOddsHistory();
    const snaps = history[String(matchId)];
    if (!snaps || snaps.length < 2) return null;

    const now = Date.now();
    const targetTs = now - (24 * 60 * 60 * 1000);

    // Find snapshot closest to -24h
    let baseline = snaps[0];
    let minDiff = Math.abs(baseline.ts - targetTs);

    for (const s of snaps) {
        const diff = Math.abs(s.ts - targetTs);
        if (diff < minDiff) {
            minDiff = diff;
            baseline = s;
        }
    }

    const current = snaps[snaps.length - 1];
    
    // If baseline is too young (e.g. only 4h old), we can't call it "24h"
    const actualAgeHours = (current.ts - baseline.ts) / (1000 * 3600);
    
    return {
        h_delta: baseline.h && current.h ? (current.h - baseline.h) : 0,
        a_delta: baseline.a && current.a ? (current.a - baseline.a) : 0,
        d_delta: baseline.d && current.d ? (current.d - baseline.d) : 0,
        h_pct: baseline.h && current.h ? (((current.h - baseline.h) / baseline.h) * 100) : 0,
        a_pct: baseline.a && current.a ? (((current.a - baseline.a) / baseline.a) * 100) : 0,
        age_hours: parseFloat(actualAgeHours.toFixed(1)),
        is_reliable: actualAgeHours >= 4 // Lowered from 12 to 4 hours to catch more same-day shifts
    };
}

/**
 * Detects if a match is a Bookmaker Trap (Reverse Line Movement).
 * A trap occurs when AI has high confidence (>65%) but the odds for that outcome
 * have shifted significantly HIGHER (worse value) indicating market resistance or inside info.
 * @param {string} matchId 
 * @param {number} aiWinProb - Probability of the favorite (0-100)
 * @param {string} expectedWinner - 'HOME' or 'AWAY'
 * @param {object} currentOdds - { home, away, draw }
 */
function detectBookmakerTrap(matchId, aiWinProb, expectedWinner, currentOdds) {
    if (aiWinProb < 60 || !expectedWinner) return { isTrap: false };

    const movement = get24hMovement(matchId);
    if (!movement || !movement.is_reliable) return { isTrap: false };

    let isTrap = false;
    let severity = 0;
    let msg = '';
    const TRAP_THRESHOLD_PCT = 15; // 15% odds increase is highly suspicious for a favorite

    // If AI strongly favors home
    if (expectedWinner === 'HOME' && currentOdds.home) {
        // Did the odds INCREASE?
        if (movement.h_pct >= TRAP_THRESHOLD_PCT) {
            isTrap = true;
            severity = movement.h_pct;
            msg = `HOME odds inflated by +${severity.toFixed(1)}% despite AI confidence.`;
        }
    } 
    // If AI strongly favors away
    else if (expectedWinner === 'AWAY' && currentOdds.away) {
        if (movement.a_pct >= TRAP_THRESHOLD_PCT) {
            isTrap = true;
            severity = movement.a_pct;
            msg = `AWAY odds inflated by +${severity.toFixed(1)}% despite AI confidence.`;
        }
    }

    return { isTrap, severity: severity ? parseFloat(severity.toFixed(1)) : 0, msg, shiftPct: severity };
}

module.exports = { snapshotOdds, getSteamForMatch, get24hMovement, detectBookmakerTrap };


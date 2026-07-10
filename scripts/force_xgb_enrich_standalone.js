const database = require('../core/database');
const StatisticalEngine = require('../core/services/StatisticalEngine');
const axios = require('axios');

const FASTAPI_URL = process.env.INFERENCE_URL || 'http://prono-fastapi:8000';
const XGB_TIMEOUT = 60000;

function factorial(n) { if (n < 2) return 1; let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poissonProb(x, lambda) { if (lambda <= 0) return x === 0 ? 1 : 0; return Math.exp(-lambda) * Math.pow(lambda, x) / factorial(x); }

function buildScoreMatrix(xgH, xgA, maxG = 8) {
  const m = [];
  for (let h = 0; h <= maxG; h++) { m[h] = []; const ph = poissonProb(h, xgH); for (let a = 0; a <= maxG; a++) m[h][a] = ph * poissonProb(a, xgA); }
  return m;
}

function calcMarkets(matrix) {
  const maxG = matrix.length - 1; let h=0,d=0,a=0,o25=0,b=0;
  for (let i=0;i<=maxG;i++) for (let j=0;j<=maxG;j++) { const p=matrix[i][j]; if(i>j) h+=p; else if(i===j) d+=p; else a+=p; if(i+j>2.5) o25+=p; if(i>0&&j>0) b+=p; }
  const t = h+d+a; if (t>0) { h/=t; d/=t; a/=t; }
  return { home:h, draw:d, away:a, over_25:o25, btts_yes:b };
}

function determinePick(pH,pD,pA) { const p=[{l:'1',p:pH},{l:'X',p:pD},{l:'2',p:pA}]; p.sort((a,b)=>b.p-a.p); const b=p[0]; return {pick:b.l,prob:Math.round(b.p*10)/10,ev:Math.round((b.p/100*2-1)*100)/100}; }

async function tryXgb(match) {
  try {
    const payload = {
      homeTeam: match.homeTeam, awayTeam: match.awayTeam,
      league: match.league || match.tournament_name || '',
      odds_home: parseFloat(match.odds_home) || 2.0,
      odds_draw: parseFloat(match.odds_draw) || 3.0,
      odds_away: parseFloat(match.odds_away) || 3.0,
      startTimestamp: match.startTimestamp || match.timestamp || 0,
      task: 'PREDICTION',
    };
    // Try internal URL first, then fallback to public URL
    let resp;
    try { resp = await axios.post(`${FASTAPI_URL}/predict`, payload, { timeout: XGB_TIMEOUT, headers:{'Content-Type':'application/json'} }); }
    catch (_) { resp = await axios.post(`https://prono-fastapi.onrender.com/predict`, payload, { timeout: XGB_TIMEOUT, headers:{'Content-Type':'application/json'} }); }
    const py = resp.data;
    if (!py || !py.success) return null;
    const pHome = parseFloat(py.home_win_probability)||0, pDraw = parseFloat(py.draw_probability)||0, pAway = parseFloat(py.away_win_probability)||0;
    if (pHome + pDraw + pAway <= 0.01) return null;
    const xgbConf = parseFloat(py.xgboost_confidence || py.confidence || 0);
    const pHPct = +(pHome * 100).toFixed(1), pDPct = +(pDraw * 100).toFixed(1), pAPct = +(pAway * 100).toFixed(1);
    if (xgbConf < 0.40 || pDPct > 50) return null;
    const xgH = parseFloat(py.home_xg) || parseFloat(py.expected_goals_home) || 1.5;
    const xgA = parseFloat(py.away_xg) || parseFloat(py.expected_goals_away) || 1.15;
    const {pick,prob,ev} = determinePick(pHPct, pDPct, pAPct);
    return {
      home_win_probability: pHPct, draw_probability: pDPct, away_win_probability: pAPct,
      home_xg: Math.round(xgH * 100) / 100, away_xg: Math.round(xgA * 100) / 100,
      source: 'xgb_fastapi_v553',
      xgboost_confidence: xgbConf,
      ou_25_prob: py.ou_25_prob ? Math.round(py.ou_25_prob * 100) : null,
      btts_prob: py.btts_prob ? Math.round(py.btts_prob * 100) : null,
      expected_score: py.expected_score || `${Math.round(xgH)} - ${Math.round(xgA)}`,
      prediction: pick, prediction_probability: prob, ev_score: ev, verdict: pick,
    };
  } catch (e) { return null; }
}

function tryJSEngine(match) {
  try {
    if (!match.homeTeam || !match.awayTeam) return null;
    const xg = StatisticalEngine.getMatchXG(match);
    const xgH = xg.h, xgA = xg.a;
    const matrix = buildScoreMatrix(xgH, xgA);
    const m = calcMarkets(matrix);
    const pH = Math.round(m.home * 1000) / 10, pD = Math.round(m.draw * 1000) / 10, pA = Math.round(m.away * 1000) / 10;
    const {pick,prob,ev} = determinePick(pH, pD, pA);
    return {
      home_win_probability: pH, draw_probability: pD, away_win_probability: pA,
      home_xg: Math.round(xgH * 100) / 100, away_xg: Math.round(xgA * 100) / 100,
      source: 'fallback_js',
      xgboost_confidence: 0,
      ou_25_prob: Math.round(m.over_25 * 1000) / 10,
      btts_prob: Math.round(m.btts_yes * 1000) / 10,
      expected_score: `${Math.round(xgH)} - ${Math.round(xgA)}`,
      prediction: pick, prediction_probability: prob, ev_score: ev, verdict: pick,
    };
  } catch (e) { return null; }
}

(async () => {
  console.log('[FORCE_XGB] Starting...');
  let matches;
  try { matches = await database.getInsufficientDataMatches(); } catch (e) { console.error('DB query failed:', e.message); process.exit(1); }
  if (!matches || matches.length === 0) { console.log('No insufficient-data matches found.'); return; }
  console.log(`Found ${matches.length} matches.`);
  let xgbOk=0, jsOk=0, failed=0, enriched=0;
  const batchSize = 5;
  for (let i=0; i<matches.length; i+=batchSize) {
    const batch = matches.slice(i, i+batchSize);
    const results = await Promise.all(batch.map(async (m) => {
      let r = await tryXgb(m);
      if (r) { xgbOk++; return {m, r}; }
      r = tryJSEngine(m);
      if (r) { jsOk++; return {m, r}; }
      failed++;
      return null;
    }));
    for (const item of results) {
      if (!item) continue;
      const {m, r} = item;
      try {
        const dbPayload = {
          home_win_probability: r.home_win_probability, draw_probability: r.draw_probability,
          away_win_probability: r.away_win_probability, insufficient_data: 0, home_xg: r.home_xg, away_xg: r.away_xg,
          source: r.source, xgboost_confidence: r.xgboost_confidence || null,
        };
        if (r.ou_25_prob != null) dbPayload.ou_25_prob = r.ou_25_prob;
        if (r.btts_prob != null) dbPayload.btts_prob = r.btts_prob;
        if (r.expected_score) dbPayload.expected_score = r.expected_score;
        if (r.prediction) { dbPayload.verdict = r.verdict || r.prediction; dbPayload.prediction_probability = r.prediction_probability; dbPayload.ev_score = r.ev_score; }
        await database.updatePredictions(m.id, dbPayload);
        enriched++;
        process.stdout.write('.');
      } catch (e) { process.stdout.write('!'); }
    }
    if (i + batchSize < matches.length) await new Promise(r => setTimeout(r, 100));
  }
  console.log(`\nDone: ${enriched}/${matches.length} (XGBoost:${xgbOk} JS:${jsOk} Failed:${failed})`);
  console.log(JSON.stringify({enriched,total:matches.length,xgbOk,jsOk,failed}));
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

'use strict';
/**
 * MARKET REGISTRY — definitions canoniques + alias par source.
 * Ajouter un marche = ajouter une entree ici. Aucune logique de parsing
 * hardcodee par nom de bookmaker (pas de if "over 1.5").
 */

// Categories: goals | corners | cards | btts | handicap | team_goals | result | ht_ft
// ORDRE IMPORTANT : team_goals avant total_goals (sinon "Home Team Total Goals"
// est capte par total_goals).
const MARKET_REGISTRY = {
  total_goals: {
    category: 'goals',
    type: 'over_under',
    period: 'full_time',
    aliases: [
      /over\/under\s*(\d+(?:\.\d+)?)\s*goals?/i,
      /(?<!\bteam\s)total\s*goals?\s*(\d+(?:\.\d+)?)/i,
      /\bou\s*(\d+(?:\.\d+)?)\b/i,
      /match\s*goals?\s*(\d+(?:\.\d+)?)/i,
      /over\s*(\d+(?:\.\d+)?)\s*goals?/i,
      /under\s*(\d+(?:\.\d+)?)\s*goals?/i,
    ],
    selections: {
      over: [/^over\b/i, /\bmore\b/i, /^o\s*\d/i, /over\s*\d/i],
      under: [/^under\b/i, /\bless\b/i, /\bfewer\b/i, /^u\s*\d/i, /under\s*\d/i],
    },
    defaultLine: 2.5,
  },
  total_corners: {
    category: 'corners',
    type: 'over_under',
    period: 'full_time',
    aliases: [
      /over\/under\s*(\d+(?:\.\d+)?)\s*(?:corner|ck|corners)/i,
      /total\s*(?:corner|ck|corners)\s*(\d+(?:\.\d+)?)/i,
      /(\d+(?:\.\d+)?)\s*(?:corner|ck|corners)\s*(?:over|under)/i,
      /(corner|ck|corners?)\s*(\d+(?:\.\d+)?)/i,
      /(?:corner|ck|corners?)\s*(?:line)?\s*(\d+(?:\.\d+)?)/i,
    ],
    selections: {
      over: [/^over\b/i, /more corners/i, /o\s*\d/i, /over\s*\d/i],
      under: [/^under\b/i, /fewer corners/i, /u\s*\d/i, /under\s*\d/i],
    },
    defaultLine: 9.5,
  },
  total_cards: {
    category: 'cards',
    type: 'over_under',
    period: 'full_time',
    aliases: [
      /over\/under\s*(\d+(?:\.\d+)?)\s*(?:card|booking|yellow)/i,
      /total\s*(?:card|booking)\s*(\d+(?:\.\d+)?)/i,
    ],
    selections: {
      over: [/^over\b/i, /more cards/i],
      under: [/^under\b/i, /fewer cards/i],
    },
    defaultLine: 3.5,
  },
  btts: {
    category: 'btts',
    type: 'both_teams',
    period: 'full_time',
    aliases: [
      /both\s*teams\s*to\s*score/i,
      /\bbtts\b/i,
      /\bgg\b/i,
      /goal\s*goal/i,
      /b\s*th\s*teams/i,
    ],
    selections: {
      yes: [/^yes\b/i, /\bgg\b/i, /both/i, /btts\s*yes/i],
      no: [/^no\b/i, /\bng\b/i, /not\s*both/i, /either\b/i, /btts\s*no/i],
    },
    defaultLine: null,
  },
  asian_handicap: {
    category: 'handicap',
    type: 'asian_handicap',
    period: 'full_time',
    needsHandicap: true,
    aliases: [
      /asian\s*handicap/i,
      /\bah\b/i,
      /\bhandicap\b/i,
    ],
    selections: {
      home: [/home\s*[-+]\s*\d/i, /h\s*cap/i, /(-?\d+(?:\.\d+)?)\s*on\s*home/i],
      away: [/away\s*[-+]\s*\d/i, /a\s*cap/i],
    },
    defaultLine: null,
  },
  team_goals: {
    category: 'team_goals',
    type: 'team_total',
    period: 'full_time',
    aliases: [
      /^(home|away)\s*team\s*total\s*(?:goals?)?\s*(\d+(?:\.\d+)?)?/i,
      /(home|away)\s*over\/under\s*(\d+(?:\.\d+)?)/i,
      /(home|away)\s*team\s*goals?\s*(?:line)?\s*(\d+(?:\.\d+)?)?\s*(over|under)?/i,
      /^(home|away)\s*total\s*goals?/i,
      /(home|away)\s*(?:to\s*score\s*)?(?:over|under)\s*(\d+(?:\.\d+)?)\s*(?:goals?|team)/i,
    ],
    selections: {
      over: [/^over\b/i, /more/i, /over\s*\d/i],
      under: [/^under\b/i, /less/i, /under\s*\d/i],
    },
    defaultLine: 1.5,
  },
  ht_ft: {
    category: 'result',
    type: 'ht_ft',
    period: 'full_time',
    aliases: [
      /half\s*time\s*[\/\-]?\s*full\s*time/i,
      /\bht\/ft\b/i,
      /halftime\/fulltime/i,
      /ht-ft/i,
      /half\/full/i,
      /half\s*time\s*.*full\s*time/i,
    ],
    selections: {
      home_home: [/home\/home/i, /\bh\/h\b/i, /home\s*&\s*home/i],
      home_draw: [/home\/draw/i, /\bh\/d\b/i],
      home_away: [/home\/away/i, /\bh\/a\b/i],
      draw_home: [/draw\/home/i, /\bd\/h\b/i],
      draw_draw: [/draw\/draw/i, /\bd\/d\b/i],
      draw_away: [/draw\/away/i, /\bd\/a\b/i],
      away_home: [/away\/home/i, /\ba\/h\b/i],
      away_draw: [/away\/draw/i, /\ba\/d\b/i],
      away_away: [/away\/away/i, /\ba\/a\b/i],
    },
    defaultLine: null,
  },
  match_result: {
    category: 'result',
    type: 'match_result',
    period: 'full_time',
    aliases: [/^(?:1x2|match\s*result|full\s*time\s*result|winner)/i, /three\s*way/i, /match\s*result/i],
    selections: {
      home: [/^home\b/i, /^1\b/i, /\bhome\s*win/i],
      draw: [/^draw\b/i, /^x\b/i, /^12\b/i, /unchanged/i],
      away: [/^away\b/i, /^2\b/i, /\baway\s*win/i],
    },
    defaultLine: null,
  },
  double_chance: {
    category: 'result',
    type: 'double_chance',
    period: 'full_time',
    aliases: [/double\s*chance/i, /\bdc\b/i, /(home|away)\s*or\s*draw/i],
    selections: {
      home_draw: [/^(home|1).*(draw|x)/i, /home\/draw/i, /1x/i, /home\s*or\s*draw/i],
      home_away: [/^(home|1).*(away|2)/i, /home\/away/i, /12/i, /home\s*or\s*away/i],
      draw_away: [/^(draw|x).*(away|2)/i, /draw\/away/i, /x2/i, /draw\s*or\s*away/i],
    },
    defaultLine: null,
  },
  team_to_score: {
    category: 'team_goals',
    type: 'team_to_score',
    period: 'full_time',
    aliases: [/team\s*to\s*score/i, /(home|away)\s*(team)?\s*score/i, /which\s*team\s*scores/i],
    selections: {
      home: [/^home\b/i, /home\s*only/i],
      away: [/^away\b/i, /away\s*only/i],
      both: [/both/i, /either/i],
      none: [/neither/i, /no\s*team/i, /none/i],
    },
    defaultLine: null,
  },
};

// Mappage des noms de selection connus -> canonique (renforce le classifier)
const SELECTION_SYNONYMS = {
  over: 'over', ou: 'over', o: 'over', more: 'over', high: 'over',
  under: 'under', un: 'under', u: 'under', less: 'under', lower: 'under', low: 'under',
  yes: 'yes', y: 'yes', gg: 'yes', both: 'yes',
  no: 'no', n: 'no', ng: 'no',
  home: 'home', h: 'home', '1': 'home',
  draw: 'draw', x: 'draw', d: 'draw',
  away: 'away', a: 'away', '2': 'away',
};

function lookup(marketId) {
  return MARKET_REGISTRY[marketId] || null;
}

module.exports = { MARKET_REGISTRY, SELECTION_SYNONYMS, lookup };

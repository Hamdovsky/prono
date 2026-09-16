/**
 * oddsportalLeagues.js — E48 mapping "league (DB)" -> slug OddsPortal.
 *
 * Cible UNIQUEMENT les ligues obscures (celles SANS couverture BetExplorer /
 * football-data, cf. E44/E47). Les 9 ligues deja couvertes (LaLiga, National
 * League, DBU Pokalen, Regionalliga Nordost, Egypt PL, MLS Next Pro, Primera
 * Division, USL Championship, Allsvenskan) sont volontairement ABSENTES : pas
 * de duplication d'effort.
 *
 * Les slugs ont ete verifies empiriquement pendant la session E48 (probing
 * OddsPortal headless : 8/8 pages 200, 7/8 avec cotes).
 *
 * Cle = league.toLowerCase().trim() tel qu'il apparait dans matches.league.
 */

const LEAGUE_TO_SLUG = {
  // Serie D (9 groupes, ~81 matchs sur la queue type)
  'serie d: group a': 'italy/serie-d-group-a',
  'serie d: group b': 'italy/serie-d-group-b',
  'serie d: group c': 'italy/serie-d-group-c',
  'serie d: group d': 'italy/serie-d-group-d',
  'serie d: group e': 'italy/serie-d-group-e',
  'serie d: group f': 'italy/serie-d-group-f',
  'serie d: group g': 'italy/serie-d-group-g',
  'serie d: group h': 'italy/serie-d-group-h',
  'serie d: group i': 'italy/serie-d-group-i',
  'serie d': 'italy/serie-d-group-a',

  // Serie C (groupes - couverture partielle, ligue presente)
  'serie c: group a': 'italy/serie-c-group-a',
  'serie c: group b': 'italy/serie-c-group-b',
  'serie c: group c': 'italy/serie-c-group-c',

  // Allemagne basse division
  'regionalliga nord': 'germany/regionalliga-north',
  'regionalliga nordost': 'germany/regionalliga-nordost',
  'regionalliga west': 'germany/regionalliga-west',
  'oberliga: niedersachsen': 'germany/oberliga-niedersachsen',

  // Norvege
  'nm cup: round 2': 'norway/nm-cup',
  'nm cup: round 3': 'norway/nm-cup',
  'nm cup': 'norway/nm-cup',
  'division 2: group 2': 'norway/division-2-group-2',
  '2.division norrland: promotion group': 'norway/division-2-group-2',
  'division 1: north': 'norway/division-1-north',
  'division 1: south': 'norway/division-1-south',

  // Roumanie
  'liga 2': 'romania/liga-2',

  // Divers obscurs presents dans la queue
  'national division': 'malta/national-division',
  'prva liga': 'slovenia/prva-liga',
  'parva liga': 'bulgaria/parva-liga',
  'meistriliiga': 'estonia/meistriliiga',
  'virsliga': 'latvia/virsliga',
  'a lyga': 'lithuania/a-lyga',
  '2. snl': 'slovenia/2-snl',
  '1st league: rs': 'bosnia-and-herzegovina/prva-liga-rs',
  'ligue i': 'azerbaijan/i-liqa',
}

function slugForLeague(league) {
  if (!league) return null
  const k = String(league).toLowerCase().trim()
  return LEAGUE_TO_SLUG[k] || null
}

function allSlugs() {
  return [...new Set(Object.values(LEAGUE_TO_SLUG))]
}

function knownLeagues() {
  return Object.keys(LEAGUE_TO_SLUG)
}

module.exports = { LEAGUE_TO_SLUG, slugForLeague, allSlugs, knownLeagues }

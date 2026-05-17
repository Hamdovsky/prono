// ✅ NETTOYEUR ET NORMALISATEUR DE NOMS D'ÉQUIPES
// Supprime tous les suffixes, doublons, variations et erreurs courantes

const TEAM_SUFFIXES = [
    ' FC', ' F.C.', ' F.C', '.FC', ' AFC', ' A.F.C', ' SC', ' S.C.',
    ' CF', ' C.F.', ' US', ' U.S.', ' AS', ' A.S.', ' AC', ' A.C.',
    ' FK', ' SK', ' SV', ' CA', ' CD', ' CP', ' CR', ' CS', ' NK',
    ' RC', ' R.C.', ' SS', ' S.S.', ' UC', ' U.D.', ' AD', ' AE', ' AL',
    ' United', ' City', ' Town', ' Wanderers', ' Rovers', ' Rangers',
    ' Athletic', ' Club', ' Sporting', ' Sport', ' Deportivo', ' Deportivo',
    ' Real', ' Racing', ' Union', ' Internationale', ' Inter',
    ' Boys', ' Girls', ' Youth', ' Academy', ' Reserves', ' Reserve', ' B Team',
    ' II', ' III', ' IV', ' 2', ' 3', ' U17', ' U18', ' U19', ' U20', ' U21', ' U23'
].sort((a,b) => b.length - a.length);

const COMMON_VARIATIONS = {
    'paris': 'psg',
    'paris saint germain': 'psg',
    'psg': 'psg',
    'manchester united': 'man utd',
    'man utd': 'man utd',
    'manchester city': 'man city',
    'man city': 'man city',
    'tottenham': 'spurs',
    'spurs': 'spurs',
    'arsenal': 'arsenal',
    'chelsea': 'chelsea',
    'liverpool': 'liverpool',
    'barcelona': 'barca',
    'barca': 'barca',
    'real madrid': 'real madrid',
    'atletico madrid': 'atletico',
    'bayern munich': 'bayern',
    'bayern': 'bayern',
    'dortmund': 'dortmund',
    'borussia dortmund': 'dortmund',
    'juventus': 'juve',
    'juve': 'juve',
    'milan': 'ac milan',
    'ac milan': 'ac milan',
    'inter': 'inter',
    'inter milan': 'inter',
    'napoli': 'napoli',
    'roma': 'roma',
    'lazio': 'lazio',
    'lyon': 'lyon',
    'marseille': 'marseille',
    'monaco': 'monaco',
    'lille': 'lille',
    'rennes': 'rennes'
};

const RESERVE_PATTERNS = [
    /\b(II|III|IV|B|C|U\d{2}|U-\d{2}|Reserves?|Youth|Academy|Reserve|Filial|Amateurs?)\b/i,
    /\(U\d{2}\)/i, /\bDev(elopment)?\b/i, /\bJuniors?\b/i, /\bB\s*Team\b/i
];

const normalizeTeamName = (name) => {
    if (!name || typeof name !== 'string') return '';
    
    let clean = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    clean = clean.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    clean = clean.replace(/\s+/g, ' ');
    
    for (const suffix of TEAM_SUFFIXES) {
        if (clean.toLowerCase().endsWith(suffix.toLowerCase())) {
            clean = clean.slice(0, -suffix.length).trim();
        }
    }
    
    clean = clean.replace(/\s+/g, ' ').trim();
    
    const lower = clean.toLowerCase();
    if (COMMON_VARIATIONS[lower]) {
        return COMMON_VARIATIONS[lower];
    }
    
    return clean;
};

const isReserveTeam = (name) => {
    if (!name) return false;
    return RESERVE_PATTERNS.some(re => re.test(name));
};

const teamsMatch = (a, b) => {
    if (!a || !b) return false;
    const normA = normalizeTeamName(a).toLowerCase();
    const normB = normalizeTeamName(b).toLowerCase();
    
    if (normA === normB) return true;
    if (normA.includes(normB) || normB.includes(normA)) return true;
    if (COMMON_VARIATIONS[normA] === COMMON_VARIATIONS[normB]) return true;
    
    return false;
};

const deduplicateMatches = (matches) => {
    const seen = new Map();
    const cleaned = [];
    
    for (const match of matches) {
        if (!match.homeTeam || !match.awayTeam) continue;
        if (isReserveTeam(match.homeTeam) || isReserveTeam(match.awayTeam)) continue;
        
        const key = `${normalizeTeamName(match.homeTeam).toLowerCase()}|${normalizeTeamName(match.awayTeam).toLowerCase()}`;
        
        if (!seen.has(key)) {
            seen.set(key, true);
            match.homeTeamNormalized = normalizeTeamName(match.homeTeam);
            match.awayTeamNormalized = normalizeTeamName(match.awayTeam);
            cleaned.push(match);
        }
    }
    
    return cleaned;
};

export {
    normalizeTeamName,
    isReserveTeam,
    teamsMatch,
    deduplicateMatches
};

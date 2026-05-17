/**
 * Titanium League Registry — Betting-Covered Football Leagues 2026
 * Only leagues found on major betting sites (Bet365, 1xBet, Unibet, Betway, etc.)
 * Includes: Botola Pro (MAR), Egyptian Premier League (EGY), Tunisian Ligue 1 (TUN), etc.
 */

const LEAGUES = [
    // ── EUROPEAN BIG 5 ──────────────────────────
    {
        id: 'ENG_PL', name: 'Premier League', displayName: 'Premier League',
        country: 'england', countryCode: 'ENG', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', tier: 'ELITE',
        sofascoreSlug: 'premier-league', syncPriority: 'HIGH',
        webhookEnabled: true, smartScanEnabled: true,
    },
    {
        id: 'ESP_LL', name: 'LaLiga', displayName: 'La Liga',
        country: 'spain', countryCode: 'ESP', flag: '🇪🇸', tier: 'ELITE',
        sofascoreSlug: 'laliga', syncPriority: 'HIGH',
        webhookEnabled: true, smartScanEnabled: true,
    },
    {
        id: 'ITA_SA', name: 'Serie A', displayName: 'Serie A',
        country: 'italy', countryCode: 'ITA', flag: '🇮🇹', tier: 'ELITE',
        sofascoreSlug: 'serie-a', syncPriority: 'HIGH',
        webhookEnabled: true, smartScanEnabled: true,
    },
    {
        id: 'GER_BL', name: 'Bundesliga', displayName: 'Bundesliga',
        country: 'germany', countryCode: 'GER', flag: '🇩🇪', tier: 'ELITE',
        sofascoreSlug: 'bundesliga', syncPriority: 'HIGH',
        webhookEnabled: true, smartScanEnabled: true,
    },
    {
        id: 'FRA_L1', name: 'Ligue 1', displayName: 'Ligue 1',
        country: 'france', countryCode: 'FRA', flag: '🇫🇷', tier: 'ELITE',
        sofascoreSlug: 'ligue-1', syncPriority: 'HIGH',
        webhookEnabled: true, smartScanEnabled: true,
    },

    // ── TOP CONTINENTAL TIER ────────────────────
    {
        id: 'NED_ER', name: 'Eredivisie', displayName: 'Eredivisie',
        country: 'netherlands', countryCode: 'NED', flag: '🇳🇱', tier: 'TIER1',
        sofascoreSlug: 'eredivisie', syncPriority: 'HIGH',
        webhookEnabled: true, smartScanEnabled: true,
    },
    {
        id: 'POR_LP', name: 'Primeira Liga', displayName: 'Primeira Liga',
        country: 'portugal', countryCode: 'POR', flag: '🇵🇹', tier: 'TIER1',
        sofascoreSlug: 'liga-portugal', syncPriority: 'HIGH',
        webhookEnabled: true, smartScanEnabled: true,
    },
    {
        id: 'BRA_SA', name: 'Brasileirão Serie A', displayName: 'Brasileirão',
        country: 'brazil', countryCode: 'BRA', flag: '🇧🇷', tier: 'TIER1',
        sofascoreSlug: 'brasileirao-serie-a', syncPriority: 'HIGH',
        webhookEnabled: true, smartScanEnabled: true,
    },

    // ── PREMIUM ARAB (Bet365 / 1xBet covered) ───
    {
        id: 'KSA_SP', name: 'Saudi Pro League', displayName: 'Saudi Pro League',
        country: 'saudi-arabia', countryCode: 'KSA', flag: '🇸🇦', tier: 'TIER1',
        sofascoreSlug: 'saudi-pro-league', sofascoreId: 955, syncPriority: 'HIGH',
        forceSync: true, webhookEnabled: true, smartScanEnabled: true,
        arabicNewsEnabled: true,
        newsSources: [
            { name: 'Kooora KSA', url: 'https://sa.kooora.com/?rss', lang: 'ar' },
            { name: 'Sada Al-Malaaeb', url: 'https://www.sadalmalaaeb.com/rss.xml', lang: 'ar' },
        ],
    },
    {
        id: 'MAR_BP', name: 'Botola Pro', displayName: 'Botola Pro',
        country: 'morocco', countryCode: 'MAR', flag: '🇲🇦', tier: 'TIER2',
        sofascoreSlug: 'botola-pro', sofascoreId: 937, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'TUN_L1', name: 'Tunisian Ligue 1', displayName: 'Ligue Professionnelle 1',
        country: 'tunisia', countryCode: 'TUN', flag: '🇹🇳', tier: 'TIER2',
        sofascoreSlug: 'ligue-1', sofascoreId: 984, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'EGY_PL', name: 'Egyptian Premier League', displayName: 'Egyptian Premier League',
        country: 'egypt', countryCode: 'EGY', flag: '🇪🇬', tier: 'TIER1',
        sofascoreSlug: 'premier-league', sofascoreId: 808, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'ALG_L1', name: 'Algerian Ligue 1', displayName: 'Algerian Ligue 1',
        country: 'algeria', countryCode: 'ALG', flag: '🇩🇿', tier: 'TIER2',
        sofascoreSlug: 'ligue-1', sofascoreId: 841, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'UAE_PL', name: 'UAE Pro League', displayName: 'UAE Pro League',
        country: 'uae', countryCode: 'UAE', flag: '🇦🇪', tier: 'TIER1',
        sofascoreSlug: 'uae-pro-league', sofascoreId: 981, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'QAT_SL', name: 'Stars League', displayName: 'Qatar Stars League',
        country: 'qatar', countryCode: 'QAT', flag: '🇶🇦', tier: 'TIER1',
        sofascoreSlug: 'stars-league', sofascoreId: 978, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'KUW_PL', name: 'Kuwait League', displayName: 'Kuwaiti Premier League',
        country: 'kuwait', countryCode: 'KUW', flag: '🇰🇼', tier: 'TIER2',
        sofascoreSlug: 'kuwait-league', sofascoreId: 980, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'IRQ_SL', name: 'Iraq Stars League', displayName: 'Iraq Stars League',
        country: 'iraq', countryCode: 'IRQ', flag: '🇮🇶', tier: 'TIER2',
        sofascoreSlug: 'iraq-stars-league', sofascoreId: 11261, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'JOR_PL', name: 'Jordan Pro League', displayName: 'Jordan Pro League',
        country: 'jordan', countryCode: 'JOR', flag: '🇯🇴', tier: 'TIER2',
        sofascoreSlug: 'jordan-pro-league', sofascoreId: 410, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'OMA_PL', name: 'Oman Professional League', displayName: 'Oman Professional League',
        country: 'oman', countryCode: 'OMA', flag: '🇴🇲', tier: 'TIER2',
        sofascoreSlug: 'oman-professional-league', sofascoreId: 3043, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'LBY_PL', name: 'Libyan Premier League', displayName: 'Libyan Premier League',
        country: 'libya', countryCode: 'LBY', flag: '🇱🇾', tier: 'TIER2',
        sofascoreSlug: 'libyan-premier-league', sofascoreId: 3047, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'LBN_PL', name: 'Lebanese Premier League', displayName: 'Lebanese Premier League',
        country: 'lebanon', countryCode: 'LBN', flag: '🇱🇧', tier: 'TIER2',
        sofascoreSlug: 'lebanese-premier-league', sofascoreId: 3831, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'SYR_PL', name: 'Syrian Premier League', displayName: 'Syrian Premier League',
        country: 'syria', countryCode: 'SYR', flag: '🇸🇾', tier: 'TIER2',
        sofascoreSlug: 'syrian-premier-league', sofascoreId: 1243, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'BHR_PL', name: 'Bahraini Premier League', displayName: 'Bahraini Premier League',
        country: 'bahrain', countryCode: 'BHR', flag: '🇧🇭', tier: 'TIER2',
        sofascoreSlug: 'bahraini-premier-league', sofascoreId: 846, syncPriority: 'MEDIUM',
        forceSync: true, arabicNewsEnabled: true,
    },
    {
        id: 'RSA_PL', name: 'South African Premier Division', displayName: 'PSL',
        country: 'south-africa', countryCode: 'RSA', flag: '🇿🇦', tier: 'TIER2',
        sofascoreSlug: 'premier-soccer-league', syncPriority: 'MEDIUM',
    },
    {
        id: 'ENG_PL2', name: 'Premier League 2, Division 1', displayName: 'Premier League 2',
        country: 'england', countryCode: 'ENG', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', tier: 'TIER2',
        sofascoreSlug: 'premier-league-2-division-1', sofascoreId: 1129,
        syncPriority: 'MEDIUM', forceSync: true,
    },
    {
        id: 'ENG_L1', name: 'League One', displayName: 'League One',
        country: 'england', countryCode: 'ENG', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', tier: 'TIER2',
        sofascoreSlug: 'league-one', sofascoreId: 44,
        syncPriority: 'MEDIUM', forceSync: true,
        webhookEnabled: true, smartScanEnabled: true,
    },
    {
        id: 'ENG_NL', name: 'National League', displayName: 'National League',
        country: 'england', countryCode: 'ENG', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', tier: 'TIER3',
        sofascoreSlug: 'national-league', sofascoreId: 173,
        syncPriority: 'MEDIUM', forceSync: true,
        webhookEnabled: true, smartScanEnabled: true,
    },
    {
        id: 'ENG_L2', name: 'League Two', displayName: 'League Two',
        country: 'england', countryCode: 'ENG', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', tier: 'TIER2',
        sofascoreSlug: 'league-two', sofascoreId: 45,
        syncPriority: 'MEDIUM', forceSync: true,
        webhookEnabled: true, smartScanEnabled: true,
    },

];

const LEAGUE_MAP = Object.fromEntries(LEAGUES.map(l => [l.id, l]));
const ELITE_LEAGUES = LEAGUES.filter(l => l.tier === 'ELITE');
const MENA_LEAGUES = LEAGUES.filter(l => l.arabicNewsEnabled);

module.exports = { LEAGUES, LEAGUE_MAP, ELITE_LEAGUES, MENA_LEAGUES };

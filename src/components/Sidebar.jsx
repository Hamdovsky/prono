import React from 'react';
import './Sidebar.css';

const PINNED_LEAGUES = [
    { id: 'en_pr', name: 'Angleterre : Premier League', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', keywords: ['premier league', 'epl'] },
    { id: 'en_ch', name: 'Angleterre : Championship', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', keywords: ['championship'] },
    { id: 'en_l1', name: 'Angleterre : League One', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', keywords: ['league one'] },
    { id: 'en_l2', name: 'Angleterre : League Two', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', keywords: ['league two'] },
    { id: 'en_nl', name: 'Angleterre : National League', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', keywords: ['national league'] },
    { id: 'fr_l1', name: 'France : Ligue 1', flag: '🇫🇷', keywords: ['ligue 1', 'france'] },
    { id: 'es_ll', name: 'Espagne : LaLiga', flag: '🇪🇸', keywords: ['LaLiga', 'la liga', 'laliga', 'spain', 'es liga'] },
    { id: 'it_sa', name: 'Italie : Serie A', flag: '🇮🇹', keywords: ['serie a', 'italy'] },
    { id: 'de_bl', name: 'Allemagne : Bundesliga', flag: '🇩🇪', keywords: ['bundesliga', 'germany'] },
    { id: 'pt_lp', name: 'Portugal : Liga Portugal', flag: '🇵🇹', keywords: ['liga portugal', 'primeira', 'portugal'] },
    { id: 'eu_cl', name: 'UEFA : Champions League', flag: '🇪🇺', keywords: ['champions league', 'uefa'] },
    { id: 'eu_el', name: 'UEFA : Europa League', flag: '🇪🇺', keywords: ['europa league'] },
    { id: 'br_sa', name: 'Brésil : Brasileirão', flag: '🇧🇷', keywords: ['brasileiro', 'brazil'] },

];

const MENA_LEAGUES = [
    { id: 'ma_bp', name: 'Maroc : Botola Pro', flag: '🇲🇦', keywords: ['botola', 'morocco'] },
    { id: 'tn_l1', name: 'Tunisie : Ligue 1', flag: '🇹🇳', keywords: ['tunisian', 'tunisia'] },
    { id: 'sa_pl', name: 'Arabie S. : Saudi Pro', flag: '🇸🇦', keywords: ['saudi', 'al-nassr', 'al-hilal', 'al-ittihad', 'al-ahli'] },
    { id: 'eg_pl', name: 'Égypte : Egyptian Premier', flag: '🇪🇬', keywords: ['egyptian', 'egypt'] },
    { id: 'dz_l1', name: 'Algérie : Ligue 1', flag: '🇩🇿', keywords: ['algerian', 'algeria'] },
    { id: 'ae_pl', name: 'Émirats : UAE Pro League', flag: '🇦🇪', keywords: ['uae pro', 'united arab emirates'] },
    { id: 'qa_sl', name: 'Qatar : Stars League', flag: '🇶🇦', keywords: ['stars league', 'qatar'] },
    { id: 'kw_pl', name: 'Koweït : Kuwait League', flag: '🇰🇼', keywords: ['kuwait'] },
    { id: 'iq_sl', name: 'Irak : Iraq Stars League', flag: '🇮🇶', keywords: ['iraq stars', 'iraq'] },
    { id: 'jo_pl', name: 'Jordanie : Jordan Pro League', flag: '🇯🇴', keywords: ['jordan pro', 'jordan'] },
    { id: 'om_pl', name: 'Oman : Oman Pro League', flag: '🇴🇲', keywords: ['oman professional', 'oman'] },
    { id: 'ly_pl', name: 'Libye : Libyan Premier', flag: '🇱🇾', keywords: ['libyan premier', 'libya'] },
    { id: 'lb_pl', name: 'Liban : Lebanese Premier', flag: '🇱🇧', keywords: ['lebanese premier', 'lebanon'] },
    { id: 'sy_pl', name: 'Syrie : Syrian Premier', flag: '🇸🇾', keywords: ['syrian premier', 'syria'] },
    { id: 'bh_pl', name: 'Bahreïn : Bahraini Premier', flag: '🇧🇭', keywords: ['bahraini premier', 'bahrain'] }
];

const Sidebar = ({ activeLeague, onLeagueChange, matches = [], activeView, onViewChange, activeDate, onDateChange }) => {
    
    const activeCounts = {};
    const todayStr = new Date().toLocaleDateString();
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString();

    matches.forEach(m => {
        let dateMs = null;
        if (m.startTimestamp) {
            dateMs = m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000;
        } else if (m.timestamp) {
            dateMs = new Date(m.timestamp).getTime();
        } else if (m.startTime) {
            dateMs = new Date(m.startTime).getTime();
        } else if (m.date) {
            dateMs = new Date(m.date).getTime();
        }

        if (!dateMs) return;
        const matchDayStr = new Date(dateMs).toLocaleDateString();

        if (activeDate === "Today" && matchDayStr !== todayStr) return;
        if (activeDate === "Tomorrow" && matchDayStr !== tomorrowStr) return;
        if (activeDate === "Next 3 Days") {
            const threeDays = Date.now() + (3 * 24 * 60 * 60 * 1000);
            if (dateMs < Date.now() - 3600000 || dateMs > threeDays) return;
        }
        if (activeDate === "Next 7 Days") {
            const sevenDays = Date.now() + (7 * 24 * 60 * 60 * 1000);
            if (dateMs < Date.now() - 3600000 || dateMs > sevenDays) return;
        }

        const l = (m.league || 'Unknown').toLowerCase();
        activeCounts[l] = (activeCounts[l] || 0) + 1;
    });

    const pinnedWithCounts = PINNED_LEAGUES.map(pinned => {
        let count = 0;
        Object.keys(activeCounts).forEach(activeLeagueName => {
            if (pinned.keywords.some(kw => activeLeagueName.includes(kw))) {
                count += activeCounts[activeLeagueName];
            }
        });
        return { ...pinned, count };
    });

    const menaWithCounts = MENA_LEAGUES.map(mena => {
        let count = 0;
        Object.keys(activeCounts).forEach(activeLeagueName => {
            if (mena.keywords.some(kw => activeLeagueName.includes(kw))) {
                count += activeCounts[activeLeagueName];
            }
        });
        return { ...mena, count };
    });

    const isPinnedOrMena = (leagueName) => {
        const lower = leagueName.toLowerCase();
        return PINNED_LEAGUES.some(p => p.keywords.some(kw => lower.includes(kw))) ||
               MENA_LEAGUES.some(m => m.keywords.some(kw => lower.includes(kw)));
    };

    const getCountryForOther = (name) => {
        const lower = name.toLowerCase();
        if (lower.includes('algerian')) return '🇩🇿 Algérie : ';
        if (lower.includes('tunisian')) return '🇹🇳 Tunisie : ';
        if (lower.includes('egyptian')) return '🇪🇬 Égypte : ';
        if (lower.includes('moroccan') || lower.includes('botola')) return '🇲🇦 Maroc : ';
        if (lower.includes('premier league')) return '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Angleterre : ';
        if (lower.includes('laliga')) return '🇪🇸 Espagne : ';
        if (lower.includes('serie a')) return '🇮🇹 Italie : ';
        if (lower.includes('bundesliga')) return '🇩🇪 Allemagne : ';
        if (lower.includes('brazil')) return '🇧🇷 Brésil : ';
        if (lower.includes('usa') || lower.includes('mls')) return '🇺🇸 USA : ';
        return '⚽ ';
    };

    const otherLeagues = Object.entries(activeCounts)
        .filter(([name]) => !isPinnedOrMena(name))
        .map(([name, count]) => ({
            id: name,
            name: (getCountryForOther(name) + name.replace(/^([A-Za-z]+ )(\1)/i, '$1').toUpperCase()).substring(0, 35),
            count
        }))
        .sort((a,b) => a.name.localeCompare(b.name));

    const totalFilteredMatches = Object.values(activeCounts).reduce((a, b) => a + b, 0);

    return (
        <aside className="flash-sidebar">
            <div className="flash-sidebar-header">
                <h2>Laboratoir Hamdi</h2>
            </div>
            
            <div className="flash-nav-section">
                {/* ── NEW: ALL MATCHES SCANNER ────────────────────── */}
                <button 
                  className={`flash-nav-item ${activeView === 'all-matches' ? 'active' : ''}`}
                  onClick={() => onViewChange?.('all-matches')}
                  style={{
                    background: activeView === 'all-matches'
                        ? 'linear-gradient(90deg, rgba(148,163,184,0.15) 0%, transparent 100%)'
                        : 'transparent',
                    borderLeft: activeView === 'all-matches' ? '2px solid #94a3b8' : 'none',
                    color: '#94a3b8',
                    marginBottom: '8px'
                  }}
                >
                    <span className="flash-icon">📊</span>
                    <span className="flash-label" style={{ fontWeight: 'bold' }}>TOUS LES MATCHS</span>
                    <span className="flash-count" style={{ background: '#334155', color: '#fff', padding: '1px 6px', borderRadius: '4px' }}>
                        {totalFilteredMatches}
                    </span>
                </button>

                {/* ── NEW: Adaptive Learning AI ────────────────────── */}
                <button 
                  className={`flash-nav-item ${activeView === 'learning' ? 'active' : ''}`}
                  onClick={() => onViewChange?.('learning')}
                  style={{
                    marginTop: '4px',
                    background: activeView === 'learning'
                        ? 'linear-gradient(90deg, rgba(129,140,248,0.15) 0%, transparent 100%)'
                        : 'transparent',
                    borderLeft: activeView === 'learning' ? '2px solid #818cf8' : 'none',
                    color: '#818cf8'
                  }}
                >
                    <span className="flash-icon">🧠</span>
                    <span className="flash-label" style={{ fontWeight: 'bold' }}>Adaptive Learning AI</span>
                </button>

                <button 
                  className={`flash-nav-item ${activeView === 'millionaire' ? 'active' : ''}`}
                  onClick={() => onViewChange?.('millionaire')}
                  style={{
                    marginTop: '4px',
                    background: activeView === 'millionaire'
                        ? 'linear-gradient(90deg, rgba(251,191,36,0.15) 0%, transparent 100%)'
                        : 'transparent',
                    borderLeft: activeView === 'millionaire' ? '2px solid #fbbf24' : 'none',
                    color: '#fbbf24'
                  }}
                >
                    <span className="flash-icon">💰</span>
                    <span className="flash-label" style={{ fontWeight: 'bold' }}>Millionaire Selection</span>
                </button>

                {/* ── NEW: System Intelligence ────────────────────── */}
                <button 
                  className={`flash-nav-item ${activeView === 'intel' ? 'active' : ''}`}
                  onClick={() => onViewChange?.('intel')}
                  style={{
                    marginTop: '4px',
                    background: activeView === 'intel'
                        ? 'linear-gradient(90deg, rgba(56,189,248,0.15) 0%, transparent 100%)'
                        : 'transparent',
                    borderLeft: activeView === 'intel' ? '2px solid #38bdf8' : 'none',
                    color: '#38bdf8'
                  }}
                >
                    <span className="flash-icon">🛡️</span>
                    <span className="flash-label" style={{ fontWeight: 'bold' }}>System Intelligence</span>
                </button>

                {/* ── NEW: Promosport ────────────────────── */}
                <button 
                  className={`flash-nav-item ${activeView === 'promosport' ? 'active' : ''}`}
                  onClick={() => onViewChange?.('promosport')}
                  style={{
                    marginTop: '4px',
                    background: activeView === 'promosport'
                        ? 'linear-gradient(90deg, rgba(16,185,129,0.15) 0%, transparent 100%)'
                        : 'transparent',
                    borderLeft: activeView === 'promosport' ? '2px solid #10b981' : 'none',
                    color: '#10b981'
                  }}
                >
                    <span className="flash-icon">💰</span>
                    <span className="flash-label" style={{ fontWeight: 'bold' }}>TeleMatch / Promosport IA</span>
                </button>

                {/* ── NEW: Titanium Evolution ────────────────────── */}
                <button 
                  className={`flash-nav-item ${activeView === 'evolution' ? 'active' : ''}`}
                  onClick={() => onViewChange?.('evolution')}
                  style={{
                    marginTop: '4px',
                    background: activeView === 'evolution'
                        ? 'linear-gradient(90deg, rgba(236,72,153,0.15) 0%, transparent 100%)'
                        : 'transparent',
                    borderLeft: activeView === 'evolution' ? '2px solid #ec4899' : 'none',
                    color: '#ec4899'
                  }}
                >
                    <span className="flash-icon">🧬</span>
                    <span className="flash-label" style={{ fontWeight: 'bold' }}>Titanium Evolution</span>
                </button>
            </div>

            <div className="flash-nav-section">
                <h3 className="flash-section-title" style={{ color: '#64748b' }}>📅 FILTRE TEMPOREL</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', padding: '0 12px 12px' }}>
                    {["Today", "Tomorrow", "Next 3 Days", "Next 7 Days"].map(date => {
                        const labels = {
                            "Today": "AUJOURD'HUI",
                            "Tomorrow": "DEMAIN",
                            "Next 3 Days": "3 PROCHAINS JOURS",
                            "Next 7 Days": "7 PROCHAINS JOURS"
                        };
                        return (
                            <button
                                key={date}
                                className={`date-filter-btn ${activeDate === date ? 'active' : ''}`}
                                onClick={() => onDateChange?.(date)}
                                style={{
                                    padding: '8px 6px',
                                    fontSize: '11px',
                                    background: activeDate === date ? '#f59e0b' : 'rgba(255,255,255,0.06)',
                                    color: activeDate === date ? '#000' : '#cbd5e1',
                                    border: activeDate === date ? 'none' : '1px solid rgba(255,255,255,0.1)',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontWeight: activeDate === date ? '800' : '500',
                                    letterSpacing: '0.3px',
                                    transition: 'all 0.15s',
                                    fontFamily: "'JetBrains Mono', monospace"
                                }}
                            >
                                {labels[date]}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="flash-nav-section">
                <h3 className="flash-section-title" style={{ color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '8px' }}>
                     🏆 LIGUES ACTIVES
                </h3>
                
                {/* 1. Merged Fixed/Best Leagues at top if active */}
                {pinnedWithCounts.filter(l => l.count > 0).map(league => (
                    <button 
                        key={league.id} 
                        className={`flash-nav-item ${activeLeague === league.keywords[0] ? 'active' : ''}`}
                        onClick={() => { onViewChange?.('matches'); onLeagueChange(league.keywords[0]); }}
                        style={{ borderLeft: activeLeague === league.keywords[0] ? '2px solid #f59e0b' : 'none' }}
                    >
                        <span className="flash-icon">{league.flag}</span>
                        <span className="flash-label" style={{ fontWeight: '600' }}>{league.name}</span>
                        <span className="flash-count">{league.count}</span>
                    </button>
                ))}

                {/* 2. All other active leagues sorted alphabetically */}
                {otherLeagues.map(league => (
                    <button 
                        key={league.id} 
                        className={`flash-nav-item ${activeLeague === league.id ? 'active' : ''}`}
                        onClick={() => { onViewChange?.('matches'); onLeagueChange(league.id); }}
                    >
                        <span className="flash-icon">⚽</span>
                        <span className="flash-label">{league.name}</span>
                        <span className="flash-count">{league.count}</span>
                    </button>
                ))}

            </div>

            {menaWithCounts.some(l => l.count > 0) && (
                <div className="flash-nav-section">
                    <h3 className="flash-section-title" style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
                         🌙 MENA / MONDE ARABE
                    </h3>
                    
                    {menaWithCounts.filter(l => l.count > 0).map(league => (
                        <button 
                            key={league.id} 
                            className={`flash-nav-item ${activeLeague === league.keywords[0] ? 'active' : ''}`}
                            onClick={() => { onViewChange?.('matches'); onLeagueChange(league.keywords[0]); }}
                            style={{ borderLeft: activeLeague === league.keywords[0] ? '2px solid #10b981' : 'none' }}
                        >
                            <span className="flash-icon">{league.flag}</span>
                            <span className="flash-label" style={{ fontWeight: '600' }}>{league.name}</span>
                            <span className="flash-count">{league.count}</span>
                        </button>
                    ))}
                </div>
            )}

            <div className="flash-nav-section">
                {/* 3. Show fallback if absolutely no leagues are active */}
                {pinnedWithCounts.every(l => l.count === 0) && menaWithCounts.every(l => l.count === 0) && otherLeagues.length === 0 && (
                    <div style={{ padding: '20px', fontSize: '11px', color: '#64748b', textAlign: 'center', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
                        Aucune ligue active pour cette date.
                    </div>
                )}
            </div>

        </aside>
    );
};

export default Sidebar;

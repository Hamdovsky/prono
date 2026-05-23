const { fetch } = require('undici'); // Will fail because we removed it! Wait!
// Actually, I can use native global fetch.

async function searchMatch() {
    const query = "Jabalain";
    const searchUrl = `https://www.sofascore.com/api/v1/search/all?q=${query}&page=0`;
    
    try {
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });
        const data = await response.json();
        
        const events = data?.results?.filter(r => r.type === 'event' && r.entity?.homeTeam && r.entity?.awayTeam) || [];
        
        let targetEvent = events.find(e => 
            (e.entity.homeTeam.name.toLowerCase().includes('diriyah') || e.entity.homeTeam.name.toLowerCase().includes('draih') || e.entity.homeTeam.name.toLowerCase().includes('jabal')) &&
            (e.entity.awayTeam.name.toLowerCase().includes('diriyah') || e.entity.awayTeam.name.toLowerCase().includes('draih') || e.entity.awayTeam.name.toLowerCase().includes('jabal'))
        );
        
        // If exact match not found, just take the first upcoming Jabalain event
        if (!targetEvent) {
            targetEvent = events.find(e => e.entity.status?.type === 'notstarted' || e.entity.status?.type === 'inprogress');
        }

        if (targetEvent) {
            const match = targetEvent.entity;
            console.log(`Match trouvé sur Sofascore : ${match.homeTeam.name} vs ${match.awayTeam.name}`);
            console.log(`ID Sofascore : ${match.id}`);
            console.log(`Ligue : ${match.tournament?.name}`);
            
            // Fetch odds
            const oddsUrl = `https://www.sofascore.com/api/v1/event/${match.id}/odds/1/all`;
            const oddsRes = await fetch(oddsUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
            if (oddsRes.ok) {
                const oddsData = await oddsRes.json();
                const market1x2 = oddsData?.markets?.find(m => m.marketId === 1 || m.marketName?.toLowerCase().includes('result'));
                if (market1x2 && market1x2.choices) {
                    let h=null, d=null, a=null;
                    market1x2.choices.forEach(c => {
                        const name = c.name?.toLowerCase();
                        const val = parseFloat(c.fractionalValue ? (eval(c.fractionalValue)+1) : c.decimalValue) || 0;
                        if (name === '1' || name === 'home') h = val;
                        else if (name === 'x' || name === 'draw') d = val;
                        else if (name === '2' || name === 'away') a = val;
                    });
                    console.log(`Cotes : 1 (${h}) | X (${d}) | 2 (${a})`);
                    
                    // Simple probability calculation based on odds (implied probability)
                    if (h && d && a) {
                        const probH = (1 / h) * 100;
                        const probD = (1 / d) * 100;
                        const probA = (1 / a) * 100;
                        const margin = (probH + probD + probA) - 100;
                        
                        const realH = probH - (margin * (probH / 100));
                        const realD = probD - (margin * (probD / 100));
                        const realA = probA - (margin * (probA / 100));
                        
                        console.log(`\nProbabilités Implicites (Sans Marge) :`);
                        console.log(`1 : ${realH.toFixed(1)}%`);
                        console.log(`X : ${realD.toFixed(1)}%`);
                        console.log(`2 : ${realA.toFixed(1)}%`);
                        
                        let prono = "1";
                        if (realA > realH && realA > realD) prono = "2";
                        else if (realD > realH && realD > realA) prono = "X";
                        
                        console.log(`\n👉 Pronostic : ${prono}`);
                    }
                } else {
                    console.log("Cotes non disponibles.");
                }
            }
            
        } else {
            console.log("Match introuvable sur Sofascore en live search.");
        }
    } catch (e) {
        console.error("Erreur API :", e.message);
    }
}

searchMatch();

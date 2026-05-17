/**
 * NewsAnalysisService
 * المتخصص في تحليل الأخبار وتأثير الإصابات والغيابات على حالة الفريق.
 */

const NEG_KWS = ['injured', ' out ', 'out for', 'red card', 'suspended', 'ruled out', 'doubtful', 'sidelined', 'absent', 'unavailable', 'misses', 'missing'];
const POS_KWS = ['returned', ' available ', 'fit again', 'back in training', 'recovered', 'back from injury', 'returns to squad', 'cleared to play'];
const ROLE_WEIGHTS = {
    GK: -15, // Increased impact for keeper
    ST: -12, // Critical scorer
    DF: -8,  
    MD: -6,  
    ROT: -15, // Huge impact for second team/rotation
    MGR: 8   
};

const ROLE_KWS = {
    GK: ['keeper', 'goalkeeper', 'gk', 'goal keeper', 'حارس'],
    ST: ['striker', 'forward', 'goalscorer', 'top-scorer', 'leading scorer', 'هداف'],
    DF: ['defender', 'captain', 'center-back', 'centre-back', 'full-back', 'مدافع'],
    MD: ['midfield', 'midfielder', 'playmaker', 'cam ', ' dm ', 'وسط'],
    ROT: ['second team', 'reserve team', 'rotated', 'resting players', 'bench players', 'تشكيلة ثانية', 'احتياط', 'إراحة'],
    MGR: ['manager', 'head coach', 'gaffer', 'appointed as', 'مدرب']
};

class NewsAnalysisService {
    calculateNewsScore(headlines, confirmedInjuries = [], teamAvgRating = null) {
        if ((!headlines || headlines.length === 0) && (!confirmedInjuries || confirmedInjuries.length === 0)) {
            return { score: 0, attack: 1.0, defense: 1.0, chaos: 0, critical: [] };
        }

        let totalScore = 0;
        let attMod = 1.0;
        let defMod = 1.0;
        let chaosBoost = 0;
        let criticalNews = [];

        // ── Priority 1: Official confirmed injuries (Sofascore / Transfermarkt) ──
        for (const injury of (confirmedInjuries || [])) {
            const reason = (injury.reason || '').toLowerCase();
            const name   = (injury.name   || '').toLowerCase();
            const source = injury.source || 'unknown';
            const pos = (injury.position || '').toUpperCase();

            // Determine role and multiplier
            let roleWeight = -7; // default
            let isAtt = false, isDef = false, isGK = false;

            if (pos === 'G' || name.includes('keeper') || name.includes('portero') || reason.includes('gk')) {
                roleWeight = ROLE_WEIGHTS.GK;
                isGK = true;
            } else if (pos === 'F' || pos === 'M' || ROLE_KWS.ST.some(k => name.includes(k))) {
                roleWeight = pos === 'F' ? ROLE_WEIGHTS.ST : ROLE_WEIGHTS.MD;
                isAtt = true;
            } else if (pos === 'D' || ROLE_KWS.DF.some(k => name.includes(k))) {
                roleWeight = ROLE_WEIGHTS.DF;
                isDef = true;
            } else {
                roleWeight = -5;
                isAtt = true;
                isDef = true;
            }

            const officialBoost = source === 'sofascore_official' ? 1.2 : 1.0;
            if (['injury', 'illness', 'suspended', 'red card', 'unavailable', 'missing'].some(k => reason.includes(k)) || !reason) {
                let ratingMultiplier = (teamAvgRating && teamAvgRating >= 7.0) ? 1.2 : 1.0;
                const impact = Math.abs(roleWeight * officialBoost * ratingMultiplier) / 100;

                if (isGK || isDef) defMod += impact;
                if (isAtt) attMod -= impact;
                
                totalScore += Math.round(roleWeight * officialBoost * ratingMultiplier);
                criticalNews.push(`${name || 'Player'} OUT (${source.includes('sofa') ? 'Official' : 'TM'})`);
            }
        }

        // ── Priority 2: Keyword-based news headlines ──
        for (const headline of (headlines || [])) {
            const h = headline.toLowerCase();
            let importanceModifier = 1.0;
            
            if (h.includes('top scorer') || h.includes('leading scorer') || h.includes('هداف')) {
                 importanceModifier = 2.0; 
                 criticalNews.push("⚠️ TOP SCORER IMPACT");
            }

            if (h.includes('star ') || h.includes('key ') || h.includes('main ') || h.includes('first-choice')) importanceModifier = 1.5;

            if (ROLE_KWS.ROT.some(k => h.includes(k))) {
                totalScore += ROLE_WEIGHTS.ROT;
                attMod -= 0.15;
                defMod += 0.15;
                criticalNews.push("⚠️ SQUAD ROTATION DETECTED");
            }

            if (h.includes('late fitness test') || h.includes('doubtful') || h.includes('decision close to kick-off')) {
                chaosBoost += 5;
                criticalNews.push("LATE FITNESS TEST ⏳");
            }

            // ── News Negation Guard V2 ──
            const negations = ['no ', 'none ', 'zero ', 'without ', 'clear of', 'all fit', 'full squad'];
            const hasNegation = negations.some(n => h.includes(n));
            
            if (hasNegation && (h.includes('injury') || h.includes('absent') || h.includes('miss') || h.includes('suspension') || h.includes('suspended') || h.includes(' out'))) {
                totalScore += 5; // Slight boost for a clean bill of health
                criticalNews.push("✅ SQUAD CLEAR OF LIMITATIONS");
                continue; // Skip further negative checks for this headline
            }

            for (const [role, kws] of Object.entries(ROLE_KWS)) {
                if (role === 'ROT') continue;
                if (kws.some(k => h.includes(k))) {
                    const baseWeight = ROLE_WEIGHTS[role];
                    let impact = Math.abs(baseWeight * importanceModifier) / 100;
                    if (isNaN(impact)) impact = 0;
                    
                    // Check for Negatives
                    if (NEG_KWS.some(k => h.includes(k))) {
                        if (role === 'GK' || role === 'DF') defMod += impact;
                        if (role === 'ST') attMod -= impact;
                        totalScore += Math.round(baseWeight * importanceModifier);
                        criticalNews.push(`${role} OUT`);
                    } 
                    // [NEW] Check for Positives (Returns)
                    else if (POS_KWS.some(k => h.includes(k))) {
                        if (role === 'GK' || role === 'DF') defMod -= (impact * 0.5); // Recovery impact
                        if (role === 'ST') attMod += (impact * 0.5);
                        totalScore += Math.round(Math.abs(baseWeight) * 0.5 * importanceModifier);
                        criticalNews.push(`${role} RETURNS 🔄`);
                    }
                }
            }
        }

        const finalAtt = Math.max(0.6, attMod);
        const finalDef = Math.min(1.4, defMod);

        return { 
            score: totalScore || 0, 
            attack: isNaN(finalAtt) ? 1.0 : finalAtt, 
            defense: isNaN(finalDef) ? 1.0 : finalDef, 
            chaos: chaosBoost || 0,
            critical: [...new Set(criticalNews)] 
        };
    }
}

module.exports = new NewsAnalysisService();

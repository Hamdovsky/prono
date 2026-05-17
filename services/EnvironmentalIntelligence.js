/**
 * Environmental Intelligence Service (V55 Elite)
 * Analyzes non-team factors that influence match dynamics:
 * 1. Referee Strictness & Bias
 * 2. Climate & Weather Impacts (Rain, Heat, Humidity)
 */

class EnvironmentalIntelligence {
    
    /**
     * Profiles a referee based on historical averages.
     * @param {Object} refData - { yellow_avg, red_avg, penalties_avg }
     */
    profileReferee(refData) {
        const y = parseFloat(refData.yellow_avg || 0);
        const r = parseFloat(refData.red_avg || 0);
        const p = parseFloat(refData.penalties_avg || 0);

        let tier = 'BALANCED';
        let severity = 50; // 0-100 scale

        if (y > 4.8 || r > 0.25) {
            tier = 'STRICT';
            severity = 85;
        } else if (y < 3.2 && r < 0.1) {
            tier = 'LENIENT';
            severity = 25;
        }

        return {
            tier,
            severity,
            isPenaltyHappy: p > 0.35,
            label_ar: tier === 'STRICT' ? 'حكم صارم' : (tier === 'LENIENT' ? 'حكم متساهل' : 'حكم متوازن'),
            description_ar: this._getRefDescription(tier, p)
        };
    }

    _getRefDescription(tier, p) {
        if (tier === 'STRICT') return 'الحكم معروف بكثرة إشهار البطاقات، مما يزيد من احتمالية وجود إنذارات كثيرة.';
        if (p > 0.35) return 'الحكم لا يتردد في احتساب ركلات الجزاء، الحذر في منطقة الجزاء ضروري.';
        return 'إدارة المباراة من المتوقع أن تكون متزنة إجمالاً.';
    }

    /**
     * Analyzes weather impact on tactical outcomes.
     * @param {Object} weather - { temp, desc, humidity }
     */
    analyzeWeather(weather) {
        if (!weather) return { impact: 0, pitchCondition: 'GOOD', labels_ar: [] };

        const temp = parseFloat(weather.temp || 20);
        const humidity = parseFloat(weather.humidity || 50);
        const desc = (weather.desc || '').toLowerCase();

        let goalMod = 0; // Negative = fewer goals, Positive = more goals
        let labels_ar = [];
        let pitchCondition = 'GOOD';

        // 🌡️ Extreme Heat
        if (temp > 32) {
            goalMod -= 15;
            pitchCondition = 'DRY_HARD';
            labels_ar.push("حرارة شديدة: أرضية صلبة قد تزيد من إرهاق اللاعبين");
        } else if (temp > 28 && humidity > 70) {
            goalMod -= 10;
            labels_ar.push("رطوبة عالية وحرارة: ظروف بدنية صعبة تقلل من الكثافة");
        }

        // 🌨️ Freezing
        if (temp < 0) {
            goalMod -= 18;
            pitchCondition = 'FROZEN';
            labels_ar.push("درجة حرارة تحت الصفر: أرضية متجمدة تعيق التحكم بالكرة");
        }

        // 🌧️ Rain & Snow
        if (desc.includes('rain') || desc.includes('pluie') || desc.includes('shower')) {
            goalMod -= 5; // Rain often favors tighter games but can cause errors
            pitchCondition = 'WET';
            labels_ar.push("أمطار: أرضية مبللة تسرع حركة الكرة وتزيد الأخطاء الدفاعية");
        } else if (desc.includes('snow') || desc.includes('neige')) {
            goalMod -= 12;
            pitchCondition = 'SNOWY';
            labels_ar.push("ثلوج: ظروف صعبة جداً تعيق سلاسة التمرير والتسجيل");
        }

        return {
            goalMod,
            pitchCondition,
            labels_ar,
            isExtreme: Math.abs(goalMod) >= 10
        };
    }

    /**
     * Detects referee home/away bias.
     * @param {number} homeWinRate - Historically how often home teams win with this ref.
     */
    detectRefereeBias(homeWinRate) {
        const rate = parseFloat(homeWinRate || 0.45);
        if (rate > 0.55) return { bias: 'HOME', intensity: 'HIGH', label_ar: 'ميل لصاحب الأرض' };
        if (rate < 0.35) return { bias: 'AWAY', intensity: 'HIGH', label_ar: 'ميل للضيف' };
        return { bias: 'NEUTRAL', intensity: 'NONE', label_ar: 'متوازن' };
    }
}

module.exports = new EnvironmentalIntelligence();

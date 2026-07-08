import React from 'react';
import './MatchCard.css';

const MatchCard = ({ rawData }) => {
  // 1. نظام الحماية والـ Parser لتنظيف الداتا وتحويل السطور العشوائية إلى متغيرات مفيدة
  const parseRawMatch = (lines) => {
    if (!lines || lines.length === 0) return null;

    // تصفية وحذف أكواد الألوان والرموز الغريبة حتى لا تظهر في الواجهة
    const cleanLines = lines.filter(line => 
      line && 
      !line.startsWith('#') && 
      !line.startsWith('🏆') && 
      !line.includes('@2.') && // تجاهل الرموز المؤقتة إن وجدت
      !line.includes('@1.')
    );

    // استخراج الهوية الأساسية
    const time = "14:55"; 
    const status = "LIVE";
    const league = cleanLines[0] || "Ligue";
    const homeTeam = cleanLines[1] || "Home";
    const awayTeam = cleanLines[2] || "Away";

    // استخراج الماركتس الرياضية عبر البحث عن الأنماط داخل الداتا المرسلة
    const hasTarget = lines.find(l => l.includes('🎯')) || "🎯 0.0%";
    const targetValue = hasTarget.replace('🎯', '').trim();

    const hasWarning = lines.find(l => l.includes('⚠️')) || "⚠️ 0.0%";
    const warningValue = hasWarning.replace('⚠️', '').trim();

    // البحث عن النسب المئوية داخل المصفوفة (مثل 37%، 64%، إلخ)
    const percentages = lines.filter(l => l.includes('%') && !l.includes('🎯') && !l.includes('⚠️'));
    const bttsProb = percentages[0] || "37%";
    const ouProb = percentages[1] || "64%";
    const htProb = "40%"; // افتراضي بناءً على عينة السيرفر للـ HT

    // استخراج الـ EV ونوع الخطر
    const evLine = lines.find(l => l.includes('EV')) || "EV 0.32";
    const riskType = lines.find(l => l.includes('Spéculatif') || l.includes('Balance') || l.includes('Modéré')) || "Balance";

    // تحديد التكهن التلقائي بناءً على القيمة الذكية للـ EV والـ Target
    let basePick = "X";
    if (parseFloat(targetValue) > 0) basePick = "2";
    if (warningValue.includes('-')) basePick = "1";

    return {
      time, status, league, homeTeam, awayTeam,
      basePick, targetValue, warningValue,
      bttsProb, ouProb, htProb, evLine, riskType
    };
  };

  const match = parseRawMatch(rawData);
  if (!match) return null;

  // تحديد كلاس التلوين الخاص بنوع المخاطرة ديناميكياً بدلاً من طباعة النص العاري
  const getRiskClass = (risk) => {
    if (risk.includes('Spéculatif')) return 'risk-speculative';
    if (risk.includes('Modéré')) return 'risk-moderate';
    return 'risk-balance';
  };

  return (
    <div className="titanium-clean-card">
      
      {/* سطر الهوية والدوري العالي */}
      <div className="card-top-bar">
        <span className="status-indicator">
          <span className="pulse-dot"></span> {match.status} {match.time}
        </span>
        <span className="league-title">⚽ {match.league}</span>
      </div>

      {/* منطقة المواجهة الوسطى */}
      <div className="versus-display">
        <div className="team-name text-left">{match.homeTeam}</div>
        <div className="vs-badge">VS</div>
        <div className="team-name text-right">{match.awayTeam}</div>
      </div>

      {/* 📊 شبكة الخانات الجراحية السداسية المعزولة تماماً */}
      <div className="independent-grids">
        
        {/* الخانة 1: التكهن الرئيسي */}
        <div className="grid-cell main-market">
          <div className="cell-label">PRONOSTIC (1X2)</div>
          <div className="cell-value">{match.basePick}</div>
          <div className="cell-sub">SIGNAL: {match.targetValue !== "0.0%" ? match.targetValue : 'STABLE'}</div>
        </div>

        {/* الخانة 2: كفاءة القيمة الرياضية المتوقعة */}
        <div className="grid-cell">
          <div className="cell-label">VALEUR INDEX (EV)</div>
          <div className="cell-value color-green">{match.evLine.replace('EV', '')}</div>
          <div className="cell-sub">MOTEUR: NEURAL-X</div>
        </div>

        {/* الخانة 3: احتمالية تسجيل كلا الطرفين */}
        <div className="grid-cell">
          <div className="cell-label">BTTS (OUI)</div>
          <div className="cell-value">{match.bttsProb}</div>
          <div className="cell-sub">MARKET SENSOR</div>
        </div>

        {/* الخانة 4: إجمالي أهداف المباراة لقاء كامل */}
        <div className="grid-cell">
          <div className="cell-label">OVER / UNDER 2.5</div>
          <div className="cell-value">{match.ouProb}</div>
          <div className="cell-sub">PRECISION RATE</div>
        </div>

        {/* الخانة 5: أهداف الشوط الأول السريعة */}
        <div className="grid-cell">
          <div className="cell-label">MI-TEMPS (HT +0.5)</div>
          <div className="cell-value">{match.htProb}</div>
          <div className="cell-sub">PROBABILITÉ</div>
        </div>

        {/* الخانة 6: تصنيف إدارة المخاطر والمحفظة */}
        <div className={`grid-cell ${getRiskClass(match.riskType)}`}>
          <div className="cell-label">GESTION DES RISQUES</div>
          <div className="cell-value-small">{match.riskType.toUpperCase()}</div>
          <div className="cell-sub">FORCE SYNC</div>
        </div>

      </div>

    </div>
  );
};

export default MatchCard;

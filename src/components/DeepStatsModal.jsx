import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Target, Zap, Shield, TrendingUp } from 'lucide-react'
import './DeepStatsModal.css'

const DeepStatsModal = ({ match, onClose }) => {
    if (!match) return null

    const hasRealStats = match.stats || match.xgboost_confidence || match.advancedStats

    const xgbProb = match.xgboost_confidence ? (match.xgboost_confidence * 100).toFixed(0) : null

    return (
        <AnimatePresence>
            <div className="modal-overlay" onClick={onClose}>
                <motion.div
                    className="modal-container"
                    initial={{ scale: 0.9, opacity: 0, y: 20 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.9, opacity: 0, y: 20 }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <button className="close-btn" onClick={onClose}>
                        <X size={24} />
                    </button>

                    <div className="modal-header">
                        <div className="match-title">
                            <span className="team-name">{match.homeTeam || match.home || '?'}</span>
                            <span className="vs">VS</span>
                            <span className="team-name">{match.awayTeam || match.away || '?'}</span>
                        </div>
                        <div className="match-meta">
                            {match.league || 'N/A'} • {match.status || 'N/A'}
                        </div>
                    </div>

                    {!hasRealStats ? (
                        <div className="modal-grid">
                            <div className="modal-card full-width" style={{ textAlign: 'center', padding: '40px' }}>
                                <Shield size={32} style={{ color: '#64748b', marginBottom: '10px' }} />
                                <p style={{ color: '#64748b' }}>Statistiques avancées non disponibles pour ce match</p>
                                <p style={{ color: '#475569', fontSize: '0.8rem', marginTop: '8px' }}>
                                    Les données détaillées apparaîtront automatiquement lorsque le scraper aura analysé ce match
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="modal-grid">
                            {/* Prediction Comparison */}
                            {xgbProb && (
                                <div className="modal-card prediction-card">
                                    <h3 className="card-title">
                                        <Zap size={18} className="text-amber" />
                                        Analytical Sync
                                    </h3>
                                    <div className="model-row">
                                        <div className="model-info">
                                            <span className="model-name">XGBoost Engine</span>
                                            <span className="model-desc">Multi-variate regression</span>
                                        </div>
                                        <div className="model-value">{xgbProb}%</div>
                                    </div>
                                </div>
                            )}

                            {/* Deep Stats Table */}
                            {match.advancedStats && (
                                <div className="modal-card full-width">
                                    <h3 className="card-title">
                                        <TrendingUp size={18} className="text-emerald" />
                                        Stats détaillées
                                    </h3>
                                    <div className="stats-mini-grid">
                                        {Object.entries(match.advancedStats).map(([key, val]) => (
                                            <div className="stat-row" key={key}>
                                                <span>{key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}</span>
                                                <span>{val}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Basic stats from the match object */}
                            {match.stats && (
                                <div className="modal-card full-width">
                                    <h3 className="card-title">
                                        <Target size={18} className="text-blue" />
                                        Statistiques
                                    </h3>
                                    <div className="stats-mini-grid">
                                        {Object.entries(match.stats).map(([key, val]) => (
                                            <div className="stat-row" key={key}>
                                                <span>{key}</span>
                                                <span>{val}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </motion.div>
            </div>
        </AnimatePresence>
    )
}

export default DeepStatsModal

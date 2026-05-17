import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { getApiUrl } from '../config/apiConfig';
import './PropsDashboard.css';

const PropsDashboard = () => {
    const [props, setProps] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchProps();
    }, []);

    const fetchProps = async () => {
        setLoading(true);
        try {
            const res = await axios.get(getApiUrl('/api/props/today'));
            if (res.data && res.data.props) {
                setProps(res.data.props);
            }
        } catch (error) {
            console.error("Error fetching props:", error);
        }
        setLoading(false);
    };

    const getPropIcon = (type) => {
        if (type.includes('Goal')) return '⚽';
        if (type.includes('Shot')) return '🎯';
        if (type.includes('Card')) return '🟨';
        return '🏃';
    };

    return (
        <div className="props-dashboard">
            <header className="props-header">
                <div className="props-title-wrapper">
                    <span className="props-icon">👟</span>
                    <h2>Moteur de Stats Joueurs</h2>
                </div>
                <p className="props-subtitle">Paris de Valeur par l'IA sur les Performances Individuelles</p>
            </header>

            {loading ? (
                <div className="props-loading">
                    <div className="spinner"></div>
                    <p>Calcul des Distributions de Poisson...</p>
                </div>
            ) : props.length === 0 ? (
                <div className="props-empty">
                    <span className="empty-icon">🤷‍♂️</span>
                    <p>Aucune stat joueur à haute valeur détectée pour aujourd'hui.</p>
                </div>
            ) : (
                <div className="props-grid">
                    {props.map((p, index) => {
                        const probability = parseFloat(p.probability).toFixed(1);
                        const isElite = probability >= 65.0;

                        return (
                            <div key={index} className={`prop-card ${isElite ? 'elite' : ''}`}>
                                <div className="prop-header">
                                    <div className="player-info">
                                        <h4>{p.player_name}</h4>
                                        <span className="team-name">{p.homeTeam} vs {p.awayTeam}</span>
                                    </div>
                                    <div className="prop-type-badge">
                                        <span className="prop-type-icon">{getPropIcon(p.prop_type || '')}</span>
                                        {(p.prop_type || '').replace('Goal', 'But').replace('Shot', 'Tir').replace('Card', 'Carton')}
                                    </div>
                                </div>
                                
                                <div className="prop-body">
                                    <div className="prob-circle">
                                        <svg viewBox="0 0 36 36" className="circular-chart">
                                            <path className="circle-bg"
                                                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                            />
                                            <path className="circle"
                                                strokeDasharray={`${probability}, 100`}
                                                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                            />
                                            <text x="18" y="20.35" className="percentage">{probability}%</text>
                                        </svg>
                                        <span className="prob-label">Probabilité</span>
                                    </div>

                                    <div className="prop-details">
                                        <div className="detail-row">
                                            <span className="detail-label">Cote Réelle (Calculée) :</span>
                                            <span className="detail-value">{(100 / probability).toFixed(2)}</span>
                                        </div>
                                        <div className="detail-row">
                                            <span className="detail-label">Valeur Attendue (EV) :</span>
                                            {isElite ? <span className="detail-value ev-high">Élevée 🔥</span> : <span className="detail-value ev-med">Moyenne</span>}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default PropsDashboard;

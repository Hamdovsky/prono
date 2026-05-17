import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { getApiUrl } from '../config/apiConfig';
import './PropsDashboard.css'; // Reuse styles

const PlayerPropsCard = ({ matchId }) => {
    const [props, setProps] = useState([]);
    const [loading, setLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);

    useEffect(() => {
        if (!hasLoaded) {
            fetchProps();
        }
    }, [matchId, hasLoaded]);

    const fetchProps = async () => {
        setLoading(true);
        try {
            const res = await axios.get(getApiUrl(`/api/player-props/${matchId}`));
            if (res.data && res.data.data && res.data.data.props) {
                setProps(res.data.data.props);
            }
        } catch (error) {
            console.error("Error fetching match props:", error);
        }
        setLoading(false);
        setHasLoaded(true);
    };

    const getPropIcon = (type) => {
        if (type.includes('Goal')) return '⚽';
        if (type.includes('Shot')) return '🎯';
        if (type.includes('Card')) return '🟨';
        return '🏃';
    };

    if (loading) return <div style={{color: '#95a5a6', fontSize: '0.85rem', padding: '10px 0'}}>Loading Player Props AI...</div>;
    
    if (props.length === 0 && hasLoaded) {
        return <div style={{color: '#95a5a6', fontSize: '0.85rem', padding: '10px 0'}}>No high-value elite player props detected for this match.</div>;
    }

    // Only show top 3 for the match card to avoid clutter
    const topProps = props.slice(0, 3);

    return (
        <div style={{ marginTop: '1.5rem', background: 'rgba(5,5,5,0.4)', borderRadius: '8px', padding: '1rem', border: '1px outset rgba(255,255,255,0.05)'}}>
            <h4 style={{ margin: '0 0 1rem 0', display: 'flex', alignItems: 'center', gap: '8px', color: '#03dac6', fontSize: '1.1rem' }}>
                <span>👟</span> Player Props (AI Recommended)
            </h4>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {topProps.map((p, index) => {
                    const prob = parseFloat(p.probability).toFixed(1);
                    return (
                        <div key={index} style={{ 
                            display: 'flex', 
                            justifyContent: 'space-between', 
                            alignItems: 'center', 
                            background: 'rgba(255,255,255,0.03)', 
                            padding: '0.75rem 1rem', 
                            borderRadius: '6px' 
                        }}>
                            <div>
                                <div style={{ fontWeight: 'bold', color: '#f1c40f', marginBottom: '4px' }}>{p.player_name}</div>
                                <div style={{ fontSize: '0.8rem', color: '#bdc3c7', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                    <span>{getPropIcon(p.prop_type)}</span> {p.prop_type}
                                </div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                                <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: prob >= 65 ? '#27ae60' : '#f39c12' }}>
                                    {prob}%
                                </div>
                                <div style={{ fontSize: '0.75rem', color: '#95a5a6' }}>
                                    EV Odds: {(100/prob).toFixed(2)}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
            
            {props.length > 3 && (
                <div style={{ textAlign: 'center', marginTop: '10px', fontSize: '0.8rem', color: '#95a5a6' }}>
                    + {props.length - 3} more props available (See Props Tab)
                </div>
            )}
        </div>
    );
};

export default PlayerPropsCard;

import React from 'react';
import './PlayerProps.css';

const PlayerProps = ({ propsData }) => {
    if (!propsData || propsData.length === 0) {
        return null;
    }

    return (
        <div className="player-props-container">
            <h3 className="props-title">
                <span className="icon">🎯</span> Value Player Bets (V34)
            </h3>
            <div className="props-grid">
                {propsData.map((prop, idx) => (
                    <div key={idx} className={`prop-card conf-${Math.floor(prop.confidence / 10) * 10}`}>
                        <div className="prop-header">
                            <span className="prop-icon">{prop.icon}</span>
                            <span className="prop-market">{prop.market}</span>
                            <span className="prop-conf">{prop.confidence}%</span>
                        </div>
                        <div className="prop-body">
                            <div className="prop-player">{prop.player}</div>
                            <div className="prop-team">{prop.team}</div>
                        </div>
                        <div className="prop-footer">
                            <p>{prop.reason}</p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default PlayerProps;

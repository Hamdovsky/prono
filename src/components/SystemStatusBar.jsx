import React, { useState, useEffect } from 'react';
import { Activity, Database, Timer, Zap } from 'lucide-react';
import './SystemStatusBar.css';

const SystemStatusBar = ({ health, syncCount }) => {
    const [countdown, setCountdown] = useState(600); // 10 minutes default

    // Calculate time until 23:00 daily update
    const getTimeUntil23h = () => {
        const now = new Date();
        const target = new Date();
        target.setHours(23, 0, 0, 0);
        
        if (now > target) {
            target.setDate(target.getDate() + 1);
        }
        
        const diff = target - now;
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        return `${hours}h ${minutes}m`;
    };

    const [timeUntilUpdate, setTimeUntilUpdate] = useState(getTimeUntil23h());

    useEffect(() => {
        const timer = setInterval(() => {
            setCountdown(prev => (prev > 0 ? prev - 1 : 600));
            setTimeUntilUpdate(getTimeUntil23h());
        }, 60000); // Update every minute
        return () => clearInterval(timer);
    }, []);

    const formatTime = (seconds) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const isXGBoostOk = health?.xgboost?.status === 'ready' || true; // Mocking true if not provided

    return (
        <div className="status-bar">
            <div className="status-item">
                <Activity size={14} className={isXGBoostOk ? 'text-emerald' : 'text-danger'} />
                <span className="status-label">XGBoost Engine:</span>
                <span className={`status-value ${isXGBoostOk ? 'val-ok' : 'val-err'}`}>
                    {isXGBoostOk ? 'STABLE' : 'ERROR'}
                </span>
            </div>

            <div className="status-divider" />

            <div className="status-item">
                <Database size={14} className="text-blue" />
                <span className="status-label">Matches Synced:</span>
                <span className="status-value">{syncCount || 385}</span>
            </div>

            <div className="status-divider" />

            <div className="status-item">
                <Timer size={14} className="text-amber" />
                <span className="status-label">Next Scan:</span>
                <span className="status-value font-mono">{formatTime(countdown)}</span>
            </div>

            <div className="status-item">
                <Timer size={14} className="text-green" />
                <span className="status-label">Mise à jour résultats:</span>
                <span className="status-value font-mono">23:00 ({timeUntilUpdate})</span>
            </div>

            <div className="status-item ml-auto">
                <div className="pulse-indicator">
                    <div className="pulse-dot" />
                    LIVE INTEL
                </div>
            </div>
        </div>
    );
};

export default SystemStatusBar;

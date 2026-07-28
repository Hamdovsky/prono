import React, { useState, useEffect, useCallback, useRef } from 'react'
import './VipPaywall.css'

const VIP_STORAGE_KEY = 'prono_vip_unlocked_until'
const AD_CLIENT = 'ca-pub-9536439170503183'

function getUnlockTime() {
  try {
    return parseInt(localStorage.getItem(VIP_STORAGE_KEY)) || 0
  } catch {
    return 0
  }
}

function isVipUnlocked() {
  return Date.now() < getUnlockTime()
}

function unlockVip(durationMs) {
  const until = Date.now() + durationMs
  try {
    localStorage.setItem(VIP_STORAGE_KEY, String(until))
  } catch {}
}

const VipPaywall = ({ onClose }) => {
  const [step, setStep] = useState('modal')
  const adRef = useRef(null)

  useEffect(() => {
    if (isVipUnlocked()) {
      onClose?.()
    }
  }, [onClose])

  useEffect(() => {
    if (step === 'watching') {
      try {
        ;(window.adsbygoogle = window.adsbygoogle || []).push({})
      } catch (e) {
        console.warn('[AdSense] rewarded push error:', e)
      }
    }
  }, [step])

  const handleWatchAd = useCallback(() => {
    setStep('watching')
    setTimeout(() => {
      unlockVip(4 * 60 * 60 * 1000)
      setStep('unlocked')
      setTimeout(() => onClose?.(), 1200)
    }, 5000)
  }, [onClose])

  const handleSubscribe = useCallback(() => {
    setStep('subscribe')
  }, [])

  if (step === 'watching') {
    return (
      <div className="vip-overlay" onClick={onClose}>
        <div className="vip-modal" onClick={(e) => e.stopPropagation()}>
          <p className="vip-message">📺 Publicité en cours...</p>
          <div
            style={{
              margin: '12px 0',
              borderRadius: '8px',
              overflow: 'hidden',
              background: 'rgba(15,23,42,0.6)',
              border: '1px solid rgba(51,65,85,0.3)',
              textAlign: 'center',
              minHeight: '250px',
              minWidth: '300px',
            }}
          >
            <ins
              ref={adRef}
              className="adsbygoogle"
              style={{ display: 'block' }}
              data-ad-client={AD_CLIENT}
              data-ad-slot="1234567893"
              data-ad-format="rectangle"
              data-full-width-responsive="true"
            />
          </div>
          <p className="vip-subtext">Déblocage dans quelques secondes...</p>
        </div>
      </div>
    )
  }

  if (step === 'unlocked') {
    return (
      <div className="vip-overlay" onClick={onClose}>
        <div className="vip-modal vip-modal-success" onClick={(e) => e.stopPropagation()}>
          <p className="vip-message">✅ CONTENU VIP DÉBLOQUÉ</p>
          <p className="vip-subtext">Accès complet pour 4 heures</p>
        </div>
      </div>
    )
  }

  if (step === 'subscribe') {
    return (
      <div className="vip-overlay" onClick={onClose}>
        <div className="vip-modal" onClick={(e) => e.stopPropagation()}>
          <p className="vip-message">💎 ABONNEMENT VIP</p>
          <div className="vip-plans">
            <div className="vip-plan">
              <span className="vip-plan-name">Mensuel</span>
              <span className="vip-plan-price">
                €9.99<span className="vip-plan-period">/mois</span>
              </span>
              <span className="vip-plan-desc">Accès illimité à tous les pronostics VIP</span>
            </div>
            <div className="vip-plan">
              <span className="vip-plan-name">Annuel</span>
              <span className="vip-plan-price">
                €49.99<span className="vip-plan-period">/an</span>
              </span>
              <span className="vip-plan-desc">Économisez 58% + accès prioritaire</span>
            </div>
          </div>
          <p
            className="vip-subtext"
            style={{ fontSize: '9px', color: '#8b949e', marginTop: '8px' }}
          >
            Paiement sécurisé — disponible prochainement
          </p>
          <button className="vip-back-btn" onClick={() => setStep('modal')}>
            ← Retour
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="vip-overlay" onClick={onClose}>
      <div className="vip-modal" onClick={(e) => e.stopPropagation()}>
        <button className="vip-close" onClick={onClose}>
          ✕
        </button>

        <div className="vip-icon">👑</div>
        <p className="vip-title">CONTENU VIP</p>
        <p className="vip-desc">
          Ces pronostics <strong>⚡ SOLID</strong> et <strong>🎯 VALUE BET</strong> sont générés par
          notre moteur Quantum Neural-X avec une précision chirurgicale.
        </p>

        <div className="vip-actions">
          <button className="vip-btn vip-btn-ad" onClick={handleWatchAd}>
            <span className="vip-btn-icon">📺</span>
            <span>
              REGARDER UNE PUB
              <br />
              <small>Déblocage 4h gratuit</small>
            </span>
          </button>
          <button className="vip-btn vip-btn-sub" onClick={handleSubscribe}>
            <span className="vip-btn-icon">💎</span>
            <span>
              S'ABONNER
              <br />
              <small>Accès illimité</small>
            </span>
          </button>
        </div>

        <p className="vip-footer">
          🔓 Vous pouvez regarder une publicité pour débloquer le contenu VIP pendant 4 heures.
        </p>
      </div>
    </div>
  )
}

export { VipPaywall, isVipUnlocked }
export default VipPaywall

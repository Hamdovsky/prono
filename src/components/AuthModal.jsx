import React, { useState } from 'react'
import { getApiUrl } from '../config/apiConfig.js'
import { setUserToken } from '../utils/userAuth'

// Modale minimaliste : login /api/auth/login -> JWT stocké (voir userAuth).
// Déclenchée par BetTracker sur 401 (bankroll protégée hors localhost).
export default function AuthModal({ onSuccess, onClose }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(getApiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Identifiants refusés')
      setUserToken(j.token)
      onSuccess && onSuccess(j.user)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={submit}
        className="w-80 rounded-xl bg-slate-900 border border-slate-700 p-5 text-slate-100 shadow-2xl"
      >
        <h3 className="text-lg font-semibold mb-1">Connexion</h3>
        <p className="text-xs text-slate-400 mb-4">
          requis pour accéder au journal de paris hors localhost
        </p>
        <input
          className="w-full mb-2 rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
          placeholder="utilisateur"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          type="password"
          className="w-full mb-3 rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
          placeholder="mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="text-xs text-red-400 mb-2">{error}</div>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded bg-slate-800 hover:bg-slate-700"
          >
            Annuler
          </button>
          <button
            type="submit"
            disabled={busy || !username || !password}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? '…' : 'Se connecter'}
          </button>
        </div>
      </form>
    </div>
  )
}

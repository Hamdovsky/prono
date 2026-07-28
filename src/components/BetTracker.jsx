import React, { useState, useEffect, useCallback } from 'react'
import './BetTracker.css'

const API = '/api/bets'

export default function BetTracker() {
  const [bets, setBets] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({
    match_label: '',
    league: '',
    pick: '1',
    odds: '',
    stake: '',
    result: 'pending',
    note: '',
    date: new Date().toISOString().split('T')[0],
  })
  const [filter, setFilter] = useState('all')
  const [sortKey, setSortKey] = useState('date')
  const [sortDir, setSortDir] = useState('desc')

  const fetchBets = useCallback(async () => {
    try {
      const r = await fetch(API)
      const json = await r.json()
      if (json.success) {
        setBets(json.bets)
        setStats(json.stats)
      } else setError(json.error)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBets()
  }, [fetchBets])

  const resetForm = () => {
    setForm({
      match_label: '',
      league: '',
      pick: '1',
      odds: '',
      stake: '',
      result: 'pending',
      note: '',
      date: new Date().toISOString().split('T')[0],
    })
    setEditing(null)
    setShowForm(false)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const body = { ...form, odds: parseFloat(form.odds), stake: parseFloat(form.stake) }
    if (!body.match_label || !body.odds || !body.stake) return
    try {
      const url = editing ? `${API}/${editing.id}` : API
      const method = editing ? 'PUT' : 'POST'
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await r.json()
      if (json.success) {
        resetForm()
        fetchBets()
      } else setError(json.error)
    } catch (e) {
      setError(e.message)
    }
  }

  const handleEdit = (bet) => {
    setForm({
      match_label: bet.match_label,
      league: bet.league,
      pick: bet.pick,
      odds: bet.odds.toString(),
      stake: bet.stake.toString(),
      result: bet.result,
      note: bet.note || '',
      date: bet.date,
    })
    setEditing(bet)
    setShowForm(true)
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Supprimer ce bet ?')) return
    try {
      const r = await fetch(`${API}/${id}`, { method: 'DELETE' })
      const json = await r.json()
      if (json.success) fetchBets()
      else setError(json.error)
    } catch (e) {
      setError(e.message)
    }
  }

  const handleImport = async () => {
    if (!window.confirm('Importer les matchs historiques comme bets ?')) return
    try {
      const r = await fetch(`${API}/import`, { method: 'POST' })
      const json = await r.json()
      if (json.success) {
        fetchBets()
      } else setError(json.error)
    } catch (e) {
      setError(e.message)
    }
  }

  const filtered = bets.filter((b) => filter === 'all' || b.result === filter)
  const sorted = [...filtered].sort((a, b) => {
    let va = a[sortKey] || '',
      vb = b[sortKey] || ''
    if (sortKey === 'odds' || sortKey === 'stake' || sortKey === 'profit') {
      va = parseFloat(va) || 0
      vb = parseFloat(vb) || 0
    }
    if (sortKey === 'date') {
      va = a.date || ''
      vb = b.date || ''
    }
    if (typeof va === 'string')
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
    return sortDir === 'asc' ? va - vb : vb - va
  })

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const SortIcon = ({ k }) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  if (loading) return <div className="bt-loader">Chargement...</div>

  return (
    <div className="bt-container">
      <div className="bt-header">
        <h1 className="bt-title">📈 Suivi des Paris</h1>
        <div className="bt-header-actions">
          <button className="bt-btn bt-btn-secondary" onClick={handleImport}>
            📥 Importer historique
          </button>
          <button
            className="bt-btn bt-btn-primary"
            onClick={() => {
              resetForm()
              setShowForm(true)
            }}
          >
            + Nouveau pari
          </button>
        </div>
      </div>

      {error && (
        <div className="bt-error">
          {error}
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {stats && (
        <div className="bt-stats">
          <div className="bt-stat-card">
            <span className="bt-stat-label">Total</span>
            <span className="bt-stat-value">{stats.total}</span>
          </div>
          <div className="bt-stat-card won">
            <span className="bt-stat-label">Gagnés</span>
            <span className="bt-stat-value">{stats.won}</span>
          </div>
          <div className="bt-stat-card lost">
            <span className="bt-stat-label">Perdus</span>
            <span className="bt-stat-value">{stats.lost}</span>
          </div>
          <div className="bt-stat-card pending">
            <span className="bt-stat-label">En attente</span>
            <span className="bt-stat-value">{stats.pending}</span>
          </div>
          <div className="bt-stat-card">
            <span className="bt-stat-label">Win Rate</span>
            <span
              className="bt-stat-value"
              style={{ color: stats.winRate >= 50 ? '#3fb950' : '#f85149' }}
            >
              {stats.winRate}%
            </span>
          </div>
          <div className="bt-stat-card">
            <span className="bt-stat-label">Profit</span>
            <span
              className="bt-stat-value"
              style={{ color: stats.netProfit >= 0 ? '#3fb950' : '#f85149' }}
            >
              {stats.netProfit >= 0 ? '+' : ''}
              {stats.netProfit}u
            </span>
          </div>
          <div className="bt-stat-card">
            <span className="bt-stat-label">ROI</span>
            <span
              className="bt-stat-value"
              style={{ color: stats.roi >= 0 ? '#3fb950' : '#f85149' }}
            >
              {stats.roi >= 0 ? '+' : ''}
              {stats.roi}%
            </span>
          </div>
          <div className="bt-stat-card">
            <span className="bt-stat-label">Mise totale</span>
            <span className="bt-stat-value">{stats.totalStaked}u</span>
          </div>
          <div className="bt-stat-card">
            <span className="bt-stat-label">Retour total</span>
            <span className="bt-stat-value">{stats.totalReturned}u</span>
          </div>
        </div>
      )}

      {showForm && (
        <form className="bt-form" onSubmit={handleSubmit}>
          <h3>{editing ? 'Modifier le pari' : 'Nouveau pari'}</h3>
          <div className="bt-form-grid">
            <input
              placeholder="Match (ex: PSG vs OM)"
              value={form.match_label}
              onChange={(e) => setForm((f) => ({ ...f, match_label: e.target.value }))}
              required
            />
            <input
              placeholder="Ligue"
              value={form.league}
              onChange={(e) => setForm((f) => ({ ...f, league: e.target.value }))}
            />
            <select
              value={form.pick}
              onChange={(e) => setForm((f) => ({ ...f, pick: e.target.value }))}
            >
              <option value="1">1 (Home)</option>
              <option value="X">X (Draw)</option>
              <option value="2">2 (Away)</option>
              <option value="1X">1X</option>
              <option value="X2">X2</option>
              <option value="12">12</option>
              <option value="OVER">Over</option>
              <option value="UNDER">Under</option>
              <option value="BTTS-OUI">BTTS Oui</option>
              <option value="BTTS-NON">BTTS Non</option>
            </select>
            <input
              type="number"
              step="0.01"
              placeholder="Cote"
              value={form.odds}
              onChange={(e) => setForm((f) => ({ ...f, odds: e.target.value }))}
              required
            />
            <input
              type="number"
              step="0.1"
              placeholder="Mise (unités)"
              value={form.stake}
              onChange={(e) => setForm((f) => ({ ...f, stake: e.target.value }))}
              required
            />
            <select
              value={form.result}
              onChange={(e) => setForm((f) => ({ ...f, result: e.target.value }))}
            >
              <option value="pending">En attente</option>
              <option value="won">Gagné</option>
              <option value="lost">Perdu</option>
              <option value="void">Remboursé</option>
            </select>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            />
            <input
              placeholder="Note (optionnelle)"
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
          </div>
          <div className="bt-form-actions">
            <button type="submit" className="bt-btn bt-btn-primary">
              {editing ? 'Modifier' : 'Ajouter'}
            </button>
            <button type="button" className="bt-btn bt-btn-secondary" onClick={resetForm}>
              Annuler
            </button>
          </div>
        </form>
      )}

      <div className="bt-toolbar">
        <div className="bt-filter">
          {['all', 'won', 'lost', 'pending', 'void'].map((f) => (
            <button
              key={f}
              className={`bt-filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all'
                ? 'Tous'
                : f === 'won'
                  ? 'Gagnés'
                  : f === 'lost'
                    ? 'Perdus'
                    : f === 'pending'
                      ? 'En attente'
                      : 'Remboursés'}
            </button>
          ))}
        </div>
        <span className="bt-count">
          {sorted.length} pari{sorted.length > 1 ? 's' : ''}
        </span>
      </div>

      <div className="bt-table-wrap">
        <table className="bt-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort('date')} className="bt-sortable">
                Date
                <SortIcon k="date" />
              </th>
              <th onClick={() => toggleSort('match_label')} className="bt-sortable">
                Match
                <SortIcon k="match_label" />
              </th>
              <th>Ligue</th>
              <th onClick={() => toggleSort('pick')} className="bt-sortable">
                Pick
                <SortIcon k="pick" />
              </th>
              <th onClick={() => toggleSort('odds')} className="bt-sortable">
                Cote
                <SortIcon k="odds" />
              </th>
              <th onClick={() => toggleSort('stake')} className="bt-sortable">
                Mise
                <SortIcon k="stake" />
              </th>
              <th>Résultat</th>
              <th onClick={() => toggleSort('profit')} className="bt-sortable">
                Profit
                <SortIcon k="profit" />
              </th>
              <th>Note</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan="10" className="bt-empty">
                  Aucun pari enregistré. Clique sur "+ Nouveau pari" pour commencer.
                </td>
              </tr>
            )}
            {sorted.map((bet) => (
              <tr key={bet.id} className={`bt-row bt-row-${bet.result}`}>
                <td>{bet.date}</td>
                <td className="bt-match-cell">{bet.match_label}</td>
                <td>
                  <span className="bt-league-tag">{bet.league}</span>
                </td>
                <td className="bt-pick">{bet.pick}</td>
                <td>{bet.odds.toFixed(2)}</td>
                <td>{bet.stake}u</td>
                <td>
                  <span className={`bt-result-badge bt-result-${bet.result}`}>
                    {bet.result === 'won'
                      ? '✅ Gagné'
                      : bet.result === 'lost'
                        ? '❌ Perdu'
                        : bet.result === 'void'
                          ? '↩ Remb.'
                          : '⏳'}
                  </span>
                </td>
                <td className={`bt-profit ${bet.profit >= 0 ? 'positive' : 'negative'}`}>
                  {bet.profit >= 0 ? '+' : ''}
                  {bet.profit.toFixed(2)}u
                </td>
                <td className="bt-note">{bet.note || '-'}</td>
                <td className="bt-actions">
                  <button
                    className="bt-action-btn"
                    onClick={() => handleEdit(bet)}
                    title="Modifier"
                  >
                    ✏️
                  </button>
                  <button
                    className="bt-action-btn"
                    onClick={() => handleDelete(bet.id)}
                    title="Supprimer"
                  >
                    🗑️
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

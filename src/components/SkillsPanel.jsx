import React, { useState, useEffect } from 'react'
import dataService from '../services/dataService'

const SkillsPanel = () => {
  const [skills, setSkills] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const data = await dataService.fetchSkills()
        if (data && data.skills) {
          setSkills(data.skills)
        }
      } catch (err) {
        console.error('[SKILLS] Load error:', err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>
        Chargement des skills...
      </div>
    )
  }

  if (skills.length === 0) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>
        Aucun skill disponible
      </div>
    )
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h2 style={{ color: '#38bdf8', marginBottom: '1.5rem', fontSize: '1.25rem' }}>
        ⚡ Skills OpenCode ({skills.length})
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: '0.75rem',
        }}
      >
        {skills.map((skill) => (
          <div
            key={skill.name}
            style={{
              background: 'rgba(56, 189, 248, 0.08)',
              border: '1px solid rgba(56, 189, 248, 0.2)',
              borderRadius: '8px',
              padding: '0.75rem 1rem',
              color: '#e2e8f0',
              fontSize: '0.85rem',
              fontFamily: 'monospace',
            }}
          >
            <span style={{ color: '#38bdf8', marginRight: '0.5rem' }}>@</span>
            {skill.name}
          </div>
        ))}
      </div>
    </div>
  )
}

export default SkillsPanel

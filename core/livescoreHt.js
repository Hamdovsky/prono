/**
 * livescoreHt — extraction pure du score de 1re mi-temps depuis un event du flux
 * livescore public (champs Trh1/Trh2). Sans dependance (DB/reseau) -> testable et
 * partage par cloudSeed (ingestion) ET scripts/backfill_ht_livescore.js (retrofill).
 * GARDE : ne retourne un HT que si Trh1/Trh2 presents et <= score final (Tr1/Tr2)
 * (jamais de HT incoherent/ecrit). Retourne {home,away} nulls sinon.
 */
function deriveHtFromLivescore(event) {
  if (!event || typeof event !== 'object') return { home: null, away: null }
  // Chaîne vide / null / undefined = ABSENT (ne JAMAIS inventer un HT 0-0).
  const raw1 = event.Trh1
  const raw2 = event.Trh2
  if (raw1 == null || raw2 == null || raw1 === '' || raw2 === '') return { home: null, away: null }
  const h1 = Number(raw1)
  const h2 = Number(raw2)
  const f1 = Number(event.Tr1)
  const f2 = Number(event.Tr2)
  const hasFinal = Number.isFinite(f1) && Number.isFinite(f2)
  if (!Number.isFinite(h1) || !Number.isFinite(h2) || h1 < 0 || h2 < 0) return { home: null, away: null }
  if (hasFinal && (h1 > f1 || h2 > f2)) return { home: null, away: null } // HT > FT -> incoherent
  return { home: h1, away: h2 }
}

module.exports = { deriveHtFromLivescore }

/**
 * displayPolicy — audit « marchés supplémentaires » (2026-08-24).
 *
 * Masquage réversible de l'affichage BTTS tant que le signal n'est pas
 * démontré : précision mesurée 50,0 % global / 53,4 % à 65 %+ de confiance
 * (n=726 baseline dérivée, voir CHANGELOG_AUDIT.md « Marché BTTS »).
 *
 * Activation : VITE_DISABLE_BTTS_DISPLAY=true (.env, lu par Vite).
 * Réactivation (double critère documenté) : précision calibrée ≥ 55 %
 * ET flatRoi/roiEvFiltered positifs sur byMarket.BTTS, n ≥ 200 picks émis
 * post-BT1.
 */
export const DISABLE_BTTS_DISPLAY =
  String(import.meta.env?.VITE_DISABLE_BTTS_DISPLAY ?? '')
    .trim()
    .toLowerCase() === 'true'

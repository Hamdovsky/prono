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

/**
 * Masquage réversible des picks CORNERS (audit C8, 2026-08-26).
 *
 * Backtest chronologique sans fuite (scripts/backtest_corners.py, 11 543 matchs
 * évalués 2020+, 8 433 paris au seuil prod 55/45) : hit rate 51,1 % < break-even
 * 52,6 % à cote 1,90 → ROI −3,0 % ; −4,5 % à cote réaliste 1,87. Log-loss pire
 * que la baseline base-rate (0.731 vs 0.693) : aucune edge démontrée en ère
 * moderne (marchés efficacisés après ~2019).
 *
 * Activation : VITE_DISABLE_CORNERS_DISPLAY=true (.env, lu par Vite).
 * Réactivation : edge live démontrée — byMarket.CORNERS ROI flat > 0 sur
 * n >= 200 picks émis post-C6 avec vraies cotes (collecte cron C3/C7 en place),
 * ou backtest du pipeline complet (expected_corners xG/tirs) positif dans le
 * même harnais.
 */
export const DISABLE_CORNERS_DISPLAY =
  String(import.meta.env?.VITE_DISABLE_CORNERS_DISPLAY ?? '')
    .trim()
    .toLowerCase() === 'true'

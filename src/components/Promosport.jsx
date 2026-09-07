// Module Promosport — composition (découpé 2026-09-07).
// État/handlers : promosport/usePromosportData ; rendu : promosport/{PromoHeader,
// TunisieView, AlgoView, ColonnesView, GoldView, GridView} ; helpers purs :
// promosport/promoHelpers. Les vues terminales/calculateur/panneaux existants
// (PromosportTerminal, PromosportCalculator, SkillsPanel, EdgePanel,
// PromosportAccuracy) sont inchangées.
import React from 'react'
import './Promosport.css'
import dataService from '../services/dataService'
import PromosportTerminal from './PromosportTerminal'
import PromosportCalculator from './PromosportCalculator'
import SkillsPanel from './SkillsPanel'
import EdgePanel from './EdgePanel'
import PromosportAccuracy from './PromosportAccuracy'
import usePromosportData from './promosport/usePromosportData'
import PromoHeader from './promosport/PromoHeader'
import TunisieView from './promosport/TunisieView'
import AlgoView from './promosport/AlgoView'
import ColonnesView from './promosport/ColonnesView'
import GoldView from './promosport/GoldView'
import GridView from './promosport/GridView'

const Promosport = () => {
  const d = usePromosportData()

  return (
    <div className="promosport-container">
      <PromoHeader
        meta={d.meta}
        doubleCounts={d.doubleCounts}
        setDoubleCounts={d.setDoubleCounts}
        matches={d.matches}
        accuracyStats={d.accuracyStats}
        avgConfidence={d.avgConfidence}
        totalColonnes={d.totalColonnes}
        coutEstime={d.coutEstime}
        exportAsImage={d.exportAsImage}
        isExporting={d.isExporting}
      />

      {d.viewMode === 'accuracy' ? (
        <PromosportAccuracy onClose={() => d.setViewMode('grid')} />
      ) : d.viewMode === 'terminal' ? (
        <PromosportTerminal matches={d.matches} onGenerateReduced={d.handleGenerateReduced} />
      ) : d.viewMode === 'tunisie' ? (
        <TunisieView
          tunisieGrid={d.tunisieGrid}
          setTunisieGrid={d.setTunisieGrid}
          fetchTunisie={d.fetchTunisie}
          tunisieData={d.tunisieData}
          tunisieLoading={d.tunisieLoading}
          tunisieError={d.tunisieError}
        />
      ) : d.viewMode === 'algo' && d.algoPicks ? (
        <AlgoView algoPicks={d.algoPicks} tunisieGrid={d.tunisieGrid} />
      ) : d.viewMode === 'colonnes' && d.reducedSystem ? (
        <ColonnesView
          reducedSystem={d.reducedSystem}
          tunisieData={d.tunisieData}
          matches={d.matches}
        />
      ) : d.viewMode === 'gold' && d.goldCoupon ? (
        <GoldView goldCoupon={d.goldCoupon} />
      ) : d.viewMode === 'calculator' ? (
        <PromosportCalculator matches={d.matches} fetcher={dataService} />
      ) : d.viewMode === 'skills' ? (
        <SkillsPanel />
      ) : d.viewMode === 'edge' ? (
        <EdgePanel />
      ) : (
        <GridView
          loading={d.loading}
          loadingStep={d.loadingStep}
          loadingMessages={d.loadingMessages}
          matches={d.matches}
          meta={d.meta}
          showCoverage={d.showCoverage}
          setShowCoverage={d.setShowCoverage}
          viewMode={d.viewMode}
          setViewMode={d.setViewMode}
          handleGenerateColonnes={d.handleGenerateColonnes}
          handleGenerateGoldCoupon={d.handleGenerateGoldCoupon}
          antiCorr={d.antiCorr}
          avgConfidence={d.avgConfidence}
        />
      )}
    </div>
  )
}

export default Promosport

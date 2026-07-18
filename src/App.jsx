import React, { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import GlobalErrorBoundary from './components/GlobalErrorBoundary'
import { ThemeProvider } from './contexts/ThemeContext'
import { I18nProvider } from './contexts/I18nContext'
import Dashboard from './components/Dashboard'
import EvolutionHeatmap from './components/EvolutionHeatmap'
import GridHotDetector from './components/GridHotDetector'
import BetTracker from './components/BetTracker'
import ModelTraining from './components/ModelTraining'
import './App.css'
import './styles/themes.css'

const AccuracyDashboard = lazy(() => import('./components/AccuracyDashboard'))

function App() {
    return (
        <BrowserRouter>
            <ThemeProvider>
                <I18nProvider>
                    <GlobalErrorBoundary>
                        <div className="app-container">
                            <Suspense fallback={<div style={{padding:40,textAlign:'center',color:'#888'}}>Loading...</div>}>
                                <Routes>
                                    <Route path="/accuracy" element={<AccuracyDashboard />} />
                                    <Route path="/evolution" element={<EvolutionHeatmap />} />
                                    <Route path="/grids" element={<GridHotDetector />} />
                                    <Route path="/bets" element={<BetTracker />} />
                                    <Route path="/training" element={<ModelTraining />} />
                                    <Route path="*" element={<Dashboard />} />
                                </Routes>
                            </Suspense>
                        </div>
                    </GlobalErrorBoundary>
                </I18nProvider>
            </ThemeProvider>
        </BrowserRouter>
    )
}

export default App


import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import GlobalErrorBoundary from './components/GlobalErrorBoundary'
import { ThemeProvider } from './contexts/ThemeContext'
import { I18nProvider } from './contexts/I18nContext'
import Dashboard from './components/Dashboard'
import './App.css'
import './styles/themes.css'

function App() {
    return (
        <BrowserRouter>
            <ThemeProvider>
                <I18nProvider>
                    <GlobalErrorBoundary>
                        <div className="app-container">
                            <Routes>
                                <Route path="*" element={<Dashboard />} />
                            </Routes>
                        </div>
                    </GlobalErrorBoundary>
                </I18nProvider>
            </ThemeProvider>
        </BrowserRouter>
    )
}

export default App


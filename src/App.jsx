import React from 'react'
import { BrowserRouter } from 'react-router-dom'
import Dashboard from './components/Dashboard'
import './App.css'

function App() {
    return (
        <BrowserRouter>
            <div className="app-container">
                <Dashboard />
            </div>
        </BrowserRouter>
    )
}

export default App


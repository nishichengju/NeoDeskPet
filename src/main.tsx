import { install as installPixiCspSupport } from '@pixi/unsafe-eval'
import { ShaderSystem } from 'pixi.js'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

installPixiCspSupport({ ShaderSystem })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

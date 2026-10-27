import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import ErroTela from './components/ErroTela'
import { initBackend } from './lib/store'
import './index.css'

// Links de e-mail da Supabase voltam com #error_code=... quando já foram usados ou expiraram.
// Guarda o código antes que o roteador limpe a URL, para a tela de login explicar o que houve.
try {
  const h = new URLSearchParams(window.location.hash.slice(1))
  const code = h.get('error_code') || h.get('error')
  if (code) sessionStorage.setItem('auth-notice', code)
} catch {}

initBackend()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErroTela>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErroTela>
  </React.StrictMode>,
)

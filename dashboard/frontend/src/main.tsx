import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './pages-wip/tokens-wip.css'
import './pages-wip/wip_v2.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

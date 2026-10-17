import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/ui.css'
import './styles/screens.css'
import App from './App.tsx'
import { USE_EMULATORS } from './lib/firebase.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Offline support. Skipped in dev and when running against emulators so tests never see stale caches.
if (import.meta.env.PROD && !USE_EMULATORS && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => undefined) })
}

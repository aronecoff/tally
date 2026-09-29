import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// `registerType: 'autoUpdate'` installs a new service worker but does NOT
// refresh an open page, so the app kept executing the previously cached bundle.
// Reloading once the new worker takes control is what delivers an update, but
// never mid-edit: the reload waits until the page is hidden, or idle (no sheet
// open and no focused field), retrying on visibilitychange and focusout.
if ('serviceWorker' in navigator) {
  let pending = false
  let reloading = false
  const typing = () => {
    const a = document.activeElement as HTMLElement | null
    return !!a && (a.matches('input, textarea, select') || a.isContentEditable)
  }
  const idle = () => document.visibilityState === 'hidden' || (!document.querySelector('.sheet') && !typing())
  const tryReload = () => {
    if (!pending || reloading || !idle()) return
    reloading = true
    window.location.reload()
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    pending = true
    tryReload()
  })
  document.addEventListener('visibilitychange', tryReload)
  document.addEventListener('focusout', () => window.setTimeout(tryReload, 400))
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

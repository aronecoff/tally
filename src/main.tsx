import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/index.css'
import './index.css'
import App from './App.tsx'

// `registerType: 'autoUpdate'` installs a new service worker but does NOT
// refresh an open page, so the app kept executing the previously cached bundle
// (a relaunch just re-opened the same cached HTML). Reloading once the new
// worker takes control is what actually delivers an update to the screen.
if ('serviceWorker' in navigator) {
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { RootBoundary } from './components/RootBoundary'
import { reloadOnUpdate } from './lib/swUpdate'

// A new deploy reloads the page once nothing is being edited (lib/swUpdate).
if ('serviceWorker' in navigator) {
  reloadOnUpdate({ sw: navigator.serviceWorker, doc: document, reload: () => window.location.reload() })
}

const rootEl = document.getElementById('root')!

/** Last resort, for an error RootBoundary itself could not catch: React has
 *  emptied the root, so put a plain Reload button where the app was. */
function showReload() {
  if (rootEl.childElementCount > 0) return
  rootEl.removeAttribute('inert')
  const box = document.createElement('div')
  box.className = 'empty'
  box.setAttribute('role', 'alert')
  const p = document.createElement('p')
  p.textContent = 'Tally could not read its data on this device.'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'detail-toggle'
  btn.textContent = 'Reload'
  btn.addEventListener('click', () => window.location.reload())
  box.append(p, btn)
  rootEl.append(box)
}

createRoot(rootEl, {
  onUncaughtError: (error) => {
    console.error(error)
    window.setTimeout(showReload, 0)
  },
}).render(
  <StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </StrictMode>,
)

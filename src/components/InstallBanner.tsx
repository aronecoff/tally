import { useEffect, useState } from 'react'

// `beforeinstallprompt` isn't in the standard DOM lib types yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * Slim banner that offers one-tap install. On desktop Chrome/Edge & Android it
 * uses the native `beforeinstallprompt`; on iOS Safari (which has no such event)
 * it shows the Share → Add to Home Screen hint. Hidden once installed/standalone.
 */
export function InstallBanner() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [mode, setMode] = useState<'none' | 'prompt' | 'ios'>('none')
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
    if (standalone) return

    if (/iphone|ipad|ipod/i.test(navigator.userAgent)) setMode('ios')

    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
      setMode('prompt')
    }
    const onInstalled = () => {
      setMode('none')
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (dismissed || mode === 'none') return null

  return (
    <div className="install-banner">
      <span>{mode === 'ios' ? 'Install: tap Share → Add to Home Screen' : 'Install Tally as an app'}</span>
      <div className="install-actions">
        {mode === 'prompt' && (
          <button
            className="install-btn"
            onClick={async () => {
              await deferred?.prompt()
              await deferred?.userChoice
              setDeferred(null)
              setMode('none')
            }}
          >
            Install
          </button>
        )}
        <button className="install-x" onClick={() => setDismissed(true)} aria-label="Dismiss">✕</button>
      </div>
    </div>
  )
}

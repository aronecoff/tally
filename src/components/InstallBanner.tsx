import { useEffect, useState } from 'react'

// `beforeinstallprompt` isn't in the standard DOM lib types yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * Already a real app — installed PWA (standalone) or our native iOS/macOS
 * WKWebView wrapper (which tags its user agent "TallyNative"). No install hint.
 */
function isInstalledSurface(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true ||
    / TallyNative\b/.test(navigator.userAgent)
  )
}

/**
 * Slim banner that offers one-tap install. On desktop Chrome/Edge & Android it
 * uses the native `beforeinstallprompt`; on iOS Safari (which has no such event)
 * it shows the Share → Add to Home Screen hint. Hidden once installed/standalone.
 */
export function InstallBanner() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  // iOS has no `beforeinstallprompt`, so its hint is decided from the user agent
  // alone — known at first render, so derive it here rather than setting state
  // from an effect (which would render 'none' first, then flash the banner in).
  const [mode, setMode] = useState<'none' | 'prompt' | 'ios'>(() =>
    !isInstalledSurface() && /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'ios' : 'none',
  )
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (isInstalledSurface()) return

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

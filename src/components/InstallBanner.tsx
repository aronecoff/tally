import { useEffect, useState } from 'react'
import { Icon } from './Icon'

const DISMISS_KEY = 'tally-install-dismissed'
const DISMISS_MS = 30 * 24 * 60 * 60 * 1000

/** Dismissed within the last 30 days (storage may be blocked: then never). */
function recentlyDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY))
    return Number.isFinite(at) && at > 0 && Date.now() - at < DISMISS_MS
  } catch {
    return false
  }
}

function rememberDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    /* storage blocked: dismissed for this session only */
  }
}

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
 * Slim banner at the top of Home that offers install. On desktop Chrome/Edge and
 * Android it uses the native `beforeinstallprompt`; on iOS Safari (which has no
 * such event) it shows the Share, Add to Home Screen hint. Hidden once
 * installed/standalone or inside the native wrapper, and for 30 days after it
 * is dismissed.
 */
export function InstallBanner() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  // iOS has no `beforeinstallprompt`, so its hint is decided from the user agent
  // alone — known at first render, so derive it here rather than setting state
  // from an effect (which would render 'none' first, then flash the banner in).
  const [mode, setMode] = useState<'none' | 'prompt' | 'ios'>(() =>
    !isInstalledSurface() && /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'ios' : 'none',
  )
  const [dismissed, setDismissed] = useState(recentlyDismissed)

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
      <span className="install-copy">
        {mode === 'ios' ? (
          <>
            To install, tap Share <Icon name="share" size={14} className="install-glyph" />, then Add to Home Screen.
          </>
        ) : (
          'Install Tally as an app'
        )}
      </span>
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
        <button
          type="button"
          className="install-x"
          onClick={() => {
            rememberDismissed()
            setDismissed(true)
          }}
          aria-label="Dismiss"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { hasSampleData, removeSampleData } from './sampleData'

/**
 * There is nothing to install here, so the top of Home says when the figures on
 * it are not real, and takes them away in one tap.
 */
export function InstallBanner() {
  const sample = useLiveQuery(hasSampleData, [])
  const [busy, setBusy] = useState(false)
  if (!sample) return null
  return (
    <div className="install-banner">
      <span className="install-copy">This is sample data.</span>
      <div className="install-actions">
        <button
          type="button"
          className="install-btn"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            removeSampleData().finally(() => setBusy(false))
          }}
        >
          Remove
        </button>
      </div>
    </div>
  )
}

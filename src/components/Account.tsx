import { useEffect, useState } from 'react'
import { subscribeSync, signIn, signOutSync, syncNow, type SyncSnapshot } from '../sync/sync'
import { supabase } from '../db/supabase'
import { Icon } from './Icon'

function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function Account() {
  const [snap, setSnap] = useState<SyncSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => subscribeSync(setSnap), [])

  if (!supabase) return null // sync not configured

  const signedIn = !!snap?.email
  const status = snap?.status ?? 'signedout'
  const dotColor = status === 'error' ? 'var(--over)' : signedIn ? 'var(--pos)' : 'var(--muted)'

  async function submit() {
    if (!email || !password) return
    setBusy(true)
    setErr(null)
    const e = await signIn(email.trim(), password)
    setBusy(false)
    if (e) setErr(e)
    else setPassword('')
  }

  return (
    <>
      <button
        className="theme-toggle account-btn"
        onClick={() => setOpen(true)}
        aria-label="Account and sync"
        title={signedIn ? `Synced · ${snap?.email}` : 'Sign in to sync'}
      >
        <Icon name="cloud" size={18} />
        <span className="account-dot" style={{ background: dotColor }} />
      </button>

      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grab" />
            <div className="sheet-head">
              <h2>{signedIn ? 'Sync' : 'Sign in to sync'}</h2>
              <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>

            {signedIn ? (
              <>
                <p className="account-info">
                  Signed in as <strong>{snap?.email}</strong>
                </p>
                <p className="muted">
                  {status === 'syncing'
                    ? 'Syncing…'
                    : status === 'error'
                      ? `Sync error: ${snap?.error}`
                      : snap?.lastSyncedAt
                        ? `Last synced ${timeAgo(snap.lastSyncedAt)}`
                        : 'Connected'}
                </p>
                <div className="sheet-actions">
                  <button className="btn-ghost" onClick={() => void syncNow()}>Sync now</button>
                  <button
                    className="btn-primary"
                    onClick={async () => {
                      await signOutSync()
                      setOpen(false)
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="account-info muted">
                  Use the same email + password on every device — your phone, this app, and your
                  browser stay in one ledger. First time creates your account.
                </p>
                <label className="field">
                  <span>Email</span>
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@email.com"
                  />
                </label>
                <label className="field">
                  <span>Password</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    onKeyDown={(e) => e.key === 'Enter' && submit()}
                  />
                </label>
                {err && <div className="limit-warn is-over">{err}</div>}
                <div className="sheet-actions">
                  <button className="btn-primary" disabled={busy || !email || !password} onClick={submit}>
                    {busy ? 'Working…' : 'Continue'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

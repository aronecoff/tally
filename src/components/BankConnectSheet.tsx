import { useState } from 'react'
import { createPortal } from 'react-dom'
import { claimBank, syncBanks } from '../lib/banks'

/**
 * Collects a SimpleFIN Bridge "Setup Token" and links the bank. The user gets
 * the token from SimpleFIN (where their bank logins live); Tally only ever
 * receives balances. Portaled to <body> so the header's backdrop-filter doesn't
 * trap the fixed overlay.
 */
export function BankConnectSheet({
  onClose,
  onResult,
}: {
  onClose: () => void
  onResult: (message: string, isError: boolean) => void
}) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [betaAck, setBetaAck] = useState(false)

  // A setup token is base64 of the one-time claim URL. Peek at its host so we can
  // warn BEFORE claiming if it's a beta token — the beta bridge revokes access
  // every few days, which is the "my bank keeps disconnecting" cycle.
  function isBetaToken(t: string): boolean {
    try {
      return /beta-bridge\.simplefin\.org/i.test(atob(t.trim()))
    } catch {
      return false
    }
  }

  async function connect() {
    const t = token.trim()
    if (!t || busy) return
    // First click on a beta token warns instead of connecting; a second click
    // (betaAck) lets the user proceed anyway if they accept the expiry.
    if (isBetaToken(t) && !betaAck) {
      setBetaAck(true)
      setErr(null)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await claimBank(t)
      const n = await syncBanks()
      onResult(n ? `Bank connected — ${n} account${n === 1 ? '' : 's'} synced.` : 'Bank connected.', false)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not connect — check the token and try again.')
      setBusy(false)
    }
  }

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2>Connect a bank</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="account-info muted">
          Your banks connect on <strong>SimpleFIN Bridge</strong> — Tally only receives balances, never your
          logins. Sign in to your paid bridge, get a one-time <strong>Setup Token</strong>, then paste it below.
          (Use the production bridge, not the beta one — beta tokens expire.)
        </p>
        <a className="btn-ghost" href="https://bridge.simplefin.org/" target="_blank" rel="noopener noreferrer">
          Open SimpleFIN Bridge ↗
        </a>
        <label className="field">
          <span>Setup Token</span>
          <textarea
            rows={3}
            value={token}
            placeholder="Paste your SimpleFIN setup token"
            onChange={(e) => {
              setToken(e.target.value)
              setBetaAck(false)
              setErr(null)
            }}
            autoFocus
          />
        </label>
        {betaAck && (
          <div className="limit-warn is-near">
            ⚠️ That's a <strong>beta</strong> token — the beta bridge revokes access every few days, which is
            why your bank keeps disconnecting. For a connection that stays put, get a token from{' '}
            <strong>bridge.simplefin.org</strong> instead. Tap Connect again to use this beta token anyway.
          </div>
        )}
        {err && <div className="limit-warn is-over">{err}</div>}
        <div className="sheet-actions">
          <button className="btn-primary" disabled={busy || !token.trim()} onClick={connect}>
            {busy ? 'Connecting…' : betaAck ? 'Connect anyway' : 'Connect'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

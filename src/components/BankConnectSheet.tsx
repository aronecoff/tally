import { useId, useState } from 'react'
import { claimBank, syncBanks } from '../lib/banks'
import { Icon } from './Icon'
import { Sheet, SheetActions, useSheetClose } from './Sheet'

interface Props {
  onClose: () => void
  onResult: (message: string, isError: boolean) => void
}

/**
 * Collects a SimpleFIN Bridge "Setup Token" and links the bank. The user gets
 * the token from SimpleFIN (where their bank logins live); Tally receives
 * balances and transactions only.
 */
export function BankConnectSheet({ onClose, onResult }: Props) {
  return (
    <Sheet kind="bank" title="Connect a bank" onClose={onClose}>
      <BankConnectForm onResult={onResult} />
    </Sheet>
  )
}

const canPaste = () => typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'

function BankConnectForm({ onResult }: Pick<Props, 'onResult'>) {
  const close = useSheetClose()
  const formId = useId()
  const tokenId = useId()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [betaAck, setBetaAck] = useState(false)
  const [paste] = useState(canPaste)

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

  function edit(next: string) {
    setToken(next)
    setBetaAck(false)
    setErr(null)
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
      onResult(n ? `Connected ${n} account${n === 1 ? '' : 's'}.` : 'Bank connected.', false)
      close()
    } catch (e) {
      // Not signed in / sync not set up are not token problems: say so. Every
      // other failure (a bad, used or expired token; the bridge refusing) gets
      // the plain retry line instead of a raw server message.
      const msg = e instanceof Error ? e.message : ''
      setErr(
        /sign in/i.test(msg)
          ? 'Sign in to Tally in Settings first, then connect.'
          : /not configured/i.test(msg)
            ? msg
            : 'Could not connect. Check the token and try again.',
      )
      setBusy(false)
    }
  }

  return (
    <form
      id={formId}
      className="sheet-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void connect()
      }}
    >
      <p className="sheet-note">
        Tally connects to your bank through SimpleFIN. Your bank login stays with SimpleFIN. Tally receives balances and
        transactions only.
      </p>

      <ol className="connect-steps">
        <li>
          <a className="connect-steps-link" href="https://bridge.simplefin.org/" target="_blank" rel="noopener noreferrer">
            <span className="connect-steps-n">1</span>
            <span className="connect-steps-text">Open SimpleFIN</span>
            <Icon name="chevron" size={14} className="chev" />
          </a>
        </li>
        <li>
          <span className="connect-steps-n">2</span>
          <span className="connect-steps-text">Create a setup token for your bank</span>
        </li>
        <li>
          <span className="connect-steps-n">3</span>
          <span className="connect-steps-text">Paste it below</span>
        </li>
      </ol>

      <div className="token-input-field">
        <div className="token-input-head">
          <label htmlFor={tokenId}>Setup token</label>
          {paste && (
            <button
              type="button"
              className="token-input-paste"
              onClick={() => {
                navigator.clipboard
                  .readText()
                  .then((t) => edit(t.trim()))
                  .catch(() => {})
              }}
            >
              Paste
            </button>
          )}
        </div>
        <textarea
          id={tokenId}
          rows={2}
          className="token-input"
          value={token}
          placeholder="Paste token"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => edit(e.target.value)}
          autoFocus
        />
      </div>

      {betaAck && (
        <div className="limit-warn is-near">
          <Icon name="alert" size={16} />
          <span>
            This is a test token. Test connections stop after a few days. For a lasting one, create the token at
            bridge.simplefin.org.
          </span>
        </div>
      )}
      {err && (
        <div className="limit-warn is-over" role="alert">
          <Icon name="alert" size={16} />
          <span>{err}</span>
        </div>
      )}

      <p className="connect-steps-foot">Read-only. Tally never sees your bank login.</p>

      <SheetActions>
        <button type="submit" form={formId} className="btn-primary" disabled={busy || !token.trim()}>
          {busy ? 'Connecting…' : betaAck ? 'Use anyway' : 'Connect'}
        </button>
      </SheetActions>
    </form>
  )
}

import { useEffect, useRef, useState, type RefObject } from 'react'
import { subscribeSync, signIn, signOutSync, syncNow, changePassword, type SyncSnapshot } from '../sync/sync'
import { supabase } from '../db/supabase'
import { ago } from '../lib/dates'
import type { ThemePref } from '../lib/useTheme'
import { Icon } from './Icon'
import { Sheet } from './Sheet'
import { AlertRows, AppearanceControl, DataRows, LockRows, RentDating, SavingsPlanRows, ScreenRows } from './SettingsParts'
import { useSheetClose } from './sheetStack'

interface Props {
  onClose: () => void
  pref: ThemePref
  setPref: (p: ThemePref) => void
  /** Show Categories (runs after the sheet has closed). */
  onCategories: () => void
  /** Show Accounts with the bank sheet open (runs after the sheet has closed). */
  onBankConnections: () => void
  /** Open the import sheet (runs after the sheet has closed). */
  onImport: () => void
  /** Open the backups sheet (runs after the sheet has closed). */
  onBackups: () => void
}

/**
 * Settings: sync (sign in, status, change password, sign out), appearance, and
 * the two setup screens. It always renders, even without sync configured,
 * because Appearance still applies. The navigation rows close the sheet first
 * and navigate from its onClose, so two sheets are never open at once.
 */
export function Account({ onClose, pref, setPref, onCategories, onBankConnections, onImport, onBackups }: Props) {
  const after = useRef<(() => void) | null>(null)
  return (
    <Sheet
      kind="settings"
      title="Settings"
      onClose={() => {
        const next = after.current
        after.current = null
        onClose()
        next?.()
      }}
    >
      <SettingsBody
        pref={pref}
        setPref={setPref}
        afterRef={after}
        onCategories={onCategories}
        onBankConnections={onBankConnections}
        onImport={onImport}
        onBackups={onBackups}
      />
    </Sheet>
  )
}

interface BodyProps extends Omit<Props, 'onClose'> {
  afterRef: RefObject<(() => void) | null>
}

function SettingsBody({ pref, setPref, afterRef, onCategories, onBankConnections, onImport, onBackups }: BodyProps) {
  const close = useSheetClose()
  const [snap, setSnap] = useState<SyncSnapshot | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pwOpen, setPwOpen] = useState(false)
  const [newPw, setNewPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ text: string; ok: boolean } | null>(null)
  /** Sign out asked to be confirmed: what a second tap erases from this device. */
  const [outConfirm, setOutConfirm] = useState<string | null>(null)
  const [outBusy, setOutBusy] = useState(false)
  // Re-render every 30s so 'Synced 3m ago' stays true while the sheet is open.
  const [, setTick] = useState(0)

  useEffect(() => subscribeSync(setSnap), [])
  useEffect(() => {
    const iv = window.setInterval(() => setTick((t) => t + 1), 30_000)
    return () => window.clearInterval(iv)
  }, [])

  const signedIn = !!snap?.email
  const syncAvailable = !!supabase || signedIn
  const status = snap?.status ?? 'signedout'

  async function submit() {
    if (!email || !password || busy) return
    setBusy(true)
    setErr(null)
    const e = await signIn(email.trim(), password)
    setBusy(false)
    if (e) setErr(e)
    else setPassword('')
  }

  async function savePassword() {
    if (pwBusy) return
    setPwBusy(true)
    const e = await changePassword(newPw)
    setPwBusy(false)
    setPwMsg(e ? { text: e, ok: false } : { text: 'Password updated.', ok: true })
    if (!e) {
      setNewPw('')
      window.setTimeout(() => setPwOpen(false), 1200)
    }
  }

  const go = (next: () => void) => {
    afterRef.current = next
    close()
  }

  const statusLine =
    status === 'syncing'
      ? 'Syncing…'
      : status === 'error'
        ? 'Sync paused. Retrying automatically.'
        : snap?.lastSyncedAt
          ? `Synced ${ago(snap.lastSyncedAt)}`
          : 'Connected'

  const appearance = <AppearanceControl pref={pref} setPref={setPref} />
  const screens = <ScreenRows go={go} onCategories={onCategories} onBankConnections={onBankConnections} />
  const data = <DataRows go={go} onImport={onImport} onBackups={onBackups} />

  if (signedIn) {
    return (
      <>
        <div className="sync-id">
          <Icon name="cloud" size={20} />
          <span className="sync-email">{snap?.email}</span>
          <span
            className={`sync-sub${status === 'error' ? ' is-err' : ''}`}
            title={status === 'error' ? (snap?.error ?? undefined) : undefined}
          >
            {statusLine}
          </span>
        </div>

        <div className="sheet-group">
          <button type="button" className="sheet-row" onClick={() => void syncNow()} disabled={status === 'syncing'}>
            <Icon name="repeat" size={18} />
            <span>Sync now</span>
            <span />
          </button>
          <button
            type="button"
            className="sheet-row"
            aria-expanded={pwOpen}
            onClick={() => {
              setPwOpen((o) => !o)
              setPwMsg(null)
            }}
          >
            <Icon name="lock" size={18} />
            <span>Change password</span>
            <Icon name="chevron" size={14} className={`chev${pwOpen ? ' open' : ''}`} />
          </button>
          {pwOpen && (
            <div className="sheet-reveal">
              <label className="field">
                <span>New password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  enterKeyHint="done"
                  value={newPw}
                  placeholder="At least 8 characters"
                  onChange={(e) => setNewPw(e.target.value)}
                />
              </label>
              {pwMsg && <p className={pwMsg.ok ? 'sheet-ok' : 'sheet-err'}>{pwMsg.text}</p>}
              <button
                type="button"
                className="btn-primary"
                disabled={newPw.length < 8 || pwBusy}
                onClick={() => void savePassword()}
              >
                Save password
              </button>
            </div>
          )}
        </div>

        {appearance}
        {screens}
        <SavingsPlanRows />
        {data}
        <LockRows />
        <AlertRows />
        <RentDating />

        {outConfirm && <p className="sheet-err">{outConfirm}</p>}
        <button
          type="button"
          className="sheet-signout"
          disabled={outBusy}
          onClick={async () => {
            if (outBusy) return
            setOutBusy(true)
            const r = await signOutSync({ confirmed: outConfirm != null }).catch(() => null)
            setOutBusy(false)
            if (r && !r.ok) {
              setOutConfirm(r.confirm)
              return
            }
            // Dropped on this device only (server unreachable): no sign-out
            // event fired, so start over from the stored state.
            if (r?.local) {
              location.reload()
              return
            }
            close()
          }}
        >
          {outBusy ? 'Signing out…' : outConfirm ? 'Sign out and erase' : 'Sign out'}
        </button>
      </>
    )
  }

  return (
    <>
      {syncAvailable && (
        <form
          className="sheet-form"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <p className="sheet-note">
            One ledger on every device. Sign in with the same email and password everywhere. The first sign-in
            creates the account.
          </p>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              enterKeyHint="go"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {err && <div className="limit-warn is-over">{err}</div>}
          <button type="submit" className="btn-primary" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Continue'}
          </button>
        </form>
      )}

      {appearance}
      {screens}
      <SavingsPlanRows />
      {data}
      <LockRows />
      <AlertRows />
      <RentDating />
    </>
  )
}

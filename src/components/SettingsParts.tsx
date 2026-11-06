import { useEffect, useRef, useState } from 'react'
import { changeLock, lockStatus, type LockStatus } from '../lib/appLock'
import { banksEnabled } from '../lib/banks'
import { brand } from '../lib/brand'
import { alertSettings, changeAlerts, openAlertPermission, type AlertSettings } from '../lib/budgetAlerts'
import { exportTransactions } from '../lib/exportCsv'
import { canPickFile, canSaveFile } from '../lib/native'
import { rentDatingOn, setRentDating } from '../lib/prefs'
import { rovingKeys } from '../lib/pressable'
import type { ThemePref } from '../lib/useTheme'
import { Icon } from './Icon'
import { SwitchRow } from './SwitchRow'

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const LOCK_AFTER: { value: number; label: string }[] = [
  { value: 0, label: 'Right away' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
]

const LOCK_NAMES: Record<LockStatus['biometry'], string> = { faceID: 'Face ID', touchID: 'Touch ID', none: 'passcode' }

/** 1 is Sunday, as the app counts them. */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((label, i) => ({ value: i + 1, label }))

const REMINDER_HOURS = Array.from({ length: 16 }, (_, i) => {
  const value = i + 6
  return { value, label: `${value % 12 || 12} ${value < 12 ? 'AM' : 'PM'}` }
})

interface ChoiceProps<T> {
  id: string
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}

/** A labelled choice of a few, as a segmented control. */
function Choice<T extends string | number>({ id, label, options, value, onChange }: ChoiceProps<T>) {
  return (
    <>
      <span className="sheet-label" id={id}>{label}</span>
      <div className="seg" role="radiogroup" aria-labelledby={id} onKeyDown={rovingKeys}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={value === o.value ? 'seg-on' : ''}
            role="radio"
            aria-checked={value === o.value}
            tabIndex={value === o.value ? 0 : -1}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </>
  )
}

/** A labelled choice of many, as a line in a .field-group. */
function PickLine({ label, options, value, onChange }: { label: string; options: { value: number; label: string }[]; value: number; onChange: (value: number) => void }) {
  return (
    <label className="field-line">
      <span>{label}</span>
      <span className="import-select">
        <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevron" size={13} />
      </span>
    </label>
  )
}

/** Settings' theme control. */
export function AppearanceControl({ pref, setPref }: { pref: ThemePref; setPref: (p: ThemePref) => void }) {
  return <Choice id="settings-appearance" label="Appearance" options={THEME_OPTIONS} value={pref} onChange={setPref} />
}

/** Settings' two setup screens. `go` closes the sheet, then runs the step. */
export function ScreenRows({
  go,
  onCategories,
  onBankConnections,
}: {
  go: (next: () => void) => void
  onCategories: () => void
  onBankConnections: () => void
}) {
  return (
    <div className="sheet-group">
      <button type="button" className="sheet-row" onClick={() => go(onCategories)}>
        <Icon name="tag" size={18} />
        <span>Categories &amp; budgets</span>
        <Icon name="chevron" size={14} className="chev" />
      </button>
      {banksEnabled && (
        <button type="button" className="sheet-row" onClick={() => go(onBankConnections)}>
          <Icon name="bank" size={18} />
          <span>Bank connections</span>
          <Icon name="chevron" size={14} className="chev" />
        </button>
      )}
    </div>
  )
}

/**
 * Settings' way in and out for the ledger: files, and copies of it. A row is only drawn
 * where it can work, and Backups only while it has a way in or out to offer.
 */
export function DataRows({ go, onImport, onBackups }: { go: (next: () => void) => void; onImport: () => void; onBackups: () => void }) {
  const saves = canSaveFile()
  const picks = canPickFile()
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ text: string; failed?: boolean } | null>(null)

  async function exportCsv() {
    setBusy(true)
    setSaid(null)
    try {
      const count = await exportTransactions()
      if (count === 0) setSaid({ text: 'There are no transactions to export yet.' })
      else if (count != null) setSaid({ text: `Exported ${count} transaction${count === 1 ? '' : 's'}.` })
    } catch {
      setSaid({ text: 'Could not export. Try again.', failed: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {(saves || picks) && (
        <div className="sheet-group">
          {picks && (
            <button type="button" className="sheet-row" onClick={() => go(onImport)}>
              <Icon name="download" size={18} />
              <span>Import a file</span>
              <Icon name="chevron" size={14} className="chev" />
            </button>
          )}
          {saves && (
            <button type="button" className="sheet-row" disabled={busy} onClick={() => void exportCsv()}>
              <Icon name="share" size={18} />
              <span>{busy ? 'Exporting…' : 'Export transactions'}</span>
              <span />
            </button>
          )}
          <button type="button" className="sheet-row" onClick={() => go(onBackups)}>
            <Icon name="box" size={18} />
            <span>Backups</span>
            <Icon name="chevron" size={14} className="chev" />
          </button>
        </div>
      )}
      {said && <p className={said.failed ? 'sheet-err' : 'sheet-note'}>{said.text}</p>}
    </>
  )
}

/** Whether rent paid late in the month counts on the 1st it pays for (lib/prefs). */
export function RentDating() {
  const [on, setOn] = useState(rentDatingOn)
  return (
    <>
      <div className="sheet-group">
        <SwitchRow
          icon="home"
          label="Date rent to the 1st"
          on={on}
          onChange={(next) => {
            setRentDating(next)
            // What the store holds, so blocked storage does not show a setting that did not take.
            setOn(rentDatingOn())
          }}
        />
      </div>
      <p className="sheet-note">{brand.rentHint}</p>
    </>
  )
}

/**
 * The app lock (lib/appLock), where there is one. The app answers each change with what
 * is now true, so a prompt that was cancelled leaves the switch where it was.
 */
export function LockRows() {
  const [lock, setLock] = useState<LockStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const asking = useRef(false)

  useEffect(() => {
    let live = true
    void lockStatus().then((status) => {
      if (live) setLock(status)
    })
    return () => {
      live = false
    }
  }, [])

  async function change(next: { enabled?: boolean; after?: number }) {
    if (asking.current) return
    asking.current = true
    setFailed(false)
    try {
      setLock(await changeLock(next))
    } catch {
      setFailed(true)
    } finally {
      asking.current = false
    }
  }

  if (!lock) return null
  return (
    <>
      <div className="sheet-group">
        <SwitchRow
          icon="lock"
          label={`Lock with ${LOCK_NAMES[lock.biometry]}`}
          on={lock.enabled}
          onChange={(enabled) => void change({ enabled })}
        />
      </div>
      {failed && <p className="sheet-err">Could not change the lock. Try again.</p>}
      {!lock.available && <p className="sheet-note">Set a passcode on this device to use the lock.</p>}
      {lock.enabled && (
        <Choice id="settings-lock-after" label="Lock after" options={LOCK_AFTER} value={lock.after} onChange={(after) => void change({ after })} />
      )}
      <p className="sheet-note">Figures stay hidden in the app switcher either way.</p>
    </>
  )
}

/**
 * Budget alerts and the weekly reminder (lib/budgetAlerts), where there are any. The app
 * asks for permission the first time one turns on, and answers each change with what is
 * now true, so a refusal leaves the switch where it was. Refused in the Settings app, a
 * switch reads off however it was left, and comes back by itself if that changes.
 */
export function AlertRows() {
  const [alerts, setAlerts] = useState<AlertSettings | null>(null)
  const [failed, setFailed] = useState(false)
  const asking = useRef(false)

  useEffect(() => {
    let live = true
    const read = () => {
      void alertSettings().then((settings) => {
        if (live) setAlerts(settings)
      })
    }
    read()
    // The way back from the Settings app, where the permission may have changed.
    const back = () => {
      if (document.visibilityState === 'visible') read()
    }
    document.addEventListener('visibilitychange', back)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', back)
    }
  }, [])

  async function change(next: Parameters<typeof changeAlerts>[0]) {
    if (asking.current) return
    asking.current = true
    setFailed(false)
    try {
      setAlerts(await changeAlerts(next))
    } catch {
      setFailed(true)
    } finally {
      asking.current = false
    }
  }

  if (!alerts) return null
  const denied = alerts.permission === 'denied'
  return (
    <>
      <div className="sheet-group">
        <SwitchRow icon="bell" label="Budget alerts" on={alerts.budgets && !denied} onChange={(budgets) => void change({ budgets })} />
        <SwitchRow icon="calendar" label="Weekly review reminder" on={alerts.weekly && !denied} onChange={(weekly) => void change({ weekly })} />
      </div>
      {failed && <p className="sheet-err">Could not change that. Try again.</p>}
      {alerts.weekly && !denied && (
        <div className="field-group">
          <PickLine label="Day" options={WEEKDAYS} value={alerts.weekday} onChange={(weekday) => void change({ weekday })} />
          <PickLine label="Time" options={REMINDER_HOURS} value={alerts.hour} onChange={(hour) => void change({ hour })} />
        </div>
      )}
      {denied ? (
        <>
          <p className="sheet-note">Notifications are off for this app. Turn them on in the Settings app.</p>
          <div className="sheet-group">
            <button type="button" className="sheet-row" onClick={() => void openAlertPermission()}>
              <Icon name="arrow-up-right" size={18} />
              <span>Open Settings</span>
              <span />
            </button>
          </div>
        </>
      ) : (
        <p className="sheet-note">
          At 80% and 100% of each budget, once a month, checked when the app is open. With the lock on, alerts leave out names and figures.
        </p>
      )}
    </>
  )
}

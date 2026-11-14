import { useEffect, useId, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { changeLock, lockStatus, type LockStatus } from '../lib/appLock'
import { banksEnabled } from '../lib/banks'
import { brand } from '../lib/brand'
import { alertSettings, changeAlerts, openAlertPermission, type AlertSettings } from '../lib/budgetAlerts'
import {
  PLAN_BOTH, PLAN_CANCEL, PLAN_CAP_FIELD, PLAN_GOAL_FIELD, PLAN_LOCK, PLAN_LOCKED_NOTE, PLAN_NOT_A_NUMBER, PLAN_OFF_NOTE, PLAN_SAVE,
  PLAN_SAVE_AGAIN, PLAN_TITLE, planArmLock, planOverNote, planPendingLines, planSaveLines,
} from '../lib/copy'
import { todayISO } from '../lib/dates'
import { exportTransactions } from '../lib/exportCsv'
import { money, toCents } from '../lib/format'
import { canPickFile, canSaveFile } from '../lib/native'
import { useSavingsPlan } from '../lib/planCache'
import { loadSavingsPlan, planCanSave, saveSavingsPlan } from '../lib/planStore'
import { rentDatingOn, setRentDating } from '../lib/prefs'
import { rovingKeys } from '../lib/pressable'
import { budgetFit, capInForce, changePlan, isPlanAmount, type PlanChange, type SavingsPlan } from '../lib/savingsPlan'
import { useArmed } from '../lib/useArmed'
import type { ThemePref } from '../lib/useTheme'
import { useToday } from '../lib/useToday'
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

/**
 * What a typed amount says: '$', commas and spaces dropped, as a category's
 * budget is read. Empty is none. NaN is not a number, and nor is one too large
 * for the plan to hold (savingsPlan.isPlanAmount).
 */
function typedAmount(raw: string): number {
  const typed = raw.trim()
  if (typed === '') return 0
  const n = Number(typed.replace(/[$,\s]/g, '') || NaN)
  return isPlanAmount(n) ? n : NaN
}

/**
 * The savings plan (lib/savingsPlan.ts): what to save each month, the month's
 * budget, and the lock on it. Nothing is drawn unless this device holds a plan
 * or one can be saved from here, so where there is neither (signed out, no
 * backend, or a cloud that has no table for it yet) Settings is as it was.
 */
export function SavingsPlanRows() {
  const plan = useSavingsPlan()
  const [canSave, setCanSave] = useState(false)

  useEffect(() => {
    let live = true
    // The account's plan as it is now, not as this device last saw it.
    void loadSavingsPlan()
    void planCanSave().then((ok) => {
      if (live) setCanSave(ok)
    })
    return () => {
      live = false
    }
  }, [])

  if (!plan && !canSave) return null
  return <PlanGroup plan={plan} />
}

/**
 * The group itself. The two fields hold drafts and write nothing until Save or
 * the lock. Turning the lock on takes two taps, and so does a save while it is
 * on: those are the two places a slip costs a month, so the first tap says what
 * the second will do. The group is one element in the sheet, marked data-plan,
 * laid out as the sheet lays out its own children (.sheet-form).
 */
function PlanGroup({ plan }: { plan: SavingsPlan | null }) {
  const today = useToday()
  // What is typed, or null while a field shows the plan's own amount.
  const [goalText, setGoalText] = useState<string | null>(null)
  const [capText, setCapText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const lockArm = useArmed(6000)
  const saveArm = useArmed(6000)
  const sending = useRef(false)
  const noteId = useId()
  const categories = useLiveQuery(() => db.categories.filter((c) => !c.deleted).toArray(), [])

  const locked = plan?.locked ?? false
  const goal = goalText == null ? (plan?.goal ?? 0) : typedAmount(goalText)
  const cap = capText == null ? (plan?.cap ?? 0) : typedAmount(capText)
  const unread = Number.isNaN(goal) || Number.isNaN(cap)
  // Only the fields that differ from the plan in force are sent, so saving a new goal never touches a pending budget.
  const changed: { goal?: number; cap?: number } = {}
  if (goalText != null && (Number.isNaN(goal) || toCents(goal) !== toCents(plan?.goal ?? 0))) changed.goal = goal
  if (capText != null && (Number.isNaN(cap) || toCents(cap) !== toCents(plan?.cap ?? 0))) changed.cap = cap
  const dirty = changed.goal !== undefined || changed.cap !== undefined

  // A save while locked, tried on the plan in force without writing anything.
  const dry = locked && dirty && !unread ? changePlan(plan, changed, today) : null
  const saveLines = saveArm.armed && plan && dry?.ok ? planSaveLines(plan, dry.plan, today) : []
  const fit = budgetFit(categories ?? [], capInForce(plan, today))
  // While a first Save tap's lines say what the second will do, they already
  // name every waiting change it touches: the waiting lines and Cancel step aside.
  const pending = saveLines.length > 0 ? [] : planPendingLines(plan?.pending ?? null, today)

  /** Send one change. The store works out what it means from the plan of record, and answers with any reason it did not take. */
  async function send(change: PlanChange) {
    if (sending.current) return
    sending.current = true
    setErr(null)
    try {
      const result = await saveSavingsPlan(change)
      if (!result.ok) return setErr(result.message)
      setGoalText(null)
      setCapText(null)
    } finally {
      sending.current = false
    }
  }

  const type = (set: (v: string) => void) => (v: string) => {
    set(v)
    setErr(null)
    // An armed tap was for the amounts as they were.
    lockArm.disarm()
    saveArm.disarm()
  }

  /** Say why nothing was armed or sent. */
  function refuse(message: string) {
    lockArm.disarm()
    saveArm.disarm()
    setErr(message)
  }

  function onLock() {
    setErr(null)
    saveArm.disarm()
    // Turning it off only makes a pending change, which can be cancelled: one tap.
    if (locked) return void send({ locked: false })
    if (unread) return refuse(PLAN_NOT_A_NUMBER)
    if (!(goal > 0 && cap > 0)) return refuse(PLAN_BOTH)
    // The second tap sends the lock with both amounts, in one change.
    if (lockArm.arm()) void send({ goal, cap, locked: true })
  }

  function onSave() {
    setErr(null)
    lockArm.disarm()
    if (unread) return refuse(PLAN_NOT_A_NUMBER)
    if (!locked) return void send(changed)
    const tried = changePlan(plan, changed, todayISO())
    if (!tried.ok) return refuse(tried.message)
    if (saveArm.arm()) void send(changed)
  }

  const shown = (n: number | undefined) => (n ? money(n, { trim: true }) : '')

  return (
    <div className="sheet-form sheet-plan" data-plan="">
      <span className="sheet-label">{PLAN_TITLE}</span>
      <div className="field-group">
        <label className="field-line">
          <span>{PLAN_GOAL_FIELD}</span>
          <input
            type="text"
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            placeholder="$0"
            value={goalText ?? shown(plan?.goal)}
            onChange={(e) => type(setGoalText)(e.target.value)}
          />
        </label>
        <label className="field-line">
          <span>{PLAN_CAP_FIELD}</span>
          <input
            type="text"
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            placeholder="$0"
            value={capText ?? shown(plan?.cap)}
            onChange={(e) => type(setCapText)(e.target.value)}
          />
        </label>
      </div>
      <div className="sheet-group">
        <SwitchRow icon="lock" label={PLAN_LOCK} on={locked} onChange={onLock} describedBy={noteId} />
      </div>
      {/* One thing said at a time, in one live line a screen reader hears: what the
          second tap will lock or save, else how the lock works. */}
      <p className="sheet-note" id={noteId} role="status">
        {lockArm.armed ? planArmLock(cap, goal) : saveLines.length > 0 ? saveLines.join(' ') : locked ? PLAN_LOCKED_NOTE : PLAN_OFF_NOTE}
      </p>
      {fit && fit.over > 0 && <p className="sheet-note">{planOverNote(fit.over)}</p>}
      {pending.map((line) => (
        <p key={line} className="sheet-note">
          {line}
        </p>
      ))}
      {pending.length > 0 && (
        <div className="sheet-group">
          <button type="button" className="sheet-row" onClick={() => void send({ cancel: true })}>
            <Icon name="undo" size={18} />
            <span>{PLAN_CANCEL}</span>
            <span />
          </button>
        </div>
      )}
      {err && (
        <p className="sheet-err" role="alert">
          {err}
        </p>
      )}
      {/* While the lock is armed its second tap sends the typed amounts too, so Save would only undo the arming. */}
      {dirty && !lockArm.armed && (
        <button type="button" className="btn-primary" onClick={onSave}>
          {saveArm.armed ? PLAN_SAVE_AGAIN : PLAN_SAVE}
        </button>
      )}
    </div>
  )
}

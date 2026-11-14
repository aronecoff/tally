import { useEffect, useRef, useState, type RefObject } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Icon } from '../../components/Icon'
import { ImportBody } from '../../components/ImportSheet'
import { Sheet, SheetActions } from '../../components/Sheet'
import { useSheetClose, useSheetDirty } from '../../components/sheetStack'
import { db } from '../../db/db'
import { restoreBackup, type BackupFile } from '../../lib/backup'
import { BudgetRefused, writeBudgets } from '../../lib/budgetWrite'
import { brand } from './brand'
import { markOnboarded, needsFirstRun, restoreOffer } from './onboarded'
import { loadSampleData } from './sampleData'
import { seedDefaults } from './seed'

type Step = 'start' | 'budgets' | 'import' | 'restore'

const TITLE: Record<Step, string> = {
  start: `Welcome to ${brand.name}`,
  budgets: 'Set your budgets',
  import: 'Import a file',
  restore: 'Restore your data',
}

/**
 * The first thing a new install shows: how to start, in one sheet. Closing it at
 * any point leaves a working app, and every path here can be taken later from
 * Accounts, Categories or Settings. The bank sheet opens from onClose, so two
 * sheets are never open at once.
 */
export function FirstRun({ onConnectBank }: { onConnectBank: () => void }) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('start')
  const [offer, setOffer] = useState<BackupFile | null>(null)
  const after = useRef<(() => void) | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const found = await restoreOffer()
      if (!live) return
      if (found) {
        setOffer(found)
        setStep('restore')
        setOpen(true)
        return
      }
      await seedDefaults() // a device whose only backups would not read
      const yes = await needsFirstRun()
      if (live) setOpen(yes)
    })()
    return () => {
      live = false
    }
  }, [])

  if (!open) return null
  return (
    <Sheet
      kind="first-run"
      title={TITLE[step]}
      onClose={() => {
        markOnboarded()
        setOpen(false)
        // Closed without restoring: the backups stay in Settings, and the app runs.
        void seedDefaults()
        after.current?.()
      }}
    >
      {step === 'restore' && offer && <RestoreOffer offer={offer} />}
      {step === 'start' && <Start go={setStep} afterRef={after} onConnectBank={onConnectBank} />}
      {step === 'budgets' && <Budgets />}
      {step === 'import' && <ImportBody doneLabel="Next" onDone={() => setStep('budgets')} />}
    </Sheet>
  )
}

/** Storage was lost and a backup survived it: bring it back, or start over. */
function RestoreOffer({ offer }: { offer: BackupFile }) {
  const close = useSheetClose()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const count = offer.transactions.filter((t) => !t.deleted).length
  const saved = new Date(offer.exportedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  async function restore() {
    setBusy(true)
    setFailed(false)
    try {
      await restoreBackup(offer) // the page reloads
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <>
      <p className="sheet-note">
        Your data is not on this phone any more, but a backup from {saved} holds {count} transaction{count === 1 ? '' : 's'}.
      </p>
      {failed && <p className="sheet-err">Could not restore. Try again.</p>}
      <SheetActions>
        <button type="button" className="btn-ghost" disabled={busy} onClick={close}>
          Start fresh
        </button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void restore()}>
          {busy ? 'Restoring…' : 'Restore your data'}
        </button>
      </SheetActions>
    </>
  )
}

interface StartProps {
  go: (step: Step) => void
  afterRef: RefObject<(() => void) | null>
  onConnectBank: () => void
}

function Start({ go, afterRef, onConnectBank }: StartProps) {
  const close = useSheetClose()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function sample() {
    setBusy(true)
    setFailed(false)
    try {
      await loadSampleData()
      close()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <>
      <p className="sheet-note">Your money stays on this phone, with no account to create. Choose how to start.</p>

      <div className="sheet-group">
        <PathRow icon="plus" title="Track by hand" sub="Add what you spend as you go." onClick={() => go('budgets')} />
        <PathRow icon="download" title="Import a file" sub="A CSV, OFX or QFX from your bank or card." onClick={() => go('import')} />
        <PathRow
          icon="bank"
          title="Connect SimpleFIN"
          sub="A read-only bank link. SimpleFIN is a separate paid service."
          onClick={() => {
            afterRef.current = onConnectBank
            close()
          }}
        />
      </div>
      <p className="sheet-note">Use one for each account. A file and a bank link for the same account can overlap.</p>

      <div className="sheet-group">
        <PathRow
          icon="sparkles"
          title="Load sample data"
          sub="Look around with invented figures."
          disabled={busy}
          onClick={() => void sample()}
        />
      </div>
      {failed && <p className="sheet-err">Could not load the sample. Try again.</p>}
    </>
  )
}

interface PathProps {
  icon: string
  title: string
  sub: string
  disabled?: boolean
  onClick: () => void
}

function PathRow({ icon, title, sub, disabled, onClick }: PathProps) {
  return (
    <button type="button" className="sheet-row path-row" disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={18} />
      <span className="path-main">
        <span>{title}</span>
        <span className="path-sub">{sub}</span>
      </span>
      <Icon name="chevron" size={14} className="chev" />
    </button>
  )
}

/** What a money field keeps of what was typed: digits, one dot, and cents. */
function typedAmount(raw: string): string {
  const v = raw.replace(/[^\d.]/g, '')
  const dot = v.indexOf('.')
  if (dot === -1) return v
  return (v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')).slice(0, dot + 3)
}

/** A monthly limit for each spending category, all optional. */
function Budgets() {
  const close = useSheetClose()
  const categories = useLiveQuery(() => db.categories.filter((c) => !c.deleted && c.kind === 'expense').sortBy('sortOrder'), [])
  const [typed, setTyped] = useState<Record<number, string>>({})
  /** Why the budgets were not saved. */
  const [failed, setFailed] = useState<string | null>(null)
  useSheetDirty(Object.values(typed).some(Boolean))

  async function save() {
    setFailed(null)
    const now = Date.now()
    const changes = Object.entries(typed)
      .map(([id, value]) => ({ id: Number(id), monthlyBudget: Number(value) }))
      .filter((c) => c.monthlyBudget > 0)
    try {
      // All of them or none. There is normally no savings plan this early; if
      // one is locked, budgets past it are refused with the reason.
      await db.transaction('rw', db.categories, () => writeBudgets(changes, { now }))
      close()
    } catch (e) {
      setFailed(e instanceof BudgetRefused ? e.message : 'Could not save. Try again.')
    }
  }

  return (
    <>
      <p className="sheet-note">A monthly limit for each category. Leave any blank, and change them later in Categories.</p>
      <div className="field-group">
        {(categories ?? []).map((c) => (
          <label className="field-line" key={c.id}>
            <span>{c.name}</span>
            <input
              inputMode="decimal"
              enterKeyHint="next"
              placeholder="No budget"
              value={typed[c.id!] ?? ''}
              onChange={(e) => {
                const v = typedAmount(e.target.value)
                setTyped((t) => ({ ...t, [c.id!]: v }))
              }}
            />
          </label>
        ))}
      </div>
      {failed && <p className="sheet-err">{failed}</p>}
      <SheetActions>
        <button type="button" className="btn-primary" onClick={() => void save()}>
          Done
        </button>
      </SheetActions>
    </>
  )
}

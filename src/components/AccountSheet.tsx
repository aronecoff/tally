import { useId, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Account, type AccountType } from '../db/db'
import { saidFromRow } from '../lib/accountEdits'
import { ago } from '../lib/dates'
import { splitMask } from '../lib/merchants'
import { rovingKeys } from '../lib/pressable'
import { TIERS } from '../lib/tiers'
import { useArmed } from '../lib/useArmed'
import { Icon } from './Icon'
import { Sheet, SheetActions } from './Sheet'
import { useSheetClose, useSheetDirty } from './sheetStack'

interface Props {
  /** null = add a new account; an Account = edit it. */
  initial: Account | null
  onClose: () => void
}

/** Add or edit an account's balance, institution, name and type. */
export function AccountSheet({ initial, onClose }: Props) {
  // The title names the object: 'Chase Checking', not 'Edit account'.
  const title = initial ? `${initial.institution} ${splitMask(initial.name).base}`.trim() : 'Add account'
  return (
    <Sheet kind="account" title={title} onClose={onClose}>
      <AccountForm initial={initial} />
    </Sheet>
  )
}

function AccountForm({ initial }: { initial: Account | null }) {
  const close = useSheetClose()
  const formId = useId()
  const editing = initial != null
  // The row as stored now: a connector sync can land while the sheet is open,
  // and the balance field follows it until the user types.
  const live = useLiveQuery(() => (initial?.id != null ? db.accounts.get(initial.id) : undefined), [initial?.id])
  const current = live ?? initial
  const [institution, setInstitution] = useState(initial?.institution ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<AccountType>(initial?.type ?? 'cash')
  // The balance is the figure (unsigned, as money: '2525.80') plus its sign,
  // each null until the user touches it. The iOS decimal pad has no minus key,
  // so the sign has its own control.
  const [digitsEdit, setDigitsEdit] = useState<string | null>(null)
  const [negEdit, setNegEdit] = useState<boolean | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  // One write at a time (a second Enter or tap while one is in flight does nothing).
  const busy = useRef(false)
  const { armed, arm } = useArmed()

  const storedDigits = current ? Math.abs(current.balance).toFixed(2) : ''
  const storedNeg = !!current && current.balance < 0
  const digits = digitsEdit ?? storedDigits
  const neg = negEdit ?? storedNeg
  // Touched and different from what is stored. An untouched balance is never
  // written: writing the open-time figure reverted a sync that landed meanwhile.
  const balanceChanged = editing
    ? (digitsEdit != null && digitsEdit !== storedDigits) || (negEdit != null && negEdit !== storedNeg)
    : digits !== '' || neg

  const isCredit = type === 'credit'
  const digitsNum = Number(digits)
  const valid = institution.trim() !== '' && !Number.isNaN(digitsNum)
  // `|| 0` keeps a zero from being stored as -0.
  const nextBalance = (neg ? -1 : 1) * (Math.round(digitsNum * 100) / 100) || 0

  useSheetDirty(
    institution !== (initial?.institution ?? '') ||
      name !== (initial?.name ?? '') ||
      type !== (initial?.type ?? 'cash') ||
      balanceChanged,
  )

  async function save() {
    if (!valid || busy.current) return
    busy.current = true
    const now = Date.now()
    const nextName = name.trim() || (TIERS.find((t) => t.type === type)?.label ?? 'Account')
    setSaveErr(null)
    try {
      if (editing && initial?.id != null) {
        // Only the fields the user changed. A plain Save writes nothing, so a
        // stale balance is never relabelled 'Updated just now'.
        const patch: Partial<Account> = {}
        if (institution !== initial.institution) patch.institution = institution.trim()
        if (name !== initial.name) patch.name = nextName
        if (type !== initial.type) patch.type = type
        // A live row stored before its connector's own record was kept: the
        // values the user just changed were the connector's, so they become
        // that record, and the next sync keeps the user's (lib/accountEdits).
        if (current?.liveSync && !current.sourceSaid && Object.keys(patch).length > 0) patch.sourceSaid = saidFromRow(initial)
        if (balanceChanged) {
          patch.balance = nextBalance
          // A live row's freshness belongs to its connector: a typed balance
          // lasts until the next sync, and never claims a fresh one.
          if (!current?.liveSync) patch.lastUpdated = now
        }
        if (Object.keys(patch).length > 0) await db.accounts.update(initial.id, { ...patch, updatedAt: now })
      } else {
        const maxOrder = (await db.accounts.toArray()).reduce((m, a) => Math.max(m, a.sortOrder), -1)
        await db.accounts.add({
          institution: institution.trim(),
          name: nextName,
          type,
          balance: nextBalance,
          lastUpdated: now,
          updatedAt: now,
          liveSync: false,
          sortOrder: maxOrder + 1,
        } as Account)
      }
    } catch {
      busy.current = false
      setSaveErr('Could not save. Try again.')
      return
    }
    close()
  }

  async function remove() {
    if (!editing || initial?.id == null || busy.current) return
    busy.current = true
    try {
      await db.accounts.update(initial.id, { deleted: true, updatedAt: Date.now() })
    } catch {
      busy.current = false
      setSaveErr('Could not delete. Try again.')
      return
    }
    close()
  }

  return (
    <form
      id={formId}
      className="sheet-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="amount-display">
        {/* A card's figure is what is owed, so its direction is in the words
            and the sign control; any other account below zero reads '−$'. */}
        <span className="currency" aria-hidden="true">{neg && !isCredit ? '−$' : '$'}</span>
        <input
          aria-label="Balance"
          inputMode="decimal"
          type="text"
          placeholder="0"
          value={digits}
          autoFocus={!editing}
          style={{ width: `${Math.max(digits.length, 1) + 0.15}ch` }}
          onChange={(e) => {
            const raw = e.target.value
            // A leading minus (typed on a keyboard, or pasted) sets the sign.
            if (/^\s*[-−]/.test(raw)) setNegEdit(true)
            let v = raw.replace(/[^\d.]/g, '')
            const dot = v.indexOf('.')
            if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
            v = v.replace(/^(\d*\.\d{2}).*$/, '$1') // clamp to cents
            setDigitsEdit(v)
          }}
        />
      </div>
      {/* Says which way the balance points: what Save would store, sign included. */}
      <p className="amount-display-note">
        {isCredit ? (neg ? 'Credit on this card' : 'Balance owed on this card') : neg ? 'Below zero' : 'Current balance'}
      </p>
      <div className="seg" role="radiogroup" aria-label="Balance sign" onKeyDown={rovingKeys}>
        {[false, true].map((n) => (
          <button
            key={String(n)}
            type="button"
            className={neg === n ? 'seg-on' : ''}
            role="radio"
            aria-checked={neg === n}
            tabIndex={neg === n ? 0 : -1}
            onClick={() => setNegEdit(n)}
          >
            {isCredit ? (n ? 'In credit' : 'Owed') : n ? 'Negative' : 'Positive'}
          </button>
        ))}
      </div>

      {current?.liveSync && (
        <p className="acct-live-note">
          <Icon name="repeat" size={13} />
          Synced from {current.source === 'snaptrade' ? 'your brokerage' : 'your bank'} · updated {ago(current.lastUpdated)}.
          <br />
          A name or type set here stays; a balance edited here lasts until the next sync. Deleting hides the
          account from net worth until you restore it under Connections.
        </p>
      )}

      <div className="field-group">
        <label className="field-line">
          <span>Institution</span>
          <input
            type="text"
            className={institution.trim() === '' ? 'is-required' : undefined}
            placeholder="Required"
            enterKeyHint="done"
            autoCorrect="off"
            spellCheck={false}
            autoCapitalize="words"
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
          />
        </label>
        <label className="field-line">
          <span>Name</span>
          <input
            type="text"
            placeholder="Checking"
            enterKeyHint="done"
            autoCorrect="off"
            spellCheck={false}
            autoCapitalize="words"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field-line">
          <span>Type</span>
          <span className="acct-sheet-select">
            <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
              {TIERS.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.type === 'credit' ? 'Credit card' : t.label}
                </option>
              ))}
            </select>
            <Icon name="chevron" size={13} />
          </span>
        </label>
      </div>

      <SheetActions>
        {saveErr && (
          <div className="limit-warn is-over" role="alert">
            <Icon name="alert" size={16} />
            <span>{saveErr}</span>
          </div>
        )}
        <button type="submit" form={formId} className="btn-primary" disabled={!valid}>
          {editing ? 'Save' : 'Add'}
        </button>
        {editing && (
          <button
            type="button"
            className={`acct-sheet-delete${armed ? ' is-armed' : ''}`}
            onClick={() => {
              if (arm()) void remove()
            }}
          >
            {armed ? (initial?.liveSync ? 'Tap again to remove' : 'Tap again to delete') : 'Delete account'}
          </button>
        )}
      </SheetActions>
    </form>
  )
}

import { useId, useRef, useState } from 'react'
import { db, type Account, type AccountType } from '../db/db'
import { ago } from '../lib/dates'
import { splitMask } from '../lib/merchants'
import { TIERS } from '../lib/tiers'
import { useArmed } from '../lib/useArmed'
import { Icon } from './Icon'
import { Sheet, SheetActions, useSheetClose, useSheetDirty } from './Sheet'

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
  const [institution, setInstitution] = useState(initial?.institution ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<AccountType>(initial?.type ?? 'cash')
  const [balance, setBalance] = useState(initial ? String(initial.balance) : '')
  const [saveErr, setSaveErr] = useState<string | null>(null)
  // One write at a time (a second Enter or tap while one is in flight does nothing).
  const busy = useRef(false)
  const { armed, arm } = useArmed()

  const isCredit = type === 'credit'
  const balanceNum = Number(balance)
  const valid = institution.trim() !== '' && !Number.isNaN(balanceNum)

  useSheetDirty(
    institution !== (initial?.institution ?? '') ||
      name !== (initial?.name ?? '') ||
      type !== (initial?.type ?? 'cash') ||
      balance !== (initial ? String(initial.balance) : ''),
  )

  async function save() {
    if (!valid || busy.current) return
    busy.current = true
    const now = Date.now()
    const fields = {
      institution: institution.trim(),
      name: name.trim() || (TIERS.find((t) => t.type === type)?.label ?? 'Account'),
      type,
      // An untouched balance is written back exactly as stored (a negative
      // balance, say an overpaid card, is never flipped by a plain Save).
      balance:
        editing && balance === String(initial.balance) ? initial.balance : Math.round(Math.abs(balanceNum) * 100) / 100,
      lastUpdated: now,
      updatedAt: now,
    }
    setSaveErr(null)
    try {
      if (editing && initial?.id != null) await db.accounts.update(initial.id, fields)
      else {
        const maxOrder = (await db.accounts.toArray()).reduce((m, a) => Math.max(m, a.sortOrder), -1)
        await db.accounts.add({ ...fields, liveSync: false, sortOrder: maxOrder + 1 } as Account)
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
      setSaveErr('Could not save. Try again.')
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
        <span className="currency" aria-hidden="true">$</span>
        <input
          aria-label="Balance"
          inputMode="decimal"
          type="text"
          placeholder="0"
          value={balance}
          autoFocus={!editing}
          style={{ width: `${Math.max(balance.length, 1) + 0.15}ch` }}
          onChange={(e) => {
            let v = e.target.value.replace(/[^\d.]/g, '')
            const dot = v.indexOf('.')
            if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
            v = v.replace(/^(\d*\.\d{2}).*$/, '$1') // clamp to cents
            setBalance(v)
          }}
        />
      </div>
      <p className="amount-display-note">{isCredit ? 'Balance owed on this card' : 'Current balance'}</p>

      {initial?.liveSync && (
        <p className="acct-live-note">
          <Icon name="repeat" size={13} />
          Synced from {initial.source === 'snaptrade' ? 'your brokerage' : 'your bank'} · updated {ago(initial.lastUpdated)}.
          <br />
          Edits here last until the next sync.
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
            {armed ? 'Tap again to delete' : 'Delete account'}
          </button>
        )}
      </SheetActions>
    </form>
  )
}

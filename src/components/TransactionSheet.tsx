import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction, type TxType } from '../db/db'
import { todayISO, dayHeading, dayLabel } from '../lib/dates'
import { guessCategoryName } from '../lib/categorize'
import { accountLabel, cleanMerchant, merchantInfo } from '../lib/merchants'
import { money } from '../lib/format'
import { isRefund } from '../lib/ledger'
import { useArmed } from '../lib/useArmed'
import { rovingKeys } from '../lib/pressable'
import { Icon } from './Icon'
import { Pending } from './Pending'
import { Refund } from './Refund'
import { Sheet, SheetActions, useSheetClose, useSheetDirty } from './Sheet'

interface Props {
  categories: Category[]
  /** null = create new; a Transaction = edit existing. */
  initial: Transaction | null
  onClose: () => void
  /** Sort queue: called after each successful save (App advances the queue). */
  onSaved?: () => void
  /** Sort queue position, e.g. '1 of 4' (the title reads 'Sort · 1 of 4'). */
  progress?: string
  /** Sort queue: how many rows remain after this one ('Save & next' while > 0). */
  remaining?: number
}

const SAVE_ERR = 'Could not save. Try again.'

/**
 * The account the way people say it ('Citizens Money Market ··4837'). The mask
 * is the most identifying part, so when space runs out the label gives way
 * first and the mask is never cut. Display only.
 */
function AcctText({ raw }: { raw: string }) {
  const { label, mask } = accountLabel(raw)
  return (
    <span className="field-value" title={raw}>
      <span className="txn-acct-name">{label}</span>
      {mask && <span className="txn-acct-mask">{`\u00a0··${mask}`}</span>}
    </span>
  )
}

/**
 * The transaction sheet. The Sheet stays mounted while the form body is keyed
 * by the transaction, so the sort queue swaps rows without re-opening it.
 */
export function TransactionSheet({ categories, initial, onClose, onSaved, progress, remaining }: Props) {
  return (
    <Sheet
      kind="txn"
      title={txnTitle(initial, categories, progress)}
      headLeading={initial ? <TxnLogo key={initial.id ?? 'row'} initial={initial} categories={categories} /> : undefined}
      onClose={onClose}
    >
      <TxnForm
        key={initial?.id ?? 'new'}
        categories={categories}
        initial={initial}
        onSaved={onSaved}
        more={!!progress && (remaining ?? 0) > 0}
      />
    </Sheet>
  )
}

/**
 * The head names the object: the merchant, then one quiet line with the facts
 * (pending, day). The account is not repeated here: the Account row names it
 * in full. A new transaction is 'New transaction'; the sort queue leads with
 * its position and moves the merchant into the line.
 */
function txnTitle(initial: Transaction | null, categories: Category[], progress?: string): ReactNode {
  if (!initial) return progress ? `Sort · ${progress}` : 'New transaction'
  const cat = categories.find((c) => c.id === initial.categoryId)
  const merchant = merchantInfo(initial.note ?? '').name
  const name = merchant || cat?.name || 'Transaction'
  return (
    <>
      <span className="txn-head-name">{progress ? `Sort · ${progress}` : name}</span>
      <span className="txn-head-sub">
        {progress && merchant ? `${merchant} · ` : ''}
        {initial.pending && <Pending />}
        {isRefund(initial) && <Refund />}
        {dayHeading(initial.date)}
      </span>
    </>
  )
}

/** Merchant favicon when the brand is known (and loads), else the category glyph. */
function TxnLogo({ initial, categories }: { initial: Transaction; categories: Category[] }) {
  const [failed, setFailed] = useState(false)
  const logoUrl = merchantInfo(initial.note ?? '').logoUrl
  const cat = categories.find((c) => c.id === initial.categoryId)
  return (
    <span className="txn-logo" aria-hidden="true">
      {logoUrl && !failed ? (
        <img src={logoUrl} alt="" width={22} height={22} onError={() => setFailed(true)} />
      ) : (
        <Icon name={cat?.icon ?? 'tag'} size={20} />
      )}
    </span>
  )
}

interface FormProps {
  categories: Category[]
  initial: Transaction | null
  onSaved?: () => void
  /** More rows follow in the sort queue: keep the sheet open after saving. */
  more: boolean
}

function TxnForm({ categories, initial, onSaved, more }: FormProps) {
  const close = useSheetClose()
  const formId = useId()
  const capId = useId()
  const editing = initial != null
  // Bank-synced rows keep the bank's account string; it is shown, not edited.
  const synced = (initial?.uid ?? '').startsWith('sf:')
  // A refund is stored negative; the field shows the figure and save restores
  // the sign. Switched to Income it becomes ordinary money in.
  const refund = initial != null && isRefund(initial)
  const initialAmount = initial ? Math.abs(initial.amount).toFixed(2) : ''
  // A rejected IndexedDB write (quota full, an upgrade blocked by another tab)
  // used to be swallowed, so the sheet closed and the save looked like it worked.
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [type, setType] = useState<TxType>(initial?.type ?? 'expense')
  // Two decimals from the start ('100.00', not '100'): the same value, shown
  // the way the rest of the app shows it.
  const [amount, setAmount] = useState(initialAmount)
  const [date, setDate] = useState(initial?.date ?? todayISO())
  // The date the sheet opened with, held once, so a date-only edit counts as
  // unsaved (a new row's default is today at mount, not today at each render).
  const [date0] = useState(date)
  const [pickedCategoryId, setPickedCategoryId] = useState<number | null>(initial?.categoryId ?? null)
  const [note, setNote] = useState(initial?.note ?? '')
  const [account, setAccount] = useState(initial?.account ?? '')
  const [touchedCategory, setTouchedCategory] = useState(editing)
  const guessedOnce = useRef(editing)
  // One write at a time: a second Enter or tap while a save or delete is in
  // flight (or after it succeeded and the sheet is closing) does nothing.
  const busy = useRef(false)
  const { armed, arm, disarm } = useArmed(8000)

  // Purchase detail (edit mode): who the merchant is + your history with them.
  // Banks never transmit the purchased items, so the "what did I buy?" answer
  // is a deep link into the merchant's own order page.
  const merchant = useMemo(() => (editing ? merchantInfo(initial?.note ?? '') : null), [editing, initial?.note])
  const hasMerchant = editing && !!initial?.note?.trim() && cleanMerchant(initial.note) !== ''
  // undefined while the query runs (nothing is rendered until it answers).
  const history = useLiveQuery(async () => {
    if (!editing || !initial?.note?.trim()) return null
    const key = cleanMerchant(initial.note).toLowerCase()
    if (!key) return null
    const all = await db.transactions.toArray()
    // Charges only: a refund is neither a charge nor part of the average.
    const same = all
      .filter((t) => !t.deleted && t.id !== initial.id && t.type === initial.type && t.amount > 0 && cleanMerchant(t.note).toLowerCase() === key)
      .sort((a, b) => b.date.localeCompare(a.date))
    if (same.length === 0) return null
    const self = initial.amount > 0 ? [initial.amount] : []
    const count = same.length + self.length
    const total = same.reduce((s, t) => s + t.amount, 0) + self.reduce((s, x) => s + x, 0)
    return { count, total, avg: total / count, last: same[0] }
  }, [editing, initial?.id, initial?.note, initial?.type, initial?.amount])

  const visibleCategories = useMemo(
    () => categories.filter((c) => c.kind === type).sort((a, b) => a.sortOrder - b.sortOrder),
    [categories, type],
  )

  // A picked category that isn't valid for the current kind counts as unset —
  // the type was toggled, or a sync from another device deleted the category.
  // Derived during render, so no effect has to chase it after the fact.
  const categoryId =
    pickedCategoryId != null && visibleCategories.some((c) => c.id === pickedCategoryId)
      ? pickedCategoryId
      : null

  // Unsaved edits: a drag down springs back instead of closing.
  const dirty =
    amount !== initialAmount ||
    note !== (initial?.note ?? '') ||
    pickedCategoryId !== (initial?.categoryId ?? null) ||
    type !== (initial?.type ?? 'expense') ||
    date !== date0 ||
    account !== (initial?.account ?? '')
  useSheetDirty(dirty)

  // Auto-suggest a category from the note — but only once, and never after the
  // user has picked one, so it never fights their choice. Driven by the events
  // that can change the answer (typing a note, switching expense/income) rather
  // than by an effect, which would need a second render pass to apply it.
  function suggestCategory(nextNote: string, nextType: TxType) {
    if (touchedCategory || guessedOnce.current) return
    const guess = guessCategoryName(nextNote)
    if (!guess) return
    const match = categories.find((c) => c.kind === nextType && c.name === guess)
    if (match) {
      setPickedCategoryId(match.id ?? null)
      guessedOnce.current = true
    }
  }

  function changeType(next: TxType) {
    setType(next)
    suggestCategory(note, next)
  }

  const amountNum = Number(amount)
  const valid = amount !== '' && !Number.isNaN(amountNum) && amountNum > 0
  const refundNow = refund && type === 'expense'

  // Accountability: how much is already spent in the selected category this month
  // (excluding the row being edited), so we can warn before this entry breaches a budget.
  const monthOfDate = date.slice(0, 7)
  const priorSpend = useLiveQuery(async () => {
    if (type !== 'expense' || categoryId == null) return 0
    const rows = await db.transactions.where('categoryId').equals(categoryId).toArray()
    return rows
      .filter((r) => r.type === 'expense' && !r.deleted && r.date.startsWith(monthOfDate) && r.id !== initial?.id)
      .reduce((s, r) => s + r.amount, 0)
  }, [type, categoryId, monthOfDate, initial?.id], 0)

  const selectedCat = categories.find((c) => c.id === categoryId)
  // A refund lowers the category, so it never warns about a budget.
  const limit = selectedCat?.kind === 'expense' && !refundNow ? selectedCat.monthlyBudget : 0
  const projected = (priorSpend ?? 0) + (valid ? amountNum : 0)
  const warnOver = limit > 0 && valid && projected > limit
  const warnNear = limit > 0 && valid && !warnOver && projected >= limit * 0.85

  async function save() {
    if (!valid || busy.current) return
    busy.current = true
    const now = Date.now()
    const cents = Math.round(amountNum * 100) / 100
    const fields = {
      date,
      amount: refundNow ? -cents : cents,
      type,
      categoryId,
      account: account.trim(),
      note: note.trim(),
      // A hand-edit is authoritative: pin it so bank re-syncs never revert it.
      manual: true,
      updatedAt: now,
    }
    setSaveErr(null)
    try {
      if (editing && initial?.id != null) {
        await db.transactions.update(initial.id, fields)
      } else {
        await db.transactions.add({ ...fields, createdAt: now } as Transaction)
      }
    } catch {
      // Stay open with the typed values intact so nothing is lost.
      busy.current = false
      setSaveErr(SAVE_ERR)
      return
    }
    if (onSaved) {
      onSaved()
      if (!more) close()
    } else {
      close()
    }
  }

  async function remove() {
    if (!editing || initial?.id == null || busy.current) return
    busy.current = true
    // Pin the delete: without `manual`, a bank re-sync would resurrect the row.
    try {
      await db.transactions.update(initial.id, { deleted: true, manual: true, updatedAt: Date.now() })
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
      className="sheet-form txn-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {editing && initial?.pending && (
        <p className="txn-pending-note">
          This charge is still pending. Edits here stay pinned after it posts, so check Activity once it clears.
        </p>
      )}
      {refundNow && (
        <p className="txn-pending-note">
          A refund. It comes off what you spent in its category.
        </p>
      )}

      <div className={`amount-display${type === 'income' || refundNow ? ' is-income' : ''}`}>
        <span className="currency" aria-hidden="true">$</span>
        <input
          aria-label="Amount"
          inputMode="decimal"
          type="text"
          placeholder="0"
          value={amount}
          autoFocus={!editing}
          style={{ width: `${Math.max(amount.length, 1) + 0.15}ch` }}
          onChange={(e) => {
            // Strip anything but digits and a single decimal point (handles
            // pasted "1,234.56", currency symbols, etc.), clamped to cents —
            // otherwise a paste like "100.50.25" silently became 100.5025.
            let v = e.target.value.replace(/[^\d.]/g, '')
            const dot = v.indexOf('.')
            if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
            v = v.replace(/^(\d*\.\d{2}).*$/, '$1')
            setAmount(v)
          }}
        />
      </div>

      {hasMerchant && history !== undefined && (history || !refund) && (
        <p className="txn-history">
          {history ? (
            <>
              {history.count} charges · avg {money(history.avg)} · last {dayLabel(history.last.date)}
            </>
          ) : (
            'First charge here'
          )}
        </p>
      )}

      <div className="seg" role="radiogroup" aria-label="Type" onKeyDown={rovingKeys}>
        <button
          type="button"
          className={type === 'expense' ? 'seg-on' : ''}
          role="radio"
          aria-checked={type === 'expense'}
          tabIndex={type === 'expense' ? 0 : -1}
          onClick={() => changeType('expense')}
        >
          Expense
        </button>
        <button
          type="button"
          className={type === 'income' ? 'seg-on' : ''}
          role="radio"
          aria-checked={type === 'income'}
          tabIndex={type === 'income' ? 0 : -1}
          onClick={() => changeType('income')}
        >
          Income
        </button>
      </div>

      <div className="txn-cap" id={capId}>Category</div>
      <div className="chip-grid" role="group" aria-labelledby={capId}>
        {visibleCategories.map((c) => {
          const on = c.id === categoryId
          return (
            <button
              key={c.id}
              type="button"
              className={`chip ${on ? 'on' : ''}`}
              aria-pressed={on}
              onClick={() => {
                setTouchedCategory(true)
                setPickedCategoryId(on ? null : c.id ?? null)
              }}
            >
              <span className="chip-ic">
                <Icon name={c.icon} size={15} />
              </span>
              {c.name}
            </button>
          )
        })}
      </div>

      {(warnOver || warnNear) && selectedCat && (
        <div className={`limit-warn ${warnOver ? 'is-over' : 'is-near'}`}>
          <Icon name="alert" size={16} />
          <span>
            {warnOver ? (
              <>This puts {selectedCat.name} <strong className="num">{money(projected - limit)}</strong> over budget.</>
            ) : (
              <>Only <strong className="num">{money(limit - projected)}</strong> left in {selectedCat.name} after this.</>
            )}
          </span>
        </div>
      )}

      <div className="field-group">
        <label className="field-line">
          <span>Description</span>
          <input
            type="text"
            placeholder="Merchant or note"
            enterKeyHint="done"
            autoCorrect="off"
            spellCheck={false}
            autoCapitalize="words"
            value={note}
            onChange={(e) => {
              setNote(e.target.value)
              suggestCategory(e.target.value, type)
            }}
          />
        </label>
        <label className="field-line">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {synced ? (
          <div className="field-line">
            <span>Account</span>
            <AcctText raw={account} />
          </div>
        ) : (
          <label className="field-line">
            <span>Account</span>
            <input
              type="text"
              placeholder="Optional"
              enterKeyHint="done"
              autoCorrect="off"
              spellCheck={false}
              autoCapitalize="words"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
          </label>
        )}
      </div>

      {merchant && (merchant.orderUrl || merchant.searchUrl) && (
        <a
          className="txn-lookup"
          href={(merchant.orderUrl ?? merchant.searchUrl)!}
          target="_blank"
          rel="noopener noreferrer"
        >
          {merchant.orderUrl ? merchant.orderLabel : 'Look up this charge'}
          <Icon name="arrow-up-right" size={13} />
        </a>
      )}

      <SheetActions>
        {saveErr && (
          <div className="limit-warn is-over" role="alert">
            <Icon name="alert" size={16} />
            <span>{saveErr}</span>
          </div>
        )}
        <button type="submit" form={formId} className="btn-primary" disabled={!valid}>
          {editing ? (more ? 'Save & next' : 'Save') : 'Add'}
        </button>
        {editing &&
          (armed ? (
            <div className="txn-confirm" role="group" aria-label="Confirm delete">
              <p>Delete this transaction? It stays deleted after the next bank sync.</p>
              <button type="button" className="txn-confirm-cancel" onClick={disarm}>
                Cancel
              </button>
              <button
                type="button"
                className="txn-confirm-delete"
                onClick={() => {
                  if (arm()) void remove()
                }}
              >
                Delete transaction
              </button>
            </div>
          ) : (
            <button type="button" className="txn-delete" data-testid="txn-delete" onClick={() => arm()}>
              Delete
            </button>
          ))}
      </SheetActions>
    </form>
  )
}

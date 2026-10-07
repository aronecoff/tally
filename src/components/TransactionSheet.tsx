import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction, type TxType } from '../db/db'
import { todayISO, dayHeading, dayLabel } from '../lib/dates'
import { guessCategoryName, isFixed, isRentCategory } from '../lib/categorize'
import { dateMovedMark, rentRefile } from '../lib/bankRules'
import { accountLabel, cleanMerchant, merchantInfo } from '../lib/merchants'
import { money } from '../lib/format'
import { isRefund } from '../lib/ledger'
import { DOUBLE_TAP_MS, useArmed } from '../lib/useArmed'
import { rovingKeys } from '../lib/pressable'
import { Icon } from './Icon'
import { Pending } from './Pending'
import { Refund } from './Refund'
import { Sheet, SheetActions } from './Sheet'
import { useSheetClose, useSheetDirty, useSheetFocusReturn } from './sheetStack'

interface Props {
  categories: Category[]
  /** null = create new; a Transaction = edit existing. */
  initial: Transaction | null
  onClose: () => void
  /** Sort queue: called after each row is settled, saved or deleted (App advances the queue). */
  onSaved?: () => void
  /** A new row was added, filed under this date (App shows its month). */
  onAdded?: (date: string) => void
  /** Sort queue position, e.g. '1 of 4' (the title reads 'Sort · 1 of 4'). */
  progress?: string
  /** Sort queue: how many rows remain after this one ('Save & next' while > 0). */
  remaining?: number
}

const SAVE_ERR = 'Could not save. Try again.'
/** A whole day. A date field cleared part way (or all the way) reports ''. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

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
export function TransactionSheet({ categories, initial, onClose, onSaved, onAdded, progress, remaining }: Props) {
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
        onAdded={onAdded}
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
  onAdded?: (date: string) => void
  /** More rows follow in the sort queue: keep the sheet open after saving. */
  more: boolean
}

function TxnForm({ categories, initial, onSaved, onAdded, more }: FormProps) {
  const close = useSheetClose()
  const { opener, setReturnFocus } = useSheetFocusReturn()
  const formId = useId()
  const capId = useId()
  const editing = initial != null
  // Income is money in: its history counts deposits, never charges.
  const noun = initial?.type === 'income' ? 'deposit' : 'charge'
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
  const [typedDate, setDate] = useState(initial?.date ?? todayISO())
  // The date the sheet opened with, held once, so a date-only edit counts as
  // unsaved (a new row's default is today at mount, not today at each render).
  const [date0] = useState(typedDate)
  const [dateTouched, setDateTouched] = useState(false)
  const [pickedCategoryId, setPickedCategoryId] = useState<number | null>(initial?.categoryId ?? null)
  const [note, setNote] = useState(initial?.note ?? '')
  const [account, setAccount] = useState(initial?.account ?? '')
  const [touchedCategory, setTouchedCategory] = useState(editing)
  // The user turned the category chip off (not a kind switch dropping it), now
  // or in an earlier edit: a choice the self-heal must not undo
  // (Transaction.uncategorized). Picking a chip lifts it.
  const clearedByUser = useRef(!!initial?.uncategorized)
  // One write at a time: a second Enter or tap while a save or delete is in
  // flight (or after it succeeded and the sheet is closing) does nothing.
  const busy = useRef(false)
  const { armed, arm, disarm } = useArmed(8000)

  // The sort queue remounts this form for each row (it is keyed by the row),
  // so the second tap of a double tap on 'Save & next' lands on the NEXT
  // row's button and saved that row unseen. A queue submit that arrives within
  // the double-tap window of the row appearing is ignored.
  const shownAt = useRef(Infinity)
  useEffect(() => {
    shownAt.current = performance.now()
  }, [])

  // Keyboard path to delete: arming moves focus to Cancel (the safe choice; a
  // held Enter can never confirm), and Cancel or the auto-disarm brings it
  // back to Delete. The swap used to drop focus to <body>.
  const cancelRef = useRef<HTMLButtonElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const wasArmed = useRef(false)
  useEffect(() => {
    if (armed) cancelRef.current?.focus()
    else if (wasArmed.current) {
      const a = document.activeElement
      if (!a || a === document.body) deleteRef.current?.focus()
    }
    wasArmed.current = armed
  }, [armed])

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

  // A bank payment filed into Rent counts on the 1st it pays for, exactly as
  // the bank sync dates rent paid early; filed out of Rent, on the day the bank
  // posted it (bankRules.rentRefile). Shown in the Date field before Save, so
  // the budget warning reads the month it will land in. A date the user set
  // wins; a typed row, a refund and income are never moved.
  const initialCat = categories.find((c) => c.id === initial?.categoryId)
  const pickedCat = categories.find((c) => c.id === categoryId)
  const rentMove =
    editing && initial && !dateTouched
      ? rentRefile(
          { uid: initial.uid, date: typedDate, type, amount: refund && type === 'expense' ? -1 : 1, posted: initial.posted },
          !!initialCat && isRentCategory(initialCat),
          !!pickedCat && isRentCategory(pickedCat),
        )
      : null
  const date = rentMove?.date ?? typedDate

  // Unsaved edits: a drag down springs back instead of closing.
  const dirty =
    amount !== initialAmount ||
    note !== (initial?.note ?? '') ||
    pickedCategoryId !== (initial?.categoryId ?? null) ||
    type !== (initial?.type ?? 'expense') ||
    date !== date0 ||
    account !== (initial?.account ?? '')
  useSheetDirty(dirty)

  // Auto-suggest a category from the note. Until the user taps a chip, the pick
  // follows the latest guess, and clears when there is none: locking onto the
  // first word that matched filed 'Uber Eats' under Transport and 'Barber'
  // under Dining. A tapped chip (and edit mode) always wins. Driven by the
  // events that can change the answer (typing a note, switching
  // expense/income) rather than by an effect, which would need a second render
  // pass to apply it.
  function suggestCategory(nextNote: string, nextType: TxType) {
    if (touchedCategory) return
    const guess = guessCategoryName(nextNote, nextType)
    const match = guess ? categories.find((c) => c.kind === nextType && c.name === guess) : undefined
    setPickedCategoryId(match?.id ?? null)
  }

  function changeType(next: TxType) {
    setType(next)
    suggestCategory(note, next)
  }

  const amountNum = Number(amount)
  const valid = amount !== '' && !Number.isNaN(amountNum) && amountNum > 0
  const refundNow = refund && type === 'expense'
  // A date field cleared part way reports ''. Saved, the row matched no month
  // and fell out of every total for good (pinned, so no bank sync restored it).
  const dateOk = ISO_DAY.test(date)
  const canSave = valid && dateOk

  // Accountability: how much is already spent in the selected category this month
  // (excluding the row being edited), so we can warn before this entry breaches a budget.
  // While the date is blank, the month the sheet opened on (''.startsWith would
  // sum every month).
  const monthOfDate = (dateOk ? date : date0).slice(0, 7)
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
  // What this category-month held before this edit: an existing row's own
  // amount counts when it already sat here. Reopening a charge already counted
  // (or lowering it, or changing only its note) is not news; only an edit that
  // adds spending is (a new row, a raise, a move into the category or month).
  const wasHere =
    initial != null &&
    !initial.deleted &&
    initial.type === 'expense' &&
    initial.categoryId === categoryId &&
    initial.date.slice(0, 7) === monthOfDate
  const baseline = (priorSpend ?? 0) + (wasHere ? initial.amount : 0)
  const adds = !editing || projected > baseline + 0.005
  // A fixed bill landing at its budget is expected, never 'near' (as on Budget).
  const fixedCat = selectedCat ? isFixed(selectedCat) : false
  const warnOver = limit > 0 && valid && adds && projected > limit
  const warnNear = limit > 0 && valid && adds && !warnOver && !fixedCat && projected >= limit * 0.85

  /** Sort queue: move on to the next row (closing after the last); else close. */
  function settle() {
    if (onSaved) {
      onSaved()
      if (!more) close()
    } else {
      close()
    }
  }

  async function save() {
    if (!canSave || busy.current) return
    if (onSaved && performance.now() - shownAt.current < DOUBLE_TAP_MS) return
    busy.current = true
    const now = Date.now()
    const cents = Math.round(amountNum * 100) / 100
    const signed = refundNow ? -cents : cents
    // Left empty on purpose: never re-filed.
    const uncategorized = categoryId == null && clearedByUser.current
    let added = false
    setSaveErr(null)
    try {
      if (editing && initial?.id != null) {
        // Only the fields the user changed, measured against the row the sheet
        // opened on. Writing the whole form put back the open-time amount and
        // date over a bank update that landed meanwhile, and pinned the row.
        // The raw strings are compared, so a bank note with stray spaces is
        // not an edit.
        const patch: Partial<Transaction> = {}
        if (date !== date0) patch.date = date
        // The day a move into Rent leaves, kept for a move back out (local only).
        if (rentMove?.posted && rentMove.posted !== initial.posted) patch.posted = rentMove.posted
        // A date set here, by hand or by the re-file, is a move the bank never
        // re-dates while the row is pending (local only, banks.ts); the bank's
        // own day put back is not.
        if (patch.date !== undefined) patch.dateMoved = dateMovedMark(patch.date, rentMove?.posted ?? initial.posted)
        // A refund switched to Income flips its sign.
        if (amount !== initialAmount || refundNow !== refund) patch.amount = signed
        if (type !== initial.type) patch.type = type
        if (categoryId !== (initial.categoryId ?? null) || uncategorized !== !!initial.uncategorized) {
          patch.categoryId = categoryId
          patch.uncategorized = uncategorized
        }
        if (note !== (initial.note ?? '')) patch.note = note.trim()
        if (!synced && account !== (initial.account ?? '')) patch.account = account.trim()
        // Nothing changed: nothing is written and nothing pinned. A charge the
        // bank removed while the sheet was open is not written to either (a pin
        // on it would offer it back under Removed).
        const stored = Object.keys(patch).length > 0 ? await db.transactions.get(initial.id) : undefined
        if (stored && !(stored.deleted && !initial.deleted)) {
          // A hand-edit is authoritative: pin it so bank re-syncs never revert it.
          await db.transactions.update(initial.id, { ...patch, manual: true, updatedAt: now })
        }
      } else {
        await db.transactions.add({
          date,
          amount: signed,
          type,
          categoryId,
          account: account.trim(),
          note: note.trim(),
          manual: true,
          uncategorized,
          createdAt: now,
          updatedAt: now,
        } as Transaction)
        added = true
      }
    } catch {
      // Stay open with the typed values intact so nothing is lost.
      busy.current = false
      setSaveErr(SAVE_ERR)
      return
    }
    if (added) onAdded?.(date)
    settle()
  }

  /** The row to focus once this one is gone: the next in its list, else the one before. */
  function neighborOfOpener(): HTMLElement | null {
    if (!opener) return null
    const rows = [...(opener.closest('.pane')?.querySelectorAll<HTMLElement>('.txn-row') ?? [])]
    const i = rows.indexOf(opener)
    if (i === -1) return null
    return rows[i + 1] ?? rows[i - 1] ?? null
  }

  async function remove() {
    if (!editing || initial?.id == null || busy.current) return
    busy.current = true
    // Picked before the row leaves the list (the opener is usually that row).
    const next = neighborOfOpener()
    // Pin the delete: without `manual`, a bank re-sync would resurrect the row.
    try {
      await db.transactions.update(initial.id, { deleted: true, manual: true, updatedAt: Date.now() })
    } catch {
      busy.current = false
      setSaveErr('Could not delete. Try again.')
      return
    }
    if (next) setReturnFocus(next)
    // Sort queue: a delete settles this row as a save does, so move on.
    settle()
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
          This {noun} is still pending. Edits here carry over when it posts, and the amount follows the bank until then.
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
              {history.count} {history.count === 1 ? noun : `${noun}s`} · avg {money(history.avg)} · last{' '}
              {dayLabel(history.last.date)}
            </>
          ) : (
            `First ${noun} here`
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
              title={c.name}
              onClick={() => {
                setTouchedCategory(true)
                clearedByUser.current = on
                setPickedCategoryId(on ? null : c.id ?? null)
              }}
            >
              <span className="chip-ic">
                <Icon name={c.icon} size={15} />
              </span>
              {/* Its own part, so a long name ends in '…' inside the chip. */}
              <span className="chip-label">{c.name}</span>
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
          <input
            type="date"
            required
            aria-invalid={!dateOk || undefined}
            value={date}
            onChange={(e) => {
              setDate(e.target.value)
              setDateTouched(true)
            }}
          />
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

      {/* Income gets the brand's own link only: a web search for a charge
          answers nothing about a deposit. */}
      {merchant && (merchant.orderUrl || (noun === 'charge' && merchant.searchUrl)) && (
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
        {!dateOk && (
          <div className="limit-warn is-near" role="status">
            <Icon name="alert" size={16} />
            <span>Pick a date to save.</span>
          </div>
        )}
        <button type="submit" form={formId} className="btn-primary" disabled={!canSave}>
          {editing ? (more ? 'Save & next' : 'Save') : 'Add'}
        </button>
        {editing &&
          (armed ? (
            <div className="txn-confirm" role="group" aria-label="Confirm delete">
              <p>Delete this transaction? It stays deleted after the next bank sync.</p>
              <button type="button" className="txn-confirm-cancel" ref={cancelRef} onClick={disarm}>
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
            <button type="button" className="txn-delete" data-testid="txn-delete" ref={deleteRef} onClick={() => arm()}>
              Delete
            </button>
          ))}
      </SheetActions>
    </form>
  )
}

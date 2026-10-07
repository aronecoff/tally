import { useId, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction } from '../db/db'
import { supabase } from '../db/supabase'
import { EXAMPLES, MAX_COMMAND, hideExample, parseCommand, planCommand, rowParts, type Plan } from '../lib/commands'
import { applyPlan, undoPlan, type Applied } from '../lib/commandRun'
import { dayLabel, todayISO } from '../lib/dates'
import { money } from '../lib/format'
import { isRefund } from '../lib/ledger'
import { Sheet, SheetActions } from './Sheet'

interface Props {
  categories: Category[]
  onClose: () => void
}

type OkPlan = Extract<Plan, { ok: true }>
type Step =
  | { at: 'idle' }
  | { at: 'error'; message: string }
  | { at: 'preview'; plan: OkPlan }
  /** `partial`: only part of the plan was saved, and the title says what was ('Forgot 1 of 2 rules'). */
  | { at: 'done'; title: string; note?: string; partial?: boolean }
  | { at: 'undone'; title: string }

/** A change applied while the sheet is open, and what Undo needs to take it back. */
interface Change {
  title: string
  applied: Applied
}

/**
 * Preview, Apply and Undo take turns in one place, so the second tap of a
 * double tap lands on the button that just replaced the one tapped. Apply and
 * Undo ignore a tap this soon after they appear: a double tap on Preview had
 * applied a change unseen, and one on Apply undid it.
 */
const SETTLE_MS = 400

/** 'Sep 1' never splits across lines in a title. */
const keepDates = (s: string) => s.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b/g, '$1 $2')

/** Rules are saved to the account, so a plan only promises one when signed in. */
async function canSaveRules(): Promise<boolean> {
  if (!supabase) return false
  try {
    const { data } = await supabase.auth.getSession()
    return !!data.session
  } catch {
    return false
  }
}

/**
 * Tell Tally: one line in, and a preview of exactly what would change. Nothing
 * is written until Apply, and Undo takes the change back. The phrasings are
 * fixed (lib/commands.ts); there is no AI behind it and nothing to pay for.
 */
export function CommandSheet({ categories, onClose }: Props) {
  return (
    <Sheet kind="command" title="Tell Tally" onClose={onClose}>
      <CommandBody categories={categories} />
    </Sheet>
  )
}

function CommandBody({ categories }: { categories: Category[] }) {
  const formId = useId()
  const [text, setText] = useState('')
  const [step, setStep] = useState<Step>({ at: 'idle' })
  // Every change applied since the sheet opened, newest last. Undo takes back
  // the newest only: undoPlan writes the old values back, so undoing an older
  // one first would overwrite a newer edit to the same rows. Typing a new
  // command keeps them; closing the sheet ends them (hidden rows can still be
  // brought back from Activity › Removed).
  const [changes, setChanges] = useState<Change[]>([])
  const busy = useRef(false)
  const shownAt = useRef(0)
  const input = useRef<HTMLInputElement>(null)

  // The hide example, from the newest posted charge, so it finds something.
  const newest = useLiveQuery(
    () =>
      db.transactions
        .orderBy('date')
        .reverse()
        .filter((t) => !t.deleted && !t.pending && t.type === 'expense' && t.amount > 0)
        .first(),
    [],
  )
  const examples = newest ? [...EXAMPLES.slice(0, 3), hideExample(newest)] : EXAMPLES

  const show = (s: Step) => {
    shownAt.current = performance.now()
    setStep(s)
  }
  const settled = () => performance.now() - shownAt.current >= SETTLE_MS

  /** With the on-screen keyboard up, a small phone showed one row above Apply. */
  function dropKeyboard() {
    const el = input.current
    if (!el || document.activeElement !== el || !el.closest('.sheet-backdrop')?.hasAttribute('data-kb')) return
    // To the dialog (tabIndex -1, no outline): not <body>, which loses focus
    // out of the sheet, and never Apply, which a second Go would press.
    el.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true })
  }

  async function preview() {
    if (busy.current || !text.trim()) return
    const parsed = parseCommand(text, categories, todayISO())
    if (!parsed.ok) return show({ at: 'error', message: parsed.message })
    busy.current = true
    try {
      const rules = await canSaveRules()
      const plan = planCommand(parsed.command, await db.transactions.toArray(), categories, { rules })
      // An error keeps the keyboard: the next step is retyping.
      if (!plan.ok) return show({ at: 'error', message: plan.message })
      show({ at: 'preview', plan })
      dropKeyboard()
    } finally {
      busy.current = false
    }
  }

  async function apply(plan: OkPlan) {
    if (busy.current || !settled()) return
    busy.current = true
    try {
      const applied = await applyPlan(plan)
      // Part of a plan is named for what it did, and Undo takes back just that.
      const title = applied.title ?? plan.title
      setChanges((c) => [...c, { title, applied }])
      show({ at: 'done', title, note: applied.note, partial: !!applied.title })
      // After part of a plan the words stay, so Preview plans the rest.
      if (!applied.title) setText('')
    } catch {
      show({ at: 'error', message: 'Could not save. Try again.' })
    } finally {
      busy.current = false
    }
  }

  async function undo(last: Change) {
    if (busy.current || !settled()) return
    busy.current = true
    try {
      await undoPlan(last.applied)
      setChanges((c) => c.filter((x) => x !== last))
      show({ at: 'undone', title: last.title })
    } catch {
      // The change is still whole (undoPlan stops before any row when the rule
      // cannot be taken back), so Undo stays for another try.
      show({ at: 'error', message: 'Could not undo. Try again.' })
    } finally {
      busy.current = false
    }
  }

  const fill = (example: string) => {
    setText(example)
    setStep({ at: 'idle' })
    input.current?.focus()
  }

  const last = changes.at(-1)
  // Right after Apply the box is empty and Undo is the one action.
  const showPreview = !(step.at === 'done' && !text && last)

  return (
    <form
      id={formId}
      className="sheet-form cmd-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void preview()
      }}
    >
      <label className="field">
        <input
          ref={input}
          aria-label="Command"
          type="text"
          placeholder="move rent to Oct 1"
          enterKeyHint="go"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={MAX_COMMAND}
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // A preview belongs to the words it was made from. Undo stays.
            if (step.at !== 'idle') setStep({ at: 'idle' })
          }}
        />
      </label>

      <div className="cmd-result" aria-live="polite">
        {step.at === 'preview' && <Preview plan={step.plan} />}
        {step.at === 'error' && <p className="cmd-error">{step.message}</p>}
        {step.at === 'done' && (
          <>
            {/* "Done" would overstate part of a plan: its title heads the result instead. */}
            <p className="cmd-title">{step.partial ? keepDates(step.title) : 'Done'}</p>
            {!step.partial && <p className="cmd-note">{keepDates(step.title)}</p>}
            {step.note && <p className="cmd-note">{step.note}</p>}
          </>
        )}
        {step.at === 'undone' && (
          <>
            <p className="cmd-title">Undone</p>
            <p className="cmd-note">{keepDates(step.title)}</p>
          </>
        )}
        {(step.at === 'idle' || step.at === 'error') && (
          <div className="cmd-examples">
            <p className="cmd-note">Move a transaction, file a merchant, set a budget, or hide something. Try:</p>
            <div className="chip-grid">
              {examples.map((x) => (
                <button key={x} type="button" className="chip" onClick={() => fill(x)}>
                  {x}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <SheetActions>
        {step.at === 'preview' ? (
          <button type="button" className="btn-primary" onClick={() => void apply(step.plan)}>
            Apply
          </button>
        ) : (
          <>
            {showPreview && (
              <button type="submit" form={formId} className="btn-primary" disabled={!text.trim()}>
                Preview
              </button>
            )}
            {last && (
              <button type="button" className="cmd-undo" aria-label={`Undo: ${last.title}`} onClick={() => void undo(last)}>
                {step.at === 'done' ? 'Undo' : 'Undo last change'}
              </button>
            )}
          </>
        )}
      </SheetActions>
    </form>
  )
}

const moneyIn = (t: Transaction) => t.type === 'income' || isRefund(t)

/** Exactly what Apply would change, row by row. */
function Preview({ plan }: { plan: OkPlan }) {
  const year = new Date().getFullYear()
  // Past 8 rows the rest folds into "and N more": money coming in and the
  // largest rows go first, so a paycheck is never among the unseen.
  const many = plan.rows.length > 8
  const rows = many
    ? [...plan.rows].sort((a, b) => Number(moneyIn(b.t)) - Number(moneyIn(a.t)) || Math.abs(b.t.amount) - Math.abs(a.t.amount))
    : plan.rows
  const spent = plan.rows.reduce((n, r) => (moneyIn(r.t) ? n : n + Math.abs(r.t.amount)), 0)
  const back = plan.rows.reduce((n, r) => (moneyIn(r.t) ? n + Math.abs(r.t.amount) : n), 0)
  const otherYear = plan.rows.some((r) => !r.t.date.startsWith(String(year)))
  return (
    <>
      <p className="cmd-title">{keepDates(plan.title)}</p>
      {rows.length > 0 && (
        <ul className={`field-group cmd-rows${otherYear ? ' has-year' : ''}`}>
          {rows.slice(0, 8).map((r) => {
            const { name, amount } = rowParts(r.t)
            return (
              <li key={r.t.id} className="cmd-row">
                <span className="cmd-row-date">{dayLabel(r.t.date, year)}</span>
                <span className="cmd-row-name">{name}</span>
                <span className="cmd-row-amt num">{amount}</span>
                <span className="cmd-row-to">{r.to}</span>
              </li>
            )
          })}
        </ul>
      )}
      {many && (
        <p className="cmd-note">
          and {plan.rows.length - 8} more. In all: {[spent > 0 && `${money(spent)} spent`, back > 0 && `+${money(back)} coming in`].filter(Boolean).join(' · ')}
        </p>
      )}
      {plan.budget && (
        <p className="cmd-note">
          Now {plan.budget.before > 0 ? money(plan.budget.before, { trim: true }) : 'no budget'}.
        </p>
      )}
      {plan.notes?.map((n, i) => (
        <p key={i} className="cmd-note">
          {n}
        </p>
      ))}
      {!!plan.pending && (
        <p className="cmd-note">
          {plan.pending === 1 ? '1 pending charge is' : `${plan.pending} pending charges are`} left until{' '}
          {plan.pending === 1 ? 'it posts' : 'they post'}.
        </p>
      )}
    </>
  )
}

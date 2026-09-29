import { useId, useRef, useState } from 'react'
import { db, type Category } from '../db/db'
import { EXAMPLES, parseCommand, planCommand, rowLabel, type Plan } from '../lib/commands'
import { applyPlan, undoPlan, type Applied } from '../lib/commandRun'
import { dayLabel, todayISO } from '../lib/dates'
import { money } from '../lib/format'
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
  | { at: 'done'; title: string; applied: Applied }
  | { at: 'undone'; title: string }

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
  const busy = useRef(false)
  const input = useRef<HTMLInputElement>(null)

  async function preview() {
    if (busy.current || !text.trim()) return
    const parsed = parseCommand(text, categories, todayISO())
    if (!parsed.ok) return setStep({ at: 'error', message: parsed.message })
    const plan = planCommand(parsed.command, await db.transactions.toArray(), categories)
    setStep(plan.ok ? { at: 'preview', plan } : { at: 'error', message: plan.message })
  }

  async function apply(plan: OkPlan) {
    if (busy.current) return
    busy.current = true
    try {
      const applied = await applyPlan(plan)
      setStep({ at: 'done', title: plan.title, applied })
      setText('')
    } catch {
      setStep({ at: 'error', message: 'Could not save. Try again.' })
    } finally {
      busy.current = false
    }
  }

  async function undo(title: string, applied: Applied) {
    if (busy.current) return
    busy.current = true
    try {
      await undoPlan(applied)
      setStep({ at: 'undone', title })
    } catch {
      setStep({ at: 'error', message: 'Could not undo. Try again.' })
    } finally {
      busy.current = false
    }
  }

  const fill = (example: string) => {
    setText(example)
    setStep({ at: 'idle' })
    input.current?.focus()
  }

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
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // A preview belongs to the words it was made from; typing a new
            // command also ends the chance to undo the last one.
            if (step.at !== 'idle') setStep({ at: 'idle' })
          }}
        />
      </label>

      <div className="cmd-result" aria-live="polite">
        {step.at === 'preview' && <Preview plan={step.plan} />}
        {step.at === 'error' && <p className="cmd-error">{step.message}</p>}
        {step.at === 'done' && (
          <>
            <p className="cmd-title">Done</p>
            <p className="cmd-note">{step.title}</p>
            {step.applied.note && <p className="cmd-note">{step.applied.note}</p>}
          </>
        )}
        {step.at === 'undone' && (
          <>
            <p className="cmd-title">Undone</p>
            <p className="cmd-note">{step.title}</p>
          </>
        )}
        {(step.at === 'idle' || step.at === 'error') && (
          <div className="cmd-examples">
            <p className="cmd-note">Move a transaction, file a merchant, set a budget, or hide something. Try:</p>
            <div className="chip-grid">
              {EXAMPLES.map((x) => (
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
        ) : step.at === 'done' ? (
          <button type="button" className="cmd-undo" onClick={() => void undo(step.title, step.applied)}>
            Undo
          </button>
        ) : (
          <button type="submit" form={formId} className="btn-primary" disabled={!text.trim()}>
            Preview
          </button>
        )}
      </SheetActions>
    </form>
  )
}

/** Exactly what Apply would change, row by row. */
function Preview({ plan }: { plan: OkPlan }) {
  return (
    <>
      <p className="cmd-title">{plan.title}</p>
      {plan.rows.length > 0 && (
        <ul className="field-group cmd-rows">
          {plan.rows.slice(0, 8).map((r) => (
            <li key={r.t.id} className="cmd-row">
              <span className="cmd-row-date">{dayLabel(r.t.date)}</span>
              <span className="cmd-row-name">{rowLabel(r.t)}</span>
              <span className="cmd-row-to">{r.to}</span>
            </li>
          ))}
        </ul>
      )}
      {plan.rows.length > 8 && <p className="cmd-note">and {plan.rows.length - 8} more</p>}
      {plan.budget && (
        <p className="cmd-note">
          Now {plan.budget.before > 0 ? money(plan.budget.before, { trim: true }) : 'no budget'}.
        </p>
      )}
      {plan.others > 0 && (
        <p className="cmd-note">
          The most recent of {plan.others + plan.rows.length}. Add an amount or a date to pick another, or say "all".
        </p>
      )}
      {plan.rule && <p className="cmd-note">New charges from this merchant will follow it too.</p>}
    </>
  )
}

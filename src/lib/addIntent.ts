import { hasNative, native } from './native'

/**
 * "Add expense" from Siri and Shortcuts (ios/Shared/AddExpenseIntent.swift). The app
 * holds what was asked and the page takes it: on starting, for a launch the ask caused,
 * and when the app nudges, for a page that was already up. All it does is open the add
 * sheet with the fields filled in. Nothing is written until someone taps Add.
 *
 * In a browser and in the Mac app no one can ask, so this does nothing.
 */
export interface AddPrefill {
  /** Each ask is its own sheet, even in the same words. */
  n: number
  /** As the Amount field holds it. Empty when what came was not an amount. */
  amount: string
  note: string
}

/** What the app hands over. Empty when nothing is waiting. */
interface Ask {
  amount?: unknown
  note?: unknown
}

const NUDGE = 'app:add-expense'
/** Past this it is not an amount anyone meant, and toFixed stops writing digits. */
const MOST = 1e9
const LONGEST_NOTE = 200

let asks = 0

function toPrefill(ask: Ask): AddPrefill {
  const { amount, note } = ask
  return {
    n: ++asks,
    amount: typeof amount === 'number' && amount > 0 && amount < MOST ? amount.toFixed(2) : '',
    note: typeof note === 'string' ? note.trim().slice(0, LONGEST_NOTE) : '',
  }
}

/** Calls `open` with each ask, now and to come. Returns how to stop. */
export function startAddIntent(open: (prefill: AddPrefill) => void): () => void {
  if (!hasNative()) return () => {}
  const take = () =>
    void native<Ask>('addExpense.take')
      .then((ask) => {
        if (ask.amount !== undefined) open(toPrefill(ask))
      })
      .catch(() => {}) // an older app around the page has no such door
  window.addEventListener(NUDGE, take)
  take()
  return () => window.removeEventListener(NUDGE, take)
}

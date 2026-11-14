import { db } from '../db/db'
import { todayISO } from './dates'
import { homeDays, homeFigures, homeHistoryFrom } from './homeFigures'
import { getPlan } from './planCache'
import { capInForce } from './savingsPlan'

/** Home's figures for the live month, whichever month Home is showing, from the rows Home reads. */
export async function homeNow() {
  const today = todayISO()
  const month = today.slice(0, 7)
  const { dayOfMonth, daysInMonth } = homeDays(today)
  // One read, so a sync landing halfway cannot mix two moments.
  const [monthTxns, recentTxns, cats] = await db.transaction('r', db.transactions, db.categories, () =>
    Promise.all([
      db.transactions.where('date').startsWith(month).toArray(),
      db.transactions.where('date').aboveOrEqual(homeHistoryFrom(today)).toArray(),
      db.categories.filter((c) => !c.deleted).toArray(),
    ]),
  )
  const cap = capInForce(getPlan(), today)
  return { month, dayOfMonth, daysInMonth, cats, d: homeFigures({ monthTxns, recentTxns, month, cats, daysInMonth, dayOfMonth, cap }) }
}

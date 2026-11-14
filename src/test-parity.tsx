/**
 * One invented ledger, and every screen and figure made from it, for the two
 * parity tests (src/parity.noplan.test.tsx and its public twin). The pictures
 * they keep were taken before the savings plan existed, so with no plan in
 * force nothing a person sees or the app sends may differ from them.
 *
 * Every name, amount and date here is made up, and the clock is pinned.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { Account } from './components/Account'
import { Analysis } from './components/Analysis'
import { Categories } from './components/Categories'
import { Dashboard } from './components/Dashboard'
import { Home } from './components/Home'
import { db, type Category, type Transaction } from './db/db'
import { alertWords, crossings } from './lib/budgetAlerts'
import { applyPlan, undoPlan } from './lib/commandRun'
import { parseCommand, planCommand } from './lib/commands'
import { homeNow } from './lib/homeNow'
import { buildWidgetSnapshot } from './lib/widgetSnapshot'

/** A made-up day, ten days before this month's pay. */
export const PARITY_NOW = '2031-03-18T12:00:00'
const TODAY = '2031-03-18'
const MONTH = '2031-03'
const PAST = '2031-01'

const cat = (id: number, name: string, monthlyBudget: number, extra: Partial<Category> = {}): Category => ({
  id, uid: `cat-${id}`, name, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, updatedAt: 1, ...extra,
})

const CATS: Category[] = [
  cat(1, 'Rent', 1200, { key: 'rent', icon: 'home' }),
  cat(2, 'Groceries', 450, { icon: 'cart' }),
  cat(3, 'Dining', 220.5, { icon: 'utensils' }),
  cat(4, 'Fun', 150, { icon: 'sparkles' }),
  cat(5, 'Travel', 0, { icon: 'car' }),
  cat(8, 'Salary', 0, { kind: 'income', key: 'salary', icon: 'briefcase' }),
  cat(9, 'Other income', 0, { kind: 'income', key: 'other income', icon: 'plus-circle' }),
]

let nextId = 1
const row = (date: string, amount: number, categoryId: number | null, note: string, extra: Partial<Transaction> = {}): Transaction => ({
  id: nextId++, uid: `row-${nextId}`, date, amount, type: 'expense', categoryId, account: 'Card', note, createdAt: 1, updatedAt: 1, ...extra,
})
const pay = (date: string, amount: number) => row(date, amount, 8, 'NORTHWIND PAYROLL', { type: 'income' })

/** A full month: rent, pay twice, and enough purchases to count as whole. */
function wholeMonth(month: string, dining: number): Transaction[] {
  const out = [row(`${month}-01`, 1200, 1, 'BRAMBLE COURT APTS'), pay(`${month}-12`, 1900), pay(`${month}-26`, 1900)]
  for (let i = 0; i < 6; i++) out.push(row(`${month}-${String(3 + i * 4).padStart(2, '0')}`, 61.4 + i, 2, 'FERNWAY MARKET'))
  for (let i = 0; i < 5; i++) out.push(row(`${month}-${String(5 + i * 5).padStart(2, '0')}`, dining + i * 2.25, 3, 'KETTLE AND CROW'))
  out.push(row(`${month}-20`, 48, 4, 'LANTERN CINEMA'))
  return out
}

function ledger(): Transaction[] {
  nextId = 1
  return [
    ...wholeMonth('2030-12', 31),
    ...wholeMonth('2031-01', 52),
    ...wholeMonth('2031-02', 38),
    // The live month, before its pay: rent, a few purchases, interest only.
    row('2031-03-01', 1200, 1, 'BRAMBLE COURT APTS'),
    row('2031-03-03', 64.18, 2, 'FERNWAY MARKET'),
    row('2031-03-08', 71.02, 2, 'FERNWAY MARKET'),
    row('2031-03-10', 58.4, 2, 'FERNWAY MARKET'),
    row('2031-03-06', 212.75, 3, 'KETTLE AND CROW'),
    row('2031-03-09', -18.5, 3, 'KETTLE AND CROW'), // a refund
    row('2031-03-14', 164.99, 4, 'LANTERN CINEMA'),
    row('2031-03-17', 23.6, 2, 'FERNWAY MARKET', { pending: true }),
    row('2031-03-16', 40, null, 'ZORBLATT 4411'), // uncategorized
    row('2031-03-15', 89, 5, 'TIDEWATER RAIL'),
    row('2031-03-07', 4.12, 9, 'INTEREST PAYMENT', { type: 'income' }),
    row(TODAY, 12.3, 3, 'KETTLE AND CROW'),
  ]
}

/** Put the ledger in the store, as it was before anything in the test changed it. */
export async function seedParityLedger(): Promise<void> {
  await db.transaction('rw', db.categories, db.transactions, db.accounts, async () => {
    await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])
    await db.categories.bulkAdd(CATS)
    await db.transactions.bulkAdd(ledger())
  })
}

/** Lets what a screen asks for when it mounts come back. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)) })
}

async function shot(ui: React.ReactElement, ready: string, from: () => Element | null = () => null): Promise<string> {
  const view = render(ui)
  await waitFor(() => {
    if (!document.querySelector(ready)) throw new Error(`waiting for ${ready}`)
  })
  await settle()
  const html = (from() ?? view.container).innerHTML
  cleanup()
  return html
}

const noop = () => {}

/** Everything a person sees and the app hands on, by name. */
export async function captureParity(): Promise<Record<string, string>> {
  vi.setSystemTime(new Date(PARITY_NOW))
  await seedParityLedger()
  const cats = CATS.filter((c) => !c.deleted)
  const out: Record<string, string> = {}
  // Home with its charts and lists open, so the whole screen is in the picture.
  localStorage.setItem('tally-home-detail', '1')

  out['home.html'] = await shot(<Home categories={cats} onEdit={noop} onMore={noop} active />, '.home-hero')
  out['budget.html'] = await shot(<Dashboard month={MONTH} categories={cats} active />, '.bud-hero')
  out['budget-past.html'] = await shot(<Dashboard month={PAST} categories={cats} active />, '.bud-hero')
  out['categories.html'] = await shot(<Categories categories={cats} />, '.cats')
  out['insights.html'] = await shot(<Analysis month={MONTH} categories={cats} active />, '.analysis')
  out['insights-past.html'] = await shot(<Analysis month={PAST} categories={cats} active />, '.analysis')
  out['settings.html'] = await shot(
    <Account onClose={noop} pref="system" setPref={noop} onCategories={noop} onBankConnections={noop} onImport={noop} onBackups={noop} />,
    '[role="dialog"] .sheet-body',
    () => document.querySelector('[role="dialog"] .sheet-body'),
  )

  const widget = await buildWidgetSnapshot()
  out['widget.json'] = JSON.stringify({ ...widget, asOf: 0 }, null, 2)
  const { month, cats: liveCats, d } = await homeNow()
  const lines = crossings(d, liveCats, month)
  out['alerts.json'] = JSON.stringify(lines.map((c) => ({ ...c, said: alertWords(c, false), quiet: alertWords(c, true) })), null, 2)

  // Tell Tally: a budget command from its words to what it writes, and back.
  const budgets = async () => (await db.categories.toArray()).map((c) => ({ id: c.id, monthlyBudget: c.monthlyBudget, updatedAt: c.updatedAt }))
  const parsed = parseCommand('set Dining budget to 300', cats, TODAY)
  const tell: Record<string, unknown> = { parsed }
  if (parsed.ok) {
    const plan = planCommand(parsed.command, await db.transactions.toArray(), cats, { rules: false, today: TODAY })
    tell.plan = plan
    if (plan.ok) {
      vi.setSystemTime(new Date('2031-03-18T12:00:05'))
      const applied = await applyPlan(plan)
      tell.applied = applied
      tell.afterApply = await budgets()
      vi.setSystemTime(new Date('2031-03-18T12:00:09'))
      await undoPlan(applied)
      tell.afterUndo = await budgets()
    }
  }
  out['tell.json'] = JSON.stringify(tell, null, 2)
  vi.setSystemTime(new Date(PARITY_NOW))
  return renumbered(out)
}

/**
 * A Settings sheet with the savings plan's group taken out, and how many of its
 * elements were there. Where the group shows with no plan in force (always in
 * the public app, and wherever a device holds an unlocked plan), the rest of
 * the sheet must still be what it was.
 */
export function withoutPlanGroup(html: string): { html: string; found: number } {
  const box = document.createElement('div')
  box.innerHTML = html
  const group = box.querySelectorAll('[data-plan]')
  group.forEach((el) => el.remove())
  return { html: box.innerHTML, found: group.length }
}

/**
 * React numbers the ids it makes up (the wheel's pattern) from one counter for
 * the whole page, so a second capture in one test file would carry on from the
 * first. Each is renamed by where it first appears, which is what a capture on
 * a fresh page gives.
 */
function renumbered(out: Record<string, string>): Record<string, string> {
  const seen = new Map<string, string>()
  const again: Record<string, string> = {}
  for (const [name, text] of Object.entries(out)) {
    again[name] = text.replace(/_r_[0-9a-z]+_/g, (id) => {
      if (!seen.has(id)) seen.set(id, `_r_${seen.size.toString(32)}_`)
      return seen.get(id)!
    })
  }
  return again
}

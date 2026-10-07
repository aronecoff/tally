import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { db, type Category, type Transaction } from '../db/db'
import { money, toCents } from '../lib/format'
import { isFixed } from '../lib/categorize'
import { BILL_MONTHS, oneOffRows, paceProjector } from '../lib/projection'
import { awaitingPay } from '../lib/payday'
import { beforePayday, budgetStatus, rowState, INCOME, OVERSPENT, SAVED, SPENDING, BY_MONTH_END, type RowState } from '../lib/copy'
import { dayLabel, monthLabel, shiftMonth } from '../lib/dates'
import { useToday } from '../lib/useToday'
import { useKeyedLiveQuery } from '../lib/useKeyedLiveQuery'
import { isRefund } from '../lib/ledger'
import { pressable } from '../lib/pressable'
import { useSettle } from '../lib/motion'
import { BudgetWheel, type WheelSlice } from './BudgetWheel'
import { Icon } from './Icon'
import { Money } from './Money'
import { Pending } from './Pending'
import { Refund } from './Refund'
import { Skeleton } from './Skeleton'

interface Props {
  month: string
  categories: Category[]
  onManageCategories?: () => void
  onEdit?: (t: Transaction) => void
  /** This pane is the visible one (a hidden pane skips the rebuild). */
  active: boolean
  /** Expand this category once (a nonce: n changes on every request). */
  initialOpen?: { key: string; n: number } | null
  /** Called after initialOpen has been applied. */
  onInitialOpenConsumed?: () => void
}

interface Row {
  id: number | null
  name: string
  icon: string
  spent: number
  limit: number
  projected: number
  /** A fixed monthly bill (the category's flag or built-in key, so a rename keeps it). */
  fixed: boolean
  state: RowState
  txns: Transaction[]
  pendingCount: number
}

const rowKey = (r: Row) => (r.id == null ? 'uncat' : String(r.id))

/** A budget with nothing spent and nothing filed yet. Grouped under 'Nothing yet'. */
const isIdle = (r: Row) => r.limit > 0 && r.spent === 0 && r.txns.length === 0

const reducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The month's figures. Every sum and projection is the pre-uplift maths,
 * unchanged; the two display-only sums at the end (unbudgeted, idle) add up
 * row figures that are already on screen.
 */
function buildModel(
  month: string,
  txns: Transaction[],
  history: Transaction[],
  categories: Category[],
  isCurrent: boolean,
  dayOfMonth: number,
  daysInMonth: number,
) {
  // Summed in whole cents and divided once: a float sum of 9.99 + 20.00 is
  // 29.990000000000002, which read 'Over budget · $0.00 over' a $29.99 budget.
  const byCatC = new Map<number | null, number>()
  // One-off rows count once, never at daily pace: big rows, refunds and
  // monthly bills (projection.oneOffRows, from the months before this one).
  const lumpByCatC = new Map<number | null, number>()
  const once = oneOffRows(txns, history, month)
  const txByCat = new Map<number | null, Transaction[]>()
  let incomeC = 0
  let expenseC = 0
  /** Display-only: rows in the month (an empty month says so, B104). */
  let count = 0
  for (const t of txns) {
    if (t.deleted) continue
    count++
    const c = toCents(t.amount)
    if (t.type === 'income') {
      incomeC += c
      continue
    }
    expenseC += c
    byCatC.set(t.categoryId, (byCatC.get(t.categoryId) ?? 0) + c)
    if (once.has(t)) lumpByCatC.set(t.categoryId, (lumpByCatC.get(t.categoryId) ?? 0) + c)
    const list = txByCat.get(t.categoryId)
    if (list) list.push(t)
    else txByCat.set(t.categoryId, [t])
  }
  for (const list of txByCat.values()) list.sort((a, b) => b.amount - a.amount)
  const income = incomeC / 100
  const expense = expenseC / 100
  const spentIn = (id: number | null) => (byCatC.get(id) ?? 0) / 100
  const lumpIn = (id: number | null) => (lumpByCatC.get(id) ?? 0) / 100
  const pendingIn = (list: Transaction[]) => list.reduce((n, t) => n + (t.pending ? 1 : 0), 0)

  // All pace math lives in lib/projection.ts (shared with Home). Past months
  // arrive with dayOfMonth = full, so they never extrapolate.
  const p = paceProjector(dayOfMonth, daysInMonth)

  const expenseCats = categories.filter((c) => c.kind === 'expense').sort((a, b) => a.sortOrder - b.sortOrder)
  const catSpends = expenseCats.map((c) => ({
    name: c.name,
    spent: spentIn(c.id!),
    budget: c.monthlyBudget || 0,
    fixed: isFixed(c),
    lump: lumpIn(c.id!),
  }))
  const rows: Row[] = expenseCats
    .map((c) => {
      const spent = spentIn(c.id!)
      const limit = c.monthlyBudget || 0
      const fixed = isFixed(c)
      const projected = p.forCategory(c.name, spent, limit, { fixed, lump: lumpIn(c.id!) })
      const list = txByCat.get(c.id!) ?? []
      return {
        id: c.id!,
        name: c.name,
        icon: c.icon,
        spent,
        limit,
        projected,
        fixed,
        // The shared thresholds (lib/copy.ts rowState, a verbatim copy of this screen's).
        state: rowState({ spent, limit, projected, fixed, isCurrent }),
        txns: list,
        pendingCount: pendingIn(list),
      }
    })
    // A category with no budget stays while it has rows this month, a net
    // refund included: dropped, the rows no longer added up to the hero.
    .filter((r) => r.limit > 0 || r.spent !== 0 || r.txns.length > 0)

  const uncat = spentIn(null)
  const uncatLump = lumpIn(null)
  // Listed whenever rows sit in it, even when a refund there outweighs the
  // purchases: they still need a category.
  const uncatList = txByCat.get(null) ?? []
  if (uncat !== 0 || uncatList.length > 0) {
    const list = uncatList
    rows.push({
      id: null, name: 'Uncategorized', icon: 'tag', spent: uncat, limit: 0,
      projected: p.forCategory('Uncategorized', uncat, 0, { fixed: false, lump: uncatLump }),
      fixed: false, state: 'none', txns: list, pendingCount: pendingIn(list),
    })
  }

  // Attention first: over, then pace, then near, then Uncategorized (the one
  // row with an action), then other unbudgeted spend, then the rest.
  const rank: Record<RowState, number> = { over: 0, pace: 1, near: 2, none: 3, ok: 4 }
  const rankOf = (r: Row) => (r.id === null ? 2.5 : rank[r.state])
  rows.sort((a, b) => rankOf(a) - rankOf(b) || b.spent - a.spent)

  const totalLimit = expenseCats.reduce((s, c) => s + toCents(c.monthlyBudget || 0), 0) / 100
  const idle = rows.filter(isIdle)
  return {
    count,
    income,
    expense,
    net: (incomeC - expenseC) / 100,
    rows: rows.filter((r) => !isIdle(r)),
    idle,
    totalLimit,
    projectedTotal: p.monthEnd(catSpends, expense, uncatLump),
    canProject: p.canProject && isCurrent,
    /** Display-only: spend in rows with no budget (Other + Uncategorized). */
    unbudgetedTotal: rows.filter((r) => r.limit <= 0 && r.spent > 0).reduce((s, r) => s + toCents(r.spent), 0) / 100,
    /** Display-only: the budgets of the idle rows. */
    idleSum: idle.reduce((s, r) => s + toCents(r.limit), 0) / 100,
    // The live month before payday (lib/payday.ts, shared with Home and
    // Insights). A finished month that earned nothing really did spend more
    // than it took in, so it keeps its word.
    awaitingIncome: isCurrent && awaitingPay(month, txns, history, categories),
  }
}

/**
 * Budget tab: one hero (the month's spend, a verdict word and a pace rail), the
 * budget wheel (angle = share of this month's spending, one colour per
 * category), then every category, attention first, each opening onto the exact
 * transactions filed under it. Budgets are the seeded monthly amounts, never
 * mutated here.
 */
export const Dashboard = memo(function Dashboard({
  month,
  categories,
  onManageCategories,
  onEdit,
  active,
  initialOpen,
  onInitialOpenConsumed,
}: Props) {
  const [open, setOpen] = useState<string | null>(null)
  // No default: undefined means 'still loading' (a skeleton), never an empty month.
  // A month step suspends rather than show the old month's figures under the
  // new label (lib/useKeyedLiveQuery).
  const txns = useKeyedLiveQuery(month, () => db.transactions.where('date').startsWith(month).toArray())
  // The months before: monthly bills (counted once in the projection) and
  // last month's income (has this month's pay landed?).
  const history = useKeyedLiveQuery(month, () =>
    db.transactions.where('date').between(`${shiftMonth(month, -BILL_MONTHS)}-01`, `${month}-01`).toArray(),
  )

  // The clock as a subscription, so a pane left open past midnight moves on.
  const today = useToday()
  const isCurrent = month === today.slice(0, 7)
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const dayOfMonth = isCurrent ? Number(today.slice(8, 10)) : daysInMonth

  // A hidden (keep-alive) pane keeps its last picture and skips the rebuild
  // until it is shown again; the catch-up happens in the render that shows it.
  const live = useMemo(
    () => ({ month, txns, history, categories, isCurrent, daysInMonth, dayOfMonth }),
    [month, txns, history, categories, isCurrent, daysInMonth, dayOfMonth],
  )
  const [shown, setShown] = useState(live)
  if (active && shown !== live) setShown(live)
  const src = active ? live : shown

  const data = useMemo(
    () =>
      src.txns && src.history
        ? buildModel(src.month, src.txns, src.history, src.categories, src.isCurrent, src.dayOfMonth, src.daysInMonth)
        : null,
    [src],
  )

  // Wheel slices: angle = share of this month's spending, largest first.
  const wheelSlices = useMemo<WheelSlice[]>(
    () =>
      (data ? data.rows : [])
        .filter((r) => r.spent > 0)
        .map((r) => ({ key: rowKey(r), name: r.name, spent: r.spent, limit: r.limit, state: r.state, count: r.txns.length }))
        .sort((a, b) => b.spent - a.spent),
    [data],
  )

  // Opened from elsewhere (Home's attention rows): expand once per request,
  // then bring the row into view once it exists.
  const scrollTarget = useRef<string | null>(null)
  useEffect(() => {
    if (!initialOpen) return
    setOpen(initialOpen.key)
    scrollTarget.current = initialOpen.key
    onInitialOpenConsumed?.()
    // A nonce: each request applies exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOpen?.n])
  useEffect(() => {
    const key = scrollTarget.current
    if (!key || !data) return
    scrollTarget.current = null
    requestAnimationFrame(() => document.getElementById(`bud-${key}`)?.scrollIntoView({ block: 'nearest' }))
  }, [data, open])

  const goToRow = useCallback((key: string) => {
    document.getElementById(`bud-${key}`)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })
  }, [])

  // The hero figure settles when it changes (a month step, a sync landing).
  const heroRef = useRef<HTMLElement>(null)
  useSettle(heroRef, '.hero-fig')

  if (!data) return <Skeleton variant="budget" />

  // Where an even spender would be today (day 21 of 30 → 70% of the month gone).
  // Drawn as a tick on each rail so "ahead of pace" is visible, not calculated.
  const paceP = src.isCurrent && src.daysInMonth > 0 ? Math.min(100, (src.dayOfMonth / src.daysInMonth) * 100) : null

  const hasLimit = data.totalLimit > 0
  const over = hasLimit && data.expense > data.totalLimit
  const overPace = hasLimit && !over && data.canProject && data.projectedTotal > data.totalLimit
  const heroState = over ? 'over' : overPace ? 'pace' : 'ok'
  const pct = hasLimit ? Math.min(100, (data.expense / data.totalLimit) * 100) : 0
  const left = data.totalLimit - data.expense
  const hasSpend = wheelSlices.length > 0
  // A past month that nets to nothing has no verdict: no state word, no sage.
  const noData = !src.isCurrent && data.expense === 0 && data.income === 0
  // A past month with no rows at all (before any history) says so, as Insights
  // and Activity do, instead of $0.00 against a budget rail. Keyed on rows, not
  // totals: refunds that cancel purchases are still a month with activity.
  const empty = !src.isCurrent && data.count === 0
  // The live month before payday: not 'Overspent' (buildModel).
  const awaitingIncome = data.awaitingIncome

  const drill = (r: Row) => (
    <ul className="bud-txns" id={`bud-txns-${rowKey(r)}`}>
      {r.txns.length === 0 ? (
        <li className="bud-txn-empty">No transactions this month.</li>
      ) : (
        r.txns.map((t) => (
          <li
            key={t.id}
            className={`bud-txn${onEdit ? ' bud-txn-editable row-press' : ''}`}
            {...(onEdit ? pressable(() => onEdit(t)) : {})}
          >
            <span className="bud-txn-date">{dayLabel(t.date)}</span>
            <span className="bud-txn-note">
              {t.pending && <Pending />}
              {isRefund(t) && <Refund />}
              <span className="bud-txn-name">{t.note || 'Transaction'}</span>
            </span>
            <span className={`bud-txn-amt num${isRefund(t) ? ' pos' : ''}`}>
              {isRefund(t) ? '+' : ''}
              {money(Math.abs(t.amount))}
            </span>
            {onEdit && <Icon name="chevron" size={12} className="bud-txn-chev" />}
          </li>
        ))
      )}
    </ul>
  )

  const row = (r: Row) => {
    const key = rowKey(r)
    const expanded = open === key
    const has = r.limit > 0
    // Clamped at 0: refunds bigger than the month's purchases leave `spent` negative.
    const barPct = has ? Math.max(0, Math.min(100, (r.spent / r.limit) * 100)) : 0
    const fill = r.state === 'over' ? 'over' : r.state === 'pace' || r.state === 'near' ? 'pace' : 'ok'
    const tile = r.state === 'over' ? 'over' : r.state === 'pace' || r.state === 'near' ? 'pace' : ''
    const status = budgetStatus({
      name: r.name,
      spent: r.spent,
      limit: r.limit,
      projected: r.projected,
      canProject: data.canProject,
      state: r.state,
      isUncategorized: r.id === null,
      txnCount: r.txns.length,
      pendingCount: r.pendingCount,
      fixed: r.fixed,
    })
    return (
      <li key={key} id={`bud-${key}`} className={`bud-cat row-sep${expanded ? ' open' : ''}`}>
        <button
          type="button"
          className="bud-cat-head row-press"
          aria-expanded={expanded}
          aria-controls={expanded ? `bud-txns-${key}` : undefined}
          onClick={() => setOpen(expanded ? null : key)}
        >
          <span className={`cat-tile sm ${tile}`}>
            <Icon name={r.icon} size={16} />
          </span>
          <span className="traj-main">
            <span className="traj-top">
              <span className="traj-name">{r.name}</span>
              <span className="traj-figs num">
                <strong className={r.state === 'over' ? 'over' : ''}>{money(r.spent)}</strong>
                {has && <span className="of"> of {money(r.limit, { trim: true })}</span>}
              </span>
            </span>
            {has && (
              <span className="traj-bar">
                <span className={`traj-fill rail-fill ${fill}`} style={{ '--p': barPct / 100 } as CSSProperties} />
                {/* Pace tick: fill past this mark = spending faster than the
                    month is passing. Fixed bills land up front by design, so
                    flagging them would be noise. */}
                {paceP != null && !r.fixed && <i className="traj-pace" style={{ left: `${paceP}%` }} />}
              </span>
            )}
            <span className="traj-meta">
              <span className={status.tone}>{status.text}</span>
            </span>
          </span>
          <Icon name="chevron" size={14} className={`chev${expanded ? ' open' : ''}`} />
        </button>
        {expanded && drill(r)}
      </li>
    )
  }

  const idleRow = (r: Row) => {
    const key = rowKey(r)
    const expanded = open === key
    return (
      <li key={key} id={`bud-${key}`} className={`bud-cat bud-idle row-sep${expanded ? ' open' : ''}`}>
        <button
          type="button"
          className="bud-cat-head row-press"
          aria-expanded={expanded}
          aria-controls={expanded ? `bud-txns-${key}` : undefined}
          onClick={() => setOpen(expanded ? null : key)}
        >
          <span className="cat-tile sm">
            <Icon name={r.icon} size={16} />
          </span>
          <span className="traj-main">
            <span className="traj-top">
              <span className="traj-name">{r.name}</span>
              <span className="traj-figs num">{money(r.limit, { trim: true })}</span>
            </span>
          </span>
          <Icon name="chevron" size={14} className={`chev${expanded ? ' open' : ''}`} />
        </button>
        {expanded && drill(r)}
      </li>
    )
  }

  return (
    <div className="dash-home">
      <div className="dash-col">
        {/* Hero: the month's spend, a verdict word, and the rail that proves it. */}
        <section className="card-sect bud-hero enter" ref={heroRef}>
          <span className="hero-label">{src.isCurrent ? `${SPENDING} so far` : SPENDING}</span>
          {empty && <span className="hero-state">No activity in {monthLabel(month)}.</span>}
          {hasLimit && !noData && (
            <span className={`hero-state ${heroState}`}>
              {over ? 'Over budget' : overPace ? 'Likely to go over' : 'On track'}
            </span>
          )}
          {!empty && <Money className="hero-fig" value={data.expense} />}
          {hasLimit && !empty && (
            <>
              <div className="cf-bar bud-hero-rail">
                <div
                  className={`cf-bar-fill rail-fill ${heroState === 'ok' ? 'out' : heroState}`}
                  style={{ '--p': pct / 100 } as CSSProperties}
                />
                {paceP != null && <i className="traj-pace" style={{ left: `${paceP}%` }} />}
              </div>
              <span className="hero-caption num">
                {over ? (
                  <>
                    {money(-left)} over a {money(data.totalLimit, { trim: true })} budget
                  </>
                ) : (
                  <>
                    {/* Home's order and words: 'of $X budget · ~$Y by month-end'. */}
                    of {money(data.totalLimit, { trim: true })} budget
                    {data.canProject && (
                      <>
                        {' · '}
                        <span className="nowrap">
                          ~{money(data.projectedTotal, { approx: true })} {BY_MONTH_END}
                        </span>
                      </>
                    )}
                  </>
                )}
              </span>
              {heroState !== 'ok' && data.unbudgetedTotal > 0 && (
                <span className="bud-cap-note num">{money(data.unbudgetedTotal)} of this has no budget</span>
              )}
            </>
          )}
          {!empty && (
            <p className="bud-meta num">
              {awaitingIncome ? (
                <>
                  {INCOME} {money(data.income)} · {beforePayday(data.income)}
                </>
              ) : (
                <>
                  {INCOME} {money(data.income)} · {data.net >= 0 ? SAVED : OVERSPENT}{' '}
                  <span className={noData ? undefined : data.net >= 0 ? 'pos' : 'over'}>{money(Math.abs(data.net))}</span>
                </>
              )}
            </p>
          )}
        </section>

        {/* Budget wheel: angle = share of this month's spending. */}
        {hasSpend && (
          <section className="card-sect enter">
            <div className="sect-row">
              <span className="sect-title">The shape of your month</span>
              <span className="sect-note">share of spending</span>
            </div>
            <BudgetWheel
              slices={wheelSlices}
              totalLimit={data.totalLimit}
              totalSpent={data.expense}
              selected={open}
              onSelect={setOpen}
              onGo={goToRow}
            />
          </section>
        )}
      </div>

      <div className="dash-col">
        {/* Categories with drill-down */}
        <section className="card-sect enter">
          <div className="sect-row">
            <span className="sect-title">Budgets</span>
            {onManageCategories && (
              <button type="button" className="sect-action" data-testid="manage-categories" onClick={onManageCategories}>
                Edit
              </button>
            )}
          </div>
          {data.rows.length === 0 && data.idle.length === 0 ? (
            <p className="empty">Nothing tracked yet this month.</p>
          ) : (
            <ul className="bud-list">
              {data.rows.map(row)}
              {data.idle.length > 0 && (
                <li className="bud-group">
                  {src.isCurrent ? 'Nothing yet · ' : 'Nothing spent · '}
                  <span className="num">{money(data.idleSum, { trim: true })}</span>
                  {src.isCurrent ? ' ready' : ' unused'}
                </li>
              )}
              {data.idle.map(idleRow)}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
})

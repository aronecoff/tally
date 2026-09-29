import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction } from '../db/db'
import { money } from '../lib/format'
import { isFixedCategory } from '../lib/categorize'
import { paceProjector } from '../lib/projection'
import { budgetStatus, rowState, INCOME, OVERSPENT, SAVED, SPENDING, BY_MONTH_END, type RowState } from '../lib/copy'
import { currentMonth, dayLabel } from '../lib/dates'
import { pressable } from '../lib/pressable'
import { useSettle } from '../lib/motion'
import { BudgetWheel, type WheelSlice } from './BudgetWheel'
import { Icon } from './Icon'
import { Money } from './Money'
import { Pending } from './Pending'
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
function buildModel(txns: Transaction[], categories: Category[], isCurrent: boolean, dayOfMonth: number, daysInMonth: number) {
  const byCat = new Map<number | null, number>()
  const txByCat = new Map<number | null, Transaction[]>()
  let income = 0
  let expense = 0
  for (const t of txns) {
    if (t.deleted) continue
    if (t.type === 'income') {
      income += t.amount
      continue
    }
    expense += t.amount
    byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + t.amount)
    const list = txByCat.get(t.categoryId)
    if (list) list.push(t)
    else txByCat.set(t.categoryId, [t])
  }
  for (const list of txByCat.values()) list.sort((a, b) => b.amount - a.amount)
  const pendingIn = (list: Transaction[]) => list.reduce((n, t) => n + (t.pending ? 1 : 0), 0)

  // All pace math lives in lib/projection.ts (shared with Home). Past months
  // arrive with dayOfMonth = full, so they never extrapolate.
  const p = paceProjector(dayOfMonth, daysInMonth)

  const expenseCats = categories.filter((c) => c.kind === 'expense').sort((a, b) => a.sortOrder - b.sortOrder)
  const catSpends = expenseCats.map((c) => ({
    name: c.name,
    spent: byCat.get(c.id!) ?? 0,
    budget: c.monthlyBudget || 0,
  }))
  const rows: Row[] = expenseCats
    .map((c) => {
      const spent = byCat.get(c.id!) ?? 0
      const limit = c.monthlyBudget || 0
      const projected = p.forCategory(c.name, spent, limit)
      const list = txByCat.get(c.id!) ?? []
      return {
        id: c.id!,
        name: c.name,
        icon: c.icon,
        spent,
        limit,
        projected,
        // The shared thresholds (lib/copy.ts rowState, a verbatim copy of this screen's).
        state: rowState({ spent, limit, projected, fixed: isFixedCategory(c.name), isCurrent }),
        txns: list,
        pendingCount: pendingIn(list),
      }
    })
    .filter((r) => r.limit > 0 || r.spent > 0)

  const uncat = byCat.get(null) ?? 0
  if (uncat > 0) {
    const list = txByCat.get(null) ?? []
    rows.push({ id: null, name: 'Uncategorized', icon: 'tag', spent: uncat, limit: 0, projected: p.extrapolate(uncat), state: 'none', txns: list, pendingCount: pendingIn(list) })
  }

  // Attention first: over, then pace, then near, then Uncategorized (the one
  // row with an action), then other unbudgeted spend, then the rest.
  const rank: Record<RowState, number> = { over: 0, pace: 1, near: 2, none: 3, ok: 4 }
  const rankOf = (r: Row) => (r.id === null ? 2.5 : rank[r.state])
  rows.sort((a, b) => rankOf(a) - rankOf(b) || b.spent - a.spent)

  const totalLimit = expenseCats.reduce((s, c) => s + (c.monthlyBudget || 0), 0)
  const idle = rows.filter(isIdle)
  return {
    income,
    expense,
    net: income - expense,
    rows: rows.filter((r) => !isIdle(r)),
    idle,
    totalLimit,
    projectedTotal: p.monthEnd(catSpends, expense),
    canProject: p.canProject && isCurrent,
    /** Display-only: spend in rows with no budget (Other + Uncategorized). */
    unbudgetedTotal: rows.filter((r) => r.limit <= 0 && r.spent > 0).reduce((s, r) => s + r.spent, 0),
    /** Display-only: the budgets of the idle rows. */
    idleSum: idle.reduce((s, r) => s + r.limit, 0),
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
  const txns = useLiveQuery(() => db.transactions.where('date').startsWith(month).toArray(), [month])

  const isCurrent = month === currentMonth()
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const dayOfMonth = isCurrent ? new Date().getDate() : daysInMonth

  // A hidden (keep-alive) pane keeps its last picture and skips the rebuild
  // until it is shown again; the catch-up happens in the render that shows it.
  const live = useMemo(
    () => ({ txns, categories, isCurrent, daysInMonth, dayOfMonth }),
    [txns, categories, isCurrent, daysInMonth, dayOfMonth],
  )
  const [shown, setShown] = useState(live)
  if (active && shown !== live) setShown(live)
  const src = active ? live : shown

  const data = useMemo(
    () => (src.txns ? buildModel(src.txns, src.categories, src.isCurrent, src.dayOfMonth, src.daysInMonth) : null),
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
  // A past month with nothing in it has no verdict: no state word, no sage.
  const noData = !src.isCurrent && data.expense === 0 && data.income === 0

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
              {t.note || 'Transaction'}
            </span>
            <span className="bud-txn-amt num">{money(t.amount)}</span>
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
    const barPct = has ? Math.min(100, (r.spent / r.limit) * 100) : 0
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
      fixed: isFixedCategory(r.name),
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
                {paceP != null && !isFixedCategory(r.name) && <i className="traj-pace" style={{ left: `${paceP}%` }} />}
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
          {hasLimit && !noData && (
            <span className={`hero-state ${heroState}`}>
              {over ? 'Over budget' : overPace ? 'Likely to go over' : 'On track'}
            </span>
          )}
          <Money className="hero-fig" value={data.expense} />
          {hasLimit && (
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
          <p className="bud-meta num">
            {INCOME} {money(data.income)} · {data.net >= 0 ? SAVED : OVERSPENT}{' '}
            <span className={noData ? undefined : data.net >= 0 ? 'pos' : 'over'}>{money(Math.abs(data.net))}</span>
          </p>
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

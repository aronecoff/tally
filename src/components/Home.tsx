import { memo, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction } from '../db/db'
import { dayLabel } from '../lib/dates'
import { useToday } from '../lib/useToday'
import { homeBillsSince, homeDays, homeFigures, homeHero, homeHistoryFrom, homeLabel, type HomeRow as Row } from '../lib/homeFigures'
import { brand } from '../lib/brand'
import { cleanMerchant } from '../lib/merchants'
import { isRefund } from '../lib/ledger'
import { money, pct } from '../lib/format'
import { rowState, budgetStatus, beforePayday, INCOME, SPENDING, SAVED, OVERSPENT, NO_BUDGET } from '../lib/copy'
import { Icon } from './Icon'
import { Money } from './Money'
import { Pending } from './Pending'
import { Refund } from './Refund'
import { Skeleton } from './Skeleton'
import { pressable } from '../lib/pressable'
import { useSettle } from '../lib/motion'

interface Props {
  categories: Category[]
  onEdit: (t: Transaction) => void
  onMore: () => void
  /** This pane is the visible one (stage 2 skips heavy work while hidden). */
  active: boolean
  /** Open the sort queue for posted, uncategorized spending. */
  onSort?: () => void
  /** Open Budget with this category expanded. */
  onOpenCategory?: (key: string) => void
}

const EMPTY: Transaction[] = []
const DETAIL_KEY = 'tally-home-detail'

// ≥1040 the two-column desktop has room for everything, so detail is always on.
const WIDE = '(min-width: 1040px)'
function subscribeWide(cb: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia(WIDE)
  mq.addEventListener?.('change', cb)
  return () => mq.removeEventListener?.('change', cb)
}
const getWide = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(WIDE).matches
const getWideServer = () => false

function readDetail(): boolean {
  try {
    return localStorage.getItem(DETAIL_KEY) === '1'
  } catch {
    return false
  }
}
function writeDetail(on: boolean) {
  try {
    localStorage.setItem(DETAIL_KEY, on ? '1' : '0')
  } catch {
    /* storage blocked: remembered for this session only */
  }
}

/**
 * While the pane is hidden, hand back the last value seen while it was visible,
 * so live-query updates from a background sync do not recompute Home's memos.
 * The first visible render passes the fresh value straight through.
 */
function useWhileActive<T>(value: T, active: boolean): T {
  const [held, setHeld] = useState(value)
  if (active && held !== value) setHeld(value)
  return active ? value : held
}

const railP = (p: number) => ({ '--p': Math.max(0, Math.min(1, p)) }) as CSSProperties

/**
 * Home = the live dashboard for the current month. One budget hero (state word,
 * figure, rail), the Income/Spending contributors and the net, then only what
 * needs you. The day bars, budgets and recurring bills sit behind 'Show charts'
 * (always shown on the wide desktop).
 */
export const Home = memo(function Home({ categories, onEdit, onMore, active, onSort, onOpenCategory }: Props) {
  // The clock as a subscription: left open overnight, Home moves to the new
  // day (and month) on resume instead of waiting for a tab change.
  const today = useToday()
  const month = today.slice(0, 7)
  const { dayOfMonth, daysInMonth } = homeDays(today)

  // No [] defaults: undefined means "still loading" and shows the skeleton, so
  // Home never flashes $0.00 or a false 'all on track'.
  const liveMonth = useLiveQuery(() => db.transactions.where('date').startsWith(month).toArray(), [month])
  const since = useMemo(() => homeBillsSince(today), [today])
  const from = useMemo(() => homeHistoryFrom(today), [today])
  const liveRecent = useLiveQuery(() => db.transactions.where('date').aboveOrEqual(from).toArray(), [from])

  const monthTxns = useWhileActive(liveMonth, active)
  const recentTxns = useWhileActive(liveRecent, active)
  const cats = useWhileActive(categories, active)

  const catById = useMemo(() => {
    const m = new Map<number, Category>()
    for (const c of cats) if (c.id != null) m.set(c.id, c)
    return m
  }, [cats])

  const d = useMemo(
    () => homeFigures({ monthTxns, recentTxns, month, cats, daysInMonth, dayOfMonth }),
    [monthTxns, recentTxns, month, cats, daysInMonth, dayOfMonth],
  )

  // Recurring bills: an expense whose merchant recurs across ≥2 distinct months.
  const bills = useMemo(() => {
    const groups = new Map<string, { name: string; months: Set<string>; last: number; lastDate: string; catId: number | null }>()
    for (const t of recentTxns ?? EMPTY) {
      // The last 100 days (the query reaches further back for the forecast).
      if (t.date < since) continue
      // Rent paid early is dated the 1st it pays for: it still marks the
      // month, but a future day is never the 'last' charge.
      const future = t.date > today
      // A refund is not a bill landing (and would show as a negative 'last').
      if (t.deleted || t.type !== 'expense' || isRefund(t)) continue
      // Group by the CLEANED merchant, or "SAFEWAY #1234" and "SAFEWAY #5678"
      // read as two different bills and recurring detection undercounts.
      const key = cleanMerchant(t.note || '').toLowerCase()
      if (!key) continue
      const g = groups.get(key)
      const m = t.date.slice(0, 7)
      if (!g) {
        groups.set(key, { name: cleanMerchant(t.note), months: new Set([m]), last: future ? 0 : t.amount, lastDate: future ? '' : t.date, catId: t.categoryId })
      } else {
        g.months.add(m)
        if (!future && t.date > g.lastDate) {
          g.lastDate = t.date
          g.last = t.amount
          g.catId = t.categoryId
        }
      }
    }
    return [...groups.values()]
      .filter((g) => g.months.size >= 2 && g.lastDate !== '')
      .sort((a, b) => b.last - a.last)
      .slice(0, 6)
  }, [recentTxns, today, since])

  const todays = useMemo(
    () => (monthTxns ?? EMPTY).filter((t) => !t.deleted && t.date === today).sort((a, b) => (b.id ?? 0) - (a.id ?? 0)),
    [monthTxns, today],
  )

  // Calm by default, detail on demand: only the verdict and anything that needs
  // action are always visible. The charts and full lists sit behind one
  // disclosure (remembered across visits). Everything is still tracked either way.
  const [showDetail, setShowDetail] = useState(readDetail)
  const toggleDetail = () =>
    setShowDetail((v) => {
      writeDetail(!v)
      return !v
    })
  const wide = useSyncExternalStore(subscribeWide, getWide, getWideServer)
  const detail = showDetail || wide

  // The hero figure settles when it changes (a sync landing, an edit).
  const heroRef = useRef<HTMLElement>(null)
  useSettle(heroRef, '.hero-fig')

  // Every hook sits above this line: the skeleton return keeps hook order stable.
  if (monthTxns === undefined || recentTxns === undefined) return <Skeleton variant="home" />

  const inTotal = d.income
  const outTotal = d.spend
  const flowMax = Math.max(1, inTotal, outTotal)

  // The top of Home answers one question: am I inside my BUDGET? That is not the
  // same question as "am I inside my means", so the hero says which one it is
  // and the net sits below it as its own line; otherwise a green "on track"
  // sits directly above a red "over income" and the two read as a contradiction.
  // Income lands on payday: before it does, a month that has only spent is
  // not 'Overspent' (that read every month until the first deposit), and an
  // interest credit on the 7th is not pay (lib/payday.ts).
  const awaitingIncome = d.awaitingIncome
  const overIncome = inTotal > 0 && outTotal > inTotal && !awaitingIncome
  const waitWord = beforePayday(inTotal)
  const hero = homeHero(d, dayOfMonth, daysInMonth)
  const { overBudget, overPaceBudget, budgetPct, budgetState, pacePct, hasBudget } = hero
  const hasActivity = inTotal > 0 || outTotal > 0

  // What needs you: over budget, likely to go over, or unfiled, plus (while the
  // month total is at risk) the unbudgeted spending that is pushing it there.
  const totalAtRisk = overBudget || overPaceBudget
  const attention = d.rows.filter(
    (r) =>
      r.id === null ||
      (r.budget > 0 && (r.spent > r.budget || (d.canProject && r.projected > r.budget))) ||
      (totalAtRisk && r.budget === 0 && r.spent > 0),
  )

  const statusOf = (r: Row) => {
    const state = rowState({ spent: r.spent, limit: r.budget, projected: r.projected, fixed: r.fixed, isCurrent: true })
    const status = budgetStatus({
      name: r.name,
      spent: r.spent,
      limit: r.budget,
      projected: r.projected,
      canProject: d.canProject,
      state,
      isUncategorized: r.id === null,
      txnCount: r.txnCount,
      pendingCount: r.pendingCount,
      fixed: r.fixed,
    })
    return { state, status }
  }

  const tileClass = (state: string) => (state === 'over' || state === 'pace' ? ` ${state}` : '')

  const figs = (r: Row) => (
    <span className="traj-figs num">
      <strong>{money(r.spent)}</strong>
      {r.budget > 0 && <span className="of"> of {money(r.budget, { trim: true })}</span>}
    </span>
  )

  // Uncategorized: posted rows go to the sort queue. Pending rows never do (a
  // manual pin on a pending charge can double-count once it posts), so an
  // all-pending Uncategorized only opens its Budget drill.
  const actOn = (r: Row) => () => {
    if (r.id === null) {
      if (r.txnCount - r.pendingCount > 0) onSort?.()
      else onOpenCategory?.('uncat')
      return
    }
    onOpenCategory?.(String(r.id))
  }

  const renderAttention = (r: Row) => {
    const { state, status } = statusOf(r)
    const unbudgeted = r.id !== null && r.budget <= 0
    const text = unbudgeted ? `${NO_BUDGET} · counts toward your total` : status.text
    const tone = unbudgeted ? 'muted' : status.tone
    // The tap lives on the <li> so a click anywhere in the row reaches it; the
    // button supplies focus, Enter/Space and the role, and its click bubbles here.
    return (
      <li key={r.id ?? 'uncat'} className="row-sep" onClick={actOn(r)}>
        <button type="button" className="traj-row home-row row-press">
          <span className={`cat-tile${tileClass(state)}`}>
            <Icon name={r.icon} size={18} />
          </span>
          <span className="traj-main">
            <span className="traj-top">
              <span className="traj-name">{r.name}</span>
              {figs(r)}
            </span>
            <span className={`traj-meta ${tone}`}>{text}</span>
          </span>
          <Icon name="chevron" size={14} className="chev" />
        </button>
      </li>
    )
  }

  const renderBudget = (r: Row) => {
    const { state, status } = statusOf(r)
    const withBudget = r.budget > 0
    const fill = state === 'over' || state === 'pace' ? state : 'ok'
    const showMeta = state !== 'ok' || r.spent < 0
    return (
      <li key={r.id ?? 'uncat'} className={`row-sep traj-row home-brow${showMeta ? ' has-meta' : ''}`}>
        <span className={`cat-tile${tileClass(state)}`}>
          <Icon name={r.icon} size={18} />
        </span>
        <div className="traj-main">
          <div className="traj-top">
            <span className="traj-name">{r.name}</span>
            {figs(r)}
          </div>
          {withBudget && (
            <div className="traj-bar">
              <div className={`traj-fill rail-fill ${fill}`} style={railP(r.spent / r.budget)} />
              {!r.fixed && <i className="traj-pace" style={{ left: `${pacePct}%` }} />}
            </div>
          )}
          {showMeta && <div className={`traj-meta ${status.tone}`}>{status.text}</div>}
        </div>
      </li>
    )
  }

  // The Budget tab's idle rule: budgeted, nothing spent and nothing filed. A
  // category whose refunds outweigh its purchases (spent < 0) is active.
  const isQuiet = (r: Row) => r.budget > 0 && r.spent === 0 && r.txnCount === 0
  const spentRows = d.rows.filter((r) => !isQuiet(r))
  const quiet = d.rows.filter(isQuiet)
  const quietLine = (() => {
    if (quiet.length === 0) return null
    const names = quiet.map((r) => r.name)
    const listed = names.length > 4 ? `${names.slice(0, 4).join(', ')} +${names.length - 4} more` : names.join(', ')
    const ready = quiet.reduce((s, r) => s + r.budget, 0)
    return `Nothing yet in ${listed} · ${money(ready, { trim: true })} ready`
  })()

  const heroLabel = homeLabel(month, dayOfMonth, daysInMonth)

  return (
    <div className={`dash-home${detail ? '' : ' is-calm'}`}>
      <div className="dash-col">
        {/* The one hero: budget state, what is left (or over), the rail. */}
        <section className="sect home-hero enter" ref={heroRef}>
          <span className="hero-label">{heroLabel}</span>
          {hasBudget ? (
            <>
              <span className={`hero-state ${budgetState}`}>
                {hero.stateWord}
              </span>
              <div className="hero-fig">
                <Money value={hero.value} />
                <span className="home-hero-unit"> {hero.unit}</span>
              </div>
              <div className="traj-bar home-hero-rail">
                <div className={`traj-fill rail-fill ${budgetState}`} style={railP(budgetPct / 100)} />
                <i className="traj-pace" style={{ left: `${pacePct}%` }} />
              </div>
              <span className="hero-caption num">
                {hero.budgetLine}
                {hero.forecast && (
                  <>
                    {' · '}
                    <span className="nowrap">{hero.forecast}</span>
                  </>
                )}
              </span>
            </>
          ) : hasActivity ? (
            <>
              {/* No budgets set: the net is the hero, with the same anatomy. */}
              {awaitingIncome ? (
                <>
                  <span className="hero-state">{waitWord}</span>
                  <div className="hero-fig">
                    <Money value={outTotal} />
                  </div>
                  <span className="hero-caption num">spent so far</span>
                </>
              ) : (
                <>
                  <span className={`hero-state ${d.net >= 0 ? 'ok' : 'over'}`}>{d.net >= 0 ? SAVED : OVERSPENT}</span>
                  <div className="hero-fig">
                    <Money value={Math.abs(d.net)} />
                  </div>
                  {d.net >= 0 && inTotal > 0 && (
                    <span className="hero-caption num">{pct((d.net / inTotal) * 100)} of income</span>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <span className="hero-state">Nothing yet this month</span>
              {brand.homeEmpty && <span className="hero-caption">{brand.homeEmpty}</span>}
            </>
          )}

          {/* The contributors that explain the hero. */}
          <div className="cf-flows">
            <div className="cf-flow">
              <div className="cf-flow-top">
                <span className="cf-flow-label">{INCOME}</span>
                <span className="cf-flow-amt num">{money(inTotal)}</span>
              </div>
              <div className="cf-bar">
                <div className="cf-bar-fill in rail-fill" style={railP(inTotal / flowMax)} />
              </div>
            </div>
            <div className="cf-flow">
              <div className="cf-flow-top">
                <span className="cf-flow-label">{SPENDING}</span>
                <span className="cf-flow-amt num">{money(outTotal)}</span>
              </div>
              <div className="cf-bar">
                <div className={`cf-bar-fill out rail-fill${overIncome ? ' over' : ''}`} style={railP(outTotal / flowMax)} />
              </div>
            </div>
            {hasBudget && hasActivity && (
              <div className="home-net">
                {awaitingIncome ? (
                  // The Spending row right above already carries the figure.
                  <span className="home-net-label muted">{waitWord}</span>
                ) : (
                  <>
                    <span className="home-net-label">{d.net >= 0 ? `${SAVED} so far` : `${OVERSPENT} so far`}</span>
                    <span className={`home-net-fig num ${d.net >= 0 ? 'pos' : 'over'}`}>
                      {money(Math.abs(d.net))}
                      {d.net >= 0 && inTotal > 0 && <em> · {pct((d.net / inTotal) * 100)} of income</em>}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Needs your eye: the only list that is always visible. */}
        <section className="sect enter">
          <div className="sect-row">
            <h2 className="sect-title">Needs your eye</h2>
          </div>
          {overIncome || attention.length > 0 ? (
            <ul className="home-list">
              {/* Living above your means outranks any single category being over,
                  and it is invisible to the per-category checks, which only read
                  budgets. Without it the list said "nothing needs you" in a month
                  that spent more than it earned. */}
              {overIncome && (
                <li className="row-sep">
                  <div className={`traj-row home-row${d.totalBudget > inTotal ? '' : ' is-short'}`}>
                    <span className="cat-tile over">
                      <Icon name="alert" size={18} />
                    </span>
                    <span className="traj-main">
                      <span className="traj-name">
                        {d.totalBudget > inTotal ? 'Budgets exceed income' : 'Spending is ahead of income'}
                      </span>
                      {d.totalBudget > inTotal && (
                        <span className="traj-meta muted">
                          <strong className="num">{money(d.totalBudget, { trim: true })}</strong> budgeted ·{' '}
                          <strong className="num">{money(inTotal)}</strong> income so far
                        </span>
                      )}
                    </span>
                  </div>
                </li>
              )}
              {attention.map(renderAttention)}
            </ul>
          ) : (
            <div className="allgood">
              <Icon name="check" size={16} />
              {hasBudget ? ' All budgets on track. Nothing needs you.' : brand.allGoodNoBudget}
            </div>
          )}
        </section>

        {/* Today */}
        {todays.length > 0 && (
          <section className="sect enter">
            <div className="sect-row">
              <h2 className="sect-title">Today</h2>
            </div>
            <ul className="txn-list">
              {todays.map((t) => {
                const cat = t.categoryId != null ? catById.get(t.categoryId) : undefined
                const refund = isRefund(t)
                const moneyIn = t.type === 'income' || refund
                return (
                  <li key={t.id} className="txn-row" {...pressable(() => onEdit(t))}>
                    <span className="cat-tile">
                      <Icon name={cat?.icon ?? 'tag'} size={18} />
                    </span>
                    <span className="txn-main">
                      <span className="txn-note">{cleanMerchant(t.note || '') || cat?.name || 'Uncategorized'}</span>
                      <span className="txn-sub">
                        {t.pending && <Pending />}
                        {refund && <Refund />}
                        {cat?.name ?? 'Uncategorized'}
                      </span>
                    </span>
                    <span className={`txn-amt num${moneyIn ? ' pos' : ''}`}>
                      {moneyIn ? '+' : ''}
                      {money(Math.abs(t.amount))}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <button
          type="button"
          className="home-disclose row-press enter"
          data-testid="home-detail-toggle"
          aria-expanded={showDetail}
          onClick={toggleDetail}
        >
          <span>{showDetail ? 'Hide charts' : 'Show charts'}</span>
          <Icon name="chevron" size={14} className={`chev${showDetail ? ' open' : ''}`} />
        </button>

        {/* Day by day */}
        {detail && (
          <section className="sect enter">
            <div className="sect-row">
              <h2 className="sect-title">Day by day</h2>
              <span className="sect-note num">~{money(d.avgPerDay, { approx: true })}/day excl. bills</span>
            </div>
            <div
              className="daily"
              role="img"
              aria-label={`Spending by day; flexible spending about ${money(d.avgPerDay, { approx: true })} a day, excluding bills and one-offs`}
            >
              {d.daily.map((amt, i) => {
                // Bars are DIRECT flex children with explicit px heights: the
                // wrapper-column + percentage-height version misrendered in WebKit
                // (iOS painted every bar full-size).
                const h = Math.max(2, Math.round((amt / d.maxDaily) * 64))
                const isToday = i + 1 === dayOfMonth
                return (
                  <div
                    key={i}
                    // "zero", not "empty": .empty is the app's padded empty-state
                    // message class and inflates the bar to 48×104.
                    // A refund-only day nets below zero: it draws as an empty day.
                    className={`daily-bar${isToday ? ' today' : ''}${amt <= 0 ? ' zero' : ''}`}
                    style={{ height: `${h}px` }}
                    title={`Day ${i + 1}: ${money(amt)}`}
                  />
                )
              })}
            </div>
            <div className="daily-axis">
              <span>1</span>
              <span>{Math.ceil(daysInMonth / 2)}</span>
              <span>{daysInMonth}</span>
            </div>
          </section>
        )}
      </div>

      <div className="dash-col">
        {/* Budgets + trajectory */}
        {detail && (
          <section className="sect enter">
            <div className="sect-row">
              <h2 className="sect-title">Budgets</h2>
              <span className="sect-note">
                {spentRows.length} active{quiet.length > 0 && ` · ${quiet.length} untouched`}
              </span>
            </div>
            <ul className="home-list">
              {spentRows.map(renderBudget)}
              {spentRows.length === 0 && <li className="traj-empty">Nothing spent yet this month.</li>}
            </ul>
            {/* Untouched budgets stay out of the way: one quiet line instead of a
                wall of $0.00 rows. The full list always lives in the Budget tab. */}
            {quietLine && <div className="traj-quiet num">{quietLine}</div>}
            <button type="button" className="home-link row-press" onClick={onMore}>
              <span>See all budgets</span>
              <Icon name="chevron" size={14} className="chev" />
            </button>
          </section>
        )}

        {/* Recurring bills */}
        {detail && bills.length > 0 && (
          <section className="sect enter">
            <div className="sect-row">
              <h2 className="sect-title">Recurring</h2>
            </div>
            <ul className="home-list">
              {bills.map((b) => {
                const cat = b.catId != null ? catById.get(b.catId) : undefined
                return (
                  <li key={b.name} className="row-sep bill-row">
                    <span className="cat-tile">
                      <Icon name={cat?.icon ?? 'repeat'} size={18} />
                    </span>
                    <div className="bill-main">
                      <span className="bill-name">{b.name}</span>
                      <span className="bill-sub">
                        {cat?.name ?? 'Other'} · last {dayLabel(b.lastDate)}
                      </span>
                    </div>
                    <span className="bill-amt num">{money(b.last)}</span>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
})

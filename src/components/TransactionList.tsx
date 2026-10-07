import { Fragment, memo, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { db, type Category, type Transaction } from '../db/db'
import { money } from '../lib/format'
import { dayHeading, dayLabel, monthLabel, shiftMonth } from '../lib/dates'
import { useToday } from '../lib/useToday'
import { useKeyedLiveQuery } from '../lib/useKeyedLiveQuery'
import { accountLabel, cleanMerchant } from '../lib/merchants'
import { groupByDay, isRefund, type DayGroup } from '../lib/ledger'
import { pressable, rovingKeys } from '../lib/pressable'
import { Icon } from './Icon'
import { Pending } from './Pending'
import { Refund } from './Refund'
import { Skeleton } from './Skeleton'

interface Props {
  month: string
  categories: Category[]
  onEdit: (t: Transaction) => void
  /** This pane is the visible one (a hidden pane keeps its last render). */
  active: boolean
  /** Open the add-transaction sheet (the empty month's action). */
  onAdd?: () => void
}

type Filter = 'all' | 'uncat' | 'removed'

/** 'To categorize' everywhere (Home, Budget): a posted expense with no category.
 *  A pending row is never offered, since a manual pin on it can double-count. */
const needsCategory = (t: Transaction) => t.type === 'expense' && t.categoryId == null && !t.pending

/** Removed by hand (Delete) or by Tell Tally's hide: a pinned tombstone. A
 *  bank's own tombstones (transfers, a pending row replaced by its posted
 *  copy) are not pinned, and a pinned pending row the bank retired when it
 *  posted is marked `retired`: neither is offered back, since restoring one
 *  counted the charge twice beside its posted row. */
const isRemoved = (t: Transaction) => !!t.deleted && !!t.manual && !t.retired

/** Back in every total. The pin stays, so a bank sync never removes it again. */
const restore = (t: Transaction) => {
  if (t.id != null) void db.transactions.update(t.id, { deleted: false, manual: true, updatedAt: Date.now() })
}

/**
 * Display names for the month's account strings: the short label, plus the
 * mask only when two different accounts would read the same. Display only;
 * the stored t.account is never changed.
 */
function accountNames(rows: readonly Transaction[]): Map<string, string> {
  const raws = new Set<string>()
  for (const t of rows) if (t.account) raws.add(t.account)
  const byLabel = new Map<string, number>()
  for (const raw of raws) {
    const { label } = accountLabel(raw)
    byLabel.set(label, (byLabel.get(label) ?? 0) + 1)
  }
  const names = new Map<string, string>()
  for (const raw of raws) {
    const { label, mask } = accountLabel(raw)
    names.set(raw, mask && (byLabel.get(label) ?? 0) > 1 ? `${label} ··${mask}` : label)
  }
  return names
}

/** A hidden pane keeps the inputs it last showed, so nothing recomputes (and its
 *  rows and scroll position stay put) until it is visible again. */
function useWhileActive<T>(value: T, active: boolean): T {
  const [kept, setKept] = useState(value)
  if (active && kept !== value) setKept(value)
  return active ? value : kept
}

export const TransactionList = memo(function TransactionList({ month, categories, onEdit, active, onAdd }: Props) {
  // No default result: undefined means still loading (skeleton), never 'empty'.
  // A month step suspends rather than show the old month's rows under the new
  // label (lib/useKeyedLiveQuery).
  const live = useKeyedLiveQuery(month, () => db.transactions.where('date').startsWith(month).toArray())
  // The clock as a subscription: left open past midnight, 'Today' and
  // 'Yesterday' and the live month move on.
  const today = useToday()
  const isLive = month === today.slice(0, 7)
  // Rows dated in a month that has not started: rent paid early is dated the
  // 1st it pays for, so until then it sat in no list at all, with the money
  // already gone from the bank. Shown under the live month only, apart from
  // its own rows and totals; once its day comes it is simply in its month.
  const liveAhead = useKeyedLiveQuery(`${month}|${isLive}`, () =>
    isLive ? db.transactions.where('date').aboveOrEqual(`${shiftMonth(month, 1)}-01`).toArray() : [],
  )

  const txns = useWhileActive(live, active)
  const aheadRows = useWhileActive(liveAhead, active)
  const shownMonth = useWhileActive(month, active)
  const cats = useWhileActive(categories, active)

  // The filter lasts only as long as its month: any month change resets it to
  // All, so coming back to a month starts at All too.
  const [picked, setPicked] = useState<{ month: string; filter: Filter }>({ month, filter: 'all' })
  if (picked.month !== month) setPicked({ month, filter: 'all' })
  const filter: Filter = picked.month === month ? picked.filter : 'all'
  const pick = (f: Filter) => setPicked({ month, filter: f })

  const catById = useMemo(() => {
    const m = new Map<number, Category>()
    for (const c of cats) if (c.id != null) m.set(c.id, c)
    return m
  }, [cats])

  const sorted = useMemo(
    () =>
      txns
        ?.filter((t) => !t.deleted)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0))),
    [txns],
  )
  const removedRows = useMemo(
    () => txns?.filter(isRemoved).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0))) ?? [],
    [txns],
  )

  const summary = useMemo(() => {
    if (!sorted) return null
    let pending = 0
    let uncat = 0
    for (const t of sorted) {
      if (t.pending) pending++
      if (needsCategory(t)) uncat++
    }
    return { count: sorted.length, pending, uncat, names: accountNames(sorted) }
  }, [sorted])

  const groups = useMemo(
    () => (sorted ? groupByDay(filter === 'removed' ? removedRows : filter === 'uncat' ? sorted.filter(needsCategory) : sorted) : null),
    [sorted, removedRows, filter],
  )

  /** Future rows by the month they count in, earliest first. */
  const ahead = useMemo(() => {
    const byMonth = new Map<string, Transaction[]>()
    for (const t of [...(aheadRows ?? [])].filter((t) => !t.deleted).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
      const m = t.date.slice(0, 7)
      const list = byMonth.get(m)
      if (list) list.push(t)
      else byMonth.set(m, [t])
    }
    return [...byMonth.entries()]
  }, [aheadRows])

  if (!sorted || !summary || !groups) return <Skeleton variant="list" />

  const removed = removedRows.length
  if (sorted.length === 0 && removed === 0) {
    return (
      <div className="activity">
        <div className="txn-empty">
          <Icon name="list" size={22} />
          <p>No transactions in {monthLabel(shownMonth)}.</p>
          {shownMonth === today.slice(0, 7) && onAdd && (
            <button type="button" className="detail-toggle" onClick={onAdd}>
              <Icon name="plus" size={14} /> Add a transaction
            </button>
          )}
        </div>
      </div>
    )
  }

  const { count, pending, uncat, names } = summary

  return (
    <div className="activity">
      <p className="txn-count">
        {count} transaction{count === 1 ? '' : 's'}
        {pending ? ` · ${pending} pending` : ''}
      </p>

      {(uncat > 0 || removed > 0 || filter !== 'all') && (
        <div className="txn-filter" role="tablist" aria-label="Filter" onKeyDown={rovingKeys}>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            tabIndex={filter === 'all' ? 0 : -1}
            className={filter === 'all' ? 'on' : undefined}
            onClick={() => pick('all')}
          >
            All
          </button>
          {(uncat > 0 || filter === 'uncat') && (
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'uncat'}
              tabIndex={filter === 'uncat' ? 0 : -1}
              className={filter === 'uncat' ? 'on' : undefined}
              onClick={() => pick('uncat')}
            >
              Needs category <em className="num">{uncat}</em>
            </button>
          )}
          {(removed > 0 || filter === 'removed') && (
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'removed'}
              tabIndex={filter === 'removed' ? 0 : -1}
              className={filter === 'removed' ? 'on' : undefined}
              onClick={() => pick('removed')}
            >
              Removed <em className="num">{removed}</em>
            </button>
          )}
        </div>
      )}

      {filter === 'all' &&
        ahead.map(([m, rows]) => (
          <section className="txn-day" key={`ahead-${m}`}>
            <div className="txn-day-head" role="heading" aria-level={3}>
              <span>Counts in {monthLabel(m).split(' ')[0]}</span>
            </div>
            <ul className="txn-list">
              {rows.map((t) => (
                <TxnRow key={t.id} t={t} i={0} catById={catById} names={names} onEdit={onEdit} counts={`Counts ${dayLabel(t.date)}`} />
              ))}
            </ul>
          </section>
        ))}

      {groups.length === 0 ? (
        <div className="txn-empty is-filtered">
          <p>{filter === 'removed' ? 'Nothing removed.' : filter === 'uncat' ? 'Nothing needs a category.' : `No transactions in ${monthLabel(shownMonth)}.`}</p>
        </div>
      ) : filter === 'removed' ? (
        <DayList groups={groups} catById={catById} names={names} onEdit={restore} action="Tap to restore" today={today} />
      ) : (
        <DayList groups={groups} catById={catById} names={names} onEdit={onEdit} today={today} />
      )}
    </div>
  )
})

interface DayListProps {
  groups: DayGroup[]
  catById: Map<number, Category>
  names: Map<string, string>
  onEdit: (t: Transaction) => void
  /** What a tap does, when it is not opening the row (Removed: 'Tap to restore'). No day totals then. */
  action?: string
  /** Today (YYYY-MM-DD): the 'Today' and 'Yesterday' headings follow it. */
  today: string
}

/** Expense rows in a day: its total is shown only when it sums two or more,
 *  since a lone expense would repeat its own row figure right below it. A day
 *  whose refunds outweigh its purchases nets to money back and reads '+$x',
 *  as its refund rows do; one that nets to exactly nothing reads '$0.00'. */
const expenseRows = (g: DayGroup) => g.rows.reduce((n, t) => (t.type === 'expense' ? n + 1 : n), 0)

/** The ledger: a quiet heading per day with its total, then that day's rows. */
const DayList = memo(function DayList({ groups, catById, names, onEdit, action, today }: DayListProps) {
  let i = 0 // entrance stagger index, counted across days
  return (
    <>
      {groups.map((g) => (
        <section className="txn-day" key={g.date}>
          <div className="txn-day-head" role="heading" aria-level={3}>
            <span>{dayHeading(g.date, today)}</span>
            {!action && expenseRows(g) > 1 && (
              <span className={`num${g.out < 0 ? ' pos' : ''}`}>
                {g.out < 0 ? '+' : ''}
                {money(Math.abs(g.out))}
              </span>
            )}
          </div>
          <ul className="txn-list">
            {g.rows.map((t) => (
              <TxnRow key={t.id} t={t} i={i++} catById={catById} names={names} onEdit={onEdit} action={action} />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
})

interface TxnRowProps {
  t: Transaction
  i: number
  catById: Map<number, Category>
  names: Map<string, string>
  onEdit: (t: Transaction) => void
  /** A row that counts in a later month: 'Counts Oct 1'. */
  counts?: string
  /** What a tap does, said first: 'Tap to restore'. */
  action?: string
}

function TxnRow({ t, i, catById, names, onEdit, counts, action }: TxnRowProps) {
  const cat = t.categoryId != null ? catById.get(t.categoryId) : undefined
  const uncategorized = t.type === 'expense' && t.categoryId == null
  const title = cleanMerchant(t.note ?? '') || cat?.name || 'Uncategorized'
  const account = t.account ? (names.get(t.account) ?? accountLabel(t.account).label) : ''
  const refund = isRefund(t)
  // Money coming back reads the same whether it is income or a refund.
  const moneyIn = t.type === 'income' || refund

  const meta: ReactNode[] = []
  if (action) meta.push(action)
  if (counts) meta.push(counts)
  if (cat) meta.push(cat.name)
  else if (uncategorized) meta.push(<span className="txn-uncat">Uncategorized</span>)
  if (account) meta.push(account)

  const spoken = [
    title,
    `${moneyIn ? 'plus ' : ''}${money(Math.abs(t.amount))}`,
    counts ?? dayLabel(t.date),
    t.pending ? 'pending' : '',
    refund ? 'refund' : '',
    cat?.name ?? (uncategorized ? 'Uncategorized' : ''),
    account,
    action ?? '',
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <li
      className={`txn-row enter${t.pending ? ' is-pending' : ''}`}
      style={{ ['--i' as string]: Math.min(i, 8) } as CSSProperties}
      {...pressable(() => onEdit(t))}
      aria-label={spoken}
    >
      <span className="cat-tile sm">
        <Icon name={cat?.icon ?? 'tag'} size={18} />
      </span>
      <span className="txn-main">
        <span className="txn-note">{title}</span>
        <span className="txn-sub">
          {t.pending && (meta.length > 0 || refund ? <Pending /> : <span className="pending-chip">Pending</span>)}
          {refund && (meta.length > 0 ? <Refund /> : <span className="refund-chip">Refund</span>)}
          {meta.map((m, k) => (
            <Fragment key={k}>
              {k > 0 && ' · '}
              {m}
            </Fragment>
          ))}
        </span>
      </span>
      <span className={`txn-amt num${moneyIn ? ' pos' : ''}`}>
        {moneyIn ? '+' : ''}
        {money(Math.abs(t.amount))}
      </span>
    </li>
  )
}

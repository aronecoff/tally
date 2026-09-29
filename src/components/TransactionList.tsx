import { Fragment, memo, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction } from '../db/db'
import { money } from '../lib/format'
import { currentMonth, dayHeading, dayLabel, monthLabel } from '../lib/dates'
import { accountLabel, cleanMerchant } from '../lib/merchants'
import { groupByDay, type DayGroup } from '../lib/ledger'
import { pressable } from '../lib/pressable'
import { Icon } from './Icon'
import { Pending } from './Pending'
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

type Filter = 'all' | 'uncat'

/** 'To categorize' everywhere (Home, Budget): a posted expense with no category.
 *  A pending row is never offered, since a manual pin on it can double-count. */
const needsCategory = (t: Transaction) => t.type === 'expense' && t.categoryId == null && !t.pending

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
  const live = useLiveQuery(() => db.transactions.where('date').startsWith(month).toArray(), [month])

  const txns = useWhileActive(live, active)
  const shownMonth = useWhileActive(month, active)
  const cats = useWhileActive(categories, active)

  // The filter belongs to the month it was picked in: a new month starts at All.
  const [picked, setPicked] = useState<{ month: string; filter: Filter }>({ month, filter: 'all' })
  const filter: Filter = picked.month === shownMonth ? picked.filter : 'all'
  const pick = (f: Filter) => setPicked({ month: shownMonth, filter: f })

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
    () => (sorted ? groupByDay(filter === 'uncat' ? sorted.filter(needsCategory) : sorted) : null),
    [sorted, filter],
  )

  if (!sorted || !summary || !groups) return <Skeleton variant="list" />

  if (sorted.length === 0) {
    return (
      <div className="activity">
        <div className="txn-empty">
          <Icon name="list" size={22} />
          <p>No transactions in {monthLabel(shownMonth)}.</p>
          {shownMonth === currentMonth() && onAdd && (
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

      {(uncat > 0 || filter === 'uncat') && (
        <div className="txn-filter" role="tablist" aria-label="Filter">
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={filter === 'all' ? 'on' : undefined}
            onClick={() => pick('all')}
          >
            All
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'uncat'}
            className={filter === 'uncat' ? 'on' : undefined}
            onClick={() => pick('uncat')}
          >
            Needs category <em className="num">{uncat}</em>
          </button>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="txn-empty is-filtered">
          <p>Nothing needs a category.</p>
        </div>
      ) : (
        <DayList groups={groups} catById={catById} names={names} onEdit={onEdit} />
      )}
    </div>
  )
})

interface DayListProps {
  groups: DayGroup[]
  catById: Map<number, Category>
  names: Map<string, string>
  onEdit: (t: Transaction) => void
}

/** The ledger: a quiet heading per day with its total, then that day's rows. */
const DayList = memo(function DayList({ groups, catById, names, onEdit }: DayListProps) {
  let i = 0 // entrance stagger index, counted across days
  return (
    <>
      {groups.map((g) => (
        <section className="txn-day" key={g.date}>
          <div className="txn-day-head" role="heading" aria-level={3}>
            <span>{dayHeading(g.date)}</span>
            {g.out > 0 && <span className="num">{money(g.out)}</span>}
          </div>
          <ul className="txn-list">
            {g.rows.map((t) => (
              <TxnRow key={t.id} t={t} i={i++} catById={catById} names={names} onEdit={onEdit} />
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
}

function TxnRow({ t, i, catById, names, onEdit }: TxnRowProps) {
  const cat = t.categoryId != null ? catById.get(t.categoryId) : undefined
  const uncategorized = t.type === 'expense' && t.categoryId == null
  const title = cleanMerchant(t.note ?? '') || cat?.name || 'Uncategorized'
  const account = t.account ? (names.get(t.account) ?? accountLabel(t.account).label) : ''
  const income = t.type === 'income'

  const meta: ReactNode[] = []
  if (cat) meta.push(cat.name)
  else if (uncategorized) meta.push(<span className="txn-uncat">Uncategorized</span>)
  if (account) meta.push(account)

  const spoken = [
    title,
    `${income ? 'plus ' : ''}${money(t.amount)}`,
    dayLabel(t.date),
    t.pending ? 'pending' : '',
    cat?.name ?? (uncategorized ? 'Uncategorized' : ''),
    account,
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
          {t.pending && <Pending />}
          {meta.map((m, k) => (
            <Fragment key={k}>
              {k > 0 && ' · '}
              {m}
            </Fragment>
          ))}
        </span>
      </span>
      <span className={`txn-amt num${income ? ' pos' : ''}`}>
        {income ? '+' : ''}
        {money(t.amount)}
      </span>
    </li>
  )
}

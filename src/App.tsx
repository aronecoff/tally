import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Transaction } from './db/db'
import { seedIfEmpty } from './db/seed'
import { currentMonth, monthLabel, shiftMonth } from './lib/dates'
import { Dashboard } from './components/Dashboard'
import { TransactionList } from './components/TransactionList'
import { Categories } from './components/Categories'
import { ImportCsv } from './components/ImportCsv'
import { TransactionSheet } from './components/TransactionSheet'
import { InstallBanner } from './components/InstallBanner'
import { Icon } from './components/Icon'

type Tab = 'dashboard' | 'transactions' | 'categories' | 'import'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Budget', icon: 'pie' },
  { id: 'transactions', label: 'Activity', icon: 'list' },
  { id: 'categories', label: 'Categories', icon: 'tag' },
  { id: 'import', label: 'Import', icon: 'download' },
]

// Sentinel for "add new" vs editing an existing transaction.
type SheetState = { mode: 'new' } | { mode: 'edit'; txn: Transaction } | null

export default function App() {
  const [month, setMonth] = useState(currentMonth())
  const [tab, setTab] = useState<Tab>('dashboard')
  const [sheet, setSheet] = useState<SheetState>(null)
  const [ready, setReady] = useState(false)

  const categories = useLiveQuery(() => db.categories.toArray(), [], [])

  useEffect(() => {
    seedIfEmpty().finally(() => setReady(true))
  }, [])

  // Month nav + quick-add only make sense on the spending views.
  const showMonthNav = tab === 'dashboard' || tab === 'transactions'
  const showFab = showMonthNav

  return (
    <div className="app">
      <header className="app-head">
        <div className="brand">
          <span className="brand-mark" /> Tally
        </div>
        {showMonthNav && (
          <div className="month-nav">
            <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
            <button
              className="month-label"
              onClick={() => setMonth(currentMonth())}
              title="Jump to current month"
            >
              {monthLabel(month)}
            </button>
            <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
          </div>
        )}
      </header>

      <InstallBanner />

      <main className="app-body">
        {!ready ? (
          <p className="empty">Loading…</p>
        ) : tab === 'dashboard' ? (
          <Dashboard month={month} categories={categories} />
        ) : tab === 'transactions' ? (
          <TransactionList
            month={month}
            categories={categories}
            onEdit={(t) => setSheet({ mode: 'edit', txn: t })}
          />
        ) : tab === 'categories' ? (
          <Categories categories={categories} />
        ) : (
          <ImportCsv categories={categories} onDone={() => setTab('transactions')} />
        )}
      </main>

      {showFab && (
        <button className="fab" onClick={() => setSheet({ mode: 'new' })} aria-label="Add transaction">
          ＋
        </button>
      )}

      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'tab-on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={21} />
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>

      {sheet && (
        <TransactionSheet
          categories={categories}
          initial={sheet.mode === 'edit' ? sheet.txn : null}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  )
}

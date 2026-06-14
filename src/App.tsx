import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Transaction } from './db/db'
import { seedIfEmpty } from './db/seed'
import { currentMonth, monthLabel, shiftMonth } from './lib/dates'
import { useTheme } from './lib/useTheme'
import { Dashboard } from './components/Dashboard'
import { TransactionList } from './components/TransactionList'
import { Categories } from './components/Categories'
import { ImportCsv } from './components/ImportCsv'
import { TransactionSheet } from './components/TransactionSheet'
import { InstallBanner } from './components/InstallBanner'
import { Account } from './components/Account'
import { Icon } from './components/Icon'
import { initSync } from './sync/sync'

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
  const { theme, toggle } = useTheme()

  const categories = useLiveQuery(() => db.categories.filter((c) => !c.deleted).toArray(), [], [])

  useEffect(() => {
    seedIfEmpty().finally(() => setReady(true))
    initSync()
  }, [])

  const showMonthNav = tab === 'dashboard' || tab === 'transactions'
  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? ''

  const navButtons = (cls: 'tab' | 'side-tab') =>
    TABS.map((t) => (
      <button
        key={t.id}
        className={`${cls} ${tab === t.id ? `${cls}-on` : ''}`}
        onClick={() => setTab(t.id)}
      >
        <Icon name={t.icon} size={cls === 'side-tab' ? 19 : 21} />
        <span className="tab-label">{t.label}</span>
      </button>
    ))

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="side-brand"><span className="brand-mark" /> Tally</div>
        <nav className="side-nav">{navButtons('side-tab')}</nav>
        <div className="side-foot">
          <button className="side-add" onClick={() => setSheet({ mode: 'new' })}>
            <Icon name="plus" size={18} /> New transaction
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="app-head">
          <div className="brand"><span className="brand-mark" /> Tally</div>
          <h1 className="page-title">{activeLabel}</h1>
          <div className="head-right">
            {showMonthNav && (
              <div className="month-nav">
                <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
                <button className="month-label" onClick={() => setMonth(currentMonth())} title="Jump to current month">
                  {monthLabel(month)}
                </button>
                <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
              </div>
            )}
            <Account />
            <button className="theme-toggle" onClick={toggle} aria-label="Toggle light or dark">
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
            </button>
          </div>
        </header>

        <InstallBanner />

        <main className="app-body">
          <div className="app-scroll">
            <div className="view" key={tab}>
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
            </div>
          </div>
        </main>

        {showMonthNav && (
          <button className="fab" onClick={() => setSheet({ mode: 'new' })} aria-label="Add transaction">＋</button>
        )}

        <nav className="tabbar">{navButtons('tab')}</nav>
      </div>

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

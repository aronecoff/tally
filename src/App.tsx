import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Transaction } from './db/db'
import { seedIfEmpty } from './db/seed'
import { seedAccountsIfEmpty } from './db/seedAccounts'
import { currentMonth, monthLabel, shiftMonth } from './lib/dates'
import { useTheme } from './lib/useTheme'
import { Home } from './components/Home'
import { Accounts } from './components/Accounts'
import { Dashboard } from './components/Dashboard'
import { Analysis } from './components/Analysis'
import { TransactionList } from './components/TransactionList'
import { Categories } from './components/Categories'
import { TransactionSheet } from './components/TransactionSheet'
import { InstallBanner } from './components/InstallBanner'
import { Account } from './components/Account'
import { Icon } from './components/Icon'
import { initSync, subscribeSync } from './sync/sync'
import { syncAllConnectors, subscribeBankHealth, type BankHealth } from './lib/banks'

type Tab = 'home' | 'dashboard' | 'insights' | 'accounts' | 'transactions' | 'categories'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'dashboard', label: 'Budget', icon: 'pie' },
  { id: 'insights', label: 'Insights', icon: 'chart' },
  { id: 'accounts', label: 'Accounts', icon: 'wallet' },
  { id: 'transactions', label: 'Activity', icon: 'list' },
  { id: 'categories', label: 'Categories', icon: 'tag' },
]

export default function App() {
  const [month, setMonth] = useState(currentMonth())
  const [tab, setTab] = useState<Tab>('home')
  const [editTxn, setEditTxn] = useState<Transaction | null>(null)
  const [ready, setReady] = useState(false)
  const [bankHealth, setBankHealth] = useState<BankHealth>('unknown')
  const { theme, toggle } = useTheme()

  useEffect(() => subscribeBankHealth(setBankHealth), [])

  const categories = useLiveQuery(() => db.categories.filter((c) => !c.deleted).toArray(), [], [])

  useEffect(() => {
    Promise.all([seedIfEmpty(), seedAccountsIfEmpty()]).finally(() => setReady(true))
    initSync()
    // Real-time connector sync: pull balances + transactions on boot, whenever the
    // window regains focus, and every few minutes while open. Device sync (Supabase
    // ↔ Dexie) runs its own 45s/focus/online loop inside initSync().
    const pull = () => void syncAllConnectors().catch(() => {})
    const boot = setTimeout(pull, 1800)
    const iv = setInterval(pull, 4 * 60 * 1000)
    window.addEventListener('focus', pull)

    // Kill stale builds: poke the service worker to check for a new deploy on a
    // short interval + on focus. registerType 'autoUpdate' then activates the new
    // build and reloads on its own — no more manual ⇧⌘R / force-refresh.
    const swUpdate = () =>
      void navigator.serviceWorker?.getRegistration?.().then((r) => r?.update()).catch(() => {})
    const swIv = setInterval(swUpdate, 60 * 1000)
    window.addEventListener('focus', swUpdate)
    // The moment a session signs in (fresh device / after reconnect), pull live
    // balances immediately — no manual "Sync now", net worth is never $0.
    let signedIn = false
    const unsub = subscribeSync((s) => {
      const now = !!s.email
      if (now && !signedIn) pull()
      signedIn = now
    })
    return () => {
      clearTimeout(boot)
      clearInterval(iv)
      clearInterval(swIv)
      window.removeEventListener('focus', pull)
      window.removeEventListener('focus', swUpdate)
      unsub()
    }
  }, [])

  const isHome = tab === 'home'
  const showMonthNav = tab === 'dashboard' || tab === 'insights' || tab === 'transactions'
  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? ''

  const navButtons = (cls: 'tab' | 'side-tab') => {
    // Mobile bar = the 4 daily destinations (Home via the wordmark; Categories is
    // a settings screen, reached from Budget → "Manage categories & budgets").
    const items = cls === 'tab' ? TABS.filter((t) => t.id !== 'home' && t.id !== 'categories') : TABS
    return items.map((t) => (
      <button
        key={t.id}
        className={`${cls} ${tab === t.id ? `${cls}-on` : ''}`}
        onClick={() => setTab(t.id)}
      >
        <Icon name={t.icon} size={cls === 'side-tab' ? 19 : 21} />
        <span className="tab-label">{t.label}</span>
      </button>
    ))
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="side-brand"><span className="brand-mark" /> Tally</div>
        <nav className="side-nav">{navButtons('side-tab')}</nav>
      </aside>

      <div className="main">
        <header className="app-head">
          <button className="brand" onClick={() => setTab('home')} aria-label="Home">
            <span className="brand-mark" /> Tally
          </button>
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

        {bankHealth === 'expired' && (
          <button
            className="reconnect-banner"
            onClick={() => {
              setTab('accounts')
              window.dispatchEvent(new Event('tally:open-bank-connect'))
            }}
          >
            <Icon name="alert" size={15} />
            Bank connection expired — tap to reconnect
          </button>
        )}

        <main className="app-body">
          <div className="app-scroll">
            <div className="view" key={tab}>
              {!ready ? (
                <p className="empty">Loading…</p>
              ) : tab === 'home' ? (
                <Home categories={categories} onEdit={setEditTxn} onMore={() => setTab('dashboard')} />
              ) : tab === 'dashboard' ? (
                <Dashboard month={month} categories={categories} onManageCategories={() => setTab('categories')} onEdit={setEditTxn} />
              ) : tab === 'insights' ? (
                <Analysis month={month} categories={categories} />
              ) : tab === 'accounts' ? (
                <Accounts onSynced={() => setTab('insights')} />
              ) : tab === 'transactions' ? (
                <TransactionList month={month} categories={categories} onEdit={setEditTxn} />
              ) : (
                <Categories categories={categories} />
              )}
            </div>
          </div>
        </main>

        {!isHome && <nav className="tabbar">{navButtons('tab')}</nav>}
      </div>

      {editTxn && (
        <TransactionSheet categories={categories} initial={editTxn} onClose={() => setEditTxn(null)} />
      )}
    </div>
  )
}

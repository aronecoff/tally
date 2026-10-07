import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction } from './db/db'
import { supabase } from './db/supabase'
import { seedIfEmpty } from './db/seed'
import { currentMonth } from './lib/dates'
import { useToday } from './lib/useToday'
import { useTheme } from './lib/useTheme'
import { play } from './lib/motion'
import { Home } from './components/Home'
import { Accounts } from './components/Accounts'
import { Dashboard } from './components/Dashboard'
import { Analysis } from './components/Analysis'
import { TransactionList } from './components/TransactionList'
import { Categories } from './components/Categories'
import { TransactionSheet } from './components/TransactionSheet'
import { InstallBanner } from './components/InstallBanner'
import { Account } from './components/Account'
import { CommandSheet } from './components/CommandSheet'
import { Icon } from './components/Icon'
import { MonthSwitch } from './components/MonthSwitch'
import { Skeleton, type SkeletonVariant } from './components/Skeleton'
import { getStack, useOpenSheets } from './components/sheetStack'
import { initSync, subscribeSync, type SyncSnapshot } from './sync/sync'
import { syncAllConnectors, subscribeBankHealth, type BankHealth } from './lib/banks'

type Tab = 'home' | 'dashboard' | 'insights' | 'accounts' | 'transactions' | 'categories'

// Screen names: the [data-screen] styling hook AND the URL hash. Internal Tab
// ids stay as they are.
const SCREEN: Record<Tab, string> = {
  home: 'home',
  dashboard: 'budget',
  insights: 'insights',
  accounts: 'accounts',
  transactions: 'activity',
  categories: 'categories',
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'dashboard', label: 'Budget', icon: 'pie' },
  { id: 'insights', label: 'Insights', icon: 'chart' },
  { id: 'accounts', label: 'Accounts', icon: 'wallet' },
  { id: 'transactions', label: 'Activity', icon: 'list' },
  { id: 'categories', label: 'Categories', icon: 'tag' },
]
const TAB_IDS = TABS.map((t) => t.id)

/** The month screens: their header title is the month switch. */
const MONTH_TABS = new Set<Tab>(['dashboard', 'insights', 'transactions'])

const SKELETON: Record<Tab, SkeletonVariant> = {
  home: 'home',
  dashboard: 'budget',
  insights: 'insights',
  accounts: 'accounts',
  transactions: 'list',
  categories: 'list',
}

const MONTH_KEY = 'tally-month'

function tabFromHash(): Tab | null {
  const h = location.hash.replace(/^#/, '')
  return TAB_IDS.find((t) => SCREEN[t] === h) ?? null
}

/** A past month chosen on purpose survives a reload (per tab session). The
 *  current month is never stored, so a reload after the month turns (an
 *  update, or iOS reloading the web view overnight) opens the new month. */
function readMonth(): string {
  const cur = currentMonth()
  try {
    const m = sessionStorage.getItem(MONTH_KEY)
    if (m && /^\d{4}-\d{2}$/.test(m) && m < cur) return m
  } catch {
    /* storage blocked: start on this month */
  }
  return cur
}

const reducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** The app icon's tally mark: four strokes and the accent diagonal. */
function TallyGlyph() {
  return (
    <svg
      className="head-glyph"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M7 5.75v12.5 M10.33 5.75v12.5 M13.67 5.75v12.5 M17 5.75v12.5" />
      <path className="head-glyph-slash" d="M7 17.2 17 6.8" />
    </svg>
  )
}

/** Stable while categories load, so the memoised panes do not re-render. */
const NO_CATEGORIES: Category[] = []

interface SortQueue {
  items: Transaction[]
  i: number
}

export default function App() {
  const [month, setMonth] = useState(readMonth)
  // Left open overnight into a new month: a screen that was following the
  // current month moves to the new one; a past month chosen on purpose stays.
  const cur = useToday().slice(0, 7)
  const [seenCur, setSeenCur] = useState(cur)
  if (seenCur !== cur) {
    setSeenCur(cur)
    if (month === seenCur) setMonth(cur)
  }
  const [tab, setTab] = useState<Tab>(() => tabFromHash() ?? 'home')
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set([tabFromHash() ?? 'home']))
  const [editTxn, setEditTxn] = useState<Transaction | null>(null)
  const [adding, setAdding] = useState(false)
  const [queue, setQueue] = useState<SortQueue | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [bankPrompt, setBankPrompt] = useState(false)
  const [budgetFocus, setBudgetFocus] = useState<{ key: string; n: number } | null>(null)
  const [ready, setReady] = useState(false)
  const [bankHealth, setBankHealth] = useState<BankHealth>('unknown')
  const [snap, setSnap] = useState<SyncSnapshot | null>(null)
  const { pref, setPref } = useTheme()

  const headRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const panes = useRef<Partial<Record<Tab, HTMLElement | null>>>({})
  const scrollMem = useRef<Partial<Record<Tab, number>>>({})
  const tabRef = useRef(tab)
  const pendingTab = useRef<Tab | null>(null)

  useEffect(() => subscribeBankHealth(setBankHealth), [])
  useEffect(() => subscribeSync(setSnap), [])

  // No [] default: undefined means "still loading", never "no categories".
  const categories = useLiveQuery(() => db.categories.filter((c) => !c.deleted).toArray(), [])
  const loaded = ready && categories !== undefined

  useEffect(() => {
    seedIfEmpty().finally(() => setReady(true))
    initSync()
    // Real-time connector sync: pull balances + transactions on boot, whenever the
    // window regains focus, and every few minutes while open. Each run syncs the
    // device (Supabase ↔ Dexie) first; initSync() adds a 45s/online loop of its own.
    const pull = () => void syncAllConnectors().catch(() => {})
    const boot = setTimeout(pull, 1800)
    // SimpleFIN refreshes once every 24h; lib/banks throttles the actual bank
    // calls to 4/day. A 30-minute tick is plenty to catch the window opening.
    const iv = setInterval(pull, 30 * 60 * 1000)
    window.addEventListener('focus', pull)

    // Stale builds: poke the service worker to check for a new deploy on a short
    // interval + on focus. main.tsx applies the update once the app is idle.
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

  // A past month survives a reload; the current month is not stored (readMonth).
  useEffect(() => {
    try {
      if (month === cur) sessionStorage.removeItem(MONTH_KEY)
      else sessionStorage.setItem(MONTH_KEY, month)
    } catch {
      /* storage blocked */
    }
  }, [month, cur])

  // ---- Navigation --------------------------------------------------------
  /** Show a tab: remember the old pane's scroll, update the hash, mount it once. */
  const show = useCallback((t: Tab, push = false) => {
    const cur = tabRef.current
    const el = panes.current[cur]
    if (el) scrollMem.current[cur] = el.scrollTop
    if (push) history.pushState({ tally: 'cat' }, '', `#${SCREEN[t]}`)
    else history.replaceState(history.state, '', `#${SCREEN[t]}`)
    tabRef.current = t
    setVisited((v) => (v.has(t) ? v : new Set(v).add(t)))
    setTab(t)
  }, [])

  /** Every tab change goes through here. The active tab again scrolls to top. */
  const go = useCallback(
    (t: Tab) => {
      const cur = tabRef.current
      if (t === cur) {
        panes.current[t]?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
        return
      }
      // Leaving a Categories that Budget pushed: pop its entry first (so no
      // stray entry is left for the edge swipe) and land in popstate.
      if (cur === 'categories' && history.state?.tally === 'cat') {
        pendingTab.current = t
        history.back()
        return
      }
      show(t)
    },
    [show],
  )

  useEffect(() => {
    // The hash always names the screen (reload lands where you were).
    history.replaceState(history.state, '', `#${SCREEN[tabRef.current]}`)
    const onPop = () => {
      const pending = pendingTab.current
      pendingTab.current = null
      if (pending) {
        show(pending)
        return
      }
      const t = tabFromHash() ?? 'home'
      if (t !== tabRef.current) show(t)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [show])

  /** Budget's Edit: Categories as a pushed child, so back returns to Budget. */
  const pushCategories = useCallback(() => {
    if (tabRef.current !== 'categories') show('categories', true)
  }, [show])

  /** The Categories back control: its label ('Budget') is always true. go()
   *  pops a pushed Categories entry and lands on Budget whatever the entry
   *  behind it now says (a tab change rewrites it; Forward comes back here). */
  const back = useCallback(() => go('dashboard'), [go])

  // Restore the shown pane's own scroll position and the header hairline.
  useLayoutEffect(() => {
    const el = panes.current[tab]
    if (!el) return
    const y = scrollMem.current[tab] ?? 0
    if (Math.abs(el.scrollTop - y) > 1) el.scrollTop = y
    headRef.current?.classList.toggle('scrolled', el.scrollTop > 2)
  }, [tab, loaded])

  // Month step: the shown pane drifts in from the side time moved toward (a
  // step back comes from the left) and the header month crossfades. Script
  // animations, so nothing replays when a pane is shown again; transform and
  // opacity only; play() skips them under Reduce Motion.
  const shownMonth = useRef(month)
  useLayoutEffect(() => {
    const from = shownMonth.current
    shownMonth.current = month
    if (from === month) return
    // A new month is new content: every month screen opens at its top.
    for (const t of MONTH_TABS) scrollMem.current[t] = 0
    const shown = panes.current[tabRef.current]
    if (shown && MONTH_TABS.has(tabRef.current)) shown.scrollTop = 0
    headRef.current?.classList.remove('scrolled')
    const d = month > from ? 1 : -1
    play(
      panes.current[tabRef.current],
      [
        { opacity: 0.35, transform: `translateX(${d * 14}px)` },
        { opacity: 1, transform: 'none' },
      ],
      '--dur-2',
    )
    play(headRef.current?.querySelector('.ms-label'), [{ opacity: 0 }, { opacity: 1 }], '--dur-2')
  }, [month])

  // Header hairline: a DOM class from one passive capture listener, never state.
  useEffect(() => {
    const main = mainRef.current
    if (!main) return
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement
      if (el !== panes.current[tabRef.current]) return
      headRef.current?.classList.toggle('scrolled', el.scrollTop > 2)
    }
    main.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => main.removeEventListener('scroll', onScroll, { capture: true })
  }, [])

  // One stable ref per pane. A pane is marked data-seen after its first 900ms,
  // so entrances never replay when it is shown again.
  const [paneRefs] = useState(
    () =>
      Object.fromEntries(
        TAB_IDS.map((t) => [
          t,
          (el: HTMLElement | null) => {
            panes.current[t] = el
            if (el && !el.hasAttribute('data-seen')) window.setTimeout(() => el.setAttribute('data-seen', ''), 900)
          },
        ]),
      ) as Record<Tab, (el: HTMLElement | null) => void>,
  )

  // ---- Cross-screen actions (stable, so memoised panes do not re-render) ---
  const openAdd = useCallback(() => setAdding(true), [])
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const openCommand = useCallback(() => setCommandOpen(true), [])
  const closeCommand = useCallback(() => setCommandOpen(false), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const closeTxn = useCallback(() => {
    setEditTxn(null)
    setAdding(false)
  }, [])
  // A new row shows its own month (the + is global, and the month a screen
  // shows can be a past one). A month the switcher cannot reach yet (a future
  // date) leaves the view as it is.
  const showMonthOf = useCallback((date: string) => {
    const m = date.slice(0, 7)
    if (m <= currentMonth()) setMonth(m)
  }, [])
  // Home is always the current month, so what it opens on Budget is too
  // (the tab bar keeps the month Budget was left on).
  const goBudget = useCallback(() => {
    setMonth(currentMonth())
    go('dashboard')
  }, [go])
  // 'Refresh balances' lands on Insights only if the user is still on Accounts
  // with nothing open over it when the refresh resolves (read live then, not
  // from the tap): otherwise the pane switched behind their back.
  const onRefreshed = useCallback(() => {
    if (tabRef.current === 'accounts' && getStack().length === 0) go('insights')
  }, [go])
  const goCategories = useCallback(() => go('categories'), [go])
  const openBank = useCallback(() => {
    setBankPrompt(true)
    go('accounts')
  }, [go])
  const clearBankPrompt = useCallback(() => setBankPrompt(false), [])
  const openCategory = useCallback(
    (key: string) => {
      setBudgetFocus((f) => ({ key, n: (f?.n ?? 0) + 1 }))
      setMonth(currentMonth())
      go('dashboard')
    },
    [go],
  )
  const consumeFocus = useCallback(() => setBudgetFocus(null), [])

  /**
   * The sort queue: this month's posted, uncategorized expenses, largest first.
   * Pending rows are never offered (a manual pin on a pending charge can
   * double-count once it posts). Nothing to sort: nothing opens.
   */
  const sortUncategorized = useCallback(async () => {
    const rows = await db.transactions.where('date').startsWith(currentMonth()).toArray()
    const items = rows
      .filter((t) => !t.deleted && t.type === 'expense' && t.categoryId == null && !t.pending)
      .sort((a, b) => b.amount - a.amount)
    if (items.length === 0) return
    setQueue({ items, i: 0 })
  }, [])
  const advanceQueue = useCallback(
    () => setQueue((q) => (q && q.i + 1 < q.items.length ? { ...q, i: q.i + 1 } : q)),
    [],
  )
  const closeQueue = useCallback(() => setQueue(null), [])

  // DEV-only QA hooks. import.meta.env.DEV is false in production builds, so
  // these expressions are dropped from dist.
  // ?__state=bank-expired forces the reconnect banner so the harness can capture it.
  const forceBankExpired =
    import.meta.env.DEV && new URLSearchParams(location.search).get('__state') === 'bank-expired'
  // window.__tally.sortUncategorized() lets the harness and probes drive the queue.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __tally?: object }).__tally = { sortUncategorized }
  }, [sortUncategorized])

  // 'n' opens the add sheet and '/' opens Tell Tally, when nothing is being
  // typed and no sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'n' && e.key !== '/') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      const a = document.activeElement as HTMLElement | null
      if (a && (a.matches('input, textarea, select') || a.isContentEditable)) return
      if (document.querySelector('.sheet')) return
      e.preventDefault()
      if (e.key === 'n') setAdding(true)
      else setCommandOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openSheets = useOpenSheets()
  const bankSheetOpen = openSheets.some((s) => s.kind === 'bank')
  const showReconnect = (bankHealth === 'expired' || forceBankExpired) && !bankSheetOpen

  // ---- Sync status on the Settings button (only when it means something) --
  const syncOn = !!supabase || !!snap?.email
  const dot: 'error' | 'signedout' | 'syncing' | null = !syncOn
    ? null
    : snap?.status === 'error'
      ? 'error'
      : !snap?.email
        ? 'signedout'
        : snap.status === 'syncing'
          ? 'syncing'
          : null
  const statusLabel =
    dot === 'error'
      ? 'Settings, sync paused'
      : dot === 'signedout'
        ? 'Settings, not signed in'
        : dot === 'syncing'
          ? 'Settings, syncing'
          : 'Settings'
  const dotEl = dot && <span className={`head-dot is-${dot}`} aria-hidden="true" />

  // Categories highlights Budget in the tab bar (it is Budget's child there).
  const navTab: Tab = tab === 'categories' ? 'dashboard' : tab

  const navButtons = (cls: 'tab' | 'side-tab') => {
    // Mobile bar = the 5 daily destinations; Categories lives under Budget.
    const items = cls === 'tab' ? TABS.filter((t) => t.id !== 'categories') : TABS
    const current = cls === 'tab' ? navTab : tab
    return items.map((t) => {
      const on = current === t.id
      return (
        <button
          key={t.id}
          type="button"
          className={`${cls} ${on ? `${cls}-on` : ''}`}
          aria-current={on ? 'page' : undefined}
          onClick={() => go(t.id)}
        >
          <Icon name={t.icon} size={cls === 'side-tab' ? 19 : 21} />
          <span className="tab-label">{t.label}</span>
        </button>
      )
    })
  }

  const headLeft =
    tab === 'home' ? (
      <h1 className="head-brand">
        {/* The brand on the phone; 'Home' on the desktop, where the sidebar carries the brand. */}
        <span className="head-brand-mark">
          <TallyGlyph /> Tally
        </span>
        <span className="head-brand-desk">Home</span>
      </h1>
    ) : MONTH_TABS.has(tab) ? (
      <MonthSwitch month={month} setMonth={setMonth} />
    ) : tab === 'accounts' ? (
      <h1 className="page-title">Accounts</h1>
    ) : (
      <>
        <button type="button" className="head-back" onClick={back}>
          <Icon name="chevron" size={20} className="flip" />
          Budget
        </button>
        <h1 className="head-center">Categories</h1>
      </>
    )

  const cats = categories ?? NO_CATEGORIES
  const screens = useMemo(
    () => ({
      home: (active: boolean) => (
        <>
          <InstallBanner />
          <Home
            active={active}
            categories={cats}
            onEdit={setEditTxn}
            onMore={goBudget}
            onSort={sortUncategorized}
            onOpenCategory={openCategory}
          />
        </>
      ),
      dashboard: (active: boolean) => (
        <Dashboard
          active={active}
          month={month}
          categories={cats}
          onManageCategories={pushCategories}
          onEdit={setEditTxn}
          initialOpen={budgetFocus}
          onInitialOpenConsumed={consumeFocus}
        />
      ),
      insights: (active: boolean) => <Analysis active={active} month={month} categories={cats} />,
      accounts: (active: boolean) => (
        <Accounts
          active={active}
          openBankConnect={bankPrompt}
          onBankConnectOpened={clearBankPrompt}
          onSynced={onRefreshed}
        />
      ),
      transactions: (active: boolean) => (
        <TransactionList active={active} month={month} categories={cats} onEdit={setEditTxn} onAdd={openAdd} />
      ),
      categories: () => <Categories categories={cats} />,
    }),
    [cats, month, goBudget, sortUncategorized, openCategory, pushCategories, budgetFocus, consumeFocus, bankPrompt,
      clearBankPrompt, onRefreshed, openAdd],
  )

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="side-brand">
          <TallyGlyph /> Tally
        </div>
        <nav className="side-nav" aria-label="Primary">
          {navButtons('side-tab')}
        </nav>
        <div className="side-foot">
          <button type="button" className="side-add" data-testid="add-txn" aria-label="Add transaction" onClick={openAdd}>
            <Icon name="plus" size={16} />
            <span>Add transaction</span>
          </button>
          <button type="button" className="side-tab" data-testid="command-btn" aria-label="Tell Tally" onClick={openCommand}>
            <Icon name="prompt" size={19} />
            <span className="tab-label">Tell Tally</span>
          </button>
          <button
            type="button"
            className="side-tab side-settings"
            data-testid="settings-btn"
            aria-label={statusLabel}
            onClick={openSettings}
          >
            <Icon name="person" size={19} />
            <span className="tab-label">Settings</span>
            {dotEl}
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="app-head" ref={headRef}>
          <div className="head-left">{headLeft}</div>
          <div className="head-right">
            <button type="button" className="head-btn" data-testid="command-btn" aria-label="Tell Tally" onClick={openCommand}>
              <Icon name="prompt" size={21} />
            </button>
            <button type="button" className="head-btn" data-testid="add-txn" aria-label="Add transaction" onClick={openAdd}>
              <Icon name="plus" size={22} />
            </button>
            <button
              type="button"
              className="head-btn"
              data-testid="settings-btn"
              aria-label={statusLabel}
              onClick={openSettings}
            >
              <Icon name="person" size={21} />
              {dotEl}
            </button>
          </div>
        </header>

        {showReconnect && (
          <button type="button" className="reconnect-banner" data-testid="reconnect-banner" onClick={openBank}>
            <Icon name="alert" size={16} />
            <span className="reconnect-copy">Bank connection expired.</span>
            <span className="reconnect-cta">Reconnect</span>
          </button>
        )}

        <main className="app-body" ref={mainRef}>
          {!loaded ? (
            <section className="view pane" data-screen={SCREEN[tab]} aria-busy="true">
              <Skeleton variant={SKELETON[tab]} />
            </section>
          ) : (
            TAB_IDS.filter((t) => visited.has(t)).map((t) => (
              <section
                key={t}
                className="view pane"
                data-screen={SCREEN[t]}
                aria-label={TABS.find((x) => x.id === t)?.label}
                hidden={t !== tab}
                ref={paneRefs[t]}
              >
                {/* A month screen suspends while a new month loads: under a
                    MonthSwitch transition the old month stays up meanwhile;
                    any other month change shows the skeleton. */}
                <Suspense fallback={<Skeleton variant={SKELETON[t]} />}>{screens[t](t === tab)}</Suspense>
              </section>
            ))
          )}
        </main>

        <nav className="tabbar" aria-label="Primary">
          {navButtons('tab')}
        </nav>
      </div>

      {loaded && queue ? (
        <TransactionSheet
          key="queue"
          categories={cats}
          initial={queue.items[queue.i]}
          progress={`${queue.i + 1} of ${queue.items.length}`}
          remaining={queue.items.length - queue.i - 1}
          onSaved={advanceQueue}
          onClose={closeQueue}
        />
      ) : loaded && (editTxn || adding) ? (
        <TransactionSheet key="edit" categories={cats} initial={editTxn} onClose={closeTxn} onAdded={showMonthOf} />
      ) : null}

      {loaded && commandOpen && <CommandSheet categories={cats} onClose={closeCommand} />}

      {settingsOpen && (
        <Account
          onClose={closeSettings}
          pref={pref}
          setPref={setPref}
          onCategories={goCategories}
          onBankConnections={openBank}
        />
      )}
    </div>
  )
}

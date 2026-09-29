import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Account, type AccountType } from '../db/db'
import { money } from '../lib/format'
import { ago } from '../lib/dates'
import { splitMask } from '../lib/merchants'
import { brokerageEnabled, connectBrokerage } from '../lib/brokerage'
import { banksEnabled, syncAllConnectors } from '../lib/banks'
import { BankConnectSheet } from './BankConnectSheet'
import { AccountSheet } from './AccountSheet'
import { squarify } from '../lib/treemap'
import { TIERS } from '../lib/tiers'
import { Icon } from './Icon'
import { Money } from './Money'
import { Skeleton } from './Skeleton'

/** Treemap canvas; the container is locked to this ratio so cells stay square-ish. */
const MAP_W = 100
const MAP_H = 64

/** Tile hit slop, in px. A tile under 44pt (--hit) grows its tap area out over
 *  the map's outer edges: the 16px page gutter or the desktop column gap at the
 *  sides, the section title row above, the legend below (none of them tappable).
 *  Between tiles it grows only halfway into the 4px gap, so it never covers a
 *  neighbour's visible tile. A tile boxed in by neighbours can stay under 44pt;
 *  its account row is the full 60pt target. */
const HIT = 44
const GAP_HALF = 2
const OUT_SIDE = 12
const OUT_TOP = 12
const OUT_BOTTOM = 24

/** Splits `need` px of slop between two sides, each held to its own cap. */
function spread(need: number, capA: number, capB: number): [number, number] {
  let a = Math.min(capA, need / 2)
  const b = Math.min(capB, need - a)
  a = Math.min(capA, need - b)
  return [a, b]
}

const px = (n: number) => `${Math.max(0, n).toFixed(2)}px`
const onEdge = (v: number, at: number) => Math.abs(v - at) < 0.01

/** Auto refresh on showing Accounts: at most once a minute, across tab switches. */
const AUTO_REFRESH_MS = 60_000
let lastAutoRefresh = 0

/** 'Refresh balances' forces a bank fetch at most once per 30 minutes (client-side).
 *  More often and SimpleFIN answers 403 (over budget), which reads as 'expired'. */
const FORCE_FLOOR_MS = 30 * 60_000
const FORCED_KEY = 'tally-forced-bank-at'
/** In-memory copy, so blocked storage cannot reset the floor within a session. */
let lastForcedMem = 0
/** lib/banks stamps every real bank fetch here; read-only on this screen. */
const BANK_FETCH_KEY = 'tally:lastBankFetchAt'

/** Freshness: a live balance older than 2 days, or a manual one older than 30, is stale. */
const LIVE_STALE_MS = 2 * 864e5
const MANUAL_STALE_MS = 30 * 864e5

const EMPTY: Account[] = []

// Map labels only: a compact figure ($1.3K) where the whole-dollar one does not fit.
const COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})
const COMPACT_MULT: Record<string, number> = { '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 }

/** Width of a tile amount as drawn (the .nwmap-amt font: --w-demi --fs-meta
 *  --font-ui). Canvas matches the DOM for these figures; without a canvas it
 *  falls back to the 7.2px-a-character estimate. */
let amtCtx: CanvasRenderingContext2D | null | undefined
function amountWidth(s: string): number {
  if (amtCtx === undefined) {
    try {
      amtCtx = document.createElement('canvas').getContext('2d')
      if (amtCtx) {
        const css = getComputedStyle(document.documentElement)
        const v = (k: string, d: string) => css.getPropertyValue(k).trim() || d
        amtCtx.font = `${v('--w-demi', '600')} ${v('--fs-meta', '13px')} ${v('--font-ui', 'sans-serif')}`
      }
    } catch {
      amtCtx = null
    }
  }
  return amtCtx ? amtCtx.measureText(s).width : s.length * 7.2
}

function readTime(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0
  } catch {
    return 0
  }
}

function writeTime(key: string, ms: number): void {
  try {
    localStorage.setItem(key, String(ms))
  } catch {
    /* storage blocked: the in-memory copy still holds the floor this session */
  }
}

/** Compact form of |n|, or null when it would sit more than 1% off the exact
 *  figure ($1.9K for $1,851.37 is 2.6% off, so that tile shows no amount). */
function compactAbs(n: number): string | null {
  const abs = Math.abs(n)
  const s = COMPACT.format(abs)
  const m = s.match(/^\$([\d.,]+)([KMBT]?)$/)
  if (!m) return null
  const v = Number(m[1].replace(/,/g, '')) * (COMPACT_MULT[m[2]] ?? NaN)
  return Math.abs(v - abs) <= abs * 0.01 ? s : null
}

/** The tile's name: the institution when it is the only one, otherwise the tail
 *  of the name that tells its siblings apart, mask stripped ('Checking'). */
function tileLabel(a: Account, all: Account[]): string {
  const sib = all.filter((b) => b.institution === a.institution)
  if (sib.length <= 1) return a.institution || splitMask(a.name).base
  const words = (s: string) => splitMask(s).base.split(/\s+/)
  const mine = words(a.name)
  let k = 0
  while (k < mine.length - 1 && sib.every((b) => words(b.name)[k] === mine[k])) k++
  return mine.slice(k).join(' ')
}

/** Row sub-line: mask, then how fresh the balance is. */
function rowSub(a: Account, now: number): { text: string; stale: boolean } {
  const { last4 } = splitMask(a.name)
  const pre = last4 ? `··${last4} · ` : ''
  if (a.balance === 0) return { text: `${pre}No balance yet`, stale: false }
  const at = a.lastUpdated
  if (a.liveSync) return { text: at ? `${pre}Updated ${ago(at)}` : `${pre}Live`, stale: !!at && now - at > LIVE_STALE_MS }
  return { text: at ? `${pre}Manual · ${ago(at)}` : `${pre}Manual`, stale: !!at && now - at > MANUAL_STALE_MS }
}

interface Props {
  /** This pane is the visible one (the auto refresh runs when it becomes true). */
  active: boolean
  /** App asks for the bank-connect sheet (reconnect banner, Settings). */
  openBankConnect?: boolean
  /** Called once the bank-connect sheet has been opened for openBankConnect. */
  onBankConnectOpened?: () => void
  /** A manual 'Refresh balances' succeeded (App jumps to Insights). */
  onSynced?: () => void
}

export const Accounts = memo(function Accounts({ active, openBankConnect, onBankConnectOpened, onSynced }: Props) {
  // No [] default: undefined means "still loading" (a skeleton, never a false $0.00).
  const accounts = useLiveQuery(() => db.accounts.filter((a) => !a.deleted && !a.archived).toArray(), [])
  const list = accounts ?? EMPTY
  const [editing, setEditing] = useState<Account | 'new' | null>(null)
  const [bankOpen, setBankOpen] = useState(false)
  /** A manual refresh in flight, and where it was started. */
  const [busy, setBusy] = useState<'status' | 'row' | null>(null)
  /** The quiet auto refresh. Never disables anything. */
  const [refreshing, setRefreshing] = useState(false)
  const [statusErr, setStatusErr] = useState<string | null>(null)
  const [rowNote, setRowNote] = useState<{ text: string; err: boolean } | null>(null)
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null)
  const mapRef = useRef<HTMLDivElement>(null)
  const [mapPx, setMapPx] = useState(0)

  /** status: the hero line, never forces the bank. row: 'Refresh balances', the one
   *  forcing action (at most every 30 minutes), which jumps to Insights on success. */
  async function runSync(from: 'status' | 'row') {
    if (busy) return
    let force = false
    let sinceForced = 0
    if (from === 'row') {
      sinceForced = Date.now() - Math.max(readTime(FORCED_KEY), lastForcedMem)
      force = sinceForced >= FORCE_FLOOR_MS
      if (force) {
        lastForcedMem = Date.now()
        writeTime(FORCED_KEY, lastForcedMem)
      }
    }
    setBusy(from)
    setStatusErr(null)
    setRowNote(null)
    try {
      let res = await syncAllConnectors({ force })
      // A run already in flight (this screen's auto refresh, or the app's boot, focus
      // or interval sync) absorbs the call and skips the bank on its 6h floor. Run
      // again once it settles, so the forced fetch the tap asked for still happens.
      if (force && res.bankSkipped) res = await syncAllConnectors({ force: true })
      const { total, errors } = res
      if (total === 0 && errors.length) {
        // Surface the sign-in prompt if that is why nothing synced, else the first error.
        const msg = errors.find((e) => /sign in/i.test(e)) ?? errors[0]
        if (from === 'row') setRowNote({ text: msg, err: true })
        else setStatusErr(msg)
      } else if (from === 'row') {
        if (!force) {
          const mins = Math.max(1, Math.ceil((FORCE_FLOOR_MS - sinceForced) / 60_000))
          const bankAt = readTime(BANK_FETCH_KEY)
          setRowNote({
            text: `${bankAt ? `Bank data updated ${ago(bankAt)}` : 'Balances updated'} · again in ${mins} min`,
            err: false,
          })
        }
        onSynced?.()
      }
    } finally {
      setBusy(null)
    }
  }

  async function runConnectBrokerage() {
    setNote(null)
    // Open the window synchronously inside the click gesture so it is not pop-up
    // blocked after the awaited round-trip; fill in its URL once we have it.
    const win = window.open('', '_blank')
    try {
      const url = await connectBrokerage()
      if (win) {
        win.location.href = url
        setNote({ text: 'Finish linking in the window that opened. Balances refresh when you come back.', err: false })
      } else {
        setNote({ text: 'Allow pop-ups for this site, then tap Connect a brokerage again.', err: true })
      }
    } catch (e) {
      if (win) win.close()
      setNote({ text: e instanceof Error ? e.message : 'Could not start the connection', err: true })
    }
  }

  // Settings' Bank connections (and the reconnect banner) dispatch this event.
  useEffect(() => {
    const open = () => setBankOpen(true)
    window.addEventListener('tally:open-bank-connect', open)
    return () => window.removeEventListener('tally:open-bank-connect', open)
  }, [])

  // App asks for the bank sheet through a prop as well (idempotent with the event).
  useEffect(() => {
    if (!openBankConnect) return
    setBankOpen(true)
    onBankConnectOpened?.()
  }, [openBankConnect, onBankConnectOpened])

  // Quiet refresh whenever Accounts is shown: at most once a minute, never forced,
  // never disabling a control, never jumping tabs.
  useEffect(() => {
    if (!active || !brokerageEnabled) return
    const now = Date.now()
    if (now - lastAutoRefresh < AUTO_REFRESH_MS) return
    lastAutoRefresh = now
    setRefreshing(true)
    syncAllConnectors()
      .catch(() => {
        /* quiet on auto-run: the manual actions surface errors */
      })
      .finally(() => setRefreshing(false))
  }, [active])

  const { netWorth, assets, liabilities, byTier } = useMemo(() => {
    const byTier = new Map<AccountType, Account[]>()
    let assets = 0
    let liabilities = 0
    for (const a of list) {
      if (!byTier.has(a.type)) byTier.set(a.type, [])
      byTier.get(a.type)!.push(a)
      if (a.type === 'credit') liabilities += a.balance
      else assets += a.balance
    }
    for (const l of byTier.values()) l.sort((a, b) => a.sortOrder - b.sortOrder)
    return { netWorth: assets - liabilities, assets, liabilities, byTier }
  }, [list])

  // Balance map: area = size of the balance, colour = tier. Area alone cannot tell
  // an asset from a debt, so the tier colour carries that distinction.
  const cells = useMemo(
    () =>
      squarify(
        list
          .map((a) => ({ key: String(a.id), value: Math.abs(a.balance), data: a }))
          .filter((i) => i.value > 0)
          .sort((x, y) => y.value - x.value),
        MAP_W,
        MAP_H,
      ),
    [list],
  )

  // Legend: tiers on the map, largest first, no amounts (the tier headers hold them).
  const legend = useMemo(
    () =>
      TIERS.filter((t) => list.some((a) => a.type === t.type && a.balance !== 0))
        .map((t) => ({ t, total: list.filter((a) => a.type === t.type).reduce((s, a) => s + a.balance, 0) }))
        .sort((x, y) => Math.abs(y.total) - Math.abs(x.total)),
    [list],
  )

  // Tile labels are sized in real pixels. A hidden pane measures 0: keep the last width.
  const hasMap = cells.length > 0
  useLayoutEffect(() => {
    const el = mapRef.current
    if (!el) return
    const w0 = Math.round(el.getBoundingClientRect().width)
    if (w0 > 0) setMapPx(w0)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width)
      if (w > 0) setMapPx(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasMap])

  if (accounts === undefined) return <Skeleton variant="accounts" />

  const now = Date.now()
  const newestLive = Math.max(0, ...list.filter((a) => a.liveSync).map((a) => a.lastUpdated || 0))
  const bankAt = readTime(BANK_FETCH_KEY)
  const u = mapPx / MAP_W

  const connections = (
    <div className="tier add-group">
      <div className="tier-head">
        <span className="tier-label">Connections</span>
      </div>
      <ul className="acct-list">
        {brokerageEnabled && (
          <li className="row-sep">
            <button type="button" className="acct-row row-press" onClick={() => void runSync('row')}>
              <span className="cat-tile">
                <Icon name="repeat" size={18} className={busy === 'row' ? 'spin' : undefined} />
              </span>
              <span className="acct-main">
                <span className="acct-name">Refresh balances</span>
                <span className={`acct-sub${rowNote?.err ? ' is-err' : ''}`}>
                  {busy === 'row'
                    ? 'Refreshing…'
                    : rowNote?.text ?? (bankAt ? `Bank data updated ${ago(bankAt)}` : 'Bank data not fetched yet')}
                </span>
              </span>
            </button>
          </li>
        )}
        {banksEnabled && (
          <li className="row-sep">
            <button
              type="button"
              className="acct-row row-press"
              data-testid="connect-bank"
              onClick={() => setBankOpen(true)}
            >
              <span className="cat-tile">
                <Icon name="bank" size={18} />
              </span>
              <span className="acct-main">
                <span className="acct-name">Connect a bank</span>
                <span className="acct-sub">Balances and transactions via SimpleFIN</span>
              </span>
              <Icon name="chevron" size={14} className="chev acct-chev" />
            </button>
          </li>
        )}
        {brokerageEnabled && (
          <li className="row-sep">
            <button type="button" className="acct-row row-press" onClick={() => void runConnectBrokerage()}>
              <span className="cat-tile">
                <Icon name="chart" size={18} />
              </span>
              <span className="acct-main">
                <span className="acct-name">Connect a brokerage</span>
                <span className="acct-sub">Balances via SnapTrade</span>
              </span>
              <Icon name="chevron" size={14} className="chev acct-chev" />
            </button>
          </li>
        )}
        <li className="row-sep">
          <button type="button" className="acct-row row-press" onClick={() => setEditing('new')}>
            <span className="cat-tile">
              <Icon name="plus" size={18} />
            </span>
            <span className="acct-main">
              <span className="acct-name">Add manually</span>
              <span className="acct-sub">Enter a balance yourself</span>
            </span>
            <Icon name="chevron" size={14} className="chev acct-chev" />
          </button>
        </li>
      </ul>
      {note && (
        <p className={`acct-note${note.err ? ' is-err' : ''}`} role="status">
          {note.text}
        </p>
      )}
    </div>
  )

  return (
    <div className="accounts">
      {list.length === 0 ? (
        <div className="dash-col">
          <p className="empty">No accounts yet</p>
          {connections}
        </div>
      ) : (
        <>
          <div className="dash-col">
            <section className="sect nw-hero">
              <span className="hero-label">Net worth</span>
              <Money className="hero-fig" value={netWorth} />
              <span className="hero-caption">
                <span className="num">{money(assets)}</span>
                {/* The owed part only when something is owed (as the old foot did). */}
                {liabilities > 0 ? (
                  <>
                    {' owned · '}
                    <span className="num">{money(liabilities)}</span>{' '}
                    owed
                  </>
                ) : (
                  ' owned'
                )}
              </span>
              {brokerageEnabled && (
                <button
                  type="button"
                  className={`nw-status${statusErr ? ' is-err' : ''}`}
                  onClick={() => void runSync('status')}
                  disabled={busy != null}
                >
                  <Icon name="repeat" size={13} className={busy || refreshing ? 'spin' : undefined} />
                  <span>
                    {statusErr ??
                      (busy || refreshing ? 'Updating…' : newestLive ? `Updated ${ago(newestLive)}` : 'Refresh')}
                  </span>
                </button>
              )}
            </section>

            {hasMap && (
              <section className="sect">
                <div className="sect-row">
                  <span className="sect-title">Where your money lives</span>
                  <span className="sect-note">size = balance</span>
                </div>
                <div
                  className="nwmap"
                  ref={mapRef}
                  role="group"
                  aria-label="Where your money lives"
                  style={{ aspectRatio: `${MAP_W} / ${MAP_H}` }}
                >
                  {cells.map((c) => {
                    const a = c.data
                    const owed = a.type === 'credit'
                    const wpx = c.rect.w * u - 4
                    const hpx = c.rect.h * u - 4
                    // Same sign rule as the row: credit shows '−' for an amount owed.
                    const lead = owed && a.balance > 0 ? '−' : ''
                    const full = lead + money(a.balance, { approx: true })
                    const short = compactAbs(a.balance)
                    const compact = short && lead + (a.balance < 0 ? '−' : '') + short
                    // The drawn width plus the 8px inset, the border and a little air on
                    // the right. An amount that does not fit is left out, never cut.
                    const fits = (s: string) => wpx >= amountWidth(s) + 12
                    const amt = hpx < 20 ? null : fits(full) ? full : compact && fits(compact) ? compact : null
                    const showName = amt != null && hpx >= 40 && wpx >= 52
                    const exact = `${a.institution} ${a.name}, ${owed ? 'owed ' : ''}${money(a.balance)}`
                    const r = c.rect
                    const [sl, sr] = spread(
                      Math.max(0, HIT - wpx),
                      onEdge(r.x, 0) ? OUT_SIDE : GAP_HALF,
                      onEdge(r.x + r.w, MAP_W) ? OUT_SIDE : GAP_HALF,
                    )
                    const [st, sb] = spread(
                      Math.max(0, HIT - hpx),
                      onEdge(r.y, 0) ? OUT_TOP : GAP_HALF,
                      onEdge(r.y + r.h, MAP_H) ? OUT_BOTTOM : GAP_HALF,
                    )
                    const style = {
                      left: `calc(${(r.x / MAP_W) * 100}% + 2px)`,
                      top: `calc(${(r.y / MAP_H) * 100}% + 2px)`,
                      width: `calc(${(r.w / MAP_W) * 100}% - 4px)`,
                      height: `calc(${(r.h / MAP_H) * 100}% - 4px)`,
                      '--slop-t': px(st),
                      '--slop-r': px(sr),
                      '--slop-b': px(sb),
                      '--slop-l': px(sl),
                    } as CSSProperties
                    return (
                      <button
                        key={c.key}
                        type="button"
                        className={`nwmap-tile ${a.type}`}
                        style={style}
                        onClick={() => setEditing(a)}
                        title={exact}
                        aria-label={exact}
                      >
                        {amt && (
                          <span className={`nwmap-label${hpx < 30 ? ' tight' : ''}`} aria-hidden="true">
                            {showName && <span className="nwmap-name">{tileLabel(a, list)}</span>}
                            <span className="nwmap-amt num">{amt}</span>
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
                <div className="nwmap-key">
                  {legend.map(({ t }) => (
                    <span className="nwmap-key-item" key={t.type}>
                      <i className={`nwmap-dot ${t.type}`} aria-hidden="true" />
                      {t.liability ? 'Owed' : t.label}
                    </span>
                  ))}
                </div>
              </section>
            )}
          </div>

          <div className="dash-col">
            {TIERS.map((tier) => {
              const rows = byTier.get(tier.type) ?? []
              if (rows.length === 0) return null
              const subtotal = rows.reduce((s, a) => s + a.balance, 0)
              return (
                <div className="tier" key={tier.type}>
                  <div className="tier-head">
                    <span className="tier-label">
                      <i className={`tier-dot ${tier.type}`} aria-hidden="true" />
                      {tier.label}
                    </span>
                    <span className="tier-total num">
                      {tier.liability && subtotal > 0 ? '−' : ''}
                      {money(subtotal)}
                    </span>
                  </div>
                  <ul className="acct-list">
                    {rows.map((a) => {
                      const sub = rowSub(a, now)
                      return (
                        <li key={a.id} className="row-sep">
                          <button type="button" className="acct-row row-press" onClick={() => setEditing(a)}>
                            <span className="cat-tile">
                              <Icon name={tier.icon} size={18} />
                            </span>
                            <span className="acct-main">
                              <span className="acct-name">
                                {a.institution} {splitMask(a.name).base}
                              </span>
                              <span className={`acct-sub${sub.stale ? ' stale' : ''}`}>{sub.text}</span>
                            </span>
                            <span className="acct-bal num">
                              {tier.liability && a.balance > 0 ? '−' : ''}
                              {money(a.balance)}
                            </span>
                            <Icon name="chevron" size={14} className="chev acct-chev" />
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
            {connections}
          </div>
        </>
      )}

      {editing && <AccountSheet initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {bankOpen && (
        <BankConnectSheet
          onClose={() => setBankOpen(false)}
          onResult={(msg, isErr) => setNote({ text: msg, err: isErr })}
        />
      )}
    </div>
  )
})

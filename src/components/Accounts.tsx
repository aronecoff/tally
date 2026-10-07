import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Account, type AccountType } from '../db/db'
import { money, toCents } from '../lib/format'
import { ago } from '../lib/dates'
import { splitMask } from '../lib/merchants'
import { brokerageEnabled, connectBrokerage, restoreAccount } from '../lib/brokerage'
import { banksEnabled, subscribeBankWarnings, subscribeConnectorSync, syncAllConnectors } from '../lib/banks'
import { BankConnectSheet } from './BankConnectSheet'
import { AccountSheet } from './AccountSheet'
import { squarify } from '../lib/treemap'
import { compactForms, fitTileLabel } from '../lib/mapLabel'
import { TIERS } from '../lib/tiers'
import { useSettle } from '../lib/motion'
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
/** lib/banks stamps every bank fetch that brought data back here; read-only on this screen. */
const BANK_FETCH_KEY = 'tally:lastBankFetchAt'

/** Freshness: a live balance older than 2 days, or a manual one older than 30, is stale. */
const LIVE_STALE_MS = 2 * 864e5
const MANUAL_STALE_MS = 30 * 864e5

/** A result note that is not an error stays this long ('Bank connected.'). */
const NOTE_MS = 8000
/** The relative times on screen ('Updated 5m ago') are redrawn this often while it is shown. */
const TICK_MS = 30_000

/** An error, and when it arrived: a later successful sync clears it. */
type TimedErr = { text: string; at: number }
/** Under 'Refresh balances': an error, or the 30-minute floor (drawn from timestamps). */
type RowNote = ({ kind: 'err' } & TimedErr) | { kind: 'floor' }
/** Under Connections: a connect result. `untilSync` holds it until the next
 *  successful sync ('Finish linking…'), otherwise a success fades after NOTE_MS. */
type ConnectNote = { text: string; err: boolean; at: number; untilSync?: boolean }

const EMPTY: Account[] = []

/** A tile's drawn box under this (px) is only its borders, and its +2px inset
 *  pushes it past its own cell, out of the map: it is not drawn. */
const MIN_TILE = 4

/** Width of a tile amount as drawn (the .nwmap-amt font: --w-demi --fs-meta
 *  --font-ui, or --fs-micro for .nwmap-amt.small). Canvas matches the DOM for
 *  these figures; without a canvas it falls back to a per-character estimate
 *  (7.2px at 13px, scaled for 11px). */
let amtCtx: CanvasRenderingContext2D | null | undefined
let amtFont: { meta: string; micro: string } | null = null
function amountWidth(s: string, small = false): number {
  if (amtCtx === undefined) {
    try {
      amtCtx = document.createElement('canvas').getContext('2d')
      if (amtCtx) {
        const css = getComputedStyle(document.documentElement)
        const v = (k: string, d: string) => css.getPropertyValue(k).trim() || d
        const font = (size: string) => `${v('--w-demi', '600')} ${size} ${v('--font-ui', 'sans-serif')}`
        amtFont = { meta: font(v('--fs-meta', '13px')), micro: font(v('--fs-micro', '11px')) }
      }
    } catch {
      amtCtx = null
    }
  }
  if (!amtCtx || !amtFont) return s.length * (small ? 6.1 : 7.2)
  amtCtx.font = small ? amtFont.micro : amtFont.meta
  return amtCtx.measureText(s).width
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

/** Row sub-line: mask, then how fresh the balance is. The verb ('Updated ') is
 *  its own part so a 320px screen can drop it ('··1111 · 12d ago'). */
function rowSub(a: Account, now: number): { pre: string; verb: string; text: string; stale: boolean } {
  const { last4 } = splitMask(a.name)
  const pre = last4 ? `··${last4} · ` : ''
  // A live $0 is a real reading (a paid-off card) and gets the freshness line;
  // only a manual account still at $0 has no balance yet.
  if (a.balance === 0 && !a.liveSync) return { pre, verb: '', text: 'No balance yet', stale: false }
  const at = a.lastUpdated
  if (a.liveSync)
    return at ? { pre, verb: 'Updated ', text: ago(at), stale: now - at > LIVE_STALE_MS } : { pre, verb: '', text: 'Live', stale: false }
  return { pre, verb: '', text: at ? `Manual · ${ago(at)}` : 'Manual', stale: !!at && now - at > MANUAL_STALE_MS }
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
  // Connector-fed accounts the user removed: hidden, never re-added by a sync,
  // and restorable here (a reconnect no longer looks like it brought them back).
  const removed = useLiveQuery(() => db.accounts.filter((a) => !!a.deleted && a.liveSync && !!a.sourceAccountId).toArray(), []) ?? EMPTY
  /** A bank connection SimpleFIN could not refresh: its accounts kept their last balance. */
  const [bankWarn, setBankWarn] = useState<string[]>([])
  useEffect(() => subscribeBankWarnings(setBankWarn), [])
  const [editing, setEditing] = useState<Account | 'new' | null>(null)
  const [bankOpen, setBankOpen] = useState(false)
  /** A manual refresh in flight, and where it was started. */
  const [busy, setBusy] = useState<'status' | 'row' | null>(null)
  /** The quiet auto refresh. Never disables anything. */
  const [refreshing, setRefreshing] = useState(false)
  const [statusErr, setStatusErr] = useState<TimedErr | null>(null)
  const [rowNote, setRowNote] = useState<RowNote | null>(null)
  const [note, setNote] = useState<ConnectNote | null>(null)
  const mapRef = useRef<HTMLDivElement>(null)
  const [mapPx, setMapPx] = useState(0)

  // A successful connector sync from anywhere (the app's focus and interval
  // syncs included) clears an error shown from an earlier run, and a note
  // waiting for that sync. They used to stay up after later syncs worked.
  useEffect(
    () =>
      subscribeConnectorSync((okAt) => {
        setStatusErr((e) => (e && okAt >= e.at ? null : e))
        setRowNote((n) => (n?.kind === 'err' && okAt >= n.at ? null : n))
        setNote((n) => (n && !n.err && okAt >= n.at ? null : n))
      }),
    [],
  )

  // A connect success fades; an error stays until the next action.
  useEffect(() => {
    if (!note || note.err || note.untilSync) return
    const t = setTimeout(() => setNote((n) => (n === note ? null : n)), NOTE_MS)
    return () => clearTimeout(t)
  }, [note])

  // Leaving the screen clears the connect note (it answered what was done here).
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    if (!active) setNote(null)
  }

  // Relative times ('Updated 5m ago', 'again in 3 min') are drawn from
  // timestamps: redraw them while the screen is shown, and on coming back.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const tick = () => setTick((t) => t + 1)
    const iv = setInterval(tick, TICK_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(iv)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active])

  /** status: the hero line, never forces the bank. row: 'Refresh balances', the one
   *  forcing action (at most every 30 minutes), which jumps to Insights on success. */
  async function runSync(from: 'status' | 'row') {
    if (busy) return
    let force = false
    if (from === 'row') {
      const sinceForced = Date.now() - Math.max(readTime(FORCED_KEY), lastForcedMem)
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
        const at = Date.now()
        if (from === 'row') setRowNote({ kind: 'err', text: msg, at })
        else setStatusErr({ text: msg, at })
      } else if (from === 'row') {
        // Inside the 30-minute floor: say when the bank can be asked again
        // (drawn from the timestamps at render, so it counts down).
        if (!force) setRowNote({ kind: 'floor' })
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
    // Cut the link back to Tally while the window is still our blank page, so the
    // portal (or any page it passes through) cannot redirect this tab. Not
    // 'noopener': that makes window.open return null and breaks the trick above.
    if (win) win.opener = null
    try {
      const url = await connectBrokerage()
      if (win) {
        win.location.href = url
        setNote({
          text: 'Finish linking in the window that opened. Balances refresh when you come back.',
          err: false,
          at: Date.now(),
          untilSync: true,
        })
      } else {
        setNote({ text: 'Allow pop-ups for this site, then tap Connect a brokerage again.', err: true, at: Date.now() })
      }
    } catch (e) {
      if (win) win.close()
      setNote({ text: e instanceof Error ? e.message : 'Could not start the connection. Try again.', err: true, at: Date.now() })
    }
  }

  // App asks for the bank sheet through a prop (reconnect banner, Settings).
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

  // Net worth settles when it changes (a sync landing, an edit).
  const heroRef = useRef<HTMLElement>(null)
  useSettle(heroRef, '.hero-fig')

  if (accounts === undefined) return <Skeleton variant="accounts" />

  const now = Date.now()
  const newestLive = Math.max(0, ...list.filter((a) => a.liveSync).map((a) => a.lastUpdated || 0))
  const bankAt = readTime(BANK_FETCH_KEY)
  const bankLine = bankAt ? `Bank data updated ${ago(bankAt)}` : 'Bank data not fetched yet'
  // The floor note while a forced refresh is still not allowed; after that the
  // row reads as it always does.
  const floorLeft = FORCE_FLOOR_MS - (now - Math.max(readTime(FORCED_KEY), lastForcedMem))
  const rowText =
    rowNote?.kind === 'err'
      ? rowNote.text
      : rowNote?.kind === 'floor' && floorLeft > 0
        ? `${bankAt ? bankLine : 'Balances updated'} · again in ${Math.ceil(floorLeft / 60_000)} min`
        : bankLine
  const u = mapPx / MAP_W

  const connections = (
    <div className="tier add-group enter">
      <div className="tier-head">
        <span className="tier-label">Connections</span>
      </div>
      <ul className="acct-list">
        {banksEnabled && bankWarn.length > 0 && (
          <li className="row-sep">
            <button type="button" className="acct-row row-press" onClick={() => setBankOpen(true)}>
              <span className="cat-tile">
                <Icon name="alert" size={18} />
              </span>
              <span className="acct-main">
                <span className="acct-name">Needs attention</span>
                <span className="acct-sub is-err">
                  {bankWarn[0].replace(/[.\s]+$/, '')}. Its accounts keep their last balance. Tap to reconnect.
                </span>
              </span>
              <Icon name="chevron" size={14} className="chev acct-chev" />
            </button>
          </li>
        )}
        {brokerageEnabled && (
          <li className="row-sep">
            <button type="button" className="acct-row row-press" onClick={() => void runSync('row')}>
              <span className="cat-tile">
                <Icon name="repeat" size={18} className={busy === 'row' ? 'spin' : undefined} />
              </span>
              <span className="acct-main">
                <span className="acct-name">Refresh balances</span>
                <span className={`acct-sub${rowNote?.kind === 'err' ? ' is-err' : ''}`}>
                  {busy === 'row' ? 'Refreshing…' : rowText}
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
        {removed.map((a) => (
          <li className="row-sep" key={a.id}>
            <button type="button" className="acct-row row-press" onClick={() => void restoreAccount(a.id!)}>
              <span className="cat-tile">
                <Icon name="plus" size={18} />
              </span>
              <span className="acct-main">
                <span className="acct-name">
                  Restore {a.institution} {a.name}
                </span>
                <span className="acct-sub">Removed from net worth. Tap to count it again.</span>
              </span>
            </button>
          </li>
        ))}
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
          <p className="empty enter">No accounts yet</p>
          {connections}
        </div>
      ) : (
        <>
          <div className="dash-col">
            <section className="sect nw-hero enter" ref={heroRef}>
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
                    {statusErr?.text ??
                      (busy || refreshing
                        ? 'Updating…'
                        : bankWarn.length
                          ? 'Some accounts not updated'
                          : newestLive
                            ? `Updated ${ago(newestLive)}`
                            : 'Refresh')}
                  </span>
                </button>
              )}
            </section>

            {hasMap && (
              <section className="sect enter">
                <div className="sect-row">
                  <span className="sect-title">Where your money lives</span>
                  <span className="sect-note">sized by balance</span>
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
                    // Too small to draw honestly (a few dollars beside thousands): left
                    // out, its area kept as a gap so the rest keep their proportions.
                    // Its row below is the full target. Not before the map is measured.
                    if (mapPx > 0 && (wpx < MIN_TILE || hpx < MIN_TILE)) return null
                    // Same sign rule as the row: what the account adds to net
                    // worth. Owed reads '−$500'; a card in credit '+$126'.
                    const shown = owed ? -a.balance : a.balance
                    const inCredit = owed && a.balance < 0
                    const full = (inCredit ? '+' : '') + money(shown, { approx: true })
                    const sign = shown < 0 ? '−' : inCredit ? '+' : ''
                    // Whole or compact, normal or small, across or up the side
                    // (lib/mapLabel): only slivers no true figure fits in stay empty.
                    const label = fitTileLabel(full, compactForms(a.balance).map((s) => sign + s), wpx, hpx, amountWidth)
                    const small = !!label?.small
                    const vert = !!label?.vert
                    const showName = label != null && !vert && hpx >= 40 && wpx >= 52
                    const exact = inCredit
                      ? `${a.institution} ${a.name}, credit ${money(-a.balance)}`
                      : `${a.institution} ${a.name}, ${owed ? 'owed ' : ''}${money(a.balance)}`
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
                        {label && (
                          <span className={`nwmap-label${vert ? ' vert' : hpx < 30 ? ' tight' : ''}`} aria-hidden="true">
                            {showName && <span className="nwmap-name">{tileLabel(a, list)}</span>}
                            <span className={`nwmap-amt num${small ? ' small' : ''}`}>{label.amt}</span>
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
              const subtotal = rows.reduce((s, a) => s + toCents(a.balance), 0) / 100
              return (
                <div className="tier enter" key={tier.type}>
                  <div className="tier-head">
                    <span className="tier-label">
                      <i className={`tier-dot ${tier.type}`} aria-hidden="true" />
                      {tier.label}
                    </span>
                    <span className="tier-total num">
                      {/* A liability shows what it adds to net worth: owed is
                          '−$X'; a card in credit is money of yours, '+$X credit'. */}
                      {tier.liability ? (
                        subtotal < 0 ? <span className="pos">{money(-subtotal, { sign: true })} credit</span> : money(-subtotal)
                      ) : (
                        money(subtotal)
                      )}
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
                              <span className={`acct-sub${sub.stale ? ' stale' : ''}`}>
                                {sub.pre}
                                {sub.verb && <span className="acct-sub-verb">{sub.verb}</span>}
                                {sub.text}
                              </span>
                            </span>
                            <span className="acct-bal num">
                              {tier.liability ? (
                                a.balance < 0 ? <span className="pos">{money(-a.balance, { sign: true })} credit</span> : money(-a.balance)
                              ) : (
                                money(a.balance)
                              )}
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
          onResult={(msg, isErr) => setNote({ text: msg, err: isErr, at: Date.now() })}
        />
      )}
    </div>
  )
})

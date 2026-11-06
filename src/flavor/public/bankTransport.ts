import { db, type Account } from '../../db/db'
import type { SyncedTx } from '../../lib/bankRules'
import type { SyncedAccount } from '../../lib/accountMerge'
import { normalize, transactionsOf, type SimplefinSet } from '../../lib/simplefinNormalize'
import { native } from './native'

/**
 * SimpleFIN on the device. The app does the HTTP and holds the access URL; this
 * answers banks.ts exactly as the Edge Function does in the personal build, down
 * to the error strings it reads by regex.
 */

export const banksConfigured = true

export const bankBlockedCopy: { signIn: string | null; notPulled: string | null } = { signIn: null, notPulled: null }

const DAY = 86_400
/**
 * SimpleFIN allows 90 days a request, but past 45 its answer carries a warning in
 * `errors`, which the app must show and which stops accounts being archived. So
 * every request stays under it. A request with no end date counts to a day past
 * now, which makes the most that reads clean 44 (seen on the demo bridge).
 */
export const WINDOW_DAYS = 44
/** A first link reaches back this many windows, just under a year. */
const HISTORY_WINDOWS = 8
/** A row can land a few days after its own date. Each pull looks back past the last one by this. */
const OVERLAP_DAYS = 7
/**
 * The reconcile compares calendar days and a window opens mid-day, so the first
 * day of a window holds rows the bank was never asked for. A row's own date can
 * also sit up to OVERLAP_DAYS from the bank's date, which is what the bank filters
 * on. Past this far inside the oldest window, a stored row missing from the feed
 * is really gone. Nearer the edge it may only be out of reach, so it stays.
 */
const RECONCILE_MARGIN_DAYS = OVERLAP_DAYS + 1
/**
 * How far past the last read a pull reaches. Rows no rule can name stay out of the
 * ledger while they sit in the first days of the feed (`edgeTo`), and one that never
 * got in is gone for good. So a new row must start clear of those days, even landing
 * a week late with a purchase date a week before that.
 */
const READ_BACK_DAYS = RECONCILE_MARGIN_DAYS + 2 * OVERLAP_DAYS
/** Up to when the ledger holds everything the bank offered (seconds), every
 *  connection included. Held back while one is down. Unset: never yet. */
const COVERED_KEY = 'plainsum:bankCoveredTo'
/** Up to when the connections that answered have been read, problems or not.
 *  Unset: a first link's history is still to read. */
const READ_KEY = 'plainsum:bankReadTo'

function readPoint(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0
  } catch {
    return 0
  }
}

function writePoint(key: string, at: number): void {
  try {
    localStorage.setItem(key, String(at))
  } catch {
    /* private mode: the next pull reaches back further, which is safe */
  }
}

/** Which link a pull in flight was started for. */
let link = 0

/** A new link has a new history to read: the next pull fetches all of it. */
export function forgetBankCoverage(): void {
  link++
  try {
    localStorage.removeItem(COVERED_KEY)
    localStorage.removeItem(READ_KEY)
  } catch {
    /* nothing to forget */
  }
}

interface Span {
  start: number
  /** Exclusive, as SimpleFIN reads it. The newest window leaves it open, so a row
   *  dated tomorrow is not missed. */
  end?: number
}

/**
 * The requests one pull needs, newest first: contiguous, because `end-date` is
 * exclusive. Usually that is one. The app only pulls while it is open, so someone
 * back after months needs more than the last window, or the days between would
 * be missing for good. A first link needs the whole history.
 */
export function windowsFor(now: number, coveredTo: number): Span[] {
  const span = WINDOW_DAYS * DAY
  const back = coveredTo ? now - coveredTo + READ_BACK_DAYS * DAY : HISTORY_WINDOWS * span
  const count = Math.min(HISTORY_WINDOWS, Math.max(1, Math.ceil(back / span)))
  return Array.from({ length: count }, (_, i) => ({ start: now - (i + 1) * span, ...(i ? { end: now - i * span } : {}) }))
}

/** Refreshing needs an account a bank feeds. With none, the tap would do nothing. */
export const bankRefreshable = (accounts: Account[]): boolean => accounts.some((a) => a.source === 'simplefin' && a.liveSync)

/** Live accounts with nothing to read them through: a restore onto a new phone,
 *  because the Keychain item stays on the old one. */
const hasLiveAccounts = async () => (await db.accounts.filter((a) => a.source === 'simplefin' && a.liveSync && !a.deleted).count()) > 0

async function fetchSet(span: Span): Promise<SimplefinSet> {
  let reply: { status: number; body: string }
  try {
    reply = await native('simplefin.fetch', { startDate: span.start, ...(span.end ? { endDate: span.end } : {}) })
  } catch (e) {
    if (e instanceof Error && e.message === 'not_connected') {
      throw new Error((await hasLiveAccounts()) ? 'simplefin /accounts -> 401' : 'not connected', { cause: e })
    }
    throw e
  }
  if (reply.status < 200 || reply.status >= 300) throw new Error(`simplefin /accounts -> ${reply.status}`)
  try {
    return (JSON.parse(reply.body) ?? {}) as SimplefinSet
  } catch {
    return {}
  }
}

interface Pull {
  accounts: SyncedAccount[]
  transactions: SyncedTx[]
  /** Every account that answered, by its row label. */
  responded: string[]
  errors: unknown[]
  errlist: { msg?: unknown }[]
  /** Where the feed can be read as complete: a stored row older than this says nothing by being missing. */
  reconcileFrom: number
  /** Up to where a row may have lost its partner off the end of the feed. Unlike
   *  `reconcileFrom` it does not move for a troubled answer: that holds back what a
   *  stored row's absence means, and this would hold back rows the answer did carry. */
  edgeTo: number
}

const hasRows = (set: SimplefinSet) => (set.accounts ?? []).some((a) => (a.transactions ?? []).length > 0)

/** An answer that may be missing rows: a connection down, or nothing readable. */
const troubled = (set: SimplefinSet) => !!set.errors?.length || !!set.errlist?.length || !set.accounts?.length

/**
 * One pull, in as few requests as it can be. Two things decide how far back it
 * goes. The days since the last read are due whatever the answers say, or the
 * connections that work would miss them. The days a connection was down are
 * wanted too, but only from a clean answer: a line that stands must not cost a
 * long read on every pull, because SimpleFIN counts requests. So a connection
 * down from the first day costs the history once and then one request a pull, and
 * the first clean answer reads on to catch up.
 *
 * A window after the first that fails leaves the newest ones to use, and nothing
 * moves past it, so the next pull asks again. A first link stops at the first
 * empty window, which is as far back as the bank goes, and spares the budget.
 * Catching up does not: a quiet stretch can sit inside the days the app was
 * closed, with rows beyond it.
 */
async function pullWindows(): Promise<Pull> {
  const now = Math.floor(Date.now() / 1000)
  const startedFor = link
  const coveredTo = readPoint(COVERED_KEY)
  const spans = windowsFor(now, coveredTo)
  const due = windowsFor(now, readPoint(READ_KEY)).length
  const sets: SimplefinSet[] = []
  let ended = false
  for (const [i, span] of spans.entries()) {
    if (i >= due && sets.some(troubled)) break
    let set: SimplefinSet
    try {
      set = await fetchSet(span)
    } catch (e) {
      if (!i) throw e
      break
    }
    // Not an empty stretch: an answer with no accounts is one that could not be read.
    if (i && !set.accounts?.length) break
    sets.push(set)
    if (!coveredTo && i && !hasRows(set)) {
      ended = true
      break
    }
  }
  const finished = ended || sets.length === spans.length

  const rows = new Map<string, SyncedTx>()
  const responded = new Set<string>()
  for (const set of sets) {
    const { transactions, accounts } = transactionsOf(set)
    for (const t of transactions) if (!rows.has(t.sourceTxId)) rows.set(t.sourceTxId, t)
    for (const a of accounts) responded.add(a)
  }
  const errors = [...new Set(sets.flatMap((s) => s.errors ?? []))]
  const errlist = [...new Map(sets.flatMap((s) => s.errlist ?? []).map((e) => [String(e?.msg ?? ''), e])).values()]
  const accounts = (sets[0].accounts ?? []).map(normalize)
  if (startedFor === link && accounts.length) {
    if (finished || sets.length >= due) writePoint(READ_KEY, now)
    if (finished && !sets.some(troubled)) writePoint(COVERED_KEY, now)
  }
  // Windows past a troubled answer can hold an account's rows on either side of a
  // gap, so the reconcile stops short of it.
  const firstTroubled = sets.findIndex(troubled)
  const trusted = firstTroubled < 0 ? sets.length : Math.max(firstTroubled, 1)
  const reconcileFrom = spans[trusted - 1].start + RECONCILE_MARGIN_DAYS * DAY
  const edgeTo = spans[sets.length - 1].start + RECONCILE_MARGIN_DAYS * DAY
  return { accounts, transactions: [...rows.values()], responded: [...responded], errors, errlist, reconcileFrom, edgeTo }
}

let pulling: Promise<Pull> | null = null

/** banks.ts asks for balances and transactions side by side. One response holds
 *  both, so they share one pull: SimpleFIN counts requests, and two per run would
 *  spend the day's budget twice as fast for nothing. */
function pull(): Promise<Pull> {
  pulling ??= pullWindows().finally(() => {
    pulling = null
  })
  return pulling
}

export async function bankInvoke<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  switch (action) {
    case 'status': {
      const { connected } = await native<{ connected: boolean }>('simplefin.status')
      return { ok: true, connected } as T
    }
    case 'claim':
      await native('simplefin.claim', { setupToken: String(body.setupToken ?? '') })
      forgetBankCoverage()
      return { ok: true, connected: true } as T
    case 'sync': {
      const { accounts, errors, errlist } = await pull()
      return { ok: true, accounts, errors, errlist } as T
    }
    case 'transactions': {
      const { transactions, responded, errors, errlist, reconcileFrom, edgeTo } = await pull()
      return { ok: true, transactions, accounts: responded, errors, errlist, reconcileFrom, edgeTo } as T
    }
    default:
      throw new Error('unknown action')
  }
}

/** Whether a bank fetch can run: a stored link, or accounts left without one, whose
 *  fetch then fails as expired and raises the reconnect banner. In a browser, never. */
export async function bankReady(): Promise<boolean> {
  try {
    const { connected } = await native<{ connected: boolean }>('simplefin.status')
    return connected || (await hasLiveAccounts())
  } catch {
    return false
  }
}

/** The raw strings stay as banks.ts reads them. This is only what the screen says. */
export function bankErrorCopy(message: string): string {
  const status = /simplefin \/accounts ->\s*(\d{3})/i.exec(message)?.[1]
  if (status === '401' || status === '403') return 'Your bank connection needs a new setup token.'
  if (status === '402') return 'SimpleFIN says your subscription needs attention.'
  if (status === '429') return 'Bank refresh is paused for today. It will run again tomorrow.'
  if (status) return 'SimpleFIN did not answer. Try again later.'
  if (message === 'network') return 'No connection. Try again when you are online.'
  // A bridge code is not a sentence.
  return /^[a-z_]+$/.test(message) ? 'Could not refresh. Try again.' : message
}

const CLAIM_COPY: Record<string, string> = {
  not_simplefin: 'This token is not from SimpleFIN, so it was not used.',
  bad_token: 'That does not look like a setup token. Copy it again from SimpleFIN.',
  claim_refused: 'That token was already used or has expired. If you did not use it, check your connections at SimpleFIN.',
  claim_failed: 'SimpleFIN did not answer. Create a new token and try again.',
  network: 'No connection. Try again when you are online.',
}

/** What the bank sheet says about a failed claim. */
export const bankClaimCopy = (message: string): string | null => CLAIM_COPY[message] ?? null

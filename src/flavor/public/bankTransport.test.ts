// @vitest-environment jsdom
/**
 * The bank path of the public build, end to end through banks.ts, against a fake
 * of the native bridge that filters rows by date as SimpleFIN does. Every figure
 * is invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/db'
import { bankFetchDue, bankStatus, clearBankState, connectBank, subscribeBankHealth, subscribeBankWarnings, syncAllConnectors, type BankHealth } from '../../lib/banks'
import type { SimplefinAccount, SimplefinTransaction } from '../../lib/simplefinNormalize'
import { bankClaimCopy, bankErrorCopy, bankInvoke, bankReady, forgetBankCoverage, WINDOW_DAYS, windowsFor } from './bankTransport'

declare global {
  interface Window {
    webkit: { messageHandlers: { plainsum: { postMessage: typeof postMessage } } }
  }
}

const DAY = 86400
const NOW = Date.parse('2031-03-15T12:00:00Z')
const NOW_S = NOW / 1000
const ago = (days: number) => NOW_S - days * DAY
/** As far back as a first link reads. */
const HISTORY_REACH = 8 * WINDOW_DAYS * DAY

const ORG = { domain: 'bank.test', name: 'Northgate Bank' }
const card = (rows: SimplefinTransaction[], balance = '-310.40'): SimplefinAccount => ({ id: 'c1', name: 'Rewards Visa', balance, org: ORG, transactions: rows })
const row = (id: string, daysAgo: number, amount = '-12.50', payee = 'Corner Cafe'): SimplefinTransaction => ({ id, posted: ago(daysAgo), amount, description: payee, payee })

interface FetchArgs {
  startDate: number
  endDate?: number
}

/** The app around the page. `feed` is everything the bank has. */
const app = {
  connected: true,
  feed: [] as SimplefinAccount[],
  errors: [] as string[],
  /** Replaces the answer to the nth fetch (from 0), or to all of them. */
  fail: null as null | ((n: number) => { status: number; body?: string } | Error | null),
  fetches: [] as FetchArgs[],
  claims: [] as string[],
}

function answer(args: FetchArgs) {
  const n = app.fetches.push(args) - 1
  const failed = app.fail?.(n)
  if (failed instanceof Error) throw failed
  if (failed) return { status: failed.status, body: failed.body ?? '', used: n + 1, cap: 24 }
  const inSpan = (t: SimplefinTransaction) => Number(t.posted) >= args.startDate && (!args.endDate || Number(t.posted) < args.endDate)
  const accounts = app.feed.map((a) => ({ ...a, transactions: (a.transactions ?? []).filter(inSpan) }))
  return { status: 200, body: JSON.stringify({ errors: app.errors, accounts }), used: n + 1, cap: 24 }
}

function postMessage({ method, args }: { method: string; args: Record<string, unknown> }) {
  switch (method) {
    case 'simplefin.status':
      return Promise.resolve({ connected: app.connected })
    case 'simplefin.claim':
      app.claims.push(String(args.setupToken))
      app.connected = true
      return Promise.resolve({ connected: true })
    case 'simplefin.fetch':
      if (!app.connected) return Promise.reject(new Error('not_connected'))
      try {
        return Promise.resolve(answer(args as unknown as FetchArgs))
      } catch (e) {
        return Promise.reject(e)
      }
    default:
      return Promise.reject(new Error('unavailable'))
  }
}

const live = async () => (await db.transactions.toArray()).filter((t) => !t.deleted)
const health = () => {
  let now: BankHealth = 'unknown'
  subscribeBankHealth((h) => { now = h })()
  return now
}
const warnings = () => {
  let now: string[] = []
  subscribeBankWarnings((w) => { now = w })()
  return now
}
/** History read: from here on a pull is one request. */
const settle = async () => {
  await syncAllConnectors({ force: true })
  app.fetches = []
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  Object.assign(app, { connected: true, feed: [], errors: [], fail: null, fetches: [], claims: [] })
  vi.stubGlobal('webkit', { messageHandlers: { plainsum: { postMessage } } })
  localStorage.clear()
  clearBankState()
  await db.accounts.clear()
  await db.transactions.clear()
  await db.categories.clear()
  await db.categories.add({ id: 1, name: 'Other', key: 'other', icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the windows of a pull', () => {
  const span = WINDOW_DAYS * DAY

  it('stays under the size SimpleFIN warns about, and far under its limit', () => {
    expect(WINDOW_DAYS).toBeLessThanOrEqual(44)
    for (const w of windowsFor(NOW_S, 0)) {
      // A window left open is counted to a day past now.
      const measured = (w.end ?? NOW_S + DAY) - w.start
      expect(measured).toBeLessThanOrEqual(45 * DAY)
    }
  })

  it('reads just under a year on a first link, newest first, with no gap and no overlap', () => {
    const list = windowsFor(NOW_S, 0)
    expect(list).toHaveLength(8)
    expect(list[0]).toEqual({ start: NOW_S - span })
    for (let i = 1; i < list.length; i++) expect(list[i].end).toBe(list[i - 1].start)
    expect(list.at(-1)!.start).toBe(NOW_S - 8 * span)
  })

  it('is one request while the app is opened at all often', () => {
    expect(windowsFor(NOW_S, NOW_S - 6 * 3600)).toHaveLength(1)
    expect(windowsFor(NOW_S, ago(22))).toHaveLength(1)
  })

  it('reaches back over the days the app was closed', () => {
    expect(windowsFor(NOW_S, ago(23))).toHaveLength(2)
    const list = windowsFor(NOW_S, ago(100))
    expect(list).toHaveLength(3)
    expect(list.at(-1)!.start).toBeLessThanOrEqual(ago(100))
  })

  it('never asks for more than a first link would', () => {
    expect(windowsFor(NOW_S, ago(5000))).toHaveLength(8)
  })

  it('survives a clock that moved back', () => {
    expect(windowsFor(NOW_S, NOW_S + 30 * DAY)).toHaveLength(1)
  })
})

describe('one request per pull', () => {
  it('reads balances and transactions from a single fetch', async () => {
    app.feed = [card([row('t1', 3)])]
    await settle()
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(1)
    expect(app.fetches[0].endDate).toBeUndefined()
    expect(await db.accounts.count()).toBe(1)
    expect(await live()).toHaveLength(1)
  })

  it('makes at most four automatic pulls in a day, however often the app asks', async () => {
    app.feed = [card([row('t1', 3)])]
    await settle()
    for (let minute = 0; minute < 24 * 60; minute += 15) {
      vi.setSystemTime(NOW + minute * 60_000)
      await syncAllConnectors()
    }
    expect(app.fetches.length).toBeLessThanOrEqual(4)
    expect(app.fetches.length).toBeGreaterThan(0)
  })

  it('does not fetch at all with no bank linked', async () => {
    app.connected = false
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(0)
    expect(health()).toBe('unknown')
  })
})

describe('a first link', () => {
  it('reads the whole history in order, once, and files every row', async () => {
    const days = [3, 60, 100, 150, 190, 240, 280, 340]
    app.feed = [card(days.map((d) => row(`t${d}`, d)))]
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(8)
    expect(app.fetches.map((f) => f.startDate)).toEqual([...app.fetches.map((f) => f.startDate)].sort((a, b) => b - a))
    expect((await live()).map((t) => t.uid).sort()).toEqual(days.map((d) => `sf:bank.test:c1:t${d}`).sort())
    app.fetches = []
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(1)
  })

  it('stops at the first empty window, which is as far back as the bank goes', async () => {
    app.feed = [card([row('t1', 3), row('t2', 60)])]
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(3)
    app.fetches = []
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(1)
  })

  it('takes balances from the newest window and stores one row per id', async () => {
    const twin = row('t2', 50)
    app.feed = [card([row('t1', 3), twin])]
    let n = 0
    // The same id in two answers: a bank that repeats a row across a boundary.
    app.fail = () => {
      n++
      if (n !== 2) return null
      const stale = card([twin, row('t1', 3)], '-999.99')
      return { status: 200, body: JSON.stringify({ accounts: [stale] }) }
    }
    await syncAllConnectors({ force: true })
    const [a] = await db.accounts.toArray()
    expect(a.balance).toBeCloseTo(310.4)
    expect(await live()).toHaveLength(2)
  })

  it('keeps what arrived when a later window fails, and asks again next time', async () => {
    app.feed = [card([row('t1', 3), row('t2', 60), row('t3', 100)])]
    app.fail = (n) => (n === 1 ? new Error('network') : null)
    const res = await syncAllConnectors({ force: true })
    expect(res.errors).toEqual([])
    expect((await live()).map((t) => t.uid)).toEqual(['sf:bank.test:c1:t1'])
    app.fail = null
    app.fetches = []
    await syncAllConnectors({ force: true })
    expect(app.fetches.length).toBeGreaterThan(1)
    expect(await live()).toHaveLength(3)
  })

  it('reads the new link’s history even if the old link’s pull lands after the claim', async () => {
    app.feed = [card([row('t1', 3), row('t2', 60)])]
    await settle()
    forgetBankCoverage()
    let release = () => {}
    const held = new Promise<void>((r) => { release = r })
    const real = window.webkit.messageHandlers.plainsum
    vi.stubGlobal('webkit', {
      messageHandlers: {
        plainsum: { postMessage: async (m: Parameters<typeof postMessage>[0]) => {
          if (m.method === 'simplefin.fetch') await held
          return real.postMessage(m)
        } },
      },
    })
    const old = bankInvoke('sync')
    await bankInvoke('claim', { setupToken: 'c2V0dXA=' })
    release()
    await old
    app.fetches = []
    vi.stubGlobal('webkit', { messageHandlers: { plainsum: real } })
    await syncAllConnectors({ force: true })
    expect(app.fetches.length).toBeGreaterThan(1)
  })

  it('starts over on a new link', async () => {
    app.feed = [card([row('t1', 3), row('t2', 60)])]
    await settle()
    await connectBank('  c2V0dXA=  ')
    expect(app.claims).toEqual(['c2V0dXA='])
    expect(app.fetches.length).toBeGreaterThan(1)
  })
})

describe('after a long time away', () => {
  it('looks past a quiet stretch inside the days the app was closed', async () => {
    app.feed = [card([row('t1', 3)])]
    await settle()
    vi.setSystemTime(NOW + 100 * DAY * 1000)
    app.feed = [card([row('t1', 3), { ...row('t2', 0), posted: NOW_S + 5 * DAY }, { ...row('t3', 0), posted: NOW_S + 99 * DAY }])]
    await syncAllConnectors({ force: true })
    expect(await live()).toHaveLength(3)
  })

  it('fetches the days the app was closed, and adds them once', async () => {
    app.feed = [card([row('t1', 3)])]
    await settle()
    vi.setSystemTime(NOW + 100 * DAY * 1000)
    const fresh = (id: string, daysBeforeNow: number) => ({ ...row(id, 0), posted: NOW_S + 100 * DAY - daysBeforeNow * DAY })
    app.feed = [card([row('t1', 3), fresh('t2', 95), fresh('t3', 50), fresh('t4', 1)])]
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(3)
    expect((await live()).map((t) => t.uid).sort()).toEqual(['sf:bank.test:c1:t1', 'sf:bank.test:c1:t2', 'sf:bank.test:c1:t3', 'sf:bank.test:c1:t4'])
  })
})

describe('rows the window no longer reaches', () => {
  it('leaves them alone: an older row is never read as gone', async () => {
    app.feed = [card([row('t1', 3), row('t2', 80), row('t3', 120), row('t4', 150), row('t5', 200)])]
    await settle()
    expect(await live()).toHaveLength(5)
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(1)
    expect(await live()).toHaveLength(5)
  })

  it('still retires a row inside the window that the bank dropped', async () => {
    app.feed = [card([row('t1', 3), row('t2', 10), row('t3', 20)])]
    await settle()
    app.feed = [card([row('t1', 3), row('t3', 20)])]
    await syncAllConnectors({ force: true })
    expect((await live()).map((t) => t.uid).sort()).toEqual(['sf:bank.test:c1:t1', 'sf:bank.test:c1:t3'])
  })
})

describe('the moving edge of the window', () => {
  const uids = async () => (await live()).map((t) => t.uid).sort()
  const uid = (id: string) => `sf:bank.test:c1:${id}`
  /** Three rows at different hours on each of the `days` after NOW, as a real feed has them. */
  const threeADay = (days: number) =>
    Array.from({ length: days }, (_, d) => [0.25, 0.5, 0.75].map((part, i) => row(`d${d}-${i}`, -d - part))).flat()

  it('keeps a row from before the start time on the day the window starts', async () => {
    // The window opens at noon: one row of that day is inside it, one is not.
    app.feed = [card([row('morning', WINDOW_DAYS + 0.25), row('evening', WINDOW_DAYS - 0.25), row('t1', 3)])]
    await settle()
    expect(await uids()).toHaveLength(3)
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(1)
    expect(await uids()).toEqual([uid('evening'), uid('morning'), uid('t1')])
  })

  it('keeps an older row when a row’s purchase date reaches back past the window', async () => {
    const late = { ...row('late', WINDOW_DAYS - 0.5), transacted_at: ago(WINDOW_DAYS + 3) }
    app.feed = [card([late, row('older', WINDOW_DAYS + 1), row('t1', 3)])]
    await settle()
    await syncAllConnectors({ force: true })
    expect(await uids()).toEqual([uid('late'), uid('older'), uid('t1')])
  })

  it('keeps a row whose bank date sits before its purchase date, just outside the window', async () => {
    const odd = { ...row('odd', WINDOW_DAYS + 2), transacted_at: ago(WINDOW_DAYS - 2) }
    app.feed = [card([odd, row('near', WINDOW_DAYS - 0.5), row('t1', 3)])]
    await settle()
    await syncAllConnectors({ force: true })
    expect(await uids()).toEqual([uid('near'), uid('odd'), uid('t1')])
  })

  it('loses no row over two months of pulls, three rows a day', async () => {
    const days = 60
    const history = Array.from({ length: 50 }, (_, d) => [0.25, 0.5, 0.75].map((part, i) => row(`h${d}-${i}`, d + 1 + part))).flat()
    app.feed = [card(history)]
    await syncAllConnectors({ force: true })
    const start = (await live()).length
    expect(start).toBe(history.length)
    for (let d = 1; d <= days; d++) {
      vi.setSystemTime(NOW + d * DAY * 1000)
      app.feed = [card([...history, ...threeADay(d)])]
      await syncAllConnectors({ force: true })
      expect((await live()).length, `after day ${d}`).toBe(start + d * 3)
    }
  })

  it('files a row the same however far the window has moved past it', async () => {
    app.feed = [card([row('t1', 3, '-40.00')])]
    await settle()
    const before = (await live()).map((t) => [t.uid, t.date, t.amount])
    vi.setSystemTime(NOW + (WINDOW_DAYS - 2) * DAY * 1000)
    await syncAllConnectors({ force: true })
    vi.setSystemTime(NOW + (WINDOW_DAYS + 20) * DAY * 1000)
    await syncAllConnectors({ force: true })
    expect((await live()).map((t) => [t.uid, t.date, t.amount])).toEqual(before)
  })

  it('leaves a row the bank dropped near the edge, the safe way to be wrong', async () => {
    app.feed = [card([row('t1', 3), row('t2', WINDOW_DAYS - 4)])]
    await settle()
    app.feed = [card([row('t1', 3)])]
    await syncAllConnectors({ force: true })
    expect(await uids()).toEqual([uid('t1'), uid('t2')])
  })

  it('still retires a hold the bank dropped, however old', async () => {
    const hold = { ...row('hold', WINDOW_DAYS - 4), pending: true }
    app.feed = [card([hold, row('old', WINDOW_DAYS - 1), row('t1', 3)])]
    await settle()
    app.feed = [card([row('old', WINDOW_DAYS - 1), row('t1', 3)])]
    await syncAllConnectors({ force: true })
    expect(await uids()).toEqual([uid('old'), uid('t1')])
  })

  it('reconciles back to the oldest window that answered, and no further', async () => {
    app.feed = [card([row('t1', 3), row('t2', 60), row('t3', 100)])]
    await settle()
    const reply = (await bankInvoke<{ reconcileFrom: number }>('transactions'))
    expect(reply.reconcileFrom).toBeGreaterThan(ago(WINDOW_DAYS) + DAY)
    expect(reply.reconcileFrom).toBeLessThanOrEqual(ago(WINDOW_DAYS) + 10 * DAY)
  })

  it('reconciles no further than an answer with problems, whatever came after it', async () => {
    const other: SimplefinAccount = { id: 'c2', name: 'Travel Visa', balance: '-88.10', org: ORG, transactions: [3, 60, 100, 150].map((d) => row(`o${d}`, d)) }
    const full = card([row('t1', 3), row('t2', 60), row('t3', 100), row('t4', 150)])
    app.feed = [full, other]
    // A first read cut short, so the next one covers rows already stored.
    app.fail = (n) => (n === 3 ? new Error('network') : null)
    await syncAllConnectors({ force: true })
    expect(await uids()).toHaveLength(6)
    // One window comes back with this card's connection down. The windows either
    // side of it have the card's rows, so it reads as answering across the gap.
    app.fetches = []
    const down = { ...other, transactions: [row('o60', 60)] }
    app.fail = (n) => (n === 1 ? { status: 200, body: JSON.stringify({ errors: ['Connection may need attention'], accounts: [{ ...full, transactions: [] }, down] }) } : null)
    await syncAllConnectors({ force: true })
    expect(app.fetches.length).toBeGreaterThan(2)
    expect(await uids()).toContain(uid('t2'))
    expect(await uids()).toHaveLength(8)
  })

  it('treats an older window it cannot read as not read', async () => {
    app.feed = [card([row('t1', 3), row('t2', 60), row('t3', 100), row('t4', 150)])]
    app.fail = (n) => (n === 3 ? new Error('network') : null)
    await syncAllConnectors({ force: true })
    expect(await uids()).toHaveLength(3)
    app.fetches = []
    app.fail = (n) => (n === 1 ? { status: 200, body: '<html>maintenance</html>' } : null)
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(2)
    expect(await uids()).toHaveLength(3)
    app.fail = null
    app.fetches = []
    await syncAllConnectors({ force: true })
    expect(await uids()).toHaveLength(4)
  })

  it('asks again for an older window it could not read, even with a line standing', async () => {
    app.feed = [card([row('t1', 3)])]
    await settle()
    app.errors = ['Connection may need attention']
    vi.setSystemTime(NOW + 100 * DAY * 1000)
    app.feed = [card([row('t1', 3), { ...row('t2', 0), posted: NOW_S + 40 * DAY }])]
    app.fail = (n) => (n === 1 ? { status: 200, body: '<html>maintenance</html>' } : null)
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(2)
    expect(await uids()).toEqual([uid('t1')])
    app.fail = null
    app.fetches = []
    vi.setSystemTime(NOW + 101 * DAY * 1000)
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(3)
    expect(await uids()).toEqual([uid('t1'), uid('t2')])
  })
})

describe('a transfer at the edge of the feed', () => {
  const checking = (rows: SimplefinTransaction[]): SimplefinAccount => ({ id: 'k1', name: 'Everyday Checking', balance: '2400.00', org: ORG, transactions: rows })
  const savings = (rows: SimplefinTransaction[]): SimplefinAccount => ({ id: 's1', name: 'Online Savings', balance: '9000.00', org: ORG, transactions: rows })
  /** Money no rule can name, so the first days of the feed hold it back. */
  const unnamed = (id: string, posted: number, extra: Partial<SimplefinTransaction> = {}): SimplefinTransaction => ({
    id, posted, amount: '410.00', description: 'LINDEN HOLLOW LLC', payee: 'LINDEN HOLLOW LLC', ...extra,
  })
  /** A pull every day from NOW, the feed being all that has posted by then. */
  const pullDaily = async (days: number, feed: (now: number) => SimplefinAccount[]) => {
    for (let day = 0; day <= days; day++) {
      const now = NOW_S + day * DAY
      vi.setSystemTime(now * 1000)
      app.feed = feed(now)
      await syncAllConnectors({ force: true })
    }
  }

  // A purchase date from before the window pulls the oldest row back, so the leg left
  // behind when its partner slides off used to read as income, and stayed.
  it.each([
    [4, 3],
    [5, 3],
    [2, 5],
    [3, 5],
  ])('stores no income, with purchase dates %i days early and legs %i days apart', { timeout: 30_000 }, async (early, apart) => {
    const spending: SimplefinTransaction[] = []
    for (let d = -80; d <= 340; d++) {
      const posted = ago(d) - DAY / 3
      spending.push({ ...row(`c${d}`, 0), posted, amount: '-3.25', transacted_at: posted - early * DAY })
    }
    const out: SimplefinTransaction[] = []
    const into: SimplefinTransaction[] = []
    for (const [i, d] of [20, 25, 30].entries()) {
      out.push({ id: `t${i}`, posted: ago(d), amount: `-${500 + i}.00`, description: 'ONLINE TRANSFER TO SAVINGS', payee: '' })
      into.push({ id: `d${i}`, posted: ago(d) + apart * DAY, amount: `${500 + i}.00`, description: 'DEPOSIT', payee: '' })
    }
    const by = (now: number, rows: SimplefinTransaction[]) => rows.filter((t) => Number(t.posted) <= now)
    await pullDaily(60, (now) => [checking([...by(now, spending), ...by(now, out)]), savings(by(now, into))])
    expect((await live()).filter((t) => t.type === 'income')).toEqual([])
  })

  it('keeps a first read of the history with a line standing', async () => {
    app.errors = ['Connection to Other Bank may need attention']
    app.feed = [checking(Array.from({ length: 16 }, (_, i) => unnamed(`p${i}`, ago(10 + i * 20))))]
    await syncAllConnectors({ force: true })
    // All but the oldest, which is the feed's own first days.
    expect(await live()).toHaveLength(15)
  })

  it('says how far in from the oldest window it read, whatever that window answered', async () => {
    app.errors = ['Connection to Other Bank may need attention']
    app.feed = [checking(Array.from({ length: 9 }, (_, i) => unnamed(`p${i}`, ago(10 + i * 40))))]
    const reply = await bankInvoke<{ reconcileFrom: number; edgeTo: number }>('transactions')
    expect(reply.reconcileFrom).toBe(ago(WINDOW_DAYS - 8))
    expect(reply.edgeTo).toBe(ago(8 * WINDOW_DAYS - 8))
  })

  // Time away that ends just inside a window is the worst case: the first new row
  // sits nearest the edge. A row held on its only pull is lost.
  it.each([0, 3, 7])('loses no new row after any time away, purchase dates %i days early', { timeout: 30_000 }, async (early) => {
    const history = Array.from({ length: 330 }, (_, d) => ({ ...row(`h${d}`, d + 1), amount: '-3.25' }))
    for (const away of [21, 22, 23, 30, 34, 37, 38, 65, 66, 67, 74, 81, 82]) {
      localStorage.clear()
      clearBankState()
      await db.accounts.clear()
      await db.transactions.clear()
      vi.setSystemTime(NOW)
      app.feed = [checking(history)]
      await syncAllConnectors({ force: true })
      const fresh: SimplefinTransaction[] = []
      for (let at = NOW_S + DAY / 4; at < NOW_S + away * DAY; at += DAY / 4) {
        fresh.push(unnamed(`n${at}`, at, early ? { transacted_at: at - early * DAY } : {}))
      }
      vi.setSystemTime(NOW + away * DAY * 1000)
      app.feed = [checking([...history, ...fresh])]
      await syncAllConnectors({ force: true })
      const uids = new Set((await live()).map((t) => t.uid))
      expect(fresh.filter((t) => !uids.has(`sf:bank.test:k1:${t.id}`)).map((t) => t.id), `after ${away} days away`).toEqual([])
    }
  })
})

describe('any run of pulls', () => {
  /** Seeded, so a failure repeats. */
  const randomFrom = (seed: number) => () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }

  // Uneven days, long absences, one card's connection coming and going, rows landing
  // late and purchase dates a week before the bank's, and money between two bank
  // accounts. The bank never drops a row here, so a row that goes missing is one the
  // app lost, and a transfer left in the ledger is income that never was.
  it.each([1, 2, 3])('loses nothing, and holds everything once all is well (seed %i)', { timeout: 30_000 }, async (seed) => {
    const random = randomFrom(seed)
    const between = (low: number, high: number) => low + random() * (high - low)
    const spanDays = 420
    const start = NOW_S - 300 * DAY
    const rows = Array.from({ length: spanDays }, (_, i) => {
      const posted = Math.floor(start + between(0, spanDays) * DAY)
      const lag = random() < 0.4 ? between(0, 7) * DAY : 0
      return {
        account: i % 2 ? 'c2' : 'c1',
        landsAt: posted + between(0, 2) * DAY,
        tx: { ...row(`r${i}`, 0), posted, ...(lag ? { transacted_at: Math.floor(posted - lag) } : {}) },
      }
    })
    // Rows no rule can name, which the first days of the feed hold back.
    for (let i = 0; i < 140; i++) {
      const posted = Math.floor(start + between(0, spanDays) * DAY)
      const lag = random() < 0.4 ? between(0, 7) * DAY : 0
      rows.push({
        account: 'k1',
        landsAt: posted + between(0, 2) * DAY,
        tx: { id: `u${i}`, posted, amount: '410.00', description: 'LINDEN HOLLOW LLC', payee: 'LINDEN HOLLOW LLC', ...(lag ? { transacted_at: Math.floor(posted - lag) } : {}) },
      })
    }
    const legs = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const posted = Math.floor(start + between(0, spanDays - 6) * DAY)
      const into = Math.floor(posted + between(0, 5) * DAY)
      const cents = `${300 + i}.17`
      legs.add(`sf:bank.test:k1:out${i}`).add(`sf:bank.test:s1:in${i}`)
      rows.push({ account: 'k1', landsAt: posted, tx: { id: `out${i}`, posted, amount: `-${cents}`, description: 'ONLINE TRANSFER TO SAVINGS', payee: '' } })
      rows.push({ account: 's1', landsAt: into, tx: { id: `in${i}`, posted: into, amount: cents, description: 'DEPOSIT', payee: '' } })
    }
    const feedAt = (at: number, down: boolean) => {
      const of = (id: string) => rows.filter((r) => r.account === id && r.landsAt <= at).map((r) => r.tx)
      return [
        { id: 'c1', name: 'Rewards Visa', balance: '-310.40', org: ORG, transactions: of('c1') },
        { id: 'c2', name: 'Travel Visa', balance: '-88.10', org: ORG, transactions: down ? [] : of('c2') },
        { id: 'k1', name: 'Everyday Checking', balance: '2400.00', org: ORG, transactions: of('k1') },
        { id: 's1', name: 'Online Savings', balance: '9000.00', org: ORG, transactions: of('s1') },
      ]
    }

    let at = NOW_S
    let down = random() < 0.5
    const liveUids = async () => new Set((await live()).map((t) => t.uid))
    let held = new Set<string | undefined>()
    for (let pull = 0; pull < 60; pull++) {
      vi.setSystemTime(at * 1000)
      app.feed = feedAt(at, down)
      app.errors = down ? ['Connection to Northgate Bank may need attention'] : []
      await syncAllConnectors({ force: true })
      const now = await liveUids()
      expect([...held].filter((u) => !now.has(u)), `lost at pull ${pull}`).toEqual([])
      held = now
      at += random() < 0.08 ? between(10, 60) * DAY : between(0.3, 3) * DAY
      if (random() < 0.1) down = !down
    }
    vi.setSystemTime(at * 1000)
    app.feed = feedAt(at, false)
    app.errors = []
    await syncAllConnectors({ force: true })
    const end = await liveUids()
    const window = at - HISTORY_REACH
    const uidOf = (r: (typeof rows)[number]) => `sf:bank.test:${r.account}:${r.tx.id}`
    const missing = rows.filter((r) => r.landsAt <= at && r.tx.posted >= window && !legs.has(uidOf(r)) && !end.has(uidOf(r)))
    expect(missing.map((r) => r.tx.id)).toEqual([])
    expect([...legs].filter((uid) => end.has(uid))).toEqual([])
  })
})

describe('what SimpleFIN says back', () => {
  it('shows its own lines under Needs attention, once, and archives nothing', async () => {
    app.feed = [card([row('t1', 3)]), { id: 's1', name: 'Basic Savings', balance: '100.00', org: ORG }]
    await settle()
    app.feed = [card([row('t1', 3)])]
    app.errors = ['Connection to Northgate Bank may need attention']
    const res = await syncAllConnectors({ force: true })
    expect(warnings()).toEqual(['Connection to Northgate Bank may need attention'])
    expect(res.warnings).toEqual(['Connection to Northgate Bank may need attention'])
    expect((await db.accounts.toArray()).filter((a) => !a.archived)).toHaveLength(2)
  })

  it('does not count a pull with problems as covered, so the days are read once it is back', async () => {
    app.feed = [card([row('t1', 3)])]
    await settle()
    app.errors = ['Connection to Northgate Bank may need attention']
    vi.setSystemTime(NOW + 40 * DAY * 1000)
    await syncAllConnectors({ force: true })
    app.errors = []
    app.fetches = []
    vi.setSystemTime(NOW + 41 * DAY * 1000)
    await syncAllConnectors({ force: true })
    expect(app.fetches).toHaveLength(2)
  })

  describe('a line that stands', () => {
    const yearOfRows = () => [card([3, 60, 100, 150, 190, 240, 280, 340].map((d) => row(`t${d}`, d)))]
    const line = 'Connection to Northgate Bank may need attention'
    /** Requests for each of `pulls` automatic pulls, six hours apart, from `from`. */
    const pullsOf = async (pulls: number, from = NOW) => {
      const counts: number[] = []
      for (let i = 1; i <= pulls; i++) {
        vi.setSystemTime(from + i * 6.5 * 3600 * 1000)
        app.fetches = []
        await syncAllConnectors()
        counts.push(app.fetches.length)
      }
      return counts
    }

    it('reads the history once and then costs one request a pull, from a first link on', async () => {
      app.feed = yearOfRows()
      app.errors = [line]
      await syncAllConnectors({ force: true })
      expect(app.fetches).toHaveLength(8)
      expect(await live()).toHaveLength(8)
      expect(await pullsOf(8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    })

    it('costs one request a pull when it starts after a clean link', async () => {
      app.feed = yearOfRows()
      await settle()
      app.errors = [line]
      expect(await pullsOf(4)).toEqual([1, 1, 1, 1])
    })

    it('costs the same through a long stretch, and keeps reading the connections that work', async () => {
      app.feed = yearOfRows()
      await settle()
      app.errors = [line]
      const rows = [...yearOfRows()[0].transactions!]
      for (let d = 10; d <= 100; d += 10) {
        vi.setSystemTime(NOW + d * DAY * 1000)
        rows.push({ ...row(`n${d}`, 0), posted: NOW_S + d * DAY })
        app.feed = [card(rows)]
        app.fetches = []
        await syncAllConnectors({ force: true })
        expect(app.fetches, `day ${d}`).toHaveLength(1)
      }
      expect((await live()).filter((t) => t.uid?.includes(':n'))).toHaveLength(10)
    })

    it('reads the days a long absence missed, once, even with the line standing', async () => {
      app.feed = yearOfRows()
      await settle()
      app.errors = [line]
      vi.setSystemTime(NOW + 100 * DAY * 1000)
      app.feed = [card([...yearOfRows()[0].transactions!, { ...row('n1', 0), posted: NOW_S + 5 * DAY }])]
      await syncAllConnectors({ force: true })
      expect(app.fetches).toHaveLength(3)
      expect((await live()).some((t) => t.uid?.endsWith(':n1'))).toBe(true)
      app.fetches = []
      vi.setSystemTime(NOW + 101 * DAY * 1000)
      await syncAllConnectors({ force: true })
      expect(app.fetches).toHaveLength(1)
    })

    it('reads a first link’s full history once the connection is back, then settles', async () => {
      // The down connection's rows were not in the first read.
      app.feed = [card([row('t3', 3)])]
      app.errors = [line]
      await syncAllConnectors({ force: true })
      expect(await pullsOf(2)).toEqual([1, 1])
      app.feed = yearOfRows()
      app.errors = []
      app.fetches = []
      vi.setSystemTime(NOW + DAY * 1000)
      await syncAllConnectors({ force: true })
      expect(app.fetches).toHaveLength(8)
      expect(await live()).toHaveLength(8)
      app.fetches = []
      await syncAllConnectors({ force: true })
      expect(app.fetches).toHaveLength(1)
    })

    it('stops the catch-up at the first answer with a problem', async () => {
      app.feed = yearOfRows()
      app.errors = [line]
      await syncAllConnectors({ force: true })
      app.errors = []
      app.fetches = []
      const withLine = (n: number) => (n === 1 ? { status: 200, body: JSON.stringify({ errors: [line], accounts: app.feed }) } : null)
      app.fail = withLine
      vi.setSystemTime(NOW + 7 * 3600 * 1000)
      await syncAllConnectors({ force: true })
      expect(app.fetches).toHaveLength(2)
    })

    it('reads the history of a new link, line or no line', async () => {
      app.feed = yearOfRows()
      await settle()
      forgetBankCoverage()
      app.errors = [line]
      await syncAllConnectors({ force: true })
      expect(app.fetches).toHaveLength(8)
    })

    it('reads a link left by an earlier build as covered, not as new', async () => {
      app.feed = yearOfRows()
      await settle()
      localStorage.removeItem('plainsum:bankReadTo')
      await syncAllConnectors({ force: true })
      expect(app.fetches).toHaveLength(1)
    })
  })

  it('raises the reconnect banner on a 403, and spends the floor', async () => {
    app.feed = [card([row('t1', 3)])]
    await settle()
    app.fail = () => ({ status: 403 })
    vi.setSystemTime(NOW + 7 * 3600 * 1000)
    expect(bankFetchDue()).toBe(true)
    const res = await syncAllConnectors()
    expect(health()).toBe('expired')
    expect(res.errors).toEqual(['Your bank connection needs a new setup token.'])
    expect(bankFetchDue()).toBe(false)
  })

  it('spends the floor on the app’s own 429, and says so calmly', async () => {
    app.fail = () => ({ status: 429 })
    const res = await syncAllConnectors()
    expect(res.errors).toEqual(['Bank refresh is paused for today. It will run again tomorrow.'])
    expect(health()).toBe('unknown')
    expect(bankFetchDue()).toBe(false)
  })

  it('does not spend the floor on a failure that never reached SimpleFIN', async () => {
    app.fail = () => new Error('network')
    const res = await syncAllConnectors()
    expect(res.errors).toEqual(['No connection. Try again when you are online.'])
    expect(bankFetchDue()).toBe(true)
  })

  it('changes nothing on an answer it cannot read', async () => {
    app.feed = [card([row('t1', 3)])]
    await settle()
    app.fail = () => ({ status: 200, body: '<html>maintenance</html>' })
    await syncAllConnectors({ force: true })
    expect((await db.accounts.toArray()).filter((a) => !a.archived)).toHaveLength(1)
    expect(await live()).toHaveLength(1)
    app.fail = null
    app.fetches = []
    vi.setSystemTime(NOW + 50 * DAY * 1000)
    await syncAllConnectors({ force: true })
    expect(app.fetches.length).toBeGreaterThan(1)
  })
})

describe('with no stored link', () => {
  it('asks for a new token when live accounts are left without one', async () => {
    await db.accounts.add({ name: 'Rewards Visa', institution: 'Northgate Bank', type: 'credit', balance: 10, liveSync: true, source: 'simplefin', sourceAccountId: 'bank.test:c1', lastUpdated: 0, sortOrder: 0, updatedAt: 0 })
    app.connected = false
    expect(await bankReady()).toBe(true)
    const res = await syncAllConnectors()
    expect(app.fetches).toHaveLength(0)
    expect(health()).toBe('expired')
    expect(res.errors).toEqual(['Your bank connection needs a new setup token.'])
  })

  it('is quiet with nothing linked, and treats a hand-kept account as nothing', async () => {
    await db.accounts.add({ name: 'Cash', institution: 'Wallet', type: 'cash', balance: 10, liveSync: false, lastUpdated: 0, sortOrder: 0, updatedAt: 0 })
    app.connected = false
    expect(await bankReady()).toBe(false)
    await expect(bankInvoke('sync')).rejects.toThrow('not connected')
    expect((await syncAllConnectors()).errors).toEqual([])
    expect(health()).toBe('unknown')
  })

  it('does nothing in a browser, with no app around the page', async () => {
    vi.stubGlobal('webkit', undefined)
    expect(await bankReady()).toBe(false)
    expect(await bankStatus()).toBe(false)
    expect((await syncAllConnectors({ force: true })).errors).toEqual([])
    await expect(connectBank('c2V0dXA=')).rejects.toThrow('no_bridge')
  })
})

describe('the words', () => {
  it.each([
    ['simplefin /accounts -> 401', 'Your bank connection needs a new setup token.'],
    ['simplefin /accounts -> 403', 'Your bank connection needs a new setup token.'],
    ['simplefin /accounts -> 402', 'SimpleFIN says your subscription needs attention.'],
    ['simplefin /accounts -> 429', 'Bank refresh is paused for today. It will run again tomorrow.'],
    ['simplefin /accounts -> 500', 'SimpleFIN did not answer. Try again later.'],
    ['network', 'No connection. Try again when you are online.'],
    ['unavailable', 'Could not refresh. Try again.'],
    ['Could not refresh. Try again.', 'Could not refresh. Try again.'],
  ])('shows %s as a sentence', (raw, shown) => {
    expect(bankErrorCopy(raw)).toBe(shown)
  })

  it('says why a token was refused, and what to do', () => {
    expect(bankClaimCopy('not_simplefin')).toBe('This token is not from SimpleFIN, so it was not used.')
    expect(bankClaimCopy('claim_refused')).toMatch(/already used/)
    expect(bankClaimCopy('bad_token')).toMatch(/setup token/)
    expect(bankClaimCopy('network')).toMatch(/online/)
    expect(bankClaimCopy('anything else')).toBeNull()
  })

  it('forgets coverage on request', async () => {
    app.feed = [card([row('t1', 3), row('t2', 60)])]
    await settle()
    forgetBankCoverage()
    await syncAllConnectors({ force: true })
    expect(app.fetches.length).toBeGreaterThan(1)
  })
})

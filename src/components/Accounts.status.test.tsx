// @vitest-environment jsdom
/**
 * B63: the status text on Accounts follows what happened since, instead of
 * freezing at the moment it was written. Values are invented.
 *
 *  - A failed refresh's red error goes once any later connector sync succeeds
 *    (the app's own focus or interval sync included).
 *  - 'Bank data updated … · again in N min' counts down from timestamps and
 *    drops the 'again in' part once a forced refresh is allowed again.
 *  - A connect note ('Finish linking…') goes on the next successful sync, and
 *    notes go when the screen is left.
 *
 * Accounts keeps the last forced refresh and the last auto refresh in memory
 * for the session (module state), so each test loads fresh modules, as a new
 * session: a forced refresh in a test that ran earlier (--sequence.shuffle)
 * never moves this one's 30-minute floor.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

type Row = Record<string, unknown>
type Reply = { data: unknown; error: unknown }

const h = vi.hoisted(() => {
  const state = { replies: {} as Record<string, () => Reply> }
  const page = () => {
    let after: string | null = null
    type Res = { data: Row[]; error: null }
    const q: PromiseLike<Res> & { order: () => typeof q; limit: () => typeof q; gt: (c: string, v: string) => typeof q } = {
      order: () => q,
      limit: () => q,
      gt: (_c, v) => ((after = v), q),
      then: (ok, bad) => Promise.resolve({ data: after == null ? [] : [], error: null }).then(ok, bad),
    }
    return q
  }
  const supabase = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'owner@example.com' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: () => ({ select: () => page(), upsert: async () => ({ error: null }) }),
    functions: {
      invoke: async (fn: string, opts: { body: { action: string } }) => {
        const r = state.replies[`${fn}:${opts.body.action}`]
        if (r) return r()
        if (fn === 'simplefin' && opts.body.action === 'transactions') return { data: { ok: true, transactions: [] }, error: null }
        return { data: { ok: true, accounts: [] }, error: null }
      },
    },
  }
  const offline = (): Reply => ({
    data: null,
    error: Object.assign(new Error('Failed to send a request to the Edge Function'), { name: 'FunctionsFetchError', context: new TypeError('Failed to fetch') }),
  })
  return { state, supabase, offline }
})

vi.mock('../db/supabase', () => ({ supabase: h.supabase }))
vi.mock('../sync/merchantRules', () => ({ loadMerchantRules: vi.fn(async () => true) }))

let Accounts: typeof import('./Accounts').Accounts
let syncAllConnectors: typeof import('../lib/banks').syncAllConnectors
let db: typeof import('../db/db').db

const OFFLINE = 'Could not reach the server. Check your connection and try again.'
const MIN = 60_000
let shift = 0
const realNow = Date.now.bind(Date)

const pill = () => document.querySelector('.nw-status') as HTMLButtonElement
const refreshRow = () => screen.getByText('Refresh balances').closest('button') as HTMLButtonElement
const refreshSub = () => refreshRow().querySelector('.acct-sub')?.textContent
const offlineEverywhere = () => {
  for (const k of ['snaptrade:sync', 'simplefin:sync', 'simplefin:transactions']) h.state.replies[k] = h.offline
}

beforeEach(async () => {
  vi.resetModules()
  ;({ Accounts } = await import('./Accounts'))
  ;({ syncAllConnectors } = await import('../lib/banks'))
  ;({ db } = await import('../db/db'))
  shift = 0
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + shift)
  h.state.replies = {}
  localStorage.clear()
  await db.accounts.clear()
  await db.accounts.add({ institution: 'Test Bank', name: 'Checking', type: 'cash', balance: 1000, liveSync: false, lastUpdated: Date.now(), sortOrder: 0, updatedAt: 1 })
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  // Let the screen's own auto refresh settle before the next case.
  await act(() => syncAllConnectors().then(() => {}))
})

describe('B63: Accounts status text', () => {
  it("a failed refresh's error goes once a later sync succeeds", async () => {
    offlineEverywhere()
    render(<Accounts active />)
    await waitFor(() => expect(pill()).toBeTruthy())
    await act(() => syncAllConnectors().then(() => {}))
    await act(async () => {
      fireEvent.click(pill())
    })
    await waitFor(() => expect(pill().textContent).toBe(OFFLINE))
    expect(pill().className).toContain('is-err')
    // Back online: the app's focus sync (not this screen) succeeds.
    h.state.replies = {}
    await act(() => syncAllConnectors().then(() => {}))
    await waitFor(() => expect(pill().className).not.toContain('is-err'))
    expect(pill().textContent).not.toBe(OFFLINE)
  })

  it("'again in N min' counts down, then goes", async () => {
    const onSynced = vi.fn()
    // A forced refresh 25 minutes ago: this tap is inside the 30-minute floor.
    localStorage.setItem('tally-forced-bank-at', String(Date.now() - 25 * MIN))
    render(<Accounts active onSynced={onSynced} />)
    await act(() => syncAllConnectors().then(() => {}))
    await act(async () => {
      fireEvent.click(refreshRow())
    })
    await waitFor(() => expect(onSynced).toHaveBeenCalled())
    await waitFor(() => expect(refreshSub()).toBe('Bank data updated just now · again in 5 min'))
    shift = 2 * MIN
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(refreshSub()).toBe('Bank data updated 2m ago · again in 3 min'))
    shift = 6 * MIN
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(refreshSub()).toBe('Bank data updated 6m ago'))
  })

  it("a refresh row error goes once a later sync succeeds", async () => {
    offlineEverywhere()
    render(<Accounts active />)
    await act(() => syncAllConnectors().then(() => {}))
    await act(async () => {
      fireEvent.click(refreshRow())
    })
    await waitFor(() => expect(refreshSub()).toBe(OFFLINE))
    h.state.replies = {}
    await act(() => syncAllConnectors().then(() => {}))
    await waitFor(() => expect(refreshSub()).not.toBe(OFFLINE))
  })

  it("'Finish linking…' goes on the next successful sync, and a note goes when the screen is left", async () => {
    vi.stubGlobal('open', vi.fn(() => ({ location: { href: '' }, close() {} })))
    h.state.replies['snaptrade:connect'] = () => ({ data: { ok: true, redirectURI: 'https://example.test/portal' }, error: null })
    const view = render(<Accounts active />)
    await act(() => syncAllConnectors().then(() => {}))
    const connect = () => screen.getByText('Connect a brokerage').closest('button') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(connect())
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Finish linking/))
    await act(() => syncAllConnectors().then(() => {}))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())

    // An error note stays while the screen is up, and goes when it is left.
    vi.stubGlobal('open', vi.fn(() => null))
    await act(async () => {
      fireEvent.click(connect())
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Allow pop-ups/))
    view.rerender(<Accounts active={false} />)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    vi.unstubAllGlobals()
  })
})

/**
 * B116: the brokerage window must not keep a link back to Tally. With
 * `window.opener` set, the portal (or any page it passes through) could send
 * the Tally tab to a look-alike page. The link is cut before the portal loads.
 */
describe('B116: the brokerage window', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A stand-in window that records the opener at the moment a URL is loaded. */
  function fakeWindow() {
    const loads: { opener: unknown; href: string }[] = []
    const win = { opener: window as unknown, close: vi.fn(), location: {} }
    Object.defineProperty(win.location, 'href', {
      get: () => '',
      set: (href: string) => loads.push({ opener: win.opener, href }),
    })
    vi.stubGlobal('open', vi.fn(() => win))
    return { win, loads }
  }

  const connect = () => screen.getByText('Connect a brokerage').closest('button') as HTMLButtonElement

  it('the opener is cut before the portal loads', async () => {
    const { win, loads } = fakeWindow()
    h.state.replies['snaptrade:connect'] = () => ({ data: { ok: true, redirectURI: 'https://portal.example.test/connect' }, error: null })
    render(<Accounts active />)
    await act(() => syncAllConnectors().then(() => {}))
    await act(async () => {
      fireEvent.click(connect())
    })
    await waitFor(() => expect(loads).toHaveLength(1))
    expect(loads[0]).toEqual({ opener: null, href: 'https://portal.example.test/connect' })
    expect(win.close).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Finish linking/))
  })

  it('a portal URL that is not https never loads, and the blank window closes', async () => {
    const { win, loads } = fakeWindow()
    h.state.replies['snaptrade:connect'] = () => ({ data: { ok: true, redirectURI: 'javascript:alert(1)' }, error: null })
    render(<Accounts active />)
    await act(() => syncAllConnectors().then(() => {}))
    await act(async () => {
      fireEvent.click(connect())
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Could not start the connection. Try again.'))
    expect(loads).toHaveLength(0)
    expect(win.close).toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
/**
 * The plan's store in Tally: one row per account, read into the cache and
 * written through the rules. The cloud here is a fake that keeps the newer row,
 * as the table's trigger does. The amounts are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const h = vi.hoisted(() => {
  const state = {
    enabled: true,
    session: { user: { id: 'user-1' } } as { user: { id: string } } | null,
    /** The account's row, as the cloud holds it. */
    row: null as Row | null,
    readError: null as unknown,
    readThrows: false,
    /** The next read waits for this before it answers with what it saw when asked. */
    holdRead: null as Promise<void> | null,
    upsertError: null as unknown,
    upsertThrows: false,
    upsertNoRow: false,
    /** Runs after an upsert was received and before it is decided, as another device's write would. */
    beforeUpsert: null as (() => void) | null,
    /** The next upsert, once decided, waits for this before its answer arrives. */
    holdUpsert: null as Promise<void> | null,
    reads: [] as { column: string; value: string }[],
    upserts: [] as { row: Row; onConflict?: string }[],
  }
  // The cloud's own text for a stamp: a zone, and microseconds.
  const cloudStamp = (iso: string) => iso.replace(/Z$/, '000+00:00')
  const answer = (row: Row | null) => {
    if (!row) return []
    // Keys of pending come back in whatever order Postgres keeps them.
    const pending = row.pending && typeof row.pending === 'object' ? Object.fromEntries(Object.entries(row.pending as Row).reverse()) : row.pending
    return [{ goal: row.goal, cap: row.cap, locked: row.locked, since: row.since, pending, past_caps: row.past_caps ?? [], updated_at: cloudStamp(String(row.updated_at)) }]
  }
  const from = vi.fn(() => ({
    select: () => ({
      eq: (column: string, value: string) => ({
        limit: async () => {
          state.reads.push({ column, value })
          const seen = state.row
          const error = state.readError
          const hold = state.holdRead
          state.holdRead = null
          if (hold) await hold
          if (state.readThrows) throw new TypeError('Failed to fetch')
          return error ? { data: null, error } : { data: answer(seen), error: null }
        },
      }),
    }),
    upsert: (row: Row, opts?: { onConflict?: string }) => ({
      select: async () => {
        state.upserts.push({ row, onConflict: opts?.onConflict })
        state.beforeUpsert?.()
        state.beforeUpsert = null
        if (state.upsertThrows) throw new TypeError('Failed to fetch')
        if (state.upsertError) return { data: null, error: state.upsertError }
        // keep_newer_row(): an update older than the stored row leaves it as it is.
        const old = state.row
        if (!old || Date.parse(String(row.updated_at)) >= Date.parse(String(old.updated_at))) state.row = row
        const data = state.upsertNoRow ? [] : answer(state.row)
        const hold = state.holdUpsert
        state.holdUpsert = null
        if (hold) await hold
        return { data, error: null }
      },
    }),
  }))
  const client = { auth: { getSession: vi.fn(async () => ({ data: { session: state.session } })) }, from }
  return { state, client, from }
})

vi.mock('../db/supabase', () => ({
  get supabase() {
    return h.state.enabled ? h.client : null
  },
}))

import { capInForce, planOn, type SavingsPlan } from './savingsPlan'

const KEY = 'tally:savingsPlan:v1'
const NOW = '2031-04-10T12:00:00'
const at = (iso: string) => new Date(iso).getTime()
const plan = (extra: Partial<SavingsPlan> = {}): SavingsPlan => ({ goal: 800, cap: 3000, locked: true, since: '2031-04', pending: null, updatedAt: at('2031-04-02T09:00:00'), ...extra })
const cloudRow = (p: SavingsPlan): Row => ({
  user_id: 'user-1', goal: p.goal, cap: p.cap, locked: p.locked, since: p.since, pending: p.pending, past_caps: p.pastCaps ?? [],
  updated_at: new Date(p.updatedAt).toISOString(),
})
const setOnline = (on: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => on })
const cached = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as SavingsPlan | null

type Cache = typeof import('./planCache')
type Store = typeof import('./planStore')
let cache: Cache
let store: Store

/** A fresh launch: the store's memory of the table and of its last read starts over. */
async function launch() {
  vi.resetModules()
  cache = await import('./planCache')
  store = await import('./planStore')
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  vi.clearAllMocks()
  localStorage.clear()
  Object.assign(h.state, {
    enabled: true, session: { user: { id: 'user-1' } }, row: null, readError: null, readThrows: false, holdRead: null,
    upsertError: null, upsertThrows: false, upsertNoRow: false, beforeUpsert: null, holdUpsert: null, reads: [], upserts: [],
  })
  setOnline(true)
  await launch()
})
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

const MISSING = [
  { code: 'PGRST205', message: "Could not find the table 'public.savings_plan' in the schema cache" },
  { code: '42P01', message: 'undefined table' },
  { message: 'relation "public.savings_plan" does not exist' },
]

describe('loadSavingsPlan', () => {
  it("asks for the session user's row and caches it", async () => {
    h.state.row = cloudRow(plan())
    await expect(store.loadSavingsPlan()).resolves.toBe(true)
    expect(h.from).toHaveBeenCalledWith('savings_plan')
    expect(h.state.reads).toEqual([{ column: 'user_id', value: 'user-1' }])
    expect(cache.getPlan()).toEqual(plan())
    expect(cached()).toEqual(plan())
  })

  it('offline asks nothing and keeps the cache', async () => {
    cache.setPlan(plan())
    setOnline(false)
    await expect(store.loadSavingsPlan()).resolves.toBe(false)
    expect(h.from).not.toHaveBeenCalled()
    expect(cache.getPlan()).toEqual(plan())
  })

  it('signed out asks nothing and keeps the cache', async () => {
    cache.setPlan(plan())
    h.state.session = null
    await expect(store.loadSavingsPlan()).resolves.toBe(false)
    expect(h.from).not.toHaveBeenCalled()
    expect(cached()).toEqual(plan())
  })

  it('with no backend it resolves true and keeps the cache', async () => {
    cache.setPlan(plan())
    h.state.enabled = false
    await expect(store.loadSavingsPlan()).resolves.toBe(true)
    expect(cached()).toEqual(plan())
  })

  it('no row means the account has no plan, and takes off no plan this device holds: no device deletes one, so it is the older answer', async () => {
    await expect(store.loadSavingsPlan()).resolves.toBe(true)
    expect(cache.getPlan()).toBeNull()
    cache.setPlan(plan())
    await expect(store.loadSavingsPlan()).resolves.toBe(true)
    expect(cache.getPlan()).toEqual(plan())
    expect(cached()).toEqual(plan())
  })

  it('a row that is not a plan keeps the cache', async () => {
    cache.setPlan(plan())
    h.state.row = { ...cloudRow(plan()), since: null }
    await expect(store.loadSavingsPlan()).resolves.toBe(false)
    expect(cache.getPlan()).toEqual(plan())
  })

  it('a row with a damaged pending change is cached locked, with nothing pending', async () => {
    h.state.row = { ...cloudRow(plan()), pending: { from: '2031-05' } }
    await expect(store.loadSavingsPlan()).resolves.toBe(true)
    expect(cache.getPlan()).toEqual(plan())
  })

  it('a failed request keeps the cache, and a thrown one is a failure, not a crash', async () => {
    cache.setPlan(plan())
    h.state.readError = { message: 'timeout' }
    await expect(store.loadSavingsPlan()).resolves.toBe(false)
    h.state.readError = null
    h.state.readThrows = true
    await expect(store.loadSavingsPlan()).resolves.toBe(false)
    expect(cache.getPlan()).toEqual(plan())
  })

  it('overlapping callers share one request', async () => {
    h.state.row = cloudRow(plan())
    const [a, b] = await Promise.all([store.loadSavingsPlan(), store.loadSavingsPlan()])
    expect([a, b]).toEqual([true, true])
    expect(h.state.reads).toHaveLength(1)
  })

  describe.each(MISSING)('with the table missing ($message)', (error) => {
    it('behaves as no plan: resolves false, leaves the cache alone, offers no setting, and waits ten minutes to ask again', async () => {
      h.state.row = cloudRow(plan()) // a locked plan in the cloud that cannot be read
      h.state.readError = error
      await expect(store.loadSavingsPlan()).resolves.toBe(false)
      expect(cache.getPlan()).toBeNull()
      expect(cached()).toBeNull()
      await expect(store.planCanSave()).resolves.toBe(false)
      expect(h.state.reads).toHaveLength(1)
      vi.setSystemTime(at(NOW) + 9 * 60_000)
      await expect(store.loadSavingsPlan()).resolves.toBe(false)
      expect(h.state.reads).toHaveLength(1)
      // The migration ran in the meantime.
      h.state.readError = null
      vi.setSystemTime(at(NOW) + 10 * 60_000 + 1)
      await expect(store.loadSavingsPlan()).resolves.toBe(true)
      expect(cache.getPlan()).toEqual(plan())
      await expect(store.planCanSave()).resolves.toBe(true)
    })

    it('never clears a plan that was cached before', async () => {
      cache.setPlan(plan())
      h.state.readError = error
      await expect(store.loadSavingsPlan()).resolves.toBe(false)
      expect(cache.getPlan()).toEqual(plan())
      expect(cached()).toEqual(plan())
    })
  })

  it('a load the end of the session overtook writes nothing', async () => {
    h.state.row = cloudRow(plan())
    let release!: () => void
    h.state.holdRead = new Promise<void>((r) => (release = r))
    const loading = store.loadSavingsPlan()
    await vi.waitFor(() => expect(h.state.reads).toHaveLength(1))
    h.state.session = null
    release()
    await expect(loading).resolves.toBe(false)
    expect(cache.getPlan()).toBeNull()
  })

  it('a load another account overtook writes nothing', async () => {
    h.state.row = cloudRow(plan())
    let release!: () => void
    h.state.holdRead = new Promise<void>((r) => (release = r))
    const loading = store.loadSavingsPlan()
    await vi.waitFor(() => expect(h.state.reads).toHaveLength(1))
    h.state.session = { user: { id: 'user-2' } }
    release()
    await expect(loading).resolves.toBe(false)
    expect(cache.getPlan()).toBeNull()
  })

  it('a load a wipe of the ledger overtook writes nothing, and the next caller asks again', async () => {
    h.state.row = cloudRow(plan())
    let release!: () => void
    h.state.holdRead = new Promise<void>((r) => (release = r))
    const loading = store.loadSavingsPlan()
    await vi.waitFor(() => expect(h.state.reads).toHaveLength(1))
    cache.clearSavingsPlan()
    const again = store.loadSavingsPlan()
    release()
    await expect(loading).resolves.toBe(false)
    await expect(again).resolves.toBe(true)
    expect(h.state.reads).toHaveLength(2)
    expect(cache.getPlan()).toEqual(plan())
  })

  describe('with { ifStale: true }', () => {
    it('asks when nothing has loaded yet, and again at once after a first read that failed', async () => {
      h.state.readError = { message: 'timeout' }
      await expect(store.loadSavingsPlan({ ifStale: true })).resolves.toBe(false)
      h.state.readError = null
      h.state.row = cloudRow(plan())
      await expect(store.loadSavingsPlan({ ifStale: true })).resolves.toBe(true)
      expect(h.state.reads).toHaveLength(2)
      expect(cache.getPlan()).toEqual(plan())
    })

    it('asks nothing inside a minute of a good read, and asks again after a minute', async () => {
      h.state.row = cloudRow(plan())
      await store.loadSavingsPlan()
      vi.setSystemTime(at(NOW) + 59_000)
      await expect(store.loadSavingsPlan({ ifStale: true })).resolves.toBe(true)
      expect(h.state.reads).toHaveLength(1)
      vi.setSystemTime(at(NOW) + 60_000)
      h.state.row = cloudRow(plan({ cap: 2800, updatedAt: at(NOW) }))
      await expect(store.loadSavingsPlan({ ifStale: true })).resolves.toBe(true)
      expect(h.state.reads).toHaveLength(2)
      expect(cache.getPlan()?.cap).toBe(2800)
    })

    it('asks again after the ledger was wiped, however recent the last read', async () => {
      h.state.row = cloudRow(plan())
      await store.loadSavingsPlan()
      cache.clearSavingsPlan()
      await expect(store.loadSavingsPlan({ ifStale: true })).resolves.toBe(true)
      expect(h.state.reads).toHaveLength(2)
    })
  })
})

describe('planCanSave', () => {
  it('needs a backend, a session and a table that has answered', async () => {
    await expect(store.planCanSave()).resolves.toBe(true)
    expect(h.state.reads).toHaveLength(1)
    // Asked once: the answer is remembered.
    await expect(store.planCanSave()).resolves.toBe(true)
    expect(h.state.reads).toHaveLength(1)
  })

  it('is false signed out, with no backend, and before the table could be asked', async () => {
    h.state.session = null
    await expect(store.planCanSave()).resolves.toBe(false)
    h.state.session = { user: { id: 'user-1' } }
    h.state.enabled = false
    await expect(store.planCanSave()).resolves.toBe(false)
    h.state.enabled = true
    setOnline(false)
    await expect(store.planCanSave()).resolves.toBe(false)
    expect(h.from).not.toHaveBeenCalled()
  })
})

describe('saveSavingsPlan', () => {
  it('a first plan: reads first, then writes the row for the session user, and caches what came back', async () => {
    await expect(store.saveSavingsPlan({ goal: 800, cap: 3000, locked: true })).resolves.toEqual({ ok: true })
    expect(h.state.reads).toEqual([{ column: 'user_id', value: 'user-1' }])
    expect(h.state.upserts).toEqual([
      {
        onConflict: 'user_id',
        row: { user_id: 'user-1', goal: 800, cap: 3000, locked: true, since: '2031-05', pending: null, past_caps: [], updated_at: new Date(NOW).toISOString() },
      },
    ])
    expect(cache.getPlan()).toEqual(plan({ since: '2031-05', updatedAt: at(NOW) }))
    expect(cached()).toEqual(cache.getPlan())
  })

  it('reads with a request of its own, never joining a load already out', async () => {
    h.state.row = cloudRow(plan())
    let release!: () => void
    h.state.holdRead = new Promise<void>((r) => (release = r))
    const loading = store.loadSavingsPlan()
    await vi.waitFor(() => expect(h.state.reads).toHaveLength(1))
    const saving = store.saveSavingsPlan({ cap: 2800 })
    await vi.waitFor(() => expect(h.state.reads).toHaveLength(2))
    release()
    await expect(saving).resolves.toEqual({ ok: true })
    await loading
    expect(cache.getPlan()?.cap).toBe(2800)
  })

  it('applies the change to the plan the account holds, not to the copy a screen had', async () => {
    cache.setPlan(plan({ locked: false, since: null })) // this device thinks the lock is off
    h.state.row = cloudRow(plan())
    await expect(store.saveSavingsPlan({ goal: 700 })).resolves.toEqual({ ok: true })
    // Locked in the account, so a lower goal waits.
    expect(cache.getPlan()).toMatchObject({ goal: 800, locked: true, pending: { from: '2031-05', goal: 700 } })
  })

  it('starts from the plan as it stands today: a change whose month has come is folded in and tidied', async () => {
    h.state.row = cloudRow(plan({ since: '2031-03', pending: { from: '2031-04', cap: 3500 } }))
    await expect(store.saveSavingsPlan({ goal: 900 })).resolves.toEqual({ ok: true })
    expect(h.state.upserts[0].row).toMatchObject({ cap: 3500, goal: 900, pending: null })
  })

  it("uses the clock's date, not one a screen holds: a save just after midnight on the 1st is dated next month", async () => {
    h.state.row = cloudRow(plan())
    vi.setSystemTime(new Date('2031-05-01T00:00:30'))
    await expect(store.saveSavingsPlan({ cap: 3500 })).resolves.toEqual({ ok: true })
    expect(cache.getPlan()?.pending).toEqual({ from: '2031-06', cap: 3500 })
  })

  it('stamps after the row it read, even with the device clock behind', async () => {
    const ahead = at(NOW) + 3_600_000
    h.state.row = cloudRow(plan({ updatedAt: ahead }))
    await expect(store.saveSavingsPlan({ cap: 2800 })).resolves.toEqual({ ok: true })
    expect(h.state.upserts[0].row.updated_at).toBe(new Date(ahead + 1).toISOString())
    expect(cache.getPlan()).toMatchObject({ cap: 2800, updatedAt: ahead + 1 })
  })

  it('knows its own write on a clock that counts in fractions of a millisecond', async () => {
    // A stamp travels as text to the millisecond, so one with a fraction would never come back the same.
    h.state.row = cloudRow(plan())
    vi.spyOn(Date, 'now').mockReturnValue(at(NOW) + 0.4375)
    await expect(store.saveSavingsPlan({ cap: 2800 })).resolves.toEqual({ ok: true })
    expect(cache.getPlan()).toMatchObject({ cap: 2800, updatedAt: at(NOW) })
    vi.restoreAllMocks()
  })

  it('a raise asked on the 30th, a save on a device already on the 1st, then a read on the 30th: the raise is still waiting there', async () => {
    h.state.row = cloudRow(plan({ since: '2031-10' }))
    await expect(store.saveSavingsPlan({ cap: 3500 }, '2031-11-30')).resolves.toEqual({ ok: true })
    vi.setSystemTime(new Date(at(NOW) + 60_000))
    await expect(store.saveSavingsPlan({ goal: 900 }, '2031-12-01')).resolves.toEqual({ ok: true })
    // A device whose date is still Nov 30 reads the row the second save wrote.
    await launch()
    await store.loadSavingsPlan()
    expect(capInForce(cache.getPlan(), '2031-11-30')).toBe(3000)
    expect(planOn(cache.getPlan(), '2031-11-30')).toMatchObject({ goal: 900, pending: { from: '2031-12', cap: 3500 } })
    expect(capInForce(cache.getPlan(), '2031-12-01')).toBe(3500)
  })

  it('an unlock asked on the 30th and a save on the 1st leave the device still on the 30th locked', async () => {
    h.state.row = cloudRow(plan({ since: '2031-10' }))
    await store.saveSavingsPlan({ locked: false }, '2031-11-30')
    vi.setSystemTime(new Date(at(NOW) + 60_000))
    await expect(store.saveSavingsPlan({ goal: 900 }, '2031-12-01')).resolves.toEqual({ ok: true })
    expect(capInForce(cache.getPlan(), '2031-11-30')).toBe(3000)
    expect(capInForce(cache.getPlan(), '2031-12-01')).toBeNull()
  })

  it('a raise that has landed is written with the budget the months before it had, and read back with it', async () => {
    h.state.row = cloudRow(plan({ since: '2031-02', pending: { from: '2031-04', cap: 3500 } }))
    await expect(store.saveSavingsPlan({ goal: 900 })).resolves.toEqual({ ok: true })
    expect(h.state.upserts[0].row).toMatchObject({ cap: 3500, pending: null, past_caps: [{ until: '2031-04', cap: 3000 }] })
    expect(cache.getPlan()?.pastCaps).toEqual([{ until: '2031-04', cap: 3000 }])
    await launch()
    await store.loadSavingsPlan()
    expect(cache.getPlan()?.pastCaps).toEqual([{ until: '2031-04', cap: 3000 }])
  })

  it('a returned row with the stamp sent is a kept write, whatever its text and key order', async () => {
    h.state.row = cloudRow(plan())
    await expect(store.saveSavingsPlan({ cap: 3500, goal: 700 })).resolves.toEqual({ ok: true })
    expect(cache.getPlan()?.pending).toEqual({ from: '2031-05', cap: 3500, goal: 700 })
  })

  it('a returned row with another stamp changed on another device: it is adopted and said', async () => {
    h.state.row = cloudRow(plan())
    const theirs = plan({ cap: 2500, updatedAt: at(NOW) + 5000 })
    h.state.beforeUpsert = () => (h.state.row = cloudRow(theirs))
    await expect(store.saveSavingsPlan({ cap: 2800 })).resolves.toEqual({
      ok: false,
      message: 'The plan changed on another device. Check it, then try again.',
    })
    expect(cache.getPlan()).toEqual(theirs)
  })

  it.each([
    ['fails', () => (h.state.upsertError = { message: 'boom' })],
    ['throws', () => (h.state.upsertThrows = true)],
    ['answers with no row', () => (h.state.upsertNoRow = true)],
  ])('an upsert that %s is followed by a fresh load, and the cache holds what that found', async (_what, arrange) => {
    cache.setPlan(plan())
    h.state.row = cloudRow(plan())
    arrange()
    // The write may have landed all the same: here another device's did.
    const found = plan({ cap: 2900, updatedAt: at(NOW) + 1 })
    h.state.beforeUpsert = () => {
      if (!h.state.upsertNoRow) h.state.row = cloudRow(found)
    }
    const result = await store.saveSavingsPlan({ cap: 2800 })
    expect(result).toEqual({ ok: false, message: 'Could not save the plan. Try again.' })
    expect(h.state.reads).toHaveLength(2)
    expect(cache.getPlan()).toEqual(h.state.upsertNoRow ? plan({ cap: 2800, updatedAt: at(NOW) }) : found)
  })

  it('a refusal comes back with its own line and nothing is written', async () => {
    await expect(store.saveSavingsPlan({ locked: true })).resolves.toEqual({ ok: false, message: 'Enter both amounts first.' })
    expect(h.state.upserts).toHaveLength(0)
  })

  it('a failed read stops the save', async () => {
    h.state.readError = { message: 'timeout' }
    await expect(store.saveSavingsPlan({ cap: 2800 })).resolves.toEqual({ ok: false, message: 'Could not save the plan. Try again.' })
    expect(h.state.upserts).toHaveLength(0)
  })

  it('offline is refused and nothing is asked', async () => {
    setOnline(false)
    await expect(store.saveSavingsPlan({ cap: 2800 })).resolves.toEqual({ ok: false, message: 'You are offline. The plan was not changed.' })
    h.state.enabled = false
    setOnline(true)
    await expect(store.saveSavingsPlan({ cap: 2800 })).resolves.toEqual({ ok: false, message: 'You are offline. The plan was not changed.' })
    expect(h.from).not.toHaveBeenCalled()
  })

  it('with no session the answer is the sign-in line and nothing is asked', async () => {
    cache.setPlan(plan())
    h.state.session = null
    await expect(store.saveSavingsPlan({ cap: 2800 })).resolves.toEqual({ ok: false, message: 'Sign in to change the plan.' })
    expect(h.from).not.toHaveBeenCalled()
    expect(cache.getPlan()).toEqual(plan())
  })

  describe('a load that started before a save and answered after it', () => {
    it('does not put "no plan" back after a first lock', async () => {
      let release!: () => void
      h.state.holdRead = new Promise<void>((r) => (release = r))
      const loading = store.loadSavingsPlan() // sees no row
      await vi.waitFor(() => expect(h.state.reads).toHaveLength(1))
      await expect(store.saveSavingsPlan({ goal: 800, cap: 3000, locked: true })).resolves.toEqual({ ok: true })
      release()
      await loading
      expect(cache.getPlan()).toMatchObject({ locked: true, cap: 3000 })
      expect(cached()).toMatchObject({ locked: true, cap: 3000 })
    })

    it('does not put the old budget back after a lower one', async () => {
      h.state.row = cloudRow(plan())
      let release!: () => void
      h.state.holdRead = new Promise<void>((r) => (release = r))
      const loading = store.loadSavingsPlan() // sees 3,000
      await vi.waitFor(() => expect(h.state.reads).toHaveLength(1))
      await expect(store.saveSavingsPlan({ cap: 2800 })).resolves.toEqual({ ok: true })
      release()
      await loading
      expect(cache.getPlan()?.cap).toBe(2800)
      expect(cached()?.cap).toBe(2800)
    })
  })

  describe('a save made in another tab while this one was loading', () => {
    /** What the other tab does: its save lands in the cloud and in the storage both tabs share. */
    function otherTabSaves(p: SavingsPlan) {
      h.state.row = cloudRow(p)
      localStorage.setItem(KEY, JSON.stringify(p))
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
    }

    it('is not undone by the older row this tab asked for before it', async () => {
      h.state.row = cloudRow(plan())
      cache.setPlan(plan())
      let release!: () => void
      h.state.holdRead = new Promise<void>((r) => (release = r))
      const loading = store.loadSavingsPlan() // sees 3,000
      await vi.waitFor(() => expect(h.state.reads).toHaveLength(1))
      otherTabSaves(plan({ cap: 2600, updatedAt: at(NOW) }))
      release()
      await loading
      expect(cache.getPlan()?.cap).toBe(2600)
      expect(cached()?.cap).toBe(2600)
    })

    it('a first lock is not undone by the "no row" this tab asked for before it', async () => {
      let release!: () => void
      h.state.holdRead = new Promise<void>((r) => (release = r))
      const loading = store.loadSavingsPlan() // sees no row
      await vi.waitFor(() => expect(h.state.reads).toHaveLength(1))
      otherTabSaves(plan({ updatedAt: at(NOW) }))
      release()
      await loading
      expect(cache.getPlan()).toMatchObject({ locked: true, cap: 3000 })
      expect(cached()).toMatchObject({ locked: true, cap: 3000 })
    })

    it("this tab's own late save answer does not undo the other tab's newer save", async () => {
      h.state.row = cloudRow(plan())
      const theirs = plan({ cap: 2500, updatedAt: at(NOW) + 5000 })
      // This tab's write is kept, then the other tab's newer one lands before this answer is read.
      let release!: () => void
      h.state.holdUpsert = new Promise<void>((r) => (release = r))
      const answered = store.saveSavingsPlan({ cap: 2800 })
      await vi.waitFor(() => expect(h.state.upserts).toHaveLength(1))
      otherTabSaves(theirs)
      release()
      await answered
      expect(cache.getPlan()).toEqual(theirs)
      expect(cached()).toEqual(theirs)
    })
  })

  describe('when storage will not keep the plan', () => {
    const refuseKey = () => {
      const real = Storage.prototype.setItem
      return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
        if (k === KEY) throw new DOMException('full', 'QuotaExceededError')
        real.call(this, k, v)
      })
    }

    it('a save the account kept says the device could not keep it, and the next load tries storage again', async () => {
      h.state.row = cloudRow(plan())
      cache.setPlan(plan())
      const spy = refuseKey()
      const result = await store.saveSavingsPlan({ cap: 2500 })
      expect(result).toEqual({ ok: false, message: 'Saved, but this device could not keep a copy. It tries again at the next sync.' })
      expect(cache.getPlan()?.cap).toBe(2500)
      expect(cached()?.cap).toBe(3000)
      spy.mockRestore()
      await expect(store.loadSavingsPlan()).resolves.toBe(true)
      expect(cached()?.cap).toBe(2500)
    })

    it('a late answer older than the plan in memory never takes its place, though storage still holds the older one', async () => {
      h.state.row = cloudRow(plan())
      cache.setPlan(plan())
      const spy = refuseKey()
      await store.saveSavingsPlan({ cap: 2500 })
      // The cloud's answer to a read that was asked before the save, from a slow cache in between.
      h.state.row = cloudRow(plan())
      await store.loadSavingsPlan()
      expect(cache.getPlan()?.cap).toBe(2500)
      spy.mockRestore()
    })
  })
})

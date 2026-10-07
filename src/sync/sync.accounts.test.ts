/**
 * B23: accounts sync between devices.
 *
 * Two devices share one cloud. A device here is a snapshot of its Dexie tables,
 * loaded into the one test database while it syncs and saved back after. The
 * cloud behaves like PostgREST with the keep_newer_row() trigger: an upsert
 * keeps the stored row when it is newer, and a table the cloud does not have
 * answers PGRST205.
 *
 * Each test loads a fresh sync module, as a new session: the missing-table
 * memory is module state. Each device has its own localStorage.
 */
import 'fake-indexeddb/auto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Category, Transaction } from '../db/db'

type Row = Record<string, unknown>
type Res = { data: Row[] | null; error: unknown }

const h = vi.hoisted(() => {
  const state = {
    tables: { categories: new Map<string, Row>(), transactions: new Map<string, Row>(), accounts: new Map<string, Row>() } as Record<
      string,
      Map<string, Row>
    >,
    /** The cloud has no accounts table (before the migration). */
    noAccounts: false,
    /** The accounts read fails (a network error), the rest answers. */
    failAccounts: false,
    selects: [] as string[],
    upserts: [] as { table: string; rows: Row[] }[],
    /** Runs once before the next upsert to this table lands (another device's push landing first). */
    beforeUpsert: null as null | { table: string; run: () => void },
    /** Accounts upserts land but answer with an error (the connection dropped after the write). */
    accountsAnswerError: false,
    /** Columns the cloud's accounts table does not have yet. */
    missingAccountColumns: new Set<string>(),
  }
  const noTable = (t: string) => ({ code: 'PGRST205', message: `Could not find the table 'public.${t}' in the schema cache` })
  const missing = (t: string) => t === 'accounts' && state.noAccounts
  interface Q extends PromiseLike<Res> {
    order(): Q
    limit(): Q
    gt(c: string, v: string): Q
  }
  const query = (table: string): Q => {
    let after: string | null = null
    const run = async (): Promise<Res> => {
      state.selects.push(table)
      if (missing(table)) return { data: null, error: noTable(table) }
      if (table === 'accounts' && state.failAccounts) return { data: null, error: { message: 'TypeError: Load failed' } }
      const rows = [...state.tables[table].values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
      return { data: (after == null ? rows : rows.filter((r) => String(r.id) > after!)).map((r) => ({ ...r })), error: null }
    }
    const q: Q = {
      order: () => q,
      limit: () => q,
      gt: (_c, v) => ((after = v), q),
      then: (ok, bad) => run().then(ok, bad),
    }
    return q
  }
  const supabase = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'owner@example.com' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null }),
    },
    from: (table: string) => ({
      select: () => query(table),
      upsert: async (input: Row | Row[]) => {
        if (missing(table)) return { error: noTable(table) }
        const rows = Array.isArray(input) ? input : [input]
        if (table === 'accounts') {
          for (const c of state.missingAccountColumns) {
            // PostgREST refuses an upsert that names a column the table does not have.
            if (rows.some((r) => c in r)) return { error: { code: 'PGRST204', message: `Could not find the '${c}' column of 'accounts' in the schema cache` } }
          }
        }
        const hook = state.beforeUpsert
        if (hook?.table === table) {
          state.beforeUpsert = null
          hook.run()
        }
        state.upserts.push({ table, rows })
        for (const r of rows) {
          const old = state.tables[table].get(String(r.id))
          // keep_newer_row(): a stale write leaves the stored row as it is.
          if (old && Date.parse(String(r.updated_at)) < Date.parse(String(old.updated_at))) continue
          state.tables[table].set(String(r.id), { ...r })
        }
        if (table === 'accounts' && state.accountsAnswerError) return { error: { message: 'The network connection was lost.' } }
        return { error: null }
      },
    }),
  }
  return { state, supabase }
})

vi.mock('../db/supabase', () => ({ supabase: h.supabase }))
vi.mock('./merchantRules', () => ({ loadMerchantRules: vi.fn(async () => true) }))

let sync: typeof import('./sync')
let db: typeof import('../db/db').db
let brokerage: typeof import('../lib/brokerage')
let status = ''

/** One device's localStorage. */
class MemoryStorage {
  private m = new Map<string, string>()
  get length() {
    return this.m.size
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v))
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  clear() {
    this.m.clear()
  }
}

interface Device {
  accounts: Account[]
  categories: Category[]
  transactions: Transaction[]
  storage: MemoryStorage
}
const device = (accounts: Account[] = []): Device => ({
  accounts: accounts.map((a) => ({ ...a })),
  categories: [],
  transactions: [],
  storage: new MemoryStorage(),
})

/** Run `fn` as this device: its tables in Dexie and its localStorage for the duration, saved back after. */
async function on<T>(dev: Device, fn: () => Promise<T>): Promise<T> {
  Object.defineProperty(globalThis, 'localStorage', { value: dev.storage, configurable: true, writable: true })
  await db.transaction('rw', db.accounts, db.categories, db.transactions, async () => {
    await db.accounts.clear()
    await db.categories.clear()
    await db.transactions.clear()
    await db.accounts.bulkAdd(dev.accounts)
    await db.categories.bulkAdd(dev.categories)
    await db.transactions.bulkAdd(dev.transactions)
  })
  try {
    return await fn()
  } finally {
    dev.accounts = await db.accounts.toArray()
    dev.categories = await db.categories.toArray()
    dev.transactions = await db.transactions.toArray()
  }
}
const syncOn = (dev: Device) => on(dev, () => sync.syncNow())

const manual = (uid: string, p: Partial<Account> = {}): Account => ({
  uid, name: 'Retirement Plan', institution: 'Test Plan Co', type: 'retirement', balance: 1000, liveSync: false,
  lastUpdated: 1000, sortOrder: 0, deleted: false, updatedAt: 1000, ...p,
})
const live = (uid: string, source: string, sourceAccountId: string, p: Partial<Account> = {}): Account =>
  manual(uid, { name: 'Checking', institution: 'Test Bank', type: 'cash', liveSync: true, source, sourceAccountId, ...p })

const shown = (d: Device) => d.accounts.filter((a) => !a.deleted && !a.archived)
/** Net worth as Accounts draws it (assets less what is owed on cards), in cents so the order of the sum cannot matter. */
const netWorth = (d: Device) => shown(d).reduce((s, a) => s + Math.round(a.balance * 100) * (a.type === 'credit' ? -1 : 1), 0)
/** What Accounts offers back as Removed. */
const removedList = (d: Device) => d.accounts.filter((a) => !!a.deleted && a.liveSync && !!a.sourceAccountId)
const view = (d: Device) =>
  shown(d)
    .map((a) => `${a.uid}|${a.institution}|${a.name}|${a.type}|${a.balance}`)
    .sort()
const cloudAccounts = () => [...h.state.tables.accounts.values()]
/** The cloud's live hand-typed accounts. */
const liveCloudHandTyped = () => cloudAccounts().filter((r) => !r.live_sync && !r.source_account_id && !r.deleted)

beforeEach(async () => {
  vi.resetModules()
  sync = await import('./sync')
  ;({ db } = await import('../db/db'))
  brokerage = await import('../lib/brokerage')
  sync.subscribeSync((s) => (status = s.status))
  for (const t of Object.values(h.state.tables)) t.clear()
  h.state.noAccounts = false
  h.state.failAccounts = false
  h.state.selects = []
  h.state.upserts = []
  h.state.beforeUpsert = null
  h.state.accountsAnswerError = false
  h.state.missingAccountColumns.clear()
})
afterAll(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('an edit on one device reaches the other', () => {
  it('a hand-typed account, then its new balance and name, then its removal', async () => {
    const A = device([manual('m-1', { balance: 1000, updatedAt: 1000 })])
    const B = device()
    expect(await syncOn(A)).toBe('ok')
    expect(await syncOn(B)).toBe('ok')
    expect(shown(B)).toMatchObject([{ uid: 'm-1', name: 'Retirement Plan', balance: 1000, liveSync: false }])

    // B edits it (the sheet stamps updatedAt), A pulls the edit.
    await on(B, async () => {
      const row = (await db.accounts.where('uid').equals('m-1').first())!
      await db.accounts.update(row.id!, { balance: 1250.5, name: 'Plan', lastUpdated: 5000, updatedAt: 5000 })
      await sync.syncNow()
    })
    await syncOn(A)
    expect(shown(A)).toMatchObject([{ uid: 'm-1', name: 'Plan', balance: 1250.5, lastUpdated: 5000 }])

    // A deletes it; B's copy becomes the tombstone and stops counting.
    await on(A, async () => {
      const row = (await db.accounts.where('uid').equals('m-1').first())!
      await db.accounts.update(row.id!, { deleted: true, updatedAt: 9000 })
      await sync.syncNow()
    })
    await syncOn(B)
    expect(B.accounts).toMatchObject([{ uid: 'm-1', deleted: true }])
    expect(netWorth(B)).toBe(0)
    expect(h.state.tables.accounts.get('m-1')).toMatchObject({ deleted: true })
  })

  it('an older copy never overwrites a newer one, in the cloud or on a device', async () => {
    const A = device([manual('m-1', { balance: 1000, updatedAt: 1000 })])
    await syncOn(A)
    const B = device()
    await syncOn(B)
    await on(A, async () => {
      const row = (await db.accounts.where('uid').equals('m-1').first())!
      await db.accounts.update(row.id!, { balance: 2000, updatedAt: 8000 })
      await sync.syncNow()
    })
    // B edited earlier (a slower clock) and syncs after: A's edit stands everywhere.
    await on(B, async () => {
      const row = (await db.accounts.where('uid').equals('m-1').first())!
      await db.accounts.update(row.id!, { balance: 1500, updatedAt: 4000 })
      await sync.syncNow()
    })
    await syncOn(A)
    expect(h.state.tables.accounts.get('m-1')).toMatchObject({ balance: 2000 })
    expect(shown(A)[0].balance).toBe(2000)
    expect(shown(B)[0].balance).toBe(2000)
  })

  it('an archive and a restore travel too, and what the rows said stays on the device', async () => {
    const A = device([live('l-1', 'simplefin', 'ACT-1', { rowsSay: 'cash' })])
    await syncOn(A)
    const B = device()
    await syncOn(B)
    await on(B, async () => {
      const row = (await db.accounts.where('uid').equals('l-1').first())!
      await db.accounts.update(row.id!, { archived: true, updatedAt: 7000 })
      await sync.syncNow()
    })
    await syncOn(A)
    expect(A.accounts[0]).toMatchObject({ uid: 'l-1', archived: true, rowsSay: 'cash' })
    expect('rowsSay' in cloudAccounts()[0]).toBe(false)
  })
})

describe('connector accounts fetched on both devices', () => {
  // Before accounts synced, each device made its own row for each bank account.
  const macRows = () => [
    live('a-chk', 'simplefin', 'ACT-CHK', { balance: 2400, lastUpdated: 9000, updatedAt: 9000 }),
    live('z-card', 'simplefin', 'ACT-CARD', { name: 'Rewards Card', type: 'credit', balance: 310, lastUpdated: 9000, updatedAt: 9000 }),
    live('c-brk', 'snaptrade', 'BRK-1', { name: 'Taxable Account', institution: 'Example Brokerage', type: 'brokerage', balance: 5200, lastUpdated: 9000, updatedAt: 9000 }),
  ]
  const phoneRows = () => [
    live('y-chk', 'simplefin', 'ACT-CHK', { balance: 2100, lastUpdated: 4000, updatedAt: 4000, sortOrder: 3 }),
    live('b-card', 'simplefin', 'ACT-CARD', { name: 'Rewards Card', type: 'credit', balance: 290, lastUpdated: 4000, updatedAt: 4000 }),
    live('d-brk', 'snaptrade', 'BRK-1', { name: 'Taxable Account', institution: 'Example Brokerage', type: 'brokerage', balance: 5000, lastUpdated: 4000, updatedAt: 4000 }),
  ]

  it('collapse to one row each, the same row on both devices, with the newest balances', async () => {
    const A = device(macRows())
    const B = device(phoneRows())
    await syncOn(A)
    await syncOn(B)
    await syncOn(A)
    await syncOn(B)
    // The smallest uid stays on every device; the newest copy's fields win.
    expect(view(A)).toEqual(['a-chk|Test Bank|Checking|cash|2400', 'b-card|Test Bank|Rewards Card|credit|310', 'c-brk|Example Brokerage|Taxable Account|brokerage|5200'])
    expect(view(B)).toEqual(view(A))
    expect(netWorth(A)).toBe((2400 - 310 + 5200) * 100)
    expect(netWorth(B)).toBe(netWorth(A))
    // The rest are unlinked tombstones: never offered back as Removed.
    expect(removedList(A)).toEqual([])
    expect(removedList(B)).toEqual([])
    for (const uid of ['y-chk', 'z-card', 'd-brk']) {
      expect(h.state.tables.accounts.get(uid)).toMatchObject({ deleted: true, live_sync: false, source_account_id: null, source: null })
    }
    // One live cloud row per source account.
    const liveCloud = cloudAccounts().filter((r) => !r.deleted)
    expect(liveCloud.map((r) => r.id).sort()).toEqual(['a-chk', 'b-card', 'c-brk'])
  })

  it('a later fetch on either device updates the kept row and adds none', async () => {
    const A = device(macRows())
    const B = device(phoneRows())
    await syncOn(A)
    await syncOn(B)
    await on(B, async () => {
      const res = await brokerage.applySyncedAccounts(
        [{ sourceAccountId: 'ACT-CHK', institution: 'Test Bank', name: 'Checking', tier: 'cash', balance: 2600, currency: 'USD' }],
        'simplefin',
        { archiveMissing: false },
      )
      expect(res).toEqual({ shown: 1, removed: 0 })
      await sync.syncNow()
    })
    await syncOn(A)
    for (const d of [A, B]) {
      expect(shown(d).filter((a) => a.sourceAccountId === 'ACT-CHK')).toMatchObject([{ uid: 'a-chk', balance: 2600 }])
      expect(shown(d)).toHaveLength(3)
    }
  })

  it('a removal on either copy holds, and Accounts can still restore it', async () => {
    const A = device(macRows())
    // The phone removed its card row earlier; the Mac still shows the card.
    const B = device(phoneRows().map((a) => (a.sourceAccountId === 'ACT-CARD' ? { ...a, deleted: true, updatedAt: 3000 } : a)))
    await syncOn(A)
    await syncOn(B)
    await syncOn(A)
    for (const d of [A, B]) {
      expect(shown(d).some((a) => a.sourceAccountId === 'ACT-CARD')).toBe(false)
      expect(removedList(d)).toMatchObject([{ uid: 'b-card', deleted: true }])
    }
    expect(netWorth(A)).toBe((2400 + 5200) * 100)
    expect(netWorth(B)).toBe(netWorth(A))
  })
})

describe('B23 (e): net worth after a two-device merge', () => {
  it('equals what the most recently synced device showed, with a hand-typed account typed in on both', async () => {
    const A = device([
      live('k-chk', 'simplefin', 'ACT-CHK', { balance: 3150.25, lastUpdated: 9000, updatedAt: 9000 }),
      live('k-card', 'simplefin', 'ACT-CARD', { name: 'Card', type: 'credit', balance: 845.1, lastUpdated: 9000, updatedAt: 9000 }),
      live('k-brk', 'snaptrade', 'BRK-1', { name: 'Taxable Account', institution: 'Example Brokerage', type: 'brokerage', balance: 7020, lastUpdated: 9000, updatedAt: 9000 }),
      manual('k-401', { balance: 41000, lastUpdated: 6000, updatedAt: 6000, sortOrder: 4 }),
    ])
    const B = device([
      live('p-chk', 'simplefin', 'ACT-CHK', { balance: 3010.25, lastUpdated: 5000, updatedAt: 5000 }),
      live('p-card', 'simplefin', 'ACT-CARD', { name: 'Card', type: 'credit', balance: 700, lastUpdated: 5000, updatedAt: 5000 }),
      live('p-brk', 'snaptrade', 'BRK-1', { name: 'Taxable Account', institution: 'Example Brokerage', type: 'brokerage', balance: 6900, lastUpdated: 5000, updatedAt: 5000 }),
      // The same plan, typed in by hand here too (an older figure).
      manual('p-401', { name: ' retirement  plan', balance: 39000, lastUpdated: 2000, updatedAt: 2000 }),
    ])
    const before = { A: netWorth(A), B: netWorth(B), count: shown(A).length }
    await syncOn(A)
    await syncOn(B)
    await syncOn(A)
    await syncOn(B)
    expect(netWorth(A)).toBe(before.A)
    expect(netWorth(B)).toBe(before.A)
    expect(shown(A)).toHaveLength(before.count)
    expect(shown(B)).toHaveLength(before.count)
    expect(view(B)).toEqual(view(A))
    // The phone's hand-typed copy took the cloud's id: one row, the newer figure.
    expect(shown(B).filter((a) => !a.liveSync)).toMatchObject([{ uid: 'k-401', balance: 41000, name: 'Retirement Plan' }])
    expect(cloudAccounts().filter((r) => !r.live_sync && !r.deleted).map((r) => r.id)).toEqual(['k-401'])
    expect(h.state.tables.accounts.has('p-401')).toBe(false)
  })

  it('a newer hand-typed figure on the second device wins, and an account only one device had is added', async () => {
    const A = device([manual('k-401', { balance: 41000, updatedAt: 2000 })])
    const B = device([
      manual('p-401', { balance: 43500, lastUpdated: 7000, updatedAt: 7000 }),
      manual('p-hsa', { name: 'HSA', institution: 'Test Health Co', type: 'benefit', balance: 900, updatedAt: 3000 }),
    ])
    await syncOn(A)
    await syncOn(B)
    await syncOn(A)
    expect(netWorth(B)).toBe((43500 + 900) * 100)
    expect(netWorth(A)).toBe(netWorth(B))
    expect(view(A)).toEqual(view(B))
    // The newer copy goes up as it is; the older one stays only as a tombstone.
    expect(h.state.tables.accounts.get('p-401')).toMatchObject({ balance: 43500, deleted: false, updated_at: new Date(7000).toISOString() })
    expect(h.state.tables.accounts.get('k-401')).toMatchObject({ deleted: true })
    expect(liveCloudHandTyped().map((r) => r.id).sort()).toEqual(['p-401', 'p-hsa'])
  })

  it('two hand-typed accounts the cloud already holds are never merged', async () => {
    const A = device([manual('m-1', { balance: 100 }), manual('m-2', { balance: 200 })])
    await syncOn(A)
    const B = device()
    await syncOn(B)
    expect(shown(B).map((a) => a.uid).sort()).toEqual(['m-1', 'm-2'])
    expect(netWorth(B)).toBe(300 * 100)
  })
})

/** Sync the devices in this order. */
async function syncAll(...order: Device[]) {
  for (const d of order) await syncOn(d)
}
/** Start over: an empty cloud, and these two devices as new. */
function resetDevices(A: Device, a: Account[], B: Device, b: Account[]) {
  for (const t of Object.values(h.state.tables)) t.clear()
  Object.assign(A, device(a))
  Object.assign(B, device(b))
}
/** A row the old starter seed made: hand-typed, $0, stamped with the device's first boot. */
const starter = (uid: string, name: string, institution: string, type: Account['type'], at = 6000): Account =>
  manual(uid, { name, institution, type, balance: 0, lastUpdated: at, updatedAt: at })

describe('a $0 starter row never replaces a typed figure', () => {
  for (const [label, first] of [
    ['the device with the figure syncs first', 'A'],
    ['the device with the $0 row syncs first', 'B'],
  ] as const) {
    it(`${label}: the figure ends on both devices and in the cloud`, async () => {
      // The $0 row is the NEWER copy: the seed stamped it at the phone's first boot.
      const A = device([manual('a-401', { balance: 41000, lastUpdated: 5000, updatedAt: 5000 })])
      const B = device([starter('b-401', 'Retirement Plan', 'Test Plan Co', 'retirement', 6000)])
      const before = netWorth(A)
      await syncAll(...(first === 'A' ? [A, B, A, B] : [B, A, B, A]))
      for (const d of [A, B]) {
        expect(shown(d)).toHaveLength(1)
        expect(shown(d)[0]).toMatchObject({ balance: 41000, lastUpdated: 5000, name: 'Retirement Plan' })
        expect(netWorth(d)).toBe(before)
      }
      expect(view(A)).toEqual(view(B))
      expect(liveCloudHandTyped()).toMatchObject([{ balance: 41000 }])
    })
  }

  it('between two figures the newer one still wins, and a balance cleared to $0 later on the same row syncs', async () => {
    const A = device([manual('a-401', { balance: 41000, updatedAt: 5000 })])
    const B = device([manual('b-401', { balance: 39000, updatedAt: 4000 })])
    await syncAll(B, A, B)
    expect(shown(B)).toMatchObject([{ balance: 41000 }])
    // After the merge it is one row: the user clearing it is an edit like any
    // other (made after the merge, which stamped the row with the clock).
    await on(B, async () => {
      const row = (await db.accounts.filter((a) => !a.deleted).first())!
      const at = Date.now() + 1000
      await db.accounts.update(row.id!, { balance: 0, lastUpdated: at, updatedAt: at })
      await sync.syncNow()
    })
    await syncOn(A)
    expect(shown(A)).toMatchObject([{ balance: 0 }])
  })
})

describe('a device of $0 starter rows joins the accounts another device set up', () => {
  // The Mac: its connectors claimed and renamed two starter rows, the user
  // renamed the retirement row and typed its balance, and removed a fourth.
  const mac = () => [
    live('m-chk', 'simplefin', 'ACT-CHK', { name: 'Everyday Checking', institution: 'Test Bank', balance: 2400, lastUpdated: 9000, updatedAt: 9000 }),
    live('m-card', 'simplefin', 'ACT-CARD', { name: 'Rewards ··1111', institution: 'Test Card Co', type: 'credit', balance: 310, lastUpdated: 9000, updatedAt: 9000 }),
    manual('m-401', { name: 'My Plan', institution: 'Test Plan Co', type: 'retirement', balance: 41000, lastUpdated: 5000, updatedAt: 5000 }),
    { ...starter('m-sav', 'Savings', 'Other Test Bank', 'cash', 1000), deleted: true, updatedAt: 3000 },
  ]
  // The phone booted with the same seed later and never fetched a bank. One
  // starter row has no trace on the Mac at all.
  const phone = () => [
    starter('p-chk', 'Checking', 'Test Bank', 'cash'),
    starter('p-card', 'Card', 'Test Card Co', 'credit'),
    starter('p-401', 'Retirement Plan', 'Test Plan Co', 'retirement'),
    starter('p-sav', 'Savings', 'Other Test Bank', 'cash'),
    starter('p-hsa', 'Health Savings', 'Unlisted Test Co', 'benefit'),
  ]

  for (const first of ['Mac', 'phone'] as const) {
    it(`${first} first: each starter row folds into its account or its removal; only one with no trace arrives`, async () => {
      const A = device(mac())
      const B = device(phone())
      const before = { worth: netWorth(A), count: shown(A).length }
      await syncAll(...(first === 'Mac' ? [A, B, A, B] : [B, A, B, A]))
      for (const d of [A, B]) {
        expect(netWorth(d)).toBe(before.worth)
        // The Mac's three accounts, plus the starter row the Mac has no trace of ('No balance yet').
        expect(shown(d)).toHaveLength(before.count + 1)
        expect(shown(d).map((a) => `${a.institution}|${a.name}|${a.balance}`).sort()).toEqual([
          'Test Bank|Everyday Checking|2400',
          'Test Card Co|Rewards ··1111|310',
          'Test Plan Co|My Plan|41000',
          'Unlisted Test Co|Health Savings|0',
        ])
        expect(d.accounts.filter((a) => a.institution === 'Other Test Bank' && !a.deleted)).toEqual([])
      }
      expect(view(A)).toEqual(view(B))
      // Still live: the next bank fetch on the phone updates the Mac's row.
      await on(B, async () => {
        await brokerage.applySyncedAccounts(
          [{ sourceAccountId: 'ACT-CHK', institution: 'Test Bank', name: 'Everyday Checking', tier: 'cash', balance: 2500, currency: 'USD' }],
          'simplefin',
          { archiveMissing: false },
        )
      })
      expect(shown(B).filter((a) => a.sourceAccountId === 'ACT-CHK')).toMatchObject([{ balance: 2500 }])
      expect(shown(B)).toHaveLength(before.count + 1)
    })
  }

  it('a phone whose own bank fetch claimed a starter row merges to the same accounts', async () => {
    const A = device(mac())
    const B = device([
      live('p-chk', 'simplefin', 'ACT-CHK', { name: 'Everyday Checking', institution: 'Test Bank', balance: 2300, lastUpdated: 7000, updatedAt: 7000 }),
      starter('p-card', 'Card', 'Test Card Co', 'credit'),
      starter('p-401', 'Retirement Plan', 'Test Plan Co', 'retirement'),
      starter('p-sav', 'Savings', 'Other Test Bank', 'cash'),
    ])
    const before = { worth: netWorth(A), count: shown(A).length }
    await syncAll(B, A, B, A)
    for (const d of [A, B]) {
      expect(netWorth(d)).toBe(before.worth)
      expect(shown(d)).toHaveLength(before.count)
      expect(removedList(d)).toEqual([])
    }
    expect(view(A)).toEqual(view(B))
  })

  it('a balance the phone fetched after the Mac stays the newest, with a leftover starter row at that bank', async () => {
    // The phone fetched its bank after the Mac did; one starter row at that bank was left over.
    const phoneRows = () => [
      live('p-chk', 'simplefin', 'ACT-CHK', { name: 'Everyday Checking', institution: 'Test Bank', balance: 2550, lastUpdated: 12000, updatedAt: 12000 }),
      starter('p-left', 'Savings', 'Test Bank', 'cash'),
      starter('p-401', 'Retirement Plan', 'Test Plan Co', 'retirement'),
    ]
    const A = device()
    const B = device()
    for (const phoneFirst of [true, false]) {
      resetDevices(A, mac(), B, phoneRows())
      await syncAll(...(phoneFirst ? [B, A, B, A] : [A, B, A, B]))
      for (const d of [A, B]) {
        // Folding the leftover row must not make the Mac's older balance look newer.
        expect(shown(d).filter((a) => a.sourceAccountId === 'ACT-CHK')).toMatchObject([{ balance: 2550, lastUpdated: 12000 }])
        expect(netWorth(d)).toBe((2550 - 310 + 41000) * 100)
        expect(shown(d)).toHaveLength(3)
      }
      expect(view(A)).toEqual(view(B))
    }
  })

  it('a $0 account typed in after the first merge is never folded', async () => {
    const A = device(mac())
    const B = device()
    await syncAll(A, B)
    // The Mac's bank brings a new account at the same bank, while the phone has
    // an account just typed in (no balance yet) that has not synced.
    await on(A, async () => {
      await brokerage.applySyncedAccounts(
        [{ sourceAccountId: 'ACT-SAV', institution: 'Test Bank', name: 'Savings', tier: 'cash', balance: 800, currency: 'USD' }],
        'simplefin',
        { archiveMissing: false },
      )
      await sync.syncNow()
    })
    await on(B, async () => {
      await db.accounts.add({ name: 'Second Savings', institution: 'Test Bank', type: 'cash', balance: 0, liveSync: false, lastUpdated: 9500, sortOrder: 9, updatedAt: 9500 })
      await sync.syncNow()
    })
    await syncOn(A)
    for (const d of [A, B]) {
      expect(shown(d).filter((a) => a.institution === 'Test Bank').map((a) => a.name).sort()).toEqual(['Everyday Checking', 'Savings', 'Second Savings'])
    }
  })

  it('nor is one typed in on a device whose first merge found the cloud empty', async () => {
    const B = device()
    await syncOn(B) // nothing anywhere yet
    await on(B, async () => {
      await db.accounts.add({ name: 'Second Savings', institution: 'Test Bank', type: 'cash', balance: 0, liveSync: false, lastUpdated: 9500, sortOrder: 0, updatedAt: 9500 })
    })
    const A = device(mac())
    await syncOn(A) // the Mac's accounts reach the cloud before the phone's next sync
    await syncOn(B)
    await syncOn(A)
    for (const d of [A, B]) {
      expect(shown(d).filter((a) => a.institution === 'Test Bank').map((a) => a.name).sort()).toEqual(['Everyday Checking', 'Second Savings'])
    }
  })
})

describe('two devices whose first accounts syncs overlap', () => {
  /**
   * X syncs while the cloud is empty, then Y reads the empty cloud and X's
   * push lands just before Y's: neither read saw the other's account.
   */
  async function overlap(X: Device, Y: Device, opts: { failRecheck?: boolean; pushErrors?: boolean } = {}) {
    await syncOn(X)
    const xRows = new Map(h.state.tables.accounts)
    h.state.tables.accounts.clear()
    h.state.beforeUpsert = {
      table: 'accounts',
      run: () => {
        for (const [k, v] of xRows) h.state.tables.accounts.set(k, v)
        if (opts.failRecheck) h.state.failAccounts = true
        if (opts.pushErrors) h.state.accountsAnswerError = true
      },
    }
    await syncOn(Y)
    h.state.failAccounts = false
    h.state.accountsAnswerError = false
  }

  for (const [label, xFigure, yFigure] of [
    ['the later push holds the older figure', 41000, 39000],
    ['the later push holds the newer figure', 39000, 41000],
  ] as const) {
    it(`fold a hand-typed twin into one row with the newer figure (${label})`, async () => {
      const X = device([manual('x-401', { balance: xFigure, updatedAt: xFigure === 41000 ? 5000 : 4000 })])
      const Y = device([manual('y-401', { balance: yFigure, updatedAt: yFigure === 41000 ? 5000 : 4000 })])
      const kept = xFigure === 41000 ? 'x-401' : 'y-401'
      await overlap(X, Y)
      await syncAll(X, Y)
      for (const d of [X, Y]) {
        // The newer copy stays as it was: same uid, same stamp.
        expect(shown(d)).toMatchObject([{ uid: kept, balance: 41000, updatedAt: 5000 }])
        expect(netWorth(d)).toBe(41000 * 100)
      }
      expect(liveCloudHandTyped()).toMatchObject([{ id: kept, balance: 41000 }])
      expect(cloudAccounts().filter((r) => r.deleted).map((r) => r.id)).toEqual([kept === 'x-401' ? 'y-401' : 'x-401'])
    })
  }

  it('a $0 starter row on the later device still loses to the figure', async () => {
    const X = device([manual('x-401', { balance: 41000, updatedAt: 5000 })])
    const Y = device([starter('a-401', 'Retirement Plan', 'Test Plan Co', 'retirement', 6000)])
    await overlap(X, Y)
    await syncAll(X, Y)
    for (const d of [X, Y]) expect(shown(d)).toMatchObject([{ uid: 'x-401', balance: 41000 }])
  })

  it('a failed read right after the push leaves the fold to the next pull', async () => {
    const X = device([manual('a-401', { balance: 41000, updatedAt: 5000 })])
    const Y = device([manual('y-401', { balance: 39000, updatedAt: 4000 })])
    await overlap(X, Y, { failRecheck: true })
    expect(shown(Y)).toHaveLength(1) // not pulled yet
    await syncAll(Y, X)
    for (const d of [X, Y]) expect(shown(d)).toMatchObject([{ uid: 'a-401', balance: 41000 }])
  })

  it('a push that answered with an error but landed still folds at the next pull', async () => {
    const X = device([manual('a-401', { balance: 41000, updatedAt: 5000 })])
    const Y = device([manual('y-401', { balance: 39000, updatedAt: 4000 })])
    await overlap(X, Y, { pushErrors: true })
    expect(status).toBe('error')
    expect(h.state.tables.accounts.has('y-401')).toBe(true) // it landed all the same
    await syncAll(Y, X)
    for (const d of [X, Y]) expect(shown(d)).toMatchObject([{ uid: 'a-401', balance: 41000 }])
    expect(h.state.tables.accounts.get('y-401')).toMatchObject({ deleted: true })
  })

  it('never fold two rows the user typed on one device', async () => {
    const X = device([manual('x-1', { balance: 100 }), manual('x-2', { balance: 200 })])
    const Y = device([manual('y-1', { balance: 300 })])
    await overlap(X, Y)
    await syncAll(X, Y)
    for (const d of [X, Y]) expect(shown(d).map((a) => a.uid).sort()).toEqual(['x-1', 'x-2', 'y-1'])
  })

  it('a later sync with no overlap leaves the cloud as it is', async () => {
    const X = device([manual('a-401', { balance: 41000, updatedAt: 5000 })])
    const Y = device([manual('y-401', { balance: 39000, updatedAt: 4000 })])
    await overlap(X, Y)
    await syncAll(X, Y)
    const snap = JSON.stringify([...h.state.tables.accounts.entries()].sort())
    await syncAll(X, Y, X, Y)
    expect(JSON.stringify([...h.state.tables.accounts.entries()].sort())).toBe(snap)
  })
})

describe('B23 (d): a fresh device', () => {
  it('makes no accounts of its own before the pull, and a fetch after it adds none', async () => {
    const A = device([live('a-chk', 'simplefin', 'ACT-CHK', { balance: 2400 }), manual('a-401', { balance: 41000 })])
    await syncOn(A)
    const { seedIfEmpty } = await import('../db/seed')
    const B = device()
    await on(B, async () => {
      await seedIfEmpty()
      expect(await db.accounts.count()).toBe(0)
      await sync.syncNow()
      await brokerage.applySyncedAccounts(
        [{ sourceAccountId: 'ACT-CHK', institution: 'Test Bank', name: 'Checking', tier: 'cash', balance: 2500, currency: 'USD' }],
        'simplefin',
        { archiveMissing: false },
      )
    })
    expect(view(B)).toEqual(['a-401|Test Plan Co|Retirement Plan|retirement|41000', 'a-chk|Test Bank|Checking|cash|2500'])
  })
})

describe('B23 (f): a cloud without the accounts table', () => {
  it('syncs the ledger as before, leaves accounts alone, and asks again only after a while', async () => {
    h.state.noAccounts = true
    const A = device([manual('m-1'), live('l-1', 'simplefin', 'ACT-1')])
    const before = structuredClone(A.accounts)
    await on(A, async () => {
      await db.transactions.add({ uid: 't-1', date: '2026-01-05', amount: 12, type: 'expense', categoryId: null, account: '', note: 'CORNER STORE', createdAt: 1, updatedAt: 1 })
      expect(await sync.syncNow()).toBe('ok')
      expect(status).toBe('synced')
      expect(await sync.syncNow()).toBe('ok')
    })
    expect(A.accounts).toMatchObject(before)
    expect(h.state.tables.transactions.has('t-1')).toBe(true)
    expect(h.state.upserts.some((u) => u.table === 'accounts')).toBe(false)
    expect(h.state.selects.filter((t) => t === 'accounts')).toHaveLength(1)

    // The migration runs; a later sync (past the recheck) starts syncing accounts.
    h.state.noAccounts = false
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000)
    try {
      await syncOn(A)
    } finally {
      clock.mockRestore()
    }
    expect(cloudAccounts().map((r) => r.id).sort()).toEqual(['l-1', 'm-1'])
  })

  it('a failed accounts read still syncs the ledger, pushes no accounts, and says so', async () => {
    h.state.failAccounts = true
    const A = device([manual('m-1')])
    await on(A, async () => {
      await db.transactions.add({ uid: 't-1', date: '2026-01-05', amount: 12, type: 'expense', categoryId: null, account: '', note: 'CORNER STORE', createdAt: 1, updatedAt: 1 })
      expect(await sync.syncNow()).toBe('ok')
    })
    expect(status).toBe('error')
    expect(h.state.tables.transactions.has('t-1')).toBe(true)
    expect(h.state.upserts.some((u) => u.table === 'accounts')).toBe(false)
    expect(A.accounts).toMatchObject([{ uid: 'm-1', deleted: false }])
  })
})

describe('sign-out', () => {
  it('does not hold back for hand-typed accounts once they are in the cloud', async () => {
    const A = device([manual('m-1')])
    const r = await on(A, () => sync.signOutSync())
    expect(r).toEqual({ ok: true, local: false })
    expect(h.state.tables.accounts.get('m-1')).toMatchObject({ deleted: false, balance: 1000 })
  })
})

describe('what the user set on a live account reaches the other devices', () => {
  // The phone renames a bank account the Mac's connector fed, and sets a card
  // its bank reports at a positive figure to Credit. The Mac's next bank fetch
  // must keep both: the connector's own record (source_said) travels with the
  // row, so the Mac can tell the user's values from the bank's.
  const bankSaid = (balance: number, name = 'Rewards (9999)') =>
    [{ sourceAccountId: 'ACT-RW', institution: 'Test Bank', name, tier: 'cash' as const, balance, currency: 'USD' }]

  it('a rename and a type set on one device hold through a bank fetch on the other', async () => {
    const A = device()
    await on(A, () => brokerage.applySyncedAccounts(bankSaid(420), 'simplefin', { archiveMissing: false }))
    await syncOn(A)
    expect(h.state.tables.accounts.size).toBe(1)
    expect([...h.state.tables.accounts.values()][0]).toMatchObject({ source_said: { name: 'Rewards (9999)', type: 'cash', balance: 420 } })
    const B = device()
    await syncOn(B)
    await on(B, async () => {
      const row = (await db.accounts.toArray())[0]
      await db.accounts.update(row.id!, { name: 'Rewards card', type: 'credit', updatedAt: Date.now() })
      await sync.syncNow()
    })
    await syncOn(A)
    await on(A, () => brokerage.applySyncedAccounts(bankSaid(435), 'simplefin', { archiveMissing: false }))
    expect(shown(A)).toMatchObject([{ name: 'Rewards card', type: 'credit', balance: 435 }])
    expect(netWorth(A)).toBe(-43500)
    // A device that never fetched this bank before reads the record from the cloud.
    const C = device()
    await syncOn(C)
    await on(C, () => brokerage.applySyncedAccounts(bankSaid(440), 'simplefin', { archiveMissing: false }))
    expect(shown(C)).toMatchObject([{ name: 'Rewards card', type: 'credit', balance: 440 }])
  })

  it('a cloud without the column: the push goes without it, and the accounts still sync', async () => {
    h.state.missingAccountColumns.add('source_said')
    const A = device()
    await on(A, () => brokerage.applySyncedAccounts(bankSaid(420), 'simplefin', { archiveMissing: false }))
    expect(await syncOn(A)).toBe('ok')
    expect(status).toBe('synced')
    const sent = [...h.state.tables.accounts.values()]
    expect(sent).toHaveLength(1)
    expect('source_said' in sent[0]).toBe(false)
    // This device keeps its own record, so a rename here still holds here.
    await on(A, async () => {
      const row = (await db.accounts.toArray())[0]
      await db.accounts.update(row.id!, { name: 'Rewards card', updatedAt: Date.now() })
      await sync.syncNow()
      await brokerage.applySyncedAccounts(bankSaid(430), 'simplefin', { archiveMissing: false })
    })
    expect(shown(A)).toMatchObject([{ name: 'Rewards card', balance: 430, sourceSaid: { name: 'Rewards (9999)' } }])
  })
})

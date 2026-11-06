// @vitest-environment jsdom
/** The automatic copy of the ledger. The figures are invented. */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { db } from '../db/db'
import { defaultCategories } from '../db/seed'

const writes: string[] = []
let failWrites = false
/** A write waits for this, as one does when the app is suspended around it. */
let held: Promise<void> | null = null

async function postMessage({ method, args }: { method: string; args: { json?: string } }) {
  if (method === 'app.info') return { version: '1.0', build: '7' }
  if (method === 'backup.write') {
    if (held) {
      const waiting = held
      held = null
      await waiting
      throw new Error('unavailable')
    }
    if (failWrites) throw new Error('unavailable')
    writes.push(args.json!)
    return { name: 'backup-20261105-120000.json' }
  }
  throw new Error('unavailable')
}

const addRow = (note = 'Harbor Coffee') =>
  db.transactions.add({ date: '2026-11-03', amount: 4.5, type: 'expense', categoryId: null, account: '', note, createdAt: 1, updatedAt: 1 })

const loaded: { stopAutoBackup: () => void }[] = []

/** A fresh module each time: it starts once per page. */
const load = async () => {
  vi.resetModules()
  const module = await import('./autoBackup')
  loaded.push(module)
  return module
}

/** The write itself is IndexedDB and the bridge, which real time carries. */
const carried = async () => {
  vi.useRealTimers()
  await new Promise((r) => setTimeout(r, 30))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

const settle = async () => {
  await vi.advanceTimersByTimeAsync(20_000)
  await carried()
}

const turnTo = (state: 'hidden' | 'visible') => {
  const look = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  document.dispatchEvent(new Event('visibilitychange'))
  look.mockRestore()
}

/** The app goes to the background, or comes back, and what that starts is carried out. */
const appIs = async (state: 'hidden' | 'visible') => {
  turnTo(state)
  await carried()
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  writes.length = 0
  failWrites = false
  held = null
  localStorage.clear()
  vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })
  await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])
})

afterEach(() => {
  // Dexie's event is global, so a page from an earlier test is still listening.
  for (const module of loaded.splice(0)) module.stopAutoBackup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('startAutoBackup', () => {
  it('does nothing in a browser or the Mac app, not even listen', async () => {
    vi.unstubAllGlobals()
    const listen = vi.spyOn(document, 'addEventListener')
    await addRow()
    ;(await load()).startAutoBackup()
    await settle()
    expect(writes).toEqual([])
    expect(listen).not.toHaveBeenCalledWith('visibilitychange', expect.anything())
    listen.mockRestore()
  })

  it('writes one copy a while after a change', async () => {
    await addRow()
    ;(await load()).startAutoBackup()
    await vi.advanceTimersByTimeAsync(19_000)
    expect(writes).toEqual([])
    await settle()
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0])).toMatchObject({ format: 'tally-backup', app: '1.0 (7)', transactions: [{ note: 'Harbor Coffee' }] })
  })

  it('writes again after a later change, and waits for quiet', async () => {
    await addRow()
    const { startAutoBackup } = await load()
    startAutoBackup()
    await settle()
    await addRow('Corner Market')
    await vi.advanceTimersByTimeAsync(10_000)
    await addRow('Metro Fare')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(writes).toHaveLength(1)
    await settle()
    expect(writes).toHaveLength(2)
    expect(JSON.parse(writes[1]).transactions).toHaveLength(3)
  })

  it('does not write the same rows twice, whatever the clock says', async () => {
    await addRow()
    ;(await load()).startAutoBackup()
    await settle()
    ;(await load()).startAutoBackup() // the next launch
    await settle()
    expect(writes).toHaveLength(1)
  })

  it('writes at once when the app goes to the background', async () => {
    await addRow()
    ;(await load()).startAutoBackup()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 30))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(writes).toHaveLength(1)
    vi.restoreAllMocks()
  })

  it('never writes an empty ledger over the week of good ones', async () => {
    await db.categories.add({ name: 'Fun', icon: 'x', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 1 })
    await db.transactions.add({ date: '2026-11-03', amount: 1, type: 'expense', categoryId: null, account: '', note: 'x', deleted: true, createdAt: 1, updatedAt: 1 })
    ;(await load()).startAutoBackup()
    await settle()
    expect(writes).toEqual([])
  })

  it('writes nothing for a ledger of the defaults, whose budgets no one set', async () => {
    await db.categories.bulkAdd(defaultCategories(true))
    expect((await db.categories.toArray()).some((c) => c.monthlyBudget > 0)).toBe(true)
    ;(await load()).startAutoBackup()
    await settle()
    expect(writes).toEqual([])
  })

  it('writes the defaults once someone has changed a budget', async () => {
    await db.categories.bulkAdd(defaultCategories(true))
    await db.categories.where('name').equals('Dining').modify({ monthlyBudget: 275 })
    ;(await load()).startAutoBackup()
    await settle()
    expect(writes).toHaveLength(1)
  })

  it('counts budgets as worth keeping, for someone who has set them and spent nothing', async () => {
    await db.categories.add({ name: 'Fun', icon: 'x', color: '#fff', kind: 'expense', monthlyBudget: 50, sortOrder: 0, updatedAt: 1 })
    ;(await load()).startAutoBackup()
    await settle()
    expect(writes).toHaveLength(1)
  })

  it('tries again at the next change after a failed write', async () => {
    await addRow()
    failWrites = true
    const { startAutoBackup } = await load()
    startAutoBackup()
    await settle()
    failWrites = false
    await addRow('Corner Market')
    await settle()
    expect(writes).toHaveLength(1)
  })
})

describe('coming back to the app', () => {
  it('tries a copy again that failed on the way out, with nothing else to bring it back', async () => {
    await addRow()
    failWrites = true
    ;(await load()).startAutoBackup()
    await appIs('hidden')
    expect(writes).toEqual([])
    failWrites = false
    await appIs('visible')
    expect(writes).toHaveLength(1)
  })

  it('tries each time it comes back, until one goes through', async () => {
    await addRow()
    failWrites = true
    ;(await load()).startAutoBackup()
    await appIs('hidden')
    await appIs('visible')
    await appIs('hidden')
    await appIs('visible')
    expect(writes).toEqual([])
    failWrites = false
    await appIs('hidden')
    await appIs('visible')
    expect(writes).toHaveLength(1)
  })

  it('tries again when the write only fails after the app is back', async () => {
    await addRow()
    let letGo = () => {}
    held = new Promise((go) => (letGo = go))
    ;(await load()).startAutoBackup()
    await appIs('hidden')
    await appIs('visible')
    expect(writes).toEqual([])
    letGo()
    await carried()
    expect(writes).toHaveLength(1)
  })

  it('tries a copy again that failed on its quiet timer too', async () => {
    await addRow()
    failWrites = true
    ;(await load()).startAutoBackup()
    await settle()
    failWrites = false
    await appIs('visible')
    expect(writes).toHaveLength(1)
  })

  it('leaves a change alone that is waiting for quiet', async () => {
    await addRow()
    ;(await load()).startAutoBackup()
    turnTo('visible')
    await vi.advanceTimersByTimeAsync(19_000)
    await carried()
    expect(writes).toEqual([])
  })

  it('writes nothing when the last copy went through', async () => {
    await addRow()
    ;(await load()).startAutoBackup()
    await appIs('hidden')
    await appIs('visible')
    expect(writes).toHaveLength(1)
  })

  it('writes nothing once the ledger is being erased or replaced', async () => {
    await addRow()
    failWrites = true
    const { startAutoBackup, stopAutoBackup } = await load()
    startAutoBackup()
    await appIs('hidden')
    stopAutoBackup()
    failWrites = false
    await appIs('visible')
    expect(writes).toEqual([])
  })
})

describe('stopAutoBackup', () => {
  it('stops a write that was waiting, and any later one', async () => {
    await addRow()
    const { startAutoBackup, stopAutoBackup } = await load()
    startAutoBackup()
    stopAutoBackup()
    await addRow('Corner Market')
    await settle()
    expect(writes).toEqual([])
  })
})

describe('writeBackupNow', () => {
  it('saves what is here at once, whatever the last copy held', async () => {
    await addRow()
    const { startAutoBackup, writeBackupNow } = await load()
    startAutoBackup()
    await settle()
    vi.useRealTimers()
    await writeBackupNow()
    expect(writes).toHaveLength(2)
  })

  it('does nothing in a browser', async () => {
    vi.unstubAllGlobals()
    await addRow()
    vi.useRealTimers()
    await (await load()).writeBackupNow()
    expect(writes).toEqual([])
  })
})

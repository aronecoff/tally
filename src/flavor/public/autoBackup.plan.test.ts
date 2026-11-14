// @vitest-environment jsdom
/**
 * In the public app the savings plan travels in the automatic copy, because the
 * phone holds the only one: a change to the plan reaches the next copy without
 * waiting for a write to the ledger. The figures are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/db'

const writes: string[] = []

async function postMessage({ method, args }: { method: string; args: { json?: string } }) {
  if (method === 'app.info') return { version: '1.0', build: '7' }
  if (method === 'backup.write') {
    writes.push(args.json!)
    return { name: 'backup-20311105-120000.json' }
  }
  throw new Error('unavailable')
}

const loaded: { stopAutoBackup: () => void }[] = []
const settle = async () => {
  await vi.advanceTimersByTimeAsync(20_000)
  vi.useRealTimers()
  await new Promise((r) => setTimeout(r, 30))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  writes.length = 0
  localStorage.clear()
  vi.stubGlobal('webkit', { messageHandlers: { plainsum: { postMessage } } })
  await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])
  await db.transactions.add({ date: '2031-11-03', amount: 4.5, type: 'expense', categoryId: null, account: '', note: 'Harbor Coffee', createdAt: 1, updatedAt: 1 })
})

afterEach(() => {
  for (const module of loaded.splice(0)) module.stopAutoBackup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('the automatic copy', () => {
  it('is written again when the plan changes, and holds the plan', async () => {
    vi.resetModules()
    const auto = await import('../../lib/autoBackup')
    loaded.push(auto)
    const { setPlan } = await import('../../lib/planCache')
    auto.startAutoBackup()
    await settle()
    expect(writes).toHaveLength(1)
    expect('tally:savingsPlan:v1' in JSON.parse(writes[0]).prefs).toBe(false)

    const plan = { goal: 800, cap: 3000, locked: true, since: '2031-12', pending: null, updatedAt: 1 }
    setPlan(plan)
    await settle()
    expect(writes).toHaveLength(2)
    expect(JSON.parse(JSON.parse(writes[1]).prefs['tally:savingsPlan:v1'])).toEqual(plan)
    setPlan(null)
  })
})

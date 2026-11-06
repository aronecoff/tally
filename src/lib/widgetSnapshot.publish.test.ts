// @vitest-environment jsdom
/** When the widget's figures go to the app. The figures are invented. */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import type { WidgetSnapshot } from './widgetSnapshot'

const sent: WidgetSnapshot[] = []
let failing = false

async function postMessage({ method, args }: { method: string; args: WidgetSnapshot }) {
  if (method !== 'widget.publish' || failing) throw new Error('unavailable')
  sent.push(args)
  return { written: true }
}

const addRow = (amount = 4.5) =>
  db.transactions.add({ date: new Date().toLocaleDateString('en-CA'), amount, type: 'expense', categoryId: 1, account: '', note: 'Harbor Coffee', createdAt: 1, updatedAt: 1 })

const addCategory = () =>
  db.categories.add({ id: 1, name: 'Dining', icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget: 100, sortOrder: 0, updatedAt: 1 })

const loaded: { stopWidgetSnapshot: () => void }[] = []

/** A fresh module each time: it starts once per page. */
const load = async () => {
  vi.resetModules()
  const module = await import('./widgetSnapshot')
  loaded.push(module)
  return module
}

const settle = async () => {
  await vi.advanceTimersByTimeAsync(1500)
  // The read itself is IndexedDB and the bridge, which real time carries.
  vi.useRealTimers()
  await new Promise((r) => setTimeout(r, 30))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

let visibility: DocumentVisibilityState = 'visible'
const goTo = (state: DocumentVisibilityState) => {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  sent.length = 0
  failing = false
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })
  await addCategory()
})

afterEach(async () => {
  // Each load added page-wide listeners, which a stopped module ignores.
  for (const m of loaded.splice(0)) m.stopWidgetSnapshot()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await db.transactions.clear()
  await db.categories.clear()
})

describe('Publishing the widget', () => {
  it('does nothing without the app around the page, not even listen', async () => {
    vi.unstubAllGlobals()
    const listen = vi.spyOn(document, 'addEventListener')
    const { startWidgetSnapshot } = await load()
    startWidgetSnapshot()
    await addRow()
    await settle()
    expect(sent).toEqual([])
    expect(listen).not.toHaveBeenCalledWith('visibilitychange', expect.anything())
  })

  it('publishes once the app has started', async () => {
    ;(await load()).startWidgetSnapshot()
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ v: 1, whole: '$100', cents: '.00', unit: 'left' })
  })

  it('starts once', async () => {
    const { startWidgetSnapshot } = await load()
    startWidgetSnapshot()
    startWidgetSnapshot()
    await settle()
    expect(sent).toHaveLength(1)
  })

  it('follows a change in the ledger, once for a burst of them', async () => {
    ;(await load()).startWidgetSnapshot()
    await settle()
    await addRow(10)
    await addRow(20)
    await settle()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ whole: '$70', cents: '.00' })
  })

  it('stays quiet when a write leaves the figures as they were', async () => {
    ;(await load()).startWidgetSnapshot()
    await settle()
    await db.accounts.add({ institution: 'Test Bank', name: 'Checking', type: 'cash', balance: 5, liveSync: false, lastUpdated: 1, sortOrder: 0, updatedAt: 1 })
    await settle()
    expect(sent).toHaveLength(1)
  })

  it('coming back says the figures were read just now, even if they are the same', async () => {
    ;(await load()).startWidgetSnapshot()
    await settle()
    goTo('hidden')
    await settle()
    expect(sent).toHaveLength(1)
    goTo('visible')
    await settle()
    expect(sent).toHaveLength(2)
  })

  it('leaving sends what has not gone yet, without waiting for the quiet', async () => {
    ;(await load()).startWidgetSnapshot()
    await settle()
    await addRow(10)
    goTo('hidden')
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 30))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ whole: '$90', cents: '.00' })
  })

  it('keeps its order, however the calls bunch up', async () => {
    ;(await load()).startWidgetSnapshot()
    goTo('hidden')
    goTo('visible')
    await addRow(10)
    goTo('hidden')
    await settle()
    expect(sent.at(-1)).toMatchObject({ whole: '$90', cents: '.00' })
    expect(sent.map((s) => s.asOf)).toEqual(sent.map((s) => s.asOf).sort((a, b) => a - b))
  })

  it('a failed publish tries again at the next change', async () => {
    ;(await load()).startWidgetSnapshot()
    await settle()
    failing = true
    await addRow(10)
    await settle()
    expect(sent).toHaveLength(1)
    failing = false
    await db.accounts.add({ institution: 'Test Bank', name: 'Checking', type: 'cash', balance: 5, liveSync: false, lastUpdated: 1, sortOrder: 0, updatedAt: 1 })
    await settle()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ whole: '$90', cents: '.00' })
  })

  it('an app from before widgets answers unavailable, and the page carries on', async () => {
    failing = true
    ;(await load()).startWidgetSnapshot()
    await settle()
    expect(sent).toEqual([])
  })

  it('sends nothing once stopped, and catches up if the erase failed', async () => {
    const { startWidgetSnapshot, stopWidgetSnapshot, resumeWidgetSnapshot } = await load()
    startWidgetSnapshot()
    await settle()
    stopWidgetSnapshot()
    await addRow(10)
    await settle()
    goTo('hidden')
    goTo('visible')
    await settle()
    expect(sent).toHaveLength(1)
    resumeWidgetSnapshot()
    await settle()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ whole: '$90', cents: '.00' })
  })

  it('stopped mid-read, it still sends nothing', async () => {
    const { startWidgetSnapshot, stopWidgetSnapshot } = await load()
    startWidgetSnapshot()
    stopWidgetSnapshot() // the first read is in flight
    await settle()
    expect(sent).toEqual([])
  })
})

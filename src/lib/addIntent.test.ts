// @vitest-environment jsdom
/**
 * "Add expense" from Siri and Shortcuts: the page takes what the app holds as it starts,
 * and again when nudged. What comes through the door is not trusted to be an amount.
 * Values are invented.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startAddIntent, type AddPrefill } from './addIntent'

const flush = () => new Promise((r) => setTimeout(r, 0))
const nudge = () => window.dispatchEvent(new Event('app:add-expense'))

/** An app holding these asks, handed out one per question, as AddExpenseInbox does. */
function app(...asks: Record<string, unknown>[]) {
  const postMessage = vi.fn(async () => asks.shift() ?? {})
  vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })
  return postMessage
}

function start() {
  const opened: AddPrefill[] = []
  stop = startAddIntent((p) => opened.push(p))
  return opened
}
let stop = () => {}

afterEach(() => {
  stop()
  vi.unstubAllGlobals()
})

describe('taking an ask', () => {
  it('finds one that launched the app', async () => {
    const postMessage = app({ amount: 12.5, note: 'Sample Cafe' })
    const opened = start()
    await flush()
    expect(postMessage).toHaveBeenCalledWith({ method: 'addExpense.take', args: {} })
    expect(opened).toMatchObject([{ amount: '12.50', note: 'Sample Cafe' }])
  })

  it('opens nothing when nothing is waiting', async () => {
    app()
    const opened = start()
    await flush()
    expect(opened).toEqual([])
  })

  it('takes one that arrives while the page is up, when nudged', async () => {
    const postMessage = app()
    const opened = start()
    await flush()
    postMessage.mockResolvedValueOnce({ amount: 8 })
    nudge()
    await flush()
    expect(opened).toMatchObject([{ amount: '8.00', note: '' }])
  })

  it('tells the same words apart, so each ask opens afresh', async () => {
    app({ amount: 3 }, { amount: 3 })
    const opened = start()
    await flush()
    nudge()
    await flush()
    expect(opened).toHaveLength(2)
    expect(opened[0].n).not.toBe(opened[1].n)
  })

  it('stops listening when told', async () => {
    const postMessage = app()
    start()
    await flush()
    stop()
    nudge()
    await flush()
    expect(postMessage).toHaveBeenCalledOnce()
  })
})

describe('where there is no door', () => {
  it('does nothing in a browser and in the Mac app, and leaves nothing listening', async () => {
    const listen = vi.spyOn(window, 'addEventListener')
    const opened = start()
    nudge()
    await flush()
    expect(opened).toEqual([])
    expect(listen).not.toHaveBeenCalled()
    listen.mockRestore()
  })

  it('costs nothing on an older app with no such method', async () => {
    const postMessage = vi.fn(async () => {
      throw new Error('unavailable')
    })
    vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })
    const opened = start()
    await flush()
    expect(postMessage).toHaveBeenCalledOnce()
    expect(opened).toEqual([])
  })
})

describe('what comes through', () => {
  const taken = async (ask: Record<string, unknown>) => {
    app(ask)
    const opened = start()
    await flush()
    stop()
    return opened[0]
  }

  it('reads an amount the way the field holds one', async () => {
    expect((await taken({ amount: 4.1 })).amount).toBe('4.10')
    expect((await taken({ amount: 1250 })).amount).toBe('1250.00')
  })

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1e9, '12', null])('leaves the amount empty for %s, and still opens', async (amount) => {
    expect((await taken({ amount, note: 'Sample Shop' }))).toMatchObject({ amount: '', note: 'Sample Shop' })
  })

  it('trims the note and keeps it to a line of sensible length', async () => {
    expect((await taken({ amount: 1, note: '  Sample Shop  ' })).note).toBe('Sample Shop')
    expect((await taken({ amount: 1, note: 'x'.repeat(500) })).note).toHaveLength(200)
    expect((await taken({ amount: 1, note: 42 })).note).toBe('')
  })
})

// @vitest-environment jsdom
/**
 * useKeyedLiveQuery's load for a stepped-to month serves that one step only.
 * Values are invented.
 *  - B64 follow-up: a load kept for a while after it settled was handed back on
 *    a later visit, so a month edited in between flashed its rows from before
 *    the edit until the live query answered.
 *  - A failed load must reach the error boundary (so RootBoundary can reopen
 *    the database), and must not be rethrown on a later visit after recovery.
 */
import 'fake-indexeddb/auto'
import { Component, Fragment, Suspense, startTransition, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { db, type Transaction } from '../db/db'
import { useKeyedLiveQuery } from './useKeyedLiveQuery'

const SEP = '2026-09'
const AUG = '2026-08'
const row = (id: number, date: string, amount: number): Transaction => ({
  id, date, amount, type: 'expense', categoryId: null, account: 'Card', note: `Shop ${id}`, createdAt: 0, updatedAt: 0,
})

/** Every read of a month, and the months whose next reads fail. */
const reads: string[] = []
const failing = new Map<string, number>()
async function read(month: string) {
  reads.push(month)
  const left = failing.get(month) ?? 0
  if (left > 0) {
    failing.set(month, left - 1)
    throw new Error('Connection to Indexed Database server lost')
  }
  return db.transactions.where('date').startsWith(month).toArray()
}

function Probe({ month }: { month: string }) {
  const rows = useKeyedLiveQuery(month, () => read(month))
  return <p data-testid="out">{rows === undefined ? 'loading' : `${month}: ${rows.map((r) => r.amount).join(',')}`}</p>
}

/** Like RootBoundary: on an error, remount the children, up to `tries` times. */
class Recover extends Component<
  { children: ReactNode; tries: number; onError: (e: unknown) => void },
  { failed: boolean; n: number }
> {
  state = { failed: false, n: 0 }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    this.props.onError(e)
    if (this.state.n < this.props.tries) this.setState((s) => ({ failed: false, n: s.n + 1 }))
  }
  render() {
    if (this.state.failed) return <p data-testid="out">failed</p>
    return <Fragment key={this.state.n}>{this.props.children}</Fragment>
  }
}

function Harness({ tries, onError }: { tries: number; onError: (e: unknown) => void }) {
  const [month, setMonth] = useState(SEP)
  return (
    <>
      {/* MonthSwitch steps inside a transition; B29/B30 set the month directly. */}
      <button onClick={() => startTransition(() => setMonth(AUG))}>August</button>
      <button onClick={() => startTransition(() => setMonth(SEP))}>September</button>
      <button onClick={() => setMonth(AUG)}>August now</button>
      <Recover tries={tries} onError={onError}>
        <Suspense fallback={<p data-testid="out">fallback</p>}>
          <Probe month={month} />
        </Suspense>
      </Recover>
    </>
  )
}

const out = () => screen.getByTestId('out').textContent
const tap = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
let consoleError: ReturnType<typeof vi.spyOn>
const uncached = () => consoleError.mock.calls.filter((c: unknown[]) => String(c[0]).includes('uncached promise'))

beforeEach(async () => {
  reads.length = 0
  failing.clear()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  await db.transactions.bulkAdd([row(1, '2026-09-10', 111), row(2, '2026-08-10', 444)])
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await db.transactions.clear()
})

describe('useKeyedLiveQuery', () => {
  it('coming back to a month after an edit reads it again, never the rows from before', async () => {
    render(<Harness tries={0} onError={() => {}} />)
    await waitFor(() => expect(out()).toBe('2026-09: 111'))
    await tap('August')
    await waitFor(() => expect(out()).toBe('2026-08: 444'))
    await act(async () => {
      await db.transactions.update(2, { amount: 500 })
    })
    await waitFor(() => expect(out()).toBe('2026-08: 500'))
    await tap('September')
    await waitFor(() => expect(out()).toBe('2026-09: 111'))

    const seen: (string | null)[] = []
    const mo = new MutationObserver(() => seen.push(out()))
    mo.observe(document.body, { subtree: true, childList: true, characterData: true })
    await tap('August')
    await waitFor(() => expect(out()).toBe('2026-08: 500'))
    mo.disconnect()
    expect(seen).not.toContain('2026-08: 444')
    // The retry render after each suspend found its own load again.
    expect(uncached()).toEqual([])
  })

  it('a failed load is not rethrown on a later visit after the boundary recovered', async () => {
    const onError = vi.fn()
    render(<Harness tries={3} onError={onError} />)
    await waitFor(() => expect(out()).toBe('2026-09: 111'))
    failing.set(AUG, 1)
    await tap('August')
    // The failure reached the boundary, which remounted; August then read fine.
    await waitFor(() => expect(out()).toBe('2026-08: 444'))
    expect(onError).toHaveBeenCalledTimes(1)
    await tap('September')
    await waitFor(() => expect(out()).toBe('2026-09: 111'))
    await tap('August')
    await waitFor(() => expect(out()).toBe('2026-08: 444'))
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('a failure that persists reaches the boundary, set directly or in a transition, with no loop of reads', async () => {
    for (const button of ['August now', 'August']) {
      const onError = vi.fn()
      const view = render(<Harness tries={0} onError={onError} />)
      await waitFor(() => expect(out()).toBe('2026-09: 111'))
      failing.set(AUG, 1000)
      reads.length = 0
      // A plain click, outside act(): React schedules the retries itself, as in
      // the app. (Inside act() React replays the very load it suspended on,
      // which hides a hook that drops a failed load and reads again.)
      screen.getByRole('button', { name: button }).click()
      await waitFor(() => expect(out()).toBe('failed'))
      expect(onError).toHaveBeenCalledTimes(1)
      expect(reads.filter((m) => m === AUG).length).toBeLessThanOrEqual(2)
      view.unmount()
      failing.clear()
    }
  })
})

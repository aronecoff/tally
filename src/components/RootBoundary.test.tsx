// @vitest-environment jsdom
/**
 * B66: one failed IndexedDB read (WebKit's 'Connection to Indexed Database
 * server lost', an UnknownError) used to unmount the whole app and leave an
 * empty page. The root boundary reopens the database and remounts the app,
 * gives up after three tries, and offers Reload for anything else.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { db } from '../db/db'
import { RootBoundary } from './RootBoundary'

/** Throws while the connection is "lost"; a reopen of the database heals it. */
const conn = { lost: false, heals: true }
function App() {
  if (conn.lost) throw new Dexie.UnknownError('Connection to Indexed Database server lost. Refresh the page to try again')
  return <p>Tally is here</p>
}

let openSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  conn.lost = false
  conn.heals = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await db.open()
  const realOpen = db.open.bind(db)
  openSpy = vi.spyOn(db, 'open').mockImplementation(() => {
    if (conn.heals) conn.lost = false
    return realOpen()
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RootBoundary', () => {
  it('a lost IndexedDB connection reopens the database and brings the app back', async () => {
    const view = render(
      <RootBoundary>
        <App />
      </RootBoundary>,
    )
    expect(screen.getByText('Tally is here')).toBeTruthy()
    conn.lost = true
    view.rerender(
      <RootBoundary>
        <App />
      </RootBoundary>,
    )
    await waitFor(() => expect(screen.getByText('Tally is here')).toBeTruthy())
    expect(openSpy).toHaveBeenCalled()
    expect(db.isOpen()).toBe(true)
    // The database still answers after the reopen.
    await expect(db.categories.count()).resolves.toBeGreaterThanOrEqual(0)
  })

  it('a failure that never heals stops after three tries and offers Reload', async () => {
    conn.heals = false
    conn.lost = true
    const reload = vi.fn()
    render(
      <RootBoundary reload={reload}>
        <App />
      </RootBoundary>,
    )
    const btn = await screen.findByRole('button', { name: 'Reload' })
    expect(openSpy).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('alert').textContent).toMatch(/could not read/i)
    fireEvent.click(btn)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('an error that is not the database offers Reload at once', async () => {
    function Broken(): never {
      throw new TypeError('x is undefined')
    }
    render(
      <RootBoundary>
        <Broken />
      </RootBoundary>,
    )
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy()
    expect(openSpy).not.toHaveBeenCalled()
  })
})

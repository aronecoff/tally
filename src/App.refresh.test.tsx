// @vitest-environment jsdom
/**
 * B62: a successful 'Refresh balances' jumps to Insights only when the user
 * is still looking at Accounts with nothing open over it. Leaving for another
 * screen, or opening a sheet, while it ran used to switch the pane to Insights
 * behind their back. Values are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { db } from './db/db'
import type { ConnectorResult } from './lib/banks'

const h = vi.hoisted(() => ({
  release: null as null | ((r: ConnectorResult) => void),
}))

vi.mock('./db/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  },
}))
vi.mock('./sync/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync/sync')>()),
  initSync: vi.fn(),
}))
vi.mock('./lib/banks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/banks')>()),
  // The tap's run (the only caller passing options) waits until the test
  // releases it; every other run (boot, the screen's auto refresh) answers at once.
  syncAllConnectors: vi.fn((opts?: { force?: boolean }) =>
    opts
      ? new Promise<ConnectorResult>((r) => (h.release = r))
      : Promise.resolve({ total: 1, errors: [], warnings: [], bankErrors: [] }),
  ),
}))

import App from './App'

const OK: ConnectorResult = { total: 1, errors: [], warnings: [], bankErrors: [], bankSkipped: false }
const visiblePane = () => document.querySelector('section.pane:not([hidden])') as HTMLElement
const tab = (name: string) => within(document.querySelector('nav.tabbar') as HTMLElement).getByRole('button', { name })
const tap = (el: Element) =>
  act(async () => {
    fireEvent.click(el)
  })

async function tapRefresh() {
  history.replaceState(null, '', '#accounts')
  render(<App />)
  await waitFor(() => expect(visiblePane()?.dataset.screen).toBe('accounts'))
  const row = await screen.findByText('Refresh balances')
  await tap(row.closest('button')!)
  await waitFor(() => expect(h.release).not.toBeNull())
}
const finish = () =>
  act(async () => {
    h.release!(OK)
    await new Promise((r) => setTimeout(r, 20))
  })

beforeEach(async () => {
  h.release = null
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  sessionStorage.clear()
  await db.categories.bulkAdd([{ id: 1, name: 'Groceries', icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget: 500, sortOrder: 1, updatedAt: 0 }])
  await db.accounts.add({ institution: 'Test Bank', name: 'Checking', type: 'cash', balance: 1000, liveSync: false, lastUpdated: Date.now(), sortOrder: 0, updatedAt: 1 })
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await db.accounts.clear()
  await db.categories.clear()
})

describe("B62: where 'Refresh balances' lands", () => {
  it('still on Accounts with nothing open: Insights', async () => {
    await tapRefresh()
    await finish()
    await waitFor(() => expect(visiblePane().dataset.screen).toBe('insights'))
  })

  it('moved to Activity and opened a sheet: stays there, sheet and all', async () => {
    await tapRefresh()
    await tap(tab('Activity'))
    await tap(screen.getAllByTestId('add-txn')[0])
    expect(document.querySelector('.sheet')).not.toBeNull()
    await finish()
    expect(visiblePane().dataset.screen).toBe('activity')
    expect(document.querySelector('.sheet')).not.toBeNull()
  })

  it('moved to Home: stays on Home', async () => {
    await tapRefresh()
    await tap(tab('Home'))
    await finish()
    expect(visiblePane().dataset.screen).toBe('home')
  })

  it('still on Accounts but a sheet opened after the tap: stays on Accounts', async () => {
    await tapRefresh()
    await tap(screen.getAllByTestId('settings-btn')[0])
    expect(document.querySelector('.sheet')).not.toBeNull()
    await finish()
    expect(visiblePane().dataset.screen).toBe('accounts')
  })
})

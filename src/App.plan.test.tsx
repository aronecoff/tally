// @vitest-environment jsdom
/**
 * When the app asks the account for the savings plan again: wherever it already
 * refreshes (focus, a sign-in), and after each sync, so a change made on one
 * device reaches another open one without waiting for a focus event.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { db } from './db/db'
import type { SyncSnapshot } from './sync/sync'

const h = vi.hoisted(() => ({
  listeners: new Set<(s: SyncSnapshot) => void>(),
  loads: [] as unknown[],
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
  subscribeSync: (l: (s: SyncSnapshot) => void) => {
    h.listeners.add(l)
    l({ email: null, status: 'signedout', lastSyncedAt: null, error: null })
    return () => void h.listeners.delete(l)
  },
}))
vi.mock('./lib/banks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/banks')>()),
  syncAllConnectors: vi.fn(async () => ({ total: 0, errors: [], warnings: [], bankErrors: [] })),
}))
vi.mock('./lib/planStore', () => ({
  loadSavingsPlan: vi.fn(async (opts?: unknown) => {
    h.loads.push(opts)
    return true
  }),
  planCanSave: vi.fn(async () => false),
  saveSavingsPlan: vi.fn(),
}))

import App from './App'

const emit = (s: Partial<SyncSnapshot>) =>
  act(async () => {
    for (const l of h.listeners) l({ email: null, status: 'idle', lastSyncedAt: null, error: null, ...s })
  })

beforeEach(async () => {
  h.loads.length = 0
  h.listeners.clear()
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
  history.replaceState(null, '', '#home')
  render(<App />)
  await waitFor(() => expect(document.querySelector('section.pane:not([hidden])')).not.toBeNull())
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await db.categories.clear()
})

describe('reading the savings plan again', () => {
  it('when the window comes forward', async () => {
    await act(async () => void window.dispatchEvent(new Event('focus')))
    expect(h.loads).toEqual([undefined])
  })

  it('the moment a session signs in', async () => {
    await emit({ email: 'someone@example.com' })
    expect(h.loads).toEqual([undefined])
    // Still signed in: not a new edge.
    await emit({ email: 'someone@example.com' })
    expect(h.loads).toEqual([undefined])
  })

  it('after a sync, only if the last read is stale', async () => {
    await emit({ email: 'someone@example.com' })
    h.loads.length = 0
    await emit({ email: 'someone@example.com', status: 'syncing' })
    expect(h.loads).toEqual([])
    await emit({ email: 'someone@example.com', status: 'synced' })
    expect(h.loads).toEqual([{ ifStale: true }])
  })
})

// @vitest-environment jsdom
/** The app starts its alert check once the ledger is ready. Its rules are in lib/budgetAlerts.test.ts. */
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import App from './App'

vi.mock('./db/supabase', () => ({ supabase: null }))
vi.mock('./lib/banks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/banks')>()),
  syncAllConnectors: vi.fn(async () => {}),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('looks at the budgets once the app has started', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  const asked: string[] = []
  const postMessage = async ({ method }: { method: string }) => {
    asked.push(method)
    throw new Error('unavailable')
  }
  vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })
  render(<App />)
  await waitFor(() => expect(asked).toContain('alerts.status'))
})

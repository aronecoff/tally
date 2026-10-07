// @vitest-environment jsdom
/**
 * B114: on desktop Home's header repeated the sidebar's 'Tally' brand. The
 * header heading carries both words; shell.css shows the brand on the phone
 * and 'Home' from 920px (styles/visual.test.ts pins that rule).
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { db } from './db/db'
import App from './App'

vi.mock('./db/supabase', () => ({ supabase: null }))
vi.mock('./lib/banks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/banks')>()),
  syncAllConnectors: vi.fn(async () => {}),
}))

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
  )
  Element.prototype.scrollIntoView = vi.fn()
  history.replaceState(null, '', '#home')
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await db.transactions.clear()
  await db.categories.clear()
})

describe('B114: the Home header', () => {
  it('holds the brand for the phone and "Home" for the desktop', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('section.pane:not([hidden])')?.getAttribute('aria-busy')).toBeNull())
    const h1 = document.querySelector('.app-head h1.head-brand')!
    expect(h1.querySelector('.head-brand-mark')?.textContent).toBe(' Tally')
    expect(h1.querySelector('.head-brand-mark svg')).not.toBeNull()
    expect(h1.querySelector('.head-brand-desk')?.textContent).toBe('Home')
  })
})

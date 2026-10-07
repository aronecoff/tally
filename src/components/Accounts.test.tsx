// @vitest-environment jsdom
/**
 * A card can hold a credit in your favour (a refund after it was paid off).
 * It is stored as a negative amount owed, and it used to be drawn exactly like
 * money owed ('−$125.50'), so the Credit rows did not add up to their total.
 * Values are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { Accounts } from './Accounts'
import { db, type Account } from '../db/db'

const acct = (id: number, name: string, type: Account['type'], balance: number): Account => ({
  id, name, institution: 'Test Bank', type, balance, liveSync: false, lastUpdated: Date.now(), sortOrder: id, updatedAt: 0,
})

afterEach(async () => {
  cleanup()
  await db.accounts.clear()
})

describe('Accounts: a card in credit', () => {
  it('reads as a credit, and the Credit rows add up to their total', async () => {
    await db.accounts.bulkAdd([acct(1, 'Checking', 'cash', 1000), acct(2, 'Freedom', 'credit', 500), acct(3, 'Rewards', 'credit', -125.5)])
    const { container } = render(<Accounts active />)
    await waitFor(() => expect(container.querySelector('.acct-list')).not.toBeNull())
    const credit = [...container.querySelectorAll('.tier')].find((t) => t.querySelector('.tier-label')?.textContent?.includes('Credit'))!
    const bals = [...credit.querySelectorAll('.acct-bal')].map((b) => b.textContent)
    expect(bals).toEqual(['−$500.00', '+$125.50 credit'])
    expect(credit.querySelector('.acct-bal .pos')?.textContent).toBe('+$125.50 credit')
    expect(credit.querySelector('.tier-total')?.textContent).toBe('−$374.50')
    const tile = container.querySelector('.nwmap-tile[aria-label^="Test Bank Rewards"]')
    expect(tile?.getAttribute('aria-label')).toBe('Test Bank Rewards, credit $125.50')
    expect(container.querySelector('.nwmap-tile[aria-label^="Test Bank Freedom"]')?.getAttribute('aria-label')).toBe('Test Bank Freedom, owed $500.00')
  })
})

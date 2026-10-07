// @vitest-environment jsdom
/**
 * Accounts map and rows. Values are invented.
 *  - B68: a tall narrow tile (a card owed) was left blank while smaller tiles
 *    were labelled; it now reads its amount up the side.
 *  - B109: a balance too small to draw (a few dollars next to thousands) drew
 *    a stray 2px stripe outside the map; it is left out of the map.
 *  - B107: a live card at $0 (paid off) read 'No balance yet'.
 *  - B113: 'Updated ' is its own part, so a 320px screen can drop it.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { Accounts } from './Accounts'
import { db, type Account } from '../db/db'

const HOUR = 3600_000
const acct = (id: number, name: string, type: Account['type'], balance: number, extra: Partial<Account> = {}): Account => ({
  id, name, institution: 'Test Bank', type, balance, liveSync: false, lastUpdated: Date.now(), sortOrder: id, updatedAt: 0, ...extra,
})

/** jsdom has no layout: give the map a width (a 320px screen less its gutters). */
function withMapWidth(px: number) {
  const proto = HTMLElement.prototype
  const orig = proto.getBoundingClientRect
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (!this.classList.contains('nwmap')) return orig.call(this)
    const h = px * 0.64
    return { x: 0, y: 0, left: 0, top: 0, right: px, bottom: h, width: px, height: h, toJSON: () => ({}) } as DOMRect
  }
  return () => {
    proto.getBoundingClientRect = orig
  }
}

let restore: (() => void) | null = null
beforeEach(() => {
  // No canvas in jsdom: amounts are measured by the per-character estimate.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(async () => {
  cleanup()
  restore?.()
  restore = null
  vi.restoreAllMocks()
  await db.accounts.clear()
})

async function renderAccounts(rows: Account[]) {
  await db.accounts.bulkAdd(rows)
  const view = render(<Accounts active />)
  await waitFor(() => expect(view.container.querySelector('.acct-list')).not.toBeNull())
  return view.container
}

const tile = (root: HTMLElement, label: string) => root.querySelector(`.nwmap-tile[aria-label^="Test Bank ${label}"]`)

describe('B68: the balance map', () => {
  it('a tall narrow tile reads its amount up the side', async () => {
    restore = withMapWidth(288)
    const root = await renderAccounts([acct(1, 'Checking', 'cash', 10000), acct(2, 'Card', 'credit', 1200)])
    // The card is about 27px wide and 180px tall: '−$1,200' does not fit across.
    const label = tile(root, 'Card')?.querySelector('.nwmap-label')
    expect(label?.classList.contains('vert')).toBe(true)
    expect(label?.querySelector('.nwmap-amt')?.textContent).toBe('−$1,200')
    // No name on a vertical label: the amount alone.
    expect(label?.querySelector('.nwmap-name')).toBeNull()
    expect(tile(root, 'Checking')?.querySelector('.nwmap-label.vert')).toBeNull()
  })
})

describe('B109: a balance too small to draw', () => {
  it('is left out of the map, and still listed in its tier', async () => {
    restore = withMapWidth(288)
    const root = await renderAccounts([acct(1, 'Checking', 'cash', 25000), acct(2, 'Brokerage', 'brokerage', 3.21)])
    expect(tile(root, 'Checking')).not.toBeNull()
    expect(tile(root, 'Brokerage')).toBeNull()
    expect([...root.querySelectorAll('.acct-bal')].map((b) => b.textContent)).toContain('$3.21')
  })

  it('is kept before the map has been measured (a hidden pane)', async () => {
    const root = await renderAccounts([acct(1, 'Checking', 'cash', 25000), acct(2, 'Brokerage', 'brokerage', 3.21)])
    expect(root.querySelectorAll('.nwmap-tile')).toHaveLength(2)
  })
})

describe('B107 + B113: the row sub-line', () => {
  it('a live card at $0 reads how fresh it is, not "No balance yet"', async () => {
    const root = await renderAccounts([
      acct(1, 'Checking', 'cash', 900),
      acct(2, 'Sapphire (1111)', 'credit', 0, { liveSync: true, lastUpdated: Date.now() - HOUR }),
      acct(3, 'Old card (2222)', 'credit', 0, { liveSync: true, lastUpdated: Date.now() - 3 * 24 * HOUR }),
      acct(4, 'Savings (3333)', 'cash', 0),
    ])
    const sub = (mask: string) => [...root.querySelectorAll('.acct-sub')].find((s) => s.textContent?.startsWith(`··${mask}`))!
    expect(sub('1111').textContent).toBe('··1111 · Updated 1h ago')
    // An old $0 is flagged stale like any other live balance.
    expect(sub('2222').textContent).toBe('··2222 · Updated 3d ago')
    expect(sub('2222').classList.contains('stale')).toBe(true)
    // A manual account still at $0 has no balance yet.
    expect(sub('3333').textContent).toBe('··3333 · No balance yet')
  })

  it("'Updated ' is its own part, so a narrow screen can drop it", async () => {
    const root = await renderAccounts([acct(1, 'Checking (1111)', 'cash', 900, { liveSync: true, lastUpdated: Date.now() - 12 * 24 * HOUR })])
    const sub = root.querySelector('.acct-sub')!
    expect(sub.textContent).toBe('··1111 · Updated 12d ago')
    expect(sub.querySelector('.acct-sub-verb')?.textContent).toBe('Updated ')
  })
})

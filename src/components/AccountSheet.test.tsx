// @vitest-environment jsdom
/**
 * The account sheet writes only what the user changed. Values are invented.
 *
 *  - B14: an untouched balance is never written, so a connector sync landing
 *    while the sheet is open survives a Save, and a plain Save never stamps a
 *    stale balance 'Updated just now'. A live row's lastUpdated belongs to its
 *    connector, even when a balance is typed over it.
 *  - B57: a balance can be negative (an overdrawn account, a card in credit):
 *    a typed '-' or the sign control keeps the sign, and editing a negative
 *    balance keeps it negative.
 *  - B58: the field shows the balance as money ('2525.80', never '2525.8' or
 *    '-125.5'), and the line under it says which way the balance points.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AccountSheet } from './AccountSheet'
import { db, type Account } from '../db/db'
import { applySyncedAccounts } from '../lib/brokerage'

vi.mock('../db/supabase', () => ({ supabase: null }))

const DAY = 864e5
const NOW = Date.now()
const acct = (id: number, p: Partial<Account> = {}): Account => ({
  id, institution: 'Test Bank', name: 'Checking', type: 'cash', balance: 1000, liveSync: false,
  lastUpdated: NOW - DAY, sortOrder: id, updatedAt: 1, ...p,
})

const balanceInput = () => screen.getByLabelText('Balance') as HTMLInputElement
const note = () => document.querySelector('.amount-display-note')?.textContent
const sign = (label: string) => within(screen.getByRole('radiogroup', { name: 'Balance sign' })).getByRole('radio', { name: label })

async function open(a: Account | null) {
  const onClose = vi.fn()
  render(<AccountSheet initial={a} onClose={onClose} />)
  if (a) await waitFor(() => expect(balanceInput().value).not.toBe(''))
  return onClose
}

beforeEach(async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  await db.open()
  await db.accounts.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('B14: a balance the user did not touch is never written', () => {
  const brokerage = () => acct(1, { institution: 'Test Brokerage', name: 'Individual', type: 'brokerage', balance: 1000, liveSync: true, source: 'snaptrade', sourceAccountId: 'b1', lastUpdated: NOW - 3_600_000 })

  it('a sync that lands while the sheet is open survives a plain Save', async () => {
    const a = brokerage()
    await db.accounts.add(a)
    const onClose = await open(a)
    await act(async () => {
      await db.accounts.update(1, { balance: 1500.55, lastUpdated: NOW, updatedAt: 2 })
    })
    await waitFor(() => expect(balanceInput().value).toBe('1500.55'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await db.accounts.get(1)).toMatchObject({ balance: 1500.55, lastUpdated: NOW, updatedAt: 2 })
  })

  it('a name edit saves the name and keeps the synced balance', async () => {
    const a = brokerage()
    await db.accounts.add(a)
    const onClose = await open(a)
    await act(async () => {
      await db.accounts.update(1, { balance: 1500.55, lastUpdated: NOW, updatedAt: 2 })
    })
    fireEvent.change(screen.getByPlaceholderText('Checking'), { target: { value: 'Joint' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await db.accounts.get(1)).toMatchObject({ name: 'Joint', balance: 1500.55, lastUpdated: NOW })
  })

  it('a stale live balance stays stale after a plain Save', async () => {
    const a = acct(2, { name: 'Rewards Card', type: 'credit', balance: 300, liveSync: true, source: 'simplefin', sourceAccountId: 'c1', lastUpdated: NOW - 12 * DAY })
    await db.accounts.add(a)
    const onClose = await open(a)
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await db.accounts.get(2)).toEqual(a)
  })

  it('an old manual balance is not marked fresh by a plain Save', async () => {
    const a = acct(3, { lastUpdated: NOW - 40 * DAY })
    await db.accounts.add(a)
    const onClose = await open(a)
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await db.accounts.get(3)).toEqual(a)
  })

  it('a typed balance on a live row is saved without claiming a fresh sync', async () => {
    const a = brokerage()
    await db.accounts.add(a)
    const onClose = await open(a)
    fireEvent.change(balanceInput(), { target: { value: '1200' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await db.accounts.get(1)).toMatchObject({ balance: 1200, lastUpdated: a.lastUpdated })
  })

  it('a typed balance on a manual row is stamped now', async () => {
    const a = acct(3, { lastUpdated: NOW - 40 * DAY })
    await db.accounts.add(a)
    const onClose = await open(a)
    fireEvent.change(balanceInput(), { target: { value: '950' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const saved = (await db.accounts.get(3))!
    expect(saved.balance).toBe(950)
    expect(saved.lastUpdated).toBeGreaterThan(NOW - DAY)
  })
})

describe('B57: a negative balance', () => {
  it("'-50.00' typed into a new manual account is saved as −50", async () => {
    const onClose = await open(null)
    fireEvent.change(screen.getByPlaceholderText('Required'), { target: { value: 'Test Credit Union' } })
    fireEvent.change(balanceInput(), { target: { value: '-50.00' } })
    expect(balanceInput().value).toBe('50.00')
    expect(sign('Negative').getAttribute('aria-checked')).toBe('true')
    expect(note()).toBe('Below zero')
    fireEvent.click(screen.getByText('Add'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((await db.accounts.toArray())[0]).toMatchObject({ institution: 'Test Credit Union', balance: -50, type: 'cash' })
  })

  it('the sign control works without a minus key (the iOS decimal pad has none)', async () => {
    const onClose = await open(null)
    fireEvent.change(screen.getByPlaceholderText('Required'), { target: { value: 'Test Credit Union' } })
    fireEvent.change(balanceInput(), { target: { value: '25' } })
    fireEvent.click(sign('Negative'))
    fireEvent.click(screen.getByText('Add'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((await db.accounts.toArray())[0].balance).toBe(-25)
  })

  it('editing a negative balance keeps it negative', async () => {
    const a = acct(4, { balance: -25 })
    await db.accounts.add(a)
    const onClose = await open(a)
    expect(balanceInput().value).toBe('25.00')
    fireEvent.change(balanceInput(), { target: { value: '250' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((await db.accounts.get(4))?.balance).toBe(-250)
  })

  it('a card in credit can be set back to owed', async () => {
    const a = acct(5, { name: 'Rewards Card', type: 'credit', balance: -125.5 })
    await db.accounts.add(a)
    const onClose = await open(a)
    fireEvent.click(sign('Owed'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect((await db.accounts.get(5))?.balance).toBe(125.5)
  })
})

describe('B58: the balance reads as money', () => {
  for (const [p, shown, words] of [
    [{ type: 'credit', balance: 2525.8 }, '2525.80', 'Balance owed on this card'],
    [{ type: 'retirement', balance: 31750 }, '31750.00', 'Current balance'],
    [{ type: 'credit', balance: -125.5 }, '125.50', 'Credit on this card'],
    [{ type: 'cash', balance: -42.1 }, '42.10', 'Below zero'],
    [{ type: 'cash', balance: 0.1 + 0.2 }, '0.30', 'Current balance'],
  ] as const) {
    it(`${p.balance} (${p.type}) shows '${shown}' over '${words}', and a plain Save keeps it exactly`, async () => {
      const a = acct(6, p)
      await db.accounts.add(a)
      const onClose = await open(a)
      expect(balanceInput().value).toBe(shown)
      expect(note()).toBe(words)
      fireEvent.click(screen.getByText('Save'))
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect((await db.accounts.get(6))?.balance).toBe(p.balance)
    })
  }
})

describe('a live account renamed or retyped here keeps it through the next sync', () => {
  // Stored before the connector's record was kept (as every row synced until now).
  const linked = () =>
    acct(7, { institution: 'Test Bank', name: 'Premier Checking (1111)', balance: 2000, liveSync: true, source: 'simplefin', sourceAccountId: 'tb:7' })
  const sync = (balance: number) =>
    applySyncedAccounts([{ sourceAccountId: 'tb:7', institution: 'Test Bank', name: 'Premier Checking (1111)', tier: 'cash', balance, currency: 'USD' }], 'simplefin')

  it('a new name', async () => {
    const a = linked()
    await db.accounts.add(a)
    const onClose = await open(a)
    fireEvent.change(screen.getByPlaceholderText('Checking'), { target: { value: 'Everyday' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    await sync(2100)
    expect(await db.accounts.get(7)).toMatchObject({ name: 'Everyday', institution: 'Test Bank', type: 'cash', balance: 2100 })
  })

  it('the note says what a sync keeps and what it replaces', async () => {
    const a = linked()
    await db.accounts.add(a)
    await open(a)
    expect(document.querySelector('.acct-live-note')?.textContent).toContain('A name or type set here stays; a balance edited here lasts until the next sync.')
  })

  it('a plain Save still writes nothing', async () => {
    const a = linked()
    await db.accounts.add(a)
    const onClose = await open(a)
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await db.accounts.get(7)).toEqual(a)
  })
})

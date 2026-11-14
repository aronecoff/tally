// @vitest-environment jsdom
/**
 * Public Settings: what is on it and what the rows do. Disconnect has its own
 * file (bankLink.test.tsx). The figures are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { db } from '../../db/db'
import { rentDate } from '../../lib/bankRules'
import { getPlan, setPlan } from '../../lib/planCache'
import { rentDatingOn } from '../../lib/prefs'
import { DOUBLE_TAP_MS } from '../../lib/useArmed'
import { hasSampleData } from './sampleData'
import { seedIfEmpty } from './seed'
import { Account } from './Settings'

const calls: string[] = []
const reload = vi.fn()

const lock = { enabled: false, available: true, biometry: 'faceID', after: 60 }
const alerts = { permission: 'unset', budgets: false, weekly: false, weekday: 1, hour: 18, fired: [] }

async function postMessage({ method, args }: { method: string; args?: { enabled?: boolean } }) {
  calls.push(method)
  if (method === 'simplefin.status') return { connected: false }
  if (method === 'lock.status') return lock
  if (method === 'lock.set') return { ...lock, ...args }
  if (method === 'alerts.status') return alerts
  return { erased: true }
}

beforeEach(async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  vi.stubGlobal('webkit', { messageHandlers: { plainsum: { postMessage } } })
  vi.stubGlobal('location', { ...window.location, reload })
  calls.length = 0
  reload.mockClear()
  localStorage.clear()
  await db.categories.clear()
  await db.transactions.clear()
  await db.accounts.clear()
  await seedIfEmpty()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const open = () =>
  render(<Account onClose={() => {}} pref="system" setPref={() => {}} onCategories={() => {}} onBankConnections={() => {}} onImport={() => {}} onBackups={() => {}} />)

describe('the file rows', () => {
  it('are all here, whatever the user agent looks like: this is never an old shell', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')
    open()
    for (const name of ['Import a file', 'Export transactions', 'Backups']) expect(screen.getByRole('button', { name })).toBeTruthy()
  })
})

describe('alerts', () => {
  it('are here too, off, and asking for nothing', async () => {
    open()
    const budgets = await screen.findByRole('switch', { name: 'Budget alerts' })
    expect(budgets.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Weekly review reminder' }).getAttribute('aria-checked')).toBe('false')
    expect(calls).not.toContain('alerts.set')
  })
})

describe('rent re-dating', () => {
  const row = () => screen.getByRole('switch', { name: 'Date rent to the 1st' })

  it('starts off here', () => {
    open()
    expect(row().getAttribute('aria-checked')).toBe('false')
    expect(rentDatingOn()).toBe(false)
    expect(rentDate('2026-09-28')).toBe('2026-09-28')
  })

  it('turns on, stays on and moves the date', () => {
    open()
    fireEvent.click(row())
    expect(row().getAttribute('aria-checked')).toBe('true')
    expect(rentDate('2026-09-28')).toBe('2026-10-01')
    cleanup()
    open()
    expect(row().getAttribute('aria-checked')).toBe('true')
  })

  it('does not tell anyone to match other devices: there is only this one', () => {
    open()
    expect(document.querySelector('.sheet')?.textContent).not.toContain('each device')
  })
})

describe('the app lock', () => {
  const row = () => screen.findByRole('switch', { name: 'Lock with Face ID' })

  it('starts off here too, and turns on through the app', async () => {
    open()
    expect((await row()).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(await row())
    await waitFor(async () => expect((await row()).getAttribute('aria-checked')).toBe('true'))
    expect(calls).toContain('lock.set')
    expect(screen.getByRole('radiogroup', { name: 'Lock after' })).toBeTruthy()
  })

  it('shows nothing in a browser', async () => {
    vi.stubGlobal('webkit', undefined)
    open()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByRole('switch', { name: /^Lock with/ })).toBeNull()
  })
})

describe('the savings plan', () => {
  const goal = () => screen.getByLabelText('Save each month') as HTMLInputElement
  const budget = () => screen.getByLabelText('Monthly budget') as HTMLInputElement
  const lockRow = () => screen.getByRole('switch', { name: 'Lock the budget' })
  const typeIn = (el: HTMLInputElement, v: string) => fireEvent.change(el, { target: { value: v } })
  const said = () => [...document.querySelectorAll('.sheet [data-plan] > p')].map((p) => p.textContent)
  /** Past the double-tap window, so the next tap is a confirmation. */
  const wait = () => act(async () => void vi.advanceTimersByTime(DOUBLE_TAP_MS + 50))

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] })
    vi.setSystemTime(new Date('2031-11-12T12:00:00'))
    setPlan(null)
  })
  afterEach(() => void setPlan(null))

  it('is offered with no account, off and empty, right after the budgets row', async () => {
    open()
    await screen.findByText('Savings plan')
    expect([goal().value, budget().value, lockRow().getAttribute('aria-checked')]).toEqual(['', '', 'false'])
    expect(said()).toEqual(['Off. Turn the lock on and Home counts spending against this budget, and category budgets can only add up to it.'])
    const label = document.querySelector('.sheet [data-plan]')!
    expect(label.previousElementSibling?.textContent).toContain('Categories & budgets')
    expect(document.querySelector('.sheet')?.textContent).not.toMatch(/sign in/i)
  })

  it('locks in two taps, on this device only', async () => {
    open()
    await screen.findByText('Savings plan')
    typeIn(goal(), '800')
    typeIn(budget(), '3000')
    fireEvent.click(lockRow())
    expect(said()).toContain('Tap again to lock the budget at $3,000 a month with a goal of $800. Turning it off again waits for the 1st of next month.')
    expect(getPlan()).toBeNull()
    await wait()
    fireEvent.click(lockRow())
    await waitFor(() => expect(lockRow().getAttribute('aria-checked')).toBe('true'))
    expect(getPlan()).toMatchObject({ goal: 800, cap: 3000, locked: true, since: '2031-12', pending: null })
    expect(JSON.parse(localStorage.getItem('tally:savingsPlan:v1')!)).toMatchObject({ locked: true, cap: 3000 })
  })

  it('a higher budget waits for the 1st, shows as pending with its date, and can be cancelled', async () => {
    setPlan({ goal: 800, cap: 3000, locked: true, since: '2031-11', pending: null, updatedAt: 1 })
    open()
    await screen.findByText('Savings plan')
    typeIn(budget(), '3500')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(said()).toContain('The budget rises to $3,500 on Dec 1.')
    expect(getPlan()?.pending).toBeNull()
    await wait()
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to save' }))
    await waitFor(() => expect(getPlan()?.pending).toEqual({ from: '2031-12', cap: 3500 }))
    expect(getPlan()?.cap).toBe(3000)
    await waitFor(() => expect(budget().value).toBe('$3,000'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this change' }))
    await waitFor(() => expect(getPlan()?.pending).toBeNull())
    expect(screen.queryByRole('button', { name: 'Cancel this change' })).toBeNull()
  })

  it('one tap asks for the lock off, which waits', async () => {
    setPlan({ goal: 800, cap: 3000, locked: true, since: '2031-11', pending: null, updatedAt: 1 })
    open()
    await screen.findByText('Savings plan')
    fireEvent.click(lockRow())
    await waitFor(() => expect(said()).toContain('The lock turns off on Dec 1.'))
    expect(lockRow().getAttribute('aria-checked')).toBe('true')
    expect(getPlan()).toMatchObject({ locked: true, pending: { from: '2031-12', locked: false } })
  })

  it('says so when the device will not keep it', async () => {
    setPlan({ goal: 800, cap: 3000, locked: true, since: '2031-11', pending: null, updatedAt: 1 })
    open()
    await screen.findByText('Savings plan')
    typeIn(budget(), '2800')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await wait()
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to save' }))
    await waitFor(() => expect(document.querySelector('.sheet [data-plan] > p.sheet-err')?.textContent).toBe('Could not save the plan on this device.'))
    blocked.mockRestore()
    expect(getPlan()?.cap).toBe(3000)
  })
})

describe('sample data', () => {
  it('loads, then offers to remove', async () => {
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Load sample data' }))
    await screen.findByRole('button', { name: 'Remove sample data' })
    expect(await hasSampleData()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Remove sample data' }))
    await screen.findByRole('button', { name: 'Load sample data' })
    expect(await db.transactions.count()).toBe(0)
  })
})

describe('erase all data', () => {
  const button = () => screen.getByRole('button', { name: /erase/i })

  it('one tap only arms it', async () => {
    open()
    fireEvent.click(button())
    expect(button().textContent).toBe('Tap again to erase')
    expect(calls).not.toContain('erase.all')
    expect(reload).not.toHaveBeenCalled()
  })

  it('a double tap is not a confirmation', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    open()
    fireEvent.click(button())
    fireEvent.click(button())
    expect(calls).not.toContain('erase.all')
  })

  it('the second tap erases', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    open()
    fireEvent.click(button())
    await act(async () => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS + 1)
    })
    fireEvent.click(button())
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(calls).toContain('erase.all')
  })

  it('says what it cannot do for the user', () => {
    open()
    expect(document.querySelector('.sheet')?.textContent).toContain('revoke it at SimpleFIN')
  })
})

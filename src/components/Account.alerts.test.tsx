// @vitest-environment jsdom
/**
 * Alerts' rows in Tally's Settings. The alerts are in the app around the page
 * (ios/Shared/BudgetAlerts.swift), so the app here is a fake that answers as the real
 * one does: the permission is asked once, and each change comes back as what is now true.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { db } from '../db/db'
import type { AlertSettings } from '../lib/budgetAlerts'
import { todayISO } from '../lib/dates'
import { Account } from './Account'

vi.mock('../db/supabase', () => ({ supabase: null }))

let status: AlertSettings
const sent: { method: string; args: Record<string, unknown> }[] = []
/** What the person says at the system prompt. */
let prompt: 'allow' | 'refuse' = 'allow'
let failing = false
let release: (() => void) | null = null
let hold = false

async function postMessage({ method, args }: { method: string; args: Record<string, unknown> }) {
  sent.push({ method, args })
  if (method === 'alerts.status') return status
  if (method === 'alerts.openSettings') return { opened: true }
  if (method === 'alerts.set') {
    if (hold) await new Promise<void>((resolve) => (release = resolve))
    if (failing) throw new Error('unavailable')
    if (args.budgets === true || args.weekly === true) {
      if (status.permission === 'unset') status = { ...status, permission: prompt === 'allow' ? 'allowed' : 'denied' }
      if (status.permission === 'denied') return status
    }
    const { seen, ...rest } = args as Partial<AlertSettings> & { seen?: string[] }
    status = { ...status, ...rest, fired: [...status.fired, ...(seen ?? [])] }
    return status
  }
  throw new Error('unavailable')
}

const show = async () => {
  render(<Account onClose={() => {}} pref="system" setPref={() => {}} onCategories={() => {}} onBankConnections={() => {}} onImport={() => {}} onBackups={() => {}} />)
  await screen.findByRole('switch', { name: 'Budget alerts' })
}

const on = (name: string) => screen.getByRole('switch', { name }).getAttribute('aria-checked') === 'true'

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })
  status = { permission: 'unset', budgets: false, weekly: false, weekday: 1, hour: 18, fired: [] }
  sent.length = 0
  prompt = 'allow'
  failing = false
  hold = false
  release = null
  localStorage.clear()
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await db.transactions.clear()
  await db.categories.clear()
})

describe('Alert rows', () => {
  it('is not there in a browser or the Mac app', async () => {
    vi.unstubAllGlobals()
    render(<Account onClose={() => {}} pref="system" setPref={() => {}} onCategories={() => {}} onBankConnections={() => {}} onImport={() => {}} onBackups={() => {}} />)
    await act(async () => {})
    expect(screen.queryByRole('switch', { name: 'Budget alerts' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Weekly review reminder' })).toBeNull()
  })

  it('is not there around an older app, which has no such method', async () => {
    vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage: () => Promise.reject(new Error('unavailable')) } } })
    render(<Account onClose={() => {}} pref="system" setPref={() => {}} onCategories={() => {}} onBankConnections={() => {}} onImport={() => {}} onBackups={() => {}} />)
    await act(async () => {})
    expect(screen.queryByRole('switch', { name: 'Budget alerts' })).toBeNull()
  })

  it('starts off, and opening Settings asks for nothing', async () => {
    await show()
    expect(on('Budget alerts')).toBe(false)
    expect(on('Weekly review reminder')).toBe(false)
    expect(sent.filter((s) => s.method !== 'lock.status').map((s) => s.method)).toEqual(['alerts.status'])
  })

  it('turning budget alerts on asks then, and only then', async () => {
    await show()
    fireEvent.click(screen.getByRole('switch', { name: 'Budget alerts' }))
    await waitFor(() => expect(on('Budget alerts')).toBe(true))
    expect(sent.filter((s) => s.method === 'alerts.set')).toHaveLength(1)
    expect(sent.at(-1)?.args).toMatchObject({ budgets: true, seen: [] })
  })

  it('sends what is already past a line along with turning on', async () => {
    await db.categories.add({ id: 1, uid: 'c1', name: 'Dining', icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget: 100, sortOrder: 0, updatedAt: 1 })
    await db.transactions.add({ date: todayISO(), amount: 90, type: 'expense', categoryId: 1, account: '', note: 'x', createdAt: 1, updatedAt: 1 })
    await show()
    fireEvent.click(screen.getByRole('switch', { name: 'Budget alerts' }))
    await waitFor(() => expect(on('Budget alerts')).toBe(true))
    const month = todayISO().slice(0, 7)
    expect(status.fired).toEqual([`month-${month}-80`, `c1-${month}-80`])
  })

  it('a refusal leaves it off and says where the switch is', async () => {
    prompt = 'refuse'
    await show()
    fireEvent.click(screen.getByRole('switch', { name: 'Budget alerts' }))
    await screen.findByText('Notifications are off for this app. Turn them on in the Settings app.')
    expect(on('Budget alerts')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    await waitFor(() => expect(sent.at(-1)?.method).toBe('alerts.openSettings'))
  })

  it('refused in the Settings app, an alert that was on reads off, and comes back', async () => {
    status = { ...status, permission: 'denied', budgets: true, weekly: true }
    await show()
    expect(on('Budget alerts')).toBe(false)
    expect(on('Weekly review reminder')).toBe(false)
    expect(screen.queryByText('Day')).toBeNull()
    status = { ...status, permission: 'allowed' }
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(on('Budget alerts')).toBe(true))
    expect(on('Weekly review reminder')).toBe(true)
    expect(screen.queryByText('Notifications are off for this app. Turn them on in the Settings app.')).toBeNull()
  })

  it('stops listening once the sheet has gone', async () => {
    await show()
    cleanup()
    sent.length = 0
    document.dispatchEvent(new Event('visibilitychange'))
    await act(async () => {})
    expect(sent).toEqual([])
  })

  it('turning off asks for nothing and sends no lines', async () => {
    status = { ...status, permission: 'allowed', budgets: true }
    await show()
    fireEvent.click(screen.getByRole('switch', { name: 'Budget alerts' }))
    await waitFor(() => expect(on('Budget alerts')).toBe(false))
    expect(sent.at(-1)?.args).toEqual({ budgets: false })
  })

  it('the reminder has a day and a time once it is on, Sunday at 6 PM to start', async () => {
    await show()
    expect(screen.queryByText('Day')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Weekly review reminder' }))
    await waitFor(() => expect(on('Weekly review reminder')).toBe(true))
    expect(screen.getByLabelText<HTMLSelectElement>('Day').selectedOptions[0].text).toBe('Sunday')
    expect(screen.getByLabelText<HTMLSelectElement>('Time').selectedOptions[0].text).toBe('6 PM')
    expect(on('Budget alerts')).toBe(false)
  })

  it('moving the reminder tells the app, which counts Sunday as 1', async () => {
    status = { ...status, permission: 'allowed', weekly: true }
    await show()
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '7' } })
    await waitFor(() => expect(sent.at(-1)?.args).toEqual({ weekday: 7 }))
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>('Day').selectedOptions[0].text).toBe('Saturday'))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '9' } })
    await waitFor(() => expect(sent.at(-1)?.args).toEqual({ hour: 9 }))
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>('Time').selectedOptions[0].text).toBe('9 AM'))
  })

  it('names the hours as a clock does', async () => {
    status = { ...status, permission: 'allowed', weekly: true }
    await show()
    const hours = [...screen.getByLabelText<HTMLSelectElement>('Time').options].map((o) => o.text)
    expect(hours[0]).toBe('6 AM')
    expect(hours).toContain('12 PM')
    expect(hours.at(-1)).toBe('9 PM')
  })

  it('says so when a change fails, and leaves it as it was', async () => {
    await show()
    failing = true
    fireEvent.click(screen.getByRole('switch', { name: 'Weekly review reminder' }))
    await screen.findByText('Could not change that. Try again.')
    expect(on('Weekly review reminder')).toBe(false)
    failing = false
    fireEvent.click(screen.getByRole('switch', { name: 'Weekly review reminder' }))
    await waitFor(() => expect(on('Weekly review reminder')).toBe(true))
    expect(screen.queryByText('Could not change that. Try again.')).toBeNull()
  })

  it('a second tap while the prompt is up is not a second change', async () => {
    hold = true
    await show()
    fireEvent.click(screen.getByRole('switch', { name: 'Budget alerts' }))
    await waitFor(() => expect(release).not.toBeNull())
    fireEvent.click(screen.getByRole('switch', { name: 'Budget alerts' }))
    await act(async () => {
      release?.()
    })
    await waitFor(() => expect(on('Budget alerts')).toBe(true))
    // The second tap reads the ledger before it reaches the app, so it takes a moment to show.
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(sent.filter((s) => s.method === 'alerts.set')).toHaveLength(1)
  })
})

// @vitest-environment jsdom
/**
 * The lock's row in Tally's Settings. The lock is in the app around the page
 * (ios/Shared/AppLock.swift), so the app here is a fake that answers as the real one
 * does: each change comes back as what is now true.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LockStatus } from '../lib/appLock'
import { Account } from './Account'

const session = vi.hoisted(() => ({ email: null as string | null }))

vi.mock('../db/supabase', () => ({ supabase: null }))
vi.mock('../sync/sync', async (real) => ({
  ...(await real<typeof import('../sync/sync')>()),
  subscribeSync: (listener: (snap: { email: string | null; status: string; lastSyncedAt: null; error: null }) => void) => {
    listener({ email: session.email, status: 'idle', lastSyncedAt: null, error: null })
    return () => {}
  },
}))

let status: LockStatus
const sent: { method: string; args: Record<string, unknown> }[] = []
/** What the person does at the prompt. */
let prompt: 'pass' | 'cancel' = 'pass'
let release: (() => void) | null = null
let hold = false

async function postMessage({ method, args }: { method: string; args: Record<string, unknown> }) {
  sent.push({ method, args })
  if (method === 'lock.status') return status
  if (method === 'lock.set') {
    if (hold) await new Promise<void>((resolve) => (release = resolve))
    if (typeof args.after === 'number') status = { ...status, after: args.after }
    if (typeof args.enabled === 'boolean' && prompt === 'pass') status = { ...status, enabled: args.enabled }
    return status
  }
  throw new Error('unavailable')
}

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })
  status = { enabled: false, available: true, biometry: 'faceID', after: 60 }
  sent.length = 0
  prompt = 'pass'
  hold = false
  release = null
  session.email = null
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const open = () =>
  render(<Account onClose={() => {}} pref="system" setPref={() => {}} onCategories={() => {}} onBankConnections={() => {}} onImport={() => {}} onBackups={() => {}} />)
const row = (name = 'Lock with Face ID') => screen.findByRole('switch', { name })
const changes = () => sent.filter((s) => s.method === 'lock.set')

describe('where there is no lock', () => {
  /** Lets lock.status answer, so "nothing showed" is not just "nothing yet". */
  const settled = () => act(async () => { await Promise.resolve() })

  it('shows nothing in a browser or the Mac app', async () => {
    vi.stubGlobal('webkit', undefined)
    open()
    await settled()
    expect(screen.queryByRole('switch', { name: /^Lock with/ })).toBeNull()
    expect(document.querySelector('.sheet')?.textContent).not.toMatch(/app switcher|Lock after/)
  })

  it('shows nothing in an older app that does not know the method', async () => {
    vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage: async () => { throw new Error('unavailable') } } } })
    open()
    await settled()
    expect(screen.queryByRole('switch', { name: /^Lock with/ })).toBeNull()
  })
})

describe('the row', () => {
  it('starts off, with no timeout to choose, and asks for nothing by itself', async () => {
    open()
    expect((await row()).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('radiogroup', { name: 'Lock after' })).toBeNull()
    expect(changes()).toEqual([])
  })

  it('is there signed in too', async () => {
    session.email = 'someone@example.test'
    open()
    expect((await row()).getAttribute('aria-checked')).toBe('false')
  })

  it.each([
    ['touchID', 'Lock with Touch ID'],
    ['none', 'Lock with passcode'],
  ] as const)('names what this device asks with: %s', async (biometry, name) => {
    status = { ...status, biometry }
    open()
    expect(await row(name)).toBeTruthy()
  })

  it('says the switcher is covered either way', async () => {
    open()
    await row()
    expect(document.querySelector('.sheet')?.textContent).toContain('Figures stay hidden in the app switcher either way.')
  })
})

describe('changing it', () => {
  it('turns on once the app says so, and offers the timeout', async () => {
    open()
    fireEvent.click(await row())
    await waitFor(async () => expect((await row()).getAttribute('aria-checked')).toBe('true'))
    expect(changes()).toEqual([{ method: 'lock.set', args: { enabled: true } }])
    expect(screen.getByRole('radio', { name: '1 minute' }).getAttribute('aria-checked')).toBe('true')
  })

  it('does not move on its own: a cancelled prompt leaves it off and says nothing', async () => {
    prompt = 'cancel'
    open()
    fireEvent.click(await row())
    await waitFor(() => expect(changes()).toHaveLength(1))
    await act(async () => { await Promise.resolve() })
    expect((await row()).getAttribute('aria-checked')).toBe('false')
    expect(document.querySelector('.sheet-err')).toBeNull()
  })

  it('stays on when turning it off is cancelled', async () => {
    status = { ...status, enabled: true }
    prompt = 'cancel'
    open()
    fireEvent.click(await row())
    await waitFor(() => expect(changes()).toEqual([{ method: 'lock.set', args: { enabled: false } }]))
    await act(async () => { await Promise.resolve() })
    expect((await row()).getAttribute('aria-checked')).toBe('true')
  })

  it('asks once, however many taps land while the prompt is up', async () => {
    hold = true
    open()
    const switchRow = await row()
    fireEvent.click(switchRow)
    fireEvent.click(switchRow)
    fireEvent.click(switchRow)
    await waitFor(() => expect(changes()).toHaveLength(1))
    await act(async () => {
      release?.()
      await Promise.resolve()
    })
    await waitFor(async () => expect((await row()).getAttribute('aria-checked')).toBe('true'))
    expect(changes()).toHaveLength(1)
  })

  it('says so when the app could not answer, and can try again', async () => {
    open()
    const switchRow = await row()
    vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage: async () => { throw new Error('unavailable') } } } })
    fireEvent.click(switchRow)
    expect((await screen.findByText('Could not change the lock. Try again.')).className).toBe('sheet-err')
    expect(switchRow.getAttribute('aria-checked')).toBe('false')
    vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })
    fireEvent.click(switchRow)
    await waitFor(() => expect(switchRow.getAttribute('aria-checked')).toBe('true'))
    expect(document.querySelector('.sheet-err')).toBeNull()
  })

  it('offers the timeouts the app accepts, and shows the one it kept', async () => {
    status = { ...status, enabled: true }
    open()
    await row()
    const radios = screen.getAllByRole('radio').filter((r) => r.closest('[aria-labelledby="settings-lock-after"]'))
    expect(radios.map((r) => r.textContent)).toEqual(['Right away', '1 minute', '5 minutes'])
    fireEvent.click(screen.getByRole('radio', { name: '5 minutes' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: '5 minutes' }).getAttribute('aria-checked')).toBe('true'))
    expect(changes()).toEqual([{ method: 'lock.set', args: { after: 300 } }])
    expect(screen.getByRole('radio', { name: '1 minute' }).getAttribute('aria-checked')).toBe('false')
  })
})

describe('a device with no passcode', () => {
  it('says what it needs, whatever the switch shows', async () => {
    status = { ...status, available: false, biometry: 'none' }
    open()
    await row('Lock with passcode')
    expect(document.querySelector('.sheet')?.textContent).toContain('Set a passcode on this device to use the lock.')
  })

  it('does not say so otherwise', async () => {
    open()
    await row()
    expect(document.querySelector('.sheet')?.textContent).not.toContain('Set a passcode')
  })
})

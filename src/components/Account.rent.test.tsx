// @vitest-environment jsdom
/**
 * The rent setting in the personal app. It starts on, because that is how the app
 * has always run, and its Settings carries nothing of the public build's.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Account } from './Account'
import { rentDate } from '../lib/bankRules'

vi.mock('../db/supabase', () => ({ supabase: null }))

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const open = () =>
  render(<Account onClose={() => {}} pref="system" setPref={() => {}} onCategories={() => {}} onBankConnections={() => {}} onImport={() => {}} onBackups={() => {}} />)
const row = () => screen.getByRole('switch', { name: 'Date rent to the 1st' })

describe('Settings', () => {
  it('has the rule on until someone turns it off', () => {
    open()
    expect(row().getAttribute('aria-checked')).toBe('true')
    expect(rentDate('2026-09-28')).toBe('2026-10-01')
  })

  it('turns it off and back on', () => {
    open()
    fireEvent.click(row())
    expect(row().getAttribute('aria-checked')).toBe('false')
    expect(rentDate('2026-09-28')).toBe('2026-09-28')
    fireEvent.click(row())
    expect(rentDate('2026-09-28')).toBe('2026-10-01')
  })

  it('says to match the other devices, since each one syncs the bank itself', () => {
    open()
    expect(document.querySelector('.sheet')?.textContent).toContain('Set it the same on each device.')
  })

  it('offers nothing from the public build', () => {
    open()
    expect(document.querySelector('.sheet')?.textContent).not.toMatch(/sample data|Erase all data|Disconnect bank|Acknowledgements/)
  })
})

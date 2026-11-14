// @vitest-environment jsdom
/**
 * A fresh public app: its name in the header, nothing that asks for an account,
 * and a Home that does not claim budgets no one has set.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../../App'
import { db } from '../../db/db'
import { brand } from '../../lib/brand'
import { markOnboarded } from './onboarded'

const name = brand.mark.trim()

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
  markOnboarded()
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await db.transactions.clear()
  await db.categories.clear()
  await db.accounts.clear()
})

async function boot() {
  render(<App />)
  await waitFor(() => expect(document.querySelector('section.pane:not([hidden])')?.getAttribute('aria-busy')).toBeNull())
}

describe('a fresh public app', () => {
  it('wears its own name and no status dot', async () => {
    await boot()
    expect(document.querySelector('.head-brand-mark')?.textContent).toBe(` ${name}`)
    expect(document.querySelector('.side-brand')?.textContent).toBe(` ${name}`)
    expect(screen.getAllByRole('button', { name: `Tell ${name}` }).length).toBeGreaterThan(0)
    expect(document.querySelector('.head-dot')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Settings' }).length).toBeGreaterThan(0)
  })

  it('says what a budget would do instead of calling them on track', async () => {
    await boot()
    await screen.findByText(/Set a budget and this will show what needs you\./)
    expect(document.body.textContent).not.toContain('All budgets on track')
  })

  it('has a Settings sheet with no sign-in', async () => {
    await boot()
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
    const sheet = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.sheet')
      expect(el).not.toBeNull()
      return el!
    })
    expect(sheet.textContent).toContain('Appearance')
    expect(sheet.textContent).toContain('Categories & budgets')
    expect(sheet.textContent).toContain('Bank connections')
    // Nothing to type but the savings plan's two amounts: no email, no password.
    expect([...sheet.querySelectorAll('input')].map((i) => i.closest('label')?.textContent)).toEqual(['Save each month', 'Monthly budget'])
    expect(sheet.textContent).not.toMatch(/sign in|sign out|password|email/i)
  })

  it('says what to do on every empty tab, in words that fit an app with no sync', async () => {
    await boot()
    await screen.findByText('Tap + to add a transaction.')
    const tab = (name: string) => fireEvent.click(screen.getAllByRole('button', { name }).at(-1)!)

    tab('Budget')
    await screen.findByText('No budgets yet. Tap Edit to set them.')
    tab('Insights')
    await screen.findByText('Add a transaction or import a file, and this fills in.')
    tab('Accounts')
    await screen.findByText('No accounts yet')
    tab('Activity')
    await screen.findByRole('button', { name: /Add a transaction/ })
    expect(document.body.textContent).not.toMatch(/\bsync/i)
  })

  it('opens a new install on the first-run sheet', async () => {
    localStorage.removeItem('plainsum:onboarded')
    await boot()
    await screen.findByRole('heading', { name: `Welcome to ${name}` })
    localStorage.setItem('plainsum:onboarded', '1')
  })

  it('takes Connect SimpleFIN from first run to the bank sheet on Accounts', async () => {
    localStorage.removeItem('plainsum:onboarded')
    await boot()
    fireEvent.click(await screen.findByRole('button', { name: /Connect SimpleFIN/ }))
    await screen.findByRole('heading', { name: 'Connect a bank' })
    expect(document.querySelectorAll('.sheet')).toHaveLength(1)
    expect(document.querySelector('section.pane:not([hidden])')?.getAttribute('data-screen')).toBe('accounts')
  })

  it('marks sample data on Home, and takes it away from there', async () => {
    await db.categories.clear()
    localStorage.removeItem('plainsum:onboarded')
    await boot()
    fireEvent.click(await screen.findByRole('button', { name: /Load sample data/ }))
    await screen.findByText('This is sample data.')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByText('This is sample data.')).toBeNull())
    expect(await db.transactions.count()).toBe(0)
    expect(await db.accounts.count()).toBe(0)
  })

  it('lists what ships inside the app under Acknowledgements', async () => {
    await boot()
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledgements' }))
    const sheet = document.querySelector<HTMLElement>('.sheet')!
    expect(sheet.textContent).toContain('SIL Open Font License 1.1')
    expect(sheet.textContent).toContain('Apache License 2.0')
    expect(sheet.textContent).toContain('MIT License')
  })
})

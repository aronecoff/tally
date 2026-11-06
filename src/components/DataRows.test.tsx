// @vitest-environment jsdom
/**
 * Settings' file rows on every shell. Going live opens the new page inside the old apps,
 * and a row there must either work or not be drawn.
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { standIn, type Shell } from '../test-shells'
import { DataRows } from './SettingsParts'

const rows = () => {
  render(<DataRows go={() => {}} onImport={() => {}} onBackups={() => {}} />)
  return screen.queryAllByRole('button').map((b) => b.textContent)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DataRows', () => {
  it.each<Shell>(['safariOnMac', 'chromeOnMac', 'firefoxOnMac', 'safariOnIphone', 'iphoneApp', 'macApp'])('offers all three in %s', (shell) => {
    standIn(shell)
    expect(rows()).toEqual(['Import a file', 'Export transactions', 'Backups'])
  })

  it('has no Export in an old iPhone app, where one can only fail', () => {
    standIn('oldIphoneApp')
    expect(rows()).toEqual(['Import a file', 'Backups'])
  })

  it('draws nothing in an old Mac app, not even an empty group', () => {
    standIn('oldMacApp')
    expect(rows()).toEqual([])
    expect(document.querySelector('.sheet-group')).toBeNull()
  })
})

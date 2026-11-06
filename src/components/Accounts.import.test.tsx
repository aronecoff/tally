// @vitest-environment jsdom
/** Accounts' Import a file row, where the shell around the page can open a file and where it cannot. */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { standIn, type Shell } from '../test-shells'
import { Accounts } from './Accounts'

const drawn = async () => {
  const { container } = render(<Accounts active />)
  await waitFor(() => expect(screen.getByRole('button', { name: /Add manually/ })).toBeTruthy())
  return container
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Accounts', () => {
  it.each<Shell>(['safariOnMac', 'iphoneApp', 'macApp', 'oldIphoneApp'])('offers Import a file in %s', async (shell) => {
    standIn(shell)
    await drawn()
    expect(screen.getByRole('button', { name: /Import a file/ })).toBeTruthy()
  })

  it('has no Import a file row in an old Mac app, where the picker never opens', async () => {
    standIn('oldMacApp')
    const list = await drawn()
    expect(screen.queryByRole('button', { name: /Import a file/ })).toBeNull()
    expect([...list.querySelectorAll('li.row-sep')].filter((li) => li.childElementCount === 0)).toEqual([])
  })
})

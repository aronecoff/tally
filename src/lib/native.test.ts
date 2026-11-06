// @vitest-environment jsdom
/** What each place around the page can do with a file. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { standIn, type Shell } from '../test-shells'
import { canPickFile, canSaveFile } from './native'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a file', () => {
  it.each<[Shell, boolean, boolean]>([
    ['safariOnMac', true, true],
    ['chromeOnMac', true, true],
    ['firefoxOnMac', true, true],
    ['safariOnIphone', true, true],
    ['iphoneApp', true, true],
    ['macApp', true, true],
    // Nowhere to land a download, but WebKit on a phone opens a file input by itself.
    ['oldIphoneApp', false, true],
    ['oldIphoneAppOnIpad', false, true],
    // No download, and no panel for a file input to open.
    ['oldMacApp', false, false],
  ])('in %s: can save %s, can pick %s', (shell, save, pick) => {
    standIn(shell)
    expect(canSaveFile()).toBe(save)
    expect(canPickFile()).toBe(pick)
  })
})

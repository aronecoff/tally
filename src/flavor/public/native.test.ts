// @vitest-environment jsdom
/** The public app is the app or a browser, and each can save a file and pick one. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canPickFile, canSaveFile } from '../../lib/native'

const OLD_MAC_LOOK = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'

afterEach(() => vi.restoreAllMocks())

describe('a file', () => {
  it('can be saved and picked, whatever the user agent looks like', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(OLD_MAC_LOOK)
    expect(canSaveFile()).toBe(true)
    expect(canPickFile()).toBe(true)
  })
})

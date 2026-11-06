/**
 * Where the page runs, for tests: each user agent as that place sends it, and whether
 * the app's door is there (ios/Tally/WebView.swift, desktop/Tally.swift). An old app is
 * one built before the page could save a file: going live opens the new page inside it,
 * and it stays until it is reinstalled.
 */
import { vi } from 'vitest'

const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)'
const MAC = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${WEBKIT}`
const IPHONE = `Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) ${WEBKIT}`

export const SHELLS = {
  safariOnMac: { ua: `${MAC} Version/26.0 Safari/605.1.15`, door: false },
  chromeOnMac: { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', door: false },
  firefoxOnMac: { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0', door: false },
  safariOnIphone: { ua: `${IPHONE} Version/26.0 Mobile/15E148 Safari/604.1`, door: false },
  iphoneApp: { ua: `${IPHONE} Mobile/15E148 TallyNative`, door: true },
  oldIphoneApp: { ua: `${IPHONE} Mobile/15E148 TallyNative`, door: false },
  // An iPad asks for desktop pages, so its WebKit says Macintosh. It is still the iPhone app.
  oldIphoneAppOnIpad: { ua: `${MAC} TallyNative`, door: false },
  macApp: { ua: `${MAC} TallyMac`, door: false },
  oldMacApp: { ua: MAC, door: false },
}

export type Shell = keyof typeof SHELLS

/** Be there, until vi.restoreAllMocks() and vi.unstubAllGlobals(). */
export function standIn(shell: Shell): void {
  const { ua, door } = SHELLS[shell]
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
  if (door) vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage: async () => ({}) } } })
}

// @vitest-environment jsdom
/** The door to the phone's Taptic Engine: nothing waits on it, and without an app it is not there. */
import { afterEach, expect, it, vi } from 'vitest'
import { haptic } from './haptics'

const app = (postMessage: (m: unknown) => Promise<unknown>) =>
  vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })

afterEach(() => vi.unstubAllGlobals())

it('asks the app to play the kind it was given', () => {
  const postMessage = vi.fn(async () => ({ played: true }))
  app(postMessage)
  haptic('warning')
  expect(postMessage).toHaveBeenCalledWith({ method: 'haptic.play', args: { kind: 'warning' } })
})

it('does nothing in a browser and in the Mac app', () => {
  expect(() => haptic('success')).not.toThrow()
})

it('an app that cannot play it costs nothing', async () => {
  const refused = vi.fn(async () => {
    throw new Error('unavailable')
  })
  app(refused)
  haptic('light')
  await new Promise((r) => setTimeout(r, 0)) // a rejection left loose fails the whole run
  expect(refused).toHaveBeenCalledOnce()
})

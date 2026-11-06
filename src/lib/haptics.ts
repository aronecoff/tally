import { native } from './native'

/**
 * A tap the hand can feel, played by the app around the page (ios/Shared/Haptics.swift),
 * which is what follows the phone's own settings. It marks a change that really landed,
 * so call it after the write and never before: a Save with nothing to save stays still.
 *
 *   success  a row or an account saved, a Tell Tally change applied
 *   light    a row saved with more to come in the sort queue
 *   warning  a delete confirmed, or only part of a change applied
 *
 * In a browser and in the Mac app there is nothing to play it, and nothing waits on it.
 */
export type Haptic = 'light' | 'success' | 'warning'

export function haptic(kind: Haptic): void {
  void native('haptic.play', { kind }).catch(() => {})
}

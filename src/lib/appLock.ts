import { hasNative, native } from './native'

/**
 * The app's lock lives in the app around the page (ios/Shared/AppLock.swift) and gates
 * nothing here: the page only shows the setting. The app asks for Face ID or the
 * passcode before any change to it, so a change can come back as no change.
 */
export interface LockStatus {
  enabled: boolean
  /** The device has a passcode, so there is something to ask for. */
  available: boolean
  biometry: 'faceID' | 'touchID' | 'none'
  /** Seconds away before it asks again. */
  after: number
}

/** Null where there is no lock: a browser, the Mac app, or an older iPhone app. */
export async function lockStatus(): Promise<LockStatus | null> {
  if (!hasNative()) return null
  try {
    return await native<LockStatus>('lock.status')
  } catch {
    return null
  }
}

export const changeLock = (change: { enabled?: boolean; after?: number }): Promise<LockStatus> => native<LockStatus>('lock.set', change)

/**
 * The typed door to the app around the page (ios/Plainsum/NativeBridge.swift).
 * A call resolves with the app's reply, or rejects with an Error whose message
 * is a code: `bad_args`, `denied`, `unavailable`, or the method's own.
 *
 * In a browser there is no app, so every call rejects with `no_bridge` and
 * callers carry on without it.
 */
interface Handler {
  postMessage(message: { method: string; args: Record<string, unknown> }): Promise<unknown>
}

const handler = () =>
  (globalThis as unknown as { webkit?: { messageHandlers?: { plainsum?: Handler } } }).webkit?.messageHandlers?.plainsum

/** The app around the page can take calls. */
export const hasNative = (): boolean => !!handler()

export async function native<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const h = handler()
  if (!h) throw new Error('no_bridge')
  return (await h.postMessage({ method, args })) as T
}

/** Only ever a browser, here: the app always has the door. */
export const canDownload = (): boolean => true

/** The app or a browser, and each can do both. There is no older shell: the page ships inside the app. */
export const canSaveFile = (): boolean => true
export const canPickFile = (): boolean => true

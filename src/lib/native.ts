/**
 * The typed door to the app around the page (ios/Tally/TallyBridge.swift). A call
 * resolves with the app's reply, or rejects with an Error whose message is a code:
 * `bad_args`, `denied`, `unavailable`, or the method's own.
 *
 * In a browser and in the Mac app there is no such door, so every call rejects
 * with `no_bridge`, and callers carry on without it. The public build swaps this
 * module for its own (scripts/flavor.ts).
 */
interface Handler {
  postMessage(message: { method: string; args: Record<string, unknown> }): Promise<unknown>
}

const handler = () => (globalThis as unknown as { webkit?: { messageHandlers?: { tally?: Handler } } }).webkit?.messageHandlers?.tally

/** The app around the page can take calls. */
export const hasNative = (): boolean => !!handler()

export async function native<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const h = handler()
  if (!h) throw new Error('no_bridge')
  return (await h.postMessage({ method, args })) as T
}

/**
 * An older Mac app around the page: WebKit naming no browser and no app of ours. A Mac
 * app that can do more names itself (desktop/Tally.swift). An iPad asks for desktop
 * pages, so it says Macintosh too, and the iPhone app's own name tells it apart.
 */
const oldMacApp = (ua: string): boolean => /Macintosh/.test(ua) && !/Safari|Firefox|Chrome| Tally(Mac|Native)\b/.test(ua)

/**
 * Whether a download can land anywhere. An older iPhone app around the page has no
 * door yet and no way to save one, and a blob link there replaces the page with the
 * file's text, leaving no way back. An older Mac app is the same.
 */
export function canDownload(): boolean {
  const ua = navigator.userAgent
  return !/ TallyNative\b/.test(ua) && !oldMacApp(ua)
}

/** This place can hand a file over: through the app's door, or as a download. A row that needs it is not drawn without it. */
export const canSaveFile = (): boolean => hasNative() || canDownload()

/**
 * This place can open a file. WebKit on a phone does that by itself, with or without
 * the door. On a Mac the app has to answer, and an older one never does: the tap goes
 * nowhere and says nothing. A row that needs it is not drawn without it.
 */
export const canPickFile = (): boolean => !oldMacApp(navigator.userAgent)

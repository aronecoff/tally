/**
 * The error a failed Edge Function call throws, shared by the bank and
 * brokerage connectors so the two cannot drift apart.
 *
 * Only a detail the server sent passes through untouched: the expired-token
 * check (/->\s*40[13]\b|forbidden|unauthorized token/), the 'not connected'
 * check and the sign-in prompt all read it. The library's own wording
 * ('Failed to send a request to the Edge Function', 'Edge Function returned a
 * non-2xx status code') never reaches the screen.
 */
export const SIGN_IN_MSG = 'Sign in to Tally in Settings first.'
export const OFFLINE_MSG = 'Could not reach the server. Check your connection and try again.'
export const RETRY_MSG = 'Could not reach the server. Try again.'

export async function edgeFailure(error: unknown): Promise<Error> {
  let detail: string | undefined
  try {
    // A non-2xx reply (FunctionsHttpError) carries the response on context.
    detail = (await (error as { context?: Response }).context?.json?.())?.error
  } catch {
    /* no JSON body */
  }
  if (detail === 'unauthorized') return new Error(SIGN_IN_MSG)
  if (detail) return new Error(detail)
  // FunctionsFetchError: the request never left (offline, DNS, blocked). A
  // relay error, or an HTTP error with no JSON body (a gateway page, a boot
  // error), is a hiccup on the server's side.
  const neverLeft =
    (error as { name?: string } | null)?.name === 'FunctionsFetchError' ||
    (typeof navigator !== 'undefined' && navigator.onLine === false)
  return new Error(neverLeft ? OFFLINE_MSG : RETRY_MSG)
}

/**
 * Connector and sign-in error copy. Only the literal fallbacks are plain
 * sentences; whatever the server sends is thrown untouched, because two checks
 * read it: the expired-token test (/->\s*40[13]\b|forbidden|unauthorized token/)
 * that raises the reconnect banner, and /not connected/i, which keeps an
 * unlinked bank quiet. Accounts and the bank sheet look for /sign in/i.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, signInWithPassword, signUp } = vi.hoisted(() => ({
  invoke: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
}))

vi.mock('../db/supabase', () => ({
  supabase: { functions: { invoke }, auth: { signInWithPassword, signUp } },
}))

import { claimBank, subscribeBankHealth, syncBanks, type BankHealth } from './banks'
import { connectBrokerage } from './brokerage'
import { signIn } from '../sync/sync'

/** A non-2xx reply from an Edge Function: the body's `error` is the detail. */
const httpError = (detail?: string, message = 'Edge Function returned a non-2xx status code') => ({
  data: null,
  error: Object.assign(new Error(message), {
    context: { json: async () => (detail === undefined ? {} : { error: detail }) },
  }),
})

function health(): BankHealth {
  let h: BankHealth = 'unknown'
  subscribeBankHealth((x) => (h = x))()
  return h
}

beforeEach(async () => {
  vi.clearAllMocks()
  // Start each case from a healthy connection.
  invoke.mockResolvedValueOnce({ data: { ok: true }, error: null })
  await claimBank('token')
  expect(health()).toBe('ok')
})

describe('expired bank token', () => {
  it("'… -> 403 …' is an expired token: the detail is thrown as sent and the banner state is raised", async () => {
    const detail = 'GET https://bridge.simplefin.org/accounts -> 403 Forbidden'
    invoke.mockResolvedValueOnce(httpError(detail))
    await expect(syncBanks()).rejects.toThrow(detail)
    expect(health()).toBe('expired')
  })

  it("'… -> 401' is expired too", async () => {
    invoke.mockResolvedValueOnce(httpError('POST /claim -> 401'))
    await expect(syncBanks()).rejects.toThrow('POST /claim -> 401')
    expect(health()).toBe('expired')
  })

  it('an unrelated failure is not an expired token', async () => {
    invoke.mockResolvedValueOnce(httpError('Token already claimed'))
    await expect(syncBanks()).rejects.toThrow('Token already claimed')
    expect(health()).toBe('ok')
  })

  it("'not connected' still reaches its check (a bank that is not linked stays quiet)", async () => {
    invoke.mockResolvedValueOnce(httpError('not connected'))
    await expect(syncBanks()).resolves.toBe(0)
    expect(health()).toBe('ok')
  })
})

describe('sign-in prompt', () => {
  it('banks: an unauthorized reply asks the user to sign in, in plain words', async () => {
    invoke.mockResolvedValueOnce(httpError('unauthorized'))
    const err = await syncBanks().catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/sign in/i)
    expect((err as Error).message).toBe('Sign in to Tally in Settings first.')
    expect((err as Error).message).not.toMatch(/—/)
  })

  it('brokerage: the same prompt', async () => {
    invoke.mockResolvedValueOnce(httpError('unauthorized'))
    await expect(connectBrokerage()).rejects.toThrow(/sign in/i)
  })
})

describe('literal fallbacks', () => {
  it('a failure with no detail and no message reads as a plain retry line', async () => {
    invoke.mockResolvedValueOnce(httpError(undefined, ''))
    await expect(syncBanks()).rejects.toThrow('Could not reach the server. Try again.')
    invoke.mockResolvedValueOnce({ data: { ok: false }, error: null })
    await expect(connectBrokerage()).rejects.toThrow('Could not reach the server. Try again.')
  })

  // B97: the library's own words ('Failed to send a request to the Edge
  // Function') never reach the screen. A request that never left (offline,
  // DNS) says to check the connection; a server hiccup with no detail is the
  // plain retry line. Neither reads as an expired token, 'not connected' or a
  // sign-in prompt.
  const fetchError = () => ({
    data: null,
    error: Object.assign(new Error('Failed to send a request to the Edge Function'), {
      name: 'FunctionsFetchError',
      context: new TypeError('Failed to fetch'),
    }),
  })
  const OFFLINE = 'Could not reach the server. Check your connection and try again.'

  it('a request that never left says to check the connection, for banks and brokerage', async () => {
    invoke.mockResolvedValueOnce(fetchError())
    await expect(syncBanks()).rejects.toThrow(OFFLINE)
    expect(health()).toBe('ok')
    invoke.mockResolvedValueOnce(fetchError())
    await expect(connectBrokerage()).rejects.toThrow(OFFLINE)
  })

  it('a relay or server error with no detail is the plain retry line', async () => {
    invoke.mockResolvedValueOnce({
      data: null,
      error: Object.assign(new Error('Relay Error invoking the Edge Function'), { name: 'FunctionsRelayError', context: {} }),
    })
    await expect(syncBanks()).rejects.toThrow(/^Could not reach the server\. Try again\.$/)
    invoke.mockResolvedValueOnce(httpError(undefined))
    await expect(connectBrokerage()).rejects.toThrow(/^Could not reach the server\. Try again\.$/)
  })

  it('a brokerage portal with no URL', async () => {
    invoke.mockResolvedValueOnce({ data: { ok: true, redirectURI: '' }, error: null })
    await expect(connectBrokerage()).rejects.toThrow('Could not start the connection. Try again.')
  })

  // B116: only an https portal is opened. A javascript: or data: URL would run
  // inside Tally's own blank window, and a non-string reply reads '[object Object]'.
  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'http://portal.example.test/connect',
    '[object Object]',
    'not a url',
  ])('a portal URL that is not https is refused: %s', async (bad) => {
    invoke.mockResolvedValueOnce({ data: { ok: true, redirectURI: bad }, error: null })
    await expect(connectBrokerage()).rejects.toThrow('Could not start the connection. Try again.')
  })

  it('an object in place of the portal URL is refused', async () => {
    invoke.mockResolvedValueOnce({ data: { ok: true, redirectURI: { redirectURI: 'https://portal.example.test/' } }, error: null })
    await expect(connectBrokerage()).rejects.toThrow('Could not start the connection. Try again.')
  })

  it('an https portal URL is returned as is', async () => {
    invoke.mockResolvedValueOnce({ data: { ok: true, redirectURI: 'https://portal.example.test/connect?token=abc' }, error: null })
    await expect(connectBrokerage()).resolves.toBe('https://portal.example.test/connect?token=abc')
  })
})

describe('sign-in errors', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const failSignUp = (message: string) => {
    signInWithPassword.mockResolvedValueOnce({ error: new Error('Invalid login credentials') })
    signUp.mockResolvedValueOnce({ data: { user: null, session: null }, error: new Error(message) })
  }

  it('maps the server wording to one plain sentence and logs the raw message', async () => {
    failSignUp('Unable to validate email address: invalid format')
    expect(await signIn('x@', 'password1')).toBe('Check the email address.')
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'Unable to validate email address: invalid format')

    failSignUp('Password should be at least 6 characters.')
    expect(await signIn('a@b.co', 'short')).toBe('Use at least 8 characters.')

    failSignUp('Signups not allowed for this instance')
    expect(await signIn('a@b.co', 'password1')).toBe('Could not sign in. Try again.')
  })

  it('a rate limit is not a bad email address', async () => {
    failSignUp('email rate limit exceeded')
    expect(await signIn('a@b.co', 'password1')).toBe('Too many tries. Wait a minute, then try again.')
  })

  it('an existing account with a wrong password says so', async () => {
    failSignUp('User already registered')
    expect(await signIn('a@b.co', 'wrong-pass')).toBe('That password does not match this email.')

    signInWithPassword.mockResolvedValueOnce({ error: new Error('Invalid login credentials') })
    signUp.mockResolvedValueOnce({ data: { user: { identities: [] }, session: null }, error: null })
    expect(await signIn('a@b.co', 'wrong-pass')).toBe('That password does not match this email.')
  })
})

import { describe, expect, it } from 'vitest'
import { minuteStamp, nextBuildNumber, readBuildNumber } from './build-number.mjs'

const at = (iso: string) => new Date(iso)

describe('the build number', () => {
  it('is the UTC minute, whatever the zone it is read in', () => {
    expect(minuteStamp(at('2026-11-05T20:49:30Z'))).toBe(202611052049)
    expect(minuteStamp(at('2026-11-05T23:30:00-08:00'))).toBe(202611060730)
  })

  it('rises from one minute to the next, and across a year', () => {
    expect(nextBuildNumber(202611052049, at('2026-11-05T20:50:00Z'))).toBe(202611052050)
    expect(nextBuildNumber(202612312359, at('2027-01-01T00:00:00Z'))).toBe(202701010000)
  })

  it('still rises within a minute, and with the clock set back', () => {
    expect(nextBuildNumber(202611052049, at('2026-11-05T20:49:59Z'))).toBe(202611052050)
    expect(nextBuildNumber(202611052049, at('2026-01-01T00:00:00Z'))).toBe(202611052050)
  })

  it('starts from the clock when there is no number yet', () => {
    expect(nextBuildNumber(0, at('2026-11-05T20:49:00Z'))).toBe(202611052049)
  })

  it('stays within what App Store Connect takes for a version', () => {
    const number = String(nextBuildNumber(0, at('2099-12-31T23:59:00Z')))
    expect(number).toMatch(/^[1-9]\d*$/)
    expect(number.length).toBeLessThanOrEqual(18)
    expect(Number.isSafeInteger(Number(number))).toBe(true)
  })

  it('reads back what it wrote, and treats anything else as none', () => {
    expect(readBuildNumber('// Written by a script.\nCURRENT_PROJECT_VERSION = 202611052049\n')).toBe(202611052049)
    expect(readBuildNumber('CURRENT_PROJECT_VERSION = soon\n')).toBe(0)
    expect(readBuildNumber('')).toBe(0)
  })
})

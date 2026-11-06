/** Reading dates and amounts out of a file. Values are invented. */
import { describe, expect, it } from 'vitest'
import { parseAmount, parseDate, readDateOrder } from './csv'

describe('parseDate', () => {
  it('reads the formats banks write', () => {
    const days: [string, string][] = [
      ['2026-06-03', '2026-06-03'],
      ['2026-06-03T14:22:00Z', '2026-06-03'],
      ['2026/06/03', '2026-06-03'],
      ['2026-6-3', '2026-06-03'],
      ['06/03/2026', '2026-06-03'],
      ['6/3/26', '2026-06-03'],
      ['06-03-2026', '2026-06-03'],
      ['06.03.2026', '2026-06-03'],
      ['06/03/2026 14:22', '2026-06-03'],
      ['Jun 3, 2026', '2026-06-03'],
      ['June 3rd 2026', '2026-06-03'],
      ['Sept. 3, 2026', '2026-09-03'],
      ['3 Jun 2026', '2026-06-03'],
      ['03-Jun-26', '2026-06-03'],
    ]
    for (const [raw, day] of days) expect(parseDate(raw), raw).toBe(day)
  })

  it('reads the first number as the day when told to', () => {
    expect(parseDate('03/11/2026', 'day-first')).toBe('2026-11-03')
    expect(parseDate('13.10.2026', 'day-first')).toBe('2026-10-13')
    expect(parseDate('3-11-26', 'day-first')).toBe('2026-11-03')
  })

  it('leaves the other formats alone when told day first', () => {
    expect(parseDate('2026-06-03', 'day-first')).toBe('2026-06-03')
    expect(parseDate('Jun 3, 2026', 'day-first')).toBe('2026-06-03')
  })

  it('refuses a month or a day that cannot be', () => {
    for (const raw of ['13/10/2026', '10/32/2026', '00/10/2026', '10/00/2026', '2026-13-10', '2026-25-10', '2026-06-31', '2026-00-10']) {
      expect(parseDate(raw), raw).toBeNull()
    }
    expect(parseDate('10/13/2026', 'day-first')).toBeNull()
  })

  it('refuses a day that does not round-trip', () => {
    expect(parseDate('02/29/2026')).toBeNull()
    expect(parseDate('02/29/2028')).toBe('2028-02-29')
    expect(parseDate('04/31/2026')).toBeNull()
    expect(parseDate('Feb 30, 2026')).toBeNull()
  })

  it('refuses a year that cannot be from a statement', () => {
    for (const raw of ['10/13/1026', '10/13/3026', '2126-01-01', '1899-12-31']) expect(parseDate(raw), raw).toBeNull()
    expect(parseDate('1900-01-01')).toBe('1900-01-01')
    expect(parseDate('2100-12-31')).toBe('2100-12-31')
  })

  it('refuses what only looks like a date', () => {
    for (const raw of ['', ' ', 'n/a', 'Check 1234', 'Junk 3, 2026', 'Total', '1', '12', '10/13/0026', '10/13/202', '10/13-2026']) {
      expect(parseDate(raw), raw).toBeNull()
    }
  })
})

describe('readDateOrder', () => {
  it('reads a day above 12 in first place as day first', () => {
    expect(readDateOrder(['13/10/2026', '25/10/2026', '03/11/2026'])).toEqual({ order: 'day-first', proven: true })
  })

  it('reads a day above 12 in second place as month first', () => {
    expect(readDateOrder(['10/13/2026', '10/25/2026', '11/03/2026'])).toEqual({ order: 'month-first', proven: true })
  })

  it('cannot tell from dates that read both ways, and starts month first', () => {
    expect(readDateOrder(['03/11/2026', '05/11/2026'])).toEqual({ order: 'month-first', proven: false })
  })

  it('does not ask when the dates read the same either way', () => {
    expect(readDateOrder(['03/03/2026', '11/11/2026']).proven).toBe(true)
  })

  it('does not ask about dates with no order to get wrong', () => {
    expect(readDateOrder(['2026-06-03', 'Jun 4, 2026', '']).proven).toBe(true)
    expect(readDateOrder([]).proven).toBe(true)
  })

  it('goes with the larger side when the rows disagree, and asks', () => {
    expect(readDateOrder(['13/10/2026', '25/10/2026', '10/13/2026'])).toEqual({ order: 'day-first', proven: false })
    expect(readDateOrder(['13/10/2026', '10/13/2026'])).toEqual({ order: 'month-first', proven: false })
  })

  it('ignores a number that could be neither', () => {
    expect(readDateOrder(['45/10/2026', '10/99/2026']).proven).toBe(true)
  })
})

describe('parseAmount', () => {
  it('reads the ways a figure is written', () => {
    const amounts: [string, number][] = [
      ['12.34', 12.34],
      ['-12.34', -12.34],
      ['$1,234.56', 1234.56],
      ['(45.00)', -45],
      ['-$45.00', -45],
      ['$-45.00', -45],
      ['45.00-', -45],
      ['−45.00', -45],
      ['+45.00', 45],
      ['1,234,567.00', 1234567],
      ['.50', 0.5],
      ['5.', 5],
      ['0.00', 0],
    ]
    for (const [raw, n] of amounts) expect(parseAmount(raw), raw).toBe(n)
  })

  it('refuses a comma it cannot be sure of, rather than read a figure a hundred times too big', () => {
    for (const raw of ['12,50', '1.234,56', '1,23', '1234,567.00']) expect(parseAmount(raw), raw).toBeNull()
  })

  it('refuses what is not a figure', () => {
    for (const raw of ['', ' ', 'n/a', '$', '-', '.', '1.2.3', 'EUR 12', '--5', '12-34']) expect(parseAmount(raw), raw).toBeNull()
  })

  it('does not read a date as a figure when the wrong column is chosen', () => {
    expect(parseAmount('2026-06-03')).toBeNull()
  })
})

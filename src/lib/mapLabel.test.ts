/**
 * B68: the Accounts map labelled small tiles and left bigger, taller ones
 * blank (a tall narrow card tile, the largest debt, never got a figure). The
 * label ladder is pinned here with a fixed-width measure. Values are invented.
 */
import { describe, expect, it } from 'vitest'
import { compactForms, fitTileLabel, type Measure } from './mapLabel'

/** 7px a character at the normal size, 6px at the small one. */
const measure: Measure = (s, small) => s.length * (small ? 6 : 7)

describe('compactForms: never more than 1% off', () => {
  it('refuses a one-decimal form that rounds too far, and offers two decimals instead', () => {
    // $1.9K would be 2.6% off $1,851.37.
    expect(compactForms(1851.37)).toEqual(['$1.85K'])
    // $2.5K is 1.02% off $2,525.80.
    expect(compactForms(2525.8)).toEqual(['$2.53K'])
    // $1.2M is 2.8% off; $1.23M is well inside 1%.
    expect(compactForms(1234567.89)).toEqual(['$1.23M'])
  })

  it('keeps a one-decimal form that is close enough', () => {
    expect(compactForms(25000)[0]).toBe('$25K')
    expect(compactForms(4810)[0]).toBe('$4.8K')
  })
})

describe('fitTileLabel', () => {
  it('a tall narrow tile reads its amount up the side rather than none', () => {
    // 37x71: '−$2,526' is 49px, too wide across even at the small size.
    const label = fitTileLabel('−$2,526', compactForms(2525.8).map((s) => `−${s}`), 37, 71, measure)
    expect(label).toEqual({ amt: '−$2,526', small: false, vert: true })
  })

  it('steps a vertical amount down to the small size before giving up', () => {
    // 45x54: 42px + 14 does not fit up the side at the normal size; 36px + 14 does small.
    expect(fitTileLabel('$3,862', [], 45, 54, measure)).toEqual({ amt: '$3,862', small: true, vert: true })
  })

  it('prefers the amount across when it fits', () => {
    expect(fitTileLabel('$2,537', [], 66, 39, measure)).toEqual({ amt: '$2,537', small: false, vert: false })
  })

  it('a million-dollar tile shows $1.23M where the whole figure does not fit', () => {
    const full = '$1,234,568'
    expect(fitTileLabel(full, compactForms(1234567.89), 61, 69, measure)).toEqual({ amt: '$1.23M', small: false, vert: false })
  })

  it('never uses a short form that is no narrower than the whole figure', () => {
    // '$1.85K' is as long as '$1,851': no help, so the small whole figure wins.
    expect(fitTileLabel('$1,851', ['$1.85K'], 50, 30, measure)).toEqual({ amt: '$1,851', small: true, vert: false })
  })

  it('leaves a sliver blank', () => {
    expect(fitTileLabel('$12', [], 30, 12, measure)).toBeNull()
    expect(fitTileLabel('−$2,526', [], 18, 90, measure)).toBeNull()
    expect(fitTileLabel('$5', [], -4, -4, measure)).toBeNull()
  })

  it('a blank tile is never bigger both ways than a labelled one with the same figure', () => {
    const sizes: number[] = []
    for (let s = 10; s <= 120; s += 2) sizes.push(s)
    const full = '−$2,526'
    const short = compactForms(2525.8).map((s) => `−${s}`)
    const labelled = (w: number, h: number) => fitTileLabel(full, short, w, h, measure) != null
    for (const w of sizes)
      for (const h of sizes) {
        if (!labelled(w, h)) continue
        // Every tile at least this wide and this tall is labelled too.
        expect(labelled(w + 2, h)).toBe(true)
        expect(labelled(w, h + 2)).toBe(true)
      }
  })
})

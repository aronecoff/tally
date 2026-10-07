/**
 * Accounts map tile labels: which figure a tile of a given size shows, and how.
 * Pure (the caller passes how wide a string is drawn), so the ladder is pinned
 * in mapLabel.test.ts.
 */

/** A compact figure ($1.3K) where the whole-dollar one does not fit; one decimal, then two. */
const COMPACT = [1, 2].map(
  (digits) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }),
)
const COMPACT_MULT: Record<string, number> = { '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 }

/** Compact forms of |n| that sit within 1% of the exact figure, one decimal
 *  first. $1.9K for $1,851.37 is 2.6% off, so it is refused; $1.85K is not.
 *  A second decimal rarely helps in thousands ('$1.85K' is as wide as
 *  '$1,851') but does in millions ('$1.23M' for $1,234,567). */
export function compactForms(n: number): string[] {
  const abs = Math.abs(n)
  const out: string[] = []
  for (const f of COMPACT) {
    const s = f.format(abs)
    const m = s.match(/^\$([\d.,]+)([KMBT]?)$/)
    if (!m || out.includes(s)) continue
    const v = Number(m[1].replace(/,/g, '')) * (COMPACT_MULT[m[2]] ?? NaN)
    if (Math.abs(v - abs) <= abs * 0.01) out.push(s)
  }
  return out
}

/** How wide a string is drawn, at the normal (--fs-meta) or small (--fs-micro) size. */
export type Measure = (s: string, small: boolean) => number

export interface TileLabel {
  amt: string
  /** At --fs-micro, the name's size. */
  small: boolean
  /** Up the side, bottom to top (a tall narrow tile). */
  vert: boolean
}

/** A vertical figure needs its line (15.6px at 13px) plus its inset across the tile. */
const VERT_MIN_W = 24

/**
 * The tile's amount, or null for a sliver no true figure fits in. An amount is
 * shown whole or not at all, never cut. Across first: the whole figure, then a
 * compact one, at the normal size and then the small one (the drawn width plus
 * the 8px inset, the border and a little air). A tall narrow tile then tries the
 * same figures up its side, so it is never left blank while a smaller tile is
 * labelled. A short form is used only where it is narrower than the whole one.
 */
export function fitTileLabel(full: string, compacts: string[], wpx: number, hpx: number, measure: Measure): TileLabel | null {
  if (wpx <= 0 || hpx <= 0) return null
  const forms = (small: boolean) => {
    const w = measure(full, small)
    return [full, ...compacts.filter((c) => measure(c, small) < w)]
  }
  if (hpx >= 20) {
    for (const small of [false, true]) {
      const amt = forms(small).find((s) => wpx >= measure(s, small) + 12)
      if (amt) return { amt, small, vert: false }
    }
  }
  // Up the side: an 8px inset at the start, and clear of the 3px tier rule at the end.
  if (hpx > wpx && wpx >= VERT_MIN_W) {
    for (const small of [false, true]) {
      const amt = forms(small).find((s) => hpx >= measure(s, small) + 14)
      if (amt) return { amt, small, vert: true }
    }
  }
  return null
}

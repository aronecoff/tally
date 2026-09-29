const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

// Whole dollars: for estimates (projections, per-day averages) that are
// already rounded, and for exactly-whole amounts when trimmed.
const USD_WHOLE = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

export interface MoneyOpts {
  /** Force a leading + or − (U+2212). */
  sign?: boolean
  /** Whole dollars. For estimates and chart annotations ONLY, never for actuals. */
  approx?: boolean
  /** Drop '.00' when the amount is exactly whole ($2,875, not $2,875.00).
   *  Never rounds: $2,875.50 stays $2,875.50. */
  trim?: boolean
}

/**
 * Format a number as USD.
 *
 * - Actuals are exact to the cent. Any figure in a sentence or a hero is exact.
 * - `approx` (whole dollars) is for estimates and chart annotations only; pair it
 *   with a leading '~' in the copy.
 * - `trim` drops '.00' from exactly-whole amounts (budgets such as $2,875). It
 *   never rounds a figure that has cents.
 */
export function money(n: number, opts: MoneyOpts = {}): string {
  const whole = opts.approx || (opts.trim && Math.round(Math.abs(n) * 100) % 100 === 0)
  const formatted = (whole ? USD_WHOLE : USD).format(Math.abs(n))
  if (opts.sign) return `${n < 0 ? '−' : '+'}${formatted}`
  return `${n < 0 ? '−' : ''}${formatted}`
}

/** money() split at its last '.', so cents can be styled quietly.
 *  `whole + cents === money(n, opts)` always; cents is '' when there are none. */
export function moneyParts(n: number, opts: MoneyOpts = {}): { whole: string; cents: string } {
  const s = money(n, opts)
  const i = s.lastIndexOf('.')
  return i === -1 ? { whole: s, cents: '' } : { whole: s.slice(0, i), cents: s.slice(i) }
}

/** Whole percent with a true minus (U+2212): pct(-112.6) === '−113%'. */
export function pct(n: number): string {
  const r = Math.round(n)
  return `${r < 0 ? '−' : ''}${Math.abs(r)}%`
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

// Whole dollars — for estimates (projections, per-day averages) that are
// already rounded. Printing "$410.00" for a forecast implies cent-level
// precision the number doesn't have.
const USD_WHOLE = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

/** Format a number as USD. { sign: true } forces a leading +/−;
 *  { approx: true } drops cents (use for estimates, never for actuals). */
export function money(n: number, opts: { sign?: boolean; approx?: boolean } = {}): string {
  const formatted = (opts.approx ? USD_WHOLE : USD).format(Math.abs(n))
  if (opts.sign) return `${n < 0 ? '−' : '+'}${formatted}`
  return `${n < 0 ? '−' : ''}${formatted}`
}

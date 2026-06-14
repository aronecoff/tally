const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Format a number as USD. Pass { sign: true } to force a leading +/-. */
export function money(n: number, opts: { sign?: boolean } = {}): string {
  const formatted = USD.format(Math.abs(n))
  if (opts.sign) return `${n < 0 ? '−' : '+'}${formatted}`
  return `${n < 0 ? '−' : ''}${formatted}`
}

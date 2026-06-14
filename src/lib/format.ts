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

/** Compact form for tight spaces, e.g. $1.2k. */
export function moneyCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1000) return `${n < 0 ? '−' : ''}$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`
  return money(n)
}

// Canonicalize an institution name so SnapTrade's free-form label matches the
// hand-typed seed shell — e.g. "Charles Schwab" ~ "Schwab", "American Express"
// ~ "Amex", "Citizens Bank" ~ "Citizens", "Robinhood Securities" ~ "Robinhood".
// A connector sync claims a hand-typed shell by it (brokerage.ts), and the
// first accounts sync on a device folds a $0 shell by it (sync.ts).
const INST_ALIASES: Record<string, string> = {
  'american express': 'amex',
  'charles schwab': 'schwab',
  'citizens bank': 'citizens',
  'robinhood markets': 'robinhood',
  'robinhood securities': 'robinhood',
  'webull financial': 'webull',
}
const INST_SUFFIX = /\b(securities|markets|brokerage|bank|financial|investments?|advisors?|llc|inc|na|corp|co|company|group)\b/g

export function canonInstitution(s: string): string {
  let c = (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (INST_ALIASES[c]) return INST_ALIASES[c]
  c = c.replace(INST_SUFFIX, ' ').replace(/\s+/g, ' ').trim()
  return INST_ALIASES[c] ?? c
}

export function institutionsMatch(a: string, b: string): boolean {
  const ca = canonInstitution(a)
  const cb = canonInstitution(b)
  if (!ca || !cb) return false
  if (ca === cb) return true
  // Word-level containment for leftover cases ("charles schwab" ⊇ "schwab").
  const wa = ca.split(' ')
  const wb = cb.split(' ')
  return (ca.length >= 4 && wb.includes(ca)) || (cb.length >= 4 && wa.includes(cb))
}

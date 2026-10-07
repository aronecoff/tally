/**
 * Budget wheel colours: the approved earth palette, as themable tokens
 * (--cat-*, tokens.css). The colours seeded in the DB are bright defaults that
 * were never rendered, so the wheel keys off the category NAME.
 */

/** Built-in categories with a token of their own. */
const CAT_KEYS = new Set(['rent', 'groceries', 'shopping', 'transport', 'dining', 'subscriptions', 'health', 'fun', 'other'])
/** What a custom category may borrow: every token but Other's grey. */
const PALETTE_KEYS = ['rent', 'groceries', 'dining', 'transport', 'subscriptions', 'health', 'shopping', 'fun']

function hashOf(k: string): number {
  let h = 0
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0
  return h
}

/**
 * Slice key -> fill: a CSS colour, or null when every colour is taken (the
 * slice is then dotted). Built-ins keep their own token. Each custom slice gets
 * a colour no other visible slice uses: its name's hashed slot, or the next
 * free one, taken in name order so a colour does not move with spend from
 * month to month. Uncategorized ('uncat') is hatched and takes no colour.
 */
export function assignColors(slices: readonly { key: string; name: string }[]): Map<string, string | null> {
  const out = new Map<string, string | null>()
  const used = new Set<string>()
  const custom: { key: string; name: string }[] = []
  for (const s of slices) {
    if (s.key === 'uncat') continue
    const k = s.name.trim().toLowerCase()
    if (CAT_KEYS.has(k) && !used.has(k)) {
      out.set(s.key, `var(--cat-${k})`)
      used.add(k)
    } else custom.push(s)
  }
  for (const s of [...custom].sort((a, b) => a.name.localeCompare(b.name))) {
    const h = hashOf(s.name.trim().toLowerCase())
    let pick: string | null = null
    for (let i = 0; i < PALETTE_KEYS.length; i++) {
      const c = PALETTE_KEYS[(h + i) % PALETTE_KEYS.length]
      if (!used.has(c)) {
        pick = c
        break
      }
    }
    if (pick) used.add(pick)
    out.set(s.key, pick ? `var(--cat-${pick})` : null)
  }
  return out
}

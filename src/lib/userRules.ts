/**
 * The signed-in user's own categorization rules (public.merchant_rules).
 *
 * Personal merchants (a landlord, a local restaurant, a niche shop) belong in
 * the user's own rows, never in this source: the source ships in the public
 * bundle. The rules are compiled once, held in memory for categorize(), and
 * seeded synchronously from a localStorage cache, so an offline boot files a
 * transaction exactly as an online one does.
 *
 * Each rule carries a priority on the same scale as the built-in rules in
 * categorize.ts (multiples of 10), so a user rule can sit before, between or
 * after them. A user rule wins a tie.
 */
export type RuleKind = 'expense' | 'income'

/** One row as stored (and as cached). */
export type UserRuleRow = {
  pattern: string
  flags?: string | null
  category: string
  kind?: string | null
  priority: number
}

export type UserRule = { match: RegExp; category: string; kind: RuleKind; priority: number }

const CACHE_KEY = 'tally:merchantRules:v1'

let rows: UserRuleRow[] = []
let rules: UserRule[] = []
let ready = false

/**
 * Only i, m, s and u survive. g and y make RegExp.test() stateful (lastIndex),
 * so the same text would match on one call and miss on the next. Duplicates are
 * dropped because new RegExp('x', 'ii') throws. No flags given means 'i'.
 */
function cleanFlags(flags: string | null | undefined): string {
  if (flags == null) return 'i'
  return [...new Set(flags.split(''))].filter((f) => 'imsu'.includes(f)).join('')
}

/** A row that cannot be used (bad regex, bad kind, no category) is skipped. */
function compile(input: readonly UserRuleRow[]): UserRule[] {
  const out: UserRule[] = []
  for (const r of input) {
    if (!r || typeof r.pattern !== 'string' || !r.pattern) continue
    if (typeof r.category !== 'string' || !r.category.trim()) continue
    const kind: RuleKind | null = r.kind == null || r.kind === 'expense' ? 'expense' : r.kind === 'income' ? 'income' : null
    if (!kind) continue
    const priority = Number(r.priority)
    if (!Number.isFinite(priority)) continue
    let match: RegExp
    try {
      match = new RegExp(r.pattern, cleanFlags(r.flags))
    } catch {
      continue
    }
    out.push({ match, category: r.category.trim(), kind, priority })
  }
  return out
}

function install(next: readonly UserRuleRow[]): void {
  rows = next.map((r) => ({ pattern: r.pattern, flags: r.flags ?? null, category: r.category, kind: r.kind ?? null, priority: r.priority }))
  rules = compile(rows)
  ready = true
}

// Seed from the cache at load. A missing or unreadable cache leaves the store
// empty and not ready, which is also how a private window behaves.
try {
  const raw = localStorage.getItem(CACHE_KEY)
  if (raw) {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) install(parsed as UserRuleRow[])
  }
} catch {
  /* storage blocked or corrupt: start empty */
}

/**
 * The compiled rules. The array is replaced, never mutated, so callers can
 * memoize on its identity.
 */
export function getUserRules(): readonly UserRule[] {
  return rules
}

/** True once the rules came from the server or from the cache. */
export function userRulesReady(): boolean {
  return ready
}

/** Replace the rules with the server's rows and refresh the cache. */
export function setUserRules(next: readonly UserRuleRow[]): void {
  install(next)
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(rows))
  } catch {
    /* storage blocked: the in-memory copy still holds for this session */
  }
}

/** Forget the rules (sign-out): built-in rules only, and not ready. */
export function clearUserRules(): void {
  rows = []
  rules = []
  ready = false
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    /* ignore */
  }
}

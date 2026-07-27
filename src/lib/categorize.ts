/**
 * Auto-categorization for both hand-typed notes and real synced transactions.
 * For synced transactions the merchant category code (MCC) is the strongest
 * signal — a bank-assigned code for what the merchant sells — so we try it
 * first, then fall back to keyword matching on payee/description/memo.
 *
 * Rules are split by kind: EXPENSE_RULES only ever apply to expenses and
 * INCOME_RULES only to income. That separation is load-bearing — it stops an
 * expense whose text happens to contain "pay" (PayPal) or "zelle" from being
 * mis-filed into Salary/Freelance (an income category), which inflated the
 * budget and broke the footing.
 * All rules resolve to a category NAME; the caller maps it to the user's actual
 * category id (falling back to Uncategorized when unmatched).
 */

/**
 * Categories that are fixed monthly bills — they land once (or as a fixed set)
 * per month, so linear day-pace extrapolation is meaningless for them. The
 * budget views project them as "already known": max(spent so far, the monthly
 * budget). Shared with Analysis's fixed-vs-flexible split.
 */
const FIXED_CATEGORIES = new Set(['rent', 'subscriptions', 'health'])
export const isFixedCategory = (name: string) => FIXED_CATEGORIES.has(name.trim().toLowerCase())

type Rule = { match: RegExp; category: string }

// Expense keyword → category. First match wins, so order = priority.
const EXPENSE_RULES: Rule[] = [
  // Rent / housing (specific, first). "indiana corp" = Aron's landlord entity.
  { match: /\brent\b|landlord|property ?mgmt|leasing|apartment|indiana ?corp/i, category: 'Rent' },
  // Groceries
  { match: /grocer|whole ?foods|trader ?joe|safeway|costco|kroger|aldi|wegmans|publix|sprouts|instacart|\bh-?e-?b\b/i, category: 'Groceries' },
  // Dining — restaurants, delivery, cafes, bars
  { match: /restaurant|cafe|coffee|starbucks|blue ?bottle|doordash|uber ?eats|grubhub|postmates|chipotle|pizza|taco|sushi|kalbi|korean|\bbbq\b|dunkin|mcdonald|burger|in-?n-?out|\bbar\b|grill|kitchen|eatery|deli|bakery|ice ?cream|pints ?of ?joy|mademoiselle|brunello|homestead/i, category: 'Dining' },
  // Transport — rideshare, fuel, EV charging, transit, air, parking, auto insurance
  { match: /\buber\b|lyft|shell|chevron|exxon|\bgas\b|fuel|supercharger|charge ?point|insta ?charge|electrify|\bevgo\b|\btesla\b|parking|\bbart\b|transit|caltrain|\btoll\b|amtrak|delta|united|american air|airlines?|progressive|geico|state ?farm|allstate|\bdmv\b/i, category: 'Transport' },
  // Subscriptions — streaming, SaaS, digital, telecom, memberships
  { match: /netflix|spotify|hulu|disney|youtube|\bhbo\b|paramount|peacock|adobe|figma|canva|notion|icloud|dropbox|1password|openai|chatgpt|anthropic|\bclaude\b|vercel|github|google ?(photos|one|storage|drive)|\bapple\.com|itunes|app ?store|audible|prime ?video|kindle|patreon|substack|\bkqed\b|flowsavvy|aragon|subscription|annual ?membership/i, category: 'Subscriptions' },
  // Fitness EQUIPMENT retailers — before Health so "Rogue Fitness" doesn't
  // match the membership rule below (gear is a purchase, not healthcare).
  { match: /roguefitnes|\brogue\b/i, category: 'Shopping' },
  // Health — pharmacy, medical, fitness services (memberships, care)
  { match: /pharmacy|\bcvs\b|walgreens|rite ?aid|doctor|dental|dentist|clinic|hospital|\bgym\b|fitness|equinox|peloton|therapy|optometr/i, category: 'Health' },
  // Shopping — retail, apparel, general merchandise, online stores
  { match: /amazon|\btarget\b|walmart|best ?buy|\bikea\b|home ?depot|lowes|nordstrom|\bmacy|talbots|\basics\b|evergoods|polar ?electro|sticker ?mule|smallsforsmalls|nike|adidas|\bstore\b|\bshop\b|\.com\b/i, category: 'Shopping' },
  // Fun — entertainment, events, gaming
  { match: /movie|cinema|\bamc\b|concert|ticketmaster|stubhub|\bsteam\b|playstation|xbox|nintendo|arcade|bowling|museum/i, category: 'Fun' },
  // Apple services (kept after Shopping's apple.com so device buys read as Shopping,
  // but bare "apple" recurring charges land in Subscriptions).
  { match: /^apple$|apple ?(services|music|tv)/i, category: 'Subscriptions' },
  // Installment purchases are shopping regardless of the financing rail.
  { match: /pay ?in ?4|affirm|klarna|afterpay/i, category: 'Shopping' },
  // Person-to-person payments and cash: real spending, bucketed visibly in
  // Other (recategorize by hand when the recipient matters).
  { match: /\bzelle\b|atm withdrawal|\bzillow\b/i, category: 'Other' },
]

// Income keyword → category. Only applied to income transactions.
const INCOME_RULES: Rule[] = [
  { match: /payroll|salary|direct ?dep|paycheck|\bpaid\b/i, category: 'Salary' },
  { match: /refund|interest ?(payment|paid)?|dividend|cash ?back|rebate|reimburse/i, category: 'Other income' },
  { match: /invoice|freelance|consult|stripe|gumroad|\bclient\b/i, category: 'Freelance' },
]

// MCC (ISO 18245) → category. Everyday ranges only; applies to expenses.
const MCC: Record<string, string> = {
  // Groceries / food stores
  '5411': 'Groceries', '5422': 'Groceries', '5451': 'Groceries', '5462': 'Groceries', '5499': 'Groceries',
  // Dining
  '5812': 'Dining', '5813': 'Dining', '5814': 'Dining', '5811': 'Dining',
  // Transport / fuel / travel
  '5541': 'Transport', '5542': 'Transport', '5533': 'Transport', '5983': 'Transport',
  '4111': 'Transport', '4121': 'Transport', '4131': 'Transport', '4784': 'Transport', '7523': 'Transport',
  '4011': 'Transport', '4511': 'Transport', '3000': 'Transport', '3001': 'Transport',
  // Subscriptions / telecom / digital
  '4899': 'Subscriptions', '4814': 'Subscriptions', '4815': 'Subscriptions', '4816': 'Subscriptions',
  '5968': 'Subscriptions', '5815': 'Subscriptions', '5816': 'Subscriptions', '5817': 'Subscriptions', '5818': 'Subscriptions',
  // Health
  '5912': 'Health', '5122': 'Health', '8011': 'Health', '8021': 'Health', '8031': 'Health',
  '8041': 'Health', '8042': 'Health', '8043': 'Health', '8049': 'Health', '8062': 'Health',
  '8071': 'Health', '8099': 'Health', '7997': 'Health', '7298': 'Health',
  // Shopping / retail
  '5300': 'Shopping', '5310': 'Shopping', '5311': 'Shopping', '5331': 'Shopping', '5399': 'Shopping',
  '5611': 'Shopping', '5621': 'Shopping', '5641': 'Shopping', '5651': 'Shopping', '5661': 'Shopping', '5691': 'Shopping',
  '5732': 'Shopping', '5733': 'Shopping', '5734': 'Shopping', '5735': 'Shopping',
  '5942': 'Shopping', '5943': 'Shopping', '5945': 'Shopping', '5977': 'Shopping', '5999': 'Shopping',
  // Fun / entertainment
  '7832': 'Fun', '7841': 'Fun', '7922': 'Fun', '7929': 'Fun', '7933': 'Fun', '7941': 'Fun',
  '7991': 'Fun', '7994': 'Fun', '7996': 'Fun', '7998': 'Fun', '7999': 'Fun',
  // Rent / housing
  '6513': 'Rent',
}

/**
 * Keyword guess. Returns a category name or null.
 * `kind` scopes which rule set is used; omit it (hand-typed notes) to try
 * expense rules first, then income.
 */
export function guessCategoryName(description: string, kind?: 'expense' | 'income'): string | null {
  if (!description) return null
  if (kind === 'income') {
    for (const r of INCOME_RULES) if (r.match.test(description)) return r.category
    return null
  }
  for (const r of EXPENSE_RULES) if (r.match.test(description)) return r.category
  if (kind === 'expense') return null
  for (const r of INCOME_RULES) if (r.match.test(description)) return r.category
  return null
}

/** Full guess for a synced transaction: MCC first (expenses only), then keywords. */
export function categorize(input: {
  description?: string
  payee?: string
  memo?: string
  mcc?: string | null
  kind?: 'expense' | 'income'
}): string | null {
  if (input.kind !== 'income') {
    const mcc = (input.mcc ?? '').trim()
    if (mcc && MCC[mcc]) return MCC[mcc]
  }
  const text = [input.payee, input.description, input.memo].filter(Boolean).join(' ')
  return guessCategoryName(text, input.kind)
}

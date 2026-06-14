/**
 * Keyword → category-name rules for auto-categorizing imported rows and
 * suggesting a category while typing a note. Matches against a free-text
 * description. First match wins. Returns a category NAME (resolved to an id by
 * the caller against the user's actual categories).
 */
const RULES: { match: RegExp; category: string }[] = [
  { match: /grocer|whole ?foods|trader ?joe|safeway|costco|kroger|aldi|market\b/i, category: 'Groceries' },
  { match: /restaurant|cafe|coffee|starbucks|doordash|uber ?eats|grubhub|chipotle|pizza|taco|sushi|\bbar\b/i, category: 'Dining' },
  { match: /uber|lyft|shell|chevron|exxon|\bgas\b|fuel|parking|\bbart\b|transit|caltrain|toll/i, category: 'Transport' },
  { match: /netflix|spotify|hulu|disney\+?|youtube|adobe|figma|canva|notion|icloud|subscription|membership/i, category: 'Subscriptions' },
  { match: /pharmacy|\bcvs\b|walgreens|doctor|dental|clinic|\bgym\b|fitness|therapy/i, category: 'Health' },
  { match: /amazon|target|walmart|best ?buy|\bstore\b|\bshop\b/i, category: 'Shopping' },
  { match: /rent|landlord|property ?mgmt|leasing/i, category: 'Rent' },
  { match: /netflix|movie|cinema|concert|ticket|game|steam/i, category: 'Fun' },
  // Income
  { match: /payroll|salary|\bdeposit\b|direct ?dep|paycheck/i, category: 'Salary' },
  { match: /invoice|freelance|consult|stripe|gumroad|client/i, category: 'Freelance' },
]

export function guessCategoryName(description: string): string | null {
  if (!description) return null
  for (const rule of RULES) {
    if (rule.match.test(description)) return rule.category
  }
  return null
}

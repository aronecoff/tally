/**
 * Merchant intelligence for the transaction detail view. Bank descriptors are
 * ugly ("AMZN Mktp US*2A3BC5X", "SQ *BLUE BOTTLE #4") and carry no item-level
 * detail — banks only transmit merchant/amount/date. So the detail view shows
 * what CAN be known: a cleaned name, the brand's logo, and a deep link to the
 * merchant's own order/receipt page, which is where the purchased items live.
 */

interface Brand {
  match: RegExp
  name: string
  domain: string
  /** Where this merchant shows your order/purchase history, if they have one. */
  orderUrl?: string
  orderLabel?: string
}

// Tested against the RAW lowercased descriptor (before cleaning), so processor
// codes like "amzn" still match. First match wins.
const BRANDS: Brand[] = [
  { match: /amzn|amazon/, name: 'Amazon', domain: 'amazon.com', orderUrl: 'https://www.amazon.com/gp/css/order-history', orderLabel: 'See your Amazon orders' },
  { match: /apple\.com|apple ?bill|itunes/, name: 'Apple', domain: 'apple.com', orderUrl: 'https://reportaproblem.apple.com', orderLabel: 'See your Apple purchases' },
  { match: /paypal/, name: 'PayPal', domain: 'paypal.com', orderUrl: 'https://www.paypal.com/myaccount/activities/', orderLabel: 'See your PayPal activity' },
  { match: /venmo/, name: 'Venmo', domain: 'venmo.com' },
  { match: /target(\.com| |$|\b)/, name: 'Target', domain: 'target.com', orderUrl: 'https://www.target.com/orders', orderLabel: 'See your Target orders' },
  { match: /walmart|wal-mart/, name: 'Walmart', domain: 'walmart.com', orderUrl: 'https://www.walmart.com/orders', orderLabel: 'See your Walmart orders' },
  { match: /costco/, name: 'Costco', domain: 'costco.com', orderUrl: 'https://www.costco.com/OrderStatusCmd', orderLabel: 'See your Costco orders' },
  { match: /whole ?foods|wfm/, name: 'Whole Foods', domain: 'wholefoodsmarket.com' },
  { match: /trader ?joe/, name: "Trader Joe's", domain: 'traderjoes.com' },
  { match: /safeway/, name: 'Safeway', domain: 'safeway.com' },
  { match: /netflix/, name: 'Netflix', domain: 'netflix.com' },
  { match: /spotify/, name: 'Spotify', domain: 'spotify.com' },
  { match: /doordash|dd \*/, name: 'DoorDash', domain: 'doordash.com', orderUrl: 'https://www.doordash.com/orders', orderLabel: 'See your DoorDash orders' },
  { match: /uber ?eats/, name: 'Uber Eats', domain: 'ubereats.com', orderUrl: 'https://www.ubereats.com/orders', orderLabel: 'See your Uber Eats orders' },
  { match: /uber/, name: 'Uber', domain: 'uber.com' },
  { match: /lyft/, name: 'Lyft', domain: 'lyft.com' },
  { match: /instacart|ic\* /, name: 'Instacart', domain: 'instacart.com', orderUrl: 'https://www.instacart.com/store/account/orders', orderLabel: 'See your Instacart orders' },
  { match: /starbucks/, name: 'Starbucks', domain: 'starbucks.com' },
  { match: /chipotle/, name: 'Chipotle', domain: 'chipotle.com' },
  { match: /openai|chatgpt/, name: 'OpenAI', domain: 'openai.com' },
  { match: /anthropic|claude/, name: 'Anthropic', domain: 'anthropic.com' },
  { match: /google (one|storage|photos)/, name: 'Google One', domain: 'one.google.com' },
  { match: /youtube/, name: 'YouTube', domain: 'youtube.com' },
  { match: /audible/, name: 'Audible', domain: 'audible.com' },
  { match: /patreon/, name: 'Patreon', domain: 'patreon.com' },
  { match: /substack/, name: 'Substack', domain: 'substack.com' },
]

/** Turn a bank descriptor into a human name: strip processor prefixes, ref
 * codes, and store numbers; fix SHOUTING CAPS. */
export function cleanMerchant(raw: string): string {
  let s = raw.trim()
  // Processor prefixes (Square, Toast, Shopify, PayPal pass-through, Instacart).
  s = s.replace(/^(sq|tst|py|sp|dd|ic|pp)\s?\*\s?/i, '')
  s = s.replace(/^(pos|debit|checkcard|purchase|recurring)\s+/i, '')
  // "*2A3BC5X"-style reference codes and trailing store numbers.
  s = s.replace(/\*\s?[a-z0-9]{3,}\b/gi, '')
  s = s.replace(/#\s?\d+\b/g, '')
  s = s.replace(/\s{2,}/g, ' ').replace(/[\s*·-]+$/g, '').trim()
  // ALL CAPS → Title Case (leave mixed-case names alone). Apostrophes are NOT
  // word boundaries — "TRADER JOE'S" must become "Trader Joe's", not "Joe'S".
  if (s.length > 3 && s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|[\s./-])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase())
  }
  return s
}

export interface MerchantInfo {
  /** Human display name (brand name when recognized, cleaned descriptor otherwise). */
  name: string
  /** Brand logo (favicon service) when the merchant is recognized. */
  logoUrl: string | null
  /** Deep link to the merchant's own order/purchase history, when they have one. */
  orderUrl: string | null
  orderLabel: string | null
  /** Web search for the raw descriptor — the escape hatch for mystery charges. */
  searchUrl: string | null
}

export function merchantInfo(raw: string): MerchantInfo {
  const trimmed = raw.trim()
  const lower = trimmed.toLowerCase()
  const brand = trimmed ? BRANDS.find((b) => b.match.test(lower)) : undefined
  return {
    name: brand ? brand.name : cleanMerchant(trimmed),
    logoUrl: brand
      ? `https://www.google.com/s2/favicons?domain=${brand.domain}&sz=128`
      : null,
    orderUrl: brand?.orderUrl ?? null,
    orderLabel: brand?.orderLabel ?? null,
    searchUrl: trimmed
      ? `https://www.google.com/search?q=${encodeURIComponent(`"${trimmed}" charge`)}`
      : null,
  }
}

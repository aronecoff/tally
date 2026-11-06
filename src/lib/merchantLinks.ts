/**
 * Everything merchants.ts links out to: the logo service, each merchant's order
 * history and the web search for a mystery charge. Kept apart from the name
 * cleaning so the public build can swap these for nothing (scripts/flavor.ts):
 * a logo is a call to Google, made each time a transaction opens.
 */

/** Where a merchant shows your order/purchase history, by brand name. */
const ORDERS: Record<string, { url: string; label: string }> = {
  Amazon: { url: 'https://www.amazon.com/gp/css/order-history', label: 'See your Amazon orders' },
  Apple: { url: 'https://reportaproblem.apple.com', label: 'See your Apple purchases' },
  PayPal: { url: 'https://www.paypal.com/myaccount/activities/', label: 'See your PayPal activity' },
  Target: { url: 'https://www.target.com/orders', label: 'See your Target orders' },
  Walmart: { url: 'https://www.walmart.com/orders', label: 'See your Walmart orders' },
  Costco: { url: 'https://www.costco.com/OrderStatusCmd', label: 'See your Costco orders' },
  DoorDash: { url: 'https://www.doordash.com/orders', label: 'See your DoorDash orders' },
  'Uber Eats': { url: 'https://www.ubereats.com/orders', label: 'See your Uber Eats orders' },
  Instacart: { url: 'https://www.instacart.com/store/account/orders', label: 'See your Instacart orders' },
}

/** Brand logo (favicon service) for a recognized merchant's domain. */
export const logoFor = (domain: string): string | null => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`

/** The merchant's own order history, when they have one. */
export const orderFor = (name: string): { url: string; label: string } | null => ORDERS[name] ?? null

/** Web search for the raw descriptor: the escape hatch for mystery charges. */
export const searchFor = (raw: string): string | null => `https://www.google.com/search?q=${encodeURIComponent(`"${raw}" charge`)}`

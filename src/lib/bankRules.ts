/**
 * How a bank feed row is read: money movement (dropped), spending, income, or a
 * refund. Pure: no storage and no network, so the app, the tests and a replay of
 * a raw SimpleFIN dump all run exactly the same rules.
 */

/** One row as the simplefin Edge Function's `transactions` action returns it. */
export interface SyncedTx {
  sourceTxId: string
  account: string
  tier: string
  posted: number
  amount: number
  description: string
  payee: string
  memo: string
  mcc: string | null
  pending?: boolean
}

// NOTE on Robinhood: a blanket /\brobinhood\b/ used to sit in here, which hid
// BOTH brokerage funding AND a Robinhood-issued card bill ("Robinhood Payment …
// CCB", CCB = Coastal Community Bank, the card's issuer). When that card is not a
// connected account, its purchases never arrive — excluding the payment too
// made that whole card's spending invisible on both sides. Only genuine
// brokerage funding ("ROBINHOOD DEBITS") is excluded now.
// Money-movement that must NOT count as spending or income: internal transfers,
// card payments, investment funding (Robinhood/Webull/brokerages), and bank
// reversals (returned/declined). Zelle is handled separately (account-aware).
// `payment\W*thank`: Chase writes "Payment Thank You-Mobile" but Amex writes
// "MOBILE PAYMENT - THANK YOU", which the old literal `payment thank you` missed.
export const EXCLUDE_RE = /\btransfer\b|autopay|auto ?pay|online (payment|pmt|banking)|card ?payment|\bcredit card\b|payment\W*thank ?you|\bpymt\b|\bxfer\b|web ?xfr|e-?transfer|bill ?pay|e-?payment|\bepay\b|\bach\b.*(pmt|payment|debit|credit)|\bwire\b|to (savings|checking)|from (savings|checking)|balance ?payment|statement ?credit|robinhood ?debits|robinhood ?instant|\bwebull\b|interactive ?brokers|\bschwab\b|\bfidelity\b|\bcoinbase\b|\bvanguard\b|\bbetterment\b|\bacorns\b|brokerage|returned ?check|declin|amex ?send|sav (incr|decr)ease int/i

/**
 * A credit on a card is one of two things: the card being paid (money movement)
 * or a merchant giving money back (a refund). Issuers label their own credits
 * plainly, so a credit that reads like the issuer talking (a payment, a rewards
 * redemption) is never a refund. Deliberately broad: a missed refund leaves
 * spending exactly as high as before, but a payment read as a refund would wipe
 * out a month of spending.
 * Keep \bpmt\b bounded: Amazon purchases AND refunds both read
 * "AMAZON MKTPLACE PMTS", so it must never widen to match "PMTS".
 */
export const CARD_CREDIT_NOT_REFUND_RE = /\bpayments?\b|\bpymt\b|\bpmt\b|thank ?you|\bepay\b|auto ?pay|reward|cash ?back|redemption|redeem|pay yourself back/i

export function isoFromUnix(sec: number): string {
  // UTC components, not local: banks stamp postings at UTC midnight-ish, so a
  // local-time conversion in any UTC-negative timezone (e.g. Pacific) shifted
  // every transaction one day EARLY — breaking month boundaries and footing.
  const d = new Date((Number(sec) || 0) * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Rent paid in the last week of a month is the NEXT month's rent: it is due on
 * the 1st, so it goes out a few days early. Filing it on the 1st of the month it
 * pays for gives every month exactly one rent, instead of two in the month it
 * was paid and none in the next (which had been fixed by hand every month).
 */
export const RENT_EARLY_DAYS = 7

/** The date a rent payment made on `iso` counts on. */
export function rentDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  if (d <= daysInMonth - RENT_EARLY_DAYS) return iso
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

const txText = (t: SyncedTx) => [t.payee, t.description, t.memo].filter(Boolean).join(' ')

/**
 * Detect internal transfers / card payments: a debit on one account that pairs
 * with a credit of the SAME amount on ANOTHER account within ~5 days. That's
 * money moving between your own accounts (incl. paying a card), which must never
 * count as spend or income. Returns the set of transfer sourceTxIds.
 */
export function detectTransferIds(txs: SyncedTx[]): Set<string> {
  const ids = new Set<string>()
  const byAmt = new Map<number, SyncedTx[]>()
  for (const t of txs) {
    const cents = Math.round(Math.abs(Number(t.amount)) * 100)
    if (!cents) continue
    const list = byAmt.get(cents)
    if (list) list.push(t)
    else byAmt.set(cents, [t])
  }
  const looksLikeTransfer = (t: SyncedTx) => EXCLUDE_RE.test(txText(t))
  for (const group of byAmt.values()) {
    if (group.length < 2) continue
    // An identical amount on opposite signs is weak evidence on its own: a $40
    // refund and an unrelated $40 purchase look exactly like a transfer pair.
    // If either side of the amount is ambiguous, do not guess a partner.
    const negs = group.filter((t) => Number(t.amount) < 0)
    const poss = group.filter((t) => Number(t.amount) > 0)
    if (negs.length !== 1 || poss.length !== 1) continue
    const a = negs[0]
    const b = poss[0]
    const near = Math.abs((Number(a.posted) || 0) - (Number(b.posted) || 0)) <= 5 * 86400
    // Require corroboration from the text on at least one side. Single rows that
    // self-identify are already dropped below; the pair detector exists to reach
    // the FAR side of an obvious transfer, which often reads only "DEPOSIT".
    if (a.account !== b.account && near && (looksLikeTransfer(a) || looksLikeTransfer(b))) {
      ids.add(a.sourceTxId)
      ids.add(b.sourceTxId)
    }
  }
  return ids
}

/** Why a row is left out. Named so a replay can say exactly which rule fired. */
export type SkipRule = 'no-amount' | 'transfer-pair' | 'money-movement' | 'zelle-from-savings' | 'card-credit'

/**
 * What one feed row becomes. A `refund` is stored as an expense with a NEGATIVE
 * amount: it comes off spending in its merchant's category, in the month it
 * posts, and every total picks that up by simply adding amounts.
 */
export type BankTxVerdict = { kind: 'expense' | 'income' | 'refund' } | { kind: 'skip'; rule: SkipRule }

export function classifyBankTx(t: SyncedTx, transferIds: ReadonlySet<string>): BankTxVerdict {
  const amt = Number(t.amount)
  if (!Number.isFinite(amt) || amt === 0) return { kind: 'skip', rule: 'no-amount' }
  const text = txText(t)

  // Exclude money-movement so it never counts as spend/income:
  //  - debit↔credit pairs matched across your accounts (detectTransferIds)
  //  - keyword transfers / card payments / investment moves / reversals
  //  - Zelle OUT OF a savings/money-market account (large self-transfers);
  //    Zelle out of checking is kept as spending (you paying people).
  if (transferIds.has(t.sourceTxId)) return { kind: 'skip', rule: 'transfer-pair' }
  if (EXCLUDE_RE.test(text)) return { kind: 'skip', rule: 'money-movement' }
  if (/\bzelle\b/i.test(text) && /money ?market|savings|hysa|high ?yield/i.test(t.account || '')) {
    return { kind: 'skip', rule: 'zelle-from-savings' }
  }

  if (t.tier === 'credit') {
    if (amt < 0) return { kind: 'expense' }
    // Every card credit used to be skipped here, which hid merchant refunds and
    // left card spending overstated by each one.
    if (CARD_CREDIT_NOT_REFUND_RE.test(text)) return { kind: 'skip', rule: 'card-credit' }
    return { kind: 'refund' }
  }
  return { kind: amt < 0 ? 'expense' : 'income' }
}

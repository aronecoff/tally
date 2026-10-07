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
  /** The account's id as the `sync` action keys it (newer Edge Functions only). */
  sourceAccountId?: string
  /** The account's own name, without the institution that `account` starts with (newer Edge Functions only). */
  accountName?: string
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
// Only words that ALWAYS mean money movement live here. How a bill was paid
// (autopay, ACH, bill pay, e-pay) is PAY_CHANNEL_RE: billers print those words
// too ("GEICO AUTOPAY"), and dropping every such row hid real bills.
// Brokerage funding by ACH that names only the broker or its clearing firm
// ("APEX CLEARING ACH DEBIT" is Webull's, "ROBINHOOD MONEY ACH DEBIT") stays
// out too; a Robinhood row with card words (the "… CCB" card bill) does not.
export const EXCLUDE_RE = /\btransfer\b|card ?payment|\bcredit card\b|payment\W*thank ?you|\bxfer\b|web ?xfr|e-?transfer|\bwire\b|to (savings|checking)|from (savings|checking)|balance ?payment|statement ?credit|robinhood ?debits|robinhood ?instant|apex ?clearing|^(?=.*\brobinhood\b)(?=.*\bach\b)(?!.*\b(?:ccb|card|crd)\b)|\bwebull\b|interactive ?brokers|\bschwab\b|\bfidelity\b|\bcoinbase\b|\bvanguard\b|\bbetterment\b|\bacorns\b|brokerage|returned ?check|declin|amex ?send|sav (incr|decr)ease int/i

/** HOW a bill was paid, not WHO was paid: billers print these words too. */
export const PAY_CHANNEL_RE = /auto ?pay|online (payment|pmt|banking)|\bpymt\b|bill ?pay|e-?payment|\bepay\b|\bach\b.*(pmt|payment|debit|credit)/i

/** A card or its issuer named in the text. Robinhood is left out on purpose (see NOTE above). */
export const CARD_ISSUER_RE = /\bamex\b|american ?express|\bchase\b|\bciti(bank|cards?)?\b|\bdiscover\b|capital ?one|apple ?card|\bgs ?bank\b|goldman|barclay|synchrony|\bsyf\b|wells ?fargo|\bwf\b|bk of amer|bank of america|\bboa\b|\bus ?bank\b|\bbilt\b|\bcrd\b|\bcard(member)?\b|\bvisa\b|mastercard/i

/**
 * The row's own words say money movement. Payment-channel words count only
 * when they name a card or its issuer (a card bill paid from checking), or on
 * a card's own credit (the card being paid). A biller's autopay is spending.
 */
export const saysMoneyMovement = (text: string, t?: Pick<SyncedTx, 'tier' | 'amount'>) =>
  EXCLUDE_RE.test(text) ||
  (PAY_CHANNEL_RE.test(text) && (CARD_ISSUER_RE.test(text) || (t?.tier === 'credit' && Number(t.amount) > 0)))

/** Looser: corroboration for a pair already matched by amount across two accounts. */
const corroboratesPair = (text: string) => EXCLUDE_RE.test(text) || PAY_CHANNEL_RE.test(text)

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
 * Rent paid on or after the 20th is the NEXT month's rent: it is due on the
 * 1st, so it goes out a few days early. Filing it on the 1st of the month it
 * pays for gives every month exactly one rent, instead of two in the month it
 * was paid and none in the next (which had been fixed by hand every month).
 * The cutoff is a fixed day, not "the last N days": a distance from the 1st
 * lands on a different day in a 28-, 30- or 31-day month, so a payer on the
 * same day every month got some months with two rents and some with none.
 */
export const RENT_EARLY_FROM_DAY = 20

/** The date a rent payment made on `iso` counts on. */
export function rentDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (d < RENT_EARLY_FROM_DAY) return iso
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

/**
 * The date a bank row should carry after a hand re-file into or out of Rent,
 * or null to leave it. Only bank rows (sf:) are re-dated, and only real
 * payments: a date someone typed, a refund and income are never moved.
 *  - Into Rent: the 1st it pays for (rentDate is idempotent, so a row already
 *    on the 1st stays put).
 *  - Out of Rent: the day the bank posted it (`posted`, kept beside a moved
 *    date), when the row still carries the date Rent gave it. A row with no
 *    posted day, or one moved by hand to another day since, keeps its date.
 */
export function rentRedate(
  t: { uid?: string; date: string; type: string; amount: number; posted?: string },
  wasRent: boolean,
  isRent: boolean,
): string | null {
  if (wasRent === isRent) return null
  if (!(t.uid ?? '').startsWith('sf:') || t.type !== 'expense' || !(t.amount > 0)) return null
  if (!isRent) return t.posted && t.posted !== t.date && rentDate(t.posted) === t.date ? t.posted : null
  const d = rentDate(t.date)
  return d !== t.date ? d : null
}

/**
 * The fields a hand re-file into or out of Rent changes on a bank row (see
 * rentRedate), or null. Moving in keeps the day it leaves as `posted`, so a
 * later move out can put it back.
 */
export function rentRefile(
  t: { uid?: string; date: string; type: string; amount: number; posted?: string },
  wasRent: boolean,
  isRent: boolean,
): { date: string; posted?: string } | null {
  const date = rentRedate(t, wasRent, isRent)
  if (!date) return null
  return isRent ? { date, posted: t.posted ?? t.date } : { date }
}

/**
 * Transaction.dateMoved for a date set by hand, or by a re-file into or out of
 * Rent: any day but the bank's own (`posted`; a row without one was still on
 * the bank's day, so any new date is a move) is a move the bank never
 * re-dates, and the bank's own day put back is not.
 */
export function dateMovedMark(date: string, posted: string | undefined): boolean {
  return date !== posted
}

const txText = (t: SyncedTx) => [t.payee, t.description, t.memo].filter(Boolean).join(' ')

/**
 * Detect internal transfers / card payments: a debit on one account that pairs
 * with a credit of the SAME amount on ANOTHER account within ~5 days. That's
 * money moving between your own accounts (incl. paying a card), which must never
 * count as spend or income. Returns the set of transfer sourceTxIds.
 *
 * Pairing happens inside the window, nearest dates first, one to one. The old
 * rule gave up whenever the amount appeared more than once ANYWHERE in the
 * feed, so a $500 sweep made every month (or one unrelated $500 purchase two
 * months back) left every far-side 'DEPOSIT' counted as income.
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
  const corroborates = (t: SyncedTx) => corroboratesPair(txText(t))
  // A card row with no transfer words can only be the card side of a payment
  // (a credit in the issuer's own words). A purchase or a merchant refund on a
  // card is never used up as a transfer leg.
  const canBeLeg = (t: SyncedTx) =>
    t.tier !== 'credit' || corroborates(t) || (Number(t.amount) > 0 && CARD_CREDIT_NOT_REFUND_RE.test(txText(t)))
  const posted = (t: SyncedTx) => Number(t.posted) || 0
  for (const group of byAmt.values()) {
    if (group.length < 2) continue
    const negs = group.filter((t) => Number(t.amount) < 0 && canBeLeg(t))
    const poss = group.filter((t) => Number(t.amount) > 0 && canBeLeg(t))
    // Candidate pairs: two accounts, the credit landing up to 5 days after the
    // debit (or up to 2 before it: an issuer can credit a card payment before
    // the bank's debit posts), and the text on at least one side says money
    // movement. Single rows that self-identify are dropped by classifyBankTx
    // anyway; the pair detector exists to reach the FAR side of an obvious
    // transfer, which often reads only "DEPOSIT".
    const edges: { a: SyncedTx; b: SyncedTx; gap: number }[] = []
    for (const a of negs) {
      for (const b of poss) {
        const lead = posted(b) - posted(a)
        if (lead < -2 * 86400 || lead > 5 * 86400) continue
        if (a.account !== b.account && (corroborates(a) || corroborates(b))) edges.push({ a, b, gap: Math.abs(lead) })
      }
    }
    edges.sort((x, y) => x.gap - y.gap)
    const used = new Set<SyncedTx>()
    for (const e of edges) {
      if (used.has(e.a) || used.has(e.b)) continue
      // Two partners at exactly the same distance for one row is a guess: the
      // contested row stays unpaired (and is not paired further away either).
      const rival = edges.find((f) => f !== e && f.gap === e.gap && !used.has(f.a) && !used.has(f.b) && (f.a === e.a || f.b === e.b))
      if (rival) {
        used.add(rival.a === e.a ? e.a : e.b)
        continue
      }
      used.add(e.a)
      used.add(e.b)
      ids.add(e.a.sourceTxId)
      ids.add(e.b.sourceTxId)
    }
  }
  return ids
}

/** A bank's stand-in text for a row that has not posted: 'Credit', 'Debit'. */
const PLACEHOLDER_RE = /^(credit|debit|deposit|withdrawal|transfer|pending)$/i
const isPlaceholder = (t: SyncedTx) => PLACEHOLDER_RE.test((t.payee || t.description || '').trim())
/** Who the row says it is, letters only: 'Americanexpress Transfer' → 'americanexpresstransfer'. */
const payeeKey = (t: SyncedTx) => (t.payee || t.description || '').toLowerCase().replace(/[^a-z]/g, '')
/** The bank, from the uid the Edge Function builds (`<org domain>:<account>:<tx>`). */
const bankOf = (t: SyncedTx) => {
  const domain = t.sourceTxId.split(':')[0]
  return domain && domain !== 'sf' ? domain : null
}
/** The last four digits an account name ends with: '… Money Market (4444)' → '4444'. */
const maskOf = (account: string) => /\((\d{4})\)\s*$/.exec(account)?.[1] ?? null

/**
 * Transfers that are still pending. Until a row posts, some banks describe it
 * with a stand-in ('Credit', 'Debit', the other bank's bare name) and only the
 * posted row says 'To Checking XXXXXX1234'. So a move between your own
 * accounts was counted twice while pending (income on one account, spending on
 * the other) and a one-sided move out (savings, brokerage) counted as
 * spending. Only pending bank-account rows are read here, and only on evidence;
 * each one is read again from its own words once it posts.
 *  1. Both legs pending at the same bank: opposite amounts on two accounts
 *     within 2 days, one of them a stand-in, and no other candidate.
 *  2. The other leg already says what it is AND names this account's last
 *     four digits ('FROM CHECKING XXXXXX4444').
 *  3. It repeats a move this account already posted: same amount, same payee,
 *     posted as money movement in the last 35 days (a weekly savings sweep, a
 *     daily brokerage buy).
 */
export function detectPendingTransferIds(txs: SyncedTx[]): Set<string> {
  const ids = new Set<string>()
  const cents = (t: SyncedTx) => Math.round(Math.abs(Number(t.amount)) * 100)
  const sign = (t: SyncedTx) => Math.sign(Number(t.amount))
  const days = (a: SyncedTx, b: SyncedTx) => Math.abs((Number(a.posted) || 0) - (Number(b.posted) || 0)) / 86400
  const says = (t: SyncedTx) => saysMoneyMovement(txText(t), t)
  // Rows that already say what they are are handled by their own words.
  const unclear = txs.filter((t) => t.pending && t.tier === 'cash' && cents(t) > 0 && !says(t))

  const byBankAmount = new Map<string, SyncedTx[]>()
  for (const t of unclear) {
    const bank = bankOf(t)
    if (!bank) continue
    const key = `${bank}|${cents(t)}`
    const list = byBankAmount.get(key)
    if (list) list.push(t)
    else byBankAmount.set(key, [t])
  }
  for (const group of byBankAmount.values()) {
    const negs = group.filter((t) => sign(t) < 0)
    const poss = group.filter((t) => sign(t) > 0)
    if (negs.length !== 1 || poss.length !== 1) continue
    const [a] = negs
    const [b] = poss
    if (a.account !== b.account && days(a, b) <= 2 && (isPlaceholder(a) || isPlaceholder(b))) {
      ids.add(a.sourceTxId)
      ids.add(b.sourceTxId)
    }
  }

  const movement = txs.filter((r) => cents(r) > 0 && says(r))
  for (const t of unclear) {
    if (ids.has(t.sourceTxId)) continue
    const mask = maskOf(t.account || '')
    const key = payeeKey(t)
    const repeatable = key.length >= 4 && !isPlaceholder(t)
    const evidenced = movement.some((r) => {
      if (cents(r) !== cents(t)) return false
      if (r.account !== t.account) {
        return !!mask && sign(r) === -sign(t) && days(r, t) <= 5 && new RegExp(`(^|\\D)${mask}(\\D|$)`).test(txText(r))
      }
      const rk = payeeKey(r)
      return repeatable && !r.pending && sign(r) === sign(t) && Number(r.posted) <= Number(t.posted) &&
        days(r, t) <= 35 && rk.length >= 4 && (rk.startsWith(key) || key.startsWith(rk))
    })
    if (evidenced) ids.add(t.sourceTxId)
  }
  return ids
}

// ---- Account tiers from the account's name ---------------------------------
// The SAME rules as inferTier in supabase/functions/simplefin/index.ts (keep the
// two in step). The Edge Function falls back to the balance sign when no rule
// matches, so a card at $0 read as cash (its refunds became income) and an
// overdrawn checking read as credit (its deposits became refunds). The app
// re-reads the name and remembers a card once it has been seen as one.
// Plan numbers are word-bounded so a 4-digit mask such as "(4013)" or "(2457)"
// is never read as a 401(k) or a 457 plan.
const RETIREMENT_NAME_RE = /\b(?:401|403|457)(?:\s*\(?[kb]\)?|\b)|\bira\b|roth|retire|pension|rrsp|\bsep\b/i
const BENEFIT_NAME_RE = /\bhsa\b|health ?savings/i
const CASH_NAME_RE = /check|chequing|saving|money ?market|\bcd\b|certificate|deposit|debit|cash management|\bhysa\b|\bckg\b|\bchk\b|\bdda\b/i
const BROKERAGE_NAME_RE = /brokerage|invest|securities|\bindividual\b|margin/i
const CREDIT_NAME_RE = /credit card|line of credit|\bloc\b|\bloan\b|mortgage|\bvisa\b|master ?card|\bamex\b|american express|\bsapphire\b|\bfreedom\b|gold card|platinum card/i

export type NamedTier = 'cash' | 'credit' | 'brokerage' | 'retirement' | 'benefit'

/** The tier an account's NAME decides, or null when the name says nothing. */
export function tierFromName(name: string): NamedTier | null {
  const n = name ?? ''
  if (RETIREMENT_NAME_RE.test(n)) return 'retirement'
  if (BENEFIT_NAME_RE.test(n)) return 'benefit'
  if (CASH_NAME_RE.test(n)) return 'cash'
  if (BROKERAGE_NAME_RE.test(n)) return 'brokerage'
  if (CREDIT_NAME_RE.test(n)) return 'credit'
  return null
}

// ---- Account tiers from the account's own rows ------------------------------
// Credits only a bank account receives: pay, money a person sent by Zelle, a
// deposit made at a branch, an ATM or by phone.
const CHECKING_CREDIT_RE = /payroll|salary|direct ?dep|paycheck|\bzelle\b|\b(?:mobile|atm|branch|remote|cash|check) ?deposit/i
// Credits only a card receives: the payment that pays its bill.
const CARD_PAYMENT_RE = /payment\W*(?:thank ?you|received)|thank ?you\W*(?:for )?(?:your )?payment|auto ?pay(?:ment)?\b|\bepay(?:ment)?\b|(?:online|mobile|internet|electronic) (?:payment|pymt|pmt)/i
// A person paying you through an app ('VENMO PAYMENT RECEIVED') is not a bill being paid.
const P2P_RE = /\bzelle\b|venmo|paypal|cash ?app/i

/**
 * What an account's own feed rows say it is, or null when they say nothing.
 * Only credits are read: pay or a deposit lands in a bank account, a payment
 * received pays a card. A bank account's evidence wins when both appear.
 */
export function tierFromRows(rows: readonly SyncedTx[]): 'cash' | 'credit' | null {
  let card = false
  for (const t of rows) {
    if (!(Number(t.amount) > 0)) continue
    const text = txText(t)
    if (CHECKING_CREDIT_RE.test(text)) return 'cash'
    if (CARD_PAYMENT_RE.test(text) && !P2P_RE.test(text)) card = true
  }
  return card ? 'credit' : null
}

/**
 * The tier to read an account's rows by, in order of evidence:
 *  1. the account's name, when it decides (tierFromName);
 *  2. its own rows, when they say (tierFromRows, this feed's or remembered);
 *  3. a balance the bank shows owing: a card (or an overdrawn checking, which
 *     nothing else can tell apart while it lasts);
 *  4. stored credit stays credit at a $0 balance (a card paid in full), and
 *     when no balance is given (a transaction sync, which reads what the
 *     balance sync stored). A positive balance with nothing else to go on is
 *     a bank account in the black: the sticky rule used to keep an overdrawn
 *     once checking a card for good, its payroll stored as refunds;
 *  5. what was stored, else what the bank's balance suggested.
 */
export function effectiveTier(
  name: string,
  edgeTier: string,
  stored?: string | null,
  seen: { rows?: 'cash' | 'credit' | null; balance?: number | null } = {},
): string {
  const named = tierFromName(name)
  if (named) return named
  if (seen.rows) return seen.rows
  if (edgeTier === 'credit') return 'credit'
  if (stored === 'credit') return seen.balance === undefined || seen.balance === 0 ? 'credit' : edgeTier
  return stored ?? edgeTier
}

/** Why a row is left out. Named so a replay can say exactly which rule fired. */
export type SkipRule =
  | 'no-amount' | 'transfer-pair' | 'pending-transfer' | 'money-movement' | 'zelle-from-savings' | 'card-credit' | 'investment'

/**
 * What one feed row becomes. A `refund` is stored as an expense with a NEGATIVE
 * amount: it comes off spending in its merchant's category, in the month it
 * posts, and every total picks that up by simply adding amounts.
 */
export type BankTxVerdict = { kind: 'expense' | 'income' | 'refund' } | { kind: 'skip'; rule: SkipRule }

/** Words a merchant's refund to a debit card carries. Returned checks are money movement already. */
export const CASH_REFUND_RE = /\brefund|\breturn\b|\breversal\b/i
/** Credits to a bank account that stay income even when they say "refund". */
export const CASH_CREDIT_KEEP_INCOME_RE = /\bzelle\b|interest|dividend|payroll|salary|direct ?dep|paycheck|reimburse|\batm\b/i
/** Account names that are everyday money, whatever tier the bank's name rules guessed. */
const EVERYDAY_ACCOUNT_RE = /check|chequing|saving|money ?market|debit|visa|master ?card|amex|card|\bhsa\b/i

export function classifyBankTx(
  t: SyncedTx,
  transferIds: ReadonlySet<string>,
  pendingTransferIds: ReadonlySet<string> = new Set(),
  /** The expense category a row's merchant files under (used for refunds to a debit card). */
  merchantOf?: (t: SyncedTx) => string | null,
): BankTxVerdict {
  const amt = Number(t.amount)
  if (!Number.isFinite(amt) || amt === 0) return { kind: 'skip', rule: 'no-amount' }
  const text = txText(t)

  // Exclude money-movement so it never counts as spend/income:
  //  - debit↔credit pairs matched across your accounts (detectTransferIds)
  //  - pending transfers still wearing a stand-in text (detectPendingTransferIds)
  //  - keyword transfers / card payments / investment moves / reversals
  //  - Zelle OUT OF a savings/money-market account (large self-transfers);
  //    Zelle out of checking is kept as spending (you paying people), and
  //    Zelle INTO savings is money received.
  if (transferIds.has(t.sourceTxId)) return { kind: 'skip', rule: 'transfer-pair' }
  if (pendingTransferIds.has(t.sourceTxId)) return { kind: 'skip', rule: 'pending-transfer' }
  if (saysMoneyMovement(text, t)) return { kind: 'skip', rule: 'money-movement' }
  if (amt < 0 && /\bzelle\b/i.test(text) && /money ?market|savings|hysa|high ?yield/i.test(t.account || '')) {
    return { kind: 'skip', rule: 'zelle-from-savings' }
  }
  // Buys, sells and dividends inside a brokerage or retirement account are not
  // spending or income. An account whose name reads as everyday money is never
  // skipped, whatever its tier: a mis-tiered checking or card would otherwise
  // vanish from spending entirely.
  if ((t.tier === 'brokerage' || t.tier === 'retirement') && !EVERYDAY_ACCOUNT_RE.test(t.account || '')) {
    return { kind: 'skip', rule: 'investment' }
  }

  if (t.tier === 'credit') {
    if (amt < 0) return { kind: 'expense' }
    // Every card credit used to be skipped here, which hid merchant refunds and
    // left card spending overstated by each one.
    if (CARD_CREDIT_NOT_REFUND_RE.test(text)) return { kind: 'skip', rule: 'card-credit' }
    return { kind: 'refund' }
  }
  // A merchant's refund to a debit card offsets its category instead of
  // counting as income. Only on clear evidence: the row says refund/return, it
  // is not a Zelle, interest, payroll or fee refund, and the merchant files
  // under a real spending category. Rent is left to matchRentRefunds, which
  // dates it by the payment it reverses.
  if (amt > 0 && merchantOf && CASH_REFUND_RE.test(text) && !CASH_CREDIT_KEEP_INCOME_RE.test(text)) {
    const c = (merchantOf(t) ?? '').trim().toLowerCase()
    if (c && c !== 'other' && c !== 'rent') return { kind: 'refund' }
  }
  return { kind: amt < 0 ? 'expense' : 'income' }
}

/**
 * Rent refunds: a credit that files as Rent, matched to the payment it
 * reverses (same account, same payee, at most 35 days earlier, no smaller than
 * the refund). Returns refund sourceTxId → the payment's posted day. A refund
 * is dated no earlier than the rent it reverses (see banks.ts), so a rent paid
 * early and refunded before the 1st nets to nothing in BOTH months, instead of
 * a negative rent in one and a full rent in the next.
 */
export function matchRentRefunds(txs: SyncedTx[], isRent: (t: SyncedTx) => boolean, skip: ReadonlySet<string> = new Set()): Map<string, string> {
  const out = new Map<string, string>()
  const posted = (t: SyncedTx) => Number(t.posted) || 0
  const cents = (t: SyncedTx) => Math.round(Math.abs(Number(t.amount)) * 100)
  const payments = txs.filter((t) => Number(t.amount) < 0 && !skip.has(t.sourceTxId) && isRent(t))
  const refunds = txs
    .filter((t) => Number(t.amount) > 0 && !skip.has(t.sourceTxId) && !saysMoneyMovement(txText(t), t) && isRent(t))
    .sort((a, b) => posted(a) - posted(b))
  const used = new Set<SyncedTx>()
  for (const r of refunds) {
    const rk = payeeKey(r)
    let best: SyncedTx | null = null
    for (const p of payments) {
      if (used.has(p) || p.account !== r.account || cents(p) < cents(r)) continue
      const gap = posted(r) - posted(p)
      if (gap < 0 || gap > 35 * 86400) continue
      const pk = payeeKey(p)
      if (!rk || !pk || !(rk.startsWith(pk) || pk.startsWith(rk))) continue
      if (!best || posted(p) > posted(best)) best = p
    }
    if (best) {
      used.add(best)
      out.set(r.sourceTxId, isoFromUnix(posted(best)))
    }
  }
  return out
}

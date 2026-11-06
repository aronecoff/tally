/**
 * The personal build reads SimpleFIN in an Edge Function and the public build
 * reads it on the device. Both must file the same answer the same way, and the
 * function is deployed on its own, so the two are held together here: its
 * functions are sliced out of its own text, run, and compared over a table of
 * invented accounts.
 */
import { describe, expect, it } from 'vitest'
import edgeSource from '../../supabase/functions/simplefin/index.ts?raw'
import ownSource from './simplefinNormalize.ts?raw'
import { inferTier, normalize, transactionsOf, type SimplefinAccount, type SimplefinSet } from './simplefinNormalize'

interface Edge {
  inferTier: typeof inferTier
  normalize: typeof normalize
  transactionsOf: typeof transactionsOf
}

function slice(from: string, to: string): string {
  const start = edgeSource.indexOf(from)
  const end = edgeSource.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`the Edge Function no longer has ${from} ... ${to}`)
  return edgeSource.slice(start, end)
}

const edge = new Function(`
  ${slice('const pick =', 'Deno.serve(')}
  return {
    inferTier,
    normalize,
    transactionsOf(data) {
      ${slice('const transactions = [];', 'console.log(`[tx]')}
      return { transactions, accounts };
    },
  };
`)() as Edge

/** A function's body, with what differs between the two files' styles evened out. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  const open = source.indexOf(' {\n', start)
  const close = source.indexOf('\n}\n', open)
  if (start < 0 || open < 0 || close < 0) throw new Error(`no ${name} to read`)
  return source.slice(open, close).replaceAll('"', "'").replace(/;$/gm, '').trim()
}

const NAMES = [
  'Everyday Checking', 'Total Checking', 'Investor Checking', 'Basic Savings', 'Online Savings', 'Money Market', 'Share Certificate',
  'CD 12 Month', 'Debit Card', 'Cash Management', 'HYSA', 'CKG 1234', 'CHK 5678', 'DDA 9012',
  'Gold Card', 'Platinum Card', 'Sapphire Preferred', 'Freedom Unlimited', 'Rewards Visa', 'Mastercard', 'Master Card', 'Amex Blue',
  'American Express', 'Credit Card', 'Line of Credit', 'Home LOC', 'Auto Loan', 'Mortgage', 'Card', 'Discover', 'Credit',
  '401(k)', '401k Plan', '403(b)', '457 Plan', 'Traditional IRA', 'Roth IRA', 'Pension', 'Retirement Fund', 'RRSP', 'SEP', 'Card (4013)', 'Rewards (2457)',
  'HSA', 'Health Savings', 'Brokerage', 'Individual', 'Margin Account', 'Securities', 'Invest', 'Mystery', '', undefined, null,
]
const BALANCES = ['1200.50', '-1200.50', '0.00', '0', 88, -88, 0, '', '   ', null, undefined, 'n/a', 'NaN', 'Infinity']
const ORGS = [
  { domain: 'bank.test', name: 'Northgate Bank' },
  { domain: 'bank.test' },
  { name: 'Northgate Bank' },
  { domain: '', name: '' },
  {},
  undefined,
  null,
]
const ROWS: SimplefinAccount['transactions'][] = [
  [
    { id: 'a1', posted: 1800000000, amount: '-12.50', description: 'COFFEE 44', payee: 'Corner Cafe', memo: 'ref 1', mcc: '5814' },
    { id: 'a2', posted: 1800000100, transacted_at: 1799999000, amount: '40', description: '', payee: 'Refund Co' },
    { id: 'a3', posted: 0, pending: true, amount: -9.1, description: 'HOLD' },
    { id: 'a4', amount: 'n/a' },
    {},
  ],
  [],
  undefined,
  null,
]

const accountsTable = (): SimplefinAccount[] => {
  const out: SimplefinAccount[] = []
  let n = 0
  for (const name of NAMES) {
    for (const balance of BALANCES) {
      for (const avail of [undefined, '75.25', '-75.25']) {
        const org = ORGS[n % ORGS.length]
        out.push({
          id: `acct-${n++}`,
          name,
          balance,
          ...(avail ? { 'available-balance': avail } : {}),
          ...(n % 3 ? { currency: 'USD' } : { currency: n % 2 ? 'CAD' : undefined }),
          ...(org === undefined ? {} : { org }),
          transactions: ROWS[n % ROWS.length],
        })
      }
    }
  }
  return out
}

describe('the same answers as the Edge Function', () => {
  const table = accountsTable()

  it('has a table worth comparing', () => {
    expect(table.length).toBeGreaterThan(2000)
  })

  // A table only knows the names in it: a keyword added on one side alone passes it.
  it.each(['inferTier', 'legacyInferTier'])('has the same rules in %s, line for line', (name) => {
    expect(bodyOf(ownSource, name)).toBe(bodyOf(edgeSource, name))
    expect(bodyOf(ownSource, name)).toMatch(/\.test\(n\)/)
  })

  it('tiers every name at every balance alike', () => {
    for (const name of NAMES) {
      for (const num of [1200.5, -1200.5, 0, NaN, Infinity]) {
        expect(inferTier(name, num), `${name} at ${num}`).toBe(edge.inferTier(name, num))
      }
    }
  })

  it('normalizes every account alike, the card clamp included', () => {
    for (const a of table) expect(normalize(a)).toEqual(edge.normalize(a))
  })

  it('maps every row alike', () => {
    const set: SimplefinSet = { accounts: table }
    const mine = transactionsOf(set)
    expect(mine).toEqual(edge.transactionsOf(set))
    expect(mine.transactions.length).toBeGreaterThan(1000)
  })

  it('reads an empty answer alike', () => {
    for (const set of [{}, { accounts: [] }, { accounts: null }] as SimplefinSet[]) {
      expect(transactionsOf(set)).toEqual(edge.transactionsOf(set))
    }
  })
})

/** Parity alone would pass if both were wrong: the rules the app depends on, spelled out. */
describe('the rules themselves', () => {
  const account = (name: string, balance: string) => normalize({ id: 'x', name, balance, org: { domain: 'bank.test', name: 'Northgate Bank' } })

  it('clamps a card to owed whichever way its bank signs it', () => {
    expect(account('Rewards Visa', '310.40')).toMatchObject({ tier: 'credit', balance: -310.4 })
    expect(account('Rewards Visa', '-310.40')).toMatchObject({ tier: 'credit', balance: -310.4 })
  })

  it('leaves a card only the wider name rules know as its bank signed it', () => {
    expect(account('Gold Card', '310.40')).toMatchObject({ tier: 'credit', balance: 310.4 })
  })

  it('never inverts a deposit account, and reads an unnamed debt by its sign', () => {
    expect(account('Total Checking', '-20.00')).toMatchObject({ tier: 'cash', balance: -20 })
    expect(account('Mystery', '-20.00')).toMatchObject({ tier: 'credit', balance: -20 })
    expect(account('Mystery', '20.00')).toMatchObject({ tier: 'cash', balance: 20 })
  })

  it('has no balance rather than a zero when the bank gave none', () => {
    expect(normalize({ id: 'x', name: 'Everyday Checking', balance: '' }).balance).toBeNull()
  })

  it('falls back to the available balance', () => {
    expect(normalize({ id: 'x', name: 'Everyday Checking', balance: ' ', 'available-balance': '55.00' }).balance).toBe(55)
  })

  it('keys an account and its rows the same way', () => {
    const { transactions, accounts } = transactionsOf({
      accounts: [{ id: 'a9', name: 'Everyday Checking', balance: '1', org: { domain: 'bank.test', name: 'Northgate Bank' }, transactions: [{ id: 't1', posted: 1800000000, amount: '-3.00', payee: 'Corner Cafe' }] }],
    })
    expect(accounts).toEqual(['Northgate Bank Everyday Checking'])
    expect(transactions[0]).toMatchObject({
      sourceTxId: 'bank.test:a9:t1',
      sourceAccountId: 'bank.test:a9',
      account: 'Northgate Bank Everyday Checking',
      accountName: 'Everyday Checking',
      amount: -3,
      posted: 1800000000,
      description: 'Corner Cafe',
    })
  })

  it('reads a pending row with posted 0 as undated, never as 1970', () => {
    const { transactions } = transactionsOf({ accounts: [{ id: 'a', transactions: [{ id: 't', posted: 0, pending: true, amount: '-1' }] }] })
    expect(transactions[0].posted).toBeNull()
    expect(transactions[0].pending).toBe(true)
  })
})

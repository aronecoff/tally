/**
 * The v4 upgrade gives the seeded categories their built-in key (and every
 * category an explicit fixed flag), so a later rename no longer switches off
 * fixed-bill projection or rent dating. It must not touch updatedAt: a backfill
 * stamped "now" would win last-write-wins over the cloud on every device.
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'

describe('Dexie v4 upgrade', () => {
  it('backfills key and fixed from the name, leaving updatedAt alone', async () => {
    const old = new Dexie('tally')
    old.version(3).stores({
      categories: '++id, uid, name, kind, sortOrder',
      transactions: '++id, uid, date, type, categoryId',
      accounts: '++id, uid, type, sortOrder',
    })
    await old.open()
    const base = { icon: 'tag', color: '#fff', monthlyBudget: 0, sortOrder: 0, updatedAt: 7 }
    await old.table('categories').bulkAdd([
      { ...base, uid: 'a', name: 'Rent', kind: 'expense' },
      { ...base, uid: 'b', name: 'Coffee', kind: 'expense' },
      { ...base, uid: 'c', name: 'Other income', kind: 'income' },
      { ...base, uid: 'd', name: 'Subscriptions', kind: 'expense', key: 'subscriptions', fixed: false },
    ])
    old.close()

    const { db } = await import('./db')
    const byUid = new Map((await db.categories.toArray()).map((c) => [c.uid, c]))
    expect(byUid.get('a')).toMatchObject({ key: 'rent', fixed: true, updatedAt: 7 })
    expect(byUid.get('b')).toMatchObject({ fixed: false, updatedAt: 7 })
    expect(byUid.get('b')?.key).toBeUndefined()
    expect(byUid.get('c')).toMatchObject({ key: 'other income', fixed: false })
    // Set values are never overwritten.
    expect(byUid.get('d')).toMatchObject({ key: 'subscriptions', fixed: false })
  })
})

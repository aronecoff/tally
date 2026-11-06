import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/db'
import { seedIfEmpty } from '../../db/seed'

/**
 * The personal defaults as written in src/db/seed.ts, without their budgets. Read
 * from disk because the swap answers any import of that path with the public one,
 * and through a plain string because src/ compiles without Node's types.
 */
async function personalDefaults() {
  const fs = (await import('node:fs' as string)) as { readFileSync(path: string, encoding: 'utf8'): string }
  const source = fs.readFileSync('src/db/seed.ts', 'utf8')
  const rows = [...source.matchAll(/\{ name: '([^']+)', icon: '([^']+)', color: '([^']+)', kind: '(\w+)', monthlyBudget: \d+, sortOrder: (\d+) \}/g)]
  return rows.map(([, name, icon, color, kind, sortOrder]) => ({ name, icon, color, kind, sortOrder: Number(sortOrder) }))
}

beforeEach(() => db.categories.clear())

describe('seedIfEmpty', () => {
  it('seeds the personal shape with every budget at 0', async () => {
    await seedIfEmpty()
    const rows = await db.categories.orderBy('sortOrder').toArray()
    const want = await personalDefaults()
    expect(want.length).toBeGreaterThan(0)
    expect(rows.map(({ name, icon, color, kind, sortOrder }) => ({ name, icon, color, kind, sortOrder }))).toEqual(want)
    expect(rows.every((c) => c.monthlyBudget === 0)).toBe(true)
    expect(rows.find((c) => c.name === 'Rent')).toMatchObject({ key: 'rent', fixed: true })
  })

  it('leaves a device that has categories alone, and seeds once when called twice', async () => {
    await Promise.all([seedIfEmpty(), seedIfEmpty()])
    const count = await db.categories.count()
    await db.categories.toCollection().modify({ monthlyBudget: 75 })
    await seedIfEmpty()
    expect(await db.categories.count()).toBe(count)
    expect((await db.categories.toArray()).every((c) => c.monthlyBudget === 75)).toBe(true)
  })
})

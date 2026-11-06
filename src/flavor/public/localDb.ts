import Dexie, { type Table } from 'dexie'

/** One rule as stored: the row the cloud table held, without an owner. */
export interface LocalRule {
  id?: number
  pattern: string
  flags: string | null
  category: string
  kind: string | null
  priority: number
  updated_at: string
}

/**
 * Tell Plainsum's rules. The cloud table's place is taken by a database of its
 * own, so db.ts keeps its schema and the personal build gets no upgrade.
 */
class PlainsumLocal extends Dexie {
  rules!: Table<LocalRule, number>

  constructor() {
    super('plainsum-local')
    this.version(1).stores({ rules: '++id, pattern, priority' })
  }
}

export const localDb = new PlainsumLocal()

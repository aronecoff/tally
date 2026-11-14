/**
 * The savings plan as this device holds it: one copy in memory, read from
 * localStorage once at load, so the first paint already has the plan and an
 * offline launch enforces it. In Tally the stored value is a cache of the
 * account's row; in the public app it is the plan itself (lib/planStore.ts and
 * its public twin are the only writers).
 *
 * The copy is the plan as stored. Never read a field of it without planOn(): a
 * pending change comes into force by the date alone.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { capInForce, planOn, readPlan, type SavingsPlan } from './savingsPlan'
import { useToday } from './useToday'

/** Lower case on purpose, like the other keys the public bundle carries. */
export const PLAN_KEY = 'tally:savingsPlan:v1'

let plan: SavingsPlan | null = null
/** Bumped whenever the ledger the plan measures is erased, so a load that started before cannot land after. */
let epoch = 0
const listeners = new Set<() => void>()

/** What storage holds. A value that will not parse, or is not a plan, is removed and reads as no plan. */
function readStored(): SavingsPlan | null {
  try {
    const raw = localStorage.getItem(PLAN_KEY)
    if (raw == null) return null
    let found: SavingsPlan | null = null
    try {
      found = readPlan(JSON.parse(raw))
    } catch {
      /* not JSON */
    }
    if (!found) localStorage.removeItem(PLAN_KEY)
    return found
  } catch {
    return null // storage blocked: there is nothing to read
  }
}

/** One plan, one text: the fields in a set order, so key order never makes news. */
const canon = (p: SavingsPlan | null): string => {
  if (!p) return 'null'
  const w = p.pending
  const past = (p.pastCaps ?? []).map((c) => [c.until, c.cap])
  return JSON.stringify([p.goal, p.cap, p.locked, p.since, w ? [w.from, w.cap ?? null, w.goal ?? null, w.locked ?? null] : null, p.updatedAt, past])
}

/** Replace the copy in memory. The same plan again keeps the same object and tells no one. */
function install(next: SavingsPlan | null): void {
  if (canon(next) === canon(plan)) return
  plan = next
  listeners.forEach((f) => f())
}

plan = readStored()

// Another tab changed it (or cleared storage): both tabs hold the same plan.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === PLAN_KEY || e.key === null) install(readStored())
  })
}

/** The plan as stored, or null for no plan. The object is replaced, never mutated. */
export function getPlan(): SavingsPlan | null {
  return plan
}

/** Keep this plan in memory and in storage. False when storage refused it: the copy in memory still holds for this session. */
export function setPlan(next: SavingsPlan | null): boolean {
  install(next)
  try {
    if (next) localStorage.setItem(PLAN_KEY, JSON.stringify(next))
    else localStorage.removeItem(PLAN_KEY)
    return true
  } catch {
    return false
  }
}

const stamp = (p: SavingsPlan | null) => (p ? p.updatedAt : -1)

/**
 * Take the account's copy of the plan, unless this device already holds a newer
 * one: in memory, or in storage, which every open tab shares. A row's stamp only
 * ever moves forward (the table keeps the newer row), and no device deletes a
 * row, so no plan is older than any plan. That is the one rule that keeps an
 * answer asked for before a save, in this tab or another, from putting the older
 * plan back. Whatever is newest is written to storage again, so a write that
 * storage once refused is tried again at every load. False when storage refused
 * it this time.
 */
export function adoptPlan(next: SavingsPlan | null): boolean {
  let newest = next
  for (const held of [plan, readStored()]) if (stamp(held) > stamp(newest)) newest = held
  return setPlan(newest)
}

/** Forget the plan. Called only where the ledger it measures is erased. */
export function clearSavingsPlan(): void {
  epoch++
  try {
    localStorage.removeItem(PLAN_KEY)
  } catch {
    /* storage blocked: nothing was kept */
  }
  install(null)
}

/** Which ledger the copy belongs to; a load compares it before writing. */
export function planEpoch(): number {
  return epoch
}

export function subscribePlan(f: () => void): () => void {
  listeners.add(f)
  return () => {
    listeners.delete(f)
  }
}

/**
 * The plan as it stands today, for a screen. A pending change is folded in when
 * its month comes, within the minute useToday() ticks at and with no reload.
 */
export function useSavingsPlan(): SavingsPlan | null {
  const stored = useSyncExternalStore(subscribePlan, getPlan, getPlan)
  const today = useToday()
  return useMemo(() => planOn(stored, today), [stored, today])
}

/**
 * The budget a screen measures the month against today (savingsPlan.capInForce),
 * or null: measure against what the category budgets add up to. Every screen
 * asks here, so no two can disagree about it.
 */
export function useCapInForce(): number | null {
  const stored = useSyncExternalStore(subscribePlan, getPlan, getPlan)
  return capInForce(stored, useToday())
}

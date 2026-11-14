import { todayISO } from '../../lib/dates'
import { getPlan, setPlan } from '../../lib/planCache'
import { planToSave, type PlanChange } from '../../lib/savingsPlan'

/**
 * The savings plan, kept on the device and nowhere else: the stored value
 * lib/planCache reads at load is the plan itself. The rules are the shared ones
 * (lib/savingsPlan.ts), and this stands where the account's store stood
 * (src/lib/planStore.ts). It travels in backups (backupPolicy.ts), because the
 * phone holds the only copy.
 */

export type SaveResult = { ok: true } | { ok: false; message: string }

/** The device was read when the page loaded. */
export const loadSavingsPlan = async (): Promise<boolean> => true

/** The plan needs no account here. */
export const planCanSave = async (): Promise<boolean> => true

/** Change the plan as it stands on `today`: the clock at the moment of the save. */
export async function saveSavingsPlan(change: PlanChange, today: string = todayISO()): Promise<SaveResult> {
  const held = getPlan()
  const next = planToSave(held, change, today)
  if (!next.ok) return next
  if (setPlan({ ...next.plan, updatedAt: Date.now() })) return { ok: true }
  // Storage refused it, so it would be gone at the next launch: the plan stays what the device still holds.
  setPlan(held)
  return { ok: false, message: 'Could not save the plan on this device.' }
}

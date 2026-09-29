import type { AccountType } from '../db/db'

/**
 * The account tiers, in display order. Shared by the Accounts screen and the
 * account sheet (moved out of Accounts.tsx so the sheet can live on its own).
 */
export const TIERS: { type: AccountType; label: string; icon: string; liability?: boolean }[] = [
  { type: 'cash', label: 'Cash', icon: 'wallet' },
  { type: 'credit', label: 'Credit', icon: 'card', liability: true },
  { type: 'brokerage', label: 'Brokerage', icon: 'chart' },
  { type: 'retirement', label: 'Retirement', icon: 'briefcase' },
  { type: 'benefit', label: 'Benefits', icon: 'heart' },
]

import { db } from '../../db/db'
import { clearBankState } from '../../lib/banks'
import { forgetBankCoverage } from './bankTransport'
import { native } from './native'
import { bumpLedgerGeneration } from './sync'

/**
 * Remove the stored link. The accounts and their rows stay as the user's own, and
 * keep `sourceAccountId`, so linking the same bank again picks them up rather
 * than adding them twice. SimpleFIN still holds the access until the user revokes
 * it there, because the app has no way to do that for them.
 */
export async function disconnectBank(): Promise<void> {
  // First: a fetch in flight answers for the link that is going.
  bumpLedgerGeneration()
  await native('simplefin.disconnect')
  forgetBankCoverage()
  await db.accounts.filter((a) => a.source === 'simplefin' && a.liveSync).modify({ liveSync: false, updatedAt: Date.now() })
  clearBankState()
}

import type { BackupFile } from './backup'

/**
 * How this app treats a backup. Here the ledger's home is the cloud, so a restore
 * only ever adds what is missing (backup.ts), and this file holds no way to clear
 * or overwrite a row. Rules stay in the cloud, out of the file. The public build
 * swaps this module for its own, where the phone is the only copy
 * (scripts/flavor.ts).
 */
export type RestoreMode = 'merge' | 'replace'

export const restoreMode: RestoreMode = 'merge'

export const backupFormat: string = 'tally-backup'

/** What a backup carries beyond the ledger. */
export const backupExtras = async (): Promise<Pick<BackupFile, 'rules' | 'prefs'>> => ({ rules: [], prefs: {} })

/** There is no such thing here. */
export const replaceLedger: (file: BackupFile) => Promise<void> = async () => {
  throw new Error('This app only adds what is missing.')
}

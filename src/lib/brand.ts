/**
 * Every visible string that names the app. The public build swaps this module
 * for its own (scripts/flavor.ts), so shared code names no brand. These are the
 * exact strings the app shipped with, spaces included: `mark` and
 * `allGoodNoBudget` sit right after an icon. The personal-parity gate compares
 * them with main (scripts/personal-parity.mjs).
 */
export const brand = {
  /** Starts the names of files the app hands out. */
  fileStem: 'tally',
  /** The header and sidebar mark, after the glyph. */
  mark: ' Tally',
  /** The command bar's name. */
  tell: 'Tell Tally',
  cannotRead: 'Tally could not read its data on this device.',
  notUnderstood: 'Tally did not understand that.',
  noTellRule: (label: string) => `There is no Tell Tally rule for "${label}".`,
  bankIntro:
    'Tally connects to your bank through SimpleFIN. Your bank login stays with SimpleFIN. Tally receives balances and transactions only.',
  bankFoot: 'Read-only. Tally never sees your bank login.',
  signInToConnect: 'Sign in to Tally in Settings first, then connect.',
  signInRules: 'Sign in to change your rules.',
  signInFollow: 'Sign in to have new charges from this merchant follow too.',
  signInAlready: (category: string, who: string, noun: string) =>
    `Already filed under ${category}. Sign in to have new ${who} ${noun} follow it.`,
  /** Who feeds a live account, for its sheet. */
  sourceNoun: (source?: string): string => (source === 'snaptrade' ? 'your brokerage' : 'your bank'),
  /** Home's all-clear when no budget has been set. */
  allGoodNoBudget: ' All budgets on track. Nothing needs you.',
  /** Under Home's 'Nothing yet this month'. Empty: nothing shows. */
  homeEmpty: '',
  /** Budget's list with no budgets and nothing spent. */
  budgetEmpty: 'Nothing tracked yet this month.',
  /** Insights with nothing in the month. */
  insightsEmpty: 'Insights appear as transactions sync.',
  /** Under the rent setting. Bank rows are re-dated on each device's own sync, so
   *  two devices set differently would keep moving the same rows. */
  rentHint: 'Bank rent paid on or after the 20th counts on the 1st it pays for. Set it the same on each device.',
}

/** The name in ios/PublicApp.xcconfig, put here at build time (scripts/flavor.ts). */
declare const __PUBLIC_APP_NAME__: string

const name = __PUBLIC_APP_NAME__

/** Every visible string that names the app. See src/lib/brand.ts for the fields. */
export const brand = {
  name,
  fileStem: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  mark: ` ${name}`,
  tell: `Tell ${name}`,
  cannotRead: `${name} could not read its data on this device.`,
  notUnderstood: `${name} did not understand that.`,
  noTellRule: (label: string) => `There is no Tell ${name} rule for "${label}".`,
  bankIntro: `${name} connects to your bank through SimpleFIN. Your bank login stays with SimpleFIN. ${name} receives balances and transactions only.`,
  bankFoot: `Read-only. ${name} never sees your bank login.`,
  // Rules and banks need no account here, so nothing asks for one.
  signInToConnect: '',
  signInRules: '',
  signInFollow: '',
  signInAlready: () => '',
  sourceNoun: () => 'your bank',
  allGoodNoBudget: ' Set a budget and this will show what needs you.',
  homeEmpty: 'Tap + to add a transaction.',
  budgetEmpty: 'No budgets yet. Tap Edit to set them.',
  insightsEmpty: 'Add a transaction or import a file, and this fills in.',
  rentHint: 'Bank rent paid on or after the 20th counts on the 1st it pays for.',
}

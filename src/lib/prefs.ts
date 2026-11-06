const RENT_KEY = 'tally:rentDating'

/**
 * Rules this app has always applied, as settings. Each one stays on unless this
 * device was told otherwise. The public build swaps this module for its own,
 * where the same settings start off (scripts/flavor.ts).
 */

/** Rent paid late in the month counts on the 1st it pays for (bankRules.rentDate). */
export function rentDatingOn(): boolean {
  try {
    return localStorage.getItem(RENT_KEY) !== '0'
  } catch {
    return true
  }
}

export function setRentDating(on: boolean): void {
  try {
    localStorage.setItem(RENT_KEY, on ? '1' : '0')
  } catch {
    /* storage blocked: the rule stays as it was */
  }
}

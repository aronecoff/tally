const RENT_KEY = 'plainsum:rentDating'

/** Rent re-dating is a setting here, off unless asked for. */
export function rentDatingOn(): boolean {
  try {
    return localStorage.getItem(RENT_KEY) === '1'
  } catch {
    return false
  }
}

export function setRentDating(on: boolean): void {
  try {
    localStorage.setItem(RENT_KEY, on ? '1' : '0')
  } catch {
    /* storage blocked: the rule stays as it was */
  }
}

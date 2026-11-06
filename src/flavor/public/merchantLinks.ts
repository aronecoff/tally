/**
 * Nothing links out from a transaction. A logo is a call to Google and a search
 * sends the bank's descriptor there, and neither belongs in an app that says
 * nothing leaves the device. TransactionSheet falls back to a letter tile and
 * hides the link row when these are null.
 */
export const logoFor = (): string | null => null
export const orderFor = (): { url: string; label: string } | null => null
export const searchFor = (): string | null => null

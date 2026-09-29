/**
 * The pending tag before other meta. This is the ONLY way a screen shows it, so
 * text dumps read 'Pending · …'. The separator is markup, not ::after.
 * Pending = authorised but not yet posted: it still counts against the budget.
 */
export function Pending() {
  return (
    <>
      <span className="pending-chip">Pending</span>
      <span className="meta-sep" aria-hidden="true"> · </span>
    </>
  )
}

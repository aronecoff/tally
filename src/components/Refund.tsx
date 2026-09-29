/**
 * The refund tag before other meta, styled and separated exactly like
 * <Pending/>, so text dumps read 'Refund · …'. A refund is money back from a
 * merchant: it comes off that category's spending.
 */
export function Refund() {
  return (
    <>
      <span className="refund-chip">Refund</span>
      <span className="meta-sep" aria-hidden="true"> · </span>
    </>
  )
}

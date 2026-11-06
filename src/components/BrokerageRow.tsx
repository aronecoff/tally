import { brokerageEnabled, connectBrokerage } from '../lib/brokerage'
import { Icon } from './Icon'

/** Under Connections: a connect result. `untilSync` holds it until the next
 *  successful sync ('Finish linking…'), otherwise a success fades after NOTE_MS. */
export type ConnectNote = { text: string; err: boolean; at: number; untilSync?: boolean }

/** Accounts' 'Connect a brokerage' row, and the portal it opens. */
export function BrokerageRow({ setNote }: { setNote: (n: ConnectNote | null) => void }) {
  if (!brokerageEnabled) return null

  async function runConnectBrokerage() {
    setNote(null)
    // Open the window synchronously inside the click gesture so it is not pop-up
    // blocked after the awaited round-trip; fill in its URL once we have it.
    const win = window.open('', '_blank')
    // Cut the link back to Tally while the window is still our blank page, so the
    // portal (or any page it passes through) cannot redirect this tab. Not
    // 'noopener': that makes window.open return null and breaks the trick above.
    if (win) win.opener = null
    try {
      const url = await connectBrokerage()
      if (win) {
        win.location.href = url
        setNote({
          text: 'Finish linking in the window that opened. Balances refresh when you come back.',
          err: false,
          at: Date.now(),
          untilSync: true,
        })
      } else {
        setNote({ text: 'Allow pop-ups for this site, then tap Connect a brokerage again.', err: true, at: Date.now() })
      }
    } catch (e) {
      if (win) win.close()
      setNote({ text: e instanceof Error ? e.message : 'Could not start the connection. Try again.', err: true, at: Date.now() })
    }
  }

  return (
    <li className="row-sep">
      <button type="button" className="acct-row row-press" onClick={() => void runConnectBrokerage()}>
        <span className="cat-tile">
          <Icon name="chart" size={18} />
        </span>
        <span className="acct-main">
          <span className="acct-name">Connect a brokerage</span>
          <span className="acct-sub">Balances via SnapTrade</span>
        </span>
        <Icon name="chevron" size={14} className="chev acct-chev" />
      </button>
    </li>
  )
}

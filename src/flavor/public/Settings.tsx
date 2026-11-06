import { useEffect, useRef, useState, type RefObject } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Icon } from '../../components/Icon'
import { AlertRows, AppearanceControl, DataRows, LockRows, RentDating, ScreenRows } from '../../components/SettingsParts'
import { Sheet } from '../../components/Sheet'
import { useSheetClose } from '../../components/sheetStack'
import { bankStatus } from '../../lib/banks'
import { useArmed } from '../../lib/useArmed'
import type { ThemePref } from '../../lib/useTheme'
import { disconnectBank } from './bankLink'
import { NOTICES } from './notices'
import { hasSampleData, loadSampleData, removeSampleData } from './sampleData'
import { eraseAllData } from './sync'

interface Props {
  onClose: () => void
  pref: ThemePref
  setPref: (p: ThemePref) => void
  /** Show Categories (runs after the sheet has closed). */
  onCategories: () => void
  /** Show Accounts with the bank sheet open (runs after the sheet has closed). */
  onBankConnections: () => void
  /** Open the import sheet (runs after the sheet has closed). */
  onImport: () => void
  /** Open the backups sheet (runs after the sheet has closed). */
  onBackups: () => void
}

/**
 * Settings with no account: everything here is about this device. Exported as
 * Account because it stands in for the personal sheet (scripts/flavor.ts). The
 * navigation rows close the sheet first and navigate from its onClose, so two
 * sheets are never open at once.
 */
export function Account({ onClose, pref, setPref, onCategories, onBankConnections, onImport, onBackups }: Props) {
  const after = useRef<(() => void) | null>(null)
  return (
    <Sheet
      kind="settings"
      title="Settings"
      onClose={() => {
        const next = after.current
        after.current = null
        onClose()
        next?.()
      }}
    >
      <SettingsBody
        pref={pref}
        setPref={setPref}
        afterRef={after}
        onCategories={onCategories}
        onBankConnections={onBankConnections}
        onImport={onImport}
        onBackups={onBackups}
      />
    </Sheet>
  )
}

interface BodyProps extends Omit<Props, 'onClose'> {
  afterRef: RefObject<(() => void) | null>
}

function SettingsBody({ pref, setPref, afterRef, onCategories, onBankConnections, onImport, onBackups }: BodyProps) {
  const close = useSheetClose()
  const [noticesOpen, setNoticesOpen] = useState(false)

  const go = (next: () => void) => {
    afterRef.current = next
    close()
  }

  return (
    <>
      <AppearanceControl pref={pref} setPref={setPref} />
      <ScreenRows go={go} onCategories={onCategories} onBankConnections={onBankConnections} />
      <DataRows go={go} onImport={onImport} onBackups={onBackups} />
      <LockRows />
      <AlertRows />
      <RentDating />
      <SampleData />
      <DisconnectBank />

      <div className="sheet-group">
        <button type="button" className="sheet-row" aria-expanded={noticesOpen} onClick={() => setNoticesOpen((o) => !o)}>
          <Icon name="book" size={18} />
          <span>Acknowledgements</span>
          <Icon name="chevron" size={14} className={`chev${noticesOpen ? ' open' : ''}`} />
        </button>
        {noticesOpen && (
          <div className="sheet-reveal">
            {NOTICES.map((n) => (
              <details key={n.name} className="ack">
                <summary className="ack-head">
                  <span className="sheet-note">
                    {n.name}. {n.by}. {n.license}.
                  </span>
                  <Icon name="chevron" size={14} className="chev" />
                </summary>
                <pre className="ack-text">{n.text}</pre>
              </details>
            ))}
          </div>
        )}
      </div>

      <EraseAll />
    </>
  )
}

/** Sample data in, or out again. Removing it leaves everything else as it is. */
function SampleData() {
  const loaded = useLiveQuery(hasSampleData, [])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function run() {
    setBusy(true)
    setFailed(false)
    try {
      await (loaded ? removeSampleData() : loadSampleData())
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (loaded === undefined) return null
  return (
    <>
      <div className="sheet-group">
        <button type="button" className="sheet-row" disabled={busy} onClick={() => void run()}>
          <Icon name="sparkles" size={18} />
          <span>{loaded ? 'Remove sample data' : 'Load sample data'}</span>
          <span />
        </button>
      </div>
      {failed && <p className="sheet-err">That did not work. Try again.</p>}
    </>
  )
}

/** Two taps, then everything on this device is gone and the app starts over. */
function EraseAll() {
  const { armed, arm } = useArmed(6000)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function erase() {
    setBusy(true)
    setFailed(false)
    try {
      await eraseAllData() // the page reloads
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <div className="sheet-danger">
      <p className="sheet-note">
        Erasing removes everything from this phone, the bank link included, and cannot be undone. If a bank is linked,
        revoke it at SimpleFIN afterwards.
      </p>
      {failed && <p className="sheet-err">Could not erase. Try again.</p>}
      <button
        type="button"
        className="sheet-signout"
        disabled={busy}
        onClick={() => {
          if (arm()) void erase()
        }}
      >
        {busy ? 'Erasing…' : armed ? 'Tap again to erase' : 'Erase all data'}
      </button>
    </div>
  )
}

/**
 * Removes the stored link, there only when one exists. The app cannot revoke the
 * access itself, so it says so and points to where the user can.
 */
function DisconnectBank() {
  const [linked, setLinked] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let live = true
    void bankStatus().then((connected) => {
      if (live) setLinked(connected)
    })
    return () => {
      live = false
    }
  }, [])

  async function disconnect() {
    setBusy(true)
    setFailed(false)
    try {
      await disconnectBank()
      setDone(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <>
        <p className="sheet-note">Disconnected. To finish, revoke access at SimpleFIN.</p>
        <div className="sheet-group">
          <a className="sheet-row sheet-link" href="https://bridge.simplefin.org/" target="_blank" rel="noopener noreferrer">
            <Icon name="bank" size={18} />
            <span>Open SimpleFIN</span>
            <Icon name="chevron" size={14} className="chev" />
          </a>
        </div>
      </>
    )
  }
  if (!linked) return null
  return (
    <div className="sheet-group">
      <button type="button" className="sheet-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="bank" size={18} />
        <span>Disconnect bank</span>
        <Icon name="chevron" size={14} className={`chev${open ? ' open' : ''}`} />
      </button>
      {open && (
        <div className="sheet-reveal">
          <p className="sheet-note">Your accounts and transactions stay here and stop updating.</p>
          {failed && <p className="sheet-err">Could not disconnect. Try again.</p>}
          <button type="button" className="sheet-signout" disabled={busy} onClick={() => void disconnect()}>
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      )}
    </div>
  )
}

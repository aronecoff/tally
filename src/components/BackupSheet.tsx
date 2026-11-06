import { useEffect, useState, type ChangeEvent } from 'react'
import {
  BackupError, exportBackup, listBackups, parseBackup, planRestore, readBackup, restoreBackup,
  type BackupEntry, type BackupFile, type Counts, type RestorePlan,
} from '../lib/backup'
import { decodeText } from '../lib/importFile'
import { canPickFile, canSaveFile, hasNative } from '../lib/native'
import { useArmed } from '../lib/useArmed'
import { Icon } from './Icon'
import { Sheet, SheetActions } from './Sheet'
import { useSheetClose } from './sheetStack'

/** Settings' Backups: what the app has saved, and a way to keep or restore a copy. */
export function BackupSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet kind="backups" title="Backups" onClose={onClose}>
      <BackupBody />
    </Sheet>
  )
}

const whenFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const when = (ms: number) => whenFormat.format(new Date(ms))

const n = (count: number, word: string, many = `${word}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? word : many}`

const list = (parts: string[]) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`)

/** "12 transactions, 1 category and 3 accounts". */
function holds(c: Counts): string {
  return list([n(c.transactions, 'transaction'), n(c.categories, 'category', 'categories'), n(c.accounts, 'account')])
}

/** The same, with what there is none of left out: "12 transactions and 3 accounts". */
function adding(c: Counts): string {
  const parts: [number, string, string?][] = [[c.transactions, 'transaction'], [c.categories, 'category', 'categories'], [c.accounts, 'account']]
  return list(parts.filter(([count]) => count > 0).map(([count, word, many]) => n(count, word, many)))
}

interface Review {
  file: BackupFile
  plan: RestorePlan
}

function BackupBody() {
  const close = useSheetClose()
  const saves = canSaveFile()
  const [saved, setSaved] = useState<BackupEntry[] | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void listBackups().then((list) => {
      if (live) setSaved(list)
    })
    return () => {
      live = false
    }
  }, [])

  /** Everything that can fail before anything is written. */
  async function open(read: () => Promise<string>) {
    if (busy) return
    setBusy(true)
    setErr(null)
    setNote(null)
    try {
      const file = parseBackup(await read())
      setReview({ file, plan: await planRestore(file) })
    } catch (e) {
      setErr(e instanceof BackupError ? e.message : 'Could not read that backup. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function choose(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0]
    e.target.value = '' // the same file can be chosen again
    if (picked) await open(async () => decodeText(await picked.arrayBuffer()))
  }

  async function keep() {
    setBusy(true)
    setErr(null)
    setNote(null)
    try {
      if (await exportBackup()) setNote('Exported a backup.')
    } catch {
      setErr('Could not export. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (review) return <Review file={review.file} plan={review.plan} onBack={() => setReview(null)} />

  return (
    <>
      <p className="sheet-note">
        {hasNative()
          ? 'A copy of your data is saved on this phone as you go, and up to 7 are kept across recent days. They go if the app is deleted, so export one now and then to keep it somewhere else.'
          : saves
            ? 'Export a backup to keep a copy of your data, or restore one from a file.'
            : 'Restore a copy of your data from a backup file.'}
      </p>

      {saved && saved.length > 0 && (
        <div className="sheet-group">
          {saved.map((b) => (
            <button key={b.name} type="button" className="sheet-row" disabled={busy} onClick={() => void open(() => readBackup(b.name))}>
              <Icon name="box" size={18} />
              <span>{when(b.at)}</span>
              <Icon name="chevron" size={14} className="chev" />
            </button>
          ))}
        </div>
      )}

      <div className="sheet-group">
        {saves && (
          <button type="button" className="sheet-row" disabled={busy} onClick={() => void keep()}>
            <Icon name="share" size={18} />
            <span>Export a backup</span>
            <span />
          </button>
        )}
        {canPickFile() && (
          <label className="sheet-row import-choose">
            <Icon name="download" size={18} />
            <span>Restore from a file</span>
            <Icon name="chevron" size={14} className="chev" />
            <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => void choose(e)} hidden />
          </label>
        )}
      </div>

      {note && <p className="sheet-note">{note}</p>}
      {err && <p className="sheet-err">{err}</p>}

      <SheetActions>
        <button type="button" className="btn-primary" onClick={close}>
          Done
        </button>
      </SheetActions>
    </>
  )
}

/** What a restore would do, and the only way on to it: a confirming second tap. */
function Review({ file, plan, onBack }: Review & { onBack: () => void }) {
  const close = useSheetClose()
  const { armed, arm, disarm } = useArmed(6000)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [added, setAdded] = useState<Counts | null>(null)

  const merge = plan.mode === 'merge'
  const total = plan.add.transactions + plan.add.categories + plan.add.accounts
  const stamp = Date.parse(file.exportedAt)

  async function run() {
    setBusy(true)
    setFailed(false)
    try {
      const result = await restoreBackup(file) // replacing reloads the page
      if (result) setAdded(result)
    } catch {
      setFailed(true)
      setBusy(false)
      disarm()
    }
  }

  if (added) {
    return (
      <>
        <p className="sheet-note">{adding(added) ? `Added ${adding(added)}.` : 'Nothing was missing by then.'}</p>
        <SheetActions>
          <button type="button" className="btn-primary" onClick={close}>
            Done
          </button>
        </SheetActions>
      </>
    )
  }

  const left = [
    plan.here > 0 && `${n(plan.here, 'transaction')} already here.`,
    plan.removed > 0 && `${n(plan.removed, 'transaction')} removed since, and staying out.`,
    plan.alike > 0 && `${n(plan.alike, 'transaction')} matching one already here in amount and day, and staying out.`,
  ].filter(Boolean)

  return (
    <>
      <p className="sheet-note">
        {Number.isNaN(stamp) ? 'This backup' : `This backup from ${when(stamp)}`} holds {holds(plan.backup)}.
      </p>
      {merge ? (
        <>
          <p className="sheet-note">
            {total > 0
              ? `Restoring adds ${adding(plan.add)} missing here. Nothing here is changed or removed.`
              : 'Nothing in it is missing here, so there is nothing to add.'}
          </p>
          {left.length > 0 && <p className="sheet-note">{left.join(' ')}</p>}
        </>
      ) : (
        <p className="sheet-note">
          Restoring replaces everything on this phone, which holds {holds(plan.current)} now.
          {hasNative() && ' A copy of what is here is saved first.'}
        </p>
      )}
      {failed && <p className="sheet-err">Could not restore. Nothing was changed. Try again.</p>}

      <SheetActions>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onBack}>
          Back
        </button>
        {(!merge || total > 0) && (
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => {
              if (arm()) void run()
            }}
          >
            {busy ? 'Restoring…' : armed ? (merge ? 'Tap again to add' : 'Tap again to replace') : 'Restore'}
          </button>
        )}
      </SheetActions>
    </>
  )
}

import { useId, useMemo, useState, type ChangeEvent, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction } from '../db/db'
import { isAllPlain, isSplit, marksOf, readDateOrder, rereadCells, saysWay, waysClash, type DateOrder } from '../lib/csv'
import {
  importRows, lastImport, rowEffect, stageRows, summarizeImport, undoImport,
  type ImportBatch, type ImportColumns, type LargestRow, type LeftOutRow, type SignMode, type StagedFile, type StagedRow,
} from '../lib/csvImport'
import { dayLabel } from '../lib/dates'
import { money } from '../lib/format'
import { ImportFileError, readImportFile, readTableSign, type ImportFile, type SignDoubt, type SignNote } from '../lib/importFile'
import { rovingKeys } from '../lib/pressable'
import { FILE_UID, matchLedger } from '../lib/rowMatch'
import { useArmed } from '../lib/useArmed'
import { Icon } from './Icon'
import { Sheet, SheetActions } from './Sheet'
import { useSheetClose, useSheetDirty } from './sheetStack'

const KINDS: { value: boolean; label: string }[] = [
  { value: false, label: 'Bank account' },
  { value: true, label: 'Card' },
]

const CHARGES: { value: boolean; label: string }[] = [
  { value: false, label: 'Charges are negative' },
  { value: true, label: 'Charges are positive' },
]

const MARKS: { value: boolean; label: string }[] = [
  { value: false, label: 'Marks mean money in' },
  { value: true, label: 'Ignore the marks' },
]

const ORDERS: { value: DateOrder; label: string }[] = [
  { value: 'month-first', label: 'Month first' },
  { value: 'day-first', label: 'Day first' },
]

const PREVIEW = 5
const NO_CATEGORIES: Category[] = []
const NO_ROWS: Transaction[] = []
const NOTHING_STAGED: StagedFile = { rows: [], leftOut: [] }

/**
 * What the picker offers. iOS has no type for OFX or QFX, so listing their
 * extensions greys those files out. The generic type keeps them choosable and still
 * opens the file picker, where leaving `accept` off offers the photo library first.
 * The file is read by what is in it.
 */
const FILE_TYPES = '.csv,.ofx,.qfx,.qbo,text/csv,application/octet-stream'

const ROLES: { key: 'date' | 'amount' | 'inflow' | 'direction' | 'note'; label: string; none?: string }[] = [
  { key: 'date', label: 'Date' },
  { key: 'amount', label: 'Amount' },
  { key: 'inflow', label: 'Money in', none: 'None' },
  { key: 'direction', label: 'In or out', none: 'None' },
  { key: 'note', label: 'Description', none: 'None' },
]

/** Why a file cannot say which way its money runs. */
const WHY_ASK: Record<SignDoubt | 'plain', string> = {
  plain: 'Most of these figures are positive. On a bank account that is money in, and some cards list charges that way. Check the rows below.',
  mixed: 'These figures run both ways, and nothing in the file says which way is spending. On a bank account a plain figure is money in, and some cards list charges that way. Check the rows below.',
  payment: 'A line here reads like a card being paid, but the rows around it look like a bank account. Check the rows below.',
  card: 'This file reads partly like a card and partly like a bank account. On a bank account money in is income, and on a card it is a refund. Check the rows below.',
  back: 'Most of the money going out here reads like money coming back, as a card lists it. On a card those rows come off your spending, and on a bank account they are spending. Check the rows below.',
}

/** What a read rests on, where one line or one column could have made it. The file is read, and a person can change it above. */
const RESTS_ON: Record<SignNote, string> = {
  line: 'A line here reads like a card being paid, so this reads as a card. If it is a bank account, choose Bank account above.',
  column: 'A column here reads like a card’s, so this reads as a card. If it is a bank account, choose Bank account above.',
  lean: 'These figures run both ways, and nothing in the file settles whose they are, so this reads as a bank account, where money in is income. If it is a card, choose Card above.',
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const columnName = (file: ImportFile, at: number) => file.headers[at] || `Column ${at + 1}`

/** A table with no names for its columns gets numbers for them (`readTable`). */
const isNumbered = (file: ImportFile) => file.headers.every((h, i) => h === `Column ${i + 1}`)

/** Whether marks on some figures are what makes the rest read as money out. */
const marksDecide = (cols: ImportColumns, mode: SignMode) => !!cols.marked && (cols.way === 'out' || mode === 'card-positive')

/** What a file's marks did to its figures, so a read that hangs on a few marks can be seen. */
function marksNote({ marked, rest }: { marked: number; rest: number }): string {
  const said = `${plural(marked, 'figure')} ${marked === 1 ? 'is' : 'are'} marked as money in`
  return rest > 0 ? `${said}, so the other ${rest} read${rest === 1 ? 's' : ''} as money out.` : `${said}.`
}

/** What the rows of a file with one way of saying it show, so a read that hangs on one column can be seen. */
function wayNote(file: ImportFile, cols: ImportColumns, rows: StagedRow[]): string | null {
  const going = rows.filter((r) => rowEffect(r) === 'out').length
  const coming = rows.length - going
  const oneWay = rows.length > 0 && (coming === 0 || going === 0)
  const missing = 'If money also went the other way, it is not in this file.'
  if ((cols.direction ?? -1) >= 0 && rows.length > 0) {
    return `${columnName(file, cols.direction!)} says which way each row ran: ${going} money out, ${coming} money in.${oneWay ? ` ${missing}` : ''}`
  }
  if (cols.way && oneWay) return `${columnName(file, cols.amount)} is the only column of money here, so every row reads as money ${going ? 'out' : 'in'}. ${missing}`
  return null
}

/** A column could say which way a file's figures ran: one does, or one is left over beside plain figures. Signed figures say it themselves. */
function canPickWay(file: ImportFile, cols: ImportColumns): boolean {
  if ((cols.direction ?? -1) >= 0 || waysClash(cols, file.headers, file.rows)) return true
  const taken = [cols.date, cols.amount, cols.note, cols.memo]
  return isAllPlain(cols, file.rows) && file.headers.some((_, i) => !taken.includes(i))
}

/** Which columns a file's rows are read from, for the row its pickers fold into. */
const columnsRead = (file: ImportFile, cols: ImportColumns) =>
  ROLES.flatMap(({ key }) => (cols[key] ?? -1) >= 0 ? [columnName(file, cols[key]!)] : []).join(', ')

/** The day an import happened, by this device's clock. */
const importDay = (at: number) => {
  const d = new Date(at)
  return dayLabel(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, new Date().getFullYear())
}

/** Bring in a file on its own, from the Import a file rows in Accounts and Settings. */
export function ImportSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet kind="import" title="Import a file" onClose={onClose}>
      <ImportBody />
    </Sheet>
  )
}

interface BodyProps {
  /** What the last button does. Unset, it closes the sheet. */
  onDone?: () => void
  doneLabel?: string
}

/** Choose a file, say which columns are which, and bring in the rows that are new. */
export function ImportBody({ onDone, doneLabel = 'Done' }: BodyProps) {
  const close = useSheetClose()
  const formId = useId()
  const categories = useLiveQuery(() => db.categories.filter((c) => !c.deleted).toArray(), []) ?? NO_CATEGORIES
  const ledger = useLiveQuery(() => db.transactions.toArray(), []) ?? NO_ROWS
  const [file, setFile] = useState<ImportFile | null>(null)
  const [cols, setCols] = useState<ImportColumns>({ date: -1, amount: -1, note: -1 })
  const [cardPick, setCardPick] = useState<boolean | null>(null)
  const [plainPick, setPlainPick] = useState<boolean | null>(null)
  const [orderPick, setOrderPick] = useState<DateOrder | null>(null)
  const [ticks, setTicks] = useState<ReadonlyMap<number, boolean>>(new Map())
  const [showAll, setShowAll] = useState(false)
  const [picked, setPicked] = useState(false)
  const [bringBack, setBringBack] = useState(false)
  const [undone, setUndone] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ imported: number; skipped: number; leftOut: number; at: number } | null>(null)

  const dates = useMemo(
    () => readDateOrder(file && cols.date >= 0 ? file.rows.map((r) => r[cols.date] ?? '') : []),
    [file, cols.date],
  )
  const order = orderPick ?? dates.order
  const split = isSplit(cols)
  const sided = saysWay(cols)
  // What the file says through the columns as they stand: a person can pick others.
  const reading = useMemo(() => (file?.format === 'csv' && !file.kinds ? readTableSign(file, cols) : null), [file, cols])
  const sign = reading?.sign ?? file?.sign ?? 'negative-expense'
  const card = cardPick ?? sign !== 'negative-expense'
  // A file that settled nothing and turns out to be a card lists its charges as most of its figures run.
  const plainCharges = plainPick ?? (reading && !reading.proven ? reading.plain : sign === 'card-positive')
  const mode: SignMode = !card ? 'negative-expense' : plainCharges && !sided ? 'card-positive' : 'card-negative'
  const { rows: staged, leftOut } = useMemo(
    () =>
      file
        ? stageRows(file.rows, cols, mode, categories, { order, ids: file.ids, cards: file.cards, kinds: file.kinds, paid: card ? file.paid : undefined, account: file.account })
        : NOTHING_STAGED,
    [file, cols, mode, card, categories, order],
  )
  const { fresh, here, removed, twins } = useMemo(() => matchLedger(staged, ledger), [staged, ledger])
  // Rows removed earlier stay out unless a person asks for them.
  const open = useMemo(() => (bringBack ? [...fresh, ...removed] : fresh), [bringBack, fresh, removed])
  const startsOff = (r: StagedRow) => r.movement || twins.has(r)
  // Rows that start unticked come first, where they can be seen.
  const listed = useMemo(
    () => [...open].sort((a, b) => Number(b.movement || twins.has(b)) - Number(a.movement || twins.has(a))),
    [open, twins],
  )
  const isTicked = (r: StagedRow) => ticks.get(r.line) ?? !startsOff(r)
  const chosen = open.filter(isTicked)
  // Only rows that would count twice are left, and none has been ticked in.
  const nothingNew = staged.length > 0 && chosen.length === 0 && open.every(startsOff)
  // A file that cannot settle its sign writes nothing until a person has said.
  const asks = !!reading && !reading.proven && open.length > 0
  const waiting = asks && cardPick == null && plainPick == null
  const last = useMemo(() => lastImport(ledger), [ledger])
  // Rows of the last import that this reading of the file sees another way: the
  // same id with other money, or the same money with other words. The file's first
  // reading can be the one a person corrected, so other money only counts once they
  // change it here. A look-alike or two is chance, between two files, and most of a
  // file is that file again.
  const reread = !!file && (mode !== file.sign || sided !== saysWay(file.cols))
  const differs = useMemo(() => {
    if (!last) return 0
    const inLast = (t?: Transaction) => t?.createdAt === last.at && !!t.uid?.startsWith(FILE_UID)
    const byUid = new Map(ledger.map((t) => [t.uid, t]))
    const changed = reread
      ? here.filter((r) => {
          const t = byUid.get(r.uid)
          return inLast(t) && (t!.amount !== r.amount || t!.type !== r.type)
        })
      : []
    const alike = [...twins.values()].filter(inLast).length
    return changed.length + (alike * 2 > staged.length ? alike : 0)
  }, [here, twins, ledger, last, staged, reread])
  useSheetDirty(!!file && !done && !nothingNew)

  async function choose(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0]
    e.target.value = '' // the same file can be chosen again
    if (!picked) return
    setErr(null)
    try {
      const read = await readImportFile(picked)
      setCols(read.cols)
      setFile(read)
    } catch (e) {
      setErr(e instanceof ImportFileError ? e.message : 'Could not read that file. Try again.')
    }
  }

  async function run() {
    if (busy || chosen.length === 0 || waiting) return
    setBusy(true)
    setErr(null)
    try {
      const result = await importRows(staged, { chosen, bringBack })
      setDone({
        imported: result.imported,
        skipped: result.skipped + here.length + (bringBack ? 0 : removed.length),
        leftOut: leftOut.length + open.length - chosen.length,
        at: result.at,
      })
    } catch {
      setErr('Could not import. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <>
        <p className="sheet-note">
          Imported {done.imported} transaction{done.imported === 1 ? '' : 's'}.
          {done.skipped > 0 && ` Skipped ${done.skipped} already here.`}
          {done.leftOut > 0 && ` Left out ${done.leftOut} row${done.leftOut === 1 ? '' : 's'}.`}
        </p>
        {err && <p className="sheet-err">{err}</p>}
        <SheetActions>
          {done.imported > 0 && (
            <UndoImport
              at={done.at}
              className="btn-ghost"
              onError={setErr}
              onUndone={() => {
                setDone(null)
                setBringBack(true)
              }}
            >
              {(armed) => (armed ? 'Tap again to undo' : 'Undo')}
            </UndoImport>
          )}
          <button type="button" className="btn-primary" onClick={onDone ?? close}>
            {doneLabel}
          </button>
        </SheetActions>
      </>
    )
  }

  if (!file) {
    return (
      <>
        <p className="sheet-note">
          Export a CSV, OFX or QFX from your bank or card, then choose it here. You see every row before anything is
          saved, and rows already in the app are skipped.
        </p>
        {last && (
          <UndoRow
            batch={last}
            onError={setErr}
            onUndone={(rows) => {
              setUndone(rows)
              setBringBack(true)
            }}
          />
        )}
        {undone != null && <p className="sheet-note">Removed {plural(undone, 'row')}. Choose the file again to bring it in another way.</p>}
        {err && <p className="sheet-err">{err}</p>}
        <SheetActions>
          <label className="btn-primary import-choose">
            Choose a file
            <input type="file" accept={FILE_TYPES} onChange={(e) => void choose(e)} hidden />
          </label>
        </SheetActions>
      </>
    )
  }

  const whatFrom = !file.kinds && file.format === 'csv' && <Seg label="What this file is from" options={KINDS} value={card} onChange={setCardPick} />
  const howCharges = card && !sided && <Seg label="How charges read" options={CHARGES} value={plainCharges} onChange={setPlainPick} />
  const sayWay = wayNote(file, cols, staged)
  const marks = marksOf(cols, file.rows)
  const marksSay = marks && marksDecide(cols, mode)
  // Named columns that read most rows leave a person nothing to do here, unless a column could answer the question above. A file's footer is a few rows left out.
  const columnsSettled = !isNumbered(file) && cols.date >= 0 && cols.amount >= 0 && staged.length > leftOut.length && !(asks && !sided && canPickWay(file, cols))

  return (
    <form
      id={formId}
      className="sheet-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void run()
      }}
    >
      {asks && (
        <div className="import-ask">
          <div role="alert">
            <p className="import-ask-title">Is this a bank account or a card?</p>
            <p className="sheet-note">{WHY_ASK[reading.doubt ?? 'plain']}</p>
          </div>
          {whatFrom}
          {howCharges}
        </div>
      )}

      {file.format === 'ofx' ? (
        <p className="sheet-note">
          {file.title}: {plural(file.rows.length, 'row')}.
        </p>
      ) : (
        <>
          <details className="field-group import-columns" open={picked || !columnsSettled}>
            <summary className="field-line">
              <span>Columns</span>
              <span className="import-select">
                <span className="import-columns-read">{columnsRead(file, cols)}</span>
                <Icon name="chevron" size={13} />
              </span>
            </summary>
            {ROLES.filter((role) => role.key !== 'direction' || canPickWay(file, cols)).map((role) => (
              <label className="field-line" key={role.key}>
                <span>{role.key === 'amount' && split ? 'Money out' : role.label}</span>
                <span className="import-select">
                  <select
                    value={cols[role.key] ?? -1}
                    onChange={(e) => {
                      setPicked(true)
                      setCols(rereadCells({ ...cols, [role.key]: Number(e.target.value) }, file.headers, file.rows))
                      if (role.key === 'date') setOrderPick(null)
                    }}
                  >
                    <option value={-1}>{role.none ?? 'Choose'}</option>
                    {file.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {isNumbered(file) ? `${h}: ${file.rows.find((r) => r[i]?.trim())?.[i]?.trim() ?? 'empty'}` : columnName(file, i)}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevron" size={13} />
                </span>
              </label>
            ))}
          </details>
          {!asks && whatFrom}
        </>
      )}

      {!asks && howCharges}

      {!asks && cardPick == null && reading?.note && <p className="sheet-note">{RESTS_ON[reading.note]}</p>}

      {marks && (marksSay || cols.noMarks) && (
        <>
          <Seg
            label="Figures marked + or CR"
            options={MARKS}
            value={!!cols.noMarks}
            onChange={(noMarks) => setCols(rereadCells({ ...cols, noMarks }, file.headers, file.rows))}
          />
          {marksSay && <p className="sheet-note">{marksNote(marks)}</p>}
        </>
      )}

      {sayWay && <p className="sheet-note">{sayWay}</p>}

      {!dates.proven && (
        <>
          <Seg label="How dates read" options={ORDERS} value={order} onChange={setOrderPick} />
          <p className="sheet-note">These dates could be read either way. Check the days below.</p>
        </>
      )}

      {(here.length > 0 || (removed.length > 0 && !bringBack)) && (
        <p className="sheet-note">
          {here.length > 0 && `${plural(here.length, 'row')} already here. `}
          {removed.length > 0 && !bringBack && `${plural(removed.length, 'row')} removed earlier, and staying out.`}
        </p>
      )}
      {removed.length > 0 && !bringBack && (
        <button type="button" className="btn-ghost import-more" onClick={() => setBringBack(true)}>
          {removed.length === 1 ? 'Bring it back' : 'Bring them back'}
        </button>
      )}
      {differs > 0 && last && (
        <>
          <p className="sheet-note">
            {plural(differs, 'row')} from your last import {differs === 1 ? 'reads' : 'read'} differently now. Undo that
            import to bring {differs === 1 ? 'it' : 'them'} in this way.
          </p>
          <UndoRow batch={last} onError={setErr} onUndone={() => setBringBack(true)} />
        </>
      )}
      {open.length > 0 && (
        <p className="sheet-note">
          {open.some(startsOff)
            ? 'Payments, transfers, balances, totals and rows that look like one already here start unticked, as they would count wrongly. Tick a row to bring it in.'
            : 'Untick any row to leave it out.'}
        </p>
      )}
      {open.length > 0 ? (
        <ul className="import-rows">
          {(showAll ? listed : listed.slice(0, PREVIEW)).map((r) => (
            <TickRow
              key={r.line}
              row={r}
              twin={twins.get(r)}
              on={isTicked(r)}
              onChange={(on) => setTicks((t) => new Map(t).set(r.line, on))}
            />
          ))}
        </ul>
      ) : staged.length === 0 ? (
        <p className="sheet-note">
          {leftOut.length > 0
            ? 'None of these rows could be read. Check the columns above.'
            : isNumbered(file) && cols.amount < 0
              ? 'This file has no names for its columns, and more than one of them holds figures. One may be a balance. Choose the amount to see the rows.'
              : 'Choose the date and amount columns to see the rows.'}
        </p>
      ) : null}
      {nothingNew && differs === 0 && (
        <p className="sheet-note">
          {open.length > 0 ? 'There is nothing new to import unless you tick a row.' : 'There is nothing new in this file.'}
        </p>
      )}
      {listed.length > PREVIEW && !showAll && (
        <button type="button" className="btn-ghost import-more" onClick={() => setShowAll(true)}>
          Show all {listed.length}
        </button>
      )}
      {leftOut.length > 0 && <LeftOutList rows={leftOut} />}
      {err && <p className="sheet-err">{err}</p>}

      <SheetActions>
        <div className="import-foot">
          {open.length > 0 && !nothingNew && <ImportTotals rows={chosen} waiting={waiting} />}
          {nothingNew ? (
            <button type="button" className="btn-primary" onClick={onDone ?? close}>
              {doneLabel}
            </button>
          ) : (
            <button type="submit" form={formId} className="btn-primary" disabled={busy || chosen.length === 0 || waiting}>
              {busy ? 'Importing…' : waiting ? 'Choose Bank account or Card above' : `Import ${plural(chosen.length, 'transaction')}`}
            </button>
          )}
        </div>
      </SheetActions>
    </form>
  )
}

/** One side's biggest row, as a person can check a whole file by it. */
function LargestLine({ label, row }: { label: string; row: LargestRow }) {
  return (
    <div className="import-sum-line">
      <dt>{label}</dt>
      <dd className="import-sum-row">
        <span className="import-sum-name">{row.note || 'No description'}</span>
        <span className="num">{money(row.amount)}</span>
      </dd>
    </div>
  )
}

/**
 * What the import will write, from the rows it will write, above the button that writes
 * them. A file read the wrong way shows here at a glance: a paycheck as the largest
 * money out. It is held in the sheet's footer, so no list of rows can push it away.
 */
function ImportTotals({ rows, waiting }: { rows: StagedRow[]; waiting: boolean }) {
  const { rows: count, moneyIn, moneyOut, refunds, largestIn, largestOut } = summarizeImport(rows)
  return (
    <div className="import-sum" role="status" aria-atomic="true">
      <p className="import-sum-head">
        <span>{waiting ? 'This import would add' : 'This import adds'}</span>
        <span>{plural(count, 'row')}</span>
      </p>
      <dl className="import-sum-lines">
        <div className="import-sum-line">
          <dt>Money in</dt>
          <dd className="num">{money(moneyIn)}</dd>
        </div>
        <div className="import-sum-line">
          <dt>Money out</dt>
          <dd className="num">{money(moneyOut)}</dd>
        </div>
        {refunds > 0 && (
          <div className="import-sum-line">
            <dt>Refunds</dt>
            <dd className="num">{money(refunds)}</dd>
          </div>
        )}
        {largestIn && <LargestLine label="Largest money in" row={largestIn} />}
        {largestOut && <LargestLine label="Largest money out" row={largestOut} />}
      </dl>
    </div>
  )
}

interface UndoProps {
  at: number
  className?: string
  /** What it shows, armed or not. */
  children: (armed: boolean) => ReactNode
  /** How many rows came out. */
  onUndone: (rows: number) => void
  /** What went wrong, or null as it tries. */
  onError: (message: string | null) => void
}

/** Take an import back out, on a confirming second tap. */
function UndoImport({ at, className, children, onUndone, onError }: UndoProps) {
  const { armed, arm } = useArmed(6000)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    onError(null)
    try {
      onUndone(await undoImport(at))
    } catch {
      onError('Could not undo. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={() => {
        if (arm()) void run()
      }}
    >
      {children(armed)}
    </button>
  )
}

/** The last import, and the way to take it back out. */
function UndoRow({ batch, onUndone, onError }: { batch: ImportBatch } & Pick<UndoProps, 'onUndone' | 'onError'>) {
  return (
    <div className="sheet-group">
      <UndoImport at={batch.at} className="sheet-row" onUndone={onUndone} onError={onError}>
        {(armed) => (
          <>
            <Icon name="undo" size={18} />
            <span>{armed ? 'Tap again to undo' : 'Undo last import'}</span>
            <span className="import-meta">
              {plural(batch.rows, 'row')} · {importDay(batch.at)}
            </span>
          </>
        )}
      </UndoImport>
    </div>
  )
}

/** A choice of a few, as the segmented control. */
function Seg<T>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label} onKeyDown={rovingKeys}>
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          className={value === o.value ? 'seg-on' : ''}
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

interface TickProps {
  row: StagedRow
  /** A ledger row with the same money and day, worded some other way. */
  twin?: Transaction
  on: boolean
  onChange: (on: boolean) => void
}

/** One row of the file, ticked to come in. The row is the button. */
function TickRow({ row, twin, on, onChange }: TickProps) {
  const year = new Date().getFullYear()
  const effect = rowEffect(row)
  return (
    <li>
      <button type="button" className="import-row import-tick-row" role="checkbox" aria-checked={on} onClick={() => onChange(!on)}>
        <span className="import-tick" aria-hidden="true">
          {on && <Icon name="check" size={13} />}
        </span>
        <span className="import-note">{row.note || 'No description'}</span>
        <span className={`num${effect === 'out' ? '' : ' pos'}`}>
          {effect === 'out' ? '−' : '+'}
          {money(Math.abs(row.amount))}
        </span>
        <span className="import-day">
          {effect === 'refund' && 'Refund · '}
          {dayLabel(row.date, year)}
          {twin && ` · Looks like ${twin.note || 'a row'} on ${dayLabel(twin.date, year)}`}
        </span>
      </button>
    </li>
  )
}

function whyLeftOut(r: LeftOutRow): string {
  if (r.why === 'zero') return 'The amount is zero'
  if (r.why === 'way') return 'Could not tell which way it ran'
  if (r.why === 'wide') return 'This row has more cells than the file has columns, so its figures may have moved'
  const [name, cell] = r.why === 'date' ? ['date', r.date] : ['amount', r.amount]
  return cell ? `Could not read the ${name}: ${cell}` : `No ${name}`
}

/** The rows that will not come in, so "Imported" always matches the file. */
function LeftOutList({ rows }: { rows: LeftOutRow[] }) {
  return (
    <>
      <p className="sheet-note">
        Left out {rows.length} row{rows.length === 1 ? '' : 's'}.
      </p>
      <ul className="import-rows">
        {rows.slice(0, PREVIEW).map((r) => (
          <li className="import-row" key={r.line}>
            <span className="import-note">{r.note || 'No description'}</span>
            {r.why !== 'amount' && r.why !== 'wide' && <span className="num">{r.amount}</span>}
            <span className="import-day">{whyLeftOut(r)}</span>
          </li>
        ))}
      </ul>
      {rows.length > PREVIEW && <p className="sheet-note">And {rows.length - PREVIEW} more.</p>}
    </>
  )
}

import { memo, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { db, type Category, type TxType } from '../db/db'
import { money } from '../lib/format'
import { useArmed } from '../lib/useArmed'
import { Icon } from './Icon'
import { CATEGORY_ICONS, ICON_LABELS } from './iconPaths'
import { Skeleton } from './Skeleton'

interface Props {
  /** undefined while the live query is still loading: a skeleton, never an empty list. */
  categories: Category[] | undefined
}

/** The name a freshly added category starts with; focusing it selects it, so typing replaces it. */
const NEW_NAME = 'New category'

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false

/** Enter (the keyboard's Done) commits a field by leaving it. */
const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') e.currentTarget.blur()
}

/**
 * The name of the category a deleted category's transactions move to: the
 * first live 'Other' of the same kind, never itself (null = none, they become
 * uncategorized). This only words the confirm note; the delete itself looks
 * the fallback up in the store, unchanged.
 */
function fallbackName(categories: Category[], category: Category): string | null {
  const f = categories.find(
    (c) => !c.deleted && c.kind === category.kind && c.name.toLowerCase() === 'other' && c.id !== category.id,
  )
  return f ? f.name : null
}

/** Adds a new, unbudgeted category at the end of the order and returns its id. */
async function addCategory(categories: Category[], kind: TxType): Promise<number> {
  const now = Date.now()
  const maxOrder = categories.reduce((m, c) => Math.max(m, c.sortOrder), -1)
  return db.categories.add({
    name: NEW_NAME,
    icon: kind === 'expense' ? 'tag' : 'plus-circle',
    color: '#9a9aa2',
    kind,
    monthlyBudget: 0,
    sortOrder: maxOrder + 1,
    updatedAt: now,
  })
}

export const Categories = memo(function Categories({ categories }: Props) {
  // One editor open at a time.
  const [openId, setOpenId] = useState<number | null>(null)
  // The row just added: brought to the middle of the pane once it renders.
  const [freshId, setFreshId] = useState<number | null>(null)

  if (!categories) return <Skeleton variant="list" />
  const all = categories

  const expense = all.filter((c) => c.kind === 'expense').sort((a, b) => a.sortOrder - b.sortOrder)
  const income = all.filter((c) => c.kind === 'income').sort((a, b) => a.sortOrder - b.sortOrder)
  // The same reduce Home and Budget use: every expense category's monthly budget.
  const totalLimit = expense.reduce((s, c) => s + (c.monthlyBudget || 0), 0)

  async function add(kind: TxType) {
    const id = await addCategory(all, kind)
    setOpenId(id)
    setFreshId(id)
  }

  const list = (cats: Category[], kind: TxType) => (
    <div className="cats-card">
      {cats.map((c) => (
        <CategoryRow
          key={c.id}
          category={c}
          showLimit={kind === 'expense'}
          open={openId === c.id}
          fresh={freshId === c.id}
          movesTo={fallbackName(all, c)}
          onToggle={() => setOpenId((o) => (o === c.id ? null : c.id!))}
          onDeleted={() => setOpenId(null)}
        />
      ))}
      <button type="button" className="cat-add row-press row-sep" onClick={() => add(kind)}>
        <Icon name="plus" size={18} />
        <span>Add category</span>
      </button>
    </div>
  )

  return (
    <div className="cats">
      <p className="cats-sub">
        {totalLimit > 0 ? (
          <>
            Your budgets total <strong className="num">{money(totalLimit, { trim: true })}</strong> a month.
          </>
        ) : (
          'No budgets set yet.'
        )}
      </p>

      <section className="cats-section">
        <h2 className="section-title">Spending</h2>
        {list(expense, 'expense')}
      </section>

      <section className="cats-section">
        <h2 className="section-title">Income</h2>
        {list(income, 'income')}
      </section>
    </div>
  )
})

interface Draft {
  value: string
  focused: boolean
  /** The category's updatedAt when this draft was taken or saved. */
  at: number
}

/**
 * A field's edit buffer. It exists from focus until the store's next write
 * after blur (this save landing, or another device's edit), so a saved field
 * never flashes its old value. The rest of the time the field mirrors the
 * store, so an edit made elsewhere shows up here at once.
 */
function useDraft(stored: string, version: number) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const held = (d: Draft | null): d is Draft => d != null && (d.focused || d.at === version)
  return {
    value: held(draft) ? draft.value : stored,
    begin: () => setDraft((d) => ({ value: held(d) ? d.value : stored, focused: true, at: version })),
    change: (value: string) => setDraft((d) => (d ? { ...d, value } : d)),
    /** Leave the field. `saved` is held until the store has it; null lets go now. */
    end: (saved: string | null) => setDraft(saved == null ? null : { value: saved, focused: false, at: version }),
    drop: () => setDraft(null),
  }
}
type FieldDraft = ReturnType<typeof useDraft>

interface RowProps {
  category: Category
  showLimit: boolean
  open: boolean
  /** Just added: bring it into view. */
  fresh: boolean
  /** Where this category's transactions go if it is deleted (null = uncategorized). */
  movesTo: string | null
  onToggle: () => void
  onDeleted: () => void
}

function CategoryRow({ category, showLimit, open, fresh, movesTo, onToggle, onDeleted }: RowProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const editId = useId()
  // Drafts live on the row so the summary previews a name while it is typed.
  const name = useDraft(category.name, category.updatedAt)
  const limit = useDraft(String(category.monthlyBudget || ''), category.updatedAt)

  useEffect(() => {
    if (fresh) rowRef.current?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [fresh])

  return (
    <div className="cat-row row-sep" ref={rowRef}>
      <button
        type="button"
        className="cat-summary row-press"
        aria-expanded={open}
        aria-controls={open ? editId : undefined}
        onClick={onToggle}
      >
        <span className="cat-tile">
          <Icon name={category.icon} size={20} />
        </span>
        <span className="cat-name">{name.value}</span>
        {showLimit ? (
          category.monthlyBudget > 0 ? (
            <span className="cat-budget num">
              {money(category.monthlyBudget, { trim: true })}
              <em>/mo</em>
            </span>
          ) : (
            <span className="cat-budget is-none">No budget</span>
          )
        ) : (
          <span />
        )}
        <Icon name="chevron" size={14} className={`chev${open ? ' open' : ''}`} />
      </button>

      {open && (
        <CategoryEdit
          id={editId}
          category={category}
          showLimit={showLimit}
          name={name}
          limit={limit}
          movesTo={movesTo}
          onDeleted={onDeleted}
        />
      )}
    </div>
  )
}

function CategoryEdit({
  id,
  category,
  showLimit,
  name,
  limit,
  movesTo,
  onDeleted,
}: {
  id: string
  category: Category
  showLimit: boolean
  name: FieldDraft
  limit: FieldDraft
  movesTo: string | null
  onDeleted: () => void
}) {
  // The entrance plays when the editor opens, never again when the pane is re-shown.
  const [entering, setEntering] = useState(true)

  async function patch(fields: Partial<Category>, field?: FieldDraft) {
    if (category.id == null) return
    try {
      await db.categories.update(category.id, { ...fields, updatedAt: Date.now() })
    } catch {
      // A rejected write left the field showing a value that was never stored,
      // which is the one place a failure here reads as success. Snap back to
      // what is actually persisted so the UI never lies about saved state.
      field?.drop()
    }
  }

  function saveName() {
    // Never save a blank name (the stored one shows again), and write nothing
    // when the name is unchanged.
    const trimmed = name.value.trim()
    if (!trimmed || trimmed === category.name) return name.end(null)
    name.end(trimmed)
    void patch({ name: trimmed }, name)
  }

  function saveLimit() {
    const n = Number(limit.value.replace(/,/g, '').trim())
    // Not a number: revert to the stored budget rather than saving 0.
    if (!Number.isFinite(n)) return limit.end(null)
    const next = Math.max(0, n)
    if (next === category.monthlyBudget) return limit.end(null)
    limit.end(String(next || ''))
    void patch({ monthlyBudget: next }, limit)
  }

  // A legacy icon outside the curated set stays visible (and selected) up front.
  const keys = CATEGORY_ICONS.includes(category.icon) ? CATEGORY_ICONS : [category.icon, ...CATEGORY_ICONS]

  return (
    <div
      id={id}
      className={`cat-edit${entering ? ' cat-edit-in' : ''}`}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setEntering(false)
      }}
    >
      <div className="cat-edit-grid">
        <label className="field">
          <span>Name</span>
          <input
            type="text"
            value={name.value}
            enterKeyHint="done"
            autoComplete="off"
            onFocus={(e) => {
              name.begin()
              if (category.name === NEW_NAME) {
                const el = e.currentTarget
                el.select()
                // iOS can drop a selection made during the focusing tap.
                requestAnimationFrame(() => {
                  if (document.activeElement === el) el.setSelectionRange(0, el.value.length)
                })
              }
            }}
            onChange={(e) => name.change(e.target.value)}
            onKeyDown={blurOnEnter}
            onBlur={saveName}
          />
        </label>
        {showLimit && (
          <label className="field">
            <span>Monthly budget</span>
            <div className="money-input">
              <input
                type="text"
                inputMode="decimal"
                enterKeyHint="done"
                autoComplete="off"
                placeholder="No budget"
                value={limit.value}
                onFocus={limit.begin}
                onChange={(e) => limit.change(e.target.value)}
                onKeyDown={blurOnEnter}
                onBlur={saveLimit}
              />
              <i aria-hidden="true">$</i>
              <em aria-hidden="true">/mo</em>
            </div>
          </label>
        )}
      </div>

      <div>
        <span className="field-sub">Icon</span>
        <div className="icon-picker" role="group" aria-label="Icon">
          {keys.map((key) => {
            const on = key === category.icon
            return (
              <button
                key={key}
                type="button"
                className={`icon-opt${on ? ' on' : ''}`}
                aria-pressed={on}
                aria-label={ICON_LABELS[key] ?? key}
                onClick={() => {
                  if (!on) void patch({ icon: key })
                }}
              >
                <Icon name={key} size={20} />
              </button>
            )
          })}
        </div>
      </div>

      <DeleteCategory category={category} movesTo={movesTo} onDeleted={onDeleted} />
    </div>
  )
}

/**
 * Delete with an in-place two-tap confirm (window.confirm is a silent no-op in
 * the iPhone wrapper). The first tap arms it and says where the transactions
 * go; the second runs the delete. Mounted only while the editor is open, so
 * closing the editor disarms it.
 */
function DeleteCategory({
  category,
  movesTo,
  onDeleted,
}: {
  category: Category
  movesTo: string | null
  onDeleted: () => void
}) {
  const { armed, arm } = useArmed()
  const [note, setNote] = useState('')

  async function remove() {
    if (category.id == null) return
    // Re-home the transactions rather than orphaning them. Nulling categoryId
    // silently drops that spending out of every budget and chart, which is
    // exactly what happened when a duplicate category set was cleaned up and
    // months of real spending fell into "Uncategorized".
    const fallback = await db.categories
      .filter((c) => !c.deleted && c.kind === category.kind && c.name.toLowerCase() === 'other' && c.id !== category.id)
      .first()
    const target = fallback?.id ?? null
    await db.transactions.where('categoryId').equals(category.id).modify({ categoryId: target, updatedAt: Date.now() })
    await db.categories.update(category.id, { deleted: true, updatedAt: Date.now() })
    onDeleted()
  }

  function onTap() {
    if (category.id == null) return
    // First tap arms (a quick double-tap is not a confirmation); the second deletes.
    if (!arm()) {
      setNote(movesTo ? `Transactions move to ${movesTo}` : 'Transactions become uncategorized')
      return
    }
    void remove()
  }

  return (
    <div className="cat-danger" aria-live="polite">
      <button type="button" className={`cat-delete${armed ? ' is-armed' : ''}`} onClick={onTap}>
        {armed ? 'Tap again to delete' : 'Delete category'}
      </button>
      {armed && note && <p className="cat-delete-note">{note}</p>}
    </div>
  )
}

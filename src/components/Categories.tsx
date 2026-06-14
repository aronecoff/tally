import { useState } from 'react'
import { db, type Category, type TxType } from '../db/db'
import { money } from '../lib/format'
import { Icon, ICON_KEYS } from './Icon'

interface Props {
  categories: Category[]
}

// Icons that don't make sense as category icons (used for nav / alerts).
const NON_CATEGORY = new Set(['pie', 'list', 'download', 'alert'])
const PICKABLE = ICON_KEYS.filter((k) => !NON_CATEGORY.has(k))

export function Categories({ categories }: Props) {
  const expense = categories.filter((c) => c.kind === 'expense').sort((a, b) => a.sortOrder - b.sortOrder)
  const income = categories.filter((c) => c.kind === 'income').sort((a, b) => a.sortOrder - b.sortOrder)

  async function addCategory(kind: TxType) {
    const now = Date.now()
    const maxOrder = categories.reduce((m, c) => Math.max(m, c.sortOrder), -1)
    await db.categories.add({
      name: 'New category',
      icon: kind === 'expense' ? 'tag' : 'plus-circle',
      color: '#9a9aa2',
      kind,
      monthlyBudget: 0,
      sortOrder: maxOrder + 1,
      updatedAt: now,
    })
  }

  return (
    <div className="cats">
      <div className="cats-section">
        <div className="section-title cats-head">
          <span>Expense categories</span>
          <button className="btn-ghost" onClick={() => addCategory('expense')}>＋ Add</button>
        </div>
        {expense.map((c) => (
          <CategoryEditor key={c.id} category={c} showLimit />
        ))}
      </div>

      <div className="cats-section">
        <div className="section-title cats-head">
          <span>Income categories</span>
          <button className="btn-ghost" onClick={() => addCategory('income')}>＋ Add</button>
        </div>
        {income.map((c) => (
          <CategoryEditor key={c.id} category={c} showLimit={false} />
        ))}
      </div>
    </div>
  )
}

function CategoryEditor({ category, showLimit }: { category: Category; showLimit: boolean }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(category.name)
  const [limit, setLimit] = useState(String(category.monthlyBudget || ''))

  async function patch(fields: Partial<Category>) {
    if (category.id == null) return
    await db.categories.update(category.id, { ...fields, updatedAt: Date.now() })
  }

  async function saveLimit(v: string) {
    const n = Number(v)
    await patch({ monthlyBudget: Number.isNaN(n) ? 0 : Math.max(0, n) })
  }

  async function remove() {
    if (category.id == null) return
    if (!window.confirm(`Delete "${category.name}"? Its transactions will become uncategorized.`)) return
    await db.transactions.where('categoryId').equals(category.id).modify({ categoryId: null, updatedAt: Date.now() })
    await db.categories.delete(category.id)
  }

  return (
    <div className="cat-row">
      <button className="cat-summary" onClick={() => setOpen((o) => !o)}>
        <span className="cat-tile">
          <Icon name={category.icon} size={18} />
        </span>
        <span className="cat-name">{name}</span>
        {showLimit && (
          <span className="cat-budget muted num">
            {category.monthlyBudget > 0 ? `${money(category.monthlyBudget)} limit` : 'no limit'}
          </span>
        )}
        <span className="cat-caret">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="cat-edit">
          <div className="cat-edit-grid">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => patch({ name })} />
            </label>
            {showLimit && (
              <label className="field">
                <span>Monthly limit</span>
                <input
                  type="number"
                  min="0"
                  step="10"
                  placeholder="none"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  onBlur={() => saveLimit(limit)}
                />
              </label>
            )}
          </div>

          <div>
            <span className="field-sub">Icon</span>
            <div className="icon-picker">
              {PICKABLE.map((key) => (
                <button
                  key={key}
                  className={`icon-opt ${key === category.icon ? 'on' : ''}`}
                  onClick={() => patch({ icon: key })}
                  aria-label={key}
                >
                  <Icon name={key} size={18} />
                </button>
              ))}
            </div>
          </div>

          <button className="btn-danger-ghost" onClick={remove}>Delete category</button>
        </div>
      )}
    </div>
  )
}

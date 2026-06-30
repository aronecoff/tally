import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Account, type AccountType } from '../db/db'
import { money } from '../lib/format'
import { Icon } from './Icon'

const TIERS: { type: AccountType; label: string; icon: string; liability?: boolean }[] = [
  { type: 'cash', label: 'Cash', icon: 'wallet' },
  { type: 'credit', label: 'Credit', icon: 'card', liability: true },
  { type: 'brokerage', label: 'Brokerage', icon: 'chart' },
  { type: 'retirement', label: 'Retirement', icon: 'briefcase' },
  { type: 'benefit', label: 'Benefits', icon: 'heart' },
]
export function Accounts() {
  const accounts = useLiveQuery(
    () => db.accounts.filter((a) => !a.deleted && !a.archived).toArray(),
    [],
    [],
  )
  const [editing, setEditing] = useState<Account | 'new' | null>(null)

  const { netWorth, byTier } = useMemo(() => {
    const byTier = new Map<AccountType, Account[]>()
    let assets = 0
    let liabilities = 0
    for (const a of accounts) {
      if (!byTier.has(a.type)) byTier.set(a.type, [])
      byTier.get(a.type)!.push(a)
      if (a.type === 'credit') liabilities += a.balance
      else assets += a.balance
    }
    for (const list of byTier.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)
    return { netWorth: assets - liabilities, byTier }
  }, [accounts])

  return (
    <div className="accounts">
      <div className="nw-hero">
        <span className="nw-label">Net worth</span>
        <span className={`nw-num num ${netWorth < 0 ? 'over' : ''}`}>
          {netWorth < 0 ? '−' : ''}
          {money(Math.abs(netWorth))}
        </span>
        <span className="nw-sub">across {accounts.length} accounts · tap one to update its balance</span>
      </div>

      {TIERS.map((tier) => {
        const list = byTier.get(tier.type) ?? []
        if (list.length === 0) return null
        const subtotal = list.reduce((s, a) => s + a.balance, 0)
        return (
          <div className="tier" key={tier.type}>
            <div className="tier-head">
              <span className="tier-label">{tier.label}</span>
              <span className={`tier-total num ${tier.liability ? 'muted' : ''}`}>
                {tier.liability ? '−' : ''}
                {money(subtotal)}
              </span>
            </div>
            <ul className="acct-list">
              {list.map((a) => (
                <li key={a.id} className="acct-row" onClick={() => setEditing(a)}>
                  <span className="cat-tile sm">
                    <Icon name={tier.icon} size={18} />
                  </span>
                  <span className="acct-main">
                    <span className="acct-name">{a.institution} {a.name}</span>
                    <span className="acct-sub">
                      {a.liveSync ? 'Live' : 'Manual'}
                      {a.balance === 0 ? ' · tap to set balance' : ''}
                    </span>
                  </span>
                  <span className={`acct-bal num ${tier.liability ? 'over' : ''}`}>
                    {tier.liability && a.balance > 0 ? '−' : ''}
                    {money(a.balance)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
      })}

      <button className="acct-add" onClick={() => setEditing('new')}>
        <Icon name="plus" size={15} /> Add an account
      </button>

      {editing && <AccountSheet initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function AccountSheet({ initial, onClose }: { initial: Account | null; onClose: () => void }) {
  const editing = initial != null
  const [institution, setInstitution] = useState(initial?.institution ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<AccountType>(initial?.type ?? 'cash')
  const [balance, setBalance] = useState(initial ? String(initial.balance) : '')

  const isCredit = type === 'credit'
  const balanceNum = Number(balance)
  const valid = institution.trim() !== '' && !Number.isNaN(balanceNum)

  async function save() {
    if (!valid) return
    const now = Date.now()
    const fields = {
      institution: institution.trim(),
      name: name.trim() || (TIERS.find((t) => t.type === type)?.label ?? 'Account'),
      type,
      balance: Math.round(Math.abs(balanceNum) * 100) / 100,
      lastUpdated: now,
      updatedAt: now,
    }
    if (editing && initial?.id != null) await db.accounts.update(initial.id, fields)
    else {
      const maxOrder = (await db.accounts.toArray()).reduce((m, a) => Math.max(m, a.sortOrder), -1)
      await db.accounts.add({ ...fields, liveSync: false, sortOrder: maxOrder + 1 } as Account)
    }
    onClose()
  }

  async function remove() {
    if (editing && initial?.id != null) {
      if (!window.confirm('Remove this account?')) return
      await db.accounts.update(initial.id, { deleted: true, updatedAt: Date.now() })
      onClose()
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2>{editing ? 'Edit account' : 'Add account'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="amount-display">
          <span className="currency">$</span>
          <input
            inputMode="decimal"
            type="text"
            placeholder="0"
            value={balance}
            autoFocus
            onChange={(e) => {
              let v = e.target.value.replace(/[^\d.]/g, '')
              const dot = v.indexOf('.')
              if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
              setBalance(v)
            }}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </div>
        <p className="acct-bal-hint muted">{isCredit ? 'Balance owed on this card' : 'Current balance'}</p>

        <div className="field-row">
          <label className="field">
            <span>Institution</span>
            <input type="text" placeholder="Chase" value={institution} onChange={(e) => setInstitution(e.target.value)} />
          </label>
          <label className="field">
            <span>Name</span>
            <input type="text" placeholder="Checking" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>Tier</span>
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {TIERS.map((t) => (
              <option key={t.type} value={t.type}>{t.label}</option>
            ))}
          </select>
        </label>

        <div className="sheet-actions">
          {editing && <button className="btn-danger" onClick={remove}>Remove</button>}
          <button className="btn-primary" disabled={!valid} onClick={save}>
            {editing ? 'Save' : 'Add account'}
          </button>
        </div>
      </div>
    </div>
  )
}

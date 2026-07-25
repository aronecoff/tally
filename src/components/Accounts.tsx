import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Account, type AccountType } from '../db/db'
import { money } from '../lib/format'
import { brokerageEnabled, connectBrokerage } from '../lib/brokerage'
import { banksEnabled, syncAllConnectors } from '../lib/banks'
import { BankConnectSheet } from './BankConnectSheet'
import { Icon } from './Icon'

const TIERS: { type: AccountType; label: string; icon: string; liability?: boolean }[] = [
  { type: 'cash', label: 'Cash', icon: 'wallet' },
  { type: 'credit', label: 'Credit', icon: 'card', liability: true },
  { type: 'brokerage', label: 'Brokerage', icon: 'chart' },
  { type: 'retirement', label: 'Retirement', icon: 'briefcase' },
  { type: 'benefit', label: 'Benefits', icon: 'heart' },
]
export function Accounts({ onSynced }: { onSynced?: () => void }) {
  const accounts = useLiveQuery(
    () => db.accounts.filter((a) => !a.deleted && !a.archived).toArray(),
    [],
    [],
  )
  const [editing, setEditing] = useState<Account | 'new' | null>(null)
  const [bankOpen, setBankOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [syncErr, setSyncErr] = useState<string | null>(null)
  const autoRan = useRef(false)

  async function runSync() {
    if (busy) return
    setBusy(true)
    setSyncErr(null)
    setSyncMsg('Syncing…')
    const { total, errors } = await syncAllConnectors()
    if (total === 0 && errors.length) {
      // Surface the auth prompt if that's why nothing synced, else the first error.
      setSyncMsg(null)
      setSyncErr(errors.find((e) => /sign in/i.test(e)) ?? errors[0])
      setBusy(false)
    } else {
      setSyncErr(null)
      setSyncMsg(total ? `${total} account${total === 1 ? '' : 's'} synced · categorized & footed` : 'Categorized & footed')
      setBusy(false)
      // Pulling + categorizing + footing is done — take them straight to the
      // analysis, which is what "hit Sync and show me the breakdown" means.
      onSynced?.()
    }
  }

  async function runConnectBrokerage() {
    setSyncErr(null)
    // Open the tab synchronously inside the click gesture so it isn't pop-up
    // blocked after the awaited round-trip; fill in its URL once we have it.
    const win = window.open('', '_blank')
    try {
      const url = await connectBrokerage()
      if (win) {
        win.location.href = url
        setSyncMsg('Finish linking in the new tab, then tap Sync now.')
      } else {
        setSyncErr('Allow pop-ups for this site, then tap Connect a brokerage again.')
      }
    } catch (e) {
      if (win) win.close()
      setSyncErr(e instanceof Error ? e.message : 'Could not start the connection')
    }
  }

  // The app-level "reconnect" banner routes here and asks us to open the sheet.
  useEffect(() => {
    const open = () => setBankOpen(true)
    window.addEventListener('tally:open-bank-connect', open)
    return () => window.removeEventListener('tally:open-bank-connect', open)
  }, [])

  // Refresh live balances (all connectors) when the Accounts view opens.
  useEffect(() => {
    if (!brokerageEnabled || autoRan.current) return
    autoRan.current = true
    setBusy(true)
    syncAllConnectors()
      .then(({ total }) => setSyncMsg(total ? `${total} live account${total === 1 ? '' : 's'} synced · just now` : null))
      .catch(() => {
        /* quiet on auto-run — the manual Sync button surfaces errors */
      })
      .finally(() => setBusy(false))
  }, [])

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
      <div className="dash-col">
      <div className="nw-hero">
        <span className="nw-label">Net worth</span>
        <span className={`nw-num num ${netWorth < 0 ? 'over' : ''}`}>
          {netWorth < 0 ? '−' : ''}
          {money(Math.abs(netWorth))}
        </span>
        <span className="nw-sub">across {accounts.length} accounts · tap one to update its balance</span>
      </div>

      {brokerageEnabled && (
        <div className="acct-sync">
          <div className="acct-sync-actions">
            <button className="acct-chip" onClick={() => void runConnectBrokerage()} disabled={busy}>
              <Icon name="chart" size={15} /> Connect a brokerage
            </button>
            {banksEnabled && (
              <button className="acct-chip" onClick={() => setBankOpen(true)} disabled={busy}>
                <Icon name="bank" size={15} /> Connect a bank
              </button>
            )}
            <button className="acct-chip" onClick={() => void runSync()} disabled={busy}>
              <Icon name="repeat" size={15} /> {busy ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
          {syncErr ? (
            <span className="acct-sync-msg is-err">{syncErr}</span>
          ) : syncMsg ? (
            <span className="acct-sync-msg muted">{syncMsg}</span>
          ) : null}
        </div>
      )}
      </div>

      <div className="dash-col">
      {TIERS.map((tier) => {
        const list = byTier.get(tier.type) ?? []
        if (list.length === 0) return null
        const subtotal = list.reduce((s, a) => s + a.balance, 0)
        return (
          <div className="tier" key={tier.type}>
            <div className="tier-head">
              <span className="tier-label">{tier.label}</span>
              <span className={`tier-total num ${tier.liability ? 'muted' : ''}`}>
                {tier.liability && subtotal > 0 ? '−' : ''}
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
      </div>

      {editing && <AccountSheet initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {bankOpen && (
        <BankConnectSheet
          onClose={() => setBankOpen(false)}
          onResult={(msg, isErr) => {
            if (isErr) {
              setSyncMsg(null)
              setSyncErr(msg)
            } else {
              setSyncErr(null)
              setSyncMsg(msg)
            }
          }}
        />
      )}
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
              v = v.replace(/^(\d*\.\d{2}).*$/, '$1') // clamp to cents
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

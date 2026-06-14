import { db, type Category, type Transaction } from '../db/db'
import { supabase } from '../db/supabase'

type Status = 'signedout' | 'idle' | 'syncing' | 'synced' | 'error'

export interface SyncSnapshot {
  email: string | null
  status: Status
  lastSyncedAt: number | null
  error: string | null
}

let snapshot: SyncSnapshot = { email: null, status: 'signedout', lastSyncedAt: null, error: null }
const listeners = new Set<(s: SyncSnapshot) => void>()

function emit(patch: Partial<SyncSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((l) => l(snapshot))
}

export function subscribeSync(l: (s: SyncSnapshot) => void): () => void {
  listeners.add(l)
  l(snapshot)
  return () => {
    listeners.delete(l)
  }
}

// ---------- field mapping (local camelCase <-> remote snake_case) ----------
const iso = (ms: number) => new Date(ms).toISOString()

function catToRemote(c: Category, userId: string) {
  return {
    id: c.uid,
    user_id: userId,
    name: c.name,
    icon: c.icon,
    color: c.color,
    kind: c.kind,
    monthly_budget: c.monthlyBudget,
    sort_order: c.sortOrder,
    deleted: !!c.deleted,
    updated_at: iso(c.updatedAt),
  }
}

function txToRemote(t: Transaction, userId: string, catUidById: Map<number, string>) {
  return {
    id: t.uid,
    user_id: userId,
    date: t.date,
    amount: t.amount,
    type: t.type,
    category_id: t.categoryId != null ? catUidById.get(t.categoryId) ?? null : null,
    account: t.account,
    note: t.note,
    deleted: !!t.deleted,
    created_at: iso(t.createdAt),
    updated_at: iso(t.updatedAt),
  }
}

// ---------- sync core ----------
let applyingRemote = false

async function pull(): Promise<void> {
  if (!supabase) return
  applyingRemote = true
  try {
    const { data: rcats, error: e1 } = await supabase.from('categories').select('*')
    if (e1) throw e1
    const localCats = await db.categories.toArray()
    const catByUid = new Map(localCats.filter((c) => c.uid).map((c) => [c.uid!, c]))
    for (const r of rcats ?? []) {
      const local = catByUid.get(r.id)
      const fields: Category = {
        uid: r.id,
        name: r.name,
        icon: r.icon,
        color: r.color,
        kind: r.kind,
        monthlyBudget: Number(r.monthly_budget),
        sortOrder: r.sort_order,
        deleted: !!r.deleted,
        updatedAt: Date.parse(r.updated_at),
      }
      if (!local) await db.categories.add(fields)
      else if (fields.updatedAt > local.updatedAt) await db.categories.update(local.id!, fields)
    }

    // uid -> local category id, for resolving transaction.category_id
    const cats2 = await db.categories.toArray()
    const localIdByCatUid = new Map(cats2.filter((c) => c.uid).map((c) => [c.uid!, c.id!]))

    const { data: rtx, error: e2 } = await supabase.from('transactions').select('*')
    if (e2) throw e2
    const localTx = await db.transactions.toArray()
    const txByUid = new Map(localTx.filter((t) => t.uid).map((t) => [t.uid!, t]))
    for (const r of rtx ?? []) {
      const local = txByUid.get(r.id)
      const fields: Transaction = {
        uid: r.id,
        date: r.date,
        amount: Number(r.amount),
        type: r.type,
        categoryId: r.category_id ? localIdByCatUid.get(r.category_id) ?? null : null,
        account: r.account ?? '',
        note: r.note ?? '',
        deleted: !!r.deleted,
        createdAt: Date.parse(r.created_at),
        updatedAt: Date.parse(r.updated_at),
      }
      if (!local) await db.transactions.add(fields)
      else if (fields.updatedAt > local.updatedAt) await db.transactions.update(local.id!, fields)
    }
  } finally {
    applyingRemote = false
  }
}

async function push(userId: string): Promise<void> {
  if (!supabase) return
  const cats = await db.categories.toArray()
  const txs = await db.transactions.toArray()
  const catUidById = new Map(cats.filter((c) => c.uid).map((c) => [c.id!, c.uid!]))

  const catRows = cats.filter((c) => c.uid).map((c) => catToRemote(c, userId))
  if (catRows.length) {
    const { error } = await supabase.from('categories').upsert(catRows)
    if (error) throw error
  }
  const txRows = txs.filter((t) => t.uid).map((t) => txToRemote(t, userId, catUidById))
  if (txRows.length) {
    const { error } = await supabase.from('transactions').upsert(txRows)
    if (error) throw error
  }
}

let syncing = false
let queued = false

export async function syncNow(): Promise<void> {
  if (!supabase) return
  const { data } = await supabase.auth.getSession()
  const user = data.session?.user
  if (!user) return
  if (syncing) {
    queued = true
    return
  }
  syncing = true
  emit({ status: 'syncing', error: null })
  try {
    await pull()
    await push(user.id)
    emit({ status: 'synced', lastSyncedAt: Date.now(), error: null })
  } catch (e) {
    emit({ status: 'error', error: e instanceof Error ? e.message : 'sync failed' })
  } finally {
    syncing = false
    if (queued) {
      queued = false
      void syncNow()
    }
  }
}

// Debounced trigger for local edits (skipped while applying remote changes).
let debounce: ReturnType<typeof setTimeout> | undefined
function schedule() {
  if (applyingRemote) return
  clearTimeout(debounce)
  debounce = setTimeout(() => void syncNow(), 600)
}

let started = false

export function initSync(): void {
  if (!supabase || started) return
  started = true

  supabase.auth.getSession().then(({ data }) => {
    if (data.session?.user) {
      emit({ email: data.session.user.email ?? null, status: 'idle' })
      void syncNow()
    }
  })

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session?.user) {
      emit({ email: session.user.email ?? null })
      void syncNow()
    } else {
      emit({ email: null, status: 'signedout', lastSyncedAt: null })
    }
  })

  for (const table of [db.categories, db.transactions]) {
    table.hook('creating', () => schedule())
    table.hook('updating', () => schedule())
  }

  setInterval(() => {
    if (snapshot.email) void syncNow()
  }, 45000)
  window.addEventListener('focus', () => {
    if (snapshot.email) void syncNow()
  })
  window.addEventListener('online', () => {
    if (snapshot.email) void syncNow()
  })
}

/** Sign in, creating the account on first use. Returns an error string or null. */
export async function signIn(email: string, password: string): Promise<string | null> {
  if (!supabase) return 'Sync is not configured.'
  const signin = await supabase.auth.signInWithPassword({ email, password })
  if (!signin.error) return null

  // No account yet → create one.
  const signup = await supabase.auth.signUp({ email, password })
  if (signup.error) return signin.error.message
  if (!signup.data.session) return 'Account created — confirm your email, then sign in.'
  return null
}

export async function signOutSync(): Promise<void> {
  if (!supabase) return
  await supabase.auth.signOut()
}

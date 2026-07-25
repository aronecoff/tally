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
    manual: !!t.manual,
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
    // Match by name+kind too, so a device's locally-seeded category ADOPTS the
    // cloud row on first sign-in instead of creating a duplicate (categories are
    // a fixed, name-identified set — never two "Groceries").
    const catByName = new Map(localCats.map((c) => [`${c.name.toLowerCase()}|${c.kind}`, c]))
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
      if (local) {
        if (fields.updatedAt > local.updatedAt) await db.categories.update(local.id!, fields)
      } else {
        const twin = catByName.get(`${r.name.toLowerCase()}|${r.kind}`)
        if (twin && twin.uid !== r.id) await db.categories.update(twin.id!, fields) // adopt cloud identity
        else await db.categories.add(fields)
      }
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
        manual: !!r.manual,
        deleted: !!r.deleted,
        createdAt: Date.parse(r.created_at),
        updatedAt: Date.parse(r.updated_at),
      }
      if (!local) await db.transactions.add(fields)
      else if (fields.updatedAt > local.updatedAt) {
        // A pin is one-way: once a row is manual anywhere, it stays manual.
        // Otherwise clock skew between devices can strip the flag mid-pull and
        // re-expose the row to bank overwrites.
        if (local.manual) fields.manual = true
        await db.transactions.update(local.id!, fields)
      }
    }
  } finally {
    applyingRemote = false
  }
}

/**
 * Upsert in chunks, and when a chunk fails retry its rows one-by-one so a single
 * poison row (bad id, constraint violation) can't wedge the entire push — the
 * failure mode that once kept the whole transactions table at 0 rows.
 */
async function resilientUpsert(table: 'categories' | 'transactions', rows: Record<string, unknown>[]): Promise<void> {
  if (!supabase || rows.length === 0) return
  let lastError: unknown = null
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const { error } = await supabase.from(table).upsert(chunk)
    if (!error) continue
    for (const row of chunk) {
      const { error: e } = await supabase.from(table).upsert(row)
      if (e) lastError = e // skip the poison row, keep pushing the rest
    }
  }
  if (lastError) throw lastError
}

async function push(userId: string): Promise<void> {
  if (!supabase) return
  const cats = await db.categories.toArray()
  const txs = await db.transactions.toArray()
  const catUidById = new Map(cats.filter((c) => c.uid).map((c) => [c.id!, c.uid!]))

  await resilientUpsert('categories', cats.filter((c) => c.uid).map((c) => catToRemote(c, userId)))
  await resilientUpsert('transactions', txs.filter((t) => t.uid).map((t) => txToRemote(t, userId, catUidById)))
}

let syncing = false
let queued = false

export async function syncNow(): Promise<void> {
  if (!supabase) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return // offline — the 'online' listener retries
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
  const clean = email.trim().toLowerCase()
  const signin = await supabase.auth.signInWithPassword({ email: clean, password })
  if (!signin.error) return null

  // Sign-in failed — try to create the account (first-time use).
  const signup = await supabase.auth.signUp({ email: clean, password })
  if (signup.error) return signup.error.message
  if (!signup.data.session) {
    // Supabase obfuscates an already-registered email by returning a user with an
    // EMPTY identities array. Empty ⇒ the account exists and the password was
    // wrong (not an email-confirmation issue). Non-empty ⇒ a genuinely new
    // account that needs confirming.
    const identities = signup.data.user?.identities
    if (identities && identities.length === 0) return 'Wrong password for that email. Check it and try again.'
    return 'Check your email to confirm your new account, then sign in.'
  }
  return null
}

/** Change the signed-in user's password. Returns an error string or null. */
export async function changePassword(newPassword: string): Promise<string | null> {
  if (!supabase) return 'Sync is not configured.'
  if (newPassword.length < 8) return 'Use at least 8 characters.'
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  return error ? error.message : null
}

export async function signOutSync(): Promise<void> {
  if (!supabase) return
  await supabase.auth.signOut()
}

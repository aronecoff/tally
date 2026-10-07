import { db, type Account, type AccountType, type Category, type SourceSaid, type Transaction } from '../db/db'
import { supabase } from '../db/supabase'
import { defaultCategories } from '../db/seed'
import { oneRowPerUid } from '../lib/ledger'
import { builtInKey } from '../lib/categorize'
import { clearUserRules } from '../lib/userRules'
import { institutionsMatch } from '../lib/institutions'
import { loadMerchantRules } from './merchantRules'

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
    key: c.key ?? null,
    fixed: c.fixed ?? null,
    deleted: !!c.deleted,
    updated_at: iso(c.updatedAt),
  }
}

/**
 * Whether the cloud's categories table has the `key` and `fixed` columns.
 * PostgREST refuses an upsert that names a column it does not have, so until
 * the migration runs the push goes again without them (and stays that way for
 * the session) instead of failing every sync, transactions included.
 */
let catMetaColumns = true
const isMissingColumn = (e: unknown) => {
  const x = (e ?? {}) as { code?: string; message?: string }
  return x.code === 'PGRST204' || x.code === '42703' || /'(key|fixed)' column|column "?(key|fixed)"?/i.test(x.message ?? '')
}
function withoutCatMeta(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row }
  delete out.key
  delete out.fixed
  return out
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
    pending: !!t.pending,
    uncategorized: !!t.uncategorized,
    retired: !!t.retired,
    retired_pin: !!t.retiredPin,
    deleted: !!t.deleted,
    created_at: iso(t.createdAt),
    updated_at: iso(t.updatedAt),
  }
}

/**
 * The transactions columns a cloud may not have yet: `uncategorized` (the user
 * cleared a category on purpose), `retired` (the bank retired a pinned pending
 * row, banks.ts) and `retired_pin` (it was retired with no posted row found,
 * so it comes back if the bank lists it again). Until each migration runs,
 * the push goes without that column for the session: the flag still holds on
 * this device.
 */
const TX_FLAGS = ['uncategorized', 'retired', 'retired_pin'] as const
const txFlagsMissing = new Set<string>()
/** The flag column a refused upsert names as missing, if any. */
const missingTxFlag = (e: unknown): string | null => {
  const x = (e ?? {}) as { code?: string; message?: string }
  const msg = x.message ?? ''
  if (!(x.code === 'PGRST204' || x.code === '42703' || /column/i.test(msg))) return null
  return TX_FLAGS.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(msg)) ?? null
}
const isMissingTxFlag = (e: unknown) => missingTxFlag(e) != null
function withoutTxFlags(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row }
  for (const c of txFlagsMissing) delete out[c]
  return out
}

/**
 * Every row of a table. PostgREST cuts each answer at the project's max-rows
 * (1,000 by default) without an error, and a pull that read only the first
 * answer had a fresh device treat the rest as missing: its bank sync re-added
 * them raw, and the push wrote that over pins and hides in the cloud. Keyset
 * pages by id, stopping only on an EMPTY page, so a cap below the page size
 * cannot end the read early. A failed page fails the whole pull.
 */
const PAGE = 1000
async function selectAll(table: 'categories' | 'transactions' | 'accounts') {
  const page = (after: string | null) => {
    const q = supabase!.from(table).select('*').order('id').limit(PAGE)
    return after == null ? q : q.gt('id', after)
  }
  type Rows = NonNullable<Awaited<ReturnType<typeof page>>['data']>
  const out: Rows = []
  let after: string | null = null
  for (;;) {
    const { data, error } = await page(after)
    if (error) throw error
    if (!data || data.length === 0) return out
    out.push(...data)
    after = String(data[data.length - 1].id)
  }
}

const catKey = (name: string, kind: string) => `${String(name).trim().toLowerCase()}|${kind}`

// ---------- accounts ----------
/**
 * Accounts sync like categories (last write wins on updatedAt, tombstones for
 * deletes) once the cloud has the table (migration 20261005130000_accounts).
 * Until then each device keeps its own accounts, as before: a missing table is
 * remembered for ACCOUNTS_RECHECK_MS, so a long-lived session picks the table
 * up after the migration runs without asking on every sync.
 */
const ACCOUNTS_RECHECK_MS = 10 * 60 * 1000
let accountsMissingAt = 0
/** When the last accounts push finished (sign-out reads it). */
let accountsPushedAt = 0
/** A merge of the cloud's rows is being written: the Dexie hooks do not schedule a push for it. */
let applyingRemote = false

/** PostgREST's answer for a table it does not have (PGRST205), or Postgres's (42P01). */
const isMissingTable = (e: unknown) => {
  const x = (e ?? {}) as { code?: string; message?: string }
  return x.code === 'PGRST205' || x.code === '42P01' || /could not find the table|relation "?[\w.]*accounts"? does not exist/i.test(x.message ?? '')
}

const ACCOUNT_TYPES: readonly string[] = ['cash', 'credit', 'brokerage', 'retirement', 'benefit'] satisfies AccountType[]
const isAccountType = (t: unknown): t is AccountType => typeof t === 'string' && ACCOUNT_TYPES.includes(t)

function acctToRemote(a: Account, userId: string) {
  const finite = (n: unknown, d = 0) => (typeof n === 'number' && Number.isFinite(n) ? n : d)
  return {
    id: a.uid,
    user_id: userId,
    name: a.name ?? '',
    institution: a.institution ?? '',
    type: a.type,
    balance: finite(a.balance),
    live_sync: !!a.liveSync,
    source_account_id: a.sourceAccountId ?? null,
    source: a.source ?? null,
    last_updated: finite(a.lastUpdated) > 0 ? iso(a.lastUpdated) : null,
    sort_order: Math.round(finite(a.sortOrder)),
    archived: !!a.archived,
    deleted: !!a.deleted,
    source_said: a.sourceSaid ?? null,
    updated_at: iso(finite(a.updatedAt)),
  }
}

type Row = Record<string, unknown>

/** A cloud `source_said` as a local record, or undefined when it is not one. */
function saidFromRemote(v: unknown): SourceSaid | undefined {
  let o = v
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o)
    } catch {
      return undefined
    }
  }
  if (!o || typeof o !== 'object') return undefined
  const x = o as Record<string, unknown>
  const balance = Number(x.balance)
  if (typeof x.institution !== 'string' || typeof x.name !== 'string' || !isAccountType(x.type) || !Number.isFinite(balance)) return undefined
  return { institution: x.institution, name: x.name, type: x.type, balance }
}

/**
 * Whether the cloud's accounts table has the `source_said` column. Until its
 * migration runs, the push goes without it for the session, and each device
 * keeps its own record (a rename then holds on the device that made it).
 */
let acctSaidColumn = true
const isMissingSaid = (e: unknown) => {
  const x = (e ?? {}) as { code?: string; message?: string }
  return (x.code === 'PGRST204' || x.code === '42703' || /column/i.test(x.message ?? '')) && /\bsource_said\b/i.test(x.message ?? '')
}
function withoutSaid(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row }
  delete out.source_said
  return out
}

/** A cloud row as a local account. `local` fills what the cloud cannot say (an unknown tier). */
function acctFromRemote(r: Row, local?: Account): Account {
  const ms = (v: unknown) => {
    const t = v == null ? NaN : Date.parse(String(v))
    return Number.isFinite(t) ? t : 0
  }
  const balance = Number(r.balance)
  const sortOrder = Number(r.sort_order)
  return {
    uid: String(r.id),
    name: String(r.name ?? ''),
    institution: String(r.institution ?? ''),
    type: isAccountType(r.type) ? r.type : (local?.type ?? 'cash'),
    balance: Number.isFinite(balance) ? balance : (local?.balance ?? 0),
    liveSync: !!r.live_sync,
    // Undefined, not null: Dexie's update removes the key, as on a manual row.
    sourceAccountId: r.source_account_id != null ? String(r.source_account_id) : undefined,
    source: r.source != null ? String(r.source) : undefined,
    lastUpdated: ms(r.last_updated),
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
    archived: !!r.archived,
    deleted: !!r.deleted,
    // A cloud without the column says nothing: this device's own record stays.
    sourceSaid: r.source_said === undefined ? local?.sourceSaid : saidFromRemote(r.source_said),
    updatedAt: ms(r.updated_at),
  }
}

const withoutUndefined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

const squash = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
/** A hand-typed account's identity on any device: where it is held, its name, its tier. */
const manualKey = (a: Pick<Account, 'institution' | 'name' | 'type'>) => `${squash(a.institution)}|${squash(a.name)}|${a.type}`
const isManual = (a: Pick<Account, 'liveSync' | 'sourceAccountId'>) => !a.liveSync && !a.sourceAccountId
/** The connector account a row is fed by, if any. */
const linkKey = (source: unknown, sourceAccountId: unknown) => (sourceAccountId ? `${String(source ?? '')}\u0000${String(sourceAccountId)}` : null)

/**
 * A hand-typed account still at $0, which Accounts shows as 'No balance yet'.
 * It holds no figure. The old starter seed made such rows on every device,
 * each stamped with that device's first boot, so on a phone that booted after
 * the Mac's last edit an untouched $0 retirement row was the newer copy.
 */
const noFigure = (a: Account) => isManual(a) && !a.deleted && a.balance === 0

/**
 * Which of two copies of one account to keep. A copy with a figure beats one
 * without, however new the $0 copy is. Otherwise the newer edit wins, and a
 * tie goes to the smaller uid, so every device makes the same choice.
 */
function pick(a: Account, b: Account): Account {
  const na = noFigure(a)
  if (na !== noFigure(b)) return na ? b : a
  const ta = a.updatedAt || 0
  const tb = b.updatedAt || 0
  if (ta !== tb) return ta > tb ? a : b
  return (a.uid ?? '') <= (b.uid ?? '') ? a : b
}

/** A stamp newer than every copy, so a merge reaches the cloud and the other devices. */
const stampAfter = (...copies: Account[]) => Math.max(Date.now(), ...copies.map((a) => (a.updatedAt || 0) + 1))

/**
 * The copy that lost a merge, as a tombstone: never shown, never matched by a
 * connector sync, never offered back as Removed. Only the losing copy is
 * stamped. The winner keeps its own stamp, so a merge never makes an older
 * balance look newer than a copy fetched later (dedupeConnectorAccounts keeps
 * the newest), and a stale edit on the other device to a copy it held cannot
 * overwrite the winner, which sits under another uid.
 */
const retired = (a: Account, updatedAt: number): Account =>
  withoutUndefined({ ...syncedFields(a), uid: a.uid, deleted: true, liveSync: false, source: undefined, sourceAccountId: undefined, updatedAt })

/** What the cloud holds of an account (rowsSay and the local id stay on the device). */
function syncedFields(a: Account): Omit<Account, 'id' | 'uid' | 'rowsSay'> {
  return {
    name: a.name,
    institution: a.institution,
    type: a.type,
    balance: a.balance,
    liveSync: a.liveSync,
    sourceAccountId: a.sourceAccountId,
    source: a.source,
    lastUpdated: a.lastUpdated,
    sortOrder: a.sortOrder,
    archived: a.archived,
    deleted: a.deleted,
    sourceSaid: a.sourceSaid,
    updatedAt: a.updatedAt,
  }
}

type AccountsRead = { status: 'ok'; rows: Row[] } | { status: 'missing' } | { status: 'failed'; error: unknown }
/** 'ok' carries the hand-typed rows the push will send as new (recheckFresh). */
type AccountsPull = { status: 'ok'; fresh: string[] } | { status: 'missing' } | { status: 'failed'; error: unknown }

/** The cloud's accounts, or why there are none to merge. Never throws. */
async function selectAccounts(): Promise<AccountsRead> {
  if (accountsMissingAt && Date.now() - accountsMissingAt < ACCOUNTS_RECHECK_MS) return { status: 'missing' }
  try {
    const rows = (await selectAll('accounts')) as Row[]
    accountsMissingAt = 0
    return { status: 'ok', rows }
  } catch (e) {
    if (isMissingTable(e)) {
      accountsMissingAt = Date.now()
      return { status: 'missing' }
    }
    return { status: 'failed', error: e }
  }
}

/**
 * Whether this device has merged accounts with the cloud for this user: set
 * by its first accounts push, erased with the ledger (PERSONAL_KEYS).
 */
const ACCOUNTS_MERGED_KEY = 'tally:accountsMergedFor'
function accountsMergedFor(): string | null {
  try {
    return localStorage.getItem(ACCOUNTS_MERGED_KEY)
  } catch {
    return null
  }
}
function markAccountsMerged(userId: string): void {
  try {
    localStorage.setItem(ACCOUNTS_MERGED_KEY, userId)
  } catch {
    /* storage blocked: the merge still tells by the rows (mergeAccounts) */
  }
}

/**
 * Hand-typed rows this device pushed as new rows, until a read of the cloud's
 * accounts after that push has checked them for a twin (foldFresh). Each
 * successful accounts read checks them and replaces them with its own.
 */
let freshAccounts: ReadonlySet<string> = new Set()

interface MergeOpts {
  /** No accounts merge has finished on this device for this user yet. */
  first: boolean
  /** Hand-typed rows this device pushed as new before this read (freshAccounts). */
  fresh: ReadonlySet<string>
}

/**
 * Merge the cloud's accounts into Dexie. Runs inside a transaction.
 *
 * A row this device has (same uid) takes the cloud's copy when that is newer;
 * rowsSay is local and stays. A row it does not have is added, tombstones
 * included (a removed connector account must stay removed when a sync here
 * fetches it again).
 *
 * Before accounts synced, each device made its own rows, so the same account
 * can exist on two devices under two uids. A local row the cloud has never
 * seen pairs with a cloud row this device does not have (one each) when they
 * are the same account, and `pick` chooses the copy to keep. When it is the
 * cloud's, the local row becomes that row (its uid and fields). When it is
 * this device's, the local row goes up as it is and the cloud's copy becomes
 * a tombstone (`retired`). The pairs:
 *
 * - a hand-typed row of the same institution, name and tier (an equal balance
 *   is matched first);
 * - on a device's first merge only, a $0 hand-typed row (the old starter seed)
 *   also matches a row of the same canonical institution and tier, whatever
 *   its name, live or removed. That is how a connector sync claims a shell
 *   (brokerage.ts), so a $0 shell the other device's connector claimed and
 *   renamed folds into that account instead of arriving there as an extra
 *   'No balance yet' row, and a $0 shell the other device removed takes the
 *   removal. Later, a $0 account typed in here is never folded: the user
 *   just made it.
 *
 * Two rows the cloud already holds are never merged (the user made both),
 * except a twin of a row this device just pushed as new (foldFresh).
 *
 * Returns the uids of hand-typed rows the cloud has never seen that matched
 * nothing: the push sends them as new rows.
 */
async function mergeAccounts(rows: Row[], opts: MergeOpts): Promise<string[]> {
  const local = await db.accounts.toArray()
  const remoteIds = new Set(rows.map((r) => String(r.id)))
  const byUid = new Map(local.filter((a) => a.uid).map((a) => [a.uid!, a]))
  const incoming: Account[] = []
  for (const r of rows) {
    const mine = byUid.get(String(r.id))
    const fields = acctFromRemote(r, mine)
    if (!mine) incoming.push(fields)
    else if (fields.updatedAt > (mine.updatedAt || 0)) await db.accounts.update(mine.id!, fields)
  }
  // A device that holds a row the cloud has merged before, whatever its flag says.
  const first = opts.first && !local.some((a) => a.uid && remoteIds.has(a.uid))
  const unseen = local.filter((a) => a.id != null && !(a.uid && remoteIds.has(a.uid)))
  const paired = new Set<Account>()
  const free = (a: Account) => !paired.has(a)
  const adopt = async (mine: Account, theirs: Account) => {
    paired.add(mine)
    paired.add(theirs)
    if (pick(mine, theirs) === theirs) await db.accounts.update(mine.id!, theirs)
    else await db.accounts.add(retired(theirs, stampAfter(theirs)))
  }

  // Cloud rows that carry the most claim first: a figure (or a live link) the
  // cloud has but this device does not, then $0 rows, then removed ones. A
  // live row whose connector account this device already holds goes after
  // the others, since that copy folds into this device's own (dedupe).
  const localLinks = new Set(local.filter((a) => !a.deleted).map((a) => linkKey(a.source, a.sourceAccountId)))
  const rank = (r: Account) => (r.deleted ? 3 : noFigure(r) ? 2 : localLinks.has(linkKey(r.source, r.sourceAccountId)) ? 1 : 0)
  const ordered = incoming.map((r, i) => ({ r, i })).sort((x, y) => rank(x.r) - rank(y.r) || x.i - y.i).map((x) => x.r)

  // 1. The same hand-typed account on both devices.
  for (const r of ordered) {
    if (r.deleted || !isManual(r)) continue
    const twins = unseen.filter((a) => free(a) && !a.deleted && isManual(a) && manualKey(a) === manualKey(r))
    if (!twins.length) continue
    await adopt(twins.find((a) => a.balance === r.balance) ?? twins.find((a) => !noFigure(a)) ?? twins[0], r)
  }
  if (first) {
    // 2. A $0 starter row and any row of the same canonical institution and
    //    tier: an account, or its removal (which then holds).
    const cloudLinks = new Set(rows.map((r) => linkKey(r.source, r.source_account_id)))
    const localRank = (a: Account) => (a.deleted ? 2 : cloudLinks.has(linkKey(a.source, a.sourceAccountId)) ? 1 : 0)
    for (const r of ordered) {
      if (!free(r)) continue
      const empty = noFigure(r)
      const cands = unseen
        .filter((a) => free(a) && a.type === r.type && (empty || noFigure(a)) && institutionsMatch(a.institution, r.institution))
        .sort((a, b) => localRank(a) - localRank(b))
      if (cands.length) await adopt(cands[0], r)
    }
  }
  await foldFresh(incoming.filter(free), remoteIds, opts.fresh, paired)
  for (const r of incoming) if (free(r)) await db.accounts.add(withoutUndefined(r))
  await dedupeConnectorAccounts()
  return unseen.filter((a) => free(a) && !a.deleted && isManual(a) && a.uid).map((a) => a.uid!)
}

/**
 * Two devices whose first accounts syncs overlap each push their own copy of
 * a hand-typed account: each read the cloud before the other's push. Both
 * rows are then in the cloud, which the merge never folds. So a hand-typed
 * row this device just pushed as new (`fresh`) folds with the one cloud row
 * of the same institution, name and tier that it does not hold, when each is
 * the only one of its side (two the user typed on one device stay two). The
 * copy `pick` keeps stays as it is, and `pick` gives the same answer on both
 * devices, so either may fold. The other copy becomes a tombstone. When this
 * device's own row loses, it turns into the winner (same local row, so an
 * open screen keeps it) and its old uid goes up as the tombstone.
 */
async function foldFresh(theirs: Account[], remoteIds: ReadonlySet<string>, fresh: ReadonlySet<string>, paired: Set<Account>): Promise<void> {
  if (fresh.size === 0) return
  const mine = (await db.accounts.toArray()).filter((a) => a.uid && fresh.has(a.uid) && remoteIds.has(a.uid) && !a.deleted && isManual(a))
  const group = (list: Account[]) => {
    const m = new Map<string, Account[]>()
    for (const a of list) m.set(manualKey(a), [...(m.get(manualKey(a)) ?? []), a])
    return m
  }
  const theirsByKey = group(theirs.filter((r) => !r.deleted && isManual(r)))
  for (const [k, ours] of group(mine)) {
    const other = theirsByKey.get(k)
    if (ours.length !== 1 || other?.length !== 1) continue
    const [l, r] = [ours[0], other[0]]
    const at = stampAfter(l, r)
    if (pick(l, r) === r) await db.accounts.update(l.id!, { ...syncedFields(r), uid: r.uid })
    await db.accounts.add(retired(pick(l, r) === r ? l : r, at))
    paired.add(r)
  }
}

/**
 * One row per connector account. Before accounts synced, every device that
 * fetched a bank or brokerage made its own row for each account, so a merge
 * brings two rows with one (source, sourceAccountId) and both counted in net
 * worth. Every device keeps the same one, the row with the smallest uid, and
 * gives it the newest copy's fields; a removal on any copy holds (Accounts can
 * restore it). The rest become unlinked tombstones: never shown, never matched
 * by a connector sync, never offered back as Removed. Stamped, so the merge
 * reaches the other devices.
 */
async function dedupeConnectorAccounts(): Promise<void> {
  const groups = new Map<string, Account[]>()
  for (const a of await db.accounts.toArray()) {
    if (a.id == null || !a.uid || !a.sourceAccountId) continue
    const k = linkKey(a.source, a.sourceAccountId)!
    groups.set(k, [...(groups.get(k) ?? []), a])
  }
  const now = Date.now()
  const later = (a: Account) => Math.max(now, (a.updatedAt || 0) + 1)
  for (const list of groups.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => (a.uid! < b.uid! ? -1 : a.uid! > b.uid! ? 1 : 0))
    const keep = list[0]
    const newest = list.reduce((n, a) => ((a.updatedAt || 0) > (n.updatedAt || 0) ? a : n), keep)
    const want: Partial<Account> = {
      name: newest.name,
      institution: newest.institution,
      type: newest.type,
      balance: newest.balance,
      liveSync: newest.liveSync,
      lastUpdated: newest.lastUpdated,
      sortOrder: newest.sortOrder,
      archived: !!newest.archived,
      deleted: list.some((a) => a.deleted),
      // The connector's record goes with the fields it is read against.
      sourceSaid: newest.sourceSaid,
    }
    const same = (k: string, v: unknown) =>
      k === 'archived' || k === 'deleted'
        ? !!keep[k] === v
        : k === 'sourceSaid'
          ? JSON.stringify(keep.sourceSaid ?? null) === JSON.stringify(v ?? null)
          : keep[k as keyof Account] === v
    const patch = Object.fromEntries(Object.entries(want).filter(([k, v]) => !same(k, v))) as Partial<Account>
    if (Object.keys(patch).length) await db.accounts.update(keep.id!, { ...patch, updatedAt: later(newest) })
    // What the account's own rows said (local only, banks.ts), if only a copy knew.
    if (keep.rowsSay == null && newest.rowsSay != null) await db.accounts.update(keep.id!, { rowsSay: newest.rowsSay })
    for (const dup of list.slice(1)) {
      await db.accounts.update(dup.id!, { deleted: true, liveSync: false, source: undefined, sourceAccountId: undefined, updatedAt: later(dup) })
    }
  }
}

async function pushAccounts(userId: string): Promise<void> {
  const rows = (await db.accounts.toArray()).filter((a) => a.uid).map((a) => acctToRemote(a, userId))
  try {
    if (acctSaidColumn) {
      try {
        await resilientUpsert('accounts', rows, (e) => isMissingTable(e) || isMissingSaid(e))
      } catch (e) {
        if (!isMissingSaid(e)) throw e
        acctSaidColumn = false
        await resilientUpsert('accounts', rows.map(withoutSaid), isMissingTable)
      }
    } else {
      await resilientUpsert('accounts', rows.map(withoutSaid), isMissingTable)
    }
    accountsPushedAt = Date.now()
    markAccountsMerged(userId)
  } catch (e) {
    if (!isMissingTable(e)) throw e
    accountsMissingAt = Date.now()
  }
}

/**
 * Right after a push that sent hand-typed rows the cloud had never seen, read
 * the cloud's accounts back once and merge them. When two devices' first
 * accounts syncs overlap, the second push to land always sees the first, so
 * one of them folds the twins (foldFresh). A failed read leaves the check to
 * the next pull.
 */
async function recheckFresh(userId: string): Promise<void> {
  const again = await selectAccounts()
  if (again.status !== 'ok') return
  let more: string[] = []
  applyingRemote = true
  try {
    await db.transaction('rw', db.accounts, async () => {
      more = await mergeAccounts(again.rows, { first: false, fresh: freshAccounts })
    })
  } finally {
    applyingRemote = false
  }
  // Rows typed in during this run go up now and are checked at the next pull.
  freshAccounts = new Set(more)
  await pushAccounts(userId)
}

// ---------- sync core ----------

async function pull(userId: string): Promise<AccountsPull> {
  if (!supabase) return { status: 'missing' }
  // Every table comes down first. Everything below runs in ONE IndexedDB write
  // transaction, so it may wait on Dexie only: a network await inside would end
  // the transaction early. One transaction means one commit (the screens redraw
  // once, not once per row) and no other tab can add the same row mid-pull.
  // Accounts never fail the pull: without them (no table yet, or an error) the
  // ledger still syncs, and this device's accounts wait for the next run.
  const rcats = await selectAll('categories')
  const rtx = await selectAll('transactions')
  const raccts = await selectAccounts()
  let fresh: string[] = []
  applyingRemote = true
  try {
    await db.transaction('rw', db.categories, db.transactions, db.accounts, async () => {
      const localCats = await db.categories.toArray()
      const remoteCatIds = new Set(rcats.map((r) => String(r.id)))
      const catByUid = new Map(localCats.filter((c) => c.uid).map((c) => [c.uid!, c]))
      // Match by name+kind too, so a device's locally-seeded category ADOPTS the
      // cloud row on first sign-in instead of creating a duplicate (categories are
      // a fixed, name-identified set — never two "Groceries"). Candidates are live
      // rows the cloud has never seen; one the cloud knows matches by uid only.
      const catByName = new Map(
        localCats.filter((c) => !c.deleted && !(c.uid && remoteCatIds.has(c.uid))).map((c) => [catKey(c.name, c.kind), c]),
      )
      // Live cloud rows claim a twin first, so a tombstone adopts a seeded twin
      // only when no live row of that name did (a deleted default stays deleted),
      // and never takes the twin from the live row (which left no live category).
      const ordered = [...rcats].sort((a, b) => Number(!!a.deleted) - Number(!!b.deleted))
      for (const r of ordered) {
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
        // Only values the cloud actually holds: a null (or a cloud without the
        // columns) never wipes the local key or flag.
        if (r.key != null) fields.key = r.key
        if (r.fixed != null) fields.fixed = !!r.fixed
        if (local) {
          if (fields.updatedAt > local.updatedAt) await db.categories.update(local.id!, fields)
        } else {
          const k = catKey(r.name, r.kind)
          const twin = catByName.get(k)
          if (twin) {
            await db.categories.update(twin.id!, { ...fields, seeded: false }) // adopt cloud identity
            catByName.delete(k) // one local row adopts at most one cloud row
          } else {
            // A seeded category the cloud has no key for yet gets it from its name.
            if (fields.key === undefined) {
              const bk = builtInKey(fields.name)
              if (bk) fields.key = bk
            }
            await db.categories.add(fields)
          }
        }
      }

      await settleSeededDefaults(remoteCatIds)
      // A device that could not ask the cloud at boot did not seed. An account
      // with no categories at all gets the defaults now, and the push uploads them.
      if (rcats.length === 0 && (await db.categories.count()) === 0) await db.categories.bulkAdd(defaultCategories())

      // Self-heal: collapse local duplicates before resolving anything, so a device
      // that accumulated two "Groceries" rows converges instead of splitting spend.
      // Only rows the cloud has never seen are folded away (remoteCatIds holds
      // every uid the cloud knows, tombstones included).
      await dedupeLocalCategories(remoteCatIds)
      await repointDeletedCategories()

      // uid -> local category id, for resolving transaction.category_id
      const cats2 = await db.categories.toArray()
      const deletedIds = new Set(cats2.filter((c) => c.deleted).map((c) => c.id!))
      const localIdByCatUid = new Map(cats2.filter((c) => c.uid).map((c) => [c.uid!, c.id!]))
      // NAME-based fallback. A device whose local categories carry different uids
      // than the cloud's (duplicate sets, partial seeds) would otherwise resolve
      // every category_id to null and silently dump months of real spending into
      // "Uncategorized" — with the cloud perfectly correct the whole time.
      const localIdByCatName = new Map(cats2.filter((c) => !c.deleted).map((c) => [catKey(c.name, c.kind), c.id!]))
      const remoteCatKeyByUid = new Map(rcats.map((r) => [String(r.id), catKey(r.name, r.kind)]))
      const resolveCat = (remoteId: string | null): number | null => {
        if (!remoteId) return null
        const byUid = localIdByCatUid.get(remoteId)
        // A live row beats a tombstoned uid match.
        if (byUid != null && !deletedIds.has(byUid)) return byUid
        const key = remoteCatKeyByUid.get(remoteId)
        return (key ? localIdByCatName.get(key) : undefined) ?? byUid ?? null
      }

      // One row per uid before comparing: the same row stored twice would count
      // twice until the next bank reconcile (up to 6 hours) collapsed it.
      const { byUid: txByUid, copies } = oneRowPerUid(await db.transactions.toArray())
      if (copies.length) await db.transactions.bulkDelete(copies.map((c) => c.id!))
      for (const r of rtx) {
        // Missing from the snapshot taken above, a row may still have arrived
        // since: a bank sync on this device adds the same sf: uid. Adopt it rather
        // than add a second copy, which would count twice.
        const local = txByUid.get(r.id) ?? (await db.transactions.where('uid').equals(r.id).first())
        const remoteCat = r.category_id ?? null
        const fields: Transaction = {
          uid: r.id,
          date: r.date,
          amount: Number(r.amount),
          type: r.type,
          // A cloud category this device cannot resolve keeps the local one; a
          // real null from the cloud still applies.
          categoryId: resolveCat(remoteCat) ?? (remoteCat && local ? local.categoryId : null),
          account: r.account ?? '',
          note: r.note ?? '',
          manual: !!r.manual,
          pending: !!r.pending,
          uncategorized: !!r.uncategorized,
          retired: !!r.retired,
          // Only what the cloud holds: a cloud without the column says nothing.
          ...(r.retired_pin != null ? { retiredPin: !!r.retired_pin } : {}),
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
          // A cloud without the column cannot say the user cleared it.
          if (r.uncategorized == null && local.uncategorized) fields.uncategorized = true
          // Nor that the bank retired it (banks.ts). A pending row of this device's
          // that comes back pinned, deleted and posted was retired by another
          // device's bank sync: a hand Delete leaves pending as it was. Unmarked,
          // Activity › Removed offered it back, to count twice.
          if (r.retired == null) {
            fields.retired = !!fields.deleted && (!!local.retired || (!!local.pending && !fields.pending && !!fields.manual))
          }
          // A pending charge this device retired (banks.ts) that another device
          // has since brought back is settled: it is no longer waiting to return.
          if (r.retired_pin == null && local.retiredPin && !fields.deleted) fields.retiredPin = false
          await db.transactions.update(local.id!, fields)
        }
      }

      await rehomeOrphanedTransactions()
      if (raccts.status === 'ok') {
        fresh = await mergeAccounts(raccts.rows, { first: accountsMergedFor() !== userId, fresh: freshAccounts })
      }
    })
  } finally {
    applyingRemote = false
  }
  return raccts.status === 'ok' ? { status: 'ok', fresh } : raccts
}

/**
 * Settle the defaults this device seeded before it knew the account. A seed the
 * account adopted (or any seed, for a new account with no categories) is kept,
 * and so is one a transaction here uses. The rest never reached the cloud and
 * would come back as a duplicate of a default the account renamed: removed
 * outright (no tombstone, since the cloud never had them).
 */
async function settleSeededDefaults(remoteIds: Set<string>): Promise<void> {
  const seeds = (await db.categories.toArray()).filter((c) => c.seeded && c.id != null)
  for (const s of seeds) {
    const adopted = remoteIds.size === 0 || (s.uid != null && remoteIds.has(s.uid))
    const used = adopted ? 1 : await db.transactions.where('categoryId').equals(s.id!).count()
    if (used === 0) await db.categories.delete(s.id!)
    else await db.categories.update(s.id!, { seeded: false })
  }
}

/**
 * A transaction filed under a category that is no longer live (another device
 * deleted it after this one filed the row) moves where the delete itself would
 * have put it: the live category of the same name, else the live 'Other' of
 * that kind, else none. Left alone it counted in the month total but in no
 * budget row, and the sort queue never offered it. Stamped now, so the move
 * reaches the other devices.
 */
async function rehomeOrphanedTransactions(): Promise<void> {
  const cats = await db.categories.toArray()
  const byId = new Map(cats.map((c) => [c.id!, c]))
  const liveByKey = new Map<string, number>()
  for (const c of cats) if (!c.deleted && c.id != null) liveByKey.set(catKey(c.name, c.kind), c.id)
  const orphans = await db.transactions
    .filter((t) => !t.deleted && t.categoryId != null && !(byId.get(t.categoryId) && !byId.get(t.categoryId)!.deleted))
    .toArray()
  const now = Date.now()
  for (const t of orphans) {
    const dead = byId.get(t.categoryId!)
    const kind = dead?.kind ?? t.type
    const target = (dead && liveByKey.get(catKey(dead.name, dead.kind))) ?? liveByKey.get(`other|${kind}`) ?? null
    await db.transactions.update(t.id!, { categoryId: target, updatedAt: now })
  }
}

/**
 * Move transactions off tombstoned categories onto the live category of the same
 * name+kind. A transaction pointing at a deleted category is invisible to every
 * view that iterates live categories — so its spend silently vanished from the
 * budget while still counting in the month total, and it surfaced as a SECOND
 * "Uncategorized" row.
 */
async function repointDeletedCategories(): Promise<void> {
  const cats = await db.categories.toArray()
  const live = new Map<string, number>()
  for (const c of cats) {
    if (c.deleted || c.id == null) continue
    live.set(`${c.name.trim().toLowerCase()}|${c.kind}`, c.id)
  }
  for (const dead of cats) {
    if (!dead.deleted || dead.id == null) continue
    const target = live.get(`${dead.name.trim().toLowerCase()}|${dead.kind}`)
    if (target == null || target === dead.id) continue
    await db.transactions.where('categoryId').equals(dead.id).modify({ categoryId: target })
  }
}

/**
 * Fold local categories that share a name+kind, but only rows that never
 * reached the cloud (their uid is not among `remoteIds`): their transactions
 * move to the kept row, stamped so the move syncs, and the row is removed
 * outright (the cloud never had it, so there is nothing to tombstone).
 * Duplicates like that arise when a device makes a category before it knows
 * the account.
 *
 * A category the cloud already has is never merged or tombstoned. Every row
 * gets a uid when it is created (db.ts), so a uid proves nothing, and
 * 'most recently touched' picked the row just renamed: renaming Fun to
 * 'Dining' tombstoned the real Dining and its budget everywhere. Two cloud
 * rows of one name stay live (each keeps its own budget and spending); the
 * editor refuses to make them.
 */
async function dedupeLocalCategories(remoteIds: ReadonlySet<string>): Promise<void> {
  const cats = await db.categories.toArray()
  const byKey = new Map<string, typeof cats>()
  for (const c of cats) {
    if (c.deleted || c.id == null) continue
    const k = catKey(c.name, c.kind)
    const list = byKey.get(k) ?? []
    list.push(c)
    byKey.set(k, list)
  }
  const inCloud = (c: Category) => c.uid != null && remoteIds.has(c.uid)
  for (const list of byKey.values()) {
    if (list.length < 2) continue
    const localOnly = list.filter((c) => !inCloud(c))
    if (localOnly.length === 0) continue
    // Keep the oldest row the cloud has; with none, the oldest local row. The
    // local id is creation order on this device (updatedAt is last touched).
    const byAge = (a: Category, b: Category) => a.id! - b.id!
    const keep = list.filter(inCloud).sort(byAge)[0] ?? [...localOnly].sort(byAge)[0]
    const now = Date.now()
    for (const dup of localOnly) {
      if (dup.id === keep.id) continue
      await db.transactions.where('categoryId').equals(dup.id!).modify({ categoryId: keep.id!, updatedAt: now })
      await db.categories.delete(dup.id!)
    }
  }
}

/**
 * Upsert in chunks, and when a chunk fails retry its rows one-by-one so a single
 * poison row (bad id, constraint violation) can't wedge the entire push — the
 * failure mode that once kept the whole transactions table at 0 rows. An error
 * `fatal` recognises (a column the cloud does not have yet) fails every row the
 * same way, so it is thrown at once instead of retried row by row.
 */
async function resilientUpsert(
  table: 'categories' | 'transactions' | 'accounts',
  rows: Record<string, unknown>[],
  fatal: (e: unknown) => boolean = () => false,
): Promise<void> {
  if (!supabase || rows.length === 0) return
  let lastError: unknown = null
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const { error } = await supabase.from(table).upsert(chunk)
    if (!error) continue
    if (fatal(error)) throw error
    for (const row of chunk) {
      const { error: e } = await supabase.from(table).upsert(row)
      if (e) lastError = e // skip the poison row, keep pushing the rest
    }
  }
  if (lastError) throw lastError
}

/**
 * Push every row. Accounts go up only when this run pulled them: a device that
 * could not read the cloud's accounts must not write its own over them, and a
 * failed accounts push never holds back the ledger's.
 */
async function push(userId: string, accounts: boolean): Promise<void> {
  if (!supabase) return
  const cats = await db.categories.toArray()
  const txs = await db.transactions.toArray()
  const catUidById = new Map(cats.filter((c) => c.uid).map((c) => [c.id!, c.uid!]))

  const catRows = cats.filter((c) => c.uid).map((c) => catToRemote(c, userId))
  if (catMetaColumns) {
    try {
      await resilientUpsert('categories', catRows, isMissingColumn)
    } catch (e) {
      if (!isMissingColumn(e)) throw e
      catMetaColumns = false
      await resilientUpsert('categories', catRows.map(withoutCatMeta))
    }
  } else {
    await resilientUpsert('categories', catRows.map(withoutCatMeta))
  }
  const txRows = txs.filter((t) => t.uid).map((t) => txToRemote(t, userId, catUidById))
  // Each refusal names one missing column: drop it and go again, at most once per column.
  for (;;) {
    try {
      await resilientUpsert('transactions', txRows.map(withoutTxFlags), isMissingTxFlag)
      break
    } catch (e) {
      const col = missingTxFlag(e)
      if (!col || txFlagsMissing.has(col)) throw e
      txFlagsMissing.add(col)
    }
  }
  if (accounts) await pushAccounts(userId)
}

/**
 * 'ok': this run pulled the cloud's rows into Dexie. 'failed': it could not
 * (this device may be behind the cloud). 'skipped': nothing to pull from (no
 * backend, offline, or signed out).
 */
export type SyncResult = 'ok' | 'failed' | 'skipped'

let inflight: Promise<SyncResult> | null = null
let queued = false
/** The run in flight has begun its push, which reads Dexie as it is now. */
let pushing = false

/**
 * Pull, then push. A call that lands mid-run returns the run in flight, so
 * `await syncNow()` always means the cloud's rows are in Dexie (the bank
 * overlay awaits this first). It queues one more run only once that run has
 * begun its push: an edit made earlier is in that push already, and queueing
 * then doubled every window focus into two full syncs.
 */
export function syncNow(): Promise<SyncResult> {
  if (!supabase) return Promise.resolve('skipped')
  if (inflight) {
    if (pushing) queued = true
    return inflight
  }
  inflight = runSync().finally(() => {
    inflight = null
    if (queued) {
      queued = false
      void syncNow()
    }
  })
  return inflight
}

async function runSync(): Promise<SyncResult> {
  if (!supabase) return 'skipped'
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'skipped' // offline — the 'online' listener retries
  const { data } = await supabase.auth.getSession()
  const user = data.session?.user
  if (!user) return 'skipped' // signed out: no cloud copy to fall behind
  emit({ status: 'syncing', error: null })
  let pulled = false
  try {
    // Another account's ledger on this device must never be pushed as this one's.
    const last = readLastUser()
    if (last && last !== user.id) {
      await wipeLocalLedger()
      void loadMerchantRules() // this account's own rules, not the last one's
    }
    writeLastUser(user.id)
    const accounts = await pull(user.id)
    pulled = true
    pushing = true
    // Set before the push: one that fails may still have landed, and the next
    // pull then folds a twin of these rows all the same.
    if (accounts.status === 'ok') freshAccounts = new Set(accounts.fresh)
    await push(user.id, accounts.status === 'ok')
    if (accounts.status === 'ok' && accounts.fresh.length) await recheckFresh(user.id)
    if (accounts.status === 'failed') {
      // The ledger synced; the accounts did not, and the next run tries again.
      const why = (accounts.error as { message?: unknown } | null)?.message
      emit({ status: 'error', error: `Accounts did not sync${typeof why === 'string' && why ? `: ${why}` : '.'}` })
    } else {
      emit({ status: 'synced', lastSyncedAt: Date.now(), error: null })
    }
  } catch (e) {
    emit({ status: 'error', error: e instanceof Error ? e.message : 'Sync failed.' })
  } finally {
    pushing = false
  }
  // A push that failed after a good pull still left the cloud's rows in Dexie.
  return pulled ? 'ok' : 'failed'
}

// ---------- who this device's ledger belongs to ----------
const LAST_USER_KEY = 'tally:lastUserId'
/** Personal keys outside Dexie, cleared with the ledger (device preferences stay). */
const PERSONAL_KEYS = ['tally:lastBankFetchAt', 'tally:bankAttemptAt', 'tally-forced-bank-at', ACCOUNTS_MERGED_KEY]

function readLastUser(): string | null {
  try {
    return localStorage.getItem(LAST_USER_KEY)
  } catch {
    return null
  }
}
function writeLastUser(id: string): void {
  try {
    localStorage.setItem(LAST_USER_KEY, id)
  } catch {
    /* storage blocked */
  }
}

let ledgerGeneration = 0
/** Bumped whenever the local ledger is wiped, so a bank overlay that started
 *  before cannot write the old account's rows after it (banks.ts). */
export function currentLedgerGeneration(): number {
  return ledgerGeneration
}

/** Erase this device's copy of the ledger: transactions, categories, accounts. */
async function wipeLocalLedger(): Promise<void> {
  ledgerGeneration++
  freshAccounts = new Set()
  await db.transaction('rw', db.transactions, db.categories, db.accounts, async () => {
    await db.transactions.clear()
    await db.categories.clear()
    await db.accounts.clear()
  })
  for (const k of PERSONAL_KEYS) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* storage blocked */
    }
  }
  clearUserRules()
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
  // DEV-only QA hook: ?__fakeSession=1 presents a signed-in, recently synced
  // session (no network) so the harness can capture the signed-in Settings
  // sheet. import.meta.env.DEV is false in production builds, so this whole
  // block is dropped from dist.
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('__fakeSession') === '1') {
    emit({ email: 'you@example.com', status: 'synced', lastSyncedAt: Date.now() - 4 * 60 * 1000, error: null })
    return
  }
  if (!supabase || started) return
  started = true

  supabase.auth.getSession().then(({ data }) => {
    if (data.session?.user) {
      emit({ email: data.session.user.email ?? null, status: 'idle' })
      void loadMerchantRules()
      void syncNow()
    }
  })

  supabase.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      emit({ email: session.user.email ?? null })
      // Not awaited: supabase-js holds its auth lock while this callback runs.
      if (event === 'SIGNED_IN') void loadMerchantRules()
      void syncNow()
    } else {
      if (event === 'SIGNED_OUT') clearUserRules()
      emit({ email: null, status: 'signedout', lastSyncedAt: null })
    }
  })

  for (const table of [db.categories, db.transactions, db.accounts]) {
    table.hook('creating', () => schedule())
    table.hook('updating', () => schedule())
  }

  // No focus listener here: App's focus refresh runs syncAllConnectors, which
  // syncs first. A second one here made every focus two full syncs.
  setInterval(() => {
    if (snapshot.email && document.visibilityState !== 'hidden') void syncNow()
  }, 45000)
  window.addEventListener('online', () => {
    if (snapshot.email) void syncNow()
  })
}

/**
 * One plain sentence for a failed sign-up, instead of the server's wording.
 * The raw message is logged for debugging. A rate limit is checked before
 * /email/, because Supabase's 'email rate limit exceeded' is not a bad address,
 * and an existing account (the sign-in just failed) means the wrong password.
 */
function authErrorCopy(raw: string): string {
  console.warn('Tally sign-in:', raw)
  if (/rate limit|too many/i.test(raw)) return 'Too many tries. Wait a minute, then try again.'
  if (/already registered|already exists/i.test(raw)) return 'That password does not match this email.'
  if (/email/i.test(raw)) return 'Check the email address.'
  if (/password/i.test(raw)) return 'Use at least 8 characters.'
  return 'Could not sign in. Try again.'
}

/** Sign in, creating the account on first use. Returns an error string or null. */
export async function signIn(email: string, password: string): Promise<string | null> {
  if (!supabase) return 'Sync is not configured.'
  const clean = email.trim().toLowerCase()
  const signin = await supabase.auth.signInWithPassword({ email: clean, password })
  if (!signin.error) return null

  // Sign-in failed — try to create the account (first-time use).
  const signup = await supabase.auth.signUp({ email: clean, password })
  if (signup.error) return authErrorCopy(signup.error.message)
  if (!signup.data.session) {
    // Supabase obfuscates an already-registered email by returning a user with an
    // EMPTY identities array. Empty ⇒ the account exists and the password was
    // wrong (not an email-confirmation issue). Non-empty ⇒ a genuinely new
    // account that needs confirming.
    const identities = signup.data.user?.identities
    if (identities && identities.length === 0) return 'That password does not match this email.'
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

/**
 * 'signed out': done (`local`: the server could not be reached, so the session
 * was dropped on this device only). 'confirm': nothing happened yet; the text
 * says what a second tap erases from this device.
 */
export type SignOutResult = { ok: true; local: boolean } | { ok: false; confirm: string }

/**
 * Sign out and erase this device's copy of the ledger, so the next account to
 * sign in here neither sees it nor uploads it as its own. Edits are pushed
 * first; when that fails, or when an account typed in by hand that never
 * reached the cloud (no accounts table yet) would be erased, the first call
 * only says so and a confirmed call proceeds.
 */
export async function signOutSync(opts: { confirmed?: boolean } = {}): Promise<SignOutResult> {
  if (!supabase) return { ok: true, local: false }
  if (!opts.confirmed) {
    const started = Date.now()
    let res = await syncNow()
    while (inflight) res = await inflight // a queued follow-up run carries the newest edits
    const pushed = res === 'ok' && snapshot.status === 'synced' && (snapshot.lastSyncedAt ?? 0) >= started
    // Hand-typed accounts are in the cloud once this sync pushed them; until
    // the cloud has the accounts table they live on this device only.
    const manual = pushed && accountsPushedAt >= started ? 0 : await db.accounts.filter((a) => !a.deleted && !a.liveSync).count()
    const says: string[] = []
    if (!pushed) says.push('Some changes have not reached the cloud yet.')
    if (manual) says.push(`${manual === 1 ? 'An account you added by hand is' : `${manual} accounts you added by hand are`} only on this device.`)
    if (says.length) return { ok: false, confirm: `${says.join(' ')} Signing out erases them here. Tap again to sign out.` }
  }
  let local = false
  const { error } = await supabase.auth.signOut().catch((e: unknown) => ({ error: e }))
  if (error) {
    // Offline or a server error: auth-js keeps the session (any scope) and
    // fires no SIGNED_OUT. Leave this device anyway.
    console.warn('Tally sign-out:', error instanceof Error ? error.message : error)
    local = true
    await supabase.auth.stopAutoRefresh().catch(() => {})
    dropStoredSession()
  }
  await wipeLocalLedger()
  // Signed out, the app still works on its own: the defaults, marked as this
  // device's seed so the next sign-in keeps only what that account adopts.
  await db.categories.bulkAdd(defaultCategories(true))
  emit({ email: null, status: 'signedout', lastSyncedAt: null, error: null })
  return { ok: true, local }
}

/** Remove the stored session by hand: auth-js's own removal needs the server. */
function dropStoredSession(): void {
  const named = (supabase?.auth as unknown as { storageKey?: unknown })?.storageKey
  try {
    const keys = typeof named === 'string' ? [named] : Object.keys(localStorage).filter((k) => /^sb-.+-auth-token$/.test(k))
    for (const k of keys) for (const suffix of ['', '-code-verifier', '-user']) localStorage.removeItem(k + suffix)
  } catch {
    /* storage blocked */
  }
}

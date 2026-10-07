# Tally — Personal Finance (PWA)

A local-first spending & budgeting app. Installable PWA, all data in the browser
(IndexedDB). No backend, no accounts, no API keys — it just runs.

> Working name. Rename freely (package.json `name`, the manifest in
> `vite.config.ts`, the `<title>` in `index.html`, and the `.brand` text in
> `src/App.tsx`).

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (preview uses 5174)
npm run build      # type-check + production build + service worker
npm run preview    # serve the production build
```

## What it does (v1)

- **Budget tab** — month summary (spent / income / net), "left to spend"
  against your total monthly budget, and a progress bar per category.
- **Activity tab** — every transaction for the month; tap any row to edit/delete.
- **Categories tab** — rename, re-emoji, recolor, and set a recurring monthly
  budget per category. Add/remove categories.
- **Import tab** — paste or upload a bank/card CSV. Columns are auto-detected,
  rows are auto-categorized by keyword, and you confirm before importing.
- **＋ (FAB)** — quick-add a transaction. The category is auto-suggested from
  the note as you type (e.g. "Trader Joe's" → Groceries).

## Architecture

```
src/
  db/
    db.ts          Dexie schema + types — the ONLY place that touches storage
    seed.ts        default categories (atomic first-run seed)
  lib/
    format.ts      money formatting
    dates.ts       month math (local-time safe, no UTC off-by-one)
    csv.ts         CSV parser + column/amount/date guessing
    categorize.ts  keyword → category rules (import + quick-add suggestions)
  components/
    Dashboard.tsx        budget view
    TransactionList.tsx  activity list
    TransactionSheet.tsx add/edit modal
    Categories.tsx       category + budget editor
    ImportCsv.tsx        CSV import flow
  App.tsx          shell: month nav, tabs, modal wiring
```

### Data model

- **Category**: `{ name, emoji, color, kind: 'expense'|'income', monthlyBudget, sortOrder }`
  — `monthlyBudget` is a recurring per-month limit (0 = none).
- **Transaction**: `{ date (YYYY-MM-DD), amount, type, categoryId, account, note }`
  — direction lives in `type`, and `amount` is positive, with one exception: a
  merchant refund on a card is an **expense with a negative amount**, filed in
  the merchant's category, so it comes off that category's spending in the
  month it posts (every total just adds amounts). Card payments are transfers
  and never land (`src/lib/bankRules.ts`).
- **Rent paid early**: a synced Rent payment made on or after the 20th of a
  month is dated the 1st of the next month, the month it pays for, so every
  month carries one rent (a fixed day, so a 28-, 30- or 31-day month makes no
  difference). A date set by hand is never moved. The bank's own day is kept
  beside the moved date on the device (`posted`, never synced), so filing the
  payment out of Rent by hand puts that day back.

Every row carries `updatedAt`. That's deliberate (see below).

## Backend (Supabase)

Sync and the live connectors run on Supabase. The Edge Functions in
`supabase/functions/` (`simplefin`, `snaptrade`, `teller`) read everything
account-specific from function secrets, never from the source.

**Before any `supabase functions deploy`**, set these secrets alongside the
existing `SNAPTRADE_CONSUMER_KEY`, `TELLER_*` and service keys:

- `OWNER_EMAIL`: the owner's sign-in email. Every connector checks the caller
  against it (and against `owner_uid`).
- `SNAPTRADE_CLIENT_ID`: the SnapTrade Personal client id.

Without them every connector rejects every request, by design (fail closed),
and SnapTrade answers `not configured`.

SimpleFIN does not define the sign of a card's balance. `simplefin` reads a
positive card balance as owed only for the accounts its earlier rules called
credit (`legacyInferTier`), so a redeploy sends every account the same balance
as before and moves no net worth. To settle the sign for good, call the `raw`
action on a card with a known balance (owed, and in credit), then replace that
with one rule for every card.

### Personal categorization rules

The built-in keyword rules in `src/lib/categorize.ts` are generic on purpose:
the source ships in the public bundle. Rules for your own merchants (a
landlord, a local restaurant, a niche shop) live in the per-user
`merchant_rules` table instead, created by
`supabase/migrations/20260928120000_merchant_rules.sql` (owner-only row-level
security). The app loads them after sign-in, caches them on the device, and
merges them with the built-ins by `priority`: the built-ins sit on multiples of
10, the lowest matching priority wins, and your rule wins a tie. Until a copy of
the rules is on the device, automatic re-filing of bank transactions waits.

### Sync columns

`supabase/migrations/20261005120000_sync_columns.sql` adds `categories.key`
and `categories.fixed` (with a backfill of the built-in categories by name),
and `transactions.uncategorized` and `transactions.retired`. The app pushes
without each column until it exists, so it can run before or after a client
ships; until it runs, a renamed built-in category, a category cleared on
purpose and a retired pending charge hold only on the device that made them.

`supabase/migrations/20261007120000_retired_pin_source_said.sql` adds
`transactions.retired_pin` (a pinned pending charge the bank left out, retired
with no posted row found, so any device brings it back if the bank lists it
again) and `accounts.source_said` (what a connector last said about a live
account, so a name, institution or type the user set in the account sheet
survives the next sync on every device). The app pushes without each column
until it exists; until then both hold only on the device that set them.

### Account sync

`supabase/migrations/20261005130000_accounts.sql` creates `accounts`
(owner-only row-level security, the `keep_newer_row()` last-write-wins
trigger). Accounts then sync like categories: every edit stamps `updatedAt`, a
delete is a tombstone, and the newer copy wins. Until the table exists each
device keeps its own accounts, as before, and the app checks for the table
again every ten minutes. A failed accounts read never stops the ledger's sync;
the accounts wait for the next run, and Settings shows the error.

Before this, each device made its own rows. The first syncs merge them, so net
worth counts each account once:

- Connector accounts (SimpleFIN, SnapTrade) are one row per
  `(source, sourceAccountId)`. Every device keeps the row with the smallest
  uid and gives it the newest copy's fields. The other rows become tombstones
  with no source link, so no connector sync matches them and Accounts never
  offers them back.
- A hand-typed account the cloud has never seen pairs with a hand-typed cloud
  row of the same institution, name and tier that this device does not have
  yet. The copy that wins is kept as it is, under its own uid and stamp. When
  the cloud's copy wins, this device's row becomes it; when this device's
  wins, it goes up unchanged and the cloud's copy becomes a tombstone. A
  merge never re-stamps the winner, so it cannot make an older balance look
  newer than a copy fetched later, and no edit to the losing copy can write
  over the winner. Two hand-typed rows the cloud already holds are never
  merged: the user made both.
- A hand-typed account at $0 (Accounts shows "No balance yet") holds no
  figure, so a copy with a balance always wins over it, however new the $0
  copy is. The old starter seed made such rows on every device, stamped at
  that device's first boot, so a phone's untouched $0 retirement row was
  often newer than the Mac's typed balance. Between two balances the newer
  edit wins.
- On a device's first accounts sync only, a $0 hand-typed row also folds into
  a row of the same canonical institution and tier whatever its name: the
  account a connector on the other device claimed and renamed, a renamed
  hand-typed account, or a row the other device removed (the removal then
  holds). This is the rule a connector sync uses to claim a shell. A $0
  account typed in after that first sync is never folded.
- When two devices make their first accounts sync in the same moment, each
  reads the cloud before the other pushes, so each pushes its own copy of a
  hand-typed account. Right after any push that sent new hand-typed rows, the
  app reads the accounts back once. The second push to land always sees the
  first and folds the two copies of an account (same institution, name and
  tier, one on each side): the winning copy stays and the other becomes a
  tombstone. Both devices choose the same winner. A failed read, or a push
  that reported an error but landed, leaves the fold to the next sync.

What the merged totals mean:

- Each account ends with its newest figure, so net worth after the merge is
  the sum of those. It equals one device's earlier total when that device held
  the newest figure of every account, as when a device of untouched starter
  rows joins one that has the balances.
- A removal of a connector account on either device holds everywhere, even
  when the other device still counted it, so the merged total can match
  neither device's earlier figure. The account stays under Removed in
  Accounts and can be restored from there. A hand-typed account with a
  balance is never hidden by a removal on another device.
- Left as they are:
  - A $0 starter row whose institution and tier match nothing on the other
    device (no account and no removal) arrives there as one more "No balance
    yet" row, to delete once.
  - In a same-moment first sync, a $0 starter row folds only into a row of
    the same name.
  - An edit made on the other device to its losing copy before that device
    has pulled the merge (under a minute while its app is open, longer if it
    is offline) brings that copy back as a second row, to delete once. Taking
    over the losing copy's uid instead would avoid the second row, but then
    a rename of a stale copy would silently write its older figure over the
    newer one.
  - After the merge, an edit made on a device that has not pulled the other's
    newer change replaces the whole row, as for categories and transactions.

## Roadmap / next steps

1. **Supabase sync** (multi-device). The seam is ready: all reads/writes go
   through `src/db/db.ts`, and every row already has `updatedAt` for
   last-write-wins. Plan: add a Dexie `version(2)` with `remoteId` / `deletedAt`,
   a sync module that pushes/pulls changed rows, and Supabase auth. No table
   rewrites needed. (Supabase MCP is already connected in this workspace.)
2. **LedgerLens import** — pipe PDF statements through the existing
   `../ledgerlens` extractor → CSV → the Import tab. The import layer already
   accepts the CSV shape LedgerLens emits.
3. **Per-month budget overrides** — today budgets are a single recurring amount
   per category; add optional month-specific overrides.
4. **Recurring transactions**, **search/filter**, **multi-currency**,
   **net-worth/accounts** view.
5. **Proper PWA icons** — currently a single SVG; generate 192/512 PNGs for full
   install-prompt support on all platforms.

## Notes

- React StrictMode double-invokes effects in dev; the first-run seed is wrapped
  in a Dexie transaction so it can't double-seed. (If you ever see duplicated
  categories from older data, clear the `tally` IndexedDB database.)

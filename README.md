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
- **Rent paid early**: a synced Rent payment made in the last week of a month
  is dated the 1st of the next month, the month it pays for, so every month
  carries one rent. A date set by hand is never moved.

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

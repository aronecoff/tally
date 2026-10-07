-- Columns the client already reads and writes (schema and a generic backfill
-- only; no rows ship with the repo).
--
-- Until each column exists the app pushes without it and keeps the value on
-- the device (src/sync/sync.ts), so this is safe to run before or after the
-- client ships. All four are additive and idempotent.
--
-- categories.key    The built-in category a row started as ('rent', 'other
--                   income'), kept through a rename. Fixed-bill projection,
--                   rent dating and rule filing read it, so a renamed Rent
--                   keeps working on every device, not only the one that
--                   renamed it.
-- categories.fixed  A fixed monthly bill, projected at its budget and never
--                   paced. Null means "decided by the key".
-- transactions.uncategorized
--                   The user cleared the category on purpose: the self-heal
--                   must not file it again.
-- transactions.retired
--                   A pinned pending row the bank retired (it posted under a
--                   new id, or the hold was dropped). Its tombstone is the
--                   bank's, so no device offers it back as Removed.

alter table public.categories
  add column if not exists key text,
  add column if not exists fixed boolean;

-- Backfill the seeded categories by their built-in names, the same set and
-- rules as the client's own upgrade (src/lib/categorize.ts BUILT_IN and
-- FIXED_CATEGORIES, src/db/db.ts version 4). updated_at is left alone, as the
-- client's upgrade leaves updatedAt alone: a backfill stamped now would
-- out-vote every device's own copy.
update public.categories
  set key = lower(btrim(name))
  where key is null
    and lower(btrim(name)) in (
      'groceries', 'dining', 'rent', 'transport', 'subscriptions', 'health', 'shopping', 'fun', 'other',
      'salary', 'freelance', 'other income'
    );

update public.categories
  set fixed = lower(btrim(name)) in ('rent', 'subscriptions', 'health')
  where fixed is null;

alter table public.transactions
  add column if not exists uncategorized boolean not null default false,
  add column if not exists retired boolean not null default false;

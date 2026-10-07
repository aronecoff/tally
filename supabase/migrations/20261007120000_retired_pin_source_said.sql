-- Two columns the client already reads and writes (schema only; no rows ship
-- with the repo).
--
-- Until each column exists the app pushes without it and keeps the value on
-- the device (src/sync/sync.ts), so this is safe to run before or after the
-- client ships. Both are additive and idempotent.
--
-- transactions.retired_pin
--                   A pinned pending charge the bank stopped listing, retired
--                   with no posted row found for it (src/lib/banks.ts). If the
--                   bank lists it again under its id, it comes back with the
--                   user's edits on whichever device sees that first. Kept on
--                   one device only, every other device held a tombstone it
--                   could not bring back.
-- accounts.source_said
--                   What a connector last said about a live account: its
--                   institution, name, tier and its own signed balance
--                   (src/db/db.ts SourceSaid). An institution, name or type
--                   that differs from it was set by the user in the account
--                   sheet, and a sync on any device keeps it.

alter table public.transactions
  add column if not exists retired_pin boolean not null default false;

-- public.accounts comes from 20261005130000_accounts.sql. If that has not run
-- yet, its own create table already has the column, so this skips.
do $do$
begin
  if to_regclass('public.accounts') is not null then
    alter table public.accounts add column if not exists source_said jsonb;
  end if;
end;
$do$;

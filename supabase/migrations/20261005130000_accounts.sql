-- Accounts, synced between devices (schema only; no rows ship with the repo).
--
-- Until this table exists the app keeps each device's accounts on that device,
-- as before, and checks for the table again every ten minutes
-- (src/sync/sync.ts). It is safe to run before or after the client ships, and
-- running it twice changes nothing.
--
-- id          The device's uid for the row (src/db/db.ts Account.uid): text,
--             made by the client.
-- updated_at  Stamped by the client on every edit. keep_newer_row() keeps the
--             stored row when a write is older (last write wins), the same
--             trigger as categories and transactions.
-- deleted     A delete is a tombstone, never a row delete, so it reaches every
--             device. A connector account the user removed keeps its
--             source_account_id (Accounts can restore it); a duplicate merged
--             away by the client has source_account_id and source cleared.
--
-- Connector accounts (source 'simplefin' or 'snaptrade') are matched across
-- devices by (source, source_account_id) in the client, which keeps one row
-- per account. There is no unique index on that pair on purpose: two devices
-- that fetched the same bank before this table existed each push their own
-- row, and a unique index would refuse the second push instead of letting the
-- client merge them.

create table if not exists public.accounts (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default '',
  institution text not null default '',
  type text not null,
  balance numeric not null default 0,
  live_sync boolean not null default false,
  source_account_id text,
  source text,
  last_updated timestamptz,
  sort_order integer not null default 0,
  archived boolean not null default false,
  deleted boolean not null default false,
  -- What the connector last said about a live account (see
  -- 20261007120000_retired_pin_source_said.sql).
  source_said jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists accounts_user_id_idx on public.accounts (user_id);

alter table public.accounts enable row level security;

drop policy if exists "accounts_select_own" on public.accounts;
create policy "accounts_select_own" on public.accounts
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "accounts_insert_own" on public.accounts;
create policy "accounts_insert_own" on public.accounts
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "accounts_update_own" on public.accounts;
create policy "accounts_update_own" on public.accounts
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "accounts_delete_own" on public.accounts;
create policy "accounts_delete_own" on public.accounts
  for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.accounts from anon;
grant select, insert, update, delete on table public.accounts to authenticated;

-- keep_newer_row() already guards categories and transactions in the project.
-- It is created here only if it is missing (a fresh project), with the same
-- rule: an update older than the stored row leaves the stored row as it is.
-- An existing function is left exactly as it is.
do $do$
begin
  if to_regprocedure('public.keep_newer_row()') is null then
    create function public.keep_newer_row()
    returns trigger
    language plpgsql
    set search_path = ''
    as $fn$
    begin
      if new.updated_at < old.updated_at then
        return old;
      end if;
      return new;
    end;
    $fn$;
  end if;
end;
$do$;

drop trigger if exists accounts_keep_newer_row on public.accounts;
create trigger accounts_keep_newer_row
  before update on public.accounts
  for each row execute function public.keep_newer_row();

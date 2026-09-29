-- Per-user categorization rules (schema only; no rows ship with the repo).
--
-- The app's built-in rules in src/lib/categorize.ts are generic and public.
-- Anything personal (a landlord, a local restaurant, a niche shop) goes in the
-- owner's own rows here instead. The client loads them after sign-in
-- (src/sync/merchantRules.ts) and merges them with the built-ins by priority:
-- the built-ins sit on multiples of 10 (expense 10..110 and 180..190, income
-- 10..30), the lowest matching priority wins, and a user rule wins a tie.
--
-- flags is limited to i/m/s/u: g and y make RegExp.test() stateful, so the same
-- text would match on one call and miss on the next.

create table if not exists public.merchant_rules (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  pattern text not null check (char_length(pattern) between 1 and 500),
  flags text not null default 'i' check (flags ~ '^[imsu]*$'),
  category text not null,
  kind text not null default 'expense' check (kind in ('expense', 'income')),
  priority integer not null,
  updated_at timestamptz not null default now()
);

create index if not exists merchant_rules_user_priority_idx
  on public.merchant_rules (user_id, priority);

alter table public.merchant_rules enable row level security;

create policy "merchant_rules_select_own" on public.merchant_rules
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "merchant_rules_insert_own" on public.merchant_rules
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "merchant_rules_update_own" on public.merchant_rules
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "merchant_rules_delete_own" on public.merchant_rules
  for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.merchant_rules from anon;
grant select, insert, update, delete on table public.merchant_rules to authenticated;

create or replace function public.merchant_rules_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists merchant_rules_touch_updated_at on public.merchant_rules;
create trigger merchant_rules_touch_updated_at
  before update on public.merchant_rules
  for each row execute function public.merchant_rules_touch_updated_at();

-- The savings plan, one row per user (schema only; no rows ship with the repo).
--
-- A plan is three values: what to save each month (goal), what may be spent
-- each month (cap), and whether the cap is locked. While it is locked the app
-- measures the month against cap instead of what the category budgets add up
-- to, and refuses a budget edit that would take their total past it
-- (src/lib/savingsPlan.ts).
--
-- since       'YYYY-MM', the first month the savings average counts. Set when
--             the lock turns on, null while it is off.
-- pending     A loosening asked for while locked (a higher cap, a lower goal,
--             or the lock turned off), as
--             {"from": "YYYY-MM", "cap"?: n, "goal"?: n, "locked"?: false}.
--             It is in force from the 1st of `from`. The client folds it in
--             when it reads the row (planOn), so nothing has to run that day.
--             A pending change always asks for something: one with a month
--             and nothing else is refused here, because the client reads it
--             as no change at all (readPlan).
-- past_caps   The cap the counted months before a raise had, kept when the
--             raise lands, as [{"until": "YYYY-MM", "cap": n}, ...]: each
--             month before `until` is judged against `cap`. So a raise never
--             turns a past month that went over into one that was inside.
--             Empty while unlocked or before any raise has landed.
-- updated_at  Stamped by the client on every change. keep_newer_row() keeps
--             the stored row when a write is older (last write wins), the same
--             trigger as categories, transactions and accounts.
--
-- Until this table exists the app behaves as if there were no plan and offers
-- no setting for one (src/lib/planStore.ts). It is safe to run before or after
-- the client ships, and running it twice changes nothing.
--
-- There is no delete. No client path removes a plan (turning the lock off
-- keeps the row with locked false), so a device that holds a plan never takes
-- a missing row for a newer answer than its own copy. The row goes only with
-- the account.
--
-- The lock is a commitment device, not security. Nothing here stops an owner
-- changing their own row; the rule about waiting for the next month lives in the
-- client.

create table if not exists public.savings_plan (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  goal numeric not null default 0 check (goal >= 0),
  cap numeric not null default 0 check (cap >= 0),
  locked boolean not null default false,
  since text check (since is null or since ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- Each test is wrapped in coalesce because a check that comes out null
  -- passes, and a missing key makes these come out null.
  pending jsonb check (
    pending is null
    or jsonb_typeof(pending) = 'null'
    or (
      jsonb_typeof(pending) = 'object'
      and coalesce((pending ->> 'from') ~ '^[0-9]{4}-(0[1-9]|1[0-2])$', false)
      and (
        coalesce(jsonb_typeof(pending -> 'cap') = 'number', false)
        or coalesce(jsonb_typeof(pending -> 'goal') = 'number', false)
        or coalesce((pending -> 'locked') = 'false'::jsonb, false)
      )
    )
  ),
  past_caps jsonb not null default '[]'::jsonb check (jsonb_typeof(past_caps) = 'array'),
  updated_at timestamptz not null default now(),
  -- A locked plan is a whole one: both amounts, and a month to count from.
  constraint savings_plan_locked_is_whole check (not locked or (goal > 0 and cap > 0 and since is not null))
);

alter table public.savings_plan enable row level security;

drop policy if exists "savings_plan_select_own" on public.savings_plan;
create policy "savings_plan_select_own" on public.savings_plan
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "savings_plan_insert_own" on public.savings_plan;
create policy "savings_plan_insert_own" on public.savings_plan
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "savings_plan_update_own" on public.savings_plan;
create policy "savings_plan_update_own" on public.savings_plan
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Only what the client uses. The revoke comes first because the project's
-- default grants would otherwise leave authenticated with delete, truncate,
-- references and trigger as well.
revoke all on table public.savings_plan from anon, authenticated;
grant select, insert, update on table public.savings_plan to authenticated;

-- keep_newer_row() already guards categories, transactions and accounts in the
-- project. It is created here only if it is missing (a fresh project), with the
-- same rule: an update older than the stored row leaves the stored row as it
-- is. An existing function is left exactly as it is.
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

drop trigger if exists savings_plan_keep_newer_row on public.savings_plan;
create trigger savings_plan_keep_newer_row
  before update on public.savings_plan
  for each row execute function public.keep_newer_row();

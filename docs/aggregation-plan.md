# Tally — Account Aggregation Strategy (researched 2026-06-30)

**Bottom line:** no single solo-accessible aggregator covers everything. Use a **3-source stack** feeding one Supabase Edge Function backend, normalized into one schema. Realistic cost **$0–$15/yr**.

- **SnapTrade** (free) → brokerages: Robinhood (margin) + Webull. *Webull is impossible via Plaid/Teller — SnapTrade is the only path.*
- **Teller** (free dev tier) → banks + cards. Already chosen. Needs mTLS (server-side only). *Alt: Plaid free Trial plan (10 items, since 2026-04-15) — no mTLS, better Amex coverage, but opaque pricing if outgrown.*
- **Manual entry** → Schwab 401(k), Robinhood Gold card, HSA/benefits (the genuine gaps).

## Coverage per account
| Account | Connector | Live? | Notes |
|---|---|---|---|
| Chase checking + card | Teller | ✅ daily | High confidence |
| Citizens checking + savings | Teller | ~ daily | Likely; verify in Connect |
| Amex card + HYSA | Teller → fallback Plaid/SimpleFIN | ⚠️ unconfirmed | Amex = hardest issuer; test it |
| Robinhood brokerage (margin) | SnapTrade | ✅ | Holdings + margin loan |
| Webull | SnapTrade | ✅ | Only SnapTrade reaches it |
| Robinhood Gold card | none | ❌ manual | Bank-issued; unconfirmed everywhere |
| Schwab 401(k) | none reliable | ❌ manual | Employer recordkeeper ≠ retail Schwab; not OAuth-aggregatable |
| BambooHR benefits | none | ❌ | Not a financial institution — connect the HSA *custodian* instead |

## Gaps (build clean manual fallbacks + staleness badges)
- **Schwab 401k:** manual balance, update from statement; assume holdings manual.
- **Robinhood Gold card:** manual; CSV if RH exports.
- **BambooHR:** drop it. Find the real HSA/FSA custodian (HealthEquity is Plaid-linkable). Model FSA/insurance/401k contributions as recurring payroll-deduction line items.
- **"Real-time":** everything is poll-on-refresh (~daily), not streaming. Frame as "one-tap / daily refresh."
- **Transfers:** no aggregator flags internal transfers — we infer them (below).

## Data model (extends Dexie: accounts, balances, holdings, txns)
Add `Account {source, institution, type: cash|credit|brokerage|retirement|benefit, liveSync, tier}`, `Balance {ledger, marginLoan}`, `Holding {symbol, qty, marketValue}`, and `Txn {kind: spend|income|transfer|trade, transferGroupId}`.

**Transfer de-dup (critical for a clean view):** for each new txn, match an opposite-sign txn on a *different own account* with equal amount within ±4 days; on match tag both `kind='transfer'` + shared `transferGroupId` and **exclude from all spend/income math**. Credit-card payments = transfers (the spend was the card purchases). Ambiguous matches → one-tap confirm. Manual overrides persist.

**Net worth** = Σcash + Σ(brokerage marketValue − margin) + Σretirement + Σbenefits − Σcredit owed.

## Tiering (the "one clean view", by liquidity)
1. **Cash** — Citizens, Chase checking, Amex HYSA → total liquid
2. **Credit** — Chase/Amex/RH cards (shown negative) → owed + available
3. **Brokerage** — Robinhood (margin), Webull → market value − margin
4. **Retirement** — Schwab 401k → balance (manual)
5. **Benefits/HSA** — HSA + payroll deductions
→ **Net worth** headline across all. "Safe to spend" (home hero) draws **only from Tier 1 cash**. Each account has an overridable `tier` + live/manual badge.

## Build phases
- **Phase 0:** Supabase Edge Function backend (holds Teller cert + SnapTrade key). **De-risk first:** confirm hosted Deno allows mTLS outbound (`Deno.createHttpClient`) to api.teller.io — if not, banks pivot to Plaid/SimpleFIN.
- **Phase 1:** unified data model + manual-account UI + tiering/net-worth view (NO signups needed — delivers "see everything tiered" immediately) → then SnapTrade (brokerages) → then Teller (Chase first, then Citizens/Amex) → transfer matcher.
- **Phase 2:** Amex fallback if Teller fails; manual accounts (401k, RH card, HSA); payroll-deduction line items; LedgerLens CSV import for statements.
- **Phase 3:** scheduled refresh; optional Plaid Trial spike for 401k (best-effort).

## What Aron must do himself
1. **SnapTrade** signup → clientId + consumerKey (consumerKey = secret → Supabase).
2. **Teller** → application_id (safe) + certificate.pem + private_key.pem (secrets → Supabase), env = Development.
3. **Connect each account** via the widgets (his bank/broker credentials + MFA — can't be done for him).
4. **Name the HSA/FSA custodian** behind BambooHR's "corona" (or confirm none).

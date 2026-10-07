// @ts-nocheck
// Deployed to the `tally` Supabase project as the `simplefin` Edge Function
// (verify_jwt OFF — custom owner auth, same model as `snaptrade`).
//
// Banks & cards via SimpleFIN Bridge (simplefin.org) — built for an individual
// aggregating their OWN accounts, so no developer approval and no mTLS. Flow:
//   1. The user creates a "Setup Token" at bridge.simplefin.org (base64 of a
//      one-time claim URL).
//   2. `claim`: we POST the decoded claim URL and get back an Access URL that
//      embeds HTTP Basic credentials; we store it in `simplefin_access` (id=1,
//      service-role only — it's a secret).
//   3. `sync`: GET {access_url}/accounts?balances-only=1, normalize to Tally
//      tiers. Deno's fetch won't send URL-embedded credentials, so we parse them
//      into an Authorization header ourselves.
//
// Owner identity (owner_uid) is shared with the other connectors via
// snaptrade_user(id=1). Fail-closed while owner_uid is NULL.
// Secrets: OWNER_EMAIL (the owner's sign-in email; unset => reject all).
import { createClient } from "npm:@supabase/supabase-js@2";

const OWNER_EMAIL = Deno.env.get("OWNER_EMAIL")?.trim().toLowerCase() || undefined;
const supa = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } }); }

async function ownerUid() {
  const { data } = await supa.from("snaptrade_user").select("owner_uid").eq("id", 1).maybeSingle();
  return data?.owner_uid;
}
async function requireOwner(req, uid) {
  if (!uid) return json({ ok: false, error: "unauthorized" }, 401); // fail closed
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ ok: false, error: "unauthorized" }, 401);
  const { data, error } = await supa.auth.getUser(token);
  const u = data?.user;
  // An unset OWNER_EMAIL secret rejects everyone, like a NULL owner_uid.
  const emailOk = !!OWNER_EMAIL && (u?.email ?? "").toLowerCase() === OWNER_EMAIL;
  if (error || !u || !u.email_confirmed_at || u.id !== uid || !emailOk) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

async function getAccessUrl() {
  const { data } = await supa.from("simplefin_access").select("access_url").eq("id", 1).maybeSingle();
  return data?.access_url;
}

// Deno fetch strips URL-embedded credentials, so pull them into a Basic header.
function authFetch(accessUrl, path) {
  const u = new URL(accessUrl);
  const auth = "Basic " + btoa(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`);
  u.username = ""; u.password = "";
  const base = u.toString().replace(/\/+$/, "");
  return fetch(base + path, { headers: { Authorization: auth, Accept: "application/json" } });
}

const pick = (v) => (v == null || (typeof v === "string" && v.trim() === "")) ? null : v;

// SimpleFIN gives no account-type field, so infer. Order matters: classify by
// product-type NAME first so a positive-balance deposit account (e.g. "Discover
// Online Savings", "Debit Card", or an overdrawn "Total Checking") is never
// inverted into a liability. Ambiguous brand/bare tokens ("card", "discover",
// bare "credit") are deliberately excluded — only unambiguous liability names
// count. Balance sign is the LAST resort to flag an otherwise-unlabeled,
// genuinely-owed account as credit.
// KEEP IN STEP with tierFromName in src/lib/bankRules.ts (the app re-reads the
// name, and remembers a card once seen, so a $0 card never reads as cash).
// - Plan numbers are word-bounded: a 4-digit mask like "(4013)" or "(2457)" is
//   not a 401(k) or a 457 plan.
// - HSA is a benefit account: its card spending is real spending.
// - Cash names win over investment words ("Schwab Investor Checking",
//   "Individual Checking"), and "CKG"/"CHK"/"DDA" are checking.
// - Card products named without "visa"/"amex" (Gold Card, Sapphire, Freedom).
function inferTier(name, num) {
  const n = String(name ?? "").toLowerCase();
  if (/\b(?:401|403|457)(?:\s*\(?[kb]\)?|\b)|\bira\b|roth|retire|pension|rrsp|\bsep\b/.test(n)) return "retirement";
  if (/\bhsa\b|health ?savings/.test(n)) return "benefit";
  if (/check|chequing|saving|money ?market|\bcd\b|certificate|deposit|debit|cash management|\bhysa\b|\bckg\b|\bchk\b|\bdda\b/.test(n)) return "cash";
  if (/brokerage|invest|securities|\bindividual\b|margin/.test(n)) return "brokerage";
  if (/credit card|line of credit|\bloc\b|\bloan\b|mortgage|\bvisa\b|master ?card|\bamex\b|american express|\bsapphire\b|\bfreedom\b|gold card|platinum card/.test(n)) return "credit";
  if (Number.isFinite(num) && num < 0) return "credit";
  return "cash";
}

// FROZEN copy of inferTier as it shipped before Oct 2026. It only decides the
// owed-clamp below, so redeploying with the wider name rules sends every
// account the SAME balance number as before and moves no net worth (the app's
// net worth depends on that number alone; the tier only picks the section).
// Without it, a "Gold Card" or "Sapphire" at a positive balance, which the old
// rules read as cash (+X, money in your favour), would be clamped to owed (-X).
// Whether a positive card balance means owed or in your favour is unsettled
// (SimpleFIN does not define the sign): check a card with a known balance
// through the "raw" action, then replace this with one rule for every card.
function legacyInferTier(name, num) {
  const n = String(name ?? "").toLowerCase();
  if (/401|403|457|\bira\b|roth|retire|pension|rrsp|\bsep\b/.test(n)) return "retirement";
  if (/brokerage|invest|securities|\bindividual\b|margin|\bhsa\b/.test(n)) return "brokerage";
  if (/check|chequing|saving|money ?market|\bcd\b|certificate|deposit|debit|cash management|\bhysa\b/.test(n)) return "cash";
  if (/credit card|line of credit|\bloc\b|\bloan\b|mortgage|\bvisa\b|master ?card|\bamex\b/.test(n)) return "credit";
  if (Number.isFinite(num) && num < 0) return "credit";
  return "cash";
}

function normalize(a) {
  const org = a?.org ?? {};
  const balRaw = pick(a?.balance) ?? pick(a?.["available-balance"]);
  const num = balRaw == null ? NaN : Number(balRaw);
  const tier = inferTier(a?.name, num);
  // Tally stores assets positive, credit as positive amount OWED (client flips).
  // SimpleFIN credit balances may be signed either way, so clamp to owed, but
  // only where the pre-Oct-2026 rules did (legacyInferTier above).
  const clamp = legacyInferTier(a?.name, num) === "credit";
  const balance = Number.isNaN(num) ? null : (clamp ? -Math.abs(num) : num);
  return {
    sourceAccountId: `${org.domain || org.name || "sf"}:${a?.id}`,
    institution: org.name || org.domain || "Bank",
    name: a?.name || "Account",
    tier,
    balance,
    currency: a?.currency || "USD",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const uid = await ownerUid();
    const denied = await requireOwner(req, uid);
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "status";

    if (action === "status") {
      return json({ ok: true, connected: !!(await getAccessUrl()) });
    }

    if (action === "claim") {
      const setupToken = String(body.setupToken ?? "").trim();
      if (!setupToken) return json({ ok: false, error: "missing setup token" }, 400);
      let claimUrl;
      try { claimUrl = atob(setupToken).trim(); } catch { return json({ ok: false, error: "that doesn't look like a valid setup token" }, 400); }
      // SSRF guard: a claim URL is only ever a SimpleFIN bridge endpoint over
      // https. Without this, a crafted token makes the function fetch arbitrary
      // URLs server-side (internal services, cloud metadata, ...).
      let claimHost = "";
      try { claimHost = new URL(claimUrl).hostname; } catch { /* handled below */ }
      if (!/^https:\/\//i.test(claimUrl) || !/(^|\.)simplefin\.org$/i.test(claimHost)) {
        return json({ ok: false, error: "that doesn't look like a SimpleFIN setup token" }, 400);
      }
      const res = await fetch(claimUrl, { method: "POST", headers: { "content-length": "0" } });
      const accessUrl = (await res.text()).trim();
      if (!res.ok || !/^https?:\/\/.+:.+@/.test(accessUrl)) {
        return json({ ok: false, error: "claim failed — the token may be expired or already used. Generate a fresh one." }, 400);
      }
      const { error } = await supa.from("simplefin_access").upsert({ id: 1, access_url: accessUrl, updated_at: new Date().toISOString() });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, connected: true });
    }

    if (action === "raw") {
      const url = await getAccessUrl();
      if (!url) return json({ ok: false, error: "not connected" }, 400);
      const res = await authFetch(url, "/accounts?balances-only=1");
      return json({ ok: true, status: res.status, raw: await res.json().catch(() => null) });
    }

    if (action === "sync") {
      const url = await getAccessUrl();
      if (!url) return json({ ok: false, error: "not connected" }, 400);
      const res = await authFetch(url, "/accounts?balances-only=1");
      if (!res.ok) return json({ ok: false, error: `simplefin /accounts -> ${res.status}` }, 502);
      const data = await res.json().catch(() => ({}));
      const accounts = (data?.accounts ?? []).map(normalize);
      // errlist is protocol 2's structured form of errors; the app reads both
      // and archives nothing while either reports a problem.
      return json({ ok: true, accounts, errors: data?.errors ?? [], errlist: data?.errlist ?? [] });
    }

    if (action === "transactions") {
      const url = await getAccessUrl();
      if (!url) return json({ ok: false, error: "not connected" }, 400);
      const days = Math.min(365, Math.max(7, Number(body.days) || 120));
      const start = Math.floor(Date.now() / 1000) - days * 86400;
      // `pending=1` is REQUIRED: SimpleFIN omits pending/authorised-but-not-
      // posted charges by default, which is why they never appeared in Tally.
      const res = await authFetch(url, `/accounts?start-date=${start}&pending=1`);
      if (!res.ok) return json({ ok: false, error: `simplefin /accounts -> ${res.status}` }, 502);
      const data = await res.json().catch(() => ({}));
      const transactions = [];
      // Every account that answered, rows or not: the app retires a dropped
      // pending hold on a card that answered with no rows at all.
      const accounts = [];
      for (const a of data?.accounts ?? []) {
        const balNum = Number(pick(a?.balance) ?? pick(a?.["available-balance"]));
        const tier = inferTier(a?.name, balNum);
        const org = a?.org ?? {};
        const account = `${org.name || org.domain || "Bank"} ${a?.name || ""}`.trim();
        // The same key the `sync` action gives the account, so the app can read
        // each row by the account's remembered tier, and the account's own name
        // for when it has none stored yet (`account` also carries the institution).
        const sourceAccountId = `${org.domain || org.name || "sf"}:${a?.id}`;
        accounts.push(account);
        for (const t of a?.transactions ?? []) {
          transactions.push({
            sourceTxId: `${org.domain || "sf"}:${a?.id}:${t?.id}`,
            sourceAccountId,
            accountName: a?.name || "",
            account,
            tier,
            // A pending row may carry posted 0 (allowed by SimpleFIN): that is
            // no date, not 1970. `||` skips it; the app dates such a row today.
            posted: t?.transacted_at || t?.posted || null,
            pending: !!t?.pending,
            amount: Number(t?.amount),
            description: t?.description || t?.payee || "",
            payee: t?.payee || "",
            memo: t?.memo || "",
            mcc: t?.mcc || null,
          });
        }
      }
      console.log(`[tx] accounts=${(data?.accounts ?? []).length} txns=${transactions.length}`);
      return json({ ok: true, transactions, accounts, errors: data?.errors ?? [], errlist: data?.errlist ?? [] });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});

// @ts-nocheck
// Deployed to the `tally` Supabase project as the `teller` Edge Function
// (verify_jwt OFF — custom owner auth, same model as `snaptrade`).
//
// Banks & cards via Teller (teller.io). Teller's API requires MUTUAL TLS in the
// development/production environments, which Supabase Edge supports via
// Deno.createHttpClient({ cert, key }) (confirmed by the mtls spike). Per-
// enrollment access tokens (one per bank login) live in the `teller_enrollment`
// table (service-role only); the access token is the credential to read that
// enrollment's accounts.
//
// Secrets (set as Supabase function secrets, never in the repo):
//   TELLER_APP_ID   — Teller application id (app_...), safe-ish but kept server-side
//   TELLER_ENV      — 'development' (default) | 'sandbox' | 'production'
//   TELLER_CERT     — client certificate PEM (or base64 of it)
//   TELLER_KEY      — client private key PEM (or base64 of it)  [SECRET]
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — injected by the platform
// Owner identity (owner_uid) is shared with `snaptrade` via snaptrade_user(id=1).
import { createClient } from "npm:@supabase/supabase-js@2";

const OWNER_EMAIL = "aron@haloconnections.com";
const APP_ID = (Deno.env.get("TELLER_APP_ID") ?? "").trim();
const ENV = (Deno.env.get("TELLER_ENV") ?? "development").trim();
const supa = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

// Accept either a raw PEM or a base64-encoded PEM (avoids newline issues in the
// secrets UI).
function pem(v) {
  v = (v ?? "").trim();
  if (!v) return "";
  return v.startsWith("-----BEGIN") ? v : (() => { try { return atob(v); } catch { return v; } })();
}
const CERT = pem(Deno.env.get("TELLER_CERT"));
const KEY = pem(Deno.env.get("TELLER_KEY"));
const CONFIGURED = !!(APP_ID && CERT && KEY);

let tlsClient = null;
function client() {
  if (!tlsClient) tlsClient = Deno.createHttpClient({ cert: CERT, key: KEY });
  return tlsClient;
}

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
  const emailOk = (u?.email ?? "").toLowerCase() === OWNER_EMAIL;
  if (error || !u || !u.email_confirmed_at || u.id !== uid || !emailOk) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

async function tellerGet(path, accessToken) {
  const res = await fetch("https://api.teller.io" + path, {
    client: client(),
    headers: { Authorization: "Basic " + btoa(accessToken + ":"), Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`teller ${path} -> ${res.status}`);
  return await res.json();
}

async function enrollments() {
  const { data } = await supa.from("teller_enrollment").select("*");
  return data ?? [];
}

// depository -> cash, credit -> credit (liability).
function tierFor(type) { return String(type).toLowerCase() === "credit" ? "credit" : "cash"; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const uid = await ownerUid();
    const denied = await requireOwner(req, uid);
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "config";

    if (action === "config") {
      return json({ ok: true, applicationId: APP_ID, environment: ENV, ready: CONFIGURED });
    }

    if (action === "enroll") {
      const accessToken = String(body.accessToken ?? "");
      if (!accessToken) return json({ ok: false, error: "missing accessToken" }, 400);
      const row = {
        access_token: accessToken,
        enrollment_id: body.enrollmentId ?? null,
        institution: body.institution ?? null,
        updated_at: new Date().toISOString(),
      };
      // Upsert on enrollment_id so re-enrolling the same bank refreshes its token.
      const onConflict = body.enrollmentId ? { onConflict: "enrollment_id" } : undefined;
      const { error } = await supa.from("teller_enrollment").upsert(row, onConflict);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "raw") {
      // Owner-only debug: returns unprocessed Teller data to verify field shapes/signs.
      if (!CONFIGURED) return json({ ok: false, error: "teller not configured" }, 400);
      const out = [];
      for (const e of await enrollments()) {
        const accts = await tellerGet("/accounts", e.access_token).catch((err) => ({ error: String(err) }));
        out.push({ enrollment: e.enrollment_id, institution: e.institution, accounts: accts });
      }
      return json({ ok: true, raw: out });
    }

    if (action === "sync") {
      if (!CONFIGURED) return json({ ok: false, error: "teller not configured" }, 400);
      const accounts = [];
      for (const e of await enrollments()) {
        let accts;
        try { accts = await tellerGet("/accounts", e.access_token); } catch { continue; }
        for (const a of accts ?? []) {
          if (a?.status === "closed") continue;
          let ledger = null, available = null;
          try {
            const b = await tellerGet(`/accounts/${a.id}/balances`, e.access_token);
            ledger = b?.ledger; available = b?.available;
          } catch { /* leave balance null */ }
          const tier = tierFor(a?.type);
          // Distinguish "no balance observed" (the /balances fetch failed, or a
          // field came back as an empty string) from a real 0. Number(null) and
          // Number("") are both 0, which would silently overwrite a good balance
          // with $0; emit null instead so the client merge skips it and keeps the
          // last known good value.
          const pick = (v) => (v == null || (typeof v === "string" && v.trim() === "")) ? null : v;
          const src = pick(ledger) ?? pick(available);
          const rawNum = src == null ? NaN : Number(src);
          // Tally convention: assets positive; credit negative-when-owed (client
          // flips to positive owed). Teller credit ledger is the amount owed, so
          // store -|amount|. (Verify the exact sign via the `raw` action.)
          const balance = Number.isNaN(rawNum) ? null : (tier === "credit" ? -Math.abs(rawNum) : rawNum);
          accounts.push({
            sourceAccountId: a?.id,
            institution: a?.institution?.name ?? "Bank",
            name: a?.name ?? a?.subtype ?? "Account",
            tier,
            balance,
            currency: a?.currency ?? "USD",
          });
        }
      }
      return json({ ok: true, accounts });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});

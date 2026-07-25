// @ts-nocheck
// Deployed to the `tally` Supabase project as the `snaptrade` Edge Function
// (deploy via the Supabase dashboard or MCP; verify_jwt is OFF — see below).
//
// Custom auth (verify_jwt is left OFF on purpose): the platform JWT gate would
// also accept the *public* anon key as a valid JWT, which is no gate at all.
// More subtly, the email claim is forgeable — with open signup + email
// confirmation off, anyone can sign up AS the owner's email and mint a validly
// signed JWT carrying it. So we gate on the IMMUTABLE auth user id, not email:
//   - owner_uid is stored server-side in snaptrade_user (id=1).
//   - the caller's bearer must resolve via getUser() to that exact user id,
//     with a confirmed email.
//   - owner_uid NULL  => fail closed (reject everyone). This is the state until
//     the owner signs in once and their uid is recorded.
//
// Secrets (set as Supabase function secrets, never in the repo):
//   SNAPTRADE_CONSUMER_KEY      — SnapTrade Personal consumer key
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — injected by the platform
// The SnapTrade userId/userSecret + owner_uid live in `snaptrade_user` (id=1),
// readable only with the service role.
import { Snaptrade } from "npm:snaptrade-typescript-sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const OWNER_EMAIL = "aron@haloconnections.com";
const CLIENT_ID = "PERS-9ENEAQ3M36XJQNF2MB32";
const CONSUMER_KEY = (Deno.env.get("SNAPTRADE_CONSUMER_KEY") ?? "").trim();
const st = new Snaptrade({ clientId: CLIENT_ID, consumerKey: CONSUMER_KEY });
const supa = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } }); }

async function config() {
  const { data } = await supa.from("snaptrade_user").select("*").eq("id", 1).maybeSingle();
  return { userId: data?.user_id, userSecret: data?.user_secret, ownerUid: data?.owner_uid };
}

// Resolve the bearer token to a user; only the provisioned owner uid passes.
// Returns null when authorized, otherwise a Response to short-circuit with.
async function requireOwner(req, ownerUid) {
  if (!ownerUid) return json({ ok: false, error: "unauthorized" }, 401); // fail closed: owner not provisioned
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ ok: false, error: "unauthorized" }, 401);
  const { data, error } = await supa.auth.getUser(token);
  const u = data?.user;
  const emailOk = (u?.email ?? "").toLowerCase() === OWNER_EMAIL;
  if (error || !u || !u.email_confirmed_at || u.id !== ownerUid || !emailOk) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

// Map a SnapTrade account to a Tally net-worth tier from its structured
// category/type, not name-string guessing. balance stays SnapTrade-signed
// (credit/LOC is negative when owed); the client normalizes the sign.
function tierFor(a) {
  const cat = String(a?.account_category ?? "").toUpperCase();
  const t = String(a?.raw_type ?? a?.meta?.type ?? a?.meta?.brokerage_account_type ?? "").toUpperCase();
  if (cat === "LOC" || t.includes("CREDIT") || t.includes("LOAN") || t.includes("MARGIN_LOAN")) return "credit";
  if (/IRA|ROTH|401|403|457|RRSP|RSP|RETIRE|PENSION|SEP|SIMPLE|LIRA|LRSP/.test(t)) return "retirement";
  if (cat === "CASH" || t === "CASH" || t === "CHECKING" || t === "SAVINGS" || t === "DEPOSIT") return "cash";
  return "brokerage";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { userId, userSecret, ownerUid } = await config();
    const denied = await requireOwner(req, ownerUid);
    if (denied) return denied;

    if (!userId) return json({ ok: false, error: "snaptrade_user not provisioned" }, 500);
    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "connect";

    if (action === "connect") {
      const login = await st.authentication.loginSnapTradeUser({ userId, userSecret, immediateRedirect: false });
      return json({ ok: true, redirectURI: login?.data?.redirectURI ?? login?.data });
    }
    if (action === "sync") {
      const acc = await st.accountInformation.listUserAccounts({ userId, userSecret });
      const accounts = (acc?.data ?? [])
        .filter((a) => a?.status !== "closed" && a?.is_paper !== true)
        .map((a) => ({
          sourceAccountId: a.id,
          institution: a.institution_name ?? a?.meta?.institution_name ?? a?.brokerage_authorization?.brokerage?.name ?? "Brokerage",
          name: a.name ?? a.number ?? "Account",
          tier: tierFor(a),
          balance: a?.balance?.total?.amount ?? a?.total_value?.value ?? null,
          currency: a?.balance?.total?.currency ?? a?.total_value?.currency ?? "USD",
        }));
      return json({ ok: true, accounts });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e?.responseBody?.detail ?? e?.message ?? e), code: e?.responseBody?.code, status: e?.status }, 500);
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMAIL_RE = /^[^\s@%]+@[^\s@%]+\.[^\s@%]{2,}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

function getClientIp(req: Request): string {
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => null);
    const cleanId = String(body?.identifier ?? "").trim().toLowerCase();
    const rawPassword = String(body?.password ?? "");

    if (!cleanId || !rawPassword || cleanId.length > 160) {
      return jsonResponse({ error: "Username/email and password are required" }, 400);
    }

    const isEmail = cleanId.includes("@");
    if (isEmail) {
      if (!EMAIL_RE.test(cleanId) || /[\r\n\t]/.test(cleanId)) {
        return jsonResponse({ error: "Invalid username/email or password" }, 400);
      }
    } else if (!USERNAME_RE.test(cleanId)) {
      return jsonResponse({ error: "Invalid username/email or password" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const clientIp = getClientIp(req);
    const { data: ipRl } = await adminClient.rpc("check_auth_rate_limit", {
      p_bucket: "username-login-ip",
      p_key: clientIp,
      p_max_attempts: 40,
      p_window_seconds: 900,
    });
    const ipLimit = Array.isArray(ipRl) ? ipRl[0] : ipRl;
    if (ipLimit && ipLimit.allowed === false) {
      const waitSec = Number(ipLimit.retry_after_seconds || 60);
      return jsonResponse(
        { error: `Too many login attempts. Try again in ${waitSec}s.` },
        429,
        { "Retry-After": String(waitSec) }
      );
    }

    const query = adminClient.from("users").select("id, email, is_active");
    const { data: userRow, error: lookupErr } = await (
      isEmail ? query.eq("email", cleanId) : query.eq("username", cleanId)
    ).maybeSingle();

    if (lookupErr || !userRow?.email) {
      return jsonResponse({ error: "Invalid username/email or password" }, 400);
    }

    const anonClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: signData, error: signErr } = await anonClient.auth.signInWithPassword({
      email: userRow.email,
      password: rawPassword,
    });

    if (signErr || !signData?.session) {
      return jsonResponse({ error: "Invalid username/email or password" }, 400);
    }

    if (!userRow.is_active) {
      await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${signData.session.access_token}`,
        },
      }).catch(() => {});

      return jsonResponse({ error: "Your account is inactive or lacks an assigned portal role." }, 403);
    }

    return jsonResponse({
      access_token: signData.session.access_token,
      refresh_token: signData.session.refresh_token,
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});

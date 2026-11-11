import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMAIL_RE = /^[^\s@%]+@[^\s@%]+\.[^\s@%]{2,}$/;

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

function canonicalPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 13 && digits.startsWith("091")) return digits.slice(3);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
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
    const rawIdentifier = String(body?.identifier ?? "").trim();
    if (!rawIdentifier || rawIdentifier.length > 160) {
      return jsonResponse({ error: "Enter your registered business phone number or email address." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const isEmail = rawIdentifier.includes("@");
    const cleanEmail = rawIdentifier.toLowerCase();
    const cleanPhone = canonicalPhone(rawIdentifier);

    if (isEmail) {
      if (!EMAIL_RE.test(cleanEmail) || /[\r\n\t]/.test(cleanEmail)) {
        return jsonResponse({ error: "Enter a valid business email address." }, 400);
      }
    } else if (cleanPhone.length < 7 || cleanPhone.length > 15) {
      return jsonResponse({ error: "Enter a valid phone number or email address." }, 400);
    }

    // Persistent IP and identifier rate limiting
    const clientIp = getClientIp(req);
    const { data: ipRl } = await adminClient.rpc("check_auth_rate_limit", {
      p_bucket: "customer-login-ip",
      p_key: clientIp,
      p_max_attempts: 40,
      p_window_seconds: 900,
    });
    const ipLimit = Array.isArray(ipRl) ? ipRl[0] : ipRl;
    if (ipLimit && ipLimit.allowed === false) {
      const waitSec = Number(ipLimit.retry_after_seconds || 60);
      return jsonResponse(
        { error: `Too many login attempts from this network. Try again in ${waitSec}s.` },
        429,
        { "Retry-After": String(waitSec) }
      );
    }

    const { data: idRl } = await adminClient.rpc("check_auth_rate_limit", {
      p_bucket: "customer-login-id",
      p_key: isEmail ? cleanEmail : cleanPhone,
      p_max_attempts: 15,
      p_window_seconds: 900,
    });
    const idLimit = Array.isArray(idRl) ? idRl[0] : idRl;
    if (idLimit && idLimit.allowed === false) {
      const waitSec = Number(idLimit.retry_after_seconds || 60);
      return jsonResponse(
        { error: `Too many login attempts for this identifier. Try again in ${waitSec}s.` },
        429,
        { "Retry-After": String(waitSec) }
      );
    }

    let matchedCustomer: {
      id: string;
      user_id: string | null;
      email: string;
      phone: string;
      status: string;
      business_name: string;
    } | null = null;

    if (isEmail) {
      const { data: row, error: lookupErr } = await adminClient
        .from("customers")
        .select("id, user_id, email, phone, status, business_name")
        .eq("email", cleanEmail)
        .maybeSingle();

      if (lookupErr) {
        return jsonResponse({ error: lookupErr.message }, 500);
      }
      matchedCustomer = row;
    } else {
      const { data: matches, error: listErr } = await adminClient.rpc("find_customers_by_canonical_phone", {
        p_phone: cleanPhone,
      });

      if (listErr) {
        return jsonResponse({ error: listErr.message }, 500);
      }

      const rows = (matches ?? []) as Array<{
        id: string;
        user_id: string | null;
        email: string;
        phone: string;
        status: string;
        business_name: string;
      }>;

      if (rows.length > 1) {
        const activeMatches = rows.filter((m) => m.status === "active");
        if (activeMatches.length === 1) {
          matchedCustomer = activeMatches[0];
        } else {
          return jsonResponse(
            {
              error:
                "Multiple customer accounts share that phone number. Please sign in using your registered email address.",
            },
            409
          );
        }
      } else {
        matchedCustomer = rows[0] ?? null;
      }
    }

    if (!matchedCustomer || !matchedCustomer.user_id) {
      return jsonResponse(
        { error: "No registered customer business found with that phone number or email." },
        404
      );
    }

    if (matchedCustomer.status === "pending") {
      return jsonResponse(
        {
          code: "PENDING_APPROVAL",
          error:
            "Your registration request is awaiting admin approval. You can enter the portal once the administrator grants access.",
        },
        403
      );
    }

    if (matchedCustomer.status !== "active") {
      return jsonResponse(
        {
          code: "ACCOUNT_DISABLED",
          error: "Your business account is currently inactive or disabled. Please contact the agency administrator.",
        },
        403
      );
    }

    const { data: userProfile, error: userErr } = await adminClient
      .from("users")
      .select("id, email, is_active, roles!inner(name)")
      .eq("id", matchedCustomer.user_id)
      .maybeSingle();

    const roleName = (userProfile?.roles as unknown as { name: string })?.name;
    if (userErr || !userProfile || !userProfile.is_active || roleName !== "customer") {
      return jsonResponse(
        { error: "Your customer portal account is inactive or unavailable. Please contact the agency administrator." },
        403
      );
    }

    const { data: linkData, error: linkErr } = await adminClient.auth.admin.generateLink({
      type: "magiclink",
      email: userProfile.email,
    });

    if (linkErr || !linkData?.properties?.hashed_token) {
      return jsonResponse({ error: linkErr?.message || "Failed to initiate customer session" }, 500);
    }

    const anonClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let { data: verifyData, error: verifyErr } = await anonClient.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "email",
    });

    if (verifyErr || !verifyData?.session) {
      const fallback = await anonClient.auth.verifyOtp({
        token_hash: linkData.properties.hashed_token,
        type: "magiclink",
      });
      verifyData = fallback.data;
      verifyErr = fallback.error;
    }

    if (verifyErr || !verifyData?.session) {
      return jsonResponse(
        { error: verifyErr?.message || "Could not verify customer session" },
        403
      );
    }

    return jsonResponse({
      access_token: verifyData.session.access_token,
      refresh_token: verifyData.session.refresh_token,
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});

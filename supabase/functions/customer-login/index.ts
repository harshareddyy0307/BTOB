import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function canonicalPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith("091")) return digits.slice(3);
  return digits;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const rawIdentifier = String(body?.identifier ?? "").trim();
    if (!rawIdentifier) {
      return jsonResponse({ error: "Enter your registered business phone number or email address." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const isEmail = rawIdentifier.includes("@");
    let matchedCustomer: {
      id: string;
      user_id: string | null;
      email: string;
      phone: string;
      status: string;
      business_name: string;
    } | null = null;

    if (isEmail) {
      const cleanEmail = rawIdentifier.toLowerCase();
      const { data: row, error: lookupErr } = await adminClient
        .from("customers")
        .select("id, user_id, email, phone, status, business_name")
        .ilike("email", cleanEmail)
        .maybeSingle();

      if (lookupErr) {
        return jsonResponse({ error: lookupErr.message }, 500);
      }
      matchedCustomer = row;
    } else {
      const cleanPhone = canonicalPhone(rawIdentifier);
      if (cleanPhone.length < 6) {
        return jsonResponse({ error: "Enter a valid phone number or email address." }, 400);
      }

      const { data: rows, error: listErr } = await adminClient
        .from("customers")
        .select("id, user_id, email, phone, status, business_name");

      if (listErr) {
        return jsonResponse({ error: listErr.message }, 500);
      }

      const matches = (rows ?? []).filter((r) => canonicalPhone(r.phone || "") === cleanPhone);
      if (matches.length > 1) {
        const activeMatches = matches.filter((m) => m.status === "active");
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
        matchedCustomer = matches[0] ?? null;
      }
    }

    if (!matchedCustomer || !matchedCustomer.user_id) {
      return jsonResponse(
        { error: "No registered customer business found with that phone number or email." },
        404
      );
    }

    if (matchedCustomer.status !== "active") {
      return jsonResponse(
        {
          error: `Your business account is currently ${matchedCustomer.status}. Please contact the agency administrator.`,
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

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { identifier, password } = await req.json();
    const cleanId = String(identifier ?? "").trim().toLowerCase();
    const rawPassword = String(password ?? "");

    if (!cleanId || !rawPassword) {
      return jsonResponse({ error: "Username/email and password are required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const query = adminClient.from("users").select("id, email, is_active");
    const { data: userRow, error: lookupErr } = await (
      cleanId.includes("@") ? query.ilike("email", cleanId) : query.ilike("username", cleanId)
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

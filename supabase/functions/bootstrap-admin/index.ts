import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMAIL_RE = /^[^\s@%]+@[^\s@%]+\.[^\s@%]{2,}$/;

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

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Match get_public_branding().has_admin — check active admin accounts only
    const { count, error: countErr } = await adminClient
      .from("users")
      .select("id, roles!inner(name)", { count: "exact", head: true })
      .eq("roles.name", "admin")
      .eq("is_active", true);

    if (countErr) {
      return jsonResponse({ error: countErr.message }, 500);
    }

    if ((count ?? 0) > 0) {
      return jsonResponse({ error: "Initial agency owner is already configured. Please sign in." }, 403);
    }

    const body = await req.json().catch(() => null);
    const full_name = String(body?.full_name ?? "").trim();
    const username = body?.username;
    const rawEmail = String(body?.email ?? "").trim().toLowerCase();
    const phone = String(body?.phone ?? "").trim();
    const password = String(body?.password ?? "");
    const agency_name = body?.agency_name;

    if (!full_name || full_name.length < 2 || !rawEmail || !password || password.length < 8) {
      return jsonResponse({ error: "Full name, valid email, and password (8+ chars) are required" }, 400);
    }

    if (rawEmail.length > 160 || !EMAIL_RE.test(rawEmail) || /[\r\n\t]/.test(rawEmail)) {
      return jsonResponse({ error: "Enter a valid email address" }, 400);
    }

    const cleanUsername = username ? String(username).trim().toLowerCase() : null;
    if (cleanUsername && !/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
      return jsonResponse(
        { error: "Username must be 3-32 characters using letters, numbers, '.', '_', or '-'" },
        400
      );
    }

    const { data: adminRole } = await adminClient
      .from("roles")
      .select("id")
      .eq("name", "admin")
      .single();

    if (!adminRole) {
      return jsonResponse({ error: "Admin role missing" }, 500);
    }

    const { data: authData, error: createErr } = await adminClient.auth.admin.createUser({
      email: rawEmail,
      password,
      email_confirm: true,
      app_metadata: { role: "admin" },
      user_metadata: { full_name },
    });

    if (createErr || !authData.user) {
      return jsonResponse({ error: createErr?.message || "Failed to create admin user" }, 400);
    }

    const { error: userErr } = await adminClient.from("users").insert({
      id: authData.user.id,
      role_id: adminRole.id,
      full_name,
      username: cleanUsername,
      email: rawEmail,
      phone: phone || null,
      is_active: true,
    });

    if (userErr) {
      await adminClient.auth.admin.deleteUser(authData.user.id);
      return jsonResponse({ error: userErr.message }, userErr.code === "23505" ? 409 : 400);
    }

    if (agency_name && String(agency_name).trim()) {
      await adminClient
        .from("agency_settings")
        .update({ agency_name: String(agency_name).trim(), email: rawEmail, phone })
        .eq("id", 1);
    }

    await adminClient.from("audit_logs").insert({
      actor_user_id: authData.user.id,
      action: "bootstrap_agency_owner",
      entity_type: "users",
      entity_id: authData.user.id,
      new_data: { full_name, email: rawEmail },
    });

    return jsonResponse({ success: true, user_id: authData.user.id }, 201);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});

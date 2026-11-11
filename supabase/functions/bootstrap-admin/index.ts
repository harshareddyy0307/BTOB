import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { count, error: countErr } = await adminClient
      .from("users")
      .select("id, roles!inner(name)", { count: "exact", head: true })
      .eq("roles.name", "admin");

    if (countErr) {
      return new Response(JSON.stringify({ error: countErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if ((count ?? 0) > 0) {
      return new Response(JSON.stringify({ error: "Initial agency owner is already configured. Please sign in." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { full_name, username, email, phone, password, agency_name } = await req.json();
    if (!full_name || !email || !password || String(password).length < 8) {
      return new Response(JSON.stringify({ error: "Full name, email, and password (8+ chars) are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cleanUsername = username ? String(username).trim().toLowerCase() : null;
    if (cleanUsername && !/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
      return new Response(
        JSON.stringify({ error: "Username must be 3-32 characters using letters, numbers, '.', '_', or '-'" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: adminRole } = await adminClient
      .from("roles")
      .select("id")
      .eq("name", "admin")
      .single();

    if (!adminRole) {
      return new Response(JSON.stringify({ error: "Admin role missing" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const { data: authData, error: createErr } = await adminClient.auth.admin.createUser({
      email: cleanEmail,
      password: String(password),
      email_confirm: true,
      app_metadata: { role: "admin" },
      user_metadata: { full_name },
    });

    if (createErr || !authData.user) {
      return new Response(JSON.stringify({ error: createErr?.message || "Failed to create admin user" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: userErr } = await adminClient.from("users").insert({
      id: authData.user.id,
      role_id: adminRole.id,
      full_name,
      username: cleanUsername,
      email: cleanEmail,
      phone: phone || null,
      is_active: true,
    });

    if (userErr) {
      await adminClient.auth.admin.deleteUser(authData.user.id);
      return new Response(JSON.stringify({ error: userErr.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (agency_name && String(agency_name).trim()) {
      await adminClient
        .from("agency_settings")
        .update({ agency_name: String(agency_name).trim(), email: cleanEmail, phone: phone || "" })
        .eq("id", 1);
    }

    await adminClient.from("audit_logs").insert({
      actor_user_id: authData.user.id,
      action: "bootstrap_agency_owner",
      entity_type: "users",
      entity_id: authData.user.id,
      new_data: { full_name, email: cleanEmail },
    });

    return new Response(JSON.stringify({ success: true, user_id: authData.user.id }), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

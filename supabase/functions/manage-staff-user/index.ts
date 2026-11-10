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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const {
      data: { user: caller },
      error: callerError,
    } = await callerClient.auth.getUser(token);

    if (callerError || !caller) {
      return new Response(JSON.stringify({ error: "Invalid session token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: callerProfile } = await adminClient
      .from("users")
      .select("id, is_active, roles!inner(name)")
      .eq("id", caller.id)
      .single();

    const callerRole = (callerProfile?.roles as unknown as { name: string })?.name;
    if (!callerProfile?.is_active || callerRole !== "admin") {
      return new Response(JSON.stringify({ error: "Forbidden: Agency Owner Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action } = body;

    if (action === "create_staff") {
      const { full_name, email, phone, password, role_name = "staff" } = body;
      if (!["admin", "staff"].includes(role_name)) {
        return new Response(JSON.stringify({ error: "Role must be admin or staff" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!full_name || !email || !password || String(password).length < 8) {
        return new Response(JSON.stringify({ error: "Name, email, and 8+ character password are required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: roleRow } = await adminClient.from("roles").select("id").eq("name", role_name).single();
      if (!roleRow) {
        return new Response(JSON.stringify({ error: "Role not found" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: authData, error: createErr } = await adminClient.auth.admin.createUser({
        email: String(email).trim().toLowerCase(),
        password: String(password),
        email_confirm: true,
        app_metadata: { role: role_name },
        user_metadata: { full_name },
      });

      if (createErr || !authData.user) {
        return new Response(JSON.stringify({ error: createErr?.message || "Failed to create staff auth user" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: newUser, error: insErr } = await adminClient
        .from("users")
        .insert({
          id: authData.user.id,
          role_id: roleRow.id,
          full_name,
          email: String(email).trim().toLowerCase(),
          phone: phone || null,
          is_active: true,
        })
        .select()
        .single();

      if (insErr) {
        await adminClient.auth.admin.deleteUser(authData.user.id);
        return new Response(JSON.stringify({ error: insErr.message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await adminClient.from("audit_logs").insert({
        actor_user_id: caller.id,
        action: "create_staff_account",
        entity_type: "users",
        entity_id: authData.user.id,
        new_data: { full_name, email, role_name },
      });

      return new Response(JSON.stringify({ user: newUser }), {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "toggle_user_status") {
      const { user_id, is_active } = body;
      if (!user_id || typeof is_active !== "boolean") {
        return new Response(JSON.stringify({ error: "user_id and is_active boolean required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (user_id === caller.id && !is_active) {
        return new Response(JSON.stringify({ error: "You cannot deactivate your own account" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await adminClient.from("users").update({ is_active }).eq("id", user_id);
      await adminClient.from("customers").update({ status: is_active ? "active" : "inactive" }).eq("user_id", user_id);
      await adminClient.auth.admin.updateUserById(user_id, {
        ban_duration: is_active ? "none" : "876000h",
      });

      await adminClient.from("audit_logs").insert({
        actor_user_id: caller.id,
        action: is_active ? "activate_user" : "deactivate_user",
        entity_type: "users",
        entity_id: user_id,
        new_data: { is_active },
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unsupported action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

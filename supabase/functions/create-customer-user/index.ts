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
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing bearer token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const {
      data: { user: caller },
      error: callerError,
    } = await callerClient.auth.getUser(token);

    if (callerError || !caller) {
      const msg =
        callerError?.code === "session_not_found" || callerError?.message?.toLowerCase().includes("session")
          ? "Session expired or signed out. Please sign in again."
          : callerError?.message || "Invalid session token";
      return new Response(JSON.stringify({ error: msg }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: callerProfile } = await adminClient
      .from("users")
      .select("id, is_active, roles!inner(name)")
      .eq("id", caller.id)
      .single();

    const callerRole = (callerProfile?.roles as unknown as { name: string })?.name;
    if (!callerProfile?.is_active || !["admin", "staff"].includes(callerRole)) {
      return new Response(JSON.stringify({ error: "Forbidden: Admin or Staff access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const {
      business_name,
      owner_name,
      phone,
      email,
      password,
      business_address,
      city,
      state,
      pincode,
      gst_number,
      business_category,
      status = "active",
    } = body;

    if (!business_name || !owner_name || !phone || !email || !business_address) {
      return new Response(JSON.stringify({ error: "Missing required customer fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rawPassword = typeof password === "string" ? password.trim() : "";
    if (rawPassword.length > 0 && rawPassword.length < 8) {
      return new Response(JSON.stringify({ error: "Password must be at least 8 characters when provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const generateInternalSecret = () => {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    };
    const effectivePassword = rawPassword.length >= 8 ? rawPassword : generateInternalSecret();

    if (!["active", "inactive", "suspended"].includes(status)) {
      return new Response(JSON.stringify({ error: "Status must be active, inactive, or suspended" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: customerRole, error: roleErr } = await adminClient
      .from("roles")
      .select("id")
      .eq("name", "customer")
      .single();

    if (roleErr || !customerRole) {
      return new Response(JSON.stringify({ error: "Customer role missing in database" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: authData, error: createAuthErr } = await adminClient.auth.admin.createUser({
      email: String(email).trim().toLowerCase(),
      password: effectivePassword,
      email_confirm: true,
      app_metadata: { role: "customer" },
      user_metadata: { full_name: owner_name },
    });

    if (createAuthErr || !authData.user) {
      return new Response(JSON.stringify({ error: createAuthErr?.message || "Failed to create auth user" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const newUserId = authData.user.id;

    if (status !== "active") {
      const { error: banErr } = await adminClient.auth.admin.updateUserById(newUserId, {
        ban_duration: "876000h",
      });
      if (banErr) {
        await adminClient.auth.admin.deleteUser(newUserId);
        return new Response(JSON.stringify({ error: banErr.message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { error: userInsertErr } = await adminClient.from("users").insert({
      id: newUserId,
      role_id: customerRole.id,
      full_name: owner_name,
      email: String(email).trim().toLowerCase(),
      phone,
      is_active: status === "active",
    });

    if (userInsertErr) {
      await adminClient.auth.admin.deleteUser(newUserId);
      return new Response(JSON.stringify({ error: userInsertErr.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: customer, error: custErr } = await adminClient
      .from("customers")
      .insert({
        user_id: newUserId,
        business_name,
        owner_name,
        phone,
        email: String(email).trim().toLowerCase(),
        business_address,
        city: city || null,
        state: state || "Telangana",
        pincode: pincode || null,
        gst_number: gst_number || null,
        business_category: business_category || null,
        status,
      })
      .select()
      .single();

    if (custErr || !customer) {
      await adminClient.from("users").delete().eq("id", newUserId);
      await adminClient.auth.admin.deleteUser(newUserId);
      return new Response(JSON.stringify({ error: custErr?.message || "Failed to create customer profile" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await adminClient.from("customer_addresses").insert({
      customer_id: customer.id,
      label: "Primary Business Address",
      contact_name: owner_name,
      contact_phone: phone,
      address_line: business_address,
      city: city || "Hyderabad",
      state: state || "Telangana",
      pincode: pincode || "500001",
      is_default: true,
    });

    await adminClient.from("audit_logs").insert({
      actor_user_id: caller.id,
      action: "create_customer_account",
      entity_type: "customers",
      entity_id: customer.id,
      new_data: { business_name, email, status },
    });

    return new Response(JSON.stringify({ customer, user_id: newUserId }), {
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

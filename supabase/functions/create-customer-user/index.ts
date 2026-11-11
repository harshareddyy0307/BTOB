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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization header" }, 401);
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
      return jsonResponse({ error: "Missing bearer token" }, 401);
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
      return jsonResponse({ error: msg }, 401);
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
      return jsonResponse({ error: "Forbidden: Admin or Staff access required" }, 403);
    }

    const body = await req.json().catch(() => null);
    const business_name = String(body?.business_name ?? "").trim();
    const owner_name = String(body?.owner_name ?? "").trim();
    const phone = String(body?.phone ?? "").trim();
    const email = String(body?.email ?? "").trim().toLowerCase();
    const rawPassword = typeof body?.password === "string" ? body.password.trim() : "";
    const business_address = String(body?.business_address ?? "").trim();
    const city = String(body?.city ?? "").trim();
    const state = String(body?.state ?? "").trim() || "Telangana";
    const pincode = String(body?.pincode ?? "").trim();
    const gst_number = String(body?.gst_number ?? "").trim().toUpperCase();
    const business_category = String(body?.business_category ?? "").trim();
    const status = String(body?.status ?? "active").trim().toLowerCase();

    if (!business_name || !owner_name || !phone || !email || !business_address) {
      return jsonResponse({ error: "Missing required customer fields" }, 400);
    }

    if (!EMAIL_RE.test(email) || email.length > 160 || /[\r\n\t]/.test(email)) {
      return jsonResponse({ error: "Enter a valid business email address" }, 400);
    }

    const cleanPhone = canonicalPhone(phone);
    if (cleanPhone.length < 7 || cleanPhone.length > 15) {
      return jsonResponse({ error: "Enter a valid phone number" }, 400);
    }

    if (rawPassword.length > 0 && rawPassword.length < 8) {
      return jsonResponse({ error: "Password must be at least 8 characters when provided" }, 400);
    }

    const generateInternalSecret = () => {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    };
    const effectivePassword = rawPassword.length >= 8 ? rawPassword : generateInternalSecret();

    if (!["active", "inactive", "suspended"].includes(status)) {
      return jsonResponse({ error: "Status must be active, inactive, or suspended" }, 400);
    }

    // Check duplicate email or canonical phone cleanly before creating auth user
    const [{ data: dupCustEmail }, { data: dupUserEmail }, { data: dupPhone }] = await Promise.all([
      adminClient.from("customers").select("id").eq("email", email).maybeSingle(),
      adminClient.from("users").select("id").eq("email", email).maybeSingle(),
      adminClient.rpc("find_customers_by_canonical_phone", { p_phone: cleanPhone }),
    ]);

    if (dupCustEmail || dupUserEmail) {
      return jsonResponse({ error: "A user or customer business with this email already exists." }, 409);
    }

    if (Array.isArray(dupPhone) && dupPhone.length > 0) {
      return jsonResponse({ error: "Another customer business already uses this phone number." }, 409);
    }

    const { data: customerRole, error: roleErr } = await adminClient
      .from("roles")
      .select("id")
      .eq("name", "customer")
      .single();

    if (roleErr || !customerRole) {
      return jsonResponse({ error: "Customer role missing in database" }, 500);
    }

    const { data: authData, error: createAuthErr } = await adminClient.auth.admin.createUser({
      email,
      password: effectivePassword,
      email_confirm: true,
      app_metadata: { role: "customer" },
      user_metadata: { full_name: owner_name },
    });

    if (createAuthErr || !authData.user) {
      return jsonResponse({ error: createAuthErr?.message || "Failed to create auth user" }, 400);
    }

    const newUserId = authData.user.id;

    if (status !== "active") {
      const { error: banErr } = await adminClient.auth.admin.updateUserById(newUserId, {
        ban_duration: "876000h",
      });
      if (banErr) {
        await adminClient.auth.admin.deleteUser(newUserId);
        return jsonResponse({ error: banErr.message }, 400);
      }
    }

    const { error: userInsertErr } = await adminClient.from("users").insert({
      id: newUserId,
      role_id: customerRole.id,
      full_name: owner_name,
      email,
      phone,
      is_active: status === "active",
    });

    if (userInsertErr) {
      await adminClient.auth.admin.deleteUser(newUserId);
      return jsonResponse({ error: userInsertErr.message }, userInsertErr.code === "23505" ? 409 : 400);
    }

    const { data: customer, error: custErr } = await adminClient
      .from("customers")
      .insert({
        user_id: newUserId,
        business_name,
        owner_name,
        phone,
        email,
        business_address,
        city: city || null,
        state,
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
      const code = custErr?.code === "23505" ? 409 : 400;
      return jsonResponse(
        {
          error:
            custErr?.code === "23505"
              ? "A customer business with this email or phone number already exists."
              : custErr?.message || "Failed to create customer profile",
        },
        code
      );
    }

    await adminClient.from("customer_addresses").insert({
      customer_id: customer.id,
      label: "Primary Business Address",
      contact_name: owner_name,
      contact_phone: phone,
      address_line: business_address,
      city: city || "Hyderabad",
      state,
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

    return jsonResponse({ customer, user_id: newUserId }, 201);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});

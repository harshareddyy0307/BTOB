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

function generateInternalSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json();

    const business_name = String(body?.business_name ?? "").trim();
    const owner_name = String(body?.owner_name ?? "").trim();
    const phone = String(body?.phone ?? "").trim();
    const email = String(body?.email ?? "").trim().toLowerCase();
    const business_address = String(body?.business_address ?? "").trim();
    const city = String(body?.city ?? "").trim();
    const state = String(body?.state ?? "").trim() || "Telangana";
    const pincode = String(body?.pincode ?? "").trim();
    const gst_number = String(body?.gst_number ?? "").trim().toUpperCase();
    const business_category = String(body?.business_category ?? "").trim();

    if (business_name.length < 2 || business_name.length > 120) {
      return jsonResponse({ error: "Enter a valid business name (2-120 characters)." }, 400);
    }
    if (owner_name.length < 2 || owner_name.length > 120) {
      return jsonResponse({ error: "Enter a valid owner or primary contact name (2-120 characters)." }, 400);
    }

    const cleanPhone = canonicalPhone(phone);
    if (cleanPhone.length < 7 || cleanPhone.length > 15) {
      return jsonResponse({ error: "Enter a valid phone number." }, 400);
    }

    if (!email || email.length > 160 || !EMAIL_RE.test(email)) {
      return jsonResponse({ error: "Enter a valid business email address." }, 400);
    }

    if (business_address.length < 5 || business_address.length > 300) {
      return jsonResponse({ error: "Enter a complete business address." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 1. Check duplicate customer email
    const { data: existingEmailCustomer, error: emailLookupErr } = await adminClient
      .from("customers")
      .select("id, status, business_name")
      .ilike("email", email)
      .maybeSingle();

    if (emailLookupErr) {
      return jsonResponse({ error: emailLookupErr.message }, 500);
    }

    if (existingEmailCustomer) {
      if (existingEmailCustomer.status === "pending") {
        return jsonResponse(
          { error: "A registration request for this email is already pending admin approval." },
          409
        );
      }
      if (existingEmailCustomer.status === "active") {
        return jsonResponse(
          { error: "An active business account already exists for this email. Please sign in to enter the portal." },
          409
        );
      }
      return jsonResponse(
        {
          error:
            "A business account with this email already exists and is currently disabled. Please contact the agency administrator.",
        },
        409
      );
    }

    // 2. Check existing user email (e.g. admin/staff)
    const { data: existingUserEmail, error: userLookupErr } = await adminClient
      .from("users")
      .select("id")
      .ilike("email", email)
      .maybeSingle();

    if (userLookupErr) {
      return jsonResponse({ error: userLookupErr.message }, 500);
    }
    if (existingUserEmail) {
      return jsonResponse(
        { error: "This email address is already registered. Please use another email or contact support." },
        409
      );
    }

    // 3. Check duplicate phone across customers
    const { data: existingCustomers, error: phoneLookupErr } = await adminClient
      .from("customers")
      .select("id, status, phone");

    if (phoneLookupErr) {
      return jsonResponse({ error: phoneLookupErr.message }, 500);
    }

    const phoneMatch = (existingCustomers ?? []).find((c) => canonicalPhone(c.phone || "") === cleanPhone);
    if (phoneMatch) {
      if (phoneMatch.status === "pending") {
        return jsonResponse(
          { error: "A registration request with this phone number is already pending admin approval." },
          409
        );
      }
      if (phoneMatch.status === "active") {
        return jsonResponse(
          {
            error:
              "An active business account already exists with this phone number. Please sign in to enter the portal.",
          },
          409
        );
      }
      return jsonResponse(
        {
          error:
            "A business account with this phone number already exists and is currently disabled. Please contact the agency administrator.",
        },
        409
      );
    }

    // 4. Resolve customer role
    const { data: customerRole, error: roleErr } = await adminClient
      .from("roles")
      .select("id")
      .eq("name", "customer")
      .single();

    if (roleErr || !customerRole) {
      return jsonResponse({ error: "Customer role missing in database" }, 500);
    }

    // 5. Create locked/inactive auth account + pending customer profile
    const { data: authData, error: createAuthErr } = await adminClient.auth.admin.createUser({
      email,
      password: generateInternalSecret(),
      email_confirm: true,
      app_metadata: { role: "customer" },
      user_metadata: { full_name: owner_name },
    });

    if (createAuthErr || !authData.user) {
      return jsonResponse({ error: createAuthErr?.message || "Failed to register account" }, 400);
    }

    const newUserId = authData.user.id;

    // Immediately ban until an administrator approves access
    const { error: banErr } = await adminClient.auth.admin.updateUserById(newUserId, {
      ban_duration: "876000h",
    });
    if (banErr) {
      await adminClient.auth.admin.deleteUser(newUserId);
      return jsonResponse({ error: banErr.message }, 400);
    }

    const { error: userInsertErr } = await adminClient.from("users").insert({
      id: newUserId,
      role_id: customerRole.id,
      full_name: owner_name,
      email,
      phone,
      is_active: false,
    });

    if (userInsertErr) {
      await adminClient.auth.admin.deleteUser(newUserId);
      return jsonResponse({ error: userInsertErr.message }, 400);
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
        status: "pending",
      })
      .select("id, business_name, owner_name, phone, email, status")
      .single();

    if (custErr || !customer) {
      await adminClient.from("users").delete().eq("id", newUserId);
      await adminClient.auth.admin.deleteUser(newUserId);
      return jsonResponse({ error: custErr?.message || "Failed to create pending business registration" }, 400);
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

    await adminClient.from("notifications").insert({
      recipient_role: "admin",
      title: "New Customer Registration Request",
      message: `${business_name} (${owner_name} • ${phone}) registered and is awaiting portal access approval.`,
      entity_type: "customer_registration",
      entity_id: customer.id,
    });

    await adminClient.from("audit_logs").insert({
      actor_user_id: newUserId,
      action: "customer_self_registered",
      entity_type: "customers",
      entity_id: customer.id,
      new_data: { business_name, owner_name, phone, email, status: "pending" },
    });

    return jsonResponse(
      {
        success: true,
        status: "pending",
        customer,
      },
      201
    );
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});

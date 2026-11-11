import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMAIL_RE = /^[^\s@%]+@[^\s@%]+\.[^\s@%]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      return jsonResponse({ error: "Forbidden: Agency Admin or Staff access required" }, 403);
    }

    const body = await req.json().catch(() => null);
    const action = body?.action;

    if (action === "create_staff") {
      if (callerRole !== "admin") {
        return jsonResponse({ error: "Forbidden: Agency Owner Admin access required" }, 403);
      }

      const full_name = String(body?.full_name ?? "").trim();
      const email = String(body?.email ?? "").trim().toLowerCase();
      const phone = String(body?.phone ?? "").trim();
      const password = String(body?.password ?? "");
      const role_name = String(body?.role_name ?? "staff").trim().toLowerCase();

      if (!["admin", "staff"].includes(role_name)) {
        return jsonResponse({ error: "Role must be admin or staff" }, 400);
      }
      if (full_name.length < 2 || !email || !password || password.length < 8) {
        return jsonResponse({ error: "Name (2+ chars), valid email, and 8+ character password are required" }, 400);
      }
      if (email.length > 160 || !EMAIL_RE.test(email) || /[\r\n\t]/.test(email)) {
        return jsonResponse({ error: "Enter a valid email address" }, 400);
      }

      const { data: dupEmail } = await adminClient
        .from("users")
        .select("id")
        .eq("email", email)
        .maybeSingle();

      if (dupEmail) {
        return jsonResponse({ error: "An account with this email already exists." }, 409);
      }

      const { data: roleRow } = await adminClient.from("roles").select("id").eq("name", role_name).single();
      if (!roleRow) {
        return jsonResponse({ error: "Role not found" }, 400);
      }

      const { data: authData, error: createErr } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { role: role_name },
        user_metadata: { full_name },
      });

      if (createErr || !authData.user) {
        return jsonResponse({ error: createErr?.message || "Failed to create staff auth user" }, 400);
      }

      const { data: newUser, error: insErr } = await adminClient
        .from("users")
        .insert({
          id: authData.user.id,
          role_id: roleRow.id,
          full_name,
          email,
          phone: phone || null,
          is_active: true,
        })
        .select()
        .single();

      if (insErr) {
        await adminClient.auth.admin.deleteUser(authData.user.id);
        return jsonResponse({ error: insErr.message }, insErr.code === "23505" ? 409 : 400);
      }

      await adminClient.from("audit_logs").insert({
        actor_user_id: caller.id,
        action: "create_staff_account",
        entity_type: "users",
        entity_id: authData.user.id,
        new_data: { full_name, email, role_name },
      });

      return jsonResponse({ user: newUser }, 201);
    }

    if (action === "toggle_user_status") {
      const targetUserId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
      const is_active = body?.is_active;
      const requestedCustomerStatus =
        typeof body?.customer_status === "string" ? body.customer_status.trim().toLowerCase() : undefined;

      if (!UUID_RE.test(targetUserId) || typeof is_active !== "boolean") {
        return jsonResponse({ error: "Valid user_id (UUID) and is_active boolean required" }, 400);
      }

      if (
        requestedCustomerStatus !== undefined &&
        !["pending", "active", "inactive", "suspended"].includes(requestedCustomerStatus)
      ) {
        return jsonResponse({ error: "customer_status must be pending, active, inactive, or suspended" }, 400);
      }

      if (requestedCustomerStatus !== undefined) {
        if (is_active && requestedCustomerStatus !== "active") {
          return jsonResponse({ error: "customer_status must be active when is_active is true" }, 400);
        }
        if (!is_active && requestedCustomerStatus === "active") {
          return jsonResponse({ error: "customer_status cannot be active when is_active is false" }, 400);
        }
      }

      const { data: targetProfile, error: targetLookupErr } = await adminClient
        .from("users")
        .select("id, is_active, roles!inner(name)")
        .eq("id", targetUserId)
        .maybeSingle();

      if (targetLookupErr) {
        return jsonResponse({ error: targetLookupErr.message }, 500);
      }

      if (!targetProfile) {
        return jsonResponse({ error: "Target user account not found" }, 404);
      }

      const targetRole = (targetProfile.roles as unknown as { name: string })?.name;
      if (callerRole === "staff" && targetRole !== "customer") {
        return jsonResponse(
          { error: "Forbidden: Only Agency Owner Admin can activate or deactivate staff/admin accounts" },
          403
        );
      }

      if (targetUserId === caller.id && !is_active) {
        return jsonResponse({ error: "You cannot deactivate your own account" }, 400);
      }

      if (targetRole === "admin" && targetProfile.is_active && !is_active) {
        const { count: activeAdmins } = await adminClient
          .from("users")
          .select("id, roles!inner(name)", { count: "exact", head: true })
          .eq("roles.name", "admin")
          .eq("is_active", true);

        if ((activeAdmins ?? 0) <= 1) {
          return jsonResponse({ error: "Cannot deactivate the last active Agency Owner Admin account." }, 400);
        }
      }

      let existingCustomerId: string | null = null;
      let existingCustomerName: string | null = null;
      let prevCustomerStatus: string | null = null;
      if (targetRole === "customer") {
        const { data: existingCustomer, error: custLookupErr } = await adminClient
          .from("customers")
          .select("id, business_name, status")
          .eq("user_id", targetUserId)
          .maybeSingle();

        if (custLookupErr) {
          return jsonResponse({ error: custLookupErr.message }, 500);
        }
        existingCustomerId = existingCustomer?.id ?? null;
        existingCustomerName = existingCustomer?.business_name ?? null;
        prevCustomerStatus = existingCustomer?.status ?? null;
      }

      const resolvedCustomerStatus = is_active
        ? "active"
        : requestedCustomerStatus === "suspended"
          ? "suspended"
          : requestedCustomerStatus === "pending"
            ? "pending"
            : "inactive";

      const { error: userUpdateErr } = await adminClient
        .from("users")
        .update({ is_active })
        .eq("id", targetUserId);

      if (userUpdateErr) {
        return jsonResponse({ error: userUpdateErr.message }, 400);
      }

      if (targetRole === "customer") {
        const { data: updatedCustRows, error: custUpdateErr } = await adminClient
          .from("customers")
          .update({ status: resolvedCustomerStatus })
          .eq("user_id", targetUserId)
          .select("id, status");

        if (custUpdateErr || !updatedCustRows || updatedCustRows.length === 0) {
          await adminClient.from("users").update({ is_active: targetProfile.is_active }).eq("id", targetUserId);
          return jsonResponse(
            { error: custUpdateErr?.message || "Matching customer profile was not updated" },
            400
          );
        }
      }

      const { error: authUpdateErr } = await adminClient.auth.admin.updateUserById(targetUserId, {
        ban_duration: is_active ? "none" : "876000h",
      });

      if (authUpdateErr) {
        await adminClient.from("users").update({ is_active: targetProfile.is_active }).eq("id", targetUserId);
        if (targetRole === "customer" && prevCustomerStatus) {
          await adminClient
            .from("customers")
            .update({ status: prevCustomerStatus })
            .eq("user_id", targetUserId);
        }
        return jsonResponse({ error: authUpdateErr.message }, 400);
      }

      const isPendingResolution = targetRole === "customer" && prevCustomerStatus === "pending";
      const actionName =
        targetRole === "customer"
          ? isPendingResolution
            ? is_active
              ? "approve_customer_registration"
              : "decline_customer_registration"
            : is_active
              ? "activate_customer"
              : "deactivate_customer"
          : is_active
            ? "activate_user"
            : "deactivate_user";

      if (isPendingResolution && existingCustomerId) {
        await adminClient
          .from("notifications")
          .update({ is_read: true })
          .eq("entity_type", "customer_registration")
          .eq("entity_id", existingCustomerId);

        if (is_active) {
          await adminClient.from("notifications").insert({
            recipient_role: "customer",
            recipient_user_id: targetUserId,
            title: "Portal Access Approved",
            message: `Access granted for ${existingCustomerName || "your business"}. Welcome to the Customer Portal!`,
            entity_type: "customer_registration",
            entity_id: existingCustomerId,
          });
        }
      }

      await adminClient.from("audit_logs").insert({
        actor_user_id: caller.id,
        action: actionName,
        entity_type: targetRole === "customer" ? "customers" : "users",
        entity_id: existingCustomerId || targetUserId,
        old_data: {
          is_active: targetProfile.is_active,
          ...(prevCustomerStatus ? { customer_status: prevCustomerStatus } : {}),
        },
        new_data: {
          is_active,
          ...(targetRole === "customer" ? { customer_status: resolvedCustomerStatus } : {}),
        },
      });

      return jsonResponse({
        success: true,
        user_id: targetUserId,
        is_active,
        customer_status: targetRole === "customer" ? resolvedCustomerStatus : null,
      });
    }

    return jsonResponse({ error: "Unsupported action" }, 400);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});

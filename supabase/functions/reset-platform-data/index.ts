import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const PIN_REGEX = /^\d{4}$/;
const REQUIRED_CONFIRMATION_PHRASE = "RESET ALL DATA";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function hashPin(pin: string, userId: string, saltHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${pin}:${userId}`),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(saltHex),
      iterations: 100_000,
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function listAllBucketFilePaths(adminClient: SupabaseClient, bucket: string): Promise<string[]> {
  const filePaths: string[] = [];
  const queue: string[] = [""];

  while (queue.length > 0) {
    const prefix = queue.shift()!;
    let offset = 0;
    const limit = 1000;

    while (true) {
      const { data, error } = await adminClient.storage.from(bucket).list(prefix, {
        limit,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error || !data || data.length === 0) {
        break;
      }

      for (const item of data) {
        if (!item.name || item.name === ".emptyFolderPlaceholder") continue;
        const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id === null) {
          queue.push(fullPath);
        } else {
          filePaths.push(fullPath);
        }
      }

      if (data.length < limit) {
        break;
      }
      offset += limit;
    }
  }

  return filePaths;
}

async function emptyBucketCompletely(
  adminClient: SupabaseClient,
  bucket: string
): Promise<{ removedCount: number; error?: string }> {
  const existingBefore = await listAllBucketFilePaths(adminClient, bucket);
  const { error: emptyErr } = await adminClient.storage.emptyBucket(bucket);

  // Verify bucket is genuinely empty; fallback to batch remove if anything remains
  const remaining = await listAllBucketFilePaths(adminClient, bucket);
  if (remaining.length > 0) {
    for (let i = 0; i < remaining.length; i += 100) {
      const chunk = remaining.slice(i, i + 100);
      const { error: remErr } = await adminClient.storage.from(bucket).remove(chunk);
      if (remErr) {
        return {
          removedCount: Math.max(0, existingBefore.length - remaining.length),
          error: remErr.message || emptyErr?.message || `Failed removing files from ${bucket}`,
        };
      }
    }
    const afterRemove = await listAllBucketFilePaths(adminClient, bucket);
    if (afterRemove.length > 0) {
      return {
        removedCount: Math.max(0, existingBefore.length - afterRemove.length),
        error: `${afterRemove.length} file(s) could not be removed from ${bucket}`,
      };
    }
  } else if (emptyErr && existingBefore.length > 0) {
    return { removedCount: 0, error: emptyErr.message };
  }

  return { removedCount: existingBefore.length };
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

    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return jsonResponse({ error: "Missing bearer token" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authHeader } },
    });

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
      .select("id, full_name, email, is_active, roles!inner(name)")
      .eq("id", caller.id)
      .single();

    const callerRole = (callerProfile?.roles as unknown as { name: string })?.name;
    if (!callerProfile?.is_active || callerRole !== "admin") {
      return jsonResponse({ error: "Forbidden: Agency Owner Admin access required" }, 403);
    }

    const body = await req.json().catch(() => null);
    const action = typeof body?.action === "string" ? body.action.trim() : "";

    if (action === "summary") {
      const [
        customersRes,
        manufacturersRes,
        categoriesRes,
        productsRes,
        ordersRes,
        posRes,
        invoicesRes,
        paymentsRes,
        notificationsRes,
        auditLogsRes,
        staffRes,
        pinRes,
      ] = await Promise.all([
        adminClient.from("customers").select("id", { count: "exact", head: true }),
        adminClient.from("manufacturers").select("id", { count: "exact", head: true }),
        adminClient.from("categories").select("id", { count: "exact", head: true }),
        adminClient.from("products").select("id", { count: "exact", head: true }),
        adminClient.from("orders").select("id", { count: "exact", head: true }),
        adminClient.from("purchase_orders").select("id", { count: "exact", head: true }),
        adminClient.from("invoices").select("id", { count: "exact", head: true }),
        adminClient.from("payments").select("id", { count: "exact", head: true }),
        adminClient.from("notifications").select("id", { count: "exact", head: true }),
        adminClient.from("audit_logs").select("id", { count: "exact", head: true }),
        adminClient
          .from("users")
          .select("id, roles!inner(name)", { count: "exact", head: true })
          .in("roles.name", ["admin", "staff"])
          .neq("id", caller.id),
        adminClient
          .from("admin_security_pins")
          .select("failed_attempts, locked_until")
          .eq("user_id", caller.id)
          .maybeSingle(),
      ]);

      const pinRow = pinRes.data;
      const lockedUntilMs = pinRow?.locked_until ? new Date(pinRow.locked_until).getTime() : 0;
      const isPinLocked = lockedUntilMs > Date.now();

      return jsonResponse({
        has_pin: Boolean(pinRow),
        is_pin_locked: isPinLocked,
        pin_locked_until: isPinLocked ? pinRow?.locked_until : null,
        counts: {
          customers: customersRes.count ?? 0,
          manufacturers: manufacturersRes.count ?? 0,
          categories: categoriesRes.count ?? 0,
          products: productsRes.count ?? 0,
          orders: ordersRes.count ?? 0,
          purchase_orders: posRes.count ?? 0,
          invoices: invoicesRes.count ?? 0,
          payments: paymentsRes.count ?? 0,
          notifications: notificationsRes.count ?? 0,
          audit_logs: auditLogsRes.count ?? 0,
          other_staff_users: staffRes.count ?? 0,
        },
      });
    }

    if (action === "reset_all_data") {
      const confirmationPhrase = String(body?.confirmation_phrase ?? "").trim().toUpperCase();
      const currentPassword = String(body?.current_password ?? "");
      const pin = String(body?.pin ?? "").trim();
      const resetAgencySettings = Boolean(body?.reset_agency_settings);
      const deleteStaff = Boolean(body?.delete_staff);

      if (confirmationPhrase !== REQUIRED_CONFIRMATION_PHRASE) {
        return jsonResponse(
          { error: `Type "${REQUIRED_CONFIRMATION_PHRASE}" exactly to confirm permanent deletion.` },
          400
        );
      }

      if (!currentPassword) {
        return jsonResponse({ error: "Your current Agency Owner password is required to authorize reset." }, 400);
      }

      // Check password/reset attempt rate limit before validating credentials
      const { data: rateRows } = await adminClient.rpc("check_auth_rate_limit", {
        p_bucket: "reset_platform_data",
        p_key: caller.id,
        p_max_attempts: 8,
        p_window_seconds: 900,
      });
      const rateResult = Array.isArray(rateRows) ? rateRows[0] : rateRows;
      if (rateResult && rateResult.allowed === false) {
        const mins = Math.max(1, Math.ceil((rateResult.retry_after_seconds || 60) / 60));
        return jsonResponse(
          { error: `Too many failed reset attempts. Please wait about ${mins} minute(s) and try again.` },
          429
        );
      }

      // Verify 4-digit Security PIN if configured for this owner account
      const { data: pinRow } = await adminClient
        .from("admin_security_pins")
        .select("pin_hash, pin_salt, failed_attempts, locked_until")
        .eq("user_id", caller.id)
        .maybeSingle();

      if (pinRow) {
        const lockedUntilMs = pinRow.locked_until ? new Date(pinRow.locked_until).getTime() : 0;
        if (lockedUntilMs > Date.now()) {
          const minsLeft = Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 60_000));
          return jsonResponse(
            { error: `4-digit PIN is temporarily locked for ${minsLeft} minute(s).` },
            429
          );
        }

        if (!PIN_REGEX.test(pin)) {
          return jsonResponse({ error: "Enter your active 4-digit Security PIN to authorize full reset." }, 400);
        }

        const computedHash = await hashPin(pin, caller.id, pinRow.pin_salt);
        const effectiveFailedAttempts =
          pinRow.locked_until && lockedUntilMs <= Date.now() ? 0 : (pinRow.failed_attempts ?? 0);

        if (!timingSafeEqualHex(computedHash, pinRow.pin_hash)) {
          const nextAttempts = effectiveFailedAttempts + 1;
          const shouldLock = nextAttempts >= MAX_PIN_ATTEMPTS;
          await adminClient
            .from("admin_security_pins")
            .update({
              failed_attempts: nextAttempts,
              locked_until: shouldLock ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString() : null,
            })
            .eq("user_id", caller.id);

          await adminClient.from("audit_logs").insert({
            actor_user_id: caller.id,
            action: "failed_reset_pin_verification",
            entity_type: "system",
            entity_id: "all",
            new_data: { attempts: nextAttempts, locked: shouldLock },
          });

          return jsonResponse(
            {
              error: shouldLock
                ? `Incorrect 4-digit PIN. Too many failed attempts — locked for ${PIN_LOCK_MINUTES} minutes.`
                : `Incorrect 4-digit PIN. ${MAX_PIN_ATTEMPTS - nextAttempts} attempt(s) remaining.`,
            },
            403
          );
        }

        if (pinRow.failed_attempts > 0 || pinRow.locked_until) {
          await adminClient
            .from("admin_security_pins")
            .update({ failed_attempts: 0, locked_until: null })
            .eq("user_id", caller.id);
        }
      }

      // Verify current login password using an isolated non-persisted Supabase auth client
      const verifyClient = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const authEmail = caller.email || callerProfile.email;
      const { data: verifyData, error: verifyErr } = await verifyClient.auth.signInWithPassword({
        email: authEmail,
        password: currentPassword,
      });

      if (verifyErr || !verifyData?.user || verifyData.user.id !== caller.id) {
        await adminClient.from("audit_logs").insert({
          actor_user_id: caller.id,
          action: "failed_reset_password_verification",
          entity_type: "system",
          entity_id: "all",
        });
        return jsonResponse({ error: "Current Agency Owner password is incorrect." }, 403);
      }

      if (verifyData.session?.access_token) {
        await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
          method: "POST",
          headers: {
            apikey: anonKey,
            Authorization: `Bearer ${verifyData.session.access_token}`,
          },
        }).catch(() => {});
      }

      // 1. Atomic PostgreSQL data wipe + sequence reset
      const { data: rpcData, error: rpcErr } = await adminClient.rpc("reset_all_platform_data", {
        p_caller_id: caller.id,
        p_reset_agency_settings: resetAgencySettings,
        p_delete_staff: deleteStaff,
      });

      if (rpcErr || !rpcData) {
        return jsonResponse(
          { error: rpcErr?.message || "Failed to execute atomic database reset" },
          500
        );
      }

      const warnings: string[] = [];

      // 2. Delete customer (and optionally staff) accounts from Supabase Auth (auth.users)
      const { data: survivingUsers } = await adminClient.from("users").select("id");
      const survivingIds = new Set<string>([
        caller.id,
        ...((survivingUsers ?? []).map((u) => String(u.id))),
      ]);

      const authDeleteTargets = new Set<string>(
        Array.isArray(rpcData.deleted_auth_user_ids)
          ? (rpcData.deleted_auth_user_ids as unknown[])
              .map((id) => String(id))
              .filter((id) => id && id !== caller.id && !survivingIds.has(id))
          : []
      );

      // Scan auth.users in pages to sweep any leftover customer/orphaned auth accounts too
      let page = 1;
      while (true) {
        const { data: pageData, error: listErr } = await adminClient.auth.admin.listUsers({
          page,
          perPage: 1000,
        });
        if (listErr || !pageData?.users || pageData.users.length === 0) {
          if (listErr) warnings.push(`Auth user list warning: ${listErr.message}`);
          break;
        }
        for (const authUser of pageData.users) {
          if (authUser.id !== caller.id && !survivingIds.has(authUser.id)) {
            authDeleteTargets.add(authUser.id);
          }
        }
        if (pageData.users.length < 1000) break;
        page += 1;
      }

      let deletedAuthUsers = 0;
      for (const uid of authDeleteTargets) {
        const { error: delAuthErr } = await adminClient.auth.admin.deleteUser(uid);
        if (delAuthErr) {
          warnings.push(`Auth user ${uid}: ${delAuthErr.message}`);
        } else {
          deletedAuthUsers += 1;
        }
      }

      // 3. Empty Storage buckets so uploaded product images / PO PDFs (& optionally logo) are deleted
      const bucketsToEmpty = resetAgencySettings
        ? ["product-images", "manufacturer-assets", "brand-assets"]
        : ["product-images", "manufacturer-assets"];

      const storageRemoved: Record<string, number> = {};
      for (const bucket of bucketsToEmpty) {
        const res = await emptyBucketCompletely(adminClient, bucket);
        storageRemoved[bucket] = res.removedCount;
        if (res.error) {
          warnings.push(`Storage ${bucket}: ${res.error}`);
        }
      }

      return jsonResponse({
        success: true,
        deleted_counts: rpcData.deleted_counts ?? {},
        deleted_auth_users: deletedAuthUsers,
        storage_removed: storageRemoved,
        reset_agency_settings: resetAgencySettings,
        deleted_staff: deleteStaff,
        warnings,
      });
    }

    return jsonResponse({ error: "Unsupported action" }, 400);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;
const PIN_REGEX = /^\d{4}$/;
const EMAIL_REGEX = /^[^\s@%]+@[^\s@%]+\.[^\s@%]{2,}$/;

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
      .select("id, full_name, username, email, phone, is_active, roles!inner(name)")
      .eq("id", caller.id)
      .single();

    const callerRole = (callerProfile?.roles as unknown as { name: string })?.name;
    if (!callerProfile?.is_active || callerRole !== "admin") {
      return jsonResponse({ error: "Forbidden: Agency Owner Admin access required" }, 403);
    }

    const body = await req.json();
    const { action } = body;

    if (action === "status") {
      const { data: pinRow } = await adminClient
        .from("admin_security_pins")
        .select("failed_attempts, locked_until, updated_at")
        .eq("user_id", caller.id)
        .maybeSingle();

      const lockedUntilMs = pinRow?.locked_until ? new Date(pinRow.locked_until).getTime() : 0;
      const isLocked = lockedUntilMs > Date.now();

      return jsonResponse({
        has_pin: Boolean(pinRow),
        is_locked: isLocked,
        locked_until: isLocked ? pinRow?.locked_until : null,
        remaining_attempts: pinRow ? Math.max(0, MAX_PIN_ATTEMPTS - (isLocked ? MAX_PIN_ATTEMPTS : pinRow.failed_attempts)) : MAX_PIN_ATTEMPTS,
        pin_updated_at: pinRow?.updated_at ?? null,
        profile: {
          id: callerProfile.id,
          full_name: callerProfile.full_name,
          username: callerProfile.username ?? null,
          email: callerProfile.email,
          phone: callerProfile.phone ?? null,
        },
      });
    }

    if (action === "set_pin") {
      const currentPassword = String(body.current_password ?? "");
      const newPin = String(body.new_pin ?? "").trim();

      if (!currentPassword) {
        return jsonResponse({ error: "Current login password is required to set or reset your 4-digit PIN." }, 400);
      }

      if (!PIN_REGEX.test(newPin)) {
        return jsonResponse({ error: "Security PIN must be exactly 4 numeric digits (0-9)." }, 400);
      }

      const verifyClient = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data: verifyData, error: verifyErr } = await verifyClient.auth.signInWithPassword({
        email: callerProfile.email,
        password: currentPassword,
      });

      if (verifyErr || !verifyData?.user || verifyData.user.id !== caller.id) {
        return jsonResponse({ error: "Current login password is incorrect." }, 403);
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

      const { data: existingPin } = await adminClient
        .from("admin_security_pins")
        .select("user_id")
        .eq("user_id", caller.id)
        .maybeSingle();

      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      const saltHex = bytesToHex(saltBytes);
      const pinHash = await hashPin(newPin, caller.id, saltHex);

      const { error: upsertErr } = await adminClient
        .from("admin_security_pins")
        .upsert({
          user_id: caller.id,
          pin_hash: pinHash,
          pin_salt: saltHex,
          failed_attempts: 0,
          locked_until: null,
        });

      if (upsertErr) {
        return jsonResponse({ error: upsertErr.message }, 500);
      }

      await adminClient.from("audit_logs").insert({
        actor_user_id: caller.id,
        action: existingPin ? "reset_admin_security_pin" : "set_admin_security_pin",
        entity_type: "users",
        entity_id: caller.id,
        new_data: { pin_configured: true },
      });

      return jsonResponse({ success: true, has_pin: true });
    }

    if (action === "remove_pin") {
      const currentPassword = String(body.current_password ?? "");
      const pin = String(body.pin ?? "").trim();

      if (!currentPassword || !PIN_REGEX.test(pin)) {
        return jsonResponse({ error: "Both current password and current 4-digit PIN are required to clear your PIN." }, 400);
      }

      const { data: pinRow } = await adminClient
        .from("admin_security_pins")
        .select("pin_hash, pin_salt, failed_attempts, locked_until")
        .eq("user_id", caller.id)
        .maybeSingle();

      if (!pinRow) {
        return jsonResponse({ error: "No 4-digit Security PIN is currently configured." }, 400);
      }

      const lockedUntilMs = pinRow.locked_until ? new Date(pinRow.locked_until).getTime() : 0;
      if (lockedUntilMs > Date.now()) {
        const minsLeft = Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 60_000));
        return jsonResponse({ error: `PIN temporarily locked for ${minsLeft} minute(s). Use Reset PIN with your password instead.` }, 429);
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
        return jsonResponse(
          {
            error: shouldLock
              ? `Incorrect 4-digit PIN. Locked for ${PIN_LOCK_MINUTES} minutes.`
              : `Incorrect 4-digit PIN. ${MAX_PIN_ATTEMPTS - nextAttempts} attempt(s) remaining.`,
          },
          403
        );
      }

      const verifyClient = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: verifyData, error: verifyErr } = await verifyClient.auth.signInWithPassword({
        email: callerProfile.email,
        password: currentPassword,
      });
      if (verifyErr || !verifyData?.user || verifyData.user.id !== caller.id) {
        return jsonResponse({ error: "Current login password is incorrect." }, 403);
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

      const { error: delErr } = await adminClient
        .from("admin_security_pins")
        .delete()
        .eq("user_id", caller.id);

      if (delErr) {
        return jsonResponse({ error: delErr.message }, 500);
      }

      await adminClient.from("audit_logs").insert({
        actor_user_id: caller.id,
        action: "remove_admin_security_pin",
        entity_type: "users",
        entity_id: caller.id,
        new_data: { pin_configured: false },
      });

      return jsonResponse({ success: true, has_pin: false });
    }

    if (action === "update_credentials") {
      const pin = String(body.pin ?? "").trim();
      if (!PIN_REGEX.test(pin)) {
        return jsonResponse({ error: "Enter your 4-digit Security PIN to authorize credential changes." }, 400);
      }

      const { data: pinRow } = await adminClient
        .from("admin_security_pins")
        .select("pin_hash, pin_salt, failed_attempts, locked_until")
        .eq("user_id", caller.id)
        .maybeSingle();

      if (!pinRow) {
        return jsonResponse({ error: "Set a 4-digit Security PIN first before changing admin credentials." }, 400);
      }

      const lockedUntilMs = pinRow.locked_until ? new Date(pinRow.locked_until).getTime() : 0;
      if (lockedUntilMs > Date.now()) {
        const minsLeft = Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 60_000));
        return jsonResponse(
          {
            error: `PIN verification temporarily locked for ${minsLeft} minute(s) due to failed attempts. You can reset your PIN below using your current login password.`,
          },
          429
        );
      }

      const computedHash = await hashPin(pin, caller.id, pinRow.pin_salt);
      const effectiveFailedAttempts =
        pinRow.locked_until && lockedUntilMs <= Date.now() ? 0 : (pinRow.failed_attempts ?? 0);

      if (!timingSafeEqualHex(computedHash, pinRow.pin_hash)) {
        const nextAttempts = effectiveFailedAttempts + 1;
        const shouldLock = nextAttempts >= MAX_PIN_ATTEMPTS;
        const nextLockedUntil = shouldLock ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString() : null;

        await adminClient
          .from("admin_security_pins")
          .update({
            failed_attempts: nextAttempts,
            locked_until: nextLockedUntil,
          })
          .eq("user_id", caller.id);

        await adminClient.from("audit_logs").insert({
          actor_user_id: caller.id,
          action: "failed_admin_pin_verification",
          entity_type: "users",
          entity_id: caller.id,
          new_data: { attempts: nextAttempts, locked: shouldLock },
        });

        return jsonResponse(
          {
            error: shouldLock
              ? `Incorrect 4-digit PIN. Too many failed attempts — locked for ${PIN_LOCK_MINUTES} minutes. Use your current password to reset the PIN.`
              : `Incorrect 4-digit PIN. ${MAX_PIN_ATTEMPTS - nextAttempts} attempt(s) remaining.`,
          },
          403
        );
      }

      // Reset failed attempt counter on valid PIN
      if (pinRow.failed_attempts > 0 || pinRow.locked_until) {
        await adminClient
          .from("admin_security_pins")
          .update({ failed_attempts: 0, locked_until: null })
          .eq("user_id", caller.id);
      }

      const nextFullName =
        body.full_name !== undefined ? String(body.full_name).trim() : callerProfile.full_name;
      if (!nextFullName || nextFullName.length < 2) {
        return jsonResponse({ error: "Display name must be at least 2 characters." }, 400);
      }

      const nextEmail =
        body.email !== undefined ? String(body.email).trim().toLowerCase() : callerProfile.email;
      if (!EMAIL_REGEX.test(nextEmail)) {
        return jsonResponse({ error: "Enter a valid email address." }, 400);
      }

      let nextUsername: string | null = callerProfile.username ?? null;
      if (body.username !== undefined) {
        const trimmedUsername = String(body.username).trim().toLowerCase();
        if (trimmedUsername.length === 0) {
          nextUsername = null;
        } else if (!USERNAME_REGEX.test(trimmedUsername)) {
          return jsonResponse(
            { error: "Username must be 3-32 characters using lowercase letters, numbers, '.', '_', or '-'." },
            400
          );
        } else {
          nextUsername = trimmedUsername;
        }
      }

      const newPassword = body.new_password !== undefined ? String(body.new_password) : "";
      if (newPassword.length > 0 && newPassword.length < 8) {
        return jsonResponse({ error: "New password must be at least 8 characters." }, 400);
      }

      const usernameChanged = nextUsername !== (callerProfile.username ?? null);
      const emailChanged = nextEmail !== callerProfile.email;
      const nameChanged = nextFullName !== callerProfile.full_name;
      const passwordChanged = newPassword.length > 0;

      if (!usernameChanged && !emailChanged && !nameChanged && !passwordChanged) {
        return jsonResponse({ error: "No changes to save." }, 400);
      }

      if (nextUsername) {
        const { data: dupUser } = await adminClient
          .from("users")
          .select("id")
          .eq("username", nextUsername)
          .neq("id", caller.id)
          .maybeSingle();

        if (dupUser) {
          return jsonResponse({ error: "That username is already in use by another account." }, 409);
        }
      }

      if (emailChanged) {
        const { data: dupEmail } = await adminClient
          .from("users")
          .select("id")
          .eq("email", nextEmail)
          .neq("id", caller.id)
          .maybeSingle();

        if (dupEmail) {
          return jsonResponse({ error: "That email address is already registered to another user." }, 409);
        }
      }

      if (emailChanged || passwordChanged || nameChanged) {
        const authPayload: {
          email?: string;
          email_confirm?: boolean;
          password?: string;
          user_metadata?: Record<string, unknown>;
        } = {};
        if (emailChanged) {
          authPayload.email = nextEmail;
          authPayload.email_confirm = true;
        }
        if (passwordChanged) {
          authPayload.password = newPassword;
        }
        if (nameChanged) {
          authPayload.user_metadata = {
            ...(caller.user_metadata ?? {}),
            full_name: nextFullName,
          };
        }

        const { error: authUpdErr } = await adminClient.auth.admin.updateUserById(caller.id, authPayload);
        if (authUpdErr) {
          return jsonResponse({ error: authUpdErr.message }, 400);
        }
      }

      const { error: userUpdErr } = await adminClient
        .from("users")
        .update({
          full_name: nextFullName,
          username: nextUsername,
          email: nextEmail,
        })
        .eq("id", caller.id);

      if (userUpdErr) {
        return jsonResponse({ error: userUpdErr.message }, 500);
      }

      await adminClient.from("audit_logs").insert({
        actor_user_id: caller.id,
        action: "update_admin_credentials",
        entity_type: "users",
        entity_id: caller.id,
        old_data: {
          full_name: callerProfile.full_name,
          username: callerProfile.username ?? null,
          email: callerProfile.email,
        },
        new_data: {
          full_name: nextFullName,
          username: nextUsername,
          email: nextEmail,
          password_changed: passwordChanged,
        },
      });

      let freshSession: { access_token: string; refresh_token: string } | null = null;
      if (passwordChanged) {
        const reauthClient = createClient(supabaseUrl, anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: reauthData } = await reauthClient.auth.signInWithPassword({
          email: nextEmail,
          password: newPassword,
        });
        if (reauthData?.session) {
          freshSession = {
            access_token: reauthData.session.access_token,
            refresh_token: reauthData.session.refresh_token,
          };
        }
      }

      return jsonResponse({
        success: true,
        password_changed: passwordChanged,
        email_changed: emailChanged,
        session: freshSession,
        profile: {
          id: caller.id,
          full_name: nextFullName,
          username: nextUsername,
          email: nextEmail,
        },
      });
    }

    return jsonResponse({ error: "Unsupported action" }, 400);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});

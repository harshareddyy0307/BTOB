import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder-key",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);

export async function extractEdgeFunctionError(
  error: unknown,
  data: unknown,
  fallback = "Request failed"
): Promise<string> {
  if (data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  if (error && typeof error === "object" && "context" in error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.clone === "function") {
      try {
        const json = (await ctx.clone().json()) as { error?: string; message?: string };
        if (json?.error) return json.error;
        if (json?.message) return json.message;
      } catch {
        try {
          const text = await ctx.clone().text();
          if (text) return text;
        } catch {
          // ignore
        }
      }
    }
  }
  if (error instanceof Error && error.message && error.message !== "Edge Function returned a non-2xx status code") {
    return error.message;
  }
  return fallback;
}

function isAuthErrorMessage(status: number | undefined, message: string): boolean {
  if (status === 401) return true;
  return /invalid session token|session_not_found|session.*not found|session expired|invalid jwt|jwt expired|refresh_token_not_found|invalid refresh token/i.test(
    message
  );
}

function isHardAuthErrObj(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: string; message?: string };
  if (e.status === 401 || e.status === 403) return true;
  const combined = `${e.code || ""} ${e.message || ""}`.toLowerCase();
  return (
    combined.includes("session_not_found") ||
    combined.includes("session from session_id claim") ||
    combined.includes("refresh_token_not_found") ||
    combined.includes("invalid refresh token") ||
    combined.includes("invalid_grant") ||
    combined.includes("user_not_found") ||
    combined.includes("invalid jwt") ||
    combined.includes("bad_jwt")
  );
}

export async function invokeAuthenticatedFunction<T = unknown>(
  functionName: string,
  body: unknown,
  fallbackError = "Request failed"
): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  let activeSession = sessionData.session;

  const expiresSoon =
    Boolean(activeSession?.expires_at) && activeSession!.expires_at! * 1000 < Date.now() + 60_000;

  if (!activeSession?.access_token || expiresSoon) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    activeSession = refreshed.session ?? activeSession;
  }

  if (!activeSession?.access_token) {
    await supabase.auth.signOut({ scope: "local" });
    throw new Error("Your login session expired or was signed out. Please sign in again.");
  }

  // Validate that the session still exists on Supabase Auth before calling Edge Function
  const { data: userRes, error: userErr } = await supabase.auth.getUser(activeSession.access_token);

  if (userErr || !userRes?.user) {
    const { data: refreshed, error: refErr } = await supabase.auth.refreshSession();
    let retryErr: unknown = null;
    if (!refErr && refreshed.session?.access_token) {
      const retryRes = await supabase.auth.getUser(refreshed.session.access_token);
      retryErr = retryRes.error;
      if (!retryRes.error && retryRes.data?.user) {
        activeSession = refreshed.session;
      } else if (isHardAuthErrObj(retryErr)) {
        activeSession = null;
      }
    } else if (isHardAuthErrObj(userErr) || isHardAuthErrObj(refErr)) {
      activeSession = null;
    } else {
      throw new Error("Unable to verify your login session. Please check your connection and try again.");
    }

    if (!activeSession) {
      await supabase.auth.signOut({ scope: "local" });
      throw new Error("Your login session expired or was signed out. Please sign in again.");
    }

    if (retryErr) {
      throw new Error("Unable to verify your login session. Please check your connection and try again.");
    }
  }

  const runInvoke = (token: string) =>
    supabase.functions.invoke(functionName, {
      body: body as Record<string, unknown>,
      headers: { Authorization: `Bearer ${token}` },
    });

  let { data, error } = await runInvoke(activeSession.access_token);

  if (error || (data && typeof data === "object" && "error" in data && (data as { error?: unknown }).error)) {
    const status = (error as { context?: Response } | null)?.context?.status;
    const msg = await extractEdgeFunctionError(error, data, fallbackError);

    if (isAuthErrorMessage(status, msg)) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      if (refreshed.session?.access_token) {
        const retry = await runInvoke(refreshed.session.access_token);
        data = retry.data;
        error = retry.error;
        if (!error && !(data && typeof data === "object" && "error" in data && (data as { error?: unknown }).error)) {
          return data as T;
        }
        const retryStatus = (error as { context?: Response } | null)?.context?.status;
        const retryMsg = await extractEdgeFunctionError(error, data, fallbackError);
        if (!isAuthErrorMessage(retryStatus, retryMsg)) {
          throw new Error(retryMsg);
        }
      }

      await supabase.auth.signOut({ scope: "local" });
      throw new Error("Your login session expired or was signed out. Please sign in again.");
    }

    throw new Error(msg);
  }

  return data as T;
}

/**
 * Fetches all rows across PostgREST `.range(from, to)` pages so catalogs, orders,
 * invoices, and reports do not silently truncate at Supabase's 1,000-row cap.
 */
export async function fetchAllRows<T = unknown>(
  fetchPage: (
    from: number,
    to: number
  ) => PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }>,
  pageSize = 1000
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) {
      throw new Error(error.message || "Failed to fetch records");
    }
    const batch = (data ?? []) as T[];
    all.push(...batch);
    if (batch.length < pageSize) {
      break;
    }
    from += pageSize;
  }

  return all;
}

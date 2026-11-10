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

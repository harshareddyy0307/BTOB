import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import type { AppUser, CustomerProfile, UserRole } from "@/types/database";

interface PublicBranding {
  agency_name: string;
  logo_url: string | null;
  currency_symbol: string;
  has_admin: boolean;
}

interface AuthContextValue {
  session: Session | null;
  userProfile: AppUser | null;
  customerProfile: CustomerProfile | null;
  role: UserRole | null;
  branding: PublicBranding;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null; role?: UserRole | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  refreshBranding: () => Promise<void>;
}

const DEFAULT_BRANDING: PublicBranding = {
  agency_name: "TradeBridge B2B",
  logo_url: null,
  currency_symbol: "₹",
  has_admin: true,
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [userProfile, setUserProfile] = useState<AppUser | null>(null);
  const [customerProfile, setCustomerProfile] = useState<CustomerProfile | null>(null);
  const [branding, setBranding] = useState<PublicBranding>(DEFAULT_BRANDING);
  const [loading, setLoading] = useState(true);

  const refreshBranding = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    const { data, error } = await supabase.rpc("get_public_branding");
    if (!error && data) {
      setBranding(data as PublicBranding);
    }
  }, []);

  const loadUserDetails = useCallback(async (userId: string): Promise<UserRole | null> => {
    const { data: userRow, error: userErr } = await supabase
      .from("users")
      .select("id, role_id, full_name, email, phone, is_active, created_at, roles!inner(name)")
      .eq("id", userId)
      .single();

    if (userErr || !userRow || !userRow.is_active) {
      setUserProfile(null);
      setCustomerProfile(null);
      return null;
    }

    const roleName = (userRow.roles as unknown as { name: UserRole }).name;
    const mappedUser: AppUser = {
      id: userRow.id,
      role_id: userRow.role_id,
      role: roleName,
      full_name: userRow.full_name,
      email: userRow.email,
      phone: userRow.phone,
      is_active: userRow.is_active,
      created_at: userRow.created_at,
    };
    setUserProfile(mappedUser);

    if (roleName === "customer") {
      const { data: custRow } = await supabase
        .from("customers")
        .select("*")
        .eq("user_id", userId)
        .single();
      setCustomerProfile((custRow as CustomerProfile) ?? null);
    } else {
      setCustomerProfile(null);
    }

    return roleName;
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    const { data } = await supabase.auth.getSession();
    if (data.session?.user) {
      await loadUserDetails(data.session.user.id);
    }
  }, [loadUserDetails]);

  useEffect(() => {
    let mounted = true;

    async function init() {
      if (!isSupabaseConfigured) {
        if (mounted) setLoading(false);
        return;
      }

      await refreshBranding();
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;

      setSession(data.session);
      if (data.session?.user) {
        await loadUserDetails(data.session.user.id);
      }
      if (mounted) setLoading(false);
    }

    init();

    if (!isSupabaseConfigured) return;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      if (nextSession?.user) {
        await loadUserDetails(nextSession.user.id);
      } else {
        setUserProfile(null);
        setCustomerProfile(null);
      }
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [loadUserDetails, refreshBranding]);

  const signIn = async (email: string, password: string) => {
    if (!isSupabaseConfigured) {
      return { error: "Supabase environment variables are not configured." };
    }
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error || !data.user) {
      return { error: error?.message || "Invalid email or password" };
    }
    const role = await loadUserDetails(data.user.id);
    if (!role) {
      await supabase.auth.signOut();
      return { error: "Your account is inactive or lacks an assigned portal role." };
    }
    return { error: null, role };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setUserProfile(null);
    setCustomerProfile(null);
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        userProfile,
        customerProfile,
        role: userProfile?.role ?? null,
        branding,
        loading,
        signIn,
        signOut,
        refreshProfile,
        refreshBranding,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ShieldCheck, Building2, Lock, AlertTriangle, Loader2, Store, ArrowRight } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { extractEdgeFunctionError, isSupabaseConfigured, supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface LoginPageProps {
  portal?: "customer" | "admin";
}

export function LoginPage({ portal = "customer" }: LoginPageProps) {
  const { signIn, signInCustomer, signOut, role, branding, refreshBranding, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const fromState = location.state as { from?: { pathname?: string; search?: string } } | null;
  const fromPath = fromState?.from?.pathname;

  const [customerIdentifier, setCustomerIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasNavigatedRef = useRef(false);

  // Initial agency owner setup state (only available when zero admin accounts exist)
  const [agencyName, setAgencyName] = useState("TradeBridge B2B Supply Agency");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => {
    setError(null);
  }, [portal]);

  useEffect(() => {
    if (!authLoading && role && !submitting && !hasNavigatedRef.current) {
      hasNavigatedRef.current = true;
      navigate(role === "customer" ? "/customer/home" : "/admin/dashboard", { replace: true });
    }
  }, [authLoading, role, submitting, navigate]);

  const handleCustomerLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    hasNavigatedRef.current = false;
    setSubmitting(true);
    const res = await signInCustomer(customerIdentifier);

    if (res.error) {
      setSubmitting(false);
      setError(res.error);
      return;
    }

    hasNavigatedRef.current = true;
    setSubmitting(false);
    const target = fromPath && fromPath.startsWith("/customer") ? `${fromPath}${fromState?.from?.search ?? ""}` : "/customer/home";
    navigate(target, { replace: true });
  };

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    hasNavigatedRef.current = false;
    setSubmitting(true);
    const res = await signIn(email, password);

    if (res.error) {
      setSubmitting(false);
      setError(res.error);
      return;
    }

    if (res.role === "customer") {
      await signOut();
      setSubmitting(false);
      setError("Customer accounts must sign in through the Customer Portal at /login.");
      return;
    }

    hasNavigatedRef.current = true;
    setSubmitting(false);
    const target = fromPath && fromPath.startsWith("/admin") ? `${fromPath}${fromState?.from?.search ?? ""}` : "/admin/dashboard";
    navigate(target, { replace: true });
  };

  const handleBootstrapAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { data, error: fnErr } = await supabase.functions.invoke("bootstrap-admin", {
      body: {
        full_name: fullName,
        username: username.trim().toLowerCase() || undefined,
        email,
        phone,
        password,
        agency_name: agencyName,
      },
    });

    if (fnErr || data?.error) {
      const msg = await extractEdgeFunctionError(fnErr, data, "Failed to initialize agency owner");
      setSubmitting(false);
      setError(msg);
      return;
    }

    await refreshBranding();
    const res = await signIn(email, password);
    setSubmitting(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    navigate("/admin/dashboard", { replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            {branding.logo_url ? (
              <img src={branding.logo_url} alt={branding.agency_name} className="h-full w-full object-contain p-1" />
            ) : (
              <Building2 className="h-5 w-5 text-blue-700" />
            )}
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{branding.agency_name}</h1>
          <p className="mt-1 text-sm text-slate-500">B2B Supply Operations &amp; Business Ordering Platform</p>
        </div>

        {!isSupabaseConfigured && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="font-semibold">Supabase Connection Required</p>
              <p className="mt-1 text-xs text-amber-800">
                Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in your environment to connect
                authentication and database services.
              </p>
            </div>
          </div>
        )}

        {!branding.has_admin && isSupabaseConfigured && portal === "admin" ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-blue-700" />
                Initial Agency Owner Setup
              </CardTitle>
              <CardDescription>
                No administrator exists yet. Create the primary Agency Owner account to initialize the platform.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleBootstrapAdmin} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="agencyName">Agency Name</Label>
                  <Input
                    id="agencyName"
                    value={agencyName}
                    onChange={(e) => setAgencyName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="fullName">Owner Full Name</Label>
                  <Input
                    id="fullName"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="e.g. Rajesh Verma"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="setupUsername">Admin Login Username (optional)</Label>
                  <Input
                    id="setupUsername"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))}
                    placeholder="e.g. rajesh_admin"
                    maxLength={32}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="phone">Phone Number</Label>
                  <Input
                    id="phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+91 98480 00000"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="setupEmail">Admin Email</Label>
                  <Input
                    id="setupEmail"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="owner@agency.in"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="setupPassword">Password (min 8 characters)</Label>
                  <Input
                    id="setupPassword"
                    type="password"
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                {error && <p className="rounded-md bg-red-50 p-2.5 text-xs font-medium text-red-700">{error}</p>}
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  Create Agency Owner Account
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : portal === "customer" ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Store className="h-4 w-4 text-blue-700" />
                Customer Portal Access
              </CardTitle>
              <CardDescription>
                Enter your registered business phone number or email &mdash; no password needed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCustomerLogin} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="customerIdentifier">Registered Phone Number or Email</Label>
                  <Input
                    id="customerIdentifier"
                    type="text"
                    autoComplete="tel"
                    value={customerIdentifier}
                    onChange={(e) => setCustomerIdentifier(e.target.value)}
                    placeholder="e.g. 9618401231 or shop@business.in"
                    required
                  />
                  <p className="text-xs text-slate-500">
                    Instant passwordless entry for active registered customer businesses.
                  </p>
                </div>

                {error && <p className="rounded-md bg-red-50 p-2.5 text-xs font-medium text-red-700">{error}</p>}

                <Button type="submit" className="w-full" disabled={submitting || !isSupabaseConfigured}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  Enter Customer Portal
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-blue-700" />
                Admin &amp; Staff Sign In
              </CardTitle>
              <CardDescription>Sign in with your agency administrator or staff credentials.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAdminLogin} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Username or Email</Label>
                  <Input
                    id="email"
                    type="text"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="username or you@company.in"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>

                {error && <p className="rounded-md bg-red-50 p-2.5 text-xs font-medium text-red-700">{error}</p>}

                <Button type="submit" className="w-full" disabled={submitting || !isSupabaseConfigured}>
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  Sign In to Admin Portal
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        <p className="text-center text-xs text-slate-400">
          {portal === "customer"
            ? "Passwordless Customer Portal • Authorized Businesses Only"
            : "Protected Admin & Staff Portal • Authorized Personnel Only"}
        </p>
      </div>
    </div>
  );
}

import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ShieldCheck,
  Building2,
  Lock,
  AlertTriangle,
  Loader2,
  Store,
  ArrowRight,
  UserPlus,
  Clock,
  CheckCircle2,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { extractEdgeFunctionError, isSupabaseConfigured, supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface LoginPageProps {
  portal?: "customer" | "admin";
  initialMode?: "signin" | "register";
}

interface RegistrationReceipt {
  business_name: string;
  owner_name: string;
  phone: string;
  email: string;
}

export function LoginPage({ portal = "customer", initialMode = "signin" }: LoginPageProps) {
  const { signIn, signInCustomer, signOut, role, branding, refreshBranding, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const fromState = location.state as { from?: { pathname?: string; search?: string } } | null;
  const fromPath = fromState?.from?.pathname;

  const [customerMode, setCustomerMode] = useState<"signin" | "register">(initialMode);
  const [customerIdentifier, setCustomerIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasNavigatedRef = useRef(false);

  // Customer self-registration state (passwordless — requires admin approval before login)
  const [regBusinessName, setRegBusinessName] = useState("");
  const [regOwnerName, setRegOwnerName] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regAddress, setRegAddress] = useState("");
  const [regCity, setRegCity] = useState("");
  const [regState, setRegState] = useState("Telangana");
  const [regPincode, setRegPincode] = useState("");
  const [regGst, setRegGst] = useState("");
  const [regCategory, setRegCategory] = useState("");
  const [registeredReceipt, setRegisteredReceipt] = useState<RegistrationReceipt | null>(null);

  // Initial agency owner setup state (only available when zero admin accounts exist)
  const [agencyName, setAgencyName] = useState("TradeBridge B2B Supply Agency");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => {
    setError(null);
    setCustomerMode(initialMode);
    if (portal !== "customer") {
      setRegisteredReceipt(null);
    }
  }, [portal, initialMode]);

  useEffect(() => {
    if (!authLoading && role && !submitting && !hasNavigatedRef.current) {
      hasNavigatedRef.current = true;
      navigate(role === "customer" ? "/customer/home" : "/admin/dashboard", { replace: true });
    }
  }, [authLoading, role, submitting, navigate]);

  const switchCustomerMode = (mode: "signin" | "register") => {
    setError(null);
    setCustomerMode(mode);
    if (mode === "signin") {
      setRegisteredReceipt(null);
    }
  };

  const resetRegistrationForm = () => {
    setRegBusinessName("");
    setRegOwnerName("");
    setRegPhone("");
    setRegEmail("");
    setRegAddress("");
    setRegCity("");
    setRegState("Telangana");
    setRegPincode("");
    setRegGst("");
    setRegCategory("");
    setRegisteredReceipt(null);
    setError(null);
  };

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
    const target =
      fromPath && fromPath.startsWith("/customer") ? `${fromPath}${fromState?.from?.search ?? ""}` : "/customer/home";
    navigate(target, { replace: true });
  };

  const handleCustomerRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const { data, error: fnErr } = await supabase.functions.invoke("register-customer", {
      body: {
        business_name: regBusinessName.trim(),
        owner_name: regOwnerName.trim(),
        phone: regPhone.trim(),
        email: regEmail.trim().toLowerCase(),
        business_address: regAddress.trim(),
        city: regCity.trim(),
        state: regState.trim() || "Telangana",
        pincode: regPincode.trim(),
        gst_number: regGst.trim().toUpperCase(),
        business_category: regCategory.trim(),
      },
    });

    if (fnErr || data?.error) {
      const msg = await extractEdgeFunctionError(fnErr, data, "Failed to submit registration request");
      setSubmitting(false);
      setError(msg);
      return;
    }

    const receipt: RegistrationReceipt = {
      business_name: data?.customer?.business_name || regBusinessName.trim(),
      owner_name: data?.customer?.owner_name || regOwnerName.trim(),
      phone: data?.customer?.phone || regPhone.trim(),
      email: data?.customer?.email || regEmail.trim().toLowerCase(),
    };

    setSubmitting(false);
    setRegisteredReceipt(receipt);
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
    const target =
      fromPath && fromPath.startsWith("/admin") ? `${fromPath}${fromState?.from?.search ?? ""}` : "/admin/dashboard";
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

  const isWideCustomerRegister = portal === "customer" && customerMode === "register" && !registeredReceipt;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className={cn("w-full space-y-6 transition-all", isWideCustomerRegister ? "max-w-lg" : "max-w-md")}>
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
                  <Input id="agencyName" value={agencyName} onChange={(e) => setAgencyName(e.target.value)} required />
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
            <CardHeader className="space-y-3">
              <div
                role="tablist"
                aria-label="Customer portal access mode"
                className="grid grid-cols-2 rounded-lg border border-slate-200 bg-slate-100 p-1"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={customerMode === "signin"}
                  onClick={() => switchCustomerMode("signin")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-all",
                    customerMode === "signin"
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-600 hover:text-slate-900"
                  )}
                >
                  <Store className="h-3.5 w-3.5" />
                  Sign In
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={customerMode === "register"}
                  onClick={() => switchCustomerMode("register")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-all",
                    customerMode === "register"
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-600 hover:text-slate-900"
                  )}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Register Business
                </button>
              </div>

              {customerMode === "signin" ? (
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Store className="h-4 w-4 text-blue-700" />
                    Customer Portal Access
                  </CardTitle>
                  <CardDescription className="mt-1">
                    Enter your registered business phone number or email &mdash; no password needed.
                  </CardDescription>
                </div>
              ) : (
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <UserPlus className="h-4 w-4 text-blue-700" />
                    {registeredReceipt ? "Registration Request Submitted" : "Register Your Business"}
                  </CardTitle>
                  <CardDescription className="mt-1">
                    {registeredReceipt
                      ? "Your request is queued for administrator approval."
                      : "Submit your business details below. Once approved by the admin, you can enter without a password."}
                  </CardDescription>
                </div>
              )}
            </CardHeader>

            <CardContent>
              {customerMode === "signin" ? (
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
                      Instant passwordless entry for admin-approved customer businesses.
                    </p>
                  </div>

                  {error && <p className="rounded-md bg-red-50 p-2.5 text-xs font-medium text-red-700">{error}</p>}

                  <Button type="submit" className="w-full" disabled={submitting || !isSupabaseConfigured}>
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                    Enter Customer Portal
                  </Button>

                  <p className="border-t border-slate-100 pt-3 text-center text-xs text-slate-500">
                    New customer business?{" "}
                    <button
                      type="button"
                      onClick={() => switchCustomerMode("register")}
                      className="font-semibold text-blue-700 hover:underline"
                    >
                      Register for Portal Access
                    </button>
                  </p>
                </form>
              ) : registeredReceipt ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                    <div className="flex items-start gap-2.5">
                      <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                      <div className="space-y-1">
                        <p className="font-semibold">Waiting for Admin Approval</p>
                        <p className="text-xs leading-relaxed text-amber-900">
                          Thank you, <strong>{registeredReceipt.owner_name}</strong>. Your registration for{" "}
                          <strong>{registeredReceipt.business_name}</strong> has been sent to the agency administrator.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-700">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Status</span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                        <Clock className="h-3 w-3" />
                        Pending Admin Approval
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Phone</span>
                      <span className="font-medium text-slate-900">{registeredReceipt.phone}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Email</span>
                      <span className="font-medium text-slate-900">{registeredReceipt.email}</span>
                    </div>
                  </div>

                  <div className="flex items-start gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-700" />
                    <span>
                      Once the administrator grants access, return to Sign In and enter your phone number or email (no
                      password needed).
                    </span>
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      className="flex-1"
                      onClick={() => {
                        setCustomerIdentifier(registeredReceipt.phone);
                        setRegisteredReceipt(null);
                        setError(null);
                        setCustomerMode("signin");
                      }}
                    >
                      <ArrowRight className="h-4 w-4" />
                      Back to Sign In
                    </Button>
                    <Button type="button" variant="outline" onClick={resetRegistrationForm}>
                      Register Another
                    </Button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleCustomerRegister} className="space-y-3.5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor="regBusinessName">Business Name *</Label>
                      <Input
                        id="regBusinessName"
                        value={regBusinessName}
                        onChange={(e) => setRegBusinessName(e.target.value)}
                        placeholder="e.g. Sri Sai Traders"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="regOwnerName">Owner / Contact Name *</Label>
                      <Input
                        id="regOwnerName"
                        value={regOwnerName}
                        onChange={(e) => setRegOwnerName(e.target.value)}
                        placeholder="e.g. Ramesh Kumar"
                        required
                      />
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor="regPhone">Phone Number *</Label>
                      <Input
                        id="regPhone"
                        type="tel"
                        value={regPhone}
                        onChange={(e) => setRegPhone(e.target.value)}
                        placeholder="10-digit mobile number"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="regEmail">Business Email *</Label>
                      <Input
                        id="regEmail"
                        type="email"
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        placeholder="shop@business.in"
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="regAddress">Business Address *</Label>
                    <Input
                      id="regAddress"
                      value={regAddress}
                      onChange={(e) => setRegAddress(e.target.value)}
                      placeholder="Shop / Godown No, Street, Locality"
                      required
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="regCity">City</Label>
                      <Input
                        id="regCity"
                        value={regCity}
                        onChange={(e) => setRegCity(e.target.value)}
                        placeholder="Hyderabad"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="regState">State *</Label>
                      <Input
                        id="regState"
                        value={regState}
                        onChange={(e) => setRegState(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="regPincode">Pincode</Label>
                      <Input
                        id="regPincode"
                        value={regPincode}
                        onChange={(e) => setRegPincode(e.target.value)}
                        placeholder="500001"
                      />
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor="regGst">GSTIN (Optional)</Label>
                      <Input
                        id="regGst"
                        value={regGst}
                        onChange={(e) => setRegGst(e.target.value.toUpperCase())}
                        placeholder="36AAAAA0000A1Z5"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="regCategory">Business Category (Optional)</Label>
                      <Input
                        id="regCategory"
                        value={regCategory}
                        onChange={(e) => setRegCategory(e.target.value)}
                        placeholder="Retail / Packaging / Bakery"
                      />
                    </div>
                  </div>

                  {error && <p className="rounded-md bg-red-50 p-2.5 text-xs font-medium text-red-700">{error}</p>}

                  <Button type="submit" className="w-full" disabled={submitting || !isSupabaseConfigured}>
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                    Submit Registration Request
                  </Button>

                  <p className="border-t border-slate-100 pt-3 text-center text-xs text-slate-500">
                    Already approved?{" "}
                    <button
                      type="button"
                      onClick={() => switchCustomerMode("signin")}
                      className="font-semibold text-blue-700 hover:underline"
                    >
                      Sign in with phone or email
                    </button>
                  </p>
                </form>
              )}
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
            ? "Passwordless Customer Portal • Admin Approval Required for New Businesses"
            : "Protected Admin & Staff Portal • Authorized Personnel Only"}
        </p>
      </div>
    </div>
  );
}

import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  ShieldAlert,
  UserCheck,
} from "lucide-react";
import { invokeAuthenticatedFunction, supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

interface AdminSecurityStatusResponse {
  has_pin: boolean;
  is_locked: boolean;
  locked_until: string | null;
  remaining_attempts: number;
  pin_updated_at: string | null;
  profile: {
    id: string;
    full_name: string;
    username: string | null;
    email: string;
    phone: string | null;
  };
}

interface UpdateCredentialsResponse {
  success: boolean;
  password_changed: boolean;
  email_changed: boolean;
  session: { access_token: string; refresh_token: string } | null;
  profile: {
    id: string;
    full_name: string;
    username: string | null;
    email: string;
  };
}

const digitsOnlyPin = (v: string) => v.replace(/\D/g, "").slice(0, 4);

export function AdminCredentialsSecurityTab() {
  const { role, refreshProfile } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isOwnerAdmin = role === "admin";

  // Credential edit state
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authPin, setAuthPin] = useState("");
  const [showNewPwd, setShowNewPwd] = useState(false);
  const [showAuthPin, setShowAuthPin] = useState(false);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);

  // 4-Digit Security PIN setup/reset state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [showCurrentPwd, setShowCurrentPwd] = useState(false);
  const [showSetupPin, setShowSetupPin] = useState(false);
  const [savingPin, setSavingPin] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  // Clear PIN modal state
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearPassword, setClearPassword] = useState("");
  const [clearPin, setClearPin] = useState("");
  const [clearingPin, setClearingPin] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const {
    data: statusData,
    isLoading,
    refetch: refetchStatus,
  } = useQuery({
    queryKey: ["admin-credential-status"],
    enabled: isOwnerAdmin,
    queryFn: () =>
      invokeAuthenticatedFunction<AdminSecurityStatusResponse>(
        "admin-credentials",
        { action: "status" },
        "Failed to load admin security settings"
      ),
  });

  useEffect(() => {
    if (statusData?.profile) {
      setFullName(statusData.profile.full_name || "");
      setUsername(statusData.profile.username || "");
      setEmail(statusData.profile.email || "");
    }
  }, [statusData?.profile?.id, statusData?.profile?.full_name, statusData?.profile?.username, statusData?.profile?.email]);

  if (!isOwnerAdmin) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-8 text-sm text-amber-900">
          <ShieldAlert className="h-5 w-5 shrink-0 text-amber-600" />
          <span>
            Only the primary <strong>Admin (Agency Owner)</strong> can manage the admin login username, password, and
            4-digit Security PIN.
          </span>
        </CardContent>
      </Card>
    );
  }

  const handleSetPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError(null);

    if (!currentPassword) {
      setPinError("Enter your current login password.");
      return;
    }
    if (!/^\d{4}$/.test(newPin)) {
      setPinError("Security PIN must be exactly 4 digits (0-9).");
      return;
    }
    if (newPin !== confirmPin) {
      setPinError("PIN entries do not match.");
      return;
    }

    setSavingPin(true);
    try {
      await invokeAuthenticatedFunction(
        "admin-credentials",
        {
          action: "set_pin",
          current_password: currentPassword,
          new_pin: newPin,
        },
        "Failed to configure 4-digit PIN"
      );

      setCurrentPassword("");
      setNewPin("");
      setConfirmPin("");
      await refetchStatus();
      queryClient.invalidateQueries({ queryKey: ["admin-audit-logs"] });
      toast({
        title: statusData?.has_pin ? "4-digit Security PIN updated" : "4-digit Security PIN configured",
        description: "You can now authorize admin username and password changes using this PIN.",
        type: "success",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save PIN";
      setPinError(msg);
      toast({ title: "PIN setup failed", description: msg, type: "error" });
    } finally {
      setSavingPin(false);
    }
  };

  const handleClearPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setClearError(null);
    if (!clearPassword || !/^\d{4}$/.test(clearPin)) {
      setClearError("Enter both your current password and current 4-digit PIN.");
      toast({ title: "Password and 4-digit PIN required", type: "error" });
      return;
    }
    setClearingPin(true);
    try {
      await invokeAuthenticatedFunction(
        "admin-credentials",
        { action: "remove_pin", current_password: clearPassword, pin: clearPin },
        "Failed to remove 4-digit PIN"
      );
      setClearModalOpen(false);
      setClearPassword("");
      setClearPin("");
      setClearError(null);
      await refetchStatus();
      queryClient.invalidateQueries({ queryKey: ["admin-audit-logs"] });
      toast({ title: "4-digit Security PIN cleared", type: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error";
      setClearError(msg);
      void refetchStatus();
      toast({
        title: "Could not clear PIN",
        description: msg,
        type: "error",
      });
    } finally {
      setClearingPin(false);
    }
  };

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setCredError(null);

    if (!statusData?.has_pin) {
      setCredError("Set a 4-digit Security PIN first before updating admin credentials.");
      return;
    }

    const cleanUsername = username.trim().toLowerCase();
    if (cleanUsername && !/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
      setCredError("Username must be 3-32 chars using letters, numbers, '.', '_', or '-'.");
      return;
    }
    if (!fullName.trim() || fullName.trim().length < 2) {
      setCredError("Display name must be at least 2 characters.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim().toLowerCase())) {
      setCredError("Enter a valid login email address.");
      return;
    }
    if (newPassword && newPassword.length < 8) {
      setCredError("New password must be at least 8 characters.");
      return;
    }
    if ((newPassword || confirmPassword) && newPassword !== confirmPassword) {
      setCredError("New password and confirmation do not match.");
      return;
    }
    if (!/^\d{4}$/.test(authPin)) {
      setCredError("Enter your 4-digit Security PIN to authorize these changes.");
      return;
    }

    setSavingCredentials(true);
    try {
      const res = await invokeAuthenticatedFunction<UpdateCredentialsResponse>(
        "admin-credentials",
        {
          action: "update_credentials",
          pin: authPin,
          username: cleanUsername,
          full_name: fullName.trim(),
          email: email.trim().toLowerCase(),
          new_password: newPassword,
        },
        "Failed to update admin credentials"
      );

      if (res.session?.access_token && res.session?.refresh_token) {
        await supabase.auth.setSession({
          access_token: res.session.access_token,
          refresh_token: res.session.refresh_token,
        });
      } else if (res.email_changed) {
        await supabase.auth.refreshSession();
      }

      await refreshProfile();
      await refetchStatus();
      queryClient.invalidateQueries({ queryKey: ["admin-staff-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-audit-logs"] });

      setNewPassword("");
      setConfirmPassword("");
      setAuthPin("");

      const summaryParts: string[] = [];
      if (cleanUsername) summaryParts.push(`Username: @${cleanUsername}`);
      if (res.email_changed) summaryParts.push(`Email updated`);
      if (res.password_changed) summaryParts.push(`Password updated`);

      toast({
        title: "Admin credentials updated",
        description: summaryParts.join(" • ") || "Changes saved and active immediately.",
        type: "success",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not update credentials";
      setCredError(msg);
      void refetchStatus();
      toast({ title: "Authorization or save failed", description: msg, type: "error" });
    } finally {
      setSavingCredentials(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading admin security status...
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-6 lg:grid-cols-5">
        {/* Update Admin Username, Email & Password (Requires 4-digit PIN) */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <UserCheck className="h-4 w-4 text-blue-700" />
                Change Admin Username &amp; Password
              </CardTitle>
              {statusData?.profile.username ? (
                <span className="rounded-full bg-blue-50 px-2.5 py-0.5 font-mono text-xs font-semibold text-blue-800">
                  @{statusData.profile.username}
                </span>
              ) : (
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  Username not set yet
                </span>
              )}
            </div>
            <CardDescription>
              Update the Agency Owner login username, email, display name, or password. Requires your 4-digit Security
              PIN below to authorize changes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!statusData?.has_pin && (
              <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <p className="font-semibold">4-Digit Security PIN Required First</p>
                  <p className="mt-0.5 text-amber-800">
                    Create your 4-digit Security PIN in the panel on the right to unlock Admin username and password
                    updates.
                  </p>
                </div>
              </div>
            )}

            {statusData?.is_locked && (
              <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                <div>
                  <p className="font-semibold">PIN Verification Temporarily Locked</p>
                  <p className="mt-0.5">
                    Too many wrong PIN attempts. Wait until{" "}
                    {statusData.locked_until ? formatDateTime(statusData.locked_until) : "the cooldown finishes"}, or
                    reset your 4-digit PIN immediately using your current password.
                  </p>
                </div>
              </div>
            )}

            <form onSubmit={handleSaveCredentials} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="admin-username">Admin Login Username</Label>
                  <Input
                    id="admin-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))}
                    placeholder="e.g. harsha_admin"
                    maxLength={32}
                    autoComplete="off"
                    className="font-mono"
                  />
                  <p className="text-[11px] text-slate-500">
                    Sign in at Login with this username or your email (3-32 chars: a-z, 0-9, ., _, -).
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="admin-fullname">Admin Display Name *</Label>
                  <Input
                    id="admin-fullname"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="admin-email">Login Email Address *</Label>
                <Input
                  id="admin-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="admin-new-password">New Password (optional)</Label>
                  <div className="relative">
                    <Input
                      id="admin-new-password"
                      type={showNewPwd ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      minLength={8}
                      placeholder="Leave blank to keep current"
                      autoComplete="new-password"
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPwd((s) => !s)}
                      className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-700"
                      aria-label={showNewPwd ? "Hide new password" : "Show new password"}
                    >
                      {showNewPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="admin-confirm-password">Confirm New Password</Label>
                  <Input
                    id="admin-confirm-password"
                    type={showNewPwd ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    autoComplete="new-password"
                  />
                </div>
              </div>

              <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3 sm:p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div className="space-y-1.5">
                    <Label htmlFor="admin-auth-pin" className="text-blue-950">
                      4-Digit Security PIN Verification *
                    </Label>
                    <div className="relative w-full sm:w-44">
                      <Input
                        id="admin-auth-pin"
                        type={showAuthPin ? "text" : "password"}
                        inputMode="numeric"
                        maxLength={4}
                        value={authPin}
                        onChange={(e) => setAuthPin(digitsOnlyPin(e.target.value))}
                        placeholder="••••"
                        disabled={!statusData?.has_pin || statusData?.is_locked}
                        className="bg-white pr-9 text-center font-mono text-base tracking-[0.4em]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowAuthPin((s) => !s)}
                        className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-700"
                        aria-label={showAuthPin ? "Hide PIN" : "Show PIN"}
                      >
                        {showAuthPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-slate-600 sm:max-w-xs sm:text-right">
                    Required to authorize changes to your username, email, or password.
                    {statusData?.has_pin && !statusData.is_locked && (
                      <span className="block font-medium text-blue-800">
                        {statusData.remaining_attempts} PIN attempt(s) remaining.
                      </span>
                    )}
                  </p>
                </div>
              </div>

              {credError && (
                <p className="rounded-md border border-red-200 bg-red-50 p-2.5 text-xs font-medium text-red-700">
                  {credError}
                </p>
              )}

              <Button
                type="submit"
                disabled={savingCredentials || !statusData?.has_pin || statusData?.is_locked}
              >
                {savingCredentials ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Save Admin Credentials
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Set or Reset 4-Digit Security PIN */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Lock className="h-4 w-4 text-blue-700" />
                4-Digit Security PIN
              </CardTitle>
              {statusData?.has_pin ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  PIN Active
                </span>
              ) : (
                <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                  Not Set
                </span>
              )}
            </div>
            <CardDescription>
              {statusData?.has_pin
                ? "Change or reset your 4-digit Security PIN anytime by confirming your current login password."
                : "Set a private 4-digit PIN (0-9) using your current login password."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statusData?.pin_updated_at && (
              <p className="mb-3 text-xs text-slate-500">
                Last configured: <span className="font-medium text-slate-700">{formatDateTime(statusData.pin_updated_at)}</span>
              </p>
            )}
            <form onSubmit={handleSetPin} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pin-current-password">Current Login Password *</Label>
                <div className="relative">
                  <Input
                    id="pin-current-password"
                    type={showCurrentPwd ? "text" : "password"}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Confirm current password"
                    autoComplete="current-password"
                    required
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrentPwd((s) => !s)}
                    className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-700"
                    aria-label={showCurrentPwd ? "Hide password" : "Show password"}
                  >
                    {showCurrentPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="pin-new">New 4-Digit PIN *</Label>
                  <div className="relative">
                    <Input
                      id="pin-new"
                      type={showSetupPin ? "text" : "password"}
                      inputMode="numeric"
                      maxLength={4}
                      value={newPin}
                      onChange={(e) => setNewPin(digitsOnlyPin(e.target.value))}
                      placeholder="••••"
                      required
                      className="pr-9 text-center font-mono text-base tracking-[0.4em]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSetupPin((s) => !s)}
                      className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-700"
                      aria-label={showSetupPin ? "Hide PIN" : "Show PIN"}
                    >
                      {showSetupPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pin-confirm">Confirm 4-Digit PIN *</Label>
                  <Input
                    id="pin-confirm"
                    type={showSetupPin ? "text" : "password"}
                    inputMode="numeric"
                    maxLength={4}
                    value={confirmPin}
                    onChange={(e) => setConfirmPin(digitsOnlyPin(e.target.value))}
                    placeholder="••••"
                    required
                    className="text-center font-mono text-base tracking-[0.4em]"
                  />
                </div>
              </div>

              {pinError && (
                <p className="rounded-md border border-red-200 bg-red-50 p-2.5 text-xs font-medium text-red-700">
                  {pinError}
                </p>
              )}

              <Button type="submit" variant={statusData?.has_pin ? "outline" : "default"} className="w-full" disabled={savingPin}>
                {savingPin && <Loader2 className="h-4 w-4 animate-spin" />}
                {statusData?.has_pin ? "Update / Reset 4-Digit PIN" : "Create 4-Digit Security PIN"}
              </Button>
              {statusData?.has_pin && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs text-slate-500 hover:text-red-700"
                  onClick={() => setClearModalOpen(true)}
                >
                  Clear 4-Digit PIN
                </Button>
              )}
            </form>
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={clearModalOpen}
        onOpenChange={(open) => {
          setClearModalOpen(open);
          if (!open) {
            setClearError(null);
            setClearPassword("");
            setClearPin("");
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear 4-Digit Security PIN</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleClearPin} className="space-y-4">
            <p className="text-xs text-slate-600">
              Confirm both your current login password and active 4-digit PIN to remove the PIN configuration.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="clear-pin-password">Current Login Password *</Label>
              <Input
                id="clear-pin-password"
                type="password"
                value={clearPassword}
                onChange={(e) => setClearPassword(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="clear-pin-code">Current 4-Digit PIN *</Label>
              <Input
                id="clear-pin-code"
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={clearPin}
                onChange={(e) => setClearPin(digitsOnlyPin(e.target.value))}
                placeholder="••••"
                className="text-center font-mono text-base tracking-[0.4em]"
                required
              />
            </div>
            {clearError && (
              <p className="rounded-md border border-red-200 bg-red-50 p-2.5 text-xs font-medium text-red-700">
                {clearError}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setClearModalOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={clearingPin}>
                {clearingPin && <Loader2 className="h-4 w-4 animate-spin" />}
                Confirm Clear PIN
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

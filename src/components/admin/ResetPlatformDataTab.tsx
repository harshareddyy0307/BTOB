import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { invokeAuthenticatedFunction } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

interface ResetSummaryCounts {
  customers: number;
  manufacturers: number;
  categories: number;
  products: number;
  orders: number;
  purchase_orders: number;
  invoices: number;
  payments: number;
  notifications: number;
  audit_logs: number;
  other_staff_users: number;
}

interface ResetSummaryResponse {
  has_pin: boolean;
  is_pin_locked: boolean;
  pin_locked_until: string | null;
  counts: ResetSummaryCounts;
}

interface ResetExecuteResponse {
  success: boolean;
  deleted_counts: Record<string, number>;
  deleted_auth_users: number;
  storage_removed: Record<string, number>;
  reset_agency_settings: boolean;
  deleted_staff: boolean;
  warnings?: string[];
}

const REQUIRED_PHRASE = "RESET ALL DATA";
const digitsOnlyPin = (v: string) => v.replace(/\D/g, "").slice(0, 4);

export function ResetPlatformDataTab() {
  const { role, userProfile, refreshBranding, refreshProfile } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isOwnerAdmin = role === "admin";

  const [resetAgencySettings, setResetAgencySettings] = useState(false);
  const [deleteStaff, setDeleteStaff] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmationPhrase, setConfirmationPhrase] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [pin, setPin] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [lastResetResult, setLastResetResult] = useState<ResetExecuteResponse | null>(null);

  const {
    data: summary,
    isLoading,
    isFetching,
    isError,
    error: summaryError,
    refetch,
  } = useQuery({
    queryKey: ["admin-reset-summary"],
    enabled: isOwnerAdmin,
    queryFn: () =>
      invokeAuthenticatedFunction<ResetSummaryResponse>(
        "reset-platform-data",
        { action: "summary" },
        "Failed to load live platform data summary"
      ),
  });

  if (!isOwnerAdmin) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-8 text-sm text-amber-900">
          <ShieldAlert className="h-5 w-5 shrink-0 text-amber-600" />
          <span>
            Only the primary <strong>Admin (Agency Owner)</strong> can reset and permanently delete all platform data.
          </span>
        </CardContent>
      </Card>
    );
  }

  const counts = summary?.counts;
  const totalOperationalRecords = counts
    ? counts.customers +
      counts.manufacturers +
      counts.categories +
      counts.products +
      counts.orders +
      counts.purchase_orders +
      counts.invoices +
      counts.payments
    : 0;

  const statItems = [
    { label: "Customers", value: counts?.customers ?? 0 },
    { label: "Manufacturers", value: counts?.manufacturers ?? 0 },
    { label: "Categories", value: counts?.categories ?? 0 },
    { label: "Products & Catalog", value: counts?.products ?? 0 },
    { label: "Customer Orders", value: counts?.orders ?? 0 },
    { label: "Purchase Orders", value: counts?.purchase_orders ?? 0 },
    { label: "GST Invoices", value: counts?.invoices ?? 0 },
    { label: "Payments", value: counts?.payments ?? 0 },
  ];

  const closeModal = () => {
    if (resetting) return;
    setConfirmOpen(false);
    setConfirmationPhrase("");
    setCurrentPassword("");
    setPin("");
    setShowPassword(false);
    setShowPin(false);
    setResetError(null);
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError(null);

    if (confirmationPhrase.trim().toUpperCase() !== REQUIRED_PHRASE) {
      setResetError(`Please type "${REQUIRED_PHRASE}" to confirm.`);
      return;
    }

    if (!currentPassword) {
      setResetError("Enter your current Agency Owner password.");
      return;
    }

    if (summary?.has_pin && !/^\d{4}$/.test(pin)) {
      setResetError("Enter your active 4-digit Security PIN.");
      return;
    }

    setResetting(true);
    try {
      const result = await invokeAuthenticatedFunction<ResetExecuteResponse>(
        "reset-platform-data",
        {
          action: "reset_all_data",
          confirmation_phrase: confirmationPhrase.trim().toUpperCase(),
          current_password: currentPassword,
          pin: summary?.has_pin ? pin : undefined,
          reset_agency_settings: resetAgencySettings,
          delete_staff: deleteStaff,
        },
        "Failed to reset platform data"
      );

      // Clear all cached operational queries immediately so every admin/customer page reflects a clean state
      queryClient.removeQueries();
      await Promise.all([
        refreshBranding(),
        refreshProfile(),
        queryClient.invalidateQueries(),
        refetch(),
      ]);

      setLastResetResult(result);
      setResetAgencySettings(false);
      setDeleteStaff(false);
      setConfirmOpen(false);
      setConfirmationPhrase("");
      setCurrentPassword("");
      setPin("");
      setShowPassword(false);
      setShowPin(false);
      setResetError(null);

      toast({
        title: "All operational data has been permanently deleted",
        description:
          result.warnings && result.warnings.length > 0
            ? `Database reset completed with ${result.warnings.length} cleanup warning(s).`
            : "Database records, uploaded product/manufacturer files, customer accounts, and number sequences have been reset cleanly.",
        type: result.warnings && result.warnings.length > 0 ? "info" : "success",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not reset platform data";
      setResetError(msg);
      void refetch();
      toast({
        title: "Data reset failed",
        description: msg,
        type: "error",
      });
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="space-y-4">
      {lastResetResult && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-950">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
            <div className="min-w-0 space-y-1">
              <p className="font-semibold">Latest Reset Completed</p>
              <p className="text-emerald-900">
                Deleted {lastResetResult.deleted_counts?.customers ?? 0} customer(s),{" "}
                {lastResetResult.deleted_counts?.manufacturers ?? 0} manufacturer(s),{" "}
                {lastResetResult.deleted_counts?.products ?? 0} product(s),{" "}
                {lastResetResult.deleted_counts?.orders ?? 0} order(s),{" "}
                {lastResetResult.deleted_counts?.purchase_orders ?? 0} purchase order(s),{" "}
                {lastResetResult.deleted_counts?.invoices ?? 0} invoice(s),{" "}
                {lastResetResult.deleted_auth_users ?? 0} portal login account(s), and reset Order/PO/Invoice numbering to 1001.
              </p>
              {lastResetResult.warnings && lastResetResult.warnings.length > 0 && (
                <p className="font-medium text-amber-800">
                  Cleanup warnings: {lastResetResult.warnings.join(" | ")}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      <Card className="border-red-200">
        <CardHeader className="border-b border-red-100 bg-red-50/40">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base text-red-900 sm:text-lg">
                <RotateCcw className="h-4 w-4 shrink-0 text-red-600 sm:h-5 sm:w-5" />
                Reset All Platform Data (Danger Zone)
              </CardTitle>
              <CardDescription className="text-red-900/80">
                Permanently delete all business, catalog, pricing, customer, supplier, order, invoice, payment, and
                uploaded file data so you can start completely fresh.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 bg-white"
              onClick={() => void refetch()}
              disabled={isFetching || resetting}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
              Refresh Counts
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-5 pt-5">
          {isError && (
            <div className="flex flex-col gap-2.5 rounded-lg border border-red-200 bg-red-50 p-3.5 text-xs text-red-900 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                <span>
                  {summaryError instanceof Error
                    ? summaryError.message
                    : "Could not verify live record counts and security PIN status."}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 bg-white"
                onClick={() => void refetch()}
                disabled={isFetching || resetting}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
                Retry
              </Button>
            </div>
          )}

          {/* Live Record Snapshot */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-600">
                <Database className="h-3.5 w-3.5 text-slate-500" />
                Live Records Currently Stored
              </h2>
              <span className="text-xs font-medium text-slate-500">
                {isLoading ? "Counting..." : !counts ? "Unavailable" : `${totalOperationalRecords} core business record(s)`}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {statItems.map((item) => (
                <div
                  key={item.label}
                  className="rounded-md border border-slate-200 bg-slate-50/70 px-3 py-2"
                >
                  <p className="truncate text-[11px] font-medium text-slate-500">{item.label}</p>
                  <p className="mt-0.5 text-lg font-bold text-slate-900">
                    {isLoading || !counts ? "—" : item.value}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* What gets wiped vs what stays */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-red-200 bg-red-50/50 p-4 text-xs text-red-950">
              <p className="flex items-center gap-1.5 font-semibold text-red-900">
                <Trash2 className="h-3.5 w-3.5 text-red-600" />
                Will Be Permanently Deleted
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-red-900/90">
                <li>All Customers, Delivery Addresses, Custom Prices, Carts &amp; Customer Portal Logins</li>
                <li>All Manufacturers, Manufacturer Links &amp; Uploaded Manufacturer Invoices/Documents</li>
                <li>All Categories, Subcategories, Products, Published Catalog Items &amp; Product Photos</li>
                <li>All Inventory Balances, Stock Adjustments &amp; Movement History</li>
                <li>All Category/Product Margin Overrides &amp; Price Change History</li>
                <li>All Customer Orders, Split/Manual Purchase Orders, GST Invoices &amp; Recorded Payments</li>
                <li>All Notifications ({counts?.notifications ?? 0}), Prior Audit Logs ({counts?.audit_logs ?? 0}), &amp; Counters reset to 1001</li>
              </ul>
            </div>

            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 text-xs text-emerald-950">
              <p className="flex items-center gap-1.5 font-semibold text-emerald-900">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
                Preserved Safely By Default
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-emerald-900/90">
                <li>
                  Your active <strong>Agency Owner</strong> login account (
                  <span className="font-mono break-all">{userProfile?.email}</span>) and 4-digit Security PIN stay
                  working
                </li>
                <li>Default Global Margin resets cleanly to <strong>15%</strong> so Margin Pricing works immediately</li>
                <li>System Roles and Storage Buckets stay configured for immediate reuse</li>
                <li>Agency GST Profile, Bank Details, Logo &amp; Staff Users stay intact unless checked below</li>
              </ul>
            </div>
          </div>

          {/* Optional Extended Reset Scope */}
          <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Optional Additional Cleanup</p>

            <label className="flex cursor-pointer items-start gap-2.5 text-xs text-slate-800">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                checked={deleteStaff}
                onChange={(e) => setDeleteStaff(e.target.checked)}
                disabled={resetting}
              />
              <span>
                <strong>Also delete other Staff &amp; secondary Admin accounts</strong> (
                {counts?.other_staff_users ?? 0} account(s) currently). Your own active Agency Owner account will never
                be deleted.
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 text-xs text-slate-800">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                checked={resetAgencySettings}
                onChange={(e) => setResetAgencySettings(e.target.checked)}
                disabled={resetting}
              />
              <span>
                <strong>Also reset Agency Profile, GSTIN, Bank Details &amp; Logo</strong> back to initial factory
                defaults (clears uploaded agency brand logo too).
              </span>
            </label>
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2.5 text-xs text-amber-950">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
              <span>
                <strong>This action cannot be undone.</strong> Export PDF backups from Orders, Customers, Manufacturers,
                or Reports before proceeding if you want an offline copy.
              </span>
            </div>
            <Button
              type="button"
              variant="destructive"
              className="w-full shrink-0 sm:w-auto"
              disabled={resetting || isLoading || isError || !summary || summary.is_pin_locked}
              onClick={() => {
                setResetError(null);
                setConfirmOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" />
              {isLoading ? "Checking Security & Counts..." : "Reset All Data..."}
            </Button>
          </div>

          {summary?.is_pin_locked && (
            <div className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <span>
                Your 4-digit Security PIN is temporarily locked until{" "}
                {summary.pin_locked_until ? formatDateTime(summary.pin_locked_until) : "the cooldown completes"}.
                Wait for the cooldown or reset your PIN in the <strong>Admin Credentials &amp; PIN</strong> tab first.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Final Multi-Step Confirmation Modal */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) closeModal();
          else setConfirmOpen(true);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              Confirm Permanent Reset of All Data
            </DialogTitle>
            <DialogDescription>
              All customers, manufacturers, categories, products, margins, inventory, orders, purchase orders,
              invoices, payments, and uploaded files will be permanently deleted.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleConfirmReset} className="space-y-4">
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900">
              <p className="font-semibold">Selected Scope:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li>Delete all business, catalog, customer, supplier, order, invoice &amp; payment data</li>
                <li>Delete all Customer Portal logins &amp; reset Order/PO/Invoice sequences to 1001</li>
                <li>Delete Staff / other Admin accounts: <strong>{deleteStaff ? "YES" : "No"}</strong></li>
                <li>Reset Agency GST Profile &amp; Brand Logo: <strong>{resetAgencySettings ? "YES" : "No"}</strong></li>
              </ul>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reset-confirm-phrase">
                Type <span className="font-mono font-bold text-red-700">{REQUIRED_PHRASE}</span> to confirm *
              </Label>
              <Input
                id="reset-confirm-phrase"
                value={confirmationPhrase}
                onChange={(e) => setConfirmationPhrase(e.target.value)}
                placeholder={REQUIRED_PHRASE}
                autoComplete="off"
                disabled={resetting}
                required
                className="font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reset-current-password">Agency Owner Login Password *</Label>
              <div className="relative">
                <Input
                  id="reset-current-password"
                  type={showPassword ? "text" : "password"}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Enter your login password"
                  autoComplete="current-password"
                  disabled={resetting}
                  required
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-700"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {summary?.has_pin && (
              <div className="space-y-1.5">
                <Label htmlFor="reset-security-pin">4-Digit Security PIN *</Label>
                <div className="relative w-full sm:w-44">
                  <Input
                    id="reset-security-pin"
                    type={showPin ? "text" : "password"}
                    inputMode="numeric"
                    maxLength={4}
                    value={pin}
                    onChange={(e) => setPin(digitsOnlyPin(e.target.value))}
                    placeholder="••••"
                    disabled={resetting}
                    required
                    className="pr-9 text-center font-mono text-base tracking-[0.4em]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin((s) => !s)}
                    className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-700"
                    aria-label={showPin ? "Hide PIN" : "Show PIN"}
                  >
                    {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}

            {resetError && (
              <p className="rounded-md border border-red-200 bg-red-50 p-2.5 text-xs font-medium text-red-700">
                {resetError}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeModal} disabled={resetting}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={
                  resetting ||
                  !summary ||
                  summary.is_pin_locked ||
                  confirmationPhrase.trim().toUpperCase() !== REQUIRED_PHRASE ||
                  !currentPassword ||
                  (summary.has_pin && pin.length !== 4)
                }
              >
                {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {resetting ? "Resetting Platform Data..." : "Permanently Reset All Data"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

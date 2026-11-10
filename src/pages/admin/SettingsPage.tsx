import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings, Users, ShieldCheck, Upload, Plus, Power, Loader2, History } from "lucide-react";
import { invokeAuthenticatedFunction, supabase } from "@/lib/supabase";
import { uploadStorageFile } from "@/lib/storage";
import { useAuth } from "@/contexts/AuthContext";
import { formatDateTime } from "@/lib/utils";
import type { AgencySettings, AppUser, AuditLogRecord } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useToast } from "@/components/ui/toast";

export function SettingsPage() {
  const { role, userProfile, refreshBranding } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isOwnerAdmin = role === "admin";

  const [form, setForm] = useState<Partial<AgencySettings>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  // Staff User Creation Dialog
  const [staffOpen, setStaffOpen] = useState(false);
  const [staffName, setStaffName] = useState("");
  const [staffEmail, setStaffEmail] = useState("");
  const [staffPhone, setStaffPhone] = useState("");
  const [staffPassword, setStaffPassword] = useState("");
  const [staffRole, setStaffRole] = useState<"staff" | "admin">("staff");
  const [creatingStaff, setCreatingStaff] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ["agency-settings-admin"],
    queryFn: async () => {
      const { data, error } = await supabase.from("agency_settings").select("*").eq("id", 1).single();
      if (error) throw error;
      return data as AgencySettings;
    },
  });

  useEffect(() => {
    if (settings) {
      setForm(settings);
    }
  }, [settings]);

  const { data: staffUsers = [], isLoading: loadingStaff } = useQuery({
    queryKey: ["admin-staff-users"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("users")
        .select("id, role_id, full_name, email, phone, is_active, created_at, roles!inner(name)")
        .in("roles.name", ["admin", "staff"])
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((u) => ({
        ...u,
        role: (u.roles as unknown as { name: AppUser["role"] }).name,
      })) as AppUser[];
    },
  });

  const { data: auditLogs = [], isLoading: loadingLogs } = useQuery({
    queryKey: ["admin-audit-logs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("*, users(full_name, email)")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as AuditLogRecord[];
    },
  });

  const handleUploadLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !isOwnerAdmin) return;
    setUploadingLogo(true);
    try {
      const { url } = await uploadStorageFile("brand-assets", "agency", file);
      setForm((prev) => ({ ...prev, logo_url: url }));
      await supabase.from("agency_settings").update({ logo_url: url }).eq("id", 1);
      await refreshBranding();
      toast({ title: "Agency logo updated", type: "success" });
    } catch (err) {
      toast({ title: "Logo upload failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwnerAdmin) return;
    setSavingSettings(true);
    try {
      const { error } = await supabase
        .from("agency_settings")
        .update({
          agency_name: form.agency_name?.trim(),
          legal_name: form.legal_name?.trim(),
          gstin: (form.gstin || "").trim().toUpperCase(),
          pan: (form.pan || "").trim().toUpperCase(),
          address: (form.address || "").trim(),
          city: (form.city || "").trim(),
          state: (form.state || "Telangana").trim(),
          pincode: (form.pincode || "").trim(),
          phone: (form.phone || "").trim(),
          email: (form.email || "").trim(),
          default_gst_rate: Number(form.default_gst_rate ?? 18),
          currency_symbol: (form.currency_symbol || "₹").trim(),
          order_prefix: (form.order_prefix || "ORD").trim().toUpperCase(),
          po_prefix: (form.po_prefix || "PO").trim().toUpperCase(),
          invoice_prefix: (form.invoice_prefix || "INV").trim().toUpperCase(),
          bank_details: form.bank_details || "",
          terms_and_conditions: form.terms_and_conditions || "",
        })
        .eq("id", 1);
      if (error) throw error;
      await refreshBranding();
      queryClient.invalidateQueries({ queryKey: ["agency-settings-admin"] });
      queryClient.invalidateQueries({ queryKey: ["agency-settings-read"] });
      toast({ title: "Agency profile & GST configuration saved", type: "success" });
    } catch (err) {
      toast({ title: "Save failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleCreateStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwnerAdmin) return;
    setCreatingStaff(true);
    try {
      await invokeAuthenticatedFunction(
        "manage-staff-user",
        {
          action: "create_staff",
          full_name: staffName.trim(),
          email: staffEmail.trim().toLowerCase(),
          phone: staffPhone.trim() || null,
          password: staffPassword,
          role_name: staffRole,
        },
        "Failed to create staff account"
      );
      toast({ title: `${staffRole.toUpperCase()} account created for ${staffEmail.trim()}`, type: "success" });
      setStaffOpen(false);
      setStaffName("");
      setStaffEmail("");
      setStaffPhone("");
      setStaffPassword("");
      queryClient.invalidateQueries({ queryKey: ["admin-staff-users"] });
    } catch (err) {
      toast({ title: "Could not create user", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setCreatingStaff(false);
    }
  };

  const toggleStaffStatus = async (u: AppUser) => {
    if (!isOwnerAdmin) return;
    try {
      await invokeAuthenticatedFunction(
        "manage-staff-user",
        {
          action: "toggle_user_status",
          user_id: u.id,
          is_active: !u.is_active,
        },
        "Failed to update user status"
      );
      toast({ title: `${u.full_name} ${!u.is_active ? "activated" : "deactivated"}`, type: "info" });
      queryClient.invalidateQueries({ queryKey: ["admin-staff-users"] });
    } catch (err) {
      toast({ title: "Update failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900">
          <Settings className="h-6 w-6 text-blue-700" />
          Agency Settings &amp; Access Control
        </h1>
        <p className="text-sm text-slate-500">
          Configure Indian GST defaults, legal business details, document prefixes, staff accounts, and system audit logs.
        </p>
      </div>

      {!isOwnerAdmin && (
        <div className="flex items-center gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900">
          <ShieldCheck className="h-4 w-4 shrink-0 text-amber-700" />
          <span>
            You are signed in with the <strong>Staff</strong> role. Viewing settings and logs is permitted; modifying legal GST configuration and managing team users requires the primary <strong>Admin (Agency Owner)</strong> role.
          </span>
        </div>
      )}

      <Tabs defaultValue="agency">
        <TabsList>
          <TabsTrigger value="agency">Agency Profile &amp; GST</TabsTrigger>
          <TabsTrigger value="staff">Staff &amp; Admin Users ({staffUsers.length})</TabsTrigger>
          <TabsTrigger value="audit">System Audit Logs ({auditLogs.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="agency">
          <Card>
            <CardHeader>
              <CardTitle>Legal Identity &amp; Tax Configuration</CardTitle>
              <CardDescription>
                Agency State determines Intra-State (CGST + SGST) vs Inter-State (IGST) calculation on Customer Invoices.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSaveSettings} className="space-y-5">
                <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                  {form.logo_url ? (
                    <img src={form.logo_url} alt="Agency logo" className="h-14 w-14 rounded-md border bg-white object-contain p-1" />
                  ) : (
                    <div className="flex h-14 w-14 items-center justify-center rounded-md border bg-white text-xs font-bold text-slate-400">
                      LOGO
                    </div>
                  )}
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-slate-900">Brand Logo</p>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                      {uploadingLogo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      <span>Upload Agency Logo</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={!isOwnerAdmin}
                        onChange={handleUploadLogo}
                      />
                    </label>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Agency Display Name *</Label>
                    <Input
                      value={form.agency_name || ""}
                      onChange={(e) => setForm({ ...form, agency_name: e.target.value })}
                      disabled={!isOwnerAdmin}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Registered Legal Name *</Label>
                    <Input
                      value={form.legal_name || ""}
                      onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
                      disabled={!isOwnerAdmin}
                      required
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-4">
                  <div className="space-y-1.5">
                    <Label>Agency GSTIN</Label>
                    <Input
                      value={form.gstin || ""}
                      onChange={(e) => setForm({ ...form, gstin: e.target.value })}
                      placeholder="36AAACT1234A1Z5"
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>PAN</Label>
                    <Input
                      value={form.pan || ""}
                      onChange={(e) => setForm({ ...form, pan: e.target.value })}
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Phone</Label>
                    <Input
                      value={form.phone || ""}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Contact Email</Label>
                    <Input
                      type="email"
                      value={form.email || ""}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>Registered Office / Dispatch Address</Label>
                  <Input
                    value={form.address || ""}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    disabled={!isOwnerAdmin}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label>City</Label>
                    <Input value={form.city || ""} onChange={(e) => setForm({ ...form, city: e.target.value })} disabled={!isOwnerAdmin} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Home State (For GST Split) *</Label>
                    <Input
                      value={form.state || ""}
                      onChange={(e) => setForm({ ...form, state: e.target.value })}
                      disabled={!isOwnerAdmin}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Pincode</Label>
                    <Input
                      value={form.pincode || ""}
                      onChange={(e) => setForm({ ...form, pincode: e.target.value })}
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-5">
                  <div className="space-y-1.5">
                    <Label>Default GST %</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={form.default_gst_rate ?? 18}
                      onChange={(e) => setForm({ ...form, default_gst_rate: Number(e.target.value) })}
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Currency Symbol</Label>
                    <Input
                      value={form.currency_symbol || "₹"}
                      onChange={(e) => setForm({ ...form, currency_symbol: e.target.value })}
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Order Prefix</Label>
                    <Input
                      value={form.order_prefix || "ORD"}
                      onChange={(e) => setForm({ ...form, order_prefix: e.target.value })}
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>PO Prefix</Label>
                    <Input
                      value={form.po_prefix || "PO"}
                      onChange={(e) => setForm({ ...form, po_prefix: e.target.value })}
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Invoice Prefix</Label>
                    <Input
                      value={form.invoice_prefix || "INV"}
                      onChange={(e) => setForm({ ...form, invoice_prefix: e.target.value })}
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Bank &amp; Remittance Details (Shown on Invoices)</Label>
                    <Textarea
                      rows={3}
                      value={form.bank_details || ""}
                      onChange={(e) => setForm({ ...form, bank_details: e.target.value })}
                      placeholder="Bank Name, A/C No., IFSC Code, Branch, UPI ID..."
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Invoice Terms &amp; Conditions</Label>
                    <Textarea
                      rows={3}
                      value={form.terms_and_conditions || ""}
                      onChange={(e) => setForm({ ...form, terms_and_conditions: e.target.value })}
                      disabled={!isOwnerAdmin}
                    />
                  </div>
                </div>

                {isOwnerAdmin && (
                  <Button type="submit" disabled={savingSettings}>
                    {savingSettings && <Loader2 className="h-4 w-4 animate-spin" />}
                    Save Agency Settings
                  </Button>
                )}
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="staff" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-600">
              Authorized staff manage manufacturers, catalog pricing, customer orders, purchase orders, and inventory.
            </p>
            {isOwnerAdmin && (
              <Button onClick={() => setStaffOpen(true)}>
                <Plus className="h-4 w-4" />
                Add Staff / Admin User
              </Button>
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4 text-blue-700" />
                Agency Team Accounts
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Full Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingStaff ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                        Loading staff accounts...
                      </TableCell>
                    </TableRow>
                  ) : (
                    staffUsers.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="font-semibold text-slate-900">
                          {u.full_name}
                          {u.id === userProfile?.id && (
                            <span className="ml-2 text-xs font-normal text-blue-700">(You)</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-slate-600">{u.email}</TableCell>
                        <TableCell className="text-xs text-slate-600">{u.phone || "—"}</TableCell>
                        <TableCell>
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold uppercase text-slate-700">
                            {u.role}
                          </span>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={u.is_active ? "active" : "inactive"} />
                        </TableCell>
                        <TableCell className="text-right">
                          {isOwnerAdmin && u.id !== userProfile?.id && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleStaffStatus(u)}
                              title={u.is_active ? "Deactivate" : "Activate"}
                            >
                              <Power className={u.is_active ? "h-4 w-4 text-amber-600" : "h-4 w-4 text-emerald-600"} />
                              {u.is_active ? "Deactivate" : "Activate"}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4 text-blue-700" />
                Recent System Audit Logs
              </CardTitle>
              <CardDescription>Last 100 security &amp; operational events across the platform.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingLogs ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-slate-500">
                        Loading audit logs...
                      </TableCell>
                    </TableRow>
                  ) : auditLogs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-slate-500">
                        No audit entries logged yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    auditLogs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell className="text-xs text-slate-500">{formatDateTime(log.created_at)}</TableCell>
                        <TableCell className="text-xs font-medium text-slate-800">
                          {log.users?.full_name || log.actor_user_id || "System"}
                        </TableCell>
                        <TableCell>
                          <span className="rounded bg-blue-50 px-2 py-0.5 font-mono text-xs font-semibold text-blue-800">
                            {log.action}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-slate-600">{log.entity_type}</TableCell>
                        <TableCell className="max-w-sm truncate font-mono text-[11px] text-slate-500">
                          {log.new_data ? JSON.stringify(log.new_data) : "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add Staff User Modal */}
      <Dialog open={staffOpen} onOpenChange={setStaffOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Agency Team Account</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateStaff} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Full Name *</Label>
                <Input value={staffName} onChange={(e) => setStaffName(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Role *</Label>
                <Select value={staffRole} onValueChange={(v) => setStaffRole(v as "staff" | "admin")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="staff">Authorized Staff</SelectItem>
                    <SelectItem value="admin">Agency Owner (Admin)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Email *</Label>
                <Input type="email" value={staffEmail} onChange={(e) => setStaffEmail(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input value={staffPhone} onChange={(e) => setStaffPhone(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Initial Password (min 8 chars) *</Label>
              <Input
                type="password"
                minLength={8}
                value={staffPassword}
                onChange={(e) => setStaffPassword(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStaffOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creatingStaff}>
                {creatingStaff && <Loader2 className="h-4 w-4 animate-spin" />}
                Create Team Account
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
